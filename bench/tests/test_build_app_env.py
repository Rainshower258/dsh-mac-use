"""scripts/build-app.sh: where a build goes (a bench build never into dist/, the daily path), which identity signs it
(each kind its own, the other's refused), how the source hash is taken, how it reports the signing, and where it
assembles and signs the app (a 0700 work dir beside the output, not $TMPDIR; removed on every exit, signals included).

The script as a whole signs in the login keychain, so it never runs here as it is. Three ways stand in:
- its environment block (from after ROOT= to the Command Line Tools check, which nothing before it may call out of);
- its SOURCE_HASH line;
- a copy of it in a temp root, sourced by a harness that defines zsh functions named /usr/bin/xcode-select,
  /usr/bin/security, /usr/bin/xcrun, /usr/bin/codesign and /usr/bin/git (zsh looks up functions before the file
  system, also for a name with slashes, and a function cannot come in through the environment). The script calls
  every tool by its absolute path, so these stand in for the toolchain and the keychain; the rest (mkdir, cp, mv, rm,
  cat, chmod, date, mktemp, awk, sort, grep, zsh, shasum) is real and touches only the temp root (mktemp behind a
  wrapper that can swap the work dir's parent for a symlink once it has run). PATH holds only
  programs that fail loudly, HOME is a temp dir, so a lookup on PATH shows, and a stub that is missed reaches no
  keychain of the user's.
"""
import hashlib
import os
import plistlib
import re
import shutil
import signal
import stat
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / 'scripts/build-app.sh'
START, END = 'ROOT=${0:A:h:h}\n', '# Without the Command Line Tools'
RELEASE_SHA = 'A' * 39 + '1'
BENCH_SHA = 'B' * 39 + '2'
LISTING = f'''Policy: Code Signing
  Matching identities
  1) {RELEASE_SHA} "cu-runtime-signing" (CSSMERR_TP_NOT_TRUSTED)
  2) {BENCH_SHA} "cu-runtime-bench-signing" (CSSMERR_TP_NOT_TRUSTED)
     2 identities found

  Valid identities only
     0 valid identities found
'''
STUBBED = ('/usr/bin/xcode-select', '/usr/bin/security', '/usr/bin/xcrun', '/usr/bin/codesign', '/usr/bin/git')


def environment_block():
    text = SCRIPT.read_text()
    assert text.count(START) == 1 and text.count(END) == 1, 'build-app.sh: the block anchors moved'
    return text.split(START, 1)[1].split(END, 1)[0]


def source_hash_line():
    lines = [line for line in SCRIPT.read_text().splitlines() if line.startswith('SOURCE_HASH=')]
    assert len(lines) == 1, lines
    return lines[0]


def code_lines(text):
    return [line for line in text.splitlines() if not line.lstrip().startswith('#')]


class BuildAppEnvironmentTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.root)
        self.block = self.root / 'block.zsh'
        self.block.write_text(environment_block())

    def run_block(self, cwd=None, **env):
        """The block under build-app.sh's own options, ROOT the temp root: (exit status, values or stderr)."""
        base = {k: v for k, v in os.environ.items() if not k.startswith('CU_')}
        script = ('set -euo pipefail; ROOT=$1; source $2; '
                  'print -rl -- "$KIND" "$DIST" "$SCRATCH" "${(j: :)BENCH}" "$BENCH_PLIST" "$NAME"')
        p = subprocess.run(['/bin/zsh', '-f', '-c', script, 'zsh', str(self.root), str(self.block)],
                           env={**base, **env}, cwd=cwd or self.root, capture_output=True, text=True)
        if p.returncode != 0:
            return p.returncode, p.stderr
        kind, dist, scratch, bench, plist, name = p.stdout.splitlines()
        return 0, {'kind': kind, 'dist': dist, 'scratch': scratch, 'bench': bench, 'plist': plist, 'name': name}

    def test_the_block_calls_no_tool(self):
        # What these tests run must stay keychain- and file-free: no lookup, build, signing or file change in it.
        code = '\n'.join(code_lines(environment_block()))
        self.assertIsNone(re.search(r'\b(security|codesign|swift|xcode-select|git|mkdir|rm|mv|cp|ditto|mktemp)\b|\$\(',
                                    code), code)

    def test_unset_is_a_release_build_into_dist(self):
        rc, out = self.run_block()
        self.assertEqual(rc, 0, out)
        self.assertEqual(out, {'kind': 'release', 'dist': f'{self.root}/dist', 'scratch': f'{self.root}/.build',
                               'bench': '', 'plist': '<false/>', 'name': 'cu-runtime-signing'})
        for off in ('', '0'):
            self.assertEqual(self.run_block(CU_BENCH=off)[1]['kind'], 'release', repr(off))
        # A release build may go into dist/ by name, as install.sh asks.
        self.assertEqual(self.run_block(CU_DIST=f'{self.root}/dist')[1]['dist'], f'{self.root}/dist')

    def test_a_bench_build_goes_into_dist_bench_by_default(self):
        rc, out = self.run_block(CU_BENCH='1')
        self.assertEqual(rc, 0, out)
        self.assertEqual(out, {'kind': 'bench', 'dist': f'{self.root}/dist-bench', 'scratch': f'{self.root}/.build',
                               'bench': '-Xswiftc -DCU_BENCH', 'plist': '<true/>', 'name': 'cu-runtime-bench-signing'})
        # As the VM scripts ask for it, and anywhere else that is not dist/.
        self.assertEqual(self.run_block(CU_BENCH='1', CU_DIST=f'{self.root}/dist-bench')[1]['dist'],
                         f'{self.root}/dist-bench')
        self.assertEqual(self.run_block(CU_BENCH='1', CU_DIST=f'{self.root}/elsewhere')[1]['dist'],
                         f'{self.root}/elsewhere')
        self.assertEqual(self.run_block(CU_BENCH='1', CU_DIST=f'{self.root}/dist2')[1]['dist'], f'{self.root}/dist2')

    def test_a_bench_build_into_dist_is_refused_in_every_spelling(self):
        (self.root / 'sub').mkdir()
        spellings = [f'{self.root}/dist', f'{self.root}/dist/', f'{self.root}/./dist', f'{self.root}/sub/../dist',
                     f'{self.root}/nowhere/../dist', f'{self.root}/DIST', f'{self.root}/Dist/.',
                     # The firmlinked spelling while dist/ does not exist yet (so -ef cannot match it).
                     f'/System/Volumes/Data{self.root}/dist']
        for spelling in spellings:
            rc, err = self.run_block(CU_BENCH='1', CU_DIST=spelling)
            self.assertEqual(rc, 2, spelling)
            self.assertIn(f'CU_BENCH=1 does not build into {self.root}/dist: that is the daily path', err)
        # Relative to the caller's directory, as every CU_DIST is.
        self.assertEqual(self.run_block(cwd=self.root, CU_BENCH='1', CU_DIST='dist')[0], 2)
        self.assertEqual(self.run_block(cwd=self.root / 'sub', CU_BENCH='1', CU_DIST='../dist')[0], 2)
        # A symlink to dist/ before dist/ exists: :A cannot resolve it, so it is refused as such (in either build).
        (self.root / 'alias').symlink_to(self.root / 'dist')
        for bench in ('1', ''):
            rc, err = self.run_block(CU_BENCH=bench, CU_DIST=f'{self.root}/alias')
            self.assertEqual(rc, 2, f'dangling alias, CU_BENCH={bench!r}')
            self.assertIn(f'CU_DIST {self.root}/alias is a symlink to a missing directory', err)
        # Once dist/ exists: the symlink, another letter case and a ".." past the symlink all reach it.
        before = sorted(p.name for p in self.root.iterdir())
        (self.root / 'dist').mkdir()
        for spelling in (f'{self.root}/alias', f'{self.root}/DIST', f'{self.root}/alias/../dist'):
            rc, err = self.run_block(CU_BENCH='1', CU_DIST=spelling)
            self.assertEqual(rc, 2, spelling)
            self.assertIn('that is the daily path', err)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), sorted(before + ['dist']), 'a refusal creates nothing')

    def test_an_unknown_cu_bench_is_refused(self):
        for value in ('2', 'yes', 'true'):
            rc, err = self.run_block(CU_BENCH=value)
            self.assertEqual(rc, 2, value)
            self.assertIn(f'not "{value}"', err)

    def test_relative_paths_are_the_callers(self):
        (self.root / 'caller').mkdir()
        rc, out = self.run_block(cwd=self.root / 'caller', CU_DIST='out', CU_SCRATCH='scratch')
        self.assertEqual(rc, 0, out)
        self.assertEqual((out['dist'], out['scratch']), (f'{self.root}/caller/out', f'{self.root}/caller/scratch'))

    def test_each_kind_refuses_the_other_kinds_identity_by_name(self):
        rc, err = self.run_block(CU_BENCH='1', CU_SIGN_NAME='cu-runtime-signing')
        self.assertEqual(rc, 2, err)
        self.assertIn('a bench build is not signed with cu-runtime-signing, the identity of release builds', err)
        rc, err = self.run_block(CU_SIGN_NAME='cu-runtime-bench-signing')
        self.assertEqual(rc, 2, err)
        self.assertIn('a release build is not signed with cu-runtime-bench-signing, the identity of bench builds', err)
        # Its own kind's name, or another identity altogether, is taken.
        self.assertEqual(self.run_block(CU_BENCH='1', CU_SIGN_NAME='cu-runtime-bench-signing')[1]['name'],
                         'cu-runtime-bench-signing')
        self.assertEqual(self.run_block(CU_SIGN_NAME='cu-runtime-signing')[1]['name'], 'cu-runtime-signing')
        self.assertEqual(self.run_block(CU_BENCH='1', CU_SIGN_NAME='other')[1]['name'], 'other')

    def test_cu_sign_identity_is_a_sha1_or_ad_hoc(self):
        for value in ('-', RELEASE_SHA, RELEASE_SHA.lower()):
            self.assertEqual(self.run_block(CU_SIGN_IDENTITY=value)[0], 0, value)
        # A name (codesign would match it as a substring of a certificate's name), a short or a long hash: refused.
        for value in ('cu-runtime', 'cu-runtime-signing', 'A' * 39, 'A' * 41, f'{RELEASE_SHA} ', '--'):
            rc, err = self.run_block(CU_BENCH='1', CU_SIGN_IDENTITY=value)
            self.assertEqual(rc, 2, value)
            self.assertIn('CU_SIGN_IDENTITY is the SHA-1 of an identity (40 hex digits) or - (ad-hoc)', err)


