// The 概览 (Overview) settings tab (plugin/src/client/settings/tabs/overview.ts), ported from the native overview: its
// view builder (the three permissions, the new-session default, the approvals in effect with their time left and
// their revoke / revoke all changes, the recent refusals) and its render through a recording Kit (which change each
// button sends, which tab each link shows). Loads the compiled CommonJS modules from a build into a temporary
// directory, removed afterwards.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENTRY, ROOT } from '../../scripts/build-client.mjs'

const dir = mkdtempSync(join(tmpdir(), 'cu-settings-overview-'))
after(() => rmSync(dir, { recursive: true, force: true }))
execFileSync(process.execPath, [join(ROOT, 'scripts/build-client.mjs'), '--out', join(dir, 'client.js'), '--cjs', join(dir, 'cjs')],
  { stdio: ['ignore', 'pipe', 'pipe'] })
const compiled = createRequire(join(dir, 'cjs', ENTRY))
const { buildOverviewView, tab, refusalTime, REFUSAL_REASONS } = compiled('./settings/tabs/overview.js')
const { readSnapshot } = compiled('./settings/model.js')
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

/** Noon local time, so "today" and "yesterday" do not depend on the time zone. */
const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime()
const SEC = NOW / 1000

function snapshot(over = {}) {
  return readSnapshot({
    started_at: SEC - 3600,
    grants: [
      { task_id: 'dsh-a1b2c3d4e5f6', expires_at: SEC + 1800, by_dialog: true, owner_gone: false, apps: [
        { bundle_id: 'com.apple.TextEdit', name: 'TextEdit', mode: 'full', scope: 'session', expires_at: SEC + 1500 },
        { bundle_id: 'com.apple.Notes', name: 'Notes', mode: 'read', scope: 'turn', expires_at: SEC + 1800 },
      ] },
      { task_id: 'dsh-ffff0000eeee', expires_at: SEC + 30, by_dialog: false, owner_gone: true, apps: [
        { bundle_id: 'com.apple.TextEdit', name: 'TextEdit', mode: null, scope: null, expires_at: SEC + 30 },
        { bundle_id: 'com.example.Viewer', name: null, mode: 'read', scope: 'always', expires_at: SEC + 3600 },
      ] },
    ],
    persistent: [], denylist: [], hard_deny: [],
    access: { default_mode: 'ask' }, access_choices: {},
    chords: { builtin: [], never: [], custom: [] },
    privacy: {}, behavior: {}, logs: {},
    recent_refusals: [
      { at: SEC - 60, method: 'act.key', app: 'com.apple.TextEdit', reason: 'chord_not_allowed' },
      { at: SEC - 13 * 3600, method: 'zoom', app: 'com.example.unknown', reason: 'no_grant' },
      { at: SEC - 120, method: 'apps.list', app: null, reason: 'brand_new_reason' },
      { at: SEC - 180, method: 'cu.future', app: null, reason: 'hard_denied_frontmost' },
    ],
    recent_changes: [],
    permissions: { accessibility: true, screen_recording: false, input_monitoring: null },
    pending: null, last_outcome: null, picked_app: null, import_preview: null, panel: null,
    ...over,
  })
}

const view = (s = snapshot(), options = {}) => buildOverviewView(s, { t, pending: false, now: NOW, ...options })
const plain = (v) => JSON.parse(JSON.stringify(v))

test('before the first snapshot: only the title and note, nothing to revoke', () => {
  const v = view(null)
  assert.equal(v.ready, false)
  assert.equal(v.title, '概览')
  assert.deepEqual(plain(v.grants.rows), [])
  assert.equal(v.grants.revokeAll.enabled, false)
  assert.deepEqual(plain(v.refusals.rows), [])
})

test('the three permissions from snapshot.permissions; input monitoring null is not requested; none without panels', () => {
  const v = view()
  assert.deepEqual(plain(v.permissions.rows), [
    { id: 'accessibility', label: '辅助功能', state: 'granted', text: '已授予', dot: 'done' },
    { id: 'screen_recording', label: '屏幕录制', state: 'missing', text: '未授予', dot: 'error' },
    { id: 'input_monitoring', label: '输入监控', state: 'notRequested', text: '未申请', dot: 'idle' },
  ])
  assert.equal(v.permissions.unknown, null)
  assert.equal(v.permissions.note, '当前版本不需要输入监控。')
  assert.equal(view(snapshot({ permissions: { accessibility: false, screen_recording: true, input_monitoring: true } }))
    .permissions.rows[2].state, 'granted')
  const headless = view(snapshot({ permissions: null }))
  assert.equal(headless.permissions.rows, null)
  assert.equal(headless.permissions.unknown, ZH['settings.overview.permissionsUnknown'])
})

