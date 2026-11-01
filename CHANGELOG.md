# Changelog

## Unreleased

- `VDBSequenceLoader` (`three-vdb-loader/sequence`): animated sequences of OpenVDB or NanoVDB files, fetched ahead and decoded in web workers, played back through textures updated in place
- `tools/manifest.mjs` writes sequence manifests
- Demo: a 240 frame oil fire simulation
- NanoVDB files (`.nvdb`): `float`, `double`, `vec3f`, `vec3d`, `fp4`, `fp8`, `fp16` and `fpN` grids, uncompressed, zip or Blosc; the format is detected from the file contents
- `setTextureType()`: `HalfFloatType` (new default), `FloatType` or `UnsignedByteType`
- `setBoundingBox()` to force the texture size, for example across the frames of a sequence
- `setValueRange()` and `grid.valueRange`
- No dependencies: zlib, Blosc and LZ4 decoding is built in
- The parser (`VDBParser.js`) no longer depends on three.js

## 0.3.0

- Vector grids (`vec3s`, `vec3d`)
- `setGridNames()`

## 0.2.0

- Blosc compression
- Fix compressed half float grids with empty blocks

## 0.1.0

- Initial release
