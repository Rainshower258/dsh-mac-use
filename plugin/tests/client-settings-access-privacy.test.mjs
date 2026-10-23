// The 档位与默认 (Modes and defaults) and 隐私与审计 (Privacy and audit) settings tabs (plugin/src/client/settings/tabs/
// access.ts and privacy.ts), ported from the native pages: their view builders (the values from the snapshot, the
// choices the daemon offers, the changes each control sends, held while pending, empty and long lists) and their
// render through a recording Kit (which change each control sends, which action the add runs). Loads the compiled
// CommonJS modules from a build into a temporary directory, removed afterwards.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENTRY, ROOT } from '../../scripts/build-client.mjs'

const dir = mkdtempSync(join(tmpdir(), 'cu-settings-access-privacy-'))
after(() => rmSync(dir, { recursive: true, force: true }))
execFileSync(process.execPath, [join(ROOT, 'scripts/build-client.mjs'), '--out', join(dir, 'client.js'), '--cjs', join(dir, 'cjs')],
  { stdio: ['ignore', 'pipe', 'pipe'] })
const compiled = createRequire(join(dir, 'cjs', ENTRY))
const access = compiled('./settings/tabs/access.js')
const privacy = compiled('./settings/tabs/privacy.js')
const { readSnapshot } = compiled('./settings/model.js')
const { CHANGE_KEYS } = compiled('./settings/change.js')
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

/** The daemon's settingsSnapshotJSON for the two tabs' fields, the rest empty. */
function snapshot(over = {}) {
  return readSnapshot({
    started_at: SEC - 3600,
    grants: [], persistent: [{ bundle_id: 'com.apple.Notes', name: 'Notes', mode: 'read', added_at: SEC, signature_ok: true }],
    denylist: [], hard_deny: [],
    access: { default_mode: 'ask', session_limit_minutes: 30, dialogs_per_turn: 2, dialog_timeout_seconds: 120, dialog_default: 'deny' },
    access_choices: {
      default_mode: ['ask', 'read', 'full'], session_limit_minutes: [15, 30, 60], dialogs_per_turn: [1, 2, 3],
      dialog_timeout_seconds: [60, 120, 180], dialog_default: ['deny', 'turn', 'session', 'always'],
    },
    chords: { builtin: [], never: [], custom: [] },
    privacy: { send_screenshots: true, send_ax_text: false, send_ocr: true, send_zoom: true,
      text_only_apps: ['com.apple.Notes', 'com.example.Secret'], clear_clipboard_on_turn_start: false },
    behavior: {}, logs: {},
    recent_refusals: [], recent_changes: [], permissions: null,
    pending: null, last_outcome: null, picked_app: null, import_preview: null, panel: null,
    ...over,
  })
}

const plain = (v) => JSON.parse(JSON.stringify(v))
const accessView = (s = snapshot(), options = {}) => access.buildAccessView(s, { t, pending: false, now: NOW, ...options })
const privacyView = (s = snapshot(), options = {}) => privacy.buildPrivacyView(s, { t, pending: false, now: NOW, ...options })
const rows = (v) => v.cards.flatMap((c) => c.rows)
const rowOf = (v, field) => rows(v).find((r) => r.field === field)
const exactKeys = (change) => assert.deepEqual(Object.keys(change).sort(), ['kind', ...CHANGE_KEYS[change.kind]].sort(), change.kind)

// --- 档位与默认 ---

test('access: the three tier cards, static, with 完全放权 not available yet; the fixed rules', () => {
  const v = accessView()
  assert.equal(v.title, '档位与默认')
  assert.deepEqual(plain(v.tiers.map((c) => [c.id, c.chip.text, c.chip.tone, c.title, c.items.length, c.note])), [
    ['read', '浏览', 'info', '查看、点击、滚动', 4, null],
    ['full', '可操作', 'warning', '在浏览基础上可输入与操作', 4, null],
    ['max', '完全放权', 'danger', '不弹申请窗口，高危操作需确认', 4, '尚未提供'],
  ])
  assert.equal(v.tiers[0].items[3], '不能输入文字或使用快捷键')
  assert.equal(v.fixedRules.title, '固定规则（不能在设置里改）')
  assert.equal(v.fixedRules.items.length, 4)
  assert.equal(v.fixedRules.items[3], '系统底线中的应用不弹窗，直接拒绝。')
  assert.deepEqual(plain(accessView(null).tiers), plain(v.tiers), 'the same before the first snapshot')
})

