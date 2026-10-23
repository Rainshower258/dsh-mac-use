// The plugin page's settings routes (plugin/src/daemon/settings.ts, routes.ts, the manager's
// settingsGate). No real daemon is reached and no real command runs: the host acts on a fake Mac (world, through the
// System facade) and talks to a fake daemon client (clients, through HostOptions.settingsClient).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import * as host from '../lib/host.js'
import { DaemonUnavailable, RpcError } from '../lib/client.js'
import { SETTINGS_BUSY_PHASES } from '../lib/daemon/manager.js'
import { daemonPaths } from '../lib/daemon/paths.js'
import { SETTINGS_TIMEOUT_MS } from '../lib/daemon/settings.js'

const HOME = '/home/someone'
const PKG = host.PACKAGE_ROOT
const SHA = 'AB'.repeat(20)
const OTHER_SHA = 'CD'.repeat(20)
const PKG_HASH = 'f'.repeat(64)
const T0 = Date.parse('2026-10-21T12:00:00Z')
const RUNTIME_FLAGS = '0x10000(runtime)'

/** The daemon's settings.action names, written out (Dispatcher.settingsActions). */
const ACTIONS = ['choose_log_directory', 'use_default_log_directory', 'choose_app', 'export_settings', 'export_audit', 'import',
  'import_confirm', 'reveal_log']
/** The daemon tab's routes, which the settings routes leave as they are. */
const STAGE2 = ['acceptIdentity', 'cancel', 'clt', 'install', 'permissions', 'restart', 'selfcheck', 'start', 'status', 'stop']
const ZERO_PARAMETER = ['settings.snapshot', 'settings.cancelVerify', ...ACTIONS.map((a) => `settings.action.${a}`)]
/** The four daemon methods the host may call, and nothing else. */
const METHODS = ['settings.snapshot', 'settings.apply', 'settings.cancel_verify', 'settings.action']

/** An Info.plist of the fake (JSON standing for the plist): what plutil reads and the signature the fake codesign checks. */
const info = ({ version = '20261021.100000-abc1234', bench = false, signer = SHA, flags = RUNTIME_FLAGS } = {}) =>
  JSON.stringify({ CFBundleVersion: version, CUSourceHash: PKG_HASH, ...(bench === null ? {} : { CUBench: bench }), signer, flags })

/**
 * A fake Mac, as far as the settings gate and the install task look at it: files are a map path → text, a directory
 * exists when it was made or anything is under it; `hold[label]` makes that command wait until it is released, so the
 * install task stays in the phase that runs it.
 */
function world({ home = HOME } = {}) {
  const P = daemonPaths(home, PKG)
  const w = { P, clock: T0, files: new Map(), dirs: new Set([home, P.stateDir]), identities: [SHA], daemons: [], nextPid: 500,
    calls: [], hold: {}, released: {} }
  const under = (path) => [...w.files.keys()].filter((k) => k === path || k.startsWith(`${path}/`))
  w.install = (over = {}) => {
    w.files.set(P.appInfo, info(over))
    w.files.set(P.appBinary, 'bin')
  }
  w.files.set(P.knownIdentity, `${SHA}\n`)
  w.files.set(join(PKG, 'package.json'), JSON.stringify({ name: 'cu-runtime', version: '0.2.0' }))
  for (const f of ['Package.swift', 'Sources/x.swift', 'Tests/t.swift', 'scripts/build-app.sh']) w.files.set(join(PKG, f), f)
  const fs = {
    exists: (p) => w.files.has(p) || w.dirs.has(p) || under(p).length > 0 || [...w.dirs].some((d) => d.startsWith(`${p}/`)),
    readText: (p) => w.files.get(p),
    mtimeMs: (p) => (w.files.has(p) ? w.clock : undefined),
    writeText: (p, t) => { w.files.set(p, t) },
    appendText: (p, t) => { w.files.set(p, (w.files.get(p) ?? '') + t) },
    createExclusive: (p, t) => {
      if (w.files.has(p)) return false
      w.files.set(p, t)
      return true
    },
    mkdir: (p) => { w.dirs.add(p) },
    rm: (p) => {
      for (const k of under(p)) w.files.delete(k)
      for (const d of [...w.dirs]) if (d === p || d.startsWith(`${p}/`)) w.dirs.delete(d)
    },
    rename: (a, b) => {
      const moved = under(a)
      if (moved.length === 0) throw new Error(`rename ${a}: ENOENT`)
      for (const k of moved) {
        w.files.set(b + k.slice(a.length), w.files.get(k))
        w.files.delete(k)
      }
    },
  }
  const ok = (stdout = '', stderr = '') => ({ code: 0, stdout, stderr })
  const no = (stderr = 'failed', code = 1) => ({ code, stdout: '', stderr })
  const plistOf = (app) => {
    const text = w.files.get(join(app, 'Contents/Info.plist'))
    return text === undefined ? undefined : JSON.parse(text)
  }
  const commands = {
    'plutil -extract': (args) => {
      const text = w.files.get(args.at(-1))
      const value = text === undefined ? undefined : JSON.parse(text)[args[1]]
      return value === undefined ? no('Could not extract value') : ok(`${value}\n`)
    },
    'security find-identity': () => ok([...w.identities.map((h, i) => `  ${i + 1}) ${h} "cu-runtime-signing" (CSSMERR_TP_NOT_TRUSTED)`),
      `     ${w.identities.length} identities found`].join('\n')),
    'codesign --verify': (args) => {
      const plist = plistOf(args.at(-1))
      if (plist === undefined) return no('No such file or directory')
      if (args[2] !== '-R') return ok()
      return args[3] === `=identifier "dev.cu-runtime.daemon" and certificate leaf = H"${plist.signer}"` ? ok() : no('failed to satisfy', 3)
    },
    'codesign -d': (args) => {
      const plist = plistOf(args.at(-1))
      return plist === undefined ? no('No such file or directory') : ok('', `CodeDirectory v=20500 size=1 flags=${plist.flags} hashes=1+1\n`)
    },
    'ps -axww': () => ok([...w.daemons.map((pid) => `  ${pid} ${P.appBinary} serve`), `  77 ${P.appBinary} self-check --out /tmp/x`,
      '  78 /opt/other/cu-runtime serve'].join('\n')),
    'xcode-select -p': () => ok('/Library/Developer/CommandLineTools\n'),
    'launchctl managername': () => ok('Aqua\n'),
    'ditto': (args) => {
      const [from, to] = args
      if (w.files.has(from)) w.files.set(to, w.files.get(from))
      for (const k of under(from)) w.files.set(to + k.slice(from.length), w.files.get(k))
      return ok()
    },
    'zsh build-app.sh': () => {
      w.files.set(join(P.builtApp, 'Contents/Info.plist'), info({ version: '20261021.120000-nogit' }))
      return ok()
    },
    'open -g': () => {
      w.daemons.push(w.nextPid++)
      return ok()
    },
    'open -n': (args) => {
      if (args[3] === 'self-check') w.files.set(args[5], JSON.stringify({ version: '20261021.120000-nogit', ax_trusted: true, sck: { ok: true } }))
      return ok()
    },
  }
  const label = (file, args) => {
    const name = basename(file)
    if (name === 'zsh') return `zsh ${basename(args.at(-1))}`
    if (name === 'ditto') return 'ditto'
    return `${name} ${args[0]}`
  }
  w.system = {
    run: async (file, args) => {
      const l = label(file, args)
      w.calls.push(l)
      await new Promise((r) => setImmediate(r))
      if (w.hold[l] !== undefined) await w.hold[l]
      const handler = commands[l]
      if (handler === undefined) throw new Error(`unexpected command: ${l}`)
      return handler(args)
    },
    fs,
    kill: (pid) => {
      w.daemons = w.daemons.filter((p) => p !== pid)
      return true
    },
    alive: (pid) => pid === 9999,
    connects: async (path) => path === P.socket && w.daemons.length > 0,
    sleep: async (ms) => {
      w.clock += ms
      await new Promise((r) => setImmediate(r))
      if (w.holdSleep !== undefined) await w.holdSleep
    },
    now: () => w.clock,
    env: { USER: 'someone' },
    home,
    pid: 9999,
  }
  /** Makes `label` wait until w.release(label). */
  w.holdOn = (l) => { w.hold[l] = new Promise((resolve) => { w.released[l] = resolve }) }
  w.release = (l) => {
    w.released[l]?.()
    delete w.hold[l]
  }
  return w
}

