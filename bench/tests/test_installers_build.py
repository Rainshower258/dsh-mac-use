"""scripts/install-cu-std.sh builds the plugin with the documented build (`npm run build` at the repository root: the
host tsc, then the plugin page), so a bundle link-installed from the same checkout never serves a page older than its
host, or none (finding regressions-2 of the second final review). scripts/install.sh's build is tested in
test_install_sh.py.

The installer as a whole writes a dsh home under ~ and copies the API key, so it never runs here. Its build step
does: the lines from the plugin-dependency check to the check of what the build produced, with the script's own
assignments of the paths it checks, run as /bin/zsh -f under the installer's options, ROOT a temp root, HOME a temp
dir, from an unrelated directory. npm is a fake that records where and how it ran and writes the files it is told to;
one test runs the real npm build on a temp copy of what the build reads. Nothing outside the temp dir is read or
written, plugin/lib of this checkout included.
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
INSTALLERS = {
    'install-cu-std.sh': ('PLUGIN', 'GATE', 'PAGE'),
}
START = '[[ -e $ROOT/plugin/node_modules/@deepseek-ai/cordis ]]'
END = '[[ -f $PLUGIN'
BUILT = {'PLUGIN': 'index.js', 'GATE': 'exec-gate.js', 'PAGE': 'web-client.js'}
FAKE_NPM = r'''#!/bin/zsh -f
print -r -- "$PWD npm $*" >> $FAKE_LOG
if [[ ${FAKE_NPM_RC:-0} != 0 ]]; then print -r -- 'plugin/src/x.ts(1,1): error TS2322: broken'; exit $FAKE_NPM_RC; fi
/bin/mkdir -p plugin/lib
for f in ${=FAKE_BUILT}; do print -r -- '// built' > plugin/lib/$f; done
'''


def build_step(name):
    """The installer's build step: its path assignments, then the lines from the deps check to the built-files check."""
    lines = (REPO / 'scripts' / name).read_text().splitlines()
    starts = [i for i, line in enumerate(lines) if line.startswith(START)]
    ends = [i for i, line in enumerate(lines) if line.startswith(END)]
    assert len(starts) == 1 and len(ends) == 1 and starts[0] < ends[0], f'{name}: the build step anchors moved'
    assigned = []
    for var in INSTALLERS[name]:
        found = [line for line in lines if line.startswith(f'{var}=$ROOT/plugin/lib/')]
        assert len(found) == 1, (name, var, found)
        assigned += found
    return '\n'.join(assigned + lines[starts[0]:ends[0] + 1]) + '\n'


def code_lines(text):
    return [line for line in text.splitlines() if not line.lstrip().startswith('#')]


class InstallerBuildStepTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.root = self.tmp / 'checkout'
        (self.root / 'plugin/node_modules/@deepseek-ai/cordis').mkdir(parents=True)
        (self.tmp / 'home').mkdir()
        (self.tmp / 'elsewhere').mkdir()
        (self.tmp / 'bin').mkdir()
        npm = self.tmp / 'bin/npm'
        npm.write_text(FAKE_NPM)
        npm.chmod(0o755)
        self.log = self.tmp / 'calls'

    def run_step(self, name, path=None, **env):
        """The build step, then a line it must not reach when it fails: (status, stdout, stderr, npm calls)."""
        script = 'set -euo pipefail\nROOT=$1\n' + build_step(name) + 'print -r -- "after the build"\n'
        p = subprocess.run(['/bin/zsh', '-f', '-c', script, 'zsh', str(self.root)], cwd=self.tmp / 'elsewhere',
                           env={'PATH': path or f'{self.tmp / "bin"}:/usr/bin:/bin', 'HOME': str(self.tmp / 'home'),
                                'FAKE_LOG': str(self.log), **env},
                           capture_output=True, text=True)
        calls = self.log.read_text().splitlines() if self.log.exists() else []
        return p.returncode, p.stdout, p.stderr, calls

    def everything(self, name):
        return ' '.join(BUILT[var] for var in INSTALLERS[name])

    def test_each_installer_runs_the_documented_build_at_the_root_from_any_directory(self):
        for name in INSTALLERS:
            with self.subTest(name):
                self.log.unlink(missing_ok=True)
                code, out, err, calls = self.run_step(name, FAKE_BUILT=self.everything(name))
                self.assertEqual(code, 0, err)
                self.assertEqual(calls, [f'{self.root} npm run --silent build'])
                self.assertEqual(out.splitlines()[-1], 'after the build')

    def test_no_build_of_their_own(self):
        # One documented build: no host-only tsc (it leaves the page out) and no page build next to it.
        for name in INSTALLERS:
            with self.subTest(name):
                code = '\n'.join(code_lines(build_step(name)))
                self.assertNotIn('tsc', code)
                self.assertNotIn('build-client', code)
                self.assertEqual(code.count('npm run --silent build'), 1)
        root = json.loads((REPO / 'package.json').read_text())
        plugin = json.loads((REPO / 'plugin/package.json').read_text())
        self.assertEqual(root['scripts']['build'], 'cd plugin && npm run build')
        self.assertEqual(plugin['scripts']['build'], 'tsc -p tsconfig.build.json && node ../scripts/build-client.mjs')

    def test_a_build_without_the_page_fails_the_install(self):
        for name, wanted in INSTALLERS.items():
            for missing in wanted:
                with self.subTest(name=name, missing=missing):
                    self.log.unlink(missing_ok=True)
                    shutil.rmtree(self.root / 'plugin/lib', ignore_errors=True)
                    built = ' '.join(BUILT[var] for var in wanted if var != missing)
                    code, out, err, calls = self.run_step(name, FAKE_BUILT=built)
                    self.assertEqual(code, 1, out)
                    self.assertIn('build did not produce', out)
                    self.assertIn(str(self.root / 'plugin/lib' / BUILT[missing]), out)
                    self.assertNotIn('after the build', out)

    def test_a_failed_build_stops_the_install_with_its_output(self):
        for name in INSTALLERS:
            with self.subTest(name):
                self.log.unlink(missing_ok=True)
                code, out, err, calls = self.run_step(name, FAKE_NPM_RC='2', FAKE_BUILT=self.everything(name))
                self.assertEqual(code, 1, out + err)
                self.assertIn('error TS2322: broken', out)
                self.assertIn(f'the plugin build failed (npm run build in {self.root})', out)
                self.assertNotIn('after the build', out)
                self.assertFalse((self.root / 'plugin/lib').exists())

    def test_the_existing_checks_stay(self):
        for name in INSTALLERS:
            with self.subTest(name):
                self.log.unlink(missing_ok=True)
                # Without npm (it comes with Node.js): said so, nothing run.
                code, out, err, calls = self.run_step(name, path='/usr/bin:/bin')
                self.assertEqual((code, calls), (1, []), out + err)
                self.assertIn('npm not found', out)
                # Without the plugin's dependencies: the old message, before any build.
                shutil.rmtree(self.root / 'plugin/node_modules')
                code, out, err, calls = self.run_step(name, FAKE_BUILT=self.everything(name))
                self.assertEqual((code, calls), (1, []), out + err)
                self.assertIn(f'plugin deps missing: run npm install in {self.root}/plugin', out)
                (self.root / 'plugin/node_modules/@deepseek-ai/cordis').mkdir(parents=True)

    def test_the_headers_say_what_is_built(self):
        for name in INSTALLERS:
            with self.subTest(name):
                header = (REPO / 'scripts' / name).read_text().split('\nset -euo pipefail\n', 1)[0]
                self.assertIn('`npm run build` at the', header)
                self.assertIn('plugin page', header)


@unittest.skipUnless((REPO / 'plugin/node_modules/.bin/tsc').exists() and shutil.which('npm'),
                     'needs plugin/node_modules (plugin/scripts/link-deps.sh) and npm')
class InstallerRealBuildTest(unittest.TestCase):
    """The step with the real npm, on a temp copy of what the build reads (this checkout's plugin/lib is not touched)."""

    def test_the_step_builds_the_host_the_tools_and_the_page(self):
        tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, tmp)
        root = tmp / 'checkout'
        for rel in ('package.json', 'plugin/package.json', 'plugin/tsconfig.build.json', 'plugin/tsconfig.client.json',
                    'scripts/build-client.mjs'):
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / rel, root / rel)
        shutil.copytree(REPO / 'plugin/src', root / 'plugin/src')
        (root / 'plugin/node_modules').symlink_to(REPO / 'plugin/node_modules')
        (tmp / 'home').mkdir()
        (tmp / 'elsewhere').mkdir()
        for name in INSTALLERS:
            with self.subTest(name):
                shutil.rmtree(root / 'plugin/lib', ignore_errors=True)
                script = 'set -euo pipefail\nROOT=$1\n' + build_step(name) + 'print -r -- "after the build"\n'
                p = subprocess.run(['/bin/zsh', '-f', '-c', script, 'zsh', str(root)], cwd=tmp / 'elsewhere',
                                   env={'PATH': os.environ['PATH'], 'HOME': str(tmp / 'home')},
                                   capture_output=True, text=True, timeout=600)
                self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
                self.assertEqual(p.stdout.splitlines()[-1], 'after the build')
                lib = root / 'plugin/lib'
                for built in ('host.js', 'index.js', 'exec-gate.js', 'daemon/manager.js', 'web-client.js'):
                    self.assertTrue((lib / built).is_file(), built)
                self.assertTrue((lib / 'web-client.js').read_text().startswith(
                    'window.__ModuleLoader__.load({\n\tid: "cu-runtime",\n'), 'the page is the loader script')
                self.assertNotIn('__ModuleLoader__', (lib / 'client.js').read_text(), "the host's daemon client stays")


if __name__ == '__main__':
    unittest.main()
