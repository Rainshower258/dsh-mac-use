// The plugin page's browser half (plugin/src/client, scripts/build-client.mjs): the script's wrapper and the only
// packages it takes from dsh, what apply registers, how the page calls the host routes and shows their failures, and
// the view model for each state of the daemon. Then how the page gets built and installed: the one documented build
// (npm run build) and its use in docs/DESIGN.md and the pre-push hook. Builds into temporary directories, removed
// afterwards; plugin/lib is not touched.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { ENTRY, EXTERNALS, MODULE_ID, ROOT, bundleModules } from '../../scripts/build-client.mjs'

const dir = mkdtempSync(join(tmpdir(), 'cu-client-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const OUT = join(dir, 'client.js')
execFileSync(process.execPath, [join(ROOT, 'scripts/build-client.mjs'), '--out', OUT, '--cjs', join(dir, 'cjs')],
  { stdio: ['ignore', 'pipe', 'pipe'] })
const SCRIPT = readFileSync(OUT, 'utf8')
const compiled = createRequire(join(dir, 'cjs', ENTRY))
const { buildView, readStatus, opensslSha1, FINGERPRINT_COMMAND, P12_FINGERPRINT_COMMAND, PHASES, LOG_LINES, ERROR_CODES } =
  compiled('./view.js')
const { NS, zh, en } = compiled('./locale.js')

/** The host's error codes (plugin/src/daemon/manager.ts), then the page's own. */
const HOST_CODES = ['busy', 'ssh_session', 'no_gui_session', 'clt_missing', 'identity_failed', 'identity_ambiguous',
  'identity_missing', 'identity_changed', 'copy_failed', 'build_failed', 'not_release_build', 'sign_failed', 'signature_mismatch',
  'stop_failed', 'replace_failed', 'start_failed', 'selfcheck_failed', 'selfcheck_timeout', 'not_installed',
  'clt_install_failed', 'no_task', 'not_cancellable', 'internal']
const PAGE_CODES = ['unauthorized', 'network', 'bad_response']

/** A numeric constant page.ts exports, read from its compiled source (page.js needs React, so it is not loaded here). */
const pageConstant = (name) => {
  // nosemgrep: detect-non-literal-regexp -- test only: name is one of this file's own constant names
  const literal = new RegExp(`^exports\\.${name} = ([\\d_]+);$`, 'm').exec(readFileSync(join(dir, 'cjs', 'page.js'), 'utf8'))
  assert.ok(literal !== null, `page.js exports ${name}`)
  return Number(literal[1].replaceAll('_', ''))
}
const IDLE_POLL_MS = pageConstant('IDLE_POLL_MS')
const ACTION_ERROR_MS = pageConstant('ACTION_ERROR_MS')

/** dsh's translate over one dictionary; a key the dictionary lacks fails the test. */
const translator = (dict) => (key, params) => {
  assert.ok(Object.hasOwn(dict, key), `no text for ${key}`)
  return params === undefined ? dict[key] : dict[key].replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
}
/** The page's namespace holds the daemon tab's keys and the settings tabs' (the tab bar's labels among them). */
const t = translator({ ...zh, ...compiled('./settings/locale/index.js').zh })

/**
 * The daemon tab as drawn: the tab shell (settings/shell.ts, its one hook the shown tab, the daemon's by default)
 * draws the daemon page as an element in its panel, and this calls that element's component as React would, so the
 * daemon page's hooks come right after the shell's.
 */
function daemonTab(shell) {
  const [panel] = find(shell, (e) => e.props?.['data-cu-runtime-tab-panel'] === 'daemon')
  assert.ok(panel !== undefined, 'the daemon tab is shown')
  const [page] = panel.props.children
  return page.type(page.props)
}

// --- the script dsh loads ---

/**
 * A React stand-in with only what the page may use. useState answers the i-th call with states[i] when given (the
 * shell's shown tab, then the daemon page's hooks in order: status, statusError, pending, done, actionError, round),
 * else the initial value.
 */
function fakeReact(states = []) {
  let call = 0
  const effects = []
  const setters = []
  return {
    effects, setters,
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const i = call++
      setters[i] = []
      const value = i < states.length ? states[i] : typeof initial === 'function' ? initial() : initial
      return [value, (next) => setters[i].push(next)]
    },
    useEffect(effect) { effects.push(effect) },
    useCallback: (callback) => callback,
  }
}

/**
 * Run the script as the dsh web client would: a classic script calling window.__ModuleLoader__.load, its factory
 * called with the loader's require (here only EXTERNALS, anything else fails the test).
 */
function load({ react = fakeReact(), primitives = {}, globals = {} } = {}) {
  const registrations = []
  const requested = []
  const sandbox = { window: { __ModuleLoader__: { load: (r) => registrations.push(r) } }, ...globals }
  vm.runInNewContext(SCRIPT, sandbox, { filename: 'client.js' })
  assert.equal(registrations.length, 1, 'one registration')
  const [{ id, factory }] = registrations
  const exports = factory((spec) => {
    requested.push(spec)
    assert.ok(EXTERNALS.includes(spec), `the bundle required ${spec}, which dsh does not provide`)
    return spec === 'react' ? react : spec === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : {}
  })
  return { id, exports, requested, sandbox }
}

/** A fake client context recording what apply registers. */
function fakeContext() {
  const seen = { locales: [], entries: [], injected: [] }
  return {
    seen,
    effect: (setup) => { seen.effectDisposer = setup() },
    locale: { register: (ns, dicts) => { seen.locales.push({ ns, dicts }); return () => {} } },
    slots: {
      inject: (name, setup) => { seen.injected.push(name); setup() },
      register: (entry, component) => { seen.entries.push({ entry: { ...entry }, component }); return () => {} },
    },
  }
}

/** Every string in a rendered element tree. */
function texts(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(texts)
  return texts(node.props?.children)
}

/** Every element in a tree that satisfies pred. */
function find(node, pred) {
  if (node === null || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((n) => find(n, pred))
  return [...(pred(node) ? [node] : []), ...find(node.props?.children, pred)]
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('client.js is one classic script registering id "cu-runtime" with a factory(require) that returns module.exports', () => {
  assert.equal(MODULE_ID, 'cu-runtime')
  assert.ok(SCRIPT.startsWith('window.__ModuleLoader__.load({\n\tid: "cu-runtime",\n\tfactory: (require) => {\n'
    + '\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n'), SCRIPT.slice(0, 200))
  assert.ok(SCRIPT.endsWith('\t\treturn module.exports;\n\t}\n});\n'))
  assert.doesNotMatch(SCRIPT, /^\s*(import|export)\s/m, 'no module syntax: dsh loads it as a classic script')
  const { id, exports, requested, sandbox } = load()
  assert.equal(id, 'cu-runtime')
  assert.deepEqual(Object.keys(sandbox), ['window'], 'nothing leaks into the page\'s globals')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual([...exports.inject], ['slots', 'locale'])
  assert.equal(exports.name, 'cu-runtime-client')
  assert.deepEqual([...new Set(requested)].sort(), ['@deepseek-ai/dsh-client-ui-primitives', 'react'])
})

test('apply registers the page\'s texts under its namespace and the page in plugins.bundle.config keyed cu-runtime', () => {
  const { exports } = load()
  const ctx = fakeContext()
  exports.apply(ctx)
  assert.equal(ctx.seen.locales.length, 1)
  const [{ ns, dicts }] = ctx.seen.locales
  assert.equal(ns, NS)
  assert.equal(ns, 'cu-runtime-page')
  assert.deepEqual(Object.keys(dicts).sort(), ['en', 'zh'])
  assert.equal(typeof ctx.seen.effectDisposer, 'function', 'registered inside ctx.effect, so it is withdrawn with the plugin')
  assert.deepEqual(ctx.seen.injected, ['plugins.bundle.config'])
  assert.equal(ctx.seen.entries.length, 1)
  assert.deepEqual(ctx.seen.entries[0].entry, { name: 'plugins.bundle.config', key: 'cu-runtime', locale: NS })
  assert.equal(typeof ctx.seen.entries[0].component, 'function')
})

test('the texts: the same keys in Chinese and English, the Chinese never addressing the reader', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  for (const [key, text] of Object.entries(zh)) {
    assert.doesNotMatch(text, /[你您]/, `zh ${key}`)
    assert.ok(text.trim() !== '' && en[key].trim() !== '', key)
  }
  assert.match(zh['task.keychain'], /「允许」/)
  assert.match(zh['task.keychain'], /不要选择「始终允许」/)
  assert.match(en['task.keychain'], /Allow, not Always Allow/)
  // Each signing asks for the login keychain password, possibly more than once (not just a click).
  assert.match(zh['task.keychain'], /输入登录钥匙串(的)?密码/)
  assert.match(zh['task.keychain'], /不止出现一次/)
  assert.match(en['task.keychain'], /enter the login keychain password/)
  assert.match(en['task.keychain'], /more than once/)
  assert.match(zh['error.sign_failed'], /密码对话框被取消/)
  assert.match(zh['error.sign_failed'], /「拒绝」/)
  assert.match(en['error.sign_failed'], /password dialog was cancelled or answered with Deny/)
  assert.match(zh['summary.identityAmbiguous'], /钥匙串里有多张名为 cu-runtime-signing 的证书，请只保留授予过权限的那一张/)
})

test('every error code of the shared contract, and the page\'s own, has its own text in Chinese and English', () => {
  assert.deepEqual([...ERROR_CODES], [...HOST_CODES, ...PAGE_CODES])
  for (const code of ERROR_CODES) {
    for (const dict of [zh, en]) assert.ok(Object.hasOwn(dict, `error.${code}`), `error.${code}`)
    const shown = buildView(null, { t, statusError: { code, message: '' } }).error
    assert.deepEqual({ ...shown }, { text: zh[`error.${code}`], detail: null }, code)
  }
  const own = Object.keys(zh).filter((k) => k.startsWith('error.')).map((k) => k.slice('error.'.length))
  assert.deepEqual(own.filter((c) => !ERROR_CODES.includes(c)).sort(), ['detail', 'phaseFailed', 'unknown'],
    'no text for a code nothing sends')
})

/** The daemon tab rendered with a status already read, the dsh primitives given (or none), and fetch recorded. */
function renderPage({ status = null, primitives = {}, pending = null } = {}) {
  const react = fakeReact(['daemon', status, null, pending])
  const fetched = []
  const { exports } = load({ react, primitives, globals: {
    fetch: async (url, init) => {
      fetched.push({ url, init })
      // An action's stated success (act() refuses a 2xx body without ok: true).
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ ok: true, error: null }) }
    },
  } })
  const ctx = fakeContext()
  exports.apply(ctx)
  const Page = ctx.seen.entries[0].component
  return { tree: daemonTab(Page({ view: 'page', t })), react, fetched }
}

test('the page before the first status: the loading line, no buttons', () => {
  const { tree } = renderPage()
  assert.ok(texts(tree).includes(zh['summary.loading']))
  assert.equal(find(tree, (e) => e.type === 'button').length, 0)
})

