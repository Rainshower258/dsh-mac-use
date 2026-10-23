import Foundation

/// How a task may change system state outside the granted app's content (PLAN-v2 R4, 2026-09-29 night).
public enum ChangePolicy: String, Sendable, CaseIterable {
    /// Never change it; work with what is there and say what that risks.
    case leave
    /// Change it only after a person approved (per call or per task, through the plugin's approval service).
    case ask
    /// Change it for the task and restore it when the task ends.
    case takeover
}

/// One mechanism for every change this daemon makes to state that outlives a single action or reaches beyond the
/// granted app's content: Electron's AXManualAccessibility (per app) and the keyboard input source (global). Each
/// change is recorded in the ledger *before* it is made and audited; restores run in layers: when no active grant
/// wants the change any more (revoke at turn/end, expiry), on SIGTERM/SIGINT, and at the next start after a crash.
/// Not thread-safe: used only from the Dispatcher's serial worker queue.
public final class SystemStateChanges {
    public static let electronAX = "electron_ax"
    public static let inputSource = "input_source"
    static let systemTarget = "system"

    public enum ApprovalScope: String, Sendable { case call, task }

    private let env: SystemEnvironment
    private let ledger: StateLedger
    private let audit: AuditSink
    private let now: () -> Date
    private let sleep: (TimeInterval) -> Void
    private let settleParams: AXSettle.Params

    /// Lowercased bundle IDs whose AXManualAccessibility this daemon has turned on.
    private(set) var manualAXOn: Set<String> = []
    /// Apps whose processes refused AXManualAccessibility (native apps: Calculator, TextEdit), by lowercased bundle ID
    /// -> their pids then: not tried again on every observe (2026-10-09), but again after a relaunch (new pids).
    private var manualAXRefused: [String: [Int32]] = [:]
    /// Settle outcome of the most recent switch-on, reported once with the next observe.
    var lastSettle: [String: AXSettle.Outcome] = [:]

    /// The input source switch in force: which task asked, what to restore, what was set, and whether it ends with
    /// the current input (a per-call approval) or with the task.
    struct InputTakeover: Equatable {
        let taskID: String
        let original: String
        let applied: String
        let perCall: Bool
    }
    private(set) var inputTakeover: InputTakeover?
    /// Approvals to switch the input source, by task (from ime.approve after a person said yes).
    private var approvals: [String: ApprovalScope] = [:]

    init(env: SystemEnvironment, ledger: StateLedger, audit: AuditSink, now: @escaping () -> Date,
         sleep: @escaping (TimeInterval) -> Void, settleParams: AXSettle.Params) {
        self.env = env
        self.ledger = ledger
        self.audit = audit
        self.now = now
        self.sleep = sleep
        self.settleParams = settleParams
    }

    // MARK: - Layers shared by every kind

    /// Startup layer: a previous daemon crashed or was killed with changes in force. Restore what still applies.
    func recover() {
        let system = ConnectionInfo(id: 0, peerPID: nil, peerPath: nil, peerPIDVersion: nil)
        for entry in ledger.entries() {
            switch entry.kind {
            case Self.electronAX:
                if !Set(entry.pids).isDisjoint(with: env.runningPIDs(bundleID: entry.target)) {
                    setManualAX(entry.target, false, conn: system, trigger: "startup_recovery")
                } else {
                    ledger.remove(kind: entry.kind, target: entry.target)
                    var f = system.auditFields
                    f["method"] = "ax.manual_accessibility"
                    f["decision"] = "allow"
                    f["app"] = .string(entry.target)
                    f["trigger"] = "startup_recovery"
                    f["detail"] = "recorded processes are gone; nothing to restore"
                    audit.record(f)
                }
            case Self.inputSource:
                guard let original = entry.original, let applied = entry.applied else {
                    ledger.remove(kind: entry.kind, target: entry.target)
                    continue
                }
                restoreInputSource(InputTakeover(taskID: "", original: original, applied: applied, perCall: false),
                                   conn: system, trigger: "startup_recovery")
            default:
                ledger.remove(kind: entry.kind, target: entry.target)   // written by a newer daemon: not ours to guess
            }
        }
    }

    /// Shutdown layer: restore everything in force.
    func restoreAll(trigger: String) {
        let system = ConnectionInfo(id: 0, peerPID: nil, peerPath: nil, peerPIDVersion: nil)
        for app in manualAXOn.sorted() { setManualAX(app, false, conn: system, trigger: trigger) }
        if let t = inputTakeover { restoreInputSource(t, conn: system, trigger: trigger) }
    }

