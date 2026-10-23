import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as gate from '../lib/exec-gate.js'

// dsh's real tool registry (pre-execute waterfall, guards, dispatch); only the approval answerer is a fake.

const settle = () => new Promise((r) => setTimeout(r, 20))
const agent = { id: 'root' }

function tool(name, runs) {
  return {
    name, description: name, parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
      render: (_a, v) => [{ type: 'text', text: v.text }] },
    execute: async () => { runs[name] = (runs[name] ?? 0) + 1; return { text: 'ran' } },
  }
}

/**
 * A registry with `bash`, `pwsh`, `workflow` and an ungated `read`; `answer` is the approval outcome (or a function).
 * `sandboxMode` is what a fake `sandboxPolicy` resolves for every call (dsh's default, read-only), a function of the
 * resolve request, or null for no policy service.
 */
async function setup({ answer = 'allowed-once', approval = true, withGate = true, override, gateConfig,
  sandboxMode = 'read-only' } = {}) {
  const ctx = new Context()
  ctx.plugin(SystemPrompt)
  ctx.plugin(ToolRuntime)
  const resolves = []
  if (sandboxMode !== null) {
    ctx.plugin({ name: 'fake-sandbox-policy', apply: (c) => c.provide('sandboxPolicy', {
      resolve: (req = {}) => {
        resolves.push(req)
        return { mode: typeof sandboxMode === 'function' ? sandboxMode(req) : sandboxMode, workspaceRoot: '/w' }
      },
    }) })
  }
  const asks = []
  if (approval) {
    ctx.plugin({ name: 'fake-approval', apply: (c) => c.provide('approval', {
      request: async (req) => { asks.push(req); return typeof answer === 'function' ? answer(req) : answer },
      overrideOf: () => override,
    }) })
  }
  await settle()
  const runs = {}
  for (const name of [...gate.GATED, 'read']) ctx.tools.register(tool(name, runs))
  const fiber = withGate ? ctx.plugin(gate, gateConfig) : undefined
  await settle()
  let n = 0
  const call = (name, extra = {}) => ctx.tools.execute({ callId: `c${++n}`, name, arguments: {}, agent,
    signal: new AbortController().signal, ...extra })
  return { ctx, asks, runs, call, fiber, resolves }
}

test('the gated tools: everything in the preset that runs what the model writes', () => {
  // workflow: model-written scripts in node:vm, which dsh says is not a security boundary.
  assert.deepEqual([...gate.GATED].sort(), ['bash', 'pwsh', 'workflow'])
})

test('each gated call runs only after its own approval; the next call asks again', async () => {
  const { asks, runs, call } = await setup()
  for (const name of gate.GATED) {
    for (let i = 0; i < 2; i++) assert.equal((await call(name)).isError, false)
    assert.equal(runs[name], 2)
  }
  assert.equal(asks.length, 2 * gate.GATED.size)
  assert.ok(asks.every((a) => a.agent === agent && a.reason === gate.REASON && a.callId !== undefined))
})

test('a person who says no, or no answer, runs nothing', async () => {
  for (const answer of ['rejected', 'cancelled', 'unavailable', 'something-else']) {
    const { runs, call } = await setup({ answer })
    for (const name of gate.GATED) {
      const r = await call(name)
      assert.equal(r.isError, true, `${name} with ${answer}`)
      assert.match(r.error.message, new RegExp(`^${name} was not run: `), `${name} with ${answer}`)
    }
    assert.deepEqual(runs, {})
  }
})

test('no approval channel, no agent, or a failing one: refused (fail closed)', async () => {
  const none = await setup({ approval: false })
  assert.match((await none.call('bash')).error.message, /no approval channel/)
  const noAgent = await setup()
  assert.match((await noAgent.call('bash', { agent: undefined })).error.message, /no approval channel/)
  const throwing = await setup({ answer: () => { throw new Error('answerer crashed') } })
  assert.match((await throwing.call('bash')).error.message, /approval check failed .*answerer crashed/)
  assert.deepEqual({ ...none.runs, ...noAgent.runs, ...throwing.runs }, {})
  assert.equal(noAgent.asks.length, 0)
})

test('negative control: a listener ahead of the gate that allows without asking is refused by the guard', async () => {
  // As if dsh's waterfall no longer reached the gate's listener: it never runs, nothing is asked.
  const { ctx, asks, runs, call } = await setup()
  ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true })
  for (const name of gate.GATED) assert.match((await call(name)).error.message, /not approved/)
  assert.equal(asks.length, 0)
  assert.deepEqual(runs, {})
  assert.equal((await call('read')).isError, false, 'positive control: other tools still run')
})

