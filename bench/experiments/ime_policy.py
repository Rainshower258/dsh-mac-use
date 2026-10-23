#!/usr/bin/env python3
"""Input method policy, end to end against the real daemon (docs/DESIGN.md "Input methods"; checks fixed
2026-09-29). Guest side; run with run_vm_experiment.sh ime_policy.py. Pinyin is selected before each case
(bench/tools/bin/inputsource); the field is pre-filled with "x" so act.type really types (an empty field would be set
through AX). Checks, fixed in advance:
  takeover          grant ime_policy takeover: the text arrives exactly, the result says switched, the source is ABC
                    while the task runs and Pinyin again after grants.revoke; audit: select then restore
  composing         takeover while "ni" is being composed: refused ime_composing (after_observe), nothing typed, the
                    source still Pinyin
  ask               ime_policy ask: refused ime_switch_needs_approval, nothing typed; after ime.approve (call) the text
                    arrives and the source is Pinyin again right after
  leave             ime_policy leave: typed, ime "left" with a warning, the source never changed
  sigterm           takeover, then SIGTERM to the daemon: the source is Pinyin again (audit trigger signal_15)
  crash             takeover, then SIGKILL: the source stays ABC and the ledger holds the entry; the next daemon start
                    restores Pinyin (trigger startup_recovery) and empties the ledger
  set_value         takeover, empty field: via ax_value, exact, and no input source change at all
Writes <out>/results.json (synthetic strings, source IDs, audit fields).
"""
import argparse
import json
import os
import signal
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
from ax_manual_accessibility import Daemon, STATE  # noqa: E402

TASK = 'actions'   # Run.act uses this task id
TOOL = BENCH / 'tools/bin/inputsource'
PINYIN, ABC = 'com.apple.inputmethod.SCIM.ITABC', 'com.apple.keylayout.ABC'


def is_layout(sid):
    # The switch goes to the ASCII layout the system pairs with Pinyin (TISCopyCurrentASCIICapableKeyboardLayoutInputSource),
    # which in the VM base is British, not ABC (first run of this experiment): any keyboard layout counts.
    return str(sid).startswith('com.apple.keylayout.')
MIX = '输入法策略测试 IME policy test，超过二十个字符！'
FIELD = {'id': 'in1', 'kind': 'input', 'x': 100, 'y': 110, 'w': 420, 'h': 28, 'label': 'field one'}
APP = Path.home() / 'Applications/CURuntime.app'


def source(*args):
    return subprocess.run([str(TOOL), *args], capture_output=True, text=True).stdout.strip()


def daemon_pids():
    out = subprocess.run(['pgrep', '-f', 'CURuntime.app/Contents/MacOS/'], capture_output=True, text=True).stdout
    return [int(x) for x in out.split()]


def start_daemon():
    (STATE / 'daemon.sock').unlink(missing_ok=True)
    subprocess.run(['open', '-n', str(APP), '--args', 'serve'], check=True)
    for _ in range(60):
        if (STATE / 'daemon.sock').exists() and (STATE / 'token').exists():
            time.sleep(0.3)
            return Daemon()
        time.sleep(0.25)
    raise SystemExit('daemon did not come back')


def stop_daemon(sig):
    for pid in daemon_pids():
        os.kill(pid, sig)
    for _ in range(40):
        if not daemon_pids():
            return
        time.sleep(0.25)


def audit_tail(n0):
    lines = []
    for f in sorted((STATE / 'audit').glob('audit-*.jsonl')):
        lines += f.read_text().splitlines()
    out = []
    for l in lines[n0:]:
        e = json.loads(l)
        if e.get('method') == 'system.input_source':
            out.append({k: e.get(k) for k in ('change', 'trigger', 'from', 'to', 'ok')})
    return out


def audit_len():
    return sum(len(f.read_text().splitlines()) for f in (STATE / 'audit').glob('audit-*.jsonl'))


