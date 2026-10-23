// The 行为与模型 (Behavior and model) and 日志 (Logs) settings tabs (plugin/src/client/settings/tabs/behavior.ts and
// logs.ts), ported from the native pages: their view builders (the values from a snapshot, the choices offered, the
// import preview, the log folder, the retention, the files, the recent changes, empty and long lists) and their
// render through a recording Kit with working hooks (which change or action each control sends, the reset confirm,
// leaving an import, every control held while pending). Loads the compiled CommonJS modules from a build into a
// temporary directory, removed afterwards.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENTRY, ROOT } from '../../scripts/build-client.mjs'

const dir = mkdtempSync(join(tmpdir(), 'cu-settings-behavior-logs-'))
after(() => rmSync(dir, { recursive: true, force: true }))
execFileSync(process.execPath, [join(ROOT, 'scripts/build-client.mjs'), '--out', join(dir, 'client.js'), '--cjs', join(dir, 'cjs')],
  { stdio: ['ignore', 'pipe', 'pipe'] })
const compiled = createRequire(join(dir, 'cjs', ENTRY))
const behavior = compiled('./settings/tabs/behavior.js')
const logs = compiled('./settings/tabs/logs.js')
const { readSnapshot } = compiled('./settings/model.js')
const { CHANGE_KEYS, SETTINGS_ACTIONS } = compiled('./settings/change.js')
const settingsLocale = compiled('./settings/locale/index.js')
const ZH = { ...compiled('./locale.js').zh, ...settingsLocale.zh }
const EN = { ...compiled('./locale.js').en, ...settingsLocale.en }

const translator = (dict) => (key, params) => {
  assert.ok(Object.hasOwn(dict, key), `no text for ${key}`)
  const text = params === undefined ? dict[key] : dict[key].replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
  assert.doesNotMatch(text, /\{\w+\}/, `${key} has a param left`)
  return text
}
const t = translator(ZH)

const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime()
const SEC = NOW / 1000

const BEHAVIOR = { restore_focus_on_turn_end: true, allow_point_targets: false, ime_policy_cap: 'ask', electron_ax_auto: true,
  activation_method: null }
const LOGS = { directory: null, directory_custom: false, retention_days: 30, files: 3, bytes: 12_345 }

function snapshot(over = {}) {
  return readSnapshot({
    started_at: SEC - 3600, grants: [],
    persistent: [{ bundle_id: 'com.apple.TextEdit', name: 'TextEdit', mode: 'read', added_at: SEC - 10, signature_ok: true }],
    denylist: [], hard_deny: [],
    access: { default_mode: 'ask' }, access_choices: {},
    chords: { builtin: [], never: [], custom: [] },
    privacy: {}, behavior: BEHAVIOR, logs: LOGS,
    recent_refusals: [],
    recent_changes: [
      { at: new Date(2026, 9, 21, 11, 58).getTime() / 1000, method: 'settings.persistent_add', app: 'com.apple.TextEdit', reason: null, verified: true },
      { at: new Date(2026, 9, 20, 9, 5).getTime() / 1000, method: 'settings.denylist_add', app: 'com.example.unknown', reason: null, verified: false },
      { at: new Date(2026, 9, 19, 23, 30).getTime() / 1000, method: 'settings.chord_add', app: null, reason: null, verified: null },
      { at: new Date(2026, 9, 18, 8, 0).getTime() / 1000, method: 'settings.chord_add', app: 'com.apple.TextEdit', reason: null, verified: null },
      { at: new Date(2026, 9, 17, 7, 1).getTime() / 1000, method: 'settings.future_thing', app: null, reason: 'some_reason', verified: null },
      { at: new Date(2026, 9, 16, 6, 2).getTime() / 1000, method: 'settings.denylist_remove', app: null, reason: null, verified: true },
    ],
    permissions: null, pending: null, last_outcome: null, picked_app: null, import_preview: null, panel: null,
    ...over,
  })
}