test('the page uses the dsh primitives when present and plain elements when this dsh lacks them', () => {
  const status = readStatus(sample())
  const Button = (props) => props
  const StateDot = (props) => props
  const Tag = (props) => props
  const withPrimitives = renderPage({ status, primitives: { Button, StateDot, Tag } }).tree
  const buttons = find(withPrimitives, (e) => e.type === Button)
  assert.ok(buttons.length >= 5)
  assert.ok(buttons.every((b) => b.props.size === 'sm' && ['primary', 'outline'].includes(b.props.variant)))
  // dsh's outline is .5px of a faint color: every button but the primary one gets a visible 1px border.
  assert.ok(buttons.some((b) => b.props.variant === 'outline'))
  for (const b of buttons) {
    // (The bundle runs in its own realm: compare the field, not objects whose prototypes differ.)
    assert.equal(b.props.style?.border, b.props.variant === 'primary' ? undefined : '1px solid var(--dsw-alias-border-l2)', b.props.variant)
  }
  assert.ok(find(withPrimitives, (e) => e.type === StateDot).length > 0)
  assert.deepEqual(find(withPrimitives, (e) => e.type === Tag).map(texts), [['20261020.133925-b071a06'], ['0.2.0']])
  const absent = readStatus(sample({ app: { installed: false, version: null, signature: 'missing' }, running: false }))
  const notInstalled = renderPage({ status: absent, primitives: { Button, StateDot, Tag } }).tree
  assert.deepEqual(find(notInstalled, (e) => e.type === Tag).map(texts), [['0.2.0']], 'the placeholder is not a tag')
  const plain = renderPage({ status }).tree
  assert.equal(find(plain, (e) => e.type === 'button').length, buttons.length)
  assert.ok(texts(plain).includes(zh['summary.ready']))
})

test('a button posts its route, document-relative with no body, then the status is read again at once', async () => {
  const { tree, react, fetched } = renderPage({ status: readStatus(sample({ running: false })) })
  const start = find(tree, (e) => e.type === 'button' && texts(e).includes(zh['action.start']))
  assert.equal(start.length, 1)
  start[0].props.onClick()
  await tick()
  assert.deepEqual(fetched.map(({ url, init }) => [url, { ...init }]), [['api/cu-runtime.start', { method: 'POST' }]])
  // The daemon page's hooks follow the shell's one (daemonTab).
  assert.deepEqual(react.setters[3], ['start', null], 'pending while the request runs, then cleared')
  assert.deepEqual(react.setters[4], [null, 'start'])
  assert.equal(react.setters[6].length, 1, 'the poll restarts')
})

/** Mount the page's poll with fetch answering `answer` and timers recorded; returns what it did. */
async function poll(answer) {
  const react = fakeReact()
  const fetched = []
  const timers = []
  const cleared = []
  const { exports } = load({ react, globals: {
    AbortController,
    fetch: async (url, init) => {
      fetched.push({ url, init })
      return { ok: true, status: 200, statusText: 'OK', json: async () => answer }
    },
    setTimeout: (fn, ms) => { timers.push(ms); return timers.length },
    clearTimeout: (id) => { cleared.push(id) },
  } })
  const ctx = fakeContext()
  exports.apply(ctx)
  daemonTab(ctx.seen.entries[0].component({ view: 'page', t }))
  assert.equal(react.effects.length, 1)
  const dispose = react.effects[0]()
  for (let i = 0; i < 5; i++) await tick()
  return { fetched, timers, cleared, dispose, react }
}

test('the status is read on mount, every second while a task runs, every 10 s otherwise, and not after unmount', async () => {
  const running = await poll(sample({ task: task('build') }))
  assert.equal(running.fetched.length, 1)
  assert.equal(running.fetched[0].url, 'api/cu-runtime.status')
  assert.equal(running.fetched[0].init.method, 'POST')
  assert.equal(running.fetched[0].init.body, undefined)
  assert.deepEqual(running.timers, [1000])
  running.dispose()
  assert.deepEqual(running.cleared, [1])
  assert.equal(running.fetched[0].init.signal.aborted, true, 'the read in flight is aborted')

  for (const phase of ['done', 'failed', 'cancelled']) {
    const ended = await poll(sample({ task: task(phase) }))
    assert.deepEqual(ended.timers, [10_000], phase)
    ended.dispose()
  }
  const idle = await poll(sample())
  assert.deepEqual(idle.timers, [10_000])
  idle.dispose()
  const broken = await poll({ app: {} })
  assert.deepEqual(broken.react.setters[2].map((f) => f?.code), ['bad_response'])
  broken.dispose()
})

// --- the page's flows: what the person sees after an action ---

/**
 * A React stand-in that keeps state between renders: useState as React's (a setter takes a value or an updater),
 * useEffect run after the render when its deps changed (the previous run's cleanup first), useCallback the callback.
 */
function statefulReact() {
  const slots = []
  let call = 0
  let queued = []
  const sameDeps = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((d, i) => Object.is(d, b[i]))
  return {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const i = call++
      if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[i]
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    },
    useEffect(effect, deps) {
      const i = call++
      const slot = slots[i]
      if (slot !== undefined && sameDeps(deps, slot.deps)) return
      queued.push(() => {
        slot?.cleanup?.()
        slots[i] = { deps, cleanup: effect() }
      })
    },
    useCallback: (callback) => callback,
    /** Draws the component with the state so far, then runs the effects the render queued. */
    render(component, props) {
      call = 0
      queued = []
      const tree = component(props)
      for (const run of queued) run()
      return tree
    },
    unmount() {
      for (const slot of slots) slot?.cleanup?.()
    },
  }
}

const STATUS_TEXT = { 200: 'OK', 401: 'Unauthorized', 403: 'Forbidden', 500: 'Internal Server Error' }

/** An answer: the request does not get through (fetch rejects with the page's TypeError, as a browser's does). */
const UNREACHABLE = Symbol('unreachable')

/**
 * The page mounted with fetch answering each route from `answers[route]`: `{ status, body }` (no body: not JSON),
 * UNREACHABLE, or a function returning one of those (called per request). Timers wait for wait(); Date.now() is a
 * clock wait() moves.
 */
function mountPage(answers) {
  const react = statefulReact()
  const posted = []
  const timers = new Map()
  let nextTimer = 1
  const clock = { now: 1_760_947_200_000 }
  class ClockDate extends Date {
    static now() { return clock.now }
  }
  const { exports, sandbox } = load({ react, globals: {
    AbortController,
    Date: ClockDate,
    fetch: async (url, init) => {
      assert.deepEqual(Object.keys(init).sort(), url === 'api/cu-runtime.status' ? ['method', 'signal'] : ['method'])
      const route = url.replace(/^api\/cu-runtime\./, '')
      posted.push(route)
      let answer = answers[route]
      while (typeof answer === 'function') answer = answer()
      assert.ok(answer !== undefined, `no answer for ${url}`)
      if (answer === UNREACHABLE) throw vm.runInContext('new TypeError("Failed to fetch")', sandbox)
      return {
        ok: answer.status >= 200 && answer.status < 300, status: answer.status, statusText: STATUS_TEXT[answer.status] ?? '',
        json: async () => {
          if (answer.body === undefined) throw new SyntaxError('Unexpected end of JSON input')
          return answer.body
        },
      }
    },
    setTimeout: (fn, ms) => {
      timers.set(nextTimer, { fn, ms })
      return nextTimer++
    },
    clearTimeout: (id) => { timers.delete(id) },
  } })
  const ctx = fakeContext()
  exports.apply(ctx)
  const Page = ctx.seen.entries[0].component
  const page = {
    posted,
    tree: null,
    draw: () => (page.tree = react.render((props) => daemonTab(Page(props)), { view: 'page', t })),
    /** Lets the requests in flight finish, then draws the page again (and runs the effects that queues). */
    async settle() {
      for (let i = 0; i < 10; i++) await tick()
      return page.draw()
    },
    /** Moves the clock by the poll's one pending timer, runs it, and settles twice (the read, then its redraw). */
    async wait() {
      assert.equal(timers.size, 1, 'one poll timer pending')
      const [[id, { fn, ms }]] = timers
      timers.delete(id)
      clock.now += ms
      fn()
      await page.settle()
      return page.settle()
    },
    /** Presses the enabled button with this text, then settles until the status read after it is drawn. */
    async click(text) {
      const buttons = find(page.tree, (e) => e.type === 'button' && texts(e).includes(text))
      assert.equal(buttons.length, 1, `one button ${text}`)
      assert.equal(buttons[0].props.disabled, false, `${text} is enabled`)
      buttons[0].props.onClick()
      await page.settle()
      return page.settle()
    },
    alert: () => texts(find(page.tree, (e) => e.props?.role === 'alert')),
    shown: () => texts(page.tree),
    unmount: () => react.unmount(),
  }
  page.draw()
  return page
}

const answer = (body, status = 200) => ({ status, body })

test('an action that fails shows its error and no success notice: refused (200, ok false), 401, 403, 500, unreachable', async () => {
  const status = answer(sample({ permissions: { accessibility: false, screenRecording: false } }))
  const cases = [
    [answer({ ok: false, error: { code: 'busy', message: 'the install task is running' } }),
      [zh['error.busy'], '详情：the install task is running']],
    [answer({ ok: false, error: { code: 'signature_mismatch', message: '' } }), [zh['error.signature_mismatch']]],
    [answer({ ok: false, error: null }), [zh['error.bad_response'], '详情：the answer has ok: false and no error code']],
    [answer(undefined, 401), [zh['error.unauthorized'], '详情：HTTP 401 Unauthorized']],
    [answer({ error: { code: 'forbidden', message: 'not the owner' } }, 403), [zh['error.unauthorized'], '详情：not the owner']],
    [answer({ ok: false, error: { code: 'internal', message: 'spawn ENOENT' } }, 500), [zh['error.internal'], '详情：spawn ENOENT']],
    [answer(undefined, 502), ['操作失败（http_502）。']],
    [UNREACHABLE, [zh['error.network'], '详情：Failed to fetch']],
  ]
  for (const [permissions, alert] of cases) {
    const page = mountPage({ status, permissions })
    await page.settle()
    assert.deepEqual(page.alert(), [])
    assert.ok(page.shown().includes(zh['hint.permissions']), 'the one-pane-per-click flow is explained')
    assert.match(zh['hint.permissions'], /开关已经打开、检查仍显示未授予时[^]*zsh scripts\/install\.sh --permissions-only/, 'and what clears a stale row')
    assert.match(en['hint.permissions'], /switch is on and the check still shows[^]*zsh scripts\/install\.sh --permissions-only/)
    await page.click(zh['action.permissions'])
    assert.deepEqual(page.posted, ['status', 'permissions', 'status'])
    assert.deepEqual(page.alert(), alert, JSON.stringify(alert))
    assert.equal(page.shown().includes(zh['notice.permissions']), false, 'no success notice')
    page.unmount()
  }

  const granted = mountPage({ status, permissions: answer({ ok: true, error: null }) })
  await granted.settle()
  await granted.click(zh['action.permissions'])
  assert.deepEqual(granted.alert(), [])
  assert.ok(granted.shown().includes(zh['notice.permissions']))
  granted.unmount()
})

test('install answers its TaskState (no ok field): a success; cancel\'s refusal is shown with its code', async () => {
  let current = answer(sample({ upToDate: false }))
  const page = mountPage({
    status: () => current,
    install: () => {
      current = answer(sample({ upToDate: false, task: task('preflight') }))
      return answer(task('preflight'))
    },
    cancel: answer({ ok: false, error: { code: 'not_cancellable', message: 'the installed app is being replaced' },
      task: task('replace') }),
  })
  await page.settle()
  await page.click(zh['action.update'])
  assert.deepEqual(page.alert(), [])
  assert.ok(page.shown().includes('正在安装守护进程：检查环境'))
  await page.click(zh['action.cancel'])
  assert.deepEqual(page.alert(), [zh['error.not_cancellable'], '详情：the installed app is being replaced'])
  page.unmount()
})

