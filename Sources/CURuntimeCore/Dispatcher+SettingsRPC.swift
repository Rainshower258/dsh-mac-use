import Foundation

// MARK: - The settings over the socket (stage 3a, contract C-B2, 2026-10-21)

/// A panel's answer (SettingsPanels): nil or false is a panel the person closed, or one that failed.
enum SettingsPanelAnswer: Sendable {
    case directory(URL?)
    case app(String?)
    case saved(Bool)
    case opened(Data?)
}

/// The settings methods' state for one dispatcher. `finish` and `onFinish` are the only parts used off the worker
/// queue: owner check verdicts and panel answers arrive on any thread and wait under the lock until the worker settles
/// them (Dispatcher.settleSettingsRPC): at once with a server around the dispatcher (its `onFinish` schedules that),
/// and in any case at the start of the next settings.* request. Everything else is the worker queue's, like the
/// Dispatcher's own state.
final class SettingsRPCState: @unchecked Sendable {
    /// The one loosening change waiting for the owner check, what the page shows of it (`summary`), who asked (the
    /// requesting connection's audit fields, for the line that settles it), and the settings and the always list
    /// live when it became pending (`settings`, `always`: nil when the list could not be read): an ok verdict is
    /// applied only while both are still exactly what is live.
    struct Pending {
        let id: UInt64
        let change: SettingsChange
        let summary: JSONValue
        let requester: [String: JSONValue]
        let settings: UserSettings
        let always: [PersistentGrant]?
    }

    /// The one panel open on the Mac for the page (an action), with what an export writes.
    struct Panel {
        let id: UInt64
        let name: String
        let bytes: Int?
    }

    enum Finished: Sendable {
        case verdict(UInt64, OwnerVerdict)
        case panel(UInt64, SettingsPanelAnswer)
    }

    var pending: Pending?
    var panel: Panel?
    /// `{at, kind, outcome, reason?}` of the last change settled after the owner check or a panel.
    var lastOutcome: JSONValue?
    /// The bundle ID the person picked in the app panel (choose_app), until the next pick.
    var pickedApp: String?
    /// The settings file the person picked (import), decoded and validated (with its own `logs.directory`, before
    /// the folder in force is put in), and the preview JSON last shown of it, until import_confirm takes it or the
    /// next import replaces it. Every snapshot and every confirm recompute the preview on the live settings
    /// (Dispatcher.settingsImportPlan).
    var importPreview: (file: UserSettings, json: JSONValue)?
    private var lastID: UInt64 = 0

    private let lock = NSLock()
    private var finished: [Finished] = []
    private var _onFinish: (@Sendable () -> Void)?

    /// Called after every `finish` has appended, on finish's thread, with the lock released. Server.init sets it to
    /// schedule Dispatcher.settleSettingsRPC on the worker queue (asynchronously: `finish` may run on the worker
    /// itself, or on the main thread while the worker waits on main). Nil (a dispatcher without a server): what
    /// finished waits for the next settings.* request.
    var onFinish: (@Sendable () -> Void)? {
        get { lock.lock(); defer { lock.unlock() }; return _onFinish }
        set { lock.lock(); _onFinish = newValue; lock.unlock() }
    }

    func newID() -> UInt64 {
        lastID += 1
        return lastID
    }

    /// From any thread: a verdict or a panel's answer, for the worker to settle; then `onFinish`.
    func finish(_ item: Finished) {
        lock.lock()
        finished.append(item)
        let hook = _onFinish
        lock.unlock()
        hook?()
    }

    /// Everything finished since the last call, in arrival order.
    func takeFinished() -> [Finished] {
        lock.lock()
        defer { lock.unlock() }
        let all = finished
        finished = []
        return all
    }
}

/// One state per dispatcher, beside it rather than in it (the Dispatcher's body is at swiftlint's type_body_length
/// cap); the key is weak, so the state goes with its dispatcher.
private let settingsRPCStates = NSMapTable<Dispatcher, SettingsRPCState>.weakToStrongObjects()
private let settingsRPCStatesLock = NSLock()

