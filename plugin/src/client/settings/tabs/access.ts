/**
 * 档位与默认 (Modes and defaults), ported from the native page (Sources/cu-runtime/SettingsAccessPage.swift): the three
 * modes explained (static cards: 浏览, 可操作 and 完全放权, the last not available yet), then one segmented control per
 * access rule (snapshot.access) offering exactly the values the daemon offers for it (snapshot.access_choices): the
 * new-session default mode (with 完全放权 shown and disabled, as the native page does: it is never a default), how long
 * "this session" lasts, the dialogs per turn, the dialog timeout and the dialog's default button. Choosing another
 * value sends `{kind: 'access.set', field, value}` with the offered value as the daemon gave it (a string or a
 * number); choosing the shown value sends nothing. Then the fixed rules, as text.
 *
 * The daemon decides what loosens and asks the person at the Mac for Touch ID or the login password itself; the lock
 * notes beside the controls are the native page's hints, nothing more. Every control is disabled while
 * TabProps.pending is true and before the first snapshot.
 *
 * @module
 */

import type { Translate } from '../../view.ts'
import type { AccessEdit, SettingsChange } from '../change.ts'
import type { Snapshot } from '../model.ts'
import type { TabModule, Tone } from '../tab.ts'

export type AccessField = AccessEdit['field']

/** The access rules in the native page's order. */
export const ACCESS_FIELDS: readonly AccessField[] = ['default_mode', 'session_limit_minutes', 'dialogs_per_turn',
  'dialog_timeout_seconds', 'dialog_default']

/** The value the native page shows after the offered default modes, always disabled (full power is never a default). */
export const FULL_POWER = 'max'

/** One choice of a segmented control. */
export interface AccessOption {
  /** The value as the control carries it: the offered value as text (numbers in decimal). */
  readonly value: string
  readonly label: string
  /** 完全放权, which is never offered as a default. */
  readonly disabled: boolean
  /**
   * Exactly what apply sends when it is chosen: `{kind: 'access.set', field, value}` with the daemon's offered value
   * (its own JSON type). null for the value shown now, for a disabled choice and while the row is not enabled.
   */
  readonly change: SettingsChange | null
}

/** One rule: its explanation on the left, its control and the native lock note on the right. */
export interface AccessRow {
  readonly field: AccessField
  readonly title: string
  readonly note: string
  /** The native page's hint for which direction the daemon verifies; null where the native page shows none. */
  readonly lock: string | null
  /** The stored value as text; '' when the snapshot has none of a known type (then no choice is shown as selected). */
  readonly value: string
  readonly options: readonly AccessOption[]
  /** false while pending or before the first snapshot. */
  readonly enabled: boolean
  /** Shown instead of the control when the daemon offers no value for the field. */
  readonly noChoices: string
}

export interface TierCard {
  readonly id: 'read' | 'full' | 'max'
  readonly chip: { readonly text: string; readonly tone: Tone }
  readonly title: string
  readonly items: readonly string[]
  /** 尚未提供 under the full-power card; null otherwise. */
  readonly note: string | null
}

export interface AccessView {
  readonly title: string
  readonly note: string
  /** false before the first snapshot: the tiers and the fixed rules are drawn, the rules' controls are disabled. */
  readonly ready: boolean
  readonly tiers: readonly TierCard[]
  /** The native page's cards: the new-session default; this session; the dialogs (count, timeout, default button). */
  readonly cards: readonly { readonly key: string; readonly title: string; readonly rows: readonly AccessRow[] }[]
  readonly fixedRules: { readonly title: string; readonly items: readonly string[] }
}

/** The fields whose values are names (`settings.value.<field>.<value>`), with the names this page has words for. */
const NAMED: Readonly<Partial<Record<AccessField, readonly string[]>>> = {
  default_mode: ['ask', 'read', 'full'],
  dialog_default: ['deny', 'turn', 'session', 'always'],
}

/** The fields whose values are whole numbers, with their unit (`settings.unit.<unit>`). */
const UNITS: Readonly<Partial<Record<AccessField, 'minutes' | 'times' | 'seconds'>>> = {
  session_limit_minutes: 'minutes', dialogs_per_turn: 'times', dialog_timeout_seconds: 'seconds',
}

/**
 * The daemon's offered values for a field that the change can carry: strings for a named field, whole numbers for a
 * numeric one, each once, in the daemon's order. Anything else is left out.
 */
export function offeredValues(snapshot: Snapshot | null, field: AccessField): (string | number)[] {
  const raw = snapshot?.access_choices[field]
  if (!Array.isArray(raw)) return []
  const out: (string | number)[] = []
  for (const v of raw) {
    const fits = NAMED[field] !== undefined ? typeof v === 'string' && v !== '' : typeof v === 'number' && Number.isInteger(v)
    if (fits && !out.some((o) => String(o) === String(v))) out.push(v as string | number)
  }
  return out
}

function valueLabel(t: Translate, field: AccessField, value: string | number): string {
  const unit = UNITS[field]
  if (unit !== undefined) return t(`settings.unit.${unit}`, { n: value })
  return typeof value === 'string' && NAMED[field]?.includes(value) ? t(`settings.value.${field}.${value}`) : String(value)
}

/** The stored value as text: a string as is, a finite number in decimal; '' for anything else. */
function storedValue(snapshot: Snapshot | null, field: AccessField): string {
  const v = snapshot?.access[field]
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? String(v) : ''
}

