import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Box3, FloatType, HalfFloatType, UnsignedByteType, Vector2, Vector3 } from 'three';
import { VDBLoader } from '../VDBLoader.js';
import { fromHalfFloat } from '../VDBCodecs.js';

const fixtures = new URL( './fixtures/', import.meta.url );

function load( file, setup = loader => loader ) {

	const buffer = readFileSync( new URL( file, fixtures ) );
	return setup( new VDBLoader() ).parse( buffer.buffer.slice( buffer.byteOffset, buffer.byteOffset + buffer.byteLength ) );

}

function index( grid, x, y, z ) {

	const { width, height } = grid.texture.image;
	const stride = grid.texture.image.data.length / ( width * height * grid.texture.image.depth );

	return ( ( ( z - grid.bbox.min.z ) * height + ( y - grid.bbox.min.y ) ) * width + ( x - grid.bbox.min.x ) ) * stride;

}

test( 'HalfFloatType is the default', () => {

	for ( const file of [ 'fog_zip_mask.vdb', 'vec3s_random_blosc_mask.vdb', 'levelset_blosc_mask.vdb' ] ) {

		const [ reference ] = load( file, l => l.setTextureType( FloatType ) );
		const [ grid ] = load( file );

		assert.equal( grid.texture.type, HalfFloatType );
		assert.ok( grid.texture.image.data instanceof Uint16Array );
		assert.equal( reference.texture.type, FloatType );
		assert.ok( reference.texture.image.data instanceof Float32Array );
		assert.deepEqual( grid.bbox, reference.bbox );
		assert.deepEqual( grid.valueRange, reference.valueRange );

		const half = grid.texture.image.data;
		const float = reference.texture.image.data;

		assert.equal( half.length, float.length );

		for ( let i = 0; i < float.length; i ++ ) {

			if ( fromHalfFloat( half[ i ] ) !== Math.f16round( float[ i ] ) ) assert.fail( file + ' value ' + i );

		}

	}

} );

test( 'valueRange', () => {

	const [ fog ] = load( 'fog_zip_mask.vdb', l => l.setTextureType( FloatType ) );
	const data = fog.texture.image.data;

	let min = Infinity, max = - Infinity;

	for ( const v of data ) {

		min = Math.min( min, v );
		max = Math.max( max, v );

	}

	assert.ok( fog.valueRange instanceof Vector2 );
	assert.deepEqual( fog.valueRange.toArray(), [ min, max ] );
	assert.ok( max > min );

	const [ vec ] = load( 'vec3s_random_blosc_mask.vdb', l => l.setTextureType( FloatType ) );
	const vdata = vec.texture.image.data;

	min = Infinity, max = - Infinity;

	for ( let i = 0; i < vdata.length; i += 4 ) {

		for ( let c = 0; c < 3; c ++ ) {

			min = Math.min( min, vdata[ i + c ] );
			max = Math.max( max, vdata[ i + c ] );

		}

	}

	assert.deepEqual( vec.valueRange.toArray(), [ min, max ], 'vector range ignores the unused 4th component' );

	const [ empty ] = load( 'empty.vdb' );
	assert.equal( empty.texture, null );
	assert.deepEqual( empty.valueRange.toArray(), [ empty.background, empty.background ] );

	const [ fixed ] = load( 'fog_zip_mask.vdb', l => l.setValueRange( new Vector2( 0, 2 ) ) );
	assert.deepEqual( fixed.valueRange.toArray(), [ 0, 2 ] );

	assert.throws( () => new VDBLoader().setTextureType( 1234 ), /Unsupported texture type/ );

} );

test( 'UnsignedByteType', () => {

	const [ reference ] = load( 'levelset_blosc_mask.vdb', l => l.setTextureType( FloatType ) );
	const [ grid ] = load( 'levelset_blosc_mask.vdb', l => l.setTextureType( UnsignedByteType ) );

	assert.equal( grid.texture.type, UnsignedByteType );
	assert.ok( grid.texture.image.data instanceof Uint8Array );
	assert.deepEqual( grid.valueRange, reference.valueRange );

	const [ min, max ] = reference.valueRange.toArray();
	const bytes = grid.texture.image.data;
	const float = reference.texture.image.data;

	for ( let i = 0; i < float.length; i ++ ) {

		if ( bytes[ i ] !== Math.round( ( float[ i ] - min ) / ( max - min ) * 255 ) ) assert.fail( 'value ' + i );

	}

	const [ clamped ] = load( 'levelset_blosc_mask.vdb', l => l.setTextureType( UnsignedByteType ).setValueRange( new Vector2( - 1, 1 ) ) );
	const cbytes = clamped.texture.image.data;

	assert.deepEqual( clamped.valueRange.toArray(), [ - 1, 1 ] );

	for ( let i = 0; i < float.length; i ++ ) {

		const expected = Math.min( 255, Math.max( 0, Math.round( ( float[ i ] + 1 ) / 2 * 255 ) ) );

		if ( cbytes[ i ] !== expected ) assert.fail( 'clamped value ' + i );

	}

	const [ flat ] = load( 'fog_zip_mask.vdb', l => l.setTextureType( UnsignedByteType ).setValueRange( new Vector2( 1, 1 ) ) );
	assert.ok( flat.texture.image.data.every( v => v === 0 ), 'an empty range maps everything to 0' );

} );

