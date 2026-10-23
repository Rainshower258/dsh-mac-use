/**
 * 行为与模型 (Behavior and model), ported from the native page (Sources/cu-runtime/SettingsBehaviorPage.swift) without
 * its model card (the model and reasoning effort dsh is configured with are not shown here): how the model operates
 * this Mac, one control per field of snapshot.behavior, each sending `{kind: 'behavior.set', field, value}` with the
 * daemon's values (restore_focus_on_turn_end, allow_point_targets and electron_ax_auto true or false;
 * ime_policy_cap leave, ask or takeover; activation_method null for the daemon's default, ax_frontmost or ax_raise);
 * then the advanced part: 导入… (`settings.action.import`: the daemon's open panel on the Mac, whose file comes back as
 * snapshot.import_preview, shown here with what it changes and what it loosens, applied with
 * `settings.action.import_confirm` or left), 导出… (`settings.action.export_settings`) and 恢复默认设置 (`{kind:
 * 'reset'}` after a confirm). The daemon decides what loosens and asks for Touch ID or the password itself; the lock
 * notes here are static hints, never computed from the values.
 *
 * @module
 */

import type { ReactNode } from 'react'
import type { Translate } from '../../view.ts'
import type { ActivationMethod, ChangePolicy, SettingsChange } from '../change.ts'
import type { Snapshot } from '../model.ts'
import type { TabModule } from '../tab.ts'

/** The behavior fields drawn as a switch (true or false). */
export type SwitchField = 'restore_focus_on_turn_end' | 'allow_point_targets'

/** A switch: `checked` null when the daemon gave no boolean (then it is disabled); `toOn`/`toOff` exactly what apply sends. */
export interface SwitchControl {
  readonly field: SwitchField
  readonly label: string
  readonly note: string
  /** The native lock note: a hint only (the daemon decides). */
  readonly lock: string | null
  readonly checked: boolean | null
  readonly enabled: boolean
  readonly toOn: SettingsChange
  readonly toOff: SettingsChange
}

/** One choice of a segmented control: `value` the control's own string, `change` exactly what apply sends. */
export interface ChoiceOption {
  readonly value: string
  readonly label: string
  readonly change: SettingsChange
}

/** A segmented control: `value` the offered option the daemon's value is, null when it is none of them (then disabled). */
export interface ChoiceControl {
  readonly id: string
  readonly label: string
  readonly note: string
  readonly lock: string | null
  readonly value: string | null
  readonly enabled: boolean
  readonly options: readonly ChoiceOption[]
}

/** A daemon action behind a button: enabled only while nothing is pending. */
export interface ActionControl {
  readonly label: string
  readonly enabled: boolean
  readonly action: 'import' | 'export_settings' | 'import_confirm'
}

/** The file settings.action.import read, as the daemon described it (snapshot.import_preview). */
export interface ImportPreviewView {
  /** Tells one preview from the next (the page hides a preview it was told to leave until another arrives). */
  readonly key: string
  readonly title: string
  /** The changed items as the daemon names them (`section.field`, `denylist.add:<id>`, …), at most 100. */
  readonly changes: readonly string[]
  /** The line over the changes: how many, or that nothing changes. */
  readonly changesText: string
  /** When the daemon listed fewer than it counted. */
  readonly more: string | null
  /** What the daemon says the import loosens, at most 100; empty: nothing. */
  readonly loosened: readonly string[]
  readonly loosenedText: string
  /** The file named another log folder, which an import never takes. */
  readonly directoryIgnored: string | null
  /** 验证并应用 when the daemon listed something loosened, else 应用. */
  readonly confirm: ActionControl
  readonly leave: string
}

export interface BehaviorView {
  readonly title: string
  readonly note: string
  /** false before the first snapshot: only the title and note are drawn. */
  readonly ready: boolean
  readonly unknown: string
  readonly operation: {
    readonly title: string
    readonly restoreFocus: SwitchControl
    readonly pointTargets: SwitchControl
    readonly imePolicy: ChoiceControl
    readonly electronAX: ChoiceControl
  }
  readonly advanced: {
    readonly title: string
    readonly activation: ChoiceControl
    readonly importExport: { readonly title: string; readonly note: string; readonly import: ActionControl; readonly export: ActionControl }
    readonly reset: {
      readonly title: string
      readonly note: string
      readonly lock: string
      readonly label: string
      readonly enabled: boolean
      readonly change: SettingsChange
      /** The confirm dialog's words. */
      readonly confirm: { readonly title: string; readonly text: string; readonly confirmLabel: string }
    }
  }
  /** null when the daemon holds no imported file. */
  readonly importPreview: ImportPreviewView | null
}