test('the new-session default: ask asks; read or full is granted for the session; a link to 档位与默认', () => {
  assert.deepEqual(plain(view().newSession), { title: '新会话默认', mode: '每次询问', note: '名单外的应用首次被访问时弹出申请。', edit: '修改默认档位' })
  assert.equal(view(snapshot({ access: { default_mode: 'full' } })).newSession.note,
    '名单外的应用首次被访问时，本次会话内直接按「可操作」放行。')
  assert.equal(view(snapshot({ access: { default_mode: 'read' } })).newSession.mode, '浏览')
  assert.equal(view(snapshot({ access: { default_mode: 'odd' } })).newSession.mode, '每次询问', 'an unknown value reads as ask')
})

test('approvals in effect: one row per app per task, mode, time left, source, session; revoke by task and revoke all', () => {
  const v = view()
  assert.equal(v.grants.title, '正在生效的授权')
  assert.deepEqual(plain(v.grants.rows.map(({ revoke, ...row }) => row)), [
    { key: 'dsh-a1b2c3d4e5f6:com.apple.TextEdit', app: { bundle_id: 'com.apple.TextEdit', name: 'TextEdit' },
      mode: { text: '可操作', tone: 'warning' }, lasts: '本次会话 · 剩约 25 分钟', source: '弹窗批准', session: '会话 a1b2c3d4', ownerGone: false },
    { key: 'dsh-a1b2c3d4e5f6:com.apple.Notes', app: { bundle_id: 'com.apple.Notes', name: 'Notes' },
      mode: { text: '浏览', tone: 'info' }, lasts: '仅本轮', source: '弹窗批准', session: '会话 a1b2c3d4', ownerGone: false },
    { key: 'dsh-ffff0000eeee:com.apple.TextEdit', app: { bundle_id: 'com.apple.TextEdit', name: 'TextEdit' },
      mode: { text: '配置授权', tone: 'neutral' }, lasts: '配置授权 · 剩不足 1 分钟', source: '配置授权', session: '进程已退出', ownerGone: true },
    { key: 'dsh-ffff0000eeee:com.example.Viewer', app: { bundle_id: 'com.example.Viewer', name: null },
      mode: { text: '浏览', tone: 'info' }, lasts: '始终允许', source: '配置授权', session: '进程已退出', ownerGone: true },
  ])
  assert.deepEqual(plain(v.grants.rows.map((r) => r.revoke)), [
    { label: '撤销', enabled: true, change: { kind: 'revoke', task_id: 'dsh-a1b2c3d4e5f6' } },
    { label: '撤销', enabled: true, change: { kind: 'revoke', task_id: 'dsh-a1b2c3d4e5f6' } },
    { label: '撤销', enabled: true, change: { kind: 'revoke', task_id: 'dsh-ffff0000eeee' } },
    { label: '撤销', enabled: true, change: { kind: 'revoke', task_id: 'dsh-ffff0000eeee' } },
  ])
  assert.deepEqual(plain(v.grants.revokeAll), { label: '全部撤销', enabled: true, change: { kind: 'revoke_all' } })
  // Exactly the daemon's keys for each kind.
  assert.deepEqual(Object.keys(v.grants.rows[0].revoke.change).sort(), ['kind', 'task_id'])
  assert.deepEqual(Object.keys(v.grants.revokeAll.change), ['kind'])
  // Expired by the clock: under a minute, never negative.
  assert.equal(view(snapshot(), { now: NOW + 3_600_000 }).grants.rows[0].lasts, '本次会话 · 剩不足 1 分钟')
})

test('while anything is pending every revoke is held; with no approval revoke all is held and the empty line shown', () => {
  const held = view(snapshot(), { pending: true })
  assert.ok(held.grants.rows.every((r) => r.revoke.enabled === false))
  assert.equal(held.grants.revokeAll.enabled, false)
  const none = view(snapshot({ grants: [] }))
  assert.equal(none.grants.revokeAll.enabled, false)
  assert.equal(none.grants.empty, '现在没有生效的授权。')
})

