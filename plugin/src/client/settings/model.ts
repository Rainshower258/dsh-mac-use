/**
 * The settings tabs' shared model, pure (no React, no fetch; plugin/tests/client-settings-*.test.mjs load the
 * compiled module): the tabs, the snapshot the host answers (`POST api/cu-runtime.settings.snapshot`, the daemon's
 * settings.snapshot with only the H4 keys) checked on arrival, how often it is read, and the words for what the
 * snapshot and the routes say: the change waiting for the owner check, the last settled outcome, an action's answer,
 * and every error code (stage 3b H3).
 *
 * @module
 */

import type { Message, Translate } from '../view.ts'
import type { ChangeKind } from './change.ts'

/** The settings tabs, in the native window's order; each has settings/tabs/<id>.ts and settings/locale/<id>.ts. */
export const SETTINGS_TABS = ['overview', 'access', 'apps', 'shortcuts', 'privacy', 'behavior', 'logs'] as const

export type SettingsTab = typeof SETTINGS_TABS[number]

/** The page's tabs: the daemon's (the stage-2 page, the default), then the settings tabs. */
export const PAGE_TABS = ['daemon', ...SETTINGS_TABS] as const

export type PageTab = typeof PAGE_TABS[number]

/**
 * The snapshot is read every SETTINGS_ACTIVE_POLL_MS while a change waits for the owner check (`pending`) or a panel
 * is open on the Mac (`panel`), else every SETTINGS_IDLE_POLL_MS; only while a settings tab is shown, and at once after
 * every apply, action and cancel. Never faster: each read has the host check the daemon with codesign.
 */
export const SETTINGS_ACTIVE_POLL_MS = 1000
export const SETTINGS_IDLE_POLL_MS = 10_000

// --- the snapshot (Sources/CURuntimeCore/Dispatcher+Settings.swift settingsSnapshotJSON, Dispatcher+SettingsRPC) ---

/** Times are epoch seconds (floats); `name` is the app's display name as the Mac knows it, null when unknown. */
export interface AppRef {
  readonly bundle_id: string
  readonly name: string | null
}

export interface GrantApp extends AppRef {
  /** null: a grant set by configuration, with its own action list. */
  readonly mode: 'read' | 'full' | null
  readonly scope: 'turn' | 'session' | 'always' | null
  readonly expires_at: number
}

/** One task's (dsh session's) approvals in effect. */
export interface Grant {
  readonly task_id: string
  readonly expires_at: number
  /** Approved through a dialog, the always list or the default mode; false: set by configuration. */
  readonly by_dialog: boolean
  /** The dsh process the approval answered has exited. */
  readonly owner_gone: boolean
  readonly apps: readonly GrantApp[]
}

export interface PersistentEntry extends AppRef {
  readonly mode: string
  readonly added_at: number
  /** Whether the app still matches the signature it was added with; null when not checked. */
  readonly signature_ok: boolean | null
}

export interface DenyEntry extends AppRef {
  readonly note: string
}

/** A floor entry: one bundle ID, or a whole namespace (`namespace`, `name` null). */
export interface HardDenyEntry {
  readonly bundle_id?: string
  readonly namespace?: string
  readonly name: string | null
  readonly category: string
}

export interface Chords {
  readonly builtin: readonly { readonly chord: string; readonly enabled: boolean }[]
  readonly never: readonly string[]
  /** `app` null: every approved app. */
  readonly custom: readonly { readonly chord: string; readonly app: string | null; readonly note: string }[]
}

export interface Refusal {
  readonly at: number
  readonly method: string
  /** The bundle ID the call named, when it named one. */
  readonly app: string | null
  readonly reason: string
}

export interface RecentChange {
  readonly at: number
  readonly method: string
  readonly app: string | null
  readonly reason: string | null
  readonly verified: boolean | null
}

/** The three permissions; null for the whole object when the daemon runs without panels. */
export interface Permissions {
  readonly accessibility: boolean
  readonly screen_recording: boolean
  /** null: not requested (this version does not need it). */
  readonly input_monitoring: boolean | null
}