/** A world where the verified installed app runs. */
function running() {
  const w = world()
  w.install()
  w.daemons = [400]
  return w
}

/**
 * The fake daemon client factory: every client made, with the options it was made with, the requests it got and
 * whether it was closed. `answer(method, params)` gives the result (or throws, as the client would).
 */
function clients(answer = () => ({ status: 'applied' })) {
  const c = { made: [], answer }
  c.factory = (options) => {
    const client = { options, requests: [], closed: false, openWhenAsked: 0 }
    client.request = async (method, params, signal, opts) => {
      client.requests.push({ method, params, signal, opts })
      client.openWhenAsked = c.made.filter((m) => !m.closed).length
      await new Promise((r) => setImmediate(r))
      return c.answer(method, params)
    }
    client.close = () => { client.closed = true }
    c.made.push(client)
    return client
  }
  /** Every request sent, over all clients. */
  c.sent = () => c.made.flatMap((m) => m.requests)
  return c
}

/** The host plugin on a fake context with the fake client; `call(op, init)` posts to one route. */
function hostOn(w, c = clients()) {
  const routes = []
  const ctx = {
    get: (name) => (name === 'profileContext' ? { name: 'web' } : undefined),
    effect: () => {},
    inject: (_deps, callback) => callback({ connection: { fetch: { register: (r) => { routes.push(r); return async () => {} } } } }),
  }
  host.applyWith({ system: w.system, packageSourceHash: () => PKG_HASH, sourceHash: () => PKG_HASH, bootTime: () => 1000,
    settingsClient: c.factory })(ctx)
  const request = (op, init = {}) => new Request(`http://127.0.0.1:1/api/cu-runtime.${op}${init.query ?? ''}`,
    { method: 'POST', body: init.body, headers: init.headers, duplex: init.duplex })
  const call = async (op, init = {}) => {
    const route = routes.find((r) => r.path === `/api/cu-runtime.${op}`)
    const res = await route.fetch(init.request ?? request(op, init))
    return { res, body: await res.json() }
  }
  const PAGE = { 'content-type': 'application/json', 'x-cu-runtime-page': '1' }
  /** settings.apply with this body (an object is JSON-encoded) and the page's headers unless others are given. */
  const apply = (body, headers = PAGE) => call('settings.apply', { body: typeof body === 'string' ? body : JSON.stringify(body), headers })
  return { routes, call, apply, PAGE, c }
}

// ------------------------------------------------------------------------------------------------ routes

test('routes: the daemon tab\'s, settings.snapshot, settings.apply, settings.cancelVerify and one per action, the mode check\'s; nothing else', () => {
  const { routes } = hostOn(running())
  const expected = [...STAGE2, 'settings.snapshot', 'settings.apply', 'settings.cancelVerify', ...ACTIONS.map((a) => `settings.action.${a}`),
    'modeCheck', 'modeCheckRefresh']
  assert.deepEqual(routes.map((r) => r.path).sort(), expected.map((op) => `/api/cu-runtime.${op}`).sort())
  for (const r of routes) {
    assert.deepEqual(r.methods, ['POST'])
    assert.equal(r.requestBody, 'buffered')
  }
})