test('negative control: a listener that turns the refusal into allow is refused by the guard', async () => {
  const { ctx, asks, runs, call } = await setup({ answer: 'rejected' })
  ctx.on('tools/pre-execute', async (_e, next) => { await next(); return { kind: 'allow' } }, { prepend: true })
  assert.match((await call('bash')).error.message, /not approved/)
  assert.equal(asks.length, 1)
  assert.deepEqual(runs, {})
})

test("dsh's own refusal after the gate stands without asking; its ask is folded into one question", async () => {
  const deny = await setup()
  deny.ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'sandbox says no' }))
  assert.match((await deny.call('bash')).error.message, /sandbox says no/)
  assert.equal(deny.asks.length, 0)
  const ask = await setup()
  ask.ctx.on('tools/pre-execute', async () => ({ kind: 'ask', reason: 'wants to write outside the workspace' }))
  assert.equal((await ask.call('bash')).isError, false)
  assert.equal(ask.asks.length, 1)
  assert.match(ask.asks[0].reason, /wants to write outside the workspace/)
  assert.equal(deny.runs.bash, undefined)
  assert.equal(ask.runs.bash, 1)
})

test('other tools are not asked', async () => {
  const { asks, runs, call } = await setup({ answer: 'rejected' })
  assert.equal((await call('read')).isError, false)
  assert.equal(runs.read, 1)
  assert.equal(asks.length, 0)
})

test('negative control: a tool row that injects the gate exists only while the gate runs', async () => {
  // The preset's bash row with `inject: [cuExecGate]` (install-cu-std.sh), as a stand-in plugin.
  const { ctx, runs, call } = await setup({ withGate: false })
  const bashRow = { name: 'bash-row', inject: ['tools', gate.SERVICE], apply: (c) => { c.tools.register(tool('shell', runs)) } }
  ctx.plugin(bashRow)
  await settle()
  const shell = () => call('shell')
  assert.equal((await shell()).isError, true, 'no gate: the tool is not there')
  const g = ctx.plugin(gate)
  await settle()
  assert.equal((await shell()).isError, false, 'positive control: with the gate it is there')
  await g.dispose()
  await settle()
  assert.equal((await shell()).isError, true, 'gate unloaded: the tool went with it')
  assert.equal(runs.shell, 1)
})

test('the refusal says who refused, so the model can tell the user (not "the sandbox")', async () => {
  const said = async (opts) => (await (await setup(opts)).call('bash')).error.message
  assert.equal(await said({ answer: 'rejected' }), `bash was not run: the user declined this call in the approval prompt. ${gate.WHY_ASKED}`)
  assert.match(gate.WHY_ASKED, /every bash, pwsh and workflow call, whatever it does.*not because of the sandbox or the workspace/)
  for (const answer of ['cancelled', 'unavailable']) assert.ok((await said({ answer })).endsWith(gate.WHY_ASKED), answer)
  assert.ok(!(await said({ answer: 'rejected', override: 'never' })).includes(gate.WHY_ASKED), 'never: nobody was asked')
  assert.match(await said({ answer: 'rejected', override: 'ask' }), /the user declined this call/)
  assert.match(await said({ answer: 'rejected', override: 'never' }), /approvals are off in this session, so it was refused without asking the user/)
  assert.match(await said({ answer: 'cancelled' }), /cancelled before the user answered/)
  assert.match(await said({ answer: 'unavailable' }), /no approval prompt could be shown, so the user was not asked/)
  assert.match(await said({ answer: 'something-else' }), /approval something-else/)
  for (const answer of ['cancelled', 'unavailable', 'something-else']) {
    assert.doesNotMatch(await said({ answer }), /declined/, `${answer} is not the user saying no`)
  }
})

test('commands stay in the sandbox: danger-full-access (or any mode past workspace-write) is refused, unasked', async () => {
  for (const mode of ['danger-full-access', 'some-future-mode', 7]) {
    const { asks, runs, call } = await setup()
    for (const name of ['bash', 'pwsh']) {
      const r = await call(name, { arguments: { sandbox_permissions: mode, justification: 'j' } })
      assert.equal(r.isError, true, `${name} ${mode}`)
      assert.match(r.error.message, new RegExp(`^${name} was not run: this session keeps every command inside the sandbox`))
      assert.match(r.error.message, /whatever the user would approve/)
    }
    assert.deepEqual(runs, {})
    assert.equal(asks.length, 0, 'nobody is asked for what cannot run')
  }
})

