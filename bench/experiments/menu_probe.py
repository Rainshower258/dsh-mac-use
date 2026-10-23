#!/usr/bin/env python3
"""act.menu against the real daemon and TextEdit (2026-10-09, cu_menu). Guest side; run with
run_vm_experiment.sh menu_probe.py. Checks, fixed in advance:
  bar_listed       path [] lists the menu titles, and the Apple menu is not among them
  app_menu_listed  the app menu lists items, and Services is not among them
  services_refused [app menu, Services] is refused menu_excluded
  apple_unknown    ["Apple"] is refused menu_not_found (the Apple menu cannot be matched)
  file_new         [File, New] is pressed and TextEdit then shows a window
  unknown_item     [File, <nonsense>] is refused menu_not_found with the available titles
  disabled_item    a disabled item, if the File menu has one, is refused menu_item_disabled (else noted)
  audit_clean      no menu title appears in the audit
Writes <out>/results.json.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

BENCH = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BENCH))
from vmguard import require_vm  # noqa: E402
sys.path.insert(0, str(BENCH / 'experiments'))
from ax_manual_accessibility import Daemon  # noqa: E402
from approval_dialog import audit_lines, call  # noqa: E402

TE = 'com.apple.TextEdit'


def main():
    require_vm(Path(__file__).name)
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    out = Path(os.path.expanduser(ap.parse_args().out))
    out.mkdir(parents=True, exist_ok=True)
    res = {'checks': {}, 'notes': {}}
    chk, note = res['checks'], res['notes']
    subprocess.run(['pkill', '-x', 'TextEdit'], check=False)
    time.sleep(1)
    d = Daemon()
    d.call('grants.set', {'task_id': 'm', 'bundle_ids': [TE], 'source': 'config', 'allow_launch': True})
    d.call('apps.launch', {'task_id': 'm', 'app': TE})
    time.sleep(3)
    menu = lambda path: call(d, 'act.menu', {'task_id': 'm', 'app': TE, 'path': path})  # noqa: E731

    bar, err = menu([])
    titles = [i['title'] for i in (bar or {}).get('untrusted_items', [])]
    note['bar'] = titles or err
    chk['bar_listed'] = bool(titles) and not any(t.lower() == 'apple' for t in titles)
    app_menu = titles[0] if titles else 'TextEdit'
    items, err = menu([app_menu])
    app_items = [i['title'] for i in (items or {}).get('untrusted_items', [])]
    note['app_menu'] = app_items or err
    chk['app_menu_listed'] = bool(app_items) and not any(t.lower() in ('services', '服务') for t in app_items)
    _, err = menu([app_menu, 'Services'])
    chk['services_refused'] = err == 'menu_excluded'
    _, err = menu(['Apple'])
    chk['apple_unknown'] = err == 'menu_not_found'
    note['apple'] = err
    file_menu = next((t for t in titles if t.lower() in ('file', '文件')), None)
    note['file_menu'] = file_menu
    fitems, err = menu([file_menu or 'File'])
    fitems = (fitems or {}).get('untrusted_items', [])
    new_item = next((i['title'] for i in fitems if i['title'].lower() in ('new', '新建')), None)
    note['file_items'] = [(i['title'], i['enabled']) for i in fitems] or err
    r, err = menu([file_menu or 'File', new_item or 'New'])
    time.sleep(1.5)
    obs = d.call('observe', {'task_id': 'm', 'ocr': 'off', 'include_image': False})
    chk['file_new'] = bool(r and r.get('executed')) and len(obs.get('windows', [])) > 0
    note['file_new'] = {'result': r, 'err': err, 'windows': len(obs.get('windows', []))}
    _, err = menu([file_menu or 'File', 'Zzz Nope'])
    chk['unknown_item'] = err == 'menu_not_found'
    disabled = next((i['title'] for i in fitems if not i['enabled'] and not i['submenu']), None)
    if disabled:
        _, err = menu([file_menu or 'File', disabled])
        chk['disabled_item'] = err == 'menu_item_disabled'
    else:
        note['disabled_item'] = 'no disabled leaf in the File menu'
    blob = json.dumps(audit_lines(), ensure_ascii=False)
    chk['audit_clean'] = not any(t and t in blob for t in (app_items + [i['title'] for i in fitems]) if len(t) > 3)
    d.call('grants.revoke', {'task_id': 'm'})
    subprocess.run(['pkill', '-x', 'TextEdit'], check=False)
    (out / 'results.json').write_text(json.dumps(res, ensure_ascii=False, indent=2))
    print(json.dumps(res, ensure_ascii=False, indent=2))
    sys.exit(0 if all(chk.values()) else 1)


if __name__ == '__main__':
    main()
