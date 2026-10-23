import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CURuntimeClient, DaemonUnavailable, RpcError } from '../lib/client.js'
import { withRetry, RETRY_DELAYS_MS } from '../lib/retry.js'
import { ElementBook, renderElement } from '../lib/elements.js'
import { defineCuTools, Tasks, explain } from '../lib/tools.js'
import { Config } from '../lib/index.js'

// ---------------------------------------------------------------- fake daemon over a real socket

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj))
  const h = Buffer.alloc(4); h.writeUInt32LE(body.length)
  return Buffer.concat([h, body])
}

async function fakeDaemon(handler) {
  const dir = mkdtempSync(join(tmpdir(), 'cur-'))
  writeFileSync(join(dir, 'token'), 'tok123\n')
  const seen = []
  const server = createServer((sock) => {
    let buf = Buffer.alloc(0)
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c])
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
        const len = buf.readUInt32LE(0)
        const msg = JSON.parse(buf.subarray(4, 4 + len)); buf = buf.subarray(4 + len)
        seen.push(msg)
        const out = msg.method === 'session.hello'
          ? (msg.params.token === 'tok123' ? { result: { protocol: 'x' } } : { error: { code: -32001, message: 'bad token' } })
          : handler(msg)
        sock.write(frame({ jsonrpc: '2.0', id: msg.id, ...out }))
      }
    })
  })
  await new Promise((r) => server.listen(join(dir, 'daemon.sock'), r))
  return { dir, seen, close: () => server.close() }
}

test('client says hello with the token, returns results and typed refusals', async () => {
  const d = await fakeDaemon((m) => m.method === 'runtime.ping' ? { result: { pong: true } }
    : { error: { code: -32010, message: 'no', data: { reason: 'hit_test_failed', retry: 'after_observe', executed: false } } })
  const c = new CURuntimeClient({ stateDir: d.dir })
  assert.deepEqual(await c.request('runtime.ping'), { pong: true })
  assert.equal(d.seen[0].method, 'session.hello')
  assert.equal(d.seen[0].params.token, 'tok123')
  await assert.rejects(c.request('act.click', {}), (e) => e instanceof RpcError && e.reason === 'hit_test_failed' && e.retry === 'after_observe')
  c.close(); d.close()
})

test('an unreachable daemon is a clear error with the way to start it, and nothing is spawned', async () => {
  const c = new CURuntimeClient({ stateDir: mkdtempSync(join(tmpdir(), 'cur-none-')) })
  await assert.rejects(c.request('runtime.ping'), (e) => e instanceof DaemonUnavailable && /open -a CURuntime/.test(e.message) && /never spawns it/.test(e.message))
})

// ---------------------------------------------------------------- retry policy

const refusal = (retry) => new RpcError(-32010, 'x', { reason: 'r', retry })

test('only after_delay is retried: 3 times, 0.5/1/2 s', async () => {
  const waits = []
  let n = 0
  const report = { retries: 0 }
  const v = await withRetry(async () => { if (++n < 4) throw refusal('after_delay'); return 'ok' },
    { sleep: async (ms) => { waits.push(ms) }, report })
  assert.equal(v, 'ok')
  assert.deepEqual(waits, [...RETRY_DELAYS_MS])
  assert.deepEqual(waits, [500, 1000, 2000])
  assert.equal(report.retries, 3)

  n = 0
  await assert.rejects(withRetry(async () => { n++; throw refusal('after_delay') }, { sleep: async () => {} }))
  assert.equal(n, 4, 'one attempt plus three retries, then give up')

  for (const cls of ['outcome_unknown', 'after_observe', 'never', undefined]) {
    n = 0
    await assert.rejects(withRetry(async () => { n++; throw refusal(cls) }, { sleep: async () => {} }))
    assert.equal(n, 1, `${cls} is never retried`)
  }
})

// ---------------------------------------------------------------- stable ids and diffs

const el = (id, key, text, extra = {}) => ({ id, key, source: 'ax', text, frame_pt: [10, 20, 30, 40], occluded: false, role: 'AXButton', ...extra })

test('first observe lists everything; then only changes, and unchanged ids map to the new snapshot', () => {
  const b = new ElementBook()
  const d1 = b.update([el('a1', 'aaaaaaaaaaaa', 'Send'), el('a2', 'bbbbbbbbbbbb', 'Cancel')], 1, false)
  assert.equal(d1.full, true)
  assert.deepEqual(d1.shown.map((e) => e.sid), ['eaaaaaaa', 'ebbbbbbb'])
  const d2 = b.update([el('a7', 'aaaaaaaaaaaa', 'Send'), el('a8', 'cccccccccccc', 'Retry')], 2, false)
  assert.equal(d2.full, false)
  assert.deepEqual(d2.shown.map((e) => e.sid), ['eccccccc'])
  assert.deepEqual(d2.removed, ['ebbbbbbb'])
  assert.equal(d2.unchanged, 1)
  assert.deepEqual(b.resolve('eaaaaaaa'), { daemonId: 'a7', gen: 2 }, 'same element, current snapshot id')
  assert.equal(b.resolve('ebbbbbbb'), undefined, 'gone: unknown, never silently re-pointed')
  assert.equal(b.update([el('a9', 'aaaaaaaaaaaa', 'Send')], 3, true).full, true)
})

test('rendering marks OCR, occlusion and interceptors', () => {
  const line = renderElement({ ...el('o3', 'dddddddddddd', 'hi', { source: 'ocr', confidence: 0.912, occluded: true, intercepted_by: 'com.x' }), sid: 'oddddddd' })
  assert.match(line, /^oddddddd "hi" @10,20,30,40 \[ocr 0\.91, occluded, clicks here go to com\.x\]$/)
})

// ---------------------------------------------------------------- tools against a fake client

/** dsh's settings service as the plugin reads it: locale.preference only (lang.ts). */
const localeSettings = (preference) => ({ get: (ns) => (ns === 'locale' ? { preference } : undefined) })

function harness({ approval, responses = {}, config = {}, onCall, settings = localeSettings('zh'), services = {} } = {}) {
  const calls = []
  const client = {
    async request(method, params) {
      calls.push({ method, params })
      onCall?.(method, params)
      const r = responses[method]
      if (typeof r === 'function') return r(params)
      if (r instanceof Error) throw r
      return r ?? {}
    },
  }
  const ctx = { get: (name) => (name in services ? services[name] : name === 'approval' ? approval : name === 'settings' ? settings : undefined) }
  const tasks = new Tasks({ apps: ['dev.dsh.bench.fixture'], electronAx: false, grantTtlS: 600, ...config })
  const tools = Object.fromEntries(defineCuTools({ ctx, client, tasks, sleep: async () => {} }).map((t) => [t.name, t]))
  const exec = { agent: { session: { id: 's1', requestHeader: () => undefined }, options: {} }, name: 'x', callId: 'c1', signal: new AbortController().signal }
  return { calls, tools, exec, tasks }
}

const observed = {
  snapshot_gen: 5, frontmost: 'dev.dsh.bench.fixture',
  windows: [{ app: 'dev.dsh.bench.fixture', frame_pt: [0, 0, 800, 600] }],
  untrusted_observation: { elements: [el('a3', 'aaaaaaaaaaaa', 'Send')] }, capture: {},
}

test('the first call grants the configured apps and warms up; element ids map to the latest snapshot', async () => {
  const h = harness({ responses: { observe: observed, 'act.click': { executed: true, via: 'ax' } } })
  const out = await h.tools.cu_observe.execute({}, h.exec)
  assert.match(out.text, /untrusted observation/)
  assert.match(out.text, /eaaaaaaa "Send"/)
  assert.deepEqual(h.calls.slice(0, 2).map((c) => c.method), ['grants.set', 'observe'])
  assert.deepEqual(h.calls[0].params.bundle_ids, ['dev.dsh.bench.fixture'])
  assert.equal(h.calls[0].params.source, 'config')
  assert.equal(h.calls[0].params.task_id, 'dsh-s1')
  assert.equal(h.calls[1].params.include_image, false, 'warm-up observe')
  await h.tools.cu_click.execute({ element_id: 'eaaaaaaa' }, h.exec)
  const click = h.calls.at(-1)
  assert.equal(click.method, 'act.click')
  assert.equal(click.params.element_id, 'a3')
  assert.equal(click.params.snapshot_gen, 5)
  await assert.rejects(h.tools.cu_click.execute({ element_id: 'enotthere' }, h.exec), /not on screen/)
  await assert.rejects(h.tools.cu_click.execute({ x: 1, y: 2 }, h.exec), /must declare space/)
})