/// The socket's settings methods, on the worker queue only (Dispatcher.route, the `settings` namespace, which skips
/// app-name resolution like `grants`). The only settings path over the socket: one closed change at a time
/// (SettingsChange), never a file path, never a caller's word that the person is verified.
///
/// - `settings.snapshot` (no params): settingsSnapshotJSON plus `permissions` (the panels'; null without panels),
///   `pending` (the summary of the change waiting for the owner check, or null), `last_outcome`, `picked_app`
///   (`{bundle_id, name}` or null), `import_preview` (`{changes, loosened, log_directory_ignored}` or null) and `panel`
///   (the action whose panel is open, or null). `recent_changes` leaves out `settings.apply` lines: the setter's own
///   line beside each records the change, and a refused one is among `recent_refusals`.
/// - `settings.apply {change}` (no other key): decoded strictly (SettingsChange.decode). A change that does not
///   loosen the live settings is applied at once (`{status: applied}`). One that loosens is refused `approval_open`
///   while an approval dialog is up, `verify_busy` while another change waits, `verify_unavailable` without an
///   owner check, and otherwise as OwnerCheck.begin refuses it (`verify_busy`, `verify_cooldown` with `until`,
///   `verify_unavailable`, `approval_open`); else it becomes the one pending change (`{status: pending, summary}`;
///   the same change asked again while it waits answers the same). The owner check shows settingsVerifyReason,
///   the daemon's text, never the client's.
/// - The verdict is settled on the worker as soon as it arrives (with a server: SettingsRPCState.onFinish), and in any
///   case at the start of the next settings.* request (every one settles first). ok applies the change only while the
///   settings and the always list are exactly what was live when it became pending (`verified:
///   settingsLoosens(change)`); if either changed meanwhile, whatever changed it, nothing is applied (outcome refused,
///   reason `settings_changed`). Any other verdict changes nothing. `last_outcome.outcome` is applied, verify_failed,
///   verify_cancelled, verify_unavailable, cancelled (by settings.cancel_verify) or refused (with the setter's
///   `reason`).
/// - `settings.cancel_verify` (no params): ends the pending change's check (`nothing_pending` when none).
/// - `settings.action {name}` (no other key), each without a path in or out: `use_default_log_directory` (applied at
///   once, needs no panel), `reveal_log` (the Finder shows the log folder), `choose_log_directory`, `choose_app`,
///   `export_settings`, `export_audit` (the last 7 days, written where the person saves it, never sent over the
///   socket), `import` (an open panel; the file is decoded and validated as the window does into `import_preview`,
///   which every snapshot recomputes on the live settings, keeping the log folder in force), `import_confirm`
///   (recomputes the preview: if it differs from the one last shown, the fresh one is kept and the confirm is refused
///   `settings_changed` with nothing applied, so the next snapshot shows what confirming now does; else the file with
///   the folder in force is applied as a settings.apply would; `nothing_pending` without one). Without panels
///   (headless) every action but the first is `settings_unavailable`. A panel action answers `{status: open}` and its
///   result is settled like a verdict, as soon as it arrives (`last_outcome` with the action's name as `kind`,
///   outcome done, cancelled or refused; an export's `settings.export` / `settings.audit_export` line); while one
///   panel is open another answers `{status: busy, panel}` without opening one. A panel that never answers keeps the
///   others closed until restart.
///
/// Audit: the request's own line (Dispatcher.handle) carries `kind`, `app`, `name` and `status` (`pending` for a change
/// left waiting, which AuditReader.recentSettingsChanges skips); each settled verdict writes a `settings.apply` line
/// with `stage` settled and `outcome` (decision deny with `reason` unless applied), each settled panel a
/// `settings.action` line (never `changed`: the setters and the exports write their own lines).
extension Dispatcher {
    static let settingsActions: Set<String> = [
        "choose_log_directory", "use_default_log_directory", "choose_app", "export_settings", "export_audit", "import",
        "import_confirm", "reveal_log",
    ]

    var settingsRPC: SettingsRPCState {
        settingsRPCStatesLock.lock()
        defer { settingsRPCStatesLock.unlock() }
        if let s = settingsRPCStates.object(forKey: self) { return s }
        let s = SettingsRPCState()
        settingsRPCStates.setObject(s, forKey: self)
        return s
    }

    /// App names for the page and the owner check's text: the panels' lookup, none without panels.
    var settingsAppNames: (String) -> String? { { [weak p = settingsPanels] id in p?.appName(id) } }

