/**
 * 应用名单 (App lists), ported from the native page (Sources/cu-runtime/SettingsAppsPage.swift): the three lists from
 * loosest to strictest.
 *
 * - 始终允许 (snapshot.persistent): each app's name over its bundle ID, its mode, when it was added and whether it still
 *   matches the signature it was added with. 改档位 sends `{kind: 'persistent.mode', bundle_id, mode}`, 重新批准 (only
 *   while the signature changed) `{kind: 'persistent.reapprove', bundle_id}`, 移除 `{kind: 'persistent.remove',
 *   bundle_id}`. Adding takes the app from the daemon's panel: 添加到始终允许… runs the `choose_app` action, the app
 *   the person picks there (snapshot.picked_app) opens the form, which offers the mode and sends
 *   `{kind: 'persistent.add', bundle_id, mode}`; nothing here is typed.
 * - 黑名单 (snapshot.denylist): each app with its note; 移出 sends `{kind: 'deny.remove', bundle_id}`. The add form takes
 *   a bundle ID typed or picked through `choose_app`, and a note, and sends `{kind: 'deny.add', bundle_id, note}`
 *   (note always present, '' when none).
 * - 系统底线 (snapshot.hard_deny): read-only, by category, in the limited-height list; a namespace shows as `prefix.*`.
 *
 * Every control that changes something is disabled while `pending`. Which change loosens anything (and so asks for
 * Touch ID or the password on the Mac) is the daemon's decision; the notes say what the native window says, as hints.
 *
 * @module
 */

import type { Translate } from '../../view.ts'
import { CHANGE_LIMITS, type AppMode, type SettingsChange } from '../change.ts'
import type { AppRef, HardDenyEntry, PersistentEntry, Snapshot } from '../model.ts'
import type { TabModule, Tone } from '../tab.ts'

/** A control that changes something: enabled only while nothing is pending, `change` exactly what apply sends. */
export interface ChangeControl {
  readonly label: string
  readonly enabled: boolean
  readonly change: SettingsChange
}

/** One of a choice's options with the change choosing it sends. */
export interface ChoiceOption {
  readonly value: string
  readonly label: string
  readonly change: SettingsChange
}

export interface AlwaysRow {
  readonly key: string
  readonly app: AppRef
  /** The mode in words; a mode this page does not know is shown as the daemon wrote it. */
  readonly mode: { readonly text: string; readonly tone: Tone }
  /** When it was added (YYYY-MM-DD HH:mm here), or '—' when the daemon gave no time. */
  readonly added: string
  readonly signature: { readonly state: 'ok' | 'changed' | 'unknown'; readonly text: string; readonly tone: Tone }
  /** Only while the signature changed (the entry is void until approved again). */
  readonly reapprove: ChangeControl | null
  /** 改档位: the current mode (the daemon's string) and the two modes; choosing the current one sends nothing. */
  readonly changeMode: { readonly label: string; readonly value: string; readonly enabled: boolean; readonly options: readonly ChoiceOption[] }
  readonly remove: ChangeControl
}

export interface DenyRow {
  readonly key: string
  readonly app: AppRef
  /** The note, or '—' when there is none (`hasNote` false). */
  readonly note: string
  readonly hasNote: boolean
  readonly remove: ChangeControl
}

export interface FloorGroup {
  readonly id: string
  readonly title: string
  readonly items: readonly { readonly key: string; readonly text: string; readonly id: string }[]
}

/** What the person is filling in (the tab's own state, kept by render). */
export interface AppsForms {
  /** The always form: the app picked in the daemon's panel and the mode chosen. */
  readonly always: { readonly app: AppRef; readonly mode: AppMode } | null
  /** The deny form: the bundle ID as typed (or picked) and the note as typed. */
  readonly deny: { readonly id: string; readonly note: string } | null
  /** Which form waits for an app from the daemon's panel. */
  readonly waiting: 'always' | 'deny' | null
}

export const NO_FORMS: AppsForms = { always: null, deny: null, waiting: null }

