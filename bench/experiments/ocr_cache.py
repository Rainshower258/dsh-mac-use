#!/usr/bin/env python3
"""OCR cache experiment (docs/DESIGN.md "OCR cache", decided 2026-09-29), guest side; run with run_vm_experiment.sh.

The calibration fixture shows synthetic text lines whose rendered rects are the ground truth. They are hidden from
AX (pixels only, like canvas text) so the OCR path is what gets measured; one extra line is AX-visible. Metrics fixed in
advance, per phase:
  cold      whole-window OCR (capture.ocr.full == 1); lines read correctly (edit distance <= 1, box centre inside
            the truth rect widened by 4 pt)
  unchanged every observe served from the cache (cached_only == 1, recognized area 0), ids identical to cold
  dedup     one extra line is also exposed to AX: it must come back as the AX element only (no OCR duplicate)
  edit      one line changed per step: exactly one band, only that line's id changes, the new text read correctly,
            recognized area fraction
  move      window moved: no OCR, every line's frame follows the window (max error vs truth), ids unchanged
  resize    whole-window OCR again
Latency (ms) p50/p95 for each phase, with OCR only (include_image false) and as cu_observe does it for the model
(include_image true). Writes <out>/results.json, numbers only.
"""
import argparse
import json
import random
import statistics
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

TASK = 'ocr-cache'
WORDS = ('amber basalt cobalt delta ember falcon garnet harbor indigo juniper kestrel lantern meadow nickel orchid '
         'pepper quartz raven saffron timber umber violet walnut yarrow zephyr 2048 3187 5520 7093 9461').split()


def edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def norm(s):
    return ''.join(s.lower().split())


def pct(xs, p):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))], 1) if xs else None


def lat(xs):
    return {'n': len(xs), 'p50': pct(xs, 50), 'p95': pct(xs, 95), 'max': round(max(xs), 1) if xs else None}


class Run:
    def __init__(self, fx, d):
        self.fx, self.d = fx, d

    def observe(self, image=False):
        t0 = time.perf_counter()
        r = self.d.call('observe', {'task_id': TASK, 'ocr': 'on', 'include_image': image})
        return r, (time.perf_counter() - t0) * 1000

    def truth(self, include_ax_line=False):
        return [t for t in self.fx.state()['windows']['main']['texts'] if include_ax_line or t['id'] != 99]

    @staticmethod
    def ocr(r):
        return [e for e in r['untrusted_observation']['elements'] if e['source'] == 'ocr']

    @staticmethod
    def match(truth, ocr):
        """truth id -> (ocr element, correct) for the OCR line whose box centre lies in the widened truth rect."""
        out = {}
        for t in truth:
            best = None
            for e in ocr:
                x, y, w, h = e['frame_pt']
                cx, cy = x + w / 2, y + h / 2
                if t['x'] - 4 <= cx <= t['x'] + t['w'] + 4 and t['y'] - 4 <= cy <= t['y'] + t['h'] + 4:
                    d = edit_distance(norm(t['text']), norm(e['text']))
                    if best is None or d < best[1]:
                        best = (e, d)
            out[t['id']] = (best[0], best[1] <= 1) if best else (None, False)
        return out


