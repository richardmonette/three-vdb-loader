// Writes dense voxel arrays as OpenVDB files. This module has no dependencies on
// three.js so it can run in a worker; `VDBExporter` reads three.js textures into it.
//
// Grids are stored as the standard 5-4-3 tree. Every 8³ block of the dense array
// that holds a single value becomes a tile, the others become leaves, and blocks
// of inactive background values are left out. Values equal to the background are
// inactive, and for level sets so is the negated background (the inside).

import { fromHalfFloat, toHalfFloat, LENGTH_BASE, LENGTH_EXTRA, DIST_BASE, DIST_EXTRA, CODE_LENGTH_ORDER } from './VDBCodecs.js';

const MAGIC = 0x56444220;
const FILE_VERSION = 224;
const LIBRARY_VERSION = [ 10, 0 ];

const COMPRESS_ZIP = 0x1;
const COMPRESS_ACTIVE_MASK = 0x2;

const NO_MASK_OR_INACTIVE_VALS = 0;
const NO_MASK_AND_MINUS_BG = 1;
const NO_MASK_AND_ONE_INACTIVE_VAL = 2;
const MASK_AND_NO_INACTIVE_VALS = 3;
const MASK_AND_ONE_INACTIVE_VAL = 4;
const MASK_AND_TWO_INACTIVE_VALS = 5;
const NO_MASK_AND_ALL_VALS = 6;

const LEAF_LOG2 = 3, LOWER_LOG2 = 4, UPPER_LOG2 = 5;
const LOWER_TOTAL = LEAF_LOG2 + LOWER_LOG2; // 7
const UPPER_TOTAL = LOWER_TOTAL + UPPER_LOG2; // 12

const RESERVED_METADATA = new Set( [ 'class', 'name', 'file_bbox_min', 'file_bbox_max', 'file_compression', 'file_mem_bytes', 'file_voxel_count', 'is_saved_as_half_float', 'is_local_space', 'vector_type' ] );

// Deflate (RFC 1950 / 1951): LZ77 with hash chains and one step of lazy matching,
// then whichever of a stored, fixed or dynamic Huffman block is smallest.

const MIN_MATCH = 3;
const MAX_MATCH = 258;
const WINDOW = 32768;
const MAX_CHAIN = 128;
const BLOCK_TOKENS = 1 << 15;
const MATCH_FLAG = 1 << 25;

let lengthCodes = null;
let distanceCodes = null;
let hashHead = null;
let hashBase = 1;
let fixedLiteralLengths = null;
let fixedDistanceLengths = null;

function initDeflateTables() {

	lengthCodes = new Uint8Array( MAX_MATCH + 1 );

	for ( let code = 0; code < 29; code ++ ) {

		const end = code === 28 ? MAX_MATCH : LENGTH_BASE[ code ] + ( 1 << LENGTH_EXTRA[ code ] ) - 1;
		for ( let length = LENGTH_BASE[ code ]; length <= end; length ++ ) lengthCodes[ length ] = code;

	}

	lengthCodes[ MAX_MATCH ] = 28;

	distanceCodes = new Uint8Array( WINDOW + 1 );

	for ( let code = 0; code < 30; code ++ ) {

		const end = DIST_BASE[ code ] + ( 1 << DIST_EXTRA[ code ] ) - 1;
		for ( let distance = DIST_BASE[ code ]; distance <= end && distance <= WINDOW; distance ++ ) distanceCodes[ distance ] = code;

	}

	fixedLiteralLengths = new Uint8Array( 288 );
	fixedLiteralLengths.fill( 8, 0, 144 );
	fixedLiteralLengths.fill( 9, 144, 256 );
	fixedLiteralLengths.fill( 7, 256, 280 );
	fixedLiteralLengths.fill( 8, 280, 288 );

	fixedDistanceLengths = new Uint8Array( 30 ).fill( 5 );

}

class BitWriter {

	constructor( capacity ) {

		this.bytes = new Uint8Array( Math.max( 64, capacity ) );
		this.length = 0;
		this.buffer = 0;
		this.count = 0;

	}

	ensure( n ) {

		if ( this.length + n <= this.bytes.length ) return;

		const bytes = new Uint8Array( Math.max( this.bytes.length * 2, this.length + n ) );
		bytes.set( this.bytes.subarray( 0, this.length ) );
		this.bytes = bytes;

	}

	// Writes up to 24 bits, least significant first.
	write( value, n ) {

		this.buffer |= value << this.count;
		this.count += n;

		if ( this.count >= 16 ) {

			this.ensure( 4 );

			while ( this.count >= 8 ) {

				this.bytes[ this.length ++ ] = this.buffer & 0xff;
				this.buffer >>>= 8;
				this.count -= 8;

			}

		}

	}

	align() {

		this.ensure( 4 );

		while ( this.count > 0 ) {

			this.bytes[ this.length ++ ] = this.buffer & 0xff;
			this.buffer >>>= 8;
			this.count = Math.max( 0, this.count - 8 );

		}

		this.buffer = 0;

	}

	append( src ) {

		this.ensure( src.length );
		this.bytes.set( src, this.length );
		this.length += src.length;

	}

}

/**
 * Computes Huffman code lengths of at most `maxBits` for the given symbol frequencies.
 */
