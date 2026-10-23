// The 应用名单 (App lists) and 快捷键 (Shortcuts) settings tabs (plugin/src/client/settings/tabs/apps.ts and
// shortcuts.ts), ported from the native pages: their view builders (the lists from a snapshot, the choices offered,
// empty and long lists, the change each control sends, every control held while pending) and their render through a
// recording Kit with working hooks (the add flows: choose_app, the picked app, the forms, exactly the change sent).
// Loads the compiled CommonJS modules from a build into a temporary directory, removed afterwards.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENTRY, ROOT } from '../../scripts/build-client.mjs'

const dir = mkdtempSync(join(tmpdir(), 'cu-settings-apps-shortcuts-'))
after(() => rmSync(dir, { recursive: true, force: true }))
execFileSync(process.execPath, [join(ROOT, 'scripts/build-client.mjs'), '--out', join(dir, 'client.js'), '--cjs', join(dir, 'cjs')],
  { stdio: ['ignore', 'pipe', 'pipe'] })
const compiled = createRequire(join(dir, 'cjs', ENTRY))
const apps = compiled('./settings/tabs/apps.js')
const shortcuts = compiled('./settings/tabs/shortcuts.js')
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
const ADDED = new Date(2026, 8, 3, 9, 5, 0).getTime() / 1000

const BUILTIN = ['cmd+a', 'cmd+c', 'shift+cmd+z', 'cmd+q', 'opt+left']
const NEVER_SORTED = ['cmd+space', 'cmd+tab', 'ctrl+cmd+q', 'ctrl+f2', 'opt+cmd+escape', 'shift+cmd+3']

function snapshot(over = {}) {
  return readSnapshot({
    started_at: SEC - 3600,
    grants: [],
    persistent: [
      { bundle_id: 'com.apple.TextEdit', name: 'TextEdit', mode: 'full', added_at: ADDED, signature_ok: true },
      { bundle_id: 'com.example.Viewer', name: null, mode: 'read', added_at: ADDED, signature_ok: false },
      { bundle_id: 'com.example.Old', name: 'Old', mode: 'max', signature_ok: null },
    ],
    denylist: [
      { bundle_id: 'com.example.Chat', name: 'Chat', note: 'work chat' },
      { bundle_id: 'com.example.Bank', name: null, note: '' },
    ],
    hard_deny: [
      { bundle_id: 'com.apple.systempreferences', name: 'System Settings', category: 'systemUI' },
      { bundle_id: 'com.apple.Terminal', name: null, category: 'runsCode' },
      { namespace: 'com.apple.loginwindow', name: null, category: 'systemUI' },
      { bundle_id: 'com.apple.keychainaccess', name: 'Keychain Access', category: 'authentication' },
      { bundle_id: 'com.example.future', name: null, category: 'brandNew' },
    ],
    access: { default_mode: 'ask' }, access_choices: {},
    chords: {
      builtin: BUILTIN.map((chord) => ({ chord, enabled: chord !== 'cmd+q' })),
      never: NEVER_SORTED,
      custom: [
        { chord: 'shift+cmd+k', app: null, note: 'clear' },
        { chord: 'ctrl+opt+b', app: 'com.apple.TextEdit', note: '' },
        { chord: 'cmd+e', app: 'com.example.unnamed', note: 'x' },
      ],
    },
    privacy: {}, behavior: {}, logs: {},
    recent_refusals: [], recent_changes: [],
    permissions: null, pending: null, last_outcome: null, picked_app: null, import_preview: null, panel: null,
    ...over,
  })
}

const plain = (v) => JSON.parse(JSON.stringify(v))
const keysOf = (change) => Object.keys(change).filter((k) => k !== 'kind').sort()
/** A change has exactly the daemon's keys for its kind (change.ts CHANGE_KEYS, the daemon's SettingsChange.keys). */
const exact = (change) => assert.deepEqual(keysOf(change), [...CHANGE_KEYS[change.kind]].sort(), change.kind)

const appsView = (s = snapshot(), options = {}) => apps.buildAppsView(s, { t, pending: false, ...options })
const chordsView = (s = snapshot(), options = {}) => shortcuts.buildShortcutsView(s, { t, pending: false, ...options })

// --- 应用名单: the view ---

test('apps before the first snapshot: only the title and note, nothing listed', () => {
  const v = appsView(null)
  assert.equal(v.ready, false)
  assert.equal(v.title, '应用名单')
  assert.deepEqual(plain(v.always.rows), [])
  assert.deepEqual(plain(v.deny.rows), [])
  assert.deepEqual(plain(v.floor.groups), [])
})