test('positive controls: a plain call is asked; an escalation is left to dsh\'s own prompt; fullAccess lets it leave the sandbox', async () => {
  // dsh asks every escalation itself, for that one call, before it runs (escalates): the gate does not ask it again.
  const { asks, runs, call } = await setup()
  assert.equal((await call('bash')).isError, false)
  assert.equal((await call('bash', { arguments: { sandbox_permissions: 'workspace-write', justification: 'j' } })).isError, false)
  assert.equal(runs.bash, 2)
  assert.equal(asks.length, 1, 'only the plain call: the escalation is dsh\'s to ask')
  const open = await setup({ gateConfig: { fullAccess: true } })
  assert.equal((await open.call('bash', { arguments: { sandbox_permissions: 'danger-full-access', justification: 'j' } })).isError, false)
  assert.equal(open.asks.length, 0, 'asked once, by dsh, not twice')
  assert.equal(gate.escalates({ name: 'bash', arguments: { sandbox_permissions: 'danger-full-access' } }, 'read-only'), true)
  assert.equal(gate.escalates({ name: 'workflow', arguments: { sandbox_permissions: 'danger-full-access' } }, 'read-only'), false)
  assert.equal(gate.escalates({ name: 'bash', arguments: {} }, 'read-only'), false)
})

// Review 2026-10-23: dsh's approveEscalation returns without asking when the requested mode is the call's current one,
// so `sandbox_permissions: <current mode>` skipped both prompts. Only a strictly wider request is left to dsh.

test('a request for the session\'s current sandbox mode is not an escalation: the gate confirms it', async () => {
  for (const mode of ['read-only', 'workspace-write']) {
    for (const confirm of ['always', 'after-screen']) {
      const { asks, runs, call } = await setup({ sandboxMode: mode, gateConfig: { confirm }, answer: 'rejected' })
      const root = { id: 'root', session: { events: [{ type: 'tool/call', data: { name: 'screen' } }], header: {} } }
      for (const name of ['bash', 'pwsh']) {
        const r = await call(name, { agent: root, arguments: { sandbox_permissions: mode, justification: 'j' } })
        assert.equal(r.isError, true, `${name} ${mode} ${confirm}`)
        assert.match(r.error.message, new RegExp(`^${name} was not run: the user declined this call`))
      }
      assert.equal(asks.length, 2, `${mode} ${confirm}: each same-mode call asked by the gate`)
      assert.deepEqual(runs, {})
    }
  }
  const ok = await setup({ sandboxMode: 'workspace-write' })
  assert.equal((await ok.call('bash', { arguments: { sandbox_permissions: 'workspace-write', justification: 'j' } })).isError, false)
  assert.equal(ok.asks.length, 1, 'positive control: approved by the gate, it runs')
  assert.equal(ok.runs.bash, 1)
})

test('a strictly wider request is left to dsh\'s escalation prompt, read against the calling session\'s mode', async () => {
  const wider = await setup({ sandboxMode: 'read-only' })
  assert.equal((await wider.call('bash', { arguments: { sandbox_permissions: 'workspace-write', justification: 'j' } })).isError, false)
  assert.equal(wider.asks.length, 0, 'read-only to workspace-write: dsh asks, the gate does not')
  assert.deepEqual(wider.resolves.at(-1), {}, 'an agent without a session resolves the deployment default, as dsh does')
  const full = await setup({ sandboxMode: 'workspace-write', gateConfig: { fullAccess: true } })
  assert.equal((await full.call('pwsh', { arguments: { sandbox_permissions: 'danger-full-access', justification: 'j' } })).isError, false)
  assert.equal(full.asks.length, 0, 'workspace-write to danger-full-access (fullAccess): dsh asks')
  // The session's own mode, not the deployment default: a session switched to workspace-write asks workspace-write.
  const switched = { id: 'root', session: { events: [], header: {} } }
  const perSession = await setup({ sandboxMode: (req) => (req.session === switched.session ? 'workspace-write' : 'read-only') })
  await perSession.call('bash', { agent: switched, arguments: { sandbox_permissions: 'workspace-write', justification: 'j' } })
  assert.equal(perSession.asks.length, 1, 'same mode as this session: the gate asks')
  assert.deepEqual(perSession.resolves.at(-1), { session: switched.session })
})