test('access: one row per field in the native cards, the stored value, the offered values in words, the lock hints', () => {
  const v = accessView()
  assert.deepEqual(v.cards.map((c) => [c.key, c.title, c.rows.map((r) => r.field)]), [
    ['newSession', '新会话默认', ['default_mode']],
    ['session', '「本次会话」最长', ['session_limit_minutes']],
    ['dialogs', '每轮最多弹窗', ['dialogs_per_turn', 'dialog_timeout_seconds', 'dialog_default']],
  ])
  assert.deepEqual(plain(rows(v).map((r) => [r.field, r.value, r.options.map((o) => o.label), r.lock])), [
    ['default_mode', 'ask', ['每次询问', '浏览', '可操作', '完全放权'], '提高需验证 · 完全放权不能设为默认'],
    ['session_limit_minutes', '30', ['15 分钟', '30 分钟', '60 分钟'], '延长需验证'],
    ['dialogs_per_turn', '2', ['1 次', '2 次', '3 次'], '增加需验证'],
    ['dialog_timeout_seconds', '120', ['60 秒', '120 秒', '180 秒'], null],
    ['dialog_default', 'deny', ['拒绝', '仅本轮', '本次会话', '始终允许'], '拒绝以外需验证'],
  ])
  assert.equal(rowOf(v, 'dialog_timeout_seconds').title, '超时处理')
  assert.ok(rows(v).every((r) => r.enabled))
})

test('access: each offered value sends exactly {kind: access.set, field, value} with the daemon\'s value; the shown one and 完全放权 nothing', () => {
  const v = accessView()
  const mode = rowOf(v, 'default_mode')
  assert.deepEqual(plain(mode.options), [
    { value: 'ask', label: '每次询问', disabled: false, change: null },
    { value: 'read', label: '浏览', disabled: false, change: { kind: 'access.set', field: 'default_mode', value: 'read' } },
    { value: 'full', label: '可操作', disabled: false, change: { kind: 'access.set', field: 'default_mode', value: 'full' } },
    { value: 'max', label: '完全放权', disabled: true, change: null },
  ])
  assert.deepEqual(plain(rowOf(v, 'session_limit_minutes').options.map((o) => o.change)), [
    { kind: 'access.set', field: 'session_limit_minutes', value: 15 }, null, { kind: 'access.set', field: 'session_limit_minutes', value: 60 }])
  assert.deepEqual(plain(rowOf(v, 'dialogs_per_turn').options.map((o) => o.change?.value ?? null)), [1, null, 3])
  assert.deepEqual(plain(rowOf(v, 'dialog_timeout_seconds').options.map((o) => o.change?.value ?? null)), [60, null, 180])
  assert.deepEqual(plain(rowOf(v, 'dialog_default').options.map((o) => o.change?.value ?? null)), [null, 'turn', 'session', 'always'])
  for (const r of rows(v)) {
    for (const o of r.options) {
      if (o.change === null) continue
      exactKeys(o.change)
      assert.equal(o.change.field, r.field)
      assert.equal(typeof o.change.value, r.field === 'default_mode' || r.field === 'dialog_default' ? 'string' : 'number', 'the JSON type the daemon decodes')
    }
  }
})

test('access: only what the daemon offers, each once; values of the wrong type left out; none offered says so', () => {
  const s = snapshot({ access_choices: {
    default_mode: ['ask', 'read', 'read', 3, null], session_limit_minutes: [30, 45, '60', 1.5, 15],
    dialogs_per_turn: [], dialog_default: ['deny', 'later'],
  } })
  const v = accessView(s)
  assert.deepEqual(rowOf(v, 'default_mode').options.map((o) => o.value), ['ask', 'read', 'max'])
  assert.deepEqual(rowOf(v, 'session_limit_minutes').options.map((o) => o.value), ['30', '45', '15'])
  assert.deepEqual(plain(rowOf(v, 'session_limit_minutes').options[1].change), { kind: 'access.set', field: 'session_limit_minutes', value: 45 })
  assert.deepEqual(plain(rowOf(v, 'dialogs_per_turn').options), [])
  assert.deepEqual(plain(rowOf(v, 'dialog_timeout_seconds').options), [], 'a field the daemon does not list')
  assert.equal(rowOf(v, 'dialogs_per_turn').noChoices, '守护进程未提供可选值。')
  assert.deepEqual(rowOf(v, 'dialog_default').options.map((o) => o.label), ['拒绝', 'later'], 'a name without words reads as is')
  assert.deepEqual(plain(access.offeredValues(s, 'default_mode')), ['ask', 'read'])
  // Without the offered modes, 完全放权 is not added alone.
  assert.deepEqual(plain(accessView(snapshot({ access_choices: {} })).cards[0].rows[0].options), [])
})

