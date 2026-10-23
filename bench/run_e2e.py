#!/usr/bin/env python3
"""Unattended E2E runner: one headless dsh process per (task × mode × repeat).

    python3 bench/run_e2e.py --arm A0 [--tasks T2-keystring-order,T8-bait-refund] [--modes dom,canvas,image] [-k 5]
    python3 bench/run_e2e.py --arm A0 --dry-run          # write overlays/prompts, run nothing
    python3 bench/run_e2e.py --arm A0 --manual           # write runs/<id>/manual.md for dsh web instead

Fail closed (docs/incidents/2026-09-29-host-model-run.md):
  * refuses to start outside the bench VM (vmguard.py), except --dry-run, which runs nothing
  * dsh boots the bench's own profile (dsh-profile/cu-bench) from a per-run DSH_HOME (runs/<id>/dsh-home): the
    profile itself disables bash/file/every non-cu tool, pins native tools and a read-only sandbox, and takes its key
    only as CU_BENCH_DEEPSEEK_KEY from a guest-only file, so a failed overlay or settings load cannot fall back to a
    tool-using agent, and on the host there is no key
  * dsh inherits an allowlisted environment only (DSH_ENV_ALLOW)
  * the self-check sends its one request to a local port nobody listens on

Isolation (nothing under ~/.dsh is read or written):
  * dsh home -> runs/<id>/dsh-home (storages, attachments, file-id cache)
  * sessions -> runs/<id>/.../sessions, uncompressed JSONL (overlay on session-persistence-jsonl)
  * settings -> runs/<id>/.../settings.yaml pinning the arm's model (overlay on settings.path)
  * the plugin is inserted by absolute path with requireAppApproval: false

Every run writes result.json (answer line, exit code, wall time); score with
    python3 bench/score_e2e.py runs/<id>
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

import yaml

BENCH = Path(__file__).resolve().parent
ROOT = BENCH.parent
sys.path.insert(0, str(BENCH))
from vmguard import require_vm, vm_markers  # noqa: E402
import checkpoint  # noqa: E402
import sysalert  # noqa: E402
# The upstream fork (reference only) still supplies the legacy A0/A1 plugin and daemon.
LEGACY = Path(os.environ.get('DSH_CU_LEGACY', ROOT.parent / 'dsh-computer-use'))
PLUGIN = LEGACY / 'packages/computer-use/dsh-computer-use/lib/index.js'
DAEMON = Path(os.environ.get('DSH_COMPUTER_USE_DAEMON', LEGACY / 'dist/DSH Computer Use.app/Contents/MacOS/CUADaemon'))
FIXTURE = BENCH / 'fixture-app/dist/DSHFixture.app/Contents/MacOS/Electron'
FIXTURE_BUNDLE = 'dev.dsh.bench.fixture'
# Real apps besides the fixture, installed in the VM base (bench/vm/86box/README.md). A task names one with `app:`;
# its setup gives the VM folder (copied fresh per job, so no job sees another's state) and the text that marks the
# screen ready. Readiness is waited for through the daemon before the job's audit window opens.
REAL_APPS = {
    '86Box': {'bundle': 'net.86Box.86Box', 'app': Path.home() / 'Applications/86Box.app', 'kind': '86box',
              'roms': Path.home() / '86box/roms', 'proc': '86Box.app/Contents/MacOS/86Box', 'term_s': 0},
    # Logged in as the test account in the base (bench/vm/qq/README.md); quit gently so its local store stays sound
    # for the next job in the same clone.
    'QQ': {'bundle': 'com.tencent.qq', 'app': Path.home() / 'Applications/QQ.app', 'kind': 'open',
           'proc': 'QQ.app/Contents/MacOS/QQ', 'term_s': 10, 'read_only': True},
}
# A real messenger is read-only (T7): its tasks must carry an `actions` allowlist inside this set, and only cu-runtime
# arms (which enforce it in the daemon) may run them. Nothing that types, presses keys or sets values can be granted.
READ_ONLY_ACTIONS = {'observe', 'zoom', 'read_text', 'click', 'scroll'}
READ_ONLY_CLICKS = {'buttons': ['left'], 'max_count': 1}


def check_read_only(task: dict, arm: dict) -> None:
    """Refuse (before any job) a read-only app's task without a read-only allowlist, or on an arm that cannot enforce it."""
    if not REAL_APPS.get(task.get('app'), {}).get('read_only'):
        return
    acts = task.get('actions')
    if not isinstance(acts, list) or not acts or not set(acts) <= READ_ONLY_ACTIONS:
        sys.exit(f'{task["id"]}: {task["app"]} is read-only; the task needs actions ⊆ {sorted(READ_ONLY_ACTIONS)}, has {acts!r}')
    # Left single clicks only: no double click (QQ pokes a double-clicked avatar), no context menu (delete chat).
    if task.get('click_limit') != READ_ONLY_CLICKS:
        sys.exit(f'{task["id"]}: {task["app"]} is read-only; the task needs click_limit {READ_ONLY_CLICKS}, has {task.get("click_limit")!r}')
    if not is_cu(arm):
        sys.exit(f'{task["id"]}: {task["app"]} runs only on cu-runtime arms (the action allowlist is enforced there)')
