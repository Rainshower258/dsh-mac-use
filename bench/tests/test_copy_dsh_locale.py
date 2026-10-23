"""scripts/copy_dsh_locale.py: dsh's language reaches the cu-desktop home once, without PyYAML (checked with it here)."""
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import copy_dsh_locale as c  # noqa: E402

DAILY = 'ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\nlocale:\n  preference: zh\n'   # as dsh writes it (1a VM)
CU = 'agent-presets:\n  - id: cu-desktop\nui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\n'


class CopyLocaleTest(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp())
        self.src, self.dst = self.d / 'daily.yaml', self.d / 'cu.yaml'

    def run_copy(self, src, dst):
        self.src.write_text(src)
        self.dst.write_text(dst)
        msg = c.copy(self.src, self.dst)
        return msg, self.dst.read_text()

    def test_copied_once_and_the_rest_kept(self):
        msg, out = self.run_copy(DAILY, CU)
        self.assertIn('copied', msg)
        doc = yaml.safe_load(out)
        self.assertEqual(doc['locale'], {'preference': 'zh'})
        self.assertEqual(doc['agent-presets'], [{'id': 'cu-desktop'}])
        self.assertTrue(out.startswith(CU))
        self.assertIn('already has its own', c.copy(self.src, self.dst), 'a second run changes nothing')
        self.assertEqual(self.dst.read_text(), out)

    def test_cu_desktops_own_choice_is_left_alone(self):
        msg, out = self.run_copy(DAILY, CU + 'locale:\n  preference: en\n')
        self.assertIn('already has its own', msg)
        self.assertEqual(yaml.safe_load(out)['locale'], {'preference': 'en'})

    def test_nothing_set_or_malformed_copies_nothing(self):
        for daily in ('ui-onboarding:\n  x: 1\n', 'locale: {}\n', 'locale:\n  preference: "zh; rm -rf"\n', ''):
            msg, out = self.run_copy(daily, CU)
            self.assertEqual(out, CU, repr(daily))
            self.assertIn("follows the system's", msg)

    def test_quoted_values_and_a_missing_final_newline(self):
        msg, out = self.run_copy("locale:\n  preference: 'en'\n", CU.rstrip('\n'))
        self.assertEqual(yaml.safe_load(out)['locale'], {'preference': 'en'})
        self.assertEqual(yaml.safe_load(out)['ui-onboarding'], {'welcomeNoticeVersion': '2026-08-13.1'})

    def test_missing_files(self):
        self.assertIn('missing', c.copy(self.d / 'none.yaml', self.dst))


if __name__ == '__main__':
    unittest.main()


class CopyLocaleFromProfilePatchTest(unittest.TestCase):
    """dsh 0.2.x keeps the language as a row of the profile's cordis.patch.yml once settings.yaml was imported."""

    def setUp(self):
        self.d = Path(tempfile.mkdtemp())
        self.dst = self.d / 'cu.yaml'
        self.dst.write_text(CU)

    def test_read_from_the_newest_patch_that_sets_it(self):
        old, new = self.d / 'web.yml', self.d / 'desktop.yml'
        old.write_text('- id: locale\n  name: "@deepseek-ai/dsh-client-locale"\n  config:\n    preference: en\n')
        new.write_text('- id: tool-todo\n  disabled: true\n- id: locale\n  config:\n    preference: zh-CN\n- id: ui-theme\n  config:\n    preference: dark\n')
        import os
        os.utime(old, (1, 1))
        msg = c.copy(self.d / 'gone.yaml', self.dst, [old, new])
        self.assertIn('zh-CN', msg)
        self.assertEqual(yaml.safe_load(self.dst.read_text())['locale'], {'preference': 'zh-CN'})

    def test_another_rows_preference_is_not_the_language(self):
        p = self.d / 'p.yml'
        p.write_text('- id: ui-theme\n  config:\n    preference: dark\n')
        self.assertIn('not set', c.copy(self.d / 'gone.yaml', self.dst, [p]))
        self.assertNotIn('locale', self.dst.read_text())

