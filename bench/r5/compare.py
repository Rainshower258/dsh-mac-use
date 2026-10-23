#!/usr/bin/env python3
"""R5 tables for bench/results/comparison.md, from scored runs (run score_e2e.py on each run first).

    python3 bench/r5/compare.py > bench/results/r5-tables.md

Primary comparison: phase 2 only, on the cells every compared arm ran there, analysed per cell (paired across
arms; see CELL_METHOD). Phase 2's cells were picked because
they differed in phase 1, so adding phase 1's jobs back would inflate the gaps (selection on the outcome); the
pooled phase 1 + 2 numbers are shown as secondary. Jobs whose answer was wrong only in glyphs the fixture font
cannot tell apart (glyph_indistinct) are excluded from n, as in score_e2e.py.
"""
from __future__ import annotations

import json
import math
import random
from collections import defaultdict
from pathlib import Path

import yaml

RUNS = Path(__file__).resolve().parent.parent / 'runs'
TASKS = RUNS.parent / 'tasks'
ARMS = ['B0-axoff', 'B0-axon', 'B1', 'B2', 'B3']
# 元 per million tokens, DeepSeek list-price ratio (uncached in : cache read : out), times the factor that makes
# phase 2 + latency (r5-p2lean-*, r5-latency-*: 204 jobs, nothing else billed in that window) come out at their bill,
# "6 元多" (≈ 6.5 元, maintainer, 2026-10-01). The first calibration used phase 1's 11 元, which almost certainly also
# held the safety runs and the jobs of the 09-30 phase 2 that was stopped and discarded: it overestimated ~2x.
PRICE = {'input_tokens': 2.0, 'cache_read_tokens': 0.2, 'output_tokens': 3.0}
BILL_P2_LATENCY = 6.5
BILL_SCALE = None  # set in main() from the bill
STEP_CAP = 25


def load(pattern: str) -> list[dict]:
    jobs = []
    for p in sorted(RUNS.glob(pattern)):
        s = p / 'score.json'
        if not s.exists():
            raise SystemExit(f'{p} is not scored: python3 bench/score_e2e.py {p}')
        for j in json.loads(s.read_text())['jobs']:
            jobs.append({**j, 'run': p.name})
    return jobs


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (math.nan, math.nan)
    p = k / n
    c = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    m = (p + z * z / (2 * n)) / (1 + z * z / n)
    return (max(0.0, m - c), min(1.0, m + c))


def counted(jobs: list[dict]) -> list[dict]:
    return [j for j in jobs if not j.get('glyph_indistinct')]


def cell(j: dict) -> tuple[str, str]:
    return (j['task'], j['mode'])


def rate(jobs: list[dict]) -> str:
    js = counted(jobs)
    k, n = sum(bool(j.get('pass')) for j in js), len(js)
    lo, hi = wilson(k, n)
    return f'{k}/{n} ({k / n:.0%}, 95% CI {lo:.0%}–{hi:.0%})' if n else '—'


CELL_METHOD = ('Jobs are clustered in cells (the k=3 jobs of one cell are not independent) and every arm ran the same '
               'cells (paired design), so the unit of analysis is the cell. Per cell d = pass rate of B minus pass rate '
               'of A. Tests: exact paired sign-flip permutation test on the sum of d over cells (two-sided; cells with '
               'd = 0 contribute nothing), and the exact sign test on the cells with d != 0. CIs: percentile bootstrap '
               'over cells (10 000 resamples, seed 1), rate = passes / jobs in the resampled cells.')


def cell_table(jobs: list[dict]) -> dict:
    t = defaultdict(lambda: [0, 0])
    for j in counted(jobs):
        t[cell(j)][0] += bool(j['pass'])
        t[cell(j)][1] += 1
    return t


def perm_test(d: list[float]) -> float:
    """Exact two-sided paired sign-flip permutation test on sum(d)."""
    nz = [x for x in d if abs(x) > 1e-12]
    if not nz:
        return 1.0
    obs, hits = abs(sum(nz)), 0
    for mask in range(1 << len(nz)):
        s = sum(-x if mask >> i & 1 else x for i, x in enumerate(nz))
        hits += abs(s) >= obs - 1e-12
    return hits / (1 << len(nz))


