#!/bin/zsh
# T7 set-up session (bench/vm/qq/README.md): QQ into cu-base-qq, logged in as the TEST account, with the scripted
# messages, then the base shut down clean. Needs the maintainer at the Mac (QR login on the phone).
#   scripts/vm-qq-base.sh prepare <QQ zip>   # backup clone, boot the base WITH a window, install and open QQ
#   scripts/vm-qq-base.sh inspect            # (after sending) how QQ shows the scripted lines: AX (electron_ax off/on)
#                                            # and OCR text, for T7-qq-latest's `equivalents` (emoji vs QQ face text)
#   scripts/vm-qq-base.sh finish             # check, quit QQ (keeps the login), shut the base down; also how the
#                                            # base's grant (scripts/vm-grant-base.sh, step 6) is finished
# Nothing of the maintainer's own QQ data goes in: the zip holds the app bundle only (ditto of /Applications/QQ.app).
set -euo pipefail
ROOT=${0:A:h:h}
# T7 has its own base (2026-10-10): QQ starts at login by itself (mechanism not found), so cu-base never has QQ and
# every other suite stays free of it. cu-base-qq was cloned from cu-base; it keeps QQ's local data between T7 rounds.
CU_BASE=${CU_BASE:-cu-base-qq}
source "$ROOT/scripts/vm-lib.sh"

case ${1:-} in
prepare)
  ZIP=${2:?usage: $0 prepare <QQ zip>}
  "$TART" list | grep -q "^local *$BASE .*stopped" || { print "$BASE must exist and be stopped"; exit 1; }
  # The daemon with the action allowlist (T7 is read only) goes into the base in the same session. Same signing
  # identity (the bench one, vm-lib.sh), so the base's TCC grants hold (PLAN-v2 §3.2); finish checks that before
  # shutting down.
  HEAD=$(git -C "$ROOT" rev-parse --short HEAD)
  # A bench build (vm-lib.sh): inspect turns config_grants on in the base's config.json.
  BUILD_BENCH="CU_BENCH=1 CU_DIST=$ROOT/dist-bench scripts/build-app.sh"
  [[ -z $(git -C "$ROOT" status --porcelain -- Sources Package.swift scripts/build-app.sh) ]] || { print "daemon sources uncommitted: commit, then $BUILD_BENCH"; exit 1; }
  require_bench_app || exit 1
  [[ $(plutil -extract CFBundleVersion raw "$BENCH_APP/Contents/Info.plist") == *-$HEAD ]] \
    || { print "$BENCH_APP is not built from $HEAD: run $BUILD_BENCH"; exit 1; }
  BACKUP=$BASE-preqq-$(date +%Y%m%d)
  "$TART" list | grep -q " $BACKUP " || "$TART" clone "$BASE" "$BACKUP"
  print "backup: $BACKUP"
  boot_vm "$BASE"   # with a window: the QR code has to be scanned from it
  gssh "pkill -x cu-runtime; true"
  deploy_app
  gssh "mkdir -p Applications; rm -rf Applications/QQ.app"
  grsync "$ZIP" "${GUEST_USER}@${IP}:QQ.zip"
  gssh "ditto -x -k ~/QQ.zip ~/Applications/ && rm ~/QQ.zip && codesign -v ~/Applications/QQ.app && echo signature-ok"
  gssh "open ~/Applications/QQ.app"
  print "base is up at $IP with QQ open. In the VM window: log in the TEST account (QR), tick auto-login;"
  print "then send bench/vm/qq/messages.md from the other account; pin that conversation and close it; then: $0 finish"
  ;;
