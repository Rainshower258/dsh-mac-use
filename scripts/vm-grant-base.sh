#!/bin/zsh
# One-time (per bench signing identity, cu-runtime-bench-signing): install the bench build of CURuntime.app into cu-base
# and have the maintainer grant it Accessibility + Screen Recording, then shut the base down clean. The grants pin the
# bench certificate, so every later bench build keeps them in every clone, and no build signed otherwise gets them.
#   scripts/vm-grant-base.sh prepare   # boot base with a window, deploy, trigger the permission prompts
#   scripts/vm-grant-base.sh finish    # self-check, clean up, shut down
# The whole setup, from a Mac without the bench identity (also after the switch from the release identity, 2026-10-20):
#   1. zsh scripts/make-signing-identity.sh cu-runtime-bench-signing   (in Terminal on the Mac's screen)
#   2. CU_BENCH=1 zsh scripts/build-app.sh   (the keychain asks for the login password: Allow, not Always Allow)
#   3. scripts/vm-grant-base.sh prepare. In the base's window, System Settings → Privacy & Security: under
#      Accessibility turn CURuntime on; under Screen & System Audio Recording (屏幕与系统录音) turn CURuntime on. If a
#      CURuntime row does not take effect (finish's self-check says false), select it, remove it with "–", add
#      ~/Applications/CURuntime.app with "+", and run finish again.
#   4. scripts/vm-grant-base.sh finish: the self-check must show "ax_trusted": true and "sck": {"ok": true, ...}
#      (otherwise the base is left running).
#   5. scripts/vm-signing-check.sh: PASS (a rebuild deployed into a fresh clone keeps the grants). It builds again, so
#      the keychain asks for the login password once more: Allow, not Always Allow.
#   6. The QQ base has grants of its own: CU_BASE=cu-base-qq scripts/vm-grant-base.sh prepare, grant as in step 3,
#      then scripts/vm-qq-base.sh finish (not this script's finish): the same self-check, and it quits QQ with SIGTERM
#      and waits for it before the shutdown, which keeps the test account's login (bench/vm/qq/README.md). This
#      script's finish refuses a base with QQ in it and says so.
set -euo pipefail
ROOT=${0:A:h:h}
source "$ROOT/scripts/vm-lib.sh"

case ${1:-} in
prepare)
  "$TART" list | grep -q "^local *$BASE .*stopped" || { print "$BASE must exist and be stopped"; exit 1; }
  require_bench_app || exit 1
  boot_vm "$BASE"
  deploy_app
  # From a clean slate: rows granted to another certificate (the release identity's, before 2026-10-20) stay listed
  # as CURuntime but do not match this build, and a System Settings left open can write such a row back
  # (VM 2026-10-11; scripts/install.sh clears such rows too). Best effort; step 3 above says what to do by hand when a row still does not take.
  gssh "osascript -e 'tell application \"System Settings\" to quit' >/dev/null 2>&1; tccutil reset Accessibility $BUNDLE_ID >/dev/null 2>&1; tccutil reset ScreenCapture $BUNDLE_ID >/dev/null 2>&1; true"
  sleep 1
  gssh "open -n ~/$GUEST_APP --args request-permissions"
  sleep 2
  gssh 'open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"'
  print "base is up at $IP; grant CURuntime in Accessibility and Screen Recording (see this script's header), then run: $0 finish"
  ;;
finish)
  IP=$("$TART" ip "$BASE")
  # A base with QQ (cu-base-qq: QQ starts at every login) is finished by vm-qq-base.sh, which quits QQ and waits for it
  # first; a shutdown with QQ still running may lose the test account's login. Checked before anything is changed.
  if [[ $(gssh '[ -d ~/Applications/QQ.app ] || pgrep -x QQ >/dev/null && echo has-qq || echo no-qq') == has-qq ]]; then
    print "$BASE has QQ: finish it with CU_BASE=$BASE scripts/vm-qq-base.sh finish (the same self-check; it quits QQ"
    print "first, which keeps the test account's login). Nothing changed; the base is still running at $IP"
    exit 1
  fi
  # Shut down only a base whose grants take effect: else it stays up for step 3's fix by hand.
  result=$(self_check); print -r -- "$result"
  python3 -c 'import json,sys; r=json.loads(sys.argv[1]); sys.exit(0 if r["ax_trusted"] and r["sck"]["ok"] else 1)' "$result" \
    || { print "self-check FAILED: base left running at $IP; fix the CURuntime rows (step 3 in $0), then rerun finish"; exit 1; }
  gssh "pkill -x cu-runtime; rm -rf ~/Library/Application\ Support/cu-runtime; true"
  gssh "echo $GUEST_PASS | sudo -S shutdown -h now" || true  # ssh drops when the guest goes down
  for i in {1..60}; do "$TART" list | grep -q "^local *$BASE .*stopped" && break; sleep 2; done
  "$TART" list | grep -q "^local *$BASE .*stopped" || { print "$BASE did not stop; check it"; exit 1; }
  print "$BASE stopped"
  ;;
*)
  print "usage: $0 prepare|finish"; exit 2 ;;
esac