test('settings routes answer JSON with cache-control no-store, also when refused', async () => {
  const { call, apply } = hostOn(running(), clients(() => ({ started_at: 1 })))
  for (const { res } of [await call('settings.snapshot'), await apply('nope'), await hostOn(world()).call('settings.snapshot')]) {
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.match(res.headers.get('content-type'), /application\/json/)
  }
})

test('the zero-parameter routes never read the request: a body, a query or headers naming a path change nothing', async () => {
  for (const op of ZERO_PARAMETER) {
    const plain = clients((method) => (method === 'settings.snapshot' ? { started_at: 1 } : { status: 'done' }))
    const { call } = hostOn(running(), plain)
    const quiet = (await call(op)).body
    const evil = clients(plain.answer)
    const other = hostOn(running(), evil)
    let pulled = false
    const body = new ReadableStream({ pull() { pulled = true; throw new Error('read') } }, { highWaterMark: 0 })
    const request = new Request(`http://127.0.0.1:1/api/cu-runtime.${op}?name=reveal_log&path=/etc&state_dir=/tmp`, {
      method: 'POST', body, duplex: 'half',
      headers: { 'content-type': 'application/json', 'x-cu-runtime-page': '1', 'x-method': 'settings.apply' },
    })
    assert.deepEqual((await other.call(op, { request })).body, quiet, op)
    assert.equal(request.bodyUsed, false, op)
    assert.equal(pulled, false, op)
    assert.deepEqual(evil.sent().map((r) => [r.method, r.params]), plain.sent().map((r) => [r.method, r.params]), op)
    // Also a JSON body naming another change or action.
    const third = clients(plain.answer)
    await hostOn(running(), third).call(op, { body: JSON.stringify({ change: { kind: 'reset' }, name: 'reveal_log', method: 'x' }),
      headers: { 'content-type': 'application/json', 'x-cu-runtime-page': '1' } })
    assert.deepEqual(third.sent().map((r) => [r.method, r.params]), plain.sent().map((r) => [r.method, r.params]), op)
  }
})

test('each route calls exactly its daemon method, an action route exactly its name; no route calls anything else', async () => {
  const c = clients((method) => (method === 'settings.snapshot' ? {} : { status: 'done' }))
  const { call, apply } = hostOn(running(), c)
  const seen = []
  const expect = async (run, method, params) => {
    const before = c.sent().length
    await run()
    const sent = c.sent().slice(before)
    assert.deepEqual(sent.map((r) => [r.method, r.params]), [[method, params]])
    seen.push(method)
  }
  await expect(() => call('settings.snapshot'), 'settings.snapshot', {})
  await expect(() => call('settings.cancelVerify'), 'settings.cancel_verify', {})
  for (const a of ACTIONS) await expect(() => call(`settings.action.${a}`), 'settings.action', { name: a })
  await expect(() => apply({ change: { kind: 'reset' } }), 'settings.apply', { change: { kind: 'reset' } })
  for (const r of c.sent()) {
    assert.ok(METHODS.includes(r.method), r.method)
    if (r.method === 'settings.action') assert.ok(ACTIONS.includes(r.params.name))
  }
  assert.deepEqual([...new Set(seen)].sort(), [...METHODS].sort())
})

// ------------------------------------------------------------------------------------------------ settings.apply's body

const long = (n, ch = 'a') => ch.repeat(n)