test('refusals tell the model what happened and what to do; outcome_unknown is not retried', async () => {
  let n = 0
  const h = harness({ responses: { observe: observed, 'act.key': () => { n++; throw new RpcError(-32010, 'posting failed', { reason: 'action_failed', retry: 'outcome_unknown' }) } } })
  await h.tools.cu_observe.execute({}, h.exec)
  await assert.rejects(h.tools.cu_key.execute({ chord: 'return' }, h.exec), /MAY ALREADY HAVE HAPPENED/)
  assert.equal(n, 1)
  assert.match(explain(new RpcError(-32010, 'm', { reason: 'hit_test_failed', retry: 'after_observe', intercepted_by: 'com.x' })).message, /Clicks there go to com\.x.*cu_observe/)
})

const granted = (bundle, mode = 'read', scope = 'turn') =>
  ({ status: 'granted', app: { bundle_id: bundle, name: 'App', path: `/Applications/${bundle}.app` }, mode, scope, via: 'dialog' })
const refused = (reason, message = reason) => new RpcError(-32010, message, { reason, retry: 'never', executed: false })

test('cu_request_app without a person (bench, headless): one access.request, not interactive, refused by the daemon', async () => {
  const h = harness({ responses: { observe: observed, 'access.request': refused('approval_unavailable', 'nobody can approve') } })
  await assert.rejects(h.tools.cu_request_app.execute({ app: 'com.apple.TextEdit', mode: 'read', reason: 'r' }, h.exec),
    /approval_unavailable.*Do not retry/)
  const req = h.calls.find((c) => c.method === 'access.request')
  assert.equal(req.params.interactive, false)
  assert.equal(h.calls.filter((c) => c.method === 'access.status').length, 0)
})

// ---------------------------------------------------------------- approvals on first touch (cu-desktop; P2, 2026-10-16)

const ask = { overrideOf: () => undefined, config: { policy: 'ask' } }
const pending = { status: 'pending', request_id: 'dlg-1', app: { bundle_id: 'com.tencent.qq' }, mode: 'read' }
const qq = { app: 'com.tencent.qq' }
const interactiveRequests = (h) => h.calls.filter((c) => c.method === 'access.request' && c.params.interactive === true)

/** A cu-desktop harness: no configured apps; silent access.request finds nothing until a dialog was answered `grant`. */
function desktop({ approval = ask, grant = (p) => granted('com.tencent.qq', p.mode, 'session'), status, responses = {},
                   settings = localeSettings('zh'), services = {} } = {}) {
  const approved = new Set()
  let polls = 0
  return harness({ approval, settings, services, config: { apps: [], appApproval: 'dialog' }, responses: {
    // As the daemon answers in daily use (config_grants off): any cu-desktop path that still used grants.set fails.
    'grants.set': () => { throw refused('config_grants_disabled', 'grants.set is off in this daemon\'s config') },
    observe: { ...observed, windows: [{ app: 'com.tencent.qq', frame_pt: [0, 0, 800, 600] }] },
    'access.request': (p) => {
      if (p.interactive) return { ...pending, mode: p.mode }
      if (approved.has(p.mode) || (p.mode === 'read' && approved.has('full'))) return granted('com.tencent.qq', p.mode, 'existing')
      throw refused('approval_unavailable', 'nobody can approve com.tencent.qq here')
    },
    'access.status': status ?? ((p) => {
      if (++polls < 3) return { status: 'pending', request_id: 'dlg-1' }
      const last = interactiveModes.at(-1)
      approved.add(last)
      return grant({ mode: last })
    }),
    ...responses,
  }, onCall: (m, p) => { if (m === 'access.request' && p.interactive) interactiveModes.push(p.mode) } })
}
let interactiveModes = []

test('cu-desktop (P2, 2026-10-16): the first call touching an app asks the user once, full mode, with the justification; approved, nothing is asked again', async () => {
  interactiveModes = []
  const h = desktop()
  assert.match((await h.tools.cu_observe.execute({}, h.exec)).text, /No app is approved.*cu_observe with app/)
  const out = await h.tools.cu_observe.execute({ ...qq, justification: 'read the pinned chat' }, h.exec)
  assert.match(out.text, /untrusted observation/)
  const req = interactiveRequests(h)
  assert.equal(req.length, 1)
  assert.deepEqual([req[0].params.app, req[0].params.mode, req[0].params.reason], ['com.tencent.qq', 'full', 'read the pinned chat'])
  assert.equal(h.calls.filter((c) => c.method === 'access.status').length, 3, 'polled until the person answered')
  assert.equal(h.calls.filter((c) => c.method === 'grants.set').length, 0, 'apps come from approvals')
  assert.deepEqual(h.tasks.byTaskId('dsh-s1').apps, ['com.tencent.qq'])
  // Approved now: the plain call goes through without asking.
  await h.tools.cu_observe.execute(qq, h.exec)
  assert.equal(interactiveRequests(h).length, 1)
  // Without a justification the dialog still opens, with no reason; the justification never reaches the daemon call itself.
  const bare = desktop()
  await bare.tools.cu_observe.execute({ ...qq, justification: 'j' }, bare.exec)
  assert.equal(interactiveRequests(bare)[0].params.reason, 'j')
  assert.ok(!bare.calls.some((c) => c.method === 'observe' && 'justification' in c.params))
  const silent = desktop()
  await silent.tools.cu_observe.execute(qq, silent.exec)
  assert.equal(interactiveRequests(silent)[0].params.reason, undefined)
})


test('a dialog that failed is final for the turn; policy never or no approval service asks nothing', async () => {
  for (const reason of ['approval_rejected', 'approval_timeout', 'approval_limit']) {
    interactiveModes = []
    const h = desktop({ status: refused(reason) })
    await assert.rejects(h.tools.cu_observe.execute(qq, h.exec), new RegExp(`${reason}.*Do not retry`))
    await assert.rejects(h.tools.cu_observe.execute(qq, h.exec), /already failed in this turn \(approval_\w+\).*final/)
    assert.equal(interactiveRequests(h).length, 1, reason)
    // A new turn may ask again (the daemon itself refuses an app refused earlier in the session).
    h.tasks.endTurn('dsh-s1')
    await assert.rejects(h.tools.cu_observe.execute(qq, h.exec), new RegExp(reason))
    assert.equal(interactiveRequests(h).length, 2, reason)
  }
  for (const approval of [{ overrideOf: () => 'never', config: { policy: 'ask' } }, { overrideOf: () => undefined, config: { policy: 'never' } }, null]) {
    interactiveModes = []
    const h = desktop({ approval })
    // It says how approvals come to be off, so the user is told (2026-10-14: a full-access session).
    await assert.rejects(h.tools.cu_observe.execute(qq, h.exec), /approval policy of this session is "never".*switched off in this session.*full-access mode.*switch the session back/)
    assert.equal(interactiveRequests(h).length, 0)
  }
})

test('the daemon\'s dialog limit still holds: approval_limit is final for the turn, nothing shown', async () => {
  interactiveModes = []
  const h = desktop({ responses: { 'access.request': (p) => {
    if (p.interactive) throw refused('approval_limit', '3 approval dialogs were shown this turn')
    throw refused('approval_unavailable')
  } } })
  await assert.rejects(h.tools.cu_observe.execute(qq, h.exec), /approval_limit.*Do not retry/)
  assert.equal(h.calls.filter((c) => c.method === 'access.status').length, 0, 'no dialog to poll')
  await assert.rejects(h.tools.cu_observe.execute(qq, h.exec), /already failed in this turn \(approval_\w+\).*final/)
})

test('refusals no dialog can change (hard-denied, refused earlier, unknown or ambiguous app) go to the model as they are', async () => {
  for (const reason of ['hard_denied', 'approval_refused_earlier', 'app_not_found', 'app_name_ambiguous']) {
    const h = desktop({ responses: { 'access.request': refused(reason) } })
    await assert.rejects(h.tools.cu_observe.execute(qq, h.exec), (e) => new RegExp(`${reason}.*Do not retry`).test(e.message) && !/justification/.test(e.message))
    assert.equal(interactiveRequests(h).length, 0)
  }
})

test('actions on an app not yet approved ask once (full) and are then sent again; approved, they go through silently', async () => {
  for (const [tool, args, method] of [['cu_type', { ...qq, text: 'hi' }, 'act.type'], ['cu_key', { ...qq, chord: 'return' }, 'act.key']]) {
    interactiveModes = []
    let n = 0
    const h = desktop({ responses: { [method]: () => { if (n++ === 0) throw refused('not_granted'); return { executed: true } } } })
    assert.match((await h.tools[tool].execute({ ...args, justification: 'reply to the chat' }, h.exec)).text, /^Done/)
    assert.equal(n, 2, `${tool}: refused, asked, sent again once`)
    assert.deepEqual(interactiveRequests(h).map((c) => [c.params.mode, c.params.reason]), [['full', 'reply to the chat']], tool)
    assert.match((await h.tools[tool].execute(args, h.exec)).text, /^Done/)
    assert.equal(interactiveRequests(h).length, 1, `${tool}: approved, nothing asked`)
  }
  // A click needs a snapshot first; the look asked, so the click's refusal is covered silently and it is sent again.
  interactiveModes = []
  let n = 0
  const h = desktop({ responses: { 'act.click': () => { if (n++ === 0) throw refused('not_granted'); return { executed: true } } } })
  await h.tools.cu_observe.execute(qq, h.exec)
  assert.match((await h.tools.cu_click.execute({ ...qq, x: 1, y: 2, space: 'screen' }, h.exec)).text, /^Done/)
  assert.equal(n, 2)
  assert.deepEqual(interactiveModes, ['full'])
})

