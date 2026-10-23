/**
 * Automatic retries (PLAN-v2 R4): only refusals the daemon classes `after_delay` (refused before anything ran,
 * transient), at most 3 times, after 0.5 / 1 / 2 s. Everything else goes back to the model; `outcome_unknown`
 * is never retried because the action may already have happened.
 *
 * @module
 */

import { RpcError } from './client.ts'

export const RETRY_DELAYS_MS = [500, 1000, 2000] as const

export interface RetryReport {
  /** Retries done (0 when the first attempt settled it). */
  retries: number
}

export async function withRetry<T>(
  attempt: () => Promise<T>,
  options: { delays?: readonly number[], sleep?: (ms: number) => Promise<void>, report?: RetryReport } = {},
): Promise<T> {
  const delays = options.delays ?? RETRY_DELAYS_MS
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  for (let i = 0; ; i++) {
    try {
      return await attempt()
    } catch (e) {
      if (!(e instanceof RpcError) || e.retry !== 'after_delay' || i >= delays.length) throw e
      if (options.report !== undefined) options.report.retries = i + 1
      await sleep(delays[i]!)
    }
  }
}
