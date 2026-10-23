import Foundation

// MARK: - The settings window's view of the daemon (2026-10-15)

/// One approved app inside a grant, as the overview lists it.
public struct ActiveAppInfo: Sendable, Equatable {
    public let bundleID: String
    /// nil for a config grant (grants.set): no per-app mode.
    public let mode: AppMode?
    public let scope: AccessScope?
    public let expiresAt: Date
}

public struct ActiveGrantInfo: Sendable, Equatable {
    public let taskID: String
    public let source: Grant.Source
    public let expiresAt: Date
    public let apps: [ActiveAppInfo]
    /// The requesting process, when a person approved it (GrantOwner).
    public let ownerPID: Int32?
    /// That process has exited (the grant ends at its task's next request; the window says so meanwhile).
    public let ownerGone: Bool
}

/// Everything the window shows, read in one hop to the worker queue.
public struct SettingsSnapshot: Sendable {
    public let startedAt: Date
    public let settings: UserSettings
    public let grants: [ActiveGrantInfo]
    public let persistent: [PersistentGrant]
    /// Per persistent entry (lowercased bundle ID): whether the app at its recorded path still satisfies the
    /// signature it was pinned to; absent when the daemon has no app directory. A changed signature voids the
    /// entry on its next use (persistentAccess); the window shows it as such meanwhile.
    public let persistentValid: [String: Bool]
    public let hardDeny: [HardDeny.Entry]
    /// Where the audit is written now (the logs setting applied to the default); nil in tests.
    public let logDirectory: URL?
}

/// Called on the worker queue only (Server.perform, or a socket request). Every change is audited as `settings.*`.
/// Callers: the settings window, and (since 2026-10-21) the socket's settings methods (Dispatcher+SettingsRPC.swift)
/// through settingsApply (SettingsChange.swift). Each loosening setter refuses unless `verified`: the window passes
/// true after its own owner check, the socket path only when the daemon's OwnerCheck said ok; a caller's word never
/// counts.
extension Dispatcher {
    public func settingsSnapshot() -> SettingsSnapshot {
        let t = now()
        let infos = grants.all(now: t).map { g -> ActiveGrantInfo in
            let apps: [ActiveAppInfo] = g.bundleIDs.map { id in
                if let a = g.access[id.lowercased()] {
                    return ActiveAppInfo(bundleID: a.bundleID, mode: a.mode, scope: a.scope, expiresAt: a.expiresAt)
                }
                return ActiveAppInfo(bundleID: id, mode: nil, scope: nil, expiresAt: g.expiresAt)
            }
            return ActiveGrantInfo(taskID: g.taskID, source: g.source, expiresAt: g.expiresAt, apps: apps, ownerPID: g.owner?.pid,
                                   ownerGone: g.owner?.pid.map { env.processPath(pid: $0) == nil } ?? false)
        }
        let persistent = (try? approvals.persistent.load()) ?? []
        var valid: [String: Bool] = [:]
        if let apps {
            for e in persistent { valid[e.bundleId.lowercased()] = apps.satisfies(path: e.path, requirement: e.requirement) }
        }
        return SettingsSnapshot(startedAt: startedAt, settings: settings, grants: infos, persistent: persistent,
                                persistentValid: valid, hardDeny: HardDeny.entries + HardDeny.namespaces,
                                logDirectory: effectiveLogDirectory)
    }