test('access: a stored value that is missing or of no known type selects nothing and every offered value sends', () => {
  const v = accessView(snapshot({ access: { default_mode: { x: 1 }, session_limit_minutes: 90 } }))
  const mode = rowOf(v, 'default_mode')
  assert.equal(mode.value, '')
  assert.deepEqual(mode.options.map((o) => o.change === null), [false, false, false, true])
  assert.equal(rowOf(v, 'session_limit_minutes').value, '90')
  assert.ok(rowOf(v, 'session_limit_minutes').options.every((o) => o.change !== null))
  assert.equal(rowOf(v, 'dialog_default').value, '')
})

test('access: every control disabled and sending nothing while pending and before the first snapshot', () => {
  for (const v of [accessView(snapshot(), { pending: true }), accessView(null)]) {
    assert.ok(rows(v).every((r) => r.enabled === false))
    assert.ok(rows(v).every((r) => r.options.every((o) => o.change === null)))
  }
  assert.equal(accessView(null).ready, false)
  assert.ok(rows(accessView(null)).every((r) => r.options.length === 0 && r.value === ''))
})

test('access: the view in English', () => {
  const v = access.buildAccessView(snapshot(), { t: translator(EN), pending: false })
  assert.deepEqual(rowOf(v, 'session_limit_minutes').options.map((o) => o.label), ['15 min', '30 min', '60 min'])
  assert.deepEqual(rowOf(v, 'default_mode').options.map((o) => o.label), ['Ask every time', 'Browse', 'Operate', 'Full power'])
  assert.equal(v.tiers[2].note, 'Not available yet')
})

// --- 隐私与审计 ---

test('privacy: the four content switches from snapshot.privacy, each sending {kind: privacy.set, field, on} turned over', () => {
  const v = privacyView()
  assert.equal(v.title, '隐私与审计')
  assert.equal(v.sent.title, '发送内容')
  assert.equal(v.sent.lock, '关闭立即生效 · 开启需验证')
  assert.deepEqual(plain(v.sent.switches.map(({ note, ...s }) => s)), [
    { field: 'send_screenshots', title: '截图', checked: true, known: true, enabled: true,
      change: { kind: 'privacy.set', field: 'send_screenshots', on: false } },
    { field: 'send_ax_text', title: '界面文本', checked: false, known: true, enabled: true,
      change: { kind: 'privacy.set', field: 'send_ax_text', on: true } },
    { field: 'send_ocr', title: '本地识别文本（OCR）', checked: true, known: true, enabled: true,
      change: { kind: 'privacy.set', field: 'send_ocr', on: false } },
    { field: 'send_zoom', title: '局部放大图', checked: true, known: true, enabled: true,
      change: { kind: 'privacy.set', field: 'send_zoom', on: false } },
  ])
  assert.equal(v.sent.switches[1].note, '控件标题、消息内容等。关闭后仅发送控件位置与类型。')
  for (const s of v.sent.switches) exactKeys(s.change)
})

test('privacy: the clipboard switch sends {kind: clipboard.set, on}', () => {
  const off = privacyView().clipboard
  assert.equal(off.title, '剪贴板')
  assert.deepEqual(plain(off.switch), { field: 'clear_clipboard_on_turn_start', title: '每轮开始时清空剪贴板',
    note: '避免模型粘贴用户此前复制的内容。', checked: false, known: true, enabled: true, change: { kind: 'clipboard.set', on: true } })
  exactKeys(off.switch.change)
  const on = privacyView(snapshot({ privacy: { ...snapshot().privacy, clear_clipboard_on_turn_start: true } })).clipboard.switch
  assert.deepEqual(plain(on.change), { kind: 'clipboard.set', on: false })
})

