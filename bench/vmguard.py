"""Fail closed outside the bench VM.

Every bench entry point that drives the GUI or runs a model calls require_vm() first. On 2026-09-29 a real model
with bash ran on the host once, because a settings file did not load and dsh fell back to its defaults
(docs/incidents/2026-09-29-host-model-run.md). The fix is not to rely on configuration loading: outside a VM these
scripts do not start at all.

The marker is the OS itself, not a file that could be copied onto the host: macOS guests on Apple silicon report
kern.hv_vmm_present=1 and a VirtualMac hw.model (checked in the cu-base clone and on the host).

The only exemption is the host QQ measurement (experiments/ax_manual_accessibility.py): no model, no dsh, no bash,
observe only, and the grant is revoked right after (an exemption made for R5). It does not call this module.
"""
from __future__ import annotations

import subprocess
import sys


def _sysctl(name: str) -> str:
    try:
        return subprocess.run(['sysctl', '-n', name], capture_output=True, text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ''


def vm_markers() -> dict:
    return {'kern.hv_vmm_present': _sysctl('kern.hv_vmm_present'), 'hw.model': _sysctl('hw.model')}


def in_vm(markers: dict | None = None) -> bool:
    m = vm_markers() if markers is None else markers
    return m.get('kern.hv_vmm_present') == '1' and m.get('hw.model', '').startswith('VirtualMac')


def require_vm(what: str) -> dict:
    """Exit unless running in the bench VM. Returns the markers (runners record them)."""
    m = vm_markers()
    if not in_vm(m):
        sys.exit(f'{what}: refusing to run outside the bench VM ({m}). E2E runs and experiments only run in a '
                 f'cu-base clone: bench/vm/run_vm.sh, bench/experiments/run_vm_experiment.sh, bench/geometry/run_vm.sh')
    return m
