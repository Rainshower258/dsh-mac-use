/**
 * 概览 (Overview), ported from the native overview (Sources/cu-runtime/SettingsWindow.swift OverviewPage) without its
 * daemon card, which is the 守护进程 tab: the three system permissions (snapshot.permissions; input monitoring may be
 * null, not requested), the new-session default with a link to 档位与默认, the approvals in effect with their time
 * left, each task's 撤销 (`{kind: 'revoke', task_id}`) and 全部撤销 (`{kind: 'revoke_all'}`), and the recent refusals,
 * in a list of limited height. Revoking only tightens: the daemon applies it at once.
 *
 * @module
 */

import type { DotState, Translate } from '../../view.ts'
import type { SettingsChange } from '../change.ts'
import { appName, shortTask, type AppRef, type GrantApp, type Refusal, type Snapshot } from '../model.ts'
import type { TabModule, Tone } from '../tab.ts'

export interface PermissionRow {
  readonly id: 'accessibility' | 'screen_recording' | 'input_monitoring'
  readonly label: string
  readonly state: 'granted' | 'missing' | 'notRequested'
  readonly text: string
  readonly dot: DotState
}

/** A control that changes something: enabled only while nothing is pending, `change` exactly what apply sends. */
export interface ChangeControl {
  readonly label: string
  readonly enabled: boolean
  readonly change: SettingsChange
}

/** One app of one task's approvals (the native overview's row): two tasks holding the same app are two rows. */
export interface GrantRow {
  readonly key: string
  readonly app: AppRef
  readonly mode: { readonly text: string; readonly tone: Tone }
  /** How long it lasts: this turn, always, or the scope with the minutes left. */
  readonly lasts: string
  /** Approved in a dialog, or a config grant. */
  readonly source: string
  /** The session (task ID as dsh shows it), or that its process exited. */
  readonly session: string
  readonly ownerGone: boolean
  readonly revoke: ChangeControl
}

export interface RefusalRow {
  readonly key: string
  /** HH:mm:ss, prefixed for yesterday's (the list covers two days). */
  readonly at: string
  readonly text: string
  /** The reason in words, or the code itself when this page has no words for it. */
  readonly reason: string
  readonly code: string
}

export interface OverviewView {
  readonly title: string
  readonly note: string
  /** false before the first snapshot: only the title and note are drawn (the shell says it is reading). */
  readonly ready: boolean
  readonly permissions: {
    readonly title: string
    /** null when the daemon gave none (it runs without panels); `unknown` says so. */
    readonly rows: readonly PermissionRow[] | null
    readonly unknown: string | null
    readonly note: string
    readonly hint: string
    readonly toDaemon: string
  }
  readonly newSession: { readonly title: string; readonly mode: string; readonly note: string; readonly edit: string }
  readonly grants: { readonly title: string; readonly rows: readonly GrantRow[]; readonly empty: string; readonly revokeAll: ChangeControl }
  readonly refusals: { readonly title: string; readonly note: string; readonly rows: readonly RefusalRow[]; readonly empty: string }
}

/** The audit's refusal reasons with words, by the word's key (the native table: several reasons share one). */
export const REFUSAL_REASONS: Readonly<Record<string, string>> = {
  hard_denied: 'floor', hard_denied_frontmost: 'floor', user_denied: 'denyList', dsh_host_app: 'dshHost',
  chord_not_allowed: 'chord', invalid_chord: 'chord', not_granted: 'noGrant', no_grant: 'noGrant', grant_expired: 'noGrant',
  action_not_allowed: 'mode', click_not_allowed: 'mode', ax_action_not_allowed: 'mode', launch_not_allowed: 'mode',
  approval_rejected: 'refusedByUser', approval_refused_earlier: 'refusedByUser', approval_limit: 'dialogLimit',
  approval_timeout: 'dialogTimeout', secure_input: 'secureInput', hit_test_failed: 'outsideWindow',
  not_on_target_window: 'outsideWindow', not_on_granted_window: 'outsideWindow', open_not_allowed: 'notOpenable',
  open_not_found: 'notOpenable', ime_switch_needs_approval: 'imeSwitch', finder_not_enabled: 'finder',
  session_locked: 'locked',
}

/** The methods a refusal is described by (settings.overview.attempt.<method>); zoom reads as observe. */
const ATTEMPTS = ['access.request', 'apps.launch', 'act.key', 'act.type', 'act.click', 'act.menu', 'observe', 'apps.list']

const DEFAULT_MODES = ['ask', 'read', 'full']

const pad = (n: number): string => String(n).padStart(2, '0')

