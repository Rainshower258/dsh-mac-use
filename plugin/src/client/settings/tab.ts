/**
 * What a settings tab module receives and returns (settings/tabs/index.ts says how one plugs in). Types only: the
 * tabs import nothing at run time from React or dsh, so their view builders and render functions load from the
 * compiled CommonJS in plain node (the tests), and everything they draw goes through the Kit the shell hands them.
 *
 * @module
 */

import type { CSSProperties, ReactNode, createElement, useEffect, useState } from 'react'
import type { DotState, Translate } from '../view.ts'
import type { SettingsAction, SettingsChange } from './change.ts'
import type { AppRef, PageTab, SettingsTab, Snapshot } from './model.ts'

/** What the shell gives a tab on every draw. */
export interface TabProps {
  /** The last snapshot read (model.ts Snapshot); null before the first read and after a not_running or busy read. */
  readonly snapshot: Snapshot | null
  /** dsh's translate over the page's namespace: the shared `settings.` keys and every tab's `settings.<tab>.` keys. */
  readonly t: Translate
  /**
   * Every control that changes something is disabled while true: a change waits for the owner check
   * (snapshot.pending; the shell shows the banner with 取消), a request of the page is in flight, or no snapshot is
   * there yet. Links between tabs and disclosures stay enabled.
   */
  readonly pending: boolean
  /**
   * Sends one change (`settings.apply` with exactly `{change}`); the snapshot is read again at once afterwards,
   * whatever the outcome. Resolves true when the daemon applied it or took it as the pending change, false when it was
   * refused (the shell shows the error; the tab only resets its own inputs on true). Never rejects.
   */
  readonly apply: (change: SettingsChange) => Promise<boolean>
  /** Runs one daemon action (`settings.action.<name>`), as apply; the shell shows its answer (a panel opened, busy, done). */
  readonly action: (name: SettingsAction) => Promise<boolean>
  /** Shows another tab of the page (e.g. the overview's link to 档位与默认, or not_running's to 守护进程). */
  readonly goTo: (tab: PageTab) => void
  /** Date.now() for this draw (time left, today or yesterday). */
  readonly now: number
}

/** A settings tab module: settings/tabs/<id>.ts exports `tab` of this type (and its pure view builder). */
export interface TabModule {
  readonly id: SettingsTab
  /**
   * Draws the tab. The shell calls it as the body of a component keyed by the tab's id, so it may use ui.useState and
   * ui.useEffect (always the same ones in the same order) and its state goes when another tab is shown.
   */
  readonly render: (props: TabProps, ui: Kit) => ReactNode
}

export type Tone = 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'

export interface ButtonSpec {
  readonly key?: string
  readonly label: string
  readonly onClick: () => void
  /** Pass `props.pending || …` for a control that changes something. */
  readonly disabled?: boolean
  readonly variant?: 'primary' | 'outline' | 'ghost'
}

/** The style tokens the shared pieces use, for a tab's own layout (dsh's --dsw-* variables). */
export type KitStyle = 'tab' | 'line' | 'row' | 'heading' | 'note' | 'quiet' | 'warn' | 'error' | 'code' | 'actions'

/**
 * The shared pieces, each the running dsh's primitive when it ships it (checked before use) and a plain element
 * otherwise. A tab draws only through these, never through React or dsh directly.
 */
export interface Kit {
  readonly h: typeof createElement
  readonly useState: typeof useState
  readonly useEffect: typeof useEffect
  readonly styles: Readonly<Record<KitStyle, CSSProperties>>
  button(spec: ButtonSpec): ReactNode
  tag(text: string, tone?: Tone): ReactNode
  dot(state: DotState): ReactNode
  /** An app as every list shows it: its name (the bundle ID when the Mac has none) over its bundle ID in monospace. */
  appLabel(app: AppRef): ReactNode
  /**
   * A list that can be long (the floor, approvals, refusals, changes, custom chords): its rows in a box of limited
   * height (maxHeight px, default 240) that scrolls; `empty` instead when there are no rows.
   */
  list(spec: { readonly key?: string; readonly label: string; readonly rows: readonly ReactNode[]; readonly empty: string;
    readonly maxHeight?: number }): ReactNode
  /** A confirm dialog (dsh's Modal, else an inline dialog); nothing while `open` is false. */
  confirm(spec: { readonly open: boolean; readonly title: string; readonly text: string; readonly confirmLabel: string;
    readonly onConfirm: () => void; readonly onCancel: () => void }): ReactNode
  /** A box with a title, an optional note under it and an optional control beside the title (the native cards). */
  card(spec: { readonly key?: string; readonly title: string; readonly note?: string; readonly trailing?: ReactNode;
    readonly children: readonly ReactNode[] }): ReactNode
  switch(spec: { readonly key?: string; readonly checked: boolean; readonly onChange: (next: boolean) => void;
    readonly label: string; readonly disabled?: boolean }): ReactNode
  segmented(spec: { readonly key?: string; readonly id: string; readonly value: string;
    readonly options: readonly { readonly value: string; readonly label: string; readonly disabled?: boolean }[];
    readonly onChange: (next: string) => void; readonly label: string; readonly disabled?: boolean }): ReactNode
  input(spec: { readonly key?: string; readonly value: string; readonly onChange: (text: string) => void;
    readonly label: string; readonly placeholder?: string; readonly disabled?: boolean; readonly maxLength?: number }): ReactNode
  disclosure(spec: { readonly key?: string; readonly title: string; readonly open: boolean; readonly onToggle: () => void;
    readonly children: readonly ReactNode[] }): ReactNode
  /** A shortcut as key caps, e.g. ['⌘', 'C']. */
  keys(keys: readonly string[]): ReactNode
  /** A transient line (dsh's Toast, which calls onDone once faded; the fallback stays until the tab drops it). */
  toast(spec: { readonly text: string; readonly onDone: () => void }): ReactNode
}