/** settings.apply's bodies that the host refuses (bad_request), with nothing sent to the daemon. */
const BAD_CHANGES = [
  // the change itself
  ['change not an object', 'reset'],
  ['change an array', [{ kind: 'reset' }]],
  ['change null', null],
  ['kind missing', {}],
  ['kind not a string', { kind: 7 }],
  ['unknown kind', { kind: 'logs.directory' }],
  ['the import kind', { kind: 'import' }],
  ['unknown kind (prototype name)', { kind: 'constructor' }],
  ['unknown kind (prototype name 2)', { kind: '__proto__' }],
  // keys
  ['verified', { kind: 'privacy.set', field: 'send_ax_text', on: true, verified: true }],
  ['path', { kind: 'logs.default_directory', path: '/tmp' }],
  ['directory', { kind: 'logs.retention', days: 30, directory: '/tmp' }],
  ['state_dir', { kind: 'reset', state_dir: '/tmp' }],
  ['an extra key on a kind without keys', { kind: 'revoke_all', task_id: 't1' }],
  ['missing key', { kind: 'persistent.add', bundle_id: 'com.example.app' }],
  ['missing note', { kind: 'deny.add', bundle_id: 'com.example.app' }],
  ['missing app', { kind: 'chord.add', chord: 'cmd+k', note: '' }],
  // types
  ['task_id a number', { kind: 'revoke', task_id: 7 }],
  ['bundle_id a number', { kind: 'persistent.remove', bundle_id: 1 }],
  ['on a string', { kind: 'clipboard.set', on: 'true' }],
  ['on a number', { kind: 'privacy.set', field: 'send_ocr', on: 1 }],
  ['days a string', { kind: 'logs.retention', days: '30' }],
  ['access value a string number', { kind: 'access.set', field: 'session_limit_minutes', value: '30' }],
  ['behavior bool a string', { kind: 'behavior.set', field: 'allow_point_targets', value: 'true' }],
  ['app missing type', { kind: 'chord.remove', chord: 'cmd+k', app: 3 }],
  ['note null', { kind: 'deny.add', bundle_id: 'com.example.app', note: null }],
  // values outside the offered sets
  ['mode', { kind: 'persistent.add', bundle_id: 'com.example.app', mode: 'admin' }],
  ['access field', { kind: 'access.set', field: 'allow_finder', value: true }],
  ['default_mode value', { kind: 'access.set', field: 'default_mode', value: 'always' }],
  ['session limit value', { kind: 'access.set', field: 'session_limit_minutes', value: 45 }],
  ['session limit fraction', { kind: 'access.set', field: 'session_limit_minutes', value: 30.5 }],
  ['dialogs value', { kind: 'access.set', field: 'dialogs_per_turn', value: 4 }],
  ['timeout value', { kind: 'access.set', field: 'dialog_timeout_seconds', value: 30 }],
  ['dialog default value', { kind: 'access.set', field: 'dialog_default', value: 'forever' }],
  ['privacy field', { kind: 'privacy.set', field: 'send_audio', on: true }],
  ['privacy field (camel case)', { kind: 'privacy.set', field: 'sendAXText', on: true }],
  ['behavior field', { kind: 'behavior.set', field: 'debug_ime', value: true }],
  ['ime cap value', { kind: 'behavior.set', field: 'ime_policy_cap', value: 'always' }],
  ['activation value', { kind: 'behavior.set', field: 'activation_method', value: 'click' }],
  ['null for a bool behavior', { kind: 'behavior.set', field: 'electron_ax_auto', value: null }],
  ['null for the ime cap', { kind: 'behavior.set', field: 'ime_policy_cap', value: null }],
  ['retention 14', { kind: 'logs.retention', days: 14 }],
  ['retention 0', { kind: 'logs.retention', days: 0 }],
  // bundle IDs
  ['bundle_id empty', { kind: 'persistent.remove', bundle_id: '' }],
  ['bundle_id 256 characters', { kind: 'persistent.remove', bundle_id: long(256) }],
  ['bundle_id with a space', { kind: 'text_only.add', bundle_id: 'com.example app' }],
  ['bundle_id with a tab', { kind: 'text_only.remove', bundle_id: 'com.example\tapp' }],
  ['bundle_id with a no-break space', { kind: 'deny.remove', bundle_id: 'com.example\u00a0app' }],
  ['bundle_id with a line separator', { kind: 'persistent.reapprove', bundle_id: 'com.example\u2028app' }],
  ['bundle_id with a newline', { kind: 'persistent.mode', bundle_id: 'com.example\napp', mode: 'full' }],
  ['bundle_id with a zero-width space (Cf)', { kind: 'deny.add', bundle_id: 'com.exa\u200bmple', note: '' }],
  ['bundle_id with a lone surrogate', { kind: 'deny.add', bundle_id: 'com.\ud800example', note: '' }],
  ['chord app with a space', { kind: 'chord.add', chord: 'cmd+k', app: 'com.example app', note: '' }],
  ['chord app empty', { kind: 'chord.remove', chord: 'cmd+k', app: '' }],
  // notes
  ['note 201 characters', { kind: 'deny.add', bundle_id: 'com.example.app', note: long(201) }],
  ['note with a newline', { kind: 'deny.add', bundle_id: 'com.example.app', note: 'line\nbreak' }],
  ['note with an escape', { kind: 'chord.add', chord: 'cmd+k', app: null, note: '\u001b[31m' }],
  ['note with a zero-width joiner (Cf)', { kind: 'deny.add', bundle_id: 'com.example.app', note: '👨\u200d👩' }],
  ['note of 201 characters as Swift counts them', { kind: 'deny.add', bundle_id: 'com.example.app', note: 'e\u0301'.repeat(201) }],
  ['note with a right-to-left override (Cf)', { kind: 'chord.add', chord: 'cmd+k', app: null, note: 'a\u202eb' }],
  // chords
  ['chord empty', { kind: 'chord.disable', chord: '' }],
  ['chord blank', { kind: 'chord.enable', chord: '  \t ' }],
  ['chord 65 characters', { kind: 'chord.disable', chord: long(65) }],
  ['chord with a control character', { kind: 'chord.remove', chord: 'cmd+\u0000', app: null }],
  ['chord a number', { kind: 'chord.enable', chord: 1 }],
  // task IDs
  ['task_id empty', { kind: 'revoke', task_id: '' }],
  ['task_id 256 characters', { kind: 'revoke', task_id: long(256) }],
  ['task_id with a control character', { kind: 'revoke', task_id: 'task\u007f' }],
]

test('settings.apply: every malformed change is bad_request (HTTP 400), and nothing reaches the gate or the daemon', async () => {
  for (const [what, change] of BAD_CHANGES) {
    const w = running()
    const c = clients()
    const { apply } = hostOn(w, c)
    const { res, body } = await apply({ change })
    assert.equal(res.status, 400, what)
    assert.equal(body.ok, false, what)
    assert.equal(body.error.code, 'bad_request', what)
    assert.equal(typeof body.error.message, 'string', what)
    assert.ok(body.error.message.length <= 300, what)
    assert.deepEqual(c.made, [], `${what}: no client made`)
    assert.deepEqual(w.calls, [], `${what}: no command ran`)
  }
  // The messages name the key, as the daemon's do.
  const message = async (change) => (await hostOn(running()).apply({ change })).body.error.message
  assert.equal(await message({ kind: 'persistent.add', bundle_id: 'com.example.app' }), 'persistent.add needs mode')
  assert.equal(await message({ kind: 'reset', verified: true, path: '/tmp' }), 'reset takes no path, verified')
  assert.equal(await message({ kind: 'logs.retention', days: 14 }), 'logs.retention: days must be one of 7, 30, 90')
})

