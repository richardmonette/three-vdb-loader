// Decoders shared by the VDB loaders: zlib inflate, Blosc (LZ4 with byte shuffle)
// and IEEE half floats. This module has no dependencies so it can run in a worker.

const LENGTH_BASE = [ 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258 ];
const LENGTH_EXTRA = [ 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0 ];
const DIST_BASE = [ 1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577 ];
const DIST_EXTRA = [ 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13 ];
const CODE_LENGTH_ORDER = [ 16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15 ];

let fixedLiteralTable = null;
let fixedDistanceTable = null;

/**
 * Builds a lookup table for a canonical Huffman code. Each entry holds
 * `( symbol << 4 ) | codeLength` and is indexed by the next `maxLength`
 * bits of the stream (least significant bit first).
 */
function buildHuffmanTable( lengths ) {

	let maxLength = 0;

	for ( let i = 0; i < lengths.length; i ++ ) if ( lengths[ i ] > maxLength ) maxLength = lengths[ i ];

	if ( maxLength === 0 ) return { table: new Uint16Array( 1 ), maxLength: 1 };

	const counts = new Uint16Array( 16 );

	for ( let i = 0; i < lengths.length; i ++ ) counts[ lengths[ i ] ] ++;

	counts[ 0 ] = 0;

	const next = new Uint16Array( 16 );

	for ( let i = 1; i < 16; i ++ ) next[ i ] = ( next[ i - 1 ] + counts[ i - 1 ] ) << 1;

	const size = 1 << maxLength;
	const table = new Uint16Array( size );

	for ( let symbol = 0; symbol < lengths.length; symbol ++ ) {

		const length = lengths[ symbol ];

		if ( length === 0 ) continue;

		let code = next[ length ] ++;
		let reversed = 0;

		for ( let i = 0; i < length; i ++ ) {

			reversed = ( reversed << 1 ) | ( code & 1 );
			code >>= 1;

		}

		const entry = ( symbol << 4 ) | length;

		for ( let i = reversed; i < size; i += 1 << length ) table[ i ] = entry;

	}

	return { table, maxLength };

}

/**
 * Inflates a zlib stream (RFC 1950 / 1951) into a buffer of known size.
 *
 * @param {Uint8Array} src - The compressed bytes.
 * @param {number} size - The decompressed size in bytes.
 * @return {Uint8Array} The decompressed bytes.
 */
