#!/bin/sh
# Converts a subset of the OpenVDB fixtures to NanoVDB with nanovdb_convert
# (NanoVDB 32.4, from Ubuntu libnanovdb-tools). Run from this directory in WSL.
# Most files are zip or Blosc compressed to keep the repository small; the
# uncompressed codec is covered by empty.nvdb and unsupported_int32.nvdb.
set -e
mkdir -p nano
c() { out=$1; shift; nanovdb_convert -f "$@" "nano/$out" >/dev/null; echo "$out"; }
c fog_float_zip.nvdb -z fog_zip_mask.vdb
c fog_float_blosc.nvdb -b fog_blosc.vdb
c fog_fp4_zip.nvdb --fp4 -z fog_mask.vdb
c fog_fp8_zip.nvdb --fp8 -z fog_mask.vdb
c fog_fp16_zip.nvdb --fp16 -z fog_mask.vdb
c fog_fpN_zip.nvdb --fpN -a 0.01 -z fog_mask.vdb
c fog_fpN_relative_blosc.nvdb --fpN -r 0.05 -b fog_mask.vdb
c fog_fp8_dither_blosc.nvdb --fp8 -d -b fog_mask.vdb
c levelset_float_zip.nvdb -z levelset_zip_mask.vdb
c levelset_fp8_zip.nvdb --fp8 -z levelset_blosc_mask.vdb
c levelset_fp16_blosc.nvdb --fp16 -b levelset_blosc_mask.vdb
c levelset_unknown_zip.nvdb -z levelset_unknown_zip_mask.vdb
c tiles_float_zip.nvdb -z tiles_zip_mask.vdb
c tiles_fp8_blosc.nvdb --fp8 -b tiles_blosc_mask.vdb
c multi_float_zip.nvdb -z multi_zip_mask.vdb
c multi_fp8_blosc.nvdb --fp8 -b multi_blosc_mask.vdb
c vec3s_random_zip.nvdb -z vec3s_random_zip_mask.vdb
c vec3s_gradient_zip.nvdb -z vec3s_gradient_blosc_mask.vdb
c vec3s_tiles_blosc.nvdb -b vec3s_tiles_blosc_mask.vdb
c vec3s_with_scalar_blosc.nvdb -b vec3s_with_scalar_blosc_mask.vdb
c random_fp8_zip.nvdb --fp8 -z random_zip_mask.vdb
c random_savehalf_float_zip.nvdb -z random_savehalf_zip_mask.vdb
c double_zip.nvdb -z double_zip_mask.vdb
c empty.nvdb empty.vdb
c unsupported_int32.nvdb unsupported_int32.vdb
ls -l nano | awk 'NR > 1 { print $5, $9 }'
