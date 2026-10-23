"""Scoring primitives for the offline read-screen bench.

Everything here is pure and deterministic: a backend's output for one image is
a list of blocks {text, bbox|None, confidence|None}; ground truth is a
*.gt.json from bench/corpus.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

WS = re.compile(r'\s+')


def strip_ws(s: str) -> str:
    return WS.sub('', s)


def norm_strict(s: str) -> str:
    """Layout whitespace is not content: CER is computed on whitespace-free text."""
    return strip_ws(s)


def norm_loose(s: str) -> str:
    """Also forgive width variants (， vs ,  ０ vs 0) — reported next to strict."""
    return strip_ws(unicodedata.normalize('NFKC', s))


def infix_distance(needle: str, hay: str) -> int:
    """Edit distance between `needle` and its best-matching substring of `hay`
    (free deletions of hay's prefix/suffix). Bounded by len(needle)."""
    if not needle:
        return 0
    if not hay:
        return len(needle)
    prev = [0] * (len(hay) + 1)  # empty needle matches anywhere for free
    for i, nc in enumerate(needle, 1):
        cur = [i] + [0] * len(hay)
        for j, hc in enumerate(hay, 1):
            cur[j] = min(prev[j - 1] + (nc != hc), prev[j] + 1, cur[j - 1] + 1)
        prev = cur
    return min(prev)


def window_subtree(ax_text: str) -> list[str]:
    """Only the AXWindow subtrees. The app's menu bar is not window content, and
    its Apple menu lists the user's system-wide Recent Items (private file names)."""
    out, depth = [], None
    for line in ax_text.splitlines():
        indent = len(line) - len(line.lstrip(' '))
        if depth is not None and indent <= depth:
            depth = None
        if depth is None and 'AXWindow' in line:
            depth = indent
        if depth is not None:
            out.append(line)
    return out


def ax_strings(ax_text: str) -> list[str]:
    """Every string the window part of an AX tree exposes: titles, descriptions, values."""
    out: list[str] = []
    for line in window_subtree(ax_text):
        out += re.findall(r'"([^"]*)"', line)
        m = re.search(r' - (.*?)(?: value=|$)', line)
        if m:
            out.append(m.group(1))
        m = re.search(r'value=(.*)$', line)
        if m:
            out.append(m.group(1))
    return [s for s in out if s.strip()]


def rows(blocks: list[dict]) -> list[str]:
    """Join boxed blocks that sit on the same visual row (so one GT line split
    into several OCR boxes, or several GT lines merged, still align)."""
    boxed = [b for b in blocks if b.get('bbox')]
    boxed.sort(key=lambda b: (b['bbox'][1], b['bbox'][0]))
    groups: list[list[dict]] = []
    for b in boxed:
        x, y, w, h = b['bbox']
        for g in groups:
            gx, gy, gw, gh = g[-1]['bbox']
            overlap = min(y + h, gy + gh) - max(y, gy)
            gap = x - (gx + gw)
            if overlap > 0.5 * min(h, gh) and -0.5 * h < gap < 3 * max(h, gh):
                g.append(b)
                break
        else:
            groups.append([b])
    return [' '.join(b['text'] for b in sorted(g, key=lambda b: b['bbox'][0])) for g in groups if len(g) > 1]


@dataclass
class LineScore:
    text: str
    dist_strict: int
    len_strict: int
    dist_loose: int
    len_loose: int
    best: str


def score_lines(gt_lines: list[str], blocks: list[dict]) -> list[LineScore]:
    candidates = [b['text'] for b in blocks] + rows(blocks)
    cand_strict = [norm_strict(c) for c in candidates]
    cand_loose = [norm_loose(c) for c in candidates]
    out = []
    for text in gt_lines:
        s, l = norm_strict(text), norm_loose(text)
        if not s:
            continue
        # Prefilter by character overlap; exact DP only on the top few.
        chars = set(l)
        order = sorted(range(len(candidates)), key=lambda i: -len(chars & set(cand_loose[i])))[:6]
        best_i, best_d = None, len(s)
        for i in order:
            d = infix_distance(s, cand_strict[i])
            if d < best_d:
                best_i, best_d = i, d
        dl = min([infix_distance(l, cand_loose[i]) for i in order] or [len(l)])
        out.append(LineScore(text, best_d, len(s), dl, len(l), candidates[best_i] if best_i is not None else ''))
    return out


def keystring_hits(keystrings: list[str], blocks: list[dict]) -> dict[str, bool]:
    """Exact (whitespace-insensitive, no width folding) presence of each key string
    in the reading-order concatenation (a key string may wrap across two boxes)."""
    ordered = sorted(blocks, key=lambda b: (b['bbox'][1], b['bbox'][0]) if b.get('bbox') else (0, 0))
    full = strip_ws(''.join(b['text'] for b in ordered))
    return {k: strip_ws(k) in full for k in keystrings}


def keystring_hits_loose(keystrings: list[str], blocks: list[dict]) -> dict[str, bool]:
    """Same, after NFKC width folding (℃ == °C, ０ == 0); confusable letters still count."""
    ordered = sorted(blocks, key=lambda b: (b['bbox'][1], b['bbox'][0]) if b.get('bbox') else (0, 0))
    full = norm_loose(''.join(b['text'] for b in ordered))
    return {k: norm_loose(k) in full for k in keystrings}


def bbox_hits(regions: list[dict], blocks: list[dict]) -> list[dict]:
    """For labelled clickable regions: does a block reading that label have its
    centre inside the region? (What an agent needs to click by reading.)"""
    out = []
    boxed = [b for b in blocks if b.get('bbox')]
    for r in regions:
        if r.get('role') not in ('button', 'conv') or not r.get('text'):
            continue
        label = norm_loose(r['text'])
        matches = [b for b in boxed if label and label in norm_loose(b['text'])]
        rx, ry, rw, rh = r['bbox']
        hit = any(rx <= b['bbox'][0] + b['bbox'][2] / 2 <= rx + rw and ry <= b['bbox'][1] + b['bbox'][3] / 2 <= ry + rh for b in matches)
        out.append({'id': r.get('id'), 'label': r['text'], 'hit': hit, 'matches': len(matches)})
    return out


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    v = sorted(values)
    k = (len(v) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)
