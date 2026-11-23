// Exports every fixture, plus half float, uncompressed, downsampled and rotated
// variants, into test/openvdb/out/ for check.sh to read with OpenVDB.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { Data3DTexture, FloatType, Matrix4, Quaternion, RGBAFormat, Vector3 } from 'three';
import { VDBLoader } from '../../VDBLoader.js';
import { VDBExporter } from '../../VDBExporter.js';

console.warn = () => {};

const fixtures = new URL( '../fixtures/', import.meta.url );
const out = new URL( './out/', import.meta.url );

rmSync( out, { recursive: true, force: true } );
mkdirSync( out, { recursive: true } );

function read( file ) {

	const buffer = readFileSync( new URL( file, fixtures ) );
	return buffer.buffer.slice( buffer.byteOffset, buffer.byteOffset + buffer.byteLength );

}

const load = ( file, setup = l => l ) => setup( new VDBLoader().setTextureType( FloatType ) ).parse( read( file ) ).filter( g => g.texture !== null );
const save = ( name, buffer ) => writeFileSync( new URL( name + '.vdb', out ), Buffer.from( buffer ) );

const files = readdirSync( fixtures ).filter( f => f.endsWith( '.vdb' ) )
	.concat( readdirSync( new URL( 'nano/', fixtures ) ).filter( f => f.endsWith( '.nvdb' ) ).map( f => 'nano/' + f ) );

let count = 0;

for ( const file of files ) {

	const grids = load( file );
	if ( grids.length === 0 ) continue;

	const base = file.replace( 'nano/', 'nano_' ).replace( /\.n?vdb$/, '' );

	save( base, new VDBExporter().parse( grids ) );
	save( base + '.half', new VDBExporter().parse( grids, { halfFloat: true } ) );
	save( base + '.none', new VDBExporter().parse( grids, { compression: 'none' } ) );
	count += 3;

}

save( 'fog.downsampled', new VDBExporter().parse( load( 'fog_zip_mask.vdb', l => l.setMaxResolution( 8 ) ) ) );

const vectors = new Float32Array( 6 * 5 * 4 * 4 ).map( ( _, i ) => i % 4 === 3 ? 1 : Math.sin( i ) );
const texture = new Data3DTexture( vectors, 6, 5, 4 );
texture.format = RGBAFormat;
texture.type = FloatType;

const transform = new Matrix4().compose( new Vector3( 1, 2, 3 ), new Quaternion().setFromAxisAngle( new Vector3( 1, 1, 0 ).normalize(), 0.7 ), new Vector3( 0.5, 0.5, 0.5 ) );
save( 'vec3s.rotated', new VDBExporter().parse( { name: 'velocity', texture, transform, metadata: { class: 'staggered' } } ) );

console.log( 'exported', count + 2, 'files to', out.pathname );
