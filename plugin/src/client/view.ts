/**
 * The page's view model: the host's status JSON (POST api/cu-runtime.status, PLAN-阶段2 route table) in, the text,
 * states and enabled buttons the page draws out. Pure (no React, no fetch), so the decisions are unit tested
 * (plugin/tests/client.test.mjs loads the compiled module).
 *
 * @module
 */

/** The install task's working phases, in the order the host runs them. */
export const PHASES = ['preflight', 'identity', 'copy', 'build', 'sign', 'verify', 'stop', 'replace', 'start', 'selfcheck'] as const

/** Phases a task ends in; any other phase, including one this page does not know, is a running task. */
export const TERMINAL_PHASES = ['done', 'failed', 'cancelled'] as const

export type WorkPhase = typeof PHASES[number]
export type Phase = WorkPhase | typeof TERMINAL_PHASES[number]

/** The host can cancel a task until it starts replacing ~/Applications/CURuntime.app. */
const LAST_CANCELLABLE: WorkPhase = 'stop'

/**
 * The keychain asks for the login keychain password during sign (once or more); the advice stands from the start of
 * the task until then.
 */
const LAST_KEYCHAIN: WorkPhase = 'sign'

/**
 * The phase codesign asks for the login keychain password in. Ending it there (a failure, a cancel, the build's
 * timeout) does not close the password dialog: the dialog is macOS's (SecurityAgent), not the task's.
 */
const DIALOG_PHASE: WorkPhase = 'sign'

/** A certificate's SHA-1 as the host sends it: 40 hexadecimal digits. */
const SHA1 = /^[0-9A-Fa-f]{40}$/

/**
 * A SHA-1 written as 40 hexadecimal digits inside a host's message: not part of a longer run of hexadecimal digits,
 * and not quoted (a designated requirement's `H"…"` stays as codesign spells it).
 */
const SHA1_IN_TEXT = /(?<![0-9A-Fa-f"])[0-9A-Fa-f]{40}(?![0-9A-Fa-f"])/g

/**
 * How to read the SHA-1 of the certificate in the identity's .p12 backup kept off this Mac, the reference no process
 * of this user can swap (`<backup.p12>` stands for its path). /usr/bin/openssl is the system's LibreSSL, which reads
 * the RC2-40 bag of such a .p12 (an OpenSSL 3 earlier on PATH does not without -legacy); it asks for the .p12's
 * password and writes no key; the second openssl prints `SHA1 Fingerprint=` and the form opensslSha1 gives.
 */
export const P12_FINGERPRINT_COMMAND =
  '/usr/bin/openssl pkcs12 -in <backup.p12> -nokeys -clcerts | /usr/bin/openssl x509 -noout -fingerprint -sha1'

/**
 * How to read the SHA-1 of a cert.pem: as written, the copy scripts/make-signing-identity.sh keeps on this Mac
 * (~/.cu-runtime-signing/cert.pem), only a convenience, since any process of this user can rewrite it (a
 * cert.pem.replaced-* next to it means it was); a cert.pem kept off this Mac is a reference, with its path in place.
 * openssl prints it as `SHA1 Fingerprint=` and the form opensslSha1 gives.
 */
export const FINGERPRINT_COMMAND = 'openssl x509 -noout -fingerprint -sha1 -in ~/.cu-runtime-signing/cert.pem'

/**
 * A SHA-1 in openssl's form, the one `openssl x509 -fingerprint -sha1` prints and every SHA-1 the page draws is in:
 * upper-case hexadecimal pairs joined by ':'.
 * @param sha1 - 40 hexadecimal digits, either case.
 * @returns e.g. `3C:6E:B8:…` (59 characters).
 */
export function opensslSha1(sha1: string): string {
  return sha1.toUpperCase().match(/../g)!.join(':')
}

/** How many of the task's last log lines the page shows (the host keeps 200). */
export const LOG_LINES = 12

export interface Failure {
  readonly code: string
  readonly message: string
}

export interface TaskState {
  readonly id: string
  readonly phase: string
  readonly startedAt: unknown
  readonly log: readonly string[]
  readonly error: Failure | null
  /**
   * The phase the task was in when it ended failed or cancelled; null for any other task, and from a host that does
   * not send it (or sends something that is not a string).
   */
  readonly endedIn: string | null
}

