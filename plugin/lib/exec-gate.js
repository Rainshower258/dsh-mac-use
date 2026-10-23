/**
 * B prototype (cu-std): calls of a tool that runs commands or code (bash, pwsh, workflow) wait for the person's
 * approval of that one call, in dsh's own approval UI. Which calls (`confirm`):
 * - `always` (the default here, so a gate loaded without config stays strict): every one;
 * - `after-screen` (cu-std's default 2026-10-14 to 10-16, now an option): once screen content may be in the
 *   conversation (screenSeen), every one; before that, bash runs under dsh's standard rules;
 * - `off` (cu-std's setting since 2026-10-16: the official dsh keeps bash and computer use apart, and the per-call
 *   confirmation cost more than it caught): none for that reason.
 * Whatever the mode, every workflow call is asked. A bash or pwsh call that escalates its sandbox mode to one strictly
 * wider than the session's current mode is asked by dsh itself, once, and not again here (escalates); one that names
 * the current mode, or whose current mode cannot be read, is not an escalation dsh asks, so it is confirmed here.
 *
 * Fails closed three ways:
 * - Not loaded: it provides the `cuExecGate` service only once both checks below are registered, and cu-std loads bash
 *   at the profile level with a row that injects that service (profiles/cu-std/cordis.patch.yml.in; the preset's bash,
 *   pwsh and workflow rows are off: workflow runs inside dsh's process, outside the sandbox). Without the gate dsh
 *   refuses to start ("entry did not activate"); when the gate unloads, bash stops with it. workflow stays in GATED, so
 *   a composition that offers it anyway still asks per call.
 * - Bypassed: a monotonic `tools.guard` refuses every gated call this gate did not see approved, so a listener
 *   earlier in the `tools/pre-execute` waterfall that allows without calling `next()`, or turns the answer into
 *   allow, gets a refusal, and so does a dsh whose waterfall no longer reaches this listener.
 * - Broken: no approval service, no agent, any outcome but `allowed-once`, or an error is a refusal.
 *
 * And keeps commands inside the sandbox: a bash or pwsh call that asks for a mode wider than workspace-write
 * (`sandbox_permissions: danger-full-access`, which dsh runs without any sandbox, so without scripts/cu-sandbox-runner
 * and its fence around the daemon) is refused before anyone is asked (VM 2026-10-11: refused by the runner, the model
 * sent the same command again with danger-full-access, and two approvals later it listed the daemon's state dir).
 * Only `fullAccess: true` in the gate's config allows it, and then dsh's escalation prompt asks the user for that call.
 *
 * @module cu-runtime-plugin/exec-gate
 */
export const name = 'cu-exec-gate';
export const inject = ['tools'];
/** The tools that run what the model writes: shell commands, and workflow scripts (not a sandbox: dsh's README). */
export const GATED = new Set(['bash', 'pwsh', 'workflow']);
/** The service the gated rows inject. */
export const SERVICE = 'cuExecGate';
export const REASON = 'cu-std：屏幕内容可能已进入对话，每条命令都要你确认后才执行。'
    + ' Screen text may be in this conversation: every command runs only after you approve it.';
export const REASON_SCREEN = 'cu-std：这次对话里已经有屏幕内容（screen 的回答），从现在起每条命令都要你确认后才执行。'
    + ' Screen content is in this conversation now: from here on every command runs only after you approve it.';
export const REASON_WORKFLOW = 'cu-std：workflow 脚本在 dsh 进程里运行，不在沙箱内，确认后才执行。'
    + ' Workflow scripts run inside dsh, outside the sandbox: this one runs only after you approve it.';
/** The delegation tool whose answers bring screen content to its caller (cu-std: `screen`); cu_* tools always do. */
export const SCREEN_TOOL = 'screen';
/**
 * The session's log, or undefined when it cannot be read. dsh 0.1.5 has `snapshotEvents()` and no `events` (VM
 * 2026-10-14: reading `events` alone found no log, so every session counted as having seen the screen).
 */
function logOf(session) {
    const log = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events;
    return Array.isArray(log) ? log : undefined;
}
/**
 * Whether screen content may be in the conversation of this agent: its session's log, or the log of a session it was
 * delegated from (a child's task was written by a parent that may have read the screen), holds a call of the screen
 * tool or of any cu_* tool. The log, not a flag in memory: a resumed or forked session carries its history, and
 * so does a dsh that restarted. Unknown is yes (fail closed): no session, a log that cannot be read, a parent that is
 * not live, a lineage deeper than 8.
 */
