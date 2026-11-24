import {
	BufferAttribute,
	BufferGeometry,
	FloatType,
	HalfFloatType,
	Matrix3,
	Matrix4,
	RedFormat,
	UnsignedByteType,
	Vector3
} from 'three';
import { fromHalfFloat } from './VDBCodecs.js';

// The triangle table of marching cubes from Paul Bourke's "Polygonising a scalar
// field" (public domain), as in three.js' MarchingCubes.js: for each of the 256
// inside / outside patterns of a cube's corners, up to five triangles as triples of
// cube edges. Stored as one hexadecimal digit per entry, the edge plus one, 0 ending
// the list.

const TRIANGLE_TABLE =
	'0000000000000000194000000000000012a0000000000000294a92000000000023b000000000000019423b0000000000a3b13a00000000003943b9ba90000000' +
	'4c300000000000001c39c100000000002a134c00000000002c32aca9c00000004b2cb400000000001b219b9cb00000004a14cacba0000000a9bb9c0000000000' +
	'5890000000000000541845000000000012a958000000000052a582842000000023b958000000000045841523b0000000a3ba1395800000003ba3a83848a50000' +
	'9584c30000000000c58c353150000000a1295834c000000058ca5cac3a3200004b24cb89500000002cb25c2158c50000589a1cacbc14000058c5caacb0000000' +
	'a650000000000000a6519400000000001652610000000000965946426000000023ba65000000000041923b5a6000000063b65351300000003b64364654590000' +
	'a6534c00000000001c319c5a6000000016512634c000000032636939c5960000b4cb24a6500000005a61929b29cb000065161c6cbc14000065969bb9c0000000' +
	'a8968a0000000000a41a64684000000018912826800000002644680000000000a89a68b230000000b23a616416840000913936968b6300003b63644680000000' +
	'8a689a4c30000000a68a83a3138c000034c1292892680000c32c288260000000a69968b24b4c000068161a8c121bcb10cb1c14b619186810cb68c60000000000' +
	'b7600000000000001946b70000000000a126b700000000002942a96b7000000027637200000000002762374190000000a76a1713700000006a96936374390000' +
	'34cb760000000000c19c31b76000000012a34c6b700000006b72a3ac3a9c000074c764624000000019c1c61626c700004c714717616a000076a7acca90000000' +
	'6b7589000000000054158476b00000002a16b79580000000b762a82848a5000072376258900000002366374154580000958a16176137000084a8a543a6a737a0' +
	'4c3895b7600000006b758353138c000012a58934c6b70000a32ac3a5c8c56b709584c64626c7000062c6c721c8c515c016a176147c74958076a7ac58a8ca0000' +
	'b5a75b00000000005b75ab1940000000b12b71751000000094292797572b000025a235375000000041923a35a375000013553700000000009439355370000000' +
	'b5ab75c34000000019339c5ab5b700004c312717572b000075272b59232c9c20a75a47a24c7400009c2921c72a2575204c74711750000000759c790000000000' +
	'8b789b9ab00000001841b81ab78b0000b782b82892910000b78b82284000000023727929a978000037a3a278a1a484a089181771300000008437830000000000' +
	'34cb79b9a978000031838c1a878bab802912892b878b34c0c32c28b7278200009a7978a27c7424701a2c7800000000008918174c1c7100008c70000000000000' +
	'87c0000000000000419c87000000000012ac87000000000092a942c870000000b237c8000000000023b4197c800000003a13ba7c800000007c83b4b94ba90000' +
	'8347380000000000819871731000000038734812a00000002732972a99870000b87b282480000000b8728b298219000014818b1ba7b8000087b8b99ba0000000' +
	'795c97000000000047c417157000000097c957a120000000a57a74a42c4700007957c93b2000000023b41c17c15700005c957c13a3ba0000ba4b43a54c475740' +
	'934953573000000015357300000000002a134535754900002a525335700000009249729577b20000b21b1771500000005745497b414aba40ba57b50000000000' +
	'5a687c00000000001945a6c87000000061265187c0000000c879454654260000a65b2387c00000007c823b1945a6000087c65b53b5130000459465436b63c870' +
	'83487365a0000000a65197173798000047348726165100007397983295962690a65b27287248000027b287218981a65051b5b614b7b848b087b8b965b59b0000' +
	'7a67cac9a000000047c1741671a600001c916c12667c00007c4746642000000023ba6cac9c6700001c417c1a767a23b0c96c67916b6313607c47463b4b640000' +
	'69a6396734930000a67a7117300000002692916794937390267327000000000024727b49767a9a70b21b17a61671000014967b0000000000b670000000000000' +
	'c6b86c0000000000c6bc8694100000006c86bc2a10000000b86bc8a929420000c23c82862000000019423828683c0000a86a38a133c8000086383c6a3439a930' +
	'36b3464860000000931963986b360000a126b46484b30000a93a32983b36863024648600000000001981822860000000a14a466480000000a986a80000000000' +
	'6956b9bc900000006156c16bcc41000012a95b9bcb560000bc5b56c45a5242503623963c9569000015c1c456c3c262c013616a3c6569c960a563c40000000000' +
	'36b46345649500006b363553100000004b346b49656912a06b36352a3a53000095696446200000001562160000000000956964a161460000a560000000000000' +
	'5c85acabc00000001945a8ac8abc00002bc2c525185c00004254592b585cbc505c8ac5a3ca230000a85ac8a2c3c21940c85c533510000000c85c539454350000' +
	'3ab38a34885a0000ab8a85b38981318048b4b385b2b151b02b398500000000005a252882400000005a2528192982000051485400000000005980000000000000' +
	'ab9bc9000000000041a4accab000000012b1b99bc000000042bc4b000000000023c2caac9000000041a4ac23a3ca000013c91c000000000043c0000000000000' +
	'34939bb9a0000000ab31a3000000000034939b1292b900002b30000000000000249a2900000000001a2000000000000014900000000000000000000000000000';