export interface AppsView {
  readonly title: string
  readonly note: string
  /** false before the first snapshot: only the title and note are drawn (the shell says it is reading). */
  readonly ready: boolean
  readonly always: {
    readonly title: string
    readonly note: string
    /** Runs the choose_app action; the picked app opens the form. */
    readonly add: { readonly label: string; readonly enabled: boolean }
    readonly rows: readonly AlwaysRow[]
    readonly empty: string
    readonly waiting: string | null
    readonly form: {
      readonly title: string
      readonly app: AppRef
      readonly modeLabel: string
      readonly mode: AppMode
      readonly modes: readonly { readonly value: AppMode; readonly label: string }[]
      readonly note: string
      readonly chooseAgain: { readonly label: string; readonly enabled: boolean }
      readonly submit: ChangeControl
    } | null
  }
  readonly deny: {
    readonly title: string
    readonly note: string
    readonly add: { readonly label: string; readonly enabled: boolean }
    readonly rows: readonly DenyRow[]
    readonly empty: string
    readonly waiting: string | null
    readonly form: {
      readonly title: string
      readonly idLabel: string
      readonly id: string
      readonly idHint: string
      readonly noteLabel: string
      readonly note: string
      readonly notePlaceholder: string
      readonly chooseApp: { readonly label: string; readonly enabled: boolean }
      /** Enabled only for a bundle ID the daemon takes (bundleIdOf) and a note it takes (noteOf). */
      readonly submit: ChangeControl
    } | null
  }
  readonly floor: { readonly title: string; readonly note: string; readonly count: string; readonly groups: readonly FloorGroup[];
    readonly empty: string }
  readonly stopWaiting: string
  readonly cancel: string
}

/** The floor's categories in the native order (HardDeny.Category); anything else goes under 其他, last. */
export const FLOOR_CATEGORIES = ['systemUI', 'authentication', 'runsCode', 'selfAndRemote'] as const

/** Control and format characters (Unicode Cc and Cf), as the daemon's CharacterSet.controlCharacters refuses them. */
const CONTROL = /[\p{Cc}\p{Cf}]/u

/**
 * A typed bundle ID as the daemon takes it (SettingsChange.decode): trimmed, 1–CHANGE_LIMITS.bundleId characters, no
 * space or control character inside; null otherwise.
 */
export function bundleIdOf(text: string): string | null {
  const id = text.trim()
  return id.length > 0 && id.length <= CHANGE_LIMITS.bundleId && !/\s/.test(id) && !CONTROL.test(id) ? id : null
}

/** A typed note as the daemon takes it: trimmed ('' allowed), at most CHANGE_LIMITS.note characters, no control character. */
export function noteOf(text: string): string | null {
  const note = text.trim()
  return note.length <= CHANGE_LIMITS.note && !CONTROL.test(note) ? note : null
}

/**
 * What became of a `choose_app` the page ran at `since` (epoch seconds, the draw's time when it was asked): `picked`
 * with the app once the daemon settled that panel (last_outcome kind choose_app, done, at or after `since`) and named
 * the app (picked_app), `ended` when the panel settled otherwise (cancelled, refused), else `waiting`. An earlier
 * pick still in picked_app is never taken for this one.
 */
