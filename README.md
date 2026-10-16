# three-vdb-loader

OpenVDB loader for three.js.

[Demo](https://richardmonette.github.io/three-vdb-loader/)

<img src="examples/screenshots/torusknot.jpg" width="24%"> <img src="examples/screenshots/smoke.jpg" width="24%"> <img src="examples/screenshots/fire.jpg" width="24%"> <img src="examples/screenshots/velocity.jpg" width="24%">

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
		"fflate": "https://cdn.jsdelivr.net/npm/fflate@0.8.3/esm/browser.js",
		"three-vdb-loader": "https://cdn.jsdelivr.net/npm/three-vdb-loader@0.3.0/VDBLoader.js"
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