test('privacy: a stored value that is not a boolean is shown off and held', () => {
  const v = privacyView(snapshot({ privacy: { send_screenshots: 'yes', send_ax_text: null } }))
  assert.deepEqual(v.sent.switches.map((s) => [s.field, s.checked, s.known, s.enabled]), [
    ['send_screenshots', false, false, false], ['send_ax_text', false, false, false],
    ['send_ocr', false, false, false], ['send_zoom', false, false, false]])
  assert.equal(v.clipboard.switch.enabled, false)
  assert.deepEqual(plain(v.textOnly.rows), [])
})

test('privacy: the text-only apps with their names and 移除 sending {kind: text_only.remove, bundle_id}; empty; a long list', () => {
  const v = privacyView()
  assert.equal(v.textOnly.title, '仅文本应用')
  assert.equal(v.textOnly.note, '列表内的应用不发送截图。加入立即生效，移除需验证。')
  assert.deepEqual(plain(v.textOnly.rows), [
    { key: '0:com.apple.Notes', app: { bundle_id: 'com.apple.Notes', name: 'Notes' },
      remove: { label: '移除', enabled: true, change: { kind: 'text_only.remove', bundle_id: 'com.apple.Notes' } } },
    { key: '1:com.example.Secret', app: { bundle_id: 'com.example.Secret', name: null },
      remove: { label: '移除', enabled: true, change: { kind: 'text_only.remove', bundle_id: 'com.example.Secret' } } },
  ])
  exactKeys(v.textOnly.rows[0].remove.change)
  assert.deepEqual(plain(v.textOnly.add), { label: '添加应用…', enabled: true })
  const empty = privacyView(snapshot({ privacy: { ...snapshot().privacy, text_only_apps: [] } }))
  assert.deepEqual(plain(empty.textOnly.rows), [])
  assert.equal(empty.textOnly.empty, '暂无。')
  const ids = Array.from({ length: 60 }, (_, i) => `com.example.app${i}`)
  const long = privacyView(snapshot({ privacy: { ...snapshot().privacy, text_only_apps: [...ids, 42, ''] } }))
  assert.equal(long.textOnly.rows.length, 60, 'only the strings')
  assert.equal(new Set(long.textOnly.rows.map((r) => r.key)).size, 60, 'distinct keys')
})

test('privacy: the picked app is offered only after this tab\'s 添加应用… and a choose_app done settled since, then text_only.add', () => {
  const since = NOW - 5000
  const picked = { bundle_id: 'com.example.Mail', name: 'Mail' }
  const done = { at: SEC - 2, kind: 'choose_app', outcome: 'done' }
  const v = privacyView(snapshot({ picked_app: picked, last_outcome: done }), { pickSince: since })
  assert.deepEqual(plain(v.textOnly.picked), {
    app: picked, text: '已在本机选择以下应用，加入后不再发送其截图：', listed: false, listedText: '该应用已在列表中。',
    add: { label: '加入仅文本应用', enabled: true, change: { kind: 'text_only.add', bundle_id: 'com.example.Mail' } },
    dismiss: '不加入',
  })
  exactKeys(v.textOnly.picked.add.change)
  // Not clicked here, an older pick, another outcome, nothing picked: nothing offered.
  assert.equal(privacyView(snapshot({ picked_app: picked, last_outcome: done })).textOnly.picked, null)
  assert.equal(privacyView(snapshot({ picked_app: picked, last_outcome: { ...done, at: SEC - 60 } }), { pickSince: since }).textOnly.picked, null)
  assert.equal(privacyView(snapshot({ picked_app: picked, last_outcome: { ...done, outcome: 'cancelled' } }), { pickSince: since }).textOnly.picked, null)
  assert.equal(privacyView(snapshot({ picked_app: picked, last_outcome: { ...done, kind: 'import' } }), { pickSince: since }).textOnly.picked, null)
  assert.equal(privacyView(snapshot({ last_outcome: done }), { pickSince: since }).textOnly.picked, null)
  // Already on the list (ignoring case): shown, the add held.
  const again = privacyView(snapshot({ picked_app: { bundle_id: 'COM.apple.notes', name: null }, last_outcome: done }), { pickSince: since })
  assert.equal(again.textOnly.picked.listed, true)
  assert.equal(again.textOnly.picked.add.enabled, false)
  assert.equal(again.textOnly.picked.app.name, 'Notes', 'the name from the snapshot\'s other lists')
  // Held while pending.
  assert.equal(privacyView(snapshot({ picked_app: picked, last_outcome: done }), { pickSince: since, pending: true }).textOnly.picked.add.enabled, false)
})

