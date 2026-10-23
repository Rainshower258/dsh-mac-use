#!/usr/bin/env python3
"""Sanity-check a corpus directory.

For every <name>.png with a <name>.gt.json:
  * the screenshot is not blank (a Chromium window captured before its first
    frame reaches the window server is a flat background);
  * every non-clipped ground-truth line box actually contains ink, i.e. the
    point->pixel mapping lines up with the pixels;
  * for fixture shots, how much of the ground truth the AX text exposes.

    python3 bench/corpus/check.py [bench/corpus/synthetic]
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'offline'))
from metrics import ax_strings  # noqa: E402

import numpy as np
from PIL import Image

INK_STD = 12.0  # grey-level std inside a text box; flat background is ~0


def main(corpus: Path) -> int:
    failures = 0
    rows = []
    for gt_path in sorted(corpus.glob('*.gt.json')):
        gt = json.loads(gt_path.read_text())
        img = np.asarray(Image.open(corpus / gt['image']).convert('L'), dtype=np.float32)
        name = gt['image'][:-4]
        problems = []
        if img.std() < 5:
            problems.append('blank screenshot')
        dead = 0
        for line in gt.get('linesDetail', []):
            if line.get('clipped'):
                continue
            x, y, w, h = line['bbox']
            crop = img[max(0, y):y + h, max(0, x):x + w]
            if crop.size == 0 or crop.std() < INK_STD * (0.35 if line.get('faint') else 1):
                dead += 1
        if dead:
            problems.append(f'{dead} gt boxes without ink')
        ax_path = corpus / f'{name}.ax.txt'
        ax_cover = None
        if ax_path.exists():
            ax = re.sub(r'\s+', '', '\n'.join(ax_strings(ax_path.read_text())))
            lines = [re.sub(r'\s+', '', t) for t in gt['lines']]
            ax_cover = sum(1 for t in lines if t and t in ax) / max(1, len(lines))
        rows.append((name, len(gt['lines']), len(gt['keystrings']), ax_cover, problems))
        failures += bool(problems)

    print(f'{"shot":34} {"lines":>5} {"keys":>4} {"AX line coverage":>16}  problems')
    for name, n_lines, n_keys, ax_cover, problems in rows:
        cover = '-' if ax_cover is None else f'{ax_cover:.0%}'
        print(f'{name:34} {n_lines:5} {n_keys:4} {cover:>16}  {"; ".join(problems)}')
    print(f'\n{len(rows)} shots, {failures} with problems')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main(Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent / 'synthetic')))
