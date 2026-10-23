"""A system prompt in front before a run starts (guest side).

The daemon stops every action while a hard-denied app is frontmost (hard_denied_frontmost), by design. When that
app is a system prompt that came up by itself (UserNotificationCenter: a consent prompt, "background item added",
a disk not ejected; an authentication or update prompt), nothing the run measures means anything: it is an
environment failure, never the model's or the daemon's. Cloned bases showed one at boot about 1 boot in 5
(2026-10-10). Checked only before anything acts, so it cannot hide something a model or the daemon brought up;
terminals and other hard-denied apps are not on this list for the same reason.
"""
from __future__ import annotations   # macOS's own python3 is 3.9: no `str | None` at runtime

import subprocess

SYSTEM_PROMPTS = {
    'com.apple.usernotificationcenter', 'com.apple.securityagent', 'com.apple.localauthentication.uiagent',
    'com.apple.loginwindow', 'com.apple.softwareupdate', 'com.apple.installer',
}


def frontmost_bundle() -> str | None:
    """The frontmost app's bundle ID (lowercased), from LaunchServices; no permission needed. None if unknown."""
    try:
        asn = subprocess.run(['lsappinfo', 'front'], capture_output=True, text=True, timeout=5).stdout.strip()
        out = subprocess.run(['lsappinfo', 'info', '-only', 'bundleid', asn], capture_output=True, text=True,
                             timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.split('=', 1)[1].strip().strip('"').lower() if '=' in out else None


def system_prompt_in_front() -> str | None:
    """The bundle ID of a system prompt that is frontmost, or None."""
    front = frontmost_bundle()
    return front if front in SYSTEM_PROMPTS else None