export interface Status {
  readonly app: {
    readonly installed: boolean
    readonly version: string | null
    readonly sourceHash: string | null
    /**
     * 'mismatch' also stands for an installed app that is not a release build (Info.plist CUBench not false, a bench
     * build), which the host refuses to start, restart, check or grant (not_release_build).
     */
    readonly signature: 'ok' | 'mismatch' | 'unsigned' | 'missing'
    /** 'ambiguous': more than one code-signing identity has the name; the host then reports signature 'mismatch'. */
    readonly identity: 'present' | 'missing' | 'ambiguous'
    /**
     * The SHA-1 of the one cu-runtime-signing identity's certificate (the one the designated requirement pins) when
     * identity is 'present'; null otherwise, and from a host that does not send it or sends something that is not 40
     * hexadecimal digits.
     */
    readonly identitySha1: string | null
    /**
     * The SHA-1 the host knows (identityKnownSource says from where): the one it last signed with successfully or
     * created (its known-identity file), or, without a readable record, the installed app's leaf certificate's; null
     * when it has neither, and from a host that does not send it or sends something that is not 40 hexadecimal digits.
     */
    readonly identityKnown: string | null
    /**
     * Where identityKnown comes from: 'record' (the known-identity file) or 'installedApp' (the installed
     * CURuntime.app's signature, read while there is no readable record); null with no identityKnown, and from a host
     * that does not send it or sends anything else. The page labels the known SHA-1 by it, null as 'record' (a host
     * from before the field knew only its record).
     */
    readonly identityKnownSource: 'record' | 'installedApp' | null
    /**
     * The one identity is not the one the host knows (identity 'present', identityKnown set and different from
     * identitySha1): the host refuses install (identity_changed) until acceptIdentity. false from a host that does not
     * send it.
     */
    readonly identityChanged: boolean
  }
  readonly package: { readonly version: string; readonly sourceHash: string }
  readonly upToDate: boolean
  readonly running: boolean
  /** null: no self-check in the last 10 minutes, so not known (not an error). */
  readonly permissions: { readonly accessibility: boolean; readonly screenRecording: boolean } | null
  readonly environment: { readonly gui: boolean; readonly clt: boolean; readonly sshSession: boolean }
  readonly task: TaskState | null
  /**
   * The cross-process lock's live holder while this host has no task of its own; null otherwise, and from a host that
   * does not send it.
   */
  readonly busy: Busy | null
}

/** Who holds the host's lock (host.lock) while the page's own host has no task: every action of it answers busy. */
export interface Busy {
  readonly pid: number
  /** When the holder took the lock (ISO 8601), shown as the host sends it. */
  readonly since: string
  /**
   * The holder is this dsh process: an earlier load of the package (an earlier version, after an update) still
   * finishing what it began. false: another process (another dsh, the web profile next to the Electron app).
   */
  readonly self: boolean
}

/**
 * The host routes the page posts to besides status; each is `api/cu-runtime.<op>`. permissions opens one System
 * Settings pane per call (Accessibility, or Screen Recording once a recent self-check shows Accessibility granted);
 * selfcheck reads the permissions again; acceptIdentity makes the current identity the one the host knows (only
 * offered while status.app.identityChanged).
 */
export type Op = 'install' | 'permissions' | 'selfcheck' | 'start' | 'stop' | 'restart' | 'cancel' | 'clt' | 'acceptIdentity'

/** The dsh client's translate seat: a key of the page's namespace, `{name}` params. */
export type Translate = (key: string, params?: Record<string, unknown>) => string

export type DotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'

/** One fact; `state` null draws no dot. */
export interface Row {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly state: DotState | null
}

export interface Section {
  readonly id: 'daemon' | 'environment'
  readonly title: string
  readonly rows: readonly Row[]
}

export interface Action {
  readonly op: Op
  readonly label: string
  readonly enabled: boolean
  /** At most one primary: the next step the state calls for. */
  readonly variant: 'primary' | 'outline'
}

export interface Message {
  readonly text: string
  /** The host's own message, when it sent one. */
  readonly detail: string | null
}

