import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Box3, FloatType, HalfFloatType, UnsignedByteType, Vector3 } from 'three';
import { VDBLoader } from '../VDBLoader.js';

// A downsampled grid must equal the full resolution grid, read over the same box,
// averaged over cubes of `voxelsPerTexel` voxels.

const fixtures = new URL( './fixtures/', import.meta.url );

function load( file, setup = loader => loader ) {

	const buffer = readFileSync( new URL( file, fixtures ) );
	return setup( new VDBLoader().setTextureType( FloatType ) ).parse( buffer.buffer.slice( buffer.byteOffset, buffer.byteOffset + buffer.byteLength ) );

}

function dimensions( grid ) {

	const { width, height, depth } = grid.texture.image;
	return [ width, height, depth ];

}

function assertDownsampled( grid, reference, message ) {

	const step = grid.voxelsPerTexel;
	const [ width, height, depth ] = dimensions( grid );
	const [ fullWidth, fullHeight, fullDepth ] = dimensions( reference );

	assert.deepEqual( [ fullWidth, fullHeight, fullDepth ], [ width * step, height * step, depth * step ], message + ': the box is a whole number of texels' );
	assert.deepEqual( reference.bbox, grid.bbox, message + ': bbox' );

	const data = grid.texture.image.data;
	const full = reference.texture.image.data;
	const stride = data.length / ( width * height * depth );
	const components = stride === 1 ? 1 : 3;

	let magnitude = 1;
	for ( let i = 0; i < full.length; i ++ ) magnitude = Math.max( magnitude, Math.abs( full[ i ] ) );

	const tolerance = magnitude * 1e-5;

	let min = Infinity, max = - Infinity;

	for ( let z = 0; z < depth; z ++ ) {

		for ( let y = 0; y < height; y ++ ) {

			for ( let x = 0; x < width; x ++ ) {

				for ( let c = 0; c < components; c ++ ) {

					let sum = 0;

					for ( let k = 0; k < step; k ++ ) {

						for ( let j = 0; j < step; j ++ ) {

							for ( let i = 0; i < step; i ++ ) {

								sum += full[ ( ( ( z * step + k ) * fullHeight + y * step + j ) * fullWidth + x * step + i ) * stride + c ];

							}

						}

					}

					const actual = data[ ( ( z * height + y ) * width + x ) * stride + c ];

					if ( ! ( Math.abs( actual - sum / step ** 3 ) <= tolerance ) ) {

						assert.fail( message + ': value at ' + [ x, y, z, c ] + ' is ' + actual + ', expected ' + sum / step ** 3 );

					}

					min = Math.min( min, actual );
					max = Math.max( max, actual );

				}

			}

		}

	}

	assert.deepEqual( grid.valueRange.toArray(), [ min, max ], message + ': valueRange is measured on the downsampled values' );

}

const files = [
	'fog_zip_mask.vdb',
	'fog_savehalf_blosc.vdb',
	'levelset_blosc_mask.vdb',
	'tiles_zip_mask.vdb',
	'multi_zip_mask.vdb',
	'double_zip_mask.vdb',
	'half_zip_mask.vdb',
	'random_zip.vdb',
	'vec3s_random_zip_mask.vdb',
	'vec3s_tiles_blosc_mask.vdb',
	'vec3d_zip_mask.vdb',
	'nano/fog_float_zip.nvdb',
	'nano/fog_fp8_zip.nvdb',
	'nano/fog_fpN_zip.nvdb',
	'nano/levelset_fp16_blosc.nvdb',
	'nano/tiles_float_zip.nvdb',
	'nano/multi_fp8_blosc.nvdb',
	'nano/double_zip.nvdb',
	'nano/vec3s_tiles_blosc.nvdb'
];

