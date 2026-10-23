/**
 * The browser half of the cu-runtime bundle (PLAN-阶段2「浏览器端页面」, stage 3c). dsh's web client loads it from the
 * package's `./client` export for the top-level row named `cu-runtime`, as a client plugin with the slots and locale
 * services; it puts the plugin page (settings/shell.ts: the daemon tab, page.ts, then the daemon's settings tabs) on
 * the bundle's detail page, slot `plugins.bundle.config` keyed by the package name. scripts/build-client.mjs bundles
 * this directory into the one classic script dsh loads.
 *
 * @module cu-runtime-plugin/client
 */

import type { ComponentType } from 'react'
import { NS, en, zh } from './locale.ts'
import type { PageProps } from './page.ts'
import { en as settingsEn, zh as settingsZh } from './settings/locale/index.ts'
import { PluginPage } from './settings/shell.ts'

/** The package name: the key dsh looks up the bundle's configuration entry by. */
export const PACKAGE = 'cu-runtime'

export const name = 'cu-runtime-client'
export const inject = ['slots', 'locale']

/** The parts of the dsh client context this plugin uses. */
export interface ClientContext {
  effect(setup: () => () => void): void
  locale: { register(ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): () => void }
  slots: {
    inject(name: string, setup: () => () => void): void
    register(entry: { name: string; key: string; locale: string }, component: ComponentType<PageProps>): () => void
  }
}

/** The page's one namespace: the daemon tab's keys and every `settings.` key (the two sets never share a key). */
const dictionaries = { zh: { ...zh, ...settingsZh }, en: { ...en, ...settingsEn } }

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, dictionaries))
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE, locale: NS }, PluginPage))
}
