import { Box3, Vector2 } from 'three';
import { VDBLoader, toGrid } from './VDBLoader.js';
import { readNanoVDBBounds } from './NanoVDBParser.js';
import { parse } from './VDBWorker.js';

/**
 * Loads a sequence of OpenVDB or NanoVDB files, one file per frame, and plays
 * them back through a fixed set of {@link Data3DTexture} objects that are
 * updated in place.
 *
 * Frames are fetched in order with bounded concurrency and decoded off the
 * main thread in a pool of workers, a few frames ahead of playback, so memory
 * stays bounded for sequences of any length. Playback never runs ahead of the
 * decoded frames.
 *
 * ```js
 * const sequence = await new VDBSequenceLoader()
 * 	.setGridNames( [ 'density' ] )
 * 	.setTextureType( THREE.UnsignedByteType )
 * 	.loadAsync( 'models/fire/sequence.json' );
 *
 * const texture = sequence.grids[ 0 ].texture;
 * sequence.play();
 *
 * // in the render loop
 * sequence.update( clock.getDelta() );
 * ```
 *
 * The URL points to a manifest, a JSON file with the frame URLs (relative to
 * the manifest), the frame rate and, optionally, the index space bounding box
 * shared by all frames and the value range of each grid:
 *
 * ```json
 * { "fps": 30, "frames": [ "frame_0000.nvdb", "frame_0001.nvdb" ],
 *   "bbox": [ -8, -1, 9, 70, 91, 88 ], "valueRange": { "density": [ 0, 9 ] } }
 * ```
 *
 * The same fields can be passed as an object instead of a URL. Without a
 * bounding box the loader reads it from the NanoVDB file headers (or parses
 * every OpenVDB frame) before the first frame is shown.
 *
 * @augments VDBLoader
 */
class VDBSequenceLoader extends VDBLoader {

	/**
	 * Constructs a new sequence loader.
	 *
	 * @param {LoadingManager} [manager] - The loading manager.
	 */
	constructor( manager ) {

		super( manager );

		/**
		 * The number of workers decoding frames, or `0` to decode on the main thread.
		 *
		 * @type {number}
		 * @default 4
		 */
		this.workerLimit = 4;

		/**
		 * The number of frames decoded ahead of the current frame.
		 *
		 * @type {number}
		 * @default 8
		 */
		this.lookahead = 8;

		/**
		 * The number of decoded frames kept in memory.
		 *
		 * @type {number}
		 * @default 24
		 */
		this.cacheSize = 24;

		/**
		 * The number of frames fetched at the same time.
		 *
		 * @type {number}
		 * @default 6
		 */
		this.fetchLimit = 6;

	}

	/**
	 * Sets the number of workers decoding frames. `0` decodes on the main thread.
	 *
	 * @param {number} limit - The number of workers.
	 * @return {VDBSequenceLoader} A reference to this loader.
	 */
	setWorkerLimit( limit ) {

		this.workerLimit = limit;
		return this;

	}

	/**
	 * Sets the number of frames decoded ahead of the current frame.
	 *
	 * @param {number} frames - The number of frames.
	 * @return {VDBSequenceLoader} A reference to this loader.
	 */
	setLookahead( frames ) {

		this.lookahead = frames;
		return this;

	}

	/**
	 * Sets the number of decoded frames kept in memory.
	 *
	 * @param {number} frames - The number of frames.
	 * @return {VDBSequenceLoader} A reference to this loader.
	 */
	setCacheSize( frames ) {

		this.cacheSize = frames;
		return this;

	}

	/**
	 * Starts loading the sequence and passes it to `onLoad()` once the first frame
	 * is ready. `onProgress()` is called with the number of fetched and total frames.
	 *
	 * @param {(string|Object)} url - The URL of the manifest, or the manifest itself.
	 * @param {function(VDBSequence)} onLoad - Executed when the first frame can be shown.
	 * @param {function(number, number)} onProgress - Executed as frames are fetched.
	 * @param {onErrorCallback} onError - Executed when errors occur.
	 */
	load( url, onLoad, onProgress, onError ) {

		const scope = this;

		const base = typeof url === 'string' ? resolve( this.path + url ) : resolve( '' );

		const manifest = typeof url === 'string'
			? fetch( base, this.fetchOptions() ).then( response => {

				if ( response.ok === false ) throw new Error( 'THREE.VDBSequenceLoader: ' + response.status + ' ' + response.statusText + ' for ' + base );
				return response.json();

			} )
			: Promise.resolve( url );

		manifest.then( manifest => {

			const sequence = new VDBSequence( scope, manifest, base );

			return sequence.start( onProgress ).then( () => onLoad( sequence ) );

		} ).catch( error => {

			if ( onError ) onError( error );
			else console.error( error );

			scope.manager.itemError( typeof url === 'string' ? url : 'sequence' );

		} );

	}

