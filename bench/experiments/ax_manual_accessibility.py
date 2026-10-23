#!/usr/bin/env python3
"""R2 experiment: how much visible text does AX expose with Electron's AXManualAccessibility off vs on?

Read-only by construction: this script only calls grants.set / observe / grants.revoke on a running
cu-runtime daemon. It never calls act.* and involves no model. The grant covers exactly one app.

PRE-REGISTERED METRICS (fixed 2026-09-28, before any run; do not change after seeing results)
- Denominator: OCR text lines (daemon OCR, native resolution) whose frame centre lies inside the
  message region. The region is given as fractions of the app's largest on-screen window.
- Normalisation (both sides): Unicode NFKC (full-width -> half-width), remove all whitespace, lowercase.
- Lines whose normalised length is < 2 are excluded from the denominator (mostly icons read as glyphs);
  the excluded count is reported.
- A line is "covered" if it occurs as an approximate substring of some AX element's normalised text:
  edit distance <= 1 for lines of length >= 4, exact substring for shorter lines (a 1-edit tolerance
  on a 2-3 character line would match almost anything).
- Coverage = covered / denominator. AX text is taken from the whole app (not just the region).
- Procedure: grant(manual AX off) -> observe; grant(on) -> wait 3 s -> observe; wait 3 s -> observe again
  (stability check); grant(off) -> revoke. Same window, same screen: the window frame and OCR line count
  must match across runs, otherwise the run is flagged "screen_changed".
- Protocol amendment (2026-09-28, after the first fixture pilot, BEFORE any QQ run): one discarded warm-up
  observe (OCR on) precedes the "off" run. In the pilot the first capture after daemon start came back with
  no text in the region (denominator 0) while later captures of the same screen had 10 lines. A run with
  denominator 0 is reported as invalid, never as coverage 0.
- Amendment 2 (2026-09-28, after QQ run 1): two DIAGNOSTIC outputs, numbers only; the coverage metric above
  is unchanged.
  (a) Geometry: for every covered line, compare its OCR box with the matching AX element's frame (among
      text-matching elements, the one nearest to the OCR box): IoU and
      containment = area(OCR ∩ AX) / area(OCR). A multi-line message is one AX element but several OCR lines,
      so containment (not IoU) is the primary "is the AX frame in the right place" signal. Reported: median,
      p10, share with containment >= 0.9, count of matches whose AX frame is null.
  (b) Categories of uncovered lines, counts only (first rule that matches): ocr_misread (the closest AX text
      is within 3 edits and <= 20% of the line length: the text IS in AX, OCR misread it, so this is an OCR
      error, not an AX gap), timestamp, unread_badge, level_badge, link, reply_quote, small_meta (line height
      < 0.85 x median line height: nicknames and similar), other. (ocr_misread added after the fixture pilot of
      amendment 2, before any further QQ run.)
- The request parameter is `electron_ax` (renamed from ax_manual_accessibility). The daemon now waits for
  the AX tree to settle after switching it on; the settle outcome is recorded per run.
- Recorded per run: coverage, denominator, excluded, AX nodes / elements, AX snapshot ms, hit time budget,
  hit node cap, OCR ms, capture ms. Plus app version and window frame.

- Amendment 3 (2026-10-01, before any multi-session run): --sessions N measures N conversations in one daemon
  run, in two passes, because once Chromium's AX tree is on, switching the attribute off does not reliably take it
  down (an "off" after an "on" would be contaminated). Pass 1, attribute off: warm-up once, then per conversation one
  "off" measurement. Pass 2, attribute on: the same conversations in the same order, per conversation one
  measurement 3 s after the screen is back ("on_3s"). Between measurements the script waits for the maintainer to
  switch: the region's OCR line set must change (pass 1) or match the pass-1 set of that conversation (Jaccard
  >= 0.8, pass 2), then stay unchanged for 3 s. The line sets live in memory only (nothing textual on disk);
  whether pass 2 found the same screen is recorded as a number. A sound marks each finished measurement. Per
  conversation: coverage off / on as defined above; pooled: sum(covered) / sum(denominator) per pass.
- Amendment 4 (2026-10-02, after three aborted --sessions runs, before any multi-session result): pass 2 no longer
  waits for the pass-1 screen (Jaccard >= 0.8): an active group chat gets new messages during a run, so the same
  conversation can never look the same again (run 3 went back correctly and saw 0.12). Both passes now detect a
  switch the same way: the region's line set differs from the previous measurement's (Jaccard < 0.5) and then holds
  still for 3 s; the first conversation of pass 1 also waits for 3 s of stillness. The Jaccard to the same
  conversation's pass-1 screen is still recorded per conversation; below 0.8 it is flagged, and the pooled on/off
  numbers are reported for all conversations and for the matched ones only. The coverage metric is unchanged.
- Known flaw (found 2026-10-02 after the amendment-4 run): the daemon's OCRDedup (2026-09-29) drops OCR lines an AX
  element already carries, i.e. the covered lines, so every "on" result since then is biased low and the pass-2
  screen never matches pass 1. "off" results are unaffected. Fix (R6): an observe parameter that turns the dedup off.

Privacy: nothing textual is written to disk. result.json holds numbers only and goes to bench/runs/
(gitignored). --preview writes the downscaled capture with the region drawn on it, for a human to check
the region once; delete it afterwards.

    python3 bench/experiments/ax_manual_accessibility.py --app com.tencent.qq --region 0.18,0.054,0.885,0.765 --preview
    python3 bench/experiments/ax_manual_accessibility.py --app com.tencent.qq --region 0.18,0.054,0.885,0.765
    python3 bench/experiments/ax_manual_accessibility.py --app com.tencent.qq --region 0.18,0.054,0.885,0.765 --sessions 5

Host exemption (the only bench script allowed outside the VM; vmguard.py, docs/incidents/2026-09-29-host-model-run.md):
no model, no dsh, no bash, observe only. On the host it refuses to start while any dsh process runs, and after a
measurement (not after --preview, which is followed by one) it stops the daemon (SIGTERM switches
AXManualAccessibility back off) and revokes the daemon's Accessibility and Screen Recording grants with tccutil.
"""
import argparse
import base64
import re
import statistics
import json
import os
import socket
import struct
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

