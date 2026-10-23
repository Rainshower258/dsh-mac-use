#!/usr/bin/env python3
"""T6 set-up probe (guest only): start 86Box on a VM folder, then observe it through the daemon (OCR on) at fixed
times and keep each image and its OCR lines, to see whether it boots straight to the fixed DOS screen.

    bench/experiments/run_vm_experiment.sh app86box_probe.py --vm 86box/t6 [--keys 12:f1] [--times 5,10,20,30]

--keys T:CHORD sends a chord to 86Box at T seconds (e.g. a BIOS "press F1" prompt), each logged in results.json.
86Box itself comes from ~/Applications/86Box.app (EXTRA_SYNC in run_vm_experiment.sh puts it there).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ax_manual_accessibility import Daemon  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vmguard import require_vm  # noqa: E402

APP = 'net.86Box.86Box'
APP_SEEN = APP.lower()  # how the daemon reports it (bundle ids compared case-insensitively)
TASK = 'exp-86box-probe'


def main() -> None:
    require_vm('app86box_probe.py')
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', type=Path, required=True)
    ap.add_argument('--vm', required=True, help='86Box VM folder (holds 86box.cfg), relative to the guest home')
    ap.add_argument('--app', default=str(Path.home() / 'Applications/86Box.app'))
    ap.add_argument('--roms', default=str(Path.home() / '86box/roms'))
    ap.add_argument('--times', default='5,10,20,30')
    ap.add_argument('--keys', default='', help='comma-separated T:CHORD')
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    vm = Path.home() / a.vm  # relative: a ~ on the runner's command line would expand on the host
    if not (vm / '86box.cfg').exists():
        raise SystemExit(f'no 86box.cfg in {vm}')
    subprocess.run(['open', '-n', '-a', a.app, '--args', '-P', str(vm), '-R', os.path.expanduser(a.roms),
                    '-L', str(a.out / '86box.log')], check=True)
    t0 = time.time()
    d = Daemon()
    d.call('grants.set', {'task_id': TASK, 'bundle_ids': [APP], 'source': 'config', 'expires_in_s': 3600,
                          'electron_ax': False})
    keys = sorted((float(t), c) for t, c in (k.split(':', 1) for k in a.keys.split(',') if k))
    shots, sent, gen = [], [], None
    for t in sorted(float(x) for x in a.times.split(',')):
        while keys and keys[0][0] <= t:
            kt, chord = keys.pop(0)
            time.sleep(max(0.0, kt - (time.time() - t0)))
            try:
                d.call('act.key', {'task_id': TASK, 'app': APP, 'chord': chord, **({'snapshot_gen': gen} if gen else {})})
                sent.append({'t': kt, 'chord': chord, 'ok': True})
            except SystemExit as e:
                sent.append({'t': kt, 'chord': chord, 'ok': False, 'error': str(e)[:300]})
        time.sleep(max(0.0, t - (time.time() - t0)))
        try:
            obs = d.call('observe', {'task_id': TASK, 'ocr': 'on', 'include_image': True})
        except SystemExit as e:
            shots.append({'t': t, 'error': str(e)[:300]})
            continue
        gen = obs.get('snapshot_gen')
        els = obs['untrusted_observation']['elements']
        lines = [{'text': e['text'], 'frame_pt': e['frame_pt']} for e in els if e['source'] == 'ocr']
        ax = [{'role': e.get('role'), 'text': e['text']} for e in els if e['source'] == 'ax'][:40]
        imgs = []
        for i, im in enumerate(obs.get('images') or ([obs['image']] if obs.get('image') else [])):
            p = a.out / f'shot-{int(t):03d}-{i}.png'
            p.write_bytes(base64.b64decode(im['base64']))
            imgs.append({'file': p.name, 'frame_pt': im.get('frame_pt')})
        shots.append({'t': t, 'obs_keys': sorted(obs), 'windows': [w for w in obs['windows'] if w['app'] == APP_SEEN], 'images': imgs,
                      'ocr_lines': lines, 'ax_sample': ax})
    d.call('grants.revoke', {'task_id': TASK})
    cfg = vm / '86box.cfg'
    if cfg.exists():  # what 86Box made of the config (it rewrites it)
        (a.out / '86box.cfg').write_text(cfg.read_text(errors='replace'))
    (a.out / 'results.json').write_text(json.dumps({'vm': str(vm), 'keys': sent, 'shots': shots}, ensure_ascii=False,
                                                   indent=1))
    for s in shots:
        print(f't={s["t"]:>4.0f}s', s.get('error') or ' | '.join(l['text'] for l in s['ocr_lines'])[:400])


if __name__ == '__main__':
    main()
