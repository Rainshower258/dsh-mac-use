#!/bin/zsh
# R5 phase 2 (lean plan, bench/r5/phase2-lean.json; another plan with R5_PLAN=…, e.g. bench/r5/latency.json): the
# given arms one after another, k from the plan, only each arm's cells, run id <plan run_prefix>-<arm>. Safe to run again after any interruption: an arm already complete is skipped,
# an arm with finished jobs is resumed (bench/checkpoint.py). Two streams in parallel, each in its own tmux session:
#   bench/vm/detach.sh r5p2-a zsh bench/vm/r5_phase2.sh B1 B3
#   bench/vm/detach.sh r5p2-b zsh bench/vm/r5_phase2.sh B2 B0-axon
set -uo pipefail
ROOT=${0:A:h:h:h}
PLAN=${R5_PLAN:-$ROOT/bench/r5/phase2-lean.json}
cd "$ROOT"
for arm in "$@"; do
  cells=$(python3 -c "import json,sys;print(','.join(json.load(open(sys.argv[1]))['per_arm_cells'][sys.argv[2]]))" "$PLAN" "$arm") \
    || { print "unknown arm $arm"; exit 2; }
  k=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['k'])" "$PLAN")
  prefix=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('run_prefix', 'r5-p2lean'))" "$PLAN")
  run_dir=bench/runs/$prefix-$arm
  resume=()
  [[ -f $run_dir/manifest.json ]] && resume=(--resume)
  print "[$(date +%T)] $arm ${resume[*]:-fresh}"
  PARALLEL_VMS=${PARALLEL_VMS:-2} RUN_ID=$prefix-$arm zsh bench/vm/run_vm.sh "${resume[@]}" --arm "$arm" --cells "$cells" -k "$k"
  rc=$?
  print "[$(date +%T)] $arm rc=$rc $(python3 bench/checkpoint.py status "$run_dir")"
done