BENCH = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BENCH))
from vmguard import in_vm  # noqa: E402

DAEMON_BUNDLE = 'dev.cu-runtime.daemon'
STATE = Path(os.environ.get('CU_STATE_DIR', Path.home() / 'Library/Application Support/cu-runtime'))
TASK = 'exp-ax-manual'
# Unmatched-line diagnostics print screen text, so they are allowed only for the synthetic fixture.
DIAGNOSTIC_APPS = {'dev.dsh.bench.fixture'}
SETTLE_S = 3.0


class Daemon:
    def __init__(self):
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.connect(str(STATE / 'daemon.sock'))
        self.n = 0
        self.call('session.hello', {'token': (STATE / 'token').read_text().strip()})

    def call(self, method, params=None):
        self.n += 1
        body = json.dumps({'jsonrpc': '2.0', 'id': self.n, 'method': method, 'params': params or {}}).encode()
        self.s.sendall(struct.pack('<I', len(body)) + body)
        (n,) = struct.unpack('<I', self._read(4))
        msg = json.loads(self._read(n))
        if 'error' in msg:
            raise SystemExit(f'{method}: {msg["error"]}')
        return msg['result']

    def _read(self, n):
        buf = b''
        while len(buf) < n:
            chunk = self.s.recv(n - len(buf))
            if not chunk:
                raise SystemExit('daemon closed the connection')
            buf += chunk
        return buf


def norm(s):
    return ''.join(unicodedata.normalize('NFKC', s).split()).lower()


def approx_substring_distance(needle, hay):
    """Minimum edit distance between `needle` and any substring of `hay` (Sellers)."""
    prev = [0] * (len(hay) + 1)
    for i, c in enumerate(needle, 1):
        cur = [i] + [0] * len(hay)
        for j, h in enumerate(hay, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (c != h))
        prev = cur
    return min(prev)


def match_indices(line, ax_texts):
    """Indices of every AX text that covers `line` (same rule as `covered`)."""
    return [i for i, t in enumerate(ax_texts)
            if line in t or (len(line) >= 4 and approx_substring_distance(line, t) <= 1)]


def match_index(line, ax_texts):
    found = match_indices(line, ax_texts)
    return found[0] if found else None


def nearest(ocr_frame, candidates, ax_els):
    """Among text-matching AX elements, the one whose frame centre is closest to the OCR box (the same text can
    appear twice, e.g. a message and its preview in the conversation list)."""
    cx, cy = ocr_frame[0] + ocr_frame[2] / 2, ocr_frame[1] + ocr_frame[3] / 2
    def dist(i):
        f = ax_els[i].get('frame_pt')
        return float('inf') if not f else (f[0] + f[2] / 2 - cx) ** 2 + (f[1] + f[3] / 2 - cy) ** 2
    return min(candidates, key=dist)