	/**
	 * Returns the options for `fetch()`.
	 *
	 * @private
	 * @return {Object} The fetch options.
	 */
	fetchOptions() {

		return { headers: this.requestHeader, credentials: this.withCredentials ? 'include' : 'same-origin' };

	}

}

/**
 * Resolves a URL against the page, or returns it as is where there is no page.
 */
function resolve( url, base ) {

	if ( base === undefined && typeof document !== 'undefined' ) base = document.baseURI;
	if ( base === undefined && typeof location !== 'undefined' ) base = location.href;

	return base === undefined ? ( url === '' ? undefined : url ) : new URL( url, base ).href;

}

/**
 * A sequence of grids loaded by {@link VDBSequenceLoader}.
 */
class VDBSequence {

	constructor( loader, manifest, base ) {

		this.loader = loader;

		/**
		 * The frame URLs.
		 *
		 * @type {Array<string>}
		 */
		this.urls = manifest.frames.map( frame => resolve( frame, base ) );

		/**
		 * The number of frames.
		 *
		 * @type {number}
		 */
		this.frameCount = this.urls.length;

		/**
		 * The frame rate.
		 *
		 * @type {number}
		 */
		this.fps = manifest.fps || 24;

		/**
		 * Whether playback starts over at the end.
		 *
		 * @type {boolean}
		 * @default true
		 */
		this.loop = true;

		/**
		 * Whether the sequence is playing.
		 *
		 * @type {boolean}
		 */
		this.playing = false;

		/**
		 * The playback time in seconds.
		 *
		 * @type {number}
		 */
		this.time = 0;

		/**
		 * The grids of the current frame, in the form {@link VDBLoader} returns
		 * them. Their textures are updated in place as frames change.
		 *
		 * @type {Array<VDBLoader~Grid>}
		 */
		this.grids = [];

		/**
		 * The index space bounding box shared by all frames.
		 *
		 * @type {Box3}
		 */
		this.bbox = new Box3();

		/**
		 * The number of frames fetched so far.
		 *
		 * @type {number}
		 */
		this.loaded = 0;

		this.manifest = manifest;
		this.buffers = new Array( this.frameCount ).fill( null );
		this.fetchWaiters = new Map();
		this.current = - 1;
		this.wanted = 0;
		this.cache = new Map();
		this.pending = new Map();
		this.workers = [];
		this.idle = [];
		this.queue = [];
		this.nextId = 0;
		this.disposed = false;

	}

	/**
	 * The index of the frame on display. Setting it seeks.
	 *
	 * @type {number}
	 */
	get frame() {

		return this.current;

	}

	set frame( index ) {

		this.time = index / this.fps;
		this.seek( index );

	}

	/**
	 * The number of frames that can be shown without waiting.
	 *
	 * @type {number}
	 */
	get ready() {

		return this.cache.size;

	}

	/**
	 * Starts playback.
	 */
	play() {

		this.playing = true;

	}

	/**
	 * Pauses playback.
	 */
	pause() {

		this.playing = false;

	}

	/**
	 * Advances playback. Call it from the render loop with the elapsed time.
	 *
	 * @param {number} delta - The elapsed time in seconds.
	 */
	update( delta ) {

		if ( this.playing === false || this.frameCount === 0 ) return;

		this.time += delta;

		let index = Math.floor( this.time * this.fps );

		if ( index >= this.frameCount ) {

			if ( this.loop ) {

				index %= this.frameCount;
				this.time -= Math.floor( this.time * this.fps / this.frameCount ) * this.frameCount / this.fps;

			} else {

				index = this.frameCount - 1;
				this.time = index / this.fps;
				this.playing = false;

			}

		}

		// Never run ahead of what is decoded: hold at the first frame that is
		// still missing between the current and the target frame.

		let steps = index - this.current;
		if ( steps < 0 ) steps += this.frameCount;

		for ( let step = 1; step <= steps; step ++ ) {

			const i = ( this.current + step ) % this.frameCount;

			if ( this.cache.has( i ) === false ) {

				if ( step > 1 ) this.show( ( i + this.frameCount - 1 ) % this.frameCount );

				this.wanted = i;
				this.time = i / this.fps;
				this.schedule();
				return;

			}

		}

		this.seek( index );

	}