function huffmanLengths( freqs, maxBits ) {

	const n = freqs.length;
	const lengths = new Uint8Array( n );
	const weights = Float64Array.from( freqs );

	for ( ;; ) {

		let count = 0;
		for ( let i = 0; i < n; i ++ ) if ( weights[ i ] > 0 ) count ++;

		if ( count === 0 ) return lengths;

		if ( count === 1 ) {

			for ( let i = 0; i < n; i ++ ) if ( weights[ i ] > 0 ) lengths[ i ] = 1;
			return lengths;

		}

		// Sorted by weight, then symbol: weight * 512 + symbol, as a typed array sort.
		const keys = new Float64Array( count );
		for ( let i = 0, k = 0; i < n; i ++ ) if ( weights[ i ] > 0 ) keys[ k ++ ] = weights[ i ] * 512 + i;
		keys.sort();

		const leaves = new Int32Array( count );
		for ( let i = 0; i < count; i ++ ) leaves[ i ] = keys[ i ] % 512;

		// Two queue construction: leaves in order, then internal nodes in creation order.
		const weight = new Float64Array( 2 * count - 1 );
		const parent = new Int32Array( 2 * count - 1 );

		for ( let i = 0; i < count; i ++ ) weight[ i ] = weights[ leaves[ i ] ];

		let leaf = 0, internal = count, next = count;

		const pick = () => ( leaf < count && ( internal >= next || weight[ leaf ] <= weight[ internal ] ) ) ? leaf ++ : internal ++;

		while ( next < 2 * count - 1 ) {

			const a = pick(), b = pick();
			weight[ next ] = weight[ a ] + weight[ b ];
			parent[ a ] = next;
			parent[ b ] = next;
			next ++;

		}

		const depth = new Uint8Array( 2 * count - 1 );
		let longest = 0;

		for ( let i = 2 * count - 3; i >= 0; i -- ) {

			depth[ i ] = depth[ parent[ i ] ] + 1;
			if ( i < count && depth[ i ] > longest ) longest = depth[ i ];

		}

		if ( longest <= maxBits ) {

			for ( let i = 0; i < count; i ++ ) lengths[ leaves[ i ] ] = depth[ i ];
			return lengths;

		}

		for ( let i = 0; i < n; i ++ ) if ( weights[ i ] > 0 ) weights[ i ] = Math.floor( weights[ i ] / 2 ) | 1;

	}

}

// Canonical codes, bit reversed for the least significant bit first stream.
function huffmanCodes( lengths ) {

	const counts = new Uint16Array( 16 );
	for ( let i = 0; i < lengths.length; i ++ ) counts[ lengths[ i ] ] ++;
	counts[ 0 ] = 0;

	const next = new Uint16Array( 16 );
	for ( let i = 1; i < 16; i ++ ) next[ i ] = ( next[ i - 1 ] + counts[ i - 1 ] ) << 1;

	const codes = new Uint16Array( lengths.length );

	for ( let symbol = 0; symbol < lengths.length; symbol ++ ) {

		const length = lengths[ symbol ];
		if ( length === 0 ) continue;

		let code = next[ length ] ++;
		let reversed = 0;

		for ( let i = 0; i < length; i ++ ) {

			reversed = ( reversed << 1 ) | ( code & 1 );
			code >>= 1;

		}

		codes[ symbol ] = reversed;

	}

	return codes;

}

// Run length encodes the literal and distance code lengths with symbols 16, 17 and 18.
function encodeCodeLengths( lengths ) {

	const symbols = [];

	for ( let i = 0; i < lengths.length; ) {

		const value = lengths[ i ];
		let run = 1;
		while ( i + run < lengths.length && lengths[ i + run ] === value ) run ++;

		if ( value === 0 && run >= 3 ) {

			const n = Math.min( run, 138 );
			symbols.push( n >= 11 ? [ 18, n - 11, 7 ] : [ 17, n - 3, 3 ] );
			i += n;

		} else if ( value !== 0 && run >= 4 ) {

			symbols.push( [ value, 0, 0 ] );
			const n = Math.min( run - 1, 6 );
			symbols.push( [ 16, n - 3, 2 ] );
			i += 1 + n;

		} else {

			symbols.push( [ value, 0, 0 ] );
			i ++;

		}

	}

	return symbols;

}