def covered(line, ax_texts):
    return match_index(line, ax_texts) is not None


def box_stats(ocr, ax):
    ox, oy, ow, oh = ocr
    ax_, ay, aw, ah = ax
    iw = max(0.0, min(ox + ow, ax_ + aw) - max(ox, ax_))
    ih = max(0.0, min(oy + oh, ay + ah) - max(oy, ay))
    inter = iw * ih
    union = ow * oh + aw * ah - inter
    return (inter / union if union > 0 else 0.0), (inter / (ow * oh) if ow * oh > 0 else 0.0)


TIME_RE = re.compile(r'^(\d{1,2}:\d{2}|昨天|前天|今天|星期.|周.|\d{1,2}月\d{1,2}日|\d{4}[-/年]\d{1,2})')


def category(line, height, median_height, ax_texts=()):
    best = min((approx_substring_distance(line, t) for t in ax_texts), default=None)
    if best is not None and best <= 3 and best <= 0.2 * len(line):
        return 'ocr_misread'
    if TIME_RE.search(line) or re.fullmatch(r'[\d:/\-年月日 ]+', line):
        return 'timestamp'
    if '条新消息' in line or 'newmessage' in line:
        return 'unread_badge'
    if re.match(r'^lv\d+', line) or any(k in line for k in ('管理员', '群主', '群管')):
        return 'level_badge'
    if 'http' in line or 'www.' in line or re.search(r'\.(com|cn|net|org)\b', line):
        return 'link'
    if line.startswith(('回复', '引用')) or '回复' in line[:6]:
        return 'reply_quote'
    if median_height and height < 0.85 * median_height:
        return 'small_meta'
    return 'other'


def region_rect(window, frac):
    x, y, w, h = window
    x0, y0, x1, y1 = frac
    return (x + x0 * w, y + y0 * h, x + x1 * w, y + y1 * h)


def inside(frame, r):
    cx, cy = frame[0] + frame[2] / 2, frame[1] + frame[3] / 2
    return r[0] <= cx <= r[2] and r[1] <= cy <= r[3]


def measure(d, app, frac, include_image=False, show_unmatched=False, show_geometry=False):
    obs = d.call('observe', {'task_id': TASK, 'ocr': 'on', 'include_image': include_image})
    wins = [w for w in obs['windows'] if w['app'] == app]
    if not wins:
        raise SystemExit(f'no on-screen window for {app}')
    window = max((w['frame_pt'] for w in wins), key=lambda f: f[2] * f[3])
    reg = region_rect(window, frac)
    els = obs['untrusted_observation']['elements']
    ax_els = [e for e in els if e['source'] == 'ax']
    ax_texts = [norm(e['text']) for e in ax_els]
    ocr_in = [e for e in els if e['source'] == 'ocr' and e['frame_pt'] and inside(e['frame_pt'], reg)]
    lines = [norm(e['text']) for e in ocr_in]
    counted_els = [e for e, l in zip(ocr_in, lines) if len(l) >= 2]
    counted = [l for l in lines if len(l) >= 2]
    matches = [(lambda c: nearest(e['frame_pt'], c, ax_els) if c else None)(match_indices(l, ax_texts))
               for e, l in zip(counted_els, counted)]
    hit = sum(m is not None for m in matches)
    heights = [e['frame_pt'][3] for e in counted_els]
    med_h = statistics.median(heights) if heights else 0
    ious, contains, null_frames = [], [], 0
    cats = {}
    for e, l, m in zip(counted_els, counted, matches):
        if m is None:
            c = category(l, e['frame_pt'][3], med_h, ax_texts)
            cats[c] = cats.get(c, 0) + 1
            continue
        axf = ax_els[m].get('frame_pt')
        if show_geometry:
            print(f'  geom: {l[:24]!r} ocr={[round(v) for v in e["frame_pt"]]} ax={axf and [round(v) for v in axf]} '
                  f'ax_role={ax_els[m].get("role")} ax_text={ax_texts[m][:30]!r}')
        if not axf:
            null_frames += 1
            continue
        iou, cont = box_stats(e['frame_pt'], axf)
        ious.append(iou)
        contains.append(cont)

    def q(xs, p):
        return round(sorted(xs)[max(0, int(p * len(xs)) - (1 if p == 1 else 0))], 3) if xs else None
    geometry = {
        'matched_with_frame': len(ious), 'matched_null_frame': null_frames,
        'iou_median': round(statistics.median(ious), 3) if ious else None, 'iou_p10': q(ious, 0.1),
        'containment_median': round(statistics.median(contains), 3) if contains else None,
        'containment_p10': q(contains, 0.1),
        'share_containment_ge_0_9': round(sum(c >= 0.9 for c in contains) / len(contains), 3) if contains else None,
    }
    if show_unmatched:
        for l in counted:
            if not covered(l, ax_texts):
                best = min(ax_texts, key=lambda t: approx_substring_distance(l, t), default='')
                print(f'  unmatched: {l!r}  (closest AX distance {approx_substring_distance(l, best) if best else None})')
    stats = [s for s in obs['ax_stats'] if s['app'] == app]
    cap = obs.get('capture', {})
    return {
        'valid': bool(counted),
        'coverage': round(hit / len(counted), 4) if counted else None,
        'covered': hit, 'denominator': len(counted), 'excluded_short': len(lines) - len(counted),
        'ax_elements': len(ax_texts),
        'ax_nodes': sum(s['nodes'] for s in stats),
        'ax_snapshot_ms': round(sum(s['elapsed_ms'] for s in stats), 1),
        'hit_time_budget': any(s['hit_time_budget'] for s in stats),
        'hit_node_cap': any(s['hit_node_cap'] for s in stats),
        'electron_ax': any(s.get('electron_ax') for s in stats),
        'settle': next((s['settle'] for s in stats if s.get('settle')), None),
        'geometry': geometry,
        'uncovered_categories': cats,
        'ocr_ms': round(cap.get('ocr_elapsed_ms', 0), 1),
        'capture_ms': round(cap.get('capture_elapsed_ms', 0), 1),
        'capture_error': cap.get('error'),
        'window_pt': window,
    }, obs, reg