for ( const file of files ) {

	test( 'setMaxResolution ' + file, () => {

		const originals = load( file );

		let downsampled = 0;

		for ( const resolution of [ 8, 5 ] ) {

			const grids = load( file, l => l.setMaxResolution( resolution ) );

			assert.equal( grids.length, originals.length );

			for ( let g = 0; g < grids.length; g ++ ) {

				const grid = grids[ g ];
				const original = originals[ g ];
				const message = file + ' "' + grid.name + '" at ' + resolution;

				const longest = Math.max( ...dimensions( original ) );
				const step = Math.ceil( longest / resolution );

				assert.equal( grid.voxelsPerTexel, step, message + ': voxelsPerTexel' );

				if ( step === 1 ) {

					assert.deepEqual( grid.texture.image.data, original.texture.image.data, message + ': a grid that fits is unchanged' );
					continue;

				}

				downsampled ++;

				assert.equal( original.voxelsPerTexel, 1 );
				assert.ok( Math.max( ...dimensions( grid ) ) <= resolution, message + ': fits the limit' );
				assert.deepEqual( dimensions( grid ), dimensions( original ).map( n => Math.ceil( n / step ) ), message + ': size' );
				assert.deepEqual( grid.bbox.min, original.bbox.min, message + ': the box keeps its minimum' );
				assert.ok( grid.bbox.containsBox( original.bbox ), message + ': the box covers the active voxels' );

				const [ reference ] = load( file, l => l.setGridNames( [ grid.name ] ).setBoundingBox( grid.bbox ) );

				assertDownsampled( grid, reference, message );

			}

		}

		assert.ok( downsampled >= 2, file + ': the fixture is larger than the limits' );

	} );

}

test( 'setMaxResolution leaves grids that fit unchanged', () => {

	for ( const file of [ 'fog_zip_mask.vdb', 'vec3s_random_zip_mask.vdb', 'nano/fog_fp8_zip.nvdb' ] ) {

		const [ original ] = load( file );
		const longest = Math.max( ...dimensions( original ) );

		for ( const resolution of [ longest, longest + 1, 4096 ] ) {

			const [ grid ] = load( file, l => l.setMaxResolution( resolution ) );

			assert.equal( grid.voxelsPerTexel, 1 );
			assert.deepEqual( grid.bbox, original.bbox );
			assert.deepEqual( grid.valueRange, original.valueRange );
			assert.deepEqual( grid.texture.image.data, original.texture.image.data );

		}

		const [ reset ] = load( file, l => l.setMaxResolution( 8 ).setMaxResolution( null ) );
		assert.deepEqual( reset.texture.image.data, original.texture.image.data );

	}

} );

test( 'setMaxResolution with setBoundingBox', () => {

	const [ original ] = load( 'fog_zip_mask.vdb' );

	// A box that crops one side and pads the other.
	const box = new Box3( original.bbox.min.clone().addScalar( 5 ), original.bbox.max.clone().addScalar( 9 ) );
	const [ grid ] = load( 'fog_zip_mask.vdb', l => l.setBoundingBox( box ).setMaxResolution( 10 ) );

	assert.ok( grid.voxelsPerTexel > 1 );
	assert.deepEqual( grid.bbox.min, box.min );
	assert.ok( grid.bbox.containsBox( box ) );

	const [ reference ] = load( 'fog_zip_mask.vdb', l => l.setBoundingBox( grid.bbox ) );

	assertDownsampled( grid, reference, 'cropped and padded' );

	// Every grid of a file gets the same texture size.
	const shared = new Box3( new Vector3( - 20, - 20, - 20 ), new Vector3( 50, 60, 70 ) );
	const grids = load( 'multi_zip_mask.vdb', l => l.setBoundingBox( shared ).setMaxResolution( 32 ) );

	assert.ok( grids.length > 1 );

	for ( const grid of grids ) {

		assert.equal( grid.voxelsPerTexel, 3 );
		assert.deepEqual( dimensions( grid ), [ 24, 27, 31 ] );
		assert.deepEqual( grid.bbox, new Box3( shared.min, new Vector3( 51, 60, 72 ) ) );

	}

	// An empty grid is a texture of background values.
	const [ empty ] = load( 'empty.vdb', l => l.setBoundingBox( new Box3( new Vector3( 0, 0, 0 ), new Vector3( 9, 9, 9 ) ) ).setMaxResolution( 4 ) );

	assert.equal( empty.voxelsPerTexel, 3 );
	assert.deepEqual( dimensions( empty ), [ 4, 4, 4 ] );
	assert.ok( empty.texture.image.data.every( v => v === empty.background ) );

	const [ none ] = load( 'empty.vdb', l => l.setMaxResolution( 4 ) );

	assert.equal( none.texture, null );
	assert.equal( none.voxelsPerTexel, 1 );

} );