test('an older read approval (always list): looking asks nothing; typing (needs_mode full) asks once for full; the bench gets the refusal', async () => {
  interactiveModes = []
  let n = 0
  const needsFull = () => { if (n++ === 0) throw new RpcError(-32010, 'read-only', { reason: 'action_not_allowed', retry: 'never', executed: false, needs_mode: 'full' }); return { executed: true } }
  const h = desktop({ responses: { 'act.type': needsFull, 'access.request': (p) => {
    if (p.interactive) return { ...pending, mode: p.mode }
    if (p.mode === 'read') return granted('com.tencent.qq', 'read', 'persistent')
    throw refused('approval_unavailable', 'nobody can approve com.tencent.qq here')
  } } })
  await h.tools.cu_observe.execute(qq, h.exec)
  assert.equal(interactiveRequests(h).length, 0, 'read covers looking')
  await h.tools.cu_type.execute({ ...qq, text: 'hi' }, h.exec)
  assert.deepEqual(interactiveRequests(h).map((c) => c.params.mode), ['full'])
  assert.equal(n, 2)

  n = 0
  const bench = harness({ responses: { observe: observed, 'act.type': needsFull } })
  await assert.rejects(bench.tools.cu_type.execute({ text: 'hi' }, bench.exec), (e) => /action_not_allowed/.test(e.message) && !/justification/.test(e.message))
  assert.equal(bench.calls.filter((c) => c.method === 'access.request').length, 0)
})

test('only cu-desktop takes a justification and drops cu_request_app; the bench keeps its tools as they were', async () => {
  const { SAFETY_PROMPT, DIALOG_SAFETY_PROMPT } = await import('../lib/index.js')
  const d = desktop(), b = harness()
  const params = (h, name) => Object.keys(h.tools[name].parameters?.properties ?? h.tools[name].parameters ?? {})
  for (const name of ['cu_observe', 'cu_launch', 'cu_click', 'cu_type', 'cu_key', 'cu_scroll', 'cu_drag', 'cu_set_value', 'cu_ax_action', 'cu_steps']) {
    assert.ok(params(d, name).includes('justification') && !params(d, name).includes('access'), name)
    if (b.tools[name]) assert.ok(!params(b, name).includes('justification') && !params(b, name).includes('access'), name)
  }
  assert.ok(!params(d, 'cu_zoom').includes('justification'))
  assert.equal(d.tools.cu_request_app, undefined)
  assert.ok(b.tools.cu_request_app)
  assert.match(SAFETY_PROMPT, /ask with cu_request_app/)
  assert.doesNotMatch(DIALOG_SAFETY_PROMPT, /cu_request_app|access:/)
  assert.match(DIALOG_SAFETY_PROMPT, /The first call that touches another app asks the user/)
  assert.match(DIALOG_SAFETY_PROMPT, /A refusal is final for this turn/)
})

test('exclusive: with any non-cu_* tool visible to the model, every cu_* tool refuses before reaching the daemon', async () => {
  const mk = (names, config = {}) => {
    const h = harness({ config, responses: { observe: observed } })
    const tools = Object.fromEntries(defineCuTools({ ctx: { get: () => undefined }, client: { request: async (m, p) => { h.calls.push({ method: m, params: p }); return m === 'observe' ? observed : {} } },
      tasks: h.tasks, sleep: async () => {}, visibleTools: () => names }).map((t) => [t.name, t]))
    return { ...h, tools }
  }
  const withBash = mk(['cu_observe', 'cu_click', 'bash', 'read'])
  await assert.rejects(withBash.tools.cu_observe.execute({}, withBash.exec), (e) => e.message === 'cu-runtime refuses to work '
    + 'while the model also has other tools (bash, read): computer use runs only where cu_* tools are offered and nothing '
    + 'else (the 电脑操作 mode). Tell the user.')
  await assert.rejects(withBash.tools.cu_request_app.execute({ app: 'x', mode: 'read', reason: 'r' }, withBash.exec), /other tools/)
  assert.equal(withBash.calls.length, 0)
  const codeMode = mk(['cu_observe', 'run_code'])
  await assert.rejects(codeMode.tools.cu_observe.execute({}, codeMode.exec), /run_code/)
  const only = mk(['cu_observe', 'cu_click'])
  assert.match((await only.tools.cu_observe.execute({}, only.exec)).text, /untrusted observation/)
  const off = mk(['cu_observe', 'bash'], { exclusive: false })
  assert.match((await off.tools.cu_observe.execute({}, off.exec)).text, /untrusted observation/)
})

test('config: appApproval defaults to none (no dialog) and exclusive to true', () => {
  const c = new Config({ electronAx: false })
  assert.equal(c.appApproval, 'none')
  assert.equal(c.exclusive, true)
})

test('arm switches: OCR off forces ocr off and removes cu_read_text; image off removes cu_zoom and images', async () => {
  const h = harness({ config: { ocr: false, image: false }, responses: { observe: observed } })
  assert.equal(h.tools.cu_read_text, undefined)
  assert.equal(h.tools.cu_zoom, undefined)
  await h.tools.cu_observe.execute({ ocr: true, image: true }, h.exec)
  const obs = h.calls.filter((c) => c.method === 'observe')
  assert.ok(obs.every((c) => c.params.ocr === 'off'), 'the model cannot turn OCR on')
  assert.equal(obs.at(-1).params.include_image, false)
  const all = harness()
  assert.ok(all.tools.cu_zoom && all.tools.cu_read_text)
})

test('action allowlist (T7): tools outside it are not offered; the grant carries it, read_text as zoom', async () => {
  const h = harness({ config: { actions: ['observe', 'zoom', 'read_text', 'click', 'scroll'] }, responses: { observe: observed } })
  for (const gone of ['cu_type', 'cu_set_value', 'cu_key', 'cu_drag', 'cu_ax_action']) assert.equal(h.tools[gone], undefined, gone)
  for (const kept of ['cu_observe', 'cu_zoom', 'cu_read_text', 'cu_click', 'cu_scroll', 'cu_list_apps']) assert.ok(h.tools[kept], kept)
  await h.tools.cu_observe.execute({}, h.exec)
  assert.deepEqual(h.calls[0].params.actions, ['click', 'observe', 'scroll', 'zoom'])
  const open = harness({ responses: { observe: observed } })
  assert.ok(open.tools.cu_type && open.tools.cu_key)
  await open.tools.cu_observe.execute({}, open.exec)
  assert.equal(open.calls[0].params.actions, undefined, 'no allowlist = no limit sent')
})

test('click limit (T7): passed to the grant as click_limit and stated in cu_click', async () => {
  const h = harness({ config: { actions: ['observe', 'click'], clickLimit: { buttons: ['left'], maxCount: 1 } }, responses: { observe: observed } })
  await h.tools.cu_observe.execute({}, h.exec)
  assert.deepEqual(h.calls[0].params.click_limit, { buttons: ['left'], max_count: 1 })
  assert.match(h.tools.cu_click.description, /only left clicks, count at most 1/)
  const open = harness({ responses: { observe: observed } })
  await open.tools.cu_observe.execute({}, open.exec)
  assert.equal(open.calls[0].params.click_limit, undefined)
})

test('config: a missing actions key means no limit (not an empty allowlist); unknown names are rejected', () => {
  const base = { electronAx: false }
  assert.equal(Config(base).actions ?? undefined, undefined)
  assert.deepEqual(Config({ ...base, actions: ['observe', 'click'] }).actions, ['observe', 'click'])
  assert.throws(() => Config({ ...base, actions: ['observe', 'send'] }))
  assert.equal(Config(base).clickLimit ?? undefined, undefined)
  assert.deepEqual(Config({ ...base, clickLimit: { buttons: ['left'], maxCount: 1 } }).clickLimit, { buttons: ['left'], maxCount: 1 })
  assert.throws(() => Config({ ...base, clickLimit: { buttons: ['left'], maxCount: 5 } }))
  assert.throws(() => Config({ ...base, clickLimit: { buttons: ['thumb'], maxCount: 1 } }))
})

// ---------------------------------------------------------------- input method policy

const needsApproval = new RpcError(-32010, 'needs approval', { reason: 'ime_switch_needs_approval', retry: 'never', executed: false, input_source: 'com.apple.inputmethod.SCIM.ITABC' })

