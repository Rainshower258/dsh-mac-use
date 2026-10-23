import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'
import * as host from '../lib/host.js'

// The bundle's mode (cordis.patch.yml at the repository root): its cu-runtime row, the daemon never reached here.
const MODE = { apps: [], appApproval: 'dialog', electronAx: true, imePolicy: 'ask', imeApproval: 'call',
  restoreFocus: true, autoStart: false, onlyCuTools: true, stateDir: '/nonexistent' }

const tool = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
    render: (_a, v) => [{ type: 'text', text: v.text }] },
  execute: async () => ({ text: 'ran' }) })

// The real prompt and tool registries, a real agent scope, the host's own tools beside the plugin's.
async function mode(config) {
  const { createScope, scopeTarget } = await import('@deepseek-ai/dsh-scope')
  const ctx = new Context()
  ctx.plugin(SystemPrompt)
  ctx.plugin(ToolRuntime)
  await new Promise((r) => setTimeout(r, 20))
  for (const name of ['working_directory', 'bash']) ctx.tools.register(tool(name))
  const warnings = []
  const fiber = ctx.plugin({ inject: ['tools', 'systemPrompt'], apply: (c) => {
    c.logger.warn = (m) => { warnings.push(m) }
    c.plugin(plugin, config)
  } })
  await new Promise((r) => setTimeout(r, 20))
  // dsh: an agent's id is its session's.
  const agent = { id: 's1', session: { id: 's1' } }
  await new Promise((resolve) => ctx.plugin({ inject: ['tools', 'systemPrompt'], apply: (loop) => {
    agent.ctx = createScope(loop, agent).ctx
    resolve()
  } }))
  const tools = async () => (await ctx.systemPrompt.assemble({ agent, scope: agent })).tools.map((t) => t.name)
  const created = () => ctx.emit(scopeTarget(ctx, agent), 'agent/created', { agent, source: 'new' })
  const preStep = () => ctx.waterfall(scopeTarget(ctx, agent), 'agent/pre-step',
    { agent, messages: [], turn: 1, step: 2, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
  const sessionEvent = (type) => ctx.emit(scopeTarget(ctx, agent), 'session/event', agent.session, { type })
  return { ctx, fiber, agent, tools, created, preStep, sessionEvent, warnings }
}

test('onlyCuTools: from the first step the mode\'s agent sees the cu_* tools and none of the host\'s', async () => {
  const m = await mode(MODE)
  assert.ok((await m.tools()).includes('bash'), 'before agent/created the host tools are there')
  m.created()
  const names = await m.tools()
  assert.ok(names.length > 5 && names.every((n) => n.startsWith('cu_')), `tools: ${names}`)
  assert.deepEqual(m.warnings, [])
})

test('onlyCuTools: a new session\'s agent moved into the mode (no agent/created) loses the host tools at agent-preset/selected or turn/start, before its first step', async () => {
  for (const type of ['agent-preset/selected', 'turn/start']) {
    // appApproval none: no turn marks sent to a daemon here.
    const m = await mode({ ...MODE, appApproval: 'none' })
    m.ctx.provide('agents')
    m.ctx.set('agents', { get: (id) => (id === m.agent.id ? m.agent : undefined) })
    m.sessionEvent('agent/inbox/spliced')
    assert.ok((await m.tools()).includes('bash'), 'other session events change nothing')
    m.sessionEvent(type)
    const names = await m.tools()
    assert.ok(names.length > 5 && names.every((n) => n.startsWith('cu_')), `${type}: ${names}`)
    assert.deepEqual(m.warnings, [])
  }
})

test('onlyCuTools: a host tool added later is denied before the next step', async () => {
  const m = await mode(MODE)
  m.created()
  m.ctx.tools.register(tool('mcp_read_resource'))
  assert.ok((await m.tools()).includes('mcp_read_resource'))
  assert.equal((await m.preStep()).kind, 'enter', 'the step goes on')
  assert.ok((await m.tools()).every((n) => n.startsWith('cu_')))
})

test('onlyCuTools: a tool of the agent\'s own scope cannot be denied; it is named, and exclusive refuses the cu_* calls', async () => {
  const m = await mode(MODE)
  m.agent.ctx.tools.register(tool('preset_helper'))
  m.created()
  const names = await m.tools()
  assert.ok(names.includes('preset_helper') && !names.includes('bash'), `tools: ${names}`)
  assert.equal(m.warnings.length, 1)
  assert.match(m.warnings[0], /preset_helper stays visible next to the cu_\* tools/)
  const r = await m.ctx.tools.execute({ callId: 'c1', name: 'cu_observe', arguments: {}, agent: m.agent,
    signal: new AbortController().signal })
  assert.equal(r.isError, true)
  assert.match(JSON.stringify(r.content), /other tools \(preset_helper\).*电脑操作/)
})

test('positive control: without onlyCuTools (cu-desktop, the bench) the host tools stay', async () => {
  const m = await mode({ ...MODE, onlyCuTools: false })
  m.created()
  const names = await m.tools()
  assert.ok(names.includes('bash') && names.includes('working_directory'), `tools: ${names}`)
})

test('onlyCuTools with hideFromRoot is refused at load', async () => {
  const ctx = new Context()
  ctx.plugin(SystemPrompt)
  ctx.plugin(ToolRuntime)
  await new Promise((r) => setTimeout(r, 20))
  const fiber = ctx.plugin(plugin, { ...MODE, hideFromRoot: true })
  await new Promise((r) => setTimeout(r, 20))
  assert.match(String(fiber._error), /onlyCuTools and hideFromRoot exclude each other/)
})

test('config: onlyCuTools is off unless set', () => {
  assert.equal(plugin.Config({ electronAx: false }).onlyCuTools, false)
})

test('the host row stops a dsh without a profile context (0.1.5) and names the supported range and 9c6f36d', () => {
  const asked = []
  const at = (services) => ({ get: (name) => services[name], effect: () => {}, inject: (deps) => { asked.push(deps) } })
  assert.throws(() => host.apply(at({})), (e) => e.message === host.UNSUPPORTED_DSH)
  assert.deepEqual(asked, [], 'nothing else is done on 0.1.5')
  assert.match(host.UNSUPPORTED_DSH, />=0\.2\.0-rc\.2 <0\.3\.0.*9c6f36d/)
  assert.equal(host.apply(at({ profileContext: { name: 'web' } })), undefined)
  assert.deepEqual(asked, [['connection']], 'the page routes wait for dsh\'s connection')
})