    /// The settings page's view: snake_case JSON with no secret, token, state-directory path or raw
    /// audit line. App names come from `names` (the daemon's panels, SettingsPanels.appName), null without one. The
    /// log directory is shown (home as ~) only when the person chose one; the default lives under the state
    /// directory and shows as null with `directory_custom` false. The audit lists keep only time, method, app and
    /// reason (refusals) or reason and verified (changes); never a detail text.
    public func settingsSnapshotJSON(names: (String) -> String? = { _ in nil }) -> JSONValue {
        let snap = settingsSnapshot()
        let s = snap.settings
        func name(_ id: String) -> JSONValue { names(id).map { .string($0) } ?? .null }
        func time(_ d: Date) -> JSONValue { .number(d.timeIntervalSince1970) }
        let grants: [JSONValue] = snap.grants.map { g in
            let apps: [JSONValue] = g.apps.map { a in
                ["bundle_id": .string(a.bundleID), "name": name(a.bundleID), "mode": a.mode.map { .string($0.rawValue) } ?? .null,
                 "scope": a.scope.map { .string($0.rawValue) } ?? .null, "expires_at": time(a.expiresAt)]
            }
            // by_dialog: approved through access.request (a dialog, the always list or the default mode), not grants.set.
            return ["task_id": .string(g.taskID), "expires_at": time(g.expiresAt), "by_dialog": .bool(g.source == .approval),
                    "owner_gone": .bool(g.ownerGone), "apps": .array(apps)]
        }
        let persistent: [JSONValue] = snap.persistent.map { e in
            ["bundle_id": .string(e.bundleId), "name": name(e.bundleId), "mode": .string(e.mode), "added_at": .number(e.addedAt),
             "signature_ok": snap.persistentValid[e.bundleId.lowercased()].map { .bool($0) } ?? .null]
        }
        let denylist: [JSONValue] = s.denylist.map { ["bundle_id": .string($0.bundleId), "name": name($0.bundleId), "note": .string($0.note)] }
        let hardDeny: [JSONValue] = HardDeny.entries.map {
            ["bundle_id": .string($0.bundleID), "name": name($0.bundleID), "category": .string($0.category.rawValue)]
        } + HardDeny.namespaces.map { ["namespace": .string($0.bundleID), "name": .null, "category": .string($0.category.rawValue)] }
        let chords: JSONValue = [
            "builtin": .array(ChordPolicy.builtinOrder.map { ["chord": .string($0.description), "enabled": .bool(!s.chords.isDisabled($0))] }),
            "never": .array(ChordPolicy.neverAllowed.map(\.description).sorted().map { .string($0) }),
            "custom": .array(s.chords.custom.map { ["chord": .string($0.chord), "app": $0.app.map { .string($0) } ?? .null, "note": .string($0.note)] }),
        ]
        let choices: JSONValue = [
            "default_mode": .array(DefaultMode.allCases.map { .string($0.rawValue) }),
            "session_limit_minutes": .array(AccessDefaults.sessionChoices.map { .number(Double($0)) }),
            "dialogs_per_turn": .array(AccessDefaults.dialogChoices.map { .number(Double($0)) }),
            "dialog_timeout_seconds": .array(AccessDefaults.timeoutChoices.map { .number(Double($0)) }),
            "dialog_default": .array(DialogDefault.allCases.map { .string($0.rawValue) }),
        ]
        var files = 0, bytes = 0
        var refusals: [JSONValue] = [], changes: [JSONValue] = []
        if let dir = snap.logDirectory {
            let fm = FileManager.default
            for n in (try? fm.contentsOfDirectory(atPath: dir.path)) ?? [] where n.hasPrefix("audit-") && n.hasSuffix(".jsonl") {
                files += 1
                bytes += (try? fm.attributesOfItem(atPath: dir.appendingPathComponent(n).path))?[.size] as? Int ?? 0
            }
            refusals = AuditReader.recentRefusals(directory: dir, now: now()).map { r in
                ["at": time(r.at), "method": .string(r.method), "app": r.app.map { .string($0) } ?? .null, "reason": .string(r.reason)]
            }
            changes = AuditReader.recentSettingsChanges(directory: dir, now: now()).map { c in
                let verified: JSONValue = if case .bool(let b)? = c.fields["verified"] { .bool(b) } else { .null }
                return ["at": time(c.at), "method": .string(c.method), "app": c.fields["app"]?.stringValue.map { .string($0) } ?? .null,
                        "reason": c.fields["reason"]?.stringValue.map { .string($0) } ?? .null, "verified": verified]
            }
        }
        let logs: JSONValue = [
            "directory": s.logs.directory != nil ? snap.logDirectory.map { .string(Self.shownPath($0)) } ?? .null : .null,
            "directory_custom": .bool(s.logs.directory != nil), "retention_days": .number(Double(s.logs.retentionDays)),
            "files": .number(Double(files)), "bytes": .number(Double(bytes)),
        ]
        return ["started_at": time(snap.startedAt), "grants": .array(grants), "persistent": .array(persistent),
                "denylist": .array(denylist), "hard_deny": .array(hardDeny), "access": s.access.json, "access_choices": choices,
                "chords": chords, "privacy": s.privacy.json, "behavior": s.behavior.json, "logs": logs,
                "recent_refusals": .array(refusals), "recent_changes": .array(changes)]
    }

