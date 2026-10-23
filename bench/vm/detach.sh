#!/bin/zsh
# Start a long bench batch detached from the terminal or agent session that launched it: a tmux session NAME, the
# Mac kept from idle sleep by caffeinate (a closed lid on battery still sleeps it). Output goes to the session and
# to bench/runs/detached-NAME.log, ending with "[exit <rc> <time>]".
#   bench/vm/detach.sh r5p2-a zsh bench/vm/r5_phase2.sh B1 B3
# Watch: tmux attach -t NAME (leave with ctrl-b d) or tail the log. An interrupted batch is resumed by running the
# same command again (bench/vm/r5_phase2.sh resumes each arm's run; bench/checkpoint.py).
set -euo pipefail
NAME=$1; shift
ROOT=${0:A:h:h:h}
LOGF=$ROOT/bench/runs/detached-$NAME.log
tmux has-session -t "=$NAME" 2>/dev/null && { print -u2 "tmux session $NAME already exists"; exit 1; }
mkdir -p "${LOGF:h}"
print -r -- "[start $(date '+%F %T')] $*" >>"$LOGF"
# Several args after the options: tmux runs them as argv (no shell re-parsing of the batch command).
tmux new-session -d -s "$NAME" -c "$ROOT" zsh -c \
  'logf=$1; shift; caffeinate -i "$@" 2>&1 | tee -a "$logf"; print -r -- "[exit ${pipestatus[1]} $(date "+%F %T")]" >>"$logf"' \
  zsh "$LOGF" "$@"
print "started tmux session $NAME; log $LOGF"
