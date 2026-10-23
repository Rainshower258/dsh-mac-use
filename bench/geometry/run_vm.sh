#!/bin/zsh
# Geometry suite (bench/geometry/collect.py) in throwaway cu-base clones, one per display configuration.
#   bench/geometry/run_vm.sh                     all configs, all scenarios
#   ONLY="pos-center occlusion" CONFIGS=hidpi bench/geometry/run_vm.sh
# Results (numbers only) and overlays for failures: bench/runs/geometry-<ts>/<config>/ (gitignored), plus the full
# runner output (clone, boot, deploy, collect) in <config>/runner.log.
# Exit status is non-zero unless every config produced results and every scenario passed (report.py): a VM that
# never booted is a failure, never "0 failures".
set -uo pipefail
ROOT=${0:A:h:h:h}
source "$ROOT/scripts/vm-lib.sh"
GB='dsh-cu-ocr/dsh-computer-use/bench'
PY='$HOME/.local/python/bin/python3'
OUT=$ROOT/bench/runs/geometry-$(date +%Y%m%d-%H%M%S)
typeset -A DISPLAYS=(hidpi 1440x900pt 1x 1440x900px)
CONFIGS=(${=CONFIGS:-hidpi 1x})

"$TART" list | grep -q "^local *$BASE .*stopped" || { print "$BASE must exist and be stopped"; exit 1; }
require_bench_app || exit 1   # config_grants and debug_native_images in the clone's config.json: a bench build only
mkdir -p "$OUT"

body() {
  local cfg=$1 name=$2
  "$TART" set "$name" --display "${DISPLAYS[$cfg]}"
  # GRAPHICS=1: show the VM window (someone watching the run); default stays headless.
  local gfx=(--no-graphics)
  [[ ${GRAPHICS:-} == 1 ]] && gfx=()
  boot_vm "$name" $gfx
  deploy_app
  # Test-only config: native composites may leave the daemon. Lives only in this throwaway clone.
  gssh 'd="$HOME/Library/Application Support/cu-runtime"; mkdir -p -m 700 "$d"; chmod 700 "$d";
        printf "{\"debug_native_images\": true, \"config_grants\": true}" > "$d/config.json"; chmod 600 "$d/config.json"'
  grsync --exclude __pycache__/ "$ROOT/bench/experiments" "$ROOT/bench/geometry" "$ROOT/bench/vmguard.py" "$ROOT/bench/sysalert.py" "$GUEST_USER@$IP:$GB/"
  grsync --exclude node_modules/ --exclude dist/ "$ROOT/bench/fixture-app/" "$GUEST_USER@$IP:$GB/fixture-app/"
  gssh "open -n ~/$GUEST_APP --args serve"
  gssh 'for i in $(seq 40); do [ -S ~/Library/Application\ Support/cu-runtime/daemon.sock ] && exit 0; sleep 0.25; done; exit 1'
  # collect.py exits 0 when scenarios fail (they are in results.json); non-zero means it crashed.
  local rc=0
  gssh "LEAK_SELFTEST=${LEAK_SELFTEST:-0} OVERLAYS=${OVERLAYS:-} $PY $GB/geometry/collect.py --out ~/geom-out/$cfg --config-name $cfg ${ONLY:+--only $ONLY}" || rc=$?
  print "collect.py exit status: $rc"
  print $rc > "$OUT/$cfg/collect.rc"
  # 3: a system prompt was in front before anything acted. What it was, from the guest's log (no screenshot: that
  # needs a screen-recording grant, i.e. another prompt).
  (( rc == 3 )) && gssh "echo $GUEST_PASS | sudo -S -p '' /usr/bin/log show --last 10m --style compact --predicate \
      'process == \"UserNotificationCenter\" OR eventMessage CONTAINS[c] \"CFUserNotification\" OR eventMessage CONTAINS[c] \"UserNotificationCenter\"'" \
      > "$OUT/$cfg/system-prompt.log" 2>&1
  grsync "$GUEST_USER@${IP}:geom-out/$cfg/" "$OUT/$cfg/"
}

runner_failed=()
for cfg in $CONFIGS; do
  print "=== config $cfg (${DISPLAYS[$cfg]})"
  clone="geom-$cfg-$(date +%H%M%S)"
  mkdir -p "$OUT/$cfg"
  VM_LOG="$OUT/$cfg/runner.log" with_clone "$clone" body "$cfg" "$clone" 2>&1 | tee -a "$OUT/$cfg/runner.log"
  rc=${pipestatus[1]}
  if (( rc != 0 )); then
    print "=== config $cfg: runner failed (exit $rc), see $OUT/$cfg/runner.log"
    runner_failed+=($cfg)
  fi
done
python3 "$ROOT/bench/geometry/report.py" "$OUT" $CONFIGS
report_rc=$?
print "report: $OUT/summary.md"
(( ${#runner_failed} == 0 && report_rc == 0 )) || { print "FAILED (runner: ${runner_failed:-none}; report exit $report_rc)"; exit 1; }
