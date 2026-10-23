import Foundation

// MARK: - Turn focus (access.turn_start, access.turn_end restore_focus)

/// A turn ends with the app its actions brought forward (QQ) in front, and with it the keyboard: the user's next words
/// for dsh would go into that app, and Enter would send them (2026-10-08 QQ run). So the plugin (cu-desktop,
/// `restoreFocus`) marks each turn's start, and at its end the daemon hands the focus back to the app that was in front
/// then (the browser with dsh, where the user just wrote), but only if the app in front now is one this turn's actions
/// targeted: an app the user switched to is left alone. Turn ends of every kind (completed, aborted by stop, error,
/// blocked) come through the same dsh `turn/end` event. No timer: an idle timer would pull the focus away from a
/// person working in the app themselves.
extension Dispatcher {
    struct TurnEndParams: Decodable {
        let taskId: String
        let restoreFocus: Bool?
    }

    /// access.turn_start: remember the app in front (never this daemon: its dialog is not where the user works). A late
    /// mark (the daemon was not running when the turn began; the plugin marks before its first call) may find another
    /// app in front by then: it names the host only for a task with none yet, never replacing one a turn start found.
    func markTurnStart(_ taskID: String, late: Bool = false, _ f: inout [String: JSONValue]) -> JSONValue {
        f["task_id"] = .string(taskID)
        book.turnTargets.removeValue(forKey: taskID)
        guard let front = env.frontmostBundleID(), front.caseInsensitiveCompare(HardDeny.daemon) != .orderedSame else {
            book.turnFront.removeValue(forKey: taskID)
            return ["front": .null]
        }
        book.turnFront[taskID] = front.lowercased()
        if !late || book.hostApp[taskID] == nil { book.hostApp[taskID] = front.lowercased() }
        f["front"] = .string(front.lowercased())
        return ["front": .string(front.lowercased())]
    }

    /// The task's host app (AccessBook.hostApp) is refused like a hard-denied one: no dialog, no look, no action.
    func checkNotHost(_ taskID: String, _ app: String) throws {
        guard let host = book.hostApp[taskID], host == app.lowercased() else { return }
        throw Denial("dsh_host_app", "\(app) is where the user talks to you (dsh runs in it); it is never granted to this "
                     + "task, in any mode, so you cannot operate your own conversation or its approvals")
    }

    /// Every action (act.*, apps.launch) first: the task's grant must allow its kind on its target app (apps.launch
    /// names it bundle_id), whose mode limits the kind as well. A target that passed is recorded for the turn.
    func admitAction(_ kind: ActionKind, _ params: JSONValue?, _ f: inout [String: JSONValue]) throws {
        let t = try JSONCoding.decodeParams(TaskParams.self, params)
        f["task_id"] = .string(t.taskId)
        let target = params?["app"]?.stringValue ?? params?["bundle_id"]?.stringValue
        if kind == .launch {
            let opening = params?["open"]?.stringValue != nil
            do { try admitLaunch(try activeGrant(t.taskId), app: target, opening: opening) } catch let d as Denial {
                throw launchDenial(d, app: target, opening: opening)
            }
            return noteTurnTarget(t.taskId, target)
        }
        try activeGrant(t.taskId).checkAllows(kind, app: target,
                                                            axAction: kind == .axAction ? params?["action"]?.stringValue : nil)
        noteTurnTarget(t.taskId, target)
    }

    /// An action that passed the grant check targets `app`: recorded for a marked turn only.
    func noteTurnTarget(_ taskID: String, _ app: String?) {
        guard let app, book.turnFront[taskID] != nil else { return }
        book.turnTargets[taskID, default: []].insert(app.lowercased())
    }

    /// At the turn's end: the focus back to the app in front at its start, if an app this turn's actions targeted is
    /// in front now. Always ends the turn's record. Audited as `focus` restored / skipped (`focus_skipped` why) /
    /// failed.
    func restoreTurnFocus(_ taskID: String, _ f: inout [String: JSONValue]) -> String {
        let targets = book.turnTargets.removeValue(forKey: taskID) ?? []
        let before = book.turnFront.removeValue(forKey: taskID)
        let front = env.frontmostBundleID()?.lowercased()
        if let before { f["focus_to"] = .string(before) }
        if let front { f["focus_from"] = .string(front) }
        let running = before == nil ? [] : env.runningBundleIDs()
        guard let before, let front, front != before, targets.contains(front), running.contains(before) else {
            f["focus_skipped"] = before == nil ? "no_turn_start" : front == nil ? "front_unknown"
                : front == before ? "already_front" : !targets.contains(front ?? "") ? "front_not_targeted" : "previous_gone"
            f["focus"] = "skipped"
            return "skipped"
        }
        let ok = env.activate(bundleID: before, timeout: Self.activationTimeout, method: activationMethod)
            || (activationMethod != .axFrontmost
                && env.activate(bundleID: before, timeout: Self.activationTimeout, method: .axFrontmost))
        f["focus"] = ok ? "restored" : "failed"
        return ok ? "restored" : "failed"
    }
}