    func routeSettings(_ method: String, _ params: JSONValue?, _ f: inout [String: JSONValue]) throws -> JSONValue {
        settleSettingsRPC()
        switch method {
        case "settings.snapshot":
            _ = try settingsParams(params, method, keys: [])
            return settingsRPCSnapshot()
        case "settings.apply":
            let o = try settingsParams(params, method, keys: ["change"])
            return try settingsRequest(try SettingsChange.decode(o["change"]), &f)
        case "settings.cancel_verify":
            _ = try settingsParams(params, method, keys: [])
            return try settingsCancelVerify(&f)
        case "settings.action":
            let o = try settingsParams(params, method, keys: ["name"])
            guard case .string(let name)? = o["name"], Self.settingsActions.contains(name) else {
                throw RPCFailure(.invalidParams, "settings.action: name must be one of \(Self.settingsActions.sorted())")
            }
            f["name"] = .string(name)
            return try settingsAction(name, &f)
        default: throw RPCFailure(.methodNotFound, "unknown method \(method)")
        }
    }

    /// The params object with exactly `keys` (none: absent or empty); anything else, `verified` included, is refused.
    private func settingsParams(_ params: JSONValue?, _ method: String, keys: Set<String>) throws -> [String: JSONValue] {
        let o: [String: JSONValue]
        switch params {
        case nil, .null?: o = [:]
        case .object(let v)?: o = v
        default: throw RPCFailure(.invalidParams, "\(method): params must be an object")
        }
        let extra = Set(o.keys).subtracting(keys), missing = keys.subtracting(o.keys)
        guard extra.isEmpty else { throw RPCFailure(.invalidParams, "\(method) takes no \(extra.sorted().prefix(5).map(Self.clip).joined(separator: ", "))") }
        guard missing.isEmpty else { throw RPCFailure(.invalidParams, "\(method) needs \(missing.sorted().joined(separator: ", "))") }
        return o
    }

    // MARK: snapshot

    func settingsRPCSnapshot() -> JSONValue {
        let st = settingsRPC
        let names = settingsAppNames
        var o = settingsSnapshotJSON(names: names).objectValue
        if case .array(let changes)? = o["recent_changes"] {
            o["recent_changes"] = .array(changes.filter { $0["method"] != "settings.apply" })
        }
        o["permissions"] = settingsPanels.map { p -> JSONValue in
            let x = p.permissions()
            return ["accessibility": .bool(x.accessibility), "screen_recording": .bool(x.screenRecording),
                    "input_monitoring": x.inputMonitoring.map { .bool($0) } ?? .null]
        } ?? .null
        o["pending"] = st.pending?.summary ?? .null
        o["last_outcome"] = st.lastOutcome ?? .null
        o["picked_app"] = st.pickedApp.map { ["bundle_id": .string($0), "name": names($0).map { .string($0) } ?? .null] } ?? .null
        // Recomputed on the live settings; a recompute that throws keeps the preview last shown.
        if let p = st.importPreview, let fresh = try? settingsImportPlan(p.file) { st.importPreview = (p.file, fresh.json) }
        o["import_preview"] = st.importPreview?.json ?? .null
        o["panel"] = st.panel.map { .string($0.name) } ?? .null
        return .object(o)
    }

    // MARK: apply, cancel

    /// A change from the page (settings.apply, import_confirm): applied at once unless it loosens, else waiting for
    /// the owner check (see the extension's comment).
    private func settingsRequest(_ c: SettingsChange, _ f: inout [String: JSONValue]) throws -> JSONValue {
        f["kind"] = .string(c.kind)
        if let app = Self.settingsApp(c) { f["app"] = .string(app) }
        let st = settingsRPC
        guard settingsLoosens(c) else {
            try settingsApply(c, verified: false)
            f["status"] = "applied"
            return ["status": "applied"]
        }
        if let p = st.pending {
            guard p.change == c else {
                throw Denial("verify_busy", "another settings change waits for the owner check; finish or cancel it first")
            }
            f["status"] = "pending"
            return ["status": "pending", "summary": p.summary]
        }
        if approvalDialogOpen { throw Denial("approval_open", "an approval dialog is open; answer it first") }
        guard let ownerCheck else { throw Denial("verify_unavailable", "this daemon has no owner check (no person at the Mac)") }
        let id = st.newID()
        let summary = settingsChangeSummary(c)
        st.pending = SettingsRPCState.Pending(id: id, change: c, summary: summary, requester: conn.auditFields,
                                              settings: settings, always: try? approvals.persistent.load())
        // The verdict may arrive before begin returns (a verifier that answers at once): the slot takes it either way.
        let reason = settingsVerifyReason(c, names: settingsAppNames)
        let start = ownerCheck.begin(reason: reason, purpose: "settings.apply \(c.kind)") { [st] in st.finish(.verdict(id, $0)) }
        guard start == .started else {
            st.pending = nil
            switch start {
            case .busy: throw Denial("verify_busy", "another owner check is open; try again when it is answered")
            case .cooldown(let until):
                throw Denial("verify_cooldown", "an owner check was refused or cancelled a moment ago; try again later",
                             data: ["until": .number(until.timeIntervalSince1970)])
            case .approvalOpen: throw Denial("approval_open", "an approval dialog is open; answer it first")
            case .unavailable, .started: throw Denial("verify_unavailable", "the owner check cannot be shown here")
            }
        }
        f["status"] = "pending"
        return ["status": "pending", "summary": summary]
    }