const plain = (v) => JSON.parse(JSON.stringify(v))
const bview = (s = snapshot(), options = {}) => behavior.buildBehaviorView(s, { t, pending: false, ...options })
const lview = (s = snapshot(), options = {}) => logs.buildLogsView(s, { t, pending: false, ...options })

/** Every change object has exactly its kind's keys (CHANGE_KEYS, the daemon's). */
function assertShape(change) {
  assert.ok(Object.hasOwn(CHANGE_KEYS, change.kind), change.kind)
  assert.deepEqual(Object.keys(change).sort(), ['kind', ...CHANGE_KEYS[change.kind]].sort(), JSON.stringify(change))
}

// --- 行为与模型: the view ---

test('behavior before the first snapshot: only the title and note, every control held', () => {
  const v = bview(null)
  assert.equal(v.ready, false)
  assert.equal(v.title, '行为与模型')
  assert.equal(v.importPreview, null)
  for (const c of [v.operation.restoreFocus, v.operation.pointTargets, v.operation.imePolicy, v.operation.electronAX,
    v.advanced.activation, v.advanced.importExport.import, v.advanced.importExport.export, v.advanced.reset]) {
    assert.equal(c.enabled, false)
  }
})

test('behavior: each field\'s value from snapshot.behavior, the choices the daemon offers, each change exactly', () => {
  const o = bview().operation
  assert.deepEqual(plain(o.restoreFocus), {
    field: 'restore_focus_on_turn_end', label: '每轮结束后归还焦点', note: ZH['settings.behavior.restoreFocusNote'], lock: null,
    checked: true, enabled: true,
    toOn: { kind: 'behavior.set', field: 'restore_focus_on_turn_end', value: true },
    toOff: { kind: 'behavior.set', field: 'restore_focus_on_turn_end', value: false },
  })
  assert.equal(o.pointTargets.checked, false)
  assert.equal(o.pointTargets.lock, '关闭立即生效 · 开启需验证')
  assert.deepEqual(plain(o.pointTargets.toOn), { kind: 'behavior.set', field: 'allow_point_targets', value: true })
  assert.equal(o.imePolicy.value, 'ask')
  assert.deepEqual(plain(o.imePolicy.options), [
    { value: 'leave', label: '不切换', change: { kind: 'behavior.set', field: 'ime_policy_cap', value: 'leave' } },
    { value: 'ask', label: '每次询问', change: { kind: 'behavior.set', field: 'ime_policy_cap', value: 'ask' } },
    { value: 'takeover', label: '本轮接管', change: { kind: 'behavior.set', field: 'ime_policy_cap', value: 'takeover' } },
  ])
  assert.equal(o.electronAX.value, 'auto')
  assert.deepEqual(plain(o.electronAX.options), [
    { value: 'auto', label: '自动', change: { kind: 'behavior.set', field: 'electron_ax_auto', value: true } },
    { value: 'off', label: '关', change: { kind: 'behavior.set', field: 'electron_ax_auto', value: false } },
  ])
  const a = bview().advanced.activation
  assert.equal(a.value, 'default')
  assert.deepEqual(plain(a.options), [
    { value: 'default', label: '标准（推荐）', change: { kind: 'behavior.set', field: 'activation_method', value: null } },
    { value: 'ax_frontmost', label: '无障碍前台属性', change: { kind: 'behavior.set', field: 'activation_method', value: 'ax_frontmost' } },
    { value: 'ax_raise', label: '无障碍窗口前置', change: { kind: 'behavior.set', field: 'activation_method', value: 'ax_raise' } },
  ])
  for (const c of [o.restoreFocus.toOn, o.restoreFocus.toOff, o.pointTargets.toOn, ...o.imePolicy.options.map((x) => x.change),
    ...o.electronAX.options.map((x) => x.change), ...a.options.map((x) => x.change), bview().advanced.reset.change]) assertShape(c)
  assert.deepEqual(plain(bview().advanced.reset.change), { kind: 'reset' })
  assert.equal(bview(snapshot({ behavior: { ...BEHAVIOR, electron_ax_auto: false } })).operation.electronAX.value, 'off')
  assert.equal(bview(snapshot({ behavior: { ...BEHAVIOR, activation_method: 'ax_raise' } })).advanced.activation.value, 'ax_raise')
})

