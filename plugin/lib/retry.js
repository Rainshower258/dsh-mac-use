/**
 * Automatic retries (PLAN-v2 R4): only refusals the daemon classes `after_delay` (refused before anything ran,
 * transient), at most 3 times, after 0.5 / 1 / 2 s. Everything else goes back to the model; `outcome_unknown`
 * is never retried because the action may already have happened.
 *
 * @module
 */
import { RpcError } from "./client.js";
export const RETRY_DELAYS_MS = [500, 1000, 2000];
export async function withRetry(attempt, options = {}) {
    const delays = options.delays ?? RETRY_DELAYS_MS;
    const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    for (let i = 0;; i++) {
        try {
            return await attempt();
        }
        catch (e) {
            if (!(e instanceof RpcError) || e.retry !== 'after_delay' || i >= delays.length)
                throw e;
            if (options.report !== undefined)
                options.report.retries = i + 1;
            await sleep(delays[i]);
        }
    }
}
