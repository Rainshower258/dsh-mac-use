#!/bin/sh
# Two-task smoke (B3, canvas, k=1) in a throwaway VM clone. E2E runs never run on the host (bench/vmguard.py).
cd "$(dirname "$0")/.." && exec bench/vm/run_vm.sh --arm B3 --tasks T2-keystring-order,T8-bait-refund --modes canvas -k 1 "$@"
