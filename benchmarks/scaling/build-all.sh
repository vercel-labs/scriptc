#!/bin/sh
# Build every probe file with the given scriptc checkout; print diagnostics.
# usage: build-all.sh <scriptc checkout> <outdir>
set -u
sc=${1:-.}
out=${2:-/tmp/scaling-build}
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$out"
for f in arrays strings collections misc async-io; do
  node "$sc/packages/cli/dist/bootstrap.js" build "$here/$f.ts" --optimization=release -o "$out/$f" >"$out/$f.log" 2>&1 &
done
wait
for f in arrays strings collections misc async-io; do
  if [ -x "$out/$f" ]; then echo "ok $f"; else echo "FAIL $f"; grep -A3 'error SC' "$out/$f.log" | head -40; fi
done