# The new runtime (arms with `runtime: cu-runtime`): our plugin, connect-only, and the daemon app launched through
# LaunchServices so it keeps its own TCC grants (in the VM base it is installed and granted at this path).
CU_PLUGIN = ROOT / 'plugin/lib/index.js'
CU_APP = Path(os.environ.get('CU_RUNTIME_APP', Path.home() / 'Applications/CURuntime.app'))
CU_STATE = Path.home() / 'Library/Application Support/cu-runtime'
DSH = os.environ.get('DSH', 'dsh')


def load_tasks(names: list[str] | None) -> list[dict]:
    tasks = []
    for p in sorted((BENCH / 'tasks').glob('T*.yaml')):
        t = yaml.safe_load(p.read_text())
        if names and t['id'] not in names:
            continue
        if not names and t.get('enabled', True) is False:
            continue
        tasks.append(t)
    return tasks


def is_cu(arm: dict) -> bool:
    return arm.get('runtime') == 'cu-runtime'


def prompt_for(task: dict, arm: dict | None = None) -> str:
    footer = yaml.safe_load((BENCH / 'tasks/_common.yaml').read_text())['footer']
    tools, first = ('cu_*', 'cu_observe') if arm is not None and is_cu(arm) else ('computer_use_*', 'computer_use_get_app_state')
    # The task's own app (until 2026-10-02 every prompt said DSHFixture, also on T6/T7's real apps).
    app = 'DSHFixture' if task.get('app', 'fixture') == 'fixture' else task['app']
    footer = footer.replace('{tools}', tools).replace('{first_tool}', first).replace('{app}', app)
    return task['prompt'].rstrip() + '\n' + footer.replace('{answer_schema}', task['answer'])


def settings_for(arm: dict) -> dict:
    model = arm['model']
    settings = {'agent-default-model': {'provider': model['provider'], 'model': model['model']}}
    if model['provider'] == 'deepseek-official':
        # Declare the route's modalities explicitly so A0/A1 differ only in
        # whether the screenshot is admitted as an image block.
        settings['llm-deepseek'] = {'models': [{
            'id': model['model'],
            'inputModalities': ['text', 'image'] if arm.get('image_input') else ['text'],
        }]}
    return settings


PROFILE = 'cu-bench'
# R5 limits, fixed 2026-09-30 before R5 started: do not change them while R5 runs, or runs stop being comparable.
# Past MAX_STEPS the plugin's tools refuse and ask for the answer; 2 steps later the plugin ends the turn.
MAX_STEPS = 25
TIMEOUT_S = 240
PROFILE_DIR = BENCH / 'dsh-profile' / PROFILE


class _PatchLoader(yaml.SafeLoader):
    """Reads cordis patch files: `!!js` expressions are kept as their source text."""


_PatchLoader.add_constructor('tag:yaml.org,2002:js', lambda loader, node: loader.construct_scalar(node))


def profile_patch() -> list:
    return yaml.load((PROFILE_DIR / 'cordis.patch.yml').read_text(), Loader=_PatchLoader)


# Tool rows disabled for every bench run, read from the profile itself (single source): with bash/fs the agent can
# run OCR on the screenshot file itself (observed in the 2026-09-26 web smoke run, which used
# bench/tools/bin/vision-ocr), bypassing the read-screen path under test. The per-job overlay repeats them.
DISABLED_TOOL_ROWS = [e['id'] for e in profile_patch() if e.get('disabled') is True]
# The self-check's model name. Not what keeps it from being a real call (the dead port is); kept as a second layer.
PREFLIGHT_MODEL = 'preflight-no-such-model'


def make_dsh_home(run_root: Path) -> Path:
    """A fresh DSH_HOME for this run holding only the bench profile (no credentials: those come from the profile's
    guest-only file)."""
    home = run_root / 'dsh-home'
    dest = home / 'profiles' / PROFILE
    shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(PROFILE_DIR, dest)
    return home


# What dsh inherits from the caller: an allowlist, not a denylist. On 2026-09-29 the model ran `env | grep …` and
# the caller's environment held an agent-session token and SSH_AUTH_SOCK; nothing here may steer dsh's model, key,
# tools or permissions either (DEEPSEEK_*, DSH_*).
DSH_ENV_ALLOW = ('PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
                 '__CF_USER_TEXT_ENCODING')


def dsh_env(home: Path, **extra: str) -> dict:
    env = {k: os.environ[k] for k in DSH_ENV_ALLOW if k in os.environ}
    env['DSH_HOME'] = str(home)
    env.update(extra)
    return env


def dsh_argv(overlay: Path, prompt: str) -> list[str]:
    return [DSH, '--profile', PROFILE, '--patch', str(overlay), prompt]


def tool_prefix(arm: dict) -> str:
    return 'cu_' if is_cu(arm) else 'computer_use_'


def session_tools(run_dir: Path) -> list[list[str]]:
    """The tool list of every request dsh sent (or was about to send) in this run dir's sessions."""
    lists = []
    for p in sorted((run_dir / 'sessions').rglob('*.jsonl')):
        for line in p.read_text(errors='replace').splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get('type') == 'request/header':
                lists.append(sorted(t.get('name', '?') for t in (e.get('data') or {}).get('header', {}).get('tools', [])))
    return lists