test('recent refusals: time (yesterday marked), what was attempted on which app, the reason in words and as recorded', () => {
  const s = snapshot()
  const rows = view(s).refusals.rows
  assert.deepEqual(plain(rows.map(({ key, ...r }) => r)), [
    { at: '11:59:00', text: '在「TextEdit」中按快捷键', reason: '快捷键不在允许列表', code: 'chord_not_allowed' },
    { at: '昨天 23:00:00', text: '查看「com.example.unknown」', reason: '没有授权', code: 'no_grant' },
    { at: '11:58:00', text: '列出应用', reason: 'brand_new_reason', code: 'brand_new_reason' },
    { at: '11:57:00', text: 'cu.future 未知应用', reason: '系统底线', code: 'hard_denied_frontmost' },
  ])
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, 'distinct keys')
  assert.equal(view(s).refusals.empty, '近两天没有拦截记录。')
  assert.equal(refusalTime(t, SEC - 5, NOW), '11:59:55')
  for (const word of new Set(Object.values(REFUSAL_REASONS))) {
    assert.ok(Object.hasOwn(ZH, `settings.overview.reason.${word}`) && Object.hasOwn(EN, `settings.overview.reason.${word}`), word)
  }
})

test('the view in English', () => {
  const v = buildOverviewView(snapshot(), { t: translator(EN), pending: false, now: NOW })
  assert.equal(v.grants.rows[0].lasts, 'This session · about 25 min left')
  assert.equal(v.refusals.rows[1].at, 'yest. 23:00:00')
  assert.equal(v.refusals.rows[0].text, 'Press a shortcut in “TextEdit”')
  assert.equal(v.permissions.rows[2].text, 'Not requested')
})

// --- render, through a Kit that records what each piece was given ---

function recordingKit() {
  const h = (type, props, ...children) => ({ type, props: { ...props, children } })
  const el = (type, spec, children = []) => ({ type, props: { ...spec, children } })
  return {
    h, useState: (v) => [v, () => {}], useEffect: () => {}, styles: new Proxy({}, { get: () => ({}) }),
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

function render(s, { pending = false } = {}) {
  const applied = []
  const shown = []
  const props = {
    snapshot: s, t, pending, now: NOW,
    apply: async (c) => { applied.push(c); return true },
    action: async () => true,
    goTo: (id) => shown.push(id),
  }
  return { tree: tab.render(props, recordingKit()), applied, shown }
}

test('render: 撤销 sends {kind: revoke, task_id} of its row\'s task, 全部撤销 {kind: revoke_all}; both held while pending', () => {
  assert.equal(tab.id, 'overview')
  const { tree, applied } = render(snapshot())
  const revokes = find(tree, (e) => e.type === 'button' && e.props.label === '撤销')
  assert.equal(revokes.length, 4)
  revokes[0].props.onClick()
  revokes[2].props.onClick()
  const [all] = find(tree, (e) => e.type === 'button' && e.props.label === '全部撤销')
  assert.equal(all.props.disabled, false)
  all.props.onClick()
  assert.deepEqual(plain(applied), [{ kind: 'revoke', task_id: 'dsh-a1b2c3d4e5f6' }, { kind: 'revoke', task_id: 'dsh-ffff0000eeee' },
    { kind: 'revoke_all' }])
  const held = render(snapshot(), { pending: true }).tree
  assert.ok(find(held, (e) => e.type === 'button' && ['撤销', '全部撤销'].includes(e.props.label)).every((b) => b.props.disabled === true))
})

test('render: the links show 档位与默认 and 守护进程; the long lists go through the limited-height list', () => {
  const { tree, shown } = render(snapshot())
  find(tree, (e) => e.type === 'button' && e.props.label === '修改默认档位')[0].props.onClick()
  find(tree, (e) => e.type === 'button' && e.props.label === ZH['settings.toDaemon'])[0].props.onClick()
  assert.deepEqual(shown, ['access', 'daemon'])
  const lists = find(tree, (e) => e.type === 'list')
  assert.deepEqual(lists.map((l) => [l.props.label, l.props.rows.length]), [['正在生效的授权', 4], ['最近拦截', 4]])
  const words = texts(tree)
  for (const text of ['系统权限', '辅助功能', '已授予', '屏幕录制', '未授予', '输入监控', '未申请', '新会话默认', '每次询问',
    '正在生效的授权', 'TextEdit', 'com.apple.TextEdit', '本次会话 · 剩约 25 分钟', '最近拦截', '昨天 23:00:00', 'chord_not_allowed']) {
    assert.ok(words.includes(text), text)
  }
  const empty = render(snapshot({ grants: [], recent_refusals: [] })).tree
  assert.ok(texts(empty).includes('现在没有生效的授权。'))
  assert.ok(texts(empty).includes('近两天没有拦截记录。'))
  const waiting = render(null).tree
  assert.deepEqual(texts(waiting), ['概览', ZH['settings.overview.note']])
})