def main():
    require_vm(Path(__file__).name)
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    kill_all()
    fx = App(Path('/tmp/imepol-apps/fx'), x=150, y=150, w=800, h=520)
    fx.ready()
    fx.cmd('fields', fields=[FIELD], settle=0.8)
    fx.cmd('focus', settle=0.5)
    cb = fx.state()['windows']['main']['contentBounds']
    cx, cy = cb['x'] + FIELD['x'] + FIELD['w'] / 2, cb['y'] + FIELD['y'] + FIELD['h'] / 2
    state = {'d': Daemon()}
    res = {}

    def grant(policy):
        state['d'].call('grants.set', {'task_id': TASK, 'bundle_ids': [FIXTURE], 'source': 'config', 'expires_in_s': 600,
                                       'ime_policy': policy})

    def value():
        return fx.state()['windows']['main'].get('fields', {}).get('in1')

    def arrived():
        # Pre-filled "x": the caret after an AX focus may sit before or after it, so: all of MIX, plus the x.
        v = value() or ''
        return MIX in v and len(v) == len(MIX) + 1

    def prepare(prefill='x'):
        source('select', PINYIN)
        fx.cmd('fields', fields=[{**FIELD, 'value': prefill}], settle=0.5)
        run = Run(fx, state['d'])
        obs = run.observe()
        return run, element_at(obs, cx, cy, ('AXTextField',)), obs['snapshot_gen']

    def type_(run, el, gen, **kw):
        return run.act('act.type', text=MIX, element_id=el, snapshot_gen=gen, **kw)

    # takeover
    n0 = audit_len()
    grant('takeover')
    run, el, gen = prepare()
    r, reason = type_(run, el, gen)
    time.sleep(0.5)
    during = source('current')
    state['d'].call('grants.revoke', {'task_id': TASK})
    time.sleep(0.3)
    res['takeover'] = {'reason': reason, 'ime': (r or {}).get('ime'), 'restores': (r or {}).get('restores'),
                       'exact': arrived(), 'source_during': during, 'source_after_revoke': source('current'),
                       'audit': audit_tail(n0)}

    # composing
    grant('takeover')
    run, el, gen = prepare(prefill='')
    run.act('act.click', point={'x': cx, 'y': cy, 'space': 'screen'}, snapshot_gen=gen)
    time.sleep(0.4)
    run.act('act.key', chord='n')
    run.act('act.key', chord='i')
    time.sleep(0.8)
    obs = run.observe()
    el = element_at(obs, cx, cy, ('AXTextField',))
    before = value()
    r, reason = run.act('act.type', text=MIX, element_id=el, snapshot_gen=obs['snapshot_gen'])
    msg = run.refusals[-1] if run.refusals else ''
    res['composing'] = {'reason': reason, 'retry_after_observe': "'retry': 'after_observe'" in msg, 'value_before': before,
                        'value_after': value(), 'source': source('current')}
    run.act('act.key', chord='escape')
    time.sleep(0.4)
    state['d'].call('grants.revoke', {'task_id': TASK})

    # ask
    n0 = audit_len()
    grant('ask')
    run, el, gen = prepare()
    r1, reason1 = type_(run, el, gen)
    typed_before_approval = value() != 'x'
    state['d'].call('ime.approve', {'task_id': TASK, 'scope': 'call'})
    obs = run.observe()
    r2, reason2 = type_(run, element_at(obs, cx, cy, ('AXTextField',)), obs['snapshot_gen'])
    time.sleep(0.4)
    res['ask'] = {'first': reason1, 'typed_before_approval': typed_before_approval, 'second': reason2,
                  'restores': (r2 or {}).get('restores'), 'exact': arrived(), 'source_after': source('current'),
                  'audit': audit_tail(n0)}
    state['d'].call('grants.revoke', {'task_id': TASK})

    # leave
    grant('leave')
    run, el, gen = prepare()
    r, reason = type_(run, el, gen)
    time.sleep(0.4)
    res['leave'] = {'reason': reason, 'ime': (r or {}).get('ime'), 'warning': bool((r or {}).get('ime_warning')),
                    'composing': (r or {}).get('ime_composing'), 'exact': arrived(), 'source': source('current')}
    state['d'].call('grants.revoke', {'task_id': TASK})

    # sigterm
    n0 = audit_len()
    grant('takeover')
    run, el, gen = prepare()
    type_(run, el, gen)
    during = source('current')
    stop_daemon(signal.SIGTERM)
    time.sleep(0.3)
    res['sigterm'] = {'source_during': during, 'source_after': source('current'), 'audit': audit_tail(n0)}
    state['d'] = start_daemon()

    # crash
    n0 = audit_len()
    grant('takeover')
    run, el, gen = prepare()
    type_(run, el, gen)
    stop_daemon(signal.SIGKILL)
    time.sleep(0.3)
    ledger = STATE / 'state-changes.json'
    after_kill = {'source': source('current'), 'ledger': json.loads(ledger.read_text()) if ledger.exists() else None}
    state['d'] = start_daemon()
    time.sleep(0.5)
    res['crash'] = {'after_kill': after_kill, 'source_after_restart': source('current'), 'ledger_after_restart': ledger.exists(),
                    'audit': audit_tail(n0)}

    # set_value
    grant('takeover')
    run, el, gen = prepare(prefill='')
    n0 = audit_len()
    r, reason = type_(run, el, gen)
    time.sleep(0.5)
    res['set_value'] = {'reason': reason, 'via': (r or {}).get('via'), 'exact': value() == MIX, 'source': source('current'),
                        'source_changes': audit_tail(n0)}
    state['d'].call('grants.revoke', {'task_id': TASK})

    source('select', ABC)
    fx.stop()
    kill_all()
    t, c, a, lv, st, cr, sv = (res[k] for k in ('takeover', 'composing', 'ask', 'leave', 'sigterm', 'crash', 'set_value'))
    checks = {
        'takeover': t['reason'] is None and t['ime'] == 'switched' and t['exact'] and is_layout(t['source_during'])
        and t['source_after_revoke'] == PINYIN and [x['change'] for x in t['audit']] == ['select', 'restore'],
        'composing': c['reason'] == 'ime_composing' and c['retry_after_observe'] and c['value_after'] == c['value_before']
        and c['source'] == PINYIN,
        'ask': a['first'] == 'ime_switch_needs_approval' and not a['typed_before_approval'] and a['second'] is None
        and a['restores'] == 'after_this_input' and a['exact'] and a['source_after'] == PINYIN,
        'leave': lv['reason'] is None and lv['ime'] == 'left' and lv['warning'] and lv['source'] == PINYIN,
        'sigterm': is_layout(st['source_during']) and st['source_after'] == PINYIN
        and any(x['trigger'] == 'signal_15' and x['change'] == 'restore' for x in st['audit']),
        'crash': is_layout(cr['after_kill']['source']) and bool(cr['after_kill']['ledger']) and cr['source_after_restart'] == PINYIN
        and not cr['ledger_after_restart'] and any(x['trigger'] == 'startup_recovery' for x in cr['audit']),
        'set_value': sv['reason'] is None and sv['via'] == 'ax_value' and sv['exact'] and sv['source'] == PINYIN
        and not sv['source_changes'],
    }
    res['checks'] = checks
    res['all_passed'] = all(checks.values())
    (out / 'results.json').write_text(json.dumps(res, indent=2, ensure_ascii=False))
    print(json.dumps(checks))
    print('all_passed', res['all_passed'])
    if not res['all_passed']:
        print(json.dumps(res, ensure_ascii=False)[:4000])


if __name__ == '__main__':
    main()