function writeBlock( writer, tokens, start, end, src, srcStart, srcEnd, last ) {

	const literalFreqs = new Uint32Array( 286 );
	const distanceFreqs = new Uint32Array( 30 );

	for ( let t = start; t < end; t ++ ) {

		const token = tokens[ t ];

		if ( token < 256 ) {

			literalFreqs[ token ] ++;

		} else {

			literalFreqs[ 257 + lengthCodes[ ( token >>> 16 ) & 0x1ff ] ] ++;
			distanceFreqs[ distanceCodes[ token & 0xffff ] ] ++;

		}

	}

	literalFreqs[ 256 ] = 1;

	const literalLengths = huffmanLengths( literalFreqs, 15 );
	const distanceLengths = huffmanLengths( distanceFreqs, 15 );

	if ( distanceLengths.every( l => l === 0 ) ) distanceLengths[ 0 ] = 1;

	let hlit = 286;
	while ( hlit > 257 && literalLengths[ hlit - 1 ] === 0 ) hlit --;

	let hdist = 30;
	while ( hdist > 1 && distanceLengths[ hdist - 1 ] === 0 ) hdist --;

	const codeLengthSymbols = encodeCodeLengths( [ ...literalLengths.subarray( 0, hlit ), ...distanceLengths.subarray( 0, hdist ) ] );
	const codeLengthFreqs = new Uint32Array( 19 );
	for ( const [ symbol ] of codeLengthSymbols ) codeLengthFreqs[ symbol ] ++;

	const codeLengthLengths = huffmanLengths( codeLengthFreqs, 7 );

	let hclen = 19;
	while ( hclen > 4 && codeLengthLengths[ CODE_LENGTH_ORDER[ hclen - 1 ] ] === 0 ) hclen --;

	// Sizes in bits of the three block types.

	const dataBits = ( lLengths, dLengths ) => {

		let bits = lLengths[ 256 ];

		for ( let i = 0; i < 256; i ++ ) bits += literalFreqs[ i ] * lLengths[ i ];
		for ( let i = 0; i < 29; i ++ ) bits += literalFreqs[ 257 + i ] * ( lLengths[ 257 + i ] + LENGTH_EXTRA[ i ] );
		for ( let i = 0; i < 30; i ++ ) bits += distanceFreqs[ i ] * ( dLengths[ i ] + DIST_EXTRA[ i ] );

		return bits;

	};

	let dynamicBits = 3 + 14 + hclen * 3 + dataBits( literalLengths, distanceLengths );
	for ( const [ symbol, , extra ] of codeLengthSymbols ) dynamicBits += codeLengthLengths[ symbol ] + extra;

	const fixedBits = 3 + dataBits( fixedLiteralLengths, fixedDistanceLengths );
	const storedBits = ( srcEnd - srcStart ) * 8 + 32 + 8 + Math.ceil( ( srcEnd - srcStart ) / 65535 ) * 40;

	if ( storedBits <= fixedBits && storedBits <= dynamicBits ) {

		for ( let p = srcStart; p < srcEnd || p === srcStart; ) {

			const n = Math.min( 65535, srcEnd - p );
			const final = last && p + n >= srcEnd;

			writer.write( final ? 1 : 0, 3 );
			writer.align();
			writer.write( n, 16 );
			writer.write( n ^ 0xffff, 16 );
			writer.append( src.subarray( p, p + n ) );
			p += n;

			if ( n === 0 ) break;

		}

		return;

	}

	let lLengths = fixedLiteralLengths, dLengths = fixedDistanceLengths;

	if ( dynamicBits < fixedBits ) {

		lLengths = literalLengths;
		dLengths = distanceLengths;

		writer.write( last ? 1 : 0, 1 );
		writer.write( 2, 2 );
		writer.write( hlit - 257, 5 );
		writer.write( hdist - 1, 5 );
		writer.write( hclen - 4, 4 );

		for ( let i = 0; i < hclen; i ++ ) writer.write( codeLengthLengths[ CODE_LENGTH_ORDER[ i ] ], 3 );

		const codeLengthCodes = huffmanCodes( codeLengthLengths );

		for ( const [ symbol, extraValue, extraBits ] of codeLengthSymbols ) {

			writer.write( codeLengthCodes[ symbol ], codeLengthLengths[ symbol ] );
			if ( extraBits > 0 ) writer.write( extraValue, extraBits );

		}

	} else {

		writer.write( last ? 1 : 0, 1 );
		writer.write( 1, 2 );

	}

	const lCodes = huffmanCodes( lLengths );
	const dCodes = huffmanCodes( dLengths );

	for ( let t = start; t < end; t ++ ) {

		const token = tokens[ t ];

		if ( token < 256 ) {

			writer.write( lCodes[ token ], lLengths[ token ] );

		} else {

			const length = ( token >>> 16 ) & 0x1ff;
			const distance = token & 0xffff;
			const lc = lengthCodes[ length ];
			const dc = distanceCodes[ distance ];

			writer.write( lCodes[ 257 + lc ], lLengths[ 257 + lc ] );
			if ( LENGTH_EXTRA[ lc ] > 0 ) writer.write( length - LENGTH_BASE[ lc ], LENGTH_EXTRA[ lc ] );
			writer.write( dCodes[ dc ], dLengths[ dc ] );
			if ( DIST_EXTRA[ dc ] > 0 ) writer.write( distance - DIST_BASE[ dc ], DIST_EXTRA[ dc ] );

		}

	}

	writer.write( lCodes[ 256 ], lLengths[ 256 ] );

}

/**
 * Compresses bytes into a zlib stream (RFC 1950 / 1951).
 *
 * @param {Uint8Array} src - The bytes to compress.
 * @return {Uint8Array} The zlib stream.
 */
