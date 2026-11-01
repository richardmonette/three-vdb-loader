import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Box3, FloatType, HalfFloatType, UnsignedByteType, Vector2, Vector3 } from 'three';
import { VDBLoader } from '../VDBLoader.js';
import { VDBSequenceLoader } from '../VDBSequenceLoader.js';

const fixtures = new URL( './fixtures/', import.meta.url );

function read( file ) {

	const buffer = readFileSync( new URL( file, fixtures ) );
	return buffer.buffer.slice( buffer.byteOffset, buffer.byteOffset + buffer.byteLength );

}

// Three frames with different bounds, so the union matters.
const frames = {
	'http://test/frames/a.nvdb': read( 'nano/fog_fp8_zip.nvdb' ),
	'http://test/frames/b.nvdb': read( 'nano/multi_float_zip.nvdb' ),
	'http://test/frames/c.nvdb': read( 'nano/levelset_fp16_blosc.nvdb' ),
	'http://test/frames/open.vdb': read( 'fog_zip_mask.vdb' ),
	'http://test/frames/sequence.json': new TextEncoder().encode( JSON.stringify( { fps: 10, frames: [ 'a.nvdb', 'b.nvdb', 'c.nvdb' ] } ) ).buffer
};

const delays = new Map();

globalThis.fetch = async ( url ) => {

	const buffer = frames[ url ];

	if ( delays.has( url ) ) await delays.get( url );

	if ( buffer === undefined ) return { ok: false, status: 404, statusText: 'Not Found' };

	return { ok: true, arrayBuffer: async () => buffer.slice( 0 ), json: async () => JSON.parse( new TextDecoder().decode( buffer ) ) };

};

function direct( file, names, box, type = FloatType, range = null ) {

	return new VDBLoader().setGridNames( names ).setTextureType( type ).setBoundingBox( box ).setValueRange( range ).parse( frames[ file ] );

}

function until( condition, timeout = 5000 ) {

	return new Promise( ( resolve, reject ) => {

		const start = Date.now();
		const tick = () => condition() ? resolve() : Date.now() - start > timeout ? reject( new Error( 'timeout' ) ) : setTimeout( tick, 5 );
		tick();

	} );

}

test( 'sequence from a manifest URL', async () => {

	const progress = [];
	const loader = new VDBSequenceLoader().setGridNames( [ 'density' ] ).setTextureType( FloatType ).setWorkerLimit( 0 );
	const sequence = await loader.loadAsync( 'http://test/frames/sequence.json', ( loaded, total ) => progress.push( [ loaded, total ] ) );

	assert.equal( sequence.frameCount, 3 );
	assert.equal( sequence.fps, 10 );
	assert.equal( sequence.frame, 0 );
	assert.equal( sequence.grids.length, 1 );

	// Union of the three frames' bounds, read from the NanoVDB headers.
	const [ a ] = direct( 'http://test/frames/a.nvdb', [ 'density' ], null );
	const [ b ] = direct( 'http://test/frames/b.nvdb', [ 'density' ], null );
	const union = a.bbox.clone().union( b.bbox );

	assert.deepEqual( sequence.bbox, union, 'c has no density grid' );
	assert.deepEqual( sequence.grids[ 0 ].bbox, union );

	const texture = sequence.grids[ 0 ].texture;
	const size = union.getSize( new Vector3() ).addScalar( 1 );
	assert.deepEqual( [ texture.image.width, texture.image.height, texture.image.depth ], size.toArray() );

	const [ expected0 ] = direct( 'http://test/frames/a.nvdb', [ 'density' ], union );
	assert.deepEqual( texture.image.data, expected0.texture.image.data );

	await until( () => sequence.loaded === 3 );
	assert.deepEqual( progress.at( - 1 ), [ 3, 3 ] );

	// Seek.
	sequence.frame = 1;
	await until( () => sequence.frame === 1 );

	const [ expected1 ] = direct( 'http://test/frames/b.nvdb', [ 'density' ], union );
	assert.deepEqual( texture.image.data, expected1.texture.image.data );
	assert.equal( texture.image.data.length, expected0.texture.image.data.length );

	// Playback at 10 fps: 0.25 s is frame 2 from frame 0 after wrapping past frame 1.
	sequence.frame = 0;
	await until( () => sequence.frame === 0 );
	sequence.play();
	await until( () => sequence.ready === 3 );

	sequence.update( 0.25 );
	assert.equal( sequence.frame, 2 );

	// Frame c has no density grid: the texture keeps the data it had.
	assert.deepEqual( texture.image.data, expected0.texture.image.data );

	sequence.update( 0.1 );
	assert.equal( sequence.frame, 0, 'loops' );

	sequence.loop = false;
	sequence.update( 10 );
	assert.equal( sequence.frame, 2 );
	assert.equal( sequence.playing, false, 'stops at the end without loop' );

	sequence.dispose();

} );

