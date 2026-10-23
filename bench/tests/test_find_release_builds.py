"""scripts/find-release-builds.sh: it finds every CURuntime.app (Spotlight plus find over the places Spotlight skips),
tells a hardened release build signed with the current release identity from every other bundle the release
certificate signed, and removes those only after "yes" on the terminal.

Nothing of this Mac is read. The script, copied into a temp tree (a checkout with worktrees, a home with
~/Applications, ~/Library/Caches/cu-runtime and ~/Archives, a temp dir), is sourced by a harness that defines zsh
functions named /usr/bin/mdfind, /usr/bin/security, /usr/bin/codesign, /usr/bin/plutil, /usr/bin/find, /bin/ps and
/bin/rm (zsh looks up functions before the file system, also for a name with slashes); the script calls every tool by
its absolute path. mdfind, security, codesign and ps answer from the environment and the fixtures (a bundle's
Contents/_codesign holds what codesign -d prints for it); plutil, find and rm are the real programs behind a guard that
refuses any path outside the temp tree (find drops such a root, /private/tmp among them, and logs it). PATH holds only
programs that fail loudly. --delete reads its answer from /dev/tty: those tests run it in a pseudo-terminal of its
own, the others in a new session without a terminal.
"""
import hashlib
import os
import plistlib
import pty
import re
import select
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / 'scripts/find-release-builds.sh'
RELEASE = 'AB' * 20
EARLIER = 'EF' * 20
BENCH = 'CD' * 20
LISTING = f'''Policy: Code Signing
  Matching identities
  1) {RELEASE} "cu-runtime-signing" (CSSMERR_TP_NOT_TRUSTED)
  2) {BENCH} "cu-runtime-bench-signing" (CSSMERR_TP_NOT_TRUSTED)
     2 identities found

  Valid identities only
     0 valid identities found
'''

HARNESS = r'''
stub_log() { print -r -- "$*" >> $STUB_LOG }
inside() { [[ ${1:A} == $STUB_ROOT || ${1:A} == $STUB_ROOT/* ]] }
function /usr/bin/mdfind {
  stub_log mdfind "$@"
  [[ -z ${STUB_MDFIND:-} ]] || print -r -- $STUB_MDFIND
  return ${STUB_MDFIND_RC:-0}
}
function /usr/bin/security {
  stub_log security "$@"
  [[ $1 == find-identity ]] || return 90
  print -r -- "$STUB_IDENTITIES"
  return ${STUB_SECURITY_RC:-0}
}
function /bin/ps {
  stub_log ps "$@"
  print -r -- x >> $STUB_STATE/ps-calls
  [[ -z ${STUB_PS:-} ]] || print -r -- $STUB_PS
  if [[ -n ${STUB_LATE:-} ]] && (( $(/usr/bin/wc -l < $STUB_STATE/ps-calls) >= 2 )); then source $STUB_LATE; fi
  return 0
}
function /usr/bin/codesign {
  stub_log codesign "$@"
  [[ $1 == -d ]] || return 90
  local app=${@[-1]}
  inside $app || return 91
  if [[ ! -f $app/Contents/_codesign ]]; then print -u2 -r -- "$app: code object is not signed at all"; return 1; fi
  print -u2 -r -- "Executable=$app/Contents/MacOS/cu-runtime"
  /usr/bin/grep -v '^designated' $app/Contents/_codesign >&2
  /usr/bin/grep '^designated' $app/Contents/_codesign
  return 0
}
function /usr/bin/plutil {
  stub_log plutil "$@"
  [[ $1 == -extract ]] || return 90
  inside ${@[-1]} || return 91
  command /usr/bin/plutil "$@"
}
function /usr/bin/find {
  stub_log find "$@"
  local -a roots=() kept=()
  local a
  for a in "$@"; do [[ $a == [-\(\!]* ]] && break; roots+=($a); done
  for a in $roots; do if inside $a; then kept+=($a); else stub_log find-dropped $a; fi; done
  (( ${#kept} )) || return 0
  command /usr/bin/find $kept "${@[${#roots}+1,-1]}"
}
function /bin/rm {
  stub_log rm "$@"
  local a
  for a in "$@"; do [[ $a == -* ]] && continue; inside $a || return 91; done
  command /bin/rm "$@"
}
script=$1; shift
source $script "$@"
'''

LOUD = '#!/bin/sh\necho "PATH lookup: $(basename "$0")" >&2\nexit 97\n'
LOUD_NAMES = ('mdfind', 'security', 'codesign', 'plutil', 'find', 'ps', 'rm', 'awk', 'sort', 'grep', 'openssl',
              'shasum', 'mv', 'ditto', 'tccutil', 'pkill', 'kill')


def code_text(text):
    """The script's code: comment lines dropped, quoted text emptied, trailing comments cut."""
    lines = [line for line in text.splitlines() if not line.lstrip().startswith('#')]
    return '\n'.join(re.sub(r'\s#\s.*$', '', re.sub(r"'[^']*'", "''", re.sub(r'"(?:[^"\\]|\\.)*"', '""', line)))
                     for line in lines)


