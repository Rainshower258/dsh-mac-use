/**
 * The settings tabs, in the native window's order. How a tab module plugs in (a tab is added or changed without
 * touching any shared file):
 *
 * - settings/tabs/<id>.ts exports `tab: TabModule` (settings/tab.ts) with `id: '<id>'` and
 *   `render(props: TabProps, ui: Kit): ReactNode`, and a pure view builder (any name, e.g. `buildAccessView`) that
 *   render draws: plain data in, plain data out, so tests call it on the compiled CommonJS like view.ts.
 * - The module imports nothing at run time but other plain modules (settings/model.ts, settings/change.ts); React
 *   and dsh's primitives come only through `ui` (ui.h, ui.useState, ui.useEffect, ui.button, ui.list, ui.confirm,
 *   ui.switch, ui.segmented, ui.input, ...), each falling back to a plain element where the running dsh lacks it.
 * - render receives, through `props`: `snapshot` (null before the first read), `t` (every `settings.` key),
 *   `pending` (disable every control that changes something while true), `apply(change)` (one SettingsChange of
 *   settings/change.ts, exactly the daemon's keys; resolves true when applied or pending, false when refused, and the
 *   shell then shows the error), `action(name)` (a daemon action, likewise), `goTo(tab)` and `now`. The shell reads
 *   the snapshot again at once after each apply and action, and draws the pending banner, the outcome notices, the
 *   answers and the errors above the tab: a tab shows none of them itself.
 * - render runs as the body of a component keyed by the tab's id: hooks from `ui` are allowed (the same ones in the
 *   same order on every draw); the tab's state is dropped when another tab is shown.
 * - Its text lives in settings/locale/<id>.ts (`zh` and `en`, the same keys, every key `settings.<id>.`); the
 *   locale index already merges every tab's file into the page's namespace.
 *
 * @module
 */

import type { SettingsTab } from '../model.ts'
import type { TabModule } from '../tab.ts'
import { tab as access } from './access.ts'
import { tab as apps } from './apps.ts'
import { tab as behavior } from './behavior.ts'
import { tab as logs } from './logs.ts'
import { tab as overview } from './overview.ts'
import { tab as privacy } from './privacy.ts'
import { tab as shortcuts } from './shortcuts.ts'

/** Every settings tab's module, by id. */
export const TAB_MODULES: Readonly<Record<SettingsTab, TabModule>> = { overview, access, apps, shortcuts, privacy, behavior, logs }