    /// After every request: undo what no active grant wants any more (turn/end revokes the task's grant).
    func reconcile(grants: [Grant], observing: [String], conn: ConnectionInfo) {
        let wanted = Set(grants.filter(\.electronAX).flatMap { $0.bundleIDs.map { $0.lowercased() } })
        for app in observing where wanted.contains(app) && !manualAXOn.contains(app) {
            if let pids = manualAXRefused[app], pids == env.runningPIDs(bundleID: app) { continue }
            setManualAX(app, true, conn: conn, trigger: "observe")
        }
        for app in manualAXOn.subtracting(wanted).sorted() {
            setManualAX(app, false, conn: conn, trigger: "no_grant_wants_it")
        }
        let active = Set(grants.map(\.taskID))
        approvals = approvals.filter { active.contains($0.key) }
        if let t = inputTakeover, !active.contains(t.taskID) {
            restoreInputSource(t, conn: conn, trigger: "no_grant_wants_it")
        }
    }

    // MARK: - electron_ax

    func setManualAX(_ app: String, _ on: Bool, conn: ConnectionInfo, trigger: String) {
        // Ledger first, so a crash between the two can still be cleaned up on the next start.
        if on {
            ledger.record(StateEntry(kind: Self.electronAX, target: app, pids: env.runningPIDs(bundleID: app), setAt: now()))
        }
        let baseline = on ? env.countAXNodes(bundleID: app) : 0
        let ok = env.setManualAccessibility(bundleID: app, enabled: on)
        // Never read a half-built tree: wait until the node count has settled (or say that it did not).
        let settle = on && ok ? AXSettle.wait(baseline: baseline, params: settleParams,
                                              count: { env.countAXNodes(bundleID: app) }, sleep: sleep) : nil
        if on && ok { manualAXOn.insert(app) }
        if on && !ok {
            ledger.remove(kind: Self.electronAX, target: app)
            manualAXRefused[app] = env.runningPIDs(bundleID: app)
        }
        if !on {
            manualAXOn.remove(app)
            if ok { ledger.remove(kind: Self.electronAX, target: app) }
        }
        var f = conn.auditFields
        f["method"] = "ax.manual_accessibility"
        f["decision"] = "allow"
        f["app"] = .string(app)
        f["value"] = .bool(on)
        f["ok"] = .bool(ok)
        f["trigger"] = .string(trigger)
        if let s = settle {
            f["settle"] = ["reason": .string(s.reason.rawValue), "baseline_nodes": .number(Double(s.baseline)),
                           "nodes": .number(Double(s.nodes)), "reads": .number(Double(s.reads)),
                           "elapsed_ms": .number((s.elapsed * 1000).rounded())]
            lastSettle[app] = s
        }
        audit.record(f)
    }

    // MARK: - input_source

    /// A person approved switching the input source for this task: for its next input (`call`) or until it ends.
    func approveInputSwitch(taskID: String, scope: ApprovalScope) {
        approvals[taskID] = scope
    }

    static func passesThroughIME(_ c: Unicode.Scalar) -> Bool {
        ("0"..."9").contains(c) || c == " " || c == "\n" || c == "\t"
    }

