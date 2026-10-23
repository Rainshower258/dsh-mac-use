#!/usr/bin/env python3
"""Keep the records of a run when its directory goes (root cause 6 of docs/incidents/2026-09-29-host-model-run.md:
the session log was deleted with the run directory, so the model's commands could not be recovered).

    python3 bench/records.py archive bench/runs/<id>     # copy the run into bench/archive/<id>/ (gitignored)
    python3 bench/records.py clean bench/runs/<id> ...   # archive, then delete the run directory
    python3 bench/records.py prune                       # drop archives older than 30 days

A run directory holds everything needed to reconstruct it: dsh's uncompressed session JSONL (every tool call with
its arguments), the per-job and the guest daemon's full audit logs, prompts, answers, stdout/stderr and the run's
dsh home. bench/vm/run_vm.sh archives each E2E run as soon as its results are back on the host. Delete run
directories with `clean`, never with rm.
"""
from __future__ import annotations

import shutil
import sys
import time
from pathlib import Path

BENCH = Path(__file__).resolve().parent
ARCHIVE = BENCH / 'archive'
KEEP_DAYS = 30
STAMP = '.archived-at'


def archive(run_dir: Path, root: Path = ARCHIVE) -> Path:
    run_dir = run_dir.resolve()
    if not run_dir.is_dir():
        raise SystemExit(f'no such run directory: {run_dir}')
    dest = root / run_dir.name
    root.mkdir(mode=0o700, exist_ok=True)
    # Merge into an existing archive of the same run (a resumed run adds jobs; nothing archived is removed).
    shutil.copytree(run_dir, dest, symlinks=True, dirs_exist_ok=True)
    (dest / STAMP).write_text(time.strftime('%Y-%m-%dT%H:%M:%S%z'))
    prune(root)
    return dest


def prune(root: Path = ARCHIVE, keep_days: int = KEEP_DAYS, now: float | None = None) -> list[Path]:
    cutoff = (now if now is not None else time.time()) - keep_days * 86400
    gone = []
    for d in sorted(root.glob('*')) if root.is_dir() else []:
        stamp = d / STAMP
        if d.is_dir() and stamp.exists() and stamp.stat().st_mtime < cutoff:
            shutil.rmtree(d)
            gone.append(d)
    return gone


def clean(run_dir: Path, root: Path = ARCHIVE) -> Path:
    dest = archive(run_dir, root)
    shutil.rmtree(run_dir)
    return dest


def main(argv: list[str]) -> None:
    if not argv or argv[0] not in ('archive', 'clean', 'prune'):
        raise SystemExit(__doc__)
    if argv[0] == 'prune':
        for d in prune():
            print(f'pruned {d}')
        return
    for arg in argv[1:]:
        dest = (archive if argv[0] == 'archive' else clean)(Path(arg))
        print(f'{argv[0]}: {arg} -> {dest}')


if __name__ == '__main__':
    main(sys.argv[1:])