// Each cube edge as its lower corner and axis (0 x, 1 y, 2 z).
const EDGES = [
	[ 0, 0, 0, 0 ], [ 1, 0, 0, 1 ], [ 0, 1, 0, 0 ], [ 0, 0, 0, 1 ],
	[ 0, 0, 1, 0 ], [ 1, 0, 1, 1 ], [ 0, 1, 1, 0 ], [ 0, 0, 1, 1 ],
	[ 0, 0, 0, 2 ], [ 1, 0, 0, 2 ], [ 1, 1, 0, 2 ], [ 0, 1, 0, 2 ]
];

let triangles = null;

/**
 * Extracts the surface of a scalar grid as a triangle mesh, with marching cubes.
 *
 * For a level set the default isovalue of `0` is the surface the grid describes.
 * For a fog volume pass a density: the surface encloses the voxels denser than it.
 * The inside is the side away from the background value, so the triangles face
 * outwards either way. Positions and normals are in world space, from
 * `grid.transform`, and normals come from the gradient of the grid. The texture
 * is closed at its bounds, so the mesh is closed too.
 *
 * ```js
 * const [ grid ] = await new VDBLoader().setTextureType( THREE.FloatType ).loadAsync( 'bunny.vdb' );
 * const mesh = new THREE.Mesh( createSurfaceGeometry( grid ), new THREE.MeshStandardMaterial() );
 * ```
 *
 * @param {VDBLoader~Grid} grid - A scalar grid from {@link VDBLoader}, or an object with `texture` and optionally `transform`, `bbox`, `background`, `voxelsPerTexel` and `valueRange`.
 * @param {Object} [options] - The options.
 * @param {number} [options.isovalue=0] - The value of the surface.
 * @return {BufferGeometry} An indexed geometry with `position` and `normal` attributes.
 */
