// Parses OpenVDB files into dense voxel arrays. This module has no dependencies on
// three.js so it can run in a worker; `VDBLoader` wraps its output in three.js objects.

import { inflate, bloscDecompress, fromHalfFloat, toHalfFloat } from './VDBCodecs.js';

const MAGIC = 0x56444220;

const FILE_VERSION_NODE_MASK_COMPRESSION = 222;

const COMPRESS_ZIP = 0x1;
const COMPRESS_ACTIVE_MASK = 0x2;
const COMPRESS_BLOSC = 0x4;

const NO_MASK_OR_INACTIVE_VALS = 0;
const NO_MASK_AND_ONE_INACTIVE_VAL = 2;
const MASK_AND_NO_INACTIVE_VALS = 3;
const MASK_AND_ONE_INACTIVE_VAL = 4;
const MASK_AND_TWO_INACTIVE_VALS = 5;
const NO_MASK_AND_ALL_VALS = 6;

const HALF_FLOAT_SUFFIX = '_HalfFloat';
const VALUE_SIZES = { half: 2, float: 4, double: 8 };

const VALUE_TYPES = {
	half: { base: 'half', components: 1 },
	float: { base: 'float', components: 1 },
	double: { base: 'double', components: 1 },
	vec3s: { base: 'float', components: 3 },
	vec3d: { base: 'double', components: 3 }
};

const MAX_DENSE_VALUES = 1 << 28;

class Reader {

	constructor( buffer ) {

		this.buffer = buffer;
		this.view = new DataView( buffer );
		this.offset = 0;

	}

	skip( n ) {

		this.offset += n;

	}

	uint8() {

		return this.view.getUint8( this.offset ++ );

	}

	int32() {

		const value = this.view.getInt32( this.offset, true );
		this.offset += 4;
		return value;

	}

	uint32() {

		const value = this.view.getUint32( this.offset, true );
		this.offset += 4;
		return value;

	}

	int64() {

		const value = Number( this.view.getBigInt64( this.offset, true ) );
		this.offset += 8;
		return value;

	}

	float64() {

		const value = this.view.getFloat64( this.offset, true );
		this.offset += 8;
		return value;

	}

	bytes( n ) {

		const value = new Uint8Array( this.buffer, this.offset, n );
		this.offset += n;
		return value;

	}

	string() {

		const length = this.uint32();
		return new TextDecoder().decode( this.bytes( length ) );

	}

	mask( size ) {

		return this.bytes( size >> 3 ).slice();

	}

}

function readMetadata( reader ) {

	const metadata = {};
	const count = reader.uint32();

	for ( let i = 0; i < count; i ++ ) {

		const name = reader.string();
		const type = reader.string();
		const size = reader.uint32();
		const view = new DataView( reader.buffer, reader.offset, size );

		switch ( type ) {

			case 'string': metadata[ name ] = new TextDecoder().decode( reader.bytes( size ) ); break;
			case 'bool': metadata[ name ] = view.getUint8( 0 ) !== 0; break;
			case 'int32': metadata[ name ] = view.getInt32( 0, true ); break;
			case 'int64': metadata[ name ] = Number( view.getBigInt64( 0, true ) ); break;
			case 'float': metadata[ name ] = view.getFloat32( 0, true ); break;
			case 'double': metadata[ name ] = view.getFloat64( 0, true ); break;
			case 'vec3i': metadata[ name ] = [ view.getInt32( 0, true ), view.getInt32( 4, true ), view.getInt32( 8, true ) ]; break;
			case 'vec3s': metadata[ name ] = [ view.getFloat32( 0, true ), view.getFloat32( 4, true ), view.getFloat32( 8, true ) ]; break;
			case 'vec3d': metadata[ name ] = [ view.getFloat64( 0, true ), view.getFloat64( 8, true ), view.getFloat64( 16, true ) ]; break;

		}

		reader.offset = view.byteOffset + size;

	}

	return metadata;

}