test('behavior: running_application set elsewhere is offered as itself; an odd or missing value is held, not guessed', () => {
  const explicit = bview(snapshot({ behavior: { ...BEHAVIOR, activation_method: 'running_application' } })).advanced.activation
  assert.equal(explicit.value, 'running_application')
  assert.deepEqual(explicit.options.map((o) => o.value), ['default', 'running_application', 'ax_frontmost', 'ax_raise'])
  assert.equal(explicit.options[1].label, '标准（已明确指定）')
  assert.deepEqual(plain(explicit.options[1].change), { kind: 'behavior.set', field: 'activation_method', value: 'running_application' })
  // A missing activation_method is the default (null); an unknown one is none of the choices.
  assert.equal(bview(snapshot({ behavior: { ...BEHAVIOR, activation_method: undefined } })).advanced.activation.value, 'default')
  const odd = bview(snapshot({ behavior: { restore_focus_on_turn_end: 'yes', ime_policy_cap: 'maybe', activation_method: 'warp' } }))
  assert.equal(odd.operation.restoreFocus.checked, null)
  assert.equal(odd.operation.restoreFocus.enabled, false)
  assert.equal(odd.operation.pointTargets.checked, null)
  assert.equal(odd.operation.imePolicy.value, null)
  assert.equal(odd.operation.imePolicy.enabled, false)
  assert.equal(odd.operation.electronAX.value, null)
  assert.equal(odd.advanced.activation.value, null)
  assert.equal(odd.advanced.activation.enabled, false)
  assert.equal(odd.advanced.reset.enabled, true, 'reset and import stay available')
})

test('behavior: while anything is pending every control is held', () => {
  const v = bview(snapshot({ import_preview: { changes: [], changes_count: 0, loosened: [], log_directory_ignored: false } }), { pending: true })
  for (const c of [v.operation.restoreFocus, v.operation.pointTargets, v.operation.imePolicy, v.operation.electronAX,
    v.advanced.activation, v.advanced.importExport.import, v.advanced.importExport.export, v.advanced.reset, v.importPreview.confirm]) {
    assert.equal(c.enabled, false)
  }
})

test('behavior: the import preview shows what changes and what loosens; the confirm says verify only when the daemon listed something', () => {
  const p = bview(snapshot({ import_preview: { changes: ['behavior.allow_point_targets', 'denylist.add:com.example.x'], changes_count: 2,
    loosened: ['allow_point_targets'], log_directory_ignored: true } })).importPreview
  assert.deepEqual(plain({ ...p, key: undefined }), {
    title: '导入设置', changes: ['behavior.allow_point_targets', 'denylist.add:com.example.x'], changesText: '导入将更改以下 2 项：', more: null,
    loosened: ['allow_point_targets'], loosenedText: '导入将放宽以下项，需要身份验证：',
    directoryIgnored: ZH['settings.behavior.importDirectoryIgnored'],
    confirm: { label: '验证并应用', enabled: true, action: 'import_confirm' }, leave: '暂不导入',
  })
  const none = bview(snapshot({ import_preview: { changes: [], changes_count: 0, loosened: [], log_directory_ignored: false } })).importPreview
  assert.equal(none.changesText, '导入内容与当前设置相同。')
  assert.equal(none.loosenedText, '导入内容不比当前宽松，可直接应用。')
  assert.equal(none.confirm.label, '应用')
  assert.equal(none.directoryIgnored, null)
  // The daemon lists at most 100 and counts them all.
  const many = Array.from({ length: 100 }, (_, i) => `denylist.add:com.example.app${i}`)
  const long = bview(snapshot({ import_preview: { changes: many, changes_count: 140, loosened: [], log_directory_ignored: false } })).importPreview
  assert.equal(long.changes.length, 100)
  assert.equal(long.changesText, '导入将更改以下 140 项：')
  assert.equal(long.more, '仅列出前 100 项，共 140 项。')
  // A malformed preview reads as empty lists, never a crash; two previews have two keys.
  const bad = bview(snapshot({ import_preview: { changes: 'x', loosened: [1] } })).importPreview
  assert.deepEqual([...bad.changes, ...bad.loosened], [])
  assert.notEqual(long.key, none.key)
})

