import Foundation

// MARK: - Approval dialogs (access.*)

/// What the approval flow needs: without a directory or a presenter every access request is refused.
public struct ApprovalDeps {
    let apps: AppDirectory?
    let presenter: ApprovalPresenter?
    let persistent: PersistentGrantStore
    let book = ApprovalBook()

    public init(apps: AppDirectory? = nil, presenter: ApprovalPresenter? = nil,
                persistent: PersistentGrantStore = MemoryPersistentGrants()) {
        self.apps = apps
        self.presenter = presenter
        self.persistent = persistent
    }
}

extension Dispatcher {
    var apps: AppDirectory? { approvals.apps }
    var presenter: ApprovalPresenter? { approvals.presenter }
    var persistent: PersistentGrantStore { approvals.persistent }
    var book: ApprovalBook { approvals.book }

    /// access.request: resolve the app, refuse without a dialog where policy already decides (hard-deny, refused
    /// earlier in this session, no person, too many dialogs this turn), grant without one where an approval already
    /// covers it (this task, or the persistent list with a matching signature), else show the dialog and answer
    /// `pending`. The client then polls access.status: a person's answer can take up to the dialog timeout, longer
    /// than any request may block the worker.
    func routeAccess(_ method: String, _ params: JSONValue?, _ f: inout [String: JSONValue]) throws -> JSONValue {
        switch method {
        case "access.request":
            let p = try JSONCoding.decodeParams(AccessRequestParams.self, params)
            f["task_id"] = .string(p.taskId)
            f["app_requested"] = .string(Self.clip(p.app))
            f["mode"] = .string(p.mode)
            // The plugin's probe for an approval that already covers the app (no dialog possible). Its refusal
            // (approval_unavailable) is not the user's or the policy's: marked so the audit does not read as one.
            if p.interactive != true { f["silent"] = true }
            guard let mode = AppMode(rawValue: p.mode) else { throw RPCFailure(.invalidParams, "mode must be read or full") }
            guard let imeAsked = ChangePolicy(rawValue: p.imePolicy ?? "leave") else {
                throw RPCFailure(.invalidParams, "ime_policy must be leave, ask or takeover")
            }
            // The behavior settings cap the input-source policy and may keep Electron AX off (batch 4).
            let ime = settings.behavior.imePolicy(requested: imeAsked)
            if ime != imeAsked { f["ime_policy_capped"] = .string(ime.rawValue) }
            let electronAX = (p.electronAx ?? false) && settings.behavior.electronAXAuto
            if p.electronAx == true, !electronAX { f["electron_ax_off"] = "settings" }
            settleAbandonedDialog()
            // A hard-denied bundle ID is refused even if it is not installed; no dialog either way.
            if HardDeny.entry(for: p.app) != nil || settings.denies(p.app) != nil {
                try GrantRules.checkGrantable(p.app, source: .approval, config: config, settings: settings)
            }
            let identity = try resolveIdentity(p.app)
            f["app"] = .string(identity.bundleID)
            if identity.bundleID.caseInsensitiveCompare(p.app) != .orderedSame { f["app_resolved_from_name"] = true }
            try GrantRules.checkGrantable(identity.bundleID, source: .approval, config: config, settings: settings)
            try checkNotHost(p.taskId, identity.bundleID)

            endIfOwnerGone(p.taskId)
            let t = now()
            if let g = grants.current(p.taskId, now: t) { try checkOwner(g) }
            if let g = grants.current(p.taskId, now: t), g.covers(identity.bundleID) {
                let existing = g.access[identity.bundleID.lowercased()]
                // A grants.set grant (no per-app entry) has no per-app limit: it covers both modes.
                if existing?.mode.covers(mode) ?? true {
                    f["via"] = "existing"
                    return granted(identity, existing?.mode, existing?.scope, via: "existing")
                }
            }
            // Anything new (the persistent list, a dialog) only for the client that marked this turn (M4, 2026-10-14):
            // a process outside dsh that reaches the socket cannot open dialogs under a task's name, or between turns.
            // Unmarked, the list is not consulted; a silent probe then gets approval_unavailable as before (the bench
            // never marks turns), a request for a dialog approval_no_turn (below).
            if turnMarked(p.taskId), let a = try persistentAccess(identity, mode, taskID: p.taskId,
                                                                  electronAX: electronAX, ime: ime, &f) {
                f["via"] = "persistent"
                return granted(identity, a.mode, a.scope, via: "persistent")
            }
            if book.refusedRecently(p.taskId, identity.bundleID, now: t) {
                throw Denial("approval_refused_earlier", "the user refused \(identity.bundleID) earlier in this turn; "
                             + "it is not asked again in this turn", data: ["app": .string(identity.bundleID)])
            }
            // The default mode (settings, batch 1): an app outside every list gets a session approval of that mode
            // without a dialog, for the client that marked this turn; a request above it goes to the dialog as usual.
            // Nothing the person refused this turn (above) and nothing on a list (checked before) comes this way.
            if turnMarked(p.taskId), settings.access.defaultMode.covers(mode) {
                let a = AppAccess(bundleID: identity.bundleID, mode: mode, scope: .session,
                                  expiresAt: now().addingTimeInterval(settings.access.sessionLimit))
                try give(a, taskID: p.taskId, electronAX: electronAX, ime: ime, owner: GrantOwner(conn))
                f["via"] = "default_mode"
                f["default_mode"] = .string(settings.access.defaultMode.rawValue)
                return granted(identity, a.mode, a.scope, via: "default_mode")
            }
            guard p.interactive == true, let presenter, let apps else {
                // Whether it runs: the plugin sends a model that wants to look at an app that is not running to
                // cu_launch (one full dialog) instead of a read dialog with nothing to see after it (2026-10-09, 2d).
                throw Denial("approval_unavailable", "nobody can approve \(identity.bundleID) here (no approval UI)",
                             data: ["app": .string(identity.bundleID),
                                    "app_running": .bool(env.runningBundleIDs().contains(identity.bundleID.lowercased()))])
            }
            try checkTurn(p.taskId)
            if let d = book.pending {
                if d.taskID == p.taskId, d.identity.bundleID == identity.bundleID, d.mode == mode {
                    f["decision"] = "defer"
                    f["request_id"] = .string(d.id)
                    return pending(d)
                }
                throw Denial("approval_busy", "another approval dialog is open; wait for it to be answered")
            }
            // Widening this task's read approval of the same app to full is not one of the turn's counted dialogs.
            let upgrade = grants.current(p.taskId, now: t)?.access[identity.bundleID.lowercased()]?.mode == .read && mode == .full
            let shown = book.dialogsThisTurn[p.taskId, default: 0]
            guard upgrade || shown < settings.access.dialogsPerTurn else {
                throw Denial("approval_limit", "\(shown) approval dialogs were shown this turn (at most "
                             + "\(settings.access.dialogsPerTurn)); ask the user in the conversation instead")
            }
            let offerAlways = apps.designatedRequirement(path: identity.path) != nil
            let d = PendingDialog(id: book.newID(), taskID: p.taskId, identity: identity, mode: mode,
                                  electronAX: electronAX, imePolicy: ime, startedAt: t, requester: conn)
            book.pending = d
            if !upgrade { book.dialogsThisTurn[p.taskId] = shown + 1 } else { f["upgrade"] = true }
            f["decision"] = "defer"
            f["request_id"] = .string(d.id)
            f["offer_always"] = .bool(offerAlways)
            f["reason_len"] = .number(Double(p.reason?.count ?? 0))
            let reason = p.reason.map { $0.count > 300 ? String($0.prefix(300)) + "…" : $0 }
            let running = env.runningBundleIDs().contains(identity.bundleID.lowercased())
            if !running { f["app_running"] = false }
            let lang = UILanguage.resolve(p.lang)
            f["lang"] = .string(lang.rawValue)
            let first = !book.approvedClients.contains { $0.matches(conn) }
            if first { f["first_from_requester"] = true }
            presenter.present(DialogRequest(identity: identity, mode: mode, reason: reason, offerAlways: offerAlways,
                                            timeout: settings.access.dialogTimeout, running: running, lang: lang,
                                            requester: Self.requesterLabel(conn), firstFromRequester: first,
                                            defaultAnswer: settings.access.dialogDefault.answer)) { [d] answer, focus, windows in
                d.answer(answer, focus: focus, windows: windows)
            }
            return pending(d)

        case "access.status":
            let p = try JSONCoding.decodeParams(AccessStatusParams.self, params)
            f["task_id"] = .string(p.taskId)
            f["request_id"] = .string(p.requestId)
            guard let d = book.pending, d.id == p.requestId, d.taskID == p.taskId else {
                throw Denial("unknown_request", "no open approval dialog \(Self.clip(p.requestId)) for this task")
            }
            // Only the client that asked polls (and so settles) its dialog; request IDs are sequential (dlg-N). The
            // app stays out of the refusal and its audit line. An answered dialog whose requester stopped polling is
            // settled by the next access.request (settleAbandonedDialog), still as the requester's.
            guard d.owner.matches(conn) else {
                throw Denial("grant_owner_mismatch", "approval dialog \(Self.clip(p.requestId)) belongs to the client "
                             + "that asked for it, not to this connection")
            }
            f["app"] = .string(d.identity.bundleID)
            if let answer = d.answer { return try settle(d, answer, &f) }
            // The presenter closes its own dialog at the timeout; this is the backstop if it never answered.
            if now().timeIntervalSince(d.startedAt) > settings.access.dialogTimeout + 10 { return try settle(d, .timeout, &f) }
            f["decision"] = "defer"
            return pending(d)

        case "access.turn_start":
            // The plugin's turn/start (restoreFocus): see Dispatcher+Focus.swift. Opens the turn for approvals, for
            // the client that owns the task's turns (claimTurns).
            let p = try JSONCoding.decodeParams(TurnStartParams.self, params)
            f["task_id"] = .string(p.taskId)
            if p.late == true { f["late"] = true }
            try claimTurns(p.taskId)
            book.turnOpen.insert(p.taskId)
            if settings.privacy.clearClipboardOnTurnStart { f["clipboard_cleared"] = .bool(env.pasteboardClear()) }
            return markTurnStart(p.taskId, late: p.late == true, &f)

        case "access.turn_end":
            // The plugin's turn/end. Turn approvals end; so does a grants.set (config) grant, as before. With
            // restore_focus, the focus goes back first (whatever became of the grant: it may have expired).
            let p = try JSONCoding.decodeParams(TurnEndParams.self, params)
            f["task_id"] = .string(p.taskId)
            if let o = book.turnOwner[p.taskId], !o.matches(conn), !ownerGone(o) {
                throw Denial("turn_owner_mismatch", "task \(p.taskId)'s turns are marked by the client that started "
                             + "them, not by this connection")
            }
            book.turnOpen.remove(p.taskId)
            book.dialogsThisTurn.removeValue(forKey: p.taskId)
            book.refused.removeValue(forKey: p.taskId)  // the next message may ask again (AccessRules.refusalMemory)
            if p.restoreFocus == true, !settings.behavior.restoreFocusOnTurnEnd {
                f["focus_restore_off"] = "settings"
            } else if p.restoreFocus == true {
                _ = restoreTurnFocus(p.taskId, &f)
            } else {
                book.turnFront.removeValue(forKey: p.taskId)
                book.turnTargets.removeValue(forKey: p.taskId)
            }
            guard let g = grants.current(p.taskId, now: now()) else { return ["dropped": []] }
            if g.source == .config {
                grants.revoke(p.taskId)
                return ["dropped": .array(g.bundleIDs.map { .string($0) }), "revoked": true]
            }
            // An app whose turn approval sat over a longer one (a turn's full over a session's read) stays, narrower.
            let after = g.removing { $0.scope == .turn }
            let dropped = g.bundleIDs.filter { !(after?.covers($0) ?? false) }.sorted()
            grants.update(p.taskId, after)
            f["dropped"] = .array(dropped.map { .string($0) })
            return ["dropped": .array(dropped.map { .string($0) })]

        default:
            throw RPCFailure(.methodNotFound, "unknown method \(method)")
        }
    }