export interface TaskView {
  readonly title: string
  readonly state: DotState
  /** "Step n of 10: phase" while running; null once ended or in a phase this page does not know. */
  readonly step: string | null
  /** How to answer the keychain prompts, from preflight through sign; null after it and in a phase this page does not know. */
  readonly keychain: string | null
  /**
   * That a keychain password dialog may still be open and is closed with 拒绝 (Deny): for a task that ended failed or
   * cancelled while signing (endedIn 'sign'), or failed with sign_failed; null for any other task.
   */
  readonly openDialog: string | null
  /** Why there is no cancel any more, from replace on; null before it and in a phase this page does not know. */
  readonly note: string | null
  readonly error: Message | null
  readonly logTitle: string
  readonly log: readonly string[]
}

/** What to check before accepting a changed identity, drawn between the sections and the buttons. */
export interface IdentityChange {
  /**
   * That the two SHA-1s differ (the known one named by where it comes from), how to compare the current one with the
   * certificate backed up off this Mac, why the local cert.pem is no reference and what a cert.pem.replaced-* means,
   * and what each outcome means.
   */
  readonly text: string
  /** P12_FINGERPRINT_COMMAND, then FINGERPRINT_COMMAND (the order the text names them in), each drawn as code. */
  readonly commands: readonly string[]
}

export interface PageView {
  /**
   * The state in one line. While another holder has the host's lock (status.busy, no running task of the page's own
   * host) it names the holder's pid, since when, and whether it is this dsh process (an earlier version of the
   * package still finishing) or another process.
   */
  readonly summary: { readonly state: DotState; readonly text: string }
  readonly sections: readonly Section[]
  readonly actions: readonly Action[]
  /** While status.app.identityChanged (and the identity is the one, 'present'); null otherwise. */
  readonly identityChange: IdentityChange | null
  readonly task: TaskView | null
  /**
   * How granting goes, one System Settings pane per click, drawn next to the buttons: while the app could be granted
   * permissions (on this Mac's screen, installed and verifiable) and they are not both known to be granted.
   */
  readonly permissionsHint: string | null
  /**
   * How to update this plugin (remove it, add the new package) and that adding a plugin needs the pnpm on dsh's PATH:
   * drawn at the foot of the page, always, before the first status too (a page that cannot read it may be one an
   * update fixes).
   */
  readonly pluginUpdateHint: string
  /** What to do after an action that hands over to macOS (permissions, clt). */
  readonly notice: string | null
  readonly error: Message | null
}

export interface ViewOptions {
  readonly t: Translate
  /** The action whose request is in flight: every button waits for it. */
  readonly pending?: Op | null
  /** The last action that succeeded, for its notice (and, after permissions, 检查权限 as the next step). */
  readonly done?: Op | null
  /** The last action's failure; it outranks statusError. */
  readonly actionError?: Failure | null
  /**
   * The action actionError came from. acceptIdentity's identity_changed (the identity changed again after the status
   * the page showed) has its own text, since identity_changed's says the install was refused.
   */
  readonly actionErrorOp?: Op | null
  /** The last status read's failure; the status shown is then the last one read. */
  readonly statusError?: Failure | null
}

/** The codes the host's task and action failures carry (PLAN-阶段2「实现后定下的约定」), each with its own text. */
export const HOST_ERROR_CODES = ['busy', 'ssh_session', 'no_gui_session', 'clt_missing', 'identity_failed',
  'identity_ambiguous', 'identity_missing', 'identity_changed', 'copy_failed', 'build_failed', 'not_release_build',
  'sign_failed', 'signature_mismatch', 'stop_failed', 'replace_failed', 'start_failed', 'selfcheck_failed',
  'selfcheck_timeout', 'not_installed', 'clt_install_failed', 'no_task', 'not_cancellable', 'internal'] as const

/**
 * The page's own codes: dsh refused the session (HTTP 401/403), the request did not get through, the status had the
 * wrong shape.
 */
export const PAGE_ERROR_CODES = ['unauthorized', 'network', 'bad_response'] as const

/** Codes with their own text (error.<code>): the host's, then the page's. */
export const ERROR_CODES = [...HOST_ERROR_CODES, ...PAGE_ERROR_CODES] as const

const NOTICES: ReadonlySet<Op> = new Set(['permissions', 'clt'])

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

function readFailure(v: unknown): Failure | null | undefined {
  if (v === null) return null
  if (!isObject(v) || typeof v.code !== 'string') return undefined
  return { code: v.code, message: typeof v.message === 'string' ? v.message : '' }
}