// --- 日志: the view ---

test('logs before the first snapshot: only the title and note, every control held', () => {
  const v = lview(null)
  assert.equal(v.ready, false)
  assert.equal(v.title, '日志')
  const l = v.auditLog.location
  assert.ok([l.choose, l.reveal, v.auditLog.retention, v.auditLog.files.export].every((c) => c.enabled === false))
  assert.deepEqual(plain(v.changes.rows), [])
})

test('logs: the default folder reads 默认位置 with the tag and no 恢复默认位置; a chosen one is shown with it', () => {
  const l = lview().auditLog.location
  assert.deepEqual(plain(l), {
    title: '存放位置', path: '默认位置', defaultTag: '默认', note: ZH['settings.logs.locationNote'],
    choose: { label: '选择…', enabled: true, action: 'choose_log_directory' }, useDefault: null,
    reveal: { label: '在访达中显示', enabled: true, action: 'reveal_log' },
  })
  const chosen = lview(snapshot({ logs: { ...LOGS, directory: '~/Documents/audit', directory_custom: true } })).auditLog.location
  assert.equal(chosen.path, '~/Documents/audit')
  assert.equal(chosen.defaultTag, null)
  assert.deepEqual(plain(chosen.useDefault), { label: '恢复默认位置', enabled: true, action: 'use_default_log_directory' })
  // Custom but the daemon could not show it.
  const hidden = lview(snapshot({ logs: { ...LOGS, directory: null, directory_custom: true } })).auditLog.location
  assert.equal(hidden.path, '自定义位置')
  assert.notEqual(hidden.useDefault, null)
  for (const a of [l.choose, l.reveal, chosen.useDefault]) assert.ok(SETTINGS_ACTIONS.includes(a.action), a.action)
})

test('logs: retention 7 / 30 / 90 with {kind: logs.retention, days}; the files and their size; what is recorded', () => {
  const r = lview().auditLog.retention
  assert.equal(r.value, '30')
  assert.equal(r.lock, ZH['settings.logs.retentionLock'])
  assert.deepEqual(plain(r.options), [
    { value: '7', label: '7 天', change: { kind: 'logs.retention', days: 7 } },
    { value: '30', label: '30 天', change: { kind: 'logs.retention', days: 30 } },
    { value: '90', label: '90 天', change: { kind: 'logs.retention', days: 90 } },
  ])
  for (const o of r.options) assertShape(o.change)
  const odd = lview(snapshot({ logs: { ...LOGS, retention_days: 14 } })).auditLog.retention
  assert.equal(odd.value, null)
  assert.equal(odd.enabled, false)
  assert.deepEqual(plain(lview().auditLog.files), { title: '当前文件', text: '3 个文件 · 12 KB',
    export: { label: '导出最近 7 天', enabled: true, action: 'export_audit' } })
  assert.equal(lview(snapshot({ logs: { ...LOGS, files: 0, bytes: 0 } })).auditLog.files.text, '0 个文件 · 0 字节')
  assert.equal(lview(snapshot({ logs: { ...LOGS, files: 'x' } })).auditLog.files.text, '—')
  assert.deepEqual(['999', '1500', '1234567', '20000000', '3000000000'].map((n) => logs.sizeText(t, Number(n))),
    ['999 字节', '2 KB', '1.2 MB', '20 MB', '3 GB'])
  assert.deepEqual(plain(lview().auditLog.recorded), { title: '记录内容', note: ZH['settings.logs.recordedNote'], fixed: '固定' })
})

