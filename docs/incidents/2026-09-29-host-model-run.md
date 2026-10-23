# Incident — a real model with bash ran on the host (2026-09-29)

Sanitized summary. The full report (local paths, file names) is not part of the repository.

## What happened

While reproducing the runner's self-check **negative control** by hand on the host (bash and the file tools
deliberately enabled, to show the check reports them), the overlay pointed at the settings file by a relative path.
The settings did not load, so the fake model name in them — the only thing standing between that configuration and
a real model — did not apply either. dsh fell back to its default model and default `headless` profile and ran the
prompt `preflight` for real: 23 model steps and 22 bash tool calls over about 90 seconds, in dsh's `workspace-write`
Seatbelt sandbox.

## What is known

The complete session record was deleted with the run directory. The following was reconstructed from what remained:
dsh's session projection cache, the kernel sandbox log (every system binary started inside the sandbox leaves a
denied `/dev/dtracehelper` write, so the log yields each process name and time, but no arguments), the daemon's
audit log, dsh's upload cache, and a scan of files modified in the window.

- The model explored the working tree (ls/find/grep/head, one `mdfind`, two `cat`), listed its environment once
  (`env | grep | sort`), started the daemon and the fixture with `open` (outside the sandbox, through
  LaunchServices), and twice pinged the daemon from Python, which means reading its token file.
- Daemon audit: grants for the fixture only; 4 observes (1 with an image), 2 app lists; **no actions**. The host
  daemon had no Accessibility or Screen Recording grant.
- One image was uploaded to the model provider: grey blocks for unauthorized regions plus a black region. It
  contained no host screen content.
- **No writes outside the working directory**: the only real sandbox denial was an attempt to exec a setuid binary
  (`ps`). No configuration or LaunchAgent changed.
- No curl/wget/nc/ssh inside the sandbox. (Two ssh processes in the window were a pre-existing LaunchAgent,
  outside the sandbox.) Session telemetry was in feedback-only mode and did not upload.

## What cannot be ruled out

Which files the model **read**. The sandbox allows reads and does not log them, and on this APFS volume atime is
only refreshed when it is older than mtime, so atimes cannot tell. Whatever was read went into the conversation, i.e.
to the model provider. Whether a caller-environment token matched the model's `env | grep` cannot be established.
Rotating the credentials that might have been exposed is the remaining remedy; this report does not decide it.

## Root causes

1. **Fail-open defaults.** When configuration failed to load, dsh fell back to a real model and a tool-using
   profile. Every restriction depended on external files loading.
2. The most dangerous configuration (bash on) was the one being run on purpose, guarded by one file.
3. Bench entry points ran anywhere, including the host.
4. The host's default credential store gave any dsh profile the key.
5. dsh's `workspace-write` sandbox confines writes only; reads, network and `open` are allowed.
6. The session record was deleted with the run directory.

## Fixes (fail closed)

| layer | change | verified |
|---|---|---|
| where | `bench/vmguard.py`: every bench entry point that drives the GUI or runs a model exits unless `kern.hv_vmm_present == 1` and `hw.model` is a `VirtualMac` (OS facts, not a copyable marker file). The one exemption is the host QQ measurement (no model, no dsh, observe only). | structural test over all entry points (mutation-checked); runner refuses on the host; markers checked in a clone |
| profile | the bench boots its own dsh profile, `bench/dsh-profile/cu-bench`, from a per-run `DSH_HOME`. The profile **itself** disables bash, file, web, subagent, workflow and skill tools, pins native tool schemas, a read-only sandbox and no telemetry | unit test on the profile; the self-check's tool list in the VM |
| key | the profile reads only `CU_BENCH_DEEPSEEK_KEY` from a guest-only file; `bench/vm/guest_key.py` moves the key there inside each throwaway clone (the base image is unchanged). On the host the profile stops at the first model call with `MISSING_CREDENTIAL` | host test (mutation-checked: with the host's default store it reaches the endpoint instead) |
| environment | dsh inherits an allowlist of variables only (`DSH_ENV_ALLOW`) | unit test |
| self-check | the request goes to a loopback port verified to refuse connections, set through `$DEEPSEEK_BASE_URL` and settings; it passes only on `TRANSPORT` to that port (an API error means the override did not take). The fake model name stays as a second layer | VM run; negative control as a host test (overlay re-enables bash and fs, fake key, dead port → `bash`, `read` reported) |
| isolation | all dsh state lives under the run's `dsh-home`, not the user's `~/.dsh` | VM run |
| records | the VM runner copies the guest daemon's whole audit log back before the clone is destroyed and archives every E2E run (session JSONL with every tool call's arguments, audits, prompts, outputs) into the gitignored `bench/archive/` for 30 days (`bench/records.py`); run directories are deleted only through `records.py clean`, which archives first; a resumed run renames the earlier self-check directory instead of deleting it | unit tests; VM run archived |
| signing key | the .p12 password moved from a plain file into the login keychain | read back and opened the .p12 (wrong-password control refused) |

## Remaining

- dsh's own sandbox allows reads, network and `open` in `workspace-write` mode; that is upstream behaviour and still
  applies to interactive dsh use on the host.
- The host QQ measurement stays a separate, exempt procedure: no model, no bash, observe only, grant revoked
  immediately afterwards.
