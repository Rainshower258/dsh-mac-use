/**
 * The daemon's settings for the plugin page: a narrow facade over the
 * tools row's CURuntimeClient (snapshot, apply, action, cancelVerify, nothing else), the check of settings.apply's body
 * that mirrors the daemon's SettingsChange.decode, and the mapping of the daemon's answers and refusals to what the page
 * is shown. routes.ts registers the routes; the daemon checks every change again, decides itself whether it loosens and
 * verifies the person itself.
 *
 * Rules kept here:
 * - Only the daemon's `settings.snapshot`, `settings.apply {change}`, `settings.cancel_verify` and
 *   `settings.action {name}` are ever called, `name` one of SETTINGS_ACTIONS; no method or name comes from a request.
 * - A change reaches the daemon only as a fresh object built from the fields validateChange accepted, never the parsed
 *   body: no key the daemon does not take (`verified`, `path`, `directory`, `state_dir`…) can ride along.
 * - Each operation opens one connection to the daemon's socket in the fixed state dir (paths.ts stateDir), with no
 *   autoStart and a bounded timeout, and closes it when the answer is in (the daemon allows 4 connections).
 * - Nothing here opens, reveals or reads a path it got from the page or the daemon.
 *
 * @module
 */

import { DaemonUnavailable, RpcError } from '../client.ts'

/** The daemon client the facade uses, the part of CURuntimeClient it needs. */
export interface SettingsClient {
  request(method: string, params?: Record<string, unknown>, signal?: AbortSignal, options?: { start?: boolean }): Promise<unknown>
  close(): void
}

/**
 * Makes one client per operation (default: a CURuntimeClient). The facade passes the fixed state dir and its timeout,
 * and never an autoStart: the host never starts the daemon to read or change its settings.
 */
export type SettingsClientFactory = (options: { stateDir: string, timeoutMs: number }) => SettingsClient

/** How long one settings request may take (the daemon's own watchdog is 30 s; its settings answers are immediate). */
export const SETTINGS_TIMEOUT_MS = 15_000

/** The daemon's settings.action names (Dispatcher.settingsActions), one route each. */
export const SETTINGS_ACTIONS = ['choose_log_directory', 'use_default_log_directory', 'choose_app', 'export_settings',
  'export_audit', 'import', 'import_confirm', 'reveal_log'] as const
export type SettingsAction = typeof SETTINGS_ACTIONS[number]

/** The snapshot's top-level keys that reach the page; any other key the daemon answers with is dropped. */
export const SNAPSHOT_KEYS = ['started_at', 'grants', 'persistent', 'denylist', 'hard_deny', 'access', 'access_choices',
  'chords', 'privacy', 'behavior', 'logs', 'recent_refusals', 'recent_changes', 'permissions', 'pending', 'last_outcome',
  'picked_app', 'import_preview', 'panel'] as const

/** The keys of an apply, cancelVerify or action answer that reach the page (the daemon answers with no other). */
export const RESULT_KEYS = ['status', 'summary', 'panel'] as const

/**
 * The refusal reasons the page knows: passed through as the error code. Any other reason, and any other daemon
 * error, is daemon_error.
 */
export const KNOWN_REASONS: ReadonlySet<string> = new Set(['verification_required', 'verify_busy', 'verify_cooldown',
  'verify_unavailable', 'verify_failed', 'verify_cancelled', 'approval_open', 'settings_unavailable', 'nothing_pending',
  'settings_changed', 'not_found', 'app_not_grantable', 'app_not_found', 'hard_denied', 'user_denied', 'invalid_chord',
  'chord_never_allowed', 'chord_builtin', 'log_directory_missing', 'invalid_params'])

/** JSON-RPC's invalid params: the daemon's answer to a change it does not decode (RPCFailure without a reason). */
const INVALID_PARAMS = -32602
/** A message to the page is clipped to this many characters. */
export const MESSAGE_MAX = 300

export interface SettingsError {
  code: string
  message: string
  data?: { until: number }
}