test( 'sequence holds for frames that are not decoded yet', async () => {

	let release;
	delays.set( 'http://test/frames/c.nvdb', new Promise( r => release = r ) );

	const loader = new VDBSequenceLoader().setGridNames( [ 'density' ] ).setTextureType( HalfFloatType ).setWorkerLimit( 0 );
	const sequence = await loader.loadAsync( { fps: 10, frames: [ 'http://test/frames/a.nvdb', 'http://test/frames/b.nvdb', 'http://test/frames/c.nvdb' ], bbox: [ - 10, - 15, - 10, 15, 10, 15 ] } );

	assert.equal( sequence.grids[ 0 ].texture.type, HalfFloatType );
	assert.deepEqual( [ sequence.grids[ 0 ].texture.image.width, sequence.grids[ 0 ].texture.image.height, sequence.grids[ 0 ].texture.image.depth ], [ 26, 26, 26 ] );

	await until( () => sequence.loaded === 2 );
	await until( () => sequence.ready === 2 );

	sequence.play();
	sequence.update( 0.55 );
	assert.equal( sequence.frame, 1, 'cannot pass frame 2' );
	assert.ok( Math.abs( sequence.time - 0.2 ) < 1e-9, 'time waits at the missing frame' );

	release();
	await until( () => sequence.loaded === 3 );
	await until( () => sequence.ready === 3 );

	sequence.update( 0.0 );
	assert.equal( sequence.frame, 2 );

	delays.clear();
	sequence.dispose();

} );

test( 'byte textures use the manifest or the measured range', async () => {

	const loader = new VDBSequenceLoader().setGridNames( [ 'density' ] ).setTextureType( UnsignedByteType ).setWorkerLimit( 0 );
	const manifest = { fps: 30, frames: [ 'http://test/frames/a.nvdb', 'http://test/frames/b.nvdb' ], bbox: [ - 6, - 13, - 8, 12, 5, 10 ], valueRange: { density: [ 0, 2 ] } };
	const sequence = await loader.loadAsync( manifest );

	const grid = sequence.grids[ 0 ];
	assert.equal( grid.texture.type, UnsignedByteType );
	assert.deepEqual( grid.valueRange.toArray(), [ 0, 2 ] );

	const box = new Box3( new Vector3( - 6, - 13, - 8 ), new Vector3( 12, 5, 10 ) );
	const [ expected ] = direct( 'http://test/frames/a.nvdb', [ 'density' ], box, UnsignedByteType, new Vector2( 0, 2 ) );
	assert.deepEqual( grid.texture.image.data, expected.texture.image.data );

	sequence.dispose();

	// Without a range in the manifest it is measured over the frames.
	const measured = await new VDBSequenceLoader().setGridNames( [ 'density' ] ).setTextureType( UnsignedByteType ).setWorkerLimit( 0 )
		.loadAsync( { fps: 30, frames: [ 'http://test/frames/a.nvdb', 'http://test/frames/b.nvdb' ] } );

	const [ a ] = direct( 'http://test/frames/a.nvdb', [ 'density' ], null );
	const [ b ] = direct( 'http://test/frames/b.nvdb', [ 'density' ], null );

	assert.deepEqual( measured.grids[ 0 ].valueRange.toArray(), [ Math.min( a.valueRange.x, b.valueRange.x ), Math.max( a.valueRange.y, b.valueRange.y ) ] );
	measured.dispose();

} );

test( 'OpenVDB frames and errors', async () => {

	const sequence = await new VDBSequenceLoader().setTextureType( FloatType ).setWorkerLimit( 0 )
		.loadAsync( { fps: 24, frames: [ 'http://test/frames/open.vdb', 'http://test/frames/a.nvdb' ] } );

	const [ open ] = direct( 'http://test/frames/open.vdb', null, null );
	assert.deepEqual( sequence.bbox, open.bbox, 'OpenVDB bounds come from a full parse' );
	assert.equal( sequence.fps, 24 );
	sequence.dispose();

	await assert.rejects( new VDBSequenceLoader().loadAsync( 'http://test/frames/missing.json' ), /404/ );

} );

test( 'frames either side of the wanted one are decoded while paused', async () => {

	const sequence = await new VDBSequenceLoader().setGridNames( [ 'density' ] ).setTextureType( FloatType ).setWorkerLimit( 0 )
		.loadAsync( { fps: 10, frames: [ 'http://test/frames/a.nvdb', 'http://test/frames/b.nvdb', 'http://test/frames/c.nvdb' ] } );

	await until( () => sequence.loaded === 3 );

	// Paused at frame 1: both neighbours count as one frame away, and the far side wraps when looping.
	sequence.frame = 1;
	await until( () => sequence.frame === 1 );
	assert.equal( sequence.distance( 0 ), 1 );
	assert.equal( sequence.distance( 2 ), 1 );
	await until( () => sequence.ready === 3 );

	sequence.frame = 0;
	await until( () => sequence.frame === 0 );
	assert.equal( sequence.distance( 2 ), 1, 'wraps while looping' );
	sequence.loop = false;
	assert.equal( sequence.distance( 2 ), 2, 'no wrap without loop' );

	// Playing: only the frames ahead are near.
	sequence.loop = true;
	sequence.play();
	assert.equal( sequence.distance( 1 ), 1 );
	assert.equal( sequence.distance( 2 ), 2 );
	sequence.frame = 2;
	await until( () => sequence.frame === 2 );
	assert.equal( sequence.distance( 0 ), 1, 'the next frame after the last wraps to the first' );

	sequence.dispose();

} );