/** A refusal's time: HH:mm:ss in this Mac's time zone, prefixed when it is not today's. */
export function refusalTime(t: Translate, at: number, now: number): string {
  const d = new Date(at * 1000)
  const today = new Date(now)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  return sameDay ? time : t('settings.overview.yesterday', { time })
}

function lasts(t: Translate, a: GrantApp, now: number): string {
  if (a.scope === 'turn' || a.scope === 'always') return t(`settings.overview.scope.${a.scope}`)
  const scope = a.scope === 'session' ? t('settings.overview.scope.session') : t('settings.overview.configGrant')
  const seconds = Math.max(0, a.expires_at - now / 1000)
  return seconds < 60 ? t('settings.overview.lastsUnderMinute', { scope })
    : t('settings.overview.lastsLeft', { scope, minutes: Math.floor(seconds / 60) })
}

function modeChip(t: Translate, mode: GrantApp['mode']): { text: string; tone: Tone } {
  if (mode === 'read') return { text: t('settings.mode.read'), tone: 'info' }
  if (mode === 'full') return { text: t('settings.mode.full'), tone: 'warning' }
  return { text: t('settings.overview.configGrant'), tone: 'neutral' }
}

function refusalRow(t: Translate, r: Refusal, i: number, snapshot: Snapshot, now: number): RefusalRow {
  const app = r.app === null ? t('settings.overview.unknownApp') : t('settings.overview.app', { name: appName(snapshot, r.app) ?? r.app })
  const method = r.method === 'zoom' ? 'observe' : r.method
  const text = ATTEMPTS.includes(method) ? t(`settings.overview.attempt.${method}`, { app })
    : t('settings.overview.attempt.other', { method: r.method, app })
  const word = REFUSAL_REASONS[r.reason]
  return { key: `${r.at}:${i}`, at: refusalTime(t, r.at, now), text, reason: word === undefined ? r.reason : t(`settings.overview.reason.${word}`), code: r.reason }
}

function permissionRow(t: Translate, id: PermissionRow['id'], granted: boolean | null): PermissionRow {
  const state = granted === null ? 'notRequested' : granted ? 'granted' : 'missing'
  return { id, label: t(`settings.overview.permission.${id}`), state, text: t(`settings.overview.permission.${state}`),
    dot: state === 'granted' ? 'done' : state === 'missing' ? 'error' : 'idle' }
}

/**
 * The overview's view.
 * @param snapshot - null before the first read (ready false).
 * @param options.pending - every revoke is disabled while true (TabProps.pending).
 * @param options.now - Date.now() for the time left and today's refusals.
 */
export function buildOverviewView(snapshot: Snapshot | null, { t, pending, now }: { t: Translate; pending: boolean; now: number }): OverviewView {
  const permissions = snapshot?.permissions ?? null
  const mode = snapshot !== null && typeof snapshot.access.default_mode === 'string' && DEFAULT_MODES.includes(snapshot.access.default_mode)
    ? snapshot.access.default_mode : 'ask'
  const modeName = t(`settings.value.default_mode.${mode}`)
  const grants = snapshot?.grants ?? []
  return {
    title: t('settings.overview.title'),
    note: t('settings.overview.note'),
    ready: snapshot !== null,
    permissions: {
      title: t('settings.overview.permissions'),
      rows: permissions === null ? null : [
        permissionRow(t, 'accessibility', permissions.accessibility),
        permissionRow(t, 'screen_recording', permissions.screen_recording),
        permissionRow(t, 'input_monitoring', permissions.input_monitoring),
      ],
      unknown: permissions === null ? t('settings.overview.permissionsUnknown') : null,
      note: t('settings.overview.inputMonitoringNote'),
      hint: t('settings.overview.permissionsHint'),
      toDaemon: t('settings.toDaemon'),
    },
    newSession: {
      title: t('settings.overview.newSessionDefault'),
      mode: modeName,
      note: mode === 'ask' ? t('settings.overview.newSessionNote') : t('settings.overview.newSessionGranted', { mode: modeName }),
      edit: t('settings.overview.editDefaults'),
    },
    grants: {
      title: t('settings.overview.activeGrants'),
      rows: grants.flatMap((g) => g.apps.map((a): GrantRow => ({
        key: `${g.task_id}:${a.bundle_id}`,
        app: { bundle_id: a.bundle_id, name: a.name },
        mode: modeChip(t, a.mode),
        lasts: lasts(t, a, now),
        source: g.by_dialog ? t('settings.overview.byDialog') : t('settings.overview.configGrant'),
        session: g.owner_gone ? t('settings.overview.processGone') : t('settings.overview.session', { task: shortTask(g.task_id) }),
        ownerGone: g.owner_gone,
        revoke: { label: t('settings.overview.revoke'), enabled: !pending, change: { kind: 'revoke', task_id: g.task_id } },
      }))),
      empty: t('settings.overview.noneActive'),
      revokeAll: { label: t('settings.overview.revokeAll'), enabled: !pending && grants.length > 0, change: { kind: 'revoke_all' } },
    },
    refusals: {
      title: t('settings.overview.recentRefusals'),
      note: t('settings.overview.refusalsNote'),
      rows: snapshot === null ? [] : snapshot.recent_refusals.map((r, i) => refusalRow(t, r, i, snapshot, now)),
      empty: t('settings.overview.noRefusals'),
    },
  }
}

