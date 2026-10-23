#!/bin/zsh
# Run bench/run_e2e.py inside a throwaway clone of the cu-base Tart VM.
#   bench/vm/run_vm.sh --arm A1 --tasks T2-keystring-order --modes canvas -k 1
#   RUN_ID=<id> bench/vm/run_vm.sh --resume <same args as the first attempt>
# All other args go to run_e2e.py. Results land in bench/runs/<run-id>/ on the host.
# PARALLEL_VMS=2 when another clone runs at the same time: recorded, and score.md then says its wall times are not
# latency data (the VMs share the host's CPU and memory; R5 measures latency with one VM only).
# The daemon .app is NOT synced: its TCC grant in cu-base is bound to its signature.
#
# Checkpointing (bench/checkpoint.py): the run directory comes back to the host after every finished job, so an
# interrupted run (clone destroyed, host rebooted, session gone) keeps every finished job. `--resume` pushes it into
# a new clone and run_e2e.py skips the jobs that have result.json. Without --resume a run id that already has
# finished jobs is refused (a fresh clone would re-run them and the copy-back would overwrite the results).
# A resume is refused unless the code, the daemon binary and the arguments are those of the first attempt.
# Run long batches detached from any terminal or agent session (tmux; see bench/vm/detach.sh).
set -uo pipefail   # no errexit out here: with_clone runs the body with errexit and always destroys the clone

