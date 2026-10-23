#!/usr/bin/env python3
"""Aggregate bench/runs/geometry-*/<config>/results.json into summary.md (errors in points)."""
import json
import sys
from pathlib import Path


def host_leak_check(cfg_dir, rec):
    """Re-OCR the leak scenario's composites on the host with the same Vision engine: the positive control must be
    read, the canary must not (within 2 edits)."""
    import subprocess
    tool = Path(__file__).resolve().parents[1] / 'tools/bin/vision-ocr'
    images = [p for p in (cfg_dir / 'leak-sent.png', cfg_dir / 'leak-native.png', cfg_dir / 'leak-zoom.png') if p.exists()]
    if not tool.exists() or not images:
        return {'host_ocr': 'unavailable'}, False
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'experiments'))
    from ax_manual_accessibility import approx_substring_distance
    out = subprocess.run([str(tool), *map(str, images)], capture_output=True, text=True).stdout
    res, ok = {}, True
    for line in out.splitlines():
        d = json.loads(line)
        if 'image' not in d:
            continue
        texts = [''.join(b['text'].split()).upper() for b in d['blocks']]
        pos = any(rec['posctrl'] in t for t in texts)
        near = min((approx_substring_distance(rec['canary'], t) for t in texts), default=99)
        res[Path(d['image']).name] = {'positive_control_read': pos, 'canary_min_edit_distance': near}
        ok = ok and pos and near > 2
    return {'host_ocr': res}, ok


def main(root, configs):
    """configs: the configs that were supposed to run. Returns the exit status: 0 only if every one of them produced
    results, collect.py did not crash, there was at least one result, and nothing failed. A scenario marked xfail
    (a known gap with a planned fix) that fails is reported but does not fail the run; one that PASSES does, so the
    marker gets removed and the assertion becomes a normal one."""
    root = Path(root)
    lines = ['# Geometry suite', '', f'Run: `{root.name}`. Errors in points; limits A/B/C 2 pt, D one sent pixel.', '']
    total = passed = 0
    xfailed, xpassed, broken = [], [], []
    for cfg in configs or sorted(p.name for p in root.iterdir() if p.is_dir()):
        cfg_dir = root / cfg
        rc_file = cfg_dir / 'collect.rc'
        if rc_file.exists() and rc_file.read_text().strip() == '3':   # bench/sysalert.py
            env = json.loads((cfg_dir / 'results.json').read_text())['meta'].get('env_failure')
            broken.append(f'{cfg}: ENVIRONMENT FAILURE, nothing measured: {env} (system log: {cfg}/system-prompt.log)')
            lines += [f'## {cfg} — ENVIRONMENT FAILURE', '', f'{env}. See `{cfg}/system-prompt.log`.', '']
            continue
        if rc_file.exists() and rc_file.read_text().strip() != '0':
            broken.append(f'{cfg}: collect.py exited {rc_file.read_text().strip()}')
        if not (cfg_dir / 'results.json').exists():
            broken.append(f'{cfg}: no results (see {cfg}/runner.log)')
            lines += [f'## {cfg} — NO RESULTS', '', f'See `{cfg}/runner.log`.', '']
            continue
        data = json.loads((cfg_dir / 'results.json').read_text())
        disp = data['meta'].get('display') or {}
        lines += [f"## {cfg_dir.name} — display {disp.get('bounds', {}).get('width')}x{disp.get('bounds', {}).get('height')} pt, "
                  f"scale {disp.get('scaleFactor')}", '',
                  '| scenario | ok | A max/med | B max/med | C max/med | D max/med (limit) | notes |', '|---|---|---|---|---|---|---|']
        for r in data['results']:
            if r['name'] == 'leak':
                info, host_ok = host_leak_check(cfg_dir, r)
                r.update(info)
                r['ok'] = r['ok'] and host_ok
            total += 1
            if r.get('xfail'):
                (xpassed if r['ok'] else xfailed).append(f"{cfg}/{r['name']}")
            else:
                passed += bool(r['ok'])
            p = r.get('paths', {})

            def cell(k):
                s = p.get(k)
                if not s:
                    return '–'
                miss = f", {s['missing']} missing" if s['missing'] else ''
                return f"{s['max']}/{s['median']}{miss}" + (f" ({s['limit']})" if k == 'D' else '')
            notes = []
            if isinstance(r.get('checks'), list):
                notes += [f"{c['check']}: {c['detail']}" for c in r['checks']]
            for k in ('stable_after_s', 'stable_after_activation_s', 'visible_while_away', 'animating_flagged',
                      'capture_ok_after', 'refusal', 'windows', 'ax_markers', 'blobs', 'menu_windows',
                      'menu_drawn_not_blocked', 'flat', 'blocker_pixels_leaked', 'window_y', 'workarea_bottom', 'workarea_left',
                      'landed_ok', 'refused', 'wrong', 'markers_under', 'intercepted', 'truth_reads', 'refusals_naming_interceptor', 'flagged_after', 'outcomes', 'overlay_cg', 'refusal_details', 'hidden_expected', 'stale_retries',
                      'positive_control_read', 'canary_min_edit_distance_in_ocr', 'daemon_files_with_canary',
                      'zoom_positive_control_read', 'zoom_canary_min_edit_distance', 'zoom_magnification', 'host_ocr'):
                if k in r and k != 'windows':
                    notes.append(f'{k}={r[k]}')
            if not r['ok'] and (cfg_dir / f"overlay-{r['name']}.png").exists():
                notes.append(f"overlay-{r['name']}.png")
            if r.get('xfail'):
                notes.insert(0, f"xfail: {r['xfail']}")
            mark = ('⚠️ XPASS' if r['ok'] else '➖ xfail') if r.get('xfail') else ('✅' if r['ok'] else '❌')
            lines.append(f"| {r['name']} | {mark} | {cell('A')} | {cell('B')} | {cell('C')} | {cell('D')} | "
                         + '; '.join(notes).replace('|', '/') + ' |')
        lines.append('')
    judged = total - len(xfailed) - len(xpassed)
    head = [f'**{passed}/{judged} passed.**' + (f' Expected failures: {len(xfailed)}.' if xfailed else '')]
    if xpassed:
        head.append(f'**XPASS (expected to fail, passed; remove the xfail marker):** {", ".join(xpassed)}')
    if broken:
        head.append('**Runner problems:** ' + '; '.join(broken))
    if total == 0:
        head.append('**No results at all.**')
    lines[3:3] = head + ['']
    (root / 'summary.md').write_text('\n'.join(lines))
    print('\n'.join(lines))
    return 0 if total and passed == judged and not xpassed and not broken else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2:]))