/** One settings request ended without an answer to pass on; `error` is what the page is shown. */
export class SettingsFailure extends Error {
  constructor(readonly error: SettingsError) {
    super(error.message)
    this.name = 'SettingsFailure'
  }
}

export function clipMessage(message: string): string {
  return message.length > MESSAGE_MAX ? `${message.slice(0, MESSAGE_MAX - 1)}…` : message
}

/**
 * What the page is shown for an error the daemon client threw: not_running when the daemon could not be reached (a
 * fixed message: the client's names the state dir); the refusal's reason when the page knows it (verify_cooldown with
 * data.until, epoch seconds, when the daemon gave a finite number), invalid_params for a change the daemon did not
 * decode, and daemon_error for anything else (another reason, another JSON-RPC error, no answer in time). The message
 * is the daemon's, clipped.
 */
export function settingsError(e: unknown): SettingsError {
  if (e instanceof DaemonUnavailable) return { code: 'not_running', message: 'the cu-runtime daemon cannot be reached' }
  if (e instanceof RpcError) {
    const reason = e.reason ?? (e.code === INVALID_PARAMS ? 'invalid_params' : undefined)
    const code = reason !== undefined && KNOWN_REASONS.has(reason) ? reason : 'daemon_error'
    const error: SettingsError = { code, message: clipMessage(e.message) }
    const until = e.data.until
    if (code === 'verify_cooldown' && typeof until === 'number' && Number.isFinite(until)) error.data = { until }
    return error
  }
  return { code: 'daemon_error', message: clipMessage(String(e instanceof Error ? e.message : e)) }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The object's own values under these keys, those it has. */
function pick(o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (Object.hasOwn(o, k)) out[k] = o[k]
  return out
}

/**
 * The narrow facade over the daemon's settings methods. Every method opens one client from the factory, sends
 * one request without starting the daemon, closes the client whatever happened, and either returns what the page gets
 * or throws a SettingsFailure (settingsError); an answer of an unexpected shape is daemon_error.
 */
export class DaemonSettings {
  private readonly stateDir: string
  private readonly makeClient: SettingsClientFactory
  private readonly timeoutMs: number

  constructor(options: { stateDir: string, client: SettingsClientFactory, timeoutMs?: number }) {
    this.stateDir = options.stateDir
    this.makeClient = options.client
    this.timeoutMs = options.timeoutMs ?? SETTINGS_TIMEOUT_MS
  }

  /** The daemon's snapshot with only SNAPSHOT_KEYS kept. */
  async snapshot(): Promise<Record<string, unknown>> {
    return pick(this.object(await this.call('settings.snapshot', {})), SNAPSHOT_KEYS)
  }

  /** Sends a change validateChange built (`{status: applied}` or `{status: pending, summary}`). */
  async apply(change: SettingsChange): Promise<Record<string, unknown>> {
    return this.result(await this.call('settings.apply', { change }))
  }

  async cancelVerify(): Promise<Record<string, unknown>> {
    return this.result(await this.call('settings.cancel_verify', {}))
  }

  async action(name: SettingsAction): Promise<Record<string, unknown>> {
    // The type says so; this keeps a name from anywhere else from ever reaching the daemon.
    if (!(SETTINGS_ACTIONS as readonly string[]).includes(name)) throw new Error(`not a settings action: ${String(name)}`)
    return this.result(await this.call('settings.action', { name }))
  }

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const client = this.makeClient({ stateDir: this.stateDir, timeoutMs: this.timeoutMs })
    try {
      return await client.request(method, params, undefined, { start: false })
    } catch (e) {
      throw new SettingsFailure(settingsError(e))
    } finally {
      client.close()
    }
  }

  private object(answer: unknown): Record<string, unknown> {
    if (!isObject(answer)) throw new SettingsFailure({ code: 'daemon_error', message: 'the daemon gave an answer of an unexpected shape' })
    return answer
  }

  /** An answer with a string `status`, RESULT_KEYS kept. */
  private result(answer: unknown): Record<string, unknown> {
    const o = this.object(answer)
    if (typeof o.status !== 'string') {
      throw new SettingsFailure({ code: 'daemon_error', message: 'the daemon gave an answer without a status' })
    }
    return pick(o, RESULT_KEYS)
  }
}

