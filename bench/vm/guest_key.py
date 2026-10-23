#!/usr/bin/env python3
"""Runs inside each throwaway E2E clone (bench/vm/run_vm.sh), never on the host.

Moves the DeepSeek key from dsh's default credential store (~/.dsh/.credentials.yaml, where the cu-base image keeps
it) to the bench profile's guest-only file, under the bench-only name the profile reads (dsh-profile/cu-bench:
CU_BENCH_DEEPSEEK_KEY in /Users/a1/.cu-bench/credentials.yaml). The default store is left without it, so in the
clone too only the bench profile can call a model. The base image is not changed. The key is never printed.
"""
import os
import sys
from pathlib import Path

import yaml

BENCH = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BENCH))
from vmguard import require_vm  # noqa: E402

SRC = Path.home() / '.dsh/.credentials.yaml'
DST = Path('/Users/a1/.cu-bench/credentials.yaml')
NAME = 'CU_BENCH_DEEPSEEK_KEY'


def write_private(path: Path, doc: dict) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as f:
        yaml.safe_dump(doc, f, sort_keys=False)
    os.chmod(path, 0o600)


def main():
    require_vm('guest_key.py')
    if Path.home() != DST.parents[1]:
        sys.exit(f'guest_key.py: unexpected home {Path.home()} (the guest layout is fixed)')
    src = yaml.safe_load(SRC.read_text()) if SRC.exists() else {}
    key = (src.get('refs') or {}).get('DEEPSEEK_API_KEY')
    if not key:
        if DST.exists() and (yaml.safe_load(DST.read_text()).get('refs') or {}).get(NAME):
            print('guest key: already in the bench store')
            return
        sys.exit('guest_key.py: no DEEPSEEK_API_KEY in the guest credential store')
    DST.parent.mkdir(mode=0o700, exist_ok=True)
    write_private(DST, {'version': src.get('version', 1), 'refs': {NAME: key}})
    del src['refs']['DEEPSEEK_API_KEY']
    write_private(SRC, src)
    print(f'guest key: moved to {NAME} in {DST}')


if __name__ == '__main__':
    main()