function inflate( src, size ) {

	if ( src.length < 2 || ( src[ 0 ] & 0x0f ) !== 8 || ( ( src[ 0 ] << 8 ) | src[ 1 ] ) % 31 !== 0 ) {

		throw new Error( 'THREE.VDBCodecs: Not a zlib stream.' );

	}

	if ( src[ 1 ] & 0x20 ) throw new Error( 'THREE.VDBCodecs: Preset dictionaries are not supported.' );

	const out = new Uint8Array( size );

	let pos = 2;
	let bitBuffer = 0;
	let bitCount = 0;
	let o = 0;

	function bits( n ) {

		while ( bitCount < n ) {

			bitBuffer |= ( pos < src.length ? src[ pos ] : 0 ) << bitCount;
			pos ++;
			bitCount += 8;

		}

		const value = bitBuffer & ( ( 1 << n ) - 1 );
		bitBuffer >>>= n;
		bitCount -= n;
		return value;

	}

	function decode( huffman ) {

		while ( bitCount < huffman.maxLength ) {

			bitBuffer |= ( pos < src.length ? src[ pos ] : 0 ) << bitCount;
			pos ++;
			bitCount += 8;

		}

		const entry = huffman.table[ bitBuffer & ( ( 1 << huffman.maxLength ) - 1 ) ];
		const length = entry & 15;

		if ( length === 0 ) throw new Error( 'THREE.VDBCodecs: Invalid Huffman code.' );

		bitBuffer >>>= length;
		bitCount -= length;
		return entry >> 4;

	}

	let final = 0;

	while ( final === 0 ) {

		if ( pos > src.length ) throw new Error( 'THREE.VDBCodecs: Unexpected end of zlib stream.' );

		final = bits( 1 );
		const type = bits( 2 );

		if ( type === 0 ) {

			// Stored block: return the whole bytes still in the bit buffer, then align.

			bitBuffer >>>= bitCount & 7;
			bitCount -= bitCount & 7;
			pos -= bitCount >> 3;
			bitBuffer = 0;
			bitCount = 0;

			const length = src[ pos ] | ( src[ pos + 1 ] << 8 );
			const check = src[ pos + 2 ] | ( src[ pos + 3 ] << 8 );

			if ( ( length ^ check ) !== 0xffff ) throw new Error( 'THREE.VDBCodecs: Invalid stored block.' );

			pos += 4;

			if ( o + length > size || pos + length > src.length ) throw new Error( 'THREE.VDBCodecs: Invalid stored block.' );

			out.set( src.subarray( pos, pos + length ), o );
			pos += length;
			o += length;
			continue;

		}

		let literal, distance;

		if ( type === 1 ) {

			if ( fixedLiteralTable === null ) {

				const lengths = new Uint8Array( 288 );
				lengths.fill( 8, 0, 144 );
				lengths.fill( 9, 144, 256 );
				lengths.fill( 7, 256, 280 );
				lengths.fill( 8, 280, 288 );
				fixedLiteralTable = buildHuffmanTable( lengths );
				fixedDistanceTable = buildHuffmanTable( new Uint8Array( 30 ).fill( 5 ) );

			}

			literal = fixedLiteralTable;
			distance = fixedDistanceTable;

		} else if ( type === 2 ) {

			const literalCount = bits( 5 ) + 257;
			const distanceCount = bits( 5 ) + 1;
			const codeLengthCount = bits( 4 ) + 4;

			const codeLengths = new Uint8Array( 19 );

			for ( let i = 0; i < codeLengthCount; i ++ ) codeLengths[ CODE_LENGTH_ORDER[ i ] ] = bits( 3 );

			const codeLengthTable = buildHuffmanTable( codeLengths );
			const lengths = new Uint8Array( literalCount + distanceCount );

			for ( let i = 0; i < lengths.length; ) {

				const symbol = decode( codeLengthTable );

				if ( symbol < 16 ) {

					lengths[ i ++ ] = symbol;

				} else {

					let repeat, value = 0;

					if ( symbol === 16 ) {

						if ( i === 0 ) throw new Error( 'THREE.VDBCodecs: Invalid code lengths.' );

						value = lengths[ i - 1 ];
						repeat = 3 + bits( 2 );

					} else if ( symbol === 17 ) {

						repeat = 3 + bits( 3 );

					} else {

						repeat = 11 + bits( 7 );

					}

					if ( i + repeat > lengths.length ) throw new Error( 'THREE.VDBCodecs: Invalid code lengths.' );

					lengths.fill( value, i, i + repeat );
					i += repeat;

				}

			}

			literal = buildHuffmanTable( lengths.subarray( 0, literalCount ) );
			distance = buildHuffmanTable( lengths.subarray( literalCount ) );

		} else {

			throw new Error( 'THREE.VDBCodecs: Invalid block type.' );

		}

		for ( ;; ) {

			const symbol = decode( literal );

			if ( symbol < 256 ) {

				if ( o >= size ) throw new Error( 'THREE.VDBCodecs: Output overflow.' );

				out[ o ++ ] = symbol;

			} else if ( symbol === 256 ) {

				break;

			} else {

				const lengthIndex = symbol - 257;

				if ( lengthIndex >= 29 ) throw new Error( 'THREE.VDBCodecs: Invalid length code.' );

				const length = LENGTH_BASE[ lengthIndex ] + bits( LENGTH_EXTRA[ lengthIndex ] );
				const distanceIndex = decode( distance );

				if ( distanceIndex >= 30 ) throw new Error( 'THREE.VDBCodecs: Invalid distance code.' );

				const dist = DIST_BASE[ distanceIndex ] + bits( DIST_EXTRA[ distanceIndex ] );

				if ( dist > o || o + length > size ) throw new Error( 'THREE.VDBCodecs: Invalid match.' );

				if ( dist >= length ) {

					out.copyWithin( o, o - dist, o - dist + length );
					o += length;

				} else {

					for ( let i = o - dist, end = o + length; o < end; ) out[ o ++ ] = out[ i ++ ];

				}

			}

		}

	}

	if ( o !== size ) throw new Error( 'THREE.VDBCodecs: Unexpected decompressed size.' );

	return out;

}

const BLOSC_DOSHUFFLE = 0x1;
const BLOSC_MEMCPYED = 0x2;
const BLOSC_DOBITSHUFFLE = 0x4;
const BLOSC_DONT_SPLIT = 0x10;
const BLOSC_LZ4_FORMAT = 1;

/**
 * Decompresses a Blosc chunk. Only the LZ4 codec with optional byte shuffling is
 * supported, which is what OpenVDB and NanoVDB write.
 *
 * @param {Uint8Array} src - The compressed chunk, including the 16 byte header.
 * @return {Uint8Array} The decompressed bytes.
 */
