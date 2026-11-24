import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FloatType, HalfFloatType, Matrix4, UnsignedByteType, Vector3 } from 'three';
import { VDBLoader } from '../VDBLoader.js';
import { createSurfaceGeometry } from '../VDBSurface.js';

// surface/sphere.vdb and surface/cube.vdb are level sets written by OpenVDB 10:
//   vdb_tool -sphere radius=1 center="(0.3,-0.2,0.1)" voxel=0.1 width=3 name=sphere -write codec=zip surface/sphere.vdb
//   vdb_tool -platonic faces=6 scale=1 voxel=0.05 width=3 name=cube -write codec=zip surface/cube.vdb

const fixtures = new URL( './fixtures/', import.meta.url );

function load( file, setup = loader => loader ) {

	const buffer = readFileSync( new URL( file, fixtures ) );
	return setup( new VDBLoader().setTextureType( FloatType ) ).parse( buffer.buffer.slice( buffer.byteOffset, buffer.byteOffset + buffer.byteLength ) );

}

// Volume, area, and whether every directed edge is matched by its reverse exactly
// once: then the mesh is closed and its triangles are consistently oriented.
function measure( geometry ) {

	const position = geometry.attributes.position.array;
	const index = geometry.index.array;
	const edges = new Map();
	const a = new Vector3(), b = new Vector3(), c = new Vector3(), cross = new Vector3();

	let volume = 0, area = 0;

	for ( let i = 0; i < index.length; i += 3 ) {

		const corners = [ index[ i ], index[ i + 1 ], index[ i + 2 ] ];

		for ( let k = 0; k < 3; k ++ ) {

			const key = corners[ k ] + ',' + corners[ ( k + 1 ) % 3 ];
			edges.set( key, ( edges.get( key ) || 0 ) + 1 );

		}

		a.fromArray( position, corners[ 0 ] * 3 );
		b.fromArray( position, corners[ 1 ] * 3 );
		c.fromArray( position, corners[ 2 ] * 3 );

		volume += a.dot( cross.crossVectors( b, c ) ) / 6;
		area += cross.crossVectors( b.clone().sub( a ), c.clone().sub( a ) ).length() / 2;

	}

	let closed = true;

	for ( const [ key, count ] of edges ) {

		const [ from, to ] = key.split( ',' );
		if ( count !== 1 || edges.get( to + ',' + from ) !== 1 ) closed = false;

	}

	return { volume, area, closed, triangles: index.length / 3 };

}

const CENTER = new Vector3( 0.3, - 0.2, 0.1 );

function sphereError( geometry ) {

	const position = geometry.attributes.position.array;
	const normal = geometry.attributes.normal.array;
	const p = new Vector3(), n = new Vector3();

	let radius = 0, direction = 1;

	for ( let i = 0; i < position.length; i += 3 ) {

		p.fromArray( position, i ).sub( CENTER );
		n.fromArray( normal, i );

		radius = Math.max( radius, Math.abs( p.length() - 1 ) );
		direction = Math.min( direction, p.normalize().dot( n ) );

	}

	return { radius, direction };

}

test( 'level set sphere', () => {

	const [ grid ] = load( 'surface/sphere.vdb' );
	const geometry = createSurfaceGeometry( grid );
	const { volume, area, closed } = measure( geometry );
	const { radius, direction } = sphereError( geometry );

	assert.ok( closed, 'closed and consistently oriented' );
	assert.ok( radius < 0.02 * 0.1, 'vertices within 0.02 voxels of the sphere: ' + radius / 0.1 );
	assert.ok( direction > 0.9999, 'normals point outwards along the radius: ' + direction );
	assert.ok( Math.abs( volume / ( 4 / 3 * Math.PI ) - 1 ) < 0.01, 'volume ' + volume );
	assert.ok( Math.abs( area / ( 4 * Math.PI ) - 1 ) < 0.01, 'area ' + area );

	assert.equal( geometry.index.array.constructor, Uint16Array );
	assert.equal( geometry.attributes.position.count, geometry.attributes.normal.count );

} );

test( 'level set cube', () => {

	const [ grid ] = load( 'surface/cube.vdb' );
	const { volume, area, closed } = measure( createSurfaceGeometry( grid ) );

	assert.ok( closed );
	assert.ok( Math.abs( volume - 1 ) < 1e-4, 'volume ' + volume );
	assert.ok( Math.abs( area - 6 ) < 1e-3, 'area ' + area );

} );