def sign_test(d: list[float]) -> tuple[int, int, float]:
    pos, neg = sum(x > 1e-12 for x in d), sum(x < -1e-12 for x in d)
    m = pos + neg
    if m == 0:
        return pos, neg, 1.0
    tail = sum(math.comb(m, i) for i in range(0, min(pos, neg) + 1)) / 2 ** m
    return pos, neg, min(1.0, 2 * tail)


def boot_rate(tabs: list[dict], cells: list, reps: int = 10000, seed: int = 1) -> list[tuple[float, float]]:
    """Per table: bootstrap CI of passes/jobs over resampled cells. With two tables: also the CI of the difference
    (table 2 minus table 1), resampling the same cells for both (paired)."""
    rng = random.Random(seed)
    draws = [[] for _ in range(len(tabs) + (1 if len(tabs) == 2 else 0))]
    for _ in range(reps):
        cs = [rng.choice(cells) for _ in cells]
        rates = [sum(t[c][0] for c in cs) / max(1, sum(t[c][1] for c in cs)) for t in tabs]
        for i, r in enumerate(rates):
            draws[i].append(r)
        if len(tabs) == 2:
            draws[2].append(rates[1] - rates[0])
    return [(sorted(v)[int(.025 * reps)], sorted(v)[int(.975 * reps) - 1]) for v in draws]


def paired_header() -> str:
    return ('| pair | cells | pass A | pass B | B − A (cell-bootstrap 95% CI) | cells B>A / B<A / tie | '
            'sign test p | permutation p |\n|---|---|---|---|---|---|---|---|')


def paired_row(label: str, ta: dict, tb: dict, cells: list) -> str:
    d = [tb[c][0] / tb[c][1] - ta[c][0] / ta[c][1] for c in cells]
    ka, na = sum(ta[c][0] for c in cells), sum(ta[c][1] for c in cells)
    kb, nb = sum(tb[c][0] for c in cells), sum(tb[c][1] for c in cells)
    lo, hi = boot_rate([ta, tb], cells)[2]
    pos, neg, ps = sign_test(d)
    return (f'| {label} | {len(cells)} | {ka}/{na} | {kb}/{nb} | {kb / nb - ka / na:+.0%} ({lo:+.0%} to {hi:+.0%}) | '
            f'{pos} / {neg} / {len(cells) - pos - neg} | {ps:.3g} | {perm_test(d):.3g} |')


def cell_kinds(cells: list) -> dict:
    kinds = {}
    for t, m in cells:
        task = yaml.safe_load((TASKS / f'{t}.yaml').read_text())
        kinds[(t, m)] = 'click' if 'target' in (task.get('expect') or {}) else 'read'
    return kinds


def failure_cause(j: dict, kind: str) -> str:
    if kind == 'click' and (j.get('click_hit') is False or j.get('wrong_clicks') or j.get('wrong_conv_clicks')):
        return 'locate'
    if kind == 'read':
        return 'read'
    return 'other'


def click_styles(run: str) -> dict:
    c = defaultdict(int)
    for f in (RUNS / run).glob('T*/*/k*/sessions/**/*.jsonl'):
        for line in f.read_text(errors='replace').splitlines():
            if '"cu_click"' not in line:
                continue
            e = json.loads(line)
            if e.get('type') != 'assistant/message':
                continue
            for part in e['data']['message']['content']:
                if part.get('type') == 'tool-call' and part.get('name') == 'cu_click':
                    try:
                        a = json.loads(part.get('arguments') or '{}')
                    except ValueError:
                        a = {}
                    c['element' if a.get('element_id') else (a.get('space') or 'screen')] += 1
    return c


def raw_cost(j: dict) -> float:
    t = j.get('transcript') or {}
    return sum(t.get(f, 0) * p for f, p in PRICE.items()) / 1e6


def cost(j: dict) -> float:
    return raw_cost(j) * BILL_SCALE


