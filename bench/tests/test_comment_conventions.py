"""CONTRIBUTING.md "Comments and documentation", the mechanical part: every tracked text file is read (data and
generated files aside) for references to notes outside the repository, internal milestone codes and decisions
attributed to a person. What it cannot judge (whether a comment says what was decided) is left to review.
"""
import re
import subprocess
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# Data, generated output, upstream history and the two files that name the patterns themselves.
SKIP = re.compile(r'\.(json|jsonl|png|jpg|nvr|svg|patch)$|^legacy/patches/|^bench/results/r5-|^bench/results/offline/'
                  r'|^CONTRIBUTING\.md$|^bench/tests/test_comment_conventions\.py$')

RULES = [
    # A § after a file of this repository (docs/desktop.md §2.4, r5-tables.md §3) or "see §1" inside that file is fine.
    ('a note outside the repository',
     re.compile(r'\bPLAN\b|PLAN-|阶段[0-9一二三四五六七八九]|交接|(?<!\.md )(?<!\.md` )(?<!see )§\s?[0-9]')),
    # R5 is the benchmark round documented in bench/ (CONTRIBUTING.md rule 2); the other codes are not.
    ('a milestone code', re.compile(r'(?<![\w./-])(R[1-46]|P[1-5]|C[1-6])(?![\w-])')),
    ('a review round or stage', re.compile(r'\b(VM )?round [0-9]+[a-z]?\b|\b(stage|batch) [0-9]+[a-z]?\b|第[一二三四五六七八九十0-9]+轮'
                                           r'|\bC-[AB][0-9]\b', re.I)),
    ('a decision attributed to a person',
     re.compile(r"the maintainer[,:]? \(?20\d\d-|(?i:confirmed|decided|asked|approved|chosen) by the maintainer"
                r"|the maintainer's (review|decision|Mac)|维护者[，,：:]\s?20\d\d")),
]


def tracked_text_files():
    out = subprocess.run(['git', '-C', str(REPO), 'ls-files'], check=True, capture_output=True, text=True).stdout
    for name in out.splitlines():
        if SKIP.search(name):
            continue
        path = REPO / name
        try:
            yield name, path.read_text()
        except (UnicodeDecodeError, IsADirectoryError, FileNotFoundError):
            continue


class CommentConventions(unittest.TestCase):
    def test_no_outside_references_codes_or_attributions(self):
        hits = []
        for name, text in tracked_text_files():
            for n, line in enumerate(text.splitlines(), 1):
                for what, rule in RULES:
                    m = rule.search(line)
                    if m:
                        hits.append(f'{name}:{n}: {what}: {m.group(0)!r}: {line.strip()[:120]}')
        self.assertEqual(hits, [], '\n' + '\n'.join(hits[:80]) + (f'\n... {len(hits) - 80} more' if len(hits) > 80 else ''))

    def test_the_rules_catch_what_they_are_for(self):
        caught = ['see PLAN-v2 §6', 'every §5.3 check', '(VM round 17, 2026-10-17)', 'act.type paste (P4)', 'as of R1',
                  '第七轮', '(VM round 13b)', 'stage 3b', 'batch 2', 'contract C-A1', '(the maintainer, 2026-10-14)', 'Confirmed by the maintainer', '（维护者，2026-10-14）']
        passed = ['the R5 benchmark', 'key ⌘R', 'r5-tables.md', 'the maintainer grants it by hand', 'C1-like',
                  'p1 = 3', 'VM test, 2026-10-17', 'docs/desktop.md §2.4', '`r5-tables.md` §3', '(see §1)']
        for s in caught:
            self.assertTrue(any(r.search(s) for _, r in RULES), s)
        for s in passed:
            self.assertFalse(any(r.search(s) for _, r in RULES), s)


if __name__ == '__main__':
    unittest.main()
