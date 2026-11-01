import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, constants } from 'node:zlib';
import { inflate, fromHalfFloat, toHalfFloat } from '../VDBCodecs.js';

function random( seed ) {

	return () => {

		seed = ( seed * 1664525 + 1013904223 ) >>> 0;
		return seed / 4294967296;

	};

}

function sample( kind, length, next ) {

	const data = new Uint8Array( length );

	switch ( kind ) {

		case 'random': for ( let i = 0; i < length; i ++ ) data[ i ] = next() * 256; break;
		case 'text': for ( let i = 0; i < length; i ++ ) data[ i ] = 97 + ( next() * 4 | 0 ); break;
		case 'runs': for ( let i = 0, v = 0; i < length; i ++ ) { if ( next() < 0.02 ) v = next() * 256; data[ i ] = v; } break;
		case 'zeros': break;

	}

	return data;

}

test( 'inflate', () => {

	const next = random( 7 );

	for ( const kind of [ 'random', 'text', 'runs', 'zeros' ] ) {

		for ( const length of [ 0, 1, 100, 70000, 300000 ] ) {

			const data = sample( kind, length, next );

			for ( const level of [ 0, 1, 6, 9 ] ) {

				for ( const strategy of [ constants.Z_DEFAULT_STRATEGY, constants.Z_FIXED, constants.Z_HUFFMAN_ONLY, constants.Z_RLE ] ) {

					const compressed = deflateSync( data, { level, strategy } );
					const out = inflate( new Uint8Array( compressed.buffer, compressed.byteOffset, compressed.byteLength ), length );

					assert.deepEqual( out, data, kind + ' ' + length + ' level ' + level + ' strategy ' + strategy );

				}

			}

		}

	}

	assert.throws( () => inflate( new Uint8Array( [ 0, 0 ] ), 0 ), /Not a zlib stream/ );
	assert.throws( () => inflate( new Uint8Array( deflateSync( new Uint8Array( 10 ) ) ), 9 ), /overflow|Invalid match/ );
	assert.throws( () => inflate( new Uint8Array( deflateSync( new Uint8Array( 10 ) ) ), 11 ), /decompressed size/ );

} );

test( 'half floats', () => {

	for ( let h = 0; h < 65536; h ++ ) {

		const value = fromHalfFloat( h );

		if ( value !== value ) {

			assert.equal( toHalfFloat( value ), 0x7e00 );

		} else if ( Math.abs( value ) === Infinity ) {

			assert.equal( toHalfFloat( value ), value > 0 ? 0x7bff : 0xfbff );

		} else {

			assert.equal( toHalfFloat( value ), h, 'round trip of ' + h.toString( 16 ) );

		}

	}

	assert.equal( fromHalfFloat( 0x3c00 ), 1 );
	assert.equal( fromHalfFloat( 0x0001 ), 2 ** - 24 );
	assert.equal( fromHalfFloat( 0x7bff ), 65504 );
	assert.equal( toHalfFloat( - 0 ), 0x8000 );
	assert.equal( toHalfFloat( 70000 ), 0x7bff );
	assert.equal( toHalfFloat( - 70000 ), 0xfbff );

	const next = random( 11 );
	const float32 = new Float32Array( 1 );
	const uint32 = new Uint32Array( float32.buffer );

	for ( let i = 0; i < 1000000; i ++ ) {

		uint32[ 0 ] = next() * 4294967296;

		const value = float32[ 0 ];

		if ( value !== value || Math.abs( value ) > 65504 ) continue;

		assert.equal( fromHalfFloat( toHalfFloat( value ) ), Math.f16round( value ), 'rounding of ' + value );

	}

	for ( let i = 0; i < 1000000; i ++ ) {

		const value = Math.fround( ( next() - 0.5 ) * 2 ** ( next() * 40 - 30 ) );

		assert.equal( fromHalfFloat( toHalfFloat( value ) ), Math.f16round( value ), 'rounding of ' + value );

	}

} );
