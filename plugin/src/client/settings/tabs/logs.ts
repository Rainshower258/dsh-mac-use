/**
 * 日志 (Logs), ported from the native page (Sources/cu-runtime/SettingsLogsPage.swift) without the dsh session
 * records' size: where the audit log lives (snapshot.logs.directory, home as ~, shown only when the person chose one;
 * else 默认位置) with 选择… (`settings.action.choose_log_directory`: the daemon's folder panel on the Mac, which moves
 * the files), 恢复默认位置 while a folder was chosen (`settings.action.use_default_log_directory`, applied at once) and
 * 在访达中显示 (`settings.action.reveal_log`); how long it is kept (`{kind: 'logs.retention', days}`, 7, 30 or 90); the
 * files now with their size and 导出最近 7 天 (`settings.action.export_audit`, saved where the person chooses on the
 * Mac); what is recorded (fixed); and the recent settings changes (snapshot.recent_changes) in a list of limited
 * height. The daemon decides what needs the owner check (a shorter retention does); the lock note is a hint only.
 *
 * @module
 */

import type { Translate } from '../../view.ts'
import type { SettingsAction, SettingsChange } from '../change.ts'
import { appName, type RecentChange, type Snapshot } from '../model.ts'
import type { TabModule } from '../tab.ts'

/** The retention choices the daemon offers (LogSettings.retentionChoices). */
export const RETENTION_DAYS = [7, 30, 90] as const

/** A daemon action behind a button: enabled only while nothing is pending. */
export interface ActionControl {
  readonly label: string
  readonly enabled: boolean
  readonly action: SettingsAction
}

export interface RetentionOption {
  readonly value: string
  readonly label: string
  readonly change: SettingsChange
}

export interface ChangeRow {
  readonly key: string
  /** MM-dd HH:mm in this Mac's time zone (the list covers seven days). */
  readonly at: string
  readonly text: string
  /** The reason the daemon recorded with it, when it recorded one. */
  readonly reason: string | null
  /** 已验证 when the line says the owner check passed for it. */
  readonly verified: string | null
}

export interface LogsView {
  readonly title: string
  readonly note: string
  /** false before the first snapshot: only the title and note are drawn. */
  readonly ready: boolean
  readonly auditLog: {
    readonly title: string
    readonly location: {
      readonly title: string
      /** The folder as the daemon shows it (home as ~), or 默认位置. */
      readonly path: string
      /** The 默认 tag beside the title while no folder was chosen; null otherwise. */
      readonly defaultTag: string | null
      readonly note: string
      readonly choose: ActionControl
      /** Only while a folder was chosen. */
      readonly useDefault: ActionControl | null
      readonly reveal: ActionControl
    }
    readonly retention: {
      readonly id: string
      readonly title: string
      readonly note: string
      readonly lock: string
      /** The offered choice the daemon's value is, null when it is none of them (then disabled). */
      readonly value: string | null
      readonly enabled: boolean
      readonly options: readonly RetentionOption[]
    }
    readonly files: { readonly title: string; readonly text: string; readonly export: ActionControl }
    readonly recorded: { readonly title: string; readonly note: string; readonly fixed: string }
  }
  readonly changes: { readonly title: string; readonly rows: readonly ChangeRow[]; readonly empty: string; readonly maxHeight: number }
}

/** The audit's settings methods with words (settings.logs.change.<word>); any other is shown as recorded. */
export const CHANGE_METHODS: Readonly<Record<string, string>> = {
  'settings.denylist_add': 'denylistAdd', 'settings.denylist_remove': 'denylistRemove',
  'settings.persistent_add': 'persistentAdd', 'settings.persistent_revoke': 'persistentRevoke',
  'settings.persistent_mode': 'persistentMode', 'settings.persistent_reapprove': 'persistentReapprove',
  'settings.access': 'access', 'settings.privacy': 'privacy',
  'settings.chord_disable': 'chordDisable', 'settings.chord_enable': 'chordEnable', 'settings.chord_add': 'chordAdd',
  'settings.chord_remove': 'chordRemove', 'settings.revoke': 'revoke', 'settings.revoke_all': 'revokeAll',
  'settings.behavior': 'behavior', 'settings.import': 'import', 'settings.reset': 'reset',
  'settings.audit_export': 'auditExport', 'settings.logs': 'logs', 'settings.export': 'export',
  'settings.stop': 'stop', 'settings.restart': 'restart',
}

