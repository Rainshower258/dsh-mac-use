#!/bin/zsh
# Install 86Box + ROMs + the T6 VM folder into cu-base (bench/vm/86box/README.md), then shut the base down clean.
# Takes a backup clone of the base first (cu-base-pre86box-<date>; APFS clone, near-free). Nothing is launched in the
# base: 86Box first runs in throwaway clones.
#   scripts/vm-install-86box.sh <dir with 86Box-macOS.zip, romsx/86Box-roms-*/, t6vm/t6.img>
set -euo pipefail
ROOT=${0:A:h:h}
source "$ROOT/scripts/vm-lib.sh"
SRC=${1:?usage: $0 <86box assets dir>}
ZIP=$SRC/86Box-macOS.zip
ROMS=$(print -l $SRC/romsx/86Box-roms-*(/) | head -1)
IMG=$SRC/t6vm/t6.img
for f in "$ZIP" "$ROMS/machines" "$IMG" "$ROOT/bench/vm/86box/t6/86box.cfg" "$ROOT/bench/vm/86box/t6/ami286.nvr"; do
  [[ -e $f ]] || { print "missing $f"; exit 1; }
done

"$TART" list | grep -q "^local *$BASE .*stopped" || { print "$BASE must exist and be stopped"; exit 1; }
BACKUP=$BASE-pre86box-$(date +%Y%m%d)
"$TART" list | grep -q " $BACKUP " || "$TART" clone "$BASE" "$BACKUP"
print "backup: $BACKUP"

boot_vm "$BASE" --no-graphics
print "base up at $IP"
gssh "mkdir -p Applications 86box/t6/nvr; rm -rf Applications/86Box.app"
# The app goes in as its release zip, unpacked in the guest with ditto (keeps the bundle's signature intact).
# zsh: never write "$IP:A…" (or :h :t :r :e :a :l :u …) in a remote path — "$IP:Applications" applies the :A
# modifier to $IP and rsync copies to a local dir instead, reporting success (2026-10-01). Use ${IP}: or a variable.
grsync "$ZIP" "$GUEST_USER@$IP:86Box-macOS.zip"
gssh "ditto -x -k ~/86Box-macOS.zip ~/Applications/ && rm ~/86Box-macOS.zip"
grsync --delete "$ROMS/" "$GUEST_USER@$IP:86box/roms/"
grsync "$IMG" "$ROOT/bench/vm/86box/t6/86box.cfg" "$GUEST_USER@$IP:86box/t6/"
grsync "$ROOT/bench/vm/86box/t6/ami286.nvr" "$GUEST_USER@$IP:86box/t6/nvr/"
gssh 'codesign -v ~/Applications/86Box.app && echo signature-ok || exit 1; ls ~/86box/t6 ~/86box/t6/nvr; ls ~/86box/roms/machines | wc -l;
      shasum -a 256 ~/86box/t6/t6.img'
gssh "echo $GUEST_PASS | sudo -S shutdown -h now" || true  # ssh drops when the guest goes down
for i in {1..60}; do "$TART" list | grep -q "^local *$BASE .*stopped" && break; sleep 2; done
"$TART" list | grep -q "^local *$BASE .*stopped" || { print "$BASE did not stop; check it"; exit 1; }
print "$BASE stopped; backup kept as $BACKUP"
