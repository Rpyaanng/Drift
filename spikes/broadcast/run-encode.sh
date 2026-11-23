#!/bin/sh
# Runs spike B's measurements one after another and prints a line for each: sh spikes/broadcast/run-encode.sh
# (BC_SRC=window opens a 1920x1080 window at the top left of the main monitor for about 20 s per run.)
# BC_SUMMARY_ONLY=1 reprints the last results without running anything.
cd "$(dirname "$0")/../.." || exit 1
OUT=$(node -p "require('os').tmpdir()")
run() {       # run <label> <env...>
  label=$1; shift
  f="$OUT/drift-bc-$label.json"
  if [ -z "$BC_SUMMARY_ONLY" ]; then rm -f "$f"; env "$@" BC_OUT="$f" ./node_modules/.bin/electron spikes/broadcast/encode.js >/dev/null 2>&1; fi
  node spikes/broadcast/summary.js "$f" "$label"
}
for n in ${BC_COUNTS:-1 3 7 10}; do run "window-h264-$n" BC_SRC=window BC_N=$n BC_SECS=12; done
for c in ${BC_CODECS:-vp8 vp9 av1}; do run "window-$c-3" BC_SRC=window BC_CODEC=$c BC_N=3 BC_SECS=12; done