function deflate( src ) {

	if ( lengthCodes === null ) initDeflateTables();

	const n = src.length;

	// The hash heads are shared between calls: entries hold `base + position` and
	// anything below this call's base belongs to an earlier call.
	if ( hashHead === null || hashBase + n + 1 > 0x7fffffff ) {

		hashHead = new Int32Array( 1 << 15 );
		hashBase = 1;

	}

	const head = hashHead;
	const base = hashBase;
	hashBase += n + 1;

	const prev = new Int32Array( Math.max( 1, n ) );

	// Literal: the byte. Match: MATCH_FLAG | length << 16 | distance (length 9 bits, distance 16 bits).
	let tokens = new Uint32Array( 1024 );
	let tokenCount = 0;

	const push = token => {

		if ( tokenCount === tokens.length ) {

			const grown = new Uint32Array( tokens.length * 2 );
			grown.set( tokens );
			tokens = grown;

		}

		tokens[ tokenCount ++ ] = token;

	};

	const hash = p => ( ( src[ p ] << 10 ) ^ ( src[ p + 1 ] << 5 ) ^ src[ p + 2 ] ) & 0x7fff;

	const insert = p => {

		if ( p + 2 >= n ) return;
		const h = hash( p );
		prev[ p ] = head[ h ] - base;
		head[ h ] = base + p;

	};

	let matchDistance = 0;

	const longestMatch = p => {

		if ( p + 2 >= n ) return 0;

		const limit = Math.min( MAX_MATCH, n - p );
		let best = MIN_MATCH - 1;
		let candidate = head[ hash( p ) ] - base;
		let chain = MAX_CHAIN;

		while ( candidate >= 0 && p - candidate <= WINDOW && chain -- > 0 ) {

			if ( src[ candidate + best ] === src[ p + best ] ) {

				let length = 0;
				while ( length < limit && src[ candidate + length ] === src[ p + length ] ) length ++;

				if ( length > best ) {

					best = length;
					matchDistance = p - candidate;
					if ( length === limit ) break;

				}

			}

			candidate = prev[ candidate ];

		}

		return best >= MIN_MATCH ? best : 0;

	};

	// Block boundaries in tokens and in source bytes.
	const blocks = [];
	let blockStart = 0, blockSrcStart = 0;

	for ( let p = 0; p < n; ) {

		let length = longestMatch( p );
		let distance = matchDistance;

		if ( length > 0 && length < 32 && p + 1 < n ) {

			// Lazy matching: emit a literal if the next position has a longer match.
			insert( p );
			const nextLength = longestMatch( p + 1 );

			if ( nextLength > length ) {

				push( src[ p ] );
				p ++;
				insert( p );
				length = nextLength;
				distance = matchDistance;

			} else {

				for ( let i = 1; i < length; i ++ ) insert( p + i );
				push( MATCH_FLAG | ( length << 16 ) | distance );
				p += length;
				length = - 1;

			}

		} else {

			insert( p );

		}

		if ( length > 0 ) {

			for ( let i = 1; i < length; i ++ ) insert( p + i );
			push( MATCH_FLAG | ( length << 16 ) | distance );
			p += length;

		} else if ( length === 0 ) {

			push( src[ p ] );
			p ++;

		}

		if ( tokenCount - blockStart >= BLOCK_TOKENS ) {

			blocks.push( [ blockStart, tokenCount, blockSrcStart, p ] );
			blockStart = tokenCount;
			blockSrcStart = p;

		}

	}

	blocks.push( [ blockStart, tokenCount, blockSrcStart, n ] );

	const writer = new BitWriter( n + ( n >> 3 ) + 64 );

	writer.write( 0x78, 8 );
	writer.write( 0x9c, 8 );

	for ( let b = 0; b < blocks.length; b ++ ) {

		const [ start, end, srcStart, srcEnd ] = blocks[ b ];
		writeBlock( writer, tokens, start, end, src, srcStart, srcEnd, b === blocks.length - 1 );

	}

	writer.align();

	let a = 1, b = 0;

	for ( let i = 0; i < n; ) {

		const end = Math.min( n, i + 5552 );
		for ( ; i < end; i ++ ) {

			a += src[ i ];
			b += a;

		}

		a %= 65521;
		b %= 65521;

	}

	writer.append( new Uint8Array( [ b >>> 8, b & 0xff, a >>> 8, a & 0xff ] ) );

	return writer.bytes.slice( 0, writer.length );

}

class Writer {

	constructor() {

		this.bytes = new Uint8Array( 1 << 16 );
		this.view = new DataView( this.bytes.buffer );
		this.length = 0;

	}

	ensure( n ) {

		if ( this.length + n <= this.bytes.length ) return;

		const bytes = new Uint8Array( Math.max( this.bytes.length * 2, this.length + n ) );
		bytes.set( this.bytes.subarray( 0, this.length ) );
		this.bytes = bytes;
		this.view = new DataView( bytes.buffer );

	}

	uint8( v ) {

		this.ensure( 1 );
		this.view.setUint8( this.length, v );
		this.length += 1;

	}

	int32( v ) {

		this.ensure( 4 );
		this.view.setInt32( this.length, v, true );
		this.length += 4;

	}

	uint32( v ) {

		this.ensure( 4 );
		this.view.setUint32( this.length, v, true );
		this.length += 4;

	}

	int64( v, at = null ) {

		if ( at !== null ) {

			this.view.setBigInt64( at, BigInt( v ), true );
			return;

		}

		this.ensure( 8 );
		this.view.setBigInt64( this.length, BigInt( v ), true );
		this.length += 8;

	}

	float32( v ) {

		this.ensure( 4 );
		this.view.setFloat32( this.length, v, true );
		this.length += 4;

	}

	float64( v ) {

		this.ensure( 8 );
		this.view.setFloat64( this.length, v, true );
		this.length += 8;

	}

	append( bytes ) {

		this.ensure( bytes.length );
		this.bytes.set( bytes, this.length );
		this.length += bytes.length;

	}

	string( s ) {

		const bytes = new TextEncoder().encode( s );
		this.uint32( bytes.length );
		this.append( bytes );

	}

	result() {

		return this.bytes.buffer.slice( 0, this.length );

	}

}

// Metadata values: [ type, value ].

function writeMetadata( writer, entries ) {

	const names = Object.keys( entries ).sort();

	writer.uint32( names.length );

	for ( const name of names ) {

		const [ type, value ] = entries[ name ];

		writer.string( name );
		writer.string( type );

		switch ( type ) {

			case 'string': {

				const bytes = new TextEncoder().encode( value );
				writer.uint32( bytes.length );
				writer.append( bytes );
				break;

			}

			case 'bool': writer.uint32( 1 ); writer.uint8( value ? 1 : 0 ); break;
			case 'int64': writer.uint32( 8 ); writer.int64( value ); break;
			case 'double': writer.uint32( 8 ); writer.float64( value ); break;
			case 'vec3i': writer.uint32( 12 ); for ( const v of value ) writer.int32( v ); break;
			case 'vec3d': writer.uint32( 24 ); for ( const v of value ) writer.float64( v ); break;

		}

	}

}

