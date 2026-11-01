// Parses NanoVDB files (.nvdb, major version 32) into dense voxel arrays. Like
// VDBParser.js this module has no dependencies on three.js so it can run in a worker.
//
// Layouts follow NanoVDB.h: every struct is 32 byte aligned, and child nodes are
// reached through byte offsets stored in the parent, so only member offsets matter.

import { inflate, bloscDecompress } from './VDBCodecs.js';
import { createDense, finishGrid, fillCube, fillNode, expandByCube, expandByNode, isOn } from './VDBParser.js';

const MAGIC = 0x304244566f6e614en; // "NanoVDB0"
const MAJOR_VERSION = 32;

const CODEC_NONE = 0;
const CODEC_ZIP = 1;
const CODEC_BLOSC = 2;
const BLOSC_CHUNK = 1 << 30;

const FILE_HEADER_SIZE = 16;
const FILE_METADATA_SIZE = 176;
const GRID_DATA_SIZE = 672;

const FLAG_LONG_GRID_NAME = 1;

const GRID_CLASSES = { 1: 'level set', 2: 'fog volume', 3: 'staggered' };

// GridType enum: Float = 1, Double = 2, Vec3f = 6, Vec3d = 7, Fp4 = 13, Fp8 = 14, Fp16 = 15, FpN = 16.
// `size` and `align` describe ValueT; `stats` is the size of the StatsT (float or double).
const GRID_TYPES = {
	1: { name: 'float', components: 1, size: 4, align: 4, stats: 4, leaf: 'float' },
	2: { name: 'double', components: 1, size: 8, align: 8, stats: 8, leaf: 'double' },
	6: { name: 'vec3f', components: 3, size: 12, align: 4, stats: 4, leaf: 'float' },
	7: { name: 'vec3d', components: 3, size: 24, align: 8, stats: 8, leaf: 'double' },
	13: { name: 'fp4', components: 1, size: 4, align: 4, stats: 4, leaf: 'fp4' },
	14: { name: 'fp8', components: 1, size: 4, align: 4, stats: 4, leaf: 'fp8' },
	15: { name: 'fp16', components: 1, size: 4, align: 4, stats: 4, leaf: 'fp16' },
	16: { name: 'fpN', components: 1, size: 4, align: 4, stats: 4, leaf: 'fpN' }
};

const GRID_TYPE_NAMES = { 3: 'int16', 4: 'int32', 5: 'int64', 8: 'mask', 9: 'half', 10: 'uint32', 11: 'boolean', 12: 'rgba8', 17: 'vec4f', 18: 'vec4d', 19: 'index' };

function align( offset, alignment ) {

	return Math.ceil( offset / alignment ) * alignment;

}

/**
 * Parses a NanoVDB file.
 *
 * @param {ArrayBuffer} buffer - The file contents.
 * @param {Object} options - The parse options, see {@link parseVDB}.
 * @return {Array<Object>} The parsed grids, in the same form as {@link parseVDB} returns them.
 */
