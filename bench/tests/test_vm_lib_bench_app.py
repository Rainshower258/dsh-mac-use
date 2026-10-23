"""scripts/vm-lib.sh's require_bench_app: the runners deploy only a bench build signed by the one
cu-runtime-bench-signing identity (its certificate, checked with codesign --verify -R) with hardened runtime.

vm-lib.sh itself needs the VM (it reads the guest password when sourced), so its BENCH_SIGN_NAME and BUNDLE_ID
lines and the three functions are taken out and run alone, with fake security and codesign on PATH (and the real
plutil, awk and sort); the fakes answer from environment variables and log their arguments.
"""
import plistlib
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
VM_LIB = REPO / 'scripts/vm-lib.sh'
BENCH_SHA = 'B' * 39 + '2'
RELEASE_SHA = 'A' * 39 + '1'
LISTING = f'''  1) {RELEASE_SHA} "cu-runtime-signing" (CSSMERR_TP_NOT_TRUSTED)
  2) {BENCH_SHA.lower()} "cu-runtime-bench-signing" (CSSMERR_TP_NOT_TRUSTED)
     2 identities found'''

FAKE_SECURITY = '#!/bin/sh\necho "security $*" >> "$FAKE_LOG"\nprintf "%s\\n" "$FAKE_IDENTITIES"\n'
# --verify passes only for the requirement in FAKE_SIGNED_BY ("=identifier … and certificate leaf = H\"<SHA-1>\"").
FAKE_CODESIGN = r'''#!/bin/sh
echo "codesign $*" >> "$FAKE_LOG"
case "$1" in
  --verify) for a in "$@"; do case "$a" in =*) req=$a ;; esac; done
            [ "$req" = "=identifier \"dev.cu-runtime.daemon\" and certificate leaf = H\"$FAKE_SIGNED_BY\"" ] ;;
  -d) echo "CodeDirectory v=20500 size=1 flags=$FAKE_FLAGS hashes=1+1 location=embedded" >&2 ;;
  *) exit 90 ;;
esac
'''


def extracted():
    text = VM_LIB.read_text()
    parts = []
    for var in ('BENCH_SIGN_NAME', 'BUNDLE_ID'):
        lines = re.findall(rf'^{var}=.*$', text, re.M)
        assert len(lines) == 1, var
        parts.append(lines[0])
    for fn in ('bench_app_built', 'bench_identity', 'require_bench_app'):
        bodies = re.findall(rf'^{fn}\(\) \{{\n.*?^\}}\n', text, re.M | re.S)
        assert len(bodies) == 1, fn
        parts.append(bodies[0])
    return '\n'.join(parts)


class RequireBenchAppTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.root = self.tmp / 'root'
        self.app = self.root / 'dist-bench/CURuntime.app'
        self.write_app(bench=True)
        bin_dir = self.tmp / 'bin'
        bin_dir.mkdir()
        for name, text in (('security', FAKE_SECURITY), ('codesign', FAKE_CODESIGN)):
            (bin_dir / name).write_text(text)
            (bin_dir / name).chmod(0o755)
        for real in ('/usr/bin/plutil', '/usr/bin/awk', '/usr/bin/sort'):
            (bin_dir / Path(real).name).symlink_to(real)
        self.lib = self.tmp / 'lib.zsh'
        self.lib.write_text(extracted())
        self.log = self.tmp / 'fake.log'
        self.env = {'PATH': str(bin_dir), 'HOME': str(self.tmp), 'FAKE_LOG': str(self.log),
                    'FAKE_IDENTITIES': LISTING, 'FAKE_SIGNED_BY': BENCH_SHA, 'FAKE_FLAGS': '0x10000(runtime)'}

    def write_app(self, bench):
        (self.app / 'Contents').mkdir(parents=True, exist_ok=True)
        (self.app / 'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': 'dev.cu-runtime.daemon',
                                                                        'CUBench': bench}))

    def require(self, **env):
        script = 'ROOT=$1; BENCH_APP=$ROOT/dist-bench/CURuntime.app; source $2; require_bench_app'
        p = subprocess.run(['/bin/zsh', '-f', '-c', script, 'zsh', str(self.root), str(self.lib)],
                           env={**self.env, **env}, capture_output=True, text=True, timeout=30)
        calls = self.log.read_text().splitlines() if self.log.exists() else []
        self.log.unlink(missing_ok=True)
        return p.returncode, p.stderr, calls

    def test_a_bench_build_signed_by_the_bench_identity_with_hardened_runtime_passes(self):
        rc, err, calls = self.require()
        self.assertEqual(rc, 0, err)
        verify = [c for c in calls if c.startswith('codesign --verify')]
        self.assertEqual(verify, [f'codesign --verify --strict -R =identifier "dev.cu-runtime.daemon" and certificate '
                                  f'leaf = H"{BENCH_SHA}" {self.app}'])
        for flags in ('0x12a00(kill,restrict,library-validation,runtime)', '0x10002(adhoc,runtime)'):
            self.assertEqual(self.require(FAKE_FLAGS=flags)[0], 0, flags)

    def test_a_build_signed_with_the_release_certificate_is_refused(self):
        rc, err, calls = self.require(FAKE_SIGNED_BY=RELEASE_SHA)
        self.assertEqual(rc, 1)
        self.assertIn(f'is not signed by cu-runtime-bench-signing ({BENCH_SHA})', err)
        rc, err, calls = self.require(FAKE_SIGNED_BY='-')
        self.assertEqual(rc, 1)

    def test_without_hardened_runtime_it_is_refused(self):
        for flags in ('0x0(none)', '0x2(adhoc)', '0x2000(library-validation)'):
            rc, err, calls = self.require(FAKE_FLAGS=flags)
            self.assertEqual(rc, 1, flags)
            self.assertIn('is signed without hardened runtime', err)

    def test_the_bench_identity_must_be_there_once(self):
        rc, err, calls = self.require(FAKE_IDENTITIES=f'  1) {RELEASE_SHA} "cu-runtime-signing"')
        self.assertEqual(rc, 1)
        self.assertIn('no code-signing identity "cu-runtime-bench-signing"', err)
        self.assertIn("scripts/vm-grant-base.sh's header", err)
        self.assertFalse([c for c in calls if c.startswith('codesign')])
        rc, err, calls = self.require(FAKE_IDENTITIES=LISTING + f'\n  3) {"C" * 40} "cu-runtime-bench-signing"')
        self.assertEqual(rc, 1)
        self.assertIn('several code-signing identities named "cu-runtime-bench-signing"', err)

    def test_a_release_build_is_refused_before_any_signature_check(self):
        self.write_app(bench=False)
        rc, err, calls = self.require()
        self.assertEqual(rc, 1)
        self.assertIn('is not a bench build', err)
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