class BuildAppSourceHashTest(unittest.TestCase):
    def test_source_hash_runs_through_zsh_without_the_exec_bit_or_startup_files(self):
        line = source_hash_line()
        self.assertEqual(line, 'SOURCE_HASH=$(/bin/zsh -f "$ROOT/scripts/source-hash.sh" "$ROOT")')
        root = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, root)
        (root / 'scripts').mkdir()
        (root / 'Sources/x').mkdir(parents=True)
        shutil.copyfile(REPO / 'scripts/source-hash.sh', root / 'scripts/source-hash.sh')   # no exec bit
        self.assertFalse(os.stat(root / 'scripts/source-hash.sh').st_mode & stat.S_IXUSR)
        files = {'Package.swift': b'// swift-tools-version:5.10\n', 'Sources/x/a.swift': b'let a = 1\n',
                 'scripts/build-app.sh': b'#!/bin/zsh\n'}
        for name, data in files.items():
            (root / name).write_bytes(data)
        # Nothing on PATH: source-hash.sh looks nothing up there either.
        p = subprocess.run(['/bin/zsh', '-f', '-c', f'set -euo pipefail; ROOT=$1; {line}; print -r -- $SOURCE_HASH',
                            'zsh', str(root)], capture_output=True, text=True, env={'PATH': str(root / 'nothing')})
        self.assertEqual(p.returncode, 0, p.stderr)
        # Byte order: "Package.swift" < "Sources/…" < "scripts/…" ("S" 0x53 < "s" 0x73).
        lines = ''.join(f'{name}\t{hashlib.sha256(data).hexdigest()}\n' for name, data in sorted(files.items()))
        self.assertEqual(sorted(files), ['Package.swift', 'Sources/x/a.swift', 'scripts/build-app.sh'])
        self.assertEqual(p.stdout.strip(), hashlib.sha256(lines.encode()).hexdigest())


