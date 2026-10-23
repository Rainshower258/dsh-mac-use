#!/bin/sh
# bench/run_e2e.sh --arm A0 [--tasks T2-keystring-order,...] [-k 5] [--modes dom,canvas,image] [--manual]
# Thin wrapper; see run_e2e.py for details. Score afterwards with score_e2e.py.
exec python3 "$(cd "$(dirname "$0")" && pwd)/run_e2e.py" "$@"
