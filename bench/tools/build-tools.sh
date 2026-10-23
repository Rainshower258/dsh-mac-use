#!/bin/zsh
# Builds the bench's command-line tools into bench/tools/bin (gitignored): vision-ocr (Apple Vision OCR on image
# files) and inputsource (reads / selects the keyboard input source in the VM). Idempotent: a binary newer than its
# source is kept. The VM experiment runner calls this before syncing tools/bin into a clone.
set -euo pipefail
TOOLS=${0:A:h}
mkdir -p $TOOLS/bin
for t in vision-ocr inputsource; do
  src=$TOOLS/$t.swift bin=$TOOLS/bin/$t
  [[ -x $bin && $bin -nt $src ]] && continue
  swiftc -O -target arm64-apple-macosx14.0 $src -o $bin
  print "built $bin"
done
