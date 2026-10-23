// The plugin page's tab shell and the settings tabs' shared model (plugin/src/client/settings):
// the tab bar with the daemon tab as it was and the default, the settings model (when and how often the snapshot is
// read, the routes and their headers), the pending banner and its cancel, the outcome notices and the answers, every
// error code's text, the locale files, the shared pieces and their fallbacks. The bundle is built into a temporary
// directory (removed afterwards) and run as dsh runs it, with a small React stand-in that draws nested components.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { ENTRY, EXTERNALS, ROOT } from '../../scripts/build-client.mjs'

const dir = mkdtempSync(join(tmpdir(), 'cu-settings-shell-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const OUT = join(dir, 'client.js')
execFileSync(process.execPath, [join(ROOT, 'scripts/build-client.mjs'), '--out', OUT, '--cjs', join(dir, 'cjs')],
  { stdio: ['ignore', 'pipe', 'pipe'] })
const SCRIPT = readFileSync(OUT, 'utf8')
const compiled = createRequire(join(dir, 'cjs', ENTRY))
const daemonLocale = compiled('./locale.js')
const settingsLocale = compiled('./settings/locale/index.js')
const model = compiled('./settings/model.js')
const change = compiled('./settings/change.js')
const ZH = { ...daemonLocale.zh, ...settingsLocale.zh }
const EN = { ...daemonLocale.en, ...settingsLocale.en }

/** dsh's translate over one dictionary; a key the dictionary lacks fails the test, and so does a param left unfilled. */
const translator = (dict) => (key, params) => {
  assert.ok(Object.hasOwn(dict, key), `no text for ${key}`)
  const text = params === undefined ? dict[key] : dict[key].replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
  assert.doesNotMatch(text, /\{\w+\}/, `${key} has a param left: ${text}`)
  return text
}
const t = translator(ZH)

/** The test clock's start (Date.now() in the page); snapshot times are epoch seconds relative to it. */
const NOW = 1_760_947_200_000
const SEC = NOW / 1000

/**
 * A snapshot as the host answers it (the daemon's settings.snapshot, the keys the host passes on), with `over`
 * replacing top-level keys.
 */
function snapshot(over = {}) {
  return {
    started_at: SEC - 3600,
    grants: [{
      task_id: 'dsh-a1b2c3d4e5f6', expires_at: SEC + 1800, by_dialog: true, owner_gone: false,
      apps: [{ bundle_id: 'com.apple.TextEdit', name: 'TextEdit', mode: 'full', scope: 'session', expires_at: SEC + 1500 }],
    }],
    persistent: [], denylist: [],
    hard_deny: [{ bundle_id: 'com.apple.systempreferences', name: 'System Settings', category: 'system_ui' }],
    access: { default_mode: 'ask', session_limit_minutes: 30, dialogs_per_turn: 2, dialog_timeout_seconds: 120, dialog_default: 'session' },
    access_choices: { default_mode: ['ask', 'read', 'full'], session_limit_minutes: [15, 30, 60], dialogs_per_turn: [1, 2, 3],
      dialog_timeout_seconds: [60, 120, 180], dialog_default: ['deny', 'turn', 'session', 'always'] },
    chords: { builtin: [{ chord: 'cmd+c', enabled: true }], never: ['cmd+q'], custom: [] },
    privacy: { send_screenshots: true, send_ax_text: true, send_ocr: true, send_zoom: true, text_only_apps: [], clear_clipboard_on_turn_start: false },
    behavior: { restore_focus_on_turn_end: true, allow_point_targets: true, ime_policy_cap: 'takeover', electron_ax_auto: false, activation_method: null },
    logs: { directory: null, directory_custom: false, retention_days: 30, files: 2, bytes: 4096 },
    recent_refusals: [], recent_changes: [],
    permissions: { accessibility: true, screen_recording: true, input_monitoring: null },
    pending: null, last_outcome: null, picked_app: null, import_preview: null, panel: null,
    ...over,
  }
}

// --- the harness ---

/** Every string in a drawn tree. */
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

const sameDeps = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((d, i) => Object.is(d, b[i]))

/**
 * A React stand-in that draws nested function components the way React mounts them: one instance per place in the
 * tree (its path, its component's name and its key), with its own hooks; an instance not drawn again is unmounted
 * (its effects' cleanups run) before the effects of the new draw run. useState takes a value or an updater; useEffect
 * runs after the draw when its deps changed. `drawn` lists each component drawn, with its props, in the last draw.
 */
function miniReact() {
  const instances = new Map()
  const drawn = []
  let current = null
  let queued = []
  const react = {
    drawn,
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const inst = current
      const i = inst.call++
      if (!(i in inst.hooks)) inst.hooks[i] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = inst.hooks[i]
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    },
    useEffect(effect, deps) {
      const inst = current
      const i = inst.call++
      const slot = inst.hooks[i]
      if (slot !== undefined && sameDeps(deps, slot.deps)) return
      queued.push(() => {
        slot?.cleanup?.()
        inst.hooks[i] = { deps, cleanup: effect() }
      })
    },
    useCallback: (callback) => callback,
    render(type, props) {
      drawn.length = 0
      queued = []
      const seen = new Set()
      const tree = expand({ type, props: { ...props, children: [] } }, 'root', seen)
      for (const [id, inst] of instances) {
        if (seen.has(id)) continue
        for (const slot of inst.hooks) slot?.cleanup?.()
        instances.delete(id)
      }
      for (const run of queued) run()
      return tree
    },
    unmount() {
      for (const inst of instances.values()) for (const slot of inst.hooks) slot?.cleanup?.()
      instances.clear()
    },
  }
  function expand(node, path, seen) {
    if (node === null || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map((n, i) => expand(n, `${path}[${n?.props?.key ?? i}]`, seen))
    if (typeof node.type === 'function') {
      const id = `${path}<${node.type.name}${node.props.key == null ? '' : `#${node.props.key}`}>`
      let inst = instances.get(id)
      if (inst === undefined) instances.set(id, (inst = { hooks: [] }))
      seen.add(id)
      const outer = current
      current = inst
      inst.call = 0
      drawn.push({ name: node.type.name, props: node.props })
      const out = node.type(node.props)
      current = outer
      return expand(out, id, seen)
    }
    const tag = typeof node.type === 'string' ? node.type : 'x'
    return { ...node, props: { ...node.props, children: expand(node.props.children, `${path}/${tag}`, seen) } }
  }
  return react
}

/** Run the script as dsh's loader does, its require giving only EXTERNALS (anything else fails the test). */
function load({ react, primitives = {}, globals = {} }) {
  const registrations = []
  const sandbox = { window: { __ModuleLoader__: { load: (r) => registrations.push(r) } }, ...globals }
  vm.runInNewContext(SCRIPT, sandbox, { filename: 'client.js' })
  assert.equal(registrations.length, 1)
  const exports = registrations[0].factory((spec) => {
    assert.ok(EXTERNALS.includes(spec), `the bundle required ${spec}`)
    return spec === 'react' ? react : spec === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : {}
  })
  return { exports, sandbox }
}

/** A fake client context recording what apply registers. */
function fakeContext() {
  const seen = { locales: [], entries: [] }
  return {
    seen,
    effect: (setup) => { setup() },
    locale: { register: (ns, dicts) => { seen.locales.push({ ns, dicts }); return () => {} } },
    slots: {
      inject: (name, setup) => { setup() },
      register: (entry, component) => { seen.entries.push({ entry, component }); return () => {} },
    },
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

/** An answer: the request does not get through. */
const UNREACHABLE = Symbol('unreachable')
const answer = (body, status = 200) => ({ status, body })
const ok = (key, value) => answer({ ok: true, [key]: value })
const refused = (code, message = '', data) => answer({ ok: false, error: { code, message, ...(data === undefined ? {} : { data }) } })
const STATUS_TEXT = { 200: 'OK', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 500: 'Internal Server Error' }

/**
 * The plugin page mounted with fetch answering each route (the path after `api/cu-runtime.`) from `answers[route]`:
 * `{ status, body }`, UNREACHABLE, or a function of the request's init returning one (or a promise of one). Every request is recorded with
 * its init. Timers wait for fire(); Date.now() is the test clock.
 */
function mountShell(answers, { primitives = {}, view = 'page', dict = ZH } = {}) {
  const react = miniReact()
  const requests = []
  const timers = new Map()
  let nextTimer = 1
  const clock = { now: NOW }
  class ClockDate extends Date {
    static now() { return clock.now }
  }
  const { exports, sandbox } = load({ react, primitives, globals: {
    AbortController,
    Date: ClockDate,
    fetch: async (url, init) => {
      const route = url.replace(/^api\/cu-runtime\./, '')
      requests.push({ route, init })
      let a = answers[route]
      while (typeof a === 'function' || typeof a?.then === 'function') a = typeof a === 'function' ? a(init) : await a
      assert.ok(a !== undefined, `no answer for ${url}`)
      if (a === UNREACHABLE) throw vm.runInContext('new TypeError("Failed to fetch")', sandbox)
      return { ok: a.status >= 200 && a.status < 300, status: a.status, statusText: STATUS_TEXT[a.status] ?? '',
        json: async () => {
          if (a.body === undefined) throw new SyntaxError('Unexpected end of JSON input')
          return a.body
        } }
    },
    setTimeout: (fn, ms) => {
      timers.set(nextTimer, { fn, ms })
      return nextTimer++
    },
    clearTimeout: (id) => { timers.delete(id) },
  } })
  const ctx = fakeContext()
  exports.apply(ctx)
  const Shell = ctx.seen.entries[0].component
  const tr = translator(dict)
  const page = {
    react, requests, timers, clock, ctx,
    routes: () => requests.map((r) => r.route),
    tree: null,
    draw: () => (page.tree = react.render(Shell, { view, t: tr })),
    async settle() {
      for (let i = 0; i < 10; i++) await tick()
      return page.draw()
    },
    /** The pending timers' delays. */
    delays: () => [...timers.values()].map((x) => x.ms),
    /** Moves the clock by the one pending timer, runs it, and settles twice (the read, then its redraw). */
    async fire() {
      assert.equal(timers.size, 1, 'one poll timer pending')
      const [[id, { fn, ms }]] = timers
      timers.delete(id)
      clock.now += ms
      fn()
      await page.settle()
      return page.settle()
    },
    buttons: (text) => find(page.tree, (e) => e.type === 'button' && e.props.role !== 'tab' && texts(e).includes(text)),
    async click(text) {
      const buttons = page.buttons(text)
      assert.equal(buttons.length, 1, `one button ${text}`)
      assert.equal(buttons[0].props.disabled, false, `${text} is enabled`)
      buttons[0].props.onClick()
      await page.settle()
      return page.settle()
    },
    /** Shows a tab by its label, as a click on the tab bar does. */
    async tab(label) {
      const tabs = find(page.tree, (e) => e.props?.role === 'tab' && texts(e).includes(label))
      assert.equal(tabs.length, 1, `one tab ${label}`)
      tabs[0].props.onClick()
      page.draw()
      await page.settle()
      return page.settle()
    },
    shown: () => texts(page.tree),
    alerts: () => find(page.tree, (e) => e.props?.role === 'alert'),
    /** The props the shown settings tab was drawn with. */
    tabProps: () => react.drawn.find((d) => d.name === 'TabHost')?.props.props,
    unmount: () => react.unmount(),
  }
  page.draw()
  return page
}

/** The host cannot be reached: the daemon tab's status read and its 模式检查 section's read both fail. */
const STATUS_DOWN = { status: UNREACHABLE, modeCheck: UNREACHABLE }

// --- the tab shell ---

test('the daemon tab is the default and unchanged; the bar lists the daemon tab and the 7 settings tabs in the native order', async () => {
  const page = mountShell({ ...STATUS_DOWN, 'settings.snapshot': ok('snapshot', snapshot()) })
  await page.settle()
  const tabs = find(page.tree, (e) => e.props?.role === 'tab')
  assert.deepEqual(tabs.map(texts).map((x) => x.join('')), ['守护进程', '概览', '档位与默认', '应用名单', '快捷键', '隐私与审计', '行为与模型', '日志'])
  assert.deepEqual(tabs.map((e) => e.props['aria-selected']), [true, false, false, false, false, false, false, false])
  assert.deepEqual(tabs.map((e) => e.props.id), model.PAGE_TABS.map((id) => `cu-runtime-tab-${id}`))
  const [panel] = find(page.tree, (e) => e.props?.role === 'tabpanel')
  assert.equal(panel.props['data-cu-runtime-tab-panel'], 'daemon')
  assert.equal(panel.props.id, 'cu-runtime-panel-daemon')
  assert.equal(panel.props['aria-labelledby'], 'cu-runtime-tab-daemon')
  // The daemon page (page.ts) itself, with the very props dsh gave the shell.
  const daemon = page.react.drawn.filter((d) => d.name === 'Page')
  assert.equal(daemon.length, 1)
  assert.deepEqual(Object.keys(daemon[0].props).sort(), ['children', 't', 'view'])
  assert.equal(daemon[0].props.view, 'page')
  assert.ok(find(panel, (e) => e.props?.['data-cu-runtime-page'] === '').length === 1)
  assert.ok(page.shown().includes(ZH['error.network']), 'the daemon page shows its own status failure')
  assert.deepEqual(page.routes(), ['status', 'modeCheck'], 'the settings are not read while the daemon tab is shown')
  assert.ok(!page.react.drawn.some((d) => d.name === 'SettingsPage'))
  page.unmount()
})

test('dsh\'s summary view gets the daemon page alone, without the tab bar', () => {
  const page = mountShell(STATUS_DOWN, { view: 'summary' })
  assert.equal(find(page.tree, (e) => e.props?.role === 'tablist').length, 0)
  assert.deepEqual(page.react.drawn.map((d) => d.name), ['PluginPage', 'Page'])
  page.unmount()
})

test('the tab bar is dsh\'s SegmentedTabs when present, its items tied to the panel', async () => {
  const seen = []
  const SegmentedTabs = (props) => { seen.push(props); return { type: 'x-tabs', props: { children: [] } } }
  const page = mountShell(STATUS_DOWN, { primitives: { SegmentedTabs } })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].value, 'daemon')
  assert.equal(seen[0].label, ZH['settings.tabs.label'])
  assert.deepEqual([...seen[0].items].map((i) => [i.value, i.label, i.id, i.panelId]),
    model.PAGE_TABS.map((id) => [id, ZH[`settings.tab.${id}`], `cu-runtime-tab-${id}`, `cu-runtime-panel-${id}`]))
  seen[0].onChange('logs')
  page.draw()
  await page.settle()
  assert.equal(seen.at(-1).value, 'logs')
  assert.equal(find(page.tree, (e) => e.props?.role === 'tabpanel')[0].props['data-cu-runtime-tab-panel'], 'logs')
  page.unmount()
})

test('switching tabs: the settings are read only while a settings tab is shown, the daemon status only while its tab is', async () => {
  const page = mountShell({ ...STATUS_DOWN, 'settings.snapshot': ok('snapshot', snapshot()) })
  await page.settle()
  assert.deepEqual(page.routes(), ['status', 'modeCheck'])
  assert.deepEqual(page.delays(), [10_000], 'the daemon tab\'s poll (the mode check is read once, not polled)')

  await page.tab('概览')
  assert.deepEqual(page.routes(), ['status', 'modeCheck', 'settings.snapshot'], 'read at once')
  assert.deepEqual(page.delays(), [10_000], 'the daemon poll stopped; the settings poll waits 10 s')
  const [read] = page.requests.filter((r) => r.route === 'settings.snapshot')
  assert.deepEqual(Object.keys(read.init).sort(), ['method', 'signal'])
  assert.equal(read.init.method, 'POST')
  assert.ok(page.shown().includes(ZH['settings.overview.title']))
  const [panel] = find(page.tree, (e) => e.props?.role === 'tabpanel')
  assert.equal(panel.props['data-cu-runtime-tab-panel'], 'overview')

  // Another settings tab: the same model, no new read; its own panel.
  const shownPanel = () => find(page.tree, (e) => e.props?.role === 'tabpanel')[0].props['data-cu-runtime-tab-panel']
  await page.tab('档位与默认')
  assert.deepEqual(page.routes(), ['status', 'modeCheck', 'settings.snapshot'])
  assert.equal(shownPanel(), 'access')
  for (const [label, id] of [['应用名单', 'apps'], ['快捷键', 'shortcuts'], ['隐私与审计', 'privacy'], ['行为与模型', 'behavior'], ['日志', 'logs']]) {
    await page.tab(label)
    assert.equal(shownPanel(), id, id)
  }
  await page.fire()
  assert.deepEqual(page.routes(), ['status', 'modeCheck', 'settings.snapshot', 'settings.snapshot'], 'every 10 s')

  // Back to the daemon tab: the settings poll is gone (timer cleared, read aborted), the status read at once, and the
  // mode check once more (the tab is shown again).
  await page.tab('守护进程')
  assert.deepEqual(page.routes(), ['status', 'modeCheck', 'settings.snapshot', 'settings.snapshot', 'status', 'modeCheck'])
  assert.ok(page.requests.filter((r) => r.route === 'settings.snapshot').every((r) => r.init.signal.aborted))
  assert.deepEqual(page.delays(), [10_000])
  await page.fire()
  assert.deepEqual(page.routes().filter((r) => r === 'settings.snapshot').length, 2, 'no settings read after it left')
  page.unmount()
})

test('the snapshot is read every second while a change waits or a panel is open, every 10 s otherwise', async () => {
  let next = snapshot()
  const page = mountShell({ ...STATUS_DOWN, 'settings.snapshot': () => ok('snapshot', next) })
  await page.settle()
  await page.tab('概览')
  assert.deepEqual(page.delays(), [10_000])
  next = snapshot({ panel: 'choose_app' })
  await page.fire()
  assert.deepEqual(page.delays(), [1000], 'a panel is open on the Mac')
  next = snapshot({ pending: { kind: 'revoke_all' } })
  await page.fire()
  assert.deepEqual(page.delays(), [1000], 'a change waits for the owner check')
  next = snapshot()
  await page.fire()
  assert.deepEqual(page.delays(), [10_000])
  assert.equal(model.SETTINGS_ACTIVE_POLL_MS, 1000)
  assert.equal(model.SETTINGS_IDLE_POLL_MS, 10_000)
  page.unmount()
})

test('apply posts settings.apply with both headers and exactly {change}, then the snapshot is read again at once', async () => {
  const applied = []
  const page = mountShell({
    ...STATUS_DOWN,
    'settings.snapshot': ok('snapshot', snapshot()),
    'settings.apply': (init) => { applied.push(init); return ok('result', { status: 'applied' }) },
  })
  await page.settle()
  await page.tab('概览')
  await page.click(ZH['settings.overview.revoke'])
  assert.deepEqual(page.routes(), ['status', 'modeCheck', 'settings.snapshot', 'settings.apply', 'settings.snapshot'])
  assert.equal(applied.length, 1)
  const [init] = applied
  assert.deepEqual(Object.keys(init).sort(), ['body', 'headers', 'method'])
  assert.equal(init.method, 'POST')
  assert.deepEqual({ ...init.headers }, { 'content-type': 'application/json', 'x-cu-runtime-page': '1' })
  const body = JSON.parse(init.body)
  assert.deepEqual(Object.keys(body), ['change'])
  assert.deepEqual(body, { change: { kind: 'revoke', task_id: 'dsh-a1b2c3d4e5f6' } })
  assert.ok(page.shown().includes('撤销授权：已生效。'))
  assert.deepEqual(page.delays(), [10_000], 'one poll, restarted')

  await page.click(ZH['settings.overview.revokeAll'])
  assert.deepEqual(JSON.parse(applied[1].body), { change: { kind: 'revoke_all' } })
  assert.deepEqual(page.routes().slice(-2), ['settings.apply', 'settings.snapshot'])
  page.unmount()
})

test('an action posts settings.action.<name> with no body; its answer is shown and the snapshot read again', async () => {
  let result = { status: 'open' }
  const page = mountShell({
    ...STATUS_DOWN,
    'settings.snapshot': ok('snapshot', snapshot()),
    'settings.action.choose_app': () => ok('result', result),
    'settings.action.export_audit': ok('result', { status: 'busy', panel: 'export_settings' }),
  })
  await page.settle()
  await page.tab('概览')
  const props = page.tabProps()
  assert.equal(typeof props.action, 'function')
  assert.equal(await props.action('choose_app'), true)
  await page.settle()
  await page.settle()
  const sent = page.requests.find((r) => r.route === 'settings.action.choose_app')
  assert.deepEqual({ ...sent.init }, { method: 'POST' })
  assert.deepEqual(page.routes().slice(-2), ['settings.action.choose_app', 'settings.snapshot'])
  assert.ok(page.shown().includes('选择应用：已在本机打开面板，请在本机屏幕上完成。'))

  assert.equal(await page.tabProps().action('export_audit'), true)
  await page.settle()
  assert.ok(page.shown().includes('本机已有一个面板（导出设置）正在打开，请先完成或关闭它。此次操作未执行。'))
  assert.ok(!page.shown().includes('选择应用：已在本机打开面板，请在本机屏幕上完成。'), 'one answer at a time')
  result = { status: 'done' }
  await page.tabProps().action('choose_app')
  await page.settle()
  assert.ok(page.shown().includes('选择应用：已完成。'))
  assert.deepEqual([...change.SETTINGS_ACTIONS], ['choose_log_directory', 'use_default_log_directory', 'choose_app',
    'export_settings', 'export_audit', 'import', 'import_confirm', 'reveal_log'])
  page.unmount()
})

test('a change waiting for the owner check: the banner says what, asks for Touch ID or the password, 取消 posts cancelVerify; every change control is held', async () => {
  let next = snapshot({ pending: { kind: 'access.set', field: 'default_mode', value: 'full' } })
  const page = mountShell({
    ...STATUS_DOWN,
    'settings.snapshot': () => ok('snapshot', next),
    'settings.cancelVerify': () => {
      next = snapshot({ last_outcome: { at: SEC + 2, kind: 'access.set', outcome: 'cancelled' } })
      return ok('result', { status: 'cancelled', summary: { kind: 'access.set' } })
    },
  })
  await page.settle()
  await page.tab('概览')
  const [banner] = find(page.tree, (e) => e.props?.['data-cu-runtime-pending'] !== undefined)
  assert.ok(banner !== undefined)
  assert.equal(banner.props['data-cu-runtime-pending'], 'access.set')
  assert.deepEqual(texts(banner), ['等待本机验证：将「默认档位」改为可操作', ZH['settings.pending.verify'], ZH['settings.pending.locked'], '取消'])
  assert.match(ZH['settings.pending.verify'], /请在本机完成 Touch ID 或输入登录密码/)
  for (const label of [ZH['settings.overview.revoke'], ZH['settings.overview.revokeAll']]) {
    const [b] = page.buttons(label)
    assert.equal(b.props.disabled, true, `${label} is held`)
  }
  assert.equal(page.tabProps().pending, true)
  assert.deepEqual(page.delays(), [1000])
  // The banner is on every settings tab.
  await page.tab('日志')
  assert.equal(find(page.tree, (e) => e.props?.['data-cu-runtime-pending'] !== undefined).length, 1)

  await page.click('取消')
  const sent = page.requests.find((r) => r.route === 'settings.cancelVerify')
  assert.deepEqual({ ...sent.init }, { method: 'POST' })
  assert.deepEqual(page.routes().slice(-2), ['settings.cancelVerify', 'settings.snapshot'])
  assert.equal(find(page.tree, (e) => e.props?.['data-cu-runtime-pending'] !== undefined).length, 0)
  assert.ok(page.shown().includes('档位与默认的更改：已取消，没有改动。'))
  assert.equal(page.tabProps().pending, false)
  await page.tab('概览')
  assert.equal(page.buttons(ZH['settings.overview.revoke'])[0].props.disabled, false)
  page.unmount()
})

test('the pending flag also holds while no snapshot is there and while a request is in flight', async () => {
  let release
  const page = mountShell({
    ...STATUS_DOWN,
    'settings.snapshot': ok('snapshot', snapshot()),
    'settings.apply': () => new Promise((resolve) => { release = resolve }).then(() => ok('result', { status: 'applied' })),
  })
  await page.settle()
  const shown = find(page.tree, (e) => e.props?.role === 'tab' && texts(e).includes('概览'))
  shown[0].props.onClick()
  page.draw()
  assert.equal(page.tabProps().snapshot, null)
  assert.equal(page.tabProps().pending, true, 'before the first snapshot')
  assert.ok(page.shown().includes(ZH['settings.loading']))
  await page.settle()
  assert.equal(page.tabProps().pending, false)
  page.buttons(ZH['settings.overview.revoke'])[0].props.onClick()
  page.draw()
  assert.equal(page.tabProps().pending, true, 'while the apply is in flight')
  assert.equal(page.buttons(ZH['settings.overview.revoke'])[0].props.disabled, true)
  release()
  await page.settle()
  await page.settle()
  assert.equal(page.tabProps().pending, false)
  page.unmount()
})

test('after a request every change control stays held until a snapshot read after it has come back', async () => {
  let release
  let reads = 0
  const page = mountShell({
    ...STATUS_DOWN,
    'settings.snapshot': () => {
      reads += 1
      return reads === 1 ? ok('snapshot', snapshot()) : new Promise((resolve) => { release = () => resolve(ok('snapshot', snapshot())) })
    },
    'settings.apply': ok('result', { status: 'applied' }),
  })
  await page.settle()
  await page.tab('概览')
  assert.equal(page.tabProps().pending, false)
  await page.click(ZH['settings.overview.revoke'])
  assert.equal(reads, 2, 'the read after the request has started')
  assert.equal(page.tabProps().pending, true, 'the answer is in, the read after it is not')
  assert.equal(page.buttons(ZH['settings.overview.revoke'])[0].props.disabled, true)
  release()
  await page.settle()
  await page.settle()
  assert.equal(page.tabProps().pending, false)
  page.unmount()
})

test('last_outcome is shown once: only one settled while the page is open, until dismissed or replaced', async () => {
  let next = snapshot({ last_outcome: { at: SEC - 600, kind: 'reset', outcome: 'applied' } })
  const page = mountShell({ ...STATUS_DOWN, 'settings.snapshot': () => ok('snapshot', next) })
  await page.settle()
  await page.tab('概览')
  assert.equal(find(page.tree, (e) => e.props?.['data-cu-runtime-outcome'] !== undefined).length, 0, 'older than the page')
  next = snapshot({ last_outcome: { at: SEC + 9, kind: 'privacy.set', outcome: 'verify_failed' } })
  await page.fire()
  assert.ok(page.shown().includes('发送内容的更改：没有通过验证，没有改动。'))
  await page.click(ZH['settings.notice.dismiss'])
  assert.equal(find(page.tree, (e) => e.props?.['data-cu-runtime-outcome'] !== undefined).length, 0, 'dismissed')
  await page.fire()
  assert.equal(find(page.tree, (e) => e.props?.['data-cu-runtime-outcome'] !== undefined).length, 0, 'not shown again')
  next = snapshot({ last_outcome: { at: SEC + 30, kind: 'deny.add', outcome: 'refused', reason: 'hard_denied' } })
  await page.fire()
  assert.ok(page.shown().includes(`加入黑名单：未完成。${ZH['settings.error.hard_denied']}`))
  page.unmount()
})

test('outcomeNotice: every outcome has its text; refused with a reason the page does not know shows the reason', () => {
  const since = NOW
  const cases = [
    ['applied', '撤销全部授权：已生效。', 'done'], ['done', '撤销全部授权：已完成。', 'done'],
    ['verify_failed', '撤销全部授权：没有通过验证，没有改动。', 'warning'],
    ['verify_cancelled', '撤销全部授权：验证已取消，没有改动。', 'warning'],
    ['verify_unavailable', '撤销全部授权：本机当前无法进行身份验证，没有改动。', 'warning'],
    ['cancelled', '撤销全部授权：已取消，没有改动。', 'warning'],
  ]
  for (const [outcome, text, state] of cases) {
    const n = model.outcomeNotice(t, { at: SEC, kind: 'revoke_all', outcome }, since, null)
    assert.deepEqual({ text: n.text, state: n.state }, { text, state }, outcome)
  }
  assert.deepEqual([...model.OUTCOMES].sort(), cases.map(([o]) => o).concat('refused').sort())
  assert.equal(model.outcomeNotice(t, { at: SEC, kind: 'import', outcome: 'refused', reason: 'invalid_file' }, since, null).text,
    '导入设置：未完成。原因：invalid_file。')
  assert.equal(model.outcomeNotice(t, { at: SEC, kind: 'export_settings', outcome: 'refused', reason: 'settings_changed' }, since, null).text,
    `导出设置：未完成。${ZH['settings.error.settings_changed']}`)
  assert.equal(model.outcomeNotice(t, { at: SEC, kind: 'mystery', outcome: 'odd' }, since, null).text, '操作「mystery」：odd。')
  const n = model.outcomeNotice(t, { at: SEC, kind: 'reset', outcome: 'applied' }, since, null)
  assert.equal(model.outcomeNotice(t, { at: SEC, kind: 'reset', outcome: 'applied' }, since, n.key), null)
  assert.equal(model.outcomeNotice(t, null, since, null), null)
})

// --- errors ---

test('every settings error code has its own text in Chinese and English; verify_cooldown counts the seconds to data.until', () => {
  const KNOWN_REASONS = ['verification_required', 'verify_busy', 'verify_cooldown', 'verify_unavailable', 'verify_failed',
    'verify_cancelled', 'approval_open', 'settings_unavailable', 'nothing_pending', 'settings_changed', 'not_found',
    'app_not_grantable', 'app_not_found', 'hard_denied', 'user_denied', 'invalid_chord', 'chord_never_allowed',
    'chord_builtin', 'log_directory_missing', 'invalid_params']
  assert.deepEqual([...model.SETTINGS_ERROR_CODES],
    ['bad_request', 'busy', 'not_running', 'internal', 'daemon_error', ...KNOWN_REASONS, 'unauthorized', 'network', 'bad_response'])
  const texts = new Set()
  for (const code of model.SETTINGS_ERROR_CODES) {
    for (const dict of [ZH, EN]) assert.ok(Object.hasOwn(dict, `settings.error.${code}`), `${code}`)
    const shown = model.settingsErrorMessage(t, { code, message: '', data: { until: SEC + 42.2 } }, NOW)
    assert.equal(shown.detail, null)
    assert.equal(shown.toDaemon, code === 'not_running', code)
    if (code === 'verify_cooldown') assert.equal(shown.text, '验证失败次数过多，请在 43 秒后重试。此次更改未生效。')
    else assert.equal(shown.text, ZH[`settings.error.${code}`], code)
    texts.add(shown.text)
  }
  assert.equal(texts.size, model.SETTINGS_ERROR_CODES.length, 'no two codes share a text')
  assert.match(ZH['settings.error.not_running'], /「守护进程」标签页/)
  assert.match(EN['settings.error.not_running'], /Daemon tab/)
  const en = translator(EN)
  assert.equal(model.settingsErrorMessage(en, { code: 'verify_cooldown', message: '', data: { until: SEC + 5 } }, NOW).text,
    'Too many failed verifications; try again in 5 s. This change was not made.')
  assert.equal(model.settingsErrorMessage(t, { code: 'verify_cooldown', message: '', data: { until: SEC - 3 } }, NOW).text,
    '验证失败次数过多，请在 1 秒后重试。此次更改未生效。', 'at least a second')
  assert.equal(model.settingsErrorMessage(t, { code: 'verify_cooldown', message: '' }, NOW).text, ZH['settings.error.verify_cooldownUntimed'])
  assert.deepEqual({ ...model.settingsErrorMessage(t, { code: 'http_502', message: ' bad gateway ' }, NOW) },
    { text: '操作失败（http_502）。', detail: '详情：bad gateway', toDaemon: false })
})

test('the routes\' failures by their codes: refused (200), bad_request (400), internal (500), 401/403, unreachable, no result', async () => {
  const cases = [
    [refused('verify_cooldown', 'cooling down', { until: SEC + 42.2 }), 'verify_cooldown', ['验证失败次数过多，请在 43 秒后重试。此次更改未生效。', '详情：cooling down']],
    [answer({ ok: false, error: { code: 'bad_request', message: 'change.kind is unknown' } }, 400), 'bad_request', [ZH['settings.error.bad_request'], '详情：change.kind is unknown']],
    [answer({ ok: false, error: { code: 'internal', message: 'boom' } }, 500), 'internal', [ZH['settings.error.internal'], '详情：boom']],
    [answer({}, 401), 'unauthorized', [ZH['settings.error.unauthorized'], '详情：HTTP 401 Unauthorized']],
    [answer(undefined, 403), 'unauthorized', [ZH['settings.error.unauthorized'], '详情：HTTP 403 Forbidden']],
    [UNREACHABLE, 'network', [ZH['settings.error.network'], '详情：Failed to fetch']],
    [answer({ ok: true }), 'bad_response', [ZH['settings.error.bad_response'], '详情：the settings.apply answer has no result']],
    [ok('result', { summary: {} }), 'bad_response', [ZH['settings.error.bad_response'], '详情：the settings.apply result has no status']],
    [refused('user_denied', 'on the deny list'), 'user_denied', [ZH['settings.error.user_denied'], '详情：on the deny list']],
  ]
  for (const [reply, code, lines] of cases) {
    const page = mountShell({ ...STATUS_DOWN, 'settings.snapshot': ok('snapshot', snapshot()), 'settings.apply': reply })
    await page.settle()
    await page.tab('概览')
    assert.equal(await page.tabProps().apply({ kind: 'revoke_all' }), false, code)
    await page.settle()
    const alerts = page.alerts()
    assert.equal(alerts.length, 1, code)
    assert.equal(alerts[0].props['data-cu-runtime-error'], code)
    assert.deepEqual(texts(alerts[0]), lines, code)
    page.unmount()
  }
})

test('not_running: the snapshot is dropped and the alert points to the daemon tab, which its button shows', async () => {
  let reply = ok('snapshot', snapshot())
  const page = mountShell({ ...STATUS_DOWN, 'settings.snapshot': () => reply })
  await page.settle()
  await page.tab('概览')
  assert.ok(page.tabProps().snapshot !== null)
  reply = refused('not_running', 'the cu-runtime daemon cannot be reached')
  await page.fire()
  assert.equal(page.tabProps().snapshot, null)
  assert.deepEqual(texts(page.alerts()), [ZH['settings.error.not_running'], '详情：the cu-runtime daemon cannot be reached', ZH['settings.toDaemon']])
  assert.ok(!page.shown().includes(ZH['settings.loading']), 'not "reading" while the read failed')
  await page.click(ZH['settings.toDaemon'])
  const [panel] = find(page.tree, (e) => e.props?.role === 'tabpanel')
  assert.equal(panel.props['data-cu-runtime-tab-panel'], 'daemon')
  assert.deepEqual(page.routes().slice(-2), ['status', 'modeCheck'])
  page.unmount()
})

test('a failed read other than not_running or busy keeps the last snapshot; a bad snapshot is bad_response', async () => {
  let reply = ok('snapshot', snapshot())
  const page = mountShell({ ...STATUS_DOWN, 'settings.snapshot': () => reply })
  await page.settle()
  await page.tab('概览')
  reply = UNREACHABLE
  await page.fire()
  assert.ok(page.tabProps().snapshot !== null)
  assert.deepEqual(texts(page.alerts())[0], ZH['settings.error.network'])
  reply = refused('busy', 'the install task is replacing the daemon')
  await page.fire()
  assert.equal(page.tabProps().snapshot, null)
  reply = ok('snapshot', { ...snapshot(), grants: 'none' })
  await page.fire()
  assert.equal(page.alerts()[0].props['data-cu-runtime-error'], 'bad_response')
  assert.match(texts(page.alerts())[1], /grants/)
  page.unmount()
})

test('readSnapshot checks every part the tabs key on, and reads optional entry fields as null', () => {
  const s = model.readSnapshot(snapshot())
  assert.equal(s.grants[0].apps[0].name, 'TextEdit')
  assert.equal(s.permissions.input_monitoring, null)
  const lenient = model.readSnapshot(snapshot({
    grants: [{ task_id: 'x', expires_at: SEC, apps: [{ bundle_id: 'a.b', expires_at: SEC, mode: 'odd', scope: 7 }] }],
    permissions: null, recent_refusals: [{ at: SEC, method: 'observe', reason: 'no_grant' }],
  }))
  assert.deepEqual({ ...lenient.grants[0].apps[0] }, { bundle_id: 'a.b', name: null, mode: null, scope: null, expires_at: SEC })
  assert.equal(lenient.grants[0].by_dialog, false)
  assert.equal(lenient.recent_refusals[0].app, null)
  const broken = [
    [null, 'body'], [{ ...snapshot(), grants: {} }, 'grants'], [{ ...snapshot(), grants: [{ task_id: 1 }] }, 'grants'],
    [{ ...snapshot(), access: [] }, 'access'], [{ ...snapshot(), chords: { builtin: [], never: [] } }, 'chords.custom'],
    [{ ...snapshot(), pending: 'x' }, 'pending'], [{ ...snapshot(), permissions: { accessibility: true } }, 'permissions'],
    [{ ...snapshot(), last_outcome: { kind: 'x' } }, 'last_outcome'], [{ ...snapshot(), panel: 3 }, 'panel'],
    [{ ...snapshot(), recent_refusals: [{ at: 'now' }] }, 'recent_refusals'], [{ ...snapshot(), started_at: null }, 'started_at'],
  ]
  for (const [raw, what] of broken) {
    assert.throws(() => model.readSnapshot(raw), (e) => e.code === 'bad_response' && e.message.includes(what), what)
  }
})

// --- the words ---

test('summaryText puts every change kind the daemon summarizes in words, apps by name and bundle ID', () => {
  const s = model.readSnapshot(snapshot({ denylist: [{ bundle_id: 'com.example.Chat', name: 'Chat', note: '' }] }))
  const cases = [
    [{ kind: 'revoke', task_id: 'dsh-a1b2c3d4e5f6' }, '撤销会话 a1b2c3d4 的授权'],
    [{ kind: 'revoke_all' }, '撤销全部授权'],
    [{ kind: 'persistent.remove', bundle_id: 'com.apple.TextEdit' }, '将「TextEdit」（com.apple.TextEdit）移出始终允许名单'],
    [{ kind: 'persistent.add', bundle_id: 'com.example.unknown', mode: 'full' }, '将「com.example.unknown」以「可操作」加入始终允许名单'],
    [{ kind: 'persistent.mode', bundle_id: 'com.apple.TextEdit', mode: 'read' }, '将始终允许名单中「TextEdit」（com.apple.TextEdit）的档位改为「浏览」'],
    [{ kind: 'persistent.reapprove', bundle_id: 'com.apple.TextEdit' }, '重新批准始终允许名单中的「TextEdit」（com.apple.TextEdit）'],
    [{ kind: 'deny.add', bundle_id: 'com.example.Chat', note: 'x' }, '将「Chat」（com.example.Chat）加入黑名单'],
    [{ kind: 'deny.remove', bundle_id: 'com.example.chat' }, '将「Chat」（com.example.chat）移出黑名单'],
    [{ kind: 'access.set', field: 'session_limit_minutes', value: 60 }, '将「「本次会话」最长」改为60 分钟'],
    [{ kind: 'access.set', field: 'dialogs_per_turn', value: 3 }, '将「每轮最多弹窗」改为3 次'],
    [{ kind: 'access.set', field: 'dialog_timeout_seconds', value: 180 }, '将「弹窗超时」改为180 秒'],
    [{ kind: 'access.set', field: 'dialog_default', value: 'always' }, '将「弹窗默认按钮」改为始终允许'],
    [{ kind: 'chord.disable', chord: 'cmd+a' }, '停用快捷键 cmd+a'],
    [{ kind: 'chord.enable', chord: 'cmd+a' }, '恢复快捷键 cmd+a'],
    [{ kind: 'chord.add', chord: 'cmd+k', app: null, note: '' }, '允许在所有已授权应用中使用快捷键 cmd+k'],
    [{ kind: 'chord.add', chord: 'cmd+k', app: 'com.apple.TextEdit', note: '' }, '允许在「TextEdit」（com.apple.TextEdit）中使用快捷键 cmd+k'],
    [{ kind: 'chord.remove', chord: 'cmd+k', app: null }, '删除所有已授权应用的快捷键 cmd+k'],
    [{ kind: 'privacy.set', field: 'send_ax_text', on: true }, '恢复发送「界面文本」'],
    [{ kind: 'privacy.set', field: 'send_zoom', on: false }, '停止发送「局部放大图」'],
    [{ kind: 'text_only.add', bundle_id: 'com.apple.TextEdit' }, '将「TextEdit」（com.apple.TextEdit）加入仅文本应用'],
    [{ kind: 'text_only.remove', bundle_id: 'com.apple.TextEdit' }, '将「TextEdit」（com.apple.TextEdit）移出仅文本应用'],
    [{ kind: 'clipboard.set', on: false }, '每轮开始时不再清空剪贴板'],
    [{ kind: 'behavior.set', field: 'allow_point_targets', value: true }, '将「允许按坐标点击」改为开'],
    [{ kind: 'behavior.set', field: 'ime_policy_cap', value: 'takeover' }, '将「中文输入法处理」改为本轮接管'],
    [{ kind: 'behavior.set', field: 'activation_method', value: null }, '将「激活应用的方式」改为标准（推荐）'],
    [{ kind: 'logs.retention', days: 7 }, '将审计日志保留期限改为7 天'],
    [{ kind: 'logs.default_directory' }, '将日志移回默认文件夹'],
    [{ kind: 'logs.directory', directory: '~/Documents/audit' }, '将日志移到 ~/Documents/audit'],
    [{ kind: 'reset', loosened: ['default_mode', 'send_ocr'] }, '恢复默认设置（放宽：default_mode、send_ocr）'],
    [{ kind: 'import', loosened: [] }, '应用导入的设置（放宽：—）'],
    [{ kind: 'something.new' }, '一项设置更改（something.new）'],
    [{ kind: 'access.set', field: 'default_mode', value: 'odd' }, '将「默认档位」改为"odd"'],
  ]
  for (const [summary, text] of cases) assert.equal(model.summaryText(t, summary, s), text, summary.kind)
  const covered = new Set(cases.map(([c]) => c.kind))
  for (const kind of model.SUMMARY_KINDS) assert.ok(covered.has(kind), `a case for ${kind}`)
  assert.deepEqual(Object.keys(change.CHANGE_KEYS).concat(['logs.directory', 'import']).sort(), [...model.SUMMARY_KINDS].sort())
  const en = translator(EN)
  for (const [summary] of cases) assert.ok(model.summaryText(en, summary, s).length > 0)
})

// --- the locale ---

test('the locale: one file per tab plus the shared one, each with the same keys in zh and en, under its own prefix', () => {
  const files = settingsLocale.LOCALE_FILES
  assert.deepEqual(Object.keys(files), ['shared', ...model.SETTINGS_TABS])
  const all = []
  for (const [name, { zh, en }] of Object.entries(files)) {
    assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), `${name}: zh and en keys`)
    for (const key of Object.keys(zh)) {
      if (name === 'shared') {
        assert.ok(key.startsWith('settings.'), key)
        assert.ok(!model.SETTINGS_TABS.some((tab) => key.startsWith(`settings.${tab}.`)), `${key} is not a tab's`)
      } else {
        assert.ok(key.startsWith(`settings.${name}.`), key)
      }
      assert.doesNotMatch(zh[key], /[你您]/, `zh ${key}`)
      assert.ok(zh[key].trim() !== '' && en[key].trim() !== '', key)
      all.push(key)
    }
  }
  assert.equal(new Set(all).size, all.length, 'no key in two files')
  assert.ok(!Object.keys(daemonLocale.zh).some((k) => k.startsWith('settings.')), 'the daemon tab\'s keys never start with settings.')
  for (const id of model.PAGE_TABS) assert.ok(Object.hasOwn(ZH, `settings.tab.${id}`), id)
  // Registered as one namespace, the existing one.
  const page = mountShell(STATUS_DOWN)
  const [{ ns, dicts }] = page.ctx.seen.locales
  assert.equal(ns, 'cu-runtime-page')
  assert.deepEqual(Object.keys(dicts.zh).sort(), Object.keys(ZH).sort())
  assert.deepEqual(Object.keys(dicts.en).sort(), Object.keys(EN).sort())
  page.unmount()
})