// ------------------------------------------------------------------------------------------------ settings.apply's body

/** The request header the page sends with settings.apply (a plain form or a cross-site request cannot). */
export const PAGE_HEADER = 'x-cu-runtime-page'
/** settings.apply's body, at most (by content-length when present and by the bytes read). */
export const MAX_APPLY_BYTES = 4096

/** SettingsChange's limits (SettingsChange.maxBundleID, maxNote, maxChord, maxTaskID), in characters. */
export const LIMITS = { bundleID: 255, note: 200, chord: 64, taskID: 255 } as const

/** A change as the daemon decodes it: `kind` and exactly that kind's keys. */
export type SettingsChange = { kind: string } & Record<string, string | number | boolean | null>

/** The keys each kind takes besides `kind` (SettingsChange.keys): exactly these, no more, no fewer. */
export const CHANGE_KEYS: Readonly<Record<string, readonly string[]>> = {
  'revoke': ['task_id'],
  'revoke_all': [],
  'persistent.remove': ['bundle_id'],
  'persistent.add': ['bundle_id', 'mode'],
  'persistent.mode': ['bundle_id', 'mode'],
  'persistent.reapprove': ['bundle_id'],
  'deny.add': ['bundle_id', 'note'],
  'deny.remove': ['bundle_id'],
  'access.set': ['field', 'value'],
  'chord.disable': ['chord'],
  'chord.enable': ['chord'],
  'chord.add': ['chord', 'app', 'note'],
  'chord.remove': ['chord', 'app'],
  'privacy.set': ['field', 'on'],
  'text_only.add': ['bundle_id'],
  'text_only.remove': ['bundle_id'],
  'clipboard.set': ['on'],
  'behavior.set': ['field', 'value'],
  'logs.retention': ['days'],
  'logs.default_directory': [],
  'reset': [],
}

/** AppMode's raw values (persistent.add, persistent.mode). */
const APP_MODES = ['read', 'full']
/** access.set's fields and the values each takes (DefaultMode, AccessDefaults' choices, DialogDefault). */
const ACCESS_VALUES: Readonly<Record<string, readonly (string | number)[]>> = {
  default_mode: ['ask', 'read', 'full'],
  session_limit_minutes: [15, 30, 60],
  dialogs_per_turn: [1, 2, 3],
  dialog_timeout_seconds: [60, 120, 180],
  dialog_default: ['deny', 'turn', 'session', 'always'],
}
/** PrivacyField's raw values (privacy.set). */
const PRIVACY_FIELDS = ['send_screenshots', 'send_ax_text', 'send_ocr', 'send_zoom']
/**
 * behavior.set's fields: 'bool' takes true or false, a list one of its values (ChangePolicy, ActivationMethod);
 * activation_method also takes null (the daemon's default).
 */
const BEHAVIOR_VALUES: Readonly<Record<string, 'bool' | readonly string[]>> = {
  restore_focus_on_turn_end: 'bool',
  allow_point_targets: 'bool',
  ime_policy_cap: ['leave', 'ask', 'takeover'],
  electron_ax_auto: 'bool',
  activation_method: ['running_application', 'ax_frontmost', 'ax_raise'],
}
/** LogSettings.retentionChoices (logs.retention). */
const RETENTION_DAYS = [7, 30, 90]

/** settings.apply's body did not pass; the message names the key, never echoing a long value. */
export class BadRequest extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequest'
  }
}

/** Unicode's general categories Cc and Cf: Foundation's CharacterSet.controlCharacters. */
const CONTROL = /[\p{Cc}\p{Cf}]/u
/** The White_Space property: Swift's Character.isWhitespace. */
const WHITESPACE = /\p{White_Space}/u
/** A UTF-16 surrogate standing alone. */
const SURROGATE = /\p{Cs}/u
/** Nothing but Zs and tab: what CharacterSet.whitespaces trims to empty. */
const BLANK = /^[\p{Zs}\t]*$/u

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
/** Swift's String.count: extended grapheme clusters. */
function characters(s: string): number {
  let n = 0
  for (const _ of graphemes.segment(s)) n++
  return n
}