test('始终允许: name over bundle ID, mode, added, signature; reapprove only while the signature changed', () => {
  const rows = appsView().always.rows
  assert.deepEqual(plain(rows.map(({ changeMode, remove, reapprove, ...r }) => r)), [
    { key: 'com.apple.TextEdit', app: { bundle_id: 'com.apple.TextEdit', name: 'TextEdit' }, mode: { text: '可操作', tone: 'warning' },
      added: '加入于 2026-09-03 09:05', signature: { state: 'ok', text: '签名匹配', tone: 'success' } },
    { key: 'com.example.Viewer', app: { bundle_id: 'com.example.Viewer', name: null }, mode: { text: '浏览', tone: 'info' },
      added: '加入于 2026-09-03 09:05', signature: { state: 'changed', text: '签名已变化 · 已作废', tone: 'warning' } },
    { key: 'com.example.Old', app: { bundle_id: 'com.example.Old', name: 'Old' }, mode: { text: 'max', tone: 'neutral' },
      added: '加入于 —', signature: { state: 'unknown', text: '签名未核对', tone: 'quiet' } },
  ])
  assert.deepEqual(rows.map((r) => r.reapprove === null), [true, false, true])
  assert.deepEqual(plain(rows[1].reapprove), { label: '重新批准', enabled: true,
    change: { kind: 'persistent.reapprove', bundle_id: 'com.example.Viewer' } })
  assert.deepEqual(plain(rows[0].remove), { label: '移除', enabled: true, change: { kind: 'persistent.remove', bundle_id: 'com.apple.TextEdit' } })
  assert.deepEqual(plain(rows[0].changeMode), { label: '改档位', value: 'full', enabled: true, options: [
    { value: 'read', label: '浏览', change: { kind: 'persistent.mode', bundle_id: 'com.apple.TextEdit', mode: 'read' } },
    { value: 'full', label: '可操作', change: { kind: 'persistent.mode', bundle_id: 'com.apple.TextEdit', mode: 'full' } },
  ] })
  for (const r of rows) {
    for (const change of [r.remove.change, r.reapprove?.change, ...r.changeMode.options.map((o) => o.change)]) if (change) exact(change)
  }
  assert.equal(appsView(snapshot({ persistent: [] })).always.empty, '名单是空的。')
})

test('黑名单: each app with its note (— without one) and 移出; 系统底线 by category, namespaces as prefix.*', () => {
  const v = appsView()
  assert.deepEqual(plain(v.deny.rows), [
    { key: 'com.example.Chat', app: { bundle_id: 'com.example.Chat', name: 'Chat' }, note: 'work chat', hasNote: true,
      remove: { label: '移出', enabled: true, change: { kind: 'deny.remove', bundle_id: 'com.example.Chat' } } },
    { key: 'com.example.Bank', app: { bundle_id: 'com.example.Bank', name: null }, note: '—', hasNote: false,
      remove: { label: '移出', enabled: true, change: { kind: 'deny.remove', bundle_id: 'com.example.Bank' } } },
  ])
  exact(v.deny.rows[0].remove.change)
  assert.equal(appsView(snapshot({ denylist: [] })).deny.empty, '黑名单是空的。')
  assert.equal(v.floor.count, '5 项')
  assert.deepEqual(plain(v.floor.groups.map((g) => [g.id, g.title, g.items.map((i) => [i.text, i.id])])), [
    ['systemUI', '系统界面', [['System Settings', 'com.apple.systempreferences'], ['com.apple.loginwindow.*', 'com.apple.loginwindow.*']]],
    ['authentication', '认证与密钥', [['Keychain Access', 'com.apple.keychainaccess']]],
    ['runsCode', '可执行代码', [['com.apple.Terminal', 'com.apple.Terminal']]],
    ['other', '其他', [['com.example.future', 'com.example.future']]],
  ])
  assert.equal(appsView(snapshot({ hard_deny: [] })).floor.groups.length, 0)
})

test('apps: every change control is held while pending, and so are the add buttons', () => {
  const v = appsView(snapshot(), { pending: true, forms: { always: { app: { bundle_id: 'a.b', name: null }, mode: 'read' }, deny: { id: 'c.d', note: '' }, waiting: null } })
  for (const r of v.always.rows) {
    assert.equal(r.remove.enabled, false)
    assert.equal(r.changeMode.enabled, false)
    if (r.reapprove) assert.equal(r.reapprove.enabled, false)
  }
  assert.ok(v.deny.rows.every((r) => r.remove.enabled === false))
  assert.equal(v.always.add.enabled, false)
  assert.equal(v.deny.add.enabled, false)
  assert.equal(v.always.form.submit.enabled, false)
  assert.equal(v.always.form.chooseAgain.enabled, false)
  assert.equal(v.deny.form.submit.enabled, false)
  assert.equal(v.deny.form.chooseApp.enabled, false)
})