test('the page in English uses only English text', async () => {
  const page = mountShell({ ...STATUS_DOWN, 'settings.snapshot': ok('snapshot', snapshot({ pending: { kind: 'revoke_all' } })) }, { dict: EN })
  await page.settle()
  const tabs = find(page.tree, (e) => e.props?.role === 'tab')
  assert.deepEqual(tabs.map((e) => texts(e).join('')), ['Daemon', 'Overview', 'Modes and defaults', 'App lists', 'Shortcuts',
    'Privacy and audit', 'Behavior and model', 'Logs'])
  tabs[1].props.onClick()
  page.draw()
  await page.settle()
  await page.settle()
  const shown = page.shown().join('\n')
  assert.match(shown, /Waiting for verification on this Mac: Revoke every approval/)
  assert.doesNotMatch(shown, /[一-鿿]/, 'no Chinese')
  page.unmount()
})

// --- the shared pieces ---

test('a long list scrolls in a box of limited height; an app is its name over its bundle ID', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ at: SEC - i, method: 'observe', app: 'com.apple.TextEdit', reason: 'no_grant' }))
  const page = mountShell({ ...STATUS_DOWN, 'settings.snapshot': ok('snapshot', snapshot({ recent_refusals: many })) })
  await page.settle()
  await page.tab('概览')
  const lists = find(page.tree, (e) => e.props?.['data-cu-runtime-list'] === '')
  assert.equal(lists.length, 2, 'approvals and refusals')
  for (const list of lists) {
    assert.equal(list.props.role, 'list')
    assert.equal(list.props.style.maxHeight, 240)
    assert.equal(list.props.style.overflow, 'auto')
  }
  assert.equal(find(lists[1], (e) => e.props?.role === 'listitem').length, 30)
  // The app label: name over bundle ID.
  const [label] = find(page.tree, (e) => e.props?.['data-cu-runtime-app'] === 'com.apple.TextEdit')
  assert.deepEqual(texts(label), ['TextEdit', 'com.apple.TextEdit'])
  page.unmount()
})