test('settings.apply: the request itself (headers, size, JSON, the one key) is checked before anything else', async () => {
  const json = { 'content-type': 'application/json' }
  const PAGE = { ...json, 'x-cu-runtime-page': '1' }
  const reset = JSON.stringify({ change: { kind: 'reset' } })
  /** Pads a valid body with spaces to n bytes. */
  const padded = (n) => reset.padEnd(n, ' ')
  const cases = [
    ['no page header', reset, json],
    ['page header 0', reset, { ...json, 'x-cu-runtime-page': '0' }],
    ['page header true', reset, { ...json, 'x-cu-runtime-page': 'true' }],
    ['no content-type', reset, { 'x-cu-runtime-page': '1' }],
    ['text/plain', reset, { 'content-type': 'text/plain', 'x-cu-runtime-page': '1' }],
    ['a form', reset, { 'content-type': 'application/x-www-form-urlencoded', 'x-cu-runtime-page': '1' }],
    ['application/json-seq', reset, { 'content-type': 'application/json-seq', 'x-cu-runtime-page': '1' }],
    ['multipart', reset, { 'content-type': 'multipart/form-data; boundary=x', 'x-cu-runtime-page': '1' }],
    ['content-length above 4096', reset, { ...PAGE, 'content-length': '4097' }],
    ['content-length not a number', reset, { ...PAGE, 'content-length': 'many' }],
    ['content-length negative', reset, { ...PAGE, 'content-length': '-1' }],
    ['4097 bytes without content-length', padded(4097), PAGE],
    ['4097 bytes under a content-length of 10', padded(4097), { ...PAGE, 'content-length': '10' }],
    ['multi-byte text above 4096 bytes', JSON.stringify({ change: { kind: 'deny.add', bundle_id: 'com.example.app', note: '注'.repeat(1400) } }), PAGE],
    ['empty body', '', PAGE],
    ['invalid JSON', '{"change": {"kind": "reset"}', PAGE],
    ['invalid UTF-8', new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]), PAGE],
    ['JSON null', 'null', PAGE],
    ['a JSON string', '"reset"', PAGE],
    ['a JSON array', '[{"change": {"kind": "reset"}}]', PAGE],
    ['no change key', '{}', PAGE],
    ['an extra top-level key', JSON.stringify({ change: { kind: 'reset' }, verified: true }), PAGE],
    ['an extra top-level state_dir', JSON.stringify({ change: { kind: 'reset' }, state_dir: '/tmp' }), PAGE],
    ['change under another key', JSON.stringify({ changes: { kind: 'reset' } }), PAGE],
    ['__proto__ beside change', '{"change": {"kind": "reset"}, "__proto__": {"x": 1}}', PAGE],
  ]
  for (const [what, body, headers] of cases) {
    const w = running()
    const c = clients()
    const { call } = hostOn(w, c)
    const { res, body: answer } = await call('settings.apply', { body, headers })
    assert.equal(res.status, 400, what)
    assert.deepEqual(Object.keys(answer.error).sort(), ['code', 'message'], what)
    assert.equal(answer.error.code, 'bad_request', what)
    assert.deepEqual(c.made, [], `${what}: no client made`)
    assert.deepEqual(w.calls, [], `${what}: no command ran`)
  }
  // The limits themselves pass: 4096 bytes (content-length 4096), charset in the content-type, mixed case.
  const c = clients()
  const { call } = hostOn(running(), c)
  for (const [body, headers] of [[padded(4096), { ...PAGE, 'content-length': '4096' }], [padded(4096), PAGE],
    [reset, { 'content-type': 'Application/JSON; charset=utf-8', 'x-cu-runtime-page': '1' }]]) {
    const { res, body: answer } = await call('settings.apply', { body, headers })
    assert.equal(res.status, 200)
    assert.deepEqual(answer, { ok: true, result: { status: 'applied' } })
  }
  assert.equal(c.sent().length, 3)
})

test('settings.apply: a body that streams past 4096 bytes is refused without reading it all', async () => {
  const c = clients()
  const { call, PAGE } = hostOn(running(), c)
  let pulls = 0
  const body = new ReadableStream({
    pull(controller) {
      pulls++
      controller.enqueue(new TextEncoder().encode(' '.repeat(1024)))
      if (pulls > 100) controller.close()
    },
  })
  const request = new Request('http://127.0.0.1:1/api/cu-runtime.settings.apply', { method: 'POST', body, duplex: 'half', headers: PAGE })
  const { res, body: answer } = await call('settings.apply', { request })
  assert.equal(res.status, 400)
  assert.equal(answer.error.code, 'bad_request')
  assert.ok(pulls < 10, `stopped reading early (${pulls} chunks)`)
  assert.deepEqual(c.made, [])
})

