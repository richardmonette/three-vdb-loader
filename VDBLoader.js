import {
	Box3,
	Data3DTexture,
	FileLoader,
	FloatType,
	HalfFloatType,
	LinearFilter,
	Loader,
	Matrix4,
	RGBAFormat,
	RedFormat,
	UnsignedByteType,
	Vector2
} from 'three';
import { parseVDB } from './VDBParser.js';

const OUTPUT_TYPES = new Map( [
	[ FloatType, 'float' ],
	[ HalfFloatType, 'half' ],
	[ UnsignedByteType, 'uint8' ]
] );

/**
 * A loader for the [OpenVDB](https://www.openvdb.org/) format.
 *
 * Scalar grids (`float`, `double` and `half`) and vector grids (`vec3s` and
 * `vec3d`) are converted into dense {@link Data3DTexture} objects covering the
 * active voxels of each grid. Vector grids use `RGBAFormat`.
 * Uncompressed, zip and blosc compressed files are supported.
 *
 * ```js
 * const loader = new VDBLoader();
 * const grids = await loader.loadAsync( 'models/vdb/cloud.vdb' );
 *
 * const texture = grids[ 0 ].texture;
 * ```
 *
 * @augments Loader
 */
class VDBLoader extends Loader {

	/**
	 * Constructs a new VDB loader.
	 *
	 * @param {LoadingManager} [manager] - The loading manager.
	 */
	constructor( manager ) {

		super( manager );

		/**
		 * The names of the grids to load, or `null` to load all grids.
		 *
		 * @type {?Array<string>}
		 * @default null
		 */
		this.gridNames = null;

		/**
		 * The texture type of the voxel data: `HalfFloatType`, `FloatType` or
		 * `UnsignedByteType`.
		 *
		 * @type {number}
		 * @default HalfFloatType
		 */
		this.textureType = HalfFloatType;

		/**
		 * The index space bounding box the textures should cover, or `null` to
		 * use the bounds of the active voxels of each grid.
		 *
		 * @type {?Box3}
		 * @default null
		 */
		this.boundingBox = null;

		/**
		 * The value range used to normalize `UnsignedByteType` textures, or
		 * `null` to use the range of the values of each grid.
		 *
		 * @type {?Vector2}
		 * @default null
		 */
		this.valueRange = null;

	}

	/**
	 * Sets the names of the grids to load. Other grids are skipped.
	 *
	 * @param {?Array<string>} names - The grid names, or `null` to load all grids.
	 * @return {VDBLoader} A reference to this loader.
	 */
	setGridNames( names ) {

		this.gridNames = names;
		return this;

	}

	/**
	 * Sets the texture type of the voxel data.
	 *
	 * `HalfFloatType` (the default) can be filtered on every WebGL 2 and WebGPU
	 * device and uses half the memory of `FloatType`. `UnsignedByteType` stores
	 * values normalized to `grid.valueRange` in a quarter of the memory.
	 *
	 * @param {number} type - `HalfFloatType`, `FloatType` or `UnsignedByteType`.
	 * @return {VDBLoader} A reference to this loader.
	 */
	setTextureType( type ) {

		if ( OUTPUT_TYPES.has( type ) === false ) {

			throw new Error( 'THREE.VDBLoader: Unsupported texture type.' );

		}

		this.textureType = type;
		return this;

	}

	/**
	 * Sets the index space bounding box the textures should cover. Voxels outside
	 * the box are dropped and the inside is padded with the background value, so
	 * every grid loaded with the same box gets a texture of the same size.
	 * Both corners are inclusive, like `grid.bbox`.
	 *
	 * @param {?Box3} box - The bounding box, or `null` to use the active voxels.
	 * @return {VDBLoader} A reference to this loader.
	 */
	setBoundingBox( box ) {

		this.boundingBox = box;
		return this;

	}

	/**
	 * Sets the value range used to normalize `UnsignedByteType` textures.
	 * Values outside the range are clamped.
	 *
	 * @param {?Vector2} range - The range, or `null` to use the range of each grid.
	 * @return {VDBLoader} A reference to this loader.
	 */
	setValueRange( range ) {

		this.valueRange = range;
		return this;

	}