test('the always form: the picked app and the mode chosen give persistent.add; the deny form trims and checks the bundle ID', () => {
  const app = { bundle_id: 'com.apple.Notes', name: 'Notes' }
  const v = appsView(snapshot(), { forms: { always: { app, mode: 'full' }, deny: null, waiting: null } })
  assert.deepEqual(plain(v.always.form.app), app)
  assert.deepEqual(plain(v.always.form.modes), [{ value: 'read', label: '浏览' }, { value: 'full', label: '可操作' }])
  assert.deepEqual(plain(v.always.form.submit), { label: '加入', enabled: true, change: { kind: 'persistent.add', bundle_id: 'com.apple.Notes', mode: 'full' } })
  exact(v.always.form.submit.change)
  assert.equal(v.always.add.enabled, false, 'one always form at a time')

  const deny = (id, note = '') => appsView(snapshot(), { forms: { always: null, deny: { id, note }, waiting: null } }).deny.form.submit
  assert.deepEqual(plain(deny('  com.example.Mail ', '  spam  ')), { label: '加入', enabled: true,
    change: { kind: 'deny.add', bundle_id: 'com.example.Mail', note: 'spam' } })
  assert.deepEqual(plain(deny('com.example.Mail').change), { kind: 'deny.add', bundle_id: 'com.example.Mail', note: '' }, 'note always present')
  exact(deny('com.example.Mail').change)
  for (const bad of ['', '   ', 'com.example Mail', 'a\u0007b', 'x'.repeat(256)]) assert.equal(deny(bad).enabled, false, JSON.stringify(bad))
  assert.equal(deny('x'.repeat(255)).enabled, true)
  assert.equal(deny('a.b', 'n'.repeat(201)).enabled, false)
  assert.equal(deny('a.b', 'n'.repeat(200)).enabled, true)
  // While a form waits for the daemon's panel, nothing else asks it for an app.
  const waiting = appsView(snapshot(), { forms: { always: null, deny: { id: '', note: '' }, waiting: 'deny' } })
  assert.equal(waiting.deny.waiting, ZH['settings.apps.waiting'])
  assert.equal(waiting.deny.form.chooseApp.enabled, false)
  assert.equal(waiting.always.add.enabled, false)
})

test('pickOutcome: only a choose_app settled at or after the ask counts; an older pick is never taken', () => {
  const picked = { bundle_id: 'com.apple.Notes', name: 'Notes' }
  const at = (outcome, when, app = picked) => snapshot({ picked_app: app, last_outcome: { at: when, kind: 'choose_app', outcome } })
  assert.deepEqual(plain(apps.pickOutcome(at('done', SEC + 2), SEC)), { status: 'picked', app: picked })
  assert.deepEqual(plain(apps.pickOutcome(at('done', SEC), SEC)), { status: 'picked', app: picked })
  assert.deepEqual(plain(apps.pickOutcome(at('done', SEC - 5), SEC)), { status: 'waiting' }, 'an earlier pick')
  assert.deepEqual(plain(apps.pickOutcome(at('cancelled', SEC + 2), SEC)), { status: 'ended' })
  assert.deepEqual(plain(apps.pickOutcome(at('refused', SEC + 2), SEC)), { status: 'ended' })
  assert.deepEqual(plain(apps.pickOutcome(snapshot({ picked_app: picked, last_outcome: { at: SEC + 2, kind: 'reset', outcome: 'applied' } }), SEC)),
    { status: 'waiting' }, 'another outcome')
  assert.deepEqual(plain(apps.pickOutcome(null, SEC)), { status: 'waiting' })
})

test('apps: a long list stays one list (the Kit limits its height); the view in English', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ bundle_id: `com.example.app${i}`, name: null, note: '' }))
  assert.equal(appsView(snapshot({ denylist: many })).deny.rows.length, 60)
  const v = apps.buildAppsView(snapshot(), { t: translator(EN), pending: false })
  assert.equal(v.always.rows[1].signature.text, 'Signature changed · void')
  assert.equal(v.always.rows[0].mode.text, 'Operate')
  assert.equal(v.floor.count, '5 entries')
})

// --- 快捷键: the view ---

test('chordCaps: one cap per modifier in the Mac order, then the key; text it cannot split stays one cap', () => {
  assert.deepEqual(shortcuts.chordCaps('cmd+shift+k'), ['⇧', '⌘', 'K'])
  assert.deepEqual(shortcuts.chordCaps('shift+cmd+left'), ['⇧', '⌘', '←'])
  assert.deepEqual(shortcuts.chordCaps('Option+Control+Esc'), ['⌃', '⌥', '⎋'])
  assert.deepEqual(shortcuts.chordCaps('cmd+delete'), ['⌘', '⌫'])
  assert.deepEqual(shortcuts.chordCaps('ctrl+f2'), ['⌃', 'F2'])
  assert.deepEqual(shortcuts.chordCaps('cmd+'), ['cmd+'])
  assert.deepEqual(shortcuts.chordCaps('cmd+a+b'), ['cmd+a+b'])
  assert.deepEqual(shortcuts.chordCaps('cmd'), ['cmd'])
})