    /// Revokes one task's grant (the overview's per-row "revoke").
    @discardableResult
    public func settingsRevoke(taskID: String) -> Bool {
        let gone = grants.revoke(taskID)
        audit.record(["method": "settings.revoke", "decision": gone ? "revoke" : "allow", "task_id": .string(taskID),
                      "found": .bool(gone)])
        return gone
    }

    /// Revokes every active grant (the overview's "revoke all" and the stop button). Returns how many.
    @discardableResult
    public func settingsRevokeAll() -> Int {
        let all = grants.all(now: now())
        for g in all { grants.revoke(g.taskID) }
        audit.record(["method": "settings.revoke_all", "decision": "revoke", "count": .number(Double(all.count))])
        return all.count
    }

    /// Removes an app from the persistent ("always") list: tightening, no verification.
    public func settingsRevokePersistent(bundleID: String) throws {
        let gone = try PersistentGrants.revoke(bundleID: bundleID, store: approvals.persistent)
        audit.record(["method": "settings.persistent_revoke", "decision": "revoke", "app": .string(bundleID),
                      "found": .bool(!gone.isEmpty)])
    }

    /// Puts an app on the user's deny list: refused from now on, in every mode, without a dialog; and dropped at once
    /// from every active grant (a session that had it loses it mid-task) and from the persistent list.
    public func settingsDenylistAdd(bundleID: String, note: String) throws {
        let id = bundleID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else { throw RPCFailure(.invalidParams, "bundle ID is empty") }
        var s = settings
        s.denylist.removeAll { $0.bundleId.caseInsensitiveCompare(id) == .orderedSame }
        s.denylist.append(DenyEntry(bundleId: id, note: note, addedAt: now()))
        try settingsStore.save(s)
        settings = s
        var dropped: [String] = []
        for g in grants.all(now: now()) where g.covers(id) {
            if let kept = g.dropping(bundleID: id) { grants.set(kept) } else { grants.revoke(g.taskID) }
            dropped.append(g.taskID)
        }
        let persistentGone = (try? PersistentGrants.revoke(bundleID: id, store: approvals.persistent)) ?? []
        audit.record(["method": "settings.denylist_add", "decision": "allow", "app": .string(id),
                      "note_len": .number(Double(note.count)), "dropped_from": .array(dropped.map { .string($0) }),
                      "persistent_removed": .bool(!persistentGone.isEmpty)])
    }

    /// Sets the access rules (the "modes and defaults" page). Tightening takes effect at once (the next dialog count,
    /// timeout and approval use the new values); loosening any field needs the person verified, which the window does
    /// first and the daemon insists on. Audited with what changed.
    public func settingsSetAccess(_ new: AccessDefaults, verified: Bool) throws {
        try new.validate()
        let loosened = settings.access.loosened(by: new)
        guard loosened.isEmpty || verified else {
            throw Denial("verification_required", "loosening \(loosened.joined(separator: ", ")) needs the user verified")
        }
        guard new != settings.access else { return }
        var s = settings
        let before = s.access
        s.access = new
        try settingsStore.save(s)
        settings = s
        audit.record(["method": "settings.access", "decision": "allow", "before": before.json, "after": new.json,
                      "loosened": .array(loosened.map { .string($0) }), "verified": .bool(verified)])
    }

    /// One edit (the window's control) applied to the access rules as they are when it runs, not to a copy taken at
    /// the click: what changed meanwhile, while an owner check was open, is kept (VM test, 2026-10-17: a whole
    /// copy written back after the check undid the change made in between).
    public func settingsEditAccess(verified: Bool, _ edit: (inout AccessDefaults) -> Void) throws {
        var new = settings.access
        edit(&new)
        try settingsSetAccess(new, verified: verified)
    }