test('logs: recent changes in words with time, app name (or bundle ID), verified; unknown methods as recorded; empty line', () => {
  const c = lview().changes
  assert.equal(c.maxHeight, 320)
  assert.deepEqual(plain(c.rows.map(({ key, ...r }) => r)), [
    { at: '10-21 11:58', text: '始终允许加入「TextEdit」', reason: null, verified: '已验证' },
    { at: '10-20 09:05', text: '黑名单加入「com.example.unknown」', reason: null, verified: null },
    { at: '10-19 23:30', text: '添加快捷键', reason: null, verified: null },
    { at: '10-18 08:00', text: '添加快捷键（仅「TextEdit」）', reason: null, verified: null },
    { at: '10-17 07:01', text: 'settings.future_thing', reason: 'some_reason', verified: null },
    { at: '10-16 06:02', text: '黑名单移出未知应用', reason: null, verified: '已验证' },
  ])
  assert.equal(new Set(c.rows.map((r) => r.key)).size, c.rows.length, 'distinct keys')
  assert.equal(lview(snapshot({ recent_changes: [] })).changes.empty, '近 7 天没有设置变更。')
  for (const word of new Set(Object.values(logs.CHANGE_METHODS))) {
    assert.ok(Object.hasOwn(ZH, `settings.logs.change.${word}`) && Object.hasOwn(EN, `settings.logs.change.${word}`), word)
  }
})

test('logs: while anything is pending every control is held', () => {
  const v = lview(snapshot({ logs: { ...LOGS, directory: '~/x', directory_custom: true } }), { pending: true })
  const l = v.auditLog.location
  assert.ok([l.choose, l.useDefault, l.reveal, v.auditLog.retention, v.auditLog.files.export].every((c) => c.enabled === false))
})

test('both views in English', () => {
  const tEn = translator(EN)
  const b = behavior.buildBehaviorView(snapshot({ import_preview: { changes: ['a'], changes_count: 1, loosened: [], log_directory_ignored: false } }),
    { t: tEn, pending: false })
  assert.equal(b.operation.imePolicy.options[2].label, 'Take over')
  assert.equal(b.importPreview.confirm.label, 'Apply')
  const l = logs.buildLogsView(snapshot(), { t: tEn, pending: false })
  assert.equal(l.auditLog.location.path, 'Default location')
  assert.equal(l.auditLog.files.text, '3 file(s) · 12 KB')
  assert.equal(l.changes.rows[0].text, 'Always allowed: “TextEdit” added')
  assert.equal(l.auditLog.retention.options[0].label, '7 days')
})

// --- render, through a Kit that records what each piece was given, with hooks that keep their state ---

function recordingKit(hooks) {
  const h = (type, props, ...children) => ({ type, props: { ...props, children } })
  const el = (type, spec, children = []) => ({ type, props: { ...spec, children } })
  return {
    h, useState: hooks.useState, useEffect: () => {}, styles: new Proxy({}, { get: () => ({}) }),
    button: (spec) => el('button', spec, [spec.label]),
    tag: (text, tone) => el('tag', { tone }, [text]),
    dot: (state) => el('dot', { state }),
    appLabel: (app) => el('app', { app }, [app.name ?? app.bundle_id, app.bundle_id]),
    list: (spec) => el('list', spec, spec.rows.length === 0 ? [spec.empty] : spec.rows),
    confirm: (spec) => (spec.open ? el('confirm', spec, [spec.title, spec.text]) : null),
    card: (spec) => el('card', spec, [spec.title, spec.note ?? null, spec.trailing ?? null, ...spec.children]),
    switch: (spec) => el('switch', spec), segmented: (spec) => el('segmented', spec), input: (spec) => el('input', spec),
    disclosure: (spec) => el('disclosure', spec, spec.children), keys: (keys) => el('keys', { keys }), toast: (spec) => el('toast', spec),
  }
}

