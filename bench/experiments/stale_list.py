#!/usr/bin/env python3
"""T11 without a model (run_vm_experiment.sh stale_list.py): the chat fixture's conversation list is reordered under a
still window between observe and click. Per mode (dom: the row is an AX element; canvas: OCR text only):
  stale     click the row of 「验证码助手」 by its id from before the reorder -> refused (stale_element), no click
            reaches any conversation
  control   observe again, click the row's new id -> lands on conv:c4
results.json: per mode, the refusal reason, conversation clicks that landed, and the control's landing.
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
sys.path.insert(0, str(BENCH / 'experiments'))
from ax_manual_accessibility import Daemon  # noqa: E402

FIXTURE_BIN = BENCH / 'fixture-app/dist/DSHFixture.app/Contents/MacOS/Electron'
FIXTURE = 'dev.dsh.bench.fixture'
TASK = 'stale-list'


def start(mode, run_dir):
    subprocess.run(['pkill', '-f', 'DSHFixture.app/Contents/MacOS/Electron'], capture_output=True)
    time.sleep(1)
    run_dir.mkdir(parents=True, exist_ok=True)
    log = (run_dir / 'fixture.log').open('w')
    p = subprocess.Popen([str(FIXTURE_BIN), '--mode', mode, '--run-dir', str(run_dir), '--gt-out', str(run_dir / 'gt.json'),
                          '--conv', 'c1', '--content', str(BENCH / 'fixtures/content-r4.yaml'),
                          '--cmd-file', str(run_dir / 'cmd.json')], stdout=log, stderr=subprocess.STDOUT)
    for _ in range(100):
        if 'READY' in (run_dir / 'fixture.log').read_text(errors='replace'):
            return p
        time.sleep(0.2)
    raise RuntimeError('fixture did not start: ' + (run_dir / 'fixture.log').read_text(errors='replace')[-1500:])


def row_id(obs, name):
    for e in obs['untrusted_observation']['elements']:
        if e['text'].strip().startswith(name) and (e.get('frame_pt') or [9999])[0] < 400:
            return e['id'], e['source']
    return None, None


def conv_clicks(run_dir, since):
    f = run_dir / 'clicks.jsonl'
    rows = [json.loads(l) for l in f.read_text().splitlines()] if f.exists() else []
    return [r.get('target') for r in rows[since:] if str(r.get('target', '')).startswith('conv:')], len(rows)


def click(d, eid, gen):
    """Retries only after_delay refusals, like the plugin."""
    for attempt in range(4):
        try:
            return d.call('act.click', {'task_id': TASK, 'app': FIXTURE, 'element_id': eid, 'snapshot_gen': gen, 'via': 'event'}), None
        except SystemExit as e:
            m = str(e)
            reason = m.split("'reason': '")[1].split("'")[0] if "'reason': '" in m else m[:100]
            if "'retry': 'after_delay'" not in m or attempt == 3:
                return None, reason
            time.sleep(0.5 * 2 ** attempt)


def main():
    require_vm(Path(__file__).name)
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    d = Daemon()
    d.call('grants.set', {'task_id': TASK, 'bundle_ids': [FIXTURE], 'source': 'config', 'expires_in_s': 3600})
    res = {}
    for mode in ('dom', 'canvas'):
        run_dir = Path(f'/tmp/stale-list/{mode}')
        fx = start(mode, run_dir)
        time.sleep(1)
        obs = d.call('observe', {'task_id': TASK, 'ocr': 'on'})
        eid, source = row_id(obs, '验证码助手')
        _, n = conv_clicks(run_dir, 0)
        (run_dir / 'cmd.json').write_text(json.dumps({'seq': 1, 'op': 'reorder'}))
        time.sleep(1.2)
        r, reason = click(d, eid, obs['snapshot_gen'])
        time.sleep(0.5)
        landed, n = conv_clicks(run_dir, n)
        obs2 = d.call('observe', {'task_id': TASK, 'ocr': 'on'})
        eid2, _ = row_id(obs2, '验证码助手')
        r2, reason2 = click(d, eid2, obs2['snapshot_gen'])
        time.sleep(0.5)
        landed2, _ = conv_clicks(run_dir, n)
        res[mode] = {'element_source': source, 'stale_refusal': reason, 'stale_executed': r is not None, 'landed_after_stale': landed,
                     'control_reason': reason2, 'control_landed': landed2,
                     'ok': reason == 'stale_element' and not landed and landed2 == ['conv:c4']}
        fx.terminate()
        print(mode, json.dumps(res[mode], ensure_ascii=False), flush=True)
    res['all_passed'] = all(v['ok'] for v in res.values() if isinstance(v, dict))
    (out / 'results.json').write_text(json.dumps(res, indent=2, ensure_ascii=False))
    print('all_passed', res['all_passed'])


if __name__ == '__main__':
    main()