    /// A bundle ID (installed or running) or else a name: exactly one app, or a refusal. Never the model's string.
    private func resolveIdentity(_ app: String) throws -> AppIdentity {
        guard let apps else { throw Denial("approval_unavailable", "this daemon cannot show approval dialogs") }
        if let id = apps.identity(bundleID: app) { return id }
        var seen = Set<String>()
        let found = apps.identities(named: app).filter { seen.insert($0.bundleID.lowercased()).inserted }
        guard let only = found.first else {
            // Near names as suggestions only (2026-10-23: the model asked for "Millionaire Tycoon", installed as
            // "Millionaire"); never one the model could not get anyway (hard-denied, on the deny list).
            let near = apps.similarIdentities(to: app, limit: 5)
                .filter { HardDeny.entry(for: $0.bundleID) == nil && settings.denies($0.bundleID) == nil }
            guard !near.isEmpty else {
                throw Denial("app_not_found", "no app with bundle ID or name \"\(Self.clip(app))\" is running or installed")
            }
            throw Denial("app_not_found", "no app with bundle ID or name \"\(Self.clip(app))\" is running or installed. "
                         + "Installed apps with a similar name: \(near.map { "\($0.name) (\($0.bundleID))" }.joined(separator: ", ")). "
                         + "If one of them is the app the user meant, ask again with its bundle ID; if unsure, ask the user",
                         data: ["candidates": .array(near.map { .string($0.bundleID) })])
        }
        guard found.count == 1 else {
            throw Denial("app_name_ambiguous", "\"\(Self.clip(app))\" is the name of \(found.count) apps "
                         + "(\(found.map(\.bundleID).joined(separator: ", "))): use the bundle id",
                         data: ["candidates": .array(found.map { .string($0.bundleID) })])
        }
        return only
    }