function texts(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(texts)
  return texts(node.props?.children)
}

function find(node, pred) {
  if (node === null || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((n) => find(n, pred))
  return [...(pred(node) ? [node] : []), ...find(node.props?.children, pred)]
}

/** Draws a tab as the shell's TabHost would: its state slots kept across draws, the same hooks in the same order. */
function mount(tab, s, { pending = false } = {}) {
  const slots = []
  const applied = []
  const actions = []
  let tree = null
  let calls = 0
  const hooks = {
    useState(initial) {
      const i = calls++
      if (!(i in slots)) slots[i] = initial
      return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }]
    },
  }
  const props = {
    snapshot: s, t, pending, now: NOW,
    apply: async (c) => { applied.push(c); return true },
    action: async (name) => { actions.push(name); return true },
    goTo: () => {},
  }
  const draw = (over = {}) => {
    Object.assign(props, over)
    calls = 0
    tree = tab.render(props, recordingKit(hooks))
    return tree
  }
  draw()
  return { get tree() { return tree }, draw, applied, actions, slots }
}

const byType = (tree, type) => find(tree, (e) => e.type === type)
const button = (tree, label) => find(tree, (e) => e.type === 'button' && e.props.label === label)
const segmented = (tree, id) => find(tree, (e) => e.type === 'segmented' && e.props.id === id)[0]

test('render behavior: each switch and segmented control sends its behavior.set exactly; the same value sends nothing', () => {
  assert.equal(behavior.tab.id, 'behavior')
  const page = mount(behavior.tab, snapshot())
  const [focus, point] = byType(page.tree, 'switch')
  assert.equal(focus.props.checked, true)
  assert.equal(point.props.checked, false)
  focus.props.onChange(false)
  point.props.onChange(true)
  point.props.onChange(false) // already off
  segmented(page.tree, 'cu-runtime-behavior-ime').props.onChange('takeover')
  segmented(page.tree, 'cu-runtime-behavior-ime').props.onChange('ask') // already
  segmented(page.tree, 'cu-runtime-behavior-ime').props.onChange('bogus')
  segmented(page.tree, 'cu-runtime-behavior-electron').props.onChange('off')
  const activation = segmented(page.tree, 'cu-runtime-behavior-activation')
  assert.equal(activation.props.value, 'default')
  activation.props.onChange('ax_frontmost')
  assert.deepEqual(plain(page.applied), [
    { kind: 'behavior.set', field: 'restore_focus_on_turn_end', value: false },
    { kind: 'behavior.set', field: 'allow_point_targets', value: true },
    { kind: 'behavior.set', field: 'ime_policy_cap', value: 'takeover' },
    { kind: 'behavior.set', field: 'electron_ax_auto', value: false },
    { kind: 'behavior.set', field: 'activation_method', value: 'ax_frontmost' },
  ])
  // Back to the default sends null.
  const set = mount(behavior.tab, snapshot({ behavior: { ...BEHAVIOR, activation_method: 'ax_raise' } }))
  segmented(set.tree, 'cu-runtime-behavior-activation').props.onChange('default')
  assert.deepEqual(plain(set.applied), [{ kind: 'behavior.set', field: 'activation_method', value: null }])
  assert.deepEqual(page.actions, [])
})

