"""scripts/make-signing-identity.sh without the keychain: the key is never on disk unencrypted, the temp files go also
when the script is interrupted or terminated, and the import does not trust codesign.

The script is sourced by a harness that defines a zsh function named /usr/bin/security (zsh looks up functions
before the file system, also for a name with slashes); the script calls it only by that path. The stand-in lists
identities and takes the import: it checks the .p12 opens with the password given and records what it saw. openssl
is the real /usr/bin/openssl, wrapped to record whether the key it wrote is encrypted. HOME is a temp dir (so the
keychain path the script names is a temp path), and PATH holds only programs that fail loudly.
"""
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / 'scripts/make-signing-identity.sh'
SHA = 'D' * 40

HARNESS = r'''
stub_log() { print -r -- "$*" >> $STUB_LOG }
function /usr/bin/security {
  # -i: commands on stdin, split as security splits them (quotes, backslashes); logged as security-stdin, so a test
  # can tell them from what was in the argv.
  if [[ $1 == -i ]]; then
    stub_log security "$@"
    local line rc=0
    while IFS= read -r line; do STUB_VIA_STDIN=1 /usr/bin/security "${(@Q)${(z)line}}" || rc=$?; done
    return $rc
  fi
  if [[ -n ${STUB_VIA_STDIN:-} ]]; then stub_log security-stdin "$@"; else stub_log security "$@"; fi
  case $1 in
    find-identity)
      # STUB_REAL_SHA: the imported identity is listed by its certificate's real SHA-1, as the keychain would.
      local sha=$STUB_SHA
      [[ -n ${STUB_REAL_SHA:-} && -f $STUB_STATE/sha ]] && sha=$(<$STUB_STATE/sha)
      [[ -f $STUB_STATE/imported ]] && print -r -- "  1) $sha \"$(<$STUB_STATE/imported)\" (CSSMERR_TP_NOT_TRUSTED)"
      [[ -n ${STUB_EXISTING:-} ]] && print -r -- "  1) $STUB_SHA \"$STUB_EXISTING\" (CSSMERR_TP_NOT_TRUSTED)"
      return 0 ;;
    import)
      local -a a=("$@")
      local p12=$2 pass=${a[${a[(i)-P]}+1]}
      print -r -- ${p12:h} > $STUB_STATE/tmpdir
      [[ -e ${p12:h}/key.pem ]] && stub_log key.pem-present || stub_log key.pem-absent
      command /usr/bin/openssl pkcs12 -in $p12 -passin pass:$pass -noout 2>/dev/null && stub_log p12-opens || stub_log p12-BAD
      local cn=$(command /usr/bin/openssl pkcs12 -in $p12 -passin pass:$pass -nokeys 2>/dev/null | /usr/bin/grep -m1 '^subject=')
      stub_log "p12 $cn"
      local fp=$(command /usr/bin/openssl pkcs12 -in $p12 -passin pass:$pass -nokeys 2>/dev/null \
                 | command /usr/bin/openssl x509 -noout -fingerprint -sha1 2>/dev/null)
      print -r -- ${${fp#*=}//:/} > $STUB_STATE/sha
      stub_log "dir mode $(/usr/bin/stat -f %Lp ${p12:h})"
      if [[ -n ${STUB_HANG:-} ]]; then print ready > $STUB_STATE/ready; /bin/sleep 30; fi
      (( ${STUB_IMPORT_RC:-0} == 0 )) || return $STUB_IMPORT_RC
      print -r -- $STUB_NAME > $STUB_STATE/imported ;;
    *) return 90 ;;
  esac
}
function /usr/bin/openssl {
  command /usr/bin/openssl "$@"
  local rc=$?
  if [[ $1 == req ]]; then
    local -a a=("$@")
    local key=${a[${a[(i)-keyout]}+1]}
    # Matched by the header's start: only an encrypted PKCS#8 key begins so (the whole header is a pattern pre-push's
    # privacy check refuses in tracked files).
    /usr/bin/grep -q '^-----BEGIN ENCRYPTED ' $key && stub_log key-encrypted || stub_log key-PLAIN
  fi
  return $rc
}
# The script's own arguments: what follows its path (source keeps the caller's positional parameters when given none).
script=$1; shift
source $script "$@"
'''

