// Worker entry point: parses OpenVDB and NanoVDB files off the main thread.
// Only relative imports are used here, because module workers cannot see the
// page's import map. VDBSequenceLoader starts it with
// `new Worker( new URL( './VDBWorker.js', import.meta.url ), { type: 'module' } )`.

import { parseVDB } from './VDBParser.js';
import { parseNanoVDB, isNanoVDB } from './NanoVDBParser.js';

/**
 * Parses a file with either parser, chosen by its magic number.
 *
 * @param {ArrayBuffer} buffer - The file contents.
 * @param {Object} options - The parse options.
 * @return {Array<Object>} The parsed grids.
 */
function parse( buffer, options ) {

	return isNanoVDB( buffer ) ? parseNanoVDB( buffer, options ) : parseVDB( buffer, options );

}

if ( typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof self.document === 'undefined' ) {

	self.onmessage = function ( event ) {

		const { id, buffer, options } = event.data;

		try {

			const grids = parse( buffer, options );
			const transfer = [];

			for ( const grid of grids ) {

				if ( grid.data !== null ) transfer.push( grid.data.buffer );

			}

			self.postMessage( { id, grids }, transfer );

		} catch ( error ) {

			self.postMessage( { id, error: error.message } );

		}

	};

}

export { parse };