test('a current mode that cannot be read, or a malformed request, is confirmed by the gate (fail closed)', async () => {
  const req = { arguments: { sandbox_permissions: 'workspace-write', justification: 'j' } }
  const unknowns = [
    ['no sandboxPolicy service', { sandboxMode: null }],
    ['a mode that is not a string', { sandboxMode: () => 7 }],
    ['a mode outside the ladder', { sandboxMode: 'some-future-mode' }],
    ['a resolver that throws', { sandboxMode: () => { throw new Error('x') } }],
    ['the prototype is not a mode', { sandboxMode: '__proto__' }],
  ]
  for (const [what, opts] of unknowns) {
    const { asks, runs, call } = await setup(opts)
    assert.equal((await call('bash', req)).isError, false, what)
    assert.equal(asks.length, 1, `${what}: asked by the gate`)
    assert.equal(runs.bash, 1)
  }
  // Narrower than the current mode, or not a string (fullAccess, so leavesSandbox lets these through to the gate).
  for (const asked of ['read-only', 7, null, ['workspace-write']]) {
    const s = await setup({ sandboxMode: 'workspace-write', gateConfig: { fullAccess: true } })
    await s.call('bash', { arguments: { sandbox_permissions: asked, justification: 'j' } })
    assert.equal(s.asks.length, 1, `${JSON.stringify(asked)}: asked by the gate`)
  }
  assert.equal(gate.escalates({ name: 'bash', arguments: { sandbox_permissions: 'workspace-write' } }), false, 'no mode known')
  assert.equal(gate.currentModeOf({ agent: undefined }, { resolve: () => ({ mode: 'read-only' }) }), undefined, 'no agent')
})
test('workflow is not a sandbox escalation: it is gated per call as before', async () => {
  const { asks, runs, call } = await setup()
  assert.equal((await call('workflow', { arguments: { sandbox_permissions: 'danger-full-access' } })).isError, false)
  assert.equal(runs.workflow, 1)
  assert.equal(asks.length, 1)
  assert.equal(gate.leavesSandbox({ name: 'read', arguments: { sandbox_permissions: 'danger-full-access' } }), undefined)
})

test('cu-std does not offer workflow: its scripts run inside dsh, outside the sandbox', async () => {
  const { readFileSync } = await import('node:fs')
  const install = readFileSync(new URL('../../scripts/install-cu-std.sh', import.meta.url), 'utf8')
  const rows = install.match(/^for rid in \[(.*)\]:$/m)
  assert.ok(rows, 'the rows the installer switches off (dsh 0.2.0: in the standard preset row it copies)')
  for (const rid of ['tool-subagent', 'tool-bash', 'tool-pwsh', 'tool-workflow']) assert.match(rows[1], new RegExp(`'${rid}'`))
  assert.ok(gate.GATED.has('workflow'), 'still gated if a composition offers it anyway')
})

// after-screen (the maintainer 2026-10-14): bash is dsh's work horse until screen content may be in the conversation.

const callEvent = (name) => ({ type: 'tool/call', seq: 0, time: 0, data: { turn: 1, step: 1, callId: 'x', name, arguments: '{}' } })
const sessionOf = (names = [], header = {}) => ({ events: names.map(callEvent), header })

/** setup() with confirm after-screen, a root agent with a session, and a fake `agents` registry. */
async function screenSetup({ names = [], gateConfig = {}, agents = {}, ...opts } = {}) {
  const s = await setup({ ...opts, gateConfig: { confirm: 'after-screen', ...gateConfig } })
  s.ctx.provide('agents', { get: (id) => agents[id] })
  await settle()
  const root = { id: 'root', session: sessionOf(names) }
  const run = (name, extra = {}) => s.call(name, { agent: root, ...extra })
  return { ...s, root, run }
}

test('after-screen: before any screen content, bash runs under dsh\'s own rules, nobody is asked', async () => {
  const { asks, runs, run } = await screenSetup({ names: ['bash', 'read', 'subagent'], answer: 'rejected' })
  for (let i = 0; i < 3; i++) assert.equal((await run('bash')).isError, false)
  assert.equal((await run('pwsh')).isError, false)
  assert.equal(runs.bash, 3)
  assert.equal(asks.length, 0)
})