    /// Before typing (act.type): with an input method active, apply the task's policy. Returns what the result
    /// should say about the input source; throws a refusal (nothing typed yet) when typing must not start.
    /// Keyboard layouts need nothing: typed text goes out as Unicode events, which layouts do not transform.
    func prepareTyping(taskID: String, app: String, policy: ChangePolicy, conn: ConnectionInfo,
                       text: String? = nil) throws -> [String: JSONValue] {
        guard let src = env.currentInputSource() else { return ["input_source": .null, "ime": "unknown_source"] }
        var info: [String: JSONValue] = ["input_source": .string(src.id)]
        if let t = inputTakeover, t.applied == src.id {
            info["ime"] = "switched"
            info["original_input_source"] = .string(t.original)
            return info
        }
        guard src.isInputMethod else {
            info["ime"] = "none"
            return info
        }
        let composing = env.imeComposing(bundleID: app)
        info["ime_composing"] = composing.map { .bool($0) } ?? "unknown"
        if policy == .leave {
            info["ime"] = "left"
            info["ime_warning"] = .string("input method \(src.id) is active: it may swallow typed text (it did while "
                                          + "holding an uncommitted composition); check the result")
            return info
        }
        // Switching would commit or drop what the user is composing: never switch under it.
        if composing == true {
            throw Denial("ime_composing", "\(src.id) holds an uncommitted composition; switching the input source now "
                         + "would commit or drop it. Cancel it (Escape) or let the user finish, then observe again",
                         data: ["input_source": .string(src.id)])
        }
        // Digits, spaces and line breaks go through an input method that holds nothing as they are (2026-10-09: "896"
        // into TextEdit asked a person to approve a switch for nothing). Letters and ASCII punctuation still switch:
        // Pinyin turns letters into a composition and "," into "，".
        if composing == false, let text, !text.isEmpty, text.unicodeScalars.allSatisfy(Self.passesThroughIME) {
            info["ime"] = "not_needed"
            return info
        }
        var perCall = false
        if policy == .ask {
            guard let scope = approvals[taskID] else {
                var data: [String: JSONValue] = ["input_source": .string(src.id)]
                if let name = src.name { data["input_source_name"] = .string(name) }
                throw Denial("ime_switch_needs_approval", "typing needs the input source switched from \(src.id) to an "
                             + "ASCII layout (restored afterwards); a person must approve that first", data: data)
            }
            perCall = scope == .call
            if perCall { approvals.removeValue(forKey: taskID) }
        }
        guard let ascii = env.asciiInputSourceID(), ascii != src.id else {
            throw Denial("ime_switch_failed", "no ASCII keyboard layout to switch \(src.id) to",
                         data: ["input_source": .string(src.id)])
        }
        ledger.record(StateEntry(kind: Self.inputSource, target: Self.systemTarget, original: src.id, applied: ascii, setAt: now()))
        let ok = env.selectInputSource(id: ascii)
        auditInputSource(conn: conn, change: "select", from: src.id, to: ascii, ok: ok, trigger: policy.rawValue, taskID: taskID)
        guard ok else {
            ledger.remove(kind: Self.inputSource, target: Self.systemTarget)
            throw Denial("ime_switch_failed", "selecting \(ascii) did not take effect", data: ["input_source": .string(src.id)])
        }
        inputTakeover = InputTakeover(taskID: taskID, original: src.id, applied: ascii, perCall: perCall)
        info["ime"] = "switched"
        info["input_source"] = .string(ascii)
        info["original_input_source"] = .string(src.id)
        info["restores"] = .string(perCall ? "after_this_input" : "when_the_task_ends")
        return info
    }

    /// After typing: a per-call approval ends with the input it was given for.
    func afterTyping(taskID: String, conn: ConnectionInfo) {
        if let t = inputTakeover, t.perCall, t.taskID == taskID {
            restoreInputSource(t, conn: conn, trigger: "after_input")
        }
    }

    /// Restores the original source, but only if the one this daemon set is still current: if the user (or the
    /// system) switched since, their choice stands and is left alone.
    private func restoreInputSource(_ t: InputTakeover, conn: ConnectionInfo, trigger: String) {
        let current = env.currentInputSource()?.id
        if current == t.applied {
            let ok = env.selectInputSource(id: t.original)
            auditInputSource(conn: conn, change: "restore", from: t.applied, to: t.original, ok: ok, trigger: trigger,
                             taskID: t.taskID.isEmpty ? nil : t.taskID)
            // A failed restore stays in the ledger: the next start tries again.
            if ok { ledger.remove(kind: Self.inputSource, target: Self.systemTarget) }
        } else {
            var f = auditFields(conn: conn, change: "restore_skipped", trigger: trigger, taskID: t.taskID.isEmpty ? nil : t.taskID)
            f["current"] = current.map { .string($0) } ?? .null
            f["applied"] = .string(t.applied)
            f["detail"] = "the input source was changed since this daemon set it; left as it is"
            audit.record(f)
            ledger.remove(kind: Self.inputSource, target: Self.systemTarget)
        }
        if inputTakeover == t { inputTakeover = nil }
    }

    private func auditInputSource(conn: ConnectionInfo, change: String, from: String, to: String, ok: Bool, trigger: String,
                                  taskID: String?) {
        var f = auditFields(conn: conn, change: change, trigger: trigger, taskID: taskID)
        f["from"] = .string(from)
        f["to"] = .string(to)
        f["ok"] = .bool(ok)
        audit.record(f)
    }

    private func auditFields(conn: ConnectionInfo, change: String, trigger: String, taskID: String?) -> [String: JSONValue] {
        var f = conn.auditFields
        f["method"] = "system.input_source"
        f["decision"] = "allow"
        f["change"] = .string(change)
        f["trigger"] = .string(trigger)
        if let taskID { f["task_id"] = .string(taskID) }
        return f
    }
}
