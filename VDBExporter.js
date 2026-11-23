import {
	FloatType,
	HalfFloatType,
	Matrix4,
	RGBAFormat,
	RedFormat,
	UnsignedByteType
} from 'three';
import { writeVDB } from './VDBWriter.js';
import { fromHalfFloat, toHalfFloat } from './VDBCodecs.js';

/**
 * An exporter for the [OpenVDB](https://www.openvdb.org/) format.
 *
 * Writes the grids returned by {@link VDBLoader}, or any `Data3DTexture` of
 * `RedFormat` (scalar `float` grids) or `RGBAFormat` (`vec3s` grids, alpha is
 * dropped) with `FloatType`, `HalfFloatType` or `UnsignedByteType` data. Voxels
 * equal to the background value are stored as inactive, so only the occupied
 * part of the volume takes space in the file.
 *
 * ```js
 * const exporter = new VDBExporter();
 * const buffer = exporter.parse( grids );
 *
 * const blob = new Blob( [ buffer ], { type: 'application/octet-stream' } );
 * ```
 */
class VDBExporter {

	/**
	 * Writes the given grids as an OpenVDB file.
	 *
	 * @param {(VDBExporter~Grid|Data3DTexture|Array<(VDBExporter~Grid|Data3DTexture)>)} grids - The grids to export.
	 * @param {VDBExporter~Options} [options] - The export options.
	 * @return {ArrayBuffer} The file contents.
	 */
	parse( grids, options = {} ) {

		options = Object.assign( { compression: 'zip', halfFloat: false, tolerance: 0 }, options );

		const list = Array.isArray( grids ) ? grids : [ grids ];

		return writeVDB( list.map( ( grid, i ) => toDense( grid, i ) ), options );

	}

}

/**
 * Reads a grid or texture into the dense float layout of the writer.
 *
 * @param {(VDBExporter~Grid|Data3DTexture)} input - The grid or texture.
 * @param {number} index - The position of the grid in the list, for default names.
 * @return {Object} The dense grid.
 */
function toDense( input, index ) {

	const grid = input.isData3DTexture === true ? { texture: input } : input;
	const texture = grid.texture;

	if ( texture === null || texture === undefined ) {

		throw new Error( 'THREE.VDBExporter: Grid "' + grid.name + '" has no texture.' );

	}

	const { data, width, height, depth } = texture.image;

	let components, stride;

	if ( texture.format === RedFormat ) {

		components = 1;
		stride = 1;

	} else if ( texture.format === RGBAFormat ) {

		components = 3;
		stride = 4;

	} else {

		throw new Error( 'THREE.VDBExporter: Only RedFormat and RGBAFormat textures are supported.' );

	}

	if ( data.length !== width * height * depth * stride ) {

		throw new Error( 'THREE.VDBExporter: The texture data does not match its size.' );

	}

	const name = grid.name !== undefined ? grid.name : ( index === 0 ? 'density' : 'density' + index );
	const metadata = Object.assign( {}, grid.metadata );
	const levelSet = metadata.class === 'level set';

	let background = grid.background !== undefined ? [ grid.background ].flat() : new Array( components ).fill( 0 );

	if ( background.length !== components ) {

		throw new Error( 'THREE.VDBExporter: The background of grid "' + name + '" does not match its texture format.' );

	}

	background = background.map( v => Math.fround( v ) );

	const dense = new Float32Array( width * height * depth * stride );

	// Texels that encode the background (or its negation for level sets) are mapped
	// back to it exactly, so they are stored as inactive.

	const snap = ( decoded, encode ) => {

		const plus = background.map( encode );
		const minus = background.map( v => encode( - v ) );

		for ( let i = 0; i < dense.length; i += stride ) {

			let isBackground = true, isMinus = levelSet;

			for ( let c = 0; c < components; c ++ ) {

				if ( data[ i + c ] !== plus[ c ] ) isBackground = false;
				if ( data[ i + c ] !== minus[ c ] ) isMinus = false;

			}

			for ( let c = 0; c < components; c ++ ) {

				dense[ i + c ] = isBackground ? background[ c ] : isMinus ? - background[ c ] : decoded( data[ i + c ] );

			}

		}

	};

	switch ( texture.type ) {

		case FloatType:
			dense.set( data );
			break;

		case HalfFloatType:
			snap( fromHalfFloat, toHalfFloat );
			break;

		case UnsignedByteType: {

			const range = grid.valueRange;

			if ( range === undefined || range === null ) {

				throw new Error( 'THREE.VDBExporter: UnsignedByteType textures need the valueRange they are normalized to.' );

			}

			const min = range.x, max = range.y;
			const scale = max > min ? ( max - min ) / 255 : 0;
			const encode = v => {

				const b = max > min ? Math.round( ( v - min ) / ( max - min ) * 255 ) : 0;
				return b < 0 ? 0 : b > 255 ? 255 : b;

			};

			snap( b => min + b * scale, encode );
			break;

		}

		default:
			throw new Error( 'THREE.VDBExporter: Unsupported texture type.' );

	}

	// Texel ( 0, 0, 0 ) is at grid.bbox.min in the index space of grid.transform. A
	// downsampled texel covers a cube of `step` voxels, so the exported grid gets its
	// own index space with voxels `step` times larger, centered on those cubes.

	const step = grid.voxelsPerTexel !== undefined ? grid.voxelsPerTexel : 1;
	const min = grid.bbox !== undefined && grid.bbox.isEmpty() === false ? grid.bbox.min.toArray() : [ 0, 0, 0 ];
	const transform = grid.transform !== undefined ? grid.transform.clone() : new Matrix4();

	let origin = min;

	if ( step !== 1 ) {

		origin = min.map( v => Math.floor( v / step ) );

		const offset = min.map( ( v, i ) => v + ( step - 1 ) / 2 - step * origin[ i ] );

		transform
			.multiply( new Matrix4().makeTranslation( offset[ 0 ], offset[ 1 ], offset[ 2 ] ) )
			.multiply( new Matrix4().makeScale( step, step, step ) );

	}

	return {
		name,
		components,
		data: dense,
		stride,
		width,
		height,
		depth,
		origin,
		transform: transform.elements,
		background,
		levelSet,
		metadata
	};

}

/**
 * A grid to export. The grids returned by {@link VDBLoader} have this shape.
 *
 * @typedef {Object} VDBExporter~Grid
 * @property {Data3DTexture} texture - The voxel values, `RedFormat` or `RGBAFormat`.
 * @property {string} [name='density'] - The name of the grid.
 * @property {Matrix4} [transform] - Transforms index space coordinates into world space. Defaults to the identity.
 * @property {Box3} [bbox] - The index space box of the texture; only `bbox.min` is used. Defaults to the origin.
 * @property {(number|Array<number>)} [background=0] - The background value, stored as inactive.
 * @property {number} [voxelsPerTexel=1] - The number of voxels a texel covers along each axis.
 * @property {Vector2} [valueRange] - The range `UnsignedByteType` textures are normalized to. Required for them.
 * @property {Object} [metadata] - Extra metadata. `class` (e.g. `'fog volume'` or `'level set'`) is written as the grid class; other string, boolean and number entries are kept.
 **/

/**
 * Options of {@link VDBExporter#parse}.
 *
 * @typedef {Object} VDBExporter~Options
 * @property {('zip'|'none')} [compression='zip'] - The compression of the voxel values.
 * @property {boolean} [halfFloat=false] - Whether to store values as half floats, halving the file size at reduced precision.
 * @property {number} [tolerance=0] - Values within this distance of the background are stored as inactive background, which makes the file smaller.
 **/

export { VDBExporter };