function parseNanoVDB( buffer, options = {} ) {

	options = Object.assign( { gridNames: null, outputType: 'float', boundingBox: null, valueRange: null }, options );

	const bytes = new Uint8Array( buffer );
	const view = new DataView( buffer );
	const grids = [];

	let offset = 0;

	// A file is a sequence of segments, each with a header, grid metadata and grid buffers.

	while ( offset + FILE_HEADER_SIZE <= buffer.byteLength ) {

		if ( view.getBigUint64( offset, true ) !== MAGIC ) {

			throw new Error( 'THREE.VDBLoader: Not a NanoVDB file.' );

		}

		const version = view.getUint32( offset + 8, true );
		const major = version >>> 21;

		if ( major !== MAJOR_VERSION ) {

			throw new Error( 'THREE.VDBLoader: Unsupported NanoVDB version ' + major + '.' + ( ( version >>> 10 ) & 0x7ff ) + '.' + ( version & 0x3ff ) + '.' );

		}

		const gridCount = view.getUint16( offset + 12, true );
		offset += FILE_HEADER_SIZE;

		const metadata = [];

		for ( let i = 0; i < gridCount; i ++ ) {

			const nameSize = view.getUint32( offset + 136, true );

			metadata.push( {
				gridSize: Number( view.getBigUint64( offset, true ) ),
				gridType: view.getUint32( offset + 32, true ),
				gridClass: view.getUint32( offset + 36, true ),
				name: new TextDecoder().decode( bytes.subarray( offset + FILE_METADATA_SIZE, offset + FILE_METADATA_SIZE + nameSize ) ).replace( /\0+$/, '' ),
				codec: view.getUint16( offset + 168, true )
			} );

			offset += FILE_METADATA_SIZE + nameSize;

		}

		for ( const meta of metadata ) {

			const wanted = options.gridNames === null || options.gridNames.includes( meta.name );
			const type = GRID_TYPES[ meta.gridType ];

			if ( wanted && type === undefined ) {

				console.warn( 'THREE.VDBLoader: Skipping unsupported grid "' + meta.name + '" of type ' + ( GRID_TYPE_NAMES[ meta.gridType ] || meta.gridType ) + '.' );

			}

			let data = null;

			switch ( meta.codec ) {

				case CODEC_NONE: {

					if ( wanted && type ) data = bytes.subarray( offset, offset + meta.gridSize );
					offset += meta.gridSize;
					break;

				}

				case CODEC_ZIP: {

					const size = Number( view.getBigUint64( offset, true ) );
					if ( wanted && type ) data = inflate( bytes.subarray( offset + 8, offset + 8 + size ), meta.gridSize );
					offset += 8 + size;
					break;

				}

				case CODEC_BLOSC: {

					if ( wanted && type ) data = new Uint8Array( meta.gridSize );

					for ( let residual = meta.gridSize, position = 0; residual > 0; ) {

						const size = Number( view.getBigUint64( offset, true ) );
						const chunk = Math.min( residual, BLOSC_CHUNK );

						if ( data !== null ) {

							const out = bloscDecompress( bytes.subarray( offset + 8, offset + 8 + size ) );

							if ( out.length !== chunk ) throw new Error( 'THREE.VDBLoader: Unexpected Blosc chunk size.' );

							data.set( out, position );

						}

						offset += 8 + size;
						position += chunk;
						residual -= chunk;

					}

					break;

				}

				default:
					throw new Error( 'THREE.VDBLoader: Unsupported NanoVDB codec ' + meta.codec + '.' );

			}

			if ( data !== null ) grids.push( readGrid( data, meta, type, options ) );

		}

	}

	return grids;

}

function readGrid( data, meta, type, options ) {

	const view = new DataView( data.buffer, data.byteOffset, data.byteLength );

	if ( view.getBigUint64( 0, true ) !== MAGIC ) {

		throw new Error( 'THREE.VDBLoader: Invalid NanoVDB grid.' );

	}

	const flags = view.getUint32( 20, true );
	const gridType = view.getUint32( 636, true );

	if ( gridType !== meta.gridType ) {

		throw new Error( 'THREE.VDBLoader: NanoVDB grid type mismatch.' );

	}

	let name = meta.name;

	if ( ( flags & FLAG_LONG_GRID_NAME ) === 0 ) {

		name = new TextDecoder().decode( data.subarray( 40, 296 ) ).split( '\0' )[ 0 ];

	}

	// Map: world = mMatD * ijk + mVecD with a row major 3x3 matrix at 384 and the translation at 528.

	const m = [];
	for ( let i = 0; i < 9; i ++ ) m.push( view.getFloat64( 384 + i * 8, true ) );
	const t = [];
	for ( let i = 0; i < 3; i ++ ) t.push( view.getFloat64( 528 + i * 8, true ) );

	const transform = [
		m[ 0 ], m[ 3 ], m[ 6 ], 0,
		m[ 1 ], m[ 4 ], m[ 7 ], 0,
		m[ 2 ], m[ 5 ], m[ 8 ], 0,
		t[ 0 ], t[ 1 ], t[ 2 ], 1
	];

	const gridClass = view.getUint32( 632, true );

	const grid = { view, data, type, components: type.components };

	// Tree: node offsets relative to the tree, root last.

	const tree = GRID_DATA_SIZE;
	const root = tree + Number( view.getBigUint64( tree + 24, true ) );

	// Root: bbox (24), table size (4), background, min, max, avg, dev, then 32 byte aligned tiles.

	const tableSize = view.getUint32( root + 24, true );
	const backgroundOffset = align( root + 28, type.align );
	const background = readValue( grid, backgroundOffset );

	const statsOffset = align( backgroundOffset + 3 * type.size, type.stats );
	const tilesOffset = align( statsOffset + 2 * type.stats, 32 );

	const tileValueOffset = align( 20, type.align );
	const tileSize = align( tileValueOffset + type.size, 32 );

	const tiles = [];
	const children = [];

	for ( let i = 0; i < tableSize; i ++ ) {

		const tile = tilesOffset + i * tileSize;
		const key = view.getBigUint64( tile, true );
		const child = Number( view.getBigInt64( tile + 8, true ) );

		const origin = [
			( Number( ( key >> 42n ) & 0x1fffffn ) << 12 ) | 0,
			( Number( ( key >> 21n ) & 0x1fffffn ) << 12 ) | 0,
			( Number( key & 0x1fffffn ) << 12 ) | 0
		];

		if ( child !== 0 ) {

			children.push( readInternal( grid, root + child, origin, 5, 7 ) );

		} else {

			tiles.push( { origin, value: readValue( grid, tile + tileValueOffset ), active: view.getUint32( tile + 16, true ) !== 0 } );

		}

	}

	const bounds = [ Infinity, Infinity, Infinity, - Infinity, - Infinity, - Infinity ];

	for ( const tile of tiles ) {

		if ( tile.active ) expandByCube( bounds, tile.origin, 1 << 12 );

	}

	for ( const child of children ) expandByNode( bounds, child );

	const result = {
		name,
		type: type.name,
		metadata: { class: GRID_CLASSES[ gridClass ] || 'unknown' },
		transform,
		background: type.components === 1 ? background[ 0 ] : background,
		components: type.components
	};

	const dense = createDense( name, bounds, type.components, options.boundingBox );

	if ( dense !== null ) {

		fillCube( dense, dense.bounds, Infinity, background );

		for ( const tile of tiles ) fillCube( dense, tile.origin, 1 << 12, tile.value );
		for ( const child of children ) fillNode( dense, child );

	}

	return finishGrid( result, dense, options );

}