def app_version(bundle_id):
    out = subprocess.run(['mdfind', f'kMDItemCFBundleIdentifier == "{bundle_id}"'], capture_output=True, text=True).stdout
    for path in out.split('\n'):
        if path.endswith('.app'):
            v = subprocess.run(['defaults', 'read', f'{path}/Contents/Info', 'CFBundleShortVersionString'],
                               capture_output=True, text=True).stdout.strip()
            return {'path_name': Path(path).name, 'version': v}
    return None


def preview(obs, reg, out_dir):
    from io import BytesIO

    from PIL import Image, ImageDraw
    # One desktop composite per observe (the per-window `images` list it was written against is gone).
    shot = obs['image']
    img = Image.open(BytesIO(base64.b64decode(shot['base64']))).convert('RGB')
    ox, oy, w, _ = shot['mapping']['display_bounds_pt']
    k = shot['mapping']['sent_size_px'][0] / w
    ImageDraw.Draw(img).rectangle([(reg[0] - ox) * k, (reg[1] - oy) * k, (reg[2] - ox) * k, (reg[3] - oy) * k],
                                  outline=(255, 0, 0), width=3)
    p = out_dir / 'region-preview.png'
    img.save(p)
    os.chmod(p, 0o600)
    return p


def revoke_host_grants() -> None:
    """End of a host measurement: stop the daemon, then revoke its TCC grants (they are re-granted by hand for the
    next measurement)."""
    subprocess.run(['pkill', '-TERM', '-f', 'CURuntime.app/Contents/MacOS/'], capture_output=True)
    time.sleep(1.0)
    for service in ('Accessibility', 'ScreenCapture'):
        r = subprocess.run(['tccutil', 'reset', service, DAEMON_BUNDLE], capture_output=True, text=True)
        print(f'tccutil reset {service} {DAEMON_BUNDLE}: {"ok" if r.returncode == 0 else r.stderr.strip()}')


SOUND_NEXT = '/System/Library/Sounds/Glass.aiff'      # measured: switch to the next conversation
SOUND_PASS = '/System/Library/Sounds/Hero.aiff'       # pass 1 done: go back to the first conversation
SWITCH_TIMEOUT_S = 180


def cue(sound: str) -> None:
    subprocess.run(['afplay', sound], capture_output=True)


def region_lines(d, app, frac) -> set:
    """The region's normalised OCR lines (in memory only; used to notice a conversation switch)."""
    obs = d.call('observe', {'task_id': TASK, 'ocr': 'on'})
    wins = [w for w in obs['windows'] if w['app'] == app]
    if not wins:
        return set()
    reg = region_rect(max((w['frame_pt'] for w in wins), key=lambda f: f[2] * f[3]), frac)
    return {norm(e['text']) for e in obs['untrusted_observation']['elements']
            if e['source'] == 'ocr' and e['frame_pt'] and inside(e['frame_pt'], reg) and len(norm(e['text'])) >= 2}