test('an action whose 2xx answer states no success is a bad_response, with no success notice', async () => {
  const page = mountPage({ status: () => answer(sample({ running: false })), start: answer({}), clt: answer('not json') })
  await page.settle()
  await page.click(zh['action.start'])
  assert.equal(page.alert()[0], zh['error.bad_response'])
  assert.ok(!page.shown().includes(zh['notice.start'] ?? '\u0000'), 'no success notice for {}')
  page.unmount()
})

test('the grant hint is not shown while an install task runs (every grant button is disabled then)', () => {
  const v = buildView(sample({ permissions: { accessibility: false, screenRecording: false }, task: task('build') }),
    { t, pending: null, done: null, actionError: null, statusError: null })
  assert.equal(v.permissionsHint, null)
})

test('an action\'s failure outlasts the read right after it, then gives way to the first status read begun 30 s later', async () => {
  let current = answer(sample({ running: false }))
  const page = mountPage({
    status: () => current,
    start: answer({ ok: false, error: { code: 'start_failed', message: 'open: exit 1' } }),
    selfcheck: answer({ ok: false, error: { code: 'selfcheck_timeout', message: '' } }),
  })
  await page.settle()
  await page.click(zh['action.start'])
  const failed = [zh['error.start_failed'], '详情：open: exit 1']
  assert.deepEqual(page.alert(), failed)
  current = answer(sample())
  for (let waited = IDLE_POLL_MS; waited < ACTION_ERROR_MS; waited += IDLE_POLL_MS) {
    await page.wait()
    assert.deepEqual(page.alert(), failed, `${waited} ms on`)
  }
  await page.wait()
  assert.deepEqual(page.alert(), [], 'the daemon runs now: the old failure is gone')
  assert.ok(page.shown().includes(zh['summary.ready']))

  // A later read that fails shows its own failure once the action's has had its time.
  await page.click(zh['action.selfcheck'])
  assert.deepEqual(page.posted.slice(-2), ['selfcheck', 'status'], '检查权限 posts api/cu-runtime.selfcheck')
  assert.deepEqual(page.alert(), [zh['error.selfcheck_timeout']])
  current = UNREACHABLE
  for (let waited = IDLE_POLL_MS; waited < ACTION_ERROR_MS; waited += IDLE_POLL_MS) {
    await page.wait()
    assert.deepEqual(page.alert(), [zh['error.selfcheck_timeout']], `${waited} ms on`)
  }
  await page.wait()
  assert.deepEqual(page.alert(), [zh['error.network'], '详情：Failed to fetch'])
  current = answer(sample())
  await page.wait()
  assert.deepEqual(page.alert(), [])

  // The next action takes a failure off at once.
  await page.click(zh['action.selfcheck'])
  assert.deepEqual(page.alert(), [zh['error.selfcheck_timeout']])
  const [again] = find(page.tree, (e) => e.type === 'button' && texts(e).includes(zh['action.selfcheck']))
  again.props.onClick()
  page.draw()
  assert.deepEqual(page.alert(), [], 'nothing shown while the action is in flight')
  await page.settle()
  await page.settle()
  page.unmount()
})

test('the bundler refuses a require of anything but its own modules and the packages dsh provides', () => {
  const ok = bundleModules(new Map([
    ['index.js', '"use strict";\nexports.v = require("./sub/b.js").v + require("react").n;'],
    ['sub/b.js', '"use strict";\nexports.v = require("../a.js").v * 10;'],
    ['a.js', '"use strict";\nexports.v = require("zod").n;'],
  ]))
  assert.match(ok, /"sub\/b\.js": function \(module, exports, require\)/)
  const registrations = []
  vm.runInNewContext(ok, { window: { __ModuleLoader__: { load: (r) => registrations.push(r) } } })
  assert.equal(registrations[0].factory((spec) => ({ n: spec === 'zod' ? 4 : 2 })).v, 42, 'relative requires resolve per module')
  for (const spec of EXTERNALS) assert.doesNotThrow(() => bundleModules(new Map([['index.js', `require("${spec}");`]])), spec)
  assert.throws(() => bundleModules(new Map([['index.js', 'const pad = require("left-pad");']])), /left-pad/)
  assert.throws(() => bundleModules(new Map([['index.js', 'require("react-dom/server");']])), /react-dom\/server/)
  assert.throws(() => bundleModules(new Map([['index.js', 'require("node:fs");']])), /node:fs/)
  assert.throws(() => bundleModules(new Map([['index.js', 'const m = "x"; require(m);']])), /not require\("<literal>"\)/)
  assert.throws(() => bundleModules(new Map([['index.js', 'require("./missing.js");']])), /names no compiled module/)
  assert.throws(() => bundleModules(new Map([['a.js', '']])), /no entry module/)
})

