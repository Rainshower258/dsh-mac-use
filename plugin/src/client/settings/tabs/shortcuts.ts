/**
 * 快捷键 (Shortcuts), ported from the native page (Sources/cu-runtime/SettingsShortcutsPage.swift).
 *
 * - 内置允许 (snapshot.chords.builtin, the daemon's order): one switch per chord; off sends `{kind: 'chord.disable',
 *   chord}`, on `{kind: 'chord.enable', chord}`. They cannot be removed.
 * - 自定义 (snapshot.chords.custom): each chord with its note and where it applies; 移除 sends `{kind: 'chord.remove',
 *   chord, app}` with the entry's own `app` (null: every approved app). The add form takes the chord typed as the
 *   daemon writes it (cmd+shift+k; there is no recorder: a browser page never receives the combinations the system
 *   reserves, and the daemon parses and checks what is typed), every approved app or one app (a bundle ID typed or
 *   picked through the `choose_app` action), and a note, and sends `{kind: 'chord.add', chord, app, note}` (app null
 *   for every approved app, note always present, '' when none).
 * - 永不允许 (snapshot.chords.never): read-only, in the native window's readable order, with the F-keys and fn
 *   combinations the daemon refuses by rule.
 *
 * Every control that changes something is disabled while `pending`. Which change loosens anything (and so asks for
 * Touch ID or the password on the Mac) is the daemon's decision; the notes say what the native window says, as hints.
 * The chord text is parsed here only to draw it as key caps.
 *
 * @module
 */

import type { Translate } from '../../view.ts'
import { CHANGE_LIMITS, type SettingsChange } from '../change.ts'
import { appName, type AppRef, type Snapshot } from '../model.ts'
import type { TabModule } from '../tab.ts'
import { bundleIdOf, noteOf, pickOutcome, type ChangeControl } from './apps.ts'

/** The chords with words for what they do (settings.shortcuts.label.<chord>), in the daemon's chord text. */
export const CHORD_LABELS: readonly string[] = [
  'cmd+a', 'cmd+c', 'cmd+v', 'cmd+x', 'cmd+z', 'shift+cmd+z', 'cmd+f', 'cmd+g', 'cmd+w', 'cmd+n', 'cmd+s', 'cmd+q',
  'cmd+delete', 'cmd+l', 'shift+cmd+t', 'cmd+b', 'cmd+i', 'cmd+u', 'shift+cmd+left', 'shift+cmd+right', 'shift+cmd+up',
  'shift+cmd+down', 'opt+shift+left', 'opt+shift+right', 'opt+left', 'opt+right', 'opt+up', 'opt+down', 'cmd+left',
  'cmd+right', 'cmd+up', 'cmd+down', 'ctrl+cmd+q', 'shift+cmd+q', 'opt+cmd+escape', 'cmd+space', 'ctrl+space', 'cmd+tab',
  'opt+cmd+h', 'shift+cmd+3', 'shift+cmd+4', 'shift+cmd+5', 'ctrl+up', 'ctrl+down', 'ctrl+left', 'ctrl+right',
  'opt+cmd+d', 'ctrl+f2',
]

/** The never-allowed chords in a readable order (the native page's; the snapshot lists them sorted). */
export const NEVER_ORDER: readonly string[] = ['ctrl+cmd+q', 'shift+cmd+q', 'opt+cmd+escape', 'cmd+space', 'ctrl+space',
  'cmd+tab', 'opt+cmd+h', 'shift+cmd+3', 'shift+cmd+4', 'shift+cmd+5', 'ctrl+up', 'ctrl+down', 'ctrl+left', 'ctrl+right',
  'opt+cmd+d', 'ctrl+f2']