function bloscDecompress( src ) {

	const view = new DataView( src.buffer, src.byteOffset, src.byteLength );

	const flags = src[ 2 ];
	const typeSize = src[ 3 ];
	const size = view.getUint32( 4, true );
	const blockSize = view.getUint32( 8, true );

	const out = new Uint8Array( size );

	if ( flags & BLOSC_MEMCPYED ) {

		out.set( src.subarray( 16, 16 + size ) );
		return out;

	}

	if ( ( flags >> 5 ) !== BLOSC_LZ4_FORMAT || ( flags & BLOSC_DOBITSHUFFLE ) ) {

		throw new Error( 'THREE.VDBCodecs: Unsupported Blosc codec.' );

	}

	const shuffle = ( flags & BLOSC_DOSHUFFLE ) !== 0 && typeSize > 1;
	const split = ( flags & BLOSC_DONT_SPLIT ) === 0;
	const blockCount = Math.ceil( size / blockSize );
	const tmp = new Uint8Array( blockSize );

	for ( let i = 0; i < blockCount; i ++ ) {

		const start = i * blockSize;
		const length = Math.min( blockSize, size - start );
		const leftover = length < blockSize;
		const splits = ( split && typeSize <= 16 && Math.floor( length / typeSize ) >= 128 && ! leftover ) ? typeSize : 1;
		const splitLength = Math.floor( length / splits );
		const target = shuffle ? tmp : out.subarray( start, start + length );

		let offset = view.getInt32( 16 + i * 4, true );

		for ( let j = 0; j < splits; j ++ ) {

			const compressedLength = view.getInt32( offset, true );
			const chunk = src.subarray( offset + 4, offset + 4 + compressedLength );
			const dst = target.subarray( j * splitLength, ( j + 1 ) * splitLength );

			if ( compressedLength === splitLength ) {

				dst.set( chunk );

			} else if ( lz4Decompress( chunk, dst ) !== splitLength ) {

				throw new Error( 'THREE.VDBCodecs: Invalid Blosc data.' );

			}

			offset += 4 + compressedLength;

		}

		if ( shuffle ) {

			const count = Math.floor( length / typeSize );

			for ( let e = 0; e < count; e ++ ) {

				for ( let b = 0; b < typeSize; b ++ ) {

					out[ start + e * typeSize + b ] = tmp[ b * count + e ];

				}

			}

			const rest = length - count * typeSize;
			out.set( tmp.subarray( length - rest, length ), start + length - rest );

		}

	}

	return out;

}

/**
 * Decompresses an LZ4 block.
 *
 * @param {Uint8Array} src - The compressed block.
 * @param {Uint8Array} dst - The destination, sized to the decompressed length.
 * @return {number} The number of bytes written.
 */
function lz4Decompress( src, dst ) {

	let s = 0;
	let d = 0;

	while ( s < src.length ) {

		const token = src[ s ++ ];

		let literals = token >> 4;

		if ( literals === 15 ) {

			let b;
			do {

				b = src[ s ++ ];
				literals += b;

			} while ( b === 255 );

		}

		dst.set( src.subarray( s, s + literals ), d );
		s += literals;
		d += literals;

		if ( s >= src.length ) break;

		const distance = src[ s ] | ( src[ s + 1 ] << 8 );
		s += 2;

		let match = token & 15;

		if ( match === 15 ) {

			let b;
			do {

				b = src[ s ++ ];
				match += b;

			} while ( b === 255 );

		}

		match += 4;

		for ( let m = d - distance, end = d + match; d < end; ) dst[ d ++ ] = dst[ m ++ ];

	}

	return d;

}

let halfTable = null;

const float32 = new Float32Array( 1 );
const uint32 = new Uint32Array( float32.buffer );

/**
 * Converts a half float bit pattern to a number.
 *
 * @param {number} h - The 16 bit pattern.
 * @return {number} The value.
 */
function fromHalfFloat( h ) {

	if ( halfTable === null ) {

		halfTable = new Float32Array( 65536 );

		for ( let i = 0; i < 65536; i ++ ) {

			const sign = i & 0x8000 ? - 1 : 1;
			const exponent = ( i >> 10 ) & 0x1f;
			const mantissa = i & 0x3ff;

			if ( exponent === 0 ) {

				halfTable[ i ] = sign * mantissa * 2 ** - 24;

			} else if ( exponent === 31 ) {

				halfTable[ i ] = mantissa === 0 ? sign * Infinity : NaN;

			} else {

				halfTable[ i ] = sign * ( 1 + mantissa / 1024 ) * 2 ** ( exponent - 15 );

			}

		}

	}

	return halfTable[ h ];

}

/**
 * Converts a number to a half float bit pattern, rounding to nearest even.
 * Values beyond the half float range are clamped to ±65504.
 *
 * @param {number} value - The value.
 * @return {number} The 16 bit pattern.
 */
function toHalfFloat( value ) {

	if ( value !== value ) return 0x7e00;

	if ( value > 65504 ) value = 65504;
	else if ( value < - 65504 ) value = - 65504;

	float32[ 0 ] = value;

	const x = uint32[ 0 ];
	const sign = ( x >>> 16 ) & 0x8000;
	const exponent = ( ( x >>> 23 ) & 0xff ) - 112;
	let mantissa = x & 0x7fffff;

	if ( exponent >= 31 ) return sign | 0x7c00;

	let h, shift;

	if ( exponent <= 0 ) {

		if ( exponent < - 10 ) return sign;

		mantissa |= 0x800000;
		shift = 14 - exponent;
		h = mantissa >> shift;

	} else {

		shift = 13;
		h = ( exponent << 10 ) | ( mantissa >> 13 );

	}

	const remainder = mantissa & ( ( 1 << shift ) - 1 );
	const half = 1 << ( shift - 1 );

	if ( remainder > half || ( remainder === half && ( h & 1 ) ) ) h ++;

	return sign | h;

}

export { inflate, bloscDecompress, lz4Decompress, fromHalfFloat, toHalfFloat };