test('every kit piece: dsh\'s primitive when present, a plain element otherwise', async () => {
  const page = mountShell({ ...STATUS_DOWN, 'settings.snapshot': ok('snapshot', snapshot()) })
  await page.settle()
  await page.tab('概览')
  const host = page.react.drawn.find((d) => d.name === 'TabHost')
  const plain = host.props.ui
  const confirmClosed = plain.confirm({ open: false, title: 'T', text: 'x', confirmLabel: 'OK', onConfirm() {}, onCancel() {} })
  assert.equal(confirmClosed, null)
  let confirmed = 0
  let cancelled = 0
  const dialog = plain.confirm({ open: true, title: '恢复默认设置', text: '确认恢复？', confirmLabel: '恢复', onConfirm: () => confirmed++, onCancel: () => cancelled++ })
  assert.equal(dialog.props.role, 'dialog')
  assert.deepEqual(texts(dialog), ['恢复默认设置', '确认恢复？', '取消', '恢复'])
  find(dialog, (e) => e.type === 'button' && texts(e).includes('恢复'))[0].props.onClick()
  find(dialog, (e) => e.type === 'button' && texts(e).includes('取消'))[0].props.onClick()
  assert.deepEqual([confirmed, cancelled], [1, 1])
  let switched = null
  const sw = plain.switch({ checked: true, onChange: (v) => { switched = v }, label: '截图' })
  find(sw, (e) => e.type === 'input')[0].props.onChange({ target: { checked: false } })
  assert.equal(switched, false)
  let chosen = null
  const seg = plain.segmented({ id: 'mode', value: 'ask', options: [{ value: 'ask', label: '每次询问' }, { value: 'full', label: '可操作', disabled: true }],
    onChange: (v) => { chosen = v }, label: '默认档位' })
  assert.equal(seg.props.role, 'radiogroup')
  const radios = find(seg, (e) => e.props?.role === 'radio')
  assert.deepEqual(radios.map((r) => [r.props['aria-checked'], r.props.disabled]), [[true, false], [false, true]])
  radios[0].props.onClick()
  assert.equal(chosen, 'ask')
  let typed = null
  const input = plain.input({ value: '', onChange: (v) => { typed = v }, label: '备注', maxLength: 200 })
  assert.equal(input.type, 'input')
  assert.equal(input.props.maxLength, 200)
  input.props.onChange({ target: { value: 'abc' } })
  assert.equal(typed, 'abc')
  let toggled = 0
  const closed = plain.disclosure({ title: '高级', open: false, onToggle: () => toggled++, children: ['inside'] })
  assert.ok(!texts(closed).includes('inside'))
  find(closed, (e) => e.type === 'button')[0].props.onClick()
  assert.equal(toggled, 1)
  assert.ok(texts(plain.disclosure({ title: '高级', open: true, onToggle() {}, children: ['inside'] })).includes('inside'))
  assert.deepEqual(find(plain.keys(['⌘', 'C']), (e) => e.type === 'kbd').map(texts), [['⌘'], ['C']])
  assert.equal(plain.toast({ text: '已导出。', onDone() {} }).props.role, 'status')
  assert.equal(plain.list({ label: 'x', rows: [], empty: '暂无。' }).type, 'p')
  page.unmount()

  // With the primitives: each wrapper draws dsh's, with the props it documents.
  const seen = {}
  const fake = (name) => (props) => { seen[name] = props; return { type: `x-${name}`, props: { children: [] } } }
  const names = ['Button', 'Tag', 'StateDot', 'Modal', 'Switch', 'SegmentedControl', 'Input', 'DisclosureRow', 'ShortcutKeys', 'Toast']
  const withAll = mountShell({ ...STATUS_DOWN, 'settings.snapshot': ok('snapshot', snapshot()) },
    { primitives: Object.fromEntries(names.map((n) => [n, fake(n)])) })
  await withAll.settle()
  // The tab bar falls back to buttons (no SegmentedTabs given); show the overview through it.
  await withAll.tab('概览')
  const ui = withAll.react.drawn.find((d) => d.name === 'TabHost').props.ui
  const draw = (node) => withAll.react.render(() => node, {})
  draw(ui.confirm({ open: true, title: 'T', text: 'x', confirmLabel: 'OK', onConfirm() {}, onCancel() {} }))
  assert.equal(seen.Modal.closeLabel, ZH['settings.close'])
  assert.equal(seen.Modal.description, 'x')
  draw(ui.switch({ checked: false, onChange() {}, label: 'L', disabled: true }))
  assert.deepEqual([seen.Switch.checked, seen.Switch.label, seen.Switch.disabled], [false, 'L', true])
  draw(ui.segmented({ id: 'i', value: 'a', options: [{ value: 'a', label: 'A' }], onChange() {}, label: 'S' }))
  assert.equal(seen.SegmentedControl.id, 'i')
  draw(ui.input({ value: 'v', onChange() {}, label: 'I' }))
  assert.equal(seen.Input['aria-label'], 'I')
  draw(ui.disclosure({ title: 'D', open: true, onToggle() {}, children: [] }))
  assert.deepEqual([seen.DisclosureRow.title, seen.DisclosureRow.expandable], ['D', true])
  draw(ui.keys(['⌘', 'K']))
  assert.deepEqual([...seen.ShortcutKeys.keys], ['⌘', 'K'])
  draw(ui.toast({ text: 'T', onDone() {} }))
  assert.equal(seen.Toast.text, 'T')
  draw([ui.tag('x', 'danger'), ui.dot('done'), ui.button({ label: 'B', onClick() {}, disabled: true })])
  assert.equal(seen.Tag.tone, 'danger')
  assert.equal(seen.StateDot.state, 'done')
  assert.deepEqual([seen.Button.size, seen.Button.variant, seen.Button.disabled], ['sm', 'outline', true])
  // A visible border on every button but a primary one (dsh's outline is .5px of a faint color, its ghost none).
  for (const variant of ['outline', 'ghost', 'primary']) {
    draw(ui.button({ label: variant, onClick() {}, variant }))
    assert.equal(seen.Button.style?.border, variant === 'primary' ? undefined : '1px solid var(--dsw-alias-border-l2)', variant)
  }
  withAll.unmount()
})
