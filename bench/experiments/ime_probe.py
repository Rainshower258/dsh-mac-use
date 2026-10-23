#!/usr/bin/env python3
"""Input method policy groundwork (Desktop handoff 2026-09-29 night), guest side. Run with
    DAEMON_CONFIG='{"debug_ime": true, "debug_activation": true}' run_vm_experiment.sh ime_probe.py
Measures, before the policy is built on them:
  A set_value   act.set_value into a Chromium input and textarea (3 each): does the DOM get the value, and does the
                app notice (an 'input' event, which updates the app's own copy and enables a send button)?
                act.type into the same fields as the control.
  B select      runtime.debug_ime select from the daemon (a LaunchServices-started background app): Pinyin <-> ABC,
                3 each, verified by reading the current source back (daemon and the inputsource tool over ssh).
  C composing   with Pinyin selected, the probe (non-granted on-screen windows by owner/layer/frame, and the focused
                element's attributes) while idle, while composing "ni" (real key presses) and after Escape; 3 each.
  D per_doc     what "restore" means with "automatically switch to a document's input source": select ABC while the
                fixture is in front (a takeover), switch to Finder and back, restore Pinyin, switch again; once with
                the default (global) setting and once with TextInputGlobalPropertyPerContextInput on.
Writes <out>/results.json (synthetic strings, input source IDs, window owners and frames only).
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
from actions import Run, element_at  # noqa: E402
from collect import App, FIXTURE, kill_all  # noqa: E402
from ax_manual_accessibility import Daemon  # noqa: E402

TASK = 'actions'
TOOL = BENCH / 'tools/bin/inputsource'
PINYIN, ABC = 'com.apple.inputmethod.SCIM.ITABC', 'com.apple.keylayout.ABC'
MIX = '设值测试 set value 中英混合，超过二十个字符！'
FIELDS = [{'id': 'in1', 'kind': 'input', 'x': 100, 'y': 110, 'w': 420, 'h': 28, 'label': 'field one', 'reactive': True},
          {'id': 'ta1', 'kind': 'textarea', 'x': 100, 'y': 170, 'w': 420, 'h': 80, 'label': 'area one', 'reactive': True}]
ROLES = {'in1': ('AXTextField',), 'ta1': ('AXTextArea',)}


def tool(*args):
    return subprocess.run([str(TOOL), *args], capture_output=True, text=True).stdout.strip()


def main():
    require_vm(Path(__file__).name)
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--trials', type=int, default=3)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    res = {'initial_source_tool': tool('current')}

    kill_all()
    fx = App(Path('/tmp/ime-apps/fx'), x=150, y=150, w=800, h=520)
    fx.ready()
    d = Daemon()
    d.call('grants.set', {'task_id': TASK, 'bundle_ids': [FIXTURE], 'source': 'config', 'expires_in_s': 3600})
    fx.cmd('fields', fields=FIELDS, settle=0.8)
    fx.cmd('focus', settle=0.5)
    run = Run(fx, d)
    cb = fx.state()['windows']['main']['contentBounds']
    centre = {f['id']: (cb['x'] + f['x'] + f['w'] / 2, cb['y'] + f['y'] + f['h'] / 2) for f in FIELDS}

    def dbg(op, **kw):
        return d.call('runtime.debug_ime', {'task_id': TASK, 'app': FIXTURE, 'op': op, **kw})

    def fields(fid):
        st = fx.state()['windows']['main'].get('fields', {})
        return {k: v for k, v in st.items() if k == fid or k.startswith(fid + '#')}

    def reset(fid):
        f = next(f for f in FIELDS if f['id'] == fid)
        fx.cmd('fields', fields=[{**f, 'value': ''}], settle=0.4)

    def element(fid):
        obs = run.observe()
        return element_at(obs, *centre[fid], ROLES[fid]), obs['snapshot_gen']

    # A: set_value vs type in Chromium
    res['set_value'] = {}
    for fid in ('in1', 'ta1'):
        rows = []
        for _ in range(args.trials):
            for how in ('set_value', 'type'):
                reset(fid)
                el, gen = element(fid)
                if how == 'set_value':
                    r, reason = run.act('act.set_value', element_id=el, value=MIX, snapshot_gen=gen)
                else:
                    r, reason = run.act('act.type', element_id=el, text=MIX, snapshot_gen=gen)
                time.sleep(0.8)
                v = fields(fid)
                rows.append({'how': how, 'reason': reason, 'dom_exact': v.get(fid) == MIX, 'app_copy_exact': v.get(f'{fid}#app') == MIX,
                             'input_events': v.get(f'{fid}#inputs'), 'send_enabled': v.get(f'{fid}#send_enabled'),
                             'verified': (r or {}).get('verified')})
        res['set_value'][fid] = rows

    # B: selecting input sources from the daemon
    res['select'] = []
    for _ in range(args.trials):
        for sid in (PINYIN, ABC):
            r = dbg('select', id=sid)
            time.sleep(0.3)
            res['select'].append({'target': sid, **r, 'tool_current': tool('current')})

    # C: what changes while composing
    res['composing'] = []
    for _ in range(args.trials):
        dbg('select', id=PINYIN)
        reset('in1')
        run.act('act.click', point={'x': centre['in1'][0], 'y': centre['in1'][1], 'space': 'screen'},
                snapshot_gen=run.observe()['snapshot_gen'])
        time.sleep(0.5)
        idle = dbg('probe')
        n_events = len(run.events())
        run.act('act.key', chord='n')
        run.act('act.key', chord='i')
        time.sleep(0.8)
        composing = dbg('probe')
        comp_value = fields('in1').get('in1')
        run.act('act.key', chord='escape')
        time.sleep(0.6)
        after = dbg('probe')
        ev = [e for e in run.events()[n_events:] if e.get('kind') in ('compositionstart', 'compositionend', 'input')]
        # Control: compose again and commit with space (the first candidate goes in): composing must be over.
        run.act('act.key', chord='n')
        run.act('act.key', chord='i')
        time.sleep(0.8)
        composing2 = dbg('probe')
        run.act('act.key', chord='space')
        time.sleep(0.8)
        committed = dbg('probe')
        res['composing'].append({'idle': idle, 'composing': composing, 'after_escape': after, 'value_while_composing': comp_value,
                                 'value_after_escape': fields('in1').get('in1'), 'dom_events': ev,
                                 'composing2': composing2, 'committed': committed, 'value_committed': fields('in1').get('in1')})
    dbg('select', id=ABC)

    # D: restore semantics with per-document input sources
    def activate_fixture():
        return d.call('runtime.debug_activate', {'task_id': TASK, 'app': FIXTURE, 'method': 'running_application'}).get('ok')

    def finder():
        subprocess.run(['open', '-a', 'Finder'])
        time.sleep(1.2)

    def cur():
        return {'daemon': dbg('probe').get('source', {}).get('id'), 'tool': tool('current')}

    def scenario():
        """Finder picks Pinyin itself; the fixture is taken over (ABC); the task ends while Finder is in front and the
        daemon's rule runs: restore only if the current source is still the one it set. Global mode: Finder shows
        ABC, the restore happens. Per-document mode: Finder shows its own Pinyin, so the restore is skipped and the
        question is what the fixture is left with."""
        s = {}
        finder()
        s['finder_select_pinyin'] = dbg('select', id=PINYIN)
        s['finder_initial'] = cur()
        s['fixture_front'] = activate_fixture()
        time.sleep(0.8)
        s['fixture_initial'] = cur()
        dbg('select', id=PINYIN)
        s['takeover_abc'] = dbg('select', id=ABC)
        s['fixture_takeover'] = cur()
        finder()
        s['finder_during_takeover'] = cur()
        now = cur()['daemon']
        s['restore'] = dbg('select', id=PINYIN) if now == ABC else f'skipped (current {now})'
        s['finder_after_restore'] = cur()
        activate_fixture()
        time.sleep(0.8)
        s['fixture_after_restore'] = cur()
        dbg('select', id=ABC)
        return s

    key = ['com.apple.HIToolbox', 'AppleGlobalTextInputProperties']
    res['per_doc'] = {'default_setting': subprocess.run(['defaults', 'read', *key], capture_output=True, text=True).stdout.strip()}
    res['per_doc']['global'] = scenario()
    subprocess.run(['defaults', 'write', *key, '-dict', 'TextInputGlobalPropertyPerContextInput', '-bool', 'true'])
    subprocess.run(['killall', 'TextInputMenuAgent'], capture_output=True)
    # Apps read the setting when they start: relaunch Finder and the fixture (the first run of this experiment
    # showed no difference without relaunching).
    subprocess.run(['killall', 'Finder'], capture_output=True)
    fx.stop()
    fx = App(Path('/tmp/ime-apps/fx2'), x=150, y=150, w=800, h=520)
    fx.ready()
    fx.cmd('fields', fields=FIELDS, settle=0.8)
    time.sleep(2)
    res['per_doc']['setting_after_write'] = subprocess.run(['defaults', 'read', *key], capture_output=True, text=True).stdout.strip()
    res['per_doc']['per_document'] = scenario()
    subprocess.run(['defaults', 'delete', *key], capture_output=True)

    res['final_source_tool'] = tool('current')
    fx.stop()
    kill_all()
    (out / 'results.json').write_text(json.dumps(res, indent=2, ensure_ascii=False))
    sv = {fid: {how: {k: sum(1 for r in rows if r['how'] == how and r[k]) for k in ('dom_exact', 'app_copy_exact', 'send_enabled')}
                for how in ('set_value', 'type')} for fid, rows in res['set_value'].items()}
    print('set_value', json.dumps(sv))
    print('select', json.dumps([(r['target'].split('.')[-1], r.get('ok'), r.get('elapsed_ms')) for r in res['select']]))
    print('composing values', [(c['value_while_composing'], c['value_after_escape']) for c in res['composing']])
    for k in ('global', 'per_document'):
        print(k, json.dumps(res['per_doc'][k], ensure_ascii=False)[:900])


if __name__ == '__main__':
    main()