test('内置允许: one switch per chord in the daemon order; off sends chord.disable, on chord.enable; held while pending', () => {
  const rows = chordsView().builtin.rows
  assert.deepEqual(plain(rows.map((r) => [r.chord, r.label, r.on, r.off, r.caps])), [
    ['cmd+a', '全选', true, null, ['⌘', 'A']],
    ['cmd+c', '拷贝', true, null, ['⌘', 'C']],
    ['shift+cmd+z', '重做', true, null, ['⇧', '⌘', 'Z']],
    ['cmd+q', '退出应用', false, '已停用', ['⌘', 'Q']],
    ['opt+left', '按词移动', true, null, ['⌥', '←']],
  ])
  assert.deepEqual(plain(rows[0].toggle), { enabled: true, change: { kind: 'chord.disable', chord: 'cmd+a' } })
  assert.deepEqual(plain(rows[3].toggle), { enabled: true, change: { kind: 'chord.enable', chord: 'cmd+q' } })
  for (const r of rows) exact(r.toggle.change)
  assert.ok(chordsView(snapshot(), { pending: true }).builtin.rows.every((r) => r.toggle.enabled === false))
  const unknown = chordsView(snapshot({ chords: { builtin: [{ chord: 'cmd+k', enabled: true }], never: [], custom: [] } })).builtin.rows[0]
  assert.equal(unknown.label, 'cmd+k', 'a chord without words reads as itself')
})

test('永不允许: read-only, in the readable order, with the F-key and fn rules; 自定义: scope, note, chord.remove with its app', () => {
  const v = chordsView()
  assert.deepEqual(plain(v.never.rows.map((r) => [r.chord, r.label])), [
    ['ctrl+cmd+q', '锁屏'], ['opt+cmd+escape', '强制退出'], ['cmd+space', '聚焦'], ['cmd+tab', '切换应用'],
    ['shift+cmd+3', '截屏'], ['ctrl+f2', '焦点到菜单栏'],
  ])
  assert.ok(v.never.rows.every((r) => !('toggle' in r) && !('remove' in r)), 'nothing to change')
  assert.deepEqual(plain(v.never.rules), ['F1–F12 功能键', 'fn 组合键'])
  const odd = chordsView(snapshot({ chords: { builtin: [], never: ['cmd+tab', 'zz+cmd', 'ctrl+cmd+q'], custom: [] } })).never.rows
  assert.deepEqual(odd.map((r) => r.chord), ['ctrl+cmd+q', 'cmd+tab', 'zz+cmd'], 'one the page does not know goes last')

  assert.deepEqual(plain(v.custom.rows.map(({ remove, key, ...r }) => r)), [
    { chord: 'shift+cmd+k', caps: ['⇧', '⌘', 'K'], note: 'clear', hasNote: true, app: null, scope: '所有已授权应用' },
    { chord: 'ctrl+opt+b', caps: ['⌃', '⌥', 'B'], note: '—', hasNote: false, app: { bundle_id: 'com.apple.TextEdit', name: 'TextEdit' }, scope: '仅 TextEdit' },
    { chord: 'cmd+e', caps: ['⌘', 'E'], note: 'x', hasNote: true, app: { bundle_id: 'com.example.unnamed', name: null }, scope: '仅 com.example.unnamed' },
  ])
  assert.deepEqual(plain(v.custom.rows.map((r) => r.remove.change)), [
    { kind: 'chord.remove', chord: 'shift+cmd+k', app: null },
    { kind: 'chord.remove', chord: 'ctrl+opt+b', app: 'com.apple.TextEdit' },
    { kind: 'chord.remove', chord: 'cmd+e', app: 'com.example.unnamed' },
  ])
  for (const r of v.custom.rows) exact(r.remove.change)
  assert.equal(new Set(v.custom.rows.map((r) => r.key)).size, 3)
  assert.ok(chordsView(snapshot(), { pending: true }).custom.rows.every((r) => r.remove.enabled === false))
  const none = chordsView(snapshot({ chords: { builtin: [], never: [], custom: [] } }))
  assert.equal(none.custom.empty, '还没有自定义快捷键。')
  assert.equal(none.builtin.rows.length, 0)
})

