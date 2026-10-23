/**
 * Automatic retries (PLAN-v2 R4): only refusals the daemon classes `after_delay` (refused before anything ran,
 * transient), at most 3 times, after 0.5 / 1 / 2 s. Everything else goes back to the model; `outcome_unknown`
 * is never retried because the action may already have happened. A watchdog timeout of a method that may act
 * (mayAct) is `outcome_unknown` whatever class the daemon sent (a daemon before 2026-10-23 sent `after_delay` for
 * `apps.launch`, and the same file or URL was opened up to 4 times).
 *
 * @module
 */
import { RpcError } from "./client.js";
export const RETRY_DELAYS_MS = [500, 1000, 2000];
/** Methods whose effect may outlast a timeout: every `act.*`, and `apps.launch` (the daemon's Server.mayHaveActed). */
export function mayAct(method) {
    return method !== undefined && (method.startsWith('act.') || method === 'apps.launch');
}
export async function withRetry(attempt, options = {}) {
    const delays = options.delays ?? RETRY_DELAYS_MS;
    const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    for (let i = 0;; i++) {
        try {
            return await attempt();
        }
        catch (e) {
            if (e instanceof RpcError && e.reason === 'request_timeout' && mayAct(options.method)
                && e.retry !== 'outcome_unknown') {
                throw new RpcError(e.code, e.message, { ...e.data, retry: 'outcome_unknown', action_may_have_executed: true, executed: null });
            }
            if (!(e instanceof RpcError) || e.retry !== 'after_delay' || i >= delays.length)
                throw e;
            if (options.report !== undefined)
                options.report.retries = i + 1;
            await sleep(delays[i]);
        }
    }
}
