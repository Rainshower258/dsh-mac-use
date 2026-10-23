#!/bin/zsh
# Run a guest-side experiment from bench/experiments in a throwaway cu-base clone.
#   bench/experiments/run_vm_experiment.sh ocr_cache.py [--reps 15]
#   CONFIG=1x bench/experiments/run_vm_experiment.sh ocr_cache.py
# The script gets --out; its output dir comes back to bench/runs/<name>-<ts>/ (gitignored) with runner.log.
# Exit status is non-zero if the runner failed or the script failed or wrote no results.json.
set -uo pipefail
ROOT=${0:A:h:h:h}
source "$ROOT/scripts/vm-lib.sh"
SCRIPT=$1; shift
ARGS=("$@")
GB='dsh-cu-ocr/dsh-computer-use/bench'
PY='$HOME/.local/python/bin/python3'
typeset -A DISPLAYS=(hidpi 1440x900pt 1x 1440x900px)
CONFIG=${CONFIG:-hidpi}
OUT=$ROOT/bench/runs/${SCRIPT:r}-$CONFIG-$(date +%Y%m%d-%H%M%S)

[[ -f "$ROOT/bench/experiments/$SCRIPT" ]] || { print "no such experiment: $SCRIPT"; exit 1; }
"$TART" list | grep -q "^local *$BASE .*stopped" || { print "$BASE must exist and be stopped"; exit 1; }
require_bench_app || exit 1   # config_grants and DAEMON_CONFIG's debug switches need a bench build
mkdir -p "$OUT"
"$ROOT/bench/tools/build-tools.sh"   # tools/bin is gitignored: a fresh clone has none

body() {
  local name=$1
  "$TART" set "$name" --display "${DISPLAYS[$CONFIG]}"
  boot_vm "$name" --no-graphics
  deploy_app
  # Test-only daemon config (e.g. DAEMON_CONFIG='{"debug_activation": true}'): lives only in this throwaway clone.
  # config_grants: the experiments grant up front with grants.set, which the daemon refuses unless its config says so.
  python3 -c 'import json,os; c=json.loads(os.environ.get("DAEMON_CONFIG") or "{}"); c.setdefault("config_grants", True); print(json.dumps(c))' | gssh 'd="$HOME/Library/Application Support/cu-runtime"; mkdir -p -m 700 "$d";
        chmod 700 "$d"; cat > "$d/config.json"; chmod 600 "$d/config.json"'
  grsync --exclude __pycache__/ "$ROOT/bench/experiments" "$ROOT/bench/geometry" "$ROOT/bench/fixtures" "$GUEST_USER@$IP:$GB/"
  # The E2E runner/scorer modules too (plugin_smoke.py checks the bench's audit counter with them).
  grsync "$ROOT"/bench/*.py "$ROOT/bench/dsh-profile" "$GUEST_USER@$IP:$GB/"
  grsync "$ROOT/bench/tools/bin/" "$GUEST_USER@$IP:$GB/tools/bin/"
  # The plugin (compiled lib) next to bench/, as in the repo: bench/experiments/plugin_smoke.mjs imports ../../plugin.
  grsync --exclude node_modules/ "$ROOT/plugin/" "$GUEST_USER@$IP:${GB:h}/plugin/"
  gssh "zsh ${GB:h}/plugin/scripts/link-deps.sh"
  grsync --exclude node_modules/ --exclude dist/ "$ROOT/bench/fixture-app/" "$GUEST_USER@$IP:$GB/fixture-app/"
  # EXTRA_SYNC="host_path:guest_path …": more files for this clone only (e.g. 86Box.app and a VM folder for T6 probes).
  for pair in ${=EXTRA_SYNC:-}; do
    gssh "mkdir -p ${pair#*:}"
    grsync "${pair%%:*}/" "$GUEST_USER@$IP:${pair#*:}/"
  done
  gssh "open -n ~/$GUEST_APP --args serve"
  gssh 'for i in $(seq 40); do [ -S ~/Library/Application\ Support/cu-runtime/daemon.sock ] && exit 0; sleep 0.25; done; exit 1'
  local rc=0
  gssh "$PY $GB/experiments/$SCRIPT --out ~/exp-out ${(q)ARGS[@]}" || rc=$?
  print "$SCRIPT exit status: $rc"
  grsync "$GUEST_USER@${IP}:exp-out/" "$OUT/"
  return $rc
}

clone="exp-$(date +%H%M%S)"
VM_LOG="$OUT/runner.log" with_clone "$clone" body "$clone" 2>&1 | tee -a "$OUT/runner.log"
rc=${pipestatus[1]}
[[ -f "$OUT/results.json" ]] || { print "FAILED: no results.json (runner exit $rc), see $OUT/runner.log"; exit 1; }
(( rc == 0 )) || { print "FAILED: exit $rc, see $OUT/runner.log"; exit 1; }
print "results: $OUT/results.json"