/** One valid change per kind (and per field), as the page may send it, and what the daemon gets. */
const GOOD_CHANGES = [
  [{ kind: 'revoke', task_id: 'task-1' }],
  [{ kind: 'revoke', task_id: long(255, 't') }],
  [{ kind: 'revoke_all' }],
  [{ kind: 'persistent.remove', bundle_id: 'com.example.app' }],
  [{ kind: 'persistent.remove', bundle_id: long(255, 'b') }],
  [{ kind: 'persistent.add', bundle_id: 'com.example.app', mode: 'read' }],
  [{ kind: 'persistent.add', bundle_id: 'com.example.app', mode: 'full' }],
  [{ kind: 'persistent.mode', bundle_id: 'com.example.app', mode: 'full' }],
  [{ kind: 'persistent.reapprove', bundle_id: 'com.example.app' }],
  [{ kind: 'deny.add', bundle_id: 'com.example.app', note: '' }],
  [{ kind: 'deny.add', bundle_id: 'com.example.app', note: `${'备'.repeat(199)}注` }],
  // Characters as Swift counts them (grapheme clusters): 200 of e + a combining acute, 255 flags.
  [{ kind: 'deny.add', bundle_id: 'com.example.app', note: 'e\u0301'.repeat(200) }],
  [{ kind: 'persistent.remove', bundle_id: '🇨🇳'.repeat(255) }],
  [{ kind: 'deny.remove', bundle_id: 'com.example.app' }],
  ...[['default_mode', 'ask'], ['default_mode', 'read'], ['default_mode', 'full'], ['session_limit_minutes', 15],
    ['session_limit_minutes', 30], ['session_limit_minutes', 60], ['dialogs_per_turn', 1], ['dialogs_per_turn', 3],
    ['dialog_timeout_seconds', 60], ['dialog_timeout_seconds', 180], ['dialog_default', 'deny'], ['dialog_default', 'turn'],
    ['dialog_default', 'session'], ['dialog_default', 'always']].map(([field, value]) => [{ kind: 'access.set', field, value }]),
  [{ kind: 'chord.disable', chord: 'cmd+q' }],
  [{ kind: 'chord.enable', chord: long(64, 'k') }],
  [{ kind: 'chord.add', chord: 'cmd+shift+k', app: null, note: 'everywhere' }],
  [{ kind: 'chord.add', chord: 'cmd+k', app: 'com.example.app', note: '' }],
  [{ kind: 'chord.remove', chord: 'cmd+k', app: null }],
  [{ kind: 'chord.remove', chord: 'cmd+k', app: 'com.example.app' }],
  ...['send_screenshots', 'send_ax_text', 'send_ocr', 'send_zoom'].flatMap((field) => [true, false]
    .map((on) => [{ kind: 'privacy.set', field, on }])),
  [{ kind: 'text_only.add', bundle_id: 'com.example.app' }],
  [{ kind: 'text_only.remove', bundle_id: 'com.example.app' }],
  [{ kind: 'clipboard.set', on: true }],
  [{ kind: 'clipboard.set', on: false }],
  ...[['restore_focus_on_turn_end', true], ['allow_point_targets', false], ['electron_ax_auto', true], ['ime_policy_cap', 'leave'],
    ['ime_policy_cap', 'ask'], ['ime_policy_cap', 'takeover'], ['activation_method', null], ['activation_method', 'running_application'],
    ['activation_method', 'ax_frontmost'], ['activation_method', 'ax_raise']].map(([field, value]) => [{ kind: 'behavior.set', field, value }]),
  [{ kind: 'logs.retention', days: 7 }],
  [{ kind: 'logs.retention', days: 30 }],
  [{ kind: 'logs.retention', days: 90 }],
  [{ kind: 'logs.default_directory' }],
  [{ kind: 'reset' }],
]

test('settings.apply: a valid change of every kind reaches the daemon as a fresh object with exactly its keys', async () => {
  const kinds = new Set()
  for (const [change] of GOOD_CHANGES) {
    const c = clients((_m, params) => ({ status: 'pending', summary: { kind: params.change.kind }, extra: 'dropped' }))
    const { apply } = hostOn(running(), c)
    // Sent with its keys in another order: the daemon gets kind first, then the kind's keys.
    const shuffled = Object.fromEntries(Object.entries(change).reverse())
    const { res, body } = await apply({ change: shuffled })
    assert.equal(res.status, 200, JSON.stringify(change))
    assert.deepEqual(body, { ok: true, result: { status: 'pending', summary: { kind: change.kind } } })
    const sent = c.sent()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].method, 'settings.apply')
    assert.deepEqual(Object.keys(sent[0].params), ['change'])
    assert.deepEqual(sent[0].params.change, change)
    assert.equal(Object.keys(sent[0].params.change)[0], 'kind')
    assert.equal(Object.getPrototypeOf(sent[0].params.change), Object.prototype)
    kinds.add(change.kind)
  }
  assert.deepEqual([...kinds].sort(), ['access.set', 'behavior.set', 'chord.add', 'chord.disable', 'chord.enable', 'chord.remove',
    'clipboard.set', 'deny.add', 'deny.remove', 'logs.default_directory', 'logs.retention', 'persistent.add', 'persistent.mode',
    'persistent.reapprove', 'persistent.remove', 'privacy.set', 'reset', 'revoke', 'revoke_all', 'text_only.add', 'text_only.remove'])
})

test('settings.apply: a whole number written as 30.0 is 30; a body with a charset passes', async () => {
  const c = clients()
  const { call } = hostOn(running(), c)
  await call('settings.apply', { body: '{"change": {"kind": "logs.retention", "days": 30.0}}',
    headers: { 'content-type': 'application/json;charset=UTF-8', 'x-cu-runtime-page': '1' } })
  assert.deepEqual(c.sent()[0].params, { change: { kind: 'logs.retention', days: 30 } })
})

// ------------------------------------------------------------------------------------------------ answers and errors

test('the snapshot keeps only the contract\'s top-level keys', async () => {
  const keys = ['started_at', 'grants', 'persistent', 'denylist', 'hard_deny', 'access', 'access_choices', 'chords', 'privacy',
    'behavior', 'logs', 'recent_refusals', 'recent_changes', 'permissions', 'pending', 'last_outcome', 'picked_app',
    'import_preview', 'panel']
  const full = Object.fromEntries(keys.map((k, i) => [k, { n: i }]))
  const c = clients(() => ({ ...full, token: 'SECRET', state_dir: '/somewhere', audit_path: '/x', future_field: 1 }))
  const { body } = await hostOn(running(), c).call('settings.snapshot')
  assert.deepEqual(body, { ok: true, snapshot: full })
  // Keys the daemon leaves out stay out.
  const some = clients(() => ({ started_at: 5, panel: null, other: true }))
  assert.deepEqual((await hostOn(running(), some).call('settings.snapshot')).body, { ok: true, snapshot: { started_at: 5, panel: null } })
})

test('results keep status, summary and panel; an answer of another shape is daemon_error', async () => {
  const answers = [
    [{ status: 'busy', panel: 'import', path: '/tmp/x' }, { ok: true, result: { status: 'busy', panel: 'import' } }],
    [{ status: 'cancelled', summary: { kind: 'reset' } }, { ok: true, result: { status: 'cancelled', summary: { kind: 'reset' } } }],
  ]
  for (const [answer, expected] of answers) {
    assert.deepEqual((await hostOn(running(), clients(() => answer)).call('settings.action.import')).body, expected)
  }
  for (const [op, answer] of [['settings.snapshot', null], ['settings.snapshot', [1]], ['settings.snapshot', 'x'],
    ['settings.cancelVerify', {}], ['settings.action.import', { status: 3 }], ['settings.action.import', null]]) {
    const { res, body } = await hostOn(running(), clients(() => answer)).call(op)
    assert.equal(res.status, 200)
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'daemon_error', `${op} ${JSON.stringify(answer)}`)
  }
})