test( 'setBoundingBox', () => {

	const [ reference ] = load( 'fog_zip_mask.vdb', l => l.setTextureType( FloatType ) );
	const min = reference.bbox.min, max = reference.bbox.max;

	// Larger box: padded with the background value.

	const larger = new Box3( min.clone().subScalar( 3 ), max.clone().addScalar( 5 ) );
	const [ padded ] = load( 'fog_zip_mask.vdb', l => l.setTextureType( FloatType ).setBoundingBox( larger ) );

	assert.deepEqual( padded.bbox, larger );
	assert.deepEqual( padded.valueRange, reference.valueRange );

	const size = larger.getSize( new Vector3() ).addScalar( 1 );
	assert.deepEqual( [ padded.texture.image.width, padded.texture.image.height, padded.texture.image.depth ], size.toArray() );

	for ( let z = larger.min.z; z <= larger.max.z; z ++ ) {

		for ( let y = larger.min.y; y <= larger.max.y; y ++ ) {

			for ( let x = larger.min.x; x <= larger.max.x; x ++ ) {

				const inside = reference.bbox.containsPoint( new Vector3( x, y, z ) );
				const expected = inside ? reference.texture.image.data[ index( reference, x, y, z ) ] : reference.background;

				if ( padded.texture.image.data[ index( padded, x, y, z ) ] !== expected ) assert.fail( 'padded value at ' + [ x, y, z ] );

			}

		}

	}

	// Smaller box: cropped.

	const smaller = new Box3( min.clone().addScalar( 7 ), max.clone().subScalar( 9 ) );
	const [ cropped ] = load( 'fog_zip_mask.vdb', l => l.setTextureType( FloatType ).setBoundingBox( smaller ) );

	assert.deepEqual( cropped.bbox, smaller );

	for ( let z = smaller.min.z; z <= smaller.max.z; z ++ ) {

		for ( let y = smaller.min.y; y <= smaller.max.y; y ++ ) {

			for ( let x = smaller.min.x; x <= smaller.max.x; x ++ ) {

				if ( cropped.texture.image.data[ index( cropped, x, y, z ) ] !== reference.texture.image.data[ index( reference, x, y, z ) ] ) assert.fail( 'cropped value at ' + [ x, y, z ] );

			}

		}

	}

	// Disjoint box: all background. Empty grid: a texture of background values.

	const disjoint = new Box3( max.clone().addScalar( 10 ), max.clone().addScalar( 12 ) );
	const [ outside ] = load( 'fog_zip_mask.vdb', l => l.setTextureType( FloatType ).setBoundingBox( disjoint ) );
	assert.ok( outside.texture.image.data.every( v => v === reference.background ) );
	assert.deepEqual( outside.valueRange.toArray(), [ reference.background, reference.background ] );

	const [ empty ] = load( 'empty.vdb', l => l.setTextureType( FloatType ).setBoundingBox( new Box3( new Vector3( 0, 0, 0 ), new Vector3( 1, 2, 3 ) ) ) );
	assert.equal( empty.texture.image.data.length, 2 * 3 * 4 );
	assert.ok( empty.texture.image.data.every( v => v === empty.background ) );
	assert.deepEqual( empty.bbox.max.toArray(), [ 1, 2, 3 ] );

	// Every grid of a file gets the same texture size, tiles included.

	const box = new Box3( new Vector3( - 20, - 20, - 20 ), new Vector3( 50, 60, 70 ) );
	const grids = load( 'multi_zip_mask.vdb', l => l.setBoundingBox( box ) );

	assert.ok( grids.length > 1 );

	for ( const grid of grids ) {

		assert.deepEqual( grid.bbox, box );
		assert.deepEqual( [ grid.texture.image.width, grid.texture.image.height, grid.texture.image.depth ], [ 71, 81, 91 ] );

	}

	assert.throws( () => load( 'fog_zip_mask.vdb', l => l.setBoundingBox( new Box3( new Vector3( 1, 0, 0 ), new Vector3( 0, 0, 0 ) ) ) ), /Invalid bounding box/ );

} );
