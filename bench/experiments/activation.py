#!/usr/bin/env python3
"""Which activation method passes the post-activation check most reliably (docs/DESIGN.md "Pre-action checks",
"Activate, then verify"). Guest side; run with
  DAEMON_CONFIG='{"debug_activation": true}' bench/experiments/run_vm_experiment.sh activation.py

For each method (running_application, ax_frontmost, ax_raise) and each situation, N trials of
runtime.debug_activate (the daemon's activation plus its usual verification: frontmost within 500 ms):
  behind   another app (the blocker) is frontmost
  hidden   the fixture app is hidden (cmd+H)
Before every trial the situation is re-established and checked. Metrics: success rate, latency p50/p95.
"""
import argparse
import json
import sys
import time
from pathlib import Path

BENCH = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BENCH))
from vmguard import require_vm  # noqa: E402  (fail closed on the host)
sys.path.insert(0, str(BENCH / 'geometry'))
sys.path.insert(0, str(BENCH / 'experiments'))
from collect import App, FIXTURE, BLOCKER, ensure_blocker_app, kill_all  # noqa: E402
from ax_manual_accessibility import Daemon  # noqa: E402

TASK = 'activation'
METHODS = ('running_application', 'ax_frontmost', 'ax_raise')


def pct(xs, p):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]) if xs else None


def main():
    require_vm(Path(__file__).name)
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--n', type=int, default=20)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    ensure_blocker_app()
    kill_all()
    fx = App(Path('/tmp/act-apps/fx'), x=150, y=150, w=700, h=450)
    fx.ready()
    blk = App(Path('/tmp/act-apps/blk'), role='blocker', x=500, y=300, w=500, h=300)
    blk.ready()
    d = Daemon()
    d.call('grants.set', {'task_id': TASK, 'bundle_ids': [FIXTURE], 'source': 'config', 'expires_in_s': 3600})

    def frontmost():
        return d.call('observe', {'task_id': TASK, 'ocr': 'off'}).get('frontmost')

    res = {}
    for situation in ('behind', 'hidden'):
        for method in METHODS:
            ok, ms, setup_fail = 0, [], 0
            for _ in range(args.n):
                if situation == 'behind':
                    blk.cmd('focus', settle=0.4)
                else:
                    fx.cmd('showApp', settle=0.3)
                    fx.cmd('hideApp', settle=0.6)
                front = frontmost()
                if front == FIXTURE:
                    setup_fail += 1
                    continue
                r = d.call('runtime.debug_activate', {'task_id': TASK, 'app': FIXTURE, 'method': method})
                ms.append(r['elapsed_ms'])
                ok += bool(r['ok'])
                time.sleep(0.2)
            trials = args.n - setup_fail
            res[f'{situation}/{method}'] = {'trials': trials, 'ok': ok, 'rate': round(ok / trials, 3) if trials else None,
                                             'p50_ms': pct(ms, 50), 'p95_ms': pct(ms, 95), 'setup_failed': setup_fail}
            print(situation, method, res[f'{situation}/{method}'], flush=True)
        fx.cmd('showApp', settle=0.3)

    fx.stop()
    blk.stop()
    kill_all()
    (out / 'results.json').write_text(json.dumps(res, indent=2))


if __name__ == '__main__':
    main()