	/**
	 * Shows a frame as soon as it is decoded and decodes the frames after it.
	 *
	 * @param {number} index - The frame index.
	 */
	seek( index ) {

		index = Math.max( 0, Math.min( this.frameCount - 1, Math.floor( index ) ) );

		this.wanted = index;

		if ( this.cache.has( index ) ) this.show( index );

		this.schedule();

	}

	/**
	 * Releases the workers and textures.
	 */
	dispose() {

		this.disposed = true;
		this.playing = false;

		for ( const worker of this.workers ) worker.terminate();
		for ( const grid of this.grids ) if ( grid.texture !== null ) grid.texture.dispose();

		this.workers.length = 0;
		this.cache.clear();
		this.buffers.fill( null );

	}

	// Internals

	async start( onProgress ) {

		const loader = this.loader;
		const manifest = this.manifest;

		this.fetchAll( onProgress );

		if ( manifest.bbox === undefined ) {

			// Read the bounding box of every frame; this needs every frame fetched.

			const union = [ Infinity, Infinity, Infinity, - Infinity, - Infinity, - Infinity ];

			for ( let i = 0; i < this.frameCount; i ++ ) {

				const buffer = await this.fetched( i );

				let bounds = readNanoVDBBounds( buffer, loader.gridNames );

				if ( bounds === null ) {

					// OpenVDB: bounds come from a full parse.
					bounds = ( await this.decode( i, loader.parseOptions() ) ).map( grid => grid.bounds ).filter( b => b !== null );

				}

				for ( const b of bounds ) {

					for ( let c = 0; c < 3; c ++ ) {

						union[ c ] = Math.min( union[ c ], b[ c ] );
						union[ c + 3 ] = Math.max( union[ c + 3 ], b[ c + 3 ] );

					}

				}

			}

			if ( union[ 0 ] > union[ 3 ] ) union.fill( 0 );

			manifest.bbox = union;

		}

		this.bbox.min.fromArray( manifest.bbox, 0 );
		this.bbox.max.fromArray( manifest.bbox, 3 );

		this.options = loader.parseOptions();
		this.options.boundingBox = manifest.bbox.slice();

		// Byte textures need one value range for the whole sequence.

		const ranges = manifest.valueRange || {};

		if ( this.options.outputType === 'uint8' && this.options.valueRange === null ) {

			const names = loader.gridNames;

			if ( names === null || names.some( name => ranges[ name ] === undefined ) ) {

				// Measure the range over all frames.

				const measured = {};

				for ( let i = 0; i < this.frameCount; i ++ ) {

					await this.fetched( i );

					for ( const grid of await this.decode( i, Object.assign( {}, this.options, { outputType: 'float' } ) ) ) {

						const range = measured[ grid.name ] || ( measured[ grid.name ] = [ Infinity, - Infinity ] );
						range[ 0 ] = Math.min( range[ 0 ], grid.valueRange[ 0 ] );
						range[ 1 ] = Math.max( range[ 1 ], grid.valueRange[ 1 ] );

					}

				}

				Object.assign( ranges, measured );

			}

			manifest.valueRange = ranges;

		}

		this.cache.clear();

		await this.fetched( 0 );

		const grids = await this.decode( 0, this.options, ranges );

		for ( const grid of grids ) {

			const result = toGrid( grid, loader.textureType );
			this.grids.push( result );

		}

		this.cache.set( 0, grids );
		this.show( 0 );
		this.schedule();

	}

