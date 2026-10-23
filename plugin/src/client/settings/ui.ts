/**
 * The Kit (tab.ts) the settings tabs draw with: the running dsh's primitives, each checked with present() before use
 * (what dsh 0.2.1-rc.2 ships; an older 0.2.x may lack some), and a plain element in its place otherwise.
 *
 * @module
 */

import { createElement as h, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { DotState, Translate } from '../view.ts'
import type { ButtonSpec, Kit, KitStyle, Tone } from './tab.ts'

/** Whether the running dsh ships this primitive: a function component, or a forwardRef / memo object. */
export const present = (component: unknown): boolean =>
  typeof component === 'function' || (typeof component === 'object' && component !== null)

/** The default height of a long list's box before it scrolls. */
export const LIST_MAX_HEIGHT = 240

/**
 * The border of every button but a primary one, dsh's Button included: dsh 0.2.1-rc.2 draws its outline variant with
 * .5px of --dsw-alias-border-l3 and its ghost variant with none, which reads as no border at all on a light theme (VM,
 * 2026-10-21); 1px of border-l2 shows it. Handed to dsh's Button as style (it passes extra props to its <button>).
 */
export const BUTTON_BORDER = '1px solid var(--dsw-alias-border-l2)'

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'

export const STYLES: Readonly<Record<KitStyle | 'card' | 'cardHead' | 'list' | 'listRow' | 'button' | 'dialog' | 'kbd'
  | 'app' | 'appName', CSSProperties>> = {
  tab: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 },
  line: { display: 'flex', alignItems: 'center', gap: 8, margin: 0, minWidth: 0 },
  row: { display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flexWrap: 'wrap' },
  heading: { margin: 0, fontSize: 13, fontWeight: 600 },
  note: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
  quiet: { margin: 0, color: 'var(--dsw-alias-label-secondary)' },
  warn: { margin: 0, color: 'var(--dsw-alias-state-warn-primary)' },
  error: { margin: 0, color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' },
  code: { fontFamily: MONO, fontSize: 12, overflowWrap: 'anywhere' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  card: { display: 'grid', gap: 10, padding: 14, border: '.5px solid var(--dsw-alias-border-l1)', borderRadius: 10, minWidth: 0 },
  cardHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, minWidth: 0 },
  list: { display: 'grid', overflow: 'auto', minWidth: 0 },
  listRow: { padding: '6px 0', borderTop: '.5px solid var(--dsw-alias-border-l1)', minWidth: 0 },
  button: {
    padding: '4px 12px', borderRadius: 8, border: BUTTON_BORDER,
    background: 'none', color: 'inherit', font: 'inherit',
  },
  dialog: { display: 'grid', gap: 10, padding: 14, border: '.5px solid var(--dsw-alias-border-l4)', borderRadius: 10 },
  kbd: { fontFamily: MONO, fontSize: 11, padding: '0 4px', border: '.5px solid var(--dsw-alias-border-l4)', borderRadius: 4 },
  app: { display: 'grid', minWidth: 0 },
  appName: { fontWeight: 600, overflowWrap: 'anywhere' },
}

const DOT_COLOR: Record<DotState, string> = {
  done: 'var(--dsw-alias-state-success-primary)',
  warning: 'var(--dsw-alias-state-warn-primary)',
  ongoing: 'var(--dsw-alias-state-business-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
  idle: 'var(--dsw-alias-state-idle-primary)',
}

export function button({ key, label, onClick, disabled = false, variant = 'outline' }: ButtonSpec): ReactNode {
  const { Button } = primitives
  const props = { key: key ?? label, disabled, onClick }
  return present(Button)
    ? h(Button!, { ...props, variant, size: 'sm', ...(variant === 'primary' ? {} : { style: { border: BUTTON_BORDER } }) }, label)
    : h('button', { ...props, type: 'button', style: { ...STYLES.button, opacity: disabled ? 0.5 : 1 } }, label)
}

export function dot(state: DotState): ReactNode {
  const { StateDot } = primitives
  if (present(StateDot)) return h(StateDot!, { state })
  return h('span', { 'aria-hidden': true, 'data-state': state,
    style: { flex: 'none', width: 8, height: 8, borderRadius: '50%', background: DOT_COLOR[state] } })
}

export function tag(text: string, tone: Tone = 'neutral'): ReactNode {
  const { Tag } = primitives
  return present(Tag) ? h(Tag!, { tone }, text) : h('span', { 'data-tone': tone }, text)
}

/**
 * The tab bar: dsh's SegmentedTabs when present, else a tablist of plain buttons. Tab `id`s are
 * `cu-runtime-tab-<value>`, their panels' `cu-runtime-panel-<value>` (tabPanelId).
 */
export function tabBar(spec: { label: string; value: string; items: readonly { value: string; label: string }[];
  onChange: (value: string) => void }): ReactNode {
  const { SegmentedTabs } = primitives
  const items = spec.items.map((i) => ({ ...i, id: `cu-runtime-tab-${i.value}`, panelId: tabPanelId(i.value) }))
  if (present(SegmentedTabs)) return h(SegmentedTabs!, { items, value: spec.value, onChange: spec.onChange, label: spec.label })
  return h('div', { role: 'tablist', 'aria-label': spec.label, style: { ...STYLES.actions, gap: 4 } },
    ...items.map((i) => {
      const selected = i.value === spec.value
      return h('button', {
        key: i.value, type: 'button', role: 'tab', id: i.id, 'aria-selected': selected, 'aria-controls': i.panelId,
        tabIndex: selected ? 0 : -1, onClick: () => spec.onChange(i.value),
        style: { ...STYLES.button, fontWeight: selected ? 600 : 400, background: selected ? 'var(--dsw-alias-bg-module-platform)' : 'none' },
      }, i.label)
    }))
}

export const tabPanelId = (value: string): string => `cu-runtime-panel-${value}`

/** The Kit for one draw, its texts (the dialog's close and cancel labels) in the page's language. */
export function makeKit(t: Translate): Kit {
  return {
    h, useState, useEffect, styles: STYLES, button, tag, dot,
    appLabel(app) {
      return h('span', { style: STYLES.app, 'data-cu-runtime-app': app.bundle_id },
        h('span', { style: STYLES.appName }, app.name ?? app.bundle_id),
        h('code', { style: { ...STYLES.code, color: 'var(--dsw-alias-label-secondary)' } }, app.bundle_id))
    },
    list({ key, label, rows, empty, maxHeight = LIST_MAX_HEIGHT }) {
      if (rows.length === 0) return h('p', { key, style: STYLES.quiet }, empty)
      return h('div', { key, role: 'list', 'aria-label': label, 'data-cu-runtime-list': '', style: { ...STYLES.list, maxHeight } },
        ...rows.map((row, i) => h('div', { key: String(i), role: 'listitem', style: STYLES.listRow }, row)))
    },
    confirm({ open, title, text, confirmLabel, onConfirm, onCancel }) {
      if (!open) return null
      const footer = h('div', { style: STYLES.actions },
        button({ key: 'cancel', label: t('settings.cancel'), onClick: onCancel }),
        button({ key: 'confirm', label: confirmLabel, onClick: onConfirm, variant: 'primary' }))
      const { Modal } = primitives
      if (present(Modal)) return h(Modal!, { open, onClose: onCancel, title, closeLabel: t('settings.close'), description: text, footer })
      return h('div', { role: 'dialog', 'aria-modal': true, 'aria-label': title, style: STYLES.dialog },
        h('p', { style: STYLES.heading }, title), h('p', { style: STYLES.quiet }, text), footer)
    },
    card({ key, title, note, trailing, children }) {
      return h('section', { key, style: STYLES.card },
        h('div', { style: STYLES.cardHead },
          h('div', { style: { display: 'grid', gap: 2, minWidth: 0 } },
            h('h4', { style: STYLES.heading }, title),
            note === undefined ? null : h('p', { style: STYLES.note }, note)),
          trailing ?? null),
        ...children)
    },
    switch({ key, checked, onChange, label, disabled = false }) {
      const { Switch } = primitives
      if (present(Switch)) return h(Switch!, { key, checked, onChange, label, disabled })
      return h('label', { key, style: STYLES.line },
        h('input', { type: 'checkbox', role: 'switch', checked, disabled, 'aria-checked': checked,
          onChange: (e: { target: { checked: boolean } }) => onChange(e.target.checked) }),
        h('span', null, label))
    },
    segmented({ key, id, value, options, onChange, label, disabled = false }) {
      const { SegmentedControl } = primitives
      if (present(SegmentedControl)) return h(SegmentedControl!, { key, id, value, options, onChange, label, disabled })
      return h('div', { key, id, role: 'radiogroup', 'aria-label': label, style: { ...STYLES.actions, gap: 4 } },
        ...options.map((o) => h('button', {
          key: o.value, type: 'button', role: 'radio', 'aria-checked': o.value === value,
          disabled: disabled || o.disabled === true, onClick: () => onChange(o.value),
          style: { ...STYLES.button, fontWeight: o.value === value ? 600 : 400, opacity: disabled || o.disabled === true ? 0.5 : 1 },
        }, o.label)))
    },
    input({ key, value, onChange, label, placeholder, disabled = false, maxLength }) {
      const { Input } = primitives
      const props = { key, value, disabled, 'aria-label': label, onChange: (e: { target: { value: string } }) => onChange(e.target.value),
        ...(placeholder === undefined ? {} : { placeholder }), ...(maxLength === undefined ? {} : { maxLength }) }
      return present(Input) ? h(Input!, props) : h('input', { ...props, type: 'text', style: { ...STYLES.button, minWidth: 0 } })
    },
    disclosure({ key, title, open, onToggle, children }) {
      const { DisclosureRow } = primitives
      if (present(DisclosureRow)) return h(DisclosureRow!, { key, icon: null, title, open, expandable: true, onToggle }, ...children)
      return h('div', { key, style: { display: 'grid', gap: 8 } },
        h('button', { type: 'button', 'aria-expanded': open, onClick: onToggle, style: { ...STYLES.button, justifySelf: 'start' } },
          `${open ? '▾' : '▸'} ${title}`),
        ...(open ? children : []))
    },
    keys(keys) {
      const { ShortcutKeys } = primitives
      if (present(ShortcutKeys)) return h(ShortcutKeys!, { keys })
      return h('span', { style: { ...STYLES.line, gap: 2 } }, ...keys.map((k, i) => h('kbd', { key: String(i), style: STYLES.kbd }, k)))
    },
    toast({ text, onDone }) {
      const { Toast } = primitives
      return present(Toast) ? h(Toast!, { text, onDone }) : h('p', { role: 'status', style: STYLES.quiet }, text)
    },
  }
}