    private func settingsCancelVerify(_ f: inout [String: JSONValue]) throws -> JSONValue {
        let st = settingsRPC
        guard let p = st.pending else { throw Denial("nothing_pending", "no settings change waits for the owner check") }
        st.pending = nil   // first: the cancelled verdict the check reports now finds nothing to settle
        f["kind"] = .string(p.change.kind)
        f["status"] = "cancelled"
        settingsSettled(p, outcome: "cancelled")
        ownerCheck?.cancel()
        return ["status": "cancelled", "summary": p.summary]
    }

    /// An approval dialog is up and not answered (Dispatcher+Access: the pending dialog, past its timeout's backstop
    /// no longer).
    private var approvalDialogOpen: Bool {
        guard let d = book.pending, d.answer == nil else { return false }
        return now().timeIntervalSince(d.startedAt) <= settings.access.dialogTimeout + 10
    }

    // MARK: settling what finished off the worker

    /// Settles every verdict and panel answer that arrived since the last call, in order, on the worker (scheduled by
    /// SettingsRPCState.onFinish, and at the start of every settings.* request). A verdict for a change no longer
    /// pending (cancelled meanwhile) and an answer for a panel no longer open are dropped.
    func settleSettingsRPC() {
        let st = settingsRPC
        for item in st.takeFinished() {
            switch item {
            case .verdict(let id, let verdict):
                guard let p = st.pending, p.id == id else { continue }
                st.pending = nil
                settleVerdict(p, verdict)
            case .panel(let id, let answer):
                guard let open = st.panel, open.id == id else { continue }
                st.panel = nil
                settlePanel(open, answer)
            }
        }
    }

    private func settleVerdict(_ p: SettingsRPCState.Pending, _ verdict: OwnerVerdict) {
        guard verdict == .ok else { return settingsSettled(p, outcome: "verify_\(verdict.rawValue)") }
        // The person approved this change on these settings: one made meanwhile (a later tightening in the window, an
        // import, an always-list entry voided by a re-signed app) refuses it rather than being undone by it.
        guard settings == p.settings, (try? approvals.persistent.load()) == p.always else {
            return settingsSettled(p, outcome: "refused", reason: "settings_changed")
        }
        let loosens = settingsLoosens(p.change)
        do {
            try settingsApply(p.change, verified: loosens)
            settingsSettled(p, outcome: "applied", verified: loosens)
        } catch {
            settingsSettled(p, outcome: "refused", reason: Self.settingsReason(error))
        }
    }

    /// Records a pending change's end: `last_outcome` and one audit line, with the requester's connection fields.
    private func settingsSettled(_ p: SettingsRPCState.Pending, outcome: String, reason: String? = nil, verified: Bool? = nil) {
        var line = p.requester
        line["method"] = "settings.apply"
        line["stage"] = "settled"
        line["kind"] = .string(p.change.kind)
        if let app = Self.settingsApp(p.change) { line["app"] = .string(app) }
        line["outcome"] = .string(outcome)
        line["decision"] = outcome == "applied" ? "allow" : "deny"
        if outcome.hasPrefix("verify_") || reason != nil { line["reason"] = .string(reason ?? outcome) }
        if let verified { line["verified"] = .bool(verified) }
        audit.record(line)
        settingsRPC.lastOutcome = settingsOutcome(p.change.kind, outcome, reason: line["reason"]?.stringValue)
    }

    private func settingsOutcome(_ kind: String, _ outcome: String, reason: String?) -> JSONValue {
        var o: [String: JSONValue] = ["at": .number(now().timeIntervalSince1970), "kind": .string(kind), "outcome": .string(outcome)]
        if let reason { o["reason"] = .string(reason) }
        return .object(o)
    }

