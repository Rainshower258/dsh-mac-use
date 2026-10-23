/**
 * One settings change as the page sends it: `POST api/cu-runtime.settings.apply` with `{"change": <one of these>}`,
 * exactly the daemon's shape (Sources/CURuntimeCore/SettingsChange.swift, `SettingsChange.keys` and `decode`): a
 * `kind` and exactly that kind's keys, the values the daemon offers. The host checks the shape again before anything
 * reaches the daemon (HTTP 400 bad_request otherwise), and the daemon decides whether a change loosens anything and
 * asks the person at the Mac for Touch ID or the login password itself; the page never says what loosens.
 *
 * - `chord.add` and `chord.remove` always carry `app`: a bundle ID, or null for every approved app.
 * - `deny.add` and `chord.add` always carry `note` ('' when none; at most CHANGE_LIMITS.note characters).
 * - `behavior.set` with field `activation_method` takes null for the daemon's default.
 * - There is no change for a log folder or an imported file: those go through the daemon's own panels
 *   (settings.action.choose_log_directory, settings.action.import then import_confirm).
 *
 * @module
 */

export type AppMode = 'read' | 'full'
export type DefaultMode = 'ask' | 'read' | 'full'
export type DialogDefault = 'deny' | 'turn' | 'session' | 'always'
export type PrivacyField = 'send_screenshots' | 'send_ax_text' | 'send_ocr' | 'send_zoom'
export type ChangePolicy = 'leave' | 'ask' | 'takeover'
export type ActivationMethod = 'running_application' | 'ax_frontmost' | 'ax_raise'

/** The access rules' offered values (AccessDefaults' choices; the snapshot's access_choices says the same). */
export type AccessEdit =
  | { readonly field: 'default_mode'; readonly value: DefaultMode }
  | { readonly field: 'session_limit_minutes'; readonly value: 15 | 30 | 60 }
  | { readonly field: 'dialogs_per_turn'; readonly value: 1 | 2 | 3 }
  | { readonly field: 'dialog_timeout_seconds'; readonly value: 60 | 120 | 180 }
  | { readonly field: 'dialog_default'; readonly value: DialogDefault }

export type BehaviorEdit =
  | { readonly field: 'restore_focus_on_turn_end' | 'allow_point_targets' | 'electron_ax_auto'; readonly value: boolean }
  | { readonly field: 'ime_policy_cap'; readonly value: ChangePolicy }
  | { readonly field: 'activation_method'; readonly value: ActivationMethod | null }

export type SettingsChange =
  | { readonly kind: 'revoke'; readonly task_id: string }
  | { readonly kind: 'revoke_all' }
  | { readonly kind: 'persistent.remove'; readonly bundle_id: string }
  | { readonly kind: 'persistent.add'; readonly bundle_id: string; readonly mode: AppMode }
  | { readonly kind: 'persistent.mode'; readonly bundle_id: string; readonly mode: AppMode }
  | { readonly kind: 'persistent.reapprove'; readonly bundle_id: string }
  | { readonly kind: 'deny.add'; readonly bundle_id: string; readonly note: string }
  | { readonly kind: 'deny.remove'; readonly bundle_id: string }
  | ({ readonly kind: 'access.set' } & AccessEdit)
  | { readonly kind: 'chord.disable'; readonly chord: string }
  | { readonly kind: 'chord.enable'; readonly chord: string }
  | { readonly kind: 'chord.add'; readonly chord: string; readonly app: string | null; readonly note: string }
  | { readonly kind: 'chord.remove'; readonly chord: string; readonly app: string | null }
  | { readonly kind: 'privacy.set'; readonly field: PrivacyField; readonly on: boolean }
  | { readonly kind: 'text_only.add'; readonly bundle_id: string }
  | { readonly kind: 'text_only.remove'; readonly bundle_id: string }
  | { readonly kind: 'clipboard.set'; readonly on: boolean }
  | ({ readonly kind: 'behavior.set' } & BehaviorEdit)
  | { readonly kind: 'logs.retention'; readonly days: 7 | 30 | 90 }
  | { readonly kind: 'logs.default_directory' }
  | { readonly kind: 'reset' }

export type ChangeKind = SettingsChange['kind']

/** The keys each kind takes besides `kind` (SettingsChange.keys in the daemon): exactly these. */
export const CHANGE_KEYS: Readonly<Record<ChangeKind, readonly string[]>> = {
  'revoke': ['task_id'], 'revoke_all': [],
  'persistent.remove': ['bundle_id'], 'persistent.add': ['bundle_id', 'mode'],
  'persistent.mode': ['bundle_id', 'mode'], 'persistent.reapprove': ['bundle_id'],
  'deny.add': ['bundle_id', 'note'], 'deny.remove': ['bundle_id'],
  'access.set': ['field', 'value'],
  'chord.disable': ['chord'], 'chord.enable': ['chord'],
  'chord.add': ['chord', 'app', 'note'], 'chord.remove': ['chord', 'app'],
  'privacy.set': ['field', 'on'],
  'text_only.add': ['bundle_id'], 'text_only.remove': ['bundle_id'],
  'clipboard.set': ['on'],
  'behavior.set': ['field', 'value'],
  'logs.retention': ['days'], 'logs.default_directory': [],
  'reset': [],
}

/** The daemon's limits (SettingsChange.max*), in characters. */
export const CHANGE_LIMITS = { bundleId: 255, note: 200, chord: 64, taskId: 255 } as const

/** The daemon's settings.action names, one route each (`api/cu-runtime.settings.action.<name>`, no body). */
export const SETTINGS_ACTIONS = ['choose_log_directory', 'use_default_log_directory', 'choose_app', 'export_settings',
  'export_audit', 'import', 'import_confirm', 'reveal_log'] as const

export type SettingsAction = typeof SETTINGS_ACTIONS[number]
