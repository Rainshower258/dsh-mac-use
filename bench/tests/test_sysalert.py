"""bench/sysalert.py: a system prompt in front before a run is an environment failure; other apps are not."""
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import sysalert  # noqa: E402


def lsappinfo(bundle):
    """subprocess.run stand-in answering `lsappinfo front` and `lsappinfo info -only bundleid`."""
    def run(argv, **kw):
        out = 'ASN:0x0-0x1234:' if argv[1] == 'front' else f'"CFBundleIdentifier"="{bundle}"\n'
        return subprocess.CompletedProcess(argv, 0, stdout=out, stderr='')
    return run


class SysAlertTest(unittest.TestCase):
    def test_user_notification_center_in_front_is_reported(self):
        with mock.patch.object(sysalert.subprocess, 'run', lsappinfo('com.apple.UserNotificationCenter')):
            self.assertEqual(sysalert.system_prompt_in_front(), 'com.apple.usernotificationcenter')

    def test_an_ordinary_app_or_a_terminal_is_not(self):
        # A terminal in front means something escaped: that must stay a failure, never an environment excuse.
        for bundle in ('dev.dsh.bench.fixture', 'com.apple.Terminal', 'com.tencent.qq'):
            with mock.patch.object(sysalert.subprocess, 'run', lsappinfo(bundle)):
                self.assertIsNone(sysalert.system_prompt_in_front(), bundle)

    def test_lsappinfo_unavailable_is_not_a_prompt(self):
        def boom(*a, **kw):
            raise OSError('no lsappinfo')
        with mock.patch.object(sysalert.subprocess, 'run', boom):
            self.assertIsNone(sysalert.frontmost_bundle())


if __name__ == '__main__':
    unittest.main()