function readTransform( reader ) {

	const type = reader.string();
	const vec3 = () => [ reader.float64(), reader.float64(), reader.float64() ];
	const matrix = ( s, t ) => [ s[ 0 ], 0, 0, 0, 0, s[ 1 ], 0, 0, 0, 0, s[ 2 ], 0, t[ 0 ], t[ 1 ], t[ 2 ], 1 ];

	switch ( type ) {

		case 'TranslationMap': {

			return matrix( [ 1, 1, 1 ], vec3() );

		}

		case 'ScaleMap':
		case 'UniformScaleMap': {

			const s = vec3();
			reader.skip( 4 * 24 );
			return matrix( s, [ 0, 0, 0 ] );

		}

		case 'ScaleTranslateMap':
		case 'UniformScaleTranslateMap': {

			const t = vec3();
			const s = vec3();
			reader.skip( 4 * 24 );
			return matrix( s, t );

		}

		case 'AffineMap':
		case 'UnitaryMap': {

			const elements = [];
			for ( let i = 0; i < 16; i ++ ) elements.push( reader.float64() );
			return elements;

		}

		default:
			throw new Error( 'THREE.VDBLoader: Unsupported transform ' + type + '.' );

	}

}

function readGrid( reader, name, valueType, saveFloatAsHalf, options ) {

	const grid = {
		name,
		compression: reader.uint32(),
		metadata: readMetadata( reader ),
		transform: readTransform( reader ),
		base: VALUE_TYPES[ valueType ].base,
		components: VALUE_TYPES[ valueType ].components,
		saveFloatAsHalf
	};

	reader.skip( 4 ); // buffer count

	grid.background = readValue( reader, grid );

	const tileCount = reader.uint32();
	const childCount = reader.uint32();

	const tiles = [];
	const children = [];

	for ( let i = 0; i < tileCount; i ++ ) {

		const origin = [ reader.int32(), reader.int32(), reader.int32() ];
		const value = readValue( reader, grid );
		const active = reader.uint8() !== 0;
		tiles.push( { origin, value, active } );

	}

	for ( let i = 0; i < childCount; i ++ ) {

		const origin = [ reader.int32(), reader.int32(), reader.int32() ];
		children.push( readInternalTopology( reader, grid, origin, 5, 7 ) );

	}

	for ( const child of children ) readInternalBuffers( reader, grid, child );

	const bounds = [ Infinity, Infinity, Infinity, - Infinity, - Infinity, - Infinity ];

	for ( const tile of tiles ) {

		if ( tile.active ) expandByCube( bounds, tile.origin, 1 << 12 );

	}

	for ( const child of children ) expandByNode( bounds, child );

	const result = {
		name,
		type: valueType,
		metadata: grid.metadata,
		transform: grid.transform,
		background: grid.components === 1 ? grid.background[ 0 ] : grid.background,
		components: grid.components
	};

	const dense = createDense( name, bounds, grid.components, options.boundingBox );

	if ( dense !== null ) {

		fillCube( dense, dense.bounds, Infinity, grid.background );

		for ( const tile of tiles ) fillCube( dense, tile.origin, 1 << 12, tile.value );
		for ( const child of children ) fillNode( dense, child );

	}

	return finishGrid( result, dense, options );

}

/**
 * Allocates the dense float array covering the active bounds of a grid, or the
 * bounding box forced by the options. Returns `null` for an empty grid.
 */
function createDense( name, activeBounds, components, boundingBox ) {

	let bounds = activeBounds;

	if ( boundingBox !== null ) {

		bounds = boundingBox.map( ( v, i ) => i < 3 ? Math.floor( v ) : Math.ceil( v ) );

		if ( bounds[ 0 ] > bounds[ 3 ] || bounds[ 1 ] > bounds[ 4 ] || bounds[ 2 ] > bounds[ 5 ] ) {

			throw new Error( 'THREE.VDBLoader: Invalid bounding box.' );

		}

	} else if ( bounds[ 0 ] > bounds[ 3 ] ) {

		return null;

	}

	const width = bounds[ 3 ] - bounds[ 0 ] + 1;
	const height = bounds[ 4 ] - bounds[ 1 ] + 1;
	const depth = bounds[ 5 ] - bounds[ 2 ] + 1;

	const stride = components === 1 ? 1 : 4;

	if ( width * height * depth * stride > MAX_DENSE_VALUES ) {

		throw new Error( 'THREE.VDBLoader: Grid "' + name + '" is too large for a dense texture (' + width + 'x' + height + 'x' + depth + ').' );

	}

	const data = new Float32Array( width * height * depth * stride );

	return { data, bounds, width, height, depth, stride, components };

}

