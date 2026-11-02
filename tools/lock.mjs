// Locks the demo sequences: the threejs.org example loads them from this repository's
// GitHub Pages site, so once published their paths and contents must not change.
//
//   node tools/lock.mjs            verifies examples/models/sequences against sequences.lock
//   node tools/lock.mjs --write    rewrites the lock after a deliberate change
//
// The lock lists every file under examples/models/sequences with its size and SHA-256.
// Verification fails if a locked file is missing or differs; new files are reported but allowed.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL( '../', import.meta.url ).pathname.replace( /^\/([A-Za-z]:)/, '$1' );
const directory = join( root, 'examples', 'models', 'sequences' );
const lockPath = join( directory, 'sequences.lock' );

function walk( dir, out = [] ) {

	for ( const name of readdirSync( dir ).sort() ) {

		const path = join( dir, name );

		if ( statSync( path ).isDirectory() ) walk( path, out );
		else if ( name !== 'sequences.lock' && name !== 'README.md' ) out.push( path );

	}

	return out;

}

function entry( path ) {

	const data = readFileSync( path );
	return relative( directory, path ).split( '\\' ).join( '/' ) + ' ' + data.length + ' ' + createHash( 'sha256' ).update( data ).digest( 'hex' );

}

const current = walk( directory ).map( entry );

if ( process.argv.includes( '--write' ) ) {

	writeFileSync( lockPath, current.join( '\n' ) + '\n' );
	console.log( 'locked ' + current.length + ' files in ' + relative( root, lockPath ) );
	process.exit( 0 );

}

if ( ! existsSync( lockPath ) ) {

	console.error( 'No lock file. Run node tools/lock.mjs --write' );
	process.exit( 1 );

}

const locked = readFileSync( lockPath, 'utf8' ).split( '\n' ).filter( Boolean );
const have = new Map( current.map( line => [ line.split( ' ' )[ 0 ], line ] ) );
const problems = [];

for ( const line of locked ) {

	const name = line.split( ' ' )[ 0 ];

	if ( have.has( name ) === false ) problems.push( 'missing: ' + name );
	else if ( have.get( name ) !== line ) problems.push( 'changed: ' + name );

}

const added = current.filter( line => locked.includes( line ) === false && locked.every( l => l.split( ' ' )[ 0 ] !== line.split( ' ' )[ 0 ] ) );

for ( const line of added ) console.log( 'new, not locked: ' + line.split( ' ' )[ 0 ] );

if ( problems.length > 0 ) {

	console.error( problems.join( '\n' ) );
	console.error( '\nThe demo sequences are published for the threejs.org example and must not change or move.' );
	console.error( 'If this change is deliberate, add new files under a new name instead, then run node tools/lock.mjs --write' );
	process.exit( 1 );

}

console.log( 'sequences match the lock (' + locked.length + ' files)' );