const MODIFIERS: Readonly<Record<string, string>> = {
  cmd: 'cmd', command: 'cmd', super: 'cmd', meta: 'cmd', ctrl: 'ctrl', control: 'ctrl', opt: 'opt', option: 'opt',
  alt: 'opt', shift: 'shift', fn: 'fn', globe: 'fn',
}
const MODIFIER_ORDER = ['ctrl', 'opt', 'shift', 'cmd', 'fn']
const MODIFIER_CAPS: Readonly<Record<string, string>> = { ctrl: '⌃', opt: '⌥', shift: '⇧', cmd: '⌘', fn: 'fn' }
const KEY_ALIASES: Readonly<Record<string, string>> = {
  enter: 'return', esc: 'escape', backspace: 'delete', pgup: 'pageup', pgdn: 'pagedown', arrowup: 'up', arrowdown: 'down',
  arrowleft: 'left', arrowright: 'right',
}
const KEY_CAPS: Readonly<Record<string, string>> = {
  return: '↩', tab: '⇥', space: 'Space', escape: '⎋', delete: '⌫', forwarddelete: '⌦', up: '↑', down: '↓', left: '←',
  right: '→', home: '↖', end: '↘', pageup: '⇞', pagedown: '⇟', minus: '-', equal: '=', comma: ',', period: '.',
  slash: '/', backslash: '\\', semicolon: ';', quote: "'", grave: '`', leftbracket: '[', rightbracket: ']',
}

/**
 * A chord's text as key caps, for drawing only (KeyCaps.caps in the native page): one cap per modifier in the Mac's
 * order (⌃ ⌥ ⇧ ⌘ fn), then the key (a symbol, else upper case). Text the daemon's parser would not read as one chord
 * (no key, two keys, an empty part) is one cap with the text as it is; which keys the daemon knows is its own check.
 */
export function chordCaps(text: string): string[] {
  const parts = text.toLowerCase().split('+').map((p) => p.trim())
  const mods = new Set<string>()
  let key: string | null = null
  for (const part of parts) {
    const mod = MODIFIERS[part]
    if (mod !== undefined) { mods.add(mod); continue }
    if (part === '' || key !== null) return [text]
    key = KEY_ALIASES[part] ?? part
  }
  if (key === null) return [text]
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)).map((m) => MODIFIER_CAPS[m]), KEY_CAPS[key] ?? key.toUpperCase()]
}

/** What a built-in or never-allowed chord does, or null when this page has no words for it. */
export function chordLabel(t: Translate, chord: string): string | null {
  return CHORD_LABELS.includes(chord) ? t(`settings.shortcuts.label.${chord}`) : null
}

export interface BuiltinRow {
  readonly key: string
  readonly chord: string
  readonly caps: readonly string[]
  /** What it does, or the chord itself when this page has no words for it. */
  readonly label: string
  readonly on: boolean
  /** The switch: enabled while nothing is pending; `change` is what flipping it sends (disable when on, enable when off). */
  readonly toggle: { readonly enabled: boolean; readonly change: SettingsChange }
  /** '已停用' while switched off, else null. */
  readonly off: string | null
}

export interface CustomRow {
  readonly key: string
  readonly chord: string
  readonly caps: readonly string[]
  readonly note: string
  readonly hasNote: boolean
  /** null: every approved app. */
  readonly app: AppRef | null
  /** Where it applies, in words. */
  readonly scope: string
  readonly remove: ChangeControl
}

/** The add form as the person is filling it in (the tab's own state, kept by render). */
export interface ChordForm {
  readonly chord: string
  readonly scope: 'all' | 'one'
  /** The bundle ID as typed or picked; only used with scope 'one'. */
  readonly app: string
  readonly note: string
}

export const EMPTY_CHORD_FORM: ChordForm = { chord: '', scope: 'all', app: '', note: '' }

export interface ShortcutsView {
  readonly title: string
  readonly note: string
  /** false before the first snapshot: only the title and note are drawn (the shell says it is reading). */
  readonly ready: boolean
  readonly builtin: { readonly title: string; readonly note: string; readonly rows: readonly BuiltinRow[]; readonly empty: string }
  readonly custom: {
    readonly title: string
    readonly note: string
    readonly add: { readonly label: string; readonly enabled: boolean }
    readonly rows: readonly CustomRow[]
    readonly empty: string
  }
  readonly form: {
    readonly title: string
    readonly comboLabel: string
    readonly chord: string
    /** The typed chord as key caps; empty while nothing is typed. */
    readonly caps: readonly string[]
    readonly comboHint: string
    readonly scopeLabel: string
    readonly scope: ChordForm['scope']
    readonly scopes: readonly { readonly value: ChordForm['scope']; readonly label: string }[]
    /** Shown with scope 'one' only. */
    readonly app: { readonly label: string; readonly value: string; readonly chooseApp: { readonly label: string; readonly enabled: boolean } } | null
    readonly waiting: string | null
    readonly stopWaiting: string
    readonly noteLabel: string
    readonly note: string
    readonly notePlaceholder: string
    readonly cancel: string
    /** Enabled for a chord of 1–64 characters, every approved app or a bundle ID the daemon takes, and a note it takes. */
    readonly submit: ChangeControl
  } | null
  readonly never: {
    readonly title: string
    readonly note: string
    readonly rows: readonly { readonly key: string; readonly chord: string; readonly caps: readonly string[]; readonly label: string | null }[]
    readonly empty: string
    /** The refusals by rule, not listed chord by chord: F1–F12 and fn combinations. */
    readonly rules: readonly string[]
  }
}

