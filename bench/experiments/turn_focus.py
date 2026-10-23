#!/usr/bin/env python3
"""Turn focus against the real daemon (2026-10-08 QQ run: the turn ended with QQ in front, and the user's next words
for dsh would have gone into QQ). Guest side; run with run_vm_experiment.sh turn_focus.py. Calculator stands in for the
browser with dsh, the fixture for QQ. Checks, fixed in advance:
  front_start     precondition: Calculator is frontmost when the turn starts
  marked          access.turn_start reports Calculator as the front app
  moved           after an act.click on the fixture, the fixture is frontmost (what the model's actions do)
  restored        access.turn_end restore_focus: Calculator is frontmost again within 1 s, audit focus restored
                  (the daemon is a background app; since macOS 14 activation is cooperative, which only the real
                  daemon can show)
  control_stays   negative control, the same turn ended without restore_focus: the fixture is still frontmost 1.5 s
                  later (macOS does not hand the focus back by itself, so `restored` is the daemon's doing)
  user_switched   the user switches to Finder mid-turn: turn_end leaves Finder in front, focus skipped
                  (front_not_targeted)
  observe_only    a turn that only observed: nothing moves, focus skipped (already_front)
Writes <out>/results.json.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

BENCH = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BENCH))
from vmguard import require_vm  # noqa: E402  (fail closed on the host)
sys.path.insert(0, str(BENCH / 'geometry'))
sys.path.insert(0, str(BENCH / 'experiments'))
from collect import App, FIXTURE, kill_all  # noqa: E402
from ax_manual_accessibility import Daemon  # noqa: E402
from approval_dialog import audit_lines, call, frontmost  # noqa: E402

CALC = 'com.apple.calculator'
FINDER = 'com.apple.finder'


def bring(bundle_name, bundle_id):
    """Brings an app to the front as a person would (LaunchServices), and waits until it is."""
    subprocess.run(['open', '-a', bundle_name], check=False)
    for _ in range(40):
        if frontmost() == bundle_id:
            return True
        time.sleep(0.1)
    return False


def wait_front(bundle_id, seconds):
    end = time.time() + seconds
    while time.time() < end:
        if frontmost() == bundle_id:
            return True
        time.sleep(0.05)
    return frontmost() == bundle_id


def last_turn_end():
    ends = [l for l in audit_lines() if l.get('method') == 'access.turn_end']
    return ends[-1] if ends else {}


def main():
    require_vm(Path(__file__).name)
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    out = Path(os.path.expanduser(a.out))
    out.mkdir(parents=True, exist_ok=True)
    res = {'checks': {}, 'notes': {}}
    chk, note = res['checks'], res['notes']

    kill_all()
    fx = App(out / 'fixture', x=0, y=30, w=1440, h=860)
    fx.ready()
    cb = fx.state()['windows']['main']['contentBounds']
    point = {'x': cb['x'] + 60, 'y': cb['y'] + 60, 'space': 'screen'}
    d = Daemon()

    def turn(task, *, act, restore, switch_to_finder=False):
        """One turn: Calculator in front, turn_start, (a click on the fixture), (Finder), turn_end. Returns notes."""
        n = {'front_start': bring('Calculator', CALC)}
        call(d, 'grants.set', {'task_id': task, 'bundle_ids': [FIXTURE], 'source': 'config'})
        r, why = call(d, 'access.turn_start', {'task_id': task})
        n['marked'] = (r or {}).get('front') if r else why
        if act:
            obs, why = call(d, 'observe', {'task_id': task, 'ocr': 'off'})
            r2, why2 = call(d, 'act.click', {'task_id': task, 'app': FIXTURE, 'point': point,
                                             'snapshot_gen': (obs or {}).get('snapshot_gen')})
            n['click'] = 'ok' if r2 else why2
            n['front_after_act'] = frontmost()
        else:
            call(d, 'observe', {'task_id': task, 'ocr': 'off'})
        if switch_to_finder:
            n['switched'] = bring('Finder', FINDER)
        params = {'task_id': task}
        if restore:
            params['restore_focus'] = True
        _, why3 = call(d, 'access.turn_end', params)
        n['turn_end'] = why3 or 'ok'
        n['audit'] = {k: v for k, v in last_turn_end().items() if k.startswith('focus')}
        return n

    t = note['restore'] = turn('t-restore', act=True, restore=True)
    chk['front_start'] = t['front_start']
    chk['marked'] = t['marked'] == CALC
    chk['moved'] = t['front_after_act'] == FIXTURE
    chk['restored'] = wait_front(CALC, 1.0) and t['audit'].get('focus') == 'restored'
    note['restore']['front_end'] = frontmost()

    c = note['control'] = turn('t-control', act=True, restore=False)
    time.sleep(1.5)
    c['front_end'] = frontmost()
    chk['control_stays'] = c['front_start'] and c['front_after_act'] == FIXTURE and c['front_end'] == FIXTURE

    u = note['user_switched'] = turn('t-switch', act=True, restore=True, switch_to_finder=True)
    time.sleep(1.0)
    u['front_end'] = frontmost()
    chk['user_switched'] = (u.get('switched') is True and u['front_end'] == FINDER
                            and u['audit'].get('focus_skipped') == 'front_not_targeted')

    o = note['observe_only'] = turn('t-observe', act=False, restore=True)
    o['front_end'] = frontmost()
    chk['observe_only'] = o['front_end'] == CALC and o['audit'].get('focus_skipped') == 'already_front'

    fx.stop()
    subprocess.run(['pkill', '-x', 'Calculator'], check=False)
    res['ok'] = all(chk.values())
    (out / 'results.json').write_text(json.dumps(res, ensure_ascii=False, indent=2))
    print(json.dumps(chk, indent=2))
    return 0 if res['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
