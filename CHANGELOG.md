# Changelog

## 0.7.0

- `createSurfaceGeometry()` (`three-vdb-loader/surface`): marching cubes from a level set or fog volume to an indexed, closed, outward facing `BufferGeometry` in world space, with normals from the grid gradient. Tested on OpenVDB level set spheres and cubes against their exact radius, volume, area and normals
- Demos are separate pages, one per feature, behind a gallery at `examples/index.html`: animation (`sequence.html`), volumes (`volumes.html`) and the new surfaces demo (`surface.html`), with level sets made with OpenVDB (`examples/models/surface/make.sh`) and fog volume isosurfaces. The animation and volumes pages share `examples/volume.js`. The README lists the demos

## 0.6.0

- `VDBExporter` (`three-vdb-loader/exporter`): writes grids from `VDBLoader`, or any `Data3DTexture`, as OpenVDB files for Blender, Houdini and the OpenVDB tools. `float` and `vec3s` grids from float, half float or byte textures, zip or no compression, optional half float storage, tiles for uniform blocks and inactive background voxels. Grids loaded as `FloatType` round-trip with the same values, bounds and transform, and exported files are checked with OpenVDB 10 (`test/openvdb/`)
- `npm test` runs `test/*.test.mjs` only

## 0.5.2

- Releases are published from GitHub Actions with npm provenance
- `package-lock.json` no longer lists `fflate`, which was removed in 0.4.0

## 0.5.1

- Faster parsing, with byte-identical results: OpenVDB files parse 3.5 to 7 times faster and NanoVDB frames about twice as fast

## 0.5.0

- `setMaxResolution()` and `grid.voxelsPerTexel`: grids larger than the limit are downsampled while they are parsed, so grids that were too large for a dense texture load
- `tools/lock.mjs` and a CI workflow: the demo sequences are hashed and checked, since the three.js example loads them

## 0.4.2

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