/** Control and format characters (Unicode Cc and Cf), as the daemon's CharacterSet.controlCharacters refuses them. */
const CONTROL = /[\p{Cc}\p{Cf}]/u

/** A typed chord as the daemon takes it before parsing it: trimmed, 1–CHANGE_LIMITS.chord characters, no control character. */
export function chordOf(text: string): string | null {
  const chord = text.trim()
  return chord.length > 0 && chord.length <= CHANGE_LIMITS.chord && !CONTROL.test(chord) ? chord : null
}

function neverRank(chord: string): number {
  const i = NEVER_ORDER.indexOf(chord)
  return i === -1 ? NEVER_ORDER.length : i
}

/**
 * The tab's view.
 * @param snapshot - null before the first read (ready false).
 * @param options.pending - every control that changes something is disabled while true (TabProps.pending).
 * @param options.form - the add form as filled in, or null while it is closed.
 * @param options.waiting - the add form waits for an app from the daemon's panel.
 */
export function buildShortcutsView(snapshot: Snapshot | null, { t, pending, form = null, waiting = false }:
  { t: Translate; pending: boolean; form?: ChordForm | null; waiting?: boolean }): ShortcutsView {
  const chords = snapshot?.chords ?? { builtin: [], never: [], custom: [] }
  const chord = form === null ? null : chordOf(form.chord)
  const app = form === null || form.scope === 'all' ? null : bundleIdOf(form.app)
  const note = form === null ? null : noteOf(form.note)
  const ready = form !== null && chord !== null && note !== null && (form.scope === 'all' || app !== null)
  return {
    title: t('settings.shortcuts.title'),
    note: t('settings.shortcuts.note'),
    ready: snapshot !== null,
    builtin: {
      title: t('settings.shortcuts.builtin.title'),
      note: t('settings.shortcuts.builtin.note'),
      rows: chords.builtin.map((c) => ({
        key: c.chord,
        chord: c.chord,
        caps: chordCaps(c.chord),
        label: chordLabel(t, c.chord) ?? c.chord,
        on: c.enabled,
        toggle: { enabled: !pending, change: c.enabled ? { kind: 'chord.disable', chord: c.chord } : { kind: 'chord.enable', chord: c.chord } },
        off: c.enabled ? null : t('settings.shortcuts.builtin.off'),
      })),
      empty: t('settings.shortcuts.builtin.empty'),
    },
    custom: {
      title: t('settings.shortcuts.custom.title'),
      note: t('settings.shortcuts.custom.note'),
      add: { label: t('settings.shortcuts.custom.add'), enabled: !pending && form === null },
      rows: chords.custom.map((c, i) => {
        const name = c.app === null ? null : appName(snapshot, c.app)
        return {
          key: `${c.chord}:${c.app ?? '*'}:${i}`,
          chord: c.chord,
          caps: chordCaps(c.chord),
          note: c.note === '' ? t('settings.value.none') : c.note,
          hasNote: c.note !== '',
          app: c.app === null ? null : { bundle_id: c.app, name },
          scope: c.app === null ? t('settings.shortcuts.custom.everyApp') : t('settings.shortcuts.custom.onlyIn', { app: name ?? c.app }),
          remove: { label: t('settings.shortcuts.custom.remove'), enabled: !pending, change: { kind: 'chord.remove', chord: c.chord, app: c.app } },
        }
      }),
      empty: t('settings.shortcuts.custom.empty'),
    },
    form: form === null ? null : {
      title: t('settings.shortcuts.form.title'),
      comboLabel: t('settings.shortcuts.form.combo'),
      chord: form.chord,
      caps: chord === null ? [] : chordCaps(chord),
      comboHint: t('settings.shortcuts.form.comboHint'),
      scopeLabel: t('settings.shortcuts.form.scope'),
      scope: form.scope,
      scopes: [{ value: 'all', label: t('settings.shortcuts.form.everyApp') }, { value: 'one', label: t('settings.shortcuts.form.oneApp') }],
      app: form.scope === 'all' ? null : {
        label: t('settings.shortcuts.form.bundleId'), value: form.app,
        chooseApp: { label: t('settings.shortcuts.form.chooseApp'), enabled: !pending && !waiting },
      },
      waiting: waiting ? t('settings.shortcuts.form.waiting') : null,
      stopWaiting: t('settings.shortcuts.form.stopWaiting'),
      noteLabel: t('settings.shortcuts.form.note'),
      note: form.note,
      notePlaceholder: t('settings.shortcuts.form.notePlaceholder'),
      cancel: t('settings.cancel'),
      submit: {
        label: t('settings.shortcuts.form.submit'), enabled: !pending && ready,
        change: { kind: 'chord.add', chord: chord ?? form.chord.trim(), app: form.scope === 'all' ? null : app ?? form.app.trim(), note: note ?? form.note.trim() },
      },
    },
    never: {
      title: t('settings.shortcuts.never.title'),
      note: t('settings.shortcuts.never.note'),
      rows: chords.never.map((c, i) => ({ c, i })).sort((a, b) => neverRank(a.c) - neverRank(b.c) || a.i - b.i)
        .map(({ c }) => ({ key: c, chord: c, caps: chordCaps(c), label: chordLabel(t, c) })),
      empty: t('settings.shortcuts.never.empty'),
      rules: [t('settings.shortcuts.never.fKeys'), t('settings.shortcuts.never.fnCombos')],
    },
  }
}

