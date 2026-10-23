#!/bin/zsh
# Enables the repo's hooks for this clone (hooks are not cloned, so run this on every machine) and creates
# the local-only private-patterns file the pre-push hook requires.
set -euo pipefail
ROOT=${0:A:h:h}
git -C "$ROOT" config core.hooksPath scripts/hooks
P="$ROOT/.git/info/private-patterns"
if [[ ! -s $P ]]; then
  : >> "$P"; chmod 600 "$P"
  print "NOTE: $P is empty. Pushes are refused until you add your private strings (one per line)."
fi
print "hooks enabled: core.hooksPath=scripts/hooks"
