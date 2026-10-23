"""bench/checkpoint.py: an interrupted run keeps its finished jobs and re-runs none of them."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import checkpoint  # noqa: E402

JOBS = [('T1', 'dom', 1), ('T1', 'dom', 2), ('T2', 'canvas', 1)]


class CheckpointTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run = Path(self.tmp.name) / 'r1'
        self.run.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def job(self, task, mode, k, done):
        d = checkpoint.job_dir(self.run, task, mode, k)
        (d / 'sessions').mkdir(parents=True)
        (d / 'sessions' / 's.jsonl').write_text('{}\n')
        if done:
            (d / 'result.json').write_text('{}')
        return d

    def test_manifest_counts_only_jobs_with_result(self):
        self.job('T1', 'dom', 1, done=True)
        self.job('T1', 'dom', 2, done=False)
        man = checkpoint.write_manifest(self.run, JOBS)
        self.assertEqual((man['planned'], man['done']), (3, 1))
        self.assertEqual([j['done'] for j in man['jobs']], [True, False, False])
        self.assertIn('1/3 done, 2 left', checkpoint.status(self.run))

    def test_attempts_accumulate(self):
        checkpoint.write_manifest(self.run, JOBS, attempt={'n': 1})
        checkpoint.write_manifest(self.run, JOBS)  # a per-job update adds no attempt
        man = checkpoint.write_manifest(self.run, JOBS, attempt={'n': 2})
        self.assertEqual(man['attempts'], [{'n': 1}, {'n': 2}])
        self.assertEqual(json.loads((self.run / 'manifest.json').read_text())['attempts'], [{'n': 1}, {'n': 2}])

    def test_partial_jobs_set_aside_not_deleted(self):
        done = self.job('T1', 'dom', 1, done=True)
        partial = self.job('T1', 'dom', 2, done=False)
        moved = checkpoint.set_aside_partial(self.run, stamp='X')
        self.assertEqual(moved, [partial.with_name('k2.partial-X')])
        self.assertFalse(partial.exists())
        self.assertTrue((partial.with_name('k2.partial-X') / 'sessions' / 's.jsonl').exists())
        self.assertTrue((done / 'result.json').exists())
        # Set-aside dirs are not job dirs: a second pass moves nothing, and the scorer sees no result in them.
        self.assertEqual(checkpoint.set_aside_partial(self.run, stamp='Y'), [])

    def test_complete(self):
        for t, m, k in JOBS:
            self.job(t, m, k, done=True)
        checkpoint.write_manifest(self.run, JOBS)
        self.assertTrue(checkpoint.status(self.run).endswith('(complete)'))

    def test_status_ignores_results_outside_the_plan(self):
        self.job('T9', 'dom', 1, done=True)
        checkpoint.write_manifest(self.run, JOBS)
        self.assertIn('0/3 done', checkpoint.status(self.run))


if __name__ == '__main__':
    unittest.main()