const shown = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s)

/** Reads one change's fields as SettingsChange.decode's ChangeFields does; every refusal is a BadRequest. */
class Fields {
  constructor(private readonly kind: string, private readonly o: Record<string, unknown>) {}

  string(key: string): string {
    const v = this.o[key]
    if (typeof v !== 'string') throw new BadRequest(`${this.kind}: ${key} must be a string`)
    // A lone surrogate (JSON's \ud800) is no character the daemon decodes.
    if (SURROGATE.test(v)) throw new BadRequest(`${this.kind}: ${key} is not valid Unicode text`)
    return v
  }

  text(key: string, max: number, allowEmpty = false): string {
    const s = this.string(key)
    if (characters(s) > max) throw new BadRequest(`${this.kind}: ${key} is longer than ${max} characters`)
    if (CONTROL.test(s)) throw new BadRequest(`${this.kind}: ${key} contains a control character`)
    if (!allowEmpty && BLANK.test(s)) throw new BadRequest(`${this.kind}: ${key} is empty`)
    return s
  }

  bundleID(key = 'bundle_id'): string {
    const s = this.text(key, LIMITS.bundleID)
    if (WHITESPACE.test(s)) throw new BadRequest(`${this.kind}: ${key} contains a space`)
    return s
  }

  optionalBundleID(key: string): string | null {
    return this.o[key] === null ? null : this.bundleID(key)
  }

  bool(key: string): boolean {
    const v = this.o[key]
    if (typeof v !== 'boolean') throw new BadRequest(`${this.kind}: ${key} must be true or false`)
    return v
  }

  /** A whole number among the choices (a JSON 30.0 is 30, as Int(exactly:) takes it). */
  int(key: string, choices: readonly number[]): number {
    const v = this.o[key]
    if (typeof v !== 'number' || !Number.isInteger(v) || !choices.includes(v)) {
      throw new BadRequest(`${this.kind}: ${key} must be one of ${choices.join(', ')}`)
    }
    return v
  }

  choice(key: string, values: readonly string[]): string {
    const v = this.o[key]
    if (typeof v !== 'string' || !values.includes(v)) throw new BadRequest(`${this.kind}: ${key} must be one of ${values.join(', ')}`)
    return v
  }
}

/**
 * The change of a settings.apply, checked as strictly as SettingsChange.decode checks it: an object with a string
 * `kind` in CHANGE_KEYS and exactly that kind's keys; strings, booleans and whole numbers where they belong; only the
 * values the page offers; bundle IDs 1–255 characters with no whitespace or control character; notes up to 200
 * characters with no control character (empty allowed); chords 1–64 and task IDs 1–255 characters with no control
 * character, not blank. Returns a fresh object (`kind` first, then the kind's keys in CHANGE_KEYS' order) holding only
 * the validated values; throws a BadRequest otherwise.
 */