def jaccard(a: set, b: set) -> float:
    return len(a & b) / len(a | b) if a | b else 1.0


def wait_screen(d, app, frac, ok, ref: set | None = None) -> set:
    """Until the region's line set satisfies ok(lines) and then stays the same for 3 s. With ref, a timeout reports the
    best Jaccard to it (a number only): tells "never went back" (about 0) from "back, but the screen differs"."""
    deadline = time.time() + SWITCH_TIMEOUT_S
    best = 0.0
    while time.time() < deadline:
        cur = region_lines(d, app, frac)
        if ref is not None and cur:
            best = max(best, jaccard(cur, ref))
        if cur and ok(cur):
            time.sleep(SETTLE_S)
            again = region_lines(d, app, frac)
            if jaccard(cur, again) >= 0.95:
                return again
        time.sleep(1.0)
    raise SystemExit(f'no conversation switch within {SWITCH_TIMEOUT_S} s'
                     + (f' (best Jaccard to the pass-1 screen: {best:.2f}, needed 0.8)' if ref is not None else ''))


def multi_session(d, app, frac, grant, n) -> dict:
    runs_off, runs_on, seen = [], [], []
    d.call('grants.set', {**grant, 'electron_ax': False})
    measure(d, app, frac)  # warm-up, discarded
    print(f'pass 1 (attribute off): {n} conversations; switch to the next one at each sound', flush=True)
    for i in range(n):
        lines = (wait_screen(d, app, frac, lambda c: True) if i == 0
                 else wait_screen(d, app, frac, lambda c: jaccard(c, seen[-1]) < 0.5))
        seen.append(lines)
        runs_off.append(measure(d, app, frac)[0])
        print(f'  off {i + 1}/{n}: denominator {runs_off[-1]["denominator"]}', flush=True)
        cue(SOUND_NEXT if i < n - 1 else SOUND_PASS)
    d.call('grants.set', {**grant, 'electron_ax': True})
    applied = d.call('observe', {'task_id': TASK, 'ocr': 'off'})
    settle = next((s.get('settle') for s in applied['ax_stats'] if s['app'] == app and s.get('settle')), None)
    print('pass 2 (attribute on): go back to the first conversation, then the same order', flush=True)
    same, prev = [], seen[-1]
    for i in range(n):
        # Amendment 4: a switch = differs from the previous screen, then still; the pass-1 match is recorded only.
        lines = wait_screen(d, app, frac, lambda c, ref=prev: jaccard(c, ref) < 0.5)
        prev = lines
        same.append(round(jaccard(lines, seen[i]), 3))
        runs_on.append(measure(d, app, frac)[0])
        flag = '' if same[-1] >= 0.8 else f'  (screen differs from pass 1: Jaccard {same[-1]})'
        print(f'  on {i + 1}/{n}: coverage {runs_on[-1]["coverage"]}{flag}', flush=True)
        cue(SOUND_NEXT if i < n - 1 else SOUND_PASS)
    seen.clear()

    def pooled(runs):
        den = sum(r['denominator'] for r in runs)
        cov = sum(r['covered'] for r in runs)
        return {'covered': cov, 'denominator': den, 'coverage': round(cov / den, 4) if den else None}
    matched = [i for i, j in enumerate(same) if j >= 0.8]
    return {'sessions': n, 'settle_on_switch': settle, 'off': runs_off, 'on_3s': runs_on,
            'pass2_same_screen_jaccard': same, 'pass2_matched': matched,
            'pooled': {'off': pooled(runs_off), 'on_3s': pooled(runs_on)},
            'pooled_matched_only': {'off': pooled([runs_off[i] for i in matched]),
                                    'on_3s': pooled([runs_on[i] for i in matched])}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--app', required=True)
    ap.add_argument('--region', required=True, help='x0,y0,x1,y1 as fractions of the app window')
    ap.add_argument('--preview', action='store_true', help='only save a region preview image, no metrics')
    ap.add_argument('--show-unmatched', action='store_true', help=f'print unmatched lines (only for {DIAGNOSTIC_APPS})')
    ap.add_argument('--show-geometry', action='store_true', help=f'print matched OCR/AX boxes (only for {DIAGNOSTIC_APPS})')
    ap.add_argument('--sessions', type=int, default=1, help='conversations to measure in two passes (amendment 3)')
    args = ap.parse_args()
    if (args.show_unmatched or args.show_geometry) and args.app.lower() not in DIAGNOSTIC_APPS:
        raise SystemExit('--show-unmatched prints screen text; it is only allowed for the synthetic fixture')
    frac = tuple(float(v) for v in args.region.split(','))
    app = args.app.lower()
    host = not in_vm()
    if host:
        dsh = subprocess.run(['pgrep', '-f', 'deepseek-ai/dsh'], capture_output=True, text=True).stdout.split()
        if dsh:
            raise SystemExit(f'host measurement: dsh is running (pids {dsh}); nothing model-driven may run alongside it')
        print('host exemption: no model, no dsh, observe only'
              + ('' if args.preview else '; the daemon is stopped and its TCC grants revoked at the end'))
    out_dir = BENCH / 'runs' / f'ax-manual-{time.strftime("%Y%m%d-%H%M%S")}-{app.split(".")[-1]}'
    out_dir.mkdir(parents=True, mode=0o700)

    d = Daemon()
    grant = {'task_id': TASK, 'bundle_ids': [app], 'source': 'config', 'expires_in_s': 600}
    try:
        d.call('grants.set', {**grant, 'electron_ax': False})
        if args.preview:
            _, obs, reg = measure(d, app, frac, include_image=True)
            print(f'preview: {preview(obs, reg, out_dir)}  (delete it after checking the red box)')
            return
        if args.sessions > 1:
            multi = multi_session(d, app, frac, grant, args.sessions)
            return
        measure(d, app, frac)  # warm-up, discarded (see protocol amendment)
        runs = {}
        runs['off'], _, _ = measure(d, app, frac, show_unmatched=args.show_unmatched, show_geometry=args.show_geometry)
        d.call('grants.set', {**grant, 'electron_ax': True})
        applied = d.call('observe', {'task_id': TASK, 'ocr': 'off'})  # applies the attribute, waits for settle
        settle = next((s.get('settle') for s in applied['ax_stats'] if s['app'] == app and s.get('settle')), None)
        time.sleep(SETTLE_S)
        runs['on_3s'], _, _ = measure(d, app, frac, show_unmatched=args.show_unmatched)
        time.sleep(SETTLE_S)
        runs['on_6s'], _, _ = measure(d, app, frac, show_unmatched=args.show_unmatched)
    finally:
        # Layer 3 of the AXManualAccessibility cleanup (daemon shutdown and its startup ledger are layers 1-2).
        try:
            d = Daemon()  # fresh connection in case the old one died with a failed request
            d.call('grants.set', {**grant, 'electron_ax': False})  # daemon switches it back off
            d.call('grants.revoke', {'task_id': TASK})
        except (OSError, SystemExit) as e:
            print(f'\n!!! could not reach the daemon to switch AXManualAccessibility off ({e}).\n'
                  f'!!! RESTART {app} now. The next daemon start will also restore it from its ledger.\n')
        if host and not args.preview:
            revoke_host_grants()
        if args.sessions > 1 and 'multi' in locals():
            result = {'experiment': 'ax_manual_accessibility', 'amendment': 4, 'app': app, 'app_info': app_version(app),
                      'region_frac': frac, 'settle_s': SETTLE_S, **multi, 'started': out_dir.name}
            (out_dir / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
            os.chmod(out_dir / 'result.json', 0o600)
            print(json.dumps({k: result[k] for k in ('pooled', 'pooled_matched_only', 'pass2_same_screen_jaccard')}, indent=2),
                  f'\nsaved {out_dir / "result.json"} (numbers only). '
                  'Now restart the app to clear AXManualAccessibility fully.')

    frames = {tuple(r['window_pt']) for r in runs.values()}
    dens = {r['denominator'] for r in runs.values()}
    result = {
        'experiment': 'ax_manual_accessibility', 'app': app, 'app_info': app_version(app), 'region_frac': frac,
        'settle_s': SETTLE_S, 'settle_on_switch': settle, 'runs': runs,
        'screen_changed': len(frames) > 1 or (max(dens) - min(dens) > max(2, 0.05 * max(dens))),
        'started': out_dir.name,
    }
    (out_dir / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    os.chmod(out_dir / 'result.json', 0o600)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f'\nsaved {out_dir / "result.json"} (numbers only). Now restart the app to clear AXManualAccessibility fully.')


if __name__ == '__main__':
    main()
