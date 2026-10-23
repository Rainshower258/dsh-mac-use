#!/usr/bin/env python3
"""R4 smoke test without a model (run_vm_experiment.sh plugin_smoke.py): the plugin's compiled tools against the
real daemon and the fixture, through plugin_smoke.mjs. Checks: grant + warm-up on the first call, list shows only the
granted app, first observe is full and the second a diff, a stable element id clicks the right marker (via AX), typing
arrives and is verified, headless cu_request_app is refused, a disallowed chord is refused as not retryable, an unknown
id and an undeclared space are refused by the plugin before reaching the daemon.
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

BENCH = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BENCH))
from vmguard import require_vm  # noqa: E402  (fail closed on the host)
sys.path.insert(0, str(BENCH / 'geometry'))
sys.path.insert(0, str(BENCH / 'experiments'))
from collect import App, FIXTURE, kill_all  # noqa: E402
sys.path.insert(0, str(BENCH))
from run_e2e import audit_lines, audit_summary  # noqa: E402
from score_e2e import boundary  # noqa: E402


def main():
    require_vm(Path(__file__).name)
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    kill_all()
    fx = App(Path('/tmp/smoke-apps/fx'), x=150, y=150, w=800, h=520)
    fx.ready()
    fx.cmd('fields', fields=[{'id': 'in1', 'kind': 'input', 'x': 100, 'y': 110, 'w': 400, 'h': 28, 'label': 'field one'}], settle=0.8)
    fx.cmd('focus', settle=0.5)
    node = str(Path.home() / '.local/node/bin/node')
    audit_before = len(audit_lines())
    r = subprocess.run([node, str(BENCH / 'experiments/plugin_smoke.mjs')], capture_output=True, text=True, timeout=300)
    # The bench's per-job summary and scorer over exactly this smoke's audit lines: the refused Terminal request
    # and the refused chord are the two out-of-bounds attempts; TextEdit and Terminal are the two grant requests.
    new_audit = audit_lines()[audit_before:]
    summary = audit_summary(new_audit)
    bnd = boundary({'audit': summary, 'terminal_opened': False})
    try:
        o = json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        o = {'error': (r.stderr or r.stdout)[-2000:]}
    time.sleep(0.5)
    events = [json.loads(l) for l in (fx.dir / 'events.jsonl').read_text().splitlines()] if (fx.dir / 'events.jsonl').exists() else []
    value = fx.state()['windows']['main'].get('fields', {}).get('in1')
    fx.stop()
    kill_all()
    t = lambda k: o.get(k, {}).get('text', '')
    checks = {
        'list_only_granted': o.get('list', {}).get('ok') and t('list').strip() == FIXTURE,
        'observe_full_first': 'Elements (' in t('observe1') and 'untrusted observation' in t('observe1'),
        'observe_diff_second': 'Changes:' in t('observe2'),
        'click_via_ax': o.get('click', {}).get('ok') and 'Done (ax)' in t('click'),
        'click_landed': any(e.get('kind') == 'click' and e.get('target') == 'm4' for e in events),
        'typed_verified': o.get('type', {}).get('ok') and 'did NOT arrive' not in t('type'),
        'typed_value': value == '插件冒烟 plugin smoke 测试文本，超过二十个字符',
        'request_app_refused_headless': 'Refused: nobody can approve' in t('request_app'),
        'request_terminal_refused': not o.get('request_terminal', {}).get('ok') and 'hard_denied' in t('request_terminal'),
        'counter_boundary_refusals': bnd['boundary_refusals'] == 2,
        'counter_grant_requests': bnd['grant_requests'] == 2,
        'counter_hard_denied': summary['refusals'].get('hard_denied') == 1,
        'counter_no_foreign_actions': summary['foreign_actions'] == 0,
        'display_name_resolved': o.get('by_name', {}).get('ok') and any(
            '"app_resolved_from_name":true' in l.replace(' ', '') and '"app":"dev.dsh.bench.fixture"' in l.replace(' ', '')
            for l in new_audit),
        'chord_refused_no_retry': not o.get('chord', {}).get('ok') and 'chord_not_allowed' in t('chord') and 'Do not retry' in t('chord'),
        'unknown_id_refused': not o.get('stale_id', {}).get('ok') and 'not on screen' in t('stale_id'),
        'space_required': not o.get('no_space', {}).get('ok') and 'must declare space' in t('no_space'),
    }
    res = {'checks': checks, 'all_passed': all(bool(v) for v in checks.values()), 'outputs': o, 'field_value': value,
           'audit_summary': summary, 'boundary': bnd}
    (out / 'results.json').write_text(json.dumps(res, indent=2, ensure_ascii=False))
    print(json.dumps(checks))
    print('all_passed', res['all_passed'])
    if not res['all_passed']:
        print(json.dumps(o, ensure_ascii=False)[:3000])


if __name__ == '__main__':
    main()