test('ime ask: the grant carries the policy; a person approves, ime.approve, then the text is sent once more', async () => {
  const asked = []
  let n = 0
  const h = harness({ config: { imePolicy: 'ask', imeApproval: 'task' },
    approval: { request: async (r) => { asked.push(r); return 'allowed-once' } },
    responses: { observe: observed, 'act.type': (p) => { if (n++ === 0) throw needsApproval; return { executed: true, via: 'event', ime: 'switched', input_source: 'com.apple.keylayout.ABC', original_input_source: 'com.apple.inputmethod.SCIM.ITABC', restores: 'when_the_task_ends' } } } })
  const out = await h.tools.cu_type.execute({ text: '你好' }, h.exec)
  assert.equal(h.calls[0].params.ime_policy, 'ask')
  assert.equal(asked.length, 1)
  assert.match(asked[0].reason, /要往「dev\.dsh\.bench\.fixture」里输入文字.*SCIM\.ITABC临时切到英文键盘（ABC），任务结束时切回/)
  assert.deepEqual(h.calls.filter((c) => c.method !== 'observe' && c.method !== 'grants.set').map((c) => c.method), ['act.type', 'ime.approve', 'act.type'])
  assert.equal(h.calls.find((c) => c.method === 'ime.approve').params.scope, 'task')
  assert.equal(h.calls.filter((c) => c.method === 'act.type').at(-1).params.ime_policy, undefined)
  assert.match(out.text, /switched from com\.apple\.inputmethod\.SCIM\.ITABC to com\.apple\.keylayout\.ABC \(switched back when the task ends\)/)
})

test('ime ask headless or refused: typed with ime_policy leave, and the result says the source was not switched', async () => {
  for (const approval of [undefined, { request: async () => 'rejected' }]) {
    let n = 0
    const h = harness({ config: { imePolicy: 'ask' }, approval,
      responses: { observe: observed, 'act.type': (p) => { if (n++ === 0) throw needsApproval; return { executed: true, via: 'event', ime: 'left', input_source: 'com.apple.inputmethod.SCIM.ITABC', ime_warning: 'w' } } } })
    const out = await h.tools.cu_type.execute({ text: 'x' }, h.exec)
    const types = h.calls.filter((c) => c.method === 'act.type')
    assert.equal(types.length, 2)
    assert.equal(types[1].params.ime_policy, 'leave')
    assert.equal(h.calls.filter((c) => c.method === 'ime.approve').length, 0)
    assert.match(out.text, approval === undefined ? /NOT switched \(approval: unavailable \(headless\)\)/ : /NOT switched \(approval: rejected\)/)
    assert.match(out.text, /Warning: input method com\.apple\.inputmethod\.SCIM\.ITABC is active/)
  }
})

test('ime: a failed switch falls back to leave; a composition refusal goes to the model; unknown outcomes are never resent', async () => {
  let n = 0
  const failed = harness({ config: { imePolicy: 'takeover' }, responses: { observe: observed, 'act.type': () => { if (n++ === 0) throw new RpcError(-32010, 'did not take effect', { reason: 'ime_switch_failed', retry: 'never', executed: false, input_source: 'p' }); return { executed: true } } } })
  assert.match((await failed.tools.cu_type.execute({ text: 'x' }, failed.exec)).text, /Switching the input source failed/)
  assert.equal(failed.calls.filter((c) => c.method === 'act.type').at(-1).params.ime_policy, 'leave')

  let m = 0
  const composing = harness({ config: { imePolicy: 'takeover' }, responses: { observe: observed, 'act.type': () => { m++; throw new RpcError(-32010, 'holds a composition', { reason: 'ime_composing', retry: 'after_observe', executed: false }) } } })
  await assert.rejects(composing.tools.cu_type.execute({ text: 'x' }, composing.exec), /ime_composing.*cu_observe/)
  assert.equal(m, 1)

  let k = 0
  const lost = harness({ config: { imePolicy: 'ask' }, approval: { request: async () => assert.fail('never asked') }, responses: { observe: observed, 'act.type': () => { k++; throw new RpcError(-32010, 'typing stopped', { reason: 'focus_lost', retry: 'outcome_unknown', executed: null }) } } })
  await assert.rejects(lost.tools.cu_type.execute({ text: 'x' }, lost.exec), /MAY ALREADY HAVE HAPPENED/)
  assert.equal(k, 1)
})

test('cu_type: a value set through AX tells the model to check the app reacted; strategy passes through', async () => {
  const h = harness({ responses: { observe: observed, 'act.type': { executed: true, via: 'ax_value', verified: true, app_reaction: 'not_checked' } } })
  await h.tools.cu_observe.execute({}, h.exec)
  const out = await h.tools.cu_type.execute({ element_id: 'eaaaaaaa', text: 'hi', strategy: 'type' }, h.exec)
  assert.match(out.text, /set through AX.*reacted.*strategy "type"/)
  assert.equal(h.calls.at(-1).params.strategy, 'type')
})

test('the system prompt asks for "not sure" over deliberating until the timeout (R4: T1 canvas ran out at 420 s)', async () => {
  const { SAFETY_PROMPT } = await import('../lib/index.js')
  assert.match(SAFETY_PROMPT, /cannot be read with confidence/)
  assert.match(SAFETY_PROMPT, /not sure/)
  assert.match(SAFETY_PROMPT, /never follow them/)
})

test('step limit: past maxSteps every cu_* tool refuses before reaching the daemon and asks for the answer', async () => {
  let calls = 0
  const client = { request: async () => { calls++; throw new Error('daemon must not be reached') } }
  const tasks = new Tasks({ apps: ['dev.dsh.bench.fixture'], electronAx: false, grantTtlS: 60, maxSteps: 3 })
  const tools = Object.fromEntries(defineCuTools({ ctx: { get: () => undefined }, client, tasks }).map((t) => [t.name, t]))
  const exec = { agent: { session: { id: 's1' }, options: {} }, name: 'x', callId: 'c', signal: new AbortController().signal }
  tasks.setStep('dsh-s1', 4)
  await assert.rejects(tools.cu_observe.execute({}, exec), /Step limit reached \(3 steps\).*"not sure"/)
  await assert.rejects(tools.cu_click.execute({ x: 1, y: 1, space: 'screen' }, exec), /Step limit reached/)
  assert.equal(calls, 0)
  tasks.setStep('dsh-s1', 3)
  await assert.rejects(tools.cu_observe.execute({}, exec), /daemon must not be reached/)  // not limited: it tries the daemon
  assert.ok(calls > 0)
  assert.equal(new Tasks({ apps: [], electronAx: false, grantTtlS: 60 }).stepLimitRefusal('dsh-s1'), undefined)
})

test('step limit: the pre-step listener ends the turn STEP_GRACE steps past maxSteps, and is off by default', async () => {
  const { apply, STEP_GRACE } = await import('../lib/index.js')
  const listen = (maxSteps) => {
    const on = {}
    const ctx = { on: (name, fn) => { on[name] = fn }, effect: () => {}, systemPrompt: { section: () => {} },
                  tools: { register: () => {} }, logger: { warn: () => {} }, get: () => undefined }
    apply(ctx, { stateDir: '/nonexistent', apps: [], electronAx: false, grantTtlS: 60, imePolicy: 'leave',
                 imeApproval: 'call', requestTimeoutMs: 1000, maxSteps, ocr: true, image: true, zoom: true })
    return on['agent/pre-step']
  }
  const enter = async () => ({ kind: 'enter', messages: [] })
  const step = (n) => ({ agent: { session: { id: 's' } }, messages: [], turn: 1, step: n, signal: new AbortController().signal })
  const pre = listen(1)
  assert.equal((await pre(step(1 + STEP_GRACE), enter)).kind, 'enter')
  assert.equal((await pre(step(2 + STEP_GRACE), enter)).kind, 'reject')
  assert.equal((await listen(0)(step(500), enter)).kind, 'enter')
})

// ---------------------------------------------------------------- turn focus and ended approvals (2026-10-08)

