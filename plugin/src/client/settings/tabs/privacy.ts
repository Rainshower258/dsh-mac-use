/**
 * 隐私与审计 (Privacy and audit), ported from the native page (Sources/cu-runtime/SettingsPrivacyPage.swift) without its
 * dsh-session card (the size and Finder reveal of dsh's records are not shown here) and with the audit on the 日志
 * tab:
 *
 * - 发送内容: four switches, one per kind of content sent to the model (snapshot.privacy send_screenshots,
 *   send_ax_text (界面文本), send_ocr, send_zoom), each sending `{kind: 'privacy.set', field, on}`; and the text-only
 *   apps (privacy.text_only_apps) in a list of limited height, each with 移除 (`{kind: 'text_only.remove', bundle_id}`).
 *   添加应用… runs the daemon's app panel (`action('choose_app')`); once the person picked an app there
 *   (snapshot.picked_app, with a choose_app outcome `done` settled after the click) the tab shows it with 加入仅文本应用,
 *   which sends `{kind: 'text_only.add', bundle_id}`.
 * - 剪贴板: one switch, `{kind: 'clipboard.set', on}` (privacy.clear_clipboard_on_turn_start).
 *
 * A switch whose stored value is not a boolean is shown off and disabled (nothing is sent for a value the page cannot
 * read). The daemon decides what loosens and asks for Touch ID or the login password itself; the lock note and the
 * list's note are the native page's hints only. Every control is disabled while TabProps.pending is true and before
 * the first snapshot.
 *
 * @module
 */

import type { ReactNode } from 'react'
import type { Translate } from '../../view.ts'
import type { PrivacyField, SettingsChange } from '../change.ts'
import { appName, type AppRef, type Snapshot } from '../model.ts'
import type { TabModule } from '../tab.ts'

/** The content switches in the native page's order. */
export const PRIVACY_FIELDS: readonly PrivacyField[] = ['send_screenshots', 'send_ax_text', 'send_ocr', 'send_zoom']

/** A control that changes something: enabled only while nothing is pending, `change` exactly what apply sends. */
export interface ChangeControl {
  readonly label: string
  readonly enabled: boolean
  readonly change: SettingsChange
}

export interface SwitchRow {
  readonly field: PrivacyField | 'clear_clipboard_on_turn_start'
  readonly title: string
  readonly note: string
  /** The stored value; false when it is not a boolean (`known` false). */
  readonly checked: boolean
  readonly known: boolean
  /** false while pending, before the first snapshot and when the stored value is not a boolean. */
  readonly enabled: boolean
  /** What turning it over sends: the field with `on` the opposite of `checked`. */
  readonly change: SettingsChange
}

export interface TextOnlyRow {
  readonly key: string
  readonly app: AppRef
  readonly remove: ChangeControl
}

/** The app picked in the daemon's panel after 添加应用…, waiting to be added. */
export interface PickedApp {
  readonly app: AppRef
  readonly text: string
  /** Already on the list (bundle IDs compare ignoring case, as the daemon's do): shown, the add disabled. */
  readonly listed: boolean
  readonly listedText: string
  readonly add: ChangeControl
  readonly dismiss: string
}

export interface PrivacyView {
  readonly title: string
  readonly note: string
  /** false before the first snapshot: only the title and note are drawn (the shell says it is reading). */
  readonly ready: boolean
  readonly sent: { readonly title: string; readonly lock: string; readonly switches: readonly SwitchRow[] }
  readonly textOnly: {
    readonly title: string
    readonly note: string
    /** 添加应用…: runs `action('choose_app')`. */
    readonly add: { readonly label: string; readonly enabled: boolean }
    readonly rows: readonly TextOnlyRow[]
    readonly empty: string
    readonly picked: PickedApp | null
  }
  readonly clipboard: { readonly title: string; readonly switch: SwitchRow }
}

/** The text-only apps the snapshot lists: its strings, in its order. */
function textOnlyApps(snapshot: Snapshot | null): string[] {
  const v = snapshot?.privacy.text_only_apps
  return Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string' && id !== '') : []
}

function switchRow(snapshot: Snapshot | null, field: SwitchRow['field'], title: string, note: string, enabled: boolean): SwitchRow {
  const v = snapshot?.privacy[field]
  const known = typeof v === 'boolean'
  const checked = v === true
  const change: SettingsChange = field === 'clear_clipboard_on_turn_start' ? { kind: 'clipboard.set', on: !checked }
    : { kind: 'privacy.set', field, on: !checked }
  return { field, title, note, checked, known, enabled: enabled && known, change }
}

/**
 * The app the person picked after this tab's 添加应用…: snapshot.picked_app when the last outcome is choose_app `done`
 * settled no earlier than the click (a second's slack for the clocks' rounding); otherwise null, so an app picked
 * before, or for another tab, is not offered here.
 * @param since - Date.now() when 添加应用… was clicked; null when it was not clicked on this tab.
 */
export function pickedForTextOnly(snapshot: Snapshot | null, since: number | null): AppRef | null {
  if (snapshot === null || since === null || snapshot.picked_app === null) return null
  const o = snapshot.last_outcome
  return o !== null && o.kind === 'choose_app' && o.outcome === 'done' && o.at >= since / 1000 - 1 ? snapshot.picked_app : null
}

/**
 * The tab's view.
 * @param snapshot - null before the first read (ready false, every control disabled).
 * @param options.pending - every control is disabled while true (TabProps.pending).
 * @param options.pickSince - Date.now() when this tab's 添加应用… was clicked, or null (see pickedForTextOnly).
 */
