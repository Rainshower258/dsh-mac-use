import Foundation

/// What a client may do after an error (decided 2026-09-29). Every refusal (-32010) carries
/// `data.executed` and `data.retry`; the plugin retries automatically only `after_delay`, a bounded number of
/// times. Everything else goes back to the model.
public enum RetryClass: String, Sendable, CaseIterable {
    /// Refused before anything was executed, for a transient reason: the same request may succeed a moment later.
    case afterDelay = "after_delay"
    /// Refused before anything was executed because the screen changed or the target is not where the snapshot said:
    /// observe again and derive a new request. Never resend the same one.
    case afterObserve = "after_observe"
    /// Refused before anything was executed by policy or because the request itself is wrong: retrying changes nothing.
    case never
    /// The action may already have happened (in full or in part). Never retry automatically: observe first.
    case outcomeUnknown = "outcome_unknown"
}

public enum Refusals {
    /// Every refusal reason the daemon produces. A test checks that each `Denial("…")` in the sources is listed.
    public static let classes: [String: RetryClass] = [
        // transient
        "overlay_state_unknown": .afterDelay,
        "activation_failed": .afterDelay,
        "window_focus_failed": .afterDelay,
        "too_many_connections": .afterDelay,
        "launch_failed": .afterDelay,
        // the screen moved on
        "stale_element": .afterObserve,
        "stale_coordinates": .afterObserve,
        "stale_snapshot": .afterObserve,
        "not_on_target_window": .afterObserve,
        "not_on_granted_window": .afterObserve,
        "hit_test_failed": .afterObserve,
        "unknown_element": .afterObserve,
        "unknown_zoom": .afterObserve,
        "zoom_snapshot_mismatch": .afterObserve,
        "no_image_mapping": .afterObserve,
        "ax_unsupported": .afterObserve,
        "ime_composing": .afterObserve,
        // policy or a malformed request
        "hard_denied": .never,
        "user_denied": .never,
        "hard_denied_frontmost": .never,
        "dsh_host_app": .never,
        "menu_excluded": .never,
        "menu_not_found": .never,
        "menu_item_disabled": .never,
        "menu_unavailable": .never,
        "not_granted": .never,
        "app_name_ambiguous": .never,
        "no_grant": .never,
        "grant_expired": .never,
        "finder_not_enabled": .never,
        "launch_not_allowed": .never,
        "open_not_allowed": .never,
        "open_not_found": .never,
        "open_no_permission": .never,
        "action_not_allowed": .never,
        "click_not_allowed": .never,
        "element_not_in_app": .never,
        "chord_not_allowed": .never,
        "invalid_chord": .never,
        "ax_action_not_allowed": .never,
        "snapshot_required": .never,
        "undeclared_coordinate_space": .never,
        "unknown_coordinate_space": .never,
        "zoom_not_magnifying": .never,
        "zoom_outside_display": .never,
        "not_implemented": .never,
        "debug_disabled": .never,
        "secure_input": .never,
        "frame_too_large": .never,
        // The screen is locked; the person unlocks it and the model observes again (never retried on its own).
        "session_locked": .never,
        // act.type strategy paste: the clipboard could not be saved before a paste; nothing was pasted.
        "clipboard_unavailable": .never,
        "clipboard_too_large": .never,
        // Approval dialogs (access.*): policy, or a person said no / did not answer. The plugin tells the model.
        "app_not_found": .never,
        "unsigned_app": .never,
        "approval_unavailable": .never,
        "config_grants_disabled": .never,
        "grant_owner_mismatch": .never,
        "turn_owner_mismatch": .never,
        "approval_no_turn": .never,
        "approval_busy": .never,
        "approval_limit": .never,
        "approval_refused_earlier": .never,
        "approval_rejected": .never,
        "approval_timeout": .never,
        // The settings methods (Dispatcher+Settings: the window, and since 2026-10-21 the socket's settings.*): never
        // the model's to retry.
        "verification_required": .never,
        // The daemon's owner check (OwnerCheck) and the settings over the socket: a person at the Mac acts
        // (waits out the check in flight or the cool-down, answers the approval dialog first, tries again), never a
        // client on its own. approval_open: an approval dialog is up; settings_unavailable: no panels (headless);
        // nothing_pending: no change waits for the owner check, or no imported file waits to be confirmed;
        // settings_changed: import_confirm on a preview the settings have since changed (the fresh one is shown).
        "verify_busy": .never,
        "verify_cooldown": .never,
        "verify_unavailable": .never,
        "verify_failed": .never,
        "verify_cancelled": .never,
        "approval_open": .never,
        "settings_unavailable": .never,
        "nothing_pending": .never,
        "settings_changed": .never,
        "not_found": .never,
        "chord_never_allowed": .never,
        "zoom_off": .never,
        "point_targets_off": .never,
        "log_directory_missing": .never,
        "chord_builtin": .never,
        "app_not_grantable": .never,
        "unknown_request": .never,
        // Input method policy: the plugin asks a person (ask) or resends with ime_policy "leave"; never as-is.
        "ime_switch_needs_approval": .never,
        "ime_switch_failed": .never,
        // may have happened
        "action_failed": .outcomeUnknown,
        "focus_lost": .outcomeUnknown,
        "open_failed": .outcomeUnknown,   // the app may have started
        "open_waiting": .outcomeUnknown,  // the open goes on after the wait: it completes once the user answers macOS
    ]

    /// Unlisted reasons are treated as unknown outcomes: the safe default for a client.
    public static func retry(for reason: String) -> RetryClass { classes[reason] ?? .outcomeUnknown }

    /// The `data` of a refusal: its reason, whether anything was executed, and the retry class.
    public static func data(reason: String, extra: [String: JSONValue] = [:]) -> JSONValue {
        let cls = retry(for: reason)
        var d = extra
        d["reason"] = .string(reason)
        d["retry"] = .string(cls.rawValue)
        d["executed"] = cls == .outcomeUnknown ? .null : .bool(false)
        if cls == .outcomeUnknown { d["action_may_have_executed"] = true }
        return .object(d)
    }
}