class SourceHashCoversBuildAppTest(unittest.TestCase):
    """scripts/source-hash.sh: Package.swift, Sources/** and scripts/build-app.sh (it decides the bundle id, the
    Info.plist keys and the signing), nothing else of scripts/."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.root)
        for name, data in {'Package.swift': 'let p = 1\n', 'Sources/a.swift': 'a\n', 'scripts/build-app.sh': 'one\n',
                           'scripts/install.sh': 'not hashed\n', 'scripts/source-hash.sh': 'not hashed\n'}.items():
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            (self.root / name).write_text(data)

    def run_hash(self):
        p = subprocess.run(['/bin/zsh', '-f', str(REPO / 'scripts/source-hash.sh'), str(self.root)],
                           capture_output=True, text=True, env={'PATH': str(self.root / 'nothing')})
        return p.returncode, p.stdout, p.stderr

    def test_build_app_counts_and_the_rest_of_scripts_does_not(self):
        rc, before, err = self.run_hash()
        self.assertEqual(rc, 0, err)
        sha = lambda b: hashlib.sha256(b).hexdigest()  # noqa: E731
        expected = sha(''.join(f'{f}\t{sha((self.root / f).read_bytes())}\n'
                               for f in ('Package.swift', 'Sources/a.swift', 'scripts/build-app.sh')).encode())
        self.assertEqual(before, f'{expected}\n')
        for other in ('scripts/install.sh', 'scripts/source-hash.sh'):
            (self.root / other).write_text('changed\n')
            self.assertEqual(self.run_hash()[1], before, other)
        (self.root / 'scripts/build-app.sh').write_text('two\n')
        self.assertNotEqual(self.run_hash()[1], before)

    def test_without_build_app_there_is_no_hash(self):
        (self.root / 'scripts/build-app.sh').unlink()
        rc, out, err = self.run_hash()
        self.assertEqual((rc, out), (1, ''))
        self.assertIn('has no scripts/build-app.sh', err)

    def test_the_repository_agrees_with_the_contract(self):
        files = ['Package.swift', 'scripts/build-app.sh']
        for top, dirs, names in os.walk(REPO / 'Sources'):   # os.walk does not follow symlinked directories
            for name in names:
                path = Path(top) / name
                if name != '.DS_Store' and stat.S_ISREG(os.lstat(path).st_mode):
                    files.append(path.relative_to(REPO).as_posix())
        files.sort(key=lambda f: f.encode())
        sha = lambda b: hashlib.sha256(b).hexdigest()  # noqa: E731
        expected = sha(''.join(f'{f}\t{sha((REPO / f).read_bytes())}\n' for f in files).encode())
        p = subprocess.run(['/bin/zsh', '-f', str(REPO / 'scripts/source-hash.sh'), str(REPO)],
                           capture_output=True, text=True)
        self.assertEqual((p.returncode, p.stdout), (0, f'{expected}\n'), p.stderr)


HARNESS = r'''
# Stand-ins for the tools that reach the toolchain or the keychain; each call is logged, one line, to $STUB_LOG.
stub_log() { print -r -- "$*" >> $STUB_LOG }
function /usr/bin/xcode-select { stub_log xcode-select "$@"; return ${STUB_CLT_RC:-0} }
function /usr/bin/git { stub_log git "$@"; return 128 }
function /usr/bin/security {
  stub_log security "$@"
  [[ $1 == find-identity ]] || return 90
  print -r -- "$STUB_IDENTITIES"
}
function /usr/bin/xcrun {
  stub_log xcrun "$@"
  # The environment the tool gets (printenv is a program: it sees what is exported, not the shell's own variables).
  stub_log "xcrun-env TMPDIR=$(/usr/bin/printenv TMPDIR)"
  [[ $1 == --no-cache && $2 == swift && $3 == build ]] || return 90
  if [[ ${@[-1]} == --show-bin-path ]]; then print -r -- $STUB_BIN; return 0; fi
  print -r -- "Build of product 'cu-runtime' complete! (0.01s)"
  if [[ -n ${STUB_BUILD_SLEEP:-} ]]; then print -r -- building > $STUB_BUILDING; /bin/sleep $STUB_BUILD_SLEEP; fi
  (( ${STUB_BUILD_RC:-0} == 0 )) || return $STUB_BUILD_RC
  /bin/mkdir -p $STUB_BIN
  [[ -n ${STUB_NO_BINARY:-} ]] || print -r -- binary > $STUB_BIN/cu-runtime
}
function /usr/bin/codesign {
  stub_log codesign "$@"
  case $1 in
    --force) print -r -- 'STUB codesign signs'
             # Where the bundle it signs lies, that directory's mode, and the temp dir codesign itself is given.
             stub_log "sign-dir ${@[-1]:h} mode $(/usr/bin/stat -f %Lp ${@[-1]:h}) TMPDIR=$(/usr/bin/printenv TMPDIR)"
             return ${STUB_SIGN_RC:-0} ;;
    --verify) return ${STUB_VERIFY_RC:-0} ;;
    -d) if [[ $2 == -r- ]]; then print -r -- "designated => identifier \"dev.cu-runtime.daemon\""
        else print -u2 -r -- "CodeDirectory v=20500 size=1 flags=${STUB_FLAGS:-0x10000(runtime)} hashes=1+1 location=embedded"
        fi ;;
    *) return 90 ;;
  esac
}
# The real mktemp (command skips the function), unless STUB_MKTEMP_SWAP is set: then, once it has made the work dir,
# that dir's parent is swapped for a symlink to it under another name, as a process that can write the grandparent
# could do while the build runs.
function /usr/bin/mktemp {
  local made
  made=$(command /usr/bin/mktemp "$@") || return
  if [[ -n ${STUB_MKTEMP_SWAP:-} ]]; then
    /bin/mv ${made:h} ${made:h}.real && /bin/ln -s ${made:h}.real ${made:h} || return 91
  fi
  print -r -- $made
}
script=$1; shift
source $script
'''

LOUD = '#!/bin/sh\necho "PATH lookup: $(basename "$0")" >&2\nexit 97\n'
LOUD_NAMES = ('security', 'codesign', 'swift', 'xcrun', 'xcode-select', 'git', 'awk', 'sort', 'mktemp', 'mkdir', 'cp',
              'mv', 'rm', 'cat', 'date', 'grep', 'zsh', 'shasum', 'plutil', 'ditto', 'openssl', 'chmod')


class BuildAppRunTest(unittest.TestCase):
    """build-app.sh run end to end in a temp root, as /bin/zsh -f with a minimal environment, the stubs above."""

    @classmethod
    def setUpClass(cls):
        # Every use of a stubbed tool is by the stubbed absolute path, and none goes around zsh's function lookup
        # (command, exec, env), so no call can slip past the stubs to the real tool. Quoted text (messages) and
        # comments do not count.
        code = '\n'.join(re.sub(r'\s#\s.*$', '', re.sub(r"'[^']*'", "''", re.sub(r'"(?:[^"\\]|\\.)*"', '""', line)))
                         for line in code_lines(SCRIPT.read_text()))
        bare = [m.group(0) for m in re.finditer(r'(?<![\w/.-])(security|codesign|xcrun|swift|xcode-select|git)(?![\w.-])', code)
                if not (m.group(0) == 'swift' and code[:m.start()].endswith('/usr/bin/xcrun --no-cache '))]
        assert not bare, f'build-app.sh calls {bare} other than as {STUBBED}'
        assert not re.search(r'\b(command|exec|builtin|env)\s', code), 'build-app.sh goes around function lookup'
        for tool in STUBBED:
            assert tool in code, tool

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.root = self.tmp / 'root'
        for rel in ('Package.swift', 'Sources/a.swift'):
            (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.root / rel).write_text(f'// {rel}\n')
        (self.root / 'scripts').mkdir()
        for rel in ('scripts/build-app.sh', 'scripts/source-hash.sh'):
            shutil.copyfile(REPO / rel, self.root / rel)
        self.harness = self.tmp / 'harness.zsh'
        self.harness.write_text(HARNESS)
        self.loud = self.tmp / 'loud'
        self.loud.mkdir()
        for name in LOUD_NAMES:
            (self.loud / name).write_text(LOUD)
            (self.loud / name).chmod(0o755)
        (self.tmp / 'home').mkdir()
        (self.tmp / 'tmp').mkdir()
        self.log = self.tmp / 'stub.log'

    def argv(self):
        return ['/bin/zsh', '-f', str(self.harness), str(self.root / 'scripts/build-app.sh')]

    def env(self, **env):
        # Only what the plugin's host passes (PATH replaced by the loud one), plus the stubs' settings.
        base = {'PATH': str(self.loud), 'HOME': str(self.tmp / 'home'), 'USER': 'tester', 'LOGNAME': 'tester',
                'TMPDIR': str(self.tmp / 'tmp'), 'LANG': 'en_US.UTF-8', 'STUB_LOG': str(self.log),
                'STUB_BIN': str(self.tmp / 'bin'), 'STUB_IDENTITIES': LISTING}
        return {**base, **env}

    def build(self, **env):
        p = subprocess.run(self.argv(), env=self.env(**env), cwd=self.tmp, capture_output=True, text=True, timeout=60)
        self.assertNotIn('PATH lookup', p.stderr)
        return p.returncode, p.stdout.splitlines(), p.stderr, self.take_calls()

    def take_calls(self):
        calls = self.log.read_text().splitlines() if self.log.exists() else []
        self.log.unlink(missing_ok=True)
        return calls

    @staticmethod
    def work_dirs(parent):
        return sorted(p.name for p in parent.iterdir() if p.name.startswith('.build-app.')) if parent.exists() else []

    def signing(self, calls):
        signs = [c.split() for c in calls if c.startswith('codesign --force')]
        self.assertEqual(len(signs), 1, calls)
        return signs[0]

    def test_a_release_build_signs_with_the_release_identity_and_hardened_runtime(self):
        rc, out, err, calls = self.build()
        self.assertEqual(rc, 0, err)
        sign = self.signing(calls)
        self.assertEqual(sign[sign.index('--sign') + 1], RELEASE_SHA)
        self.assertEqual(sign[sign.index('--options') + 1], 'runtime')
        self.assertEqual(sign[sign.index('--identifier') + 1], 'dev.cu-runtime.daemon')
        info = plistlib.loads((self.root / 'dist/CURuntime.app/Contents/Info.plist').read_bytes())
        self.assertIs(info['CUBench'], False)
        hashed = subprocess.run(['/bin/zsh', '-f', str(self.root / 'scripts/source-hash.sh'), str(self.root)],
                                capture_output=True, text=True).stdout.strip()
        self.assertEqual(info['CUSourceHash'], hashed)
        self.assertTrue(info['CFBundleVersion'].endswith('-nogit'), info['CFBundleVersion'])
        self.assertEqual((self.root / 'dist/CURuntime.app/Contents/MacOS/cu-runtime').read_text(), 'binary\n')
        self.assertIn(f'built {self.root}/dist/CURuntime.app (', '\n'.join(out))
        self.assertFalse((self.root / 'dist-bench').exists())

    def test_a_bench_build_signs_with_the_bench_identity_and_hardened_runtime(self):
        rc, out, err, calls = self.build(CU_BENCH='1')
        self.assertEqual(rc, 0, err)
        sign = self.signing(calls)
        self.assertEqual(sign[sign.index('--sign') + 1], BENCH_SHA)
        self.assertEqual(sign[sign.index('--options') + 1], 'runtime')
        self.assertIn('-DCU_BENCH', [c for c in calls if c.startswith('xcrun --no-cache swift build -c release --product')][0])
        info = plistlib.loads((self.root / 'dist-bench/CURuntime.app/Contents/Info.plist').read_bytes())
        self.assertIs(info['CUBench'], True)
        self.assertFalse((self.root / 'dist').exists())

    def test_sign_is_announced_alone_on_stdout_right_before_codesign(self):
        rc, out, err, calls = self.build()
        self.assertEqual(rc, 0, err)
        self.assertEqual(out.count('== sign'), 1, out)
        i = out.index('STUB codesign signs')
        self.assertEqual(out[i - 1], '== sign', out)
        # On stdout, after the build, and nothing ran between it and codesign.
        self.assertNotIn('== sign', err)
        self.assertLess(out.index("Build of product 'cu-runtime' complete! (0.01s)"), out.index('== sign'))

    def test_a_failed_signing_exits_3_and_leaves_dist_as_it_was(self):
        (self.root / 'dist/CURuntime.app').mkdir(parents=True)
        (self.root / 'dist/CURuntime.app/old').write_text('old build')
        for stub, message in ((dict(STUB_SIGN_RC='1'), 'codesign failed: the keychain\'s password prompt was cancelled or denied'),
                              (dict(STUB_VERIFY_RC='1'), 'the new signature does not verify'),
                              (dict(STUB_FLAGS='0x0(none)'), 'lacks the hardened runtime flag'),
                              (dict(STUB_FLAGS='0x2(adhoc)'), 'lacks the hardened runtime flag'),
                              (dict(STUB_FLAGS='0x10000(runtimefake)'), 'lacks the hardened runtime flag')):
            rc, out, err, calls = self.build(**stub)
            self.assertEqual(rc, 3, (stub, err))
            self.assertIn(message, err)
            self.assertIn(f'{self.root}/dist left untouched', err)
            self.assertIn('== sign', out)
            self.assertEqual([p.name for p in (self.root / 'dist/CURuntime.app').iterdir()], ['old'], stub)
        # The flags the check takes: runtime alone or among others.
        for flags in ('0x10000(runtime)', '0x12a00(kill,restrict,library-validation,runtime)', '0x10002(adhoc,runtime)'):
            self.assertEqual(self.build(STUB_FLAGS=flags)[0], 0, flags)

    def test_other_failures_keep_their_status_and_come_before_the_sign_line(self):
        rc, out, err, calls = self.build(STUB_BUILD_RC='1')
        self.assertEqual(rc, 1, err)
        self.assertNotIn('== sign', out)
        self.assertFalse([c for c in calls if c.startswith('codesign')])
        rc, out, err, calls = self.build(STUB_CLT_RC='2')
        self.assertEqual(rc, 1, err)
        self.assertIn('the Xcode Command Line Tools are not installed', err)
        self.assertEqual(calls, ['xcode-select -p'])
        rc, out, err, calls = self.build(STUB_IDENTITIES='     0 identities found')
        self.assertEqual(rc, 1, err)
        self.assertIn('no code-signing identity "cu-runtime-signing": run scripts/make-signing-identity.sh '
                      'cu-runtime-signing first', err)
        rc, out, err, calls = self.build(CU_BENCH='1', STUB_IDENTITIES=LISTING.replace('"cu-runtime-bench-signing"', '"x"'))
        self.assertEqual(rc, 1, err)
        self.assertIn('run scripts/make-signing-identity.sh cu-runtime-bench-signing first', err)
        twice = LISTING + f'  3) {"C" * 40} "cu-runtime-bench-signing" (CSSMERR_TP_NOT_TRUSTED)\n'
        rc, out, err, calls = self.build(CU_BENCH='1', STUB_IDENTITIES=twice)
        self.assertEqual(rc, 1, err)
        self.assertIn('several code-signing identities named "cu-runtime-bench-signing"', err)

    def test_the_other_kinds_identity_is_refused_by_sha1_too(self):
        for env, other in ((dict(CU_BENCH='1', CU_SIGN_IDENTITY=RELEASE_SHA.lower()), 'cu-runtime-signing'),
                           (dict(CU_SIGN_IDENTITY=BENCH_SHA), 'cu-runtime-bench-signing')):
            rc, out, err, calls = self.build(**env)
            self.assertEqual(rc, 2, (env, err))
            self.assertIn(f'is {other}, the identity of', err)
            self.assertFalse([c for c in calls if c.startswith(('codesign', 'xcrun'))], calls)
            self.assertNotIn('== sign', out)
        # By name, refused before anything is called at all.
        rc, out, err, calls = self.build(CU_BENCH='1', CU_SIGN_NAME='cu-runtime-signing')
        self.assertEqual((rc, calls), (2, []), err)
        # Its own kind's SHA-1 is taken, as given (upper case).
        rc, out, err, calls = self.build(CU_BENCH='1', CU_SIGN_IDENTITY=BENCH_SHA.lower())
        self.assertEqual(rc, 0, err)
        self.assertEqual(self.signing(calls)[self.signing(calls).index('--sign') + 1], BENCH_SHA)

    def test_ad_hoc_needs_no_keychain_and_is_still_hardened(self):
        rc, out, err, calls = self.build(CU_BENCH='1', CU_SIGN_IDENTITY='-')
        self.assertEqual(rc, 0, err)
        self.assertFalse([c for c in calls if c.startswith('security')], calls)
        sign = self.signing(calls)
        self.assertEqual((sign[sign.index('--sign') + 1], sign[sign.index('--options') + 1]), ('-', 'runtime'))

    def test_the_app_is_assembled_and_signed_beside_the_output_not_in_tmpdir(self):
        # $TMPDIR (and /tmp) are writable by dsh's sandboxed tool processes: what codesign signs lies in a 0700 work
        # dir beside the output, also for the plugin page's build (its CU_DIST is under ~/Library/Caches/cu-runtime).
        for env, parent in (({}, self.root),
                            (dict(CU_DIST=str(self.tmp / 'cache/build/dist')), self.tmp / 'cache/build')):
            rc, out, err, calls = self.build(**env)
            self.assertEqual(rc, 0, (env, err))
            signed = [c for c in calls if c.startswith('sign-dir ')]
            self.assertEqual(len(signed), 1, calls)
            m = re.fullmatch(r'sign-dir (\S+) mode (\d+) TMPDIR=(\S+)', signed[0])
            self.assertIsNotNone(m, signed)
            work = Path(m.group(1))
            self.assertEqual(work.parent, parent, env)
            self.assertRegex(work.name, r'^\.build-app\.[A-Za-z0-9]{8}$')
            self.assertEqual(m.group(2), '700')
            # The tools' temp dir is in it too (swift's as well as codesign's), and the caller's gets nothing.
            self.assertEqual(m.group(3), f'{work}/tmp')
            self.assertEqual({c for c in calls if c.startswith('xcrun-env ')}, {f'xcrun-env TMPDIR={work}/tmp'})
            self.assertEqual(list((self.tmp / 'tmp').iterdir()), [], env)
            # Moved into place, the work dir removed.
            self.assertEqual((parent / 'dist/CURuntime.app/Contents/MacOS/cu-runtime').read_text(), 'binary\n')
            self.assertFalse(work.exists())
            self.assertEqual(self.work_dirs(parent), [], env)
            # xcrun never consults its lookup cache (it lies in the user's temp dir).
            swift = [c for c in calls if c.startswith('xcrun ') and not c.startswith('xcrun-env')]
            self.assertEqual(len(swift), 2, calls)
            self.assertTrue(all(c.startswith('xcrun --no-cache swift build ') for c in swift), swift)

    def test_the_here_document_is_written_into_the_work_dir(self):
        # zsh writes a here-document (the Info.plist text, CUBench and CUSourceHash in it) to a temp file named by
        # TMPPREFIX (unset: /tmp/zsh, which dsh's sandboxed tool processes may write) and cat reads it from there.
        # Here the caller's TMPPREFIX names a directory nothing may write into: unless build-app.sh points TMPPREFIX
        # into its work dir, the here-document cannot be made and the build fails.
        closed = self.tmp / 'closed'
        closed.mkdir()
        closed.chmod(0o500)
        self.addCleanup(closed.chmod, 0o700)
        # That TMPPREFIX does stop a here-document (so the build below getting through says where it was written).
        p = subprocess.run(['/bin/zsh', '-f', '-c', '/bin/cat <<EOF\nplist\nEOF'], capture_output=True, text=True,
                           env={'PATH': str(self.loud), 'TMPPREFIX': f'{closed}/zsh'})
        self.assertNotEqual((p.returncode, p.stdout), (0, 'plist\n'), p.stderr)
        rc, out, err, calls = self.build(TMPPREFIX=f'{closed}/zsh')
        self.assertEqual(rc, 0, err)
        info = plistlib.loads((self.root / 'dist/CURuntime.app/Contents/Info.plist').read_bytes())
        self.assertIs(info['CUBench'], False)
        self.assertRegex(info['CUSourceHash'], r'^[0-9a-f]{64}$')
        self.assertEqual(list(closed.iterdir()), [])
        self.assertEqual(list((self.tmp / 'tmp').iterdir()), [])
        self.assertEqual(self.work_dirs(self.root), [])

    def test_the_work_dir_goes_on_every_failure(self):
        # errexit on a failing tool is shown with cp, a real program: a stub is a zsh function, and zsh skips the EXIT
        # trap when errexit fires on a function's status, which the real swift or codesign (programs) never cause.
        # test_nothing_after_the_traps_calls_a_function covers the script's side of that.
        (self.root / 'dist/CURuntime.app').mkdir(parents=True)
        (self.root / 'dist/CURuntime.app/old').write_text('old build')
        cases = ((dict(STUB_SIGN_RC='1'), 3), (dict(STUB_VERIFY_RC='1'), 3), (dict(STUB_FLAGS='0x0(none)'), 3),
                 # errexit at the top level: cp finds no binary.
                 (dict(STUB_NO_BINARY='1', STUB_BIN=str(self.tmp / 'empty-bin')), 1))
        for stub, status in cases:
            rc, out, err, calls = self.build(**stub)
            self.assertEqual(rc, status, (stub, err))
            self.assertEqual(self.work_dirs(self.root), [], stub)
            self.assertEqual(list((self.tmp / 'tmp').iterdir()), [], stub)
            self.assertEqual([p.name for p in (self.root / 'dist/CURuntime.app').iterdir()], ['old'], stub)
        self.assertFalse((self.tmp / 'empty-bin/cu-runtime').exists())

    def test_nothing_after_the_traps_calls_a_function(self):
        # zsh runs no EXIT trap when errexit fires on a function's status: from the traps on, only programs and
        # builtins run (the trap strings name cleanup, and quoted text does not count).
        text = SCRIPT.read_text()
        defined = re.findall(r'^(\w+)\(\) \{', text, re.M)
        self.assertEqual(sorted(defined), ['cleanup', 'named'])
        anchor = 'trap cleanup EXIT\n'
        self.assertEqual(text.count(anchor), 1)
        after = '\n'.join(re.sub(r"'[^']*'", "''", re.sub(r'"(?:[^"\\]|\\.)*"', '""', line))
                          for line in code_lines(text.split(anchor, 1)[1]))
        self.assertIsNone(re.search(r'\b(cleanup|named)\b', after), after)
        # The work dir is made after the traps are set, so no moment is left without them.
        self.assertIn('WORK=$(umask 077 && /usr/bin/mktemp -d "${DIST:h}/.build-app.XXXXXXXX")', text.split(anchor, 1)[1])
        before = text.split(anchor, 1)[0].split('BUNDLE_ID=dev.cu-runtime.daemon')[1]
        self.assertNotIn('mktemp', '\n'.join(code_lines(before)))

    def test_a_work_dir_path_through_a_new_symlink_is_refused(self):
        # The output's parent swapped for a symlink after DIST was resolved: nothing is built or signed through it,
        # and the work dir made there is removed again (rm -rf through the symlink: the dir it made, nothing more).
        parent = self.tmp / 'cache/build'
        rc, out, err, calls = self.build(CU_DIST=str(parent / 'dist'), STUB_MKTEMP_SWAP='1')
        self.assertEqual(rc, 1, err)
        self.assertIn('a directory on its path was made a symlink', err)
        self.assertTrue(parent.is_symlink())
        self.assertEqual(self.work_dirs(Path(f'{parent}.real')), [])
        self.assertEqual(list(Path(f'{parent}.real').iterdir()), [])
        self.assertEqual([c for c in calls if c.startswith(('xcrun', 'codesign'))], [])
        self.assertNotIn('== sign', out)

    def test_a_signal_during_the_build_removes_the_work_dir(self):
        # The plugin's host cancels a build with SIGTERM to its process group (then SIGKILL 5 s later).
        building = self.tmp / 'building'
        for sig, status in ((signal.SIGTERM, 143), (signal.SIGINT, 130), (signal.SIGHUP, 129)):
            building.unlink(missing_ok=True)
            p = subprocess.Popen(self.argv(), env=self.env(STUB_BUILD_SLEEP='30', STUB_BUILDING=str(building)),
                                 cwd=self.tmp, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                 start_new_session=True)
            try:
                deadline = time.monotonic() + 30
                while not building.exists():
                    self.assertIsNone(p.poll(), p.stderr.read() if p.poll() is not None else '')
                    self.assertLess(time.monotonic(), deadline, 'the build never started')
                    time.sleep(0.05)
                self.assertEqual(len(self.work_dirs(self.root)), 1, 'the work dir exists while it builds')
                os.killpg(p.pid, sig)
                out, err = p.communicate(timeout=30)
            finally:
                if p.poll() is None:
                    os.killpg(p.pid, signal.SIGKILL)
                    p.wait()
            self.assertEqual(p.returncode, status, (sig, err))
            self.assertEqual(self.work_dirs(self.root), [], sig)
            self.assertFalse((self.root / 'dist').exists(), sig)
            self.assertNotIn('== sign', out)
            self.take_calls()

    def test_its_own_zsh_reads_no_zshenv(self):
        # source-hash.sh runs as /bin/zsh -f: a ZDOTDIR/.zshenv, read by a zsh without -f, would print into the hash.
        zdot = self.tmp / 'zdot'
        zdot.mkdir()
        (zdot / '.zshenv').write_text('print from-zshenv\n')
        rc, out, err, calls = self.build(ZDOTDIR=str(zdot))
        self.assertEqual(rc, 0, err)
        info = plistlib.loads((self.root / 'dist/CURuntime.app/Contents/Info.plist').read_bytes())
        self.assertRegex(info['CUSourceHash'], r'^[0-9a-f]{64}$')


if __name__ == '__main__':
    unittest.main()