export function buildPrivacyView(snapshot: Snapshot | null,
  { t, pending, pickSince = null }: { t: Translate; pending: boolean; pickSince?: number | null }): PrivacyView {
  const enabled = !pending && snapshot !== null
  const listed = textOnlyApps(snapshot)
  const named = (id: string): AppRef => ({ bundle_id: id, name: appName(snapshot, id) })
  const picked = pickedForTextOnly(snapshot, pickSince)
  const isListed = picked !== null && listed.some((id) => id.toLowerCase() === picked.bundle_id.toLowerCase())
  return {
    title: t('settings.privacy.title'),
    note: t('settings.privacy.note'),
    ready: snapshot !== null,
    sent: {
      title: t('settings.privacy.sent.title'),
      lock: t('settings.privacy.sent.lock'),
      switches: PRIVACY_FIELDS.map((f) => switchRow(snapshot, f, t(`settings.field.privacy.${f}`), t(`settings.privacy.${f}.note`), enabled)),
    },
    textOnly: {
      title: t('settings.privacy.textOnly.title'),
      note: t('settings.privacy.textOnly.note'),
      add: { label: t('settings.privacy.textOnly.add'), enabled },
      rows: listed.map((id, i): TextOnlyRow => ({
        key: `${i}:${id}`,
        app: named(id),
        remove: { label: t('settings.privacy.textOnly.remove'), enabled, change: { kind: 'text_only.remove', bundle_id: id } },
      })),
      empty: t('settings.privacy.textOnly.empty'),
      picked: picked === null ? null : {
        app: { bundle_id: picked.bundle_id, name: picked.name ?? appName(snapshot, picked.bundle_id) },
        text: t('settings.privacy.textOnly.picked'),
        listed: isListed,
        listedText: t('settings.privacy.textOnly.listed'),
        add: { label: t('settings.privacy.textOnly.addPicked'), enabled: enabled && !isListed,
          change: { kind: 'text_only.add', bundle_id: picked.bundle_id } },
        dismiss: t('settings.privacy.textOnly.dismiss'),
      },
    },
    clipboard: {
      title: t('settings.privacy.clipboard.title'),
      switch: switchRow(snapshot, 'clear_clipboard_on_turn_start', t('settings.privacy.clipboard.label'),
        t('settings.privacy.clipboard.note'), enabled),
    },
  }
}

export const tab: TabModule = {
  id: 'privacy',
  render(props, ui) {
    const { h, styles } = ui
    const [pickSince, setPickSince] = ui.useState<number | null>(null)
    const view = buildPrivacyView(props.snapshot, { t: props.t, pending: props.pending, pickSince })
    const header = h('div', { key: 'header', style: { display: 'grid', gap: 2 } },
      h('h3', { style: { ...styles.heading, fontSize: 15 } }, view.title),
      h('p', { style: styles.note }, view.note))
    if (!view.ready) return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'privacy' }, header)
    const setting = (key: string, title: string, note: string, control: ReactNode, extra: Record<string, string> = {}) =>
      h('div', { key, style: { ...styles.row, alignItems: 'flex-start' }, ...extra },
        h('div', { style: { display: 'grid', gap: 2, flex: '1 1 240px', minWidth: 0 } },
          h('span', { style: styles.heading }, title),
          h('p', { style: styles.note }, note)),
        control)
    const switchNode = (s: SwitchRow) => setting(s.field, s.title, s.note, ui.switch({
      key: 'switch', label: s.title, checked: s.checked, disabled: !s.enabled,
      onChange: (next) => { if (s.enabled && next !== s.checked) void props.apply(s.change) },
    }), { 'data-privacy-field': s.field })
    const o = view.textOnly
    const p = o.picked
    const picked = p === null ? null : h('div', { key: 'picked', style: styles.row, 'data-picked-app': p.app.bundle_id },
      h('div', { style: { display: 'grid', gap: 2, flex: '1 1 200px', minWidth: 0 } },
        h('p', { style: styles.note }, p.text), ui.appLabel(p.app),
        p.listed ? h('p', { style: styles.quiet }, p.listedText) : null),
      h('div', { style: styles.actions },
        ui.button({ key: 'dismiss', label: p.dismiss, onClick: () => setPickSince(null), variant: 'ghost' }),
        ui.button({ key: 'addPicked', label: p.add.label, disabled: !p.add.enabled, variant: 'primary',
          onClick: () => void props.apply(p.add.change).then((ok) => { if (ok) setPickSince(null) }) })))
    const textOnly = h('div', { key: 'textOnly', style: { display: 'grid', gap: 8 }, 'data-privacy-field': 'text_only_apps' },
      setting('head', o.title, o.note, ui.button({ key: 'add', label: o.add.label, disabled: !o.add.enabled,
        onClick: () => {
          const clicked = Date.now()
          void props.action('choose_app').then((ok) => { if (ok) setPickSince(clicked) })
        } })),
      picked,
      ui.list({
        key: 'list', label: o.title, empty: o.empty,
        rows: o.rows.map((r) => h('div', { key: r.key, style: styles.row, 'data-text-only': r.app.bundle_id },
          h('div', { style: { flex: '1 1 160px', minWidth: 0 } }, ui.appLabel(r.app)),
          ui.button({ key: 'remove', label: r.remove.label, disabled: !r.remove.enabled, onClick: () => void props.apply(r.remove.change) }))),
      }))
    const s = view.sent
    const sent = ui.card({
      key: 'sent', title: s.title,
      trailing: h('span', { style: { ...styles.warn, fontSize: 11 }, 'data-lock': 'sent' }, s.lock),
      children: [...s.switches.map(switchNode), textOnly],
    })
    const clipboard = ui.card({ key: 'clipboard', title: view.clipboard.title, children: [switchNode(view.clipboard.switch)] })
    return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'privacy' }, header, sent, clipboard)
  },
}