	fetchAll( onProgress ) {

		const scope = this;
		const loader = this.loader;
		const limit = Math.max( 1, loader.fetchLimit );

		let next = 0;

		function fetchNext() {

			if ( scope.disposed || next >= scope.frameCount ) return;

			const index = next ++;
			const url = scope.urls[ index ];

			loader.manager.itemStart( url );

			fetch( url, loader.fetchOptions() ).then( response => {

				if ( response.ok === false ) throw new Error( 'THREE.VDBSequenceLoader: ' + response.status + ' ' + response.statusText + ' for ' + url );
				return response.arrayBuffer();

			} ).then( buffer => {

				scope.buffers[ index ] = buffer;
				scope.loaded ++;

				const waiter = scope.fetchWaiters.get( index );

				if ( waiter !== undefined ) {

					scope.fetchWaiters.delete( index );
					waiter.resolve( buffer );

				}

				if ( onProgress ) onProgress( scope.loaded, scope.frameCount );

				loader.manager.itemEnd( url );
				scope.schedule();
				fetchNext();

			} ).catch( error => {

				const waiter = scope.fetchWaiters.get( index );

				if ( waiter !== undefined ) {

					scope.fetchWaiters.delete( index );
					waiter.reject( error );

				} else {

					console.error( error );

				}

				loader.manager.itemError( url );
				loader.manager.itemEnd( url );
				fetchNext();

			} );

		}

		for ( let i = 0; i < limit; i ++ ) fetchNext();

	}

	fetched( index ) {

		if ( this.buffers[ index ] !== null ) return Promise.resolve( this.buffers[ index ] );

		return new Promise( ( resolve, reject ) => {

			this.fetchWaiters.set( index, { resolve, reject } );

		} );

	}

	/**
	 * Decodes a frame through the worker pool (or inline) and returns the parsed grids.
	 */
	decode( index, options, ranges = null ) {

		const buffer = this.buffers[ index ];

		if ( ranges !== null && options.valueRange === null && this.options.outputType === 'uint8' ) {

			// Each grid gets its own range: parse the names separately.

			const names = this.loader.gridNames || Object.keys( ranges );

			return Promise.all( names.map( name => this.parse( buffer, Object.assign( {}, options, { gridNames: [ name ], valueRange: ranges[ name ] || null } ), index ) ) )
				.then( results => results.flat() );

		}

		return this.parse( buffer, options, index );

	}

	parse( buffer, options, index = - 1 ) {

		const useWorkers = this.loader.workerLimit > 0 && typeof Worker !== 'undefined';

		if ( useWorkers === false ) {

			// Decode inline. The parsers read the buffer without copying it.

			return new Promise( ( resolve, reject ) => {

				try {

					resolve( parse( buffer, options ) );

				} catch ( error ) {

					reject( error );

				}

			} );

		}

		return new Promise( ( resolve, reject ) => {

			this.queue.push( { buffer, options, index, resolve, reject } );
			this.pump();

		} );

	}

	pump() {

		const limit = this.loader.workerLimit;

		while ( this.queue.length > 0 ) {

			if ( this.idle.length === 0 ) {

				if ( this.workers.length >= limit ) return;

				this.idle.push( this.createWorker() );

			}

			// Scrubbing can queue more frames than the workers keep up with: serve the
			// frame nearest to the wanted one and skip those that fell out of the window.
			const lookahead = Math.max( 0, this.loader.lookahead );
			let best = 0;

			for ( let i = 1; i < this.queue.length; i ++ ) {

				if ( this.distance( this.queue[ i ].index ) < this.distance( this.queue[ best ].index ) ) best = i;

			}

			const task = this.queue.splice( best, 1 )[ 0 ];

			if ( task.index !== - 1 && task.index !== this.wanted && this.distance( task.index ) > lookahead ) {

				const error = new Error( 'THREE.VDBSequenceLoader: Frame ' + task.index + ' left the decode window.' );
				error.name = 'AbortError';
				task.reject( error );
				continue;

			}

			const worker = this.idle.pop();
			const id = this.nextId ++;

			worker.tasks.set( id, task );

			// The buffer stays usable here: it is copied, not transferred, so
			// a frame can be decoded again after it leaves the cache.

			worker.postMessage( { id, buffer: task.buffer, options: task.options } );

		}

	}