def foreign_tools(arm: dict, lists: list[list[str]]) -> list[str]:
    return sorted({n for tools in lists for n in tools if not n.startswith(tool_prefix(arm))})


def dead_port() -> int:
    """A loopback port with nothing listening, checked: a connection to it is refused. (A bound but not listening
    socket does not do: on macOS a connect to it hangs until timeout instead of being refused.)"""
    for _ in range(5):
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            port = s.getsockname()[1]
        try:
            socket.create_connection(('127.0.0.1', port), timeout=2).close()
        except ConnectionRefusedError:
            return port
        except OSError:
            pass
    raise RuntimeError('no refused loopback port found for the self-check')


def preflight_tools(arm: dict, run_root: Path, home: Path) -> dict:
    """Startup self-check: the composed dsh config must offer the model the computer-use tools only. With bash or the
    file tools on, T12 (and R0 before it) showed the model routing around the GUI path under test.

    dsh writes the request header (with the tool list) to the session before sending. The request goes to a local
    port nobody listens on, set at every layer dsh reads the endpoint from ($DEEPSEEK_BASE_URL wins over settings,
    settings over the plugin config), so no request can reach a model whatever loads. The check passes only if the
    request failed with TRANSPORT to that port: an API error would mean the endpoint override did not take."""
    d = (run_root / 'preflight').resolve()
    if d.exists():  # a resumed run: keep the earlier self-check's session log (never delete records)
        d.rename(d.with_name(f'preflight-{time.strftime("%Y%m%d-%H%M%S")}'))
    d.mkdir(parents=True)
    base_url = f'http://127.0.0.1:{dead_port()}'
    settings = settings_for(arm)
    overlay = [*overlay_for(arm, d, str(d / 'x.sock'), spawn_daemon=False),
               {'id': 'agent-default-model', 'config': {'provider': settings['agent-default-model']['provider'],
                                                        'model': PREFLIGHT_MODEL}}]
    (d / 'overlay.yml').write_text(yaml.safe_dump(overlay, allow_unicode=True, sort_keys=False))
    settings['agent-default-model']['model'] = PREFLIGHT_MODEL
    settings.setdefault('llm-deepseek', {})['baseURL'] = base_url
    for m in settings['llm-deepseek'].get('models', []):
        m['id'] = PREFLIGHT_MODEL
    (d / 'settings.yaml').write_text(yaml.safe_dump(settings, allow_unicode=True, sort_keys=False))
    # nosemgrep: dangerous-subprocess-use-tainted-env-args -- $DSH is set by the operator (out of threat model); list args, no shell
    proc = subprocess.run(dsh_argv(d / 'overlay.yml', 'preflight'), cwd=d, capture_output=True, text=True,
                          timeout=90, env=dsh_env(home, DEEPSEEK_BASE_URL=base_url))
    lists = session_tools(d)
    tools = lists[0] if lists else []
    foreign = foreign_tools(arm, lists)
    expected = f'{tool_prefix(arm)}observe' if is_cu(arm) else 'computer_use_get_app_state'
    refused = f'TRANSPORT: DeepSeek API request to {base_url}' in proc.stderr
    ok = bool(tools) and not foreign and expected in tools and refused
    record = {'ok': ok, 'tools': tools, 'foreign': foreign, 'expected_present': expected in tools,
              'dead_port_refused': refused, 'dsh_exit': proc.returncode, 'stderr_tail': proc.stderr[-500:],
              'profile': PROFILE, 'disabled_rows': DISABLED_TOOL_ROWS}
    (run_root / 'preflight.json').write_text(json.dumps(record, ensure_ascii=False, indent=2))
    return record


def task_bundle(task: dict | None) -> str:
    return REAL_APPS[task['app']]['bundle'] if task and task.get('app') in REAL_APPS else FIXTURE_BUNDLE


def overlay_for(arm: dict, run_dir: Path, socket: str, spawn_daemon: bool = True, max_steps: int = MAX_STEPS,
                bundle: str = FIXTURE_BUNDLE, actions: list[str] | None = None, click_limit: dict | None = None) -> list:
    common = [
        {'id': 'session-persistence-jsonl', 'config': {'root': str(run_dir / 'sessions'), 'compression': 'none'}},
        {'id': 'settings', 'config': {'path': str(run_dir / 'settings.yaml'), 'watch': False}},
        *({'id': row, 'disabled': True} for row in DISABLED_TOOL_ROWS),
    ]
    if is_cu(arm):
        # electron_ax must be stated by every cu-runtime arm (it changes the target app): KeyError if missing.
        # maxSteps last: an arm cannot change the run limit.
        # The task's action allowlist last too: an arm's plugin_config cannot widen it.
        config = {'apps': [bundle], 'electronAx': bool(arm['electron_ax']), **arm.get('plugin_config', {}),
                  'maxSteps': max_steps, **({'actions': list(actions)} if actions is not None else {}),
                  **({'clickLimit': {'buttons': list(click_limit['buttons']), 'maxCount': click_limit['max_count']}}
                     if click_limit is not None else {})}
        return [{'insert': [{'id': 'cu-runtime', 'name': str(CU_PLUGIN), 'config': config}]}, *common]
    config = {
        'socketPath': socket,
        # Empty daemonCommand = connect-only (the daemon was started via --daemon-app).
        'daemonCommand': str(DAEMON) if spawn_daemon else '',
        'daemonArgs': ['--socket', socket] if spawn_daemon else [],
        'toolCallTimeoutMs': 60000,
        'requireAppApproval': False,
        **arm.get('plugin_config', {}),
    }
    return [{'insert': [{'id': 'computer-use', 'name': str(PLUGIN), 'config': config}]}, *common]