function writeTransform( writer, m ) {

	// `m` is column-major like three.js, which is the row-major, row-vector layout
	// of OpenVDB: the translation is in elements 12 to 14 in both.

	const scaleTranslate = m[ 1 ] === 0 && m[ 2 ] === 0 && m[ 3 ] === 0 && m[ 4 ] === 0 && m[ 6 ] === 0 && m[ 7 ] === 0 &&
		m[ 8 ] === 0 && m[ 9 ] === 0 && m[ 11 ] === 0 && m[ 15 ] === 1;

	if ( scaleTranslate ) {

		const s = [ m[ 0 ], m[ 5 ], m[ 10 ] ];

		if ( s.some( v => v === 0 || Number.isFinite( v ) === false ) ) {

			throw new Error( 'THREE.VDBExporter: The transform is not invertible.' );

		}

		writer.string( s[ 0 ] === s[ 1 ] && s[ 1 ] === s[ 2 ] ? 'UniformScaleTranslateMap' : 'ScaleTranslateMap' );

		const vec3 = v => v.forEach( x => writer.float64( x ) );

		vec3( [ m[ 12 ], m[ 13 ], m[ 14 ] ] ); // translation
		vec3( s ); // scale
		vec3( s.map( Math.abs ) ); // voxel size
		vec3( s.map( v => 1 / v ) ); // inverse scale
		vec3( s.map( v => 1 / ( v * v ) ) ); // inverse scale squared
		vec3( s.map( v => 0.5 / v ) ); // inverse twice scale
		return;

	}

	const det = m[ 0 ] * ( m[ 5 ] * m[ 10 ] - m[ 6 ] * m[ 9 ] ) - m[ 4 ] * ( m[ 1 ] * m[ 10 ] - m[ 2 ] * m[ 9 ] ) + m[ 8 ] * ( m[ 1 ] * m[ 6 ] - m[ 2 ] * m[ 5 ] );

	if ( ! ( Math.abs( det ) > 0 ) || m[ 3 ] !== 0 || m[ 7 ] !== 0 || m[ 11 ] !== 0 || m[ 15 ] !== 1 ) {

		throw new Error( 'THREE.VDBExporter: The transform must be an invertible affine matrix.' );

	}

	writer.string( 'AffineMap' );
	for ( let i = 0; i < 16; i ++ ) writer.float64( m[ i ] );

}

// Port of openvdb::io::MaskCompress: picks how the inactive values of a node are stored.

function maskCompress( values, count, components, valueMask, childMask, background ) {

	const minusBackground = background.map( v => - v );
	const inactive = [ background, background ];
	let unique = 0;

	const equal = ( i, value ) => {

		for ( let c = 0; c < components; c ++ ) if ( values[ i * components + c ] !== value[ c ] ) return false;
		return true;

	};

	const same = ( a, b ) => a.every( ( v, c ) => v === b[ c ] );

	for ( let i = 0; i < count && unique < 3; i ++ ) {

		if ( isOn( valueMask, i ) || ( childMask !== null && isOn( childMask, i ) ) ) continue;

		if ( ( unique > 0 && equal( i, inactive[ 0 ] ) ) || ( unique > 1 && equal( i, inactive[ 1 ] ) ) ) continue;

		if ( unique < 2 ) inactive[ unique ] = Array.from( values.subarray( i * components, ( i + 1 ) * components ) );
		unique ++;

	}

	let metadata = NO_MASK_OR_INACTIVE_VALS;

	if ( unique === 1 ) {

		if ( same( inactive[ 0 ], background ) === false ) {

			metadata = same( inactive[ 0 ], minusBackground ) ? NO_MASK_AND_MINUS_BG : NO_MASK_AND_ONE_INACTIVE_VAL;

		}

	} else if ( unique === 2 ) {

		if ( same( inactive[ 0 ], background ) === false && same( inactive[ 1 ], background ) === false ) {

			metadata = MASK_AND_TWO_INACTIVE_VALS;

		} else if ( same( inactive[ 1 ], background ) ) {

			metadata = same( inactive[ 0 ], minusBackground ) ? MASK_AND_NO_INACTIVE_VALS : MASK_AND_ONE_INACTIVE_VAL;

		} else {

			metadata = same( inactive[ 1 ], minusBackground ) ? MASK_AND_NO_INACTIVE_VALS : MASK_AND_ONE_INACTIVE_VAL;
			inactive.reverse();

		}

	} else if ( unique > 2 ) {

		metadata = NO_MASK_AND_ALL_VALS;

	}

	return { metadata, inactive };

}

function isOn( mask, i ) {

	return ( mask[ i >> 3 ] & ( 1 << ( i & 7 ) ) ) !== 0;

}

function countOn( mask ) {

	let count = 0;

	for ( let i = 0; i < mask.length; i ++ ) {

		let byte = mask[ i ];

		while ( byte !== 0 ) {

			byte &= byte - 1;
			count ++;

		}

	}

	return count;

}

class GridWriter {

	constructor( writer, grid, options ) {

		this.writer = writer;
		this.components = grid.components;
		this.background = grid.background;
		this.half = options.halfFloat === true;
		this.zip = options.compression !== 'none';

	}

	value( v ) {

		// Single values are written at full size, rounded to half precision in half float grids.
		for ( let c = 0; c < this.components; c ++ ) this.writer.float32( this.half ? fromHalfFloat( toHalfFloat( v[ c ] ) ) : v[ c ] );

	}