    /// The persistent list's entry for the app, if it covers the mode and the app still satisfies the signature it
    /// was pinned to: then the task gets it (scope always). A signature that changed voids the entry (audited).
    private func persistentAccess(_ identity: AppIdentity, _ mode: AppMode, taskID: String, electronAX: Bool,
                                  ime: ChangePolicy, _ f: inout [String: JSONValue]) throws -> AppAccess? {
        guard let apps else { return nil }
        let list: [PersistentGrant]
        do { list = try persistent.load() } catch {
            f["persistent_error"] = .string(String(describing: error))
            return nil
        }
        guard let e = list.first(where: { $0.bundleId.caseInsensitiveCompare(identity.bundleID) == .orderedSame }),
              let m = e.appMode, m.covers(mode) else { return nil }
        guard apps.satisfies(path: identity.path, requirement: e.requirement) else {
            _ = try? PersistentGrants.revoke(bundleID: e.bundleId, store: persistent)
            var rec = conn.auditFields
            rec["method"] = "access.persistent_invalidated"
            rec["decision"] = "revoke"
            rec["app"] = .string(e.bundleId)
            rec["mode"] = .string(e.mode)
            rec["path"] = .string(identity.path)
            rec["detail"] = "the app no longer satisfies the signature it was added with"
            audit.record(rec)
            f["persistent_invalidated"] = true
            return nil
        }
        let a = AppAccess(bundleID: identity.bundleID, mode: m, scope: .always,
                          expiresAt: now().addingTimeInterval(settings.access.sessionLimit))
        try give(a, taskID: taskID, electronAX: electronAX, ime: ime, owner: GrantOwner(conn))
        return a
    }

