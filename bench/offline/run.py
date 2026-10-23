#!/usr/bin/env python3
"""Run one read-screen backend over a corpus and score it.

    python3 bench/offline/run.py --backend apple-vision [--corpus bench/corpus/synthetic]
    python3 bench/offline/run.py --backend ax
    python3 bench/offline/summarize.py        # -> bench/results/offline/summary.md

Backends (see BACKENDS below):
  ax                  what the AX tree text exposes (A0's reading ceiling; no boxes)
  apple-vision        VNRecognizeTextRequest accurate, zh-Hans+en-US, language correction on
  apple-vision-nolc   same, language correction off
  apple-vision-fast   fast recognition level
  http-ocr            POST <image> to $HTTP_OCR_URL (default http://127.0.0.1:9003/ocr)

Writes bench/results/offline/<backend>.json (summary + per-image scores) and the
raw predictions to bench/results/offline/raw/<backend>/<image>.json.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from metrics import ax_strings, bbox_hits, keystring_hits, keystring_hits_loose, percentile, score_lines  # noqa: E402

BENCH = Path(__file__).resolve().parent.parent
VISION = BENCH / 'tools/bin/vision-ocr'


# ---------------------------------------------------------------- backends
# Each backend returns ({image_name: {"blocks": [...], "latency_ms": float|None}}, meta)

def backend_ax(images: list[Path]):
    out = {}
    for img in images:
        ax = img.with_name(img.name[:-4] + '.ax.txt')
        blocks = [{'text': s} for s in ax_strings(ax.read_text())] if ax.exists() else []
        out[img.name] = {'blocks': blocks, 'latency_ms': None}
    return out, {'has_bbox': False, 'note': 'AX tree text captured with the screenshot (disableDiff)'}


def run_timed(cmd: list[str]) -> tuple[str, float, float | None]:
    """Run under /usr/bin/time -l; return stdout, wall ms, peak RSS MB."""
    t0 = time.perf_counter()
    proc = subprocess.run(['/usr/bin/time', '-l', *cmd], capture_output=True, text=True, check=True)
    wall = (time.perf_counter() - t0) * 1000
    m = re.search(r'(\d+)\s+maximum resident set size', proc.stderr)
    return proc.stdout, wall, (int(m.group(1)) / 1e6 if m else None)


def vision_backend(flags: list[str]):
    def run(images: list[Path]):
        if not VISION.exists():
            sys.exit(f'build first: swiftc -O -target arm64-apple-macosx14.0 {BENCH}/tools/vision-ocr.swift -o {VISION}')
        # Cold start: fresh process, one image, wall clock to first result.
        _, cold_ms, _ = run_timed([str(VISION), *flags, str(images[0])])
        stdout, wall, rss = run_timed([str(VISION), *flags, *map(str, images)])
        out = {}
        for line in stdout.splitlines():
            rec = json.loads(line)
            if 'image' in rec:
                out[Path(rec['image']).name] = {'blocks': rec.get('blocks', []), 'latency_ms': rec.get('latency_ms'), 'error': rec.get('error')}
        return out, {'has_bbox': True, 'cold_start_ms': cold_ms, 'peak_rss_mb': rss, 'batch_wall_ms': wall, 'flags': flags}
    return run


def backend_http_ocr(images: list[Path]):
    url = os.environ.get('HTTP_OCR_URL', 'http://127.0.0.1:9003/ocr')
    if urllib.parse.urlsplit(url).scheme not in ('http', 'https'):
        raise SystemExit(f'HTTP_OCR_URL must be http(s), got {url!r}')  # no file:// etc.
    out = {}
    for i, img in enumerate(images):
        t0 = time.perf_counter()
        req = urllib.request.Request(url, data=img.read_bytes(), headers={'Content-Type': 'image/png'})
        # Operator-set env var, scheme restricted to http(s) above.
        with urllib.request.urlopen(req, timeout=120) as resp:  # nosemgrep: dynamic-urllib-use-detected
            rec = json.load(resp)
        ms = (time.perf_counter() - t0) * 1000
        out[img.name] = {'blocks': rec['blocks'], 'latency_ms': ms, 'server_ms': rec.get('latency_ms')}
        if i == 0:
            first_ms = ms
    return out, {'has_bbox': True, 'url': url, 'first_request_ms': first_ms,
                 'note': 'cold start / peak RSS are reported by the server itself (see bench/servers)'}


def cu_runtime_backend(flags: list[str]):
    """The daemon's own OCR (same request settings, same cropping) on the corpus: `cu-runtime ocr-files`."""
    exe = BENCH.parent / '.build/release/cu-runtime'

    def run(images: list[Path]):
        if not exe.exists():
            sys.exit(f'build first: (cd {BENCH.parent} && swift build -c release)')
        _, cold_ms, _ = run_timed([str(exe), 'ocr-files', *flags, str(images[0])])
        stdout, wall, rss = run_timed([str(exe), 'ocr-files', *flags, *map(str, images)])
        out = {}
        for line in stdout.splitlines():
            rec = json.loads(line)
            if 'image' in rec:
                out[Path(rec['image']).name] = {'blocks': rec.get('blocks', []), 'latency_ms': rec.get('latency_ms'), 'error': rec.get('error')}
        return out, {'has_bbox': True, 'cold_start_ms': cold_ms, 'peak_rss_mb': rss, 'batch_wall_ms': wall, 'flags': flags}
    return run


