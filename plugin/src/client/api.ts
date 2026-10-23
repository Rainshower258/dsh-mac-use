/**
 * The host's routes (PLAN-阶段2 route table): `POST api/cu-runtime.<op>`, document-relative (dsh serves the page
 * under its own base path), no body and no parameters, JSON back. dsh lets only the signed-in owner reach them.
 *
 * @module
 */

import type { Failure, Op } from './view.ts'

/** The routes besides the actions: the status, and the mode check (its cached result, or a fresh run). */
export type Route = Op | 'status' | 'modeCheck' | 'modeCheckRefresh'

/** The path a route is posted to, relative to the page. */
export const routePath = (route: Route): string => `api/cu-runtime.${route}`

/** A route that could not be reached or answered with an error; `code` picks the page's text (view.ts). */
export class RouteError extends Error implements Failure {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RouteError'
    this.code = code
  }
}

/** `{ error: { code, message } }` or `{ code, message }`, whichever the body carries. */
function failureOf(body: unknown): { code?: string; message?: string } {
  const outer = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const inner = typeof outer.error === 'object' && outer.error !== null ? outer.error as Record<string, unknown> : outer
  return {
    ...(typeof inner.code === 'string' ? { code: inner.code } : {}),
    ...(typeof inner.message === 'string' ? { message: inner.message } : {}),
  }
}

/** Whether a body says the route refused or failed: an object with `ok: false` (cancel, the actions, HTTP 500). */
const refused = (body: unknown): boolean =>
  typeof body === 'object' && body !== null && (body as Record<string, unknown>).ok === false

/**
 * Post to one route. The host answers a refusal with HTTP 200 and `{ ok: false, error: { code, message } }`, and an
 * unexpected exception with HTTP 500 and the same shape (code `internal`); a success is any other 2xx body: status,
 * install's TaskState (which has no `ok`), `{ ok: true, … }`.
 * @param route - the route's name.
 * @param signal - aborts the request (the status poll, when the page goes away).
 * @returns the parsed JSON body of a success (undefined when the body is not JSON).
 * @throws {RouteError} `network` when the request did not get through; `unauthorized` for HTTP 401/403 (dsh refused
 * the session; the host's routes never answer them); for another HTTP error, the body's code, else `http_<status>`;
 * for a 2xx body with `ok: false`, its `error.code`, else `bad_response`. The message is the body's when it has one.
 * An abort is rethrown as is.
 */
export async function post(route: Route, signal?: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(routePath(route), signal === undefined ? { method: 'POST' } : { method: 'POST', signal })
  } catch (error) {
    if (signal?.aborted === true) throw error
    throw new RouteError('network', error instanceof Error ? error.message : String(error))
  }
  const body: unknown = await response.json().catch(() => undefined)
  const failure = failureOf(body)
  if (response.status === 401 || response.status === 403) {
    throw new RouteError('unauthorized', failure.message ?? `HTTP ${response.status} ${response.statusText}`.trim())
  }
  if (!response.ok) throw new RouteError(failure.code ?? `http_${response.status}`, failure.message ?? response.statusText)
  if (refused(body)) {
    throw new RouteError(failure.code ?? 'bad_response', failure.message ?? 'the answer has ok: false and no error code')
  }
  return body
}

/**
 * Run one action route. A success is only what the host states as one: install's TaskState (an object with a string
 * `phase`) or, for every other action, `{ ok: true, … }`. Any other 2xx body (`{}`, not JSON) is `bad_response`, so the
 * page never reports a success the host did not state.
 * @param op - the action.
 * @returns the parsed body.
 * @throws {RouteError} as post(), and `bad_response` for a 2xx body that states no success.
 */
export async function act(op: Op): Promise<unknown> {
  const body = await post(op)
  const fields = typeof body === 'object' && body !== null ? body as Record<string, unknown> : undefined
  const stated = op === 'install' ? typeof fields?.phase === 'string' : fields?.ok === true
  if (!stated) throw new RouteError('bad_response', `the ${op} answer states no success`)
  return body
}

/** Any thrown value as a failure the view can show. */
export function asFailure(error: unknown): Failure {
  if (error instanceof RouteError) return { code: error.code, message: error.message }
  const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : 'unknown'
  return { code, message: error instanceof Error ? error.message : String(error) }
}