	/**
	 * Starts loading from the given URL and passes the loaded grids
	 * to the `onLoad()` callback.
	 *
	 * @param {string} url - The path/URL of the file to be loaded. This can also be a data URI.
	 * @param {function(Array<VDBLoader~Grid>)} onLoad - Executed when the loading process has been finished.
	 * @param {onProgressCallback} onProgress - Executed while the loading is in progress.
	 * @param {onErrorCallback} onError - Executed when errors occur.
	 */
	load( url, onLoad, onProgress, onError ) {

		const scope = this;

		const loader = new FileLoader( scope.manager );
		loader.setPath( scope.path );
		loader.setResponseType( 'arraybuffer' );
		loader.setRequestHeader( scope.requestHeader );
		loader.setWithCredentials( scope.withCredentials );
		loader.load( url, function ( buffer ) {

			try {

				onLoad( scope.parse( buffer ) );

			} catch ( e ) {

				if ( onError ) {

					onError( e );

				} else {

					console.error( e );

				}

				scope.manager.itemError( url );

			}

		}, onProgress, onError );

	}

	/**
	 * Parses the given OpenVDB data and returns the grids it contains.
	 *
	 * @param {ArrayBuffer} buffer - The raw OpenVDB data as an array buffer.
	 * @return {Array<VDBLoader~Grid>} The parsed grids.
	 */
	parse( buffer ) {

		const grids = parseVDB( buffer, this.parseOptions() );

		return grids.map( grid => toGrid( grid, this.textureType ) );

	}

	/**
	 * Returns the options for the parser.
	 *
	 * @private
	 * @return {Object} The parse options.
	 */
	parseOptions() {

		return {
			gridNames: this.gridNames,
			outputType: OUTPUT_TYPES.get( this.textureType ),
			boundingBox: this.boundingBox === null ? null : [ ...this.boundingBox.min.toArray(), ...this.boundingBox.max.toArray() ],
			valueRange: this.valueRange === null ? null : [ this.valueRange.x, this.valueRange.y ]
		};

	}

}

/**
 * Wraps a parsed grid in three.js objects.
 *
 * @param {Object} grid - The grid from the parser.
 * @param {number} textureType - The texture type.
 * @return {VDBLoader~Grid} The grid.
 */
function toGrid( grid, textureType ) {

	const result = {
		name: grid.name,
		type: grid.type,
		metadata: grid.metadata,
		transform: new Matrix4().fromArray( grid.transform ),
		background: grid.background,
		bbox: new Box3(),
		valueRange: new Vector2().fromArray( grid.valueRange ),
		texture: null
	};

	if ( grid.data === null ) return result;

	result.bbox.min.fromArray( grid.bounds, 0 );
	result.bbox.max.fromArray( grid.bounds, 3 );

	const texture = new Data3DTexture( grid.data, grid.width, grid.height, grid.depth );
	texture.format = grid.stride === 1 ? RedFormat : RGBAFormat;
	texture.type = textureType;
	texture.minFilter = LinearFilter;
	texture.magFilter = LinearFilter;
	texture.unpackAlignment = 1;
	texture.needsUpdate = true;

	result.texture = texture;

	return result;

}

/**
 * A grid parsed by {@link VDBLoader}.
 *
 * @typedef {Object} VDBLoader~Grid
 * @property {string} name - The name of the grid.
 * @property {('float'|'double'|'half'|'vec3s'|'vec3d')} type - The value type of the grid.
 * @property {Object} metadata - The grid metadata, e.g. `class`.
 * @property {Matrix4} transform - Transforms index space coordinates into world space.
 * @property {(number|Array<number>)} background - The background value of the grid.
 * @property {Box3} bbox - The bounding box of the texture in index space (inclusive). It covers the active voxels unless a bounding box was set on the loader.
 * @property {Vector2} valueRange - The minimum and maximum of the values in the texture, or the range set on the loader. `UnsignedByteType` textures are normalized to it.
 * @property {?Data3DTexture} texture - The voxel values inside `bbox`, or `null` if the grid is empty. Vector grids use `RGBAFormat`.
 **/

export { VDBLoader, toGrid };