/**
 * Completes a parsed grid: measures the value range and converts the dense
 * float data to the requested output type.
 *
 * @param {Object} result - The grid fields that do not depend on the voxel data.
 * @param {?Object} dense - The dense float data from {@link createDense}, filled in.
 * @param {Object} options - The parse options.
 * @return {Object} The completed grid.
 */
function finishGrid( result, dense, options ) {

	const background = [ result.background ].flat();

	let min = Infinity;
	let max = - Infinity;

	if ( dense === null ) {

		for ( const v of background ) {

			min = Math.min( min, v );
			max = Math.max( max, v );

		}

	} else {

		const { data, stride, components } = dense;

		if ( stride === 1 ) {

			for ( let i = 0; i < data.length; i ++ ) {

				const v = data[ i ];

				if ( v < min ) min = v;
				if ( v > max ) max = v;

			}

		} else {

			for ( let i = 0; i < data.length; i += stride ) {

				for ( let c = 0; c < components; c ++ ) {

					const v = data[ i + c ];

					if ( v < min ) min = v;
					if ( v > max ) max = v;

				}

			}

		}

	}

	const valueRange = options.valueRange !== null ? [ options.valueRange[ 0 ], options.valueRange[ 1 ] ] : [ min, max ];

	result.valueRange = valueRange;
	result.bounds = dense === null ? null : dense.bounds;
	result.width = dense === null ? 0 : dense.width;
	result.height = dense === null ? 0 : dense.height;
	result.depth = dense === null ? 0 : dense.depth;
	result.stride = dense === null ? 0 : dense.stride;
	result.data = dense === null ? null : convertValues( dense.data, options.outputType, valueRange, min, max );

	return result;

}

function convertValues( data, outputType, valueRange, min, max ) {

	switch ( outputType ) {

		case 'float': {

			return data;

		}

		case 'half': {

			if ( typeof Float16Array === 'undefined' ) {

				const out = new Uint16Array( data.length );

				for ( let i = 0; i < data.length; i ++ ) out[ i ] = toHalfFloat( data[ i ] );

				return out;

			}

			// Native conversion rounds like toHalfFloat() but does not clamp.

			if ( max > 65504 || min < - 65504 ) {

				for ( let i = 0; i < data.length; i ++ ) {

					if ( data[ i ] > 65504 ) data[ i ] = 65504;
					else if ( data[ i ] < - 65504 ) data[ i ] = - 65504;

				}

			}

			const half = new Float16Array( data.length );
			half.set( data );

			return new Uint16Array( half.buffer );

		}

		case 'uint8': {

			const out = new Uint8Array( data.length );
			const offset = valueRange[ 0 ];
			const scale = valueRange[ 1 ] > valueRange[ 0 ] ? 255 / ( valueRange[ 1 ] - valueRange[ 0 ] ) : 0;

			for ( let i = 0; i < data.length; i ++ ) {

				const v = Math.round( ( data[ i ] - offset ) * scale );
				out[ i ] = v < 0 ? 0 : v > 255 ? 255 : v;

			}

			return out;

		}

		default:
			throw new Error( 'THREE.VDBLoader: Unsupported output type ' + outputType + '.' );

	}

}

function readValue( reader, grid ) {

	const value = [];

	for ( let c = 0; c < grid.components; c ++ ) {

		const offset = reader.offset;

		reader.offset += VALUE_SIZES[ grid.base ];

		switch ( grid.base ) {

			case 'half': value.push( fromHalfFloat( reader.view.getUint16( offset, true ) ) ); break;
			case 'float': value.push( reader.view.getFloat32( offset, true ) ); break;
			case 'double': value.push( reader.view.getFloat64( offset, true ) ); break;

		}

	}

	return value;

}

