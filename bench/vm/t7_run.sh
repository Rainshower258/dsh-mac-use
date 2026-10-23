#!/bin/zsh
# T7 (QQ in the VM, read only): the given arms one after another IN ONE CLONE (run_vm.sh ARMS mode), all three T7
# tasks, k=3, run ids t7-<arm>. One clone because QQ renews its login on every auto-login: the base's login works for
# exactly one clone, so log the test account in again in the base (bench/vm/qq/README.md) right before this.
# T7's base is cu-base-qq (cu-base never has QQ).
#   bench/vm/detach.sh t7 zsh bench/vm/t7_run.sh B1 B2 B3
set -uo pipefail
ROOT=${0:A:h:h:h}
cd "$ROOT"
CU_BASE=${CU_BASE:-cu-base-qq} ARMS="$*" RUN_ID=${T7_RUN_ID:-t7} PARALLEL_VMS=1 zsh bench/vm/run_vm.sh --tasks T7-qq-latest,T7-qq-order,T7-qq-code -k 3