test('after-screen: once screen or any cu_* tool was called in the session, every bash call is asked', async () => {
  for (const tool of ['screen', 'cu_observe', 'cu_click']) {
    const { asks, runs, run, root } = await screenSetup()
    assert.equal((await run('bash')).isError, false, `${tool}: before`)
    root.session.events.push(callEvent(tool))
    for (let i = 0; i < 2; i++) assert.equal((await run('bash')).isError, false, `${tool}: approved`)
    assert.equal(asks.length, 2, `${tool}: each call after it asked`)
    assert.ok(asks.every((a) => a.reason === gate.REASON_SCREEN))
    assert.equal(runs.bash, 3)
  }
  const named = await screenSetup({ names: ['look'], gateConfig: { screenTool: 'look' } })
  await named.run('bash')
  assert.equal(named.asks.length, 1, 'the configured screen tool name counts')
})

test('after-screen: a declined call after screen content runs nothing and says why it was asked', async () => {
  const { runs, run } = await screenSetup({ names: ['screen'], answer: 'rejected' })
  const r = await run('bash')
  assert.equal(r.isError, true)
  assert.equal(r.error.message, `bash was not run: the user declined this call in the approval prompt. ${gate.WHY_ASKED_SCREEN}`)
  assert.deepEqual(runs, {})
})

test('after-screen: a child is asked when a session it was delegated from saw the screen; unknown lineage is asked', async () => {
  const parent = { session: sessionOf(['screen']) }
  const clean = { session: sessionOf([]) }
  const { asks, call } = await screenSetup({ agents: { p: parent, c: clean } })
  const child = (header, names = []) => ({ id: 'child', session: sessionOf(names, header) })
  assert.equal((await call('bash', { agent: child({ parentSession: 'c' }) })).isError, false)
  assert.equal(asks.length, 0, 'positive control: a clean lineage is not asked')
  await call('bash', { agent: child({ parentSession: 'p' }) })
  assert.equal(asks.length, 1, 'parent saw the screen')
  await call('bash', { agent: child({ parentSession: 'gone' }) })
  assert.equal(asks.length, 2, 'parent not live: fail closed')
  await call('bash', { agent: { id: 'no-session' } })
  assert.equal(asks.length, 3, 'no session: fail closed')
  await call('bash', { agent: { id: 'bad-log', session: { get events() { throw new Error('x') } } } })
  assert.equal(asks.length, 4, 'unreadable log: fail closed')
})

test('screenSeen: a lineage deeper than 8 counts as seen; a seen session is remembered', () => {
  const agents = {}
  for (let i = 0; i < 12; i++) agents[`s${i}`] = { session: sessionOf([], i < 11 ? { parentSession: `s${i + 1}` } : {}) }
  assert.equal(gate.screenSeen(agents.s0, { get: (id) => agents[id] }), true)
  assert.equal(gate.screenSeen(agents.s5, { get: (id) => agents[id] }), false, 'positive control: 6 hops to the root')
  const memo = new WeakSet()
  const a = { session: sessionOf(['cu_zoom']) }
  assert.equal(gate.screenSeen(a, undefined, 'screen', memo), true)
  assert.ok(memo.has(a.session))
})

test('after-screen: escalations are dsh\'s to ask, before and after screen content; workflow is always asked', async () => {
  for (const names of [[], ['screen']]) {
    const open = await screenSetup({ names, gateConfig: { fullAccess: true } })
    assert.equal((await open.run('bash', { arguments: { sandbox_permissions: 'danger-full-access', justification: 'j' } })).isError, false)
    assert.equal(open.asks.length, 0, `seen ${names.length > 0}: not asked a second time`)
  }
  const shut = await screenSetup()
  const r = await shut.run('bash', { arguments: { sandbox_permissions: 'danger-full-access', justification: 'j' } })
  assert.match(r.error.message, /keeps every command inside the sandbox/)
  assert.equal(shut.asks.length, 0, 'without fullAccess: refused, unasked')
  const wf = await screenSetup({ answer: 'rejected' })
  const w = await wf.run('workflow')
  assert.equal(w.error.message, `workflow was not run: the user declined this call in the approval prompt. ${gate.WHY_ASKED_WORKFLOW}`)
  assert.equal(wf.asks[0].reason, gate.REASON_WORKFLOW)
})
test('off: screen content does not make bash ask; workflow still is', async () => {
  const { asks, runs, run } = await screenSetup({ names: ['screen'], gateConfig: { confirm: 'off', fullAccess: true } })
  assert.equal((await run('bash')).isError, false)
  assert.equal(asks.length, 0)
  await run('bash', { arguments: { sandbox_permissions: 'danger-full-access', justification: 'j' } })
  await run('workflow')
  assert.equal(asks.length, 1, 'workflow only: the escalation is dsh\'s')
  assert.equal(runs.bash, 2)
})
test('an unknown confirm mode is always (fail closed)', async () => {
  for (const confirm of ['sometimes', 7, null]) {
    const { asks, run } = await screenSetup({ gateConfig: { confirm } })
    await run('bash')
    assert.equal(asks.length, 1, String(confirm))
    assert.equal(asks[0].reason, gate.REASON)
  }
})