function row(t: Translate, snapshot: Snapshot | null, field: AccessField, text: string, lock: boolean, enabled: boolean): AccessRow {
  const value = storedValue(snapshot, field)
  const options: AccessOption[] = offeredValues(snapshot, field).map((v) => ({
    value: String(v),
    label: valueLabel(t, field, v),
    disabled: false,
    change: !enabled || String(v) === value ? null : { kind: 'access.set', ...({ field, value: v } as AccessEdit) },
  }))
  if (field === 'default_mode' && options.length > 0) {
    options.push({ value: FULL_POWER, label: t('settings.access.fullPower'), disabled: true, change: null })
  }
  return {
    field,
    title: t(`settings.access.${text}.title`),
    note: t(`settings.access.${text}.note`),
    lock: lock ? t(`settings.access.${text}.lock`) : null,
    value, options, enabled,
    noChoices: t('settings.access.noChoices'),
  }
}

/**
 * The tab's view.
 * @param snapshot - null before the first read (ready false, every control disabled).
 * @param options.pending - every control is disabled while true (TabProps.pending).
 */
export function buildAccessView(snapshot: Snapshot | null, { t, pending }: { t: Translate; pending: boolean }): AccessView {
  const enabled = !pending && snapshot !== null
  const items = (tier: string) => [1, 2, 3, 4].map((i) => t(`settings.access.tier.${tier}.item${i}`))
  return {
    title: t('settings.access.title'),
    note: t('settings.access.note'),
    ready: snapshot !== null,
    tiers: [
      { id: 'read', chip: { text: t('settings.mode.read'), tone: 'info' }, title: t('settings.access.tier.read.title'), items: items('read'), note: null },
      { id: 'full', chip: { text: t('settings.mode.full'), tone: 'warning' }, title: t('settings.access.tier.full.title'), items: items('full'), note: null },
      { id: 'max', chip: { text: t('settings.access.fullPower'), tone: 'danger' }, title: t('settings.access.tier.max.title'), items: items('max'),
        note: t('settings.access.tier.max.note') },
    ],
    cards: [
      { key: 'newSession', title: t('settings.access.newSession'), rows: [row(t, snapshot, 'default_mode', 'defaultMode', true, enabled)] },
      { key: 'session', title: t('settings.access.session.title'), rows: [row(t, snapshot, 'session_limit_minutes', 'session', true, enabled)] },
      { key: 'dialogs', title: t('settings.access.dialogs.title'), rows: [
        row(t, snapshot, 'dialogs_per_turn', 'dialogs', true, enabled),
        row(t, snapshot, 'dialog_timeout_seconds', 'timeout', false, enabled),
        row(t, snapshot, 'dialog_default', 'defaultButton', true, enabled),
      ] },
    ],
    fixedRules: { title: t('settings.access.fixedRules'), items: [1, 2, 3, 4].map((i) => t(`settings.access.fixedRule${i}`)) },
  }
}

export const tab: TabModule = {
  id: 'access',
  render(props, ui) {
    const { h, styles } = ui
    const view = buildAccessView(props.snapshot, props)
    const bullets = (key: string, items: readonly string[]) => h('ul', { key, style: { margin: 0, paddingLeft: 18, display: 'grid', gap: 3 } },
      ...items.map((item, i) => h('li', { key: String(i), style: styles.note }, item)))
    const header = h('div', { key: 'header', style: { display: 'grid', gap: 2 } },
      h('h3', { style: { ...styles.heading, fontSize: 15 } }, view.title),
      h('p', { style: styles.note }, view.note))
    const tiers = h('div', { key: 'tiers', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 } },
      ...view.tiers.map((c) => h('section', { key: c.id, 'data-tier': c.id,
        style: { display: 'grid', gap: 8, alignContent: 'start', padding: 16, borderRadius: 12, border: '1px solid var(--dsw-alias-border-l2)' } },
      h('div', { style: styles.line }, ui.tag(c.chip.text, c.chip.tone)),
      h('h4', { style: styles.heading }, c.title),
      bullets('items', c.items),
      c.note === null ? null : h('p', { style: styles.quiet }, c.note))))
    const control = (r: AccessRow) => r.options.length === 0 ? h('p', { style: styles.quiet }, r.noChoices)
      : ui.segmented({
        id: `cu-runtime-access-${r.field}`, label: r.title, value: r.value, disabled: !r.enabled,
        options: r.options.map((o) => ({ value: o.value, label: o.label, disabled: o.disabled })),
        onChange: (next) => {
          const change = r.options.find((o) => o.value === next)?.change ?? null
          if (r.enabled && change !== null) void props.apply(change)
        },
      })
    const rowNode = (r: AccessRow) => h('div', { key: r.field, style: { ...styles.row, alignItems: 'flex-start' }, 'data-access-field': r.field },
      h('div', { style: { display: 'grid', gap: 2, flex: '1 1 240px', minWidth: 0 } },
        h('span', { style: styles.heading }, r.title),
        h('p', { style: styles.note }, r.note)),
      h('div', { style: { display: 'grid', gap: 6, justifyItems: 'end', flex: '0 1 auto', minWidth: 0 } },
        control(r),
        r.lock === null ? null : h('span', { style: { ...styles.warn, fontSize: 11 }, 'data-lock': r.field }, r.lock)))
    const cards = view.cards.map((c) => ui.card({ key: c.key, title: c.title, children: c.rows.map(rowNode) }))
    const fixed = ui.card({ key: 'fixedRules', title: view.fixedRules.title, children: [bullets('rules', view.fixedRules.items)] })
    return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'access' }, header, tiers, ...cards, fixed)
  },
}