function readValue( grid, offset ) {

	const { view, type } = grid;
	const value = [];

	for ( let c = 0; c < type.components; c ++ ) {

		value.push( type.leaf === 'double' ? view.getFloat64( offset + c * 8, true ) : view.getFloat32( offset + c * 4, true ) );

	}

	return value;

}

/**
 * Reads an internal node into the node shape used by VDBParser's fill functions.
 * Layout: bbox (24), flags (8), value mask, child mask, min, max, avg, dev, then the
 * 32 byte aligned table of value / child offset unions.
 */
function readInternal( grid, base, origin, log2Dim, childTotal ) {

	const { view, data, type } = grid;
	const size = 1 << ( 3 * log2Dim );
	const maskBytes = size >> 3;

	const valueMask = data.slice( base + 32, base + 32 + maskBytes );
	const childMask = data.slice( base + 32 + maskBytes, base + 32 + 2 * maskBytes );

	const statsOffset = align( base + 32 + 2 * maskBytes + 2 * type.size, type.stats );
	const tableOffset = align( statsOffset + 2 * type.stats, 32 );
	const entrySize = align( Math.max( type.size, 8 ), Math.max( type.align, 8 ) );

	const node = {
		origin,
		log2Dim,
		childTotal,
		valueMask,
		values: new Float32Array( size * type.components ),
		children: new Map()
	};

	for ( let i = 0; i < size; i ++ ) {

		const entry = tableOffset + i * entrySize;

		if ( isOn( childMask, i ) ) {

			const child = base + Number( view.getBigInt64( entry, true ) );
			const mask = ( 1 << log2Dim ) - 1;
			const childOrigin = [
				origin[ 0 ] + ( ( i >> ( 2 * log2Dim ) ) << childTotal ),
				origin[ 1 ] + ( ( ( i >> log2Dim ) & mask ) << childTotal ),
				origin[ 2 ] + ( ( i & mask ) << childTotal )
			];

			node.children.set( i, log2Dim === 5 ? readInternal( grid, child, childOrigin, 4, 3 ) : readLeaf( grid, child ) );

		} else {

			node.values.set( readValue( grid, entry ), i * type.components );

		}

	}

	return node;

}

/**
 * Reads a leaf node. Layout: bbox min (12), bbox dif (3), flags (1), value mask (64),
 * then either min, max, avg, dev and the 32 byte aligned values, or for quantized
 * leaves minimum (float), quantum (float), four uint16 statistics and the codes at 96.
 */