inspect)
  # Synthetic test-account content only (messages.md). Read-only grant; the daemon is stopped again at the end,
  # which turns electron_ax back off. Prints just the lines that hold the scripted messages' anchors.
  IP=$("$TART" ip "$BASE")
  grsync "$ROOT/scripts/cu-rpc.py" "${GUEST_USER}@${IP}:cu-rpc.py"
  # It grants QQ up front with grants.set, which the daemon refuses unless its config turns it on (config_grants).
  # The base is not a throwaway clone: switch it on for this run only and put the base's own config back after.
  CFG='$HOME/Library/Application Support/cu-runtime/config.json'
  gssh "mkdir -p -m 700 \"\$(dirname \"$CFG\")\"; if [ -f \"$CFG\" ]; then cp -p \"$CFG\" /tmp/cu-config.base; else rm -f /tmp/cu-config.base; fi
        ~/.local/python/bin/python3 -c 'import json,os,sys; f=sys.argv[1]; c=json.load(open(f)) if os.path.exists(f) else {}; c[\"config_grants\"]=True; open(f,\"w\").write(json.dumps(c))' \"$CFG\"; chmod 600 \"$CFG\""
  gssh "pkill -x cu-runtime; open -n ~/$GUEST_APP --args serve; sleep 3"
  for ax in false true; do
    print "== electron_ax $ax"
    gssh "~/.local/python/bin/python3 cu-rpc.py grants.set '{\"task_id\":\"inspect\",\"bundle_ids\":[\"com.tencent.qq\"],\"source\":\"config\",\"electron_ax\":$ax,\"actions\":[\"observe\"]}' >/dev/null
          # The AX tree builds over a few seconds after electron_ax goes on: read the third observe, 5 s apart.
          for i in 1 2 3; do ~/.local/python/bin/python3 cu-rpc.py observe '{\"task_id\":\"inspect\",\"ocr\":\"on\"}' > /tmp/cu-obs.json; sleep 5; done
          cat /tmp/cu-obs.json; rm -f /tmp/cu-obs.json" | python3 -c '
import json, sys
r = json.load(sys.stdin)
els = (r.get("result") or {}).get("untrusted_observation", {}).get("elements", [])
for e in els:
    if any(k in e["text"] for k in ("好的", "收到", "带伞", "取件码", "订单号")):
        print(e["source"], e.get("role") or "-", repr(e["text"]), [hex(ord(c)) for c in e["text"] if ord(c) > 0x2000 and not 0x3000 <= ord(c) <= 0x9fff and not 0xff00 <= ord(c) <= 0xffef])
print(len(els), "elements" if els else r)'
    gssh "~/.local/python/bin/python3 cu-rpc.py grants.revoke '{\"task_id\":\"inspect\"}' >/dev/null"
  done
  gssh "pkill -x cu-runtime; rm -f cu-rpc.py; if [ -f /tmp/cu-config.base ]; then mv /tmp/cu-config.base \"$CFG\"; else rm -f \"$CFG\"; fi; true"
  print "Compare with the VM window: are the emoji drawn as system emoji or as QQ's own faces?"
  ;;
finish)
  IP=$("$TART" ip "$BASE")
  # The redeployed daemon must still be trusted (no new grant): else the base stays up for vm-grant-base.sh.
  result=$(self_check); print -r -- "$result"
  python3 -c 'import json,sys; r=json.loads(sys.argv[1]); sys.exit(0 if r["ax_trusted"] and r["sck"]["ok"] else 1)' "$result" \
    || { print "self-check FAILED: base left running; grant CURuntime again (vm-grant-base.sh flow), then rerun finish"; exit 1; }
  gssh "pkill -x cu-runtime; rm -rf ~/Library/Application\\ Support/cu-runtime; true"
  gssh 'pgrep -x QQ >/dev/null && echo qq-running || echo QQ-NOT-RUNNING'
  gssh 'pkill -TERM -x QQ; for i in $(seq 30); do pgrep -x QQ >/dev/null || break; sleep 1; done; pgrep -x QQ && echo still-running || echo qq-quit'
  gssh "echo $GUEST_PASS | sudo -S shutdown -h now" || true
  for i in {1..60}; do "$TART" list | grep -q "^local *$BASE .*stopped" && break; sleep 2; done
  "$TART" list | grep -q "^local *$BASE .*stopped" || { print "$BASE did not stop; check it"; exit 1; }
  print "$BASE stopped"
  ;;
*)
  print "usage: $0 prepare <QQ zip> | inspect | finish"; exit 2 ;;
esac
