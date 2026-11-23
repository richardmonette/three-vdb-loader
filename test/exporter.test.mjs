import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Box3, Data3DTexture, FloatType, HalfFloatType, Matrix4, Quaternion, RedFormat, RGBAFormat, UnsignedByteType, Vector3 } from 'three';
import { VDBLoader } from '../VDBLoader.js';
import { VDBExporter } from '../VDBExporter.js';
import { inflate, fromHalfFloat } from '../VDBCodecs.js';
import { deflate } from '../VDBWriter.js';
import zlib from 'node:zlib';

// Exported files are read back with the loader. test/openvdb/ checks them with OpenVDB itself.

const fixtures = new URL( './fixtures/', import.meta.url );

function read( file ) {

	const buffer = readFileSync( new URL( file, fixtures ) );
	return buffer.buffer.slice( buffer.byteOffset, buffer.byteOffset + buffer.byteLength );

}

function load( buffer, setup = loader => loader ) {

	const warn = console.warn;
	console.warn = () => {};

	try {

		return setup( new VDBLoader().setTextureType( FloatType ) ).parse( buffer );

	} finally {

		console.warn = warn;

	}

}

// Voxels equal to the background are stored as inactive background, like OpenVDB
// does, so a voxel of -0 comes back as 0 when the background is 0. Components of
// active vectors keep their sign.
function positiveZero( data, grid ) {

	const stride = grid.texture.format === RGBAFormat ? 4 : 1;
	const background = [ grid.background ].flat();
	const result = data.slice();

	for ( let i = 0; i < data.length; i += stride ) {

		if ( background.every( ( v, c ) => data[ i + c ] === v ) ) {

			for ( let c = 0; c < background.length; c ++ ) result[ i + c ] = background[ c ];

		}

	}

	return result;

}

// The grids of `buffer` read over the boxes of `grids`, by name.
function reload( buffer, grids, type = FloatType ) {

	return grids.map( grid => load( buffer, l => l.setTextureType( type ).setGridNames( [ grid.name ] ).setBoundingBox( grid.bbox ) )[ 0 ] );

}

const files = readdirSync( fixtures ).filter( f => f.endsWith( '.vdb' ) )
	.concat( readdirSync( new URL( 'nano/', fixtures ) ).filter( f => f.endsWith( '.nvdb' ) ).map( f => 'nano/' + f ) );

test( 'deflate', () => {

	let seed = 7;
	const random = () => ( seed = ( seed * 1103515245 + 12345 ) & 0x7fffffff ) / 0x7fffffff;

	const inputs = [
		new Uint8Array( 0 ),
		new Uint8Array( [ 42 ] ),
		new Uint8Array( 70000 ),
		Uint8Array.from( { length: 70000 }, () => random() * 256 ),
		Uint8Array.from( { length: 40000 }, () => random() < 0.9 ? 65 : random() * 256 ),
		new Uint8Array( Float32Array.from( { length: 30000 }, ( _, i ) => random() > 0.6 ? Math.sin( i / 50 ) : 0 ).buffer ),
		new TextEncoder().encode( 'the quick brown fox jumps over the lazy dog '.repeat( 2000 ) )
	];

	for ( const input of inputs ) {

		const zipped = deflate( input );

		assert.deepEqual( new Uint8Array( zlib.inflateSync( zipped ) ), input, 'node:zlib reads it' );
		assert.deepEqual( inflate( zipped, input.length ), input, 'inflate() reads it' );
		assert.ok( zipped.length <= zlib.deflateSync( input ).length * 1.05 + 16, 'within 5% of zlib' );

	}

} );

for ( const file of files ) {

	test( 'round trip ' + file, () => {

		const grids = load( read( file ) ).filter( grid => grid.texture !== null );

		if ( grids.length === 0 ) return;

		const buffer = new VDBExporter().parse( grids );
		const back = reload( buffer, grids );

		for ( let i = 0; i < grids.length; i ++ ) {

			const message = file + ' "' + grids[ i ].name + '"';

			assert.deepEqual( back[ i ].texture.image.data, positiveZero( grids[ i ].texture.image.data, grids[ i ] ), message + ': values' );
			assert.ok( back[ i ].transform.equals( grids[ i ].transform ), message + ': transform' );
			assert.deepEqual( back[ i ].background, grids[ i ].background, message + ': background' );
			assert.equal( back[ i ].metadata.class, grids[ i ].metadata.class, message + ': class' );

		}

		// Without a box, the active voxels give the same bounds as the original.
		const active = load( buffer );

		for ( let i = 0; i < grids.length; i ++ ) {

			assert.deepEqual( active[ i ].bbox, grids[ i ].bbox, file + ' "' + grids[ i ].name + '": active bounds' );

		}

	} );

}