test( 'isovalues and fog volumes', () => {

	const [ grid ] = load( 'surface/sphere.vdb' );

	// A level set offset by 0.1 is a sphere of radius 1.1.
	const { volume } = measure( createSurfaceGeometry( grid, { isovalue: 0.1 } ) );
	assert.ok( Math.abs( volume / ( 4 / 3 * Math.PI * 1.1 ** 3 ) - 1 ) < 0.01, 'offset volume ' + volume );

	// Fog volumes: the surface encloses the voxels denser than the isovalue.
	const [ fog ] = load( 'fog_zip_mask.vdb' );
	const low = measure( createSurfaceGeometry( fog, { isovalue: fog.valueRange.y * 0.1 } ) );
	const high = measure( createSurfaceGeometry( fog, { isovalue: fog.valueRange.y * 0.5 } ) );

	assert.ok( low.closed && high.closed );
	assert.ok( high.volume > 0 && low.volume > high.volume, 'denser surfaces are inside lighter ones' );

	// Nothing denser than the maximum.
	assert.equal( createSurfaceGeometry( fog, { isovalue: fog.valueRange.y * 2 } ).index.count, 0 );

} );

test( 'texture types and downsampled grids', () => {

	const [ half ] = load( 'surface/sphere.vdb', l => l.setTextureType( HalfFloatType ) );
	const fromHalf = sphereError( createSurfaceGeometry( half ) );
	assert.ok( fromHalf.radius < 0.05 * 0.1, 'half floats: ' + fromHalf.radius / 0.1 );

	const [ bytes ] = load( 'surface/sphere.vdb', l => l.setTextureType( UnsignedByteType ) );
	const fromBytes = sphereError( createSurfaceGeometry( bytes ) );
	assert.ok( fromBytes.radius < 0.1 * 0.1, 'bytes: ' + fromBytes.radius / 0.1 );
	assert.throws( () => createSurfaceGeometry( { texture: bytes.texture } ), /valueRange/ );

	// Texels of a downsampled grid are the centers of the cubes they average.
	const [ coarse ] = load( 'surface/sphere.vdb', l => l.setMaxResolution( 10 ) );
	assert.ok( coarse.voxelsPerTexel > 1 );

	const geometry = createSurfaceGeometry( coarse );
	geometry.computeBoundingBox();
	const center = geometry.boundingBox.getCenter( new Vector3() );

	assert.ok( measure( geometry ).closed );
	assert.ok( center.distanceTo( CENTER ) < 0.1, 'centered: ' + center.toArray() );
	assert.ok( sphereError( geometry ).radius < 0.1 * coarse.voxelsPerTexel );

} );

test( 'transforms', () => {

	const [ grid ] = load( 'surface/sphere.vdb' );
	const reference = measure( createSurfaceGeometry( grid ) );

	// A mirrored transform keeps the triangles facing outwards.
	const mirrored = Object.assign( {}, grid, { transform: grid.transform.clone().premultiply( new Matrix4().makeScale( - 1, 1, 1 ) ) } );
	const mirror = measure( createSurfaceGeometry( mirrored ) );

	assert.ok( mirror.closed );
	assert.ok( Math.abs( mirror.volume - reference.volume ) < 1e-9 );

	// A non-uniform scale stretches the sphere into an ellipsoid with normals that stay perpendicular to it.
	const stretched = Object.assign( {}, grid, { transform: grid.transform.clone().premultiply( new Matrix4().makeScale( 2, 1, 1 ) ) } );
	const geometry = createSurfaceGeometry( stretched );
	const position = geometry.attributes.position.array, normal = geometry.attributes.normal.array;
	const center = CENTER.clone().multiply( new Vector3( 2, 1, 1 ) );

	let worst = 1;

	for ( let i = 0; i < position.length; i += 3 ) {

		// The gradient of ( x / 2 )² + y² + z² - 1 is the ellipsoid normal.
		const p = new Vector3().fromArray( position, i ).sub( center );
		const expected = new Vector3( p.x / 4, p.y, p.z ).normalize();
		worst = Math.min( worst, expected.dot( new Vector3().fromArray( normal, i ) ) );

	}

	assert.ok( worst > 0.999, 'ellipsoid normals: ' + worst );
	assert.ok( Math.abs( measure( geometry ).volume / reference.volume - 2 ) < 1e-6 );

} );

test( 'empty and vector grids', () => {

	const [ empty ] = load( 'empty.vdb' );
	assert.equal( createSurfaceGeometry( empty ).attributes.position, undefined );

	const [ vectors ] = load( 'vec3s_random_zip_mask.vdb' );
	assert.throws( () => createSurfaceGeometry( vectors ), /scalar/ );

} );