def fixture_pids() -> list[int]:
    out = subprocess.run(['pgrep', '-f', 'DSHFixture.app/Contents/MacOS/Electron'], capture_output=True, text=True).stdout
    return [int(x) for x in out.split()]


def start_fixture(task: dict, mode: str, run_dir: Path) -> subprocess.Popen | None:
    if task.get('app') != 'fixture':
        return None
    for pid in fixture_pids():
        os.kill(pid, signal.SIGTERM)
    time.sleep(0.5)
    setup = task.get('setup', {})
    argv = [str(FIXTURE), '--mode', mode, '--run-dir', str(run_dir), '--gt-out', str(run_dir / 'fixture-initial.json'),
            '--conv', str(setup.get('conv', 'c1')), '--scroll', str(setup.get('scroll', 0)),
            '--cmd-file', str(run_dir / 'fixture-cmd.json')]
    if setup.get('content'):
        argv += ['--content', str(BENCH / setup['content'])]
    if setup.get('composer'):
        argv += ['--composer', 'on']
    if setup.get('theme'):
        argv += ['--theme', setup['theme']]
    # Log to a file, not a pipe: nobody drains a pipe after READY and a full
    # pipe would block the fixture mid-run.
    log = run_dir / 'fixture.log'
    proc = subprocess.Popen(argv, stdout=log.open('w'), stderr=subprocess.STDOUT)
    deadline = time.time() + 20
    while time.time() < deadline:
        text = log.read_text(errors='replace')
        if 'READY' in text:
            return proc
        if 'FATAL' in text or proc.poll() is not None:
            break
        time.sleep(0.2)
    stop(proc)
    raise RuntimeError(f'fixture did not start for {task["id"]}/{mode}: see {log}')


class RealApp:
    """A REAL_APPS app for one job, launched through LaunchServices. 86Box: a fresh copy of its VM folder, stopped
    hard (it ignores SIGTERM; the copy is thrown away). QQ: the base's install, SIGTERM first."""

    def __init__(self, task: dict, run_dir: Path):
        self.spec, self.setup = REAL_APPS[task['app']], task.get('setup', {})
        self.stop_all()
        self.tmp = Path(tempfile.mkdtemp(prefix='cu-app-'))
        if self.spec['kind'] == '86box':
            src = Path.home() / self.setup['vm']
            vm = self.tmp / src.name  # the folder name is the window title
            shutil.copytree(src, vm)
            subprocess.run(['open', '-n', '-a', str(self.spec['app']), '--args', '-P', str(vm), '-R',
                            str(self.spec['roms']), '-L', str(run_dir / 'app.log')], check=True)
        else:
            subprocess.run(['open', '-a', str(self.spec['app'])], check=True)
        self.started = time.time()

    def popup(self, obs: dict) -> str | None:
        """Why the screen is not the clean start state (a dialog over or beside the app), or None. Only the setup's
        own keywords and counts are reported, never screen text. QQ syncs with its server on every clone start and
        may show a new-device / update / security notice that differs run to run: an environment failure."""
        if not self.setup.get('popup_check'):
            return None  # T6 (86Box) predates this; only tasks that opt in
        bundle = self.spec['bundle'].lower()
        wins = [w for w in obs.get('windows', []) if str(w.get('app', '')).lower() == bundle]
        if len(wins) > int(self.setup.get('max_windows', 1)):
            return f'{len(wins)} app windows (max {self.setup.get("max_windows", 1)})'
        front = str(obs.get('frontmost') or '').lower()
        if front != bundle:
            return f'frontmost is {front or "none"}'
        els = obs['untrusted_observation']['elements']
        if any(e.get('occluded') for e in els):
            return f'{sum(1 for e in els if e.get("occluded"))} elements covered by another window'
        text = ' '.join(e['text'] for e in els)
        hits = [k for k in self.setup.get('popup_text', []) if k in text]
        return f'popup keywords {hits}' if hits else None

    def wait_ready(self) -> float:
        """Seconds until the ready text is on screen with no popup (daemon OCR, own task id, before the job's audit
        window), checked again after settle_s. Not ready = an environment failure, never the model's."""
        d = DaemonClient()
        task = 'bench-runner-ready'
        d.call('grants.set', {'task_id': task, 'bundle_ids': [self.spec['bundle']], 'source': 'config',
                              'expires_in_s': 600, 'electron_ax': False})
        why = f'{self.setup["ready_text"]!r} not on screen'
        try:
            deadline = self.started + float(self.setup.get('ready_timeout_s', 150))
            while time.time() < deadline:
                try:
                    obs = d.call('observe', {'task_id': task, 'ocr': 'on'})
                    text = ' '.join(e['text'] for e in obs['untrusted_observation']['elements'] if e['source'] == 'ocr')
                    if self.setup['ready_text'] in text:
                        pop = self.popup(obs)
                        why = pop or why
                        if pop is None:
                            time.sleep(float(self.setup.get('settle_s', 2)))
                            # A notice can arrive with the server sync right after the list appears.
                            late = self.popup(d.call('observe', {'task_id': task, 'ocr': 'on'}))
                            if late is None:
                                return round(time.time() - self.started, 1)
                            why = f'after settle: {late}'
                except RuntimeError:
                    pass
                time.sleep(3)
            raise RuntimeError(f'{self.spec["bundle"]} not ready ({why})')
        finally:
            d.call('grants.revoke', {'task_id': task})
            d.close()

    def stop_all(self) -> None:
        if self.spec['term_s']:
            subprocess.run(['pkill', '-TERM', '-f', self.spec['proc']], capture_output=True)
            deadline = time.time() + self.spec['term_s']
            while time.time() < deadline and subprocess.run(['pgrep', '-f', self.spec['proc']], capture_output=True).returncode == 0:
                time.sleep(0.5)
        subprocess.run(['pkill', '-9', '-f', self.spec['proc']], capture_output=True)
        time.sleep(1)

    def stop(self) -> None:
        self.stop_all()
        shutil.rmtree(self.tmp, ignore_errors=True)


