// Compares the exported files with the copies OpenVDB wrote (see check.sh): the
// values, active bounds and transforms must match, and so must the voxel counts
// vdb_print measured and the ones the exporter stored in the metadata.

import { readFileSync, readdirSync } from 'node:fs';
import { FloatType } from 'three';
import { VDBLoader } from '../../VDBLoader.js';

console.warn = () => {};

const dir = new URL( './', import.meta.url );

function read( file ) {

	const buffer = readFileSync( new URL( file, dir ) );
	return buffer.buffer.slice( buffer.byteOffset, buffer.byteOffset + buffer.byteLength );

}

const load = ( buffer, setup = l => l ) => setup( new VDBLoader().setTextureType( FloatType ) ).parse( buffer );

let checks = 0, failures = 0;

const fail = message => {

	failures ++;
	console.log( message );

};

for ( const file of readdirSync( new URL( 'out/', dir ) ).filter( f => f.endsWith( '.vdb' ) ) ) {

	const name = file.replace( /\.vdb$/, '' );
	const exported = read( 'out/' + file );
	const ours = load( exported );

	// vdb_print lists grids in its own order, so compare the counts as sorted lists.
	const printed = readFileSync( new URL( 'openvdb/' + name + '.txt', dir ), 'utf8' );
	const counts = [ ...printed.matchAll( /Number of active voxels:\s+([\d,]+)/g ) ].map( m => Number( m[ 1 ].replace( /,/g, '' ) ) ).sort( ( a, b ) => a - b );
	const stored = ours.map( g => g.metadata.file_voxel_count ).sort( ( a, b ) => a - b );

	checks ++;
	if ( JSON.stringify( counts ) !== JSON.stringify( stored ) ) fail( file + ': voxel counts ' + stored + ', OpenVDB counts ' + counts );

	for ( const copy of [ 'openvdb/' + name + '.vdb', 'openvdb/' + name + '.nvdb' ] ) {

		const buffer = read( copy );
		const theirs = load( buffer );

		for ( const grid of ours ) {

			checks ++;

			const other = theirs.find( g => g.name === grid.name );

			if ( other === undefined ) {

				fail( copy + ' "' + grid.name + '": missing' );
				continue;

			}

			if ( grid.texture === null ) {

				if ( other.texture !== null ) fail( copy + ' "' + grid.name + '": not empty' );
				continue;

			}

			const [ same ] = load( buffer, l => l.setGridNames( [ grid.name ] ).setBoundingBox( grid.bbox ) );
			const a = grid.texture.image.data, b = same.texture.image.data;

			let differ = 0;
			for ( let i = 0; i < a.length; i ++ ) if ( a[ i ] !== b[ i ] ) differ ++;

			if ( differ > 0 ) fail( copy + ' "' + grid.name + '": ' + differ + ' values differ' );
			if ( other.bbox.equals( grid.bbox ) === false ) fail( copy + ' "' + grid.name + '": active bounds differ' );
			if ( other.transform.equals( grid.transform ) === false ) fail( copy + ' "' + grid.name + '": transform differs' );

		}

	}

}

console.log( checks + ' checks, ' + failures + ' failures' );
process.exitCode = failures > 0 ? 1 : 0;