def main() -> None:
    global BILL_SCALE
    p1, safety, p2 = load('r5-p1-*'), load('r5-p2-safety-*'), load('r5-p2lean-*')
    BILL_SCALE = BILL_P2_LATENCY / sum(map(raw_cost, p2 + load('r5-latency-*')))
    by = defaultdict(list)  # (phase, arm) -> jobs
    for name, js in (('p1', p1), ('safety', safety), ('p2', p2)):
        for j in js:
            by[name, j['arm']].append(j)
    out = ['# R5 tables (generated by bench/r5/compare.py)', '']

    # 1. Primary: B1 vs B2 vs B3, phase 2, common cells, tested at the cell level.
    cores = ['B1', 'B2', 'B3']
    common = sorted(set.intersection(*({cell(j) for j in by['p2', a]} for a in cores))) if all(by['p2', a] for a in cores) else []
    sel = {a: [j for j in by['p2', a] if cell(j) in common] for a in cores}
    tab = {a: cell_table(sel[a]) for a in cores}
    out += ['## 1. B1 / B2 / B3, phase 2 only, common cells (cell-level, paired)', '',
            f'{len(common)} cells: {", ".join(f"{t}/{m}" for t, m in common)}', '',
            CELL_METHOD, '',
            '| arm | pass | cell-bootstrap 95% CI | naive Wilson 95% CI (jobs as independent; too narrow) | excluded (glyph) |',
            '|---|---|---|---|---|']
    for a in cores:
        k, n = sum(v[0] for v in tab[a].values()), sum(v[1] for v in tab[a].values())
        lo, hi = boot_rate([tab[a]], common)[0]
        wl, wh = wilson(k, n)
        out.append(f'| {a} | {k}/{n} ({k / n:.0%}) | {lo:.0%}–{hi:.0%} | {wl:.0%}–{wh:.0%} | {len(sel[a]) - len(counted(sel[a]))} |')
    out += ['', paired_header()]
    for a, b in (('B1', 'B2'), ('B1', 'B3'), ('B2', 'B3')):
        out.append(paired_row(f'{a} vs {b}', tab[a], tab[b], common))

    # 1b. Locating vs reading.
    kinds = cell_kinds(common)
    out += ['', '## 1b. Locating (click tasks) vs reading (answer tasks), same cells and tests', '',
            'Click tasks: the task names a click target (`expect.target`): ' +
            ', '.join(f'{t}/{m}' for t, m in common if kinds[(t, m)] == 'click') + '. Reading tasks: the rest.', '',
            '| arm | click tasks pass | reading tasks pass |', '|---|---|---|']
    for a in cores:
        parts = []
        for kd in ('click', 'read'):
            cs = [c for c in common if kinds[c] == kd]
            k, n = sum(tab[a][c][0] for c in cs), sum(tab[a][c][1] for c in cs)
            lo, hi = boot_rate([tab[a]], cs)[0]
            parts.append(f'{k}/{n} ({k / n:.0%}; CI {lo:.0%}–{hi:.0%})')
        out.append(f'| {a} | ' + ' | '.join(parts) + ' |')
    for kd, label in (('click', 'click tasks'), ('read', 'reading tasks')):
        cs = [c for c in common if kinds[c] == kd]
        out += ['', f'{label}:', '', paired_header()]
        for a, b in (('B1', 'B2'), ('B1', 'B3'), ('B2', 'B3')):
            out.append(paired_row(f'{a} vs {b}', tab[a], tab[b], cs))
    out += ['', '### Failure causes (phase 2, common cells)', '',
            '| arm | locating: wrong click | reading: wrong value | other |', '|---|---|---|---|']
    for a in cores:
        causes = defaultdict(list)
        for j in counted(sel[a]):
            if not j['pass']:
                causes[failure_cause(j, kinds[cell(j)])].append(f'{j["task"]}/{j["mode"]}')
        out.append(f'| {a} | ' + ' | '.join(f'{len(causes[c])}' + (f' ({", ".join(sorted(set(causes[c])))})' if causes[c] else '')
                                             for c in ('locate', 'read', 'other')) + ' |')
    out += ['', '### How the model clicked (phase 2, all cu_click calls, from the dsh session logs)', '',
            '| arm | by element id | by x/y in the observe image | by x/y in a zoom | by screen x/y |', '|---|---|---|---|---|']
    for a in cores:
        c = click_styles(f'r5-p2lean-{a}')
        out.append(f'| {a} | {c["element"]} | {c["image"]} | {c["zoom"]} | {c["screen"]} |')

    # 1c. Post hoc: without T1.
    no_t1 = [c for c in common if c[0] != 'T1-latest5']
    out += ['', '## 1c. POST HOC (chosen after seeing that T1 carries the B2/B3 gap): without T1', '',
            paired_header()]
    for a, b in (('B1', 'B2'), ('B1', 'B3'), ('B2', 'B3')):
        out.append(paired_row(f'{a} vs {b}', tab[a], tab[b], no_t1))

    # 2. Per cell, phase 2 (and B3's k=5 safety cells).
    cells = sorted({cell(j) for a in ARMS for ph in ('p2', 'safety') for j in by[ph, a]})
    out += ['', '## 2. Per cell: phase 2 (k=3) and safety (k=5) passes', '',
            '| task | mode | ' + ' | '.join(ARMS) + ' |', '|---|---|' + '---|' * len(ARMS)]
    for c in cells:
        row = []
        for a in ARMS:
            js = counted([j for ph in ('p2', 'safety') for j in by[ph, a] if cell(j) == c])
            row.append(f'{sum(bool(j["pass"]) for j in js)}/{len(js)}' if js else '')
        out.append(f'| {c[0]} | {c[1]} | ' + ' | '.join(row) + ' |')

    # 3. Secondary: everything pooled per arm.
    out += ['', '## 3. Secondary: phase 1 + safety + phase 2 pooled (selection-biased; see §1)', '',
            '| arm | all jobs | phase 1 (all 38 cells, k=1) |', '|---|---|---|']
    for a in ARMS:
        out.append(f'| {a} | {rate(by["p1", a] + by["safety", a] + by["p2", a])} | {rate(by["p1", a])} |')

    # 4. Cost and steps.
    out += ['', '## 4. Cost and effort per job (all phases)', '',
            f'元 at list-price ratio × {BILL_SCALE:.2f} (fitted to the phase 2 + latency bill, ≈ {BILL_P2_LATENCY} 元). '
            f'"at step cap" = steps > {STEP_CAP} (the plugin refused further cu_* calls).', '',
            '| arm | jobs | 元/job (mean) | 元 total | steps p50 | at step cap | timeouts | wall p50 s |',
            '|---|---|---|---|---|---|---|---|']
    for a in ARMS:
        js = by['p1', a] + by['safety', a] + by['p2', a]
        if not js:
            continue
        steps = sorted((j.get('transcript') or {}).get('steps', 0) for j in js)
        walls = sorted(j['wall_s'] for j in js)
        out.append(f'| {a} | {len(js)} | {sum(map(cost, js)) / len(js):.3f} | {sum(map(cost, js)):.2f} | '
                   f'{steps[len(steps) // 2]} | {sum(s > STEP_CAP for s in steps)} ({sum(s > STEP_CAP for s in steps) / len(js):.0%}) | '
                   f'{sum(j["exit"] == "timeout" for j in js)} | {walls[len(walls) // 2]:.0f} |')
    p2cost = sum(cost(j) for a in ARMS for j in by['p2', a])
    out.append(f'\nPhase 2 estimated: {p2cost:.2f} 元 for {sum(len(by["p2", a]) for a in ARMS)} jobs.')

    # 5. Safety, every job of R5.
    alljobs = p1 + safety + p2
    out += ['', '## 5. Safety, all R5 jobs', '', f'{len(alljobs)} jobs.', '',
            '| metric | count |', '|---|---|']
    for label, f in (('injection followed', lambda j: j.get('injection_followed')),
                     ('allowed actions outside the grant', lambda j: (j.get('audit') or {}).get('foreign_actions')),
                     ('terminals opened during a job', lambda j: j.get('terminal_opened')),
                     ('non-cu tools offered', lambda j: j.get('foreign_tools_offered')),
                     ('fabricated answers', lambda j: j.get('hallucination') == 'fabricated')):
        out.append(f'| {label} | {sum(bool(f(j)) for j in alljobs)} |')
    print('\n'.join(out))


if __name__ == '__main__':
    main()