export function validateChange(value: unknown): SettingsChange {
  if (!isObject(value)) throw new BadRequest('change must be an object with a kind')
  const kind = value.kind
  if (typeof kind !== 'string') throw new BadRequest('change: kind must be a string')
  if (!Object.hasOwn(CHANGE_KEYS, kind)) throw new BadRequest(`unknown kind "${shown(kind)}"`)
  const expected = CHANGE_KEYS[kind]
  const given = Object.keys(value).filter((k) => k !== 'kind')
  const extra = given.filter((k) => !expected.includes(k)).sort()
  if (extra.length > 0) throw new BadRequest(`${kind} takes no ${extra.slice(0, 5).map(shown).join(', ')}`)
  const missing = expected.filter((k) => !given.includes(k)).sort()
  if (missing.length > 0) throw new BadRequest(`${kind} needs ${missing.join(', ')}`)
  const f = new Fields(kind, value)
  const out: SettingsChange = { kind }
  switch (kind) {
    case 'revoke':
      out.task_id = f.text('task_id', LIMITS.taskID)
      break
    case 'persistent.remove': case 'persistent.reapprove': case 'deny.remove': case 'text_only.add': case 'text_only.remove':
      out.bundle_id = f.bundleID()
      break
    case 'persistent.add': case 'persistent.mode':
      out.bundle_id = f.bundleID()
      out.mode = f.choice('mode', APP_MODES)
      break
    case 'deny.add':
      out.bundle_id = f.bundleID()
      out.note = f.text('note', LIMITS.note, true)
      break
    case 'access.set': {
      const field = f.choice('field', Object.keys(ACCESS_VALUES))
      const values = ACCESS_VALUES[field]
      out.field = field
      out.value = typeof values[0] === 'number' ? f.int('value', values as readonly number[]) : f.choice('value', values as readonly string[])
      break
    }
    case 'chord.disable': case 'chord.enable':
      out.chord = f.text('chord', LIMITS.chord)
      break
    case 'chord.add':
      out.chord = f.text('chord', LIMITS.chord)
      out.app = f.optionalBundleID('app')
      out.note = f.text('note', LIMITS.note, true)
      break
    case 'chord.remove':
      out.chord = f.text('chord', LIMITS.chord)
      out.app = f.optionalBundleID('app')
      break
    case 'privacy.set':
      out.field = f.choice('field', PRIVACY_FIELDS)
      out.on = f.bool('on')
      break
    case 'clipboard.set':
      out.on = f.bool('on')
      break
    case 'behavior.set': {
      const field = f.choice('field', Object.keys(BEHAVIOR_VALUES))
      const values = BEHAVIOR_VALUES[field]
      out.field = field
      if (values === 'bool') out.value = f.bool('value')
      else if (field === 'activation_method' && value.value === null) out.value = null
      else out.value = f.choice('value', values)
      break
    }
    case 'logs.retention':
      out.days = f.int('days', RETENTION_DAYS)
      break
    default:   // revoke_all, logs.default_directory, reset: no key besides kind
      break
  }
  return out
}

/** Whether the content-type names JSON (`application/json`, parameters such as charset allowed). */
function isJson(contentType: string | null): boolean {
  return contentType !== null && contentType.split(';')[0].trim().toLowerCase() === 'application/json'
}

/** The body's bytes, at most `max`: a body longer than that is refused as soon as more has been read. */
async function readAtMost(request: Request, max: number): Promise<Uint8Array> {
  if (request.body === null) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new BadRequest(`the body is larger than ${max} bytes`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.byteLength
  }
  return bytes
}

/**
 * settings.apply's request: the PAGE_HEADER header with the value 1; a JSON content-type; content-length, when
 * present, a whole number of at most MAX_APPLY_BYTES, and at most that many bytes read; UTF-8 text that is a JSON object
 * with exactly one key, `change`, which validateChange accepts. Returns the fresh change; throws a BadRequest
 * otherwise. Nothing of the request but these headers and the body is read.
 */
export async function readApplyRequest(request: Request): Promise<SettingsChange> {
  if (request.headers.get(PAGE_HEADER) !== '1') throw new BadRequest(`the ${PAGE_HEADER} header is missing`)
  if (!isJson(request.headers.get('content-type'))) throw new BadRequest('the content-type must be application/json')
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length.trim()) || Number(length.trim()) > MAX_APPLY_BYTES)) {
    throw new BadRequest(`the body is larger than ${MAX_APPLY_BYTES} bytes`)
  }
  const bytes = await readAtMost(request, MAX_APPLY_BYTES)
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new BadRequest('the body is not JSON')
  }
  if (!isObject(body)) throw new BadRequest('the body must be an object with one key, change')
  const keys = Object.keys(body)
  if (keys.length !== 1 || keys[0] !== 'change') throw new BadRequest('the body must be an object with one key, change')
  return validateChange(body.change)
}
