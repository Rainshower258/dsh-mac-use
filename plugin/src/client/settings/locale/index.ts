/**
 * The settings tabs' text, merged into the page's one namespace (locale.ts NS) beside the daemon tab's keys: the
 * shared file (`settings.`) and one file per tab (`settings.<tab>.`), each with the same keys in zh and en.
 *
 * @module
 */

import type { SettingsTab } from '../model.ts'
import * as access from './access.ts'
import * as apps from './apps.ts'
import * as behavior from './behavior.ts'
import * as logs from './logs.ts'
import * as overview from './overview.ts'
import * as privacy from './privacy.ts'
import * as shared from './shared.ts'
import * as shortcuts from './shortcuts.ts'

export interface Dictionaries {
  readonly zh: Readonly<Record<string, string>>
  readonly en: Readonly<Record<string, string>>
}

/** Every settings dictionary file by name: `shared`, then each tab's. */
export const LOCALE_FILES: Readonly<Record<'shared' | SettingsTab, Dictionaries>> = {
  shared, overview, access, apps, shortcuts, privacy, behavior, logs,
}

const merge = (lang: 'zh' | 'en'): Record<string, string> =>
  Object.assign({}, ...Object.values(LOCALE_FILES).map((file) => file[lang])) as Record<string, string>

/** Every settings key, merged. */
export const zh = merge('zh')
export const en = merge('en')
