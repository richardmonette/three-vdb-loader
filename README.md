# three-vdb-loader

[OpenVDB](https://www.openvdb.org/) and [NanoVDB](https://github.com/AcademySoftwareFoundation/openvdb/tree/master/nanovdb) loader for three.js, with an OpenVDB exporter and level set meshing. OpenVDB is the industry standard for sparse volumes. NanoVDB packs the same data into a compact read-only layout, which makes it the better fit for the web: smaller files and far less work to decode.

## Demos

All demos: [richardmonette.github.io/three-vdb-loader/examples](https://richardmonette.github.io/three-vdb-loader/examples/)

- [Animation](https://richardmonette.github.io/three-vdb-loader/examples/sequence.html) (`VDBSequenceLoader`): a 192 frame NanoVDB fire simulation, fp8 or fp4, streamed and decoded in web workers while it plays.
- [Volumes](https://richardmonette.github.io/three-vdb-loader/examples/volumes.html) (`VDBLoader`): single OpenVDB files raymarched from 3D textures. A frame of the fire, a torus knot fog volume, and the openvdb.org smoke, smoke2 (density and velocity) and fire, with flat, blackbody, direction and fire views.
- [Surfaces](https://richardmonette.github.io/three-vdb-loader/examples/surface.html) (`createSurfaceGeometry`): level sets built with OpenVDB (a carved dodecahedron, merged blobs, a dimpled cube) and isosurfaces of the torus knot and the fire's smoke, turned into meshes. Isovalue, resolution, normals and wireframe controls.
- [three.js `webgpu_loader_vdb`](https://github.com/mrdoob/three.js/blob/dev/examples/webgpu_loader_vdb.html): the official three.js example, which streams the fire sequence with this package and renders it with WebGPU.

<a href="https://richardmonette.github.io/three-vdb-loader/examples/sequence.html"><img src="media/fire_sequence.gif" width="400" alt="192 frame fire simulation streamed and played back at 24 fps"></a>

Above, 192 frames of NanoVDB, 31 MB, streamed and decoded in web workers while it plays ([mp4](media/fire_sequence.mp4)).

<a href="https://richardmonette.github.io/three-vdb-loader/examples/volumes.html"><img src="examples/screenshots/torusknot.jpg" width="24%"> <img src="examples/screenshots/smoke.jpg" width="24%"> <img src="examples/screenshots/fire.jpg" width="24%"> <img src="examples/screenshots/velocity.jpg" width="24%"></a>

Above, single OpenVDB files: a torus knot fog volume, the openvdb.org smoke, its fire rendered from the density and temperature grids with the same model as the animation, and the velocity of the second smoke coloured by direction. Each grid becomes one `Data3DTexture`, raymarched in a fragment shader.

```
npm install three-vdb-loader
```

```html
<!DOCTYPE html>
<html>
<body style="margin: 0">
<script type="importmap">
{
	"imports": {
		"three": "https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js",
		"three/addons/": "https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/",
		"three-vdb-loader": "https://cdn.jsdelivr.net/npm/three-vdb-loader@0.6.0/VDBLoader.js"
	}
}
</script>
<script type="module">

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VDBLoader } from 'three-vdb-loader';

const renderer = new THREE.WebGLRenderer();
renderer.setSize( innerWidth, innerHeight );
document.body.appendChild( renderer.domElement );

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera( 50, innerWidth / innerHeight, 0.1, 1000 );
const controls = new OrbitControls( camera, renderer.domElement );

const url = 'https://media.githubusercontent.com/media/AcademySoftwareFoundation/openvdb-website/master/download/models/smoke.vdb';
const [ grid ] = await new VDBLoader().setGridNames( [ 'density' ] ).loadAsync( url );

const material = new THREE.ShaderMaterial( {
	uniforms: { map: { value: grid.texture } },
	vertexShader: `
		varying vec3 vOrigin;
		varying vec3 vDirection;
		void main() {
			vOrigin = ( inverse( modelMatrix ) * vec4( cameraPosition, 1.0 ) ).xyz;
			vDirection = position - vOrigin;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
		}`,
	fragmentShader: `
		precision highp sampler3D;
		uniform sampler3D map;
		varying vec3 vOrigin;
		varying vec3 vDirection;
		void main() {
			vec3 dir = normalize( vDirection );
			vec3 t0 = ( - 0.5 - vOrigin ) / dir, t1 = ( 0.5 - vOrigin ) / dir;
			vec3 near = min( t0, t1 ), far = max( t0, t1 );
			float start = max( max( max( near.x, near.y ), near.z ), 0.0 );
			float end = min( min( far.x, far.y ), far.z );
			float step = ( end - start ) / 128.0;
			float alpha = 0.0;
			for ( int i = 0; i < 128; i ++ ) {
				alpha += ( 1.0 - alpha ) * texture( map, vOrigin + dir * ( start + float( i ) * step ) + 0.5 ).r * 0.05;
			}
			gl_FragColor = vec4( vec3( 1.0 ), alpha );
		}`,
	side: THREE.BackSide,
	transparent: true
} );

const center = grid.bbox.getCenter( new THREE.Vector3() );
const size = grid.bbox.getSize( new THREE.Vector3() ).addScalar( 1 );

const mesh = new THREE.Mesh( new THREE.BoxGeometry(), material );
mesh.matrixAutoUpdate = false;
mesh.matrix.copy( grid.transform ).multiply( new THREE.Matrix4().makeTranslation( center ).scale( size ) );
mesh.updateMatrixWorld( true );
scene.add( mesh );

const box = new THREE.Box3().setFromObject( mesh );
box.getCenter( controls.target );
camera.position.copy( controls.target ).add( new THREE.Vector3( 0, 0, box.getSize( new THREE.Vector3() ).length() ) );

renderer.setAnimationLoop( () => {

	controls.update();
	renderer.render( scene, camera );

} );

</script>
</body>
</html>
```

## Sequences

Animated volumes are a sequence of files, one per frame. `VDBSequenceLoader` fetches
them in order, decodes them in a pool of web workers a few frames ahead of playback
and updates one set of textures in place, so memory stays bounded whatever the length
of the sequence and playback starts as soon as the first frame is decoded.

```js
import { VDBSequenceLoader } from 'three-vdb-loader/sequence';

const sequence = await new VDBSequenceLoader()
	.setGridNames( [ 'density' ] )
	.setTextureType( THREE.UnsignedByteType )   // a quarter of the memory of float textures
	.loadAsync( 'models/fire/sequence.json', ( loaded, total ) => console.log( loaded + ' / ' + total ) );

material.uniforms.map.value = sequence.grids[ 0 ].texture;   // updated in place as frames change
sequence.play();

function animate() {

	sequence.update( timer.getDelta() );   // advances playback, never ahead of the decoded frames
	renderer.render( scene, camera );

}
```

`sequence.frame` seeks, `sequence.loop`, `pause()` and `dispose()` do what they say, and
`sequence.bbox` is the box all frames share. The manifest is a JSON file next to the frames:

```json
{ "fps": 24, "frames": [ "frame_000.nvdb", "frame_001.nvdb" ], "bbox": [ -6, -1, 9, 70, 91, 89 ],
  "valueRange": { "density": [ 0, 14.2 ] } }
```

`bbox` and `valueRange` are optional (the loader reads the box from the NanoVDB headers
and measures the range if needed) but they let every frame share one texture size and one
normalization. `node tools/manifest.mjs <directory> --fps 30` writes a manifest for a
directory of frames. Convert simulation frames with `nanovdb_convert --fp8 -z`: the
demo's 192 frame fire is 31 MB at 8 bits per voxel, 16 MB at 4. The demo sequences are locked (`tools/lock.mjs`, checked in CI) because the three.js example loads them from this repository's GitHub Pages site.

## Options

```js
const loader = new VDBLoader()
	.setGridNames( [ 'density' ] )              // grids to load, default: all
	.setTextureType( THREE.HalfFloatType )       // HalfFloatType (default), FloatType or UnsignedByteType
	.setBoundingBox( box3 )                      // index space box the textures cover, default: the active voxels
	.setValueRange( new THREE.Vector2( 0, 1 ) )  // range for UnsignedByteType normalization, default: measured
	.setMaxResolution( 256 );                    // largest texture size along any axis, default: no limit
```

Each grid has `name`, `type`, `metadata`, `transform` (index to world space `Matrix4`),
`background`, `bbox` (the index space `Box3` the texture covers, inclusive), `valueRange`
(a `Vector2` with the minimum and maximum voxel value), `voxelsPerTexel` and `texture`
(a `Data3DTexture`, or `null` for an empty grid). `UnsignedByteType` textures store values
normalized to `valueRange`; the other types store the values as they are.

## Large grids

A texture holds every voxel inside `bbox`, so a grid of 2000 voxels a side does not fit
in memory, let alone on a phone. `setMaxResolution( n )` downsamples grids that are larger
than `n` texels along any axis while they are parsed, without ever allocating the full
resolution grid. Each texel is the mean of a cube of `grid.voxelsPerTexel` voxels along
each axis (a whole number, `1` for grids that fit), and `grid.bbox` grows to a whole number
of those cubes, so code that places the volume from `bbox` and `transform` works unchanged.
`valueRange` is measured on the downsampled values. The option applies to OpenVDB and
NanoVDB files and to sequences, where every frame gets the same size.

## Surfaces

<a href="https://richardmonette.github.io/three-vdb-loader/examples/surface.html"><img src="examples/screenshots/surface.jpg" width="400" alt="A level set dodecahedron with a sphere carved out of it, meshed with createSurfaceGeometry"></a>

`createSurfaceGeometry` turns a scalar grid into a triangle mesh with marching cubes. Many
VDB files are level sets, the signed distance to a surface (fluid simulations, booleans and
sculpts from Houdini or Blender), and this gives you that surface as a normal
`BufferGeometry` to light, shade, collide with or export.

```js
import { createSurfaceGeometry } from 'three-vdb-loader/surface';

const [ grid ] = await new VDBLoader().setTextureType( THREE.FloatType ).loadAsync( 'bunny.vdb' );
const geometry = createSurfaceGeometry( grid );   // { isovalue: 0 } by default

scene.add( new THREE.Mesh( geometry, new THREE.MeshStandardMaterial() ) );
```

The geometry is indexed, in world space (from `grid.transform`), closed, and faces outwards,
with normals from the gradient of the grid rather than averaged from the triangles. For a level
set the isovalue is the offset from the surface: `0.1` grows it by 0.1 world units. For a fog
volume pass a density, and the surface encloses the voxels denser than it. Float textures give
the most accurate surface; half float and byte textures work too, and downsampled grids
(`setMaxResolution`) give a quick low resolution mesh in the same place.

## Exporting

`VDBExporter` writes grids back to OpenVDB files that Blender, Houdini and the OpenVDB
tools open: the grids `VDBLoader` returns, or any `Data3DTexture` you generate or simulate
in the browser.

```js
import { VDBExporter } from 'three-vdb-loader/exporter';

const buffer = new VDBExporter().parse( grids );   // or a Data3DTexture, or { name, texture, transform, ... }

const link = document.createElement( 'a' );
link.href = URL.createObjectURL( new Blob( [ buffer ] ) );
link.download = 'volume.vdb';
link.click();
```

`RedFormat` textures become `float` grids and `RGBAFormat` textures `vec3s` grids (alpha is
dropped), from `FloatType`, `HalfFloatType` or `UnsignedByteType` data; byte textures need
the `valueRange` they are normalized to. A grid may also carry a `name`, `transform`, `bbox`
(its `min` places the texture in index space), `background`, `voxelsPerTexel` and `metadata`;
`metadata.class` (`'fog volume'`, `'level set'`) becomes the grid class. Voxels equal to the
background (and, in level sets, to its negation) are stored as inactive, so only the occupied
part of the volume takes space. Downsampled grids get larger voxels in the same place.

```js
exporter.parse( grids, {
	compression: 'zip',   // 'zip' (default) or 'none'
	halfFloat: false,     // store half floats: half the size, reduced precision
	tolerance: 0          // values this close to the background become inactive
} );
```

A grid loaded as `FloatType` and exported comes back with the same values, bounds and
transform. Exported files are checked with OpenVDB 10 itself (`test/openvdb/`): `vdb_print`
reads them, and the copies `vdb_tool` and `nanovdb_convert` write hold the same voxels.

## NanoVDB

The loader also reads [NanoVDB](https://github.com/AcademySoftwareFoundation/openvdb/tree/master/nanovdb) files
(`.nvdb`, version 32), the GPU oriented layout of the same data. The format is detected from
the file contents, so `.vdb` and `.nvdb` files load the same way. Convert with the
`nanovdb_convert` tool that ships with OpenVDB:

```
nanovdb_convert --fp8 -z -g density smoke.vdb smoke.nvdb
```

`--fp4`, `--fp8`, `--fp16` and `--fpN` quantize the voxels per leaf node to 4, 8, 16 or
a variable number of bits and `-z` or `-b` compress the file with zip or Blosc. An
`fp8` grid is about a quarter of the size of the equivalent OpenVDB file, which makes
NanoVDB the format of choice for frame sequences. Supported grid types: `float`,
`double`, `vec3f`, `vec3d`, `fp4`, `fp8`, `fp16` and `fpN`, with the `NONE`, `ZIP` and
`BLOSC` codecs.

Half float textures can be filtered on every WebGL 2 and WebGPU device, including iOS,
and use half the memory of float textures. Set `FloatType` to keep the exact values.
Set a bounding box when loading several files that should share one texture size,
for example the frames of a simulation.