test( 'setMaxResolution loads grids that are too large for a dense texture', () => {

	const [ original ] = load( 'fog_zip_mask.vdb' );
	const box = new Box3( new Vector3( - 2048, - 2048, - 2048 ), new Vector3( 2047, 2047, 2047 ) );

	assert.ok( box.containsBox( original.bbox ) );
	assert.throws( () => load( 'fog_zip_mask.vdb', l => l.setBoundingBox( box ) ), /too large for a dense texture.*maximum resolution/ );

	const [ grid ] = load( 'fog_zip_mask.vdb', l => l.setBoundingBox( box ).setMaxResolution( 64 ) );

	assert.equal( grid.voxelsPerTexel, 64 );
	assert.deepEqual( dimensions( grid ), [ 64, 64, 64 ] );
	assert.deepEqual( grid.bbox, box );
	assert.equal( original.background, 0 );

	// The mean preserves the total of the grid.
	let total = 0, expected = 0;

	for ( const v of grid.texture.image.data ) total += v;
	for ( const v of original.texture.image.data ) expected += v;

	assert.ok( expected > 0 );
	assert.ok( Math.abs( total * 64 ** 3 - expected ) <= expected * 1e-4, 'total ' + total * 64 ** 3 + ', expected ' + expected );

} );

test( 'setMaxResolution with other texture types', () => {

	const [ float ] = load( 'levelset_blosc_mask.vdb', l => l.setMaxResolution( 16 ) );

	const [ half ] = load( 'levelset_blosc_mask.vdb', l => l.setTextureType( HalfFloatType ).setMaxResolution( 16 ) );

	assert.ok( half.texture.image.data instanceof Uint16Array );
	assert.equal( half.texture.image.data.length, float.texture.image.data.length );
	assert.deepEqual( half.valueRange, float.valueRange );

	const [ bytes ] = load( 'levelset_blosc_mask.vdb', l => l.setTextureType( UnsignedByteType ).setMaxResolution( 16 ) );
	const [ min, max ] = float.valueRange.toArray();

	assert.ok( bytes.texture.image.data instanceof Uint8Array );
	assert.deepEqual( bytes.valueRange, float.valueRange );

	for ( let i = 0; i < float.texture.image.data.length; i ++ ) {

		if ( bytes.texture.image.data[ i ] !== Math.round( ( float.texture.image.data[ i ] - min ) / ( max - min ) * 255 ) ) assert.fail( 'value ' + i );

	}

} );

test( 'setMaxResolution rejects invalid sizes', () => {

	for ( const value of [ 0, - 4, 0.5, NaN, '' ] ) {

		assert.throws( () => new VDBLoader().setMaxResolution( value ), /Invalid maximum resolution/, String( value ) );

	}

	assert.equal( new VDBLoader().setMaxResolution( 16.9 ).maxResolution, 16.9 );

	const [ grid ] = load( 'fog_zip_mask.vdb', l => l.setMaxResolution( 16.9 ) );
	assert.ok( Math.max( ...dimensions( grid ) ) <= 16, 'fractions round down' );

} );
