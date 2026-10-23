#!/usr/bin/env python3
"""R5 phase 1 -> phase 2: which (task, mode) cells tell the arms apart.

    python3 bench/discriminate.py bench/runs/<phase-1 run> ... [--out bench/runs/r5-phase1-discrimination]

Reads each run's score.json (scoring it first if needed). A cell is discriminative when the arms' pass results differ
(k=1 in phase 1, so one differing arm is enough; phase 2's k=5 says whether that difference holds). Jobs excluded
from the accuracy (glyph_indistinct) do not count. Phase 2 = the discriminative cells for every arm, plus the
safety cells that always get k=5 (T9 and T12 on B0-axoff and B3). Writes discrimination.md and phase2.json.
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import score_e2e

SAFETY_TASKS = ['T9-injection', 'T12-a0-replay']
SAFETY_ARMS = ['B0-axoff', 'B3']


def load_jobs(run: Path) -> list[dict]:
    if not (run / 'score.json').exists():
        score_e2e.main(run.resolve())
    return json.loads((run / 'score.json').read_text())['jobs']


def cells(jobs: list[dict]) -> dict[tuple[str, str], dict[str, list[bool]]]:
    out: dict[tuple[str, str], dict[str, list[bool]]] = defaultdict(lambda: defaultdict(list))
    for j in jobs:
        if j.get('excluded'):
            continue
        out[(j['task'], j['mode'])][j['arm']].append(bool(j['pass']))
    return out


def discriminative(by_arm: dict[str, list[bool]]) -> bool:
    return len({round(sum(v) / len(v), 3) for v in by_arm.values() if v}) > 1


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('runs', nargs='+', type=Path)
    ap.add_argument('--out', type=Path, default=Path(__file__).resolve().parent / 'runs' / 'r5-phase1-discrimination')
    args = ap.parse_args()
    jobs = [j for r in args.runs for j in load_jobs(r)]
    table = cells(jobs)
    arms = sorted({j['arm'] for j in jobs})
    disc = sorted(c for c, by_arm in table.items() if discriminative(by_arm))
    safety = sorted(c for c in table if c[0] in SAFETY_TASKS)
    args.out.mkdir(parents=True, exist_ok=True)
    md = ['# R5 phase 1: discrimination', '', f'Runs: {", ".join(r.name for r in args.runs)}. Arms: {", ".join(arms)}.', '',
          f'{len(disc)} of {len(table)} cells discriminative.', '',
          '| task | mode | ' + ' | '.join(arms) + ' | discriminative |', '|---|---|' + '---|' * (len(arms) + 1)]
    for c in sorted(table):
        row = [('✅' if all(v) else '❌' if not any(v) else f'{sum(v)}/{len(v)}') if (v := table[c].get(a)) else '—' for a in arms]
        md.append(f'| {c[0]} | {c[1]} | ' + ' | '.join(row) + f' | {"**yes**" if c in disc else ""} |')
    plan = {'k': 5, 'discriminative_cells_all_arms': [list(c) for c in disc],
            'safety_cells': {'arms': SAFETY_ARMS, 'cells': [list(c) for c in safety]}}
    # Safety cells that are also discriminative already run on every arm.
    n2 = (len(disc) * len(arms) + len([c for c in safety if c not in disc]) * len(SAFETY_ARMS)) * 5
    md += ['', f'Phase 2 (k=5): {len(disc)} discriminative cells × {len(arms)} arms, plus safety cells '
           f'{[f"{t}/{m}" for t, m in safety]} on {SAFETY_ARMS} → about {n2} jobs.']
    (args.out / 'discrimination.md').write_text('\n'.join(md) + '\n')
    (args.out / 'phase2.json').write_text(json.dumps(plan, indent=2))
    print(args.out / 'discrimination.md')


if __name__ == '__main__':
    main()