function readTask(v: unknown): TaskState | null | undefined {
  if (v === null) return null
  if (!isObject(v) || typeof v.phase !== 'string') return undefined
  const error = readFailure(v.error ?? null)
  if (error === undefined) return undefined
  return {
    id: String(v.id ?? ''),
    phase: v.phase,
    startedAt: v.startedAt,
    log: Array.isArray(v.log) ? v.log.map(String) : [],
    error,
    endedIn: typeof v.endedIn === 'string' ? v.endedIn : null,
  }
}

function readBusy(v: unknown): Busy | null | undefined {
  if (v === null) return null
  if (!isObject(v) || typeof v.pid !== 'number' || !Number.isSafeInteger(v.pid) || v.pid <= 0 || typeof v.since !== 'string'
    || !isBool(v.self)) return undefined
  return { pid: v.pid, since: v.since, self: v.self }
}

const sha1Or = (v: unknown): string | null => (typeof v === 'string' && SHA1.test(v) ? v : null)

/**
 * The status the host answered, checked field by field.
 * @param raw - the parsed response body.
 * @returns the status; a missing optional fact (version, source hash, the identity's SHA-1s, the phase a task ended
 * in, the lock's holder) reads as null, a missing identityChanged as false: a host from before those fields shows
 * nothing of them.
 * @throws {Error} with code `bad_response` when a field the page decides on is missing or of the wrong type (also
 * identityChanged and busy when present).
 */
export function readStatus(raw: unknown): Status {
  const bad = (): never => {
    throw Object.assign(new Error('the status response does not have the expected fields'), { code: 'bad_response' })
  }
  if (!isObject(raw) || !isObject(raw.app) || !isObject(raw.environment)) return bad()
  const { app, environment: env } = raw
  const perms = raw.permissions
  const pkg = isObject(raw.package) ? raw.package : {}
  const signature = app.signature
  const task = readTask(raw.task ?? null)
  const busy = readBusy(raw.busy ?? null)
  const changed = app.identityChanged ?? false
  if (!isBool(app.installed) || !isBool(raw.upToDate) || !isBool(raw.running)) return bad()
  if (signature !== 'ok' && signature !== 'mismatch' && signature !== 'unsigned' && signature !== 'missing') return bad()
  if (!isBool(env.gui) || !isBool(env.clt) || !isBool(env.sshSession)) return bad()
  if (perms !== null && !(isObject(perms) && isBool(perms.accessibility) && isBool(perms.screenRecording))) return bad()
  if (task === undefined || busy === undefined || !isBool(changed)) return bad()
  return {
    app: {
      installed: app.installed,
      version: typeof app.version === 'string' ? app.version : null,
      sourceHash: typeof app.sourceHash === 'string' ? app.sourceHash : null,
      signature,
      identity: app.identity === 'present' || app.identity === 'ambiguous' ? app.identity : 'missing',
      identitySha1: sha1Or(app.identitySha1),
      identityKnown: sha1Or(app.identityKnown),
      identityKnownSource: app.identityKnownSource === 'record' || app.identityKnownSource === 'installedApp'
        ? app.identityKnownSource : null,
      identityChanged: changed as boolean,
    },
    package: {
      version: typeof pkg.version === 'string' ? pkg.version : '',
      sourceHash: typeof pkg.sourceHash === 'string' ? pkg.sourceHash : '',
    },
    upToDate: raw.upToDate,
    running: raw.running,
    permissions: perms === null ? null : { accessibility: perms.accessibility as boolean, screenRecording: perms.screenRecording as boolean },
    environment: { gui: env.gui, clt: env.clt, sshSession: env.sshSession },
    task,
    busy,
  }
}

/** Whether a task is running: there is one, and its phase is not one a task ends in. */
export function taskActive(task: TaskState | null | undefined): boolean {
  return task != null && !(TERMINAL_PHASES as readonly string[]).includes(task.phase)
}

/**
 * Whether another holder has the host's lock while the page's own host runs no task: then every action of the host
 * answers busy, so the page holds them and reads the status as often as while a task runs.
 */
export function heldElsewhere(status: Status): boolean {
  return !taskActive(status.task) && status.busy !== null
}

