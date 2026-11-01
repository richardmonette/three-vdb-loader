# Changelog

## Unreleased

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