test('cu-desktop marks each turn start; restoreFocus asks for the focus back at every turn end; the bench never marks', async () => {
  const { apply } = await import('../lib/index.js')
  const run = async (config, { started = false } = {}) => {
    const d = await fakeDaemon((msg) => ({ result: msg.method === 'access.request' ? granted('com.tencent.qq', 'read', 'session')
      : msg.method === 'observe' ? observed : { dropped: [] } }))
    const on = {}
    const disposers = []
    const tools = {}
    const ctx = { on: (name, fn) => { on[name] = fn }, effect: (fn) => { disposers.push(fn()) }, systemPrompt: { section: () => {} },
                  tools: { register: (t) => { tools[t.name] = t }, schemas: () => [] }, logger: { warn: () => {} }, get: () => undefined }
    apply(ctx, Config({ stateDir: d.dir, electronAx: false, ...config }))
    const event = on['session/event']
    const exec = { agent: { session: { id: 's1', requestHeader: () => undefined }, options: {} }, name: 'x', callId: 'c1', signal: new AbortController().signal }
    // A turn that touched nothing (the task never started) or one that used an app, ended each way dsh ends a turn
    // (in a finally): all alike.
    for (const reason of ['completed', 'aborted', 'error', 'blocked']) {
      event({ id: 's1' }, { type: 'turn/start', turn: 1 })
      if (started) await tools.cu_observe.execute({ app: 'com.tencent.qq' }, exec)
      event({ id: 's1' }, { type: 'turn/end', turn: 1, reason: { kind: reason } })
      await new Promise((r) => setTimeout(r, 50))
    }
    await new Promise((r) => setTimeout(r, 200))
    for (const dispose of disposers) dispose()
    d.close()
    return d.seen.filter((m) => m.method.startsWith('access.turn')).map((m) => [m.method, m.params.task_id, m.params.restore_focus])
  }
  for (const started of [false, true]) {
    const marked = await run({ appApproval: 'dialog' }, { started })
    assert.equal(marked.length, 8, `started ${started}`)
    for (let i = 0; i < 8; i += 2) {
      assert.deepEqual(marked[i], ['access.turn_start', 'dsh-s1', undefined])
      assert.deepEqual(marked[i + 1], ['access.turn_end', 'dsh-s1', true], `started ${started}`)
    }
  }
  // Off: turns are still marked (the daemon learns dsh's own app, never granted: dsh_host_app) and end at the
  // daemon (its refusals end there), without the focus.
  for (const started of [false, true]) {
    assert.deepEqual(await run({ appApproval: 'dialog', restoreFocus: false }, { started }),
      Array(4).fill([['access.turn_start', 'dsh-s1', undefined], ['access.turn_end', 'dsh-s1', false]]).flat(), `started ${started}`)
  }
  assert.deepEqual(await run({ appApproval: 'none' }), [], 'the bench: no focus handling, as before')
  assert.equal(Config({ electronAx: false }).restoreFocus, true)
})

test('approvals that ended (30 minutes, or revoked): the next action asks again and is sent once more; the bench sees no_grant as before', async () => {
  interactiveModes = []
  let n = 0
  const h = desktop({ responses: { 'act.click': () => { if (n++ === 0) throw refused('no_grant', 'no grant for task dsh-s1'); return { executed: true } } } })
  const t = h.tasks.get(h.exec)
  Object.assign(t, { apps: ['com.tencent.qq'], started: true, warmed: true })
  await h.tools.cu_observe.execute({}, h.exec)
  const click = { ...qq, x: 1, y: 2, space: 'screen' }
  assert.match((await h.tools.cu_click.execute({ ...click, justification: 'open the pinned chat' }, h.exec)).text, /^Done/)
  assert.deepEqual(interactiveRequests(h).map((c) => c.params.mode), ['full'])
  assert.deepEqual(t.apps, ['com.tencent.qq'], 'the ended approval was dropped, the new one counted')
  assert.equal(n, 2)

  const bench = harness({ responses: { observe: observed, 'act.click': refused('no_grant') } })
  await bench.tools.cu_observe.execute({}, bench.exec)
  await assert.rejects(bench.tools.cu_click.execute({ x: 1, y: 2, space: 'screen' }, bench.exec), /no_grant.*Do not retry/)
})

test('approvals that ended: a call without an app says so and how to go on, instead of a final refusal', async () => {
  const h = desktop({ responses: { observe: refused('no_grant', 'no grant for task dsh-s1') } })
  Object.assign(h.tasks.get(h.exec), { apps: ['com.tencent.qq'], started: true, warmed: true })
  await assert.rejects(h.tools.cu_observe.execute({}, h.exec), (e) => /approvals of this task have ended.*cu_observe with app/.test(e.message) && !/Do not retry/.test(e.message))
  assert.deepEqual(h.tasks.get(h.exec).apps, [])
  assert.match((await h.tools.cu_observe.execute({}, h.exec)).text, /No app is approved/)
})

test('a new session that never had an approval is told where to start, not that approvals ended', async () => {
  const h = desktop({ responses: { 'apps.list': refused('no_grant', 'no grant for task dsh-s1') } })
  await assert.rejects(h.tools.cu_list_apps.execute({}, h.exec), (e) => /No app is approved/.test(e.message) && !/ended/.test(e.message))
})

test('cu-desktop: an AX tree that was not ready after electron_ax went on is said, with a call to observe again; the bench is told nothing', async () => {
  const stats = (reason) => ({ ...observed, ax_stats: [{ app: 'com.tencent.qq', nodes: 13, electron_ax: true, settle: { reason, nodes: 13, elapsed_ms: 5000 } }] })
  const notReady = /accessibility tree of com\.tencent\.qq was not ready yet \(13 nodes\).*Call cu_observe again/
  for (const reason of ['unchanged', 'timeout']) {
    const h = desktop({ responses: { observe: stats(reason) } })
    Object.assign(h.tasks.get(h.exec), { apps: ['com.tencent.qq'], started: true, warmed: true })
    assert.match((await h.tools.cu_observe.execute({}, h.exec)).text, notReady)
  }
  const settled = desktop({ responses: { observe: stats('grew_and_settled') } })
  Object.assign(settled.tasks.get(settled.exec), { apps: ['com.tencent.qq'], started: true, warmed: true })
  assert.doesNotMatch((await settled.tools.cu_observe.execute({}, settled.exec)).text, /not ready/)
  const bench = harness({ responses: { observe: stats('unchanged') } })
  assert.doesNotMatch((await bench.tools.cu_observe.execute({}, bench.exec)).text, /not ready/)
})

test('clicking by coordinates (2026-10-22): an app with no AX element is named with the advice to zoom first; a point click followed by no change says it probably missed; the bench is told neither', async () => {
  const wechat = 'com.tencent.xinWeChat'
  const ocr = (id, key, text) => ({ id, key, source: 'ocr', text, frame_pt: [300, 960, 40, 20], occluded: false, app: wechat, confidence: 0.9 })
  const look = (elements) => ({ snapshot_gen: 7, frontmost: wechat, windows: [{ app: wechat, frame_pt: [0, 0, 900, 1000] }],
    untrusted_observation: { elements }, capture: {} })
  const same = look([ocr('o1', '111111111111', '发送')])
  const noAX = /com\.tencent\.xinWeChat gives no accessibility elements.*cu_zoom on its area/
  const missed = /Nothing changed since your click at 337,982 \(screen\): it probably missed\. Do not click the same point again/

  const h = desktop({ responses: { observe: same, 'act.click': { executed: true, via: 'event' } } })
  Object.assign(h.tasks.get(h.exec), { apps: [wechat], started: true, warmed: true })
  const first = (await h.tools.cu_observe.execute({}, h.exec)).text
  assert.match(first, noAX)
  assert.doesNotMatch(first, /Nothing changed/)
  await h.tools.cu_click.execute({ x: 337, y: 982, space: 'screen' }, h.exec)
  assert.match((await h.tools.cu_observe.execute({}, h.exec)).text, missed)
  assert.doesNotMatch((await h.tools.cu_observe.execute({}, h.exec)).text, /Nothing changed/, 'said once per click')

  // The click changed something: no hint. A click on an element: no hint.
  let n = 0
  const changing = desktop({ responses: { observe: () => (n++ === 0 ? same : look([ocr('o1', '111111111111', '发送'), ocr('o2', '222222222222', '表情')])),
    'act.click': { executed: true, via: 'event' } } })
  Object.assign(changing.tasks.get(changing.exec), { apps: [wechat], started: true, warmed: true })
  await changing.tools.cu_observe.execute({}, changing.exec)
  await changing.tools.cu_click.execute({ x: 337, y: 982, space: 'screen' }, changing.exec)
  assert.doesNotMatch((await changing.tools.cu_observe.execute({}, changing.exec)).text, /Nothing changed/)
  const byId = desktop({ responses: { observe: same, 'act.click': { executed: true, via: 'event' } } })
  Object.assign(byId.tasks.get(byId.exec), { apps: [wechat], started: true, warmed: true })
  await byId.tools.cu_observe.execute({}, byId.exec)
  await byId.tools.cu_click.execute({ element_id: 'o1111111' }, byId.exec)
  assert.doesNotMatch((await byId.tools.cu_observe.execute({}, byId.exec)).text, /Nothing changed/)

  // An app with AX elements gets no zoom advice.
  const ax = desktop({ responses: { observe: { ...observed } } })
  Object.assign(ax.tasks.get(ax.exec), { apps: ['dev.dsh.bench.fixture'], started: true, warmed: true })
  assert.doesNotMatch((await ax.tools.cu_observe.execute({}, ax.exec)).text, /gives no accessibility elements/)

  // The bench: neither hint.
  const bench = harness({ responses: { observe: same, 'act.click': { executed: true, via: 'event' } } })
  const b1 = (await bench.tools.cu_observe.execute({}, bench.exec)).text
  await bench.tools.cu_click.execute({ x: 337, y: 982, space: 'screen' }, bench.exec)
  const b2 = (await bench.tools.cu_observe.execute({}, bench.exec)).text
  assert.doesNotMatch(b1 + b2, /gives no accessibility elements|Nothing changed/)
})

