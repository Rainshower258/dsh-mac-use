#!/usr/bin/env python3
"""The daemon's approval dialog (docs/desktop.md; added 2026-10-03), against the real daemon. Guest side; run
with run_vm_experiment.sh approval_dialog.py. Nobody answers the dialog here (a guest process cannot click it: that is
the point), so the person's buttons are checked on the host in the on-site session. Checks, fixed in advance:
  pending         access.request for "DSHFixture" (a name) answers pending with the resolved bundle ID and path
  dialog_shown    the daemon owns an on-screen window shortly after (the dialog)
  worker_free     while the dialog is open, another task's observe (which needs the main queue) answers within 10 s
  not_in_image    that observe lists no window of the daemon, and the composite is flat grey where the dialog is
  click_refused   act.click at the dialog's centre (over the granted fixture) is refused and the fixture got no click
  self_denied     access.request and grants.set for the daemon's own bundle ID are refused hard_denied
  busy            a request for another app while the dialog is open is refused approval_busy
  timeout         with no answer, access.status turns into approval_timeout after the 120 s, and the dialog is gone
  front_before    precondition: the fixture is frontmost before the request (a system alert in the clone, e.g.
                  UserNotificationCenter, makes focus_back and act_after meaningless; 2026-10-03 negative control)
  focus_back      the moment access.status reports the timeout, the app frontmost before the dialog is frontmost again
                  (the daemon is hard-denied: left frontmost, it stops the next action; 2026-10-03 QQ run). Polled
                  every 50 ms near the timeout, as the plugin does: macOS hands the focus back by itself a little
                  later, so a slow poll passes without the hand-back (2026-10-03 negative control)
  act_after       an act.click on the granted fixture sent at once is not refused hard_denied_frontmost
  asked_again     a timeout is not a refusal: the next request opens a dialog again
  sigterm_closes  SIGTERM while that dialog is open: the daemon exits within 10 s (the documented stop)
  audit           one access.decision line, answer timeout, focus restored
Writes <out>/results.json.
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
from collect import App, FIXTURE, cg_windows, decode, kill_all  # noqa: E402
from ax_manual_accessibility import Daemon, STATE  # noqa: E402

DAEMON = 'dev.cu-runtime.daemon'


def daemon_pids():
    out = subprocess.run(['pgrep', '-f', 'CURuntime.app/Contents/MacOS/'], capture_output=True, text=True).stdout
    return [int(x) for x in out.split()]


def call(d, method, params):
    """(result, None) or (None, refusal reason)."""
    try:
        return d.call(method, params), None
    except SystemExit as e:
        msg = str(e)
        return None, msg.split("'reason': '")[1].split("'")[0] if "'reason': '" in msg else msg[:200]


def dialog_windows(pid):
    ws = cg_windows(pid)
    return [w for w in ws if isinstance(w, dict) and w['bounds']['Width'] > 100] if isinstance(ws, list) else []


def frontmost():
    """The frontmost app's bundle ID (LaunchServices' view, as NSWorkspace sees it)."""
    asn = subprocess.run(['lsappinfo', 'front'], capture_output=True, text=True).stdout.strip()
    out = subprocess.run(['lsappinfo', 'info', '-only', 'bundleid', asn], capture_output=True, text=True).stdout
    return out.split('=', 1)[1].strip().strip('"').lower() if '=' in out else None


def audit_lines():
    out = []
    for f in sorted((STATE / 'audit').glob('audit-*.jsonl')):
        out += [json.loads(l) for l in f.read_text().splitlines() if l.strip()]
    return out


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
    d = Daemon()
    pid = daemon_pids()[0]
    # Dialogs come only in a turn the asking client marked (M4). Marked before the fixture starts: the app in front at
    # a turn's start is the task's host (dsh_host_app), which the fixture must not be.
    _, why0 = call(d, 'access.turn_start', {'task_id': 'dlg'})
    note['turn_start'] = why0 or 'ok'
    fx = App(out / 'fixture', x=0, y=30, w=1440, h=860)
    fx.ready()
    cb = fx.state()['windows']['main']['contentBounds']
    call(d, 'grants.set', {'task_id': 'cfg', 'bundle_ids': [FIXTURE], 'source': 'config'})

    note['front_before'] = frontmost()
    r, why = call(d, 'access.request', {'task_id': 'dlg', 'app': 'DSHFixture', 'mode': 'read',
                                        'reason': 'experiment: read the fixture', 'interactive': True})
    note['request'] = r or why
    chk['pending'] = bool(r) and r['status'] == 'pending' and r['app']['bundle_id'].lower() == FIXTURE
    rid = r['request_id'] if r else None

    wins = []
    for _ in range(20):
        time.sleep(0.25)
        wins = dialog_windows(pid)
        if wins:
            break
    # Measured once it has finished appearing: on macOS 26 the alert scales down from about 1.18x while it fades in, so
    # bounds taken mid-animation are larger than the window the observe below sees (2026-10-09: alpha 0.63, 614x451
    # against 520x381; the samples off the dialog were the fixture's own pixels).
    for _ in range(20):
        if not wins or min(w.get('alpha', 1) for w in wins) >= 0.99:
            break
        time.sleep(0.1)
        wins = dialog_windows(pid) or wins
    note['dialog_windows'] = wins
    # Whether the dialog made the daemon frontmost at all. Since macOS 14 activation is cooperative: without a person
    # clicking the dialog, NSApp.activate may not take the focus, and then focus_back cannot fail here (2026-10-03:
    # the negative control without the hand-back passed focus_back and act_after four times).
    note['front_during'] = frontmost()
    chk['dialog_shown'] = bool(wins)

    t0 = time.time()
    obs, why = call(d, 'observe', {'task_id': 'cfg', 'ocr': 'off', 'include_image': True})
    note['observe_ms_during_dialog'] = round((time.time() - t0) * 1000)
    chk['worker_free'] = obs is not None and note['observe_ms_during_dialog'] < 10_000
    note['dialog_windows_after_observe'] = dialog_windows(pid)  # diagnostics: the dialog may still be animating
    if obs and wins:
        b = wins[0]['bounds']
        decode(obs['image']).save(str(out / 'composite-during-dialog.png'))  # diagnostics (gitignored run dir)
        apps = {w['app'] for w in obs['windows']}
        note['observe_apps'] = sorted(apps)
        img, m = decode(obs['image']), obs['image']['mapping']
        x0, y0, w, h = m['display_bounds_pt']
        sw, sh = m['sent_size_px']
        px = lambda x, y: img.getpixel((int((x - x0) * sw / w), int((y - y0) * sh / h)))  # noqa: E731
        inset = 12
        samples = [px(b['X'] + inset + i * (b['Width'] - 2 * inset) / 6, b['Y'] + inset + j * (b['Height'] - 2 * inset) / 6)
                   for i in range(7) for j in range(7)]
        note['dialog_area_colours'] = sorted({str(s) for s in samples})
        chk['not_in_image'] = DAEMON not in {a.lower() for a in apps} and len(set(samples)) == 1

        cx, cy = b['X'] + b['Width'] / 2, b['Y'] + b['Height'] / 2
        before = len(fx.clicks())
        r2, why2 = call(d, 'act.click', {'task_id': 'cfg', 'app': FIXTURE, 'snapshot_gen': obs['snapshot_gen'],
                                         'point': {'x': cx, 'y': cy, 'space': 'screen'}})
        time.sleep(0.5)
        note['click_on_dialog'] = r2 or why2
        chk['click_refused'] = r2 is None and len(fx.clicks()) == before
    else:
        chk['not_in_image'] = chk['click_refused'] = False

    _, w1 = call(d, 'access.request', {'task_id': 'dlg', 'app': DAEMON, 'mode': 'read', 'interactive': True})
    _, w2 = call(d, 'grants.set', {'task_id': 'x', 'bundle_ids': [DAEMON], 'source': 'config'})
    note['self'] = [w1, w2]
    chk['self_denied'] = w1 == 'hard_denied' and w2 == 'hard_denied'

    _, w3 = call(d, 'access.request', {'task_id': 'dlg', 'app': 'com.apple.TextEdit', 'mode': 'read', 'interactive': True})
    note['busy'] = w3
    chk['busy'] = w3 == 'approval_busy'

    end, last = time.time() + 140, None
    while time.time() < end:
        s, why = call(d, 'access.status', {'task_id': 'dlg', 'request_id': rid})
        last = s or why
        if why:
            break
        time.sleep(2 if time.time() - t0 < 110 else 0.05)
    note['status_after_wait'] = last
    note['waited_s'] = round(time.time() - t0)
    # The answer goes out only after the hand-back, so this is already settled when the timeout is reported. The
    # click goes first, at once, on the snapshot taken during the dialog (the latest one): that is the race.
    chk['front_before'] = note['front_before'] == FIXTURE
    # A point of the fixture the dialog did not cover: in that snapshot the dialog's area is not the fixture's
    # (not_on_target_window, the first try of this check).
    px_, py_ = cb['x'] + 40, cb['y'] + cb['height'] - 40
    db = wins[0]['bounds'] if wins else None
    clear = db is not None and not (db['X'] <= px_ <= db['X'] + db['Width'] and db['Y'] <= py_ <= db['Y'] + db['Height'])
    note['act_after_point'] = [px_, py_]
    if obs and clear:
        before = len(fx.clicks())
        r5, why5 = call(d, 'act.click', {'task_id': 'cfg', 'app': FIXTURE, 'snapshot_gen': obs['snapshot_gen'],
                                         'point': {'x': px_, 'y': py_, 'space': 'screen'}})
        note['front_after'] = frontmost()
        time.sleep(0.5)
        note['act_after'] = r5 or why5
        chk['act_after'] = r5 is not None and len(fx.clicks()) == before + 1
    else:
        note['front_after'] = frontmost()
        note['act_after'] = 'no observe during the dialog, or the point is under the dialog'
        chk['act_after'] = False
    chk['focus_back'] = note['front_after'] == FIXTURE
    time.sleep(1)
    chk['timeout'] = last == 'approval_timeout' and not dialog_windows(pid)

    r4, why4 = call(d, 'access.request', {'task_id': 'dlg', 'app': FIXTURE, 'mode': 'read', 'interactive': True})
    time.sleep(1.5)
    chk['asked_again'] = bool(r4) and r4['status'] == 'pending' and bool(dialog_windows(pid))
    note['asked_again'] = r4 or why4

    decisions = [l for l in audit_lines() if l.get('method') == 'access.decision']
    note['decisions'] = decisions
    chk['audit'] = (len(decisions) == 1 and decisions[0].get('answer') == 'timeout'
                    and decisions[0].get('focus') == 'restored')

    os.kill(pid, signal.SIGTERM)
    gone = False
    for _ in range(40):
        time.sleep(0.25)
        if pid not in daemon_pids():
            gone = True
            break
    chk['sigterm_closes'] = gone

    fx.stop()
    res['ok'] = all(chk.values())
    (out / 'results.json').write_text(json.dumps(res, ensure_ascii=False, indent=2))
    print(json.dumps(chk, indent=2))
    return 0 if res['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
