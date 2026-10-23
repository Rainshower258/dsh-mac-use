#!/bin/zsh
# scripts/source-hash.sh <package root>: the daemon's source hash, which build-app.sh writes into Info.plist
# (CUSourceHash) and the plugin's host compares with the sources it ships (its node implementation must agree byte
# for byte). Files: Package.swift, scripts/build-app.sh (it decides what the app is beyond the code: its Info.plist keys,
# its bundle id, how it is signed) and every regular file under Sources/ (recursive; symlinks are not regular files and
# are not followed), except those named .DS_Store; all three must be there. Paths relative to the root with "/"
# separators, sorted together by plain byte order (so Package.swift, then Sources/..., then scripts/build-app.sh). For
# each file one line "<relative path>\t<lowercase hex sha256 of its bytes>\n"; the source hash is the lowercase hex
# sha256 of those lines concatenated. Prints the 64 hex characters and a newline. Needs no git, and looks nothing up
# on PATH (build-app.sh runs it as /bin/zsh -f with a minimal environment).
set -euo pipefail
export LC_ALL=C

(( $# == 1 )) || { print -u2 "usage: source-hash.sh <package root>"; exit 2; }
cd -- "$1"
[[ -f Package.swift ]] || { print -u2 "source-hash.sh: $1 has no Package.swift"; exit 1; }
[[ -d Sources ]] || { print -u2 "source-hash.sh: $1 has no Sources/"; exit 1; }
[[ -f scripts/build-app.sh ]] || { print -u2 "source-hash.sh: $1 has no scripts/build-app.sh"; exit 1; }

# ** does not descend into symlinked directories; (.) keeps plain files only, (D) includes dot files, (N) allows none.
found=(Package.swift scripts/build-app.sh Sources/**/*(.DN))
found=(${found:#(*/|).DS_Store})
files=(${(f)"$(print -rl -- $found | /usr/bin/sort)"})
# One shasum call for all of them, in this order: it prints "<hash>  <path>" per file, with a "\" in front when the
# path needs escaping, so a line's hash is its first 64 hex characters after that.
hashes=(${(f)"$(/usr/bin/shasum -a 256 -- $files)"})
(( ${#hashes} == ${#files} )) || { print -u2 "source-hash.sh: shasum gave ${#hashes} lines for ${#files} files"; exit 1; }
lines=''
for i in {1..${#files}}; do
  h=${${hashes[i]#\\}[1,64]}
  [[ $h =~ '^[0-9a-f]{64}$' ]] || { print -u2 "source-hash.sh: no hash for ${files[i]}"; exit 1; }
  lines+="${files[i]}"$'\t'"$h"$'\n'
done
total=$(print -rn -- "$lines" | /usr/bin/shasum -a 256)
print -r -- ${total[1,64]}