// ---------------------------------------------------------------- opening apps (2026-10-09, 2a)

test('cu_launch: an app not yet approved asks once (full), then opens only that app; the bench has no cu_launch', async () => {
  interactiveModes = []
  let n = 0
  const h = desktop({ grant: (p) => granted('com.tencent.qq', p.mode, 'turn'),
    responses: { 'apps.launch': () => { if (n++ === 0) throw refused('not_granted'); return { launched: true, was_running: false } } } })
  const out = await h.tools.cu_launch.execute({ ...qq, justification: 'open QQ to read the chat' }, h.exec)
  assert.match(out.text, /Opened: com\.tencent\.qq\. Call cu_observe/)
  assert.deepEqual(interactiveModes, ['full'])
  assert.equal(interactiveRequests(h)[0].params.reason, 'open QQ to read the chat')
  const launches = h.calls.filter((c) => c.method === 'apps.launch')
  assert.equal(launches.length, 2)
  assert.deepEqual(launches.map((c) => c.params.app), ['com.tencent.qq', 'com.tencent.qq'])
  assert.equal(harness().tools.cu_launch, undefined)
})

test('cu_launch open (C3, 2026-10-15): ~ expanded, kept through the dialog, the daemon\'s refusal passed on', async () => {
  interactiveModes = []
  let n = 0
  const h = desktop({ grant: (p) => granted('com.apple.textedit', p.mode, 'turn'),
    responses: { 'apps.launch': (p) => {
      if (n++ === 0) throw new RpcError(-32010, 'no grant', { reason: 'no_grant', retry: 'never', executed: false, needs_mode: 'full' })
      if (p.open.endsWith('.command')) throw refused('open_not_allowed', 'a .command file runs, installs or redirects to something when opened; never opened')
      return { launched: true, was_running: true, opened: 'file' }
    } } })
  const te = { app: 'com.apple.textedit', open: ' ~/Desktop/诗.txt ' }
  const out = await h.tools.cu_launch.execute({ ...te, justification: 'show the poem bash wrote' }, h.exec)
  const home = (await import('node:os')).homedir()
  assert.match(out.text, new RegExp(`was asked to open ${home}/Desktop/诗\\.txt \\(it was running\\)`))
  assert.deepEqual(interactiveModes, ['full'])
  const launches = h.calls.filter((c) => c.method === 'apps.launch')
  assert.deepEqual(launches.map((c) => c.params.open), [`${home}/Desktop/诗.txt`, `${home}/Desktop/诗.txt`])
  await assert.rejects(h.tools.cu_launch.execute({ app: 'com.apple.textedit', open: '/tmp/x.command' }, h.exec), /open_not_allowed.*never opened/)
  assert.match((await h.tools.cu_launch.execute({ app: 'com.apple.textedit', open: 'https://example.com' }, h.exec)).text, /open https:\/\/example\.com/)
  const bare = desktop({ grant: (p) => granted('com.apple.textedit', p.mode, 'turn'), responses: { 'apps.launch': { launched: true, was_running: false } } })
  assert.match((await bare.tools.cu_launch.execute({ app: 'com.apple.textedit' }, bare.exec)).text, /^Opened: com\.apple\.textedit/)
  const sent = bare.calls.filter((c) => c.method === 'apps.launch')
  assert.equal(sent.length, 1)
  assert.ok(!('open' in sent[0].params), 'no open: none sent')
})

// ---------------------------------------------------------------- cu_steps (C5, 2026-10-15)

/** A desktop harness with QQ approved (one full dialog) and element eaaaaaaa on screen. */
async function withSteps(responses, services = {}) {
  interactiveModes = []
  const h = desktop({ grant: (p) => granted('com.tencent.qq', p.mode, 'turn'), responses, services })
  await h.tools.cu_observe.execute(qq, h.exec)
  h.calls.length = 0
  return h
}
const done = { executed: true, via: 'event' }