test('render behavior: 恢复默认设置 asks first; only 确定 in the dialog sends {kind: reset}, cancelling sends nothing', () => {
  const page = mount(behavior.tab, snapshot())
  assert.equal(byType(page.tree, 'confirm').length, 0)
  button(page.tree, '恢复默认设置…')[0].props.onClick()
  assert.deepEqual(page.applied, [], 'nothing sent by the button itself')
  page.draw()
  let [dialog] = byType(page.tree, 'confirm')
  assert.equal(dialog.props.title, '恢复默认设置')
  assert.equal(dialog.props.text, ZH['settings.behavior.resetNote'])
  assert.equal(dialog.props.confirmLabel, '恢复默认设置')
  dialog.props.onCancel()
  page.draw()
  assert.equal(byType(page.tree, 'confirm').length, 0)
  assert.deepEqual(page.applied, [])
  button(page.tree, '恢复默认设置…')[0].props.onClick()
  page.draw();
  [dialog] = byType(page.tree, 'confirm')
  dialog.props.onConfirm()
  page.draw()
  assert.deepEqual(plain(page.applied), [{ kind: 'reset' }])
  assert.equal(byType(page.tree, 'confirm').length, 0, 'closed after confirming')
  // A dialog left open while a change became pending sends nothing.
  button(page.tree, '恢复默认设置…')[0].props.onClick()
  page.draw({ pending: true });
  [dialog] = byType(page.tree, 'confirm')
  dialog.props.onConfirm()
  assert.equal(page.applied.length, 1)
})

test('render behavior: 导入… and 导出… run their actions; the preview applies with import_confirm or is left', () => {
  const page = mount(behavior.tab, snapshot())
  button(page.tree, '导入…')[0].props.onClick()
  button(page.tree, '导出…')[0].props.onClick()
  assert.deepEqual(page.actions, ['import', 'export_settings'])
  assert.equal(find(page.tree, (e) => e.type === 'card' && e.props.title === '导入设置').length, 0, 'no preview yet')
  const preview = { changes: ['behavior.allow_point_targets'], changes_count: 1, loosened: ['allow_point_targets'], log_directory_ignored: true }
  page.draw({ snapshot: snapshot({ import_preview: preview }) })
  const [card] = find(page.tree, (e) => e.type === 'card' && e.props.title === '导入设置')
  const lists = byType(card, 'list')
  assert.deepEqual(lists.map((l) => [l.props.rows.length, l.props.maxHeight]), [[1, 200], [1, 200]], 'limited-height lists')
  const words = texts(card)
  for (const w of ['导入将更改以下 1 项：', 'behavior.allow_point_targets', '导入将放宽以下项，需要身份验证：', 'allow_point_targets',
    ZH['settings.behavior.importDirectoryIgnored']]) assert.ok(words.includes(w), w)
  button(card, '验证并应用')[0].props.onClick()
  assert.deepEqual(page.actions, ['import', 'export_settings', 'import_confirm'])
  // Leaving it hides this preview (nothing sent); a new import shows the next one again.
  button(page.tree, '暂不导入')[0].props.onClick()
  page.draw()
  assert.equal(find(page.tree, (e) => e.type === 'card' && e.props.title === '导入设置').length, 0)
  assert.equal(page.actions.length, 3)
  assert.deepEqual(page.applied, [])
  page.draw({ snapshot: snapshot({ import_preview: { ...preview, loosened: [] } }) })
  assert.equal(button(page.tree, '应用').length, 1, 'another preview is shown')
  button(page.tree, '暂不导入')[0].props.onClick()
  page.draw()
  button(page.tree, '导入…')[0].props.onClick()
  page.draw()
  assert.equal(button(page.tree, '应用').length, 1, '导入… again shows the preview the daemon holds')
})

