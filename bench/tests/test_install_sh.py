"""scripts/install.sh, the preflight and guide, and scripts/uninstall.sh.

install.sh: the preflight lists everything missing at once (pnpm and the API key in ~/.dsh among it), names
--permissions-only for a stale grant, and does nothing else then; with CURuntime.app installed it resets, through
tccutil, only the permissions the app's self-check reports not in effect (and none when the self-check does not
answer), quits System Settings, and requests nothing; --permissions-only does that step alone, whatever the preflight
would find, and builds nothing; it installs the plugin's dependencies and runs `npm run build` at the root; it never
builds or signs the app or makes a signing identity; and it prints the guide to the plugin page, with the checkout's
absolute path for 添加插件 and every command for copying quoted so a path with a space survives a paste.

uninstall.sh: by default it stops the daemon, resets both permissions and deletes the app; with no app it resets
nothing and says where rows left from an earlier deletion are removed; --all deletes the daemon's state dir only,
--legacy-home the retired ~/.dsh-cu-desktop only, --remove-cert the signing identity (saying when none is found, and
exiting 1 when a delete fails); a log folder chosen in the settings is said to be kept, with or without --all; the
everyday ~/.dsh is never touched.

install-cu-std.sh names docs/DESIGN.md sections that exist.

Each script runs whole, from a copy in a temp root, as /bin/zsh -f with HOME a temp dir and PATH holding only fakes
(macOS and dsh tools, tccutil, osascript, security, codesign, open, npm, pgrep, pkill, sleep…) and a few real file
tools. build-app.sh and make-signing-identity.sh in the temp root are fakes that only log. Nothing outside the temp
dir is read or written.
"""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BUNDLE_ID = 'dev.cu-runtime.daemon'
KEY = 'test-value-never-printed'

LOGGED = 'echo "$(basename "$0") $*" >> "$FAKE_LOG"'
INSTALL_FAKES = {
    'uname': 'echo Darwin',
    'sw_vers': 'echo 26.3',
    'xcode-select': 'echo /Library/Developer/CommandLineTools',
    'node': 'echo v24.1.0',
    'dsh': 'echo 0.2.1-rc.2',
    'pnpm': 'echo 10.0.0',
    # self-check --out FILE: the permissions FAKE_AX / FAKE_SCK say (both by default), or no answer at all.
    'open': r'''echo "open $*" >> "$FAKE_LOG"
out=; prev=
for a in "$@"; do [ "$prev" = --out ] && out=$a; prev=$a; done
[ -n "$out" ] && [ -z "$FAKE_NO_ANSWER" ] && printf '{"ax_trusted": %s, "sck": {"ok": %s}}' "${FAKE_AX:-true}" "${FAKE_SCK:-true}" > "$out"
exit 0''',
    'tccutil': LOGGED,
    'osascript': LOGGED,
    # Never to be called by install.sh: logged, and failing.
    'security': LOGGED + '; exit 90',
    'codesign': LOGGED + '; exit 90',
    'pgrep': LOGGED + '; exit 1',
    'pkill': LOGGED + '; exit 1',
    'ditto': LOGGED + '; exit 90',
    'sleep': 'exit 0',
    # `npm run --silent build` at the root writes what FAKE_BUILT names (both by default); FAKE_NPM_RC fails it.
    'npm': r'''echo "$PWD npm $*" >> "$FAKE_LOG"
if [ "$1" = run ]; then
  if [ "${FAKE_NPM_RC:-0}" != 0 ]; then echo 'plugin/src/x.ts(1,1): error TS2322: broken'; exit "$FAKE_NPM_RC"; fi
  mkdir -p plugin/lib
  for f in ${FAKE_BUILT-index.js web-client.js}; do echo '// built' > plugin/lib/$f; done
fi
exit 0''',
}
REAL = ('/usr/bin/sed', '/usr/bin/tail', '/usr/bin/grep', '/usr/bin/mktemp', '/usr/bin/plutil', '/bin/mkdir',
        '/usr/bin/awk', '/usr/bin/sort', '/bin/cat', '/bin/rm', '/bin/zsh', '/usr/bin/basename', '/usr/bin/printf')