function readInternalTopology( reader, grid, origin, log2Dim, childTotal ) {

	const size = 1 << ( 3 * log2Dim );

	const node = {
		origin,
		log2Dim,
		childTotal,
		childMask: reader.mask( size ),
		valueMask: null,
		values: null,
		children: new Map()
	};

	node.valueMask = reader.mask( size );
	node.values = readCompressedValues( reader, grid, size, node.valueMask );

	for ( let i = 0; i < size; i ++ ) {

		if ( isOn( node.childMask, i ) === false ) continue;

		const childOrigin = offsetToCoord( i, log2Dim, childTotal, origin );

		node.children.set( i, log2Dim === 5
			? readInternalTopology( reader, grid, childOrigin, 4, 3 )
			: { origin: childOrigin, valueMask: reader.mask( 512 ), values: null } );

	}

	return node;

}

function readInternalBuffers( reader, grid, node ) {

	for ( const child of node.children.values() ) {

		if ( child.children !== undefined ) {

			readInternalBuffers( reader, grid, child );

		} else {

			child.valueMask = reader.mask( 512 );
			child.values = readCompressedValues( reader, grid, 512, child.valueMask );

		}

	}

}

function readCompressedValues( reader, grid, count, valueMask ) {

	const metadata = reader.uint8();

	let inactiveVal1 = grid.background;
	let inactiveVal0 = metadata === NO_MASK_OR_INACTIVE_VALS ? grid.background : grid.background.map( v => - v );

	if ( metadata === NO_MASK_AND_ONE_INACTIVE_VAL || metadata === MASK_AND_ONE_INACTIVE_VAL || metadata === MASK_AND_TWO_INACTIVE_VALS ) {

		inactiveVal0 = readValue( reader, grid );

		if ( metadata === MASK_AND_TWO_INACTIVE_VALS ) inactiveVal1 = readValue( reader, grid );

	}

	let selectionMask = null;

	if ( metadata === MASK_AND_NO_INACTIVE_VALS || metadata === MASK_AND_ONE_INACTIVE_VAL || metadata === MASK_AND_TWO_INACTIVE_VALS ) {

		selectionMask = reader.mask( count );

	}

	const maskCompressed = ( grid.compression & COMPRESS_ACTIVE_MASK ) !== 0 && metadata !== NO_MASK_AND_ALL_VALS;
	const storedCount = maskCompressed ? countOn( valueMask ) : count;
	const stored = readData( reader, grid, storedCount );

	if ( storedCount === count ) return stored;

	const components = grid.components;
	const values = new Float32Array( count * components );

	for ( let i = 0, j = 0; i < count; i ++ ) {

		if ( isOn( valueMask, i ) ) {

			for ( let c = 0; c < components; c ++ ) values[ i * components + c ] = stored[ j * components + c ];
			j ++;

		} else {

			values.set( selectionMask !== null && isOn( selectionMask, i ) ? inactiveVal1 : inactiveVal0, i * components );

		}

	}

	return values;

}

function readData( reader, grid, count ) {

	if ( grid.saveFloatAsHalf && count === 0 ) return new Float32Array( 0 );

	const valueType = grid.saveFloatAsHalf ? 'half' : grid.base;
	const length = count * grid.components;
	const byteLength = length * VALUE_SIZES[ valueType ];

	let bytes;

	if ( grid.compression & COMPRESS_BLOSC ) {

		const compressedLength = reader.int64();

		bytes = compressedLength <= 0
			? reader.bytes( - compressedLength )
			: bloscDecompress( reader.bytes( compressedLength ) );

	} else if ( grid.compression & COMPRESS_ZIP ) {

		const zippedLength = reader.int64();

		bytes = zippedLength <= 0
			? reader.bytes( - zippedLength )
			: inflate( reader.bytes( zippedLength ), byteLength );

	} else {

		bytes = reader.bytes( byteLength );

	}

	if ( bytes.byteLength !== byteLength ) {

		throw new Error( 'THREE.VDBLoader: Unexpected data size.' );

	}

	const view = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	const values = new Float32Array( length );

	for ( let i = 0; i < length; i ++ ) {

		switch ( valueType ) {

			case 'half': values[ i ] = fromHalfFloat( view.getUint16( i * 2, true ) ); break;
			case 'float': values[ i ] = view.getFloat32( i * 4, true ); break;
			case 'double': values[ i ] = view.getFloat64( i * 8, true ); break;

		}

	}

	return values;

}

