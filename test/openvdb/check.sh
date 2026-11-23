#!/bin/sh
# Checks exported files with OpenVDB itself. Run in WSL or Linux with the OpenVDB
# and NanoVDB tools (Ubuntu: libopenvdb-tools, libnanovdb-tools) from the repository root:
#
#   node test/openvdb/export.mjs && sh test/openvdb/check.sh && node test/openvdb/compare.mjs
#
# Every file in test/openvdb/out/ is printed with vdb_print, written again by OpenVDB
# with vdb_tool and converted with nanovdb_convert. compare.mjs then checks that those
# copies hold the same values, bounds and transforms as the exported files.

set -u
cd "$(dirname "$0")"
rm -rf openvdb
mkdir -p openvdb
fail=0
count=0

for f in out/*.vdb; do

	b=$(basename "$f" .vdb)
	count=$((count + 1))

	if ! vdb_print -l "$f" > "openvdb/$b.txt" 2>&1; then echo "vdb_print failed: $f"; head -5 "openvdb/$b.txt"; fail=1; continue; fi
	if ! vdb_tool -read "$f" -write "openvdb/$b.vdb" > /dev/null 2>&1; then echo "vdb_tool failed: $f"; fail=1; fi
	if ! nanovdb_convert -f "$f" "openvdb/$b.nvdb" > /dev/null 2>&1; then echo "nanovdb_convert failed: $f"; fail=1; fi

done

echo "$count files read by $(vdb_print --version 2>&1 | head -1)"
exit $fail