def main():
    require_vm(Path(__file__).name)
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--reps', type=int, default=15)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(20260929)
    res = {}

    kill_all()
    fx = App(Path('/tmp/ocr-apps/fx'), x=150, y=150, w=800, h=520)
    fx.ready()
    d = Daemon()
    d.call('grants.set', {'task_id': TASK, 'bundle_ids': [FIXTURE], 'source': 'config', 'expires_in_s': 3600})
    lines = [{'id': i, 'text': ' '.join(rng.sample(WORDS, 3)), 'x': 60, 'y': 30 + i * 34, 'size': 18, 'ax': False}
             for i in range(12)]
    ax_line = {'id': 99, 'text': 'visible to accessibility', 'x': 420, 'y': 64, 'size': 18}
    fx.cmd('lines', lines=lines + [ax_line], settle=0.8)
    fx.cmd('focus', settle=0.5)
    run = Run(fx, d)

    # cold: first observe of a daemon that finished its start-up prewarm (as after login), OCR cache empty
    audit_dir = Path.home() / 'Library/Application Support/cu-runtime/audit'
    t0 = time.time()
    while time.time() - t0 < 30 and not any('"runtime.prewarm"' in f.read_text() for f in audit_dir.glob('*.jsonl')):
        time.sleep(0.2)
    res['waited_for_prewarm_s'] = round(time.time() - t0, 1)
    r, ms = run.observe()
    truth = [t for t in run.truth() if t['id'] != 99]
    m = run.match(truth, run.ocr(r))
    ids0 = {k: v[0]['id'] for k, v in m.items() if v[0]}
    axt = next(t for t in run.truth(include_ax_line=True) if t['id'] == 99)
    els = r['untrusted_observation']['elements']
    res['dedup'] = {'ax_element_present': any(e['source'] == 'ax' and 'accessibility' in e['text'] for e in els),
                    'ocr_duplicate_present': bool(run.match([axt], run.ocr(r))[99][0]),
                    'deduped_against_ax': r['capture'].get('ocr', {}).get('deduped_against_ax')}
    res['cold'] = {'ocr': r['capture'].get('ocr'), 'lines': len(lines), 'found': len(ids0),
                   'correct': sum(v[1] for v in m.values()), 'ms': round(ms, 1),
                   'capture_ms': round(r['capture'].get('capture_elapsed_ms', 0)),
                   'ocr_ms': round(r['capture'].get('ocr_elapsed_ms', 0)),
                   'ax_ms': round(sum(a['elapsed_ms'] for a in r.get('ax_stats', []))),
                   'phases_ms': r['capture'].get('phases_ms')}

    # unchanged
    ms_ocr, ms_img, cached, same_ids = [], [], 0, 0
    slowest = (0, None)
    for i in range(args.reps):
        r, ms = run.observe(image=bool(i % 2))
        (ms_img if i % 2 else ms_ocr).append(ms)
        if ms > slowest[0]:
            slowest = (round(ms), r['capture'].get('phases_ms'))
        o = r['capture'].get('ocr') or {}
        cached += o.get('cached_only') == 1 and o.get('recognized_area_fraction') == 0
        m = run.match(run.truth(), run.ocr(r))
        same_ids += all(m[k][0] and m[k][0]['id'] == v for k, v in ids0.items())
    res['unchanged'] = {'reps': args.reps, 'cached_only': cached, 'ids_identical': same_ids, 'slowest': slowest,
                        'latency_ocr_only': lat(ms_ocr), 'latency_with_image': lat(ms_img)}

    # edit one line per step
    ms_ocr, ms_img, one_band, only_changed, read_ok, fracs = [], [], 0, 0, 0, []
    ids = dict(ids0)
    slowest = (0, None)
    for i in range(args.reps):
        new = ' '.join(rng.sample(WORDS, 3))
        fx.cmd('lines', lines=[{**lines[5], 'text': new}], settle=0.4)
        r, ms = run.observe(image=bool(i % 2))
        (ms_img if i % 2 else ms_ocr).append(ms)
        if ms > slowest[0]:
            slowest = (round(ms), r['capture'].get('phases_ms'))
        o = r['capture'].get('ocr') or {}
        one_band += o.get('bands') == 1
        fracs.append(o.get('recognized_area_fraction') or 0)
        m = run.match(run.truth(), run.ocr(r))
        now = {k: v[0]['id'] for k, v in m.items() if v[0]}
        only_changed += all(now.get(k) == ids[k] for k in ids if k != 5) and now.get(5) not in (None, ids.get(5))
        read_ok += m[5][1]
        ids = now
    res['edit'] = {'reps': args.reps, 'slowest': slowest, 'one_band': one_band, 'only_that_line_new_id': only_changed,
                   'new_text_read': read_ok, 'area_fraction': {'p50': pct(fracs, 50), 'max': round(max(fracs), 3)},
                   'latency_ocr_only': lat(ms_ocr), 'latency_with_image': lat(ms_img)}

    # move
    s = fx.state()['windows']['main']['bounds']
    fx.cmd('move', x=s['x'] + 60, y=s['y'] + 40, settle=0.8)
    r, ms = run.observe()
    o = r['capture'].get('ocr') or {}
    truth = run.truth()
    m = run.match(truth, run.ocr(r))
    errs = []
    for t in truth:
        e = m[t['id']][0]
        if e:
            x, y, w, h = e['frame_pt']
            errs.append(max(abs((x + w / 2) - (t['x'] + t['w'] / 2)), abs((y + h / 2) - (t['y'] + t['h'] / 2))))
    res['move'] = {'ocr': o, 'found': len(errs), 'centre_err_max_pt': round(max(errs), 2) if errs else None,
                   'ids_unchanged': all(m[k][0] and m[k][0]['id'] == v for k, v in ids.items()), 'ms': round(ms, 1)}

    # resize -> whole window, cold latency over several sizes
    ms_full, full = [], 0
    for i in range(max(3, args.reps // 3)):
        fx.cmd('resize', w=800 + 10 * ((i % 2) * 2 - 1) * (i + 1), h=520, settle=0.8)
        r, ms = run.observe()
        ms_full.append(ms)
        full += (r['capture'].get('ocr') or {}).get('full') == 1
    res['resize'] = {'reps': len(ms_full), 'full': full, 'latency_ocr_only': lat(ms_full)}

    warm = [json.loads(l) for f in audit_dir.glob('*.jsonl') for l in f.read_text().splitlines()
            if '"runtime.prewarm"' in l]
    res['prewarm'] = {k: v for k, v in warm[-1].items() if k.endswith('_ms')} if warm else None

    fx.stop()
    kill_all()
    (out / 'results.json').write_text(json.dumps(res, indent=2))
    print(json.dumps(res, indent=2))


if __name__ == '__main__':
    main()