    /// Puts an app on the persistent ("always") list from the window (added 2026-10-17), pinned to its
    /// signature now, like the terminal command. Loosening: verified. The floor, the deny list and an app that is
    /// not installed are refused first (whether verified or not: nothing to verify for), an unsigned app as everywhere.
    public func settingsPersistentAdd(bundleID: String, mode: AppMode, verified: Bool) throws {
        let id = bundleID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else { throw RPCFailure(.invalidParams, "bundle ID is empty") }
        guard let apps else { throw RPCFailure(.internalError, "no app directory") }
        try GrantRules.checkGrantable(id, source: .approval, config: config, settings: settings)
        guard let identity = apps.identity(bundleID: id) else { throw Denial("app_not_found", "\(id) is not installed") }
        guard verified else { throw Denial("verification_required", "adding \(id) to the always list needs the user verified") }
        let e = try PersistentGrants.add(identity, mode: mode, via: "settings", store: approvals.persistent, apps: apps,
                                         now: now(), settings: settings)
        audit.record(["method": "settings.persistent_add", "decision": "allow", "app": .string(e.bundleId),
                      "mode": .string(e.mode), "path": .string(e.path), "verified": true])
    }

    /// Changes a persistent ("always") entry's mode. Raising read to full is loosening (verified); lowering takes
    /// effect at once: the app also leaves every active grant, so a task holding it full asks again.
    public func settingsSetPersistentMode(bundleID: String, mode: AppMode, verified: Bool) throws {
        let list = (try? approvals.persistent.load()) ?? []
        guard let e = list.first(where: { $0.bundleId.caseInsensitiveCompare(bundleID) == .orderedSame }) else {
            throw Denial("not_found", "\(bundleID) is not on the persistent list")
        }
        guard e.appMode != mode else { return }
        let loosening = mode == .full
        guard !loosening || verified else {
            throw Denial("verification_required", "raising \(bundleID) to full needs the user verified")
        }
        _ = try PersistentGrants.setMode(bundleID: bundleID, mode: mode, store: approvals.persistent)
        var dropped: [String] = []
        if !loosening {
            for g in grants.all(now: now()) where g.covers(bundleID) {
                if let kept = g.dropping(bundleID: bundleID) { grants.set(kept) } else { grants.revoke(g.taskID) }
                dropped.append(g.taskID)
            }
        }
        audit.record(["method": "settings.persistent_mode", "decision": "allow", "app": .string(bundleID),
                      "from": .string(e.mode), "to": .string(mode.rawValue), "verified": .bool(verified),
                      "dropped_from": .array(dropped.map { .string($0) })])
    }

    /// Pins a persistent entry to the signature its app carries now (the entry was voided by a re-signed app).
    /// Loosening: verified. An app not on the list is refused first.
    public func settingsReapprovePersistent(bundleID: String, verified: Bool) throws {
        let listed = ((try? approvals.persistent.load()) ?? []).contains { $0.bundleId.caseInsensitiveCompare(bundleID) == .orderedSame }
        guard listed else { throw Denial("not_found", "\(bundleID) is not on the persistent list") }
        guard verified else { throw Denial("verification_required", "approving \(bundleID) again needs the user verified") }
        guard let apps else { throw RPCFailure(.internalError, "no app directory") }
        guard let e = try PersistentGrants.repin(bundleID: bundleID, store: approvals.persistent, apps: apps, now: now()) else {
            throw Denial("not_found", "\(bundleID) is not on the persistent list")
        }
        audit.record(["method": "settings.persistent_reapprove", "decision": "allow", "app": .string(e.bundleId),
                      "mode": .string(e.mode), "path": .string(e.path), "verified": true])
    }

    // MARK: behavior, import, reset

    /// One edit applied to the behavior settings as they are when it runs (see settingsEditAccess): two writers never
    /// undo each other with stale copies.
    public func settingsEditBehavior(verified: Bool, _ edit: (inout BehaviorSettings) -> Void) throws {
        var new = settings.behavior
        edit(&new)
        try settingsSetBehavior(new, verified: verified)
    }