def make_bin(bin_dir, fakes):
    bin_dir.mkdir()
    for name, body in fakes.items():
        (bin_dir / name).write_text(f'#!/bin/sh\n{body}\n')
        (bin_dir / name).chmod(0o755)
    for real in REAL:
        if not (bin_dir / Path(real).name).exists():
            (bin_dir / Path(real).name).symlink_to(real)


class InstallShTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp)
        (self.tmp / 'modules').mkdir()
        self.root = self.make_root(self.tmp / 'cu-runtime')
        self.home = self.tmp / 'home'
        (self.home / '.dsh').mkdir(parents=True)
        (self.home / '.dsh/.credentials.yaml').write_text(f'refs:\n  DEEPSEEK_API_KEY: {KEY}\n')
        self.app = self.home / 'Applications/CURuntime.app'
        (self.app / 'Contents').mkdir(parents=True)
        self.bin = self.tmp / 'bin'
        make_bin(self.bin, INSTALL_FAKES)
        (self.tmp / 'tmp').mkdir()
        self.log = self.tmp / 'fake.log'
        self.env = {'PATH': str(self.bin), 'HOME': str(self.home), 'TMPDIR': str(self.tmp / 'tmp'),
                    'LANG': 'en_US.UTF-8', 'FAKE_LOG': str(self.log)}

    def make_root(self, root):
        (root / 'scripts').mkdir(parents=True)
        shutil.copyfile(REPO / 'scripts/install.sh', root / 'scripts/install.sh')
        for name in ('build-app.sh', 'make-signing-identity.sh'):
            (root / 'scripts' / name).write_text(f'print -r -- "{name} $*" >> $FAKE_LOG\n')
        (root / 'plugin').mkdir()
        (root / 'plugin/node_modules').symlink_to(self.tmp / 'modules')
        return root

    def install(self, *args, **env):
        env = {**self.env, **env}
        p = subprocess.run(['/bin/zsh', '-f', str(self.root / 'scripts/install.sh'), *args],
                           env={k: v for k, v in env.items() if v is not None},
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
        calls = self.log.read_text().splitlines() if self.log.exists() else []
        self.log.unlink(missing_ok=True)
        self.assertNotIn(KEY, p.stdout + p.stderr, 'the key is never printed')
        return p.returncode, p.stdout, p.stderr, calls

    def tcc(self, calls):
        return [c for c in calls if c.startswith('tccutil ')]

    def assert_nothing_built_or_signed(self, calls):
        for c in calls:
            self.assertFalse(c.split(' ')[0] in ('build-app.sh', 'make-signing-identity.sh', 'security', 'codesign',
                                                 'ditto', 'pkill'), c)
        self.assertEqual([c for c in calls if 'request-permissions' in c or 'x-apple.systempreferences' in c], [],
                         'nothing is requested')

    def test_all_in_effect_nothing_is_reset_and_the_plugin_is_built_and_the_guide_printed(self):
        rc, out, err, calls = self.install()
        self.assertEqual(rc, 0, err)
        self.assertEqual(self.tcc(calls), [])
        self.assertNotIn('osascript', ' '.join(calls))
        self.assertIn('辅助功能、屏幕录制都已生效', out)
        self.assertIn(f'open -n {self.app} --args self-check --out', '\n'.join(calls))
        self.assertEqual([c for c in calls if ' npm ' in c], [f'{self.root} npm run --silent build'])
        self.assert_nothing_built_or_signed(calls)
        for line in ('dsh --profile web', f'添加插件 → 填入这份源码的完整路径：{self.root} → 启用', '守护进程 → 安装守护进程 → 授予权限', '“模式检查”应显示“正常”', '“电脑操作”模式', '支持图片输入的模型',
                     'pkill -x cu-runtime', 'Contents/MacOS/cu-runtime settings', 'scripts/uninstall.sh'):
            self.assertIn(line, out)
        self.assertNotIn('cu-desktop', out + err)
        self.assertNotIn('你', out + err)

    def pasted(self, command):
        """What the shell runs when the printed command is pasted, under the fake HOME: its words, one per line."""
        p = subprocess.run(['/bin/zsh', '-f', '-c', f'print -rl -- {command}'], env={'HOME': str(self.home)},
                           capture_output=True, text=True, timeout=10)
        self.assertEqual(p.returncode, 0, p.stderr)
        return p.stdout.splitlines()

    def test_under_home_the_guide_gives_the_absolute_path_and_quotes_the_commands(self):
        # dsh's add form takes no ~/…: the guide gives the absolute path, in quotes when it has a space; the commands
        # to paste keep ~ and quote the rest, so the paste survives the space.
        for name in ('cu-runtime', 'My Projects/cu-runtime'):
            with self.subTest(name):
                self.root = self.make_root(self.home / name)
                rc, out, err, calls = self.install()
                self.assertEqual(rc, 0, err)
                shown = f'"{self.root}"（填入引号里面的部分）' if ' ' in name else str(self.root)
                self.assertIn(f'添加插件 → 填入这份源码的完整路径：{shown} → 启用', out)
                self.assertNotIn('路径：~', out)
                uninstall = out.split('再运行 zsh ', 1)[1].strip()
                self.assertTrue(uninstall.startswith('~/'), uninstall)
                self.assertEqual(self.pasted(uninstall), [str(self.root / 'scripts/uninstall.sh')])
                # The preflight's rerun command and its --permissions-only hint, quoted the same way.
                (self.bin / 'pnpm').unlink()
                rc, out, err, calls = self.install()
                self.assertEqual(rc, 2, out)
                again = err.split('然后重新运行：zsh ', 1)[1].splitlines()[0]
                self.assertEqual(self.pasted(again), [str(self.root / 'scripts/install.sh')])
                hint = err.split('不需要上面这些，执行：zsh ', 1)[1].splitlines()[0]
                self.assertEqual(self.pasted(hint), [str(self.root / 'scripts/install.sh'), '--permissions-only'])
                make_bin(self.tmp / f'pnpm-{len(name)}', {'pnpm': 'echo 10.0.0'})
                (self.bin / 'pnpm').symlink_to(self.tmp / f'pnpm-{len(name)}/pnpm')

    def test_permissions_only_resets_without_the_preflight_or_the_build(self):
        # A desktop-app user: no pnpm, another dsh, no key in ~/.dsh. The permission step still runs, alone.
        (self.bin / 'pnpm').unlink()
        (self.bin / 'dsh').write_text('#!/bin/sh\necho 0.3.0\n')
        (self.home / '.dsh/.credentials.yaml').unlink()
        rc, out, err, calls = self.install('--permissions-only', FAKE_AX='false')
        self.assertEqual(rc, 0, err)
        self.assertEqual(self.tcc(calls), [f'tccutil reset Accessibility {BUNDLE_ID}'])
        self.assertEqual(len([c for c in calls if c.startswith('osascript ')]), 1, calls)
        self.assertIn('已清除未生效的授权记录：辅助功能（', out)
        self.assertNotIn('预检', out + err)
        self.assertEqual([c for c in calls if ' npm ' in c], [])
        self.assertNotIn('接下来在 dsh 里操作', out)
        self.assert_nothing_built_or_signed(calls)
        # In effect: nothing reset; no app: said, nothing run; no answer: nothing reset.
        rc, out, err, calls = self.install('--permissions-only')
        self.assertEqual((rc, self.tcc(calls)), (0, []), err)
        self.assertIn('辅助功能、屏幕录制都已生效', out)
        rc, out, err, calls = self.install('--permissions-only', FAKE_NO_ANSWER='1', FAKE_AX='false')
        self.assertEqual((rc, self.tcc(calls)), (0, []), err)
        shutil.rmtree(self.app)
        rc, out, err, calls = self.install('--permissions-only')
        self.assertEqual(rc, 0, err)
        self.assertEqual([c for c in calls if c.startswith(('open ', 'tccutil ', 'osascript '))], [])
        self.assertIn('还没有安装 ~/Applications/CURuntime.app', out)
        self.assertNotIn('你', out + err)

    def test_an_unknown_option_does_nothing(self):
        rc, out, err, calls = self.install('--permission-only')
        self.assertEqual((rc, calls), (1, []), out)
        self.assertIn('unknown option: --permission-only', err)

    def test_only_the_permissions_not_in_effect_are_reset(self):
        for name, env, services, cleared in (
                ('accessibility off', dict(FAKE_AX='false'), ['Accessibility'], '辅助功能'),
                ('screen recording off', dict(FAKE_SCK='false'), ['ScreenCapture'], '屏幕录制'),
                ('both off', dict(FAKE_AX='false', FAKE_SCK='false'), ['Accessibility', 'ScreenCapture'],
                 '辅助功能、屏幕录制')):
            with self.subTest(name):
                rc, out, err, calls = self.install(**env)
                self.assertEqual(rc, 0, err)
                self.assertEqual(self.tcc(calls), [f'tccutil reset {s} {BUNDLE_ID}' for s in services])
                quit_ = [i for i, c in enumerate(calls) if c.startswith('osascript ')]
                self.assertEqual(len(quit_), 1, calls)
                self.assertIn('System Settings', calls[quit_[0]])
                self.assertGreater(quit_[0], max(i for i, c in enumerate(calls) if c.startswith('tccutil ')))
                self.assertIn(f'已清除未生效的授权记录：{cleared}（', out)
                self.assertIn('“守护进程”标签里点“授予权限”重新申请', out)
                self.assert_nothing_built_or_signed(calls)

    def test_no_answer_from_the_self_check_resets_nothing(self):
        rc, out, err, calls = self.install(FAKE_NO_ANSWER='1')
        self.assertEqual(rc, 0, err)
        self.assertEqual(self.tcc(calls), [])
        self.assertNotIn('osascript', ' '.join(calls))
        self.assertIn('权限自检没有返回结果，没有清除任何授权记录', out)

    def test_no_app_installed_says_the_plugin_page_installs_it(self):
        shutil.rmtree(self.app)
        rc, out, err, calls = self.install()
        self.assertEqual(rc, 0, err)
        self.assertEqual([c for c in calls if c.startswith(('open ', 'tccutil ', 'osascript '))], [])
        self.assertIn('还没有安装 ~/Applications/CURuntime.app：之后在插件页的“守护进程”标签里点“安装守护进程”', out)
        self.assertEqual([c for c in calls if ' npm ' in c], [f'{self.root} npm run --silent build'])
        self.assert_nothing_built_or_signed(calls)

    def test_the_preflight_lists_what_is_missing_and_does_nothing_else(self):
        (self.bin / 'pnpm').unlink()
        rc, out, err, calls = self.install()
        self.assertEqual(rc, 2, out)
        self.assertIn('没有 pnpm', err)
        self.assertIn('npm i -g pnpm', err)
        self.assertIn('还缺 1 样', err)
        self.assertIn('只是要清除失效的授权记录', err)
        self.assertIn('scripts/install.sh --permissions-only', err)
        self.assertEqual(calls, [])
        # The key counts only in the everyday ~/.dsh: one in the retired ~/.dsh-cu-desktop does not.
        (self.home / '.dsh/.credentials.yaml').unlink()
        (self.home / '.dsh-cu-desktop').mkdir()
        (self.home / '.dsh-cu-desktop/.credentials.yaml').write_text(f'refs:\n  DEEPSEEK_API_KEY: {KEY}\n')
        rc, out, err, calls = self.install()
        self.assertEqual(rc, 2, out)
        self.assertIn('没有 DeepSeek API key', err)
        self.assertIn('还缺 2 样', err)
        self.assertEqual(calls, [])
        # Everything there: the preflight passes.
        (self.home / '.dsh/.credentials.yaml').write_text(f'refs:\n  DEEPSEEK_API_KEY: {KEY}\n')
        make_bin(self.tmp / 'bin2', {'pnpm': 'echo 10.0.0'})
        rc, out, err, calls = self.install(PATH=f'{self.bin}:{self.tmp / "bin2"}')
        self.assertEqual(rc, 0, err)
        self.assertIn('✓ pnpm', out)
        self.assertIn('✓ DeepSeek API key', out)

    def test_the_other_preflight_checks_stay(self):
        rc, out, err, calls = self.install(SSH_CONNECTION='1 2 3 4')
        self.assertEqual((rc, calls), (2, []), out)
        self.assertIn('在 SSH 里运行', err)
        (self.bin / 'dsh').write_text('#!/bin/sh\necho 0.2.0-rc.2\n')
        (self.bin / 'node').write_text('#!/bin/sh\necho v22.0.0\n')
        rc, out, err, calls = self.install()
        self.assertEqual((rc, calls), (2, []), out)
        self.assertIn('dsh 是 0.2.0-rc.2，cu-runtime 目前只在 0.2.1-rc.2 上测过', err)
        self.assertIn('Node.js 是 v22.0.0，需要 24 版本', err)
        self.assertNotIn('你', err)

    def test_the_dependencies_are_installed_unless_linked(self):
        (self.root / 'plugin/node_modules').unlink()
        (self.root / 'plugin/package-lock.json').write_text('{}\n')
        rc, out, err, calls = self.install()
        self.assertEqual(rc, 0, err)
        self.assertEqual([c for c in calls if ' npm ' in c],
                         [f'{self.root}/plugin npm ci --no-audit --no-fund', f'{self.root} npm run --silent build'])

    def test_a_failed_or_incomplete_build_stops_it(self):
        rc, out, err, calls = self.install(FAKE_NPM_RC='2')
        self.assertEqual(rc, 2, out)
        self.assertIn('插件构建失败', err)
        self.assertIn('error TS2322: broken', err)
        self.assertNotIn('接下来在 dsh 里操作', out)
        rc, out, err, calls = self.install(FAKE_BUILT='index.js')
        self.assertEqual(rc, 2, out)
        self.assertIn('构建没有生成 plugin/lib/index.js 和 plugin/lib/web-client.js', err)
        self.assertNotIn('接下来在 dsh 里操作', out)

    def test_no_app_build_signing_or_retired_script_in_the_code(self):
        code = [line for line in (REPO / 'scripts/install.sh').read_text().splitlines()
                if not line.lstrip().startswith('#')]
        text = '\n'.join(code)
        for word in ('build-app.sh', 'make-signing-identity.sh', 'codesign', 'security ', 'ditto', 'install-cu-desktop',
                     'cu-desktop.sh', '.dsh-cu-desktop', 'request-permissions', 'sudo tccutil'):
            self.assertNotIn(word, text)


UNINSTALL_FAKES = {
    # Running while the flag file is there; pkill removes it.
    'pgrep': 'echo "pgrep $*" >> "$FAKE_LOG"; [ -e "$FAKE_RUNNING" ]',
    'pkill': 'echo "pkill $*" >> "$FAKE_LOG"; rm -f "$FAKE_RUNNING"',
    'osascript': LOGGED,
    # As the real one: it finds the app by its bundle ID, so it fails once the app is gone; FAKE_TCC_FAIL fails it anyway.
    'tccutil': LOGGED + '; [ -d "$HOME/Applications/CURuntime.app" ] && [ -z "$FAKE_TCC_FAIL" ]',
    # find-identity lists FAKE_SHA (none with FAKE_NO_IDENTITY, fails with FAKE_FIND_FAIL); FAKE_DELETE_FAIL fails a
    # delete, as a locked keychain does.
    'security': r'''echo "security $*" >> "$FAKE_LOG"
if [ "$1" = find-identity ]; then
  [ -n "$FAKE_FIND_FAIL" ] && exit 1
  if [ -n "$FAKE_NO_IDENTITY" ]; then printf '     0 valid identities found\n'
  else printf '  1) %s "cu-runtime-signing"\n     1 identities found\n' "$FAKE_SHA"; fi
fi
if [ "$1" = delete-identity ] && [ -n "$FAKE_DELETE_FAIL" ]; then echo 'User interaction is not allowed.' >&2; exit 1; fi
exit 0''',
    'sleep': 'exit 0',
}


class UninstallShTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.script = self.tmp / 'uninstall.sh'
        shutil.copyfile(REPO / 'scripts/uninstall.sh', self.script)
        self.home = self.tmp / 'home'
        self.app = self.home / 'Applications/CURuntime.app'
        self.state = self.home / 'Library/Application Support/cu-runtime'
        self.legacy = self.home / '.dsh-cu-desktop'
        self.daily = self.home / '.dsh'
        for d in (self.app / 'Contents', self.state, self.legacy / 'profiles/cu-desktop', self.daily / 'profiles/web'):
            d.mkdir(parents=True)
        (self.state / 'audit.jsonl').write_text('{}\n')
        (self.daily / '.credentials.yaml').write_text(f'refs:\n  DEEPSEEK_API_KEY: {KEY}\n')
        self.bin = self.tmp / 'bin'
        make_bin(self.bin, UNINSTALL_FAKES)
        self.log = self.tmp / 'fake.log'
        self.running = self.tmp / 'running'
        self.env = {'PATH': str(self.bin), 'HOME': str(self.home), 'LANG': 'en_US.UTF-8', 'FAKE_LOG': str(self.log),
                    'FAKE_RUNNING': str(self.running), 'FAKE_SHA': 'B' * 40}

    def uninstall(self, *args, **env):
        p = subprocess.run(['/bin/zsh', '-f', str(self.script), *args], env={**self.env, **env}, stdin=subprocess.DEVNULL,
                           capture_output=True, text=True, timeout=60)
        calls = self.log.read_text().splitlines() if self.log.exists() else []
        self.log.unlink(missing_ok=True)
        # The everyday home and dsh's profiles are never touched.
        self.assertTrue((self.daily / 'profiles/web').is_dir())
        self.assertEqual((self.daily / '.credentials.yaml').read_text(), f'refs:\n  DEEPSEEK_API_KEY: {KEY}\n')
        return p.returncode, p.stdout, p.stderr, calls

    def test_default_removes_the_app_and_both_permissions_and_keeps_the_rest(self):
        self.running.touch()
        rc, out, err, calls = self.uninstall('--yes')
        self.assertEqual(rc, 0, err)
        self.assertIn('pkill -x cu-runtime', calls)
        self.assertIn('✓ 已停止守护进程', out)
        self.assertFalse(self.app.exists())
        quit_ = calls.index("osascript -e tell application \"System Settings\" to quit")
        self.assertEqual([c for c in calls if c.startswith('tccutil ')],
                         [f'tccutil reset Accessibility {BUNDLE_ID}', f'tccutil reset ScreenCapture {BUNDLE_ID}'])
        self.assertLess(quit_, calls.index(f'tccutil reset Accessibility {BUNDLE_ID}'))
        self.assertIn('✓ 已撤销辅助功能、屏幕录制权限', out)
        self.assertNotIn('没能撤销', out + err)
        self.assertTrue(self.state.is_dir())
        self.assertTrue(self.legacy.is_dir())
        self.assertIn('保留了 ~/Library/Application Support/cu-runtime（审计日志、“始终允许”名单、设置）：要删的话加 --all', out)
        self.assertNotIn('cu-runtime-logs', out + err)
        self.assertIn('保留了 ~/.dsh-cu-desktop（已停用的 cu-desktop 主目录：会话记录、API key 副本）：要删的话加 --legacy-home',
                      out)
        self.assertEqual([c for c in calls if c.startswith('security ')], [])
        self.assertIn('保留了签名证书 cu-runtime-signing', out)
        self.assertTrue(out.rstrip().endswith('插件本身在 dsh 的插件页移除。'), out)

    def test_no_app_nothing_is_reset_and_the_rows_left_are_pointed_to(self):
        # The app already gone (a second run): tccutil cannot find it, so nothing is tried and nothing reported failed.
        shutil.rmtree(self.app)
        rc, out, err, calls = self.uninstall('--legacy-home', '--yes')
        self.assertEqual(rc, 0, err)
        self.assertEqual([c for c in calls if c.startswith(('tccutil ', 'osascript '))], [])
        self.assertIn('~/Applications/CURuntime.app 没有安装，不用删除，也没有权限可以撤销', out)
        self.assertNotIn('删除 ~/Applications/CURuntime.app，撤销', out)
        self.assertIn('~/Applications/CURuntime.app 没有安装，没有可以撤销的权限。之前删除它时留下的授权记录（如果有）', out)
        self.assertIn('选中 CURuntime 后点“−”删掉', out)
        self.assertNotIn('!', err)
        self.assertNotIn('没能撤销', out + err)
        self.assertNotIn('✓ 已撤销', out)
        self.assertNotIn('✓ 已删除 ~/Applications', out)

    def test_a_reset_that_fails_is_said_and_never_reported_done(self):
        rc, out, err, calls = self.uninstall('--yes', FAKE_TCC_FAIL='1')
        self.assertEqual(rc, 0, err)
        self.assertEqual(len([c for c in calls if c.startswith('tccutil ')]), 2)
        self.assertIn('! 没能撤销辅助功能、屏幕录制权限：到“系统设置 → 隐私与安全性”', err)
        self.assertNotIn('✓ 已撤销', out)
        self.assertFalse(self.app.exists())

    def test_a_chosen_log_folder_is_said_to_be_kept_with_or_without_all(self):
        logs = self.tmp / 'my logs'
        (logs / 'cu-runtime-logs').mkdir(parents=True)
        for args in (('--yes',), ('--all', '--yes')):
            with self.subTest(args):
                self.state.mkdir(parents=True, exist_ok=True)
                (self.state / 'settings.json').write_text(
                    '{"logs": {"directory": "%s", "retention_days": 30}, "version": 2}\n' % logs)
                (self.app / 'Contents').mkdir(parents=True, exist_ok=True)
                rc, out, err, calls = self.uninstall(*args)
                self.assertEqual(rc, 0, err)
                self.assertIn(f'  · 保留 {logs}/cu-runtime-logs（设置里选的日志位置', out)
                self.assertIn(f'· 保留了 {logs}/cu-runtime-logs（设置里选的日志位置，其中有审计日志）', out)
                self.assertTrue((logs / 'cu-runtime-logs').is_dir())
        # The default folder (null): nothing said.
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / 'settings.json').write_text('{"logs": {"directory": null, "retention_days": 30}}\n')
        rc, out, err, calls = self.uninstall('--yes')
        self.assertEqual(rc, 0, err)
        self.assertNotIn('cu-runtime-logs', out + err)

    def test_all_deletes_only_the_state_dir(self):
        rc, out, err, calls = self.uninstall('--all', '--yes')
        self.assertEqual(rc, 0, err)
        self.assertFalse(self.state.exists())
        self.assertTrue(self.legacy.is_dir(), '--all leaves the retired home alone')
        self.assertIn('✓ 已删除 ~/Library/Application Support/cu-runtime', out)
        self.assertIn('要删的话加 --legacy-home', out)

    def test_legacy_home_deletes_only_the_retired_home(self):
        rc, out, err, calls = self.uninstall('--legacy-home', '--yes')
        self.assertEqual(rc, 0, err)
        self.assertFalse(self.legacy.exists())
        self.assertTrue(self.state.is_dir())
        self.assertIn('删除 ~/.dsh-cu-desktop（已停用的 cu-desktop 主目录', out)
        self.assertIn('✓ 已删除 ~/.dsh-cu-desktop', out)
        rc, out, err, calls = self.uninstall('--all', '--legacy-home', '--yes')
        self.assertEqual(rc, 0, err)
        self.assertFalse(self.state.exists())
        self.assertFalse(self.legacy.exists())

    def test_remove_cert_deletes_the_signing_identity(self):
        rc, out, err, calls = self.uninstall('--remove-cert', '--yes')
        self.assertEqual(rc, 0, err)
        self.assertIn(f'security delete-identity -Z {"B" * 40}', calls)
        self.assertIn(f'✓ 已删除签名证书 cu-runtime-signing ({"B" * 40})', out)
        self.assertTrue(self.state.is_dir())
        self.assertTrue(self.legacy.is_dir())

    def test_remove_cert_says_when_none_is_found(self):
        rc, out, err, calls = self.uninstall('--remove-cert', '--yes', FAKE_NO_IDENTITY='1')
        self.assertEqual(rc, 0, err)
        self.assertEqual([c for c in calls if c.startswith('security delete-identity')], [])
        self.assertIn('· 没有找到签名证书 cu-runtime-signing，不用删除', out)
        self.assertNotIn('✓ 已删除签名证书', out)

    def test_remove_cert_reports_a_failed_delete_and_exits_nonzero(self):
        for name, env, text in (
                ('delete fails', dict(FAKE_DELETE_FAIL='1'), f'! 没能删除签名证书 cu-runtime-signing ({"B" * 40})'),
                ('listing fails', dict(FAKE_FIND_FAIL='1'), '! 没能读取钥匙串里的签名证书，cu-runtime-signing 没有删除')):
            with self.subTest(name):
                (self.app / 'Contents').mkdir(parents=True, exist_ok=True)
                rc, out, err, calls = self.uninstall('--remove-cert', '--yes', **env)
                self.assertEqual(rc, 1, out)
                self.assertIn(text, err)
                self.assertNotIn('✓ 已删除签名证书', out)
                self.assertFalse(self.app.exists(), 'the rest is still done')
                self.assertTrue(out.rstrip().endswith('插件本身在 dsh 的插件页移除。'), out)

    def test_nothing_is_done_without_a_yes_or_with_an_unknown_option(self):
        for args, text in ((('--all', '--legacy-home'), '加 --yes 才会执行'), (('--everything', '--yes'), 'unknown option')):
            with self.subTest(args):
                rc, out, err, calls = self.uninstall(*args)
                self.assertEqual(rc, 1, out)
                self.assertIn(text, err)
                self.assertEqual(calls, [])
                for d in (self.app, self.state, self.legacy):
                    self.assertTrue(d.is_dir(), d)


class InstallCuStdReadmeTest(unittest.TestCase):
    def test_the_readme_sections_it_names_exist(self):
        script = (REPO / 'scripts/install-cu-std.sh').read_text()
        readme = (REPO / 'docs/DESIGN.md').read_text()
        self.assertIn('## Threat model', readme)
        for section in ('Not covered with bash', 'cu-std (an experiment)'):
            self.assertIn(f'**{section}', readme)
            self.assertIn(section, script.split('\n#', 1)[1].split('set -euo')[0].replace('\n# ', ' '))
            self.assertIn(f'\\"{section}\\"', script, 'the refusal on a real Mac names it')
        for old in ('Known gaps with bash', 'With bash in the same session'):
            self.assertNotIn(old, script)


if __name__ == '__main__':
    unittest.main()