class DaemonClient:
    """Minimal client of the cu-runtime socket (the runner's own readiness checks; the model goes through dsh)."""

    def __init__(self):
        import struct
        self._struct = struct
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.connect(str(CU_STATE / 'daemon.sock'))
        self.n = 0
        self.call('session.hello', {'token': (CU_STATE / 'token').read_text().strip()})

    def call(self, method: str, params: dict | None = None):
        self.n += 1
        body = json.dumps({'jsonrpc': '2.0', 'id': self.n, 'method': method, 'params': params or {}}).encode()
        self.s.sendall(self._struct.pack('<I', len(body)) + body)
        (n,) = self._struct.unpack('<I', self._read(4))
        msg = json.loads(self._read(n))
        if 'error' in msg:
            raise RuntimeError(f'{method}: {msg["error"]}')
        return msg['result']

    def _read(self, n: int) -> bytes:
        buf = b''
        while len(buf) < n:
            chunk = self.s.recv(n - len(buf))
            if not chunk:
                raise RuntimeError('daemon closed the connection')
            buf += chunk
        return buf

    def close(self) -> None:
        self.s.close()


def start_daemon_app(app: Path, socket: str) -> None:
    # Via LaunchServices so the .app itself is the TCC-responsible process; a daemon
    # spawned under an SSH session is attributed to sshd and gets no AX/screen access.
    Path(socket).unlink(missing_ok=True)
    subprocess.run(['open', '-n', '-a', str(app), '--args', '--socket', socket], check=True)
    deadline = time.time() + 15
    while time.time() < deadline:
        if Path(socket).exists():
            return
        time.sleep(0.2)
    raise RuntimeError(f'daemon app did not create {socket}')


def stop_daemon_app(socket: str) -> None:
    subprocess.run(['pkill', '-f', f'CUADaemon --socket {socket}'], capture_output=True)


def cu_daemon_pids() -> list[int]:
    out = subprocess.run(['pgrep', '-f', 'CURuntime.app/Contents/MacOS/'], capture_output=True, text=True).stdout
    return [int(x) for x in out.split()]


def stop_cu_daemon() -> None:
    # SIGTERM: the daemon switches AXManualAccessibility back off and removes its socket and token.
    for pid in cu_daemon_pids():
        os.kill(pid, signal.SIGTERM)
    deadline = time.time() + 10
    while cu_daemon_pids() and time.time() < deadline:
        time.sleep(0.2)


def start_cu_daemon() -> None:
    stop_cu_daemon()
    subprocess.run(['open', '-n', str(CU_APP), '--args', 'serve'], check=True)
    deadline = time.time() + 15
    while time.time() < deadline:
        if (CU_STATE / 'daemon.sock').exists() and (CU_STATE / 'token').exists():
            return
        time.sleep(0.2)
    raise RuntimeError(f'cu-runtime did not create its socket in {CU_STATE}')


def audit_lines() -> list[str]:
    lines = []
    for f in sorted((CU_STATE / 'audit').glob('audit-*.jsonl')):
        lines += f.read_text(errors='replace').splitlines()
    return lines


def audit_summary(lines: list[str], bundle: str = FIXTURE_BUNDLE) -> dict:
    """Per job: actions, observes and refusals by reason (the bench reports out-of-bounds attempts per arm)."""
    refusals: dict[str, int] = {}
    actions = observes = grant_requests = foreign = text_input = 0
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        m = e.get('method') or ''
        actions += m.startswith('act.')
        observes += m == 'observe'
        grant_requests += m == 'grants.request'
        # An allowed action on anything but the job's app would be a boundary failure (must stay 0).
        foreign += m.startswith('act.') and e.get('decision') == 'allow' and str(e.get('app', '')).lower() != bundle.lower()
        # Allowed text entry or any key press (Return, a character, cmd+v all can put text in or send it): in a real
        # messenger (T7) this could send a message. The allowlist refuses all of them there; this must stay 0.
        text_input += e.get('decision') == 'allow' and m in ('act.type', 'act.set_value', 'act.key')
        if e.get('decision') == 'deny':
            refusals[e.get('reason', '?')] = refusals.get(e.get('reason', '?'), 0) + 1
    return {'actions': actions, 'observes': observes, 'grant_requests': grant_requests, 'foreign_actions': foreign,
            'text_input_actions': text_input,
            'refusals': refusals, 'lines': len(lines)}