	// Port of openvdb::io::writeCompressedValues with active mask compression.
	compressedValues( values, count, valueMask, childMask ) {

		const { writer, components } = this;
		const { metadata, inactive } = maskCompress( values, count, components, valueMask, childMask, this.background );

		writer.uint8( metadata );

		if ( metadata === NO_MASK_AND_ONE_INACTIVE_VAL || metadata === MASK_AND_ONE_INACTIVE_VAL || metadata === MASK_AND_TWO_INACTIVE_VALS ) {

			this.value( inactive[ 0 ] );
			if ( metadata === MASK_AND_TWO_INACTIVE_VALS ) this.value( inactive[ 1 ] );

		}

		if ( metadata === NO_MASK_AND_ALL_VALS ) {

			this.data( values );
			return;

		}

		const active = new Float32Array( countOn( valueMask ) * components );
		let j = 0;

		if ( metadata === MASK_AND_NO_INACTIVE_VALS || metadata === MASK_AND_ONE_INACTIVE_VAL || metadata === MASK_AND_TWO_INACTIVE_VALS ) {

			const selection = new Uint8Array( count >> 3 );

			for ( let i = 0; i < count; i ++ ) {

				if ( isOn( valueMask, i ) ) {

					for ( let c = 0; c < components; c ++ ) active[ j ++ ] = values[ i * components + c ];

				} else {

					let one = true;
					for ( let c = 0; c < components; c ++ ) if ( values[ i * components + c ] !== inactive[ 1 ][ c ] ) one = false;
					if ( one ) selection[ i >> 3 ] |= 1 << ( i & 7 );

				}

			}

			writer.append( selection );

		} else {

			for ( let i = 0; i < count; i ++ ) {

				if ( isOn( valueMask, i ) === false ) continue;
				for ( let c = 0; c < components; c ++ ) active[ j ++ ] = values[ i * components + c ];

			}

		}

		this.data( active );

	}

	data( values ) {

		const { writer } = this;

		// The half float writer of OpenVDB writes nothing at all for no values.
		if ( this.half && values.length === 0 ) return;

		let bytes;

		if ( this.half ) {

			const halves = new Uint16Array( values.length );
			for ( let i = 0; i < values.length; i ++ ) halves[ i ] = toHalfFloat( values[ i ] );
			bytes = new Uint8Array( halves.buffer );

		} else {

			bytes = new Uint8Array( values.buffer, values.byteOffset, values.byteLength );

		}

		if ( this.zip === false ) {

			writer.append( bytes );
			return;

		}

		const zipped = bytes.length > 0 ? deflate( bytes ) : null;

		if ( zipped !== null && zipped.length < bytes.length ) {

			writer.int64( zipped.length );
			writer.append( zipped );

		} else {

			writer.int64( - bytes.length );
			writer.append( bytes );

		}

	}

}

/**
 * Builds the tree of a grid from its dense values.
 *
 * @return {Object} The root children and statistics.
 */