test('the add form: chord typed, every app (null) or one app, note always present; checked as the daemon takes them', () => {
  const submit = (form, options = {}) => chordsView(snapshot(), { form: { ...shortcuts.EMPTY_CHORD_FORM, ...form }, ...options }).form.submit
  assert.deepEqual(plain(submit({ chord: ' cmd+shift+k ' })), { label: '加入', enabled: true,
    change: { kind: 'chord.add', chord: 'cmd+shift+k', app: null, note: '' } })
  assert.deepEqual(plain(submit({ chord: 'cmd+e', scope: 'one', app: ' com.apple.TextEdit ', note: ' bold ' }).change),
    { kind: 'chord.add', chord: 'cmd+e', app: 'com.apple.TextEdit', note: 'bold' })
  assert.deepEqual(plain(submit({ chord: 'cmd+e', scope: 'all', app: 'com.apple.TextEdit' }).change).app, null, 'every app ignores a typed app')
  exact(submit({ chord: 'cmd+e' }).change)
  exact(submit({ chord: 'cmd+e', scope: 'one', app: 'a.b' }).change)
  assert.equal(submit({ chord: '' }).enabled, false)
  assert.equal(submit({ chord: '   ' }).enabled, false)
  assert.equal(submit({ chord: 'k'.repeat(65) }).enabled, false)
  assert.equal(submit({ chord: 'cmd+e', scope: 'one', app: '' }).enabled, false, 'one app needs a bundle ID')
  assert.equal(submit({ chord: 'cmd+e', scope: 'one', app: 'a b' }).enabled, false)
  assert.equal(submit({ chord: 'cmd+e', note: 'n'.repeat(201) }).enabled, false)
  assert.equal(submit({ chord: 'cmd+e' }, { pending: true }).enabled, false)
  // The page decides nothing about the chord itself: the daemon refuses a reserved or built-in one.
  assert.equal(submit({ chord: 'cmd+tab' }).enabled, true)
  const v = chordsView(snapshot(), { form: { ...shortcuts.EMPTY_CHORD_FORM, chord: 'cmd+shift+k' } })
  assert.deepEqual(plain(v.form.caps), ['⇧', '⌘', 'K'])
  assert.equal(v.form.app, null)
  assert.deepEqual(plain(v.form.scopes), [{ value: 'all', label: '所有已授权应用' }, { value: 'one', label: '仅一个应用' }])
  assert.equal(v.custom.add.enabled, false, 'one form at a time')
  const one = chordsView(snapshot(), { form: { ...shortcuts.EMPTY_CHORD_FORM, scope: 'one' }, waiting: true })
  assert.equal(one.form.app.chooseApp.enabled, false)
  assert.equal(one.form.waiting, ZH['settings.shortcuts.form.waiting'])
})

test('every chord with words has them in zh and en, and the never-allowed order names only labelled chords', () => {
  const keys = Object.keys(settingsLocale.LOCALE_FILES.shortcuts.zh).filter((k) => k.startsWith('settings.shortcuts.label.'))
  assert.deepEqual(keys.map((k) => k.slice('settings.shortcuts.label.'.length)).sort(), [...shortcuts.CHORD_LABELS].sort())
  for (const chord of shortcuts.NEVER_ORDER) assert.ok(shortcuts.CHORD_LABELS.includes(chord), chord)
  const v = shortcuts.buildShortcutsView(snapshot(), { t: translator(EN), pending: false })
  assert.equal(v.builtin.rows[2].label, 'redo')
  assert.equal(v.custom.rows[1].scope, 'TextEdit only')
})

// --- render, through a recording Kit with working hooks ---