const FORM_STYLE = { display: 'grid', gap: 10, padding: 12, border: '.5px solid var(--dsw-alias-border-l4)', borderRadius: 10, minWidth: 0 }

export const tab: TabModule = {
  id: 'shortcuts',
  render(props, ui) {
    const { h, styles } = ui
    const [form, setForm] = ui.useState<ChordForm | null>(null)
    /** The draw's time when the add form asked the daemon's panel for an app, while it waits for it. */
    const [pick, setPick] = ui.useState<number | null>(null)
    ui.useEffect(() => {
      if (pick === null) return
      const result = pickOutcome(props.snapshot, pick)
      if (result.status === 'waiting') return
      setPick(null)
      if (result.status === 'picked') setForm((f) => (f === null ? f : { ...f, scope: 'one', app: result.app.bundle_id }))
    }, [props.snapshot, pick])
    const view = buildShortcutsView(props.snapshot, { t: props.t, pending: props.pending, form, waiting: pick !== null })
    const header = h('div', { key: 'header', style: { display: 'grid', gap: 2 } },
      h('h3', { style: { ...styles.heading, fontSize: 15 } }, view.title),
      h('p', { style: styles.note }, view.note))
    if (!view.ready) return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'shortcuts' }, header)
    const send = (change: SettingsChange, done?: () => void): void => {
      void props.apply(change).then((ok) => { if (ok) done?.() })
    }
    const edit = (patch: Partial<ChordForm>): void => setForm((f) => (f === null ? f : { ...f, ...patch }))

    const b = view.builtin
    const builtin = ui.card({
      key: 'builtin', title: b.title, note: b.note,
      children: [ui.list({
        key: 'list', label: b.title, empty: b.empty,
        rows: b.rows.map((r) => h('div', { key: r.key, style: { ...styles.row, opacity: r.on ? 1 : 0.6 }, 'data-chord': r.chord },
          h('span', { style: { flex: 'none', minWidth: 96 } }, ui.keys(r.caps)),
          h('div', { style: { flex: '1 1 160px', minWidth: 0 } },
            ui.switch({ key: 'switch', label: r.label, checked: r.on, disabled: !r.toggle.enabled,
              onChange: (next) => { if (next !== r.on) send(r.toggle.change) } })),
          r.off === null ? null : ui.tag(r.off, 'warning'))),
      })],
    })

    const c = view.custom
    const f = view.form
    const formBox = f === null ? null : h('div', { key: 'form', style: FORM_STYLE, 'data-cu-runtime-form': 'chord' },
      h('p', { style: styles.heading }, f.title),
      h('div', { style: styles.row },
        ui.input({ key: 'chord', label: f.comboLabel, value: f.chord, placeholder: 'cmd+shift+k', maxLength: CHANGE_LIMITS.chord,
          disabled: props.pending, onChange: (text) => edit({ chord: text }) }),
        f.caps.length === 0 ? null : ui.keys(f.caps)),
      h('p', { style: styles.note }, f.comboHint),
      ui.segmented({ key: 'scope', id: 'cu-runtime-chord-scope', label: f.scopeLabel, value: f.scope, options: f.scopes,
        disabled: props.pending, onChange: (next) => edit({ scope: next === 'one' ? 'one' : 'all' }) }),
      f.app === null ? null : h('div', { style: styles.row },
        ui.input({ key: 'app', label: f.app.label, value: f.app.value, placeholder: 'com.example.app', maxLength: CHANGE_LIMITS.bundleId,
          disabled: props.pending, onChange: (text) => edit({ app: text }) }),
        ui.button({ key: 'choose', label: f.app.chooseApp.label, disabled: !f.app.chooseApp.enabled,
          onClick: () => {
            const since = props.now / 1000
            void props.action('choose_app').then((ok) => { if (ok) setPick(since) })
          } })),
      f.waiting === null ? null : h('div', { style: styles.row, role: 'status' }, h('p', { style: styles.quiet }, f.waiting),
        ui.button({ key: 'stop', label: f.stopWaiting, onClick: () => setPick(null), variant: 'ghost' })),
      ui.input({ key: 'note', label: f.noteLabel, value: f.note, placeholder: f.notePlaceholder, maxLength: CHANGE_LIMITS.note,
        disabled: props.pending, onChange: (text) => edit({ note: text }) }),
      h('div', { style: styles.actions },
        ui.button({ key: 'cancel', label: f.cancel, onClick: () => { setForm(null); setPick(null) } }),
        ui.button({ key: 'submit', label: f.submit.label, disabled: !f.submit.enabled, variant: 'primary',
          onClick: () => send(f.submit.change, () => { setForm(null); setPick(null) }) })))
    const custom = ui.card({
      key: 'custom', title: c.title, note: c.note,
      trailing: ui.button({ key: 'add', label: c.add.label, disabled: !c.add.enabled, onClick: () => setForm(EMPTY_CHORD_FORM) }),
      children: [
        formBox,
        ui.list({
          key: 'list', label: c.title, empty: c.empty,
          rows: c.rows.map((r) => h('div', { key: r.key, style: styles.row, 'data-custom-chord': r.chord },
            h('span', { style: { flex: 'none', minWidth: 96 } }, ui.keys(r.caps)),
            h('span', { style: { flex: '1 1 160px', minWidth: 0, ...(r.hasNote ? {} : styles.quiet) } }, r.note),
            h('span', { style: { display: 'grid', fontSize: 12 } },
              h('span', { style: styles.quiet }, r.scope),
              r.app === null || r.app.name === null ? null : h('code', { style: styles.code }, r.app.bundle_id)),
            ui.button({ key: 'remove', label: r.remove.label, disabled: !r.remove.enabled, onClick: () => send(r.remove.change) }))),
        }),
      ],
    })

    const n = view.never
    const never = ui.card({
      key: 'never', title: n.title, note: n.note,
      children: [
        ui.list({
          key: 'list', label: n.title, empty: n.empty,
          rows: n.rows.map((r) => h('div', { key: r.key, style: { ...styles.row, opacity: 0.7 }, 'data-never': r.chord },
            h('span', { style: { flex: 'none', minWidth: 96, textDecoration: 'line-through' } }, ui.keys(r.caps)),
            r.label === null ? h('code', { style: styles.code }, r.chord) : h('span', null, r.label))),
        }),
        h('div', { key: 'rules', style: { ...styles.actions, gap: 6 } }, ...n.rules.map((text) => h('span', { key: text }, ui.tag(text, 'quiet')))),
      ],
    })
    return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'shortcuts' }, header, builtin, custom, never)
  },
}