    /// Applies a person's answer (or the timeout). One audit line per decision, besides the request's own: under the
    /// requester (its connection and peer), whichever call settles it; another connection that did is `settled_by`.
    private func settle(_ d: PendingDialog, _ answer: DialogAnswer, _ f: inout [String: JSONValue]) throws -> JSONValue {
        book.pending = nil
        var rec = d.requester.auditFields
        if conn.id != d.requester.id || !d.owner.matches(conn) { rec["settled_by"] = .object(conn.auditFields) }
        rec["method"] = "access.decision"
        rec["task_id"] = .string(d.taskID)
        rec["request_id"] = .string(d.id)
        rec["app"] = .string(d.identity.bundleID)
        rec["path"] = .string(d.identity.path)
        rec["mode"] = .string(d.mode.rawValue)
        rec["answer"] = .string(answer.rawValue)
        if let focus = d.focus { rec["focus"] = .string(focus.rawValue) }
        if let windows = d.windows { rec["settings_window"] = .string(windows.rawValue) }
        rec["wait_ms"] = .number((now().timeIntervalSince(d.startedAt) * 1000).rounded())
        defer { audit.record(rec) }
        f["answer"] = .string(answer.rawValue)
        var scope: AccessScope
        switch answer {
        case .deny:
            rec["decision"] = "deny"
            book.refused[d.taskID, default: [:]][d.identity.bundleID.lowercased()] = now()
            throw Denial("approval_rejected", "the user refused \(d.identity.bundleID)")
        case .timeout:
            rec["decision"] = "deny"
            throw Denial("approval_timeout", "nobody answered the approval dialog for \(d.identity.bundleID) within "
                         + "\(Int(settings.access.dialogTimeout)) s")
        case .turn: scope = .turn
        case .session: scope = .session
        case .always:
            scope = .always
            // The presenter verified the device owner for a full "always" (MacApprovalPresenter); here the entry is
            // pinned to the signature like one added by the command.
            if apps == nil { scope = .session } else {
                do {
                    let e = try PersistentGrants.add(d.identity, mode: d.mode, via: "dialog", store: persistent,
                                                     apps: apps!, now: now(), settings: settings)
                    rec["persistent"] = e.json
                } catch {
                    rec["persistent_error"] = .string(String(describing: error))
                    scope = .session
                }
            }
        }
        rec["scope"] = .string(scope.rawValue)
        let a = AppAccess(bundleID: d.identity.bundleID, mode: d.mode, scope: scope,
                          expiresAt: now().addingTimeInterval(settings.access.sessionLimit))
        do {
            try give(a, taskID: d.taskID, electronAX: d.electronAX, ime: d.imePolicy, owner: d.owner)
        } catch let e as Denial {
            rec["decision"] = "deny"
            rec["reason"] = .string(e.reason)
            throw e
        }
        rec["decision"] = "allow"
        if !book.approvedClients.contains(d.owner) { book.approvedClients.append(d.owner) }
        return granted(d.identity, a.mode, a.scope, via: "dialog")
    }

