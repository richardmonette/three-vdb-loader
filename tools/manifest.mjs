// Writes the manifest of a frame sequence for VDBSequenceLoader.
//
//   node tools/manifest.mjs <directory> [--fps 30] [--grids density,temperature] [--out sequence.json]
//
// Every .nvdb and .vdb file in the directory (sorted by name) is one frame. The
// manifest records the frame rate, the frame file names, the union of the index
// space bounding boxes and the value range of each grid over all frames, so the
// loader can allocate the textures once and normalize byte textures consistently.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FloatType } from 'three';
import { VDBLoader } from '../VDBLoader.js';

const args = process.argv.slice( 2 );
const directory = args.find( a => a.startsWith( '--' ) === false );

if ( directory === undefined ) {

	console.error( 'usage: node tools/manifest.mjs <directory> [--fps 30] [--grids a,b] [--out sequence.json]' );
	process.exit( 1 );

}

function option( name, fallback ) {

	const i = args.indexOf( '--' + name );
	return i === - 1 ? fallback : args[ i + 1 ];

}

const fps = Number( option( 'fps', 30 ) );
const grids = option( 'grids', null );
const out = option( 'out', join( directory, 'sequence.json' ) );

const frames = readdirSync( directory ).filter( f => /\.(nvdb|vdb)$/.test( f ) ).sort();

if ( frames.length === 0 ) {

	console.error( 'No .nvdb or .vdb files in ' + resolve( directory ) );
	process.exit( 1 );

}

const loader = new VDBLoader().setTextureType( FloatType ).setGridNames( grids === null ? null : grids.split( ',' ) );

const bbox = [ Infinity, Infinity, Infinity, - Infinity, - Infinity, - Infinity ];
const valueRange = {};

let bytes = 0;

for ( const frame of frames ) {

	const buffer = readFileSync( join( directory, frame ) );
	bytes += buffer.byteLength;

	for ( const grid of loader.parse( buffer.buffer.slice( buffer.byteOffset, buffer.byteOffset + buffer.byteLength ) ) ) {

		const range = valueRange[ grid.name ] || ( valueRange[ grid.name ] = [ Infinity, - Infinity ] );
		range[ 0 ] = Math.min( range[ 0 ], grid.valueRange.x );
		range[ 1 ] = Math.max( range[ 1 ], grid.valueRange.y );

		if ( grid.texture === null ) continue;

		bbox[ 0 ] = Math.min( bbox[ 0 ], grid.bbox.min.x );
		bbox[ 1 ] = Math.min( bbox[ 1 ], grid.bbox.min.y );
		bbox[ 2 ] = Math.min( bbox[ 2 ], grid.bbox.min.z );
		bbox[ 3 ] = Math.max( bbox[ 3 ], grid.bbox.max.x );
		bbox[ 4 ] = Math.max( bbox[ 4 ], grid.bbox.max.y );
		bbox[ 5 ] = Math.max( bbox[ 5 ], grid.bbox.max.z );

	}

}

if ( bbox[ 0 ] > bbox[ 3 ] ) bbox.fill( 0 );

const manifest = { fps, frames, bbox, valueRange };

writeFileSync( out, JSON.stringify( manifest, null, '\t' ) + '\n' );

const size = [ bbox[ 3 ] - bbox[ 0 ] + 1, bbox[ 4 ] - bbox[ 1 ] + 1, bbox[ 5 ] - bbox[ 2 ] + 1 ];

console.log( frames.length + ' frames, ' + ( bytes / 1048576 ).toFixed( 1 ) + ' MB, texture ' + size.join( 'x' ) + ', ' + Object.entries( valueRange ).map( ( [ name, range ] ) => name + ' ' + range.map( v => + v.toPrecision( 4 ) ).join( '..' ) ).join( ', ' ) );
console.log( 'wrote ' + out );