/** Whether the host still accepts cancel for this task (before replace). */
export function taskCancellable(task: TaskState | null | undefined): boolean {
  if (!taskActive(task)) return false
  const at = (PHASES as readonly string[]).indexOf(task!.phase)
  return at >= 0 && at <= PHASES.indexOf(LAST_CANCELLABLE)
}

function phaseLabel(t: Translate, phase: string): string {
  return (PHASES as readonly string[]).includes(phase) ? t(`phase.${phase}`) : phase
}

/**
 * The text for a failure: its code's own text when it has one, a phase's failure for `<phase>_failed`, otherwise
 * the generic text with the code; the host's message as the detail, with each SHA-1 in it (40 hexadecimal digits on
 * their own, as identity_changed names both) in openssl's form like every SHA-1 the page draws (the task's log lines
 * too, taskView). acceptIdentity's identity_changed (op) reads identity.changedAgain: not the install's refusal.
 */
export function errorMessage(t: Translate, failure: Failure | null | undefined, op: Op | null = null): Message | null {
  if (failure == null) return null
  const phase = /^(\w+)_failed$/.exec(failure.code)?.[1]
  const text = op === 'acceptIdentity' && failure.code === 'identity_changed' ? t('identity.changedAgain')
    : (ERROR_CODES as readonly string[]).includes(failure.code) ? t(`error.${failure.code}`)
      : phase !== undefined && (PHASES as readonly string[]).includes(phase) ? t('error.phaseFailed', { phase: phaseLabel(t, phase) })
        : t('error.unknown', { code: failure.code })
  const message = failure.message.trim().replace(SHA1_IN_TEXT, opensslSha1)
  const detail = message === '' ? null : t('error.detail', { message })
  return { text, detail }
}

function taskView(t: Translate, task: TaskState): TaskView {
  const active = taskActive(task)
  const at = (PHASES as readonly string[]).indexOf(task.phase)
  // A SHA-1 a tool or the host logged (make-signing-identity.sh's created identity, the host's own lines) in
  // openssl's form, as on the rows.
  const log = task.log.slice(-LOG_LINES).map((line) => line.replace(SHA1_IN_TEXT, opensslSha1))
  const ended = task.phase === 'failed' || task.phase === 'cancelled'
  return {
    title: t(active ? 'task.running' : `task.${task.phase}`),
    state: active ? 'ongoing' : task.phase === 'done' ? 'done' : task.phase === 'failed' ? 'error' : 'idle',
    step: active && at >= 0
      ? t('task.step', { index: at + 1, total: PHASES.length, phase: phaseLabel(t, task.phase) })
      : null,
    keychain: active && at >= 0 && at <= PHASES.indexOf(LAST_KEYCHAIN) ? t('task.keychain') : null,
    openDialog: ended && (task.endedIn === DIALOG_PHASE || task.error?.code === 'sign_failed') ? t('task.openDialog') : null,
    note: active && at > PHASES.indexOf(LAST_CANCELLABLE) ? t('task.noCancel') : null,
    error: task.phase === 'failed' ? errorMessage(t, task.error ?? { code: 'unknown', message: '' }) : null,
    logTitle: t('task.log', { count: log.length }),
    log,
  }
}

/**
 * Build what the page shows.
 * @param status - the last status read, or null before the first one arrives.
 * @param options - the translate seat and the page's own state (the action in flight, the last failures).
 * @returns the summary line, the daemon and environment sections, the buttons with their enabled state, what to check
 * about a changed identity, how granting goes, the task's progress, and the error to show. Unchecked permissions
 * (null) are neither an error nor all well: the summary says so once nothing else is wrong, and 检查权限 (selfcheck)
 * reads them. A keychain with more than one cu-runtime-signing identity holds every button the host refuses for it
 * (install, permissions, selfcheck, start, restart). An installed bench build arrives as signature 'mismatch' and is
 * treated as one: reinstall is the next step, and the buttons that launch the app are held. A changed identity
 * (status.app.identityChanged) shows the current and the known SHA-1 (labelled by identityKnownSource: the one last
 * used, or the installed app's), how to compare the current one with the certificate backed up off this Mac, and
 * 确认当前证书 (acceptIdentity); install (and update) is held, as the host refuses it, and so
 * are permissions, selfcheck, start and restart (the permissions must not go to an app of an unconfirmed identity);
 * no button is primary, since comparing comes first (except 安装命令行工具 when the Command Line Tools are missing: that
 * comes before everything). While another holder has the host's lock and the page's own host runs no task
 * (status.busy), the summary names it and every button is held, as while a task runs. A host without these fields
 * shows none of it.
 */