function isOn( mask, i ) {

	return ( mask[ i >> 3 ] & ( 1 << ( i & 7 ) ) ) !== 0;

}

function countOn( mask ) {

	let count = 0;

	for ( let i = 0; i < mask.length; i ++ ) {

		let byte = mask[ i ];

		while ( byte !== 0 ) {

			byte &= byte - 1;
			count ++;

		}

	}

	return count;

}

function offsetToCoord( i, log2Dim, childTotal, origin ) {

	const mask = ( 1 << log2Dim ) - 1;

	return [
		origin[ 0 ] + ( ( i >> ( 2 * log2Dim ) ) << childTotal ),
		origin[ 1 ] + ( ( ( i >> log2Dim ) & mask ) << childTotal ),
		origin[ 2 ] + ( ( i & mask ) << childTotal )
	];

}

function expandByCube( bounds, origin, size ) {

	for ( let i = 0; i < 3; i ++ ) {

		bounds[ i ] = Math.min( bounds[ i ], origin[ i ] );
		bounds[ i + 3 ] = Math.max( bounds[ i + 3 ], origin[ i ] + size - 1 );

	}

}

function expandByNode( bounds, node ) {

	if ( node.children === undefined ) {

		for ( let i = 0; i < 512; i ++ ) {

			if ( isOn( node.valueMask, i ) === false ) continue;

			const x = node.origin[ 0 ] + ( i >> 6 );
			const y = node.origin[ 1 ] + ( ( i >> 3 ) & 7 );
			const z = node.origin[ 2 ] + ( i & 7 );

			if ( x < bounds[ 0 ] ) bounds[ 0 ] = x;
			if ( y < bounds[ 1 ] ) bounds[ 1 ] = y;
			if ( z < bounds[ 2 ] ) bounds[ 2 ] = z;
			if ( x > bounds[ 3 ] ) bounds[ 3 ] = x;
			if ( y > bounds[ 4 ] ) bounds[ 4 ] = y;
			if ( z > bounds[ 5 ] ) bounds[ 5 ] = z;

		}

		return;

	}

	const size = 1 << ( 3 * node.log2Dim );

	for ( let i = 0; i < size; i ++ ) {

		const child = node.children.get( i );

		if ( child !== undefined ) {

			expandByNode( bounds, child );

		} else if ( isOn( node.valueMask, i ) ) {

			expandByCube( bounds, offsetToCoord( i, node.log2Dim, node.childTotal, node.origin ), 1 << node.childTotal );

		}

	}

}

function fillCube( dense, origin, size, value ) {

	const { data, bounds, width, height, stride } = dense;

	const x0 = Math.max( origin[ 0 ], bounds[ 0 ] ), x1 = Math.min( origin[ 0 ] + size - 1, bounds[ 3 ] );
	const y0 = Math.max( origin[ 1 ], bounds[ 1 ] ), y1 = Math.min( origin[ 1 ] + size - 1, bounds[ 4 ] );
	const z0 = Math.max( origin[ 2 ], bounds[ 2 ] ), z1 = Math.min( origin[ 2 ] + size - 1, bounds[ 5 ] );

	if ( x0 > x1 || y0 > y1 || z0 > z1 ) return;

	for ( let z = z0; z <= z1; z ++ ) {

		for ( let y = y0; y <= y1; y ++ ) {

			const row = ( ( z - bounds[ 2 ] ) * height + ( y - bounds[ 1 ] ) ) * width - bounds[ 0 ];

			if ( stride === 1 ) {

				data.fill( value[ 0 ], row + x0, row + x1 + 1 );

			} else {

				for ( let x = x0; x <= x1; x ++ ) data.set( value, ( row + x ) * stride );

			}

		}

	}

}