/** The words that name an app ({app}); chord_add names one only when it was limited to one (chordAddApp). */
const WITH_APP = new Set(['denylistAdd', 'denylistRemove', 'persistentAdd', 'persistentRevoke', 'persistentMode', 'persistentReapprove'])

const pad = (n: number): string => String(n).padStart(2, '0')
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** A change's time: MM-dd HH:mm in this Mac's time zone (the native list's). */
export function changeTime(at: number): string {
  const d = new Date(at * 1000)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * A size as the Finder writes one (decimal units): bytes below 1000, KB without a decimal, MB and above with one
 * (none when it is .0).
 */
export function sizeText(t: Translate, bytes: number): string {
  if (bytes < 1000) return t('settings.logs.bytes', { n: Math.round(bytes) })
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1000
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit += 1 }
  const shown = unit === 0 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
  return `${shown} ${units[unit]}`
}

/** One recent change in words: what the method did, with the app's name (or bundle ID) when the line names one. */
export function changeText(t: Translate, c: RecentChange, snapshot: Snapshot | null): string {
  const word = CHANGE_METHODS[c.method]
  if (word === undefined) return c.method
  const app = c.app === null ? t('settings.logs.unknownApp') : t('settings.logs.app', { name: appName(snapshot, c.app) ?? c.app })
  if (word === 'chordAdd' && c.app !== null) return t('settings.logs.change.chordAddApp', { app })
  return WITH_APP.has(word) ? t(`settings.logs.change.${word}`, { app }) : t(`settings.logs.change.${word}`)
}

/**
 * The logs tab's view.
 * @param snapshot - null before the first read (ready false, every control disabled).
 * @param options.pending - every control is disabled while true (TabProps.pending).
 */
export function buildLogsView(snapshot: Snapshot | null, { t, pending }: { t: Translate; pending: boolean }): LogsView {
  const logs = snapshot?.logs ?? {}
  const held = pending || snapshot === null
  const directory = typeof logs.directory === 'string' && logs.directory !== '' ? logs.directory : null
  const custom = logs.directory_custom === true || directory !== null
  const days = logs.retention_days
  const retention = (RETENTION_DAYS as readonly unknown[]).includes(days) ? String(days) : null
  const files = isCount(logs.files) && isCount(logs.bytes)
    ? t('settings.logs.fileCount', { n: logs.files, size: sizeText(t, logs.bytes) }) : t('settings.value.none')
  return {
    title: t('settings.logs.title'),
    note: t('settings.logs.note'),
    ready: snapshot !== null,
    auditLog: {
      title: t('settings.logs.auditLog'),
      location: {
        title: t('settings.logs.location'),
        path: directory ?? (custom ? t('settings.logs.customLocation') : t('settings.logs.defaultLocation')),
        defaultTag: custom ? null : t('settings.logs.defaultTag'),
        note: t('settings.logs.locationNote'),
        choose: { label: t('settings.logs.choose'), enabled: !held, action: 'choose_log_directory' },
        useDefault: custom ? { label: t('settings.logs.useDefault'), enabled: !held, action: 'use_default_log_directory' } : null,
        reveal: { label: t('settings.logs.reveal'), enabled: !held, action: 'reveal_log' },
      },
      retention: {
        id: 'cu-runtime-logs-retention',
        title: t('settings.logs.retention'),
        note: t('settings.logs.retentionNote'),
        lock: t('settings.logs.retentionLock'),
        value: retention,
        enabled: !held && retention !== null,
        options: RETENTION_DAYS.map((n) => ({ value: String(n), label: t('settings.unit.days', { n }),
          change: { kind: 'logs.retention', days: n } })),
      },
      files: { title: t('settings.logs.files'), text: files,
        export: { label: t('settings.logs.export'), enabled: !held, action: 'export_audit' } },
      recorded: { title: t('settings.logs.recorded'), note: t('settings.logs.recordedNote'), fixed: t('settings.logs.fixed') },
    },
    changes: {
      title: t('settings.logs.recentChanges'),
      rows: (snapshot?.recent_changes ?? []).map((c, i): ChangeRow => ({
        key: `${c.at}:${i}`, at: changeTime(c.at), text: changeText(t, c, snapshot),
        reason: c.reason, verified: c.verified === true ? t('settings.logs.verified') : null,
      })),
      empty: t('settings.logs.noChanges'),
      maxHeight: 320,
    },
  }
}

export const tab: TabModule = {
  id: 'logs',
  render(props, ui) {
    const { h, styles } = ui
    const view = buildLogsView(props.snapshot, props)
    const header = h('div', { key: 'header', style: { display: 'grid', gap: 2 } },
      h('h3', { style: { ...styles.heading, fontSize: 15 } }, view.title),
      h('p', { style: styles.note }, view.note))
    if (!view.ready) return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'logs' }, header)

    const run = (key: string, c: ActionControl, variant?: 'primary' | 'outline' | 'ghost') =>
      ui.button({ key, label: c.label, disabled: !c.enabled, variant, onClick: () => void props.action(c.action) })
    const title = (text: string) => h('span', { style: { ...styles.heading, flex: '1 1 160px', minWidth: 0 } }, text)
    const a = view.auditLog
    const l = a.location
    const r = a.retention
    const f = a.files
    const rec = a.recorded
    const audit = ui.card({
      key: 'auditLog', title: a.title,
      children: [
        h('div', { key: 'location', style: { display: 'grid', gap: 4 }, 'data-logs': 'location' },
          h('div', { style: styles.row },
            h('span', { style: { ...styles.line, flex: '1 1 160px', minWidth: 0 } },
              h('span', { style: styles.heading }, l.title), l.defaultTag === null ? null : ui.tag(l.defaultTag, 'quiet')),
            h('div', { style: styles.actions },
              run('reveal', l.reveal), run('choose', l.choose), l.useDefault === null ? null : run('useDefault', l.useDefault, 'ghost'))),
          h('code', { style: { ...styles.code, overflowWrap: 'anywhere' } }, l.path),
          h('p', { style: styles.note }, l.note)),
        h('div', { key: 'retention', style: { display: 'grid', gap: 4 }, 'data-logs': 'retention' },
          h('div', { style: styles.row }, title(r.title),
            ui.segmented({ key: 'choice', id: r.id, label: r.title, value: r.value ?? '', disabled: !r.enabled,
              options: r.options.map((o) => ({ value: o.value, label: o.label })),
              onChange: (next) => {
                const option = r.options.find((o) => o.value === next)
                if (option !== undefined && next !== r.value) void props.apply(option.change)
              } })),
          h('p', { style: styles.note }, r.note),
          h('p', { style: styles.quiet }, r.lock)),
        h('div', { key: 'files', style: { display: 'grid', gap: 4 }, 'data-logs': 'files' },
          h('div', { style: styles.row }, title(f.title), run('export', f.export)),
          h('p', { style: styles.note }, f.text)),
        h('div', { key: 'recorded', style: { display: 'grid', gap: 4 }, 'data-logs': 'recorded' },
          h('div', { style: styles.row }, title(rec.title), ui.tag(rec.fixed, 'quiet')),
          h('p', { style: styles.note }, rec.note)),
      ],
    })
    const c = view.changes
    const changes = ui.card({
      key: 'changes', title: c.title,
      children: [ui.list({
        key: 'list', label: c.title, empty: c.empty, maxHeight: c.maxHeight,
        rows: c.rows.map((row) => h('div', { key: row.key, style: styles.row, 'data-change': row.key },
          h('code', { style: { ...styles.code, flex: 'none' } }, row.at),
          h('span', { style: { flex: '1 1 160px', minWidth: 0 } }, row.text),
          row.reason === null ? null : h('code', { style: { ...styles.code, color: 'var(--dsw-alias-label-secondary)' } }, row.reason),
          row.verified === null ? null : ui.tag(row.verified, 'info'))),
      })],
    })
    return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'logs' }, header, audit, changes)
  },
}