export function buildView(status: Status | null, options: ViewOptions): PageView {
  const { t } = options
  const pending = options.pending ?? null
  const error = options.actionError != null ? errorMessage(t, options.actionError, options.actionErrorOp ?? null)
    : errorMessage(t, options.statusError)
  const notice = options.done != null && NOTICES.has(options.done) ? t(`notice.${options.done}`) : null
  if (status === null) {
    return {
      summary: options.statusError != null
        ? { state: 'error', text: t('summary.unreadable') }
        : { state: 'idle', text: t('summary.loading') },
      sections: [], actions: [], identityChange: null, task: null, permissionsHint: null,
      pluginUpdateHint: t('hint.pluginUpdate'), notice, error,
    }
  }

  const { app, environment: env, permissions: perms, task } = status
  const none = t('value.none')
  const active = taskActive(task)
  const held = heldElsewhere(status) ? status.busy : null
  const busy = pending !== null || active || held !== null
  const desktop = env.gui && !env.sshSession
  const ambiguous = app.identity === 'ambiguous'
  const changed = app.identity === 'present' && app.identityChanged
  const signed = app.installed && app.signature === 'ok' && !ambiguous
  // An app the page launches, checks or grants permissions to: signed by the one identity, and that identity confirmed
  // (an app it signed while it is unconfirmed was built outside the host, which records each identity it signs with).
  const trusted = signed && !changed
  const granted = perms !== null && perms.accessibility && perms.screenRecording
  const sha1 = (value: string | null): string => (value === null ? none : opensslSha1(value))
  // The texts naming the known SHA-1 by where the host has it from: 'InstalledApp' for the installed app's
  // signature, '' for its record (also from a host that does not say).
  const known = app.identityKnownSource === 'installedApp' ? 'InstalledApp' : ''

  const permission = (id: 'accessibility' | 'screenRecording'): Row => ({
    id,
    label: t(`row.${id}`),
    value: !app.installed ? none : perms === null ? t('value.unchecked') : perms[id] ? t('value.granted') : t('value.notGranted'),
    state: !app.installed ? null : perms === null ? 'idle' : perms[id] ? 'done' : 'warning',
  })
  const daemon: Section = {
    id: 'daemon',
    title: t('section.daemon'),
    rows: [
      { id: 'installed', label: t('row.installed'), value: t(app.installed ? 'value.installed' : 'value.notInstalled'),
        state: app.installed ? 'done' : 'idle' },
      { id: 'version', label: t('row.version'), value: app.installed && app.version !== null ? app.version : none, state: null },
      { id: 'pluginVersion', label: t('row.pluginVersion'), value: status.package.version || none, state: null },
      { id: 'upToDate', label: t('row.upToDate'), value: !app.installed ? none : t(status.upToDate ? 'value.upToDate' : 'value.outdated'),
        state: !app.installed ? null : status.upToDate ? 'done' : 'warning' },
      { id: 'signature', label: t('row.signature'),
        value: !app.installed ? none : t(ambiguous ? 'value.signature.ambiguous' : `value.signature.${app.signature}`),
        state: !app.installed ? null : signed ? 'done' : 'error' },
      { id: 'identity', label: t('row.identity'),
        value: t(ambiguous ? 'value.identityAmbiguous' : changed ? `value.identityChanged${known}`
          : app.identity === 'present' ? 'value.identityPresent' : 'value.identityMissing'),
        state: ambiguous || changed ? 'error' : app.identity === 'present' ? 'done' : 'idle' },
      // The certificate the requirement pins, in openssl's form: what `openssl x509 -noout -fingerprint -sha1` prints
      // for the certificate backed up with the identity's .p12.
      { id: 'identitySha1', label: t('row.identitySha1'),
        value: app.identity === 'present' ? sha1(app.identitySha1) : none, state: null },
      // The one the host knows (last signed with or created, or the installed app's), only while it differs from the
      // current one.
      ...(changed ? [{ id: 'identityKnown', label: t(`row.identityKnown${known}`), value: sha1(app.identityKnown), state: null }]
        : []),
      { id: 'running', label: t('row.running'), value: !app.installed ? none : t(status.running ? 'value.running' : 'value.stopped'),
        state: !app.installed ? null : status.running ? 'done' : 'idle' },
      permission('accessibility'),
      permission('screenRecording'),
    ],
  }
  const environment: Section = {
    id: 'environment',
    title: t('section.environment'),
    rows: [
      { id: 'clt', label: t('row.clt'), value: t(env.clt ? 'value.cltInstalled' : 'value.cltMissing'), state: env.clt ? 'done' : 'warning' },
      { id: 'session', label: t('row.session'),
        value: t(env.sshSession ? 'value.sshSession' : env.gui ? 'value.guiSession' : 'value.noGui'),
        state: desktop ? 'done' : 'error' },
    ],
  }

  const enabled: Record<Op, boolean> = {
    clt: !busy && desktop,
    install: !busy && desktop && env.clt && !ambiguous && !changed,
    permissions: !busy && desktop && trusted,
    selfcheck: !busy && desktop && trusted,
    start: !busy && desktop && trusted && !status.running,
    stop: !busy && status.running,
    restart: !busy && desktop && trusted && status.running,
    cancel: pending === null && taskCancellable(task),
    acceptIdentity: !busy && changed,
  }
  // Right after 授予权限 the permissions shown are still those read before it, so 检查权限 is next; it shows
  // whether 授予权限 is needed again for the next pane.
  const next: Op | null = !env.clt ? 'clt'
    : ambiguous || changed ? null
      : !app.installed || app.signature !== 'ok' || !status.upToDate ? 'install'
        : perms !== null && !granted ? (options.done === 'permissions' ? 'selfcheck' : 'permissions')
          : !status.running ? 'start'
            : perms === null ? 'selfcheck'
              : null
  const installLabel = !app.installed ? 'action.install' : app.signature !== 'ok' || status.upToDate ? 'action.reinstall' : 'action.update'
  const ops: Op[] = [...(env.clt ? [] : ['clt' as const]), ...(changed ? ['acceptIdentity' as const] : []),
    'install', 'permissions', 'selfcheck', 'start', 'stop', 'restart', ...(active ? ['cancel' as const] : [])]
  const actions = ops.map((op): Action => ({
    op,
    label: t(op === 'install' ? installLabel : `action.${op}`),
    enabled: enabled[op],
    variant: op === next && enabled[op] ? 'primary' : 'outline',
  }))

  const summary: PageView['summary'] = active ? { state: 'ongoing', text: t('summary.task', { phase: phaseLabel(t, task!.phase) }) }
    : held !== null ? { state: 'ongoing', text: t(held.self ? 'summary.busySelf' : 'summary.busyOther', { pid: held.pid, since: held.since }) }
      : !desktop ? { state: 'error', text: t(env.sshSession ? 'summary.sshSession' : 'summary.noGui') }
        : ambiguous ? { state: 'error', text: t('summary.identityAmbiguous') }
          : changed ? { state: 'error', text: t(`summary.identityChanged${known}`) }
            : !app.installed ? { state: 'idle', text: t('summary.notInstalled') }
              : app.signature !== 'ok' ? { state: 'error', text: t('summary.signature') }
                : !status.upToDate ? { state: 'warning', text: t('summary.outdated') }
                  : perms !== null && !granted ? { state: 'warning', text: t('summary.permissions') }
                    : !status.running ? { state: 'idle', text: t('summary.stopped') }
                      : perms === null ? { state: 'idle', text: t('summary.unchecked') }
                        : { state: 'done', text: t('summary.ready') }

  return {
    summary,
    sections: [daemon, environment],
    actions,
    identityChange: changed
      ? { text: t('identity.changed', { known: t(`identity.known${known}`) }),
          commands: [P12_FINGERPRINT_COMMAND, FINGERPRINT_COMMAND] }
      : null,
    task: task === null ? null : taskView(t, task),
    // Not while every grant button is disabled (an install task, an action in flight): the hint says to click one.
    permissionsHint: !busy && desktop && trusted && !granted ? t('hint.permissions') : null,
    pluginUpdateHint: t('hint.pluginUpdate'),
    notice,
    error,
  }
}

