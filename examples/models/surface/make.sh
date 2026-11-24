#!/bin/sh
# Level set models for examples/surface.html, built with OpenVDB's vdb_tool (Ubuntu:
# libopenvdb-tools). Run in WSL or Linux from this directory.
set -e
V=0.02

# A dodecahedron with a sphere carved out of it, which opens a window in every face. The
# opening rounds the knife edges where the sphere meets the faces.
vdb_tool -quiet \
	-platonic faces=12 scale=1.6 voxel=$V width=3 name=dodecahedron \
	-sphere radius=1.33 voxel=$V width=3 \
	-difference vdb=1,0 \
	-open radius=2 \
	-gauss iter=2 size=1 \
	-write codec=zip dodecahedron.vdb

# Seven spheres merged by a morphological closing, which rounds the creases between them.
vdb_tool -quiet \
	-sphere radius=0.55 center="(0,0,0)" voxel=$V width=3 \
	-sphere radius=0.38 center="(0.62,0.25,0.1)" voxel=$V width=3 -union \
	-sphere radius=0.34 center="(-0.55,0.35,-0.2)" voxel=$V width=3 -union \
	-sphere radius=0.30 center="(0.1,-0.62,0.25)" voxel=$V width=3 -union \
	-sphere radius=0.28 center="(-0.2,0.15,0.62)" voxel=$V width=3 -union \
	-sphere radius=0.26 center="(0.3,0.55,-0.45)" voxel=$V width=3 -union \
	-sphere radius=0.22 center="(-0.45,-0.45,-0.4)" voxel=$V width=3 -union \
	-close radius=12 \
	-write codec=zip blobs.vdb

# A cube with a sphere dimple in each face and its edges rounded.
vdb_tool -quiet \
	-platonic faces=6 scale=1.4 voxel=$V width=3 name=cube \
	-sphere radius=0.42 center="(0.75,0,0)" voxel=$V width=3 -difference vdb=1,0 \
	-sphere radius=0.42 center="(-0.75,0,0)" voxel=$V width=3 -difference vdb=1,0 \
	-sphere radius=0.42 center="(0,0.75,0)" voxel=$V width=3 -difference vdb=1,0 \
	-sphere radius=0.42 center="(0,-0.75,0)" voxel=$V width=3 -difference vdb=1,0 \
	-sphere radius=0.42 center="(0,0,0.75)" voxel=$V width=3 -difference vdb=1,0 \
	-sphere radius=0.42 center="(0,0,-0.75)" voxel=$V width=3 -difference vdb=1,0 \
	-gauss iter=3 size=1 \
	-write codec=zip dice.vdb

ls -la *.vdb