ROOT=${0:A:h:h:h}
source "$ROOT/scripts/vm-lib.sh"
# Legacy upstream fork: still supplies the A0/A1 plugin. The guest keeps its original layout.
LEGACY=${DSH_CU_LEGACY:-${ROOT:h}/dsh-computer-use}
GUEST_ROOT=dsh-cu-ocr/dsh-computer-use
RESUME=0
ARGS=()
for a in "$@"; do [[ $a == --resume ]] && RESUME=1 || ARGS+=("$a"); done
if (( RESUME )) && [[ -z ${RUN_ID:-} ]]; then print -u2 "--resume needs RUN_ID"; exit 2; fi
RUN_ID=${RUN_ID:-$(date +%Y%m%d-%H%M%S)-vm}
# ARMS="B1 B2 B3": several arms one after another in ONE clone, run ids <RUN_ID>-<arm>. For an app whose login is
# consumed per clone (T7: QQ renews its login token on every auto-login, so the base's copy works for one clone
# only). No --resume in this mode (an interrupted batch needs a fresh login in the base anyway).
ARM_LIST=(${=ARMS:-})
if (( ${#ARM_LIST} )); then
  (( RESUME )) && { print -u2 "ARMS mode has no --resume"; exit 2; }
  [[ ${ARGS[(Ie)--arm]} == 0 ]] || { print -u2 "ARMS mode: give the arms in ARMS, not --arm"; exit 2; }
  PREFIX=$RUN_ID
  for a in $ARM_LIST; do
    [[ -z $(find "$ROOT/bench/runs/$PREFIX-$a" -name result.json -print -quit 2>/dev/null) ]] \
      || { print -u2 "refused: bench/runs/$PREFIX-$a already has finished jobs; pick a new RUN_ID"; exit 1; }
  done
  RUN_ID=$PREFIX-${ARM_LIST[1]}
fi
RUN_DIR=$ROOT/bench/runs/$RUN_ID
# One clone name per attempt: a clone leaked by a hard stop (reboot) must not block the resume.
CLONE=run-$RUN_ID-$(date +%H%M%S)
LOG=$RUN_DIR/vm.log
require_bench_app || exit 1
APP_SHA=$(shasum -a 256 "$BENCH_APP/Contents/MacOS/cu-runtime" | cut -d' ' -f1)
# What a resume must match. Docs and Markdown may change in between; nothing else may.
CODE_PATHS=(. ':(exclude)docs' ':(exclude)*.md')

mkdir -p "$RUN_DIR"
log() { print -r -- "[$(date +%T)] $*" | tee -a "$LOG" }

"$TART" list | grep -q "^local *$BASE .*stopped" || { log "$BASE must exist and be stopped"; exit 1; }

if (( RESUME )); then
  [[ -f $RUN_DIR/vm.json && -f $RUN_DIR/manifest.json ]] || { log "resume refused: $RUN_DIR has no vm.json/manifest.json"; exit 1; }
  if ! python3 - "$RUN_DIR/vm.json" "$APP_SHA" "${ARGS[@]}" <<'EOF'
import json, sys
vm = json.load(open(sys.argv[1]))
args = sys.argv[3:]
bad = [k for k, now in (('app_sha256', sys.argv[2]), ('args', args)) if vm.get(k) != now]
if vm.get('host_git_dirty'):
    bad.append('host_git_dirty (first attempt ran on uncommitted code)')
sys.exit(f'resume refused: differs from the first attempt: {bad}' if bad else 0)
EOF
  then log "resume refused (see above)"; exit 1; fi
  FIRST=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['host_git_commit'])" "$RUN_DIR/vm.json")
  if ! git -C "$ROOT" diff --quiet "$FIRST" -- "${CODE_PATHS[@]}"; then
    log "resume refused: code changed since the first attempt ($FIRST): git diff $FIRST -- ${CODE_PATHS[*]}"; exit 1
  fi
  if python3 "$ROOT/bench/checkpoint.py" status "$RUN_DIR" | grep -q '(complete)'; then
    log "nothing to resume: $(python3 "$ROOT/bench/checkpoint.py" status "$RUN_DIR")"; exit 0
  fi
  # Clones of earlier attempts of this run that a hard stop left behind (they count toward the 2-VM limit).
  for old in $("$TART" list | awk -v p="run-$RUN_ID-" 'index($2, p) == 1 {print $2}'); do
    log "removing clone $old left by an earlier attempt"; destroy_vm "$old"
  done
  python3 "$ROOT/bench/checkpoint.py" prepare-resume "$RUN_DIR" | tee -a "$LOG"
elif [[ -n $(find "$RUN_DIR" -name result.json -print -quit) ]]; then
  log "refused: $RUN_DIR already has finished jobs; resume with --resume or pick a new RUN_ID"; exit 1
fi

# Everything finished in the guest so far, back to the host. Never --delete: the host copy is the record.
sync_back() {
  grsync "$GUEST_USER@$IP:$GUEST_ROOT/bench/runs/$RUN_ID/" "$RUN_DIR/" || log "WARNING: copy-back failed (retried at the next job)"
  # The guest daemon's whole audit log (not only the per-job slices); one folder per attempt, so a resumed attempt
  # does not overwrite an earlier one's same-day file.
  grsync "$GUEST_USER@$IP:Library/Application\\ Support/cu-runtime/audit/" "$RUN_DIR/guest-audit/$CLONE/" \
    || log "WARNING: could not copy the guest audit log"
}

body() {
  log "boot $CLONE; waiting for ssh and the auto-login GUI session"
  boot_vm "$CLONE" --no-graphics
  log "ip $IP; sync bench + plugin code"
  grsync --delete --exclude runs/ --exclude results/ --exclude archive/ --exclude __pycache__/ --exclude .DS_Store \
    --exclude fixture-app/node_modules/ --exclude fixture-app/dist/ \
    "$ROOT/bench/" "$GUEST_USER@$IP:$GUEST_ROOT/bench/"
  grsync --delete --exclude node_modules/ "$LEGACY/packages/" "$GUEST_USER@$IP:$GUEST_ROOT/packages/"
  # cu-runtime arms: the current daemon build (same signing identity, so the base's TCC grant still applies) and
  # the plugin next to bench/ with the reference plugin's dsh packages linked in.
  deploy_app
  # (run_e2e.py resolves the plugin as <bench>/../plugin, so it goes next to the guest's bench/.)
  grsync --delete --exclude node_modules/ "$ROOT/plugin/" "$GUEST_USER@$IP:$GUEST_ROOT/plugin/"
  gssh "zsh $GUEST_ROOT/plugin/scripts/link-deps.sh"
  # The bench dsh profile reads its key only from a guest-only file under a bench-only name (fail closed on the host;
  # docs/incidents/2026-09-29-host-model-run.md). Moved in this clone only; the value never leaves the guest.
  gssh "\$HOME/.local/python/bin/python3 $GUEST_ROOT/bench/vm/guest_key.py"
  # The daemon refuses grants.set unless its config turns it on (config_grants; daily use approves by dialog only).
  # The bench grants its fixture and apps up front: on, in this throwaway clone only, merged into any config there.
  gssh 'd="$HOME/Library/Application Support/cu-runtime"; mkdir -p -m 700 "$d"; f="$d/config.json"
        $HOME/.local/python/bin/python3 -c "import json,os,sys; f=sys.argv[1]; c=json.load(open(f)) if os.path.exists(f) else {}; c[\"config_grants\"]=True; open(f,\"w\").write(json.dumps(c))" "$f"; chmod 600 "$f"'

  if (( RESUME )); then
    log "resume: push the finished jobs ($(python3 "$ROOT/bench/checkpoint.py" status "$RUN_DIR"))"
    gssh "mkdir -p $GUEST_ROOT/bench/runs/$RUN_ID"
    grsync --exclude vm.log --exclude 'vm*.json' --exclude guest-audit/ --exclude '*.partial-*' \
      "$RUN_DIR/" "$GUEST_USER@$IP:$GUEST_ROOT/bench/runs/$RUN_ID/"
  fi

  if (( ${#ARM_LIST} )); then
    local a rc_all=0
    for a in $ARM_LIST; do
      RUN_ID=$PREFIX-$a; RUN_DIR=$ROOT/bench/runs/$RUN_ID; LOG=$RUN_DIR/vm.log; mkdir -p "$RUN_DIR"
      run_one --arm "$a" "${ARGS[@]}" || rc_all=$?
    done
    return $rc_all
  fi
  run_one "${ARGS[@]}"
}

# One run_e2e.py run in the clone, results copied back and archived ($RUN_ID / $RUN_DIR are the run's).
run_one() {
  local -a ARGS=("$@")
  # vm.json belongs to the first attempt (a resume is checked against it); every attempt also gets its own file.
  local vm_attempt=$RUN_DIR/vm-$CLONE.json
  python3 - "$vm_attempt" "${ARGS[@]}" <<EOF
import json, sys
json.dump({"clone": "$CLONE", "base": "$BASE", "parallel_vms": ${PARALLEL_VMS:-1}, "resume": bool($RESUME),
           "host_git_commit": "$(git -C "$ROOT" rev-parse HEAD)",
           "host_git_dirty": $([[ -n "$(git -C "$ROOT" status --porcelain -- "${CODE_PATHS[@]}")" ]] && echo True || echo False),
           "legacy_git_commit": "$(git -C "$LEGACY" rev-parse HEAD)",
           "app_sha256": "$APP_SHA", "args": sys.argv[2:]},
          open(sys.argv[1], 'w'), indent=1)
EOF
  [[ -f $RUN_DIR/vm.json ]] || cp "$vm_attempt" "$RUN_DIR/vm.json"

  log "run_e2e.py ${ARGS[*]} (run-id $RUN_ID)"
  local rc=0 line
  gssh "export PATH=\$HOME/.local/python/bin:\$HOME/.local/node/bin:\$PATH DSH_CU_LEGACY=\$HOME/$GUEST_ROOT; cd $GUEST_ROOT && \
    python3 bench/run_e2e.py --run-id $RUN_ID --daemon-app 'dist/DSH Computer Use.app' ${(q)ARGS[@]}" 2>&1 \
    | while IFS= read -r line; do
        print -r -- "$line"; print -r -- "$line" >>"$LOG"
        # run_e2e.py prints "[n/N] ..." right after a job's result.json is written.
        if [[ $line =~ '^\[[0-9]+/[0-9]+\] ' ]]; then sync_back; fi
      done \
    || rc=${pipestatus[1]}

  log "copy results back"
  sync_back
  # The guest has no git; score_e2e.py reads the commit from env.json.
  python3 - "$RUN_DIR" <<'EOF'
import json, sys, pathlib
d = pathlib.Path(sys.argv[1]); env_p = d / 'env.json'
if env_p.exists():
    env, vm = json.loads(env_p.read_text()), json.loads((d / 'vm.json').read_text())
    env.update(git_commit=vm['host_git_commit'], git_dirty=vm['host_git_dirty'],
               legacy_git_commit=vm['legacy_git_commit'], vm=vm,
               vm_attempts=sorted(p.name for p in d.glob('vm-*.json')))
    env_p.write_text(json.dumps(env, ensure_ascii=False, indent=2))
EOF
  python3 "$ROOT/bench/checkpoint.py" status "$RUN_DIR" | tee -a "$LOG"
  # Records outlive the run directory (incident root cause 6): archived now, kept 30 days (bench/records.py).
  python3 "$ROOT/bench/records.py" archive "$RUN_DIR" | tee -a "$LOG" || { log "ARCHIVE FAILED"; rc=1; }
  log "done rc=$rc -> bench/runs/$RUN_ID"
  return $rc
}

log "clone $BASE -> $CLONE"
VM_LOG=$LOG with_clone "$CLONE" body