export function pickOutcome(snapshot: Snapshot | null, since: number):
  { readonly status: 'waiting' } | { readonly status: 'ended' } | { readonly status: 'picked'; readonly app: AppRef } {
  const outcome = snapshot?.last_outcome ?? null
  if (snapshot === null || outcome === null || outcome.kind !== 'choose_app' || outcome.at < since) return { status: 'waiting' }
  return outcome.outcome === 'done' && snapshot.picked_app !== null ? { status: 'picked', app: snapshot.picked_app } : { status: 'ended' }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** An epoch-seconds time as YYYY-MM-DD HH:mm in this Mac's time zone; '—' for none (0, as readSnapshot leaves it). */
export function dayTime(t: Translate, at: number): string {
  if (!(at > 0)) return t('settings.value.none')
  const d = new Date(at * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function modeChip(t: Translate, mode: string): { text: string; tone: Tone } {
  if (mode === 'read') return { text: t('settings.mode.read'), tone: 'info' }
  if (mode === 'full') return { text: t('settings.mode.full'), tone: 'warning' }
  return { text: mode, tone: 'neutral' }
}

function alwaysRow(t: Translate, e: PersistentEntry, pending: boolean): AlwaysRow {
  const id = e.bundle_id
  const state = e.signature_ok === true ? 'ok' : e.signature_ok === false ? 'changed' : 'unknown'
  return {
    key: id,
    app: { bundle_id: id, name: e.name },
    mode: modeChip(t, e.mode),
    added: t('settings.apps.always.added', { time: dayTime(t, e.added_at) }),
    signature: { state, text: t(`settings.apps.always.signature.${state}`), tone: state === 'ok' ? 'success' : state === 'changed' ? 'warning' : 'quiet' },
    reapprove: state === 'changed'
      ? { label: t('settings.apps.always.reapprove'), enabled: !pending, change: { kind: 'persistent.reapprove', bundle_id: id } } : null,
    changeMode: {
      label: t('settings.apps.always.changeMode'), value: e.mode, enabled: !pending,
      options: (['read', 'full'] as const).map((mode) => ({ value: mode, label: t(`settings.mode.${mode}`),
        change: { kind: 'persistent.mode', bundle_id: id, mode } })),
    },
    remove: { label: t('settings.apps.always.remove'), enabled: !pending, change: { kind: 'persistent.remove', bundle_id: id } },
  }
}

function floorItem(e: HardDenyEntry, i: number): { key: string; text: string; id: string } {
  if (e.bundle_id !== undefined) return { key: `${e.bundle_id}:${i}`, text: e.name ?? e.bundle_id, id: e.bundle_id }
  const id = `${e.namespace ?? ''}.*`
  return { key: `${id}:${i}`, text: e.name ?? id, id }
}

function floorGroups(t: Translate, floor: readonly HardDenyEntry[]): FloorGroup[] {
  const known: readonly string[] = FLOOR_CATEGORIES
  const ids = [...FLOOR_CATEGORIES, 'other']
  return ids.map((id) => ({
    id,
    title: t(`settings.apps.floor.category.${id}`),
    items: floor.map((e, i) => [e, i] as const)
      .filter(([e]) => (id === 'other' ? !known.includes(e.category) : e.category === id))
      .map(([e, i]) => floorItem(e, i)),
  })).filter((g) => g.items.length > 0)
}

/**
 * The tab's view.
 * @param snapshot - null before the first read (ready false).
 * @param options.pending - every control that changes something is disabled while true (TabProps.pending).
 * @param options.forms - what the person is filling in (NO_FORMS when nothing).
 */
export function buildAppsView(snapshot: Snapshot | null, { t, pending, forms = NO_FORMS }:
  { t: Translate; pending: boolean; forms?: AppsForms }): AppsView {
  const waiting = t('settings.apps.waiting')
  const choosing = forms.waiting !== null
  const always = forms.always
  const deny = forms.deny
  const denyId = deny === null ? null : bundleIdOf(deny.id)
  const denyNote = deny === null ? null : noteOf(deny.note)
  const floor = snapshot?.hard_deny ?? []
  return {
    title: t('settings.apps.title'),
    note: t('settings.apps.note'),
    ready: snapshot !== null,
    always: {
      title: t('settings.apps.always.title'),
      note: t('settings.apps.always.note'),
      add: { label: t('settings.apps.always.add'), enabled: !pending && !choosing && always === null },
      rows: (snapshot?.persistent ?? []).map((e) => alwaysRow(t, e, pending)),
      empty: t('settings.apps.always.empty'),
      waiting: forms.waiting === 'always' ? waiting : null,
      form: always === null ? null : {
        title: t('settings.apps.always.form.title'),
        app: always.app,
        modeLabel: t('settings.apps.always.form.mode'),
        mode: always.mode,
        modes: (['read', 'full'] as const).map((mode) => ({ value: mode, label: t(`settings.mode.${mode}`) })),
        note: t('settings.apps.always.form.note'),
        chooseAgain: { label: t('settings.apps.always.form.chooseAgain'), enabled: !pending && !choosing },
        submit: { label: t('settings.apps.always.form.submit'), enabled: !pending,
          change: { kind: 'persistent.add', bundle_id: always.app.bundle_id, mode: always.mode } },
      },
    },
    deny: {
      title: t('settings.apps.deny.title'),
      note: t('settings.apps.deny.note'),
      add: { label: t('settings.apps.deny.add'), enabled: !pending && deny === null },
      rows: (snapshot?.denylist ?? []).map((e) => ({
        key: e.bundle_id,
        app: { bundle_id: e.bundle_id, name: e.name },
        note: e.note === '' ? t('settings.value.none') : e.note,
        hasNote: e.note !== '',
        remove: { label: t('settings.apps.deny.remove'), enabled: !pending, change: { kind: 'deny.remove', bundle_id: e.bundle_id } },
      })),
      empty: t('settings.apps.deny.empty'),
      waiting: forms.waiting === 'deny' ? waiting : null,
      form: deny === null ? null : {
        title: t('settings.apps.deny.form.title'),
        idLabel: t('settings.apps.deny.form.bundleId'),
        id: deny.id,
        idHint: t('settings.apps.deny.form.bundleIdHint'),
        noteLabel: t('settings.apps.deny.form.note'),
        note: deny.note,
        notePlaceholder: t('settings.apps.deny.form.notePlaceholder'),
        chooseApp: { label: t('settings.apps.chooseApp'), enabled: !pending && !choosing },
        submit: { label: t('settings.apps.deny.form.submit'), enabled: !pending && denyId !== null && denyNote !== null,
          change: { kind: 'deny.add', bundle_id: denyId ?? deny.id.trim(), note: denyNote ?? deny.note.trim() } },
      },
    },
    floor: {
      title: t('settings.apps.floor.title'),
      note: t('settings.apps.floor.note'),
      count: t('settings.apps.floor.count', { n: floor.length }),
      groups: floorGroups(t, floor),
      empty: t('settings.apps.floor.empty'),
    },
    stopWaiting: t('settings.apps.stopWaiting'),
    cancel: t('settings.cancel'),
  }
}

const FORM_STYLE = { display: 'grid', gap: 10, padding: 12, border: '.5px solid var(--dsw-alias-border-l4)', borderRadius: 10, minWidth: 0 }

export const tab: TabModule = {
  id: 'apps',
  render(props, ui) {
    const { h, styles } = ui
    const [always, setAlways] = ui.useState<AppsForms['always']>(null)
    const [deny, setDeny] = ui.useState<AppsForms['deny']>(null)
    /** The form waiting for the daemon's app panel, and the draw's time when it was asked for. */
    const [pick, setPick] = ui.useState<{ readonly target: 'always' | 'deny'; readonly since: number } | null>(null)
    ui.useEffect(() => {
      if (pick === null) return
      const result = pickOutcome(props.snapshot, pick.since)
      if (result.status === 'waiting') return
      setPick(null)
      if (result.status !== 'picked') return
      // The always form opens on its pick; the deny form is open before it, and a pick it no longer waits for (sent
      // or cancelled meanwhile) opens nothing.
      if (pick.target === 'always') setAlways((a) => ({ app: result.app, mode: a?.mode ?? 'read' }))
      else setDeny((d) => (d === null ? d : { id: result.app.bundle_id, note: d.note }))
    }, [props.snapshot, pick])
    const view = buildAppsView(props.snapshot, { t: props.t, pending: props.pending, forms: { always, deny, waiting: pick?.target ?? null } })
    const header = h('div', { key: 'header', style: { display: 'grid', gap: 2 } },
      h('h3', { style: { ...styles.heading, fontSize: 15 } }, view.title),
      h('p', { style: styles.note }, view.note))
    if (!view.ready) return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'apps' }, header)

    const choose = (target: 'always' | 'deny'): void => {
      const since = props.now / 1000
      void props.action('choose_app').then((ok) => { if (ok) setPick({ target, since }) })
    }
    const send = (change: SettingsChange, done?: () => void): void => {
      void props.apply(change).then((ok) => { if (ok) done?.() })
    }
    /** Closes a form, and stops waiting for a pick for it: a pick that comes later must not open it again. */
    const close = (target: 'always' | 'deny'): void => {
      if (target === 'always') setAlways(null)
      else setDeny(null)
      setPick((p) => (p?.target === target ? null : p))
    }
    const waitingLine = (key: string, text: string | null) => text === null ? null
      : h('div', { key, style: styles.row, role: 'status' }, h('p', { style: styles.quiet }, text),
        ui.button({ key: 'stop', label: view.stopWaiting, onClick: () => setPick(null), variant: 'ghost' }))

    const a = view.always
    const alwaysForm = a.form === null ? null : h('div', { key: 'form', style: FORM_STYLE, 'data-cu-runtime-form': 'always' },
      h('p', { style: styles.heading }, a.form.title),
      h('div', { style: styles.row },
        h('div', { style: { flex: '1 1 160px', minWidth: 0 } }, ui.appLabel(a.form.app)),
        ui.button({ key: 'again', label: a.form.chooseAgain.label, disabled: !a.form.chooseAgain.enabled, onClick: () => choose('always') })),
      ui.segmented({ key: 'mode', id: 'cu-runtime-always-mode', label: a.form.modeLabel, value: a.form.mode, disabled: props.pending,
        options: a.form.modes, onChange: (next) => setAlways((f) => (f === null ? f : { ...f, mode: next === 'full' ? 'full' : 'read' })) }),
      h('p', { style: styles.note }, a.form.note),
      h('div', { style: styles.actions },
        ui.button({ key: 'cancel', label: view.cancel, onClick: () => close('always') }),
        ui.button({ key: 'submit', label: a.form.submit.label, disabled: !a.form.submit.enabled, variant: 'primary',
          onClick: () => send(a.form!.submit.change, () => close('always')) })))
    const alwaysCard = ui.card({
      key: 'always', title: a.title, note: a.note,
      trailing: ui.button({ key: 'add', label: a.add.label, disabled: !a.add.enabled, onClick: () => choose('always') }),
      children: [
        waitingLine('waiting', a.waiting),
        alwaysForm,
        ui.list({
          key: 'list', label: a.title, empty: a.empty,
          rows: a.rows.map((r) => h('div', { key: r.key, style: styles.row, 'data-persistent': r.key },
            h('div', { style: { flex: '1 1 160px', minWidth: 0 } }, ui.appLabel(r.app)),
            ui.tag(r.mode.text, r.mode.tone),
            h('span', { 'data-signature': r.signature.state }, ui.tag(r.signature.text, r.signature.tone)),
            h('span', { style: { ...styles.quiet, fontSize: 12 } }, r.added),
            r.reapprove === null ? null : ui.button({ key: 'reapprove', label: r.reapprove.label, disabled: !r.reapprove.enabled,
              onClick: () => send(r.reapprove!.change) }),
            ui.segmented({ key: 'mode', id: `cu-runtime-mode-${r.key}`, label: r.changeMode.label, value: r.changeMode.value,
              disabled: !r.changeMode.enabled, options: r.changeMode.options,
              onChange: (next) => {
                const option = r.changeMode.options.find((o) => o.value === next)
                if (option !== undefined && next !== r.changeMode.value) send(option.change)
              } }),
            ui.button({ key: 'remove', label: r.remove.label, disabled: !r.remove.enabled, onClick: () => send(r.remove.change) }))),
        }),
      ],
    })

    const d = view.deny
    const denyForm = d.form === null ? null : h('div', { key: 'form', style: FORM_STYLE, 'data-cu-runtime-form': 'deny' },
      h('p', { style: styles.heading }, d.form.title),
      h('div', { style: styles.row },
        ui.input({ key: 'id', label: d.form.idLabel, value: d.form.id, placeholder: 'com.example.app', maxLength: CHANGE_LIMITS.bundleId,
          disabled: props.pending, onChange: (text) => setDeny((f) => (f === null ? f : { ...f, id: text })) }),
        ui.button({ key: 'choose', label: d.form.chooseApp.label, disabled: !d.form.chooseApp.enabled, onClick: () => choose('deny') })),
      h('p', { style: styles.note }, d.form.idHint),
      ui.input({ key: 'note', label: d.form.noteLabel, value: d.form.note, placeholder: d.form.notePlaceholder, maxLength: CHANGE_LIMITS.note,
        disabled: props.pending, onChange: (text) => setDeny((f) => (f === null ? f : { ...f, note: text })) }),
      h('div', { style: styles.actions },
        ui.button({ key: 'cancel', label: view.cancel, onClick: () => close('deny') }),
        ui.button({ key: 'submit', label: d.form.submit.label, disabled: !d.form.submit.enabled, variant: 'primary',
          onClick: () => send(d.form!.submit.change, () => close('deny')) })))
    const denyCard = ui.card({
      key: 'deny', title: d.title, note: d.note,
      trailing: ui.button({ key: 'add', label: d.add.label, disabled: !d.add.enabled, onClick: () => setDeny({ id: '', note: '' }) }),
      children: [
        denyForm,
        waitingLine('waiting', d.waiting),
        ui.list({
          key: 'list', label: d.title, empty: d.empty,
          rows: d.rows.map((r) => h('div', { key: r.key, style: styles.row, 'data-deny': r.key },
            h('div', { style: { flex: '1 1 160px', minWidth: 0 } }, ui.appLabel(r.app)),
            h('span', { style: { flex: '1 1 160px', minWidth: 0, fontSize: 12, ...(r.hasNote ? {} : styles.quiet) } }, r.note),
            ui.button({ key: 'remove', label: r.remove.label, disabled: !r.remove.enabled, onClick: () => send(r.remove.change) }))),
        }),
      ],
    })

    const f = view.floor
    const floorCard = ui.card({
      key: 'floor', title: f.title, note: f.note,
      trailing: h('span', { style: { ...styles.quiet, fontSize: 12, flex: 'none' } }, f.count),
      children: [ui.list({
        key: 'list', label: f.title, empty: f.empty,
        rows: f.groups.map((g) => h('div', { key: g.id, style: { display: 'grid', gap: 6 }, 'data-floor-category': g.id },
          h('p', { style: styles.heading }, g.title),
          h('div', { style: { ...styles.actions, gap: 6 } },
            ...g.items.map((i) => h('span', { key: i.key, title: i.id, 'data-floor': i.id }, ui.tag(i.text, 'quiet')))))),
      })],
    })
    return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'apps' }, header, alwaysCard, denyCard, floorCard)
  },
}
