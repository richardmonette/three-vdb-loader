import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { VDBLoader } from '../VDBLoader.js';

const fixtures = new URL( './fixtures/', import.meta.url );
const reference = JSON.parse( readFileSync( new URL( './reference.json', import.meta.url ) ) );

function load( file ) {

	const buffer = readFileSync( new URL( file, fixtures ) );
	return new VDBLoader().parse( buffer.buffer.slice( buffer.byteOffset, buffer.byteOffset + buffer.byteLength ) );

}

for ( const file of readdirSync( fixtures ).filter( f => f.endsWith( '.vdb' ) ).sort() ) {

	test( file, ( t ) => {

		const warn = t.mock.method( console, 'warn', () => {} );
		const grids = load( file );

		assert.deepEqual( grids.map( g => g.name ).sort(), reference[ file ].map( g => g.name ).sort() );

		for ( const expected of reference[ file ] ) {

			const grid = grids.find( g => g.name === expected.name );

			assert.equal( grid.background, expected.background, expected.name + ' background' );

			grid.transform.elements.forEach( ( value, i ) => {

				assert.ok( Math.abs( value - expected.matrix[ i ] ) < 1e-12, expected.name + ' transform' );

			} );

			if ( expected.empty ) {

				assert.equal( grid.texture, null );
				assert.ok( grid.bbox.isEmpty() );
				continue;

			}

			assert.deepEqual( grid.bbox.min.toArray(), expected.min, expected.name + ' bbox min' );
			assert.deepEqual( grid.bbox.max.toArray(), expected.max, expected.name + ' bbox max' );

			const data = grid.texture.image.data;
			const hash = createHash( 'sha256' ).update( new Uint8Array( data.buffer, data.byteOffset, data.byteLength ) ).digest( 'hex' );

			assert.equal( hash, expected.sha256, expected.name + ' voxel values' );

		}

		if ( file.startsWith( 'multi' ) ) {

			assert.match( String( warn.mock.calls[ 0 ].arguments[ 0 ] ), /Skipping unsupported grid "vel"/ );

		}

	} );

}