/** One profile of the host's mode check (daemon/mode-check.ts ProfileResult). */
export interface ModeCheckProfile {
  readonly profile: string
  readonly status: 'ok' | 'fail' | 'skipped'
  readonly lines: readonly string[]
}

/** The host's mode check (api/cu-runtime.modeCheck, modeCheckRefresh: the answer's `result`). */
export interface ModeCheckResult {
  /** When it ran, ISO 8601, shown as the host sends it. */
  readonly checkedAt: string
  readonly ok: boolean
  readonly profiles: readonly ModeCheckProfile[]
}

const PROFILE_STATUSES: ReadonlySet<unknown> = new Set(['ok', 'fail', 'skipped'])

/**
 * The mode check from a route's answer (`{ ok: true, result }`).
 * @throws an error with code `bad_response` when the answer does not have the expected fields.
 */
export function readModeCheck(raw: unknown): ModeCheckResult {
  const bad = (): never => {
    throw Object.assign(new Error('the mode check response does not have the expected fields'), { code: 'bad_response' })
  }
  const result = isObject(raw) ? raw.result : undefined
  if (!isObject(result) || typeof result.checked_at !== 'string' || !isBool(result.ok) || !Array.isArray(result.profiles)) {
    return bad()
  }
  const profiles = result.profiles.map((p: unknown): ModeCheckProfile => {
    if (!isObject(p) || typeof p.profile !== 'string' || !PROFILE_STATUSES.has(p.status) || !Array.isArray(p.lines)
      || !p.lines.every((l: unknown) => typeof l === 'string')) return bad()
    return { profile: p.profile, status: p.status as ModeCheckProfile['status'], lines: p.lines as string[] }
  })
  return { checkedAt: result.checked_at, ok: result.ok, profiles }
}