test( 'half floats and no compression', () => {

	for ( const file of [ 'fog_zip_mask.vdb', 'levelset_zip_mask.vdb', 'vec3s_random_zip_mask.vdb', 'multi_zip_mask.vdb' ] ) {

		const grids = load( read( file ) );
		const float = new VDBExporter().parse( grids );
		const half = new VDBExporter().parse( grids, { halfFloat: true } );
		const none = new VDBExporter().parse( grids, { compression: 'none' } );

		assert.ok( half.byteLength < float.byteLength, file + ': half floats are smaller' );
		if ( file.includes( 'random' ) === false ) assert.ok( none.byteLength > float.byteLength, file + ': zip is smaller' );

		const fromHalf = reload( half, grids );
		const fromNone = reload( none, grids );

		for ( let g = 0; g < grids.length; g ++ ) {

			const expected = grids[ g ].texture.image.data;

			assert.deepEqual( fromNone[ g ].texture.image.data, expected, file + ': no compression' );
			assert.equal( load( half, l => l.setGridNames( [ grids[ g ].name ] ) )[ 0 ].type, grids[ g ].type === 'vec3s' ? 'vec3s' : 'float' );

			const data = fromHalf[ g ].texture.image.data;

			for ( let i = 0; i < expected.length; i ++ ) {

				if ( data[ i ] !== Math.f16round( expected[ i ] ) ) assert.fail( file + ': half value ' + i + ' is ' + data[ i ] + ', expected ' + Math.f16round( expected[ i ] ) );

			}

		}

	}

} );

test( 'half float and byte textures', () => {

	for ( const file of [ 'fog_zip_mask.vdb', 'levelset_zip_mask.vdb', 'vec3s_random_zip_mask.vdb' ] ) {

		const [ float ] = load( read( file ) );
		const [ half ] = load( read( file ), l => l.setTextureType( HalfFloatType ) );
		const [ bytes ] = load( read( file ), l => l.setTextureType( UnsignedByteType ) );

		// Half textures: exported values are the half values exactly.
		const [ fromHalf ] = reload( new VDBExporter().parse( half ), [ half ], HalfFloatType );
		assert.deepEqual( fromHalf.texture.image.data, half.texture.image.data, file + ': half texture' );

		// Byte textures: the same bytes come back when normalized to the same range.
		const [ fromBytes ] = load( new VDBExporter().parse( bytes ), l => l.setTextureType( UnsignedByteType ).setBoundingBox( bytes.bbox ).setValueRange( bytes.valueRange ) );
		assert.deepEqual( fromBytes.texture.image.data, bytes.texture.image.data, file + ': byte texture' );

		// Background texels stay inactive, so the active bounds do not grow.
		const [ active ] = load( new VDBExporter().parse( bytes ) );
		assert.ok( float.bbox.containsBox( active.bbox ), file + ': byte texture bounds' );

		assert.throws( () => new VDBExporter().parse( { texture: bytes.texture } ), /valueRange/ );

	}

} );

test( 'downsampled grids keep their place in the world', () => {

	const [ full ] = load( read( 'fog_zip_mask.vdb' ) );
	const [ grid ] = load( read( 'fog_zip_mask.vdb' ), l => l.setMaxResolution( 8 ) );
	const step = grid.voxelsPerTexel;

	assert.ok( step > 1 );

	const [ back ] = load( new VDBExporter().parse( grid ) );
	const { width, height, depth } = grid.texture.image;

	// Each texel is the center of the cube of voxels it averages.
	for ( const [ x, y, z ] of [ [ 0, 0, 0 ], [ width - 1, height - 1, depth - 1 ], [ 3, 1, 2 ] ] ) {

		const original = new Vector3( x, y, z ).multiplyScalar( step ).add( grid.bbox.min ).addScalar( ( step - 1 ) / 2 ).applyMatrix4( full.transform );
		const exported = new Vector3( x, y, z ).add( back.bbox.min ).applyMatrix4( back.transform );

		assert.ok( exported.distanceTo( original ) < 1e-9, 'texel ' + [ x, y, z ] );

	}

	const [ values ] = load( new VDBExporter().parse( grid ), l => l.setBoundingBox( new Box3( back.bbox.min.clone(), back.bbox.min.clone().add( new Vector3( width - 1, height - 1, depth - 1 ) ) ) ) );
	assert.deepEqual( values.texture.image.data, grid.texture.image.data );

} );