test('the host build (tsconfig.build.json) leaves src/client to tsconfig.client.json', () => {
  const plugin = join(ROOT, 'plugin')
  const files = execFileSync(join(plugin, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.build.json', '--listFilesOnly'],
    { cwd: plugin, encoding: 'utf8' }).split('\n').filter((f) => f.includes('/plugin/src/'))
  assert.ok(files.some((f) => f.endsWith('/plugin/src/client.ts')), 'the daemon client stays in the host build')
  assert.deepEqual(files.filter((f) => f.includes('/plugin/src/client/')), [])
})

test('tsc -p tsconfig.client.json alone only type-checks: nothing is written into plugin/lib, which the package ships', () => {
  const plugin = join(ROOT, 'plugin')
  const { compilerOptions } = JSON.parse(execFileSync(join(plugin, 'node_modules/.bin/tsc'),
    ['-p', 'tsconfig.client.json', '--showConfig'], { cwd: plugin, encoding: 'utf8' }))
  assert.equal(compilerOptions.noEmit, true)
  assert.equal(compilerOptions.outDir, undefined)
  assert.match(readFileSync(join(dir, 'cjs', 'view.js'), 'utf8'), /exports\.buildView = buildView/,
    'build-client.mjs still emits, into the directory it is given')
})

// --- the view model ---

/** The one identity's certificate SHA-1, as the host sends it (40 hexadecimal digits). */
const IDENTITY_SHA1 = '5E1F'.repeat(10)
/** The same in openssl's form (`openssl x509 -noout -fingerprint -sha1`), as the page draws every SHA-1. */
const IDENTITY_OPENSSL = '5E:1F:5E:1F:5E:1F:5E:1F:5E:1F:5E:1F:5E:1F:5E:1F:5E:1F:5E:1F'

function sample(patch = {}) {
  const base = {
    app: { installed: true, version: '20261020.133925-b071a06', sourceHash: 'a'.repeat(64), signature: 'ok', identity: 'present',
      identitySha1: IDENTITY_SHA1 },
    package: { version: '0.2.0', sourceHash: 'a'.repeat(64) },
    upToDate: true,
    running: true,
    permissions: { accessibility: true, screenRecording: true },
    environment: { gui: true, clt: true, sshSession: false },
    task: null,
  }
  return {
    ...base, ...patch,
    app: { ...base.app, ...patch.app },
    environment: { ...base.environment, ...patch.environment },
  }
}

function task(phase, extra = {}) {
  return { id: 't1', phase, startedAt: 1760947200000, log: [], error: null, ...extra }
}

const view = (patch, options = {}) => buildView(readStatus(sample(patch)), { t, ...options })
const enabledOps = (v) => v.actions.filter((a) => a.enabled).map((a) => a.op)
const primaryOps = (v) => v.actions.filter((a) => a.variant === 'primary').map((a) => a.op)
const label = (v, op) => v.actions.find((a) => a.op === op)?.label
const row = (v, id) => v.sections.flatMap((s) => s.rows).find((r) => r.id === id)

test('view: not installed', () => {
  const v = view({ app: { installed: false, version: null, sourceHash: null, signature: 'missing', identity: 'missing' },
    upToDate: false, running: false, permissions: null })
  assert.deepEqual(v.summary, { state: 'idle', text: zh['summary.notInstalled'] })
  assert.deepEqual(v.actions.map((a) => a.op), ['install', 'permissions', 'selfcheck', 'start', 'stop', 'restart'])
  assert.deepEqual(enabledOps(v), ['install'])
  assert.deepEqual(primaryOps(v), ['install'])
  assert.equal(label(v, 'install'), zh['action.install'])
  assert.deepEqual(row(v, 'installed'), { id: 'installed', label: zh['row.installed'], value: zh['value.notInstalled'], state: 'idle' })
  for (const id of ['version', 'upToDate', 'signature', 'identitySha1', 'running', 'accessibility', 'screenRecording']) {
    assert.equal(row(v, id).value, '—', id)
    assert.equal(row(v, id).state, null, id)
  }
  assert.equal(row(v, 'identity').value, zh['value.identityMissing'])
  assert.equal(v.task, null)
  assert.equal(v.permissionsHint, null, 'nothing to grant before the app is installed')
  assert.deepEqual(v.sections.map((s) => s.title), [zh['section.daemon'], zh['section.environment']])
})

test('view: installed, up to date, running, both permissions granted', () => {
  const v = view({})
  assert.deepEqual(v.summary, { state: 'done', text: zh['summary.ready'] })
  assert.deepEqual(enabledOps(v), ['install', 'permissions', 'selfcheck', 'stop', 'restart'])
  assert.deepEqual(primaryOps(v), [])
  assert.equal(label(v, 'selfcheck'), zh['action.selfcheck'])
  assert.equal(v.permissionsHint, null, 'both granted: no hint')
  assert.equal(label(v, 'install'), zh['action.reinstall'])
  assert.equal(row(v, 'version').value, '20261020.133925-b071a06')
  assert.equal(row(v, 'pluginVersion').value, '0.2.0')
  assert.deepEqual(row(v, 'identitySha1'), { id: 'identitySha1', label: zh['row.identitySha1'], value: IDENTITY_OPENSSL, state: null })
  for (const id of ['installed', 'upToDate', 'signature', 'identity', 'running', 'accessibility', 'screenRecording', 'clt', 'session']) {
    assert.equal(row(v, id).state, 'done', id)
  }
  assert.equal(v.task, null)
  assert.equal(v.error, null)
  assert.equal(v.notice, null)
})

test('view: outdated', () => {
  const v = view({ upToDate: false })
  assert.deepEqual(v.summary, { state: 'warning', text: zh['summary.outdated'] })
  assert.equal(label(v, 'install'), zh['action.update'])
  assert.deepEqual(primaryOps(v), ['install'])
  assert.deepEqual(row(v, 'upToDate'), { id: 'upToDate', label: zh['row.upToDate'], value: zh['value.outdated'], state: 'warning' })
  assert.deepEqual(enabledOps(v), ['install', 'permissions', 'selfcheck', 'stop', 'restart'])
})

test('view: signature mismatch: reinstall; no start, restart or permissions for a binary that is not ours', () => {
  const v = view({ app: { signature: 'mismatch' } })
  assert.deepEqual(v.summary, { state: 'error', text: zh['summary.signature'] })
  assert.equal(label(v, 'install'), zh['action.reinstall'])
  assert.deepEqual(primaryOps(v), ['install'])
  assert.deepEqual(enabledOps(v), ['install', 'stop'])
  assert.deepEqual(row(v, 'signature'), { id: 'signature', label: zh['row.signature'], value: zh['value.signature.mismatch'], state: 'error' })
  assert.deepEqual(enabledOps(view({ app: { signature: 'unsigned' }, running: false })), ['install'])
  assert.equal(v.permissionsHint, null, 'no permissions for a binary that is not ours')
})

test('view: an installed bench build (reported as signature mismatch): its texts name it; the host\'s refusal reads as such', () => {
  // The host reports an installed app whose CUBench is not false as 'mismatch' (it carries the TCC grants of the one
  // certificate but takes --state-dir and the debug switches) and refuses to launch it with not_release_build.
  const v = view({ app: { signature: 'mismatch' }, running: false })
  assert.deepEqual(v.summary, { state: 'error', text: zh['summary.signature'] })
  assert.match(zh['summary.signature'], /签名与本机签名身份不符，或不是正式版本（例如 bench 构建），需要重新安装/)
  assert.match(en['summary.signature'], /or it is not a release build \(a bench build, for example\)/)
  assert.equal(row(v, 'signature').value, '与本机签名身份不符，或不是正式版本')
  assert.match(en['value.signature.mismatch'], /or not a release build$/)
  assert.deepEqual(primaryOps(v), ['install'])
  assert.deepEqual(enabledOps(v), ['install'], 'nothing that launches, checks or grants it')
  assert.equal(label(v, 'install'), zh['action.reinstall'])
  // not_release_build comes from the install (the app just built) and from start, restart, permissions and selfcheck
  // (the installed app): its text covers both.
  const refused = buildView(readStatus(sample({ app: { signature: 'mismatch' } })),
    { t, actionError: { code: 'not_release_build', message: 'CUBench is true' } }).error
  assert.deepEqual({ ...refused }, { text: zh['error.not_release_build'], detail: '详情：CUBench is true' })
  assert.match(zh['error.not_release_build'], /构建出的此类版本不会替换 ~\/Applications 中的守护进程/)
  assert.match(zh['error.not_release_build'], /已安装的此类版本（例如 bench 构建）不会被启动、重启、检查权限或授予权限。请重新安装守护进程。$/)
  assert.match(en['error.not_release_build'], /never replaces the daemon in ~\/Applications, and an installed one/)
})

test('view: the signing certificate\'s SHA-1 is shown for the one identity, "—" without one; a malformed one is not shown', () => {
  assert.equal(row(view({}), 'identitySha1').value, IDENTITY_OPENSSL, 'in openssl\'s form')
  assert.equal(zh['row.identitySha1'], '签名证书 SHA-1')
  assert.equal(en['row.identitySha1'], 'Certificate SHA-1')
  const lower = 'ab12'.repeat(10)
  assert.equal(readStatus(sample({ app: { identitySha1: lower } })).app.identitySha1, lower)
  assert.equal(row(view({ app: { identitySha1: lower } }), 'identitySha1').value, 'AB:12:'.repeat(10).slice(0, -1), 'upper case')
  for (const bad of ['5E1F'.repeat(9), `${'5E1F'.repeat(10)}0`, 'G'.repeat(40), ` ${'5E1F'.repeat(10)}`, 40, null, undefined]) {
    const status = readStatus(sample({ app: { identitySha1: bad } }))
    assert.equal(status.app.identitySha1, null, String(bad))
    assert.equal(row(buildView(status, { t }), 'identitySha1').value, '—', String(bad))
  }
  // A host from before the field: the identity row as before, the SHA-1 unknown.
  const { identitySha1, ...older } = sample().app
  assert.equal(readStatus({ ...sample(), app: older }).app.identitySha1, null)
  // Shown only for the one identity, even if a host sent one with several or none.
  assert.equal(row(view({ app: { identity: 'ambiguous', signature: 'mismatch' } }), 'identitySha1').value, '—')
  assert.equal(row(view({ app: { identity: 'missing', signature: 'mismatch' } }), 'identitySha1').value, '—')
  // Drawn in a monospace code element, to compare with openssl's fingerprint of the backed-up certificate.
  const { tree } = renderPage({ status: readStatus(sample()) })
  assert.deepEqual(find(tree, (e) => e.type === 'code').map(texts), [[IDENTITY_OPENSSL]])
  const none = renderPage({ status: readStatus(sample({ app: { identitySha1: null } })) }).tree
  assert.deepEqual(find(none, (e) => e.type === 'code'), [], 'the placeholder is plain text')
})

test('view: more than one cu-runtime-signing identity: said plainly; everything the host refuses for it is held', () => {
  const v = view({ app: { signature: 'mismatch', identity: 'ambiguous' }, permissions: null })
  assert.deepEqual(v.summary, { state: 'error', text: zh['summary.identityAmbiguous'] })
  assert.match(v.summary.text, /^钥匙串里有多张名为 cu-runtime-signing 的证书，请只保留授予过权限的那一张。/)
  assert.deepEqual(enabledOps(v), ['stop'], 'install, permissions, selfcheck, start and restart are refused by the host')
  assert.deepEqual(primaryOps(v), [])
  assert.deepEqual(row(v, 'identity'), { id: 'identity', label: zh['row.identity'], value: zh['value.identityAmbiguous'], state: 'error' })
  assert.deepEqual(row(v, 'signature'), { id: 'signature', label: zh['row.signature'], value: zh['value.signature.ambiguous'], state: 'error' })
  assert.equal(v.permissionsHint, null)
  assert.deepEqual(enabledOps(view({ app: { identity: 'ambiguous' }, running: false })), [],
    'held even if a host reported the signature ok')
  const notInstalled = view({ app: { installed: false, signature: 'missing', identity: 'ambiguous' }, running: false })
  assert.deepEqual(notInstalled.summary, { state: 'error', text: zh['summary.identityAmbiguous'] })
  assert.deepEqual(enabledOps(notInstalled), [])
  assert.deepEqual({ ...buildView(null, { t, actionError: { code: 'identity_ambiguous', message: '' } }).error },
    { text: zh['error.identity_ambiguous'], detail: null })
  assert.equal(readStatus(sample({ app: { identity: 'ambiguous' } })).app.identity, 'ambiguous')
  assert.equal(readStatus(sample({ app: { identity: 'several' } })).app.identity, 'missing')
})

/** The SHA-1 the host last signed with or created, when it is not the current identity's. */
const KNOWN_SHA1 = '0a1b'.repeat(10)
const KNOWN_OPENSSL = '0A:1B:0A:1B:0A:1B:0A:1B:0A:1B:0A:1B:0A:1B:0A:1B:0A:1B:0A:1B'
const CHANGED = { identityKnown: KNOWN_SHA1, identityChanged: true }

test('every SHA-1 the page draws is in openssl\'s form, and nothing says to compare with security find-identity -v', () => {
  assert.equal(opensslSha1('0123456789abcdefABCDEF0123456789abcdef01'),
    '01:23:45:67:89:AB:CD:EF:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01')
  assert.equal(FINGERPRINT_COMMAND, 'openssl x509 -noout -fingerprint -sha1 -in ~/.cu-runtime-signing/cert.pem')
  // A SHA-1 in a host's message (identity_changed names both) reads the same as on the rows; a requirement's
  // H"…" and a longer run of hexadecimal digits (a source hash) are left as they are.
  const named = buildView(null, { t, actionError: { code: 'identity_changed',
    message: `the identity ${IDENTITY_SHA1} is not ${KNOWN_SHA1}, the one last used` } }).error
  assert.deepEqual({ ...named }, { text: zh['error.identity_changed'],
    detail: `详情：the identity ${IDENTITY_OPENSSL} is not ${KNOWN_OPENSSL}, the one last used` })
  const kept = `certificate leaf = H"${IDENTITY_SHA1}", CUSourceHash ${'a'.repeat(64)}`
  assert.equal(buildView(null, { t, actionError: { code: 'signature_mismatch', message: kept } }).error.detail, `详情：${kept}`)
  // The task's log lines too: make-signing-identity.sh's created identity (echoed into the install's log) and the
  // host's own lines; the rest of a line, and the lines without one, as written.
  const log = [
    'building',
    `created code-signing identity "cu-runtime-signing" (${IDENTITY_SHA1}) in the login keychain`,
    `identity cu-runtime-signing ${KNOWN_SHA1.toLowerCase()} recorded`,
    kept,
  ]
  assert.deepEqual([...view({ task: task('sign', { log }) }).task.log], [
    'building',
    `created code-signing identity "cu-runtime-signing" (${IDENTITY_OPENSSL}) in the login keychain`,
    `identity cu-runtime-signing ${KNOWN_OPENSSL} recorded`,
    kept,
  ])
  const v = view({ app: CHANGED })
  for (const id of ['identitySha1', 'identityKnown']) assert.match(row(v, id).value, /^([0-9A-F]{2}:){19}[0-9A-F]{2}$/, id)
  // The page's texts, its sources and the design doc's bundle section: the fingerprint of the backed-up certificate,
  // never `security find-identity -v` (it does not list this untrusted self-signed identity).
  const readme = readFileSync(join(ROOT, 'docs/DESIGN.md'), 'utf8')
  const from = readme.indexOf('\n## Installable dsh bundle')
  const bundle = readme.slice(from, readme.indexOf('\n## ', from + 1))
  const sources = ['api.ts', 'index.ts', 'locale.ts', 'page.ts', 'view.ts']
    .map((f) => readFileSync(join(ROOT, 'plugin/src/client', f), 'utf8'))
  for (const text of [...Object.values(zh), ...Object.values(en), ...sources, bundle]) {
    assert.doesNotMatch(text, /find-identity -v/)
  }
  assert.ok(bundle.includes('`openssl x509 -noout -fingerprint -sha1 -in ~/.cu-runtime-signing/cert.pem`'), 'the README names the comparison')
})

test('view: an identity that is not the one the host last signed with or created: both SHA-1s, how to compare, install held', () => {
  const v = view({ app: CHANGED, upToDate: false })
  assert.deepEqual(v.summary, { state: 'error', text: zh['summary.identityChanged'] })
  assert.deepEqual(row(v, 'identity'), { id: 'identity', label: zh['row.identity'], value: zh['value.identityChanged'], state: 'error' })
  assert.equal(row(v, 'identitySha1').value, IDENTITY_OPENSSL)
  assert.deepEqual(row(v, 'identityKnown'), { id: 'identityKnown', label: zh['row.identityKnown'], value: KNOWN_OPENSSL, state: null })
  assert.deepEqual(v.sections[0].rows.map((r) => r.id).slice(5, 9), ['identity', 'identitySha1', 'identityKnown', 'running'])
  assert.deepEqual(v.actions.map((a) => a.op), ['acceptIdentity', 'install', 'permissions', 'selfcheck', 'start', 'stop', 'restart'])
  assert.equal(label(v, 'acceptIdentity'), zh['action.acceptIdentity'])
  assert.equal(label(v, 'install'), zh['action.update'])
  assert.deepEqual(enabledOps(v), ['acceptIdentity', 'stop'],
    'install (here: update) is held, and nothing that launches, checks or grants permissions to an app of that identity')
  assert.equal(v.permissionsHint, null)
  assert.match(zh['summary.identityChanged'], /在确认当前证书之前，无法安装、更新、启动守护进程或为其授予权限/)
  const ungranted = { running: false, permissions: { accessibility: false, screenRecording: false } }
  const unconfirmed = view({ app: CHANGED, ...ungranted })
  assert.deepEqual(enabledOps(unconfirmed), ['acceptIdentity'], 'not even an app it signed (one built outside the host)')
  // The grant hint says to click 授予权限, held while the identity is unconfirmed: no hint either (the same status
  // with the identity confirmed shows it).
  assert.equal(unconfirmed.permissionsHint, null)
  assert.equal(view(ungranted).permissionsHint, zh['hint.permissions'])
  assert.deepEqual(primaryOps(v), [], 'comparing comes first: no button is the next step')
  assert.deepEqual({ ...v.identityChange, commands: [...v.identityChange.commands] },
    { text: t('identity.changed', { known: zh['identity.known'] }), commands: [P12_FINGERPRINT_COMMAND, FINGERPRINT_COMMAND] })
  assert.match(v.identityChange.text, /不是上次签名或创建时使用的那一张（「上次使用的证书 SHA-1」）。/)
  assert.equal(P12_FINGERPRINT_COMMAND,
    '/usr/bin/openssl pkcs12 -in <backup.p12> -nokeys -clcerts | /usr/bin/openssl x509 -noout -fingerprint -sha1')
  // The reference is the backup kept off this Mac; the local cert.pem is a convenience any process of this user can
  // rewrite, and a cert.pem.replaced-* next to it says it was.
  assert.match(zh['identity.changed'], /可作参照的是保存在这台 Mac 之外的 \.p12 备份（或同样保存在这台 Mac 之外的 cert\.pem），本用户的进程无法替换它/)
  assert.match(zh['identity.changed'], /~\/\.cu-runtime-signing\/cert\.pem 是 make-signing-identity\.sh 在本机保存的副本，只为方便核对：本用户的任何进程都能改写它/)
  assert.match(zh['identity.changed'], /cert\.pem\.replaced-\* 文件，说明 cert\.pem 被改写过[^]*确认之前应先查明原因/)
  assert.match(zh['identity.changed'], /备份证书的 SHA-1 与「签名证书 SHA-1」一致[^]*可点击「确认当前证书」[^]*两者不一致时请勿确认/)
  assert.match(en['identity.changed'], /The reference is the \.p12 backup kept off this Mac \(or a cert\.pem kept off this Mac as well\), which no process of this user can swap/)
  assert.match(en['identity.changed'], /~\/\.cu-runtime-signing\/cert\.pem, the copy make-signing-identity\.sh kept on this Mac, which is only a convenience: any process of this user can rewrite it/)
  assert.match(en['identity.changed'], /A cert\.pem\.replaced-\* next to it means cert\.pem was rewritten[^]*find out why before accepting/)
  assert.match(en['identity.changed'], /matches Certificate SHA-1[^]*Accept the current certificate[^]*If they differ, do not accept it/)
  assert.equal(zh['action.acceptIdentity'], '确认当前证书')
  assert.match(zh['error.identity_changed'], /已拒绝安装/)
  assert.match(en['error.identity_changed'], /so the install was refused/)

  const absent = view({ app: { ...CHANGED, installed: false, signature: 'missing' }, upToDate: false, running: false })
  assert.deepEqual(absent.summary, { state: 'error', text: zh['summary.identityChanged'] })
  assert.deepEqual(enabledOps(absent), ['acceptIdentity'], 'no install either')
  const unknown = view({ app: { ...CHANGED, identityKnown: 'not a sha1' } })
  assert.equal(row(unknown, 'identityKnown').value, '—', 'a malformed SHA-1 is not shown')
  assert.deepEqual(enabledOps(view({ app: CHANGED }, { pending: 'acceptIdentity' })), [], 'held while it is in flight')
  assert.deepEqual(enabledOps(view({ app: CHANGED, task: task('build') })), ['cancel'], 'and while a task runs (the host answers busy)')

  // Where the host has the known SHA-1 from: its record ('record', and a host without the field) or, with no
  // readable record, the installed app's signature ('installedApp'); the row, the identity's value, the summary and
  // the text name it so.
  for (const source of ['record', undefined, 'elsewhere']) {
    const w = view({ app: { ...CHANGED, identityKnownSource: source } })
    assert.equal(row(w, 'identityKnown').label, zh['row.identityKnown'], String(source))
    assert.equal(w.identityChange.text, t('identity.changed', { known: zh['identity.known'] }), String(source))
  }
  const installedApp = view({ app: { ...CHANGED, identityKnownSource: 'installedApp' } })
  assert.deepEqual(row(installedApp, 'identityKnown'),
    { id: 'identityKnown', label: zh['row.identityKnownInstalledApp'], value: KNOWN_OPENSSL, state: null })
  assert.equal(row(installedApp, 'identity').value, zh['value.identityChangedInstalledApp'])
  assert.deepEqual(installedApp.summary, { state: 'error', text: zh['summary.identityChangedInstalledApp'] })
  assert.equal(installedApp.identityChange.text, t('identity.changed', { known: zh['identity.knownInstalledApp'] }))
  assert.match(installedApp.identityChange.text, /不是已安装的 CURuntime\.app 所用的那一张（「已安装应用的证书 SHA-1」）。/)
  assert.deepEqual(enabledOps(installedApp), ['acceptIdentity', 'stop'], 'held the same way')
  assert.equal(zh['row.identityKnown'], '上次使用的证书 SHA-1')
  assert.equal(en['row.identityKnown'], 'Certificate SHA-1 last used')
  assert.equal(zh['row.identityKnownInstalledApp'], '已安装应用的证书 SHA-1')
  assert.equal(en['row.identityKnownInstalledApp'], 'Installed app\'s certificate SHA-1')
  assert.equal(translator(en)('identity.changed', { known: en['identity.knownInstalledApp'] }).includes(
    'is not the one the installed CURuntime.app was signed with (Installed app\'s certificate SHA-1).'), true)
  assert.deepEqual(['record', 'installedApp', 'elsewhere', 7, undefined].map((s) =>
    readStatus(sample({ app: { ...CHANGED, identityKnownSource: s } })).app.identityKnownSource),
  ['record', 'installedApp', null, null, null])

  // A host from before the fields, and an identity that did not change: nothing of it.
  const { identityKnown, identityChanged, ...older } = sample({ app: CHANGED }).app
  for (const status of [readStatus(sample()), readStatus({ ...sample(), app: older }),
    readStatus(sample({ app: { identityKnown: IDENTITY_SHA1, identityChanged: false } }))]) {
    const w = buildView(status, { t })
    assert.equal(status.app.identityChanged, false)
    assert.equal(w.identityChange, null)
    assert.equal(row(w, 'identityKnown'), undefined)
    assert.equal(w.actions.some((a) => a.op === 'acceptIdentity'), false)
    assert.deepEqual(w.summary, { state: 'done', text: zh['summary.ready'] })
  }
  assert.equal(readStatus(sample()).app.identityKnown, null)
  assert.equal(readStatus(sample({ app: CHANGED })).app.identityKnown, KNOWN_SHA1)
  assert.throws(() => readStatus(sample({ app: { identityChanged: 'yes' } })), (e) => e.code === 'bad_response')
  // Only for the one identity: several of the name are refused as such.
  const several = view({ app: { ...CHANGED, identity: 'ambiguous', signature: 'mismatch' } })
  assert.deepEqual(several.summary, { state: 'error', text: zh['summary.identityAmbiguous'] })
  assert.equal(several.identityChange, null)
  assert.equal(several.actions.some((a) => a.op === 'acceptIdentity'), false)
})

test('确认当前证书 posts api/cu-runtime.acceptIdentity; the status read after it settles the warning', async () => {
  let current = answer(sample({ app: CHANGED }))
  const page = mountPage({
    status: () => current,
    acceptIdentity: () => {
      current = answer(sample({ app: { identityKnown: IDENTITY_SHA1, identityChanged: false } }))
      return answer({ ok: true, error: null })
    },
  })
  await page.settle()
  const changedText = t('identity.changed', { known: zh['identity.known'] })
  assert.ok(page.shown().includes(changedText))
  assert.deepEqual(find(page.tree, (e) => e.type === 'code').map(texts),
    [[IDENTITY_OPENSSL], [KNOWN_OPENSSL], [P12_FINGERPRINT_COMMAND], [FINGERPRINT_COMMAND]])
  const [update] = find(page.tree, (e) => e.type === 'button' && texts(e).includes(zh['action.reinstall']))
  assert.equal(update.props.disabled, true, 'install is held')
  await page.click(zh['action.acceptIdentity'])
  assert.deepEqual(page.posted, ['status', 'acceptIdentity', 'status'])
  assert.deepEqual(page.alert(), [])
  assert.equal(page.shown().includes(changedText), false)
  assert.ok(page.shown().includes(zh['summary.ready']))
  page.unmount()

  // The certificate changed again after the page showed it: the host refuses (identity_changed, C10). The status is
  // read again whatever the answer, so the page then shows the new certificate's SHA-1 to compare, under its own
  // text for this refusal (not the install's).
  const AGAIN_SHA1 = '7c3d'.repeat(10)
  const AGAIN_OPENSSL = '7C:3D:7C:3D:7C:3D:7C:3D:7C:3D:7C:3D:7C:3D:7C:3D:7C:3D:7C:3D'
  const again = `the code-signing identity changed again since it was shown (now ${AGAIN_SHA1}); read it again and compare`
  for (const [refusal, alert, swapped] of [
    [answer({ ok: false, error: { code: 'identity_changed', message: again } }),
      [zh['identity.changedAgain'], `详情：${again.replace(AGAIN_SHA1, AGAIN_OPENSSL)}`], true],
    [answer({ ok: false, error: { code: 'busy', message: 'the install task is running' } }), [zh['error.busy'], '详情：the install task is running'], false],
    [answer({}), [zh['error.bad_response'], '详情：the acceptIdentity answer states no success'], false],
    [answer({ ok: false, error: { code: 'internal', message: 'EACCES' } }, 500), [zh['error.internal'], '详情：EACCES'], false],
  ]) {
    let shown = answer(sample({ app: CHANGED }))
    const refused = mountPage({
      status: () => shown,
      acceptIdentity: () => {
        if (swapped) shown = answer(sample({ app: { ...CHANGED, identitySha1: AGAIN_SHA1 } }))
        return refusal
      },
    })
    await refused.settle()
    await refused.click(zh['action.acceptIdentity'])
    assert.deepEqual(refused.posted, ['status', 'acceptIdentity', 'status'], 'read again after the refusal')
    assert.deepEqual(refused.alert(), alert)
    assert.ok(refused.shown().includes(changedText), 'still to be checked')
    assert.deepEqual(find(refused.tree, (e) => e.type === 'code').map(texts).slice(0, 2),
      [[swapped ? AGAIN_OPENSSL : IDENTITY_OPENSSL], [KNOWN_OPENSSL]], 'the SHA-1 the status read after it has')
    refused.unmount()
  }
  assert.match(zh['identity.changedAgain'], /本页显示之后，钥匙串中的证书又发生了变化，已拒绝确认/)
  assert.match(en['identity.changedAgain'], /changed again after this page showed it, so it was not accepted/)
  // Only acceptIdentity's: install's identity_changed keeps its own text.
  assert.equal(buildView(null, { t, actionError: { code: 'identity_changed', message: '' }, actionErrorOp: 'install' }).error.text,
    zh['error.identity_changed'])
})

const SINCE = '2026-10-20T13:05:00.000Z'
const BUSY_OTHER = { pid: 4242, since: SINCE, self: false }
const BUSY_SELF = { pid: 4242, since: SINCE, self: true }

test('view: another holder of the host\'s lock while the host runs no task: one line naming it, every button held', () => {
  const other = view({ busy: BUSY_OTHER, upToDate: false })
  assert.deepEqual(other.summary, { state: 'ongoing', text: t('summary.busyOther', { pid: 4242, since: SINCE }) })
  assert.match(other.summary.text, /^另一个 dsh 进程（pid 4242）自 2026-10-20T13:05:00\.000Z 起正在管理守护进程。/)
  assert.deepEqual(enabledOps(other), [])
  assert.deepEqual(primaryOps(other), [])
  assert.equal(other.permissionsHint, null)
  assert.equal(other.task, null)
  const self = view({ busy: BUSY_SELF, permissions: null })
  assert.deepEqual(self.summary, { state: 'ongoing', text: t('summary.busySelf', { pid: 4242, since: SINCE }) })
  assert.match(self.summary.text, /^本 dsh 进程中先前加载的插件版本（pid 4242）自 2026-10-20T13:05:00\.000Z 起仍在管理守护进程/)
  assert.deepEqual(enabledOps(self), [])
  assert.match(en['summary.busySelf'], /^An earlier version of this plugin, loaded before in this dsh process \(pid \{pid\}\)/)
  assert.match(en['summary.busyOther'], /^Another dsh process \(pid \{pid\}\) has been managing the daemon since \{since\}/)
  for (const key of ['summary.busySelf', 'summary.busyOther']) {
    assert.match(zh[key], /无法安装、启动、停止守护进程或为其授予权限/, key)
    assert.match(en[key], /cannot be installed, started, stopped or granted permissions/, key)
  }
  assert.deepEqual(enabledOps(view({ busy: BUSY_OTHER, environment: { clt: false }, app: CHANGED })), [],
    'the Command Line Tools and accepting the identity wait too')

  // A task of the host's own that has ended: the holder governs, the task's outcome is still shown.
  const ended = view({ busy: BUSY_OTHER, task: task('failed', { error: { code: 'busy', message: '' } }) })
  assert.equal(ended.summary.text, other.summary.text)
  assert.deepEqual(enabledOps(ended), [])
  assert.equal(ended.task.title, zh['task.failed'])
  // A task of its own that runs: that task governs.
  const running = view({ busy: BUSY_OTHER, task: task('build') })
  assert.deepEqual(running.summary, { state: 'ongoing', text: '正在安装守护进程：构建' })
  assert.deepEqual(enabledOps(running), ['cancel'])

  // A host from before the field, and none held: as before.
  assert.equal(readStatus(sample()).busy, null)
  assert.equal(readStatus(sample({ busy: null })).busy, null)
  assert.deepEqual({ ...readStatus(sample({ busy: BUSY_SELF })).busy }, BUSY_SELF)
  assert.deepEqual(view({ busy: null }).summary, { state: 'done', text: zh['summary.ready'] })
  for (const bad of [{ ...BUSY_OTHER, pid: '4242' }, { ...BUSY_OTHER, pid: 0 }, { ...BUSY_OTHER, pid: 1.5 },
    { ...BUSY_OTHER, since: 1760965500000 }, { pid: 4242, since: SINCE }, 'yes', true]) {
    assert.throws(() => readStatus(sample({ busy: bad })), (e) => e.code === 'bad_response', JSON.stringify(bad))
  }

  // Drawn as the page's summary line.
  const lines = texts(find(renderPage({ status: readStatus(sample({ busy: BUSY_SELF })) }).tree, (e) => e.props?.role === 'status'))
  assert.deepEqual(lines, [self.summary.text])
})

test('the status is read every second while another holder has the lock, every 10 s once it is gone', async () => {
  for (const status of [sample({ busy: BUSY_OTHER }), sample({ busy: BUSY_SELF, task: task('done') })]) {
    const held = await poll(status)
    assert.deepEqual(held.timers, [1000], JSON.stringify(status.busy))
    held.dispose()
  }
  const free = await poll(sample({ busy: null }))
  assert.deepEqual(free.timers, [10_000])
  free.dispose()
})

test('view: Command Line Tools missing: their install comes first, the daemon\'s waits for them', () => {
  const v = view({ app: { installed: false, signature: 'missing' }, upToDate: false, running: false, permissions: null,
    environment: { clt: false } })
  assert.deepEqual(v.actions.map((a) => a.op), ['clt', 'install', 'permissions', 'selfcheck', 'start', 'stop', 'restart'])
  assert.deepEqual(enabledOps(v), ['clt'])
  assert.deepEqual(primaryOps(v), ['clt'])
  assert.equal(label(v, 'clt'), zh['action.clt'])
  assert.deepEqual(row(v, 'clt'), { id: 'clt', label: zh['row.clt'], value: zh['value.cltMissing'], state: 'warning' })
  assert.equal(view({}).actions.some((a) => a.op === 'clt'), false, 'no clt button when they are installed')
})

test('view: SSH session: nothing that signs, launches or opens a dialog; stop still works', () => {
  const v = view({ environment: { sshSession: true }, upToDate: false })
  assert.deepEqual(v.summary, { state: 'error', text: zh['summary.sshSession'] })
  assert.deepEqual(enabledOps(v), ['stop'])
  assert.deepEqual(primaryOps(v), [])
  assert.deepEqual(row(v, 'session'), { id: 'session', label: zh['row.session'], value: zh['value.sshSession'], state: 'error' })
  assert.deepEqual(enabledOps(view({ environment: { sshSession: true, clt: false }, running: false })), [])
  const headless = view({ environment: { gui: false } })
  assert.deepEqual(headless.summary, { state: 'error', text: zh['summary.noGui'] })
  assert.deepEqual(enabledOps(headless), ['stop'])
})

test('view: task running: progress, the keychain advice until signing is over, cancel until the app is replaced', () => {
  const log = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
  const v = view({ task: task('build', { log }) })
  assert.deepEqual(v.summary, { state: 'ongoing', text: '正在安装守护进程：构建' })
  assert.deepEqual(enabledOps(v), ['cancel'])
  assert.equal(v.actions.at(-1).op, 'cancel')
  assert.equal(label(v, 'cancel'), zh['action.cancel'])
  assert.equal(v.task.title, zh['task.running'])
  assert.equal(v.task.state, 'ongoing')
  assert.equal(v.task.step, `第 4 步，共 ${PHASES.length} 步：构建`)
  assert.equal(v.task.keychain, zh['task.keychain'])
  assert.equal(v.task.note, null)
  assert.equal(v.task.error, null)
  assert.deepEqual([...v.task.log], log.slice(-LOG_LINES))
  assert.equal(v.task.logTitle, `日志（最后 ${LOG_LINES} 行）`)

  for (const phase of ['preflight', 'identity', 'copy', 'sign']) {
    const w = view({ task: task(phase) })
    assert.equal(w.task.keychain, zh['task.keychain'], phase)
    assert.equal(w.task.note, null, phase)
  }
  for (const phase of ['verify', 'stop']) {
    const w = view({ task: task(phase) })
    assert.equal(w.task.keychain, null, phase)
    assert.equal(w.task.note, null, phase)
    assert.deepEqual(enabledOps(w), ['cancel'], phase)
  }
  for (const phase of ['replace', 'start', 'selfcheck']) {
    const w = view({ task: task(phase) })
    assert.deepEqual(enabledOps(w), [], phase)
    assert.equal(w.task.keychain, null, phase)
    assert.equal(w.task.note, zh['task.noCancel'], phase)
  }
  const unknown = view({ task: task('notarize') })
  assert.equal(unknown.summary.state, 'ongoing', 'a phase this page does not know is still a running task')
  assert.equal(unknown.task.step, null)
  assert.equal(unknown.task.keychain, null, 'no keychain advice for a phase this page cannot place')
  assert.equal(unknown.task.note, null, 'nor a claim that the app is being replaced')
  assert.deepEqual(enabledOps(unknown), [])
})

test('view: task failed: the error by its code and the host\'s detail; the buttons are back', () => {
  const v = view({ upToDate: false, task: task('failed', { log: ['xcode-select: error'],
    error: { code: 'clt_missing', message: 'xcode-select -p exited 2' } }) })
  assert.equal(v.task.title, zh['task.failed'])
  assert.equal(v.task.state, 'error')
  assert.deepEqual({ ...v.task.error }, { text: zh['error.clt_missing'], detail: '详情：xcode-select -p exited 2' })
  assert.equal(v.task.step, null)
  assert.equal(v.task.keychain, null)
  assert.deepEqual(enabledOps(v), ['install', 'permissions', 'selfcheck', 'stop', 'restart'])
  assert.equal(v.actions.some((a) => a.op === 'cancel'), false)
  assert.deepEqual(v.summary, { state: 'warning', text: zh['summary.outdated'] })

  const built = view({ task: task('failed', { error: { code: 'build_failed', message: '' } }) }).task.error
  assert.deepEqual({ ...built }, { text: zh['error.build_failed'], detail: null })
  const release = view({ task: task('failed', { error: { code: 'not_release_build', message: 'CUBench is true' } }) }).task.error
  assert.deepEqual({ ...release }, { text: zh['error.not_release_build'], detail: '详情：CUBench is true' })
  const byPhase = view({ task: task('failed', { error: { code: 'verify_failed', message: '' } }) }).task.error
  assert.deepEqual({ ...byPhase }, { text: '「校验签名」这一步失败。', detail: null }, 'a phase\'s failure without a text of its own')
  const signing = view({ task: task('failed', { error: { code: 'sign_failed', message: 'errSecAuthFailed' } }) }).task.error
  assert.equal(signing.text, zh['error.sign_failed'])
  const other = view({ task: task('failed', { error: { code: 'disk_full', message: 'ENOSPC' } }) }).task.error
  assert.deepEqual({ ...other }, { text: '操作失败（disk_full）。', detail: '详情：ENOSPC' })
  assert.equal(view({ task: task('failed') }).task.error.text, '操作失败（unknown）。')
  assert.equal(view({ task: task('done') }).task.title, zh['task.done'])
  assert.equal(view({ task: task('cancelled') }).task.state, 'idle')
})

test('view: a task that ended while signing, or failed with sign_failed: a password dialog may still be open, closed with 拒绝', () => {
  // Ending codesign (a failure, a cancel, the build's timeout) does not close macOS's password dialog.
  const open = zh['task.openDialog']
  assert.match(open, /^钥匙串的密码对话框可能仍未关闭/)
  assert.match(open, /请选择「拒绝」将其关闭/)
  assert.match(en['task.openDialog'], /^A keychain password dialog may still be open/)
  assert.match(en['task.openDialog'], /close it with Deny/)
  const shown = [
    task('failed', { endedIn: 'sign', error: { code: 'sign_failed', message: 'errSecAuthFailed' } }),
    task('failed', { error: { code: 'sign_failed', message: '' } }),
    task('failed', { endedIn: 'sign', error: { code: 'build_failed', message: 'timed out' } }),
    task('cancelled', { endedIn: 'sign' }),
  ]
  for (const ended of shown) assert.equal(view({ task: ended }).task.openDialog, open, JSON.stringify(ended))
  const notShown = [
    task('failed', { endedIn: 'build', error: { code: 'build_failed', message: '' } }),
    task('failed', { endedIn: 'verify', error: { code: 'signature_mismatch', message: '' } }),
    task('cancelled', { endedIn: 'build' }),
    task('cancelled'),
    task('cancelled', { endedIn: 4 }),
    task('done'),
    task('sign'),
    task('sign', { endedIn: 'sign' }),
  ]
  for (const other of notShown) assert.equal(view({ task: other }).task.openDialog, null, JSON.stringify(other))
  assert.equal(view({ task: task('sign') }).task.keychain, zh['task.keychain'], 'while signing: how to answer it instead')

  assert.equal(readStatus(sample({ task: task('cancelled', { endedIn: 'sign' }) })).task.endedIn, 'sign')
  assert.equal(readStatus(sample({ task: task('cancelled') })).task.endedIn, null, 'a host from before the field')
  assert.equal(readStatus(sample({ task: task('cancelled', { endedIn: 4 }) })).task.endedIn, null)

  // Drawn in the task's section, after the error and its detail.
  const failed = task('failed', { endedIn: 'sign', error: { code: 'sign_failed', message: 'errSecAuthFailed' } })
  const lines = texts(renderPage({ status: readStatus(sample({ task: failed })) }).tree)
  const at = lines.indexOf(open)
  assert.ok(lines.indexOf(zh['error.sign_failed']) >= 0)
  assert.ok(at > lines.indexOf('详情：errSecAuthFailed') && lines.indexOf('详情：errSecAuthFailed') > lines.indexOf(zh['error.sign_failed']))
  assert.ok(texts(renderPage({ status: readStatus(sample({ task: task('cancelled', { endedIn: 'sign' }) })) }).tree).includes(open))
  assert.ok(!texts(renderPage({ status: readStatus(sample({ task: task('cancelled', { endedIn: 'stop' }) })) }).tree).includes(open))
})

test('view: the next step is primary: permissions, then 检查权限 after each pane, then start', () => {
  const missing = view({ permissions: { accessibility: true, screenRecording: false } })
  assert.deepEqual(missing.summary, { state: 'warning', text: zh['summary.permissions'] })
  assert.deepEqual(primaryOps(missing), ['permissions'])
  assert.equal(row(missing, 'screenRecording').state, 'warning')
  assert.equal(missing.permissionsHint, zh['hint.permissions'], 'how the one-pane-per-click flow goes, next to the button')
  const opened = view({ permissions: { accessibility: false, screenRecording: false } }, { done: 'permissions' })
  assert.deepEqual(primaryOps(opened), ['selfcheck'], 'after a pane was opened, the permissions shown are those read before it')
  assert.equal(opened.notice, zh['notice.permissions'])
  const checked = view({ permissions: { accessibility: true, screenRecording: false } }, { done: 'selfcheck' })
  assert.deepEqual(primaryOps(checked), ['permissions'], 'then 授予权限 again for the next pane')
  const stopped = view({ running: false, permissions: null })
  assert.deepEqual(stopped.summary, { state: 'idle', text: zh['summary.stopped'] })
  assert.deepEqual(primaryOps(stopped), ['start'])
  assert.deepEqual(enabledOps(stopped), ['install', 'permissions', 'selfcheck', 'start'])
})

test('view: permissions not checked lately: 「未检查」, not an error and not all well; 检查权限 reads them', () => {
  const v = view({ permissions: null })
  for (const id of ['accessibility', 'screenRecording']) {
    assert.deepEqual(row(v, id), { id, label: zh[`row.${id}`], value: zh['value.unchecked'], state: 'idle' })
  }
  assert.equal(zh['value.unchecked'], '未检查')
  assert.equal(en['value.unchecked'], 'Not checked')
  assert.deepEqual(v.summary, { state: 'idle', text: zh['summary.unchecked'] })
  assert.notEqual(v.summary.text, zh['summary.ready'])
  assert.equal(v.error, null)
  assert.deepEqual(primaryOps(v), ['selfcheck'])
  assert.equal(label(v, 'selfcheck'), zh['action.selfcheck'])
  assert.equal(zh['action.selfcheck'], '检查权限')
  assert.equal(v.permissionsHint, zh['hint.permissions'])
  assert.match(zh['hint.permissions'], /每次只打开系统设置中的一个面板/)
  assert.match(zh['hint.permissions'], /「辅助功能」[^]*「检查权限」[^]*再点击一次「授予权限」打开「屏幕录制」/)
  assert.match(en['hint.permissions'], /one System Settings pane per click/)
  assert.deepEqual(enabledOps(view({ permissions: null }, { pending: 'selfcheck' })), [])
  assert.equal(view({ permissions: null, environment: { sshSession: true } }).permissionsHint, null)
})

test('view: an action in flight holds every button; its failure or notice is shown after it', () => {
  assert.deepEqual(enabledOps(view({}, { pending: 'restart' })), [])
  assert.deepEqual(enabledOps(view({ task: task('build') }, { pending: 'cancel' })), [])
  const refused = view({}, { actionError: { code: 'signature_mismatch', message: '' }, statusError: { code: 'network', message: 'x' } })
  assert.deepEqual({ ...refused.error }, { text: zh['error.signature_mismatch'], detail: null })
  assert.equal(view({}, { done: 'permissions' }).notice, zh['notice.permissions'])
  assert.equal(view({}, { done: 'clt' }).notice, zh['notice.clt'])
  assert.equal(view({}, { done: 'start' }).notice, null)
})

test('view: before any status, and when it cannot be read', () => {
  const loading = buildView(null, { t })
  assert.deepEqual(loading.summary, { state: 'idle', text: zh['summary.loading'] })
  assert.deepEqual([...loading.actions], [])
  const unreadable = buildView(null, { t, statusError: { code: 'unauthorized', message: 'HTTP 401' } })
  assert.deepEqual(unreadable.summary, { state: 'error', text: zh['summary.unreadable'] })
  assert.deepEqual({ ...unreadable.error }, { text: zh['error.unauthorized'], detail: '详情：HTTP 401' })
  assert.equal(buildView(null, { t: translator(en) }).summary.text, en['summary.loading'])
})

test('readStatus refuses a status without the fields the page decides on', () => {
  assert.equal(readStatus(sample()).app.signature, 'ok')
  const bad = (raw) => assert.throws(() => readStatus(raw), (e) => e.code === 'bad_response')
  bad(null)
  bad({})
  bad(sample({ upToDate: 'yes' }))
  bad(sample({ app: { signature: 'valid' } }))
  bad(sample({ environment: { clt: undefined } }))
  bad(sample({ permissions: { accessibility: true } }))
  bad(sample({ task: { id: 't', log: [] } }))
  bad(sample({ task: task('failed', { error: 'boom' }) }))
  const lenient = readStatus(sample({ app: { version: undefined, sourceHash: undefined }, package: undefined }))
  assert.equal(lenient.app.version, null)
  assert.equal(lenient.package.version, '')
})

// --- the packaging: the one documented build, and the profile check on the bundle from before the page ---

const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'))

/** npm's lifecycle scripts: in the root package.json they would run when the package is installed (prepare for a git install). */
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'prepack',
  'postpack', 'prepublishOnly', 'publish', 'postpublish', 'dependencies']