    /// A refusal's machine reason, never its text (it may name a path).
    static func settingsReason(_ error: Error) -> String {
        switch error {
        case let d as Denial: return d.reason
        case let f as RPCFailure: return f.code == .invalidParams ? "invalid_params" : "error"
        case is DecodingError: return "invalid_file"
        default: return "error"
        }
    }

    /// The bundle ID a change is about, for the audit's `app`.
    static func settingsApp(_ c: SettingsChange) -> String? {
        switch c {
        case .persistentRemove(let id), .persistentAdd(let id, _), .persistentMode(let id, _), .persistentReapprove(let id),
             .denyAdd(let id, _), .denyRemove(let id), .textOnlyAdd(let id), .textOnlyRemove(let id):
            return id
        case .chordAdd(_, let app, _), .chordRemove(_, let app): return app
        default: return nil
        }
    }

    // MARK: actions and panels

    private func settingsAction(_ name: String, _ f: inout [String: JSONValue]) throws -> JSONValue {
        let st = settingsRPC
        if name == "use_default_log_directory" {
            try settingsApply(.useDefaultLogDirectory, verified: false)
            f["status"] = "applied"
            return ["status": "applied"]
        }
        guard let panels = settingsPanels else {
            throw Denial("settings_unavailable", "no panels here (headless): the settings that need the Mac's panels are not available")
        }
        switch name {
        case "reveal_log":
            guard let dir = effectiveLogDirectory else { throw Denial("settings_unavailable", "this daemon has no log folder") }
            panels.reveal(dir)
            f["status"] = "done"
            return ["status": "done"]
        case "import_confirm":
            guard let preview = st.importPreview else { throw Denial("nothing_pending", "no imported file to confirm: import one first") }
            let plan = try settingsImportPlan(preview.file)
            guard plan.json == preview.json else {
                st.importPreview = (preview.file, plan.json)   // the next snapshot shows what confirming now does
                throw Denial("settings_changed", "the settings changed since the import preview was shown; check it and confirm again")
            }
            let out = try settingsRequest(.importSettings(plan.settings), &f)
            st.importPreview = nil   // applied, or waiting for the owner check; kept when refused, to try again
            return out
        default: break
        }
        if let open = st.panel {
            f["status"] = "busy"
            return ["status": "busy", "panel": .string(open.name)]
        }
        let id = st.newID()
        let done: @Sendable (SettingsPanelAnswer) -> Void = { [st] answer in st.finish(.panel(id, answer)) }
        switch name {
        case "choose_log_directory":
            st.panel = .init(id: id, name: name, bytes: nil)
            panels.chooseDirectory { done(.directory($0)) }
        case "choose_app":
            st.panel = .init(id: id, name: name, bytes: nil)
            panels.chooseApp { done(.app($0)) }
        case "export_settings":
            let data = try settings.encoded()
            st.panel = .init(id: id, name: name, bytes: data.count)
            panels.saveFile(suggestedName: "cu-runtime-settings.json", contents: data) { done(.saved($0)) }
        case "export_audit":
            let data = settingsAuditWeek()
            st.panel = .init(id: id, name: name, bytes: data.count)
            panels.saveFile(suggestedName: "cu-runtime-audit-7d.jsonl", contents: data) { done(.saved($0)) }
        default:   // import
            st.panel = .init(id: id, name: name, bytes: nil)
            panels.openFile(allowedExtensions: ["json"]) { done(.opened($0)) }
        }
        f["status"] = "open"
        return ["status": "open"]
    }

    /// The last 7 days' audit files, oldest first, as the window exports them (the retention's shortest choice).
    private func settingsAuditWeek() -> Data {
        guard let dir = effectiveLogDirectory else { return Data() }
        var data = Data()
        for day in AuditDays.last(7, now: now()).reversed() {
            if let d = try? Data(contentsOf: dir.appendingPathComponent(AuditDays.fileName(day))) { data.append(d) }
        }
        return data
    }