test('cu_steps: every step is checked before the first runs; nothing is sent for a bad batch', async () => {
  const h = await withSteps({ 'act.click': done })
  const click = { tool: 'cu_click', args: { element_id: 'eaaaaaaa' } }
  for (const [steps, re] of [
    [[], /non-empty array/],
    [Array(17).fill(click), /at most 16 steps/],
    // dsh's own argument check rejects these first (the enum in the schema); the runner would say "step 2 uses …".
    [[click, { tool: 'cu_observe', args: {} }], /steps\[1\]\.tool" must be one of|step 2 uses cu_observe/],
    [[click, { tool: 'cu_launch', args: { app: 'x' } }], /steps\[1\]\.tool" must be one of|step 2 uses cu_launch/],
    [[click, { tool: 'cu_click', args: { element_id: 'ezzzzzzz' } }], /step 2: element ezzzzzzz is not on screen/],
    [[click, 'cu_click'], /steps\[1\]"|step 2 must be \{tool, args\}/],
  ]) {
    await assert.rejects(h.tools.cu_steps.execute({ steps }, h.exec), (e) => re.test(e.message) && /^Nothing ran|^invalid arguments/.test(e.message))
  }
  assert.equal(h.calls.length, 0, 'a bad batch sends nothing, not even its good first step')
})

test('cu_steps: runs in order, stops at the first failure (later steps not sent), then one look without the image', async () => {
  const h = await withSteps({ 'act.click': done, 'act.type': { ...done, verified: true },
    'act.key': () => { throw refused('chord_not_allowed', 'cmd+q is never allowed') } })
  const out = await h.tools.cu_steps.execute({ steps: [
    { tool: 'cu_click', args: { element_id: 'eaaaaaaa' } },
    { tool: 'cu_type', args: { text: 'hello', element_id: 'eaaaaaaa' } },
    { tool: 'cu_key', args: { chord: 'cmd+q' } },
    { tool: 'cu_click', args: { element_id: 'eaaaaaaa', count: 2 } },
  ] }, h.exec)
  assert.match(out.text, /Step 1 cu_click: Done \(event\)\.\nStep 2 cu_type: Done \(event\)\. The text is in the field\.\nStep 3 cu_key: FAILED\. .*chord_not_allowed/)
  assert.match(out.text, /Steps 4-4 did not run\.\nSteps 1-2 did run and are not undone: observe before repairing\.\n--- after the last step ---\nFrontmost:/)
  assert.doesNotMatch(out.text, /Step 4/)
  assert.deepEqual(h.calls.map((c) => c.method), ['act.click', 'act.type', 'act.key', 'observe'])
  assert.equal(h.calls[0].params.snapshot_gen, 5, 'the latest snapshot, as a single call would send it')
  assert.equal(h.calls[3].params.include_image, false)
  const quiet = await withSteps({ 'act.click': done })
  const one = await quiet.tools.cu_steps.execute({ steps: [{ tool: 'cu_click', args: { element_id: 'eaaaaaaa' } }], observe: false }, quiet.exec)
  assert.deepEqual(quiet.calls.map((c) => c.method), ['act.click'])
  assert.doesNotMatch(one.text, /after the last step|did not run/)
  const withImage = await withSteps({ 'act.click': done })
  await withImage.tools.cu_steps.execute({ steps: [{ tool: 'cu_click', args: { element_id: 'eaaaaaaa' } }], image: true }, withImage.exec)
  assert.equal(withImage.calls.at(-1).params.include_image, true)
})

test('cu_steps: a step refused for lack of approval takes the approval that covers it and goes on, as the single call would; the bench has no cu_steps', async () => {
  let typed = 0
  const h = await withSteps({ 'act.click': done, 'act.key': done,
    'act.type': () => { if (typed++ === 0) throw refused('not_granted', 'approvals ended'); return { ...done, verified: true } } })
  const out = await h.tools.cu_steps.execute({ steps: [
    { tool: 'cu_click', args: { element_id: 'eaaaaaaa' } },
    { tool: 'cu_type', args: { text: 'hello', element_id: 'eaaaaaaa' } },
    { tool: 'cu_key', args: { chord: 'return' } },
  ] }, h.exec)
  assert.match(out.text, /Step 1 cu_click: Done.*\nStep 2 cu_type: Done.*The text is in the field.*\nStep 3 cu_key: Done/s)
  assert.equal(typed, 2, 'sent again once the approval covered it')
  assert.deepEqual(interactiveModes, ['full'], 'the one dialog of withSteps; the batch asked nothing more')
  assert.equal(harness().tools.cu_steps, undefined, 'bench tasks keep one call per step')
})

test('cu_steps with the image: the step lines stay in front of the look (VM round 14: a refused cmd+b vanished behind the image)', async () => {
  // A model that takes images: the look stages its text and the image for finalizeContent (admitImage), which
  // replaces the tool's text; without the fix the batch's own lines were lost.
  const services = { attachments: { saveImages: async () => [{ attachmentId: 'sha256:x' }] },
    llm: { resolveModelInfo: async () => ({ inputModalities: ['image'] }) } }
  const h = await withSteps({ 'act.key': (p) => { if (p.chord === 'cmd+b') throw refused('chord_not_allowed', 'cmd+b: not on the chord allowlist'); return done },
    observe: { ...observed, windows: [{ app: 'com.tencent.qq', frame_pt: [0, 0, 800, 600] }], image: { base64: 'aGk=', mapping: { sent_size_px: [1011, 632], display_bounds_pt: [0, 0, 1440, 901], map: 'pt = img * 1.42' } } } }, services)
  const exec = { ...h.exec, agent: { ...h.exec.agent, options: { provider: 'p', model: 'm' } } }
  const out = await h.tools.cu_steps.execute({ steps: [{ tool: 'cu_key', args: { chord: 'cmd+a' } }, { tool: 'cu_key', args: { chord: 'cmd+b' } }], image: true }, exec)
  assert.match(out.text, /Step 2 cu_key: FAILED\. .*chord_not_allowed/)
  const content = h.tools.cu_steps.finalizeContent(exec)
  assert.ok(content !== undefined, 'the look staged text and image')
  assert.equal(content[0].type, 'text')
  assert.match(content[0].text, /^Step 1 cu_key: Done.*\nStep 2 cu_key: FAILED\. .*chord_not_allowed.*\n--- after the last step ---\nFrontmost:/s)
  assert.equal(content[1].type, 'image')
  // A plain look (no batch) stages as before.
  await h.tools.cu_observe.execute({ image: true }, exec)
  assert.match(h.tools.cu_observe.finalizeContent(exec)[0].text, /^Frontmost:/)
})

test('a granted window behind another app is named as covered, with the way to bring it forward', async () => {
  const h = harness({ responses: { observe: { ...observed, covered: [{ app: 'dev.dsh.bench.fixture', window_id: 7, fraction: 1, by: ['com.apple.safari'] }] } } })
  const out = await h.tools.cu_observe.execute({}, h.exec)
  assert.match(out.text, /Granted windows:\n.*\ndev\.dsh\.bench\.fixture: 100% of its window is behind com\.apple\.safari, so it is grey in the image\. Its elements below still come from the app and are current .*: answer from them when they say enough\. To see it, cu_launch dev\.dsh\.bench\.fixture brings it to the front\./)
  const clear = harness({ responses: { observe: { ...observed, covered: [] } } })
  assert.doesNotMatch((await clear.tools.cu_observe.execute({}, clear.exec)).text, /grey in the image/)
})

test('a look without the image says the latest image is from before the actions since then (0.2.1 host run)', async () => {
  let gen = 5
  const image = { base64: 'aGk=', mapping: { sent_size_px: [992, 645], display_bounds_pt: [0, 0, 1710, 1112], map: 'pt = img * 1.72' } }
  const h = await withSteps({ 'act.click': done,
    observe: (p) => ({ ...observed, snapshot_gen: gen++, windows: [{ app: 'com.tencent.qq', frame_pt: [0, 0, 800, 600] }],
      ...(p.include_image ? { image } : {}) }) })
  const first = await h.tools.cu_observe.execute({}, h.exec)
  assert.doesNotMatch(first.text, /No image in this look/, 'with its own image')
  const steps = await h.tools.cu_steps.execute({ steps: [{ tool: 'cu_click', args: { element_id: 'eaaaaaaa' } }] }, h.exec)
  assert.match(steps.text, /--- after the last step ---[\s\S]*No image in this look\. The latest image you have \(snapshot \d+\) shows the screen before the actions since then/)
  const again = await h.tools.cu_observe.execute({}, h.exec)
  assert.doesNotMatch(again.text, /No image in this look/, 'a fresh image is the current state')
})

test('an app on the user\'s deny list (settings window): the refusal reaches the model as final, nothing asked', async () => {
  // The daemon refuses the plugin's silent probe (access.request) outright; the plugin passes that on, no escalation.
  const h = desktop({ responses: { 'access.request': () => { throw new RpcError(-32010, 'com.tencent.xinWeChat is on the user\'s deny list; it is never granted to the model and never asked about, in any mode. Do not ask for it again', { reason: 'user_denied', retry: 'never', executed: false, note: 'work chats' }) } } })
  await assert.rejects(h.tools.cu_observe.execute({ app: 'com.tencent.xinWeChat' }, h.exec), (e) => /user_denied/.test(e.message) && /deny list/.test(e.message) && !/justification/.test(e.message))
  assert.equal(interactiveRequests(h).length, 0)
})

test('observe says plainly when an approved app is not running or has no window, and never fails over it', async () => {
  const none = { ...observed, windows: [] }
  for (const [listed, re] of [[[], /NOT RUNNING.*cu_launch.*ask the user.*guessed coordinates/],
                              [['com.tencent.qq'], /running but has no window on screen: cu_launch.*read mode is enough/]]) {
    const h = desktop({ responses: { observe: none, 'apps.list': listed } })
    await h.tools.cu_observe.execute(qq, h.exec)
    const out = await h.tools.cu_observe.execute({}, h.exec)
    assert.match(out.text, re)
  }
  const shown = desktop()
  await shown.tools.cu_observe.execute(qq, shown.exec)
  assert.doesNotMatch((await shown.tools.cu_observe.execute({}, shown.exec)).text, /NOT RUNNING|no window on screen/)
  const broken = desktop({ responses: { observe: none, 'apps.list': refused('no_grant') } })
  await broken.tools.cu_observe.execute(qq, broken.exec)
  assert.match((await broken.tools.cu_observe.execute({}, broken.exec)).text, /\(none on screen\)/)
})

test('cu_launch on a running app not yet approved asks once (full), whatever mode the daemon names', async () => {
  interactiveModes = []
  let n = 0
  const h = desktop({ grant: (p) => granted('com.tencent.qq', p.mode, 'turn'),
    responses: { 'apps.launch': () => { if (n++ === 0) throw new RpcError(-32010, 'no grant', { reason: 'no_grant', retry: 'never', executed: false, needs_mode: 'read' }); return { launched: true, was_running: true } } } })
  const out = await h.tools.cu_launch.execute({ ...qq, justification: 'show the QQ window to read it' }, h.exec)
  assert.match(out.text, /Brought forward: com\.tencent\.qq/)
  assert.deepEqual(interactiveModes, ['full'])
})

test('observe uses the daemon\'s app_states: minimized and hidden apps are named, with no extra call', async () => {
  const h = desktop({ responses: { observe: { ...observed, windows: [], app_states: { 'com.tencent.qq': 'minimized' } } } })
  await h.tools.cu_observe.execute(qq, h.exec)
  const out = await h.tools.cu_observe.execute({}, h.exec)
  assert.match(out.text, /com\.tencent\.qq is running but its windows are minimized: cu_launch brings it back \(read mode is enough\)/)
  assert.equal(h.calls.filter((c) => c.method === 'apps.list').length, 0)
})

test('the IME approval names the input method and the app as the person knows them', async () => {
  const asked = []
  let n = 0
  const named = new RpcError(-32010, 'needs approval', { reason: 'ime_switch_needs_approval', retry: 'never', executed: false,
    input_source: 'com.apple.inputmethod.SCIM.ITABC', input_source_name: '简体拼音' })
  const h = desktop({ approval: { ...ask, request: async (r) => { asked.push(r); return 'allowed-once' } },
    grant: (p) => ({ ...granted('com.tencent.qq', p.mode, 'turn'), app: { bundle_id: 'com.tencent.qq', name: 'QQ' } }),
    responses: { 'act.type': () => { if (n++ === 1) throw named; if (n === 1) throw refused('not_granted'); return { executed: true, via: 'event' } } } })
  await h.tools.cu_type.execute({ ...qq, text: 'hi' }, h.exec)
  assert.equal(asked.length, 1)
  assert.match(asked[0].reason, /要往「QQ」里输入文字，需要把输入法从「简体拼音」临时切到英文键盘（ABC），这次输入完立刻切回/)
})

test('the person reads dsh in English: the IME approval and the dialog request are in English', async () => {
  const asked = []
  const sent = []
  let n = 0
  const named = new RpcError(-32010, 'needs approval', { reason: 'ime_switch_needs_approval', retry: 'never', executed: false,
    input_source: 'com.apple.inputmethod.SCIM.ITABC', input_source_name: 'Pinyin - Simplified' })
  const h = desktop({ settings: localeSettings('en'), approval: { ...ask, request: async (r) => { asked.push(r); return 'allowed-once' } },
    grant: (p) => ({ ...granted('com.tencent.qq', p.mode, 'turn'), app: { bundle_id: 'com.tencent.qq', name: 'QQ' } }),
    responses: { 'act.type': () => { if (n++ === 1) throw named; if (n === 1) throw refused('not_granted'); return { executed: true, via: 'event' } } } })
  const request = h.tools.cu_type
  await request.execute({ ...qq, text: 'hi' }, h.exec)
  for (const c of h.calls) if (c.method === 'access.request') sent.push(c.params.lang)
  assert.ok(sent.length > 0 && sent.every((l) => l === 'en'), `every access.request says en: ${sent}`)
  assert.match(asked[0].reason, /wants to type into “QQ” .* from “Pinyin - Simplified” to the English keyboard \(ABC\).* right after this input/)
  assert.doesNotMatch(asked[0].reason, /[\u4e00-\u9fff]/)
})

test('dsh language: its locale.preference, else the system locale; zh or en only', async () => {
  const { uiLanguage, languagePrompt } = await import('../lib/lang.js')
  assert.equal(uiLanguage(localeSettings('zh'), 'en-US'), 'zh')
  assert.equal(uiLanguage(localeSettings('en'), 'zh-Hans-CN'), 'en', "dsh's setting wins over the system")
  assert.equal(uiLanguage(localeSettings(undefined), 'zh-Hans-CN'), 'zh', 'not set: the system decides')
  assert.equal(uiLanguage(undefined, 'zh-CN'), 'zh', 'no settings service')
  assert.equal(uiLanguage({ get: () => { throw new TypeError('unregistered') } }, 'en-GB'), 'en', 'no locale namespace')
  assert.equal(uiLanguage(localeSettings('fr'), 'fr-FR'), 'en', 'anything else reads English')
  assert.match(languagePrompt('zh'), /answer in Chinese.*Switch only when the user explicitly asks.*not such a request/s)
  assert.match(languagePrompt('en'), /answer in English/)
})

test("the system locale is macOS's first preferred language, not node's Intl (en-US without LANG)", async () => {
  const { uiLanguage, firstAppleLanguage, systemLocale } = await import('../lib/lang.js')
  assert.equal(firstAppleLanguage('(\n    "zh-Hans-GB",\n    "en-GB"\n)\n'), 'zh-Hans-GB')
  assert.equal(firstAppleLanguage('(\n    en,\n    "zh-Hans-CN"\n)\n'), 'en', 'a bare tag is unquoted')
  assert.equal(firstAppleLanguage('(\n)\n'), undefined)
  assert.equal(firstAppleLanguage(''), undefined)
  let read = 0
  const system = () => { read += 1; return 'zh-Hans-HK' }
  assert.equal(uiLanguage(localeSettings('en'), system), 'en')
  assert.equal(read, 0, 'the system is not read when dsh has a setting')
  assert.equal(uiLanguage(localeSettings(undefined), system), 'zh')
  assert.equal(read, 1)
  if (process.platform === 'darwin') {
    const { execFileSync } = await import('node:child_process')
    const listing = execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8' })
    assert.equal(systemLocale(), firstAppleLanguage(listing), 'this Mac')
  }
})

test('the reply-language section: daily use only, read from dsh settings at each assembly', async () => {
  const { apply } = await import('../lib/index.js')
  const sections = (appApproval, settings) => {
    const out = {}
    const ctx = { on: () => {}, effect: () => {}, systemPrompt: { section: (s) => { out[s.name] = s } },
                  tools: { register: () => {} }, logger: { warn: () => {} }, get: (n) => (n === 'settings' ? settings : undefined) }
    apply(ctx, Config({ stateDir: '/nonexistent', apps: [], electronAx: false, appApproval }))
    return out
  }
  let pref = 'zh'
  const live = { get: (ns) => (ns === 'locale' ? { preference: pref } : undefined) }
  const desk = sections('dialog', live)
  assert.match(desk['cu-runtime-language'].text(), /answer in Chinese/)
  pref = 'en'
  assert.match(desk['cu-runtime-language'].text(), /answer in English/, 'a change in dsh applies at the next assembly')
  assert.equal(sections('none', live)['cu-runtime-language'], undefined, 'the bench prompt is unchanged')
})

test('looking at an app that is not running asks nothing and points to cu_launch (one full dialog)', async () => {
  interactiveModes = []
  const h = desktop({ responses: { 'access.request': (p) => {
    if (p.interactive) return { ...pending, mode: p.mode }
    throw new RpcError(-32010, 'nobody', { reason: 'approval_unavailable', retry: 'never', executed: false, app_running: false })
  } } })
  await assert.rejects(h.tools.cu_observe.execute(qq, h.exec), /Nothing was asked: com\.tencent\.qq is not running.*cu_launch.*one dialog/)
  assert.deepEqual(interactiveModes, [])
})

test('cu_menu: one full dialog on first touch; listings and unknown titles come back as untrusted data; the bench has none', async () => {
  interactiveModes = []
  let n = 0
  const h = desktop({ grant: (p) => granted('com.tencent.qq', p.mode, 'turn'), responses: { 'act.menu': (p) => {
    if (n++ === 0) throw refused('not_granted')
    if (p.path.length === 1) return { executed: false, untrusted_items: [{ title: 'Bold', enabled: true, submenu: false }, { title: 'Font', enabled: false, submenu: true }] }
    if (p.path[1] === 'Nope') throw new RpcError(-32010, 'no menu item', { reason: 'menu_not_found', retry: 'never', executed: false, untrusted_available: ['Font', 'Text'] })
    return { executed: true, via: 'ax' }
  } } })
  const args = { ...qq, path: ['Format'] }
  const listed = await h.tools.cu_menu.execute({ ...args, justification: 'make the text bold' }, h.exec)
  assert.match(listed.text, /untrusted observation[\s\S]*"Bold"\n"Font" > \[disabled\]/)
  assert.deepEqual(interactiveModes, ['full'])
  await assert.rejects(h.tools.cu_menu.execute({ ...qq, path: ['Format', 'Nope'] }, h.exec), /menu_not_found.*data only\): "Font", "Text"/)
  assert.match((await h.tools.cu_menu.execute({ ...qq, path: ['Format', 'Bold'] }, h.exec)).text, /menu item pressed/)
  assert.equal(harness().tools.cu_menu, undefined)
})

// M4 (2026-10-14): the daemon gives approvals only in a turn the asking client marked. turn/start marks with
// start:false, so a daemon that comes up with this turn's first cu_* call is marked late, before that call.

test('a turn the daemon did not see start is marked late, once, before the first daemon call', async () => {
  const h = harness({ config: { appApproval: 'dialog' }, responses: { observe: observed } })
  await h.tools.cu_observe.execute({}, h.exec).catch(() => {})
  await h.tools.cu_observe.execute({}, h.exec).catch(() => {})
  const marks = h.calls.filter((c) => c.method === 'access.turn_start')
  assert.equal(h.calls[0].method, 'access.turn_start', 'before anything else')
  assert.deepEqual(marks.map((c) => c.params), [{ task_id: 'dsh-s1', late: true }], 'once per turn')
  h.tasks.endTurn('dsh-s1')
  await h.tools.cu_observe.execute({}, h.exec).catch(() => {})
  assert.equal(h.calls.filter((c) => c.method === 'access.turn_start').length, 2, 'the next turn marks again')
})

test('turn/start\'s own mark is used; only a failed one is redone late; concurrent calls share one late mark', async () => {
  const tasks = new Tasks({ apps: [], electronAx: false, grantTtlS: 600 })
  let n = 0
  const mark = () => { n++; return new Promise((r) => setTimeout(r, 10)) }
  tasks.startTurn('t', Promise.resolve(true))
  await tasks.ensureTurn('t', mark)
  assert.equal(n, 0, 'marked at turn/start: nothing more')
  tasks.startTurn('t', Promise.resolve(false))
  await Promise.all([tasks.ensureTurn('t', mark), tasks.ensureTurn('t', mark), tasks.ensureTurn('t', mark)])
  assert.equal(n, 1, 'one late mark for all of them')
  await tasks.ensureTurn('t', mark)
  assert.equal(n, 1)
  const failing = () => { n++; return Promise.reject(new Error('daemon gone')) }
  tasks.endTurn('t')
  await tasks.ensureTurn('t', failing)  // not thrown: the daemon refuses what needs the mark
  await tasks.ensureTurn('t', failing)
  assert.equal(n, 3, 'a failed late mark is tried again on the next call')
})

test('the bench (appApproval none) never marks turns', async () => {
  const h = harness({ responses: { observe: observed } })
  await h.tools.cu_observe.execute({}, h.exec)
  assert.equal(h.calls.filter((c) => c.method === 'access.turn_start').length, 0)
})

test('the tests run against the dsh packages package.json names (VM 2026-10-14: a stale node_modules hid an API change)', async () => {
  const { readFileSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const wanted = { ...pkg.dependencies, ...pkg.devDependencies }
  const names = Object.keys(wanted).filter((n) => n.startsWith('@deepseek-ai/'))
  assert.ok(names.length > 5)
  for (const name of names) {
    const installed = JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8')).version
    assert.equal(installed, wanted[name], `${name}: run npm ci in plugin/`)
  }
})