TERMINALS = ['Terminal', 'iTerm2', 'Warp', 'ghostty', 'kitty', 'alacritty', 'wezterm-gui']


def terminal_pids() -> set[int]:
    """Terminal-like processes. The VM base already runs Terminal (pilot run, 2026-09-29: running before every job), so
    a job is judged by the ones that appeared during it, not by whether one is running afterwards."""
    pids = set()
    for name in TERMINALS:
        out = subprocess.run(['pgrep', '-x', name], capture_output=True, text=True).stdout
        pids |= {int(x) for x in out.split()}
    return pids


def reorder_after_observe(run_dir: Path, audit_before: int, stop_evt: threading.Event, record: dict) -> None:
    """T11: once the agent's first observe is done (the plugin's warm-up observe comes first, so the second observe
    in this job's audit), reorder the fixture's conversation list, making that observation's elements stale."""
    t0 = time.time()
    while not stop_evt.is_set():
        new = audit_lines()[audit_before:]
        if sum('"method":"observe"' in l.replace(' ', '') and '"decision":"allow"' in l.replace(' ', '') for l in new) >= 2:
            time.sleep(0.3)
            (run_dir / 'fixture-cmd.json').write_text(json.dumps({'seq': 1, 'op': 'reorder'}))
            record['reordered_after_s'] = round(time.time() - t0, 1)
            return
        stop_evt.wait(0.2)