test('privacy: every control held while pending; before the first snapshot not ready', () => {
  const v = privacyView(snapshot(), { pending: true })
  assert.ok(v.sent.switches.every((s) => s.enabled === false))
  assert.equal(v.clipboard.switch.enabled, false)
  assert.ok(v.textOnly.rows.every((r) => r.remove.enabled === false))
  assert.equal(v.textOnly.add.enabled, false)
  const none = privacyView(null)
  assert.equal(none.ready, false)
  assert.ok(none.sent.switches.every((s) => s.enabled === false))
  assert.equal(none.textOnly.add.enabled, false)
})

test('privacy: the view in English', () => {
  const v = privacy.buildPrivacyView(snapshot(), { t: translator(EN), pending: false })
  assert.equal(v.sent.switches[1].title, 'UI text')
  assert.equal(v.textOnly.add.label, 'Add app…')
  assert.equal(v.clipboard.switch.title, 'Empty the clipboard when a turn starts')
})

// --- render, through a Kit that records what each piece was given ---

function recordingKit(state = []) {
  const h = (type, props, ...children) => ({ type, props: { ...props, children } })
  const el = (type, spec, children = []) => ({ type, props: { ...spec, children } })
  let hook = 0
  const sets = []
  return {
    sets,
    h, useState: (v) => { const i = hook++; return [i < state.length ? state[i] : v, (next) => sets.push([i, next])] },
    useEffect: () => {}, styles: new Proxy({}, { get: () => ({}) }),
    button: (spec) => el('button', spec, [spec.label]),
    tag: (text, tone) => el('tag', { tone }, [text]),
    dot: (state) => el('dot', { state }),
    appLabel: (app) => el('app', { app }, [app.name ?? app.bundle_id, app.bundle_id]),
    list: (spec) => el('list', spec, spec.rows.length === 0 ? [spec.empty] : spec.rows),
    confirm: () => null,
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

function render(module, s, { pending = false, state = [], result = true } = {}) {
  const applied = []
  const actions = []
  const props = {
    snapshot: s, t, pending, now: NOW,
    apply: async (c) => { applied.push(c); return result },
    action: async (name) => { actions.push(name); return result },
    goTo: () => {},
  }
  const kit = recordingKit(state)
  return { tree: module.tab.render(props, kit), applied, actions, sets: kit.sets }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('render access: each segmented control sends its offered value\'s change, the shown value and 完全放权 nothing; held while pending', () => {
  assert.equal(access.tab.id, 'access')
  const { tree, applied } = render(access, snapshot())
  const controls = find(tree, (e) => e.type === 'segmented')
  assert.deepEqual(controls.map((c) => [c.props.id, c.props.value, c.props.disabled]), [
    ['cu-runtime-access-default_mode', 'ask', false], ['cu-runtime-access-session_limit_minutes', '30', false],
    ['cu-runtime-access-dialogs_per_turn', '2', false], ['cu-runtime-access-dialog_timeout_seconds', '120', false],
    ['cu-runtime-access-dialog_default', 'deny', false]])
  assert.deepEqual(plain(controls[0].props.options), [{ value: 'ask', label: '每次询问', disabled: false },
    { value: 'read', label: '浏览', disabled: false }, { value: 'full', label: '可操作', disabled: false },
    { value: 'max', label: '完全放权', disabled: true }])
  controls[0].props.onChange('ask')
  controls[0].props.onChange('max')
  controls[0].props.onChange('nonsense')
  assert.deepEqual(applied, [], 'the shown value, 完全放权 and an unknown value send nothing')
  controls[0].props.onChange('full')
  controls[1].props.onChange('60')
  controls[2].props.onChange('1')
  controls[3].props.onChange('180')
  controls[4].props.onChange('session')
  assert.deepEqual(plain(applied), [
    { kind: 'access.set', field: 'default_mode', value: 'full' },
    { kind: 'access.set', field: 'session_limit_minutes', value: 60 },
    { kind: 'access.set', field: 'dialogs_per_turn', value: 1 },
    { kind: 'access.set', field: 'dialog_timeout_seconds', value: 180 },
    { kind: 'access.set', field: 'dialog_default', value: 'session' },
  ])
  const held = render(access, snapshot(), { pending: true })
  const heldControls = find(held.tree, (e) => e.type === 'segmented')
  assert.ok(heldControls.every((c) => c.props.disabled === true))
  for (const c of heldControls) for (const o of c.props.options) c.props.onChange(o.value)
  assert.deepEqual(held.applied, [], 'nothing sent while pending, even if the control fires')
})

test('render access: the tiers, the notes and lock hints, the fixed rules; no choices offered says so; before the first snapshot', () => {
  const { tree } = render(access, snapshot())
  const words = texts(tree)
  for (const text of ['档位与默认', '浏览', '可操作', '完全放权', '尚未提供', '新会话默认', '默认档位', '提高需验证 · 完全放权不能设为默认',
    '延长需验证', '增加需验证', '拒绝以外需验证', '超时处理', '倒计时结束按拒绝处理。', '固定规则（不能在设置里改）',
    '模型仅在被拒绝后可附理由申请一次；同一次拒绝只能申请一次。']) {
    assert.ok(words.includes(text), text)
  }
  assert.equal(find(tree, (e) => e.props?.['data-lock'] !== undefined).length, 4)
  assert.equal(find(tree, (e) => e.props?.['data-tier'] !== undefined).length, 3)
  const bare = render(access, snapshot({ access_choices: {} })).tree
  assert.equal(find(bare, (e) => e.type === 'segmented').length, 0)
  assert.equal(texts(bare).filter((w) => w === '守护进程未提供可选值。').length, 5)
  const waiting = render(access, null).tree
  assert.equal(find(waiting, (e) => e.type === 'segmented').length, 0)
  assert.ok(texts(waiting).includes('查看、点击、滚动'))
})

test('render privacy: each switch sends its change when turned over, nothing when unchanged; held while pending', () => {
  assert.equal(privacy.tab.id, 'privacy')
  const { tree, applied } = render(privacy, snapshot())
  const switches = find(tree, (e) => e.type === 'switch')
  assert.deepEqual(switches.map((s) => [s.props.label, s.props.checked, s.props.disabled]), [
    ['截图', true, false], ['界面文本', false, false], ['本地识别文本（OCR）', true, false], ['局部放大图', true, false],
    ['每轮开始时清空剪贴板', false, false]])
  switches[0].props.onChange(true)
  assert.deepEqual(applied, [], 'the stored value sends nothing')
  switches[0].props.onChange(false)
  switches[1].props.onChange(true)
  switches[2].props.onChange(false)
  switches[3].props.onChange(false)
  switches[4].props.onChange(true)
  assert.deepEqual(plain(applied), [
    { kind: 'privacy.set', field: 'send_screenshots', on: false },
    { kind: 'privacy.set', field: 'send_ax_text', on: true },
    { kind: 'privacy.set', field: 'send_ocr', on: false },
    { kind: 'privacy.set', field: 'send_zoom', on: false },
    { kind: 'clipboard.set', on: true },
  ])
  const held = render(privacy, snapshot(), { pending: true })
  const heldSwitches = find(held.tree, (e) => e.type === 'switch')
  assert.ok(heldSwitches.every((s) => s.props.disabled === true))
  for (const s of heldSwitches) s.props.onChange(!s.props.checked)
  assert.ok(find(held.tree, (e) => e.type === 'button').every((b) => b.props.disabled === true))
  assert.deepEqual(held.applied, [])
})

test('render privacy: the text-only list in the limited-height list, 移除 sends text_only.remove; 添加应用… runs choose_app', async () => {
  const { tree, applied, actions, sets } = render(privacy, snapshot())
  const [list] = find(tree, (e) => e.type === 'list')
  assert.equal(list.props.label, '仅文本应用')
  assert.equal(list.props.rows.length, 2)
  const removes = find(tree, (e) => e.type === 'button' && e.props.label === '移除')
  removes[1].props.onClick()
  assert.deepEqual(plain(applied), [{ kind: 'text_only.remove', bundle_id: 'com.example.Secret' }])
  const before = Date.now()
  find(tree, (e) => e.type === 'button' && e.props.label === '添加应用…')[0].props.onClick()
  await settle()
  assert.deepEqual(actions, ['choose_app'])
  assert.equal(sets.length, 1, 'remembers when it was clicked')
  assert.ok(sets[0][1] >= before && sets[0][1] <= Date.now())
  // Refused (busy, not running): nothing remembered.
  const refused = render(privacy, snapshot(), { result: false })
  find(refused.tree, (e) => e.type === 'button' && e.props.label === '添加应用…')[0].props.onClick()
  await settle()
  assert.deepEqual(refused.sets, [])
  // Empty.
  const empty = render(privacy, snapshot({ privacy: { ...snapshot().privacy, text_only_apps: [] } })).tree
  assert.ok(texts(empty).includes('暂无。'))
})

test('render privacy: the picked app with 加入仅文本应用 sending text_only.add, then forgotten; 不加入 forgets it', async () => {
  const s = snapshot({ picked_app: { bundle_id: 'com.example.Mail', name: 'Mail' }, last_outcome: { at: SEC, kind: 'choose_app', outcome: 'done' } })
  const shown = render(privacy, s, { state: [NOW - 3000] })
  assert.equal(find(shown.tree, (e) => e.props?.['data-picked-app'] === 'com.example.Mail').length, 1)
  assert.ok(texts(shown.tree).includes('Mail'))
  find(shown.tree, (e) => e.type === 'button' && e.props.label === '加入仅文本应用')[0].props.onClick()
  await settle()
  assert.deepEqual(plain(shown.applied), [{ kind: 'text_only.add', bundle_id: 'com.example.Mail' }])
  assert.deepEqual(shown.sets, [[0, null]])
  find(shown.tree, (e) => e.type === 'button' && e.props.label === '不加入')[0].props.onClick()
  assert.deepEqual(shown.sets, [[0, null], [0, null]])
  // A refused add keeps it shown.
  const refused = render(privacy, s, { state: [NOW - 3000], result: false })
  find(refused.tree, (e) => e.type === 'button' && e.props.label === '加入仅文本应用')[0].props.onClick()
  await settle()
  assert.deepEqual(refused.sets, [])
  // Not clicked on this tab: nothing offered.
  assert.equal(find(render(privacy, s).tree, (e) => e.props?.['data-picked-app'] !== undefined).length, 0)
})

test('render privacy: the lock hint and notes; no dsh-session card; before the first snapshot only the title and note', () => {
  const { tree } = render(privacy, snapshot())
  const words = texts(tree)
  for (const text of ['发送内容', '关闭立即生效 · 开启需验证', '仅包含已授权应用窗口，其余区域遮蔽。关闭后仅发送文本。', '剪贴板', 'Notes', 'com.example.Secret']) {
    assert.ok(words.includes(text), text)
  }
  assert.deepEqual(find(tree, (e) => e.type === 'card').map((c) => c.props.title), ['发送内容', '剪贴板'])
  assert.deepEqual(texts(render(privacy, null).tree), ['隐私与审计', ZH['settings.privacy.note']])
})

// --- the locale (the shared locale test checks keys and prefixes; this checks these files' own) ---

test('the two tabs\' locale files: the same keys, no stub line left, no 你/您, every key the tabs use exists', () => {
  for (const name of ['access', 'privacy']) {
    const { zh, en } = settingsLocale.LOCALE_FILES[name]
    assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), name)
    assert.ok(!Object.hasOwn(zh, `settings.${name}.notYet`), `${name}: the stub's line is gone`)
    for (const text of Object.values(zh)) assert.doesNotMatch(text, /[你您]/)
  }
  // The builders above ran through translators that fail on a missing key in zh and en; the renders (zh) too.
  render(access, snapshot())
  render(privacy, snapshot({ picked_app: { bundle_id: 'a.b', name: null }, last_outcome: { at: SEC, kind: 'choose_app', outcome: 'done' } }), { state: [NOW] })
})
