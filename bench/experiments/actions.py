#!/usr/bin/env python3
"""R3 exit conditions (PLAN-v2 R3), guest side; run with run_vm_experiment.sh actions.py.

Ground truth comes from the fixture (calibration mode): clicks.jsonl (mousedown landings), events.jsonl (click,
dblclick, contextmenu, keydown with modifier state, wheel, mouseup, drag moves) and the text fields' values in
state.json. Checks, fixed in advance:
  click_ax      element click, default path (AXPress): each of the 9 markers gets a 'click' on itself
  click_event   element click with via: event: a mousedown on each marker
  click_point   point click at each marker centre (from the snapshot's AX frames): a mousedown on each marker
  double        count 2 at a marker: one dblclick on it
  right         button right at a marker: a contextmenu on it
  type_long     >20-character mixed Chinese/English text into an input: its value equals the text exactly
  type_multi    text with a line break into a textarea: value equals the text (the break arrives as Return)
  modifiers     cmd+a then typing into the input replaces its content; the 'a' keydown carried metaKey
  set_value     act.set_value on the input: value equals it
  scroll        scroll down / up: wheel events with deltaY > 0 / < 0
  drag          drag from marker 0 to marker 4: mouseup at the target (<= 2 pt) after >= 5 dragged moves
  stale         after the window moved, clicking an element of the old snapshot is refused (stale_element), by
                either path, and nothing reaches the fixture
Writes <out>/results.json (numbers and the synthetic test strings only).
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

BENCH = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BENCH))
from vmguard import require_vm  # noqa: E402  (fail closed on the host)
sys.path.insert(0, str(BENCH / 'geometry'))
sys.path.insert(0, str(BENCH / 'experiments'))
from collect import App, FIXTURE, kill_all  # noqa: E402
import subprocess  # noqa: E402

WINDOWS_AT = '''ObjC.import('CoreGraphics'); ObjC.import('Foundation');
function run(argv) {
  const x = Number(argv[0]), y = Number(argv[1]);
  const all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)));
  return JSON.stringify(all.filter(w => { const b = w.kCGWindowBounds;
      return b.X <= x && x <= b.X + b.Width && b.Y <= y && y <= b.Y + b.Height; })
    .map(w => ({id: w.kCGWindowNumber, owner: w.kCGWindowOwnerName, pid: w.kCGWindowOwnerPID, layer: w.kCGWindowLayer,
                alpha: w.kCGWindowAlpha, name: w.kCGWindowName, bounds: w.kCGWindowBounds})));
}'''


def windows_at(x, y):
    """Diagnostics: every on-screen window containing a point, front to back."""
    r = subprocess.run(['osascript', '-l', 'JavaScript', '-e', WINDOWS_AT, str(x), str(y)], capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except ValueError:
        return r.stderr.strip()[:200]
from ax_manual_accessibility import Daemon  # noqa: E402

TASK = 'actions'
LONG = '今天下午三点在A会议室开会，Meeting at 3pm in Room A，请准时参加！'
MULTI = '第一行 line one\n第二行 line two'
REPLACED = '替换后 replaced 123'
SET_VALUE = 'set via AX 设值'


class Run:
    def __init__(self, fx, d):
        self.fx, self.d = fx, d
        self.refusals, self.retries = [], 0

    def observe(self):
        return self.d.call('observe', {'task_id': TASK, 'ocr': 'off'})

    def act(self, method, **p):
        """(result, None) or (None, reason). Like the R4 plugin, retries only refusals classed after_delay, a few
        times; every refusal message is kept."""
        for attempt in range(7):
            try:
                return self.d.call(method, {'task_id': TASK, 'app': FIXTURE, **p}), None
            except SystemExit as e:
                msg = str(e)
                reason = msg.split("'reason': '")[1].split("'")[0] if "'reason': '" in msg else msg[:120]
                self.refusals.append(msg[:300])
                if "'retry': 'after_delay'" not in msg or attempt == 6:
                    return None, reason
                self.retries += 1
                time.sleep(0.5)

    def events(self):
        f = self.fx.dir / 'events.jsonl'
        return [json.loads(l) for l in f.read_text().splitlines()] if f.exists() else []

    def field(self, fid):
        return self.fx.state()['windows']['main'].get('fields', {}).get(fid)


def markers(obs):
    out = {}
    for e in obs['untrusted_observation']['elements']:
        if e['source'] == 'ax' and e.get('role') == 'AXButton':
            for i in range(9):
                if f'marker {i}' in e['text']:
                    x, y, w, h = e['frame_pt']
                    out[i] = {'id': e['id'], 'x': x + w / 2, 'y': y + h / 2}
    return out


def element_at(obs, x, y, roles):
    for e in obs['untrusted_observation']['elements']:
        if e['source'] == 'ax' and e.get('role') in roles and e.get('frame_pt'):
            ex, ey, w, h = e['frame_pt']
            if ex <= x <= ex + w and ey <= y <= ey + h:
                return e['id']
    return None


def main():
    require_vm(Path(__file__).name)
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    res = {}

    kill_all()
    fx = App(Path('/tmp/actions-apps/fx'), x=150, y=150, w=800, h=520)
    fx.ready()
    d = Daemon()
    d.call('grants.set', {'task_id': TASK, 'bundle_ids': [FIXTURE], 'source': 'config', 'expires_in_s': 3600})
    # Clear of the markers (content 800x520: marker columns at x 40/400/760, rows at y 40/260/480).
    fx.cmd('fields', fields=[{'id': 'in1', 'kind': 'input', 'x': 100, 'y': 110, 'w': 260, 'h': 28, 'label': 'field one'},
                             {'id': 'ta1', 'kind': 'textarea', 'x': 100, 'y': 300, 'w': 260, 'h': 90, 'label': 'area one'},
                             {'id': 'pw1', 'kind': 'password', 'x': 460, 'y': 110, 'w': 200, 'h': 28, 'label': 'password'}],
           settle=0.8)
    fx.cmd('focus', settle=0.5)
    run = Run(fx, d)
    obs = run.observe()
    gen = obs['snapshot_gen']
    mk = markers(obs)
    cb = fx.state()['windows']['main']['contentBounds']
    in1 = element_at(obs, cb['x'] + 230, cb['y'] + 124, ('AXTextField',))
    ta1 = element_at(obs, cb['x'] + 230, cb['y'] + 345, ('AXTextArea',))
    res['setup'] = {'markers': len(mk), 'input_found': bool(in1), 'textarea_found': bool(ta1)}

    def since(n, kind):
        return [e for e in run.events()[n:] if e['kind'] == kind]

    # click_ax / click_event / click_point
    for name, kw in (('click_ax', {}), ('click_event', {'via': 'event'}), ('click_point', None)):
        ok, refused = 0, []
        for i, m in sorted(mk.items()):
            n_ev, n_cl = len(run.events()), len(fx.clicks())
            if kw is None:
                r, reason = run.act('act.click', point={'x': m['x'], 'y': m['y'], 'space': 'screen'}, snapshot_gen=gen)
            else:
                r, reason = run.act('act.click', element_id=m['id'], snapshot_gen=gen, **kw)
            time.sleep(0.25)
            if r is None:
                refused.append(reason)
                continue
            if name == 'click_ax':
                ok += any(e.get('target') == f'm{i}' for e in since(n_ev, 'click')) and r.get('via') == 'ax'
            else:
                ok += any(c.get('target') == f'm{i}' for c in fx.clicks()[n_cl:]) and r.get('via') == 'event'
        res[name] = {'ok': ok, 'of': len(mk), 'refused': refused}

    # double / right
    m4 = mk.get(4)
    n = len(run.events())
    r, reason = run.act('act.click', point={'x': m4['x'], 'y': m4['y'], 'space': 'screen'}, snapshot_gen=gen, count=2)
    time.sleep(0.4)
    res['double'] = {'executed': bool(r), 'reason': reason,
                     'dblclick_on_target': sum(e.get('target') == 'm4' for e in since(n, 'dblclick'))}
    n = len(run.events())
    r, reason = run.act('act.click', point={'x': m4['x'], 'y': m4['y'], 'space': 'screen'}, snapshot_gen=gen, button='right')
    time.sleep(0.4)
    res['right'] = {'executed': bool(r), 'reason': reason,
                    'contextmenu_on_target': sum(e.get('target') == 'm4' for e in since(n, 'contextmenu'))}

    # typing
    r, reason = run.act('act.type', text=LONG, element_id=in1, snapshot_gen=gen)
    time.sleep(0.8)
    res['type_long'] = {'chars': len(LONG), 'utf16': len(LONG.encode('utf-16-le')) // 2, 'executed': bool(r),
                        'reason': reason, 'steps': (r or {}).get('steps'), 'exact': run.field('in1') == LONG}
    r, reason = run.act('act.type', text=MULTI, element_id=ta1, snapshot_gen=gen)
    time.sleep(0.8)
    res['type_multi'] = {'executed': bool(r), 'reason': reason, 'exact': run.field('ta1') == MULTI}

    # modifiers: select all in the input, then type over it (fresh snapshot: typing changed the field's value,
    # and with it the element's fingerprint)
    obs = run.observe()
    gen = obs['snapshot_gen']
    in1 = element_at(obs, cb['x'] + 230, cb['y'] + 124, ('AXTextField',))
    focus, _ = run.act('act.type', text='', element_id=in1, snapshot_gen=gen)   # focus the input
    n = len(run.events())
    r1, reason1 = run.act('act.key', chord='cmd+a')
    time.sleep(0.3)
    r2, reason2 = run.act('act.type', text=REPLACED)
    time.sleep(0.6)
    meta_a = [e for e in since(n, 'keydown') if e.get('key') == 'a']
    res['modifiers'] = {'focused': bool(focus), 'key_ok': bool(r1), 'reasons': [reason1, reason2], 'replaced': run.field('in1') == REPLACED,
                        'a_keydown_with_meta': bool(meta_a) and all(e.get('meta') for e in meta_a)}

    # set_value (fresh snapshot: typing changed the field's value, so its fingerprint changed)
    obs = run.observe()
    gen = obs['snapshot_gen']
    in1 = element_at(obs, cb['x'] + 230, cb['y'] + 124, ('AXTextField',))
    r, reason = run.act('act.set_value', element_id=in1, value=SET_VALUE, snapshot_gen=gen)
    time.sleep(0.8)
    res['set_value'] = {'executed': bool(r), 'reason': reason, 'exact': run.field('in1') == SET_VALUE}

    # scroll
    mk = markers(obs)
    m4 = mk[4]
    signs = {}
    for direction in ('down', 'up'):
        n = len(run.events())
        r, reason = run.act('act.scroll', point={'x': m4['x'], 'y': m4['y'], 'space': 'screen'}, direction=direction,
                            snapshot_gen=gen)
        time.sleep(0.4)
        dys = [e['dy'] for e in since(n, 'wheel')]
        signs[direction] = {'executed': bool(r), 'reason': reason, 'wheel_events': len(dys), 'sum_dy': sum(dys)}
        if r is None:
            signs[direction]['windows_at_point'] = windows_at(m4['x'], m4['y'])
    res['scroll'] = {**signs, 'ok': signs['down']['sum_dy'] > 0 and signs['up']['sum_dy'] < 0}

    # drag
    a, b = mk[0], mk[4]
    n = len(run.events())
    r, reason = run.act('act.drag', **{'from': {'point': {'x': a['x'], 'y': a['y'], 'space': 'screen'}},
                                       'to': {'point': {'x': b['x'], 'y': b['y'], 'space': 'screen'}}}, snapshot_gen=gen)
    time.sleep(0.5)
    ups = since(n, 'mouseup')
    moves = [e['n'] for e in since(n, 'drag_moves')]
    err = math.hypot(ups[-1]['x'] - b['x'], ups[-1]['y'] - b['y']) if ups else None
    res['drag'] = {'executed': bool(r), 'reason': reason, 'mouseup_err_pt': round(err, 2) if err is not None else None,
                   'dragged_moves': moves[-1] if moves else 0,
                   'ok': err is not None and err <= 2 and bool(moves) and moves[-1] >= 5}

    # password field: nothing is ever typed into it (2026-09-29)
    obs = run.observe()
    gen = obs['snapshot_gen']
    pw1 = element_at(obs, cb['x'] + 560, cb['y'] + 124, ('AXTextField', 'AXSecureTextField'))
    pw = {'found': bool(pw1)}
    pw['type_element'] = run.act('act.type', text='hunter2', element_id=pw1, snapshot_gen=gen)[1]
    pw['set_value'] = run.act('act.set_value', value='hunter2', element_id=pw1, snapshot_gen=gen)[1]
    run.act('act.click', point={'x': cb['x'] + 560, 'y': cb['y'] + 124, 'space': 'screen'}, snapshot_gen=gen)  # real focus
    time.sleep(0.4)
    pw['type_focused'] = run.act('act.type', text='hunter2')[1]
    pw['key_focused'] = run.act('act.key', chord='a')[1]
    time.sleep(0.4)
    pw['value_after'] = run.field('pw1')
    # Move the focus away with a real click (an AX focus change left Chromium's secure input on), then type again.
    obs = run.observe()
    gen = obs['snapshot_gen']
    run.act('act.click', point={'x': cb['x'] + 230, 'y': cb['y'] + 124, 'space': 'screen'}, snapshot_gen=gen)
    time.sleep(0.6)
    r, reason = run.act('act.type', text=' ok')
    time.sleep(0.5)
    pw['typing_elsewhere_after'] = reason or 'executed'
    pw['ok'] = (pw['found'] and all(pw[k] == 'secure_input' for k in ('type_element', 'set_value', 'type_focused', 'key_focused'))
                and pw['value_after'] == '' and pw['typing_elsewhere_after'] == 'executed')
    res['password'] = pw

    # stale: move the window, then use the old snapshot's element by both paths
    old = mk[1]
    s = fx.state()['windows']['main']['bounds']
    fx.cmd('move', x=s['x'] + 40, y=s['y'] + 30, settle=0.8)
    n_ev, n_cl = len(run.events()), len(fx.clicks())
    reasons = [run.act('act.click', element_id=old['id'], snapshot_gen=gen, **kw)[1] for kw in ({}, {'via': 'event'})]
    time.sleep(0.4)
    reasons.append(run.act('act.click', point={'x': old['x'], 'y': old['y'], 'space': 'screen'}, snapshot_gen=gen)[1])
    time.sleep(0.4)
    res['stale'] = {'reasons': reasons, 'reached_fixture': len(since(n_ev, 'click')) + len(fx.clicks()[n_cl:]),
                    'ok': reasons[:2] == ['stale_element', 'stale_element'] and reasons[2] == 'stale_coordinates'}

    res['refusal_messages'] = run.refusals
    res['after_delay_retries'] = run.retries
    import shutil
    for name in ('events.jsonl', 'clicks.jsonl'):
        if (fx.dir / name).exists():
            shutil.copy(fx.dir / name, out / name)
    fx.stop()
    kill_all()
    passed = {
        'click_ax': res['click_ax']['ok'] == res['click_ax']['of'] == 9,
        'click_event': res['click_event']['ok'] == 9,
        'click_point': res['click_point']['ok'] == 9,
        'double': res['double']['dblclick_on_target'] == 1,
        'right': res['right']['contextmenu_on_target'] == 1,
        'type_long': res['type_long']['exact'],
        'type_multi': res['type_multi']['exact'],
        'modifiers': res['modifiers']['replaced'] and res['modifiers']['a_keydown_with_meta'],
        'set_value': res['set_value']['exact'],
        'scroll': res['scroll']['ok'],
        'drag': res['drag']['ok'],
        'stale': res['stale']['ok'] and res['stale']['reached_fixture'] == 0,
        'password': res['password']['ok'],
    }
    res['passed'] = passed
    res['all_passed'] = all(passed.values())
    (out / 'results.json').write_text(json.dumps(res, indent=2, ensure_ascii=False))
    print(json.dumps(passed), flush=True)
    for k, v in res.items():
        if k not in ('passed',):
            print(k, json.dumps(v, ensure_ascii=False)[:300], flush=True)


if __name__ == '__main__':
    main()