    private func settlePanel(_ p: SettingsRPCState.Panel, _ answer: SettingsPanelAnswer) {
        let st = settingsRPC
        var line: [String: JSONValue] = ["method": "settings.action", "stage": "settled", "name": .string(p.name)]
        var outcome = "done", reason: String?
        switch answer {
        case .directory(nil), .app(nil), .saved(false), .opened(nil):
            outcome = "cancelled"
        case .directory(let url?):
            do {
                try settingsApply(.logDirectory(url), verified: false)
                outcome = "applied"
            } catch {
                (outcome, reason) = ("refused", Self.settingsReason(error))
            }
        case .app(let id?):
            if Self.validBundleID(id) {
                st.pickedApp = id
                line["app"] = .string(id)
            } else {
                (outcome, reason) = ("refused", "invalid_params")
            }
        case .saved(true):
            // As the window records its exports; the contents went to the file the person chose, not the socket.
            audit.record(["method": p.name == "export_audit" ? "settings.audit_export" : "settings.export", "decision": "allow",
                          "bytes": .number(Double(p.bytes ?? 0)), "via": "page"])
        case .opened(let data?):
            do {
                st.importPreview = try settingsImportPreview(data)
            } catch {
                (outcome, reason) = ("refused", Self.settingsReason(error))
            }
        }
        line["decision"] = outcome == "refused" ? "deny" : "allow"
        line["outcome"] = .string(outcome)
        if let reason { line["reason"] = .string(reason) }
        audit.record(line)
        st.lastOutcome = settingsOutcome(p.name, outcome, reason: reason)
    }

    /// A bundle ID as a change takes it (SettingsChange.decode): 1–255 characters, no space or control character.
    static func validBundleID(_ s: String) -> Bool {
        !s.isEmpty && s.count <= SettingsChange.maxBundleID && !s.contains(where: \.isWhitespace)
            && !s.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }

    /// A picked settings file, decoded and validated as the window does (access, privacy, behavior, and the logs
    /// through settingsImportPlan), as importPreview keeps it: the file with its own log folder, and its preview now.
    private func settingsImportPreview(_ data: Data) throws -> (file: UserSettings, json: JSONValue) {
        let file = try UserSettings.decode(data)
        try file.access.validate()
        try file.privacy.validate()
        try file.behavior.validate()
        return (file, try settingsImportPlan(file).json)
    }

    /// What importing `file` does to the live settings now: the settings to apply, with the log folder in force kept
    /// (`log_directory_ignored`: the file named another one; a folder only ever comes from the folder panel or "use
    /// the default", never from a file's contents) and the logs validated, and the page's preview of it (`changes`,
    /// `changes_count`, `loosened`, `log_directory_ignored`), clipped (it is the file's text).
    private func settingsImportPlan(_ file: UserSettings) throws -> (settings: UserSettings, json: JSONValue) {
        var new = file
        let ignored = new.logs.directory != settings.logs.directory
        new.logs.directory = settings.logs.directory
        try new.logs.validate()
        func list(_ items: [String]) -> JSONValue {
            .array(items.prefix(100).map { .string($0.count > 100 ? String($0.prefix(100)) + "…" : $0) })
        }
        let changes = Self.settingsChanges(from: settings, to: new)
        return (new, ["changes": list(changes), "changes_count": .number(Double(changes.count)),
                      "loosened": list(settings.loosened(by: new)), "log_directory_ignored": .bool(ignored)])
    }

    /// What replacing `old` with `new` changes, one item per field, entry or chord (`section.field`,
    /// `denylist.add:<id>`, `chords.enable:<chord>` …).
    static func settingsChanges(from old: UserSettings, to new: UserSettings) -> [String] {
        func fields(_ section: String, _ a: JSONValue, _ b: JSONValue) -> [String] {
            let o = a.objectValue, n = b.objectValue
            return Set(o.keys).union(n.keys).sorted().filter { o[$0] != n[$0] }.map { "\(section).\($0)" }
        }
        func diff(_ section: String, _ a: [String], _ b: [String], add: String, remove: String) -> [String] {
            let before = Set(a.map { $0.lowercased() }), after = Set(b.map { $0.lowercased() })
            return b.filter { !before.contains($0.lowercased()) }.map { "\(section).\(add):\($0)" }
                + a.filter { !after.contains($0.lowercased()) }.map { "\(section).\(remove):\($0)" }
        }
        var out = fields("access", old.access.json, new.access.json) + fields("privacy", old.privacy.json, new.privacy.json)
            + fields("behavior", old.behavior.json, new.behavior.json) + fields("logs", old.logs.json, new.logs.json)
        out += diff("denylist", old.denylist.map(\.bundleId), new.denylist.map(\.bundleId), add: "add", remove: "remove")
        out += diff("chords", old.chords.disabled, new.chords.disabled, add: "disable", remove: "enable")
        let custom = { (s: UserSettings) in s.chords.custom.map { "\($0.chord)@\($0.app ?? "*")" } }
        out += diff("chords", custom(old), custom(new), add: "add", remove: "remove")
        return out
    }
}
