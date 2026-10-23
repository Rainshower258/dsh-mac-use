#!/bin/zsh
# Signing acceptance (docs/DESIGN.md, Signing): rebuild -> deploy into a fresh clone -> NO re-grant ->
# AXIsProcessTrusted must be true and a real SCK capture must succeed.
set -uo pipefail
ROOT=${0:A:h:h}
source "$ROOT/scripts/vm-lib.sh"
CLONE=signcheck-$(date +%H%M%S)

"$TART" list | grep -q "^local *$BASE .*stopped" || { print "$BASE must exist and be stopped"; exit 1; }
# A bench build, as every guest gets (vm-lib.sh): signed with the bench identity, whose certificate the base's grants
# pin, and with hardened runtime like a release build. CU_SIGN_IDENTITY=- (ad-hoc) is the negative case: it must FAIL.
CU_BENCH=1 CU_DIST=$ROOT/dist-bench "$ROOT/scripts/build-app.sh" | tail -2 || exit 1

body() {
  boot_vm "$CLONE" --no-graphics
  print "guest had: $(gssh "defaults read ~/$GUEST_APP/Contents/Info CFBundleVersion")"
  deploy_app
  print "deployed: $(gssh "defaults read ~/$GUEST_APP/Contents/Info CFBundleVersion")"
  local result
  result=$(self_check)
  print "$result"
  python3 -c 'import json,sys; r=json.loads(sys.argv[1]); sys.exit(0 if r["ax_trusted"] and r["sck"]["ok"] else 1)' "$result" \
    && print "PASS: grants survived the rebuild" || { print "FAIL"; return 1; }
}
with_clone "$CLONE" body