/** A daemon refusal (Denial over the socket): RPC code -32000 (denied), data with the reason. */
const denial = (reason, message = `refused: ${reason}`, extra = {}) => new RpcError(-32000, message, { reason, retry: 'never', ...extra })

test('a daemon refusal the page knows passes its reason; verify_cooldown carries data.until; anything else is daemon_error', async () => {
  const known = ['verification_required', 'verify_busy', 'verify_cooldown', 'verify_unavailable', 'verify_failed', 'verify_cancelled',
    'approval_open', 'settings_unavailable', 'nothing_pending', 'settings_changed', 'not_found', 'app_not_grantable', 'app_not_found',
    'hard_denied', 'user_denied', 'invalid_chord', 'chord_never_allowed', 'chord_builtin', 'log_directory_missing', 'invalid_params']
  for (const reason of known) {
    const { body } = await hostOn(running(), clients(() => { throw denial(reason, 'the daemon says no') })).apply({ change: { kind: 'reset' } })
    assert.deepEqual(body, { ok: false, error: { code: reason, message: 'the daemon says no' } }, reason)
  }
  const cooling = clients(() => { throw denial('verify_cooldown', 'try again later', { until: 1792584000.5 }) })
  assert.deepEqual((await hostOn(running(), cooling).apply({ change: { kind: 'reset' } })).body,
    { ok: false, error: { code: 'verify_cooldown', message: 'try again later', data: { until: 1792584000.5 } } })
  // until only on verify_cooldown, and only a finite number.
  const other = clients(() => { throw denial('verify_busy', 'busy', { until: 5 }) })
  assert.equal((await hostOn(running(), other).apply({ change: { kind: 'reset' } })).body.error.data, undefined)
  const junk = clients(() => { throw denial('verify_cooldown', 'later', { until: '5' }) })
  assert.equal((await hostOn(running(), junk).apply({ change: { kind: 'reset' } })).body.error.data, undefined)
  const cases = [
    [denial('config_grants_disabled'), 'daemon_error'],
    [denial('too_many_connections'), 'daemon_error'],
    [denial('__proto__'), 'daemon_error'],
    [new RpcError(-32602, 'reset takes no x', {}), 'invalid_params'],
    [new RpcError(-32601, 'unknown method settings.x', {}), 'daemon_error'],
    [new RpcError(-32603, 'internal', null), 'daemon_error'],
    [new DaemonUnavailable('ENOENT'), 'not_running'],
    [new DaemonUnavailable('connection closed'), 'not_running'],
    [new Error('cu-runtime: settings.apply got no answer within 15000 ms; its outcome is unknown'), 'daemon_error'],
  ]
  for (const [error, code] of cases) {
    const { res, body } = await hostOn(running(), clients(() => { throw error })).apply({ change: { kind: 'reset' } })
    assert.equal(res.status, 200)
    assert.equal(body.error.code, code, error.message)
    assert.equal(body.ok, false)
  }
  // not_running says nothing of the state dir (the client's message names it).
  const gone = clients(() => { throw new DaemonUnavailable(`no token in ${join(HOME, 'Library/Application Support/cu-runtime')}`) })
  const text = JSON.stringify((await hostOn(running(), gone).call('settings.snapshot')).body)
  assert.doesNotMatch(text, /someone|Library|token|START|open -a/)
})

test('a long daemon message is clipped to 300 characters', async () => {
  for (const error of [denial('verify_busy', 'x'.repeat(5000)), denial('mystery', 'y'.repeat(5000)), new Error('z'.repeat(5000))]) {
    const { body } = await hostOn(running(), clients(() => { throw error })).call('settings.cancelVerify')
    assert.ok(body.error.message.length <= 300, String(body.error.message.length))
    assert.ok(body.error.message.length >= 290)
  }
})

test('an unexpected host error is internal, HTTP 500', async () => {
  const w = running()
  const { res, body } = await hostOn(w, { factory: () => { throw new Error('factory broke') } }).call('settings.snapshot')
  assert.equal(res.status, 500)
  assert.deepEqual(body, { ok: false, error: { code: 'internal', message: 'factory broke' } })
})

// ------------------------------------------------------------------------------------------------ the gate

test('not_running unless the verified installed app runs; nothing is sent to the daemon then', async () => {
  const cases = {
    'not installed': () => world(),
    'installed, not running': () => {
      const w = world()
      w.install()
      return w
    },
    'a bench build runs': () => {
      const w = running()
      w.install({ bench: true })
      return w
    },
    'a build without CUBench runs': () => {
      const w = running()
      w.install({ bench: null })
      return w
    },
    'signed by another identity': () => {
      const w = running()
      w.install({ signer: OTHER_SHA })
      return w
    },
    'no hardened runtime': () => {
      const w = running()
      w.install({ flags: '0x0(none)' })
      return w
    },
    'no identity': () => {
      const w = running()
      w.identities = []
      return w
    },
    'two identities of the name': () => {
      const w = running()
      w.identities = [SHA, OTHER_SHA]
      return w
    },
    'only another binary and a self-check run': () => {
      const w = running()
      w.daemons = []
      return w
    },
  }
  for (const [what, make] of Object.entries(cases)) {
    for (const op of ['settings.snapshot', 'settings.apply', 'settings.cancelVerify', 'settings.action.reveal_log']) {
      const c = clients()
      const h = hostOn(make(), c)
      const { res, body } = op === 'settings.apply' ? await h.apply({ change: { kind: 'reset' } }) : await h.call(op)
      assert.equal(res.status, 200)
      assert.equal(body.ok, false)
      assert.equal(body.error.code, 'not_running', `${what}: ${op}`)
      assert.doesNotMatch(body.error.message, /someone|\/Applications/, 'no path in the message')
      assert.deepEqual(c.made, [], `${what}: ${op}: no client made`)
    }
  }
  // The verified app running: the daemon is asked.
  const c = clients(() => ({ started_at: 1 }))
  assert.deepEqual((await hostOn(running(), c).call('settings.snapshot')).body, { ok: true, snapshot: { started_at: 1 } })
})

