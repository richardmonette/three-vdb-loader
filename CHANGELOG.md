# Changelog

## Unreleased

- Scrubbing: `VDBSequence` decodes the frame nearest to the wanted one first, skips frames that left the window, and keeps frames either side of the current one while paused

## 0.4.1

- `VDBSequenceLoader` starts its decode workers when the module is imported cross-origin, for example from a CDN
- The demo sequence is 192 frames at 24 fps, 31 MB

## 0.4.0

Breaking changes:

- Textures are `HalfFloatType` by default; they were `FloatType`. `texture.image.data` is now a `Uint16Array` of half floats instead of a `Float32Array`. Call `setTextureType( FloatType )` to keep the old behaviour.
- `fflate` is no longer a dependency. Remove it from import maps that listed it only for this loader.

New:

- `VDBSequenceLoader` (`three-vdb-loader/sequence`): animated sequences of OpenVDB or NanoVDB files, fetched ahead and decoded in web workers, played back through textures updated in place
- `tools/manifest.mjs` writes sequence manifests
- Demo: a 240 frame oil fire simulation
- NanoVDB files (`.nvdb`): `float`, `double`, `vec3f`, `vec3d`, `fp4`, `fp8`, `fp16` and `fpN` grids, uncompressed, zip or Blosc; the format is detected from the file contents
- `setTextureType()`: `HalfFloatType` (new default), `FloatType` or `UnsignedByteType`
- `setBoundingBox()` to force the texture size, for example across the frames of a sequence
- `setValueRange()` and `grid.valueRange`
- No dependencies: zlib (replacing `fflate`), Blosc and LZ4 decoding is built in
- The parser (`VDBParser.js`) no longer depends on three.js

## 0.3.0

- Vector grids (`vec3s`, `vec3d`)
- `setGridNames()`

## 0.2.0

- Blosc compression
- Fix compressed half float grids with empty blocks

## 0.1.0

- Initial release
