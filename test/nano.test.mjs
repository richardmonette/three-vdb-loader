import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Box3, FloatType, HalfFloatType, Vector3 } from 'three';
import { VDBLoader } from '../VDBLoader.js';

// Every NanoVDB fixture was converted from an OpenVDB fixture by nanovdb_convert
// (see fixtures/make-nano.sh). The grids must come out identical, up to the
// quantization of the Fp types.

const fixtures = new URL( './fixtures/', import.meta.url );

const sources = {
	'fog_float_zip.nvdb': 'fog_zip_mask.vdb',
	'fog_float_blosc.nvdb': 'fog_blosc.vdb',
	'fog_fp4_zip.nvdb': [ 'fog_mask.vdb', 4 ],
	'fog_fp8_zip.nvdb': [ 'fog_mask.vdb', 8 ],
	'fog_fp16_zip.nvdb': [ 'fog_mask.vdb', 16 ],
	'fog_fpN_zip.nvdb': [ 'fog_mask.vdb', 'absolute', 0.01 ],
	'fog_fpN_relative_blosc.nvdb': [ 'fog_mask.vdb', 'relative', 0.05 ],
	'fog_fp8_dither_blosc.nvdb': [ 'fog_mask.vdb', 8, 'dither' ],
	'levelset_float_zip.nvdb': 'levelset_zip_mask.vdb',
	'levelset_fp8_zip.nvdb': [ 'levelset_blosc_mask.vdb', 8 ],
	'levelset_fp16_blosc.nvdb': [ 'levelset_blosc_mask.vdb', 16 ],
	'levelset_unknown_zip.nvdb': 'levelset_unknown_zip_mask.vdb',
	'tiles_float_zip.nvdb': 'tiles_zip_mask.vdb',
	'tiles_fp8_blosc.nvdb': [ 'tiles_blosc_mask.vdb', 8 ],
	'multi_float_zip.nvdb': 'multi_zip_mask.vdb',
	'multi_fp8_blosc.nvdb': [ 'multi_blosc_mask.vdb', 8 ],
	'vec3s_random_zip.nvdb': 'vec3s_random_zip_mask.vdb',
	'vec3s_gradient_zip.nvdb': 'vec3s_gradient_blosc_mask.vdb',
	'vec3s_tiles_blosc.nvdb': 'vec3s_tiles_blosc_mask.vdb',
	'vec3s_with_scalar_blosc.nvdb': 'vec3s_with_scalar_blosc_mask.vdb',
	'random_fp8_zip.nvdb': [ 'random_zip_mask.vdb', 8 ],
	'random_savehalf_float_zip.nvdb': 'random_savehalf_zip_mask.vdb',
	'double_zip.nvdb': 'double_zip_mask.vdb',
	'empty.nvdb': 'empty.vdb',
	'unsupported_int32.nvdb': 'unsupported_int32.vdb'
};

function load( file, setup = loader => loader ) {

	const buffer = readFileSync( new URL( file, fixtures ) );
	return setup( new VDBLoader().setTextureType( FloatType ) ).parse( buffer.buffer.slice( buffer.byteOffset, buffer.byteOffset + buffer.byteLength ) );

}

const files = readdirSync( new URL( 'nano/', fixtures ) ).filter( f => f.endsWith( '.nvdb' ) ).sort();

assert.deepEqual( files, Object.keys( sources ).sort(), 'every NanoVDB fixture has a source' );