BACKENDS = {
    'ax': backend_ax,
    'cu-runtime': cu_runtime_backend([]),
    'cu-runtime-bands': cu_runtime_backend(['--band-pt', '96']),
    'apple-vision': vision_backend([]),
    'apple-vision-nolc': vision_backend(['--no-lc']),
    'apple-vision-fast': vision_backend(['--fast']),
    'http-ocr': backend_http_ocr,
}


# ---------------------------------------------------------------- scoring

def line_buckets(detail: dict) -> list[str]:
    block, part = detail.get('block', ''), detail.get('part')
    if block.startswith(('conv:', 'search', 'sidebar')):
        base = ['sidebar']
    elif not block.startswith('msg:'):
        base = ['ui']  # header title, buttons, input placeholder
    else:
        base = [{'meta': 'msg-meta', 'image': 'msg-image', 'code': 'msg-code'}.get(part, 'msg-body')]
    if part == 'body' and detail.get('fontPx') == 11:
        base.append('msg-small')
    if detail.get('faint'):
        base.append('msg-faint')
    return base


def score_corpus(corpus: Path, preds: dict) -> dict:
    per_image = []
    agg = defaultdict(lambda: [0, 0, 0, 0])  # bucket -> dist_s, len_s, dist_l, len_l
    keys = defaultdict(lambda: [0, 0])
    keys_loose = defaultdict(lambda: [0, 0])
    bbox = defaultdict(lambda: [0, 0])
    for gt_path in sorted(corpus.glob('*.gt.json')):
        gt = json.loads(gt_path.read_text())
        if gt.get('draft'):
            continue  # real-app ground truth not yet proofread
        pred = preds.get(gt['image'])
        if pred is None:
            continue
        blocks = pred['blocks']
        fx = gt.get('fixture', {})
        slices = [f"mode:{fx.get('mode', 'real')}", f"theme:{fx.get('theme', '-')}", 'all']
        visible = [d for d in gt.get('linesDetail', [{'text': t} for t in gt['lines']]) if not d.get('clipped')]
        scores = score_lines([d['text'] for d in visible], blocks)
        lines_out = []
        for d, s in zip([d for d in visible if d['text'].strip()], scores):
            buckets = line_buckets(d) if 'part' in d else ['all-lines']
            for b in [*buckets, *slices]:
                a = agg[b]
                a[0] += s.dist_strict; a[1] += s.len_strict; a[2] += s.dist_loose; a[3] += s.len_loose
            lines_out.append({'gt': s.text, 'pred': s.best, 'dist': s.dist_strict, 'len': s.len_strict, 'buckets': buckets})
        khits = keystring_hits(gt['keystrings'], blocks)
        khits_loose = keystring_hits_loose(gt['keystrings'], blocks)
        for sl in slices:
            keys[sl][0] += sum(khits.values()); keys[sl][1] += len(khits)
            keys_loose[sl][0] += sum(khits_loose.values()); keys_loose[sl][1] += len(khits_loose)
        bhits = bbox_hits(gt.get('regions', []), blocks)
        for sl in slices:
            bbox[sl][0] += sum(h['hit'] for h in bhits); bbox[sl][1] += len(bhits)
        per_image.append({
            'image': gt['image'], 'latency_ms': pred.get('latency_ms'),
            'cer': sum(s.dist_strict for s in scores) / max(1, sum(s.len_strict for s in scores)),
            'keystrings': khits, 'keystrings_loose': khits_loose, 'bbox_hits': bhits, 'lines': lines_out,
        })
    lat = [p['latency_ms'] for p in per_image if p['latency_ms'] is not None]
    return {
        'images': len(per_image),
        'cer': {b: {'strict': a[0] / a[1] if a[1] else None, 'loose': a[2] / a[3] if a[3] else None, 'chars': a[1]} for b, a in sorted(agg.items())},
        'keystring_recall': {k: {'hit': v[0], 'total': v[1], 'recall': v[0] / v[1] if v[1] else None} for k, v in sorted(keys.items())},
        'keystring_recall_loose': {k: {'hit': v[0], 'total': v[1], 'recall': v[0] / v[1] if v[1] else None} for k, v in sorted(keys_loose.items())},
        'bbox_hit_rate': {k: {'hit': v[0], 'total': v[1], 'rate': v[0] / v[1] if v[1] else None} for k, v in sorted(bbox.items())},
        'latency_ms': {'p50': percentile(lat, 0.5), 'p95': percentile(lat, 0.95), 'n': len(lat)},
        'per_image': per_image,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--backend', required=True, choices=sorted(BACKENDS))
    ap.add_argument('--corpus', default=str(BENCH / 'corpus/synthetic'))
    ap.add_argument('--out', default=str(BENCH / 'results/offline'))
    args = ap.parse_args()
    corpus = Path(args.corpus)
    images = sorted(p for p in corpus.glob('*.png'))
    preds, meta = BACKENDS[args.backend](images)
    result = {'backend': args.backend, 'corpus': str(corpus.relative_to(BENCH)) if corpus.is_relative_to(BENCH) else str(corpus),
              'generated': time.strftime('%Y-%m-%d %H:%M:%S'), 'meta': meta, **score_corpus(corpus, preds)}
    out = Path(args.out)
    raw = out / 'raw' / args.backend
    raw.mkdir(parents=True, exist_ok=True)
    for name, pred in preds.items():
        (raw / f'{name[:-4]}.json').write_text(json.dumps(pred, ensure_ascii=False, indent=1))
    suffix = '' if corpus.name == 'synthetic' else f'.{corpus.name}'
    (out / f'{args.backend}{suffix}.json').write_text(json.dumps(result, ensure_ascii=False, indent=1))
    c = result['cer']['all']
    k = result['keystring_recall']['all']
    b = result['bbox_hit_rate']['all']
    print(f"{args.backend}: CER strict {c['strict']:.3f} loose {c['loose']:.3f} | keystrings {k['hit']}/{k['total']} | "
          f"bbox {b['hit']}/{b['total']} | p50 {result['latency_ms']['p50']} ms | meta {json.dumps({x: y for x, y in meta.items() if x != 'note'})}")


if __name__ == '__main__':
    main()