LOUD = '#!/bin/sh\necho "PATH lookup: $(basename "$0")" >&2\nexit 97\n'


class MakeSigningIdentityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        code = '\n'.join(re.sub(r'\s#\s.*$', '', re.sub(r"'[^']*'", "''", re.sub(r'"(?:[^"\\]|\\.)*"', '""', line)))
                         for line in SCRIPT.read_text().splitlines() if not line.lstrip().startswith('#'))
        bare = re.findall(r'(?<![\w/.$-])(security|codesign|openssl)(?![\w.-])', code)
        assert not bare, f'make-signing-identity.sh calls {bare} other than by absolute path'
        assert not re.search(r'\b(command|exec|builtin|env)\s', code), 'it goes around function lookup'

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.state = self.tmp / 'state'
        self.state.mkdir()
        (self.tmp / 'home').mkdir()
        (self.tmp / 'tmp').mkdir()
        self.harness = self.tmp / 'harness.zsh'
        self.harness.write_text(HARNESS)
        loud = self.tmp / 'loud'
        loud.mkdir()
        for name in ('security', 'openssl', 'awk', 'sort', 'mktemp', 'chmod', 'rm', 'cat', 'codesign', 'grep'):
            (loud / name).write_text(LOUD)
            (loud / name).chmod(0o755)
        self.log = self.tmp / 'stub.log'
        self.env = {'PATH': str(loud), 'HOME': str(self.tmp / 'home'), 'USER': 'tester', 'LOGNAME': 'tester',
                    'TMPDIR': str(self.tmp / 'tmp'), 'LANG': 'en_US.UTF-8', 'STUB_LOG': str(self.log),
                    'STUB_STATE': str(self.state), 'STUB_SHA': SHA}

    def argv(self, *args):
        return ['/bin/zsh', '-f', str(self.harness), str(SCRIPT), *args]

    def run_script(self, *args, name='cu-runtime-signing', **env):
        p = subprocess.run(self.argv(*args), env={**self.env, 'STUB_NAME': name, **env}, capture_output=True,
                           text=True, timeout=60)
        self.assertNotIn('PATH lookup', p.stderr)
        return p.returncode, p.stdout, p.stderr, self.calls()

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def temp_dir(self):
        return Path((self.state / 'tmpdir').read_text().strip())

    def test_creates_the_identity_with_an_encrypted_key_and_cleans_up(self):
        rc, out, err, calls = self.run_script()
        self.assertEqual(rc, 0, err)
        self.assertIn('key-encrypted', calls)
        self.assertNotIn('key-PLAIN', calls)
        # Gone before the import (the .p12 holds it, encrypted too), and the .p12 opens with the password given.
        self.assertIn('key.pem-absent', calls)
        self.assertIn('p12-opens', calls)
        self.assertTrue(any(c.startswith('p12 subject=') and 'cu-runtime-signing' in c for c in calls), calls)
        self.assertIn('dir mode 700', calls)
        imports = [c.split() for c in calls if c.startswith('security-stdin import')]
        self.assertEqual(len(imports), 1, calls)
        # The password is never in an argv (ps shows those to every process of the user): security gets it on stdin.
        self.assertIn('security -i', calls)
        self.assertFalse([c for c in calls if c.startswith('security import')], calls)
        # No -T: codesign is not on the key's access list, so every signing asks.
        self.assertNotIn('-T', imports[0])
        self.assertEqual(imports[0][imports[0].index('-k') + 1], f'{self.tmp}/home/Library/Keychains/login.keychain-db')
        self.assertFalse(self.temp_dir().exists())
        self.assertIn(f'created code-signing identity "cu-runtime-signing" ({SHA})', out)
        self.assertIn('choose Allow (允许), not Always Allow (始终允许)', out)
        self.assertNotIn('vm-grant-base.sh', out)

    def test_the_bench_identity_says_the_base_must_grant_it(self):
        rc, out, err, calls = self.run_script('cu-runtime-bench-signing', name='cu-runtime-bench-signing')
        self.assertEqual(rc, 0, err)
        self.assertTrue(any(c.startswith('p12 subject=') and 'cu-runtime-bench-signing' in c for c in calls), calls)
        self.assertIn('created code-signing identity "cu-runtime-bench-signing"', out)
        self.assertIn('the VM base must grant it once', out)
        self.assertIn('scripts/vm-grant-base.sh', out)

    def test_an_existing_identity_is_kept(self):
        rc, out, err, calls = self.run_script(STUB_EXISTING='cu-runtime-signing')
        self.assertEqual(rc, 0, err)
        self.assertIn('already exists', out)
        self.assertFalse([c for c in calls if 'import' in c.split()[:2]])
        self.assertEqual(list((self.tmp / 'tmp').iterdir()), [])

    def test_a_failed_import_leaves_no_files(self):
        rc, out, err, calls = self.run_script(STUB_IMPORT_RC='1')
        self.assertEqual(rc, 1, err)
        self.assertIn('import failed', err)
        self.assertFalse(self.temp_dir().exists())
        self.assertEqual(list((self.tmp / 'tmp').iterdir()), [])

    def kept(self, name='cu-runtime-signing'):
        return self.tmp / 'home' / f'.{name}' / 'cert.pem'

    def fingerprint(self, path):
        p = subprocess.run(['/usr/bin/openssl', 'x509', '-noout', '-fingerprint', '-sha1', '-in', str(path)],
                           capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        return p.stdout.strip().split('=', 1)[1]

    def test_the_certificate_alone_is_kept_to_check_the_identity_against(self):
        rc, out, err, calls = self.run_script(STUB_REAL_SHA='1')
        self.assertEqual(rc, 0, err)
        cert = self.kept()
        text = cert.read_text()
        # A certificate, no key in any form (matched by parts: the whole headers are patterns pre-push refuses).
        self.assertTrue(text.startswith('-----BEGIN CERTIFICATE-----\n'), text[:40])
        self.assertNotIn('KEY', text)
        self.assertEqual(oct(cert.stat().st_mode & 0o777), '0o600')
        self.assertEqual(oct(cert.parent.stat().st_mode & 0o777), '0o700')
        sha = self.fingerprint(cert)
        self.assertRegex(sha, r'^([0-9A-F]{2}:){19}[0-9A-F]{2}$')
        self.assertEqual(sha.replace(':', ''), (self.state / 'sha').read_text().strip(), 'the certificate imported')
        self.assertIn(f'its certificate (SHA-1 {sha}) is kept in {cert}', out)
        self.assertIn(f'/usr/bin/openssl x509 -noout -fingerprint -sha1 -in {cert}', out)
        self.assertEqual(err, '')
        # The bench identity's goes beside it, under its own name.
        rc, out, err, calls = self.run_script('cu-runtime-bench-signing', name='cu-runtime-bench-signing',
                                              STUB_REAL_SHA='1')
        self.assertEqual(rc, 0, err)
        self.assertTrue(self.kept('cu-runtime-bench-signing').read_text().startswith('-----BEGIN CERTIFICATE-----'))
        self.assertNotEqual(self.fingerprint(self.kept('cu-runtime-bench-signing')), sha)

    def test_an_earlier_certificate_there_is_renamed_never_followed(self):
        keep = self.kept().parent
        keep.mkdir(mode=0o700)
        (keep / 'cert.pem').write_text('earlier\n')
        rc, out, err, calls = self.run_script(STUB_REAL_SHA='1')
        self.assertEqual(rc, 0, err)
        replaced = [p for p in keep.iterdir() if p.name.startswith('cert.pem.replaced-')]
        self.assertEqual([p.read_text() for p in replaced], ['earlier\n'])
        self.assertTrue(self.kept().read_text().startswith('-----BEGIN CERTIFICATE-----'))
        # A symlink in its place is renamed, and what it points to is left alone.
        (self.state / 'imported').unlink()
        target = self.tmp / 'elsewhere.txt'
        target.write_text('not a certificate\n')
        for p in replaced:
            p.unlink()
        self.kept().unlink()
        self.kept().symlink_to(target)
        rc, out, err, calls = self.run_script(STUB_REAL_SHA='1')
        self.assertEqual(rc, 0, err)
        self.assertEqual(target.read_text(), 'not a certificate\n')
        self.assertFalse(self.kept().is_symlink())
        self.assertTrue(any(p.is_symlink() for p in keep.iterdir() if p.name.startswith('cert.pem.replaced-')))
        # Also one that points nowhere yet: nothing is written through it.
        (self.state / 'imported').unlink()
        for p in keep.iterdir():
            p.unlink()
        nowhere = self.tmp / 'created-through-the-link'
        self.kept().symlink_to(nowhere)
        rc, out, err, calls = self.run_script(STUB_REAL_SHA='1')
        self.assertEqual(rc, 0, err)
        self.assertFalse(nowhere.exists())
        self.assertFalse(self.kept().is_symlink())
        self.assertTrue(self.kept().read_text().startswith('-----BEGIN CERTIFICATE-----'))

    def test_the_identity_is_made_when_the_certificate_cannot_be_kept(self):
        (self.tmp / 'home/.cu-runtime-signing').write_text('a file, not a directory\n')
        rc, out, err, calls = self.run_script(STUB_REAL_SHA='1')
        self.assertEqual(rc, 0, err)
        self.assertIn('created code-signing identity "cu-runtime-signing"', out)
        self.assertIn('its certificate could not be kept', err)
        self.assertEqual((self.tmp / 'home/.cu-runtime-signing').read_text(), 'a file, not a directory\n')
        # A symlinked directory is not written through either.
        (self.state / 'imported').unlink()
        (self.tmp / 'home/.cu-runtime-signing').unlink()
        elsewhere = self.tmp / 'elsewhere'
        elsewhere.mkdir()
        (self.tmp / 'home/.cu-runtime-signing').symlink_to(elsewhere)
        rc, out, err, calls = self.run_script(STUB_REAL_SHA='1')
        self.assertEqual(rc, 0, err)
        self.assertIn('its certificate could not be kept', err)
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_a_listed_identity_that_is_not_the_certificate_made_is_named(self):
        rc, out, err, calls = self.run_script()   # the stand-in lists D…D, not the real certificate's SHA-1
        self.assertEqual(rc, 0, err)
        self.assertIn(f'is not the identity listed ({SHA}): check the keychain', err)

    def test_an_existing_identity_keeps_no_certificate(self):
        rc, out, err, calls = self.run_script(STUB_EXISTING='cu-runtime-signing')
        self.assertEqual(rc, 0, err)
        self.assertFalse(self.kept().parent.exists())
        self.assertIn(f'no certificate is kept in {self.kept()} to check the identity against', out)
        # Once one is there, it says nothing of it.
        self.kept().parent.mkdir(mode=0o700)
        self.kept().write_text('kept\n')
        rc, out, err, calls = self.run_script(STUB_EXISTING='cu-runtime-signing')
        self.assertEqual(rc, 0, err)
        self.assertNotIn('no certificate is kept', out)
        self.assertEqual(self.kept().read_text(), 'kept\n')

    def test_a_signal_leaves_no_files(self):
        # As the plugin's host ends a cancelled or timed-out step: the signal to the whole process group.
        for sig, status in ((signal.SIGTERM, 143), (signal.SIGINT, 130), (signal.SIGHUP, 129)):
            (self.state / 'ready').unlink(missing_ok=True)
            p = subprocess.Popen(self.argv(), env={**self.env, 'STUB_NAME': 'cu-runtime-signing', 'STUB_HANG': '1'},
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
            try:
                for _ in range(200):
                    if (self.state / 'ready').exists():
                        break
                    time.sleep(0.05)
                self.assertTrue((self.state / 'ready').exists(), p.stderr.read() if p.poll() is not None else 'no import')
                self.assertTrue(self.temp_dir().exists())
                os.killpg(p.pid, sig)
                self.assertEqual(p.wait(timeout=20), status, sig)
            finally:
                if p.poll() is None:
                    os.killpg(p.pid, signal.SIGKILL)
                p.communicate()
            self.assertFalse(self.temp_dir().exists(), sig)
            self.assertEqual(list((self.tmp / 'tmp').iterdir()), [], sig)


if __name__ == '__main__':
    unittest.main()
