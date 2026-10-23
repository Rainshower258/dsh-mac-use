"""bench/records.py: run records outlive run directories (incident root cause 6)."""
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import records  # noqa: E402


class RecordsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.root = self.base / 'archive'
        self.run = self.base / 'runs' / 'r1'
        (self.run / 'T1' / 'dom' / 'k1' / 'sessions').mkdir(parents=True)
        (self.run / 'T1' / 'dom' / 'k1' / 'sessions' / 's.jsonl').write_text('{"type":"tool/call"}\n')
        (self.run / 'guest-audit').mkdir()
        (self.run / 'guest-audit' / 'audit-2026-09-30.jsonl').write_text('{"method":"observe"}\n')

    def tearDown(self):
        self.tmp.cleanup()

    def test_clean_keeps_the_records(self):
        dest = records.clean(self.run, self.root)
        self.assertFalse(self.run.exists())
        self.assertEqual((dest / 'T1/dom/k1/sessions/s.jsonl').read_text(), '{"type":"tool/call"}\n')
        self.assertTrue((dest / 'guest-audit/audit-2026-09-30.jsonl').exists())

    def test_rearchive_merges_and_never_drops(self):
        records.archive(self.run, self.root)
        (self.run / 'T1' / 'dom' / 'k1' / 'sessions' / 's.jsonl').unlink()
        (self.run / 'T2').mkdir()
        (self.run / 'T2' / 'result.json').write_text('{}')
        dest = records.archive(self.run, self.root)
        self.assertTrue((dest / 'T1/dom/k1/sessions/s.jsonl').exists())
        self.assertTrue((dest / 'T2/result.json').exists())

    def test_prune_after_30_days_only(self):
        dest = records.archive(self.run, self.root)
        stamp = dest / records.STAMP
        now = time.time()
        os.utime(stamp, (now - 29 * 86400, now - 29 * 86400))
        self.assertEqual(records.prune(self.root, now=now), [])
        os.utime(stamp, (now - 31 * 86400, now - 31 * 86400))
        self.assertEqual(records.prune(self.root, now=now), [dest])
        self.assertFalse(dest.exists())


if __name__ == '__main__':
    unittest.main()
