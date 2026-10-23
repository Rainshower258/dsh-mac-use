/**
 * The plugin page's routes, registered on dsh's connection: exact routes
 * under /api that only the signed-in owner reaches (dsh answers 401/403 to anyone else). Each is POST and answers JSON
 * with cache-control no-store. Every route but settings.apply takes no parameter: the request's body and query are
 * never read. The page calls them with `fetch('api/cu-runtime.<op>', { method: 'POST' })`; the model's tools never do.
 *
 * | route | answer |
 * |---|---|
 * | status | Status (manager.ts) |
 * | install | TaskState: the task started, or the running one joined |
 * | cancel | { ok, error, task } |
 * | permissions, start, stop, restart, selfcheck, clt, acceptIdentity | ActionResult { ok, error } |
 * | settings.snapshot | { ok: true, snapshot } or { ok: false, error } |
 * | settings.apply | { ok: true, result: {status: applied} or {status: pending, summary} } or { ok: false, error } |
 * | settings.cancelVerify, settings.action.<name> (each of settings.ts SETTINGS_ACTIONS) | { ok: true, result } or { ok: false, error } |
 * | modeCheck | { ok: true, result: ModeCheckResult } (mode-check.ts): the cached result, or a fresh run when there is none or it is older than CACHE_MS |
 * | modeCheckRefresh | { ok: true, result: ModeCheckResult }: a fresh run (while one is in flight, that one) |
 *
 * The mode check's result is wrapped in `{ ok: true, result }` since the result's own `ok` (false when a profile
 * fails or is skipped) is not the route's outcome; an unexpected host error answers HTTP 500 `internal`.
 *
 * The settings routes reach the daemon through settings.ts's facade, after the manager's
 * settingsGate: `busy` while the install task stops, replaces or starts the daemon, `not_running` unless the verified
 * installed app runs (or the daemon cannot be reached). settings.apply's body is checked first (readApplyRequest): any
 * failure answers HTTP 400 `bad_request` and nothing reaches the gate or the daemon. A daemon refusal is passed as
 * settings.ts settingsError maps it; an unexpected host error answers HTTP 500 `internal`. Every other error answers
 * HTTP 200 with ok false.
 *
 * @module
 */
import { BadRequest, clipMessage, readApplyRequest, SETTINGS_ACTIONS, SettingsFailure } from "./settings.js";
export const ROUTE_PREFIX = '/api/cu-runtime.';
/** Operation name → what it does; nothing from the request reaches it. */
export function operations(manager) {
    return {
        status: () => manager.status(),
        install: () => manager.install(),
        cancel: () => manager.cancel(),
        permissions: () => manager.permissions(),
        start: () => manager.start(),
        stop: () => manager.stop(),
        restart: () => manager.restart(),
        selfcheck: () => manager.selfCheck(),
        clt: () => manager.installClt(),
        acceptIdentity: () => manager.acceptIdentity(),
    };
}
/** The mode check's routes: route name → what it runs; nothing from the request reaches it. */
export function modeCheckOperations(modeCheck) {
    return {
        modeCheck: async () => ({ ok: true, result: await modeCheck.get() }),
        modeCheckRefresh: async () => ({ ok: true, result: await modeCheck.refresh() }),
    };
}
const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
/** A settings route's unexpected host error: HTTP 500, the message clipped. */
const internal = (e) => json({ ok: false, error: { code: 'internal',
        message: clipMessage(String(e instanceof Error ? e.message : e)) } }, 500);
/** The settings routes without a parameter: route name → what it asks the daemon; nothing from the request reaches it. */
export function settingsOperations(settings) {
    const ops = {
        'settings.snapshot': async () => ({ key: 'snapshot', value: await settings.snapshot() }),
        'settings.cancelVerify': async () => ({ key: 'result', value: await settings.cancelVerify() }),
    };
    for (const name of SETTINGS_ACTIONS)
        ops[`settings.action.${name}`] = async () => ({ key: 'result', value: await settings.action(name) });
    return ops;
}
/** Registers every operation; the routes go away with the context that registered them (dsh's connection). */
export function registerRoutes(connection, manager, settings, modeCheck) {
    const register = (op, fetch) => connection.fetch.register({
        path: `${ROUTE_PREFIX}${op}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch,
    });
    for (const [op, run] of Object.entries({ ...operations(manager), ...modeCheckOperations(modeCheck) })) {
        register(op, async () => {
            try {
                return json(await run());
            }
            catch (e) {
                return json({ ok: false, error: { code: 'internal', message: String(e instanceof Error ? e.message : e) } }, 500);
            }
        });
    }
    /** The gate, then the daemon: { ok: true, <key>: value } or { ok: false, error }. */
    const settle = async (send) => {
        const refused = await manager.settingsGate();
        if (refused !== null)
            return json({ ok: false, error: { code: refused.code, message: clipMessage(refused.message) } });
        try {
            const { key, value } = await send();
            return json({ ok: true, [key]: value });
        }
        catch (e) {
            if (e instanceof SettingsFailure)
                return json({ ok: false, error: e.error });
            throw e;
        }
    };
    for (const [op, run] of Object.entries(settingsOperations(settings))) {
        register(op, async () => {
            try {
                return await settle(run);
            }
            catch (e) {
                return internal(e);
            }
        });
    }
    register('settings.apply', async (request) => {
        try {
            let change;
            try {
                change = await readApplyRequest(request);
            }
            catch (e) {
                if (e instanceof BadRequest)
                    return json({ ok: false, error: { code: 'bad_request', message: clipMessage(e.message) } }, 400);
                throw e;
            }
            return await settle(async () => ({ key: 'result', value: await settings.apply(change) }));
        }
        catch (e) {
            return internal(e);
        }
    });
}