export function screenSeen(agent, agents, screenTool = SCREEN_TOOL, seen) {
    let session = agent?.session;
    for (let hops = 0; hops < 8; hops++) {
        if (session === undefined || session === null || typeof session !== 'object')
            return true;
        if (seen?.has(session) === true)
            return true;
        let events;
        try {
            events = logOf(session);
        }
        catch {
            return true;
        }
        if (events === undefined)
            return true;
        const hit = events.some((e) => e?.type === 'tool/call' && typeof e.data?.name === 'string'
            && (e.data.name === screenTool || e.data.name.startsWith('cu_')));
        if (hit) {
            seen?.add(session); // the log is append-only: once seen, always seen
            return true;
        }
        const parent = session.header?.parentSession;
        if (parent === undefined)
            return false;
        session = agents?.get?.(parent)?.session;
    }
    return true;
}
/**
 * Who refused, in words the model can repeat (VM 2026-10-10: "approval rejected" was told to the user as "the
 * sandbox refused"). `rejected` is the person's answer unless the session's policy is never, which refuses without
 * asking (dsh-user-approval); cu-std leaves the configured policy at its default, ask, so only the session's own
 * setting (overrideOf: a delegated subagent's, or one the user switched) can make it never.
 */
export function refusal(outcome, never, cause = 'always') {
    if (outcome === 'rejected' && never)
        return 'approvals are off in this session, so it was refused without asking the user';
    const said = outcome === 'rejected' ? 'the user declined this call in the approval prompt'
        : outcome === 'cancelled' ? 'the approval request was cancelled before the user answered'
            : outcome === 'unavailable' ? 'no approval prompt could be shown, so the user was not asked'
                : `approval ${outcome}`;
    // Why it was asked at all (VM 2026-10-11: the model guessed "outside the workspace").
    return `${said}. ${WHY[cause]}`;
}
/**
 * Every gated call is asked, whatever it does; not the file sandbox or the workspace. Worded as a wait, never as
 * "the user approves every call" (VM 2026-10-14: the model read that as "all bash calls are approved" and, rightly,
 * distrusted the refusal as an injection).
 */
const NOTHING_AHEAD = 'Nothing is approved in advance.';
export const WHY_ASKED = 'In this session every bash, pwsh and workflow call, whatever it does, waits for the user to '
    + `approve that one call (not because of the sandbox or the workspace). ${NOTHING_AHEAD}`;
export const WHY_ASKED_SCREEN = 'Screen content is in this conversation, so from now on every bash, pwsh and workflow '
    + 'call, whatever it does, waits for the user to approve that one call (not because of the sandbox or the '
    + `workspace). ${NOTHING_AHEAD}`;
export const WHY_ASKED_WORKFLOW = 'Every workflow call waits for the user to approve that one call: its script runs '
    + `inside dsh, outside the sandbox. ${NOTHING_AHEAD}`;
const WHY = { always: WHY_ASKED, screen: WHY_ASKED_SCREEN, workflow: WHY_ASKED_WORKFLOW };
const REASONS = { always: REASON, screen: REASON_SCREEN, workflow: REASON_WORKFLOW };
/** The escalation targets that stay inside the sandbox; anything else (danger-full-access, a future mode) is refused. */
export const CONFINED_MODES = new Set(['read-only', 'workspace-write']);
/** Why a call asks to leave the sandbox, or undefined when it stays inside. */
export function leavesSandbox(exec) {
    if (exec.name !== 'bash' && exec.name !== 'pwsh')
        return undefined;
    const asked = exec.arguments?.sandbox_permissions;
    if (asked === undefined || (typeof asked === 'string' && CONFINED_MODES.has(asked)))
        return undefined;
    return `${exec.name} was not run: this session keeps every command inside the sandbox, so sandbox_permissions `
        + `${JSON.stringify(asked)} is not available here, whatever the user would approve. Tell the user what could not `
        + 'be done inside the sandbox.';
}
/**
 * The strictly-wider ladder of dsh-sandbox (`WIDER_MODES`): what a call whose current mode is the key may escalate to.
 * dsh's `approveEscalation` asks the user only for these; a request for the current mode runs without asking (review
 * 2026-10-23: `sandbox_permissions: workspace-write` in a workspace-write session skipped both prompts).
 */
export const WIDER_MODES = {
    'read-only': ['workspace-write', 'danger-full-access'],
    'workspace-write': ['danger-full-access'],
};
/**
 * The sandbox mode dsh's bash and pwsh resolve for this call: `ctx.sandboxPolicy.resolve({ session })`, the session's
 * last `sandbox/mode` override or the deployment default (dsh-sandbox-policy; dsh-tool-bash and dsh-tool-pwsh call the
 * same resolver). Undefined when it cannot be read: no policy service, no agent, an error, a mode that is not a string.
 */