function buildTree( grid, tolerance ) {

	const { data, width, height, depth, stride, components, origin, background } = grid;
	const levelSet = grid.levelSet === true;
	const minusBackground = background.map( v => - v );

	const roots = new Map();

	let voxelCount = 0;
	const bboxMin = [ Infinity, Infinity, Infinity ];
	const bboxMax = [ - Infinity, - Infinity, - Infinity ];

	const expand = ( x0, y0, z0, x1, y1, z1 ) => {

		bboxMin[ 0 ] = Math.min( bboxMin[ 0 ], x0 ); bboxMax[ 0 ] = Math.max( bboxMax[ 0 ], x1 );
		bboxMin[ 1 ] = Math.min( bboxMin[ 1 ], y0 ); bboxMax[ 1 ] = Math.max( bboxMax[ 1 ], y1 );
		bboxMin[ 2 ] = Math.min( bboxMin[ 2 ], z0 ); bboxMax[ 2 ] = Math.max( bboxMax[ 2 ], z1 );

	};

	const lowerNode = ( x, y, z ) => {

		const ux = x & ~ ( ( 1 << UPPER_TOTAL ) - 1 ), uy = y & ~ ( ( 1 << UPPER_TOTAL ) - 1 ), uz = z & ~ ( ( 1 << UPPER_TOTAL ) - 1 );
		const key = ux + ',' + uy + ',' + uz;

		let upper = roots.get( key );

		if ( upper === undefined ) {

			upper = { origin: [ ux, uy, uz ], children: new Map() };
			roots.set( key, upper );

		}

		const lx = x & ~ ( ( 1 << LOWER_TOTAL ) - 1 ), ly = y & ~ ( ( 1 << LOWER_TOTAL ) - 1 ), lz = z & ~ ( ( 1 << LOWER_TOTAL ) - 1 );
		const index = ( ( ( ( lx - ux ) >> LOWER_TOTAL ) << ( 2 * UPPER_LOG2 ) ) | ( ( ( ly - uy ) >> LOWER_TOTAL ) << UPPER_LOG2 ) | ( ( lz - uz ) >> LOWER_TOTAL ) );

		let lower = upper.children.get( index );

		if ( lower === undefined ) {

			lower = { origin: [ lx, ly, lz ], children: new Map(), tiles: new Map() };
			upper.children.set( index, lower );

		}

		return { lower, index: ( ( ( ( x - lx ) >> LEAF_LOG2 ) << ( 2 * LOWER_LOG2 ) ) | ( ( ( y - ly ) >> LEAF_LOG2 ) << LOWER_LOG2 ) | ( ( z - lz ) >> LEAF_LOG2 ) ) };

	};

	const values = new Float32Array( 512 * components );
	const mask = new Uint8Array( 64 );
	const value = new Float32Array( components );

	// Reads a voxel into `value`, snapping values within the tolerance to the
	// background, and returns whether it is active.
	const read = ( x, y, z ) => {

		const tx = x - origin[ 0 ], ty = y - origin[ 1 ], tz = z - origin[ 2 ];

		if ( tx < 0 || ty < 0 || tz < 0 || tx >= width || ty >= height || tz >= depth ) {

			value.set( background );
			return false;

		}

		const index = ( ( tz * height + ty ) * width + tx ) * stride;

		let isBackground = true, isMinusBackground = levelSet;

		for ( let c = 0; c < components; c ++ ) {

			const v = data[ index + c ];
			value[ c ] = v;

			// Written so that NaN is never background.
			if ( ! ( Math.abs( v - background[ c ] ) <= tolerance ) ) isBackground = false;
			if ( ! ( Math.abs( v - minusBackground[ c ] ) <= tolerance ) ) isMinusBackground = false;

		}

		if ( isBackground ) {

			value.set( background );
			return false;

		}

		if ( isMinusBackground ) {

			value.set( minusBackground );
			return false;

		}

		return true;

	};

	const x0 = Math.floor( origin[ 0 ] / 8 ) * 8, x1 = origin[ 0 ] + width;
	const y0 = Math.floor( origin[ 1 ] / 8 ) * 8, y1 = origin[ 1 ] + height;
	const z0 = Math.floor( origin[ 2 ] / 8 ) * 8, z1 = origin[ 2 ] + depth;

	for ( let bx = x0; bx < x1; bx += 8 ) {

		for ( let by = y0; by < y1; by += 8 ) {

			for ( let bz = z0; bz < z1; bz += 8 ) {

				mask.fill( 0 );

				let uniform = true;
				let active = 0;

				const tx = bx - origin[ 0 ], ty = by - origin[ 1 ], tz = bz - origin[ 2 ];

				if ( components === 1 && levelSet === false && tolerance === 0 ) {

					// Fast path for scalar grids, same results as read().

					const b = background[ 0 ];

					for ( let x = 0, i = 0; x < 8; x ++ ) {

						const inX = tx + x >= 0 && tx + x < width;

						for ( let y = 0; y < 8; y ++ ) {

							const inXY = inX && ty + y >= 0 && ty + y < height;
							let index = ( tz * height + ty + y ) * width + tx + x;

							for ( let z = 0; z < 8; z ++, i ++, index += width * height ) {

								let v = inXY && tz + z >= 0 && tz + z < depth ? data[ index * stride ] : b;

								if ( v === b ) {

									v = b;

								} else {

									mask[ i >> 3 ] |= 1 << ( i & 7 );
									active ++;

								}

								values[ i ] = v;
								if ( v !== values[ 0 ] ) uniform = false;

							}

						}

					}

				} else for ( let i = 0; i < 512; i ++ ) {

					const on = read( bx + ( i >> 6 ), by + ( ( i >> 3 ) & 7 ), bz + ( i & 7 ) );

					if ( on ) {

						mask[ i >> 3 ] |= 1 << ( i & 7 );
						active ++;

					}

					for ( let c = 0; c < components; c ++ ) {

						values[ i * components + c ] = value[ c ];
						if ( uniform && value[ c ] !== values[ c ] ) uniform = false;

					}

				}

				if ( active !== 0 && active !== 512 ) uniform = false;

				if ( uniform ) {

					const tileValue = Array.from( values.subarray( 0, components ) );
					const isBackground = tileValue.every( ( v, c ) => v === background[ c ] );

					if ( isBackground && active === 0 ) continue;

					const { lower, index } = lowerNode( bx, by, bz );
					lower.tiles.set( index, { value: tileValue, active: active === 512 } );

					if ( active === 512 ) {

						voxelCount += 512;
						expand( bx, by, bz, bx + 7, by + 7, bz + 7 );

					}

					continue;

				}

				const { lower, index } = lowerNode( bx, by, bz );
				lower.children.set( index, { origin: [ bx, by, bz ], valueMask: mask.slice(), values: values.slice() } );

				if ( active > 0 ) {

					voxelCount += active;

					for ( let i = 0; i < 512; i ++ ) {

						if ( isOn( mask, i ) ) expand( bx + ( i >> 6 ), by + ( ( i >> 3 ) & 7 ), bz + ( i & 7 ), bx + ( i >> 6 ), by + ( ( i >> 3 ) & 7 ), bz + ( i & 7 ) );

					}

				}

			}

		}

	}

	const compare = ( a, b ) => a.origin[ 0 ] - b.origin[ 0 ] || a.origin[ 1 ] - b.origin[ 1 ] || a.origin[ 2 ] - b.origin[ 2 ];

	return { roots: [ ...roots.values() ].sort( compare ), voxelCount, bboxMin, bboxMax };

}

function writeInternalTopology( gridWriter, node, log2Dim, background ) {

	const { writer, components } = gridWriter;
	const size = 1 << ( 3 * log2Dim );
	const childMask = new Uint8Array( size >> 3 );
	const valueMask = new Uint8Array( size >> 3 );
	const values = new Float32Array( size * components );

	for ( let i = 0; i < size; i ++ ) values.set( background, i * components );

	for ( const index of node.children.keys() ) {

		childMask[ index >> 3 ] |= 1 << ( index & 7 );
		values.fill( 0, index * components, ( index + 1 ) * components );

	}

	if ( node.tiles !== undefined ) {

		for ( const [ index, tile ] of node.tiles ) {

			values.set( tile.value, index * components );
			if ( tile.active ) valueMask[ index >> 3 ] |= 1 << ( index & 7 );

		}

	}

	writer.append( childMask );
	writer.append( valueMask );

	gridWriter.compressedValues( values, size, valueMask, childMask );

	const indices = [ ...node.children.keys() ].sort( ( a, b ) => a - b );

	for ( const index of indices ) {

		const child = node.children.get( index );

		if ( log2Dim === UPPER_LOG2 ) {

			writeInternalTopology( gridWriter, child, LOWER_LOG2, background );

		} else {

			writer.append( child.valueMask );

		}

	}

	node.sorted = indices;

}

