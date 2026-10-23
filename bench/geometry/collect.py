#!/usr/bin/env python3
"""Geometry suite, guest side (runs inside a cu-base clone; see run_vm.sh).

Ground truth never comes from the pipeline under test: marker positions are Electron's own getContentBounds()
plus the renderer's layout (bench/fixture-app calibration mode), click landings are the fixture's mousedown
screenX/screenY, expected occlusion comes from the blocker's own bounds or Electron's workArea.

Four paths, each against that truth:
  A  markers detected in the NATIVE composite, mapped with the snapshot mapping -> global points
  B  AX frames of the marker buttons
  C  real cu_click at the A-derived point -> landing reported by the fixture
  D  markers detected in the DOWNSCALED (model) composite, mapped back -> global points
Pass (initial): A/B/C <= 2 pt; D <= one sent pixel in points.

Writes <out>/results.json (numbers only) and overlays for failing cases. Requires the daemon running with
config debug_native_images: true.
"""
import argparse
import base64
import io
import os
import json
import math
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

BENCH = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BENCH))
from vmguard import require_vm  # noqa: E402  (fail closed on the host)
from sysalert import system_prompt_in_front  # noqa: E402
sys.path.insert(0, str(BENCH / 'experiments'))
from ax_manual_accessibility import Daemon, approx_substring_distance  # noqa: E402

FIX_APP = BENCH / 'fixture-app/dist/DSHFixture.app'
BLK_APP = FIX_APP.parent / 'DSHBlocker.app'   # next to the fixture so the relative Resources/app link resolves
FIXTURE, BLOCKER = 'dev.dsh.bench.fixture', 'dev.dsh.bench.blocker'
CURSOR_LEVEL, SCREEN_SAVER_LEVEL = 2147483630, 1000   # CGWindowLevelForKey(.cursorWindow), NSScreenSaverWindowLevel
TASK = 'geom'
TOL_PT = 2.0


class SystemPromptInFront(RuntimeError):
    """A system prompt came up by itself before the suite acted: an environment failure (bench/sysalert.py)."""
MARKER_PT = 24


# ---------------------------------------------------------------- fixture control

def ensure_blocker_app():
    if BLK_APP.exists():
        return
    shutil.copytree(FIX_APP, BLK_APP, symlinks=True)
    plist = BLK_APP / 'Contents/Info.plist'
    for key, val in (('CFBundleIdentifier', BLOCKER), ('CFBundleName', 'DSHBlocker'), ('CFBundleDisplayName', 'DSHBlocker')):
        subprocess.run(['plutil', '-replace', key, '-string', val, str(plist)], check=True)
    subprocess.run(['codesign', '--force', '--deep', '--sign', '-', str(BLK_APP)], check=True, capture_output=True)


class App:
    def __init__(self, run_dir, role='fixture', x=200, y=150, w=800, h=500, frameless=False, label=None):
        self.dir = Path(run_dir)
        shutil.rmtree(self.dir, ignore_errors=True)
        self.dir.mkdir(parents=True)
        self.seq = 0
        bundle = BLK_APP if role == 'blocker' else FIX_APP
        args = [str(bundle / 'Contents/MacOS/Electron'), '--calibrate', '--role', role, '--run-dir', str(self.dir),
                '--x', str(x), '--y', str(y), '--w', str(w), '--h', str(h)] + (['--frameless'] if frameless else []) \
            + (['--label', label] if label else [])
        self.proc = subprocess.Popen(args, stdout=open(self.dir / 'app.log', 'w'), stderr=subprocess.STDOUT)
        self.role = role

    def state(self):
        try:
            return json.loads((self.dir / 'state.json').read_text())
        except (OSError, ValueError):
            return None

    def wait(self, cond, timeout=15, what='state'):
        end = time.time() + timeout
        while time.time() < end:
            s = self.state()
            if s and cond(s):
                return s
            time.sleep(0.1)
        raise RuntimeError(f'{self.role}: timed out waiting for {what}')

    def ready(self, wins=('main',)):
        need = 0 if self.role == 'blocker' else 9
        return self.wait(lambda s: all(w in s['windows'] and s['windows'][w]['visible']
                                       and len(s['windows'][w]['markers']) >= need for w in wins), what='markers')

    def cmd(self, op, settle=0.8, **kw):
        self.seq += 1
        tmp = self.dir / 'cmd.json.tmp'
        tmp.write_text(json.dumps({'seq': self.seq, 'op': op, **kw}))
        tmp.rename(self.dir / 'cmd.json')
        s = self.wait(lambda s: s.get('lastSeq', -1) >= self.seq, timeout=8, what=f'ack of {op}')
        if not s['lastResult'].get('ok'):
            raise RuntimeError(f'{op} failed: {s["lastResult"]}')
        time.sleep(settle)
        return self.state()

    def clicks(self):
        f = self.dir / 'clicks.jsonl'
        return [json.loads(l) for l in f.read_text().splitlines()] if f.exists() else []

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


CG_JXA = '''ObjC.import('CoreGraphics'); ObjC.import('Foundation'); ObjC.import('AppKit');
function run(argv) {
  const all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)));
  if (argv[0] == 'warp') $.CGWarpMouseCursorPosition({x: Number(argv[1]), y: Number(argv[2])});
  if (argv[0] == 'pointer' || argv[0] == 'warp') { const p = $.NSEvent.mouseLocation; return JSON.stringify({x: p.x, y_from_bottom: p.y}); }
  return JSON.stringify(all.filter(w => argv[0] == 'all' || w.kCGWindowOwnerPID == Number(argv[0]))
    .map(w => ({alpha: w.kCGWindowAlpha, layer: w.kCGWindowLayer, bounds: w.kCGWindowBounds, id: w.kCGWindowNumber,
                owner: argv[0] == 'all' ? w.kCGWindowOwnerName : undefined, pid: w.kCGWindowOwnerPID})));
}'''