    /// An answered dialog whose client stopped polling still takes effect (and is audited) before the next one.
    private func settleAbandonedDialog() {
        guard let d = book.pending else { return }
        let late = now().timeIntervalSince(d.startedAt) > settings.access.dialogTimeout + 10
        guard let answer = d.answer ?? (late ? .timeout : nil) else { return }
        var ignored: [String: JSONValue] = [:]
        _ = try? settle(d, answer, &ignored)
    }

    /// Adds an approval to the task's grant for `owner`, the client it was given to. It joins the task's grant only if
    /// that is `owner`'s or a config grant (which then becomes `owner`'s); another client's grant is refused (one whose
    /// client has exited ends first, endIfOwnerGone). Never merged into a grant someone else can use.
    private func give(_ a: AppAccess, taskID: String, electronAX: Bool, ime: ChangePolicy, owner: GrantOwner) throws {
        endIfOwnerGone(taskID)
        let base = grants.current(taskID, now: now())
        if let o = base?.owner, o != owner {
            throw Denial("grant_owner_mismatch", "task \(taskID)'s approvals belong to another client; an approval is "
                         + "not merged into them")
        }
        let g = base ?? Grant(taskID: taskID, bundleIDs: [], allowLaunch: false, expiresAt: a.expiresAt, source: .approval,
                              electronAX: electronAX, imePolicy: ime, owner: owner)
        grants.update(taskID, g.adding(a, owner: owner))
    }

    /// The task's active grant, for this connection only: every use of a grant goes through here (owner check).
    func activeGrant(_ taskID: String) throws -> Grant {
        endIfOwnerGone(taskID)
        let g = try grants.active(taskID, now: now())
        try checkOwner(g)
        return g
    }

    /// A person's approvals belong to the client that asked for them (GrantOwner); config grants have no owner.
    func checkOwner(_ g: Grant) throws {
        guard let o = g.owner, !o.matches(conn) else { return }
        throw Denial("grant_owner_mismatch", "task \(g.taskID)'s approvals belong to the client that asked for them, not to this connection")
    }

    /// The owner's process has exited, or its PID now runs another program or another process (R6). Unknown is gone.
    func ownerGone(_ o: GrantOwner) -> Bool {
        guard let pid = o.pid else { return true }
        return o.isSucceeded(by: conn) || env.processPath(pid: pid) != o.path
    }

    /// access.turn_start: a task's turns are marked by one client, the first that marks them (the plugin in the dsh
    /// process the conversation runs in). Another one is refused while that client runs, and also while another
    /// client owns the task's approvals; once it has exited (dsh restarted), the next one takes over.
    func claimTurns(_ taskID: String) throws {
        endIfOwnerGone(taskID)
        let others = [book.turnOwner[taskID], grants.stored(taskID)?.owner].compactMap { $0 }
        if others.contains(where: { !$0.matches(conn) && !ownerGone($0) }) {
            throw Denial("turn_owner_mismatch", "task \(taskID)'s turns are marked by the client that started them, "
                         + "not by this connection")
        }
        book.turnOwner[taskID] = GrantOwner(conn)
    }