export function currentModeOf(exec, policy) {
    try {
        if (exec.agent === undefined || exec.agent === null)
            return undefined;
        const session = exec.agent.session;
        const mode = policy?.resolve?.(session === undefined ? {} : { session })?.mode;
        return typeof mode === 'string' ? mode : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * A bash or pwsh call that asks for a sandbox mode strictly wider than the session's current one (`currentMode`).
 * dsh's escalation goes through its approval service for exactly those, for that one call, before anything runs
 * (dsh-tool-bash, dsh-sandbox's approveEscalation; outcomes are allowed-once or a refusal, no session-wide allow), and a
 * session whose policy is never refuses it unasked. So the gate does not ask it a second time (VM test, 2026-10-14:
 * the same `cp` to the Desktop was asked twice). Anything else is not left to dsh (fail closed): the current mode
 * requested again, which dsh runs unasked, a narrower or unknown mode, a value that is not a string, or a current mode
 * that cannot be read.
 */
export function escalates(exec, currentMode) {
    if (exec.name !== 'bash' && exec.name !== 'pwsh')
        return false;
    const asked = exec.arguments?.sandbox_permissions;
    if (typeof asked !== 'string' || currentMode === undefined || !Object.hasOwn(WIDER_MODES, currentMode))
        return false;
    return WIDER_MODES[currentMode].includes(asked);
}
/**
 * Why this call must wait for the person, or undefined: none for a strictly wider escalation, which dsh asks itself
 * (escalates, against `currentMode`: the session's mode, undefined when unknown; past workspace-write it needs
 * fullAccess, else it is refused before this). Unknown confirm modes are always.
 */
export function causeOf(exec, config, seen, currentMode) {
    if (!GATED.has(exec.name) || escalates(exec, currentMode?.(exec)))
        return undefined;
    const mode = config.confirm === 'after-screen' || config.confirm === 'off' ? config.confirm : 'always';
    if (mode === 'always')
        return 'always';
    if (exec.name === 'workflow')
        return 'workflow';
    if (mode === 'after-screen' && seen(exec.agent))
        return 'screen';
    return undefined;
}
function policyIsNever(approval, agent) {
    try {
        const session = agent?.session;
        return approval.overrideOf?.(session) === 'never';
    }
    catch {
        return false;
    }
}
export function apply(ctx, config = {}) {
    // Approved executions, by the registry's own execution object (frozen, one per call): one approval, one run.
    const approved = new WeakSet();
    const outside = (exec) => (config.fullAccess === true ? undefined : leavesSandbox(exec));
    // Sessions known to hold screen content, and one decision per execution: the listener and the guard must agree
    // even if a screen call lands in between (whichever looks first decides; the model wrote the call before either).
    const seenSessions = new WeakSet();
    const seen = (agent) => screenSeen(agent, ctx.get('agents'), config.screenTool ?? SCREEN_TOOL, seenSessions);
    const causes = new WeakMap();
    // The same resolver and session dsh's bash and pwsh read when the call runs.
    const currentMode = (exec) => currentModeOf(exec, ctx.get('sandboxPolicy'));
    const causeFor = (exec) => {
        if (!causes.has(exec))
            causes.set(exec, causeOf(exec, config, seen, currentMode) ?? null);
        return causes.get(exec) ?? undefined;
    };
    ctx.tools.guard((exec) => {
        if (!GATED.has(exec.name))
            return undefined;
        const refused = outside(exec);
        if (refused !== undefined)
            return refused;
        if (causeFor(exec) !== undefined && !approved.has(exec)) {
            return `${exec.name} runs only after the user approves this call (cu-exec-gate); it was not approved`;
        }
        return undefined;
    });
    ctx.on('tools/pre-execute', async (exec, next) => {
        if (!GATED.has(exec.name))
            return next();
        const refused = outside(exec);
        if (refused !== undefined)
            return { kind: 'deny', reason: refused };
        try {
            const cause = causeFor(exec);
            // Nothing to confirm: dsh's standard rules (its sandbox, its escalation prompt) decide alone.
            if (cause === undefined)
                return next();
            // dsh's own checks first (its sandbox escalation asks there): a refusal stands without asking.
            const inner = await next();
            if (inner.kind === 'deny')
                return inner;
            const approval = ctx.get('approval');
            if (approval === undefined || exec.agent === undefined) {
                return { kind: 'deny', reason: `${exec.name} needs the user's approval of each call, and no approval channel is available` };
            }
            const base = REASONS[cause];
            const reason = inner.kind === 'ask' && inner.reason !== undefined ? `${base}\n${inner.reason}` : base;
            const outcome = await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, reason,
                signal: exec.signal });
            if (outcome !== 'allowed-once') {
                return { kind: 'deny', reason: `${exec.name} was not run: ${refusal(outcome, policyIsNever(approval, exec.agent), cause)}` };
            }
            approved.add(exec);
            return { kind: 'allow' };
        }
        catch (e) {
            return { kind: 'deny', reason: `${exec.name} was not run: the approval check failed (${String(e)})` };
        }
    });
    ctx.provide(SERVICE, { gated: [...GATED] });
}
