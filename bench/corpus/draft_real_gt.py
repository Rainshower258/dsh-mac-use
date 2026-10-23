#!/usr/bin/env python3
"""Draft ground truth for real-app screenshots (QQ / 微信 / 飞书 / 86Box).

Put screenshots in bench/corpus/real/ (gitignored, never leaves this machine),
then run this. For every PNG without a *.gt.json it writes a *draft* using
Apple Vision: `lines` in reading order, empty `keystrings` / `regions`, and
"draft": true. The maintainer proofreads each file, fixes lines, adds keystrings and the
few clickable regions needed, and deletes "draft". The offline scorer skips
files still marked draft.

    python3 bench/corpus/draft_real_gt.py [bench/corpus/real]
"""
import json
import subprocess
import sys
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
VISION = BENCH / 'tools/bin/vision-ocr'


def main(real: Path) -> None:
    todo = [p for p in sorted(real.glob('*.png')) if not p.with_name(p.stem + '.gt.json').exists()]
    if not todo:
        print('nothing to draft')
        return
    out = subprocess.run([str(VISION), *map(str, todo)], capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        rec = json.loads(line)
        if 'image' not in rec:
            continue
        img = Path(rec['image'])
        blocks = sorted(rec.get('blocks', []), key=lambda b: (round(b['bbox'][1] / 10), b['bbox'][0]))
        gt = {
            'image': img.name,
            'source': 'real',
            'draft': True,
            'app': img.stem.split('_')[0],
            'lines': [b['text'] for b in blocks],
            'keystrings': [],
            'regions': [],
            '_ocr_draft_boxes': [{'text': b['text'], 'bbox': [round(v) for v in b['bbox']]} for b in blocks],
        }
        img.with_name(img.stem + '.gt.json').write_text(json.dumps(gt, ensure_ascii=False, indent=2))
        print(f'drafted {img.stem}.gt.json ({len(blocks)} lines)')


if __name__ == '__main__':
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else BENCH / 'corpus/real')
