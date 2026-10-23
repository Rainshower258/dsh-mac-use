#!/usr/bin/env python3
"""Checkpointing for E2E runs: a run interrupted mid-way (clone destroyed, host rebooted, session gone) loses no
finished job and re-runs no finished job.

    python3 bench/checkpoint.py status bench/runs/<id>           # planned / done / left, from manifest + result.json
    python3 bench/checkpoint.py prepare-resume bench/runs/<id>   # set unfinished job dirs aside before a resume

How (bench/vm/run_vm.sh + run_e2e.py):
  * run_e2e.py writes manifest.json (every planned job, which are done) at start and after every job;
  * run_vm.sh copies the run directory back to the host after every finished job, not only at the end;
  * `run_vm.sh --resume` pushes the host's copy into the new clone; run_e2e.py skips jobs that have result.json.

A job is done iff its directory holds result.json (written last, after stdout/stderr/audit). A job directory without
one was interrupted: its partial files (session log, audit slice) would mix into the re-run, so it is renamed to
<dir>.partial-<time> (kept as a record, never deleted; the scorer only reads directories holding result.json).
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

MANIFEST = 'manifest.json'


def job_dir(run_root: Path, task: str, mode: str, k: int) -> Path:
    return run_root / task / mode / f'k{k}'


def is_done(d: Path) -> bool:
    return (d / 'result.json').is_file()


def _atomic_write(p: Path, text: str) -> None:
    tmp = p.with_name(p.name + '.tmp')
    tmp.write_text(text)
    os.replace(tmp, p)


def write_manifest(run_root: Path, jobs: list[tuple[str, str, int]], attempt: dict | None = None) -> dict:
    """jobs: (task, mode, k) in run order. Done-ness is read from the job directories, so the manifest can never
    claim a job whose result is missing. `attempt` (once per run_e2e start) is appended to the attempt history."""
    rows = [{'task': t, 'mode': m, 'k': k, 'done': is_done(job_dir(run_root, t, m, k))} for t, m, k in jobs]
    attempts = (read_manifest(run_root) or {}).get('attempts', [])
    if attempt is not None:
        attempts = [*attempts, attempt]
    man = {'planned': len(rows), 'done': sum(r['done'] for r in rows), 'jobs': rows,
           'updated': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'attempts': attempts}
    _atomic_write(run_root / MANIFEST, json.dumps(man, ensure_ascii=False, indent=2))
    return man


def read_manifest(run_root: Path) -> dict | None:
    p = run_root / MANIFEST
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return None


def job_dirs(run_root: Path) -> list[Path]:
    """Directories shaped <task>/<mode>/k<n> (the only places jobs write)."""
    return sorted(d for d in run_root.glob('T*/*/k*') if d.is_dir() and d.name[1:].isdigit())


def set_aside_partial(run_root: Path, stamp: str | None = None) -> list[Path]:
    stamp = stamp or time.strftime('%Y%m%d-%H%M%S')
    moved = []
    for d in job_dirs(run_root):
        if not is_done(d):
            dest = d.with_name(f'{d.name}.partial-{stamp}')
            d.rename(dest)
            moved.append(dest)
    return moved


def status(run_root: Path) -> str:
    man = read_manifest(run_root)
    if man is None:
        return f'{run_root.name}: no manifest; {sum(is_done(d) for d in job_dirs(run_root))} jobs done'
    done = sum(is_done(job_dir(run_root, j['task'], j['mode'], j['k'])) for j in man['jobs'])
    left = man['planned'] - done
    return f'{run_root.name}: {done}/{man["planned"]} done, {left} left' + (' (complete)' if left == 0 else '')


def main(argv: list[str]) -> None:
    if len(argv) < 2 or argv[0] not in ('status', 'prepare-resume'):
        raise SystemExit(__doc__)
    for arg in argv[1:]:
        root = Path(arg)
        if argv[0] == 'status':
            print(status(root))
        else:
            for d in set_aside_partial(root):
                print(f'set aside unfinished job: {d}')
            print(status(root))


if __name__ == '__main__':
    main(sys.argv[1:])