/** The input-source caps the daemon offers, loosest last (ChangePolicy). */
export const IME_POLICIES: readonly ChangePolicy[] = ['leave', 'ask', 'takeover']

/**
 * The activation methods the page offers (the native picker's): the daemon's default (null) and the two AX ones.
 * running_application, the default's own method, is offered only while it is the value (set in a file or the terminal).
 */
export const ACTIVATION_CHOICES: readonly (ActivationMethod | null)[] = [null, 'ax_frontmost', 'ax_raise']

/** The segmented control's string for activation_method null. */
export const ACTIVATION_DEFAULT = 'default'

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')

function switchControl(t: Translate, behavior: Readonly<Record<string, unknown>>, field: SwitchField, pending: boolean,
  key: string, lock: string | null): SwitchControl {
  const value = behavior[field]
  const checked = typeof value === 'boolean' ? value : null
  return {
    field, label: t(`settings.field.behavior.${field}`), note: t(`settings.behavior.${key}Note`), lock, checked,
    enabled: !pending && checked !== null,
    toOn: { kind: 'behavior.set', field, value: true },
    toOff: { kind: 'behavior.set', field, value: false },
  }
}

function previewView(t: Translate, preview: Readonly<Record<string, unknown>>, pending: boolean): ImportPreviewView {
  const changes = isStrings(preview.changes) ? preview.changes : []
  const loosened = isStrings(preview.loosened) ? preview.loosened : []
  const counted = typeof preview.changes_count === 'number' && Number.isFinite(preview.changes_count)
    ? Math.max(preview.changes_count, changes.length) : changes.length
  return {
    key: JSON.stringify(preview),
    title: t('settings.behavior.importTitle'),
    changes,
    changesText: counted === 0 ? t('settings.behavior.importNoChanges') : t('settings.behavior.importChanges', { count: counted }),
    more: counted > changes.length ? t('settings.behavior.importMore', { shown: changes.length, count: counted }) : null,
    loosened,
    loosenedText: loosened.length === 0 ? t('settings.behavior.importNothingLoosened') : t('settings.behavior.importLoosens'),
    directoryIgnored: preview.log_directory_ignored === true ? t('settings.behavior.importDirectoryIgnored') : null,
    confirm: { label: loosened.length === 0 ? t('settings.behavior.apply') : t('settings.behavior.applyVerified'), enabled: !pending,
      action: 'import_confirm' },
    leave: t('settings.behavior.importLeave'),
  }
}

/**
 * The behavior tab's view.
 * @param snapshot - null before the first read (ready false, every control disabled).
 * @param options.pending - every control that changes something is disabled while true (TabProps.pending).
 */