test( 'textures without a grid', () => {

	const size = 20;
	const data = new Float32Array( size * size * size );

	for ( let z = 0; z < size; z ++ ) for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

		const r = Math.hypot( x - 9.5, y - 9.5, z - 9.5 );
		data[ ( z * size + y ) * size + x ] = r < 8 ? 1 - r / 8 : 0;

	}

	const texture = new Data3DTexture( data, size, size, size );
	texture.format = RedFormat;
	texture.type = FloatType;

	const [ grid ] = load( new VDBExporter().parse( texture ) );

	assert.equal( grid.name, 'density' );
	assert.equal( grid.type, 'float' );
	assert.ok( grid.transform.equals( new Matrix4() ) );
	assert.deepEqual( grid.bbox, new Box3( new Vector3( 2, 2, 2 ), new Vector3( 17, 17, 17 ) ) );

	const [ all ] = load( new VDBExporter().parse( texture ), l => l.setBoundingBox( new Box3( new Vector3(), new Vector3( size - 1, size - 1, size - 1 ) ) ) );
	assert.deepEqual( all.texture.image.data, data );

	// A vector texture with a rotated transform and a name, class and metadata.
	const vectors = new Float32Array( 6 * 5 * 4 * 4 ).map( ( _, i ) => i % 4 === 3 ? 1 : Math.sin( i ) );
	const vectorTexture = new Data3DTexture( vectors, 6, 5, 4 );
	vectorTexture.format = RGBAFormat;
	vectorTexture.type = FloatType;

	const transform = new Matrix4().compose( new Vector3( 1, 2, 3 ), new Quaternion().setFromAxisAngle( new Vector3( 1, 1, 0 ).normalize(), 0.7 ), new Vector3( 0.5, 0.5, 0.5 ) );
	const buffer = new VDBExporter().parse( [ { name: 'velocity', texture: vectorTexture, transform, bbox: new Box3( new Vector3( - 3, 4, - 5 ), new Vector3( 2, 8, - 2 ) ), metadata: { class: 'staggered', author: 'test', frame: 12, scale: 0.25, cached: true } } ] );
	const [ velocity ] = load( buffer, l => l.setBoundingBox( new Box3( new Vector3( - 3, 4, - 5 ), new Vector3( 2, 8, - 2 ) ) ) );

	assert.equal( velocity.name, 'velocity' );
	assert.equal( velocity.type, 'vec3s' );
	assert.ok( velocity.transform.equals( transform ) );
	assert.deepEqual( velocity.metadata.class, 'staggered' );
	assert.deepEqual( [ velocity.metadata.author, velocity.metadata.frame, velocity.metadata.scale, velocity.metadata.cached ], [ 'test', 12, 0.25, true ] );

	const expected = vectors.map( ( v, i ) => i % 4 === 3 ? 0 : v );
	const actual = velocity.texture.image.data.map( ( v, i ) => i % 4 === 3 ? 0 : v );
	assert.deepEqual( actual, expected );

} );

test( 'tolerance', () => {

	const [ fog ] = load( read( 'fog_zip_mask.vdb' ) );
	const tolerance = fog.valueRange.y * 0.1;
	const buffer = new VDBExporter().parse( fog, { tolerance } );

	assert.ok( buffer.byteLength < new VDBExporter().parse( fog ).byteLength );

	const [ back ] = reload( buffer, [ fog ] );
	const original = fog.texture.image.data, data = back.texture.image.data;

	for ( let i = 0; i < original.length; i ++ ) {

		const expected = Math.abs( original[ i ] ) <= tolerance ? 0 : original[ i ];
		if ( data[ i ] !== expected ) assert.fail( 'value ' + i );

	}

} );

test( 'duplicate names and errors', () => {

	const [ fog ] = load( read( 'fog_zip_mask.vdb' ) );
	const grids = load( new VDBExporter().parse( [ fog, fog ] ) );

	assert.deepEqual( grids.map( g => g.name ), [ 'density', 'density' ] );

	assert.throws( () => new VDBExporter().parse( fog, { compression: 'blosc' } ), /Unsupported compression/ );
	assert.throws( () => new VDBExporter().parse( { texture: null } ), /no texture/ );
	assert.throws( () => new VDBExporter().parse( Object.assign( {}, fog, { transform: new Matrix4().makeScale( 1, 0, 1 ) } ) ), /not invertible/ );
	assert.throws( () => new VDBExporter().parse( Object.assign( {}, fog, { background: [ 0, 0, 0 ] } ) ), /background/ );

	const halfTexture = new Data3DTexture( new Uint16Array( 8 ), 2, 2, 2 );
	halfTexture.format = RedFormat;
	halfTexture.type = HalfFloatType;
	assert.equal( fromHalfFloat( 0 ), 0 );
	assert.equal( load( new VDBExporter().parse( halfTexture ) )[ 0 ].texture, null, 'an all background texture is an empty grid' );

} );