class StaticTest(unittest.TestCase):
    def test_every_tool_by_absolute_path_and_only_reads(self):
        code = code_text(SCRIPT.read_text())
        bare = re.findall(r'(?<![\w/.$-])(mdfind|find|codesign|plutil|security|ps|rm|awk|sort|tccutil|kill|pkill|mv)'
                          r'(?![\w.-])', code)
        self.assertEqual(bare, [], 'a tool not called by its absolute path')
        self.assertIsNone(re.search(r'\b(command|exec|builtin|env|eval)\s', code), 'it goes around function lookup')
        # Display only: codesign -d, plutil -extract, security find-identity; nothing else of them.
        self.assertEqual(set(re.findall(r'/usr/bin/codesign (\S+)', code)), {'-d'})
        self.assertEqual(set(re.findall(r'/usr/bin/plutil (\S+)', code)), {'-extract'})
        self.assertEqual(set(re.findall(r'/usr/bin/security (\S+)', code)), {'find-identity'})
        # The only change it can make: rm -rf of a listed bundle, after the answer.
        self.assertEqual(re.findall(r'/bin/rm [^\n]*', code), ['/bin/rm -rf -- ""; then'])


class FindReleaseBuildsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.home = self.tmp / 'home'
        self.repo = self.tmp / 'repo'
        self.temp = self.tmp / 'tmp'
        for d in (self.home / 'Applications', self.home / 'Library/Caches/cu-runtime/build', self.home / 'Archives',
                  self.repo / 'scripts', self.temp):
            d.mkdir(parents=True)
        self.script = self.repo / 'scripts/find-release-builds.sh'
        shutil.copyfile(SCRIPT, self.script)
        self.harness = self.tmp / 'harness.zsh'
        self.harness.write_text(HARNESS)
        loud = self.tmp / 'loud'
        loud.mkdir()
        for name in LOUD_NAMES:
            (loud / name).write_text(LOUD)
            (loud / name).chmod(0o755)
        self.log = self.tmp / 'stub.log'
        state = self.tmp / 'state'
        state.mkdir()
        self.env = {'PATH': str(loud), 'HOME': str(self.home), 'USER': 'tester', 'LOGNAME': 'tester',
                    'TMPDIR': str(self.temp), 'LANG': 'en_US.UTF-8', 'STUB_LOG': str(self.log),
                    'STUB_ROOT': str(self.tmp), 'STUB_STATE': str(state), 'STUB_IDENTITIES': LISTING}

    # Fixtures ------------------------------------------------------------------------------------------------------

    def app(self, path, *, cubench=None, cert='release', runtime=False, bundle_id='dev.cu-runtime.daemon',
            version='20261020.152317-2a5edb0', cdhash=None):
        """A bundle at path. cert: 'release', 'earlier' (another certificate named cu-runtime-signing), 'bench',
        'other', 'adhoc' or None (unsigned). cdhash: what codesign -d --verbose=3 prints as CDHash (by default one
        of this path and these settings, so another bundle made in its place has another one)."""
        path = Path(path)
        if cdhash is None:
            # 40 hex digits, as codesign prints a CDHash (sha256 truncated to 20 bytes).
            cdhash = hashlib.sha256(f'{path}|{bundle_id}|{version}|{cubench}|{cert}|{runtime}'.encode()).hexdigest()[:40]
        (path / 'Contents/MacOS').mkdir(parents=True)
        (path / 'Contents/MacOS/cu-runtime').write_text('binary\n')
        info = {'CFBundleIdentifier': bundle_id, 'CFBundleVersion': version}
        if cubench is not None:
            info['CUBench'] = cubench
        (path / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
        flags = '0x10000(runtime)' if runtime else '0x0(none)'
        if cert == 'adhoc':
            flags = '0x10002(adhoc,runtime)' if runtime else '0x2(adhoc)'
            lines = [f'CodeDirectory v=20400 size=1 flags={flags} hashes=1+1 location=embedded', 'Signature=adhoc',
                     'designated => cdhash H"0123456789abcdef0123456789abcdef01234567"']
        elif cert is not None:
            name, sha = {'release': ('cu-runtime-signing', RELEASE), 'earlier': ('cu-runtime-signing', EARLIER),
                         'bench': ('cu-runtime-bench-signing', BENCH), 'other': ('Someone Else', '12' * 20)}[cert]
            lines = ['Identifier=dev.cu-runtime.daemon', 'Format=app bundle with Mach-O thin (arm64)',
                     f'CodeDirectory v=20400 size=1 flags={flags} hashes=1+1 location=embedded', 'Signature size=1726',
                     f'Authority={name}', 'TeamIdentifier=not set',
                     f'designated => identifier "dev.cu-runtime.daemon" and certificate leaf = H"{sha.lower()}"']
        if cert is not None:
            lines.insert(-1, f'CDHash={cdhash}')
            (path / 'Contents/_codesign').write_text('\n'.join(lines) + '\n')
        return path

    def standard_set(self):
        """Bundles of every kind in every place, and what Spotlight lists (it skips hidden directories)."""
        apps = {
            'installed': self.app(self.home / 'Applications/CURuntime.app', version='20261020.133925-b071a06'),
            'cache': self.app(self.home / 'Library/Caches/cu-runtime/build/dist/CURuntime.app', cubench=False,
                              runtime=True, version='20261021.010101-abcdef0'),
            'staged-old': self.app(self.home / 'Applications/.CURuntime.app.old-7', cubench=False, runtime=False),
            'worktree': self.app(self.repo / '.claude/worktrees/wf_1/dist/CURuntime.app', cubench=False),
            'worktree-bench': self.app(self.repo / '.claude/worktrees/wf_1/dist-bench/CURuntime.app', cubench=True,
                                       cert='bench', runtime=True),
            'dist': self.app(self.repo / 'dist/CURuntime.app', cubench=False, runtime=True),
            'old-bench': self.app(self.repo / 'dist-bench/CURuntime.app', cubench=True, runtime=False),
            'archive': self.app(self.home / 'Archives/x/CURuntime-20261003-1207.app'),
            'archive-hidden': self.app(self.home / 'Archives/.old/cu-runtime-public/dist/CURuntime.app'),
            'tmp': self.app(self.temp / '.scratch/CURuntime.app', cubench=False),
            # A copy left by a mistyped copy target, outside every place find searches.
            'stray': self.app(self.tmp / 'elsewhere/mangled-target/pplications/CURuntime.app'),
            'earlier-cert': self.app(self.tmp / 'elsewhere/rotated/CURuntime.app', cubench=False, cert='earlier',
                                     runtime=True),
            'adhoc': self.app(self.tmp / 'elsewhere/adhoc/CURuntime.app', cubench=True, cert='adhoc', runtime=True),
            'unsigned': self.app(self.tmp / 'elsewhere/unsigned/CURuntime.app', cert=None),
            'foreign': self.app(self.tmp / 'elsewhere/foreign/CURuntime.app', cubench=False, cert='other',
                                runtime=True),
        }
        # Another app in a searched place, and one with a look-alike name: never listed.
        self.app(self.home / 'Applications/Other.app', bundle_id='com.example.other')
        self.app(self.home / 'Archives/y/CURuntime.app', bundle_id='com.example.lookalike')
        spotlight = [apps[k] for k in ('installed', 'cache', 'dist', 'old-bench', 'archive', 'stray', 'earlier-cert',
                                       'adhoc', 'unsigned', 'foreign')]
        return apps, '\n'.join(str(p) for p in spotlight)

    def tree(self):
        # The stand-ins' own files (their log, the ps call count) aside.
        return sorted(str(p.relative_to(self.tmp)) for p in self.tmp.rglob('*')
                      if p.name != 'stub.log' and p.relative_to(self.tmp).parts[0] != 'state')

    def fresh(self):
        (self.tmp / 'state/ps-calls').unlink(missing_ok=True)

    # Running -------------------------------------------------------------------------------------------------------

    def argv(self, *args, script=None):
        return ['/bin/zsh', '-f', str(self.harness), str(script or self.script), *args]

    def run_script(self, *args, script=None, input=None, **env):
        """In a new session: no controlling terminal, so /dev/tty cannot be opened."""
        self.fresh()
        p = subprocess.run(self.argv(*args, script=script), env={**self.env, **env}, capture_output=True, text=True,
                           input=input, timeout=60, start_new_session=True)
        self.assertNotIn('PATH lookup', p.stderr)
        return p.returncode, p.stdout, p.stderr, self.calls()

    def run_tty(self, *args, answer, **env):
        """In a pseudo-terminal of its own: the answer is typed once the prompt shows."""
        self.fresh()
        pid, fd = pty.fork()
        if pid == 0:   # the child: a new session with the pty as its terminal
            try:
                os.execve('/bin/zsh', self.argv(*args), {**self.env, **env})
            finally:
                os._exit(127)
        out, sent, status, deadline = b'', False, None, time.monotonic() + 60

        def read_some(timeout):
            """What the terminal has within timeout; b'' when nothing came or it closed (EIO once the child is gone)."""
            if not select.select([fd], [], [], timeout)[0]:
                return b''
            try:
                return os.read(fd, 4096)
            except OSError:
                return b''

        try:
            while status is None:
                self.assertLess(time.monotonic(), deadline, f'no end within 60 s: {out!r}')
                chunk = read_some(0.2)
                out += chunk
                if not sent and b'Type yes' in out:
                    os.write(fd, answer.encode() + b'\n')
                    sent = True
                if not chunk:
                    done, st = os.waitpid(pid, os.WNOHANG)
                    if done:
                        status = st
            while chunk := read_some(0):   # what it wrote right before it exited
                out += chunk
        finally:
            if status is None:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            os.close(fd)
        rc = os.waitstatus_to_exitcode(status)
        text = out.decode().replace('\r\n', '\n')
        self.assertNotIn('PATH lookup', text)
        return rc, text, sent, self.calls()

    def calls(self):
        calls = self.log.read_text().splitlines() if self.log.exists() else []
        self.log.unlink(missing_ok=True)
        return calls

    @staticmethod
    def blocks(out):
        """{path: (verdict, the block's lines after the first)}."""
        found = {}
        for block in out.split('\n\n'):
            lines = block.strip('\n').splitlines()
            if lines and re.match(r'^(keep|REMOVE|bench|other) +/', lines[0]):
                verdict, path = lines[0].split(None, 1)
                found[path] = (verdict, [line.strip() for line in lines[1:]])
        return found

    # Tests ---------------------------------------------------------------------------------------------------------

    def test_lists_every_bundle_with_its_verdict_and_changes_nothing(self):
        apps, spotlight = self.standard_set()
        before = self.tree()
        rc, out, err, calls = self.run_script(STUB_MDFIND=spotlight)
        self.assertEqual(rc, 1, err)   # flagged bundles are left
        found = self.blocks(out)
        expected = {'installed': 'REMOVE', 'cache': 'keep', 'staged-old': 'REMOVE', 'worktree': 'REMOVE',
                    'worktree-bench': 'bench', 'dist': 'keep', 'old-bench': 'REMOVE', 'archive': 'REMOVE',
                    'archive-hidden': 'REMOVE', 'tmp': 'REMOVE', 'stray': 'REMOVE', 'earlier-cert': 'REMOVE',
                    'adhoc': 'other', 'unsigned': 'other', 'foreign': 'other'}
        self.assertEqual({p: v for p, (v, _) in found.items()}, {str(apps[k]): v for k, v in expected.items()})
        self.assertIn('15 bundles: 2 keep, 9 REMOVE, 1 bench, 3 other', out)
        self.assertEqual(self.tree(), before, 'a listing changes nothing')
        self.assertFalse([c for c in calls if c.startswith('rm ')], calls)
        # The fields: version, CUBench, hardened runtime, certificate and leaf SHA-1 in openssl's form.
        release_colons = ':'.join([RELEASE[i:i + 2] for i in range(0, 40, 2)])
        _, lines = found[str(apps['installed'])]
        self.assertEqual(lines[0], 'CFBundleVersion 20261020.133925-b071a06, CUBench (none), hardened runtime no')
        self.assertEqual(lines[1], f'certificate cu-runtime-signing, leaf SHA-1 {release_colons}')
        self.assertIn('no CUBench key: built before R1', lines[2])
        self.assertIn('no hardened runtime: built before 3ecf445', lines[2])
        _, lines = found[str(apps['cache'])]
        self.assertEqual(lines[0], 'CFBundleVersion 20261021.010101-abcdef0, CUBench false, hardened runtime yes')
        self.assertEqual(lines[2], 'a hardened release build signed with the current release identity')
        # Release builds from d4faaeb up to b0d4919: CUBench false, but no hardened runtime.
        _, lines = found[str(apps['worktree'])]
        self.assertEqual(lines[2], 'no hardened runtime: built before 3ecf445')
        _, lines = found[str(apps['old-bench'])]
        self.assertIn('a bench build (CUBench true) signed with the release certificate', lines[2])
        _, lines = found[str(apps['earlier-cert'])]
        self.assertIn('not the current release identity', lines[2])
        self.assertIn(':'.join([EARLIER[i:i + 2] for i in range(0, 40, 2)]), lines[1])
        _, lines = found[str(apps['adhoc'])]
        self.assertEqual((lines[1], lines[2]), ('certificate (none), leaf SHA-1 (none)',
                                                'an ad-hoc signature: not flagged'))
        self.assertEqual(found[str(apps['unsigned'])][1][2], 'not signed: not flagged')
        self.assertEqual(found[str(apps['foreign'])][1][2], 'signed with another certificate (Someone Else): not flagged')
        self.assertIn(f'Release identity (cu-runtime-signing in the keychain): {release_colons}', out)
        self.assertIn('To remove the REMOVE bundles: zsh scripts/find-release-builds.sh --delete', out)
        self.assertIn('rotate the release certificate', out)

    def test_searches_spotlight_and_the_places_it_skips(self):
        apps, _ = self.standard_set()
        rc, out, err, calls = self.run_script()   # Spotlight lists nothing: find alone
        found = self.blocks(out)
        for key in ('installed', 'cache', 'staged-old', 'worktree', 'worktree-bench', 'dist', 'old-bench', 'archive',
                    'archive-hidden', 'tmp'):
            self.assertIn(str(apps[key]), found, key)
        # Outside the places searched, only Spotlight knows them.
        for key in ('stray', 'earlier-cert', 'adhoc', 'unsigned', 'foreign'):
            self.assertNotIn(str(apps[key]), found, key)
        mdfind = [c for c in calls if c.startswith('mdfind ')]
        self.assertEqual(mdfind, ['mdfind kMDItemCFBundleIdentifier == "dev.cu-runtime.daemon"'])
        finds = [c for c in calls if c.startswith('find ')]
        self.assertEqual(len(finds), 1, calls)
        roots = finds[0].split(' ( ')[0].split()[1:]
        self.assertEqual(roots, [str(self.repo), str(self.home / 'Library/Caches/cu-runtime'),
                                 str(self.home / 'Applications'), str(self.home / 'Archives'), '/private/tmp',
                                 str(self.temp)])
        # /private/tmp is searched on a real run; here the guard dropped it.
        self.assertIn('find-dropped /private/tmp', calls)
        self.assertIn('-name .git -o -name node_modules', finds[0])

    def test_a_bundle_both_find_and_spotlight_see_is_listed_once(self):
        apps, _ = self.standard_set()
        # Spotlight's own spelling of a path may differ (a symlink on the way): resolved, it is the same bundle.
        (self.tmp / 'link').symlink_to(self.home)
        twice = '\n'.join([str(apps['installed']), str(self.tmp / 'link/Applications/CURuntime.app'), str(apps['dist'])])
        rc, out, err, calls = self.run_script(STUB_MDFIND=twice)
        self.assertEqual(out.count(f'  {apps["installed"]}\n'), 1, out)
        self.assertEqual(out.count(f'  {apps["dist"]}\n'), 1, out)
        self.assertNotIn(str(self.tmp / 'link'), ''.join(self.blocks(out)))

    def test_a_linked_worktree_searches_the_main_checkout(self):
        apps, _ = self.standard_set()
        inner = self.repo / '.claude/worktrees/wf_1/scripts/find-release-builds.sh'
        inner.parent.mkdir(parents=True)
        shutil.copyfile(SCRIPT, inner)
        rc, out, err, calls = self.run_script(script=inner)
        found = self.blocks(out)
        for key in ('dist', 'old-bench', 'worktree', 'worktree-bench'):
            self.assertIn(str(apps[key]), found, key)
        finds = [c for c in calls if c.startswith('find ')]
        self.assertEqual(finds[0].split()[1], str(self.repo))

    def test_the_worktrees_of_another_checkout_spotlight_shows_a_build_of_are_searched(self):
        other = self.tmp / 'other-checkout'
        shown = self.app(other / 'dist/CURuntime.app')
        hidden = self.app(other / '.claude/worktrees/wf_9/dist/CURuntime.app', cubench=False)
        # This checkout's own worktrees, already under a root, are not a root of their own.
        mine = self.app(self.repo / 'dist/CURuntime.app', cubench=False, runtime=True)
        (self.repo / '.claude/worktrees').mkdir(parents=True)
        rc, out, err, calls = self.run_script(STUB_MDFIND=f'{shown}\n{mine}')
        found = self.blocks(out)
        self.assertEqual(found[str(hidden)][0], 'REMOVE')
        self.assertIn(str(shown), found)
        roots = [c for c in calls if c.startswith('find ')][0].split(' ( ')[0].split()[1:]
        self.assertEqual(roots[-1], str(other / '.claude/worktrees'))
        self.assertNotIn(str(self.repo / '.claude/worktrees'), roots)
        # Spotlight shows no build of it: its worktrees are not seen (README says so).
        rc, out, err, calls = self.run_script(STUB_MDFIND=str(mine))
        self.assertNotIn(str(hidden), self.blocks(out))

    def test_the_work_dir_a_killed_build_left_in_another_checkout_is_searched(self):
        other = self.tmp / 'other-checkout'
        shown = self.app(other / 'dist/CURuntime.app')
        left = self.app(other / '.build-app.Ab12Cd34/CURuntime.app', cubench=False)
        # A symlink there is not followed.
        elsewhere = self.app(self.tmp / 'elsewhere/CURuntime.app')
        (other / '.build-app.Symlink1').symlink_to(self.tmp / 'elsewhere')
        rc, out, err, calls = self.run_script(STUB_MDFIND=str(shown))
        found = self.blocks(out)
        self.assertEqual(found[str(left)][0], 'REMOVE')
        roots = [c for c in calls if c.startswith('find ')][0].split(' ( ')[0].split()[1:]
        self.assertIn(str(other / '.build-app.Ab12Cd34'), roots)
        self.assertNotIn(str(other / '.build-app.Symlink1'), roots)
        self.assertNotIn(str(elsewhere), found)

    def test_directories_given_are_searched_too(self):
        extra = self.tmp / 'backup disk'
        app = self.app(extra / '.hidden/CURuntime.app')
        rc, out, err, calls = self.run_script(str(extra))
        self.assertIn(str(app), self.blocks(out))
        rc, out, err, calls = self.run_script(str(self.tmp / 'missing'))
        self.assertEqual(rc, 2)
        self.assertIn('is not a directory', err)
        rc, out, err, calls = self.run_script('--force')
        self.assertEqual(rc, 2)
        self.assertIn('usage: find-release-builds.sh [--delete] [dir ...]', err)

    def test_nothing_flagged_exits_0(self):
        self.app(self.home / 'Applications/CURuntime.app', cubench=False, runtime=True)
        self.app(self.repo / 'dist-bench/CURuntime.app', cubench=True, cert='bench', runtime=True)
        rc, out, err, calls = self.run_script()
        self.assertEqual(rc, 0, err)
        self.assertIn('2 bundles: 1 keep, 0 REMOVE, 1 bench, 0 other', out)
        self.assertNotIn('--delete', out)
        rc, out, err, calls = self.run_script('--delete')
        self.assertEqual(rc, 0, err)
        self.assertIn('Nothing to remove.', out)
        rc, out, err, calls = self.run_script()
        self.assertEqual(rc, 0)
        shutil.rmtree(self.home / 'Applications/CURuntime.app')
        shutil.rmtree(self.repo / 'dist-bench')
        rc, out, err, calls = self.run_script()
        self.assertEqual(rc, 0, err)
        self.assertIn('No CURuntime.app found.', out)

    def test_without_a_release_identity_nothing_signed_with_its_name_is_kept(self):
        app = self.app(self.home / 'Applications/CURuntime.app', cubench=False, runtime=True)
        rc, out, err, calls = self.run_script(STUB_IDENTITIES='     0 identities found')
        self.assertEqual(rc, 1)
        verdict, lines = self.blocks(out)[str(app)]
        self.assertEqual(verdict, 'REMOVE')
        self.assertIn('no identity named cu-runtime-signing is in the keychain', lines[2])
        self.assertIn('Release identity (cu-runtime-signing in the keychain): none', out)

    def test_a_running_process_is_named(self):
        app = self.app(self.home / 'Applications/CURuntime.app')
        ps = f'    1 /sbin/launchd\n  4242 {app}/Contents/MacOS/cu-runtime\n  4243 {app}x/Contents/MacOS/cu-runtime'
        rc, out, err, calls = self.run_script(STUB_PS=ps)
        self.assertEqual(self.blocks(out)[str(app)][1][3], 'running: pid 4242')
        # ps may spell the path through a symlink (/var for /private/var): resolved, it is the same bundle.
        (self.tmp / 'var').symlink_to(self.home)
        ps = f'  4244 {self.tmp}/var/Applications/CURuntime.app/Contents/MacOS/cu-runtime'
        rc, out, err, calls = self.run_script(STUB_PS=ps)
        self.assertEqual(self.blocks(out)[str(app)][1][3], 'running: pid 4244')

    # --delete ------------------------------------------------------------------------------------------------------

    def test_delete_removes_the_flagged_bundles_after_yes_on_the_terminal(self):
        apps, spotlight = self.standard_set()
        rc, out, sent, calls = self.run_tty('--delete', answer='yes', STUB_MDFIND=spotlight)
        self.assertTrue(sent, out)
        self.assertEqual(rc, 0, out)
        # Listed first, then asked, then removed.
        self.assertLess(out.index('9 REMOVE'), out.index('Type yes to remove the 9 bundles marked REMOVE'))
        flagged = ('installed', 'staged-old', 'worktree', 'old-bench', 'archive', 'archive-hidden', 'tmp', 'stray',
                   'earlier-cert')
        for key, path in apps.items():
            self.assertEqual(path.exists(), key not in flagged, key)
            if key in flagged:
                self.assertIn(f'removed {path}\n', out)
        self.assertTrue((self.home / 'Applications/Other.app').exists())
        self.assertTrue((self.home / 'Archives/y/CURuntime.app').exists())
        # It says, before asking and after, that the plugin and cu-std have no daemon until the next install.
        installed = str(self.home / 'Applications/CURuntime.app')
        self.assertLess(out.index(f'{installed} is among them: once it is removed, the plugin and cu-std have no '
                                  'daemon until the next install'), out.index('Type yes'))
        self.assertIn(f'{installed} is gone: the plugin and cu-std have no daemon until the next install', out)
        self.assertIn("(安装守护进程 on the plugin page's 守护进程 tab).", out)
        removes = [c for c in calls if c.startswith('rm ')]
        self.assertEqual(len(removes), len(flagged), calls)
        # Each through its parent directory, entered once it was checked: rm is handed ./<name>, not the path.
        self.assertEqual(sorted(removes), sorted(f'rm -rf -- ./{apps[key].name}' for key in flagged))
        # The check right before each removal reads it there too, as ./<name>: a directory higher up swapped after the
        # parent was entered changes nothing about what is judged.
        for key in flagged:
            name = apps[key].name
            self.assertIn(f'codesign -d --verbose=3 -r- ./{name}', calls, key)
            self.assertIn(f'plutil -extract CFBundleVersion raw -o - ./{name}/Contents/Info.plist', calls, key)
        # Run again: nothing is left to remove.
        rc, out, err, calls = self.run_script(STUB_MDFIND=spotlight.replace(str(apps['installed']), ''))
        self.assertEqual(rc, 0, out)
        self.assertIn('0 REMOVE', out)

    def test_delete_without_yes_removes_nothing(self):
        apps, spotlight = self.standard_set()
        before = self.tree()
        for answer in ('no', 'y', 'YES', ' yes', ''):
            rc, out, sent, calls = self.run_tty('--delete', answer=answer, STUB_MDFIND=spotlight)
            self.assertTrue(sent, out)
            self.assertEqual(rc, 1, (answer, out))
            self.assertIn('Nothing removed (the answer was not yes).', out)
            self.assertEqual(self.tree(), before, answer)
            self.assertFalse([c for c in calls if c.startswith('rm ')], calls)

    def test_delete_without_a_terminal_refuses_and_reads_no_stdin(self):
        apps, spotlight = self.standard_set()
        before = self.tree()
        rc, out, err, calls = self.run_script('--delete', input='yes\n', STUB_MDFIND=spotlight)
        self.assertEqual(rc, 1, err)
        self.assertIn('--delete asks on the terminal, and this process has none', err)
        self.assertIn('9 REMOVE', out)   # it still lists
        self.assertEqual(self.tree(), before)

    def test_delete_refuses_while_a_process_runs_from_a_flagged_bundle(self):
        apps, spotlight = self.standard_set()
        before = self.tree()
        ps = f'  4242 {apps["installed"]}/Contents/MacOS/cu-runtime'
        rc, out, sent, calls = self.run_tty('--delete', answer='yes', STUB_MDFIND=spotlight, STUB_PS=ps)
        self.assertFalse(sent, out)
        self.assertEqual(rc, 1, out)
        self.assertIn('a process runs from these, and removing a bundle does not stop it', out)
        self.assertIn(f'{apps["installed"]} (pid 4242)', out)
        self.assertEqual(self.tree(), before)

    def test_delete_refuses_with_several_release_identities_or_an_unlisted_keychain(self):
        apps, spotlight = self.standard_set()
        before = self.tree()
        several = LISTING.replace('  2) ', f'  3) {EARLIER} "cu-runtime-signing" (CSSMERR_TP_NOT_TRUSTED)\n  2) ')
        rc, out, sent, calls = self.run_tty('--delete', answer='yes', STUB_MDFIND=spotlight, STUB_IDENTITIES=several)
        self.assertFalse(sent, out)
        self.assertEqual(rc, 1, out)
        self.assertIn('several identities are named cu-runtime-signing', out)
        # Listing still works: both count as current there.
        self.assertEqual(self.blocks(out)[str(apps['earlier-cert'])][0], 'keep')
        rc, out, sent, calls = self.run_tty('--delete', answer='yes', STUB_MDFIND=spotlight, STUB_SECURITY_RC='1')
        self.assertFalse(sent, out)
        self.assertEqual(rc, 1, out)
        self.assertIn("the keychain's identities could not be listed", out)
        self.assertEqual(self.tree(), before)

    def late(self, text):
        """A snippet the ps stand-in runs from its second call on: the one right before the removals."""
        hook = self.tmp / 'late.zsh'
        hook.write_text(text)
        return str(hook)

    def test_delete_leaves_a_bundle_a_process_runs_from_since_the_listing(self):
        app = self.app(self.home / 'Applications/CURuntime.app')
        archived = self.app(self.home / 'Archives/CURuntime.app')
        hook = self.late(f'print -r -- "  77 {app}/Contents/MacOS/cu-runtime"\n')
        rc, out, sent, calls = self.run_tty('--delete', answer='yes', STUB_LATE=hook)
        self.assertTrue(sent, out)
        self.assertEqual(rc, 1, out)
        self.assertIn(f'left alone: {app} (a process runs from it since the listing: pid 77)', out)
        self.assertTrue(app.exists())
        self.assertFalse(archived.exists())
        self.assertNotIn(f'{app} is gone', out)

    def test_delete_leaves_a_bundle_replaced_since_the_listing(self):
        app = self.app(self.home / 'Archives/CURuntime.app')
        # Between the answer and the removal the bundle becomes a symlink, here to a bundle of the same id outside
        # every place searched: neither the link nor what it points to goes.
        target = self.app(self.tmp / 'outside/CURuntime.app', cubench=False, runtime=True)
        hook = self.late(f'command /bin/rm -rf {app}; /bin/ln -s {target} {app}\n')
        rc, out, sent, calls = self.run_tty('--delete', answer='yes', STUB_LATE=hook)
        self.assertTrue(sent, out)
        self.assertEqual(rc, 1, out)
        self.assertIn(f'left alone: {app} changed since it was listed', out)
        self.assertTrue(app.is_symlink())
        self.assertTrue((target / 'Contents/MacOS/cu-runtime').exists())
        self.assertFalse([c for c in calls if c.startswith('rm ')], calls)
        # Replaced by another app altogether (another bundle id): left alone too.
        app2 = self.app(self.home / 'Archives/again/CURuntime.app')
        other = self.app(self.tmp / 'other/CURuntime.app', bundle_id='com.example.other')
        hook = self.late(f'command /bin/rm -rf {app2}; /bin/mv {other} {app2}\n')
        rc, out, sent, calls = self.run_tty('--delete', answer='yes', STUB_LATE=hook)
        self.assertEqual(rc, 1, out)
        self.assertIn(f'left alone: {app2} changed since it was listed', out)
        self.assertTrue((app2 / 'Contents/MacOS/cu-runtime').exists())

    def test_delete_leaves_a_bundle_a_directory_on_whose_path_became_a_symlink(self):
        # A process that can write a searched place (/private/tmp, $TMPDIR) lists a copy of an old release build there,
        # then, while the question waits, swaps a directory on its path for a symlink to where an identical bundle
        # lies (~/Applications, a checkout's dist/): the bundle read through the link is the one judged, so only the
        # path shows it. Neither the bundle the link leads to nor the one moved away goes, at any depth.
        for depth, rel in ((1, 'd/CURuntime.app'), (2, 'g/h/CURuntime.app')):
            with self.subTest(depth=depth):
                app = self.app(self.temp / rel)
                swapped = self.temp / Path(rel).parts[0]
                target = self.tmp / f'outside{depth}'
                shutil.copytree(swapped, target / swapped.name, symlinks=True)
                lead = target / swapped.name
                hook = self.late(f'/bin/mv {swapped} {swapped}.moved; /bin/ln -s {lead} {swapped}\n')
                rc, out, sent, calls = self.run_tty('--delete', answer='yes', STUB_LATE=hook)
                self.assertTrue(sent, out)
                self.assertEqual(rc, 1, out)
                self.assertIn(f'left alone: {app} changed since it was listed (a directory on its path is gone or a '
                              'symlink now)', out)
                self.assertTrue((lead / Path(rel).relative_to(swapped.name) / 'Contents/MacOS/cu-runtime').exists())
                self.assertTrue((Path(f'{swapped}.moved') / Path(rel).relative_to(swapped.name)).exists())
                self.assertFalse([c for c in calls if c.startswith('rm ')], calls)
                swapped.unlink()
                shutil.rmtree(f'{swapped}.moved')

    def test_delete_leaves_a_bundle_rebuilt_since_the_listing(self):
        # A build from before 3ecf445 at dist/ is listed; while the question waits, install.sh's build-app.sh puts a
        # fresh hardened release build there (rm, then mv): same path, same bundle id, nothing running from it yet.
        app = self.app(self.repo / 'dist/CURuntime.app', cubench=False, runtime=False)
        fresh = self.app(self.tmp / 'fresh/CURuntime.app', cubench=False, runtime=True, version='20261021.090000-1234567')
        hook = self.late(f'command /bin/rm -rf {app}; /bin/mv {fresh} {app}\n')
        rc, out, sent, calls = self.run_tty('--delete', answer='yes', STUB_LATE=hook)
        self.assertTrue(sent, out)
        self.assertEqual(rc, 1, out)
        self.assertIn(f'left alone: {app} changed since it was listed (its Info.plist or signature is not the one '
                      'judged)', out)
        self.assertEqual(plistlib.loads((app / 'Contents/Info.plist').read_bytes())['CFBundleVersion'],
                         '20261021.090000-1234567')
        self.assertFalse([c for c in calls if c.startswith('rm ')], calls)
        # The same Info.plist and verdict, only another CDHash (re-signed, or another binary): left alone too.
        app2 = self.app(self.home / 'Archives/again/CURuntime.app')
        resigned = self.app(self.tmp / 'resigned/CURuntime.app', cdhash='9' * 40)
        (resigned / 'Contents/Info.plist').write_bytes((app2 / 'Contents/Info.plist').read_bytes())
        hook = self.late(f'command /bin/rm -rf {app2}; /bin/mv {resigned} {app2}\n')
        rc, out, sent, calls = self.run_tty('--delete', answer='yes', STUB_LATE=hook)
        self.assertEqual(rc, 1, out)
        self.assertIn(f'left alone: {app2} changed since it was listed (its Info.plist or signature', out)
        self.assertIn('CDHash=' + '9' * 40, (app2 / 'Contents/_codesign').read_text())
        self.assertFalse([c for c in calls if c.startswith('rm ')], calls)
        # Left as it was, the bundle goes.
        rc, out, sent, calls = self.run_tty('--delete', answer='yes')
        self.assertEqual(rc, 0, out)
        self.assertFalse(app2.exists())


if __name__ == '__main__':
    unittest.main()