    /// Sets how the model operates. Coordinate targets on, a higher input-source cap and Electron AX on widen what
    /// the model can do (BehaviorSettings.loosened): those need the person verified; the rest applies at once.
    /// `verified` defaults to false so the window's whole-struct call (until it moves to settingsEditBehavior)
    /// can only tighten.
    public func settingsSetBehavior(_ new: BehaviorSettings, verified: Bool = false) throws {
        try new.validate()
        let loosened = settings.behavior.loosened(by: new)
        guard loosened.isEmpty || verified else {
            throw Denial("verification_required", "loosening \(loosened.joined(separator: ", ")) needs the user verified")
        }
        guard new != settings.behavior else { return }
        var s = settings
        let before = s.behavior
        s.behavior = new
        try settingsStore.save(s)
        settings = s
        audit.record(["method": "settings.behavior", "decision": "allow", "before": before.json, "after": new.json,
                      "loosened": .array(loosened.map { .string($0) }), "verified": .bool(verified)])
    }

    /// Replaces the settings with a file's (or the defaults, `method` "settings.reset"): whatever it loosens (the
    /// window lists it first) needs the person verified. The version is the daemon's; the retention is applied.
    public func settingsImport(_ new: UserSettings, verified: Bool, method: String = "settings.import") throws {
        try new.access.validate()
        try new.privacy.validate()
        try new.behavior.validate()
        let loosened = settings.loosened(by: new)
        guard loosened.isEmpty || verified else {
            throw Denial("verification_required", "the import loosens \(loosened.count) item(s); needs the user verified")
        }
        var s = new
        s.version = UserSettings.currentVersion
        try settingsStore.save(s)
        let before = settings
        settings = s
        try applyLogSettings(from: before.logs, to: s.logs)
        for g in grants.all(now: now()) {
            // Apps now denied leave every active grant, as a single deny-list add does.
            for id in g.bundleIDs where s.denies(id) != nil {
                if let kept = g.dropping(bundleID: id) { grants.set(kept) } else { grants.revoke(g.taskID) }
            }
        }
        audit.record(["method": .string(method), "decision": "allow", "loosened": .array(loosened.map { .string($0) }),
                      "verified": .bool(verified), "denylist_count": .number(Double(s.denylist.count)),
                      "custom_chords": .number(Double(s.chords.custom.count))])
    }

    /// Back to the defaults, keeping the deny list, the text-only apps and the chords switched off.
    public func settingsReset(verified: Bool) throws {
        try settingsImport(settings.resetToDefaults(), verified: verified, method: "settings.reset")
    }

    // MARK: privacy

    /// One edit applied to the privacy settings as they are when it runs (see settingsEditAccess).
    public func settingsEditPrivacy(verified: Bool, _ edit: (inout PrivacySettings) -> Void) throws {
        var new = settings.privacy
        edit(&new)
        try settingsSetPrivacy(new, verified: verified)
    }

    /// Sets what is sent and kept. Switching content off, the clipboard setting and the retention apply at once;
    /// switching content back on or taking an app off the text-only list needs the person verified.
    public func settingsSetPrivacy(_ new: PrivacySettings, verified: Bool) throws {
        try new.validate()
        let loosened = settings.privacy.loosened(by: new)
        guard loosened.isEmpty || verified else {
            throw Denial("verification_required", "loosening \(loosened.joined(separator: ", ")) needs the user verified")
        }
        guard new != settings.privacy else { return }
        var s = settings
        let before = s.privacy
        s.privacy = new
        try settingsStore.save(s)
        settings = s
        audit.record(["method": "settings.privacy", "decision": "allow", "before": before.json, "after": new.json,
                      "loosened": .array(loosened.map { .string($0) }), "verified": .bool(verified)])
    }

    /// How actions bring an app to the front: the behavior setting, else config.json, else the measured default.
    var activationMethod: ActivationMethod {
        settings.behavior.activationMethod.flatMap(ActivationMethod.init(rawValue:))
            ?? config.activationMethod.flatMap(ActivationMethod.init(rawValue:)) ?? Self.defaultActivationMethod
    }