function readLeaf( grid, base ) {

	const { view, data, type } = grid;
	const components = type.components;

	const origin = [
		view.getInt32( base, true ) & ~7,
		view.getInt32( base + 4, true ) & ~7,
		view.getInt32( base + 8, true ) & ~7
	];

	const flags = data[ base + 15 ];
	const valueMask = data.slice( base + 16, base + 80 );
	const values = new Float32Array( 512 * components );

	switch ( type.leaf ) {

		case 'float':
		case 'double': {

			const valueSize = type.leaf === 'double' ? 8 : 4;
			const offset = align( base + 80 + 2 * type.size + 2 * type.stats, 32 );

			for ( let i = 0; i < 512 * components; i ++ ) {

				values[ i ] = valueSize === 8 ? view.getFloat64( offset + i * 8, true ) : view.getFloat32( offset + i * 4, true );

			}

			break;

		}

		default: {

			const minimum = view.getFloat32( base + 80, true );
			const quantum = view.getFloat32( base + 84, true );
			const codes = base + 96;

			let bits;

			switch ( type.leaf ) {

				case 'fp4': bits = 4; break;
				case 'fp8': bits = 8; break;
				case 'fp16': bits = 16; break;
				default: bits = 1 << ( flags >> 5 ); break;

			}

			for ( let i = 0; i < 512; i ++ ) {

				let code;

				switch ( bits ) {

					case 1: code = ( data[ codes + ( i >> 3 ) ] >> ( i & 7 ) ) & 1; break;
					case 2: code = ( data[ codes + ( i >> 2 ) ] >> ( ( i & 3 ) << 1 ) ) & 3; break;
					case 4: code = ( data[ codes + ( i >> 1 ) ] >> ( ( i & 1 ) << 2 ) ) & 15; break;
					case 8: code = data[ codes + i ]; break;
					default: code = view.getUint16( codes + i * 2, true ); break;

				}

				values[ i ] = Math.fround( Math.fround( code * quantum ) + minimum );

			}

		}

	}

	return { origin, valueMask, values };

}

/**
 * Returns whether the buffer holds a NanoVDB file.
 *
 * @param {ArrayBuffer} buffer - The file contents.
 * @return {boolean} Whether the magic number matches.
 */
function isNanoVDB( buffer ) {

	return buffer.byteLength >= 8 && new DataView( buffer ).getBigUint64( 0, true ) === MAGIC;

}

/**
 * Reads the index space bounding boxes of the grids of a NanoVDB file from the
 * file metadata, without decompressing the grids.
 *
 * @param {ArrayBuffer} buffer - The file contents.
 * @param {?Array<string>} gridNames - The grids to include, or `null` for all.
 * @return {?Array<Array<number>>} One `[ x0, y0, z0, x1, y1, z1 ]` per non-empty grid, or `null` if the buffer is not a NanoVDB file.
 */
function readNanoVDBBounds( buffer, gridNames = null ) {

	if ( isNanoVDB( buffer ) === false ) return null;

	const bytes = new Uint8Array( buffer );
	const view = new DataView( buffer );
	const bounds = [];

	let offset = 0;

	while ( offset + FILE_HEADER_SIZE <= buffer.byteLength && view.getBigUint64( offset, true ) === MAGIC ) {

		const gridCount = view.getUint16( offset + 12, true );
		offset += FILE_HEADER_SIZE;

		let skip = 0;

		for ( let i = 0; i < gridCount; i ++ ) {

			const nameSize = view.getUint32( offset + 136, true );
			const name = new TextDecoder().decode( bytes.subarray( offset + FILE_METADATA_SIZE, offset + FILE_METADATA_SIZE + nameSize ) ).replace( / +$/, '' );
			const box = [];

			for ( let c = 0; c < 6; c ++ ) box.push( view.getInt32( offset + 88 + c * 4, true ) );

			if ( ( gridNames === null || gridNames.includes( name ) ) && box[ 0 ] <= box[ 3 ] && box[ 1 ] <= box[ 4 ] && box[ 2 ] <= box[ 5 ] ) bounds.push( box );

			skip += Number( view.getBigUint64( offset + 8, true ) ); // file size of the grid, codec included
			offset += FILE_METADATA_SIZE + nameSize;

		}

		offset += skip;

	}

	return bounds;

}

export { parseNanoVDB, isNanoVDB, readNanoVDBBounds };