/**
 * The change waiting for the owner check, as the daemon summarizes it (settingsChangeSummary): `kind` and the fields
 * that say what it does (`bundle_id`, `mode`, `note` (60 characters), `field` and `value` or `on`, `chord` and `app`,
 * `days`, `directory`, `loosened` for reset and import, `task_id`).
 */
export interface ChangeSummary {
  readonly kind: string
  readonly [field: string]: unknown
}

/**
 * The last change or panel settled (`kind`: a change kind, `import` or `logs.directory`, or an action's name):
 * outcome applied, verify_failed, verify_cancelled, verify_unavailable, cancelled, refused (with `reason`), or done for
 * a panel. `at` is when it settled: the next settings request after the verdict or the panel's answer.
 */
export interface LastOutcome {
  readonly at: number
  readonly kind: string
  readonly outcome: string
  readonly reason?: string
}

export interface Snapshot {
  readonly started_at: number
  readonly grants: readonly Grant[]
  readonly persistent: readonly PersistentEntry[]
  readonly denylist: readonly DenyEntry[]
  readonly hard_deny: readonly HardDenyEntry[]
  /** default_mode, session_limit_minutes, dialogs_per_turn, dialog_timeout_seconds, dialog_default. */
  readonly access: Readonly<Record<string, unknown>>
  /** The values each access field offers, by field. */
  readonly access_choices: Readonly<Record<string, readonly unknown[]>>
  readonly chords: Chords
  /** send_screenshots, send_ax_text, send_ocr, send_zoom, text_only_apps, clear_clipboard_on_turn_start. */
  readonly privacy: Readonly<Record<string, unknown>>
  /** restore_focus_on_turn_end, allow_point_targets, ime_policy_cap, electron_ax_auto, activation_method. */
  readonly behavior: Readonly<Record<string, unknown>>
  /** directory (shown only when the person chose one, home as ~), directory_custom, retention_days, files, bytes. */
  readonly logs: Readonly<Record<string, unknown>>
  /** Today's and yesterday's, newest first, at most 100. */
  readonly recent_refusals: readonly Refusal[]
  readonly recent_changes: readonly RecentChange[]
  readonly permissions: Permissions | null
  readonly pending: ChangeSummary | null
  readonly last_outcome: LastOutcome | null
  /** The app the person picked in the daemon's panel (settings.action.choose_app), until the next pick. */
  readonly picked_app: AppRef | null
  /** `{changes, changes_count, loosened, log_directory_ignored}` of the file settings.action.import read. */
  readonly import_preview: Readonly<Record<string, unknown>> | null
  /** The action whose panel is open on the Mac. */
  readonly panel: string | null
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const nullOr = <T>(v: unknown, read: (v: unknown) => T | undefined): T | null | undefined => (v === null ? null : read(v))

/** An error the view shows by its code. */
export class SnapshotError extends Error {
  readonly code = 'bad_response'
}

function fail(what: string): never {
  throw new SnapshotError(`the settings snapshot has no valid ${what}`)
}

function arrayOf<T>(v: unknown, what: string, read: (item: unknown) => T | undefined): T[] {
  if (!Array.isArray(v)) fail(what)
  return v.map((item) => read(item) ?? fail(what))
}

function readApp(v: unknown): AppRef | undefined {
  if (!isObject(v) || !isString(v.bundle_id)) return undefined
  return { bundle_id: v.bundle_id, name: isString(v.name) ? v.name : null }
}

function readGrant(v: unknown): Grant | undefined {
  if (!isObject(v) || !isString(v.task_id) || !isNumber(v.expires_at) || !Array.isArray(v.apps)) return undefined
  const apps: GrantApp[] = []
  for (const a of v.apps) {
    const app = readApp(a)
    if (app === undefined || !isObject(a) || !isNumber(a.expires_at)) return undefined
    apps.push({
      ...app,
      mode: a.mode === 'read' || a.mode === 'full' ? a.mode : null,
      scope: a.scope === 'turn' || a.scope === 'session' || a.scope === 'always' ? a.scope : null,
      expires_at: a.expires_at,
    })
  }
  return { task_id: v.task_id, expires_at: v.expires_at, by_dialog: v.by_dialog === true, owner_gone: v.owner_gone === true, apps }
}

function readRefusal(v: unknown): Refusal | undefined {
  if (!isObject(v) || !isNumber(v.at) || !isString(v.method) || !isString(v.reason)) return undefined
  return { at: v.at, method: v.method, app: isString(v.app) ? v.app : null, reason: v.reason }
}

function readChange(v: unknown): RecentChange | undefined {
  if (!isObject(v) || !isNumber(v.at) || !isString(v.method)) return undefined
  return {
    at: v.at, method: v.method, app: isString(v.app) ? v.app : null, reason: isString(v.reason) ? v.reason : null,
    verified: typeof v.verified === 'boolean' ? v.verified : null,
  }
}

function readPermissions(v: unknown): Permissions | undefined {
  if (!isObject(v) || typeof v.accessibility !== 'boolean' || typeof v.screen_recording !== 'boolean') return undefined
  return {
    accessibility: v.accessibility, screen_recording: v.screen_recording,
    input_monitoring: typeof v.input_monitoring === 'boolean' ? v.input_monitoring : null,
  }
}

function readOutcome(v: unknown): LastOutcome | undefined {
  if (!isObject(v) || !isNumber(v.at) || !isString(v.kind) || !isString(v.outcome)) return undefined
  return { at: v.at, kind: v.kind, outcome: v.outcome, ...(isString(v.reason) ? { reason: v.reason } : {}) }
}

function readChords(v: unknown): Chords | undefined {
  if (!isObject(v)) return undefined
  return {
    builtin: arrayOf(v.builtin, 'chords.builtin', (c) =>
      isObject(c) && isString(c.chord) && typeof c.enabled === 'boolean' ? { chord: c.chord, enabled: c.enabled } : undefined),
    never: arrayOf(v.never, 'chords.never', (c) => (isString(c) ? c : undefined)),
    custom: arrayOf(v.custom, 'chords.custom', (c) => isObject(c) && isString(c.chord)
      ? { chord: c.chord, app: isString(c.app) ? c.app : null, note: isString(c.note) ? c.note : '' } : undefined),
  }
}

const record = (v: unknown, what: string): Record<string, unknown> => (isObject(v) ? v : fail(what))

/**
 * The snapshot the host answered, checked: every list a list of entries with the fields the tabs key on, every
 * settings group an object, the per-request facts (permissions, pending, last_outcome, picked_app, import_preview,
 * panel) of their shape or null. An optional field of an entry the daemon leaves out reads as null.
 * @param raw - `snapshot` of the route's `{ok: true, snapshot}`.
 * @throws {SnapshotError} code `bad_response`, naming the first part that is missing or of the wrong shape.
 */
export function readSnapshot(raw: unknown): Snapshot {
  const s = record(raw, 'body')
  const persistent = arrayOf(s.persistent, 'persistent', (v) => {
    const app = readApp(v)
    if (app === undefined || !isObject(v) || !isString(v.mode)) return undefined
    return { ...app, mode: v.mode, added_at: isNumber(v.added_at) ? v.added_at : 0,
      signature_ok: typeof v.signature_ok === 'boolean' ? v.signature_ok : null }
  })
  const choices = record(s.access_choices, 'access_choices')
  const pending = nullOr(s.pending, (v) => (isObject(v) && isString(v.kind) ? v as ChangeSummary : undefined))
  const permissions = nullOr(s.permissions ?? null, readPermissions)
  const lastOutcome = nullOr(s.last_outcome ?? null, readOutcome)
  const picked = nullOr(s.picked_app ?? null, readApp)
  const preview = nullOr(s.import_preview ?? null, (v) => (isObject(v) ? v : undefined))
  const panel = nullOr(s.panel ?? null, (v) => (isString(v) ? v : undefined))
  if (pending === undefined) fail('pending')
  if (permissions === undefined) fail('permissions')
  if (lastOutcome === undefined) fail('last_outcome')
  if (picked === undefined) fail('picked_app')
  if (preview === undefined) fail('import_preview')
  if (panel === undefined) fail('panel')
  return {
    started_at: isNumber(s.started_at) ? s.started_at : fail('started_at'),
    grants: arrayOf(s.grants, 'grants', readGrant),
    persistent,
    denylist: arrayOf(s.denylist, 'denylist', (v) => {
      const app = readApp(v)
      return app === undefined || !isObject(v) ? undefined : { ...app, note: isString(v.note) ? v.note : '' }
    }),
    hard_deny: arrayOf(s.hard_deny, 'hard_deny', (v) => isObject(v) && (isString(v.bundle_id) || isString(v.namespace))
      ? { ...(isString(v.bundle_id) ? { bundle_id: v.bundle_id } : { namespace: v.namespace as string }),
        name: isString(v.name) ? v.name : null, category: isString(v.category) ? v.category : '' } : undefined),
    access: record(s.access, 'access'),
    access_choices: Object.fromEntries(Object.entries(choices).map(([k, v]) => [k, Array.isArray(v) ? v : fail(`access_choices.${k}`)])),
    chords: readChords(s.chords) ?? fail('chords'),
    privacy: record(s.privacy, 'privacy'),
    behavior: record(s.behavior, 'behavior'),
    logs: record(s.logs, 'logs'),
    recent_refusals: arrayOf(s.recent_refusals, 'recent_refusals', readRefusal),
    recent_changes: arrayOf(s.recent_changes, 'recent_changes', readChange),
    permissions, pending, last_outcome: lastOutcome, picked_app: picked, import_preview: preview, panel,
  }
}

/**
 * How long until the next snapshot read.
 * @param snapshot - the last one read; null before the first, or when the last read failed and none is kept.
 * @returns SETTINGS_ACTIVE_POLL_MS while a change waits for the owner check or a panel is open, else SETTINGS_IDLE_POLL_MS.
 */
export function pollDelay(snapshot: Snapshot | null): number {
  return snapshot !== null && (snapshot.pending !== null || snapshot.panel !== null) ? SETTINGS_ACTIVE_POLL_MS : SETTINGS_IDLE_POLL_MS
}

/**
 * The app's name as the snapshot knows it: from the approvals, the always list, the deny list, the floor or the
 * picked app (the daemon names the apps it lists); null when none of them names it. Bundle IDs compare ignoring case,
 * as the daemon's do.
 */
export function appName(snapshot: Snapshot | null, bundleId: string): string | null {
  if (snapshot === null) return null
  const id = bundleId.toLowerCase()
  const apps: AppRef[] = [...snapshot.grants.flatMap((g) => g.apps), ...snapshot.persistent, ...snapshot.denylist,
    ...(snapshot.picked_app === null ? [] : [snapshot.picked_app])]
  for (const a of apps) if (a.bundle_id.toLowerCase() === id && a.name !== null) return a.name
  for (const a of snapshot.hard_deny) if (a.bundle_id?.toLowerCase() === id && a.name !== null) return a.name
  return null
}

// --- errors (stage 3b H3) ---

/** A settings route's failure: the host's `error` (`data.until`, epoch seconds, with verify_cooldown), or the page's. */
export interface SettingsFailure {
  readonly code: string
  readonly message: string
  readonly data?: { readonly until?: number }
}

/** What the host itself answers: its body check, its install task, the daemon not reachable or not verified, a bug. */
export const HOST_SETTINGS_CODES = ['bad_request', 'busy', 'not_running', 'internal', 'daemon_error'] as const

/** The daemon's refusal reasons the host passes through as the code (settings.ts KNOWN_REASONS). */
export const DAEMON_REASONS = ['verification_required', 'verify_busy', 'verify_cooldown', 'verify_unavailable',
  'verify_failed', 'verify_cancelled', 'approval_open', 'settings_unavailable', 'nothing_pending', 'settings_changed',
  'not_found', 'app_not_grantable', 'app_not_found', 'hard_denied', 'user_denied', 'invalid_chord',
  'chord_never_allowed', 'chord_builtin', 'log_directory_missing', 'invalid_params'] as const

/** The page's own: dsh refused the session, the request did not get through, the answer had the wrong shape. */
export const PAGE_SETTINGS_CODES = ['unauthorized', 'network', 'bad_response'] as const

/** Every code with its own text, `settings.error.<code>`. */
export const SETTINGS_ERROR_CODES = [...HOST_SETTINGS_CODES, ...DAEMON_REASONS, ...PAGE_SETTINGS_CODES] as const

/**
 * The text for a settings failure: its code's own text (verify_cooldown with the whole seconds left until
 * `data.until`, at least 1, or without a number when the host gave none), else the generic one with the code; the
 * host's message as the detail.
 * @param now - Date.now() at drawing time.
 * @returns the text, and whether it is not_running (the page then points to the 守护进程 tab).
 */
export function settingsErrorMessage(t: Translate, failure: SettingsFailure, now: number): Message & { readonly toDaemon: boolean } {
  const until = failure.data?.until
  const text = failure.code === 'verify_cooldown'
    ? isNumber(until) ? t('settings.error.verify_cooldown', { seconds: Math.max(1, Math.ceil(until - now / 1000)) })
      : t('settings.error.verify_cooldownUntimed')
    : (SETTINGS_ERROR_CODES as readonly string[]).includes(failure.code) ? t(`settings.error.${failure.code}`)
      : t('settings.error.unknown', { code: failure.code })
  const message = failure.message.trim()
  return { text, detail: message === '' ? null : t('settings.error.detail', { message }), toDaemon: failure.code === 'not_running' }
}

/** The text of a reason the daemon recorded (a refused outcome): its error text when the page knows it, else as is. */
export function reasonText(t: Translate, reason: string): string {
  return (DAEMON_REASONS as readonly string[]).includes(reason) && reason !== 'verify_cooldown' ? t(`settings.error.${reason}`)
    : t('settings.reasonCode', { reason })
}

// --- the words for a change, an outcome and an answer ---

/** The kinds a summary or an outcome can name, each with `settings.what.<kind>` (and, for a summary, `settings.summary.<kind>`). */
export const SUMMARY_KINDS: readonly (ChangeKind | 'logs.directory' | 'import')[] = ['revoke', 'revoke_all',
  'persistent.remove', 'persistent.add', 'persistent.mode', 'persistent.reapprove', 'deny.add', 'deny.remove',
  'access.set', 'chord.disable', 'chord.enable', 'chord.add', 'chord.remove', 'privacy.set', 'text_only.add',
  'text_only.remove', 'clipboard.set', 'behavior.set', 'logs.retention', 'logs.default_directory', 'reset',
  'logs.directory', 'import']

/** The actions an outcome or an answer can name (`settings.what.<name>`). */
export const ACTION_WHATS = ['choose_log_directory', 'use_default_log_directory', 'choose_app', 'export_settings',
  'export_audit', 'import_confirm', 'reveal_log'] as const

const ACCESS_FIELDS = ['default_mode', 'session_limit_minutes', 'dialogs_per_turn', 'dialog_timeout_seconds', 'dialog_default']
const PRIVACY_FIELDS = ['send_screenshots', 'send_ax_text', 'send_ocr', 'send_zoom']
const BEHAVIOR_FIELDS = ['restore_focus_on_turn_end', 'allow_point_targets', 'ime_policy_cap', 'electron_ax_auto', 'activation_method']

/** A short noun for what a change or an action did, for the outcome notices. */
export function whatText(t: Translate, kind: string): string {
  return (SUMMARY_KINDS as readonly string[]).includes(kind) || (ACTION_WHATS as readonly string[]).includes(kind)
    ? t(`settings.what.${kind}`) : t('settings.what.other', { kind })
}

/** An app in a sentence: its name and bundle ID, or the bundle ID alone. */
function appWords(t: Translate, snapshot: Snapshot | null, bundleId: unknown): string {
  if (!isString(bundleId)) return t('settings.app.unknown')
  const name = appName(snapshot, bundleId)
  return name === null || name === bundleId ? t('settings.app.id', { id: bundleId }) : t('settings.app.named', { name, id: bundleId })
}

const onOff = (t: Translate, on: unknown): string => t(on === true ? 'settings.value.on' : 'settings.value.off')

/** The named values of the fields that take one (settings.value.<field>.<value>). */
const NAMED_VALUES: Readonly<Record<string, readonly string[]>> = {
  default_mode: ['ask', 'read', 'full'],
  dialog_default: ['deny', 'turn', 'session', 'always'],
  ime_policy_cap: ['leave', 'ask', 'takeover'],
  activation_method: ['running_application', 'ax_frontmost', 'ax_raise'],
}

/** A field's value in words: the offered values by name, numbers with their unit; anything else as JSON. */
function valueWords(t: Translate, field: string, value: unknown): string {
  switch (field) {
    case 'default_mode': case 'dialog_default': case 'ime_policy_cap': case 'activation_method':
      if (field === 'activation_method' && value === null) return t('settings.value.activation_method.default')
      return isString(value) && NAMED_VALUES[field].includes(value) ? t(`settings.value.${field}.${value}`) : JSON.stringify(value)
    case 'session_limit_minutes': return t('settings.unit.minutes', { n: value })
    case 'dialogs_per_turn': return t('settings.unit.times', { n: value })
    case 'dialog_timeout_seconds': return t('settings.unit.seconds', { n: value })
    default: return typeof value === 'boolean' ? onOff(t, value) : JSON.stringify(value)
  }
}

/** The loosened items an import or a reset lists, joined; '—' when none. */
function loosenedWords(t: Translate, loosened: unknown): string {
  const items = Array.isArray(loosened) ? loosened.filter(isString) : []
  return items.length === 0 ? t('settings.value.none') : items.join(t('settings.listSeparator'))
}

/**
 * What a change does, in one sentence: the pending banner's line. Every kind the daemon summarizes has its own text;
 * an app is named with its bundle ID, a chord's `app` null is every approved app, an access or behavior field and its
 * value are in words. A kind this page does not know reads as the generic text with the kind.
 * @param snapshot - for the apps' names.
 */
export function summaryText(t: Translate, summary: ChangeSummary, snapshot: Snapshot | null): string {
  const s = summary
  const app = (key = 'bundle_id') => appWords(t, snapshot, s[key])
  const mode = () => (s.mode === 'read' || s.mode === 'full' ? t(`settings.mode.${s.mode}`) : String(s.mode))
  switch (s.kind) {
    case 'revoke': return t('settings.summary.revoke', { task: isString(s.task_id) ? shortTask(s.task_id) : '?' })
    case 'revoke_all': case 'logs.default_directory': return t(`settings.summary.${s.kind}`)
    case 'persistent.remove': case 'persistent.reapprove': case 'deny.remove': case 'text_only.add':
    case 'text_only.remove': return t(`settings.summary.${s.kind}`, { app: app() })
    case 'persistent.add': case 'persistent.mode': return t(`settings.summary.${s.kind}`, { app: app(), mode: mode() })
    case 'deny.add': return t('settings.summary.deny.add', { app: app() })
    case 'access.set': case 'behavior.set': {
      const fields = s.kind === 'access.set' ? ACCESS_FIELDS : BEHAVIOR_FIELDS
      const group = s.kind === 'access.set' ? 'access' : 'behavior'
      const field = isString(s.field) && fields.includes(s.field) ? t(`settings.field.${group}.${s.field}`) : String(s.field)
      return t(`settings.summary.${s.kind}`, { field, value: valueWords(t, String(s.field), s.value) })
    }
    case 'chord.disable': case 'chord.enable': return t(`settings.summary.${s.kind}`, { chord: String(s.chord) })
    case 'chord.add': case 'chord.remove':
      return t(`settings.summary.${s.kind}`, { chord: String(s.chord), app: s.app === null ? t('settings.app.everyApproved') : app('app') })
    case 'privacy.set': {
      const field = isString(s.field) && PRIVACY_FIELDS.includes(s.field) ? t(`settings.field.privacy.${s.field}`) : String(s.field)
      return t(s.on === true ? 'settings.summary.privacy.on' : 'settings.summary.privacy.off', { field })
    }
    case 'clipboard.set': return t(s.on === true ? 'settings.summary.clipboard.on' : 'settings.summary.clipboard.off')
    case 'logs.retention': return t('settings.summary.logs.retention', { days: t('settings.unit.days', { n: s.days }) })
    case 'logs.directory': return t('settings.summary.logs.directory', { directory: String(s.directory) })
    case 'reset': case 'import': return t(`settings.summary.${s.kind}`, { loosened: loosenedWords(t, s.loosened) })
    default: return t('settings.summary.other', { kind: s.kind })
  }
}

/** A task ID as dsh shows a session: without the `dsh-` prefix, its first 8 characters (the native overview's). */
export function shortTask(taskId: string): string {
  return taskId.replace('dsh-', '').slice(0, 8)
}

/** The outcomes with their own text; `refused` adds the reason. */
export const OUTCOMES = ['applied', 'done', 'verify_failed', 'verify_cancelled', 'verify_unavailable', 'cancelled', 'refused'] as const

export interface Notice {
  /** Tells one outcome from the next: dismissing a notice hides only it. */
  readonly key: string
  readonly text: string
  readonly state: 'done' | 'warning'
}

/**
 * The last settled outcome as a notice, shown once: only an outcome settled while this page was open (`at` not before
 * `since`, minus a second for the clocks' rounding), and only until it is dismissed (`dismissed`, its key) or a later
 * one replaces it. An outcome settled before the page opened is old news.
 * @param since - Date.now() when the settings view first showed.
 */
export function outcomeNotice(t: Translate, outcome: LastOutcome | null, since: number, dismissed: string | null): Notice | null {
  if (outcome === null || outcome.at < since / 1000 - 1) return null
  const key = `${outcome.at}:${outcome.kind}:${outcome.outcome}`
  if (key === dismissed) return null
  const what = whatText(t, outcome.kind)
  const known = (OUTCOMES as readonly string[]).includes(outcome.outcome)
  const text = !known ? t('settings.outcome.other', { what, outcome: outcome.outcome })
    : outcome.outcome === 'refused' ? t('settings.outcome.refused', { what, reason: reasonText(t, outcome.reason ?? '') })
      : t(`settings.outcome.${outcome.outcome}`, { what })
  return { key, text, state: outcome.outcome === 'applied' || outcome.outcome === 'done' ? 'done' : 'warning' }
}

/** A route's `result`: `status` (applied, pending, open, busy, done, cancelled), `summary` with pending, `panel` with busy. */
export interface RouteResult {
  readonly status: string
  readonly summary?: ChangeSummary
  readonly panel?: string
}

/**
 * The line shown right after an apply or an action answered: a panel opened on the Mac (to be answered there), one
 * already open (named), done or applied at once. Nothing for pending (the banner says it) and for cancelled (the
 * outcome notice does).
 * @param what - the action's name or the change's kind.
 */
export function resultText(t: Translate, what: string, result: RouteResult): string | null {
  switch (result.status) {
    case 'open': return t('settings.result.open', { what: whatText(t, what) })
    case 'busy': return t('settings.result.busy', { panel: result.panel === undefined ? '?' : whatText(t, result.panel) })
    case 'applied': case 'done': return t(`settings.result.${result.status}`, { what: whatText(t, what) })
    default: return null
  }
}