    /// The last thing on the worker before the process exits: the stop is on record, then every system change
    /// in force is restored (SystemStateChanges). `trigger`: signal_15, settings_stop, settings_restart.
    public func shutdownCleanup(trigger: String) {
        audit.record(["method": "runtime.stop", "decision": "allow", "trigger": .string(trigger),
                      "uptime_s": .number(Date().timeIntervalSince(startedAt).rounded())])
        restoreAllSystemState(trigger: trigger)
    }

    /// At start: the retention in force.
    public func applyAuditRetention() { audit.setRetention(days: settings.logs.retentionDays) }

    // MARK: the log (2026-10-17)

    /// Where the audit is written: the logs setting applied to the default.
    public var effectiveLogDirectory: URL? { defaultLogDirectory.map { settings.logs.effectiveDirectory(default: $0) } }

    /// One edit applied to the logs setting as it is when it runs (see settingsEditAccess).
    public func settingsEditLogs(verified: Bool, _ edit: (inout LogSettings) -> Void) throws {
        var new = settings.logs
        edit(&new)
        try settingsSetLogs(new, verified: verified)
    }

    /// Sets where the log lives and how long it is kept. A new folder must exist; the files move at once (the audit
    /// line about the move is the first line in the new place). A shorter retention deletes audit files at once
    /// (LogSettings.loosened): it needs the person verified. The folder needs no check, since it only ever comes
    /// from the daemon's own folder panel or "use the default" (a client never names a path). `verified` defaults
    /// to false so the window's whole-struct call (until it moves to settingsEditLogs) cannot shorten the retention.
    public func settingsSetLogs(_ new: LogSettings, verified: Bool = false) throws {
        try new.validate()
        let loosened = settings.logs.loosened(by: new)
        guard loosened.isEmpty || verified else {
            throw Denial("verification_required", "a shorter retention deletes audit files; needs the user verified")
        }
        guard new != settings.logs else { return }
        if let d = new.directory, d != settings.logs.directory {
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: d, isDirectory: &isDir), isDir.boolValue else {
                throw Denial("log_directory_missing", "\(d) is not an existing folder")
            }
        }
        let before = settings.logs
        try applyLogSettings(from: before, to: new)   // the move first: when it fails, nothing is saved
        var s = settings
        s.logs = new
        do { try settingsStore.save(s) } catch {
            try? applyLogSettings(from: new, to: before)
            throw error
        }
        settings = s
        audit.record(["method": "settings.logs", "decision": "allow", "before": before.json, "after": new.json,
                      "loosened": .array(loosened.map { .string($0) }), "verified": .bool(verified)])
    }

    /// The sink follows the setting: a changed folder moves the files, a changed retention prunes.
    private func applyLogSettings(from old: LogSettings, to new: LogSettings) throws {
        if let base = defaultLogDirectory, old.directory != new.directory {
            try audit.setDirectory(new.effectiveDirectory(default: base))
        }
        if old.retentionDays != new.retentionDays { audit.setRetention(days: new.retentionDays) }
    }

    // MARK: the chord allowlist

    /// Switches a built-in chord off: tightening, at once.
    public func settingsChordDisable(_ text: String) throws {
        let chord = try parseChord(text)
        guard ChordPolicy.allowedWithModifiers.contains(chord) else { throw Denial("not_found", "\(chord) is not a built-in chord") }
        var s = settings
        guard !s.chords.disabled.contains(chord.description) else { return }
        s.chords.disabled.append(chord.description)
        try settingsStore.save(s)
        settings = s
        audit.record(["method": "settings.chord_disable", "decision": "allow", "chord": .string(chord.description)])
    }

    /// Switches a built-in chord back on: loosening, verified. A chord that is not switched off is left as it is
    /// (nothing loosens, nothing to verify).
    public func settingsChordEnable(_ text: String, verified: Bool) throws {
        let chord = try parseChord(text)
        var s = settings
        let before = s.chords.disabled.count
        s.chords.disabled.removeAll { $0 == chord.description }
        guard s.chords.disabled.count < before else { return }
        guard verified else { throw Denial("verification_required", "switching \(chord) on again needs the user verified") }
        try settingsStore.save(s)
        settings = s
        audit.record(["method": "settings.chord_enable", "decision": "allow", "chord": .string(chord.description), "verified": true])
    }

    /// Adds a chord of the user's, for one app or every approved one: loosening, verified. Never-allowed and
    /// built-in chords are refused with the reason the page shows.
    public func settingsChordAdd(_ text: String, app: String?, note: String, verified: Bool) throws {
        let chord = try parseChord(text)
        if let r = ChordPolicy.addRefusal(for: chord) { throw Denial(r.reason, "\(chord): \(r.detail)") }
        let scope = app?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        if let scope, HardDeny.entry(for: scope) != nil || settings.denies(scope) != nil {
            throw Denial("app_not_grantable", "\(scope) can never be operated, so a chord for it is pointless")
        }
        guard verified else { throw Denial("verification_required", "adding \(chord) needs the user verified") }
        var s = settings
        s.chords.custom.removeAll { $0.chord == chord.description && $0.app?.lowercased() == scope?.lowercased() }
        s.chords.custom.append(CustomChord(chord: chord.description, app: scope, note: note, addedAt: now()))
        try settingsStore.save(s)
        settings = s
        audit.record(["method": "settings.chord_add", "decision": "allow", "chord": .string(chord.description),
                      "app": scope.map { .string($0) } ?? .null, "note_len": .number(Double(note.count)), "verified": true])
    }

    /// Removes a chord of the user's: tightening, at once.
    public func settingsChordRemove(_ text: String, app: String?) throws {
        let chord = try parseChord(text)
        let scope = app?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        var s = settings
        let before = s.chords.custom.count
        s.chords.custom.removeAll { $0.chord == chord.description && $0.app?.lowercased() == scope?.lowercased() }
        guard s.chords.custom.count < before else { throw Denial("not_found", "\(chord) is not one of the user's chords") }
        try settingsStore.save(s)
        settings = s
        audit.record(["method": "settings.chord_remove", "decision": "allow", "chord": .string(chord.description),
                      "app": scope.map { .string($0) } ?? .null])
    }

    private func parseChord(_ text: String) throws -> KeyChord {
        do { return try KeyChord.parse(text) } catch {
            throw Denial("invalid_chord", "cannot parse chord \"\(Self.clip(text))\": \(error)")
        }
    }

    /// Takes an app off the deny list. Loosening: refused unless `verified` (the person passed the owner check,
    /// Touch ID / password; until 2026-10-21 this setter trusted its only caller, the window, and never checked). An
    /// app that is not on the list is left as it is (nothing loosens).
    public func settingsDenylistRemove(bundleID: String, verified: Bool) throws {
        var s = settings
        let before = s.denylist.count
        s.denylist.removeAll { $0.bundleId.caseInsensitiveCompare(bundleID) == .orderedSame }
        guard s.denylist.count < before else { return }
        guard verified else { throw Denial("verification_required", "taking \(bundleID) off the deny list needs the user verified") }
        try settingsStore.save(s)
        settings = s
        audit.record(["method": "settings.denylist_remove", "decision": "allow", "app": .string(bundleID),
                      "verified": .bool(verified)])
    }
}

extension Grant {
    /// This grant without `bundleID` (deny list): per-app approvals of it go, both layers; a config grant loses the
    /// ID from its list. Nil when no app is left.
    func dropping(bundleID: String) -> Grant? {
        let key = bundleID.lowercased()
        if access[key] != nil || fallback[key] != nil {
            return removing { $0.bundleID.lowercased() == key }
        }
        let ids = self.bundleIDs.filter { $0.lowercased() != key }
        guard !ids.isEmpty else { return nil }
        return Grant(taskID: taskID, bundleIDs: ids, allowLaunch: allowLaunch, expiresAt: expiresAt, source: source,
                     electronAX: electronAX, imePolicy: imePolicy, actions: actions, clickLimit: clickLimit,
                     access: access, fallback: fallback, owner: owner)
    }
}

private extension String {
    /// Nil when empty (a blank scope field means "every approved app").
    var nonEmpty: String? { isEmpty ? nil : self }
}
