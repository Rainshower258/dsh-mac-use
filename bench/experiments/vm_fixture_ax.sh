#!/bin/zsh
# AXManualAccessibility experiment against the fixture (dom + canvas) inside a throwaway cu-base clone.
# Also yields VM-side Vision OCR latency (ocr_ms). Results (numbers only) land in bench/runs/.
set -uo pipefail
ROOT=${0:A:h:h:h}
source "$ROOT/scripts/vm-lib.sh"
REGION=${REGION:-0.27,0.12,1.0,0.81}   # fixture message area as fractions of its window
GB='dsh-cu-ocr/dsh-computer-use/bench'  # guest bench path (legacy layout, see bench/README.md)
C=axexp-$(date +%H%M%S)

"$TART" list | grep -q "^local *$BASE .*stopped" || { print "$BASE must exist and be stopped"; exit 1; }
require_bench_app || exit 1

body() {
boot_vm "$C" --no-graphics
deploy_app
grsync "$ROOT/bench/experiments" "$ROOT/bench/vmguard.py" "$GUEST_USER@$IP:$GB/"

gssh "open -n ~/$GUEST_APP --args serve"
gssh 'for i in $(seq 40); do [ -S ~/Library/Application\ Support/cu-runtime/daemon.sock ] && exit 0; sleep 0.25; done; exit 1'

for mode in dom canvas; do
  print "=== fixture $mode"
  gssh "cd $GB/fixture-app && (nohup ./fixture --mode $mode --conv c1 >/tmp/fx.log 2>&1 &) ; sleep 6"
  gssh "export PATH=\$HOME/.local/python/bin:\$PATH; python3 $GB/experiments/ax_manual_accessibility.py --app dev.dsh.bench.fixture --region $REGION --show-unmatched --show-geometry" \
    | python3 -c '
import json, sys
t = sys.stdin.read()
print("".join(l + "\n" for l in t.splitlines() if l.startswith(("  unmatched", "  geom"))), end="")
j = json.loads(t[t.index("{\n  \"experiment\""):t.rindex("}") + 1])
print("screen_changed:", j["screen_changed"])
for k, r in j["runs"].items():
    print(k, {x: r[x] for x in ("valid", "window_pt", "coverage", "covered", "denominator", "excluded_short", "ax_nodes", "ax_elements",
                               "ax_snapshot_ms", "hit_time_budget", "hit_node_cap", "electron_ax", "settle", "geometry", "uncovered_categories",
                               "ocr_ms", "capture_ms", "capture_error")})'
  gssh 'pkill -f DSHFixture.app; sleep 1'
done

mkdir -p "$ROOT/bench/runs"
grsync "$GUEST_USER@$IP:$GB/runs/" "$ROOT/bench/runs/"   # copy results back before any check can fail

print "=== audit: manual-accessibility changes (should alternate on/off)"
gssh 'grep -hF "\"method\":\"ax.manual_accessibility\"" ~/Library/Application\ Support/cu-runtime/audit/*.jsonl' \
  | python3 -c 'import json,sys; [print(e["app"], e["value"], "ok" if e["ok"] else "FAILED") for e in map(json.loads, sys.stdin)]'
gssh 'grep -c "\"text\"" ~/Library/Application\ Support/cu-runtime/audit/*.jsonl || true' | sed 's/^/audit lines containing a "text" key: /'
}
with_clone "$C" body
