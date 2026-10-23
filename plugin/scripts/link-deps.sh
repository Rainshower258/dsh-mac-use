#!/bin/zsh
# The plugin builds and runs against the same dsh packages as the upstream reference plugin (the dsh version the
# bench uses). Link its node_modules instead of installing a second copy.
set -euo pipefail
here=${0:A:h:h}
upstream=${DSH_CU_LEGACY:-${here:h:h}/dsh-computer-use}/packages/computer-use/dsh-computer-use/node_modules
[[ -d $upstream ]] || { print "missing $upstream (run npm install there)"; exit 1 }
ln -sfn "$upstream" "$here/node_modules"
print "linked $here/node_modules -> $upstream"
