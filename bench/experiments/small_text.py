#!/usr/bin/env python3
"""Acceptance check (fixed 2026-09-28): fixture text too small to read in the downscaled overview must be read correctly
through OCR or cu_zoom. Guest side; run with run_vm_experiment.sh, then small_text_report.py on the host.

Synthetic lines at 8-11 px, hidden from AX (pixels only). Per line: the daemon's OCR reads it (native resolution),
and the OCR returned with a cu_zoom over the text block reads it. Saves the overview image cropped to the text block
(overview-crop.png) and the zoom image (zoom.png) for the host to re-read with the same Vision engine: the crop
should fail where the zoom succeeds, which is what makes the zoom necessary. results.json keeps the synthetic
texts (no screen content).
"""
import argparse
import base64
import io
import json
import random
import sys
import time
from pathlib import Path

from PIL import Image

BENCH = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BENCH))
from vmguard import require_vm  # noqa: E402  (fail closed on the host)
sys.path.insert(0, str(BENCH / 'experiments'))
from ocr_cache import App, Daemon, FIXTURE, WORDS, edit_distance, kill_all, norm  # noqa: E402

TASK = 'small-text'
SIZES = (8, 9, 10, 11)


def read(truth, ocr):
    """truth id -> correct, for the OCR line whose centre lies in the truth rect widened by 3 pt."""
    out = {}
    for t in truth:
        best = 99
        for e in ocr:
            x, y, w, h = e['frame_pt']
            cx, cy = x + w / 2, y + h / 2
            if t['x'] - 3 <= cx <= t['x'] + t['w'] + 3 and t['y'] - 3 <= cy <= t['y'] + t['h'] + 3:
                best = min(best, edit_distance(norm(t['text']), norm(e['text'])))
        out[t['id']] = best <= 1
    return out


def main():
    require_vm(Path(__file__).name)
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(928)

    kill_all()
    fx = App(Path('/tmp/small-apps/fx'), x=150, y=150, w=800, h=520)
    fx.ready()
    d = Daemon()
    d.call('grants.set', {'task_id': TASK, 'bundle_ids': [FIXTURE], 'source': 'config', 'expires_in_s': 3600})
    lines, y = [], 40
    for size in SIZES:
        for k in range(3):
            lines.append({'id': len(lines), 'text': ' '.join(rng.sample(WORDS, 3)), 'x': 70, 'y': y, 'size': size, 'ax': False})
            y += size + 12
    fx.cmd('lines', lines=lines, settle=0.8)
    fx.cmd('focus', settle=0.5)
    truth = fx.state()['windows']['main']['texts']
    size_of = {l['id']: l['size'] for l in lines}

    obs = d.call('observe', {'task_id': TASK, 'ocr': 'on', 'include_image': True})
    daemon_ok = read(truth, [e for e in obs['untrusted_observation']['elements'] if e['source'] == 'ocr'])

    # The text block, in global points, with a margin.
    x0 = min(t['x'] for t in truth) - 10
    y0 = min(t['y'] for t in truth) - 10
    x1 = max(t['x'] + t['w'] for t in truth) + 10
    y1 = max(t['y'] + t['h'] for t in truth) + 10
    m = obs['image']['mapping']
    k = m['sent_size_px'][0] / m['display_bounds_pt'][2]
    img = Image.open(io.BytesIO(base64.b64decode(obs['image']['base64'])))
    img.crop((int(x0 * k), int(y0 * k), int(x1 * k) + 1, int(y1 * k) + 1)).save(out / 'overview-crop.png')

    z = d.call('zoom', {'task_id': TASK, 'snapshot_gen': obs['snapshot_gen'],
                        'rect': {'x': x0, 'y': y0, 'w': x1 - x0, 'h': y1 - y0, 'space': 'screen'}})
    Image.open(io.BytesIO(base64.b64decode(z['image']['base64']))).save(out / 'zoom.png')
    zoom_ok = read(truth, z['untrusted_observation']['ocr'])

    res = {
        'overview_px_per_pt': round(k, 3),
        'zoom_magnification': z['magnification'],
        'zoom_sent_size_px': z['image']['mapping']['sent_size_px'],
        'block_pt': [round(x0), round(y0), round(x1 - x0), round(y1 - y0)],
        'lines': [{'id': t['id'], 'size_px': size_of[t['id']], 'text': t['text'],
                   'rect_pt': [round(t['x'], 1), round(t['y'], 1), round(t['w'], 1), round(t['h'], 1)],
                   'daemon_ocr_ok': daemon_ok[t['id']], 'zoom_ocr_ok': zoom_ok[t['id']]} for t in truth],
    }
    res['by_size'] = {str(s): {'daemon_ocr_ok': sum(l['daemon_ocr_ok'] for l in res['lines'] if l['size_px'] == s),
                               'zoom_ocr_ok': sum(l['zoom_ocr_ok'] for l in res['lines'] if l['size_px'] == s), 'of': 3}
                      for s in SIZES}
    fx.stop()
    kill_all()
    (out / 'results.json').write_text(json.dumps(res, indent=2))
    print(json.dumps(res['by_size']))


if __name__ == '__main__':
    main()