for ( const file of files ) {

	test( 'nano/' + file, ( t ) => {

		const warn = t.mock.method( console, 'warn', () => {} );
		const [ source, quantization, extra ] = [ sources[ file ] ].flat();

		const grids = load( 'nano/' + file );
		const references = load( source );

		assert.deepEqual( grids.map( g => g.name ).sort(), references.map( g => g.name ).sort() );

		for ( const reference of references ) {

			const grid = grids.find( g => g.name === reference.name );

			let type = { vec3s: 'vec3f', half: 'float' }[ reference.type ] || reference.type;

			if ( type === 'float' && typeof quantization === 'number' ) type = 'fp' + quantization;
			if ( type === 'float' && typeof quantization === 'string' ) type = 'fpN';

			assert.equal( grid.type, type, reference.name + ' type' );
			assert.equal( grid.metadata.class, reference.metadata.class || 'unknown', reference.name + ' class' );
			assert.deepEqual( [ grid.background ].flat().map( Math.fround ), [ reference.background ].flat().map( Math.fround ), reference.name + ' background' );

			grid.transform.elements.forEach( ( value, i ) => {

				assert.ok( Math.abs( value - reference.transform.elements[ i ] ) < 1e-12, reference.name + ' transform' );

			} );

			assert.deepEqual( grid.bbox, reference.bbox, reference.name + ' bbox' );

			if ( reference.texture === null ) {

				assert.equal( grid.texture, null );
				continue;

			}

			const data = grid.texture.image.data;
			const expected = reference.texture.image.data;

			assert.equal( data.length, expected.length, reference.name + ' size' );

			if ( quantization === undefined || grid.type === 'float' || grid.type === 'vec3f' || grid.type === 'double' ) {

				for ( let i = 0; i < data.length; i ++ ) {

					if ( data[ i ] !== expected[ i ] ) assert.fail( reference.name + ' value ' + i + ': ' + data[ i ] + ' vs ' + expected[ i ] );

				}

				assert.deepEqual( grid.valueRange, reference.valueRange, reference.name + ' valueRange' );
				continue;

			}

			// Quantized leaves: codes are relative to the leaf's minimum and quantum
			// (max - min) / (2^bits - 1), so the error is within half a quantum of the
			// grid's range, a full quantum with dithering.

			const [ min, max ] = reference.valueRange.toArray();

			let tolerance;

			if ( quantization === 'absolute' ) tolerance = extra;
			else if ( quantization === 'relative' ) tolerance = extra * Math.max( Math.abs( min ), Math.abs( max ) );
			else tolerance = ( max - min ) / ( 2 ** quantization - 1 ) * ( extra === 'dither' ? 1 : 0.5 );

			tolerance += 1e-6 * Math.max( 1, Math.abs( min ), Math.abs( max ) );

			let worst = 0;

			for ( let i = 0; i < data.length; i ++ ) {

				const error = Math.abs( data[ i ] - expected[ i ] );

				if ( error > tolerance ) assert.fail( reference.name + ' value ' + i + ': ' + data[ i ] + ' vs ' + expected[ i ] + ' (tolerance ' + tolerance + ')' );
				if ( error > worst ) worst = error;

			}

			if ( quantization === 8 && file.startsWith( 'tiles' ) === false ) assert.ok( worst > 0, reference.name + ' is quantized' );

		}

		if ( file.startsWith( 'unsupported' ) ) {

			assert.match( String( warn.mock.calls[ 0 ].arguments[ 0 ] ), /Skipping unsupported grid "ids" of type int32/ );

		} else {

			assert.equal( warn.mock.callCount(), 0 );

		}

	} );

}

test( 'nano options', () => {

	const names = load( 'nano/multi_float_zip.nvdb', l => l.setGridNames( [ 'temperature', 'vel' ] ) ).map( g => g.name ).sort();
	assert.deepEqual( names, [ 'temperature', 'vel' ] );
	assert.deepEqual( load( 'nano/multi_float_zip.nvdb', l => l.setGridNames( [ 'missing' ] ) ), [] );

	const box = new Box3( new Vector3( - 10, - 20, - 10 ), new Vector3( 20, 10, 20 ) );
	const [ reference ] = load( 'fog_zip_mask.vdb', l => l.setBoundingBox( box ) );
	const [ grid ] = load( 'nano/fog_fp16_zip.nvdb', l => l.setBoundingBox( box ) );

	assert.deepEqual( grid.bbox, box );
	assert.deepEqual( [ grid.texture.image.width, grid.texture.image.height, grid.texture.image.depth ], [ 31, 31, 31 ] );

	const [ half ] = load( 'nano/fog_fp8_zip.nvdb', l => l.setTextureType( HalfFloatType ) );
	assert.equal( half.texture.type, HalfFloatType );
	assert.ok( half.texture.image.data instanceof Uint16Array );
	assert.equal( half.texture.image.data.length, reference.texture.image.data.length === 31 * 31 * 31 ? 19 * 19 * 19 : 0 );

} );