test('negative control (after-screen): a listener ahead of the gate cannot let a call through once the screen was seen', async () => {
  const tainted = await screenSetup({ names: ['screen'] })
  tainted.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true })
  assert.match((await tainted.run('bash')).error.message, /not approved/)
  assert.deepEqual(tainted.runs, {})
  const clean = await screenSetup()
  clean.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true })
  assert.equal((await clean.run('bash')).isError, false, 'positive control: nothing to confirm, so the guard lets it run')
  const fwd = await screenSetup({ names: ['screen'], gateConfig: { fullAccess: true } })
  fwd.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true })
  assert.match((await fwd.run('workflow')).error.message, /not approved/, 'workflow is always confirmed, guard included')
})

test('cu-std (P3, 2026-10-16) leaves bash to dsh (confirm off) and full access per call; the gate itself defaults to always', async () => {
  const { readFileSync } = await import('node:fs')
  const patch = readFileSync(new URL('../../profiles/cu-std/cordis.patch.yml.in', import.meta.url), 'utf8')
  const row = patch.match(/- id: cu-exec-gate\n((?: {6}.*\n)+)/)
  assert.ok(row, 'the gate row has a config')
  assert.match(row[1], /confirm: "off"/)
  assert.match(row[1], /fullAccess: true/)
  assert.equal(gate.causeOf({ name: 'bash', agent: {} }, {}, () => false), 'always')
})

// VM 2026-10-14: dsh 0.1.5's Session has snapshotEvents() and no `events` getter; reading `events` alone counted every
// session as having seen the screen, so after-screen asked from the first command. These use dsh's real Session.

test('screenSeen reads the log of dsh\'s real Session (0.2.0): clean is clean, a screen or cu_* call is seen', async () => {
  const { Session } = await import('@deepseek-ai/dsh-session')
  const ev = (seq, type, data) => ({ type, seq, time: 0, data })
  const start = [ev(0, 'turn/start', { turn: 1 }), ev(1, 'step/start', { turn: 1, step: 1 })]
  const call = (name) => ev(2, 'tool/call', { turn: 1, step: 1, callId: 'c1', name, arguments: '{}' })
  assert.equal('events' in Session.create('probe'), false, 'the API this guards against')
  assert.equal(gate.screenSeen({ session: Session.create('clean') }, undefined), false)
  assert.equal(gate.screenSeen({ session: Session.create('bash', [...start, call('bash')]) }, undefined), false)
  for (const name of ['screen', 'cu_observe']) {
    assert.equal(gate.screenSeen({ session: Session.create(name, [...start, call(name)]) }, undefined), true, name)
  }
  // A child of a parent that saw the screen, through the header dsh writes.
  const parent = Session.create('p', [...start, call('screen')])
  const child = Session.create('c', [], { version: 4, id: 'c', createdAt: 0, isSeeded: false, parentSession: 'p', origin: 'subagent' })
  assert.equal(gate.screenSeen({ session: child }, { get: (id) => (id === 'p' ? { session: parent } : undefined) }), true)
  assert.equal(gate.screenSeen({ session: child }, { get: () => ({ session: Session.create('p2') }) }), false)
})

test('after-screen with dsh\'s real Session: the first command of a clean session runs unasked', async () => {
  const { Session } = await import('@deepseek-ai/dsh-session')
  const s = await setup({ gateConfig: { confirm: 'after-screen' }, answer: 'rejected' })
  const root = { id: 'root', session: Session.create('real') }
  assert.equal((await s.call('bash', { agent: root })).isError, false)
  assert.equal(s.asks.length, 0)
})

test('why it was asked reads as a wait for the user, never as calls already approved', () => {
  for (const why of [gate.WHY_ASKED, gate.WHY_ASKED_SCREEN, gate.WHY_ASKED_WORKFLOW]) {
    assert.match(why, /waits for the user to approve that one call/)
    assert.match(why, /Nothing is approved in advance\./)
    assert.doesNotMatch(why, /user approves every/)
  }
})
