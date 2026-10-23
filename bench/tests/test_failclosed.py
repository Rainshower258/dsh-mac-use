"""Fail-closed regression tests (docs/incidents/2026-09-29-host-model-run.md). No model, no screen.

    python3 -m unittest discover -s bench/tests -p 'test_*.py'

The host-only tests run dsh itself when it is on PATH: with the bench profile, a scrubbed environment, a dead
endpoint and no key, so no request can reach a model.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BENCH))

import run_e2e  # noqa: E402
import vmguard  # noqa: E402

ON_HOST = not vmguard.in_vm()
# Entry points that may run on the host: reports read result files only; the QQ measurement is the one documented
# exemption (no model, no dsh, observe only; vmguard.py).
HOST_OK = {'experiments/small_text_report.py', 'geometry/report.py', 'experiments/ax_manual_accessibility.py'}


class VmGuardTest(unittest.TestCase):
    def test_markers(self):
        self.assertTrue(vmguard.in_vm({'kern.hv_vmm_present': '1', 'hw.model': 'VirtualMac2,1'}))
        self.assertFalse(vmguard.in_vm({'kern.hv_vmm_present': '0', 'hw.model': 'Mac17,3'}))
        # Both are required; a missing or unreadable sysctl is not a VM.
        self.assertFalse(vmguard.in_vm({'kern.hv_vmm_present': '1', 'hw.model': 'Mac17,3'}))
        self.assertFalse(vmguard.in_vm({'kern.hv_vmm_present': '0', 'hw.model': 'VirtualMac2,1'}))
        self.assertFalse(vmguard.in_vm({'kern.hv_vmm_present': '', 'hw.model': ''}))

    def test_every_guest_entry_point_is_guarded(self):
        missing = []
        for p in sorted([*BENCH.glob('experiments/*.py'), *BENCH.glob('geometry/*.py'), *BENCH.glob('vm/*.py')]):
            rel = str(p.relative_to(BENCH))
            src = p.read_text()
            if '__main__' not in src or rel in HOST_OK:
                continue
            main = re.search(r'^def main\(.*?\n(.*?)(?=^\S)', src, re.M | re.S)
            if not main or 'require_vm(' not in main.group(1).split('\n')[0]:
                missing.append(rel)
        self.assertEqual(missing, [], 'entry points that must call require_vm() first in main()')

    @unittest.skipUnless(ON_HOST, 'host only')
    def test_runner_refuses_on_host(self):
        proc = subprocess.run([sys.executable, str(BENCH / 'run_e2e.py'), '--arm', 'B3', '--tasks', 'T2-keystring-order',
                               '-k', '1', '--run-id', 'failclosed-should-not-exist'],
                              capture_output=True, text=True, timeout=60)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('refusing to run outside the bench VM', proc.stderr)
        self.assertFalse((BENCH / 'runs' / 'failclosed-should-not-exist').exists())


class ProfileTest(unittest.TestCase):
    def setUp(self):
        self.patch = {e['id']: e for e in run_e2e.profile_patch()}

    def test_profile_itself_disables_bash_and_file_tools(self):
        for row in ['tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search', 'tool-web', 'tool-subagent',
                    'tool-workflow', 'tool-skill']:
            self.assertIs(self.patch[row].get('disabled'), True, row)
        self.assertEqual(sorted(run_e2e.DISABLED_TOOL_ROWS),
                         sorted(i for i, e in self.patch.items() if e.get('disabled') is True))
        self.assertEqual(self.patch['tools']['config'], {'mode': 'native'})
        self.assertEqual(self.patch['sandbox-policy']['config']['mode'], 'read-only')
        self.assertEqual(self.patch['session-telemetry-otel']['config'], {'mode': 'DISABLED'})

    def test_key_only_in_guest(self):
        self.assertEqual(self.patch['llm-deepseek']['config'], {'apiKeyEnv': 'CU_BENCH_DEEPSEEK_KEY'})
        path = self.patch['credentials']['config']['path']
        self.assertEqual(path, '/Users/a1/.cu-bench/credentials.yaml')
        if ON_HOST:
            self.assertFalse(Path(path).exists())
            self.assertFalse((str(Path.home()) + '/').startswith('/Users/a1/'))

    def test_overlay_repeats_the_disables(self):
        arm = {'id': 'B3', 'runtime': 'cu-runtime', 'electron_ax': True}
        overlay = run_e2e.overlay_for(arm, Path('/tmp/x'), '/tmp/x.sock')
        disabled = {e['id'] for e in overlay if e.get('disabled') is True}
        self.assertTrue(set(run_e2e.DISABLED_TOOL_ROWS) <= disabled)

    def test_env_is_scrubbed(self):
        saved = dict(os.environ)
        try:
            os.environ.update(DEEPSEEK_API_KEY='sk-x', DEEPSEEK_BASE_URL='http://x', DSH_PERMISSION_MODE='danger-full-access',
                              DSH_TOOLS_MODE='ptc', CU_BENCH_DEEPSEEK_KEY='sk-y', DSH_HOME='/elsewhere',
                              CLAUDE_CODE_MESSAGING_TOKEN='t', SSH_AUTH_SOCK='/tmp/agent', GH_TOKEN='g')
            env = run_e2e.dsh_env(Path('/run/home'), DEEPSEEK_BASE_URL='http://127.0.0.1:1')
        finally:
            os.environ.clear()
            os.environ.update(saved)
        self.assertEqual(env['DSH_HOME'], '/run/home')
        self.assertEqual(env['DEEPSEEK_BASE_URL'], 'http://127.0.0.1:1')
        for k in ['DEEPSEEK_API_KEY', 'DSH_PERMISSION_MODE', 'DSH_TOOLS_MODE', 'CU_BENCH_DEEPSEEK_KEY',
                  'CLAUDE_CODE_MESSAGING_TOKEN', 'SSH_AUTH_SOCK', 'GH_TOKEN']:
            self.assertNotIn(k, env)
        self.assertIn('PATH', env)

    def test_dead_port_refuses(self):
        import socket
        with self.assertRaises(ConnectionRefusedError):
            socket.create_connection(('127.0.0.1', run_e2e.dead_port()), timeout=2)

    @unittest.skipUnless(ON_HOST and shutil.which('dsh'), 'host with dsh only')
    def test_profile_has_no_key_on_host(self):
        """The layer that holds even if everything above fails: this profile on the host cannot get a key.
        (Dead endpoint as well, so even a wrongly found key could not reach a model.)"""
        with tempfile.TemporaryDirectory() as d:
            home = Path(d) / 'home'
            shutil.copytree(run_e2e.PROFILE_DIR, home / 'profiles' / run_e2e.PROFILE)
            env = run_e2e.dsh_env(home, DEEPSEEK_BASE_URL=f'http://127.0.0.1:{run_e2e.dead_port()}')
            proc = subprocess.run(['dsh', '--profile', run_e2e.PROFILE, 'x'], cwd=d, env=env,
                                  capture_output=True, text=True, timeout=90)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('MISSING_CREDENTIAL', proc.stderr)
        self.assertIn('CU_BENCH_DEEPSEEK_KEY', proc.stderr)

    @unittest.skipUnless(ON_HOST and shutil.which('dsh'), 'host with dsh only')
    def test_selfcheck_sees_reenabled_bash(self):
        """Negative control of the self-check's tool list: an overlay that switches bash and the file tools back on
        must show up as foreign tools. (The 2026-09-29 incident happened while running this control by hand against
        the real API; here the key is fake and the endpoint is a refused local port.)"""
        arm = {'id': 'B3', 'runtime': 'cu-runtime', 'electron_ax': True}
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            home = d / 'home'
            shutil.copytree(run_e2e.PROFILE_DIR, home / 'profiles' / run_e2e.PROFILE)
            overlay = [*run_e2e.overlay_for(arm, d, str(d / 'x.sock'), spawn_daemon=False),
                       {'id': 'tool-bash', 'disabled': False}, {'id': 'tool-fs', 'disabled': False}]
            import yaml
            (d / 'overlay.yml').write_text(yaml.safe_dump(overlay))
            (d / 'settings.yaml').write_text('{}\n')
            env = run_e2e.dsh_env(home, DEEPSEEK_BASE_URL=f'http://127.0.0.1:{run_e2e.dead_port()}',
                                  CU_BENCH_DEEPSEEK_KEY='sk-fake-key')
            proc = subprocess.run(run_e2e.dsh_argv(d / 'overlay.yml', 'preflight'), cwd=d, env=env,
                                  capture_output=True, text=True, timeout=120)
            self.assertIn('TRANSPORT', proc.stderr)
            lists = run_e2e.session_tools(d)
        self.assertTrue(lists, 'dsh wrote no request header')
        foreign = run_e2e.foreign_tools(arm, lists)
        self.assertIn('bash', foreign)
        self.assertIn('read', foreign)


if __name__ == '__main__':
    unittest.main()


class ReadOnlyAppTest(unittest.TestCase):
    """T7 on QQ: a real messenger, read only (allowlist enforced by the daemon; the runner refuses anything else)."""
    cu = {'id': 'B3', 'runtime': 'cu-runtime', 'electron_ax': True}

    def test_every_qq_task_is_read_only(self):
        tasks = [t for t in run_e2e.load_tasks(None) if t.get('app') == 'QQ']
        self.assertGreaterEqual(len(tasks), 3)
        for t in tasks:
            run_e2e.check_read_only(t, self.cu)  # no SystemExit
            self.assertFalse({'type', 'key', 'set_value', 'drag', 'ax_action'} & set(t['actions']), t['id'])
            self.assertTrue(t['setup'].get('popup_check'), t['id'])

    def test_runner_refuses_widened_or_missing_allowlists_and_legacy_arms(self):
        t = run_e2e.load_tasks(['T7-qq-latest'])[0]
        for bad in (None, [], ['observe', 'click', 'type'], ['observe', 'key']):
            with self.assertRaises(SystemExit, msg=bad):
                run_e2e.check_read_only({**t, 'actions': bad}, self.cu)
        with self.assertRaises(SystemExit):
            run_e2e.check_read_only(t, {'id': 'A1', 'runtime': 'legacy'})
        for bad in (None, {'buttons': ['left'], 'max_count': 2}, {'buttons': ['left', 'right'], 'max_count': 1}):
            with self.assertRaises(SystemExit, msg=bad):
                run_e2e.check_read_only({**t, 'click_limit': bad}, self.cu)

    def test_overlay_puts_the_task_allowlist_after_the_arm(self):
        arm = {**self.cu, 'plugin_config': {'actions': ['observe', 'type']}}
        ov = run_e2e.overlay_for(arm, Path('/tmp/x'), '', bundle='com.tencent.qq', actions=['observe', 'click'])
        self.assertEqual(ov[0]['insert'][0]['config']['actions'], ['observe', 'click'])
        ov = run_e2e.overlay_for({**self.cu, 'plugin_config': {'clickLimit': {'buttons': ['right'], 'maxCount': 3}}}, Path('/tmp/x'), '',
                                 bundle='com.tencent.qq', click_limit={'buttons': ['left'], 'max_count': 1})
        self.assertEqual(ov[0]['insert'][0]['config']['clickLimit'], {'buttons': ['left'], 'maxCount': 1})

    def test_popup_check(self):
        app = run_e2e.RealApp.__new__(run_e2e.RealApp)
        app.spec = run_e2e.REAL_APPS['QQ']
        app.setup = {'popup_check': True, 'max_windows': 1, 'popup_text': ['版本更新', '新设备']}
        win = {'app': 'com.tencent.qq', 'id': 1}
        obs = lambda els, wins=(win,), front='com.tencent.qq': {  # noqa: E731
            'frontmost': front, 'windows': list(wins), 'untrusted_observation': {'elements': els}}
        clean = [{'text': '消息', 'source': 'ocr', 'occluded': False}]
        self.assertIsNone(app.popup(obs(clean)))
        self.assertIn('2 app windows', app.popup(obs(clean, (win, {**win, 'id': 2}))))
        self.assertIn('frontmost', app.popup(obs(clean, front='com.apple.usernotificationcenter')))
        self.assertIn('covered', app.popup(obs([{**clean[0], 'occluded': True}])))
        self.assertIn('版本更新', app.popup(obs(clean + [{'text': '发现版本更新', 'source': 'ocr'}])))
        app.setup = {}
        self.assertIsNone(app.popup(obs(clean, front='x')), 'opt-in: T6 (86Box) is unchanged')

    def test_second_safeguard_counts_every_allowed_input(self):
        import json
        lines = [json.dumps(e) for e in (
            {'method': 'act.type', 'decision': 'allow', 'app': 'com.tencent.qq'},
            {'method': 'act.key', 'decision': 'allow', 'chord': 'cmd+v', 'app': 'com.tencent.qq'},
            {'method': 'act.set_value', 'decision': 'allow', 'app': 'com.tencent.qq'},
            {'method': 'act.key', 'decision': 'deny', 'reason': 'action_not_allowed'},
            {'method': 'act.click', 'decision': 'allow', 'app': 'com.tencent.qq'},
        )]
        a = run_e2e.audit_summary(lines, 'com.tencent.qq')
        self.assertEqual((a['text_input_actions'], a['refusals']), (3, {'action_not_allowed': 1}))

    def test_prompt_names_the_tasks_own_app(self):
        t7 = run_e2e.load_tasks(['T7-qq-latest'])[0]
        self.assertIn('目标应用名为 QQ', run_e2e.prompt_for(t7, self.cu))
        self.assertNotIn('DSHFixture', run_e2e.prompt_for(t7, self.cu))
        fixture = next(t for t in run_e2e.load_tasks(None) if t.get('app', 'fixture') == 'fixture')
        self.assertIn('目标应用名为 DSHFixture', run_e2e.prompt_for(fixture, self.cu))