test('one documented build makes every entry point: npm run build at the root runs the host tsc, then the plugin page', () => {
  const root = readJson('package.json')
  const plugin = readJson('plugin/package.json')
  assert.deepEqual(root.scripts, { build: 'cd plugin && npm run build' })
  assert.deepEqual(Object.keys(root.scripts).filter((s) => LIFECYCLE.includes(s)), [], 'no install-time script')
  assert.equal(plugin.scripts.build, 'tsc -p tsconfig.build.json && node ../scripts/build-client.mjs')
  // Run on a copy of what the build reads, so plugin/lib is not touched.
  const copy = mkdtempSync(join(tmpdir(), 'cu-build-'))
  try {
    for (const p of ['package.json', 'plugin/package.json', 'plugin/tsconfig.build.json', 'plugin/tsconfig.client.json',
      'plugin/src', 'scripts/build-client.mjs']) {
      cpSync(join(ROOT, p), join(copy, p), { recursive: true })
    }
    symlinkSync(join(ROOT, 'plugin/node_modules'), join(copy, 'plugin/node_modules'))
    execFileSync('npm', ['run', 'build'], { cwd: copy, stdio: ['ignore', 'pipe', 'pipe'] })
    const built = [...new Set(Object.values(root.exports).map((t) => t.replace(/^\.\//, '')))]
      .filter((t) => t.startsWith('plugin/lib/')).sort()
    assert.deepEqual(built, ['plugin/lib/host.js', 'plugin/lib/index.js', 'plugin/lib/web-client.js'])
    for (const t of built) assert.ok(existsSync(join(copy, t)), `${t} is built`)
    assert.ok(readFileSync(join(copy, 'plugin/lib/web-client.js'), 'utf8')
      .startsWith('window.__ModuleLoader__.load({\n\tid: "cu-runtime",\n'), 'the page is the loader script')
    assert.doesNotMatch(readFileSync(join(copy, 'plugin/lib/client.js'), 'utf8'), /__ModuleLoader__/,
      'lib/client.js stays the host build\'s daemon client')
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
})

test('the design doc builds with it, says plugin/lib is tracked and to build again after editing; the pre-push hook runs the same build and refuses a stale plugin/lib', () => {
  const readme = readFileSync(join(ROOT, 'docs/DESIGN.md'), 'utf8')
  const from = readme.indexOf('\n## Installable dsh bundle')
  const bundle = readme.slice(from, readme.indexOf('\n## ', from + 1))
  const [, block] = /```sh\n([^]*?)```/.exec(bundle)
  const [build, add] = block.split('\n')
  assert.match(build, /^npm run build +# from the repository root; again after editing the plugin's sources, before dsh restarts$/)
  assert.match(add, /^dsh plugin --profile web add link:\$PWD /)
  assert.match(bundle, /`plugin\/lib` is tracked: dsh's 添加插件 with the repository's GitHub URL[^]*the pre-push hook refuses a `plugin\/lib` that differs/)
  assert.match(bundle, /after editing the plugin's sources run `npm run build` before dsh restarts/)
  assert.match(bundle, /still holds the bundle from before the plugin page \(its top-level row named `cu-runtime\/host`, its tools row `cu-runtime`\) is updated by removing the bundle and adding this version again/)
  assert.ok(readme.includes('(cd plugin && npm run build && npm test)'), 'the plugin\'s own build and test line')
  assert.doesNotMatch(readme, /tsc -p tsconfig\.build\.json/, 'no documented build that leaves the page out')

  // The hook's plugin step, run with npm and node recording where and how they were called.
  const hook = readFileSync(join(ROOT, 'scripts/hooks/pre-push'), 'utf8')
  const step = hook.slice(hook.indexOf('step "plugin: build + node tests"'), hook.indexOf('step "pytest bench/tests"'))
  const code = step.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  assert.doesNotMatch(code, /scripts\/build-client\.mjs|\.bin\/tsc/, 'no build of its own')
  const dir = mkdtempSync(join(tmpdir(), 'cu-pre-push-'))
  try {
    mkdirSync(join(dir, 'bin'))
    mkdirSync(join(dir, 'repo/plugin/node_modules'), { recursive: true })
    mkdirSync(join(dir, 'repo/plugin/tests'))
    writeFileSync(join(dir, 'repo/plugin/tests/a.test.mjs'), '')
    const run = (npmStatus, gitStatus = 0) => {
      rmSync(join(dir, 'calls'), { force: true })
      for (const [tool, status] of [['npm', npmStatus], ['node', 0], ['git', gitStatus]]) {
        writeFileSync(join(dir, 'bin', tool), `#!/bin/sh\necho "\${PWD##*/} ${tool} $*" >> '${dir}/calls'\nexit ${status}\n`, { mode: 0o755 })
      }
      const r = spawnSync('/bin/zsh', ['-c', `fail() { print -u2 "FAILED: $1"; exit 1 }\nstep() { print "step: $1" }\n${step}`],
        { cwd: join(dir, 'repo'), encoding: 'utf8', env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin` } })
      return { code: r.status, err: r.stderr, calls: readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') }
    }
    const ok = run(0)
    assert.equal(ok.code, 0, ok.err)
    const freshness = ['repo git diff --quiet HEAD -- plugin/lib', 'repo git ls-files --others --exclude-standard -- plugin/lib']
    assert.deepEqual(ok.calls, ['repo npm run build', ...freshness, 'plugin node --test tests/a.test.mjs'],
      'the root build, the committed build compared with it, then the tests')
    const stale = run(0, 1)
    assert.equal(stale.code, 1)
    assert.match(stale.err, /FAILED: plugin\/lib differs from the committed build: commit it \(npm run build && git add plugin\/lib\)/)
    assert.deepEqual(stale.calls, ['repo npm run build', freshness[0]], 'no tests on a stale plugin/lib')
    const failed = run(1)
    assert.equal(failed.code, 1)
    assert.match(failed.err, /FAILED: plugin build \(npm run build: the host tsc, then the plugin page\)/)
    assert.deepEqual(failed.calls, ['repo npm run build'], 'no tests on a failed build')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the foot of the page says how to update the plugin and that adding one needs the pnpm on dsh\'s PATH', () => {
  assert.match(zh['hint.pluginUpdate'], /移除本插件，再添加新版本的包[^]*npm i -g pnpm[^]*退出码 127[^]*桌面版自带 pnpm/)
  assert.match(en['hint.pluginUpdate'], /remove it[^]*add the new package[^]*npm i -g pnpm[^]*exit code 127[^]*desktop app brings its own pnpm/)
  assert.equal(view({}).pluginUpdateHint, zh['hint.pluginUpdate'])
  assert.ok(texts(renderPage().tree).includes(zh['hint.pluginUpdate']), 'before the first status too')
  const readme = readFileSync(join(ROOT, 'docs/DESIGN.md'), 'utf8')
  assert.match(readme, /Adding a plugin needs pnpm[^]*`npm i -g pnpm`[^]*exit code 127/)
})

// --- the 模式检查 section (api/cu-runtime.modeCheck, modeCheckRefresh) ---

const { buildModeCheckView, readModeCheck } = compiled('./view.js')
const tEn = translator({ ...en, ...compiled('./settings/locale/index.js').en })
const CHECKED_AT = '2026-10-21T12:00:00.000Z'
/** A route's answer: `{ ok: true, result }`. */
const modeAnswer = (profiles) => ({ ok: true, result: { checked_at: CHECKED_AT, ok: profiles.every((p) => p.status === 'ok'), profiles } })
const OK_LINE = 'the cu-runtime bundle, cu_* tools in its own mode only (onlyCuTools, dialog, exclusive)'
const FAILING = [
  { profile: 'web', status: 'ok', lines: [OK_LINE] },
  { profile: 'cli', status: 'fail', lines: ['onlyCuTools is not on in its mode', 'exclusive is switched off in its mode'] },
  { profile: 'old', status: 'fail', lines: ['loads a computer-use plugin'] },
  { profile: 'other', status: 'skipped', lines: ['not checked: the runner broke'] },
]

test('mode check view: ok, n problems with the failing lines, unchecked (none yet, or a profile skipped), in zh and en', () => {
  for (const [tr, dict] of [[t, zh], [tEn, en]]) {
    const ok = buildModeCheckView(readModeCheck(modeAnswer([FAILING[0]])), { t: tr })
    assert.deepEqual({ ...ok, refresh: { ...ok.refresh }, lines: [...ok.lines] }, {
      title: dict['section.modeCheck'], about: dict['modeCheck.about'], state: 'done', text: dict['modeCheck.ok'], lines: [],
      checkedAt: tr('modeCheck.checkedAt', { at: CHECKED_AT }), refresh: { label: dict['action.modeCheckRefresh'], enabled: true },
      error: null,
    })
    const bad = buildModeCheckView(readModeCheck(modeAnswer(FAILING)), { t: tr })
    assert.equal(bad.state, 'error')
    assert.equal(bad.text, tr('modeCheck.problems', { n: 3 }))
    assert.deepEqual([...bad.lines], ['cli: onlyCuTools is not on in its mode', 'cli: exclusive is switched off in its mode',
      'old: loads a computer-use plugin'], 'the failing profiles\' lines, not the ok or skipped ones')
    const skipped = buildModeCheckView(readModeCheck(modeAnswer([FAILING[0], FAILING[3]])), { t: tr })
    assert.deepEqual([skipped.state, skipped.text, [...skipped.lines]], ['idle', dict['modeCheck.unchecked'],
      ['other: not checked: the runner broke']])
    const none = buildModeCheckView(null, { t: tr })
    assert.deepEqual([none.state, none.text, none.checkedAt, none.lines.length], ['idle', dict['modeCheck.unchecked'], null, 0])
    // A home with no profile: the host's one skipped entry (profile ''), its line alone; never 正常.
    const noProfiles = buildModeCheckView(readModeCheck(modeAnswer([{ profile: '', status: 'skipped',
      lines: ['not checked: no profiles under the dsh home'] }])), { t: tr })
    assert.deepEqual([noProfiles.state, noProfiles.text, [...noProfiles.lines]], ['idle', dict['modeCheck.unchecked'],
      ['not checked: no profiles under the dsh home']])
    for (const result of [{ checked_at: CHECKED_AT, ok: true, profiles: [] }, { checked_at: CHECKED_AT, ok: false, profiles: [FAILING[0]] }]) {
      const odd = buildModeCheckView(readModeCheck({ ok: true, result }), { t: tr })
      assert.deepEqual([odd.state, odd.text, odd.lines.length], ['idle', dict['modeCheck.unchecked'], 0],
        'no profile, or a result that is not ok without a failing line: unchecked')
    }
    const checking = buildModeCheckView(null, { t: tr, pending: true })
    assert.deepEqual([checking.state, checking.text, checking.refresh.enabled], ['ongoing', dict['modeCheck.checking'], false])
    const failed = buildModeCheckView(null, { t: tr, error: { code: 'internal', message: 'listing broke' } })
    assert.equal(failed.error.text, dict['error.internal'])
  }
  assert.equal(zh['modeCheck.problems'].replace('{n}', '3'), '3 项问题')
  assert.equal(zh['modeCheck.ok'], '正常')
  assert.equal(zh['modeCheck.unchecked'], '未检查')
  assert.equal(zh['action.modeCheckRefresh'], '重新检查')
  assert.equal(zh['section.modeCheck'], '模式检查')
  assert.equal(en['section.modeCheck'], 'Mode check')
  assert.throws(() => readModeCheck({ ok: true }), (e) => e.code === 'bad_response')
  assert.throws(() => readModeCheck({ ok: true, result: { checked_at: CHECKED_AT, ok: true,
    profiles: [{ profile: 'x', status: 'odd', lines: [] }] } }), (e) => e.code === 'bad_response')
})

/**
 * The daemon tab with its 模式检查 section drawn: the section is an element of its own (its hooks are its own), called
 * here as React would after the page's; `section` is [result, pending, error, round].
 */
function renderModeCheck({ section = [], primitives = {}, answer = modeAnswer(FAILING) } = {}) {
  const react = fakeReact(['daemon', null, null, null, null, null, 0, ...section])
  const fetched = []
  const { exports } = load({ react, primitives, globals: {
    fetch: async (url, init) => {
      fetched.push({ url, init })
      return { ok: true, status: 200, statusText: 'OK', json: async () => answer }
    },
  } })
  const ctx = fakeContext()
  exports.apply(ctx)
  const page = daemonTab(ctx.seen.entries[0].component({ view: 'page', t }))
  const [element] = find(page, (e) => typeof e.type === 'function' && e.props?.t === t && e.type !== primitives.Button)
  assert.ok(element !== undefined, 'the page draws the section')
  return { tree: element.type(element.props), react, fetched }
}

test('the mode check section: read once when the tab is shown (modeCheck), again on 重新检查 (modeCheckRefresh), not polled', async () => {
  const shown = renderModeCheck()
  assert.equal(shown.react.effects.length, 2, 'the page\'s poll and the section\'s one read')
  shown.react.effects[1]()
  for (let i = 0; i < 5; i++) await tick()
  assert.deepEqual(shown.fetched.map(({ url, init }) => [url, { ...init }]), [['api/cu-runtime.modeCheck', { method: 'POST' }]])
  const result = shown.react.setters[7].at(-1)
  assert.equal(result.checkedAt, CHECKED_AT)
  assert.deepEqual(shown.react.setters[8], [true, false], 'pending while it reads')
  // 重新检查 bumps the section's round; its read is then modeCheckRefresh.
  const [again] = find(shown.tree, (e) => e.type === 'button' && texts(e).includes(zh['action.modeCheckRefresh']))
  assert.equal(again.props.style.border, '1px solid var(--dsw-alias-border-l2)')
  again.props.onClick()
  assert.equal(typeof shown.react.setters[10][0], 'function')
  assert.equal(shown.react.setters[10][0](0), 1)
  const refreshed = renderModeCheck({ section: [readModeCheck(modeAnswer(FAILING)), false, null, 1] })
  refreshed.react.effects[1]()
  for (let i = 0; i < 5; i++) await tick()
  assert.deepEqual(refreshed.fetched.map(({ url }) => url), ['api/cu-runtime.modeCheckRefresh'])
})

test('the mode check section draws the state line, the failing lines in a scrolling list, the time and the button', () => {
  const { tree } = renderModeCheck({ section: [readModeCheck(modeAnswer(FAILING)), false, null, 0] })
  const shown = texts(tree)
  assert.ok(shown.includes(zh['section.modeCheck']))
  assert.ok(shown.includes('3 项问题'))
  assert.ok(shown.includes(t('modeCheck.checkedAt', { at: CHECKED_AT })))
  const [list] = find(tree, (e) => e.type === 'ul')
  assert.deepEqual(texts(list), ['cli: onlyCuTools is not on in its mode', 'cli: exclusive is switched off in its mode',
    'old: loads a computer-use plugin'])
  assert.ok(list.props.style.maxHeight > 0 && list.props.style.overflow === 'auto', 'limited height, scrolls')
  const okTree = renderModeCheck({ section: [readModeCheck(modeAnswer([FAILING[0]])), false, null, 0] }).tree
  assert.ok(texts(okTree).includes('正常'))
  assert.equal(find(okTree, (e) => e.type === 'ul').length, 0, 'no list when nothing fails')
  assert.ok(texts(renderModeCheck({ section: [null, false, null, 0] }).tree).includes('未检查'))
  // With dsh's Button: outline, small, the page's 1px border.
  const Button = (props) => props
  const drawn = renderModeCheck({ section: [null, false, null, 0], primitives: { Button } }).tree
  const [b] = find(drawn, (e) => e.type === Button)
  assert.deepEqual([b.props.variant, b.props.size, b.props.style.border], ['outline', 'sm', '1px solid var(--dsw-alias-border-l2)'])
})