    /// The refusal for a task another running client holds, if one does: the owner of its approvals
    /// (grant_owner_mismatch) or of its turns (turn_owner_mismatch). A config grant has no owner, and a client that
    /// has exited holds nothing. `grant`: the task's grant when the caller has it already.
    func heldElsewhere(_ taskID: String, grant: Grant? = nil) -> String? {
        if let o = (grant ?? grants.current(taskID, now: now()))?.owner, !o.matches(conn), !ownerGone(o) {
            return "grant_owner_mismatch"
        }
        if let o = book.turnOwner[taskID], !o.matches(conn), !ownerGone(o) { return "turn_owner_mismatch" }
        return nil
    }

    /// grants.list: the tasks no other running client holds; another client's task IDs and apps are not this one's
    /// to read.
    func listGrants(_ f: inout [String: JSONValue]) -> JSONValue {
        let all = grants.all(now: now())
        let listed = all.filter { heldElsewhere($0.taskID, grant: $0) == nil }
        if listed.count < all.count { f["withheld"] = .number(Double(all.count - listed.count)) }
        return .array(listed.map(\.json))
    }

    /// grants.revoke: only the client that holds the task, or anyone when no running client does.
    func checkHoldsTask(_ taskID: String) throws {
        endIfOwnerGone(taskID)
        switch heldElsewhere(taskID) {
        case "grant_owner_mismatch"?:
            throw Denial("grant_owner_mismatch", "task \(taskID)'s approvals belong to the client that asked for them, "
                         + "not to this connection")
        case "turn_owner_mismatch"?:
            throw Denial("turn_owner_mismatch", "task \(taskID)'s turns are marked by the client that started them, "
                         + "not by this connection")
        default: return
        }
    }

    /// access.request may grant something new (the persistent list, a dialog) only during a turn this connection
    /// marked: access.turn_start since the last access.turn_end, by the task's turn owner.
    func turnMarked(_ taskID: String) -> Bool {
        guard book.turnOpen.contains(taskID), let o = book.turnOwner[taskID] else { return false }
        return o.matches(conn)
    }

    func checkTurn(_ taskID: String) throws {
        guard turnMarked(taskID) else {
            throw Denial("approval_no_turn", "approvals are given only during a turn that the asking client marked "
                         + "(access.turn_start); this connection has not marked the current turn of task \(taskID)")
        }
    }

    /// What the dialog says about who asks: the executable's name and the PID, from the audit token.
    static func requesterLabel(_ c: ConnectionInfo) -> String? {
        guard let pid = c.peerPID else { return nil }
        let name = c.peerPath.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "?"
        return "\(name) (PID \(pid))"
    }

    /// Approvals whose owner has exited (or whose PID now runs another program, or is this very connection's, R6) end:
    /// nobody could use them, and the task's next client (dsh restarted, same conversation) is asked again like a new
    /// one, not refused. The dead client's unfinished turn ends with it (its dialog count). Another client while the
    /// owner runs: checkOwner.
    private func endIfOwnerGone(_ taskID: String) {
        guard let g = grants.stored(taskID), let o = g.owner, let pid = o.pid, !o.matches(conn),
              o.isSucceeded(by: conn) || env.processPath(pid: pid) != o.path else { return }
        grants.revoke(taskID)
        book.dialogsThisTurn.removeValue(forKey: taskID)
        var rec = conn.auditFields
        rec["method"] = "access.owner_gone"
        rec["decision"] = "revoke"
        rec["task_id"] = .string(taskID)
        rec["owner_pid"] = .number(Double(pid))
        rec["apps"] = .array(g.bundleIDs.map { .string($0) })
        audit.record(rec)
    }

    private func granted(_ identity: AppIdentity, _ mode: AppMode?, _ scope: AccessScope?, via: String) -> JSONValue {
        ["status": "granted", "app": identity.json, "mode": mode.map { .string($0.rawValue) } ?? "unrestricted",
         "scope": scope.map { .string($0.rawValue) } ?? "grant", "via": .string(via)]
    }

    private func pending(_ d: PendingDialog) -> JSONValue {
        ["status": "pending", "request_id": .string(d.id), "app": d.identity.json, "mode": .string(d.mode.rawValue),
         "timeout_s": .number(settings.access.dialogTimeout)]
    }
}