def cg_windows(pid, *args):
    """The window server's view of a process's on-screen windows (alpha, layer, bounds), or of all of them (pid
    None, with owners), or the pointer position (pid 'pointer'; 'warp', x, y moves it there first): diagnostics."""
    arg = 'all' if pid is None else str(pid)
    r = subprocess.run(['osascript', '-l', 'JavaScript', '-e', CG_JXA, arg, *map(str, args)], capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except ValueError:
        return {'error': (r.stderr or r.stdout).strip()[:200]}


def kill_all():
    pats = ['DSHFixture.app/Contents/MacOS/Electron', 'DSHBlocker.app/Contents/MacOS/Electron']
    for p in pats:
        subprocess.run(['pkill', '-f', p], capture_output=True)
    for _ in range(50):   # wait until they are really gone, or the next case sees their windows
        if all(subprocess.run(['pgrep', '-f', p], capture_output=True).returncode != 0 for p in pats):
            break
        time.sleep(0.1)
    time.sleep(0.5)


def coverage(t, rect, margin=2):
    """'full' if the whole 24 pt marker lies inside rect, 'partial' if they overlap, else 'none'."""
    h = MARKER_PT / 2
    x0, y0, x1, y1 = t['x'] - h, t['y'] - h, t['x'] + h, t['y'] + h
    rx0, ry0, rx1, ry1 = rect['x'], rect['y'], rect['x'] + rect['width'], rect['y'] + rect['height']
    if x0 >= rx0 + margin and y0 >= ry0 + margin and x1 <= rx1 - margin and y1 <= ry1 - margin:
        return 'full'
    return 'partial' if x1 > rx0 and x0 < rx1 and y1 > ry0 and y0 < ry1 else 'none'


def split_hidden(truth, rect, kind='other'):
    """Markers fully under rect -> expected hidden; partly covered ones are ambiguous and not judged."""
    hidden = {(m['win'], m['id']): kind for m in truth if coverage(m, rect) == 'full'}
    ambiguous = {(m['win'], m['id']) for m in truth if coverage(m, rect) == 'partial'}
    return hidden, ambiguous


def truth_markers(state, wins=None):
    out = []
    for name, w in state['windows'].items():
        if wins and name not in wins:
            continue
        for m in w['markers']:
            out.append({'win': name, 'id': m['id'], 'x': m['x'], 'y': m['y']})
    return out


# ---------------------------------------------------------------- detection

def decode(img_json):
    return Image.open(io.BytesIO(base64.b64decode(img_json['base64']))).convert('RGB')


def blobs_of(obs, key):
    """No capturable window (e.g. all minimized) means no image, which means nothing can be detected."""
    img = obs.get(key)
    return detect(decode(img), img['mapping']) if img else []


def to_pt(mapping, px, py):
    x0, y0, w, h = mapping['display_bounds_pt']
    sw, sh = mapping['sent_size_px']
    return x0 + px * w / sw, y0 + py * h / sh


def detect(img, mapping):
    """Saturated blobs classified by hue (9 hues, 40 degrees apart) -> [{id, x, y, area}] in global points."""
    a = np.asarray(img).astype(np.float32) / 255.0
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a.max(-1), a.min(-1)
    d = mx - mn + 1e-6
    sat, val = d / (mx + 1e-6), mx
    hue = np.where(mx == r, (g - b) / d % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60.0
    mask = (sat > 0.55) & (val > 0.3)
    k = np.rint(hue / 40.0).astype(int) % 9
    close = np.abs(((hue - k * 40.0) + 180) % 360 - 180) <= 18
    scale = mapping['sent_size_px'][0] / mapping['display_bounds_pt'][2]   # px per point
    min_area = (MARKER_PT * scale) ** 2 * 0.25
    blobs = []
    for cls in range(9):
        ys, xs = np.nonzero(mask & close & (k == cls))
        todo = set(zip(ys.tolist(), xs.tolist()))
        while todo:
            seed = todo.pop()
            comp, stack = [seed], [seed]
            while stack:
                y, x = stack.pop()
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        n = (y + dy, x + dx)
                        if n in todo:
                            todo.remove(n)
                            comp.append(n)
                            stack.append(n)
            if len(comp) >= min_area:
                cy = sum(p[0] for p in comp) / len(comp) + 0.5
                cx = sum(p[1] for p in comp) / len(comp) + 0.5
                px, py = to_pt(mapping, cx, cy)
                blobs.append({'id': cls, 'x': px, 'y': py, 'area': len(comp)})
    return blobs


def nearest(items, t, same_id=True):
    c = [i for i in items if not same_id or i['id'] == t['id']]
    if not c:
        return None, math.inf
    best = min(c, key=lambda i: (i['x'] - t['x']) ** 2 + (i['y'] - t['y']) ** 2)
    return best, math.hypot(best['x'] - t['x'], best['y'] - t['y'])


def owned_by(blobs, t, truth):
    """Blobs of t's colour whose nearest same-colour truth marker is t (several windows share colours)."""
    same = [m for m in truth if m['id'] == t['id']]
    return [b for b in blobs if b['id'] == t['id']
            and min(same, key=lambda m: (m['x'] - b['x']) ** 2 + (m['y'] - b['y']) ** 2) is t]


def ax_markers(obs):
    out = []
    for e in obs['untrusted_observation']['elements']:
        if e['source'] != 'ax' or e.get('role') != 'AXButton' or not e.get('frame_pt'):
            continue
        for i in range(9):
            if f'marker {i}' in e['text']:
                x, y, w, h = e['frame_pt']
                out.append({'id': i, 'x': x + w / 2, 'y': y + h / 2, 'element': e['id'], 'occluded': e['occluded']})
    return out


# ---------------------------------------------------------------- measuring

class StaleSnapshot(Exception):
    pass


class Suite:
    def __init__(self, out):
        self.d = Daemon()
        self.d.call('grants.set', {'task_id': TASK, 'bundle_ids': [FIXTURE], 'source': 'config', 'expires_in_s': 3600})
        self.out = Path(out)
        self.out.mkdir(parents=True, exist_ok=True)
        self.results = []
        self.launch_waits = []
        self.overlay_retries = 0   # clicks retried after overlay_state_unknown
        self.daemon_waits = []   # the daemon's own bounded wait for new windows (WindowAppearWait), in ms
        self.wait_reasons = {'not_running': 0, 'no_window': 0}   # harness polls, by what the daemon saw

    def observe(self):
        obs = self.d.call('observe', {'task_id': TASK, 'ocr': 'off', 'include_image': True, 'debug_native_image': True})
        # The z-order the composite was drawn from, front to back: who a grey block belongs to (failures only).
        self.last_zorder = obs.get('debug_zorder')
        return obs

    def _append(self, rec):
        if not rec['ok']:
            rec['zorder_at_last_observe'] = getattr(self, 'last_zorder', None)
            rec['cg_windows_now'] = cg_windows(None)
        self.results.append(rec)

    def wait_listed(self, timeout=5.0):
        """The fixture reporting its window visible does not mean the window server lists it yet: the daemon saw
        no window for up to ~2 s after 3-4 of 24 launches per config (2026-09-29), which failed pos-top-left
        intermittently. The suite measures geometry, not launch latency, so it waits for the daemon to see the
        window; the waits are reported in meta.launch_wait_s."""
        t0 = time.time()
        while True:
            obs = self.d.call('observe', {'task_id': TASK, 'ocr': 'off', 'include_image': False})
            ww = obs.get('capture', {}).get('window_wait')
            if ww:
                self.daemon_waits.append(ww['elapsed_ms'])
            if any(w['app'] == FIXTURE for w in obs['windows']):
                self.launch_waits.append(round(time.time() - t0, 2))
                return
            # Why not yet: the daemon does not see the app as running, or sees it but lists no window.
            self.wait_reasons['not_running' if FIXTURE not in obs.get('apps', []) else 'no_window'] += 1
            if time.time() - t0 > timeout:
                raise RuntimeError(f'daemon did not list the fixture window within {timeout}s')
            time.sleep(0.1)

    def click(self, x, y, gen, element=None):
        """overlay_state_unknown (the Dock did not answer, e.g. while animating a launch) is transient by design: retry
        like a client should, a few times, and count it."""
        p = {'task_id': TASK, 'app': FIXTURE, 'snapshot_gen': gen}
        if element:
            p['element_id'] = element
        else:
            p['point'] = {'x': x, 'y': y, 'space': 'screen'}
        for attempt in range(7):
            try:
                return self.d.call('act.click', p), None
            except SystemExit as e:
                msg = str(e)
                self.last_refusal = msg[:600]
                reason = msg.split("'reason': '")[1].split("'")[0] if "'reason': '" in msg else msg[:80]
                if reason != 'overlay_state_unknown' or attempt == 6:
                    return None, reason
                self.overlay_retries += 1
                time.sleep(0.5)

    def measure(self, name, fx, truth, *args, **kw):
        """A stale_coordinates refusal means the window moved (e.g. the system repositioned it on focus). A correct
        client observes again and redoes everything against the fresh snapshot and fresh truth -- never mixes old
        coordinates with a new snapshot_gen. Up to 2 redos; the count is reported."""
        keys = {(t['win'], t['id']) for t in truth}
        for retries in range(3):
            try:
                return self._measure(name, fx, truth, *args, retries=retries, **kw)
            except StaleSnapshot:
                truth = [m for m in truth_markers(fx.state()) if (m['win'], m['id']) in keys]
        return self._measure(name, fx, truth, *args, retries=3, click=False, **{k: v for k, v in kw.items() if k != 'click'})

    def _measure(self, name, fx, truth, expect_hidden=None, click=True, extra=None, skip=(), no_click=(), retries=0):
        """expect_hidden: {(win, id): 'other'|'same'} markers that must NOT be seen. 'other' (another app's window
        or off-screen) must also refuse a click at that point; 'same' (the app's own sheet/window on top) must be
        flagged occluded but a click there legitimately targets the covering window, so it is not clicked.
        skip: ambiguous markers (partly covered) that are not judged. no_click: markers not clicked (e.g. the
        parent of an app-modal sheet, which by design receives no clicks)."""
        expect_hidden = expect_hidden or {}
        if os.environ.get('OVERLAYS') == 'all' and retries == 0:
            self.review(name, fx, truth)   # before any click: clicks focus (raise) the target window
        all_truth = truth
        truth = [t for t in truth if (t['win'], t['id']) not in skip]
        obs = self.observe()
        native, sent = obs.get('debug_native_image'), obs.get('image')
        if not native or not sent:
            # Still a failure; the diagnosis only says whether it was transient and whether LaunchServices knew the
            # fixture's pid (the daemon maps CG window owners to bundle IDs through it).
            pid = fx.proc.pid
            ls = subprocess.run(['lsappinfo', 'info', '-only', 'bundleid', str(pid)], capture_output=True, text=True)
            later = {}
            for at, pause in (('1s', 1), ('3s', 2)):
                time.sleep(pause)
                o = self.observe()
                later[at] = {'windows': len(o['windows']), 'image': bool(o.get('image'))}
            diag = {'fixture_pid': pid, 'lsappinfo': ls.stdout.strip() or ls.stderr.strip(), 'reobserve': later}
            rec = {'name': name, 'ok': False, 'paths': {}, 'checks': [{'check': 'capture', 'ok': False,
                   'detail': json.dumps(obs.get('capture'))[:300]}], 'windows': obs['windows'], 'diag': diag,
                   **(extra or {})}
            self._append(rec)
            print(f"FAIL {name} no image: {rec['checks'][0]['detail']} diag={json.dumps(diag)}", flush=True)
            return rec, obs
        a_blobs = blobs_of(obs, 'debug_native_image')
        d_blobs = blobs_of(obs, 'image')
        axs = ax_markers(obs)
        d_tol = sent['mapping']['display_bounds_pt'][2] / sent['mapping']['sent_size_px'][0]
        paths = {p: [] for p in 'ABCD'}
        checks = []
        c_detail = []
        for t in truth:
            key = (t['win'], t['id'])
            a, ea = nearest(a_blobs, t)
            _, ed = nearest(d_blobs, t)
            b, eb = nearest(axs, t)
            if key in expect_hidden:
                _, ea_own = nearest(owned_by(a_blobs, t, all_truth), t)
                _, ed_own = nearest(owned_by(d_blobs, t, all_truth), t)
                seen = ea_own <= 20 or ed_own <= 20
                checks.append({'check': f'hidden {key}', 'ok': not seen, 'detail': f'nearest own native blob {ea_own:.1f}pt'})
                if b is not None and eb <= 20 and not b['occluded']:
                    checks.append({'check': f'ax occluded flag {key}', 'ok': False, 'detail': 'AX element not flagged occluded'})
                if click and expect_hidden[key] == 'other':
                    res, reason = self.click(t['x'], t['y'], obs['snapshot_gen'])
                    checks.append({'check': f'click refused {key}', 'ok': res is None, 'detail': reason or 'EXECUTED'})
                continue
            paths['A'].append(ea)
            paths['D'].append(ed)
            paths['B'].append(eb)
            if click and a is not None and key not in no_click:
                before = len(fx.clicks())
                res, reason = self.click(a['x'], a['y'], obs['snapshot_gen'])
                if reason == 'stale_coordinates':
                    raise StaleSnapshot()
                time.sleep(0.15)
                landed = fx.clicks()[before:]
                if res is None or not landed:
                    paths['C'].append(math.inf)
                    checks.append({'check': f'click {key}', 'ok': False,
                                   'detail': f'{reason}: {self.last_refusal[-200:]}' if reason else 'no landing logged'})
                else:
                    c = landed[-1]
                    paths['C'].append(math.hypot(c['screenX'] - t['x'], c['screenY'] - t['y']))
                    c_detail.append({'marker': list(key), 'truth': [round(t['x'], 2), round(t['y'], 2)],
                                     'clicked': [round(a['x'], 2), round(a['y'], 2)], 'landed': [c['screenX'], c['screenY']],
                                     'quantized': c.get('quantized')})
                    if c.get('target') != f"m{t['id']}":
                        checks.append({'check': f'click target {key}', 'ok': False, 'detail': f"landed on {c.get('target')}"})
        limits = {'A': TOL_PT, 'B': TOL_PT, 'C': TOL_PT, 'D': d_tol}
        summary = {}
        for p, errs in paths.items():
            if not errs:
                continue
            fin = [e for e in errs if math.isfinite(e)]
            summary[p] = {'n': len(errs), 'missing': len(errs) - len(fin), 'max': round(max(errs), 2) if fin else None,
                          'median': round(statistics.median(fin), 2) if fin else None, 'limit': round(limits[p], 2),
                          'ok': len(fin) == len(errs) and max(fin) <= limits[p]}
        ok = all(s['ok'] for s in summary.values()) and all(c['ok'] for c in checks)
        rec = {'name': name, 'ok': ok, 'paths': summary, 'checks': [c for c in checks if not c['ok']] or 'all passed',
               'windows': obs['windows'], 'desktop_scale': native['mapping']['point_pixel_scale'], 'c_detail': c_detail,
               'stale_retries': retries,
               **(extra or {})}
        if not ok:
            self.overlay(name, sent, truth, d_blobs, axs)

        self._append(rec)
        print(f"{'PASS' if ok else 'FAIL'} {name} " + ' '.join(f"{p}:{s['max']}" for p, s in summary.items()), flush=True)
        return rec, obs

    def overlay(self, name, sent, truth, blobs, axs):
        img = decode(sent)
        dr = ImageDraw.Draw(img)
        k = sent['mapping']['sent_size_px'][0] / sent['mapping']['display_bounds_pt'][2]
        x0, y0 = sent['mapping']['display_bounds_pt'][:2]
        for t in truth:
            x, y = (t['x'] - x0) * k, (t['y'] - y0) * k
            dr.line([(x - 6, y), (x + 6, y)], fill=(0, 255, 0), width=2)
            dr.line([(x, y - 6), (x, y + 6)], fill=(0, 255, 0), width=2)
        for bl in blobs:
            x, y = (bl['x'] - x0) * k, (bl['y'] - y0) * k
            dr.ellipse([x - 5, y - 5, x + 5, y + 5], outline=(255, 0, 0), width=2)
        for a in axs:
            x, y = (a['x'] - x0) * k, (a['y'] - y0) * k
            dr.rectangle([x - 4, y - 4, x + 4, y + 4], outline=(0, 0, 255), width=2)
        img.save(self.out / f'overlay-{name}.png')

    def review(self, name, fx, truth):
        """For manual review (OVERLAYS=all): every element box the daemon reports, on the native composite, taken
        before the scenario clicks. AX frames blue, OCR frames orange, occluded ones thin; ground-truth marker centres
        as green crosses. Two pixel-only text lines are added to the main window so OCR boxes show too."""
        fx.cmd('lines', lines=[{'id': 90, 'text': 'OCR review line 复核 0123', 'x': 90, 'y': 70, 'size': 15, 'ax': False},
                               {'id': 91, 'text': 'second line 第二行 ABC', 'x': 90, 'y': 100, 'size': 13, 'ax': False}],
               settle=0.6)
        obs = self.d.call('observe', {'task_id': TASK, 'ocr': 'on', 'include_image': True, 'debug_native_image': True})
        native = obs['debug_native_image']
        img = decode(native).convert('RGB')
        dr = ImageDraw.Draw(img)
        s = native['mapping']['point_pixel_scale']
        x0, y0 = native['mapping']['display_bounds_pt'][:2]
        for e in obs['untrusted_observation']['elements']:
            if not e.get('frame_pt'):
                continue
            x, y, w, h = e['frame_pt']
            box = [(x - x0) * s, (y - y0) * s, (x - x0 + w) * s, (y - y0 + h) * s]
            colour = (0, 90, 255) if e['source'] == 'ax' else (255, 140, 0)
            dr.rectangle(box, outline=colour, width=1 if e['occluded'] else max(2, int(s)))
        for t in truth:
            x, y = (t['x'] - x0) * s, (t['y'] - y0) * s
            dr.line([(x - 10, y), (x + 10, y)], fill=(0, 200, 0), width=2)
            dr.line([(x, y - 10), (x, y + 10)], fill=(0, 200, 0), width=2)
        img.save(self.out / f'review-{name}.png')

    def record(self, name, ok, **info):
        self._append({'name': name, 'ok': ok, **info})
        print(f"{'PASS' if ok else 'FAIL'} {name} {info}", flush=True)

    def save(self, meta):
        (self.out / 'results.json').write_text(json.dumps({'meta': meta, 'results': self.results}, indent=2))


# ---------------------------------------------------------------- scenarios

def inside(t, b):
    return b['x'] <= t['x'] <= b['x'] + b['width'] and b['y'] <= t['y'] <= b['y'] + b['height']


def run(suite, only=None):
    runs = Path('/tmp/geom-apps')
    disp = None

    def fixture(**kw):
        kill_all()
        fx = App(runs / 'fx', **kw)
        s = fx.ready()
        suite.wait_listed()
        return fx, s

    def want(name):
        return only is None or any(name.startswith(o) for o in only)

    # 1 window positions and sizes
    fx, s = fixture()
    if (prompt := system_prompt_in_front()):   # it may come up a few seconds into the session
        raise SystemPromptInFront(prompt)
    disp = s['displays'][0]
    W, H = disp['bounds']['width'], disp['bounds']['height']
    wa = disp['workArea']
    cases = [('pos-top-left', wa['x'], wa['y'], 700, 450), ('pos-center', (W - 700) // 2, (H - 450) // 2, 700, 450),
             ('pos-bottom-right', W - 700, wa['y'] + wa['height'] - 450, 700, 450), ('size-small', 300, 200, 360, 260),
             ('size-large', 40, wa['y'] + 10, W - 80, wa['height'] - 80)]   # fits the visible area incl. title bar
    for name, x, y, w, h in cases:
        if want(name):
            fx, s = fixture(x=x, y=y, w=w, h=h)
            suite.measure(name, fx, truth_markers(s))
    if want('pos-partly-offscreen'):
        fx, s = fixture(x=W - 400, y=200, w=700, h=450)
        t = truth_markers(s)
        hidden, amb = split_hidden(t, {'x': W, 'y': -10000, 'width': 100000, 'height': 100000})
        suite.measure('pos-partly-offscreen', fx, t, expect_hidden=hidden, skip=amb)

    # A window taller than the visible area: macOS may move it when it is focused for the click. Safety property:
    # every click either lands on the intended marker or is refused (stale_coordinates) -- never elsewhere.
    if want('oversize-focus'):
        fx, s = fixture(x=40, y=wa['y'], w=W - 80, h=wa['height'] + 60)
        # macOS may reposition this window at any time after launch, not only on focus. Truth must describe the
        # window as it is in the snapshot: re-read it after observing and require the snapshot's frame to match
        # the fixture's own bounds (2026-09-29: truth read before a move made the suite click stale points).
        for truth_reads in range(1, 4):
            obs = suite.observe()
            s = fx.state()
            fr = next((w['frame_pt'] for w in obs['windows'] if w['app'] == FIXTURE), None)
            b = s['windows']['main']['bounds']
            if fr and all(abs(a - c) <= 1 for a, c in zip(fr, (b['x'], b['y'], b['width'], b['height']))):
                break
            time.sleep(0.5)
        outcomes = []
        for t in truth_markers(s):
            before = len(fx.clicks())
            res, reason = suite.click(t['x'], t['y'], obs['snapshot_gen'])
            time.sleep(0.15)
            landed = fx.clicks()[before:]
            if res is None:
                outcomes.append(('refused', reason))
            elif landed and landed[-1].get('target') == f"m{t['id']}":
                outcomes.append(('landed_ok', None))
            else:
                outcomes.append(('WRONG', landed[-1].get('target') if landed else 'nothing'))
        wrong = [o for o in outcomes if o[0] == 'WRONG']
        suite.record('oversize-focus', not wrong, landed_ok=sum(o[0] == 'landed_ok' for o in outcomes),
                     refused=sorted({o[1] for o in outcomes if o[0] == 'refused'}), wrong=wrong, truth_reads=truth_reads)

    # 2 window forms
    if want('form-frameless'):
        fx, s = fixture(x=300, y=200, w=700, h=450, frameless=True)
        suite.measure('form-frameless', fx, truth_markers(s))
    if want('form-two-windows'):
        fx, _ = fixture(x=80, y=120, w=600, h=400)
        fx.cmd('open', name='second', x=720, y=300, w=600, h=400)
        s = fx.ready(('main', 'second'))
        suite.measure('form-two-windows', fx, truth_markers(s))
    if want('form-sheet'):
        fx, _ = fixture(x=300, y=150, w=800, h=500)
        fx.cmd('sheet', settle=1.5)
        s = fx.ready(('main', 'sheet'))
        sheet = s['windows']['sheet']['bounds']
        t = truth_markers(s)
        # The sheet covers part of the main window: those markers must be hidden (by the app's own window). The
        # sheet is app-modal, so the parent window receives no clicks at all: its markers are not clicked.
        mains = [m for m in t if m['win'] == 'main']
        hidden, amb = split_hidden(mains, sheet, kind='same')
        suite.measure('form-sheet', fx, t, expect_hidden=hidden, skip=amb,
                      no_click={(m['win'], m['id']) for m in mains})
    if want('form-context-menu'):
        fx, _ = fixture(x=300, y=150, w=800, h=500)
        fx.cmd('contextMenu', x=200, y=150, settle=1.0)
        obs = suite.observe()
        menus = [w for w in obs['windows'] if w['app'] == FIXTURE and w['frame_pt'][2] < 400 and w['frame_pt'][3] < 200]
        img = decode(obs['debug_native_image'])
        drawn = False
        if menus:
            m = menus[0]['frame_pt']
            sc = obs['debug_native_image']['mapping']['point_pixel_scale']
            crop = np.asarray(img.crop((int(m[0] * sc) + 4, int(m[1] * sc) + 4, int((m[0] + m[2]) * sc) - 4, int((m[1] + m[3]) * sc) - 4)))
            drawn = crop.size > 0 and float(crop.std()) > 5   # a real menu has text; a grey block is flat
        suite.record('form-context-menu', bool(menus) and drawn, menu_windows=len(menus), menu_drawn_not_blocked=drawn)
        suite.d.call('act.key', {'task_id': TASK, 'app': FIXTURE, 'chord': 'escape'})

    # 3 occlusion by a non-granted window, 5 composite with several windows
    if want('occlusion'):
        fx, _ = fixture(x=150, y=150, w=800, h=500)
        blk = App(runs / 'blk', role='blocker', x=600, y=250, w=400, h=300)
        b = blk.ready()['windows']['main']['bounds']
        fx.cmd('focus', settle=0.3)
        blk.cmd('focus', settle=0.8)          # blocker in front
        s = fx.state()
        t = truth_markers(s)
        hidden, amb = split_hidden(t, b)
        rec, obs = suite.measure('occlusion', fx, t, expect_hidden=hidden, skip=amb, click=True)
        # The blocker area in the composite must be the flat grey block, never the blocker's own pixels (#303030).
        sc = obs['debug_native_image']['mapping']['point_pixel_scale']
        crop = np.asarray(decode(obs['debug_native_image']).crop((int((b['x'] + 10) * sc), int((b['y'] + 10) * sc),
                                                                 int((b['x'] + b['width'] - 10) * sc), int((b['y'] + b['height'] - 10) * sc))))
        leak = float(np.abs(crop.astype(int) - 48).max(-1).mean()) < 20   # close to #303030 = blocker pixels leaked
        flat = float(crop.std()) < 3
        suite.record('occlusion-block-is-flat', flat and not leak, flat=flat, blocker_pixels_leaked=leak)
        blk.stop()
    # Audit L3: a non-granted window with alpha 0 floating above the target (utility overlays do this). The CG
    # window list skips alpha-0 windows, so the CG hit test alone would miss one that takes clicks; the AX hit test
    # (window server routing) catches it and the disagreement refuses the click.
    #   occlusion-invisible:              the overlay catches clicks -> every click refused, none intercepted.
    #   occlusion-invisible-clickthrough: positive control, the overlay ignores the mouse -> every click lands on
    #                                     its marker (a daemon that refused anything near an alpha-0 window fails).
    for name, catch in (('occlusion-invisible', True), ('occlusion-invisible-clickthrough', False)):
        if not want(name):
            continue
        fx, _ = fixture(x=150, y=150, w=800, h=500)
        blk = App(runs / 'blk', role='blocker', x=500, y=120, w=520, h=600)   # right two marker columns
        b = blk.ready()['windows']['main']['bounds']
        blk.cmd('alwaysOnTop', on=True, settle=0.3)
        blk.cmd('opacity', value=0, catchMouse=catch, settle=0.8)
        fx.cmd('focus', settle=0.8)            # the target is frontmost; the invisible overlay floats above it
        t = truth_markers(fx.state())
        under, _ = split_hidden(t, b)
        cg = cg_windows(blk.proc.pid)
        obs = suite.observe()
        outcomes, refusals = [], []
        for m in (m for m in t if (m['win'], m['id']) in under):
            before_fx, before_blk = len(fx.clicks()), len(blk.clicks())
            res, reason = suite.click(m['x'], m['y'], obs['snapshot_gen'])
            time.sleep(0.2)
            on_fx, on_blk = fx.clicks()[before_fx:], blk.clicks()[before_blk:]
            if res is None:
                outcomes.append(('refused', reason))
                refusals.append(suite.last_refusal)
            elif on_blk:
                outcomes.append(('WRONG', 'intercepted by the invisible window'))
            elif on_fx and on_fx[-1].get('target') == f"m{m['id']}":
                outcomes.append(('landed_ok', None))
            else:
                outcomes.append(('WRONG', on_fx[-1].get('target') if on_fx else 'landed nowhere'))
        wrong = [o for o in outcomes if o[0] == 'WRONG']
        landed = sum(o[0] == 'landed_ok' for o in outcomes)
        setup_ok = len(cg) == 1 and cg[0].get('alpha') == 0 and len(outcomes) >= 4
        # Refusals name the interceptor; the next observe flags the markers under it (lazy occlusion).
        named = sum(f"'intercepted_by': '{BLOCKER}'" in r for r in refusals)
        after = suite.observe()
        under_ids = {m['id'] for m in t if (m['win'], m['id']) in under}
        flagged = sum(1 for e in after['untrusted_observation']['elements']
                      if e['source'] == 'ax' and e.get('role') == 'AXButton' and e.get('intercepted_by') == BLOCKER
                      and e.get('occluded') and any(f'marker {i}' in e.get('text', '') for i in under_ids))
        expected = (landed == 0 and named == len(outcomes) and flagged == len(outcomes)) if catch \
            else (landed == len(outcomes) and flagged == 0)
        suite.record(name, setup_ok and not wrong and expected,
                     markers_under=len(outcomes), landed_ok=landed, refusals_naming_interceptor=named,
                     flagged_after=flagged,
                     refused=sorted({o[1] for o in outcomes if o[0] == 'refused'}),
                     intercepted=sum(o[1] == 'intercepted by the invisible window' for o in wrong), wrong=wrong,
                     overlay_cg=cg, refusal_details=refusals[:2])
        blk.stop()
    # A non-granted window at the cursor level (any app can set it): only the Window Server's own pointer window is
    # left out of the window order, so this one must still cover the target and every click under it is refused.
    if want('occlusion-cursor-level'):
        fx, _ = fixture(x=150, y=150, w=800, h=500)
        blk = App(runs / 'blk', role='blocker', x=500, y=120, w=520, h=600)
        blk.ready()
        blk.cmd('alwaysOnTop', on=True, level='screen-saver', relative=CURSOR_LEVEL - SCREEN_SAVER_LEVEL, settle=0.5)
        fx.cmd('focus', settle=0.8)
        t = truth_markers(fx.state())
        b = blk.state()['windows']['main']['bounds']
        under, _ = split_hidden(t, b)
        cg = cg_windows(blk.proc.pid)
        obs = suite.observe()
        outcomes = []
        for m in (m for m in t if (m['win'], m['id']) in under):
            before_fx, before_blk = len(fx.clicks()), len(blk.clicks())
            res, reason = suite.click(m['x'], m['y'], obs['snapshot_gen'])
            time.sleep(0.2)
            landed = len(fx.clicks()) - before_fx + len(blk.clicks()) - before_blk
            outcomes.append(reason if res is None else f'EXECUTED (landed {landed})')
        setup_ok = len(cg) == 1 and cg[0].get('layer') == CURSOR_LEVEL
        # The window list itself must show the cover (not_on_target_window): the AX hit test would also refuse, but
        # the CG side must not depend on it.
        suite.record('occlusion-cursor-level', setup_ok and len(outcomes) >= 4 and all(o == 'not_on_target_window' for o in outcomes),
                     markers_under=len(outcomes), outcomes=sorted(set(outcomes)), overlay_cg=cg)
        blk.stop()
    if want('composite'):
        fx, _ = fixture(x=60, y=100, w=600, h=400)
        fx.cmd('open', name='second', x=700, y=250, w=600, h=400)
        s = fx.ready(('main', 'second'))
        blk = App(runs / 'blk', role='blocker', x=1150, y=250, w=250, h=310)   # fully over two markers, clear of the rest
        b = blk.ready()['windows']['main']['bounds']
        blk.cmd('focus', settle=0.8)
        t = truth_markers(fx.state())
        hidden, amb = split_hidden(t, b)
        suite.measure('composite', fx, t, expect_hidden=hidden, skip=amb, extra={'hidden_expected': len(hidden)})
        blk.stop()

    # Pixel-boundary regression: text in a non-granted window must never reach OCR output, the composites or
    # the daemon's logs. A positive control in the granted window proves OCR would have read such text.
    if want('leak'):
        import secrets
        alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'   # no 0/O, 1/I/L look-alikes
        canary = 'LEAKCANARY' + ''.join(secrets.choice(alphabet) for _ in range(8))
        posctrl = 'POSCTRL' + ''.join(secrets.choice(alphabet) for _ in range(8))
        # LEAK_SELFTEST=1 puts the canary in the GRANTED window: a simulated leak the test must catch.
        selftest = os.environ.get('LEAK_SELFTEST') == '1'
        fx, _ = fixture(x=150, y=150, w=800, h=500, label=(posctrl + ' ' + canary) if selftest else posctrl)
        blk = App(runs / 'blk', role='blocker', x=450, y=330, w=640, h=220, label=None if selftest else canary)
        blk.ready()
        blk.cmd('focus', settle=1.0)
        obs = suite.d.call('observe', {'task_id': TASK, 'ocr': 'on', 'include_image': True, 'debug_native_image': True})
        texts = [''.join(e['text'].split()).upper() for e in obs['untrusted_observation']['elements'] if e['source'] == 'ocr']
        pos_seen = any(posctrl in t for t in texts)
        canary_near = min((approx_substring_distance(canary, t) for t in texts), default=99)
        for key, name in (('image', 'leak-sent.png'), ('debug_native_image', 'leak-native.png')):
            if obs.get(key):
                decode(obs[key]).save(suite.out / name)
        # cu_zoom over both texts: the zoom path must not leak either (image re-read on the host by report.py).
        z = suite.d.call('zoom', {'task_id': TASK, 'snapshot_gen': obs['snapshot_gen'],
                                  'rect': {'x': 350, 'y': 280, 'w': 650, 'h': 240, 'space': 'screen'}})
        ztexts = [''.join(e['text'].split()).upper() for e in z['untrusted_observation']['ocr']]
        zoom_pos = any(posctrl in t for t in ztexts)
        zoom_canary = min((approx_substring_distance(canary, t) for t in ztexts), default=99)
        decode(z['image']).save(suite.out / 'leak-zoom.png')
        state_dir = Path.home() / 'Library/Application Support/cu-runtime'
        in_logs = subprocess.run(['grep', '-rl', canary, str(state_dir)], capture_output=True, text=True).stdout.split()
        ok = pos_seen and canary_near > 2 and not in_logs and zoom_pos and zoom_canary > 2
        suite.record('leak', ok, positive_control_read=pos_seen, canary_min_edit_distance_in_ocr=canary_near,
                     zoom_positive_control_read=zoom_pos, zoom_canary_min_edit_distance=zoom_canary,
                     zoom_magnification=z['magnification'],
                     daemon_files_with_canary=len(in_logs), canary=canary, posctrl=posctrl,
                     host_ocr='pending (report.py)')
        blk.stop()

    # 8 minimized / hidden
    for name, hide, show in (('minimized', 'minimize', 'restore'), ('hidden-app', 'hideApp', 'showApp')):
        if not want(name):
            continue
        fx, s = fixture(x=300, y=200, w=700, h=450)
        fx.cmd(hide, settle=1.5)
        obs = suite.observe()
        wins = [w for w in obs['windows'] if w['app'] == FIXTURE]
        marks = ax_markers(obs)
        blobs = blobs_of(obs, 'debug_native_image')
        suite.record(name, not wins and not marks and not blobs, windows=len(wins), ax_markers=len(marks), blobs=len(blobs))
        fx.cmd(show, settle=1.0)

    # 9 dynamic changes
    if want('dynamic'):
        fx, s = fixture(x=300, y=200, w=700, h=450)
        obs = suite.observe()
        m4 = next(a for a in ax_markers(obs) if a['id'] == 4)
        t4 = next(m for m in truth_markers(s) if m['id'] == 4)
        fx.cmd('move', x=350, y=200, settle=0.8)
        _, r_el = suite.click(0, 0, obs['snapshot_gen'], element=m4['element'])
        _, r_pt = suite.click(t4['x'], t4['y'], obs['snapshot_gen'])
        suite.record('dynamic-stale-element', r_el == 'stale_element', refusal=r_el)
        suite.record('dynamic-stale-coordinates', r_pt == 'stale_coordinates', refusal=r_pt)
        fx.cmd('moveAnimated', x=700, y=300, settle=0.0)
        obs = suite.observe()
        flagged = any(w['animating'] for w in obs['windows'] if w['app'] == FIXTURE)
        time.sleep(1.5)
        rec, _ = suite.measure('dynamic-after-animation', fx, truth_markers(fx.state()), click=False)
        suite.record('dynamic-animation-handled', flagged or rec['ok'], animating_flagged=flagged, capture_ok_after=rec['ok'])

    # 4 fullscreen (native = own Space; simple = same Space)
    for name, op in (('fullscreen-native', 'fullscreen'), ('fullscreen-simple', 'simpleFullscreen')):
        if not want(name):
            continue
        fx, _ = fixture(x=300, y=200, w=700, h=450)
        # The previous scenario's last click leaves the pointer on a bottom marker, over the Dock bar: a hovered
        # Dock does not auto-hide in simple fullscreen and really covers the bottom row (2026-10-10). Start clear.
        pointer_before = cg_windows('warp', W // 2, H // 2)
        t0 = time.time()
        fx.cmd(op, on=True, settle=0.0)
        stable_after, rec = None, None
        while time.time() - t0 < 12:
            s = fx.state()
            w = s['windows']['main']
            if (w['fullScreen'] or w['simpleFullScreen']) and len(w['markers']) == 9:
                obs = suite.observe()
                blobs = blobs_of(obs, 'debug_native_image')
                if all(nearest(blobs, m)[1] <= TOL_PT for m in truth_markers(s)):
                    stable_after = round(time.time() - t0, 2)
                    break
            time.sleep(0.4)
        rec, _ = suite.measure(name, fx, truth_markers(fx.state()), extra={'stable_after_s': stable_after, 'pointer_before': pointer_before})
        if op == 'fullscreen' and want('fullscreen-other-space'):
            blk = App(runs / 'blk', role='blocker', x=100, y=100, w=400, h=300)
            blk.ready()
            blk.cmd('focus', settle=2.0)      # switches away from the fullscreen Space
            obs = suite.observe()
            away = [w for w in obs['windows'] if w['app'] == FIXTURE]
            t1 = time.time()
            suite.d.call('act.key', {'task_id': TASK, 'app': FIXTURE, 'chord': 'down'})   # activation brings its Space back
            back_after = None
            while time.time() - t1 < 12:
                obs = suite.observe()
                blobs = blobs_of(obs, 'debug_native_image')
                if all(nearest(blobs, m)[1] <= TOL_PT for m in truth_markers(fx.state())):
                    back_after = round(time.time() - t1, 2)
                    break
                time.sleep(0.3)
            suite.record('fullscreen-other-space', back_after is not None, visible_while_away=len(away),
                         stable_after_activation_s=back_after)
            blk.stop()
        fx.cmd(op, on=False, settle=1.5)

    # 7 a real Notification Center banner over the fixture (433dc7a narrowed what NC's full-display window covers;
    # a banner that really covers an element must still refuse the click there). The fixture posts it: it runs in
    # the GUI session (osascript over ssh got its banner withdrawn as soon as it peeked in, 2026-10-10). In a fresh
    # clone the first notification comes with the permission request and stays up. Truth that a banner is up comes
    # from the window server (NC's full-display window at a positive layer), not from the daemon; that the refusal is
    # the banner's doing comes from the same two clicks landing just before it appeared.
    if want('notification-banner'):
        fx, s = fixture(x=W - 704, y=wa['y'], w=700, h=450)   # top right, where banners slide in
        covered, clear = [next(m for m in truth_markers(s) if m['id'] == i) for i in (2, 6)]   # top right, bottom left

        def try_clicks():
            obs = suite.observe()
            out = {}
            for key, m in (('covered', covered), ('clear', clear)):
                n0 = len(fx.clicks())
                _, reason = suite.click(m['x'], m['y'], obs['snapshot_gen'])
                out[key] = {'refused': reason, 'landed': len(fx.clicks()) > n0,
                            'detail': suite.last_refusal if reason else None}
            return out

        def nc_overlay():
            nc = set(subprocess.run(['pgrep', '-x', 'NotificationCenter'], capture_output=True, text=True).stdout.split())
            return any(isinstance(w, dict) and str(w.get('pid')) in nc and w['layer'] > 0 and w['bounds']['Width'] >= W
                       for w in cg_windows(None))

        base = try_clicks()
        fx.cmd('notify', settle=0.0)
        t0, up_after = time.time(), None
        while time.time() - t0 < 5:
            if nc_overlay():
                up_after = round(time.time() - t0, 2)
                break
            time.sleep(0.2)
        time.sleep(1.5)                                  # the banner slides in
        during = try_clicks()
        still_up = nc_overlay()
        c = during['covered']
        # The backstop the threat model relies on: after that refusal the area is flagged, the clear marker is not.
        els = [e for e in suite.observe()['untrusted_observation']['elements']
               if e['source'] == 'ax' and e.get('role') == 'AXButton']
        def flagged(i):
            return any(f'marker {i}' in e.get('text', '') and e.get('occluded')
                       and e.get('intercepted_by') == 'com.apple.notificationcenterui' for e in els)
        flagged_after = {'covered': flagged(covered['id']), 'clear': flagged(clear['id'])}
        ok = (all(v['landed'] and not v['refused'] for v in base.values()) and up_after is not None and still_up
              and c['refused'] is not None and not c['landed'] and 'notificationcenterui' in (c['detail'] or '')
              and during['clear']['landed'] and not during['clear']['refused']
              and flagged_after == {'covered': True, 'clear': False})
        suite.record('notification-banner', ok, baseline=base, banner_up_after_s=up_after, still_up=still_up,
                     during=during, flagged_after=flagged_after, caught_by_ax_only='although the window list' in (c['detail'] or ''))

    # 6 system UI: menu bar and Dock (changes Dock settings: run last)
    if want('sysui-under-menubar'):
        fx, _ = fixture(x=300, y=200, w=700, h=450)
        s = fx.cmd('move', x=300, y=0, settle=1.0)
        t = truth_markers(s)
        hidden, amb = split_hidden(t, {'x': -10000, 'y': -10000, 'width': 100000, 'height': 10000 + wa['y']})
        suite.measure('sysui-under-menubar', fx, t, expect_hidden=hidden, skip=amb,
                      extra={'window_y': s['windows']['main']['bounds']['y']})
    if want('sysui-under-dock'):
        fx, _ = fixture(x=(W - 700) // 2, y=H - 380, w=700, h=450)
        s = fx.state()
        t = truth_markers(s)
        dock_top = wa['y'] + wa['height']
        # Only the bottom-centre marker is surely under the Dock bar; other bottom markers may be beside it.
        bottom = {(m['win'], m['id']) for m in t if m['y'] + MARKER_PT / 2 > dock_top}
        hidden = {k: 'other' for k in bottom if k[1] == 7}
        suite.measure('sysui-under-dock', fx, t, expect_hidden=hidden, skip=bottom - set(hidden),
                      extra={'workarea_bottom': dock_top})
    if want('sysui-dock-autohide'):
        subprocess.run(['defaults', 'write', 'com.apple.dock', 'autohide', '-bool', 'true'])
        subprocess.run(['killall', 'Dock'])
        time.sleep(3)
        fx, s = fixture(x=(W - 700) // 2, y=H - 380, w=700, h=450)
        suite.measure('sysui-dock-autohide', fx, [m for m in truth_markers(s) if m['y'] < H - 2])
        subprocess.run(['defaults', 'write', 'com.apple.dock', 'autohide', '-bool', 'false'])
        subprocess.run(['defaults', 'write', 'com.apple.dock', 'orientation', '-string', 'left'])
        subprocess.run(['killall', 'Dock'])
        time.sleep(3)
        fx, s = fixture(x=0, y=250, w=700, h=450)
        wa2 = s['displays'][0]['workArea']
        t = truth_markers(s)
        left = {(m['win'], m['id']) for m in t if m['x'] - MARKER_PT / 2 < wa2['x']}
        hidden = {k: 'other' for k in left if k[1] == 3}   # left-middle marker: surely under the Dock bar
        # Full-display system windows above the normal layer (the Dock's, sometimes Notification Center's banner
        # window, which once put its desktop widgets above the fixture): whether a pass covered that case.
        overlays = [w['owner'] for w in cg_windows(None) if isinstance(w, dict) and w['layer'] > 0
                    and w['bounds']['Width'] >= W and w['bounds']['Height'] >= H]
        suite.measure('sysui-dock-left', fx, t, expect_hidden=hidden, skip=left - set(hidden),
                      extra={'workarea_left': wa2['x'], 'overlays': overlays})
        subprocess.run(['defaults', 'write', 'com.apple.dock', 'orientation', '-string', 'bottom'])
        subprocess.run(['killall', 'Dock'])

    kill_all()
    return disp


def main():
    require_vm(Path(__file__).name)
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--config-name', default='default')
    ap.add_argument('--only', nargs='*')
    args = ap.parse_args()
    ensure_blocker_app()
    suite = Suite(args.out)
    disp, env_failure = None, None
    try:
        if (prompt := system_prompt_in_front()):
            raise SystemPromptInFront(prompt)
        disp = run(suite, args.only)
    except SystemPromptInFront as e:
        env_failure = f'system prompt in front before the suite acted: {e}'
        print(f'ENVIRONMENT FAILURE: {env_failure}', flush=True)
    finally:
        kill_all()
        waits = suite.launch_waits
        suite.save({'config': args.config_name, 'display': disp,
                    'launch_wait_s': {'n': len(waits), 'max': max(waits, default=None),
                                      'nonzero': sum(w > 0.05 for w in waits)},
                    'daemon_window_wait_ms': {'n': len(suite.daemon_waits), 'max': max(suite.daemon_waits, default=None)},
                    'harness_wait_polls': suite.wait_reasons, 'overlay_retries': suite.overlay_retries,
                    'env_failure': env_failure})
    if env_failure:
        sys.exit(3)   # run_vm.sh: environment, not a result
    fails = [r['name'] for r in suite.results if not r['ok']]
    print(f'{len(suite.results) - len(fails)}/{len(suite.results)} passed' + (f'; failed: {fails}' if fails else ''))


if __name__ == '__main__':
    main()