export function buildBehaviorView(snapshot: Snapshot | null, { t, pending }: { t: Translate; pending: boolean }): BehaviorView {
  const behavior = snapshot?.behavior ?? {}
  const held = pending || snapshot === null
  const ime = behavior.ime_policy_cap
  const imeValue = typeof ime === 'string' && (IME_POLICIES as readonly string[]).includes(ime) ? ime : null
  const electron = behavior.electron_ax_auto
  const electronValue = electron === true ? 'auto' : electron === false ? 'off' : null
  const activation = behavior.activation_method
  const activationValue = activation === null || activation === undefined ? ACTIVATION_DEFAULT
    : activation === 'running_application' || activation === 'ax_frontmost' || activation === 'ax_raise' ? activation : null
  const activationOptions: ChoiceOption[] = ACTIVATION_CHOICES.map((m) => ({
    value: m ?? ACTIVATION_DEFAULT,
    label: m === null ? t('settings.value.activation_method.default') : t(`settings.value.activation_method.${m}`),
    change: { kind: 'behavior.set', field: 'activation_method', value: m },
  }))
  if (activationValue === 'running_application') {
    activationOptions.splice(1, 0, { value: 'running_application', label: t('settings.behavior.activationExplicit'),
      change: { kind: 'behavior.set', field: 'activation_method', value: 'running_application' } })
  }
  const preview = snapshot?.import_preview ?? null
  return {
    title: t('settings.behavior.title'),
    note: t('settings.behavior.note'),
    ready: snapshot !== null,
    unknown: t('settings.behavior.unknownValue'),
    operation: {
      title: t('settings.behavior.operation'),
      restoreFocus: switchControl(t, behavior, 'restore_focus_on_turn_end', held, 'restoreFocus', null),
      pointTargets: switchControl(t, behavior, 'allow_point_targets', held, 'pointTargets', t('settings.behavior.pointTargetsLock')),
      imePolicy: {
        id: 'cu-runtime-behavior-ime', label: t('settings.field.behavior.ime_policy_cap'), note: t('settings.behavior.imePolicyNote'),
        lock: t('settings.behavior.imePolicyLock'), value: imeValue, enabled: !held && imeValue !== null,
        options: IME_POLICIES.map((p) => ({ value: p, label: t(`settings.value.ime_policy_cap.${p}`),
          change: { kind: 'behavior.set', field: 'ime_policy_cap', value: p } })),
      },
      electronAX: {
        id: 'cu-runtime-behavior-electron', label: t('settings.field.behavior.electron_ax_auto'), note: t('settings.behavior.electronAXNote'),
        lock: t('settings.behavior.electronAXLock'), value: electronValue, enabled: !held && electronValue !== null,
        options: [
          { value: 'auto', label: t('settings.behavior.auto'), change: { kind: 'behavior.set', field: 'electron_ax_auto', value: true } },
          { value: 'off', label: t('settings.behavior.off'), change: { kind: 'behavior.set', field: 'electron_ax_auto', value: false } },
        ],
      },
    },
    advanced: {
      title: t('settings.behavior.advanced'),
      activation: {
        id: 'cu-runtime-behavior-activation', label: t('settings.field.behavior.activation_method'),
        note: t('settings.behavior.activationNote'), lock: null, value: activationValue,
        enabled: !held && activationValue !== null, options: activationOptions,
      },
      importExport: {
        title: t('settings.behavior.importExport'), note: t('settings.behavior.importExportNote'),
        import: { label: t('settings.behavior.import'), enabled: !held, action: 'import' },
        export: { label: t('settings.behavior.export'), enabled: !held, action: 'export_settings' },
      },
      reset: {
        title: t('settings.behavior.reset'), note: t('settings.behavior.resetNote'), lock: t('settings.behavior.resetLock'),
        label: t('settings.behavior.resetButton'), enabled: !held, change: { kind: 'reset' },
        confirm: { title: t('settings.behavior.reset'), text: t('settings.behavior.resetNote'), confirmLabel: t('settings.behavior.resetConfirm') },
      },
    },
    importPreview: preview === null ? null : previewView(t, preview, held),
  }
}

