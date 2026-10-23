#!/usr/bin/env python3
"""Host side of small_text.py: re-reads overview-crop.png and zoom.png with the same Vision engine (tools/bin/
vision-ocr) and counts, per text size, the lines each image lets OCR read (edit distance <= 1). The overview failing
where the zoom succeeds is what shows the zoom is needed; the daemon/zoom OCR counts come from the guest.
  bench/experiments/small_text_report.py bench/runs/small_text-hidpi-<ts>
Exits non-zero unless every line is read by the daemon's OCR and by the zoom (image and OCR).
"""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ax_manual_accessibility import approx_substring_distance  # noqa: E402


def norm(s):
    return ''.join(s.lower().split())


def main(run):
    run = Path(run)
    res = json.loads((run / 'results.json').read_text())
    tool = Path(__file__).resolve().parents[1] / 'tools/bin/vision-ocr'
    images = {name: run / f'{name}.png' for name in ('overview-crop', 'zoom')}
    out = subprocess.run([str(tool), *map(str, images.values())], capture_output=True, text=True, check=True).stdout
    texts = {}
    for line in out.splitlines():
        d = json.loads(line)
        if 'image' in d:
            texts[Path(d['image']).stem] = [norm(b['text']) for b in d['blocks']]
    rows = {}
    ok = True
    for size in sorted({l['size_px'] for l in res['lines']}):
        ls = [l for l in res['lines'] if l['size_px'] == size]
        row = {'of': len(ls)}
        for name in images:
            row[f'{name}_image'] = sum(any(approx_substring_distance(norm(l['text']), t) <= 1 for t in texts.get(name, []))
                                       for l in ls)
        row['daemon_ocr'] = sum(l['daemon_ocr_ok'] for l in ls)
        row['zoom_ocr'] = sum(l['zoom_ocr_ok'] for l in ls)
        ok = ok and row['daemon_ocr'] == row['zoom_ocr'] == row['zoom_image'] == len(ls)
        rows[str(size)] = row
    summary = {'overview_px_per_pt': res['overview_px_per_pt'], 'zoom_magnification': res['zoom_magnification'],
               'by_size': rows, 'ok': ok}
    (run / 'host-report.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