function recordingKit(hooks) {
  const h = (type, props, ...children) => ({ type, props: { ...props, children } })
  const el = (type, spec, children = []) => ({ type, props: { ...spec, children } })
  return {
    h, useState: hooks.useState, useEffect: hooks.useEffect, styles: new Proxy({}, { get: () => ({}) }),
    button: (spec) => el('button', spec, [spec.label]),
    tag: (text, tone) => el('tag', { tone }, [text]),
    dot: (state) => el('dot', { state }),
    appLabel: (app) => el('app', { app }, [app.name ?? app.bundle_id, app.bundle_id]),
    list: (spec) => el('list', spec, spec.rows.length === 0 ? [spec.empty] : spec.rows),
    confirm: () => null,
    card: (spec) => el('card', spec, [spec.title, spec.note ?? null, spec.trailing ?? null, ...spec.children]),
    switch: (spec) => el('switch', spec, [spec.label]), segmented: (spec) => el('segmented', spec), input: (spec) => el('input', spec),
    disclosure: (spec) => el('disclosure', spec, spec.children), keys: (keys) => el('keys', { keys }, [...keys]), toast: (spec) => el('toast', spec),
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

/**
 * Mounts a tab: its hooks keep their state between draws (useState by call order, useEffect run after a draw when
 * its deps changed), every draw after a state change or `update(snapshot)`. apply and action record what they got
 * and resolve with `answer` (true unless set).
 */
function mount(module, s, { pending = false } = {}) {
  const state = []
  const deps = []
  let effects = []
  let cursor = 0
  let effectCursor = 0
  let dirty = false
  const hooks = {
    useState(initial) {
      const i = cursor++
      if (!(i in state)) state[i] = initial
      return [state[i], (next) => { state[i] = typeof next === 'function' ? next(state[i]) : next; dirty = true }]
    },
    useEffect(effect, list) {
      const i = effectCursor++
      const before = deps[i]
      if (before === undefined || list.length !== before.length || list.some((d, j) => !Object.is(d, before[j]))) {
        deps[i] = list
        effects.push(effect)
      }
    },
  }
  const kit = recordingKit(hooks)
  const page = {
    applied: [], actions: [], answer: true, snapshot: s, pending, tree: null,
    draw() {
      for (let round = 0; round < 10; round++) {
        cursor = 0
        effectCursor = 0
        effects = []
        dirty = false
        page.tree = module.tab.render({
          snapshot: page.snapshot, t, pending: page.pending, now: NOW,
          apply: async (c) => { page.applied.push(c); return page.answer },
          action: async (name) => { page.actions.push(name); return page.answer },
          goTo: () => {},
        }, kit)
        for (const effect of effects) effect()
        if (!dirty) return page.tree
      }
      throw new Error('the tab keeps changing its state')
    },
    update(next) { page.snapshot = next; return page.draw() },
    async settle() { await new Promise((r) => setImmediate(r)); return page.draw() },
    buttons: (label) => find(page.tree, (e) => e.type === 'button' && e.props.label === label),
    button: (label) => {
      const [b] = page.buttons(label)
      assert.ok(b, `a button ${label}`)
      return b
    },
    the: (type, label) => {
      const [e] = find(page.tree, (n) => n.type === type && n.props.label === label)
      assert.ok(e, `a ${type} ${label}`)
      return e
    },
  }
  page.draw()
  return page
}

const picked = (app, at = SEC + 1) => snapshot({ picked_app: app, last_outcome: { at, kind: 'choose_app', outcome: 'done' } })

test('render apps: 改档位, 重新批准, 移除 and 移出 send their row\'s change; choosing the current mode sends nothing', () => {
  assert.equal(apps.tab.id, 'apps')
  const page = mount(apps, snapshot())
  const modes = find(page.tree, (e) => e.type === 'segmented' && e.props.label === '改档位')
  assert.equal(modes.length, 3)
  modes[0].props.onChange('full')
  modes[0].props.onChange('read')
  page.button('重新批准').props.onClick()
  page.buttons('移除')[2].props.onClick()
  page.buttons('移出')[1].props.onClick()
  assert.deepEqual(plain(page.applied), [
    { kind: 'persistent.mode', bundle_id: 'com.apple.TextEdit', mode: 'read' },
    { kind: 'persistent.reapprove', bundle_id: 'com.example.Viewer' },
    { kind: 'persistent.remove', bundle_id: 'com.example.Old' },
    { kind: 'deny.remove', bundle_id: 'com.example.Bank' },
  ])
  assert.equal(page.buttons('重新批准').length, 1, 'only the row whose signature changed')
  const lists = find(page.tree, (e) => e.type === 'list')
  assert.deepEqual(lists.map((l) => [l.props.label, l.props.rows.length]), [['始终允许', 3], ['黑名单', 2], ['系统底线', 4]])
  for (const word of ['TextEdit', 'com.apple.TextEdit', '签名已变化 · 已作废', '加入于 2026-09-03 09:05', 'work chat', '5 项',
    'System Settings', 'com.apple.loginwindow.*', '认证与密钥']) {
    assert.ok(texts(page.tree).includes(word), word)
  }
})

test('render apps: held while pending, every control that changes something', () => {
  const page = mount(apps, snapshot(), { pending: true })
  for (const label of ['移除', '移出', '重新批准', '添加到始终允许…', '添加到黑名单…']) {
    for (const b of page.buttons(label)) assert.equal(b.props.disabled, true, label)
  }
  assert.ok(find(page.tree, (e) => e.type === 'segmented').every((s) => s.props.disabled === true))
  const empty = mount(apps, null)
  assert.deepEqual(texts(empty.tree), ['应用名单', ZH['settings.apps.note']])
})

test('render apps: add to always runs choose_app, the app picked after it opens the form, the mode chosen goes in persistent.add', async () => {
  const notes = { bundle_id: 'com.apple.Notes', name: 'Notes' }
  // An earlier pick in the snapshot is not taken for this one.
  const page = mount(apps, picked({ bundle_id: 'com.example.Earlier', name: null }, SEC - 30))
  page.button('添加到始终允许…').props.onClick()
  assert.deepEqual(page.actions, ['choose_app'])
  await page.settle()
  assert.ok(texts(page.tree).includes(ZH['settings.apps.waiting']))
  assert.equal(find(page.tree, (e) => e.props?.['data-cu-runtime-form'] === 'always').length, 0)
  assert.equal(page.button('添加到始终允许…').props.disabled, true, 'one pick at a time')
  page.update(picked(notes))
  const [form] = find(page.tree, (e) => e.props?.['data-cu-runtime-form'] === 'always')
  assert.ok(form, 'the form opened on the pick')
  assert.ok(texts(form).includes('Notes') && texts(form).includes('com.apple.Notes'))
  assert.ok(!texts(page.tree).includes(ZH['settings.apps.waiting']))
  page.the('segmented', '档位').props.onChange('full')
  page.draw()
  page.button('加入').props.onClick()
  assert.deepEqual(plain(page.applied), [{ kind: 'persistent.add', bundle_id: 'com.apple.Notes', mode: 'full' }])
  await page.settle()
  assert.equal(find(page.tree, (e) => e.props?.['data-cu-runtime-form'] === 'always').length, 0, 'closed once applied')

  // Refused: the form stays for another try; cancelled in the panel: nothing opens.
  const refused = mount(apps, snapshot())
  refused.button('添加到始终允许…').props.onClick()
  await refused.settle()
  refused.update(picked(notes))
  refused.answer = false
  refused.button('加入').props.onClick()
  await refused.settle()
  assert.equal(find(refused.tree, (e) => e.props?.['data-cu-runtime-form'] === 'always').length, 1)
  assert.deepEqual(plain(refused.applied), [{ kind: 'persistent.add', bundle_id: 'com.apple.Notes', mode: 'read' }], 'read by default')
  const cancelled = mount(apps, snapshot())
  cancelled.button('添加到始终允许…').props.onClick()
  await cancelled.settle()
  cancelled.update(snapshot({ last_outcome: { at: SEC + 1, kind: 'choose_app', outcome: 'cancelled' } }))
  assert.equal(find(cancelled.tree, (e) => e.props?.['data-cu-runtime-form'] === 'always').length, 0)
  assert.ok(!texts(cancelled.tree).includes(ZH['settings.apps.waiting']))
  assert.equal(cancelled.button('添加到始终允许…').props.disabled, false)
})

test('render apps: the deny form takes a typed or picked bundle ID and a note; deny.add with the note always present', async () => {
  const page = mount(apps, snapshot())
  page.button('添加到黑名单…').props.onClick()
  page.draw()
  assert.equal(page.button('加入').props.disabled, true, 'nothing typed yet')
  page.the('input', 'Bundle ID').props.onChange(' com.example.Mail ')
  page.draw()
  page.button('加入').props.onClick()
  await page.settle()
  assert.deepEqual(plain(page.applied), [{ kind: 'deny.add', bundle_id: 'com.example.Mail', note: '' }])
  assert.equal(find(page.tree, (e) => e.props?.['data-cu-runtime-form'] === 'deny').length, 0, 'closed once applied')

  page.button('添加到黑名单…').props.onClick()
  page.draw()
  page.the('input', '备注').props.onChange('games')
  page.draw()
  page.button('选择应用…').props.onClick()
  assert.deepEqual(page.actions, ['choose_app'])
  await page.settle()
  page.update(picked({ bundle_id: 'com.example.Game', name: 'Game' }))
  assert.equal(page.the('input', 'Bundle ID').props.value, 'com.example.Game', 'the picked app fills the field')
  assert.equal(page.the('input', '备注').props.value, 'games', 'the note is kept')
  page.button('加入').props.onClick()
  assert.deepEqual(plain(page.applied.at(-1)), { kind: 'deny.add', bundle_id: 'com.example.Game', note: 'games' })
  exact(page.applied.at(-1))
})

test('render apps: a form sent or cancelled while it waits for a pick is not opened again by that pick', async () => {
  const forms = (page, which) => find(page.tree, (e) => e.props?.['data-cu-runtime-form'] === which).length
  const game = { bundle_id: 'com.example.Game', name: 'Game' }
  const deny = mount(apps, snapshot())
  deny.button('添加到黑名单…').props.onClick()
  deny.draw()
  deny.button('选择应用…').props.onClick()
  await deny.settle()
  assert.ok(texts(deny.tree).includes(ZH['settings.apps.waiting']))
  deny.the('input', 'Bundle ID').props.onChange('com.example.Mail')
  deny.draw()
  deny.button('加入').props.onClick()
  await deny.settle()
  assert.deepEqual(plain(deny.applied), [{ kind: 'deny.add', bundle_id: 'com.example.Mail', note: '' }])
  assert.equal(forms(deny, 'deny'), 0, 'closed once applied')
  assert.ok(!texts(deny.tree).includes(ZH['settings.apps.waiting']), 'no longer waiting')
  deny.update(picked(game))
  assert.equal(forms(deny, 'deny'), 0, 'the late pick opens nothing')

  const always = mount(apps, snapshot())
  always.button('添加到始终允许…').props.onClick()
  await always.settle()
  always.update(picked({ bundle_id: 'com.apple.Notes', name: 'Notes' }))
  assert.equal(forms(always, 'always'), 1)
  always.update(snapshot())
  always.button(ZH['settings.apps.always.form.chooseAgain']).props.onClick()
  await always.settle()
  assert.ok(texts(always.tree).includes(ZH['settings.apps.waiting']))
  always.button(ZH['settings.cancel']).props.onClick()
  always.draw()
  assert.equal(forms(always, 'always'), 0)
  always.update(picked(game))
  assert.equal(forms(always, 'always'), 0, 'the pick for a cancelled form opens nothing')
})

test('render shortcuts: a switch per built-in chord sends disable or enable; 移除 sends chord.remove with its app; held while pending', () => {
  assert.equal(shortcuts.tab.id, 'shortcuts')
  const page = mount(shortcuts, snapshot())
  const switches = find(page.tree, (e) => e.type === 'switch')
  assert.deepEqual(switches.map((s) => [s.props.label, s.props.checked, s.props.disabled]),
    [['全选', true, false], ['拷贝', true, false], ['重做', true, false], ['退出应用', false, false], ['按词移动', true, false]])
  switches[0].props.onChange(false)
  switches[3].props.onChange(true)
  switches[1].props.onChange(true)
  page.buttons('移除')[1].props.onClick()
  page.buttons('移除')[0].props.onClick()
  assert.deepEqual(plain(page.applied), [
    { kind: 'chord.disable', chord: 'cmd+a' },
    { kind: 'chord.enable', chord: 'cmd+q' },
    { kind: 'chord.remove', chord: 'ctrl+opt+b', app: 'com.apple.TextEdit' },
    { kind: 'chord.remove', chord: 'shift+cmd+k', app: null },
  ])
  const lists = find(page.tree, (e) => e.type === 'list')
  assert.deepEqual(lists.map((l) => [l.props.label, l.props.rows.length]), [['内置允许', 5], ['自定义', 3], ['永不允许', 6]])
  for (const word of ['已停用', '仅 TextEdit', '所有已授权应用', 'clear', '锁屏', 'F1–F12 功能键', 'fn 组合键', '⌘']) {
    assert.ok(texts(page.tree).includes(word), word)
  }
  const held = mount(shortcuts, snapshot(), { pending: true })
  assert.ok(find(held.tree, (e) => e.type === 'switch').every((s) => s.props.disabled === true))
  for (const b of [...held.buttons('移除'), held.button('添加快捷键…')]) assert.equal(b.props.disabled, true)
  assert.deepEqual(texts(mount(shortcuts, null).tree), ['快捷键', ZH['settings.shortcuts.note']])
})

test('render shortcuts: the add form sends chord.add for every app (null) or one picked app, with the note', async () => {
  const page = mount(shortcuts, snapshot())
  page.button('添加快捷键…').props.onClick()
  page.draw()
  assert.equal(page.button('加入').props.disabled, true)
  page.the('input', '组合键').props.onChange('cmd+shift+k')
  page.draw()
  assert.ok(texts(find(page.tree, (e) => e.props?.['data-cu-runtime-form'] === 'chord')).includes('⇧'), 'the caps of what is typed')
  page.button('加入').props.onClick()
  await page.settle()
  assert.deepEqual(plain(page.applied), [{ kind: 'chord.add', chord: 'cmd+shift+k', app: null, note: '' }])
  assert.equal(find(page.tree, (e) => e.props?.['data-cu-runtime-form'] === 'chord').length, 0, 'closed once applied')

  page.button('添加快捷键…').props.onClick()
  page.draw()
  page.the('input', '组合键').props.onChange('ctrl+opt+b')
  page.the('segmented', '在哪里生效').props.onChange('one')
  page.draw()
  assert.equal(page.button('加入').props.disabled, true, 'one app needs its bundle ID')
  page.the('input', '说明').props.onChange('bold')
  page.button('选择应用…').props.onClick()
  await page.settle()
  assert.ok(texts(page.tree).includes(ZH['settings.shortcuts.form.waiting']))
  page.update(picked({ bundle_id: 'com.apple.TextEdit', name: 'TextEdit' }))
  assert.equal(page.the('input', 'Bundle ID').props.value, 'com.apple.TextEdit')
  page.button('加入').props.onClick()
  assert.deepEqual(plain(page.applied.at(-1)), { kind: 'chord.add', chord: 'ctrl+opt+b', app: 'com.apple.TextEdit', note: 'bold' })
  exact(page.applied.at(-1))

  // Cancel closes the form and stops waiting for a pick.
  const other = mount(shortcuts, snapshot())
  other.button('添加快捷键…').props.onClick()
  other.draw()
  other.the('segmented', '在哪里生效').props.onChange('one')
  other.draw()
  other.button('选择应用…').props.onClick()
  await other.settle()
  other.button('取消').props.onClick()
  other.draw()
  assert.equal(find(other.tree, (e) => e.props?.['data-cu-runtime-form'] === 'chord').length, 0)
  other.button('添加快捷键…').props.onClick()
  other.draw()
  other.the('segmented', '在哪里生效').props.onChange('one')
  other.draw()
  assert.ok(!texts(other.tree).includes(ZH['settings.shortcuts.form.waiting']), 'a new form does not wait for the old pick')
  assert.equal(other.button('选择应用…').props.disabled, false)
  other.update(picked({ bundle_id: 'com.apple.TextEdit', name: 'TextEdit' }))
  assert.equal(other.the('input', 'Bundle ID').props.value, '', 'the old pick does not fill the new form')
})

test('typed text: a control or format character (Cc or Cf: a zero-width space, a direction mark, a BOM from a copied web string) is refused as the daemon refuses it', () => {
  for (const ch of ['\u0007', '​', '‎', '﻿']) {
    assert.equal(apps.bundleIdOf(`com.example${ch}app`), null, JSON.stringify(ch))
    assert.equal(apps.noteOf(`a ${ch}note`), null, JSON.stringify(ch))   // inside: trim() would drop a trailing BOM
    assert.equal(shortcuts.chordOf(`cmd+${ch}k`), null, JSON.stringify(ch))
  }
  assert.equal(apps.bundleIdOf(' com.example.app '), 'com.example.app')
  assert.equal(apps.noteOf('备注'), '备注')
  assert.equal(shortcuts.chordOf('cmd+shift+k'), 'cmd+shift+k')
})