export const tab: TabModule = {
  id: 'overview',
  render(props, ui) {
    const { h, styles } = ui
    const view = buildOverviewView(props.snapshot, props)
    const header = h('div', { key: 'header', style: { display: 'grid', gap: 2 } },
      h('h3', { style: { ...styles.heading, fontSize: 15 } }, view.title),
      h('p', { style: styles.note }, view.note))
    if (!view.ready) return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'overview' }, header)
    const p = view.permissions
    const permissions = ui.card({
      key: 'permissions', title: p.title,
      children: [
        p.rows === null ? h('p', { key: 'unknown', style: styles.quiet }, p.unknown)
          : h('dl', { key: 'rows', style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) max-content', rowGap: 6, columnGap: 12, margin: 0 } },
            ...p.rows.flatMap((r) => [
              h('dt', { key: `${r.id}:label` }, r.label),
              h('dd', { key: `${r.id}:value`, style: { ...styles.line, margin: 0 }, 'data-permission': r.id, 'data-state': r.state },
                ui.dot(r.dot), h('span', null, r.text)),
            ])),
        h('p', { key: 'note', style: styles.note }, p.note),
        h('div', { key: 'hint', style: styles.row }, h('p', { style: styles.note }, p.hint),
          ui.button({ key: 'toDaemon', label: p.toDaemon, onClick: () => props.goTo('daemon'), variant: 'ghost' })),
      ],
    })
    const n = view.newSession
    const newSession = ui.card({
      key: 'newSession', title: n.title,
      children: [
        h('p', { key: 'mode', style: { ...styles.heading, fontSize: 15 } }, n.mode),
        h('p', { key: 'note', style: styles.note }, n.note),
        h('div', { key: 'edit', style: styles.actions },
          ui.button({ key: 'edit', label: n.edit, onClick: () => props.goTo('access'), variant: 'ghost' })),
      ],
    })
    const g = view.grants
    const grants = ui.card({
      key: 'grants', title: g.title,
      trailing: ui.button({ key: 'revokeAll', label: g.revokeAll.label, disabled: !g.revokeAll.enabled,
        onClick: () => void props.apply(g.revokeAll.change) }),
      children: [ui.list({
        key: 'list', label: g.title, empty: g.empty,
        rows: g.rows.map((r) => h('div', { key: r.key, style: { ...styles.row, opacity: r.ownerGone ? 0.55 : 1 }, 'data-grant': r.key },
          h('div', { style: { flex: '1 1 160px', minWidth: 0 } }, ui.appLabel(r.app)),
          ui.tag(r.mode.text, r.mode.tone),
          h('span', { style: { fontSize: 12 } }, r.lasts),
          h('span', { style: { display: 'grid', fontSize: 12 } },
            h('span', { style: styles.quiet }, r.source),
            h('span', { style: r.ownerGone ? { ...styles.error, fontWeight: 600 } : styles.code }, r.session)),
          ui.button({ key: 'revoke', label: r.revoke.label, disabled: !r.revoke.enabled, onClick: () => void props.apply(r.revoke.change) }))),
      })],
    })
    const f = view.refusals
    const refusals = ui.card({
      key: 'refusals', title: f.title, note: f.note,
      children: [ui.list({
        key: 'list', label: f.title, empty: f.empty,
        rows: f.rows.map((r) => h('div', { key: r.key, style: styles.row, 'data-refusal': r.code },
          h('code', { style: { ...styles.code, flex: 'none' } }, r.at),
          h('span', { style: { flex: '1 1 160px', minWidth: 0 } }, r.text),
          ui.tag(r.reason, 'danger'),
          h('code', { style: { ...styles.code, color: 'var(--dsw-alias-label-secondary)' } }, r.code))),
      })],
    })
    return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'overview' }, header,
      h('div', { key: 'cards', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 } },
        permissions, newSession),
      grants, refusals)
  },
}