/** The 模式检查 section of the daemon tab. */
export interface ModeCheckView {
  readonly title: string
  /** What is checked, one sentence. */
  readonly about: string
  /**
   * 正常 (the result is ok: at least one profile, every one ok), n 项问题 (n failing lines), or 未检查 (no result yet,
   * a profile not checked, no profile found, or a result that is not ok without a failing line).
   */
  readonly state: DotState
  readonly text: string
  /**
   * `<profile>: <line>` for each failing profile's lines; when none fails, each skipped profile's reason (the line alone
   * for the entry of a home with no profile, whose profile is ''). Drawn in a list of limited height that scrolls.
   */
  readonly lines: readonly string[]
  /** "Checked at …", null before the first result. */
  readonly checkedAt: string | null
  /** 重新检查: modeCheckRefresh, held while a read is in flight. */
  readonly refresh: { readonly label: string; readonly enabled: boolean }
  readonly error: Message | null
}

/**
 * The mode check section from the last result read (null before the first), whether a read is in flight, and the
 * last read's failure.
 */
export function buildModeCheckView(result: ModeCheckResult | null,
  options: { t: Translate; pending?: boolean; error?: Failure | null }): ModeCheckView {
  const { t } = options
  const pending = options.pending ?? false
  const failing = result?.profiles.filter((p) => p.status === 'fail') ?? []
  const skipped = result?.profiles.filter((p) => p.status === 'skipped') ?? []
  const listed = failing.length > 0 ? failing : skipped
  const lines = listed.flatMap((p) => p.lines.map((l) => (p.profile === '' ? l : `${p.profile}: ${l}`)))
  // A failing profile counts its lines (at least one: a failure without a line is still a problem).
  const problems = failing.reduce((n, p) => n + Math.max(p.lines.length, 1), 0)
  const summary: { state: DotState; text: string } = result === null
    ? (pending ? { state: 'ongoing', text: t('modeCheck.checking') } : { state: 'idle', text: t('modeCheck.unchecked') })
    : problems > 0 ? { state: 'error', text: t('modeCheck.problems', { n: problems }) }
      : skipped.length > 0 || !result.ok || result.profiles.length === 0 ? { state: 'idle', text: t('modeCheck.unchecked') }
        : { state: 'done', text: t('modeCheck.ok') }
  return {
    title: t('section.modeCheck'),
    about: t('modeCheck.about'),
    ...summary,
    lines,
    checkedAt: result === null ? null : t('modeCheck.checkedAt', { at: result.checkedAt }),
    refresh: { label: t('action.modeCheckRefresh'), enabled: !pending },
    error: errorMessage(t, options.error),
  }
}