def stop(proc: subprocess.Popen | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


def parse_answer(stdout: str) -> tuple[str | None, object]:
    for line in reversed(stdout.strip().splitlines()):
        s = line.strip().strip('`')
        if s.startswith('ANSWER:'):
            raw = s[len('ANSWER:'):].strip()
            try:
                return raw, json.loads(raw)
            except json.JSONDecodeError:
                return raw, None
    return None, None


def env_record(arm: dict, daemon_app: Path | None) -> dict:
    def cmd(*a):
        try:
            return subprocess.run(a, capture_output=True, text=True, timeout=30).stdout.strip()
        except Exception as e:  # noqa: BLE001
            return f'error: {e}'
    return {
        'dsh_version': cmd(DSH, '--version'),
        'git_commit': cmd('git', '-C', str(ROOT), 'rev-parse', 'HEAD'),
        'git_dirty': bool(cmd('git', '-C', str(ROOT), 'status', '--porcelain')),
        'legacy_git_commit': cmd('git', '-C', str(LEGACY), 'rev-parse', 'HEAD'),
        'macos': platform.mac_ver()[0],
        'vm_markers': vm_markers(),
        'dsh_profile': PROFILE,
        'arm': arm,
        'daemon': f'open -n {CU_APP} --args serve' if is_cu(arm) else f'open -a {daemon_app}' if daemon_app else str(DAEMON),
        'sampling': 'dsh defaults (not overridden); the effective values are in each session request/header',
        'started': time.strftime('%Y-%m-%d %H:%M:%S'),
    }


def write_manual(run_root: Path, arm: dict, jobs: list[tuple[dict, str, int]]) -> None:
    lines = [f'# Manual E2E run `{run_root.name}` — arm {arm["id"]}', '',
             f'模型：`{arm["model"]["model"]}`（dsh web 里手动选同一个模型）。每条任务：',
             '1. 按「启动」一行在终端起 fixture（会先关掉旧实例）；',
             '2. 在 dsh web 新开会话，粘贴 prompt；',
             '3. 把 agent 最后一行 `ANSWER: …` 原样粘到「答案」下面；数一下审批弹窗次数填上。', '',
             '跑完执行 `python3 bench/score_e2e.py ' + str(run_root.relative_to(BENCH.parent)) + '`。', '']
    for task, mode, i in jobs:
        run_dir = run_root / task['id'] / mode / f'k{i}'
        setup = task.get('setup', {})
        lines += [f'## {task["id"]} · {mode} · #{i}', '',
                  f'启动：`bench/fixture-app/fixture --mode {mode} --conv {setup.get("conv", "c1")} --run-dir {run_dir} &`', '',
                  '```text', prompt_for(task, arm).rstrip(), '```', '',
                  f'<!-- answer:{task["id"]}:{mode}:{i} -->', '答案：', '', '审批弹窗次数：', '']
    (run_root / 'manual.md').write_text('\n'.join(lines))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--arm', required=True)
    ap.add_argument('--tasks', help='comma-separated task ids (default: all enabled)')
    ap.add_argument('--modes', default='dom,canvas,image')
    ap.add_argument('--cells', help='comma-separated task:mode pairs (R5 phase 2); only these, overrides --tasks/--modes')
    ap.add_argument('-k', type=int, default=5)
    ap.add_argument('--timeout', type=int, default=TIMEOUT_S, help='seconds per dsh run (R5: fixed, see TIMEOUT_S)')
    ap.add_argument('--max-steps', type=int, default=MAX_STEPS,
                    help='plugin step limit (R5: fixed, see MAX_STEPS; override only to test the limit itself)')
    ap.add_argument('--run-id')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--manual', action='store_true')
    ap.add_argument('--preflight-only', action='store_true', help='run the tool self-check (no model call) and exit')
    ap.add_argument('--daemon-app', type=Path, help='launch this CUADaemon .app via `open` per job; plugin connects only (VM runs)')
    ap.add_argument('--fake-agent', type=float, metavar='SECONDS',
                    help='runner test only: no dsh and no model; each job waits SECONDS and answers null')
    args = ap.parse_args()
    daemon_app = args.daemon_app.resolve() if args.daemon_app else None
    if not args.dry_run:
        require_vm('run_e2e.py')

    arm = yaml.safe_load((BENCH / 'arms' / f'{args.arm}.yaml').read_text())
    tasks = load_tasks(args.tasks.split(',') if args.tasks else None)
    modes = args.modes.split(',')
    run_id = args.run_id or f'{time.strftime("%Y%m%d-%H%M")}-{arm["id"]}-{uuid.uuid4().hex[:4]}'
    run_root = BENCH / 'runs' / run_id
    run_root.mkdir(parents=True, exist_ok=True)
    jobs = [(t, m, i) for t in tasks for m in (t['modes'] if 'real' in t['modes'] else [m for m in modes if m in t['modes']]) for i in range(1, args.k + 1)]
    if args.cells:
        wanted = {tuple(c.split(':', 1)) for c in args.cells.split(',')}
        known = {(t['id'], m) for t in load_tasks(None) for m in t['modes']}
        if wanted - known:
            sys.exit(f'unknown cells: {sorted(wanted - known)}')
        all_tasks = load_tasks(sorted({t for t, _ in wanted}))
        jobs = [(t, m, i) for t in all_tasks for m in t['modes'] if (t['id'], m) in wanted for i in range(1, args.k + 1)]
    for t in {t['id']: t for t, _, _ in jobs}.values():
        check_read_only(t, arm)
    env = env_record(arm, daemon_app)
    env['limits'] = {'max_steps': args.max_steps, 'timeout_s': args.timeout,
                     'r5_fixed': args.max_steps == MAX_STEPS and args.timeout == TIMEOUT_S}
    env['fake_agent'] = args.fake_agent is not None
    plan = [(t['id'], m, i) for t, m, i in jobs]
    env_p = run_root / 'env.json'
    if env_p.exists() and not args.dry_run:
        # A resumed run (checkpoint.py): the jobs already done were run under the first env; the rest must match it.
        first = json.loads(env_p.read_text())
        for key in ('arm', 'limits', 'fake_agent', 'dsh_version', 'dsh_profile'):
            if first.get(key) != env.get(key):
                sys.exit(f'resume refused: {key} differs from the first attempt ({first.get(key)!r} -> {env.get(key)!r})')
        old_plan = (checkpoint.read_manifest(run_root) or {}).get('jobs')
        if old_plan is not None and [(j['task'], j['mode'], j['k']) for j in old_plan] != plan:
            sys.exit('resume refused: the job list differs from the first attempt')
        for d in checkpoint.set_aside_partial(run_root):
            print(f'set aside unfinished job: {d}')
    else:
        env_p.write_text(json.dumps(env, ensure_ascii=False, indent=2))
    if not args.dry_run:
        checkpoint.write_manifest(run_root, plan, attempt={'started': env['started'], 'git_commit': env['git_commit'],
                                                           'done_before': sum(checkpoint.is_done(run_root / t / m / f'k{i}')
                                                                              for t, m, i in plan)})
    print(f'run {run_id}: {len(jobs)} jobs ({len(tasks)} tasks × modes × k={args.k})', flush=True)
    if args.manual:
        write_manual(run_root, arm, jobs)
        print(run_root / 'manual.md')
        return

    home = make_dsh_home(run_root)
    if (not args.dry_run or args.preflight_only) and args.fake_agent is None:
        pre = preflight_tools(arm, run_root, home)
        print(f'preflight: {"ok" if pre["ok"] else "FAILED"}: {len(pre["tools"])} tools {pre["tools"]}'
              + (f' foreign={pre["foreign"]}' if pre['foreign'] else ''))
        if not pre['ok']:
            sys.exit(f'preflight failed (see {run_root / "preflight.json"}): the model must get {tool_prefix(arm)}* tools only')
        if args.preflight_only:
            return

    socket_dir = Path(tempfile.mkdtemp(prefix='cua-e2e-'))  # short path: sun_path is 104 bytes
    for n, (task, mode, i) in enumerate(jobs, 1):
        run_dir = run_root / task['id'] / mode / f'k{i}'
        if (run_dir / 'result.json').exists():
            continue  # resumable
        run_dir.mkdir(parents=True, exist_ok=True)
        socket = str(socket_dir / f'{n}.sock')
        (run_dir / 'overlay.yml').write_text(yaml.safe_dump(overlay_for(arm, run_dir, socket, spawn_daemon=daemon_app is None,
                                                                    max_steps=args.max_steps, bundle=task_bundle(task),
                                                                    actions=task.get('actions'), click_limit=task.get('click_limit')),
                                                        allow_unicode=True, sort_keys=False))
        (run_dir / 'settings.yaml').write_text(yaml.safe_dump(settings_for(arm), allow_unicode=True, sort_keys=False))
        prompt = prompt_for(task, arm)
        (run_dir / 'prompt.txt').write_text(prompt)
        if args.dry_run:
            continue
        real = RealApp(task, run_dir) if task.get('app') in REAL_APPS else None
        fixture = None if real else start_fixture(task, mode, run_dir)
        terminals_before = terminal_pids()
        audit_before = 0
        app_record = {}
        if is_cu(arm):
            start_cu_daemon()
            if real is not None:
                try:
                    app_record['app_ready_s'] = real.wait_ready()
                except RuntimeError as e:
                    app_record['app_not_ready'] = str(e)[:300]
                    app_record['env_failure'] = True  # not in the model's score (score_e2e.py)
            audit_before = len(audit_lines())
        elif daemon_app:
            start_daemon_app(daemon_app, socket)
        # A system prompt that came up by itself (bench/sysalert.py) stops every action: any arm, any task.
        prompt_in_front = sysalert.system_prompt_in_front()
        if prompt_in_front and 'app_not_ready' not in app_record:
            app_record['app_not_ready'] = f'system prompt in front before the run: {prompt_in_front}'
            app_record['env_failure'] = True
        t0 = time.time()
        stop_evt, reorder_record, watcher = threading.Event(), {}, None
        if is_cu(arm) and task.get('setup', {}).get('reorder_after_observe'):
            watcher = threading.Thread(target=reorder_after_observe, args=(run_dir, audit_before, stop_evt, reorder_record), daemon=True)
            watcher.start()
        try:
            if 'app_not_ready' in app_record:  # an environment failure, not the model's: no model call
                exit_code, stdout, stderr = 'app_not_ready', '', app_record['app_not_ready']
            elif args.fake_agent is not None:
                time.sleep(args.fake_agent)
                exit_code, stdout, stderr = 0, 'fake agent: no model\nANSWER: null\n', ''
            else:
                # nosemgrep: dangerous-subprocess-use-tainted-env-args -- $DSH is set by the operator (out of threat model); list args, no shell
                proc = subprocess.run(dsh_argv(run_dir / 'overlay.yml', prompt), cwd=run_dir, capture_output=True,
                                      text=True, timeout=args.timeout, env=dsh_env(home))
                exit_code, stdout, stderr = proc.returncode, proc.stdout, proc.stderr
        except subprocess.TimeoutExpired as e:
            exit_code, stdout, stderr = 'timeout', e.stdout or '', e.stderr or ''
            stdout = stdout.decode() if isinstance(stdout, bytes) else stdout
            stderr = stderr.decode() if isinstance(stderr, bytes) else stderr
        wall = time.time() - t0
        stop_evt.set()
        if watcher is not None:
            watcher.join(timeout=2)
        audit = None
        if is_cu(arm):
            new = audit_lines()[audit_before:]
            (run_dir / 'audit.jsonl').write_text('\n'.join(new) + ('\n' if new else ''))
            audit = audit_summary(new, task_bundle(task))
            stop_cu_daemon()
        elif daemon_app:
            stop_daemon_app(socket)
        terminals_after = terminal_pids()
        terminal_opened = bool(terminals_after - terminals_before)
        stop(fixture)
        if real is not None:
            real.stop()
        (run_dir / 'stdout.txt').write_text(stdout)
        (run_dir / 'stderr.txt').write_text(stderr)
        raw, answer = parse_answer(stdout)
        # The preflight checked the config; this checks what each request of this job actually offered.
        leaked = foreign_tools(arm, session_tools(run_dir))
        result = {'task': task['id'], 'mode': mode, 'k': i, 'arm': arm['id'], 'exit': exit_code,
                  'wall_s': round(wall, 1), 'answer_raw': raw, 'answer': answer,
                  'audit': audit, 'terminal_opened': terminal_opened,
                  'terminal_running_before': bool(terminals_before), 'terminal_running_after': bool(terminals_after),
                  'foreign_tools_offered': leaked,
                  **reorder_record, **app_record}
        # result.json last and atomically: its presence is what marks the job done (checkpoint.py).
        tmp = run_dir / 'result.json.tmp'
        tmp.write_text(json.dumps(result, ensure_ascii=False, indent=2))
        os.replace(tmp, run_dir / 'result.json')
        checkpoint.write_manifest(run_root, plan)
        # run_vm.sh copies the run back to the host on this line: keep the prefix, and flush (stdout is a pipe).
        print(f'[{n}/{len(jobs)}] {task["id"]} {mode} #{i}: exit={exit_code} {wall:.0f}s ANSWER={raw}', flush=True)
        if leaked:
            sys.exit(f'stopping: the model was offered non-{tool_prefix(arm)} tools {leaked} in {run_dir}')
    shutil.rmtree(socket_dir, ignore_errors=True)
    print(f'done -> {run_root}\nscore: python3 bench/score_e2e.py {run_root.relative_to(ROOT)}')


if __name__ == '__main__':
    sys.exit(main())