test('render behavior: every control is disabled while pending; before the first snapshot only the header is drawn', () => {
  const page = mount(behavior.tab, snapshot({ import_preview: { changes: [], changes_count: 0, loosened: [], log_directory_ignored: false } }),
    { pending: true })
  const controls = find(page.tree, (e) => ['switch', 'segmented'].includes(e.type))
  assert.equal(controls.length, 5)
  assert.ok(controls.every((c) => c.props.disabled === true))
  const buttons = byType(page.tree, 'button').filter((b) => b.props.label !== '暂不导入')
  assert.deepEqual(buttons.map((b) => b.props.label).sort(), ['导入…', '导出…', '应用', '恢复默认设置…'].sort())
  assert.ok(buttons.every((b) => b.props.disabled === true))
  assert.deepEqual(texts(mount(behavior.tab, null).tree), ['行为与模型', ZH['settings.behavior.note']])
  // The model card and the dsh session size are not on the page.
  const all = texts(mount(behavior.tab, snapshot()).tree).join('\n')
  assert.doesNotMatch(all, /推理强度|使用的模型|会话记录/)
})

test('render logs: 选择… / 恢复默认位置 / 在访达中显示 / 导出最近 7 天 run their actions; retention sends logs.retention', () => {
  assert.equal(logs.tab.id, 'logs')
  const page = mount(logs.tab, snapshot({ logs: { ...LOGS, directory: '~/Documents/audit', directory_custom: true } }))
  for (const label of ['选择…', '恢复默认位置', '在访达中显示', '导出最近 7 天']) button(page.tree, label)[0].props.onClick()
  assert.deepEqual(page.actions, ['choose_log_directory', 'use_default_log_directory', 'reveal_log', 'export_audit'])
  const retention = segmented(page.tree, 'cu-runtime-logs-retention')
  assert.equal(retention.props.value, '30')
  assert.deepEqual(retention.props.options.map((o) => [o.value, o.label]), [['7', '7 天'], ['30', '30 天'], ['90', '90 天']])
  retention.props.onChange('7')
  retention.props.onChange('30') // already
  retention.props.onChange('90')
  assert.deepEqual(plain(page.applied), [{ kind: 'logs.retention', days: 7 }, { kind: 'logs.retention', days: 90 }])
  const words = texts(page.tree)
  for (const w of ['~/Documents/audit', '3 个文件 · 12 KB', '记录内容', '固定', ZH['settings.logs.retentionLock']]) assert.ok(words.includes(w), w)
  // The default folder: no 恢复默认位置, the 默认 tag.
  const plainPage = mount(logs.tab, snapshot())
  assert.equal(button(plainPage.tree, '恢复默认位置').length, 0)
  assert.ok(texts(plainPage.tree).includes('默认位置'))
  assert.ok(find(plainPage.tree, (e) => e.type === 'tag' && texts(e).includes('默认')).length === 1)
})

test('render logs: the recent changes in the limited-height list, long and empty; every control held while pending', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ at: SEC - i * 600, method: 'settings.access', app: null, reason: null, verified: null }))
  const page = mount(logs.tab, snapshot({ recent_changes: many }))
  const [list] = byType(page.tree, 'list')
  assert.equal(list.props.label, '最近设置变更')
  assert.equal(list.props.maxHeight, 320)
  assert.equal(list.props.rows.length, 50)
  const shown = mount(logs.tab, snapshot())
  assert.ok(texts(shown.tree).includes('始终允许加入「TextEdit」'))
  assert.ok(find(shown.tree, (e) => e.type === 'tag' && texts(e).includes('已验证')).length === 2)
  assert.ok(texts(mount(logs.tab, snapshot({ recent_changes: [] })).tree).includes('近 7 天没有设置变更。'))
  const held = mount(logs.tab, snapshot({ logs: { ...LOGS, directory: '~/x', directory_custom: true } }), { pending: true })
  const controls = [...byType(held.tree, 'button'), ...byType(held.tree, 'segmented')]
  assert.equal(controls.length, 5)
  assert.ok(controls.every((c) => c.props.disabled === true))
  assert.deepEqual(texts(mount(logs.tab, null).tree), ['日志', ZH['settings.logs.note']])
  assert.doesNotMatch(texts(shown.tree).join('\n'), /dsh 会话记录/)
})