function writeBuffers( gridWriter, node, log2Dim ) {

	for ( const index of node.sorted ) {

		const child = node.children.get( index );

		if ( log2Dim === UPPER_LOG2 ) {

			writeBuffers( gridWriter, child, LOWER_LOG2 );

		} else {

			gridWriter.writer.append( child.valueMask );
			gridWriter.compressedValues( child.values, 512, child.valueMask, null );

		}

	}

}

function randomUUID() {

	if ( typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ) return crypto.randomUUID();

	const hex = () => Math.floor( Math.random() * 16 ).toString( 16 );
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace( /[xy]/g, c => c === 'x' ? hex() : ( 8 + Math.floor( Math.random() * 4 ) ).toString( 16 ) );

}

/**
 * Writes grids as an OpenVDB file.
 *
 * @param {Array<Object>} grids - The grids. Each has a `name`, `components` (1 or 3),
 * dense float `data` with `stride` values per voxel ordered x fastest, then y, then z,
 * its `width`, `height` and `depth`, the index space `origin` of its first voxel, a
 * column-major 4x4 `transform` from index to world space, the `background` value as
 * an array, `levelSet` and `metadata` holding extra string, boolean and number entries.
 * @param {Object} options - The options.
 * @param {('zip'|'none')} options.compression - The compression of the voxel values.
 * @param {boolean} options.halfFloat - Whether to store values as half floats.
 * @param {number} options.tolerance - Values this close to the background are stored as inactive background.
 * @return {ArrayBuffer} The file contents.
 */
function writeVDB( grids, options = {} ) {

	options = Object.assign( { compression: 'zip', halfFloat: false, tolerance: 0 }, options );

	if ( options.compression !== 'zip' && options.compression !== 'none' ) {

		throw new Error( 'THREE.VDBExporter: Unsupported compression ' + options.compression + '.' );

	}

	const writer = new Writer();

	writer.int64( MAGIC );
	writer.uint32( FILE_VERSION );
	writer.uint32( LIBRARY_VERSION[ 0 ] );
	writer.uint32( LIBRARY_VERSION[ 1 ] );
	writer.uint8( 1 ); // grid offsets
	writer.append( new TextEncoder().encode( randomUUID() ) );

	writeMetadata( writer, { creator: [ 'string', 'three-vdb-loader' ] } );

	writer.int32( grids.length );

	const names = new Map();

	for ( const source of grids ) {

		const background = [ source.background ].flat().map( v => Math.fround( v ) );

		if ( background.length !== source.components ) {

			throw new Error( 'THREE.VDBExporter: The background of grid "' + source.name + '" does not match its components.' );

		}
		const grid = Object.assign( {}, source, { background } );
		const gridWriter = new GridWriter( writer, grid, options );

		// Grids with the same name get a suffix, like OpenVDB does.
		const count = names.get( grid.name ) || 0;
		names.set( grid.name, count + 1 );

		writer.string( count === 0 ? grid.name : grid.name + '\x1e' + count );
		writer.string( ( grid.components === 1 ? 'Tree_float_5_4_3' : 'Tree_vec3s_5_4_3' ) + ( options.halfFloat ? '_HalfFloat' : '' ) );
		writer.string( '' ); // instance parent

		const positions = writer.length;
		writer.int64( 0 );
		writer.int64( 0 );
		writer.int64( 0 );

		writer.int64( writer.length, positions ); // grid position

		const tree = buildTree( grid, options.tolerance );

		const compression = COMPRESS_ACTIVE_MASK | ( options.compression === 'zip' ? COMPRESS_ZIP : 0 );
		writer.uint32( compression );

		const metadata = {};

		for ( const [ key, value ] of Object.entries( grid.metadata || {} ) ) {

			if ( RESERVED_METADATA.has( key ) ) continue;

			if ( typeof value === 'string' ) metadata[ key ] = [ 'string', value ];
			else if ( typeof value === 'boolean' ) metadata[ key ] = [ 'bool', value ];
			else if ( typeof value === 'number' && Number.isFinite( value ) ) metadata[ key ] = Number.isInteger( value ) ? [ 'int64', value ] : [ 'double', value ];

		}

		metadata.name = [ 'string', grid.name ];
		metadata.is_saved_as_half_float = [ 'bool', options.halfFloat ];
		metadata.file_compression = [ 'string', options.compression === 'zip' ? 'zip + active values' : 'active values' ];
		metadata.file_voxel_count = [ 'int64', tree.voxelCount ];

		if ( grid.metadata && typeof grid.metadata.class === 'string' ) metadata.class = [ 'string', grid.metadata.class ];
		if ( grid.components === 3 ) metadata.vector_type = [ 'string', ( grid.metadata && grid.metadata.vector_type ) || 'invariant' ];

		if ( tree.voxelCount > 0 ) {

			metadata.file_bbox_min = [ 'vec3i', tree.bboxMin ];
			metadata.file_bbox_max = [ 'vec3i', tree.bboxMax ];

		}

		writeMetadata( writer, metadata );
		writeTransform( writer, grid.transform );

		// Topology.
		writer.uint32( 1 ); // buffer count
		gridWriter.value( background );
		writer.uint32( 0 ); // root tiles
		writer.uint32( tree.roots.length );

		for ( const upper of tree.roots ) {

			for ( const v of upper.origin ) writer.int32( v );
			writeInternalTopology( gridWriter, upper, UPPER_LOG2, background );

		}

		writer.int64( writer.length, positions + 8 ); // block position

		for ( const upper of tree.roots ) writeBuffers( gridWriter, upper, UPPER_LOG2 );

		writer.int64( writer.length, positions + 16 ); // end position

	}

	return writer.result();

}

export { writeVDB, deflate };
