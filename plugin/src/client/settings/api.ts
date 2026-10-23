/**
 * The settings routes (daemon/routes.ts), document-relative like the daemon tab's:
 * `POST api/cu-runtime.settings.snapshot`, `.settings.apply` (the one with a body), `.settings.cancelVerify` and
 * `.settings.action.<name>`. dsh lets only the signed-in owner reach them; each one has the host check the daemon
 * (codesign) before it asks it anything.
 *
 * @module
 */

import type { SettingsAction, SettingsChange } from './change.ts'
import { readSnapshot, type RouteResult, type SettingsFailure, type Snapshot } from './model.ts'

/** The header the host requires on settings.apply (a plain form or a cross-site request cannot send it). */
export const PAGE_HEADER = 'x-cu-runtime-page'

export type SettingsRoute = 'settings.snapshot' | 'settings.apply' | 'settings.cancelVerify' | `settings.action.${SettingsAction}`

/** The path a settings route is posted to, relative to the page, as the daemon tab's routes are (api.ts routePath). */
export const settingsPath = (route: SettingsRoute): string => `api/cu-runtime.${route}`

/** A settings route that could not be reached or answered with an error; `code` picks the text (model.ts). */
export class SettingsRouteError extends Error implements SettingsFailure {
  readonly code: string
  readonly data?: { readonly until?: number }

  constructor(code: string, message: string, data?: { readonly until?: number }) {
    super(message)
    this.name = 'SettingsRouteError'
    this.code = code
    if (data !== undefined) this.data = data
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The body's `error` as a failure: its code, message, and `data.until` when it is a finite number. */
function errorOf(body: unknown): { code?: string; message?: string; data?: { until: number } } {
  const error = isObject(body) && isObject(body.error) ? body.error : {}
  const until = isObject(error.data) ? error.data.until : undefined
  return {
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
    ...(typeof error.message === 'string' ? { message: error.message } : {}),
    ...(typeof until === 'number' && Number.isFinite(until) ? { data: { until } } : {}),
  }
}

/**
 * Post to one settings route and take the value under `key` of its `{ok: true, <key>: value}`.
 * @param body - settings.apply's `{change}`, sent as JSON with content-type application/json and PAGE_HEADER 1;
 * every other route is posted with no body and no header.
 * @param signal - aborts the request (the snapshot poll, when the settings tabs go away).
 * @throws {SettingsRouteError} `network` when the request did not get through; `unauthorized` for HTTP 401/403;
 * another HTTP error by the body's code (bad_request 400, internal 500), else `http_<status>`; `{ok: false, error}`
 * by its code, message and data; a 2xx body without `ok: true` and an object under `key` is `bad_response`. An
 * abort is rethrown as is.
 */
async function postSettings(route: SettingsRoute, key: 'snapshot' | 'result', body?: { change: SettingsChange },
  signal?: AbortSignal): Promise<Record<string, unknown>> {
  const init: RequestInit = body === undefined ? { method: 'POST' }
    : { method: 'POST', headers: { 'content-type': 'application/json', [PAGE_HEADER]: '1' }, body: JSON.stringify(body) }
  if (signal !== undefined) init.signal = signal
  let response: Response
  try {
    response = await fetch(settingsPath(route), init)
  } catch (error) {
    if (signal?.aborted === true) throw error
    throw new SettingsRouteError('network', error instanceof Error ? error.message : String(error))
  }
  const answer: unknown = await response.json().catch(() => undefined)
  const failure = errorOf(answer)
  if (response.status === 401 || response.status === 403) {
    throw new SettingsRouteError('unauthorized', failure.message ?? `HTTP ${response.status} ${response.statusText}`.trim())
  }
  if (!response.ok) throw new SettingsRouteError(failure.code ?? `http_${response.status}`, failure.message ?? response.statusText, failure.data)
  if (isObject(answer) && answer.ok === false) {
    throw new SettingsRouteError(failure.code ?? 'bad_response', failure.message ?? 'the answer has ok: false and no error code', failure.data)
  }
  if (!isObject(answer) || answer.ok !== true || !isObject(answer[key])) {
    throw new SettingsRouteError('bad_response', `the ${route} answer has no ${key}`)
  }
  return answer[key]
}

function readResult(route: SettingsRoute, raw: Record<string, unknown>): RouteResult {
  if (typeof raw.status !== 'string') throw new SettingsRouteError('bad_response', `the ${route} result has no status`)
  return {
    status: raw.status,
    ...(isObject(raw.summary) && typeof raw.summary.kind === 'string' ? { summary: raw.summary as RouteResult['summary'] } : {}),
    ...(typeof raw.panel === 'string' ? { panel: raw.panel } : {}),
  }
}

/** The daemon's settings, checked (model.ts readSnapshot). */
export async function fetchSnapshot(signal?: AbortSignal): Promise<Snapshot> {
  try {
    return readSnapshot(await postSettings('settings.snapshot', 'snapshot', undefined, signal))
  } catch (error) {
    if (error instanceof Error && !(error instanceof SettingsRouteError) && (error as { code?: unknown }).code === 'bad_response') {
      throw new SettingsRouteError('bad_response', error.message)
    }
    throw error
  }
}

/** One change: `{status: applied}` at once, or `{status: pending, summary}` until the owner check settles it. */
export async function applyChange(change: SettingsChange): Promise<RouteResult> {
  return readResult('settings.apply', await postSettings('settings.apply', 'result', { change }))
}

/** Ends the pending change's owner check (`nothing_pending` when none waits). */
export async function cancelVerify(): Promise<RouteResult> {
  return readResult('settings.cancelVerify', await postSettings('settings.cancelVerify', 'result'))
}

/** One daemon action: `{status: open}` (a panel on the Mac), `busy` with the open panel, `applied` or `done`. */
export async function runAction(name: SettingsAction): Promise<RouteResult> {
  const route: SettingsRoute = `settings.action.${name}`
  return readResult(route, await postSettings(route, 'result'))
}

/** Any thrown value as a failure the tabs can show. */
export function asSettingsFailure(error: unknown): SettingsFailure {
  if (error instanceof SettingsRouteError) {
    return { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
  }
  const code = isObject(error) && typeof error.code === 'string' ? error.code : 'unknown'
  return { code, message: error instanceof Error ? error.message : String(error) }
}