/** Waits until the condition holds (a mutant must fail, not hang). */
async function eventually(condition) {
  for (let i = 0; i < 10_000; i++) {
    if (await condition()) return
    await new Promise((r) => setImmediate(r))
  }
  throw new Error('the condition never held')
}

test('busy while the install task stops, replaces or starts the daemon; the daemon is asked in the other phases', async () => {
  assert.deepEqual([...SETTINGS_BUSY_PHASES].sort(), ['replace', 'selfcheck', 'start', 'stop'])
  const w = running()
  const c = clients(() => ({ started_at: 1 }))
  const h = hostOn(w, c)
  const phase = async () => (await h.call('status')).body.task?.phase
  const settingsCode = async () => {
    const { body } = await h.call('settings.snapshot')
    return body.ok ? 'ok' : body.error.code
  }
  // build: the old daemon still runs, so the settings work.
  w.holdOn('zsh build-app.sh')
  await h.call('install')
  await eventually(async () => w.calls.includes('zsh build-app.sh'))
  assert.equal(await phase(), 'build')
  assert.equal(await settingsCode(), 'ok')
  // stop: the task waits for the daemon to exit (its sleep held).
  w.system.kill = () => true   // the daemon takes its time to exit
  let releaseSleep
  w.holdSleep = new Promise((resolve) => { releaseSleep = resolve })
  w.release('zsh build-app.sh')
  await eventually(async () => (await phase()) === 'stop')
  const made = c.made.length
  for (const op of ['settings.snapshot', 'settings.cancelVerify', 'settings.action.import']) {
    const { body } = await h.call(op)
    assert.deepEqual(body.error.code, 'busy', op)
  }
  assert.equal((await h.apply({ change: { kind: 'reset' } })).body.error.code, 'busy')
  assert.equal(c.made.length, made, 'no client while busy')
  // start: open -g held.
  w.holdOn('open -g')
  w.daemons = []
  w.holdSleep = undefined
  releaseSleep()
  await eventually(async () => (await phase()) === 'start')
  assert.equal(await settingsCode(), 'busy')
  // selfcheck: open -n held.
  w.holdOn('open -n')
  w.release('open -g')
  await eventually(async () => (await phase()) === 'selfcheck')
  assert.equal(await settingsCode(), 'busy')
  w.release('open -n')
  await eventually(async () => (await phase()) === 'done')
  assert.equal(await settingsCode(), 'ok')
  assert.equal(c.made.length, made + 1)
})

// ------------------------------------------------------------------------------------------------ the connection

test('one connection per operation, closed afterwards; the fixed state dir, no autoStart, a bounded timeout, never start', async () => {
  const P = daemonPaths(HOME, PKG)
  let c = clients((method) => (method === 'settings.snapshot' ? {} : { status: 'done' }))
  const h = hostOn(running(), c)
  const ops = [() => h.call('settings.snapshot'), () => h.call('settings.cancelVerify'), () => h.apply({ change: { kind: 'reset' } }),
    ...ACTIONS.map((a) => () => h.call(`settings.action.${a}`))]
  for (const op of ops) await op()
  assert.equal(c.made.length, ops.length)
  for (const m of c.made) {
    assert.deepEqual(m.options, { stateDir: P.stateDir, timeoutMs: SETTINGS_TIMEOUT_MS })
    assert.equal(m.requests.length, 1)
    assert.deepEqual(m.requests[0].opts, { start: false })
    assert.equal(m.closed, true)
    assert.equal(m.openWhenAsked, 1, 'no other connection open meanwhile')
  }
  assert.ok(SETTINGS_TIMEOUT_MS > 0 && SETTINGS_TIMEOUT_MS <= 30_000)
  // Closed also when the request fails.
  c = clients(() => { throw denial('verify_busy') })
  const failing = hostOn(running(), c)
  await failing.call('settings.snapshot')
  await failing.apply({ change: { kind: 'reset' } })
  assert.deepEqual(c.made.map((m) => m.closed), [true, true])
})

test('the default client connects only, to the fixed state dir under the home of the system (a temporary one here)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cu-settings-'))
  try {
    const w = world({ home })
    w.install()
    w.daemons = [400]
    // A token but no socket: the real client reads the token and finds no daemon (ENOENT): not_running.
    mkdirSync(w.P.stateDir, { recursive: true })
    writeFileSync(join(w.P.stateDir, 'token'), 'test-token')
    const routes = []
    host.applyWith({ system: w.system, packageSourceHash: () => PKG_HASH, sourceHash: () => PKG_HASH, bootTime: () => 1000 })({
      get: () => ({ name: 'web' }),
      effect: () => {},
      inject: (_d, cb) => cb({ connection: { fetch: { register: (r) => { routes.push(r); return async () => {} } } } }),
    })
    const route = routes.find((r) => r.path === '/api/cu-runtime.settings.snapshot')
    const body = await (await route.fetch(new Request('http://127.0.0.1:1/x', { method: 'POST' }))).json()
    assert.deepEqual(body, { ok: false, error: { code: 'not_running', message: 'the cu-runtime daemon cannot be reached' } })
    assert.ok(!w.calls.some((l) => l.startsWith('open')), 'nothing started')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