function createSurfaceGeometry( grid, options = {} ) {

	const isovalue = options.isovalue !== undefined ? options.isovalue : 0;
	const geometry = new BufferGeometry();
	const texture = grid.texture;

	if ( texture === null || texture === undefined ) return geometry;

	if ( texture.format !== RedFormat ) {

		throw new Error( 'THREE.VDBSurface: Surfaces need a scalar grid (RedFormat).' );

	}

	if ( triangles === null ) {

		triangles = new Int8Array( 4096 );
		for ( let i = 0; i < 4096; i ++ ) triangles[ i ] = parseInt( TRIANGLE_TABLE[ i ], 16 ) - 1;

	}

	const { width, height, depth } = texture.image;
	const values = decode( texture, grid.valueRange );
	const background = grid.background !== undefined ? grid.background : 0;

	// f = sign * ( value - isovalue ) is negative inside and grows outwards.
	const sign = background > isovalue ? 1 : - 1;

	// Corners are padded by one on every side with the background, which closes the surface.
	const W = width + 2, H = height + 2, D = depth + 2;
	const f = new Float32Array( W * H * D ).fill( sign * ( background - isovalue ) );

	for ( let z = 0; z < depth; z ++ ) {

		for ( let y = 0; y < height; y ++ ) {

			const row = ( ( z + 1 ) * H + y + 1 ) * W + 1;
			const source = ( z * height + y ) * width;

			for ( let x = 0; x < width; x ++ ) f[ row + x ] = sign * ( values[ source + x ] - isovalue );

		}

	}

	// Vertices on the edges of two layers of corners: x and y edges for the layers
	// z and z + 1, z edges between them.
	const plane = W * H;
	const edgeX = [ new Int32Array( plane ), new Int32Array( plane ) ];
	const edgeY = [ new Int32Array( plane ), new Int32Array( plane ) ];
	const edgeZ = new Int32Array( plane );

	let positions = new Float32Array( 3 * 1024 );
	let normals = new Float32Array( 3 * 1024 );
	let indices = new Uint32Array( 3 * 1024 );
	let vertexCount = 0, indexCount = 0;

	const gradient = ( x, y, z, axis ) => {

		const i = ( z * H + y ) * W + x;
		const stride = axis === 0 ? 1 : axis === 1 ? W : plane;
		const c = axis === 0 ? x : axis === 1 ? y : z;
		const n = axis === 0 ? W : axis === 1 ? H : D;

		if ( c === 0 ) return f[ i + stride ] - f[ i ];
		if ( c === n - 1 ) return f[ i ] - f[ i - stride ];
		return ( f[ i + stride ] - f[ i - stride ] ) / 2;

	};

	const vertex = ( x, y, z, axis ) => {

		const i = ( z * H + y ) * W + x;
		const j = i + ( axis === 0 ? 1 : axis === 1 ? W : plane );
		const t = f[ i ] / ( f[ i ] - f[ j ] );

		if ( vertexCount * 3 === positions.length ) {

			const grownPositions = new Float32Array( positions.length * 2 );
			grownPositions.set( positions );
			positions = grownPositions;

			const grownNormals = new Float32Array( normals.length * 2 );
			grownNormals.set( normals );
			normals = grownNormals;

		}

		const p = vertexCount * 3;

		// Texel coordinates: the padding shifts corners by one.
		positions[ p ] = x - 1 + ( axis === 0 ? t : 0 );
		positions[ p + 1 ] = y - 1 + ( axis === 1 ? t : 0 );
		positions[ p + 2 ] = z - 1 + ( axis === 2 ? t : 0 );

		const x1 = x + ( axis === 0 ? 1 : 0 ), y1 = y + ( axis === 1 ? 1 : 0 ), z1 = z + ( axis === 2 ? 1 : 0 );

		for ( let a = 0; a < 3; a ++ ) normals[ p + a ] = gradient( x, y, z, a ) * ( 1 - t ) + gradient( x1, y1, z1, a ) * t;

		return vertexCount ++;

	};

	const cubeEdgeVertex = ( x, y, z, edge ) => {

		const [ dx, dy, dz, axis ] = EDGES[ edge ];
		const ex = x + dx, ey = y + dy;
		const k = ey * W + ex;

		let cache;

		if ( axis === 2 ) cache = edgeZ;
		else cache = ( axis === 0 ? edgeX : edgeY )[ ( z + dz ) & 1 ];

		if ( cache[ k ] === - 1 ) cache[ k ] = vertex( ex, ey, z + dz, axis );

		return cache[ k ];

	};

	edgeX[ 0 ].fill( - 1 );
	edgeY[ 0 ].fill( - 1 );

	for ( let z = 0; z < D - 1; z ++ ) {

		edgeX[ ( z + 1 ) & 1 ].fill( - 1 );
		edgeY[ ( z + 1 ) & 1 ].fill( - 1 );
		edgeZ.fill( - 1 );

		for ( let y = 0; y < H - 1; y ++ ) {

			// Corners 0, 3, 4 and 7 of a cube are corners 1, 2, 5 and 6 of the one before.
			const row = ( z * H + y ) * W;
			let left = ( f[ row ] < 0 ? 1 : 0 ) | ( f[ row + W ] < 0 ? 8 : 0 ) | ( f[ row + plane ] < 0 ? 16 : 0 ) | ( f[ row + plane + W ] < 0 ? 128 : 0 );

			for ( let x = 0; x < W - 1; x ++ ) {

				const i = row + x + 1;
				const right = ( f[ i ] < 0 ? 2 : 0 ) | ( f[ i + W ] < 0 ? 4 : 0 ) | ( f[ i + plane ] < 0 ? 32 : 0 ) | ( f[ i + plane + W ] < 0 ? 64 : 0 );
				const cube = left | right;

				left = ( right >> 1 & 1 ) | ( right << 1 & 8 ) | ( right >> 1 & 16 ) | ( right << 1 & 128 );

				if ( cube === 0 || cube === 255 ) continue;

				for ( let t = cube * 16; triangles[ t ] !== - 1; t += 3 ) {

					if ( indexCount + 3 > indices.length ) {

						const grown = new Uint32Array( indices.length * 2 );
						grown.set( indices );
						indices = grown;

					}

					// The table winds triangles clockwise seen from outside.
					indices[ indexCount ++ ] = cubeEdgeVertex( x, y, z, triangles[ t ] );
					indices[ indexCount ++ ] = cubeEdgeVertex( x, y, z, triangles[ t + 2 ] );
					indices[ indexCount ++ ] = cubeEdgeVertex( x, y, z, triangles[ t + 1 ] );

				}

			}

		}

	}

	// Texel coordinates to world space, like the textures: texel ( 0, 0, 0 ) is at
	// bbox.min, and a downsampled texel is the center of the cube of voxels it covers.

	const step = grid.voxelsPerTexel !== undefined ? grid.voxelsPerTexel : 1;
	const min = grid.bbox !== undefined && grid.bbox.isEmpty() === false ? grid.bbox.min : new Vector3();
	const offset = min.clone().addScalar( ( step - 1 ) / 2 );

	const matrix = ( grid.transform !== undefined ? grid.transform.clone() : new Matrix4() )
		.multiply( new Matrix4().makeTranslation( offset.x, offset.y, offset.z ) )
		.multiply( new Matrix4().makeScale( step, step, step ) );

	const normalMatrix = new Matrix3().getNormalMatrix( matrix );

	// A transform that mirrors the grid turns the triangles inside out.
	if ( matrix.determinant() < 0 ) {

		for ( let i = 0; i < indexCount; i += 3 ) {

			const swap = indices[ i + 1 ];
			indices[ i + 1 ] = indices[ i + 2 ];
			indices[ i + 2 ] = swap;

		}

	}

	const position = new BufferAttribute( positions.slice( 0, vertexCount * 3 ), 3 );
	const normal = new BufferAttribute( normals.slice( 0, vertexCount * 3 ), 3 );

	position.applyMatrix4( matrix );
	normal.applyNormalMatrix( normalMatrix );

	geometry.setAttribute( 'position', position );
	geometry.setAttribute( 'normal', normal );
	geometry.setIndex( new BufferAttribute( vertexCount > 65535 ? indices.slice( 0, indexCount ) : Uint16Array.from( indices.subarray( 0, indexCount ) ), 1 ) );

	return geometry;

}

function decode( texture, valueRange ) {

	const data = texture.image.data;

	switch ( texture.type ) {

		case FloatType:
			return data;

		case HalfFloatType:
			return Float32Array.from( data, fromHalfFloat );

		case UnsignedByteType: {

			if ( valueRange === undefined || valueRange === null ) {

				throw new Error( 'THREE.VDBSurface: UnsignedByteType textures need the valueRange they are normalized to.' );

			}

			const scale = ( valueRange.y - valueRange.x ) / 255;
			return Float32Array.from( data, v => valueRange.x + v * scale );

		}

		default:
			throw new Error( 'THREE.VDBSurface: Unsupported texture type.' );

	}

}

export { createSurfaceGeometry };
