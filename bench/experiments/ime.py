#!/usr/bin/env python3
"""R3 supplement (2026-09-29): chunked typing with the Pinyin input method selected. Guest side; run with
run_vm_experiment.sh ime.py. Needs bench/tools/bin/inputsource (synced by the runner).

Unicode keyboard events normally bypass the input method, but not necessarily while the field holds an uncommitted
Pinyin composition. Per trial (3 each), in a fresh empty input:
  no_candidate    Pinyin selected, nothing composing: act.type MIX -> the value
  with_candidate  act.key n, act.key i (real key presses: the IME composes "ni" with candidates), then act.type MIX
                  -> the value while composing, right after typing, and after an Escape
The input source is restored to ABC at the end. results.json: the values (synthetic strings) and whether each equals
MIX exactly.
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

BENCH = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BENCH))
from vmguard import require_vm  # noqa: E402  (fail closed on the host)
sys.path.insert(0, str(BENCH / 'geometry'))
sys.path.insert(0, str(BENCH / 'experiments'))
from actions import Run, element_at, windows_at  # noqa: E402
from collect import App, FIXTURE, kill_all  # noqa: E402
from ax_manual_accessibility import Daemon  # noqa: E402

TASK = 'actions'   # Run.act uses the actions experiment's task id
TOOL = BENCH / 'tools/bin/inputsource'
PINYIN, ABC = 'com.apple.inputmethod.SCIM.ITABC', 'com.apple.keylayout.ABC'
MIX = '拼音状态下输入 Pinyin mode 测试，共二十多个字符！'


def source(*args):
    return subprocess.run([str(TOOL), *args], capture_output=True, text=True).stdout.strip()


def main():
    require_vm(Path(__file__).name)
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--trials', type=int, default=3)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    res = {'initial_source': source('current')}

    kill_all()
    fx = App(Path('/tmp/ime-apps/fx'), x=150, y=150, w=800, h=520)
    fx.ready()
    d = Daemon()
    d.call('grants.set', {'task_id': TASK, 'bundle_ids': [FIXTURE], 'source': 'config', 'expires_in_s': 3600})
    fx.cmd('fields', fields=[{'id': 'in1', 'kind': 'input', 'x': 100, 'y': 110, 'w': 500, 'h': 28, 'label': 'field one'}],
           settle=0.8)
    fx.cmd('focus', settle=0.5)
    run = Run(fx, d)
    cb = fx.state()['windows']['main']['contentBounds']
    res['selected'] = source('select', PINYIN)

    def fresh_focused_input():
        fx.cmd('fields', fields=[{'id': 'in1', 'kind': 'input', 'x': 100, 'y': 110, 'w': 500, 'h': 28, 'value': ''}], settle=0.4)
        obs = run.observe()
        in1 = element_at(obs, cb['x'] + 350, cb['y'] + 124, ('AXTextField',))
        run.act('act.click', point={'x': cb['x'] + 350, 'y': cb['y'] + 124, 'space': 'screen'}, snapshot_gen=obs['snapshot_gen'])
        time.sleep(0.4)
        return in1

    trials = {'no_candidate': [], 'with_candidate': []}
    for _ in range(args.trials):
        fresh_focused_input()
        r, reason = run.act('act.type', text=MIX)
        time.sleep(0.8)
        v = run.field('in1')
        trials['no_candidate'].append({'reason': reason, 'value': v, 'exact': v == MIX, 'source': source('current')})

        fresh_focused_input()
        run.act('act.key', chord='n')
        run.act('act.key', chord='i')
        time.sleep(0.6)
        composing = run.field('in1')
        ime_windows = [w for w in windows_at(cb['x'] + 150, cb['y'] + 170) if isinstance(w, dict) and w.get('owner') != 'DSHFixture'] \
            if isinstance(windows_at(cb['x'] + 150, cb['y'] + 170), list) else []
        in1 = element_at(run.observe(), cb['x'] + 350, cb['y'] + 124, ('AXTextField',))
        obs = run.observe()
        r, reason = run.act('act.type', text=MIX, element_id=in1, snapshot_gen=obs['snapshot_gen'])
        time.sleep(0.8)
        after = run.field('in1')
        run.act('act.key', chord='escape')
        time.sleep(0.5)
        final = run.field('in1')
        trials['with_candidate'].append({'reason': reason, 'verified': (r or {}).get('verified'),
                                         'composing_value': composing, 'value_after_type': after,
                                         'value_after_escape': final, 'exact_after_type': after == MIX,
                                         'exact_after_escape': final == MIX, 'other_windows_near_field': len(ime_windows),
                                         'source': source('current')})
    res['trials'] = trials
    res['restored'] = source('select', ABC)
    res['summary'] = {
        'no_candidate_exact': sum(t['exact'] for t in trials['no_candidate']),
        'with_candidate_exact_after_type': sum(t['exact_after_type'] for t in trials['with_candidate']),
        'with_candidate_exact_after_escape': sum(t['exact_after_escape'] for t in trials['with_candidate']),
        'of': args.trials,
    }
    fx.stop()
    kill_all()
    (out / 'results.json').write_text(json.dumps(res, indent=2, ensure_ascii=False))
    print(json.dumps(res['summary']))
    for k in ('initial_source', 'selected', 'restored'):
        print(k, res[k])
    for k, ts in trials.items():
        for t in ts:
            print(k, json.dumps(t, ensure_ascii=False))


if __name__ == '__main__':
    main()
