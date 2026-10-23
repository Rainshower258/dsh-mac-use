"""scripts/hooks/pre-push: the push-what-is-checked-out guard and the two privacy steps, run against a throwaway git
repository (the hook's tests and scanners before them are not run).

The hook's own text is cut into pieces and run by zsh with its fail/step helpers, so a change to the hook is what is
tested. Each case builds a small history, marks what the remote already has with a remote-tracking ref, and feeds the
hook the stdin git would.
"""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HOOK = (REPO / 'scripts/hooks/pre-push').read_text()
ZERO = '0' * 40
NOREPLY = '1+someone@users.noreply.github.com'
# The leaks the cases plant, put together at run time: written out, they would be leaks in this file to the hook.
USERS = '/Us' + 'ers/'
BOB_RUN = USERS + 'bob/run'
BOB_MAIL = 'bob' + '@' + 'corp.com'


def piece(start: str, end: str) -> str:
    i = HOOK.index(start)
    return HOOK[i:HOOK.index(end, i)]


GUARD = piece('zero=0000', 'step "swift test"')
PRIVACY = piece('step "privacy: tracked files"', 'step "all checks passed"')
PRELUDE = 'fail() { print -u2 "pre-push: FAILED: $1"; exit 1 }\nstep() { print "pre-push: $1" }\npriv=$PRIV\n'


class PrePushPrivacy(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.repo = self.dir / 'repo'
        self.repo.mkdir()
        self.priv = self.dir / 'private-patterns'
        self.priv.write_text('Zanzibar-Secret\n')
        self.git('init', '-q', '-b', 'main')
        self.commit('README.md', 'hello\n', 'first')
        self.git('update-ref', 'refs/remotes/origin/main', 'HEAD')   # what the remote already has

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args, msg_env=None):
        env = {**os.environ, 'GIT_AUTHOR_NAME': 'x', 'GIT_COMMITTER_NAME': 'x', 'GIT_AUTHOR_EMAIL': NOREPLY,
               'GIT_COMMITTER_EMAIL': NOREPLY, **(msg_env or {})}
        return subprocess.run(['git', '-C', str(self.repo), *args], check=True, capture_output=True, text=True,
                              env=env).stdout.strip()

    def commit(self, name, text, message, email=NOREPLY):
        (self.repo / name).write_text(text)
        self.git('add', name)
        self.git('commit', '-q', '-m', message, msg_env={'GIT_AUTHOR_EMAIL': email, 'GIT_COMMITTER_EMAIL': email})

    def run_hook(self, script, lsha=None):
        lsha = lsha or self.git('rev-parse', 'HEAD')
        remote = self.git('rev-parse', 'refs/remotes/origin/main')
        stdin = f'refs/heads/main {lsha} refs/heads/main {remote}\n'
        r = subprocess.run(['/bin/zsh', '-f', '-c', PRELUDE + script], cwd=self.repo, input=stdin, text=True,
                           capture_output=True, env=dict(os.environ, PRIV=str(self.priv)))
        return r.returncode, r.stdout + r.stderr

    def privacy(self, lsha=None):
        # Ends as the hook does: the loop's last test leaves a non-zero status that the next step resets.
        return self.run_hook(GUARD + PRIVACY + 'step "all checks passed"\n', lsha)

    def test_a_clean_push_passes(self):
        self.commit('a.txt', f'contact {NOREPLY}, a@example.com, {USERS}a1/bench, devinwild48@gmail.com\n', 'add a')
        rc, out = self.privacy()
        self.assertEqual(rc, 0, out)

    def test_only_the_checked_out_commit_may_be_pushed(self):
        first = self.git('rev-parse', 'HEAD')
        self.commit('a.txt', 'a\n', 'add a')
        rc, out = self.run_hook(GUARD, lsha=first)
        self.assertEqual(rc, 1)
        self.assertIn('is not the checked-out commit', out)

    def test_a_path_added_then_removed_is_still_caught(self):
        self.commit('a.txt', f'log at {BOB_RUN}\n', 'add a')
        self.commit('a.txt', 'log at <somewhere>\n', 'scrub a')
        rc, out = self.privacy()
        self.assertEqual(rc, 1)
        self.assertIn('added by a commit being pushed', out)
        self.assertIn(BOB_RUN, out)

    def test_history_the_remote_already_has_is_not_scanned_again(self):
        self.commit('a.txt', f'log at {BOB_RUN}\n', 'add a')
        self.commit('a.txt', 'log at <somewhere>\n', 'scrub a')
        self.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
        self.commit('b.txt', 'b\n', 'add b')
        rc, out = self.privacy()
        self.assertEqual(rc, 0, out)

    def test_the_holes_are_closed(self):
        for text in ('mail Bob' + '@corp.COM\n',                                 # a TLD in capitals
                     '{"home": "' + USERS.replace('/', '\\/') + 'bob\\/x"}\n',      # JSON-escaped path
                     f'by {NOREPLY} in {BOB_RUN}\n',                              # an allowed address on the line
                     'the zanzibar-secret again\n'):                              # a private pattern in another case
            with self.subTest(text=text):
                self.git('reset', '-q', '--hard', 'refs/remotes/origin/main')
                self.commit('a.txt', text, 'add a')
                rc, out = self.privacy()
                self.assertEqual(rc, 1, out)

    def test_a_commit_message_is_scanned_with_the_generic_patterns(self):
        self.commit('a.txt', 'a\n', f'fix the run under {BOB_RUN}')
        rc, out = self.privacy()
        self.assertEqual(rc, 1)
        self.assertIn('commit metadata/messages', out)

    def test_an_author_address_that_is_not_noreply_fails(self):
        self.commit('a.txt', 'a\n', 'add a', email=BOB_MAIL)
        rc, out = self.privacy()
        self.assertEqual(rc, 1)
        self.assertIn('not a GitHub noreply address', out)


if __name__ == '__main__':
    unittest.main()