function fillNode( dense, node ) {

	if ( node.children === undefined ) {

		const { data, bounds, width, height, stride } = dense;
		const components = stride === 1 ? 1 : 3;

		for ( let i = 0; i < 512; i ++ ) {

			const x = node.origin[ 0 ] + ( i >> 6 ) - bounds[ 0 ];
			const y = node.origin[ 1 ] + ( ( i >> 3 ) & 7 ) - bounds[ 1 ];
			const z = node.origin[ 2 ] + ( i & 7 ) - bounds[ 2 ];

			if ( x < 0 || y < 0 || z < 0 || x >= width || y >= height || z > bounds[ 5 ] - bounds[ 2 ] ) continue;

			const index = ( ( z * height + y ) * width + x ) * stride;

			for ( let c = 0; c < components; c ++ ) data[ index + c ] = node.values[ i * components + c ];

		}

		return;

	}

	const size = 1 << ( 3 * node.log2Dim );

	for ( let i = 0; i < size; i ++ ) {

		const child = node.children.get( i );

		if ( child !== undefined ) {

			fillNode( dense, child );

		} else {

			const components = dense.stride === 1 ? 1 : 3;

			fillCube( dense, offsetToCoord( i, node.log2Dim, node.childTotal, node.origin ), 1 << node.childTotal, node.values.subarray( i * components, ( i + 1 ) * components ) );

		}

	}

}

/**
 * Parses an OpenVDB file.
 *
 * @param {ArrayBuffer} buffer - The file contents.
 * @param {Object} options - The parse options.
 * @param {?Array<string>} options.gridNames - The grids to read, or `null` for all.
 * @param {('float'|'half'|'uint8')} options.outputType - The element type of the voxel data.
 * @param {?Array<number>} options.boundingBox - Forced index space bounds `[ x0, y0, z0, x1, y1, z1 ]` (inclusive), or `null`.
 * @param {?Array<number>} options.valueRange - Forced `[ min, max ]` used to normalize `uint8` output, or `null` to measure it.
 * @return {Array<Object>} The parsed grids.
 */
function parseVDB( buffer, options = {} ) {

	options = Object.assign( { gridNames: null, outputType: 'float', boundingBox: null, valueRange: null }, options );

	const reader = new Reader( buffer );

	if ( reader.int64() !== MAGIC ) {

		throw new Error( 'THREE.VDBLoader: Not a VDB file.' );

	}

	const fileVersion = reader.uint32();

	if ( fileVersion < FILE_VERSION_NODE_MASK_COMPRESSION ) {

		throw new Error( 'THREE.VDBLoader: Unsupported file version ' + fileVersion + '.' );

	}

	reader.skip( 8 ); // library version

	if ( reader.uint8() === 0 ) {

		throw new Error( 'THREE.VDBLoader: Files without grid offsets are not supported.' );

	}

	reader.skip( 36 ); // uuid

	readMetadata( reader );

	const descriptors = [];
	const gridCount = reader.int32();

	for ( let i = 0; i < gridCount; i ++ ) {

		const descriptor = {
			name: reader.string().split( '\x1e' )[ 0 ],
			type: reader.string(),
			instanceParent: reader.string(),
			gridPos: reader.int64(),
			blockPos: reader.int64(),
			endPos: reader.int64()
		};

		descriptors.push( descriptor );

		reader.offset = descriptor.endPos;

	}

	const grids = [];

	for ( const descriptor of descriptors ) {

		if ( options.gridNames !== null && options.gridNames.includes( descriptor.name ) === false ) continue;

		let type = descriptor.type;
		let saveFloatAsHalf = false;

		if ( type.endsWith( HALF_FLOAT_SUFFIX ) ) {

			type = type.slice( 0, - HALF_FLOAT_SUFFIX.length );
			saveFloatAsHalf = true;

		}

		const match = /^Tree_(float|double|half|vec3s|vec3d)_5_4_3$/.exec( type );

		if ( match === null || descriptor.instanceParent !== '' ) {

			console.warn( 'THREE.VDBLoader: Skipping unsupported grid "' + descriptor.name + '" of type ' + descriptor.type + '.' );
			continue;

		}

		reader.offset = descriptor.gridPos;

		grids.push( readGrid( reader, descriptor.name, match[ 1 ], saveFloatAsHalf, options ) );

	}

	return grids;

}

export { parseVDB, createDense, finishGrid, fillCube };
