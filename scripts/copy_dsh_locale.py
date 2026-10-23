#!/usr/bin/env python3
"""Carry dsh's language from the everyday dsh home to cu-std's own one (scripts/install-cu-std.sh).

A profile in its own dsh home does not see the language the person set in dsh (settings.yaml `locale.preference`,
written by dsh's web settings): its pages came up in the browser's language and the plugin, which answers and asks in
dsh's language, fell back to the system's (1a, 2026-10-10). Copied once: an existing `locale` section in the other
home's settings is the person's own choice there and is left alone. No PyYAML (macOS's python3 lacks it):
dsh writes the section as `locale:` with an indented `preference:` line.
dsh 0.2.x renames settings.yaml at a profile's start and keeps the language as a row of that profile's
cordis.patch.yml (`- id: locale` … `config:` … `preference:`): the everyday home's profile patches are read too,
the most recently changed one that sets it first, when its settings.yaml does not (2026-10-17, 0.2.1).
    copy_dsh_locale.py <everyday settings.yaml> <cu-std settings.yaml> [<everyday profile patch>…]
"""
from __future__ import annotations   # macOS's own python3 is 3.9: no `str | None` at runtime

import re
import sys
from pathlib import Path

TAG = re.compile(r'^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$')   # dsh-client-locale's LOCALE_ID_PATTERN


def preference(text: str) -> str | None:
    """The locale.preference in a dsh settings document, if it is set and well-formed."""
    section = re.search(r'^locale:[ \t]*\n((?:[ \t]+.*(?:\n|$))*)', text, re.M)
    m = section and re.search(r'^[ \t]+preference:[ \t]*["\']?([^"\'\s#]*)', section.group(1), re.M)
    tag = m.group(1) if m else ''
    return tag if TAG.match(tag) else None


def patch_preference(text: str) -> str | None:
    """The `preference` in the config of a `- id: locale` row of a dsh 0.2.x profile patch, if well-formed."""
    tag = ''
    for row in re.split(r'^(?=- )', text, flags=re.M):
        if not re.match(r'- id: locale[ \t]*$', row, re.M):
            continue
        config = re.search(r'^  config:[ \t]*\n((?:    .*(?:\n|$))*)', row, re.M)
        m = config and re.search(r'^    preference:[ \t]*["\']?([^"\'\s#]*)', config.group(1), re.M)
        tag = m.group(1) if m else tag
    return tag if TAG.match(tag) else None


def copy(src: Path, dst: Path, patches: list[Path] | None = None) -> str:
    patches = [p for p in (patches or []) if p.exists()]
    if not dst.exists() or (not src.exists() and not patches):
        return 'language: nothing to copy (a settings file is missing)'
    if re.search(r'^locale:', dst.read_text(), re.M):
        return 'language: this home already has its own setting, left as it is'
    tag = preference(src.read_text()) if src.exists() else None
    for p in sorted(patches, key=lambda p: p.stat().st_mtime, reverse=True):
        tag = tag or patch_preference(p.read_text())
    if tag is None:
        return "language: not set in dsh, so this home follows the system's"
    text = dst.read_text()
    dst.write_text(text + ('' if text.endswith('\n') or text == '' else '\n') + f'locale:\n  preference: {tag}\n')
    return f"language: copied dsh's setting ({tag}) to {dst}"


if __name__ == '__main__':
    print(copy(Path(sys.argv[1]), Path(sys.argv[2]), [Path(p) for p in sys.argv[3:]]))