	createWorker() {

		const url = new URL( './VDBWorker.js', import.meta.url );

		// A worker script must come from the page's origin. When the loader is served from a CDN,
		// a same-origin blob module imports it instead.
		const sameOrigin = typeof location === 'undefined' || url.origin === location.origin;
		const source = sameOrigin ? url : URL.createObjectURL( new Blob( [ 'import ' + JSON.stringify( url.href ) + ';' ], { type: 'text/javascript' } ) );

		const worker = new Worker( source, { type: 'module' } );
		if ( sameOrigin === false ) URL.revokeObjectURL( source );

		worker.tasks = new Map();

		worker.onmessage = ( event ) => {

			const { id, grids, error } = event.data;
			const task = worker.tasks.get( id );

			worker.tasks.delete( id );
			this.idle.push( worker );

			if ( error !== undefined ) task.reject( new Error( error ) );
			else task.resolve( grids );

			this.pump();

		};

		worker.onerror = ( event ) => {

			for ( const task of worker.tasks.values() ) task.reject( new Error( 'THREE.VDBSequenceLoader: Worker error: ' + event.message ) );

			worker.tasks.clear();
			this.pump();

		};

		this.workers.push( worker );

		return worker;

	}

	/**
	 * Keeps the frames after the wanted one decoded, in playback order.
	 */
	schedule() {

		if ( this.options === undefined || this.disposed ) return;

		const lookahead = Math.max( 0, this.loader.lookahead );

		// Playing: the frames ahead. Paused: the frames either side, nearest first, for scrubbing.
		const steps = [ 0 ];

		for ( let step = 1; step <= lookahead; step ++ ) {

			if ( this.playing ) steps.push( step );
			else if ( step <= Math.ceil( lookahead / 2 ) ) steps.push( step, - step );

		}

		for ( const step of steps ) {

			let index = this.wanted + step;

			if ( index >= this.frameCount || index < 0 ) {

				if ( this.loop === false ) continue;
				index = ( index + this.frameCount ) % this.frameCount;

			}

			if ( this.cache.has( index ) || this.pending.has( index ) || this.buffers[ index ] === null ) continue;

			const promise = this.decode( index, this.options, this.manifest.valueRange || {} );

			this.pending.set( index, promise );

			promise.then( grids => {

				this.pending.delete( index );

				if ( this.disposed ) return;

				this.cache.set( index, grids );
				this.trim();

				if ( index === this.wanted ) this.show( index );

			} ).catch( error => {

				this.pending.delete( index );
				if ( error.name !== 'AbortError' ) console.error( error );

			} );

		}

	}

	/**
	 * Drops the decoded frames furthest from the wanted one.
	 */
	trim() {

		const size = Math.max( this.loader.lookahead + 2, this.loader.cacheSize );

		while ( this.cache.size > size ) {

			let worst = - 1;
			let worstDistance = - 1;

			for ( const index of this.cache.keys() ) {

				if ( index === this.current || index === this.wanted ) continue;

				const distance = this.distance( index );

				if ( distance > worstDistance ) {

					worstDistance = distance;
					worst = index;

				}

			}

			if ( worst === - 1 ) break;

			this.cache.delete( worst );

		}

	}

	/**
	 * How far a frame is from the wanted one: ahead in playback order while playing,
	 * either way round while paused, wrapping when looping.
	 *
	 * @param {number} index - The frame index.
	 * @return {number} The distance in frames.
	 */
	distance( index ) {

		let distance = index - this.wanted;

		if ( this.playing ) {

			if ( distance < 0 ) distance = this.loop ? distance + this.frameCount : this.frameCount - distance;
			return distance;

		}

		distance = Math.abs( distance );
		return this.loop ? Math.min( distance, this.frameCount - distance ) : distance;

	}

	show( index ) {

		const grids = this.cache.get( index );

		if ( grids === undefined || index === this.current ) return;

		for ( const result of this.grids ) {

			const grid = grids.find( g => g.name === result.name );

			if ( grid === undefined || grid.data === null || result.texture === null ) continue;

			result.texture.image.data = grid.data;
			result.texture.needsUpdate = true;

			if ( this.options.outputType !== 'uint8' ) {

				result.valueRange.x = Math.min( result.valueRange.x, grid.valueRange[ 0 ] );
				result.valueRange.y = Math.max( result.valueRange.y, grid.valueRange[ 1 ] );

			}

		}

		this.current = index;

	}

}

export { VDBSequenceLoader, VDBSequence };