export const tab: TabModule = {
  id: 'behavior',
  render(props, ui) {
    const { h, styles } = ui
    // Hooks first, the same on every draw: the reset confirm, and the preview the person chose to leave.
    const [confirmReset, setConfirmReset] = ui.useState(false)
    const [left, setLeft] = ui.useState<string | null>(null)
    const view = buildBehaviorView(props.snapshot, props)
    const header = h('div', { key: 'header', style: { display: 'grid', gap: 2 } },
      h('h3', { style: { ...styles.heading, fontSize: 15 } }, view.title),
      h('p', { style: styles.note }, view.note))
    if (!view.ready) return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'behavior' }, header)

    const text = (key: string, note: string, lock: string | null) => h('div', { key, style: { flex: '1 1 220px', minWidth: 0, display: 'grid', gap: 2 } },
      h('p', { style: styles.note }, note),
      lock === null ? null : h('p', { style: styles.quiet }, lock))
    const settingRow = (key: string, label: string, note: string, lock: string | null, known: boolean, control: ReactNode) =>
      h('div', { key, style: { display: 'grid', gap: 4 }, 'data-behavior': key },
        h('div', { style: styles.row },
          h('span', { style: { ...styles.heading, flex: '1 1 160px', minWidth: 0 } }, label),
          control),
        text('text', note, lock),
        known ? null : h('p', { style: styles.warn }, view.unknown))
    const switchRow = (c: SwitchControl) => settingRow(c.field, c.label, c.note, c.lock, c.checked !== null,
      ui.switch({ key: 'switch', label: c.label, checked: c.checked === true, disabled: !c.enabled,
        onChange: (next) => { if (next !== c.checked) void props.apply(next ? c.toOn : c.toOff) } }))
    const choiceRow = (key: string, c: ChoiceControl) => settingRow(key, c.label, c.note, c.lock, c.value !== null,
      ui.segmented({ key: 'choice', id: c.id, label: c.label, value: c.value ?? '', disabled: !c.enabled,
        options: c.options.map((o) => ({ value: o.value, label: o.label })),
        onChange: (next) => {
          const option = c.options.find((o) => o.value === next)
          if (option !== undefined && next !== c.value) void props.apply(option.change)
        } }))

    const o = view.operation
    const operation = ui.card({
      key: 'operation', title: o.title,
      children: [switchRow(o.restoreFocus), switchRow(o.pointTargets), choiceRow('ime_policy_cap', o.imePolicy),
        choiceRow('electron_ax_auto', o.electronAX)],
    })

    const a = view.advanced
    const io = a.importExport
    const r = a.reset
    const advanced = ui.card({
      key: 'advanced', title: a.title,
      children: [
        choiceRow('activation_method', a.activation),
        h('div', { key: 'importExport', style: { display: 'grid', gap: 4 }, 'data-behavior': 'importExport' },
          h('div', { style: styles.row },
            h('span', { style: { ...styles.heading, flex: '1 1 160px', minWidth: 0 } }, io.title),
            h('div', { style: styles.actions },
              ui.button({ key: 'import', label: io.import.label, disabled: !io.import.enabled,
                onClick: () => { setLeft(null); void props.action(io.import.action) } }),
              ui.button({ key: 'export', label: io.export.label, disabled: !io.export.enabled,
                onClick: () => void props.action(io.export.action) }))),
          text('text', io.note, null)),
        h('div', { key: 'reset', style: { display: 'grid', gap: 4 }, 'data-behavior': 'reset' },
          h('div', { style: styles.row },
            h('span', { style: { ...styles.heading, flex: '1 1 160px', minWidth: 0 } }, r.title),
            ui.button({ key: 'reset', label: r.label, disabled: !r.enabled, onClick: () => setConfirmReset(true) })),
          text('text', r.note, r.lock)),
      ],
    })

    const p = view.importPreview
    const preview = p === null || p.key === left ? null : ui.card({
      key: 'importPreview', title: p.title, note: p.changesText,
      children: [
        p.changes.length === 0 ? null : ui.list({ key: 'changes', label: p.changesText, empty: p.changesText, maxHeight: 200,
          rows: p.changes.map((c, i) => h('code', { key: `${i}:${c}`, style: styles.code }, c)) }),
        p.more === null ? null : h('p', { key: 'more', style: styles.quiet }, p.more),
        h('p', { key: 'loosenedText', style: p.loosened.length === 0 ? styles.note : styles.warn }, p.loosenedText),
        p.loosened.length === 0 ? null : ui.list({ key: 'loosened', label: p.loosenedText, empty: p.loosenedText, maxHeight: 200,
          rows: p.loosened.map((c, i) => h('code', { key: `${i}:${c}`, style: styles.code }, c)) }),
        p.directoryIgnored === null ? null : h('p', { key: 'directory', style: styles.quiet }, p.directoryIgnored),
        h('div', { key: 'actions', style: styles.actions },
          ui.button({ key: 'leave', label: p.leave, variant: 'ghost', onClick: () => setLeft(p.key) }),
          ui.button({ key: 'confirm', label: p.confirm.label, variant: 'primary', disabled: !p.confirm.enabled,
            onClick: () => void props.action(p.confirm.action) })),
      ],
    })

    const confirm = ui.confirm({
      open: confirmReset, title: r.confirm.title, text: r.confirm.text, confirmLabel: r.confirm.confirmLabel,
      onCancel: () => setConfirmReset(false),
      onConfirm: () => {
        setConfirmReset(false)
        if (r.enabled) void props.apply(r.change)
      },
    })
    return h('div', { style: styles.tab, 'data-cu-runtime-tab': 'behavior' }, header, operation, advanced, preview, confirm)
  },
}
