import CoreGraphics
import Foundation

/// Areas where a click was refused because it would have been intercepted (see HitTest), with the window
/// frames at that moment. The next observes flag elements there as occluded while the window list is unchanged:
/// the model learns the cause from the refusal and then sees it, without an AX hit test per element per observe.
/// (At file scope, not nested: the Dispatcher's body is at swiftlint's type_body_length cap.)
private struct Interception {
    let region: CGRect
    let by: String
    let windows: [UInt32: CGRect]
}

/// Every security decision lives here (PLAN-v2 §3: never trust the TS layer alone).
/// Not thread-safe: the server calls it only from one serial worker queue.
public final class Dispatcher {
    public static let activationTimeout: TimeInterval = 0.5
    /// Until bench/experiments/activation.py says otherwise; config.json `activation_method` overrides it.
    public static let defaultActivationMethod: ActivationMethod = .runningApplication

    let grants: GrantStore
    let env: SystemEnvironment
    let config: PolicyConfig
    let audit: AuditSink
    /// Changes to system state outside the granted content (electron_ax, the input source): ledger, restores, audit.
    private let state: SystemStateChanges
    let now: () -> Date
    let sleep: (TimeInterval) -> Void
    private let settleParams: AXSettle.Params
    private var snapshotGen = 0
    private let snapshots = SnapshotStore()
    private let zooms = ZoomStore()
    private var interceptions: [Interception] = []
    /// Apps this daemon launched, by launch time: until they show up as running, observe waits for them (bounded),
    /// so the window wait (WindowAppearWait) can take over. Apps launched by anyone else are not waited for.
    var launchedAt: [String: Date] = [:]
    static let launchGrace: TimeInterval = 10
    static let launchRegistrationTimeout: TimeInterval = 2.5
    /// Resolved directories apps.launch never opens a file from (main: the state dir). Set before the server starts.
    public var protectedDirs: [String] = []
    /// Where the audit goes when the logs setting names no folder (main: the state dir's `audit`); nil in tests.
    public var defaultLogDirectory: URL?
    /// How long apps.launch `open` waits for the app's answer (MacEnvironment.open).
    public static let openWait: TimeInterval = 10
    /// The connection of the request being handled (audit fields for state changes made on its behalf).
    private(set) var conn = ConnectionInfo(id: 0, peerPID: nil, peerPath: nil, peerPIDVersion: nil)
    /// Approval dialogs (access.*, Dispatcher+Access.swift).
    let approvals: ApprovalDeps
    /// The user's settings (Settings.swift): loaded once at start, changed from the settings window in-process
    /// (Dispatcher+Settings.swift) and over the socket only through the settings.* methods (Dispatcher+SettingsRPC.swift:
    /// one closed change at a time, a loosening one only after the daemon's own owner check, never a file path).
    /// Worker queue only, like every other state here.
    let settingsStore: SettingsStore
    public internal(set) var settings: UserSettings
    /// The daemon's one owner check (OwnerCheck.swift): the only source of `verified: true` for a settings change that
    /// arrives over the socket. Set by main.swift after init, before the server starts; nil in tests unless set, and
    /// then no loosening change can be verified.
    public var ownerCheck: OwnerCheck?
    /// The Mac's panels and lookups for the settings (SettingsPanels.swift): every file path a setting uses comes from
    /// them. Set by main.swift after init, before the server starts; nil when headless and in tests unless set.
    public var settingsPanels: SettingsPanels?
    /// When this daemon started (the overview's uptime).
    public let startedAt: Date

    public init(grants: GrantStore, env: SystemEnvironment, config: PolicyConfig, audit: AuditSink,
                ledger: StateLedger = MemoryStateLedger(), now: @escaping () -> Date = Date.init,
                sleep: @escaping (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) },
                settleParams: AXSettle.Params = AXSettle.Params(), approvals: ApprovalDeps = ApprovalDeps(),
                settingsStore: SettingsStore = MemorySettingsStore()) {
        self.grants = grants
        self.env = env
        self.config = config
        self.audit = audit
        self.approvals = approvals
        self.settingsStore = settingsStore
        self.startedAt = now()
        do {
            settings = try settingsStore.load()
            // What the daemon starts with, in counts (never the entries): the trace of every later line.
            audit.record(["method": "settings.load", "decision": "allow", "version": .number(Double(settings.version)),
                          "denylist": .number(Double(settings.denylist.count)), "custom_chords": .number(Double(settings.chords.custom.count)),
                          "disabled_chords": .number(Double(settings.chords.disabled.count)), "text_only_apps": .number(Double(settings.privacy.textOnlyApps.count)),
                          "default_mode": .string(settings.access.defaultMode.rawValue), "log_directory_custom": .bool(settings.logs.directory != nil)])
        } catch {
            // A broken settings file must not open anything up: it is as if empty, and the audit says so.
            settings = UserSettings()
            audit.record(["method": "settings.load", "decision": "error", "detail": .string("\(error)")])
        }
        self.now = now
        self.sleep = sleep
        self.settleParams = settleParams
        state = SystemStateChanges(env: env, ledger: ledger, audit: audit, now: now, sleep: sleep, settleParams: settleParams)
    }

    /// Startup layer: a previous daemon crashed or was killed with system state changed (SystemStateChanges).
    public func recoverSystemState() { state.recover() }


    /// Shutdown layer: restore every change in force. Call on the worker queue.
    public func restoreAllSystemState(trigger: String) { state.restoreAll(trigger: trigger) }

    public func handle(method: String, params: JSONValue?, conn: ConnectionInfo) -> Result<JSONValue, RPCFailure> {
        let start = Date()
        self.conn = conn
        var fields = conn.auditFields
        fields["method"] = .string(method)
        let outcome: Result<JSONValue, RPCFailure>
        do {
            outcome = .success(try route(method, params, &fields, conn: conn))
            if fields["decision"] == nil { fields["decision"] = "allow" }
        } catch let d as Denial {
            fields["decision"] = "deny"
            fields["reason"] = .string(d.reason)
            fields["detail"] = .string(d.detail)
            for (k, v) in d.data where !k.hasPrefix("untrusted_") { fields[k] = v }  // app content: to the client only
            fields["retry"] = .string(Refusals.retry(for: d.reason).rawValue)
            outcome = .failure(RPCFailure(.denied, d.detail, data: Refusals.data(reason: d.reason, extra: d.data)))
        } catch let f as RPCFailure {
            fields["decision"] = "error"
            fields["reason"] = .string(String(describing: f.code))
            fields["detail"] = .string(f.message)
            outcome = .failure(f)
        } catch {
            let detail = Self.describe(error)
            fields["decision"] = "error"
            fields["reason"] = "invalid_params"
            fields["detail"] = .string(detail)
            outcome = .failure(RPCFailure(.invalidParams, detail))
        }
        fields["dur_ms"] = .number((Date().timeIntervalSince(start) * 1000).rounded())
        audit.record(fields)
        state.reconcile(grants: grants.all(now: now()), observing: [], conn: conn)
        return outcome
    }

    // MARK: - Routing (by namespace; audit L6)

    private func route(_ method: String, _ params: JSONValue?, _ f: inout [String: JSONValue],
                       conn: ConnectionInfo) throws -> JSONValue {
        let namespace = method.split(separator: ".", maxSplits: 1).first.map(String.init) ?? method
        let params = namespace == "grants" || namespace == "settings" ? params : try resolveAppName(params, &f)
        if let kind = ActionKind.of(method: method) { try admitAction(kind, params, &f) }
        switch namespace {
        case "runtime" where method == "runtime.ping": return ["pong": true]
        case "runtime" where method == "runtime.debug_activate":
            return try debugActivate(try JSONCoding.decodeParams(DebugActivateParams.self, params), &f)
        case "runtime" where method == "runtime.debug_ime":
            return try debugIME(try JSONCoding.decodeParams(DebugIMEParams.self, params), &f)
        case "grants": return try routeGrants(method, params, &f)
        case "access": return try routeAccess(method, params, &f)
        case "ime" where method == "ime.approve":
            // The plugin calls this only after its approval service said yes (like grants.set source: approval).
            let p = try JSONCoding.decodeParams(IMEApproveParams.self, params)
            f["task_id"] = .string(p.taskId)
            f["scope"] = .string(p.scope)
            guard let scope = SystemStateChanges.ApprovalScope(rawValue: p.scope) else {
                throw RPCFailure(.invalidParams, "scope must be call or task")
            }
            _ = try activeGrant(p.taskId)
            state.approveInputSwitch(taskID: p.taskId, scope: scope)
            return ["approved": .string(scope.rawValue)]
        case "apps": return try routeApps(method, params, &f)
        case "observe" where method == "observe":
            return try observe(try JSONCoding.decodeParams(ObserveParams.self, params), &f, conn: conn)
        case "zoom" where method == "zoom":
            let p = try JSONCoding.decodeParams(ZoomParams.self, params)
            f["task_id"] = .string(p.taskId)
            return try zoom(p, &f)
        case "act": return try routeAction(method, params, &f)
        case "settings": return try routeSettings(method, params, &f)
        default: throw RPCFailure(.methodNotFound, "unknown method \(method)")
        }
    }

    private func routeGrants(_ method: String, _ params: JSONValue?, _ f: inout [String: JSONValue]) throws -> JSONValue {
        switch method {
        case "grants.set":
            guard config.configGrants else { throw Denial("config_grants_disabled", "grants.set is off in this daemon's config: apps are approved through access.request and its dialog") }
            let p = try JSONCoding.decodeParams(GrantSetParams.self, params)
            f["task_id"] = .string(p.taskId)
            f["bundle_ids"] = .array(p.bundleIds.map { .string($0) })
            guard !p.bundleIds.isEmpty else { throw RPCFailure(.invalidParams, "bundle_ids is empty") }
            guard let source = Grant.Source(rawValue: p.source) else {
                throw RPCFailure(.invalidParams, "source must be \"config\" or \"approval\"")
            }
            for b in p.bundleIds { try GrantRules.checkGrantable(b, source: source, config: config, settings: settings) }
            let ttl = min(max(p.expiresInS ?? GrantRules.defaultTTL, 1), GrantRules.maxTTL)
            guard let ime = ChangePolicy(rawValue: p.imePolicy ?? "leave") else {
                throw RPCFailure(.invalidParams, "ime_policy must be leave, ask or takeover")
            }
            let (actions, clickLimit) = try GrantRules.actionLimits(p)
            let grant = Grant(taskID: p.taskId, bundleIDs: p.bundleIds, allowLaunch: p.allowLaunch ?? false,
                              expiresAt: now().addingTimeInterval(ttl), source: source,
                              electronAX: p.electronAx ?? false, imePolicy: ime, actions: actions, clickLimit: clickLimit)
            f["electron_ax"] = .bool(grant.electronAX)
            f["ime_policy"] = .string(ime.rawValue)
            if let a = grant.json["actions"], a != .null { f["actions"] = a }
            if let c = grant.clickLimit { f["click_limit"] = c.json }
            grants.set(grant)
            return grant.json

        case "grants.revoke":
            let p = try JSONCoding.decodeParams(TaskParams.self, params)
            f["task_id"] = .string(p.taskId)
            book.forget(p.taskId)
            return ["revoked": .bool(grants.revoke(p.taskId))]

        case "grants.list":
            return .array(grants.all(now: now()).map(\.json))

        case "grants.request":
            // The daemon never widens a grant because it was asked to. A human-approved grant arrives
            // later through grants.set(source: approval); with no approver (headless) nothing arrives.
            let p = try JSONCoding.decodeParams(GrantRequestParams.self, params)
            f["task_id"] = .string(p.taskId)
            f["app"] = .string(p.bundleId)
            try GrantRules.checkGrantable(p.bundleId, source: .approval, config: config, settings: settings)
            f["decision"] = "defer"
            return ["status": "needs_approval"]

        default:
            throw RPCFailure(.methodNotFound, "unknown method \(method)")
        }
    }

    private func routeApps(_ method: String, _ params: JSONValue?, _ f: inout [String: JSONValue]) throws -> JSONValue {
        switch method {
        case "apps.list":
            let p = try JSONCoding.decodeParams(TaskParams.self, params)
            f["task_id"] = .string(p.taskId)
            let grant = try activeGrant(p.taskId)
            let running = env.runningBundleIDs()
            return .array(grant.bundleIDs.filter { running.contains($0.lowercased()) }.map { .string($0) })

        case "apps.launch": return try launch(try JSONCoding.decodeParams(LaunchParams.self, params), &f)

        default:
            throw RPCFailure(.methodNotFound, "unknown method \(method)")
        }
    }

    private func routeAction(_ method: String, _ params: JSONValue?, _ f: inout [String: JSONValue]) throws -> JSONValue {
        switch method {
        case "act.click": return try click(try JSONCoding.decodeParams(ClickParams.self, params), &f)
        case "act.scroll": return try scroll(try JSONCoding.decodeParams(ScrollParams.self, params), &f)
        case "act.drag": return try drag(try JSONCoding.decodeParams(DragParams.self, params), &f)
        case "act.type": return try type(try JSONCoding.decodeParams(TypeParams.self, params), &f)
        case "act.key": return try key(try JSONCoding.decodeParams(KeyParams.self, params), &f)
        case "act.set_value": return try setValue(try JSONCoding.decodeParams(ElementValueParams.self, params), &f)
        case "act.ax_action": return try axAction(try JSONCoding.decodeParams(ElementActionParams.self, params), &f)
        case "act.menu": return try menu(try JSONCoding.decodeParams(MenuParams.self, params), &f)
        default: throw RPCFailure(.methodNotFound, "unknown method \(method)")
        }
    }

    private func observe(_ p: ObserveParams, _ f: inout [String: JSONValue], conn: ConnectionInfo) throws -> JSONValue {
        f["task_id"] = .string(p.taskId)
        let grant = try activeGrant(p.taskId)
        try requireUnlocked()
        let ocrMode = p.ocr ?? "on"
        guard ocrMode == "on" || ocrMode == "off" else {
            throw RPCFailure(.invalidParams, "ocr must be \"on\" or \"off\" (\"auto\" waits for the R5 threshold)")
        }
        let running = waitForLaunched(grant.bundleIDs.map { $0.lowercased() }, &f)
        var apps: [String] = []
        for id in grant.bundleIDs.map({ $0.lowercased() }) where running.contains(id) && book.hostApp[p.taskId] != id {
            try GrantRules.checkGrantable(id, source: grant.source, config: config, settings: settings)
            apps.append(id)
        }
        let presence = windowPresence(granted: grant.bundleIDs, running: apps, &f)
        let showing = apps.filter { presence[$0] == nil || launchedAt[$0] != nil }
        // electron_ax goes on (and its tree is waited for) only once a window is there to grow a tree.
        state.reconcile(grants: grants.all(now: now()), observing: grant.electronAX ? showing : [], conn: conn)
        snapshotGen += 1
        let native = (p.debugNativeImage ?? false) && config.debugNativeImages
        if native { f["debug_native_image"] = true }
        // The privacy settings cut what leaves the machine (batch 3): no image when screenshots are off or a
        // text-only app is among the observed; no OCR when it is off. Audited as such.
        let privacy = settings.privacy
        let textOnly = apps.filter { privacy.isTextOnly($0) }
        var includeImage = (p.includeImage ?? false) || native
        if includeImage && !privacy.sendScreenshots { includeImage = false; f["image_off"] = "settings" }
        if includeImage && !textOnly.isEmpty { includeImage = false; f["image_off"] = "text_only_app" }
        var ocr = ocrMode == "on"
        if ocr && !privacy.sendOCR { ocr = false; f["ocr_off"] = "settings" }
        if !privacy.sendAXText { f["ax_text_off"] = "settings" }
        var req = ObserveRequest(apps: apps, ocr: ocr, includeImage: includeImage, limits: AXLimits(), debugNativeImage: native)
        req.waitFor = Set(showing)
        let out = observeResponse(env.observe(req), apps: apps, grant: grant, &f)
        guard case .object(var o) = out, !presence.isEmpty else { return out }
        o["app_states"] = .object(presence.mapValues { .string($0.rawValue) })
        return .object(o)
    }

    // MARK: - Actions (PLAN-v2 §6)

    /// AX first: an element target whose element supports AXPress is pressed through AX (no activation, not affected
    /// by what covers it) unless `via: "event"`. Points, other buttons, double clicks and `via: "event"` post real
    /// events after every §5.3 check.
    private func click(_ p: ClickParams, _ f: inout [String: JSONValue]) throws -> JSONValue {
        let count = p.count ?? 1
        guard let button = MouseButton(rawValue: p.button ?? "left"), (1...3).contains(count) else {
            throw RPCFailure(.invalidParams, "button must be left/right/middle and count 1–3")
        }
        let via = try path(p.via)
        f["button"] = .string(button.rawValue)
        if count > 1 { f["count"] = .number(Double(count)) }
        try activeGrant(p.taskId).checkClick(button: button, count: count, app: p.app)
        if let id = p.elementId, via != .event, button == .left, count == 1,
           let h = try axHandle(p.taskId, p.app, elementId: id, snapshotGen: p.snapshotGen, required: via == .ax, &f) {
            guard env.axActions(handle: h)?.contains("AXPress") == true else {
                if via == .ax { throw Denial("ax_unsupported", "element \(Self.clip(id)) has no AXPress; use via: event") }
                return try clickEvent(p, button: button, count: count, &f)
            }
            return try performAX(h, "AXPress", &f)
        }
        return try clickEvent(p, button: button, count: count, &f)
    }

    private func clickEvent(_ p: ClickParams, button: MouseButton, count: Int, _ f: inout [String: JSONValue]) throws -> JSONValue {
        let points = try precheck(p.taskId, p.app, targets: [try Target.single(p.elementId, p.point)], chord: nil,
                                  snapshotGen: p.snapshotGen, &f)
        let pt = points[0]
        f["point_pt"] = [.number(pt.x), .number(pt.y)]
        // A click on a non-focused window is swallowed as a window-activation click: focus that window first.
        // Focusing can make the system move/resize the window (e.g. to fit the visible area), so the click
        // point is re-validated afterwards: every check before this ran against the old frame.
        let window = env.topWindowID(at: pt)
        let before = window.flatMap { env.currentWindowFrames()[$0] }
        guard env.focusWindow(at: pt, bundleID: p.app.lowercased()) else {
            throw Denial("window_focus_failed", "the window under (\(pt.x), \(pt.y)) could not be made the focused window")
        }
        // The system may reposition it asynchronously a moment later: require it to hold still first.
        if let window {
            for _ in 0..<3 {
                guard env.currentWindowFrames()[window] == before else {
                    throw Denial("stale_coordinates", "window \(window) moved or resized when it was focused; observe again")
                }
                sleep(0.05)
            }
        }
        guard env.click(at: pt, button: button, count: count) else { throw Denial("action_failed", "posting the click failed") }
        // Already executed; if the window changed right after, say so: the click may have missed.
        sleep(0.05)
        let changed = window.map { env.currentWindowFrames()[$0] != before } ?? false
        if changed { f["window_changed_after_click"] = true }
        return ["executed": true, "via": "event", "point_pt": [.number(pt.x), .number(pt.y)], "window_changed_after_click": .bool(changed)]
    }

    private func scroll(_ p: ScrollParams, _ f: inout [String: JSONValue]) throws -> JSONValue {
        let lines = Int((p.amount ?? 3).rounded())
        guard (1...50).contains(lines) else { throw RPCFailure(.invalidParams, "amount must be 1–50 lines") }
        let (dx, dy): (Int, Int)
        switch p.direction {
        case "up": (dx, dy) = (0, lines)
        case "down": (dx, dy) = (0, -lines)
        case "left": (dx, dy) = (lines, 0)
        case "right": (dx, dy) = (-lines, 0)
        default: throw RPCFailure(.invalidParams, "direction must be up/down/left/right")
        }
        let pt = try precheck(p.taskId, p.app, targets: [try Target.single(p.elementId, p.point)], chord: nil,
                              snapshotGen: p.snapshotGen, &f)[0]
        f["point_pt"] = [.number(pt.x), .number(pt.y)]
        guard env.scroll(at: pt, dx: dx, dy: dy) else { throw Denial("action_failed", "posting the scroll failed") }
        return ["executed": true, "via": "event"]
    }

    private func drag(_ p: DragParams, _ f: inout [String: JSONValue]) throws -> JSONValue {
        let pts = try precheck(p.taskId, p.app, targets: [p.from, p.to], chord: nil, snapshotGen: p.snapshotGen, &f)
        f["from_pt"] = [.number(pts[0].x), .number(pts[0].y)]
        f["to_pt"] = [.number(pts[1].x), .number(pts[1].y)]
        guard env.drag(from: pts[0], to: pts[1]) else { throw Denial("action_failed", "posting the drag failed") }
        return ["executed": true, "via": "event"]
    }

    /// Text goes out in chunks of at most 20 UTF-16 units; line breaks and tabs as key presses (TypingPlan). Before
    /// every step the target must still be frontmost: if something else came to the front (a typed Return opened
    /// it), typing stops and the refusal says how much was posted (`focus_lost`, outcome partly executed).
    private func type(_ p: TypeParams, _ f: inout [String: JSONValue]) throws -> JSONValue {
        f["text_len"] = .number(Double(p.text.count))  // never the text itself
        let handle = try p.elementId.flatMap {
            try axHandle(p.taskId, p.app, elementId: $0, snapshotGen: p.snapshotGen, required: true, &f)
        }
        try refuseSecureInput(p.app, handle: handle)
        try precheck(p.taskId, p.app, targets: [], chord: nil, snapshotGen: p.snapshotGen, &f)
        if let handle, !env.axFocus(handle: handle) {
            throw Denial("ax_unsupported", "element \(Self.clip(p.elementId ?? "")) cannot take keyboard focus")
        }
        try refuseSecureInput(p.app, handle: handle)   // again: activating or focusing may have moved the focus
        guard ["auto", "type", "paste"].contains(p.strategy ?? "auto") else {
            throw RPCFailure(.invalidParams, "strategy must be auto, type or paste")
        }
        if p.strategy == "paste" { return try paste(p, handle: handle, &f) }
        // Setting the value through AX bypasses the input method entirely and changes no system state. It is used only
        // where it equals typing: an empty field (typing inserts at the caret, a set replaces everything) and no line
        // break or tab (those are key presses that submit or move focus). Chromium fires its 'input' event on an AX
        // set (bench/experiments/ime_probe.py, 6/6); whether a given app reacted is left to the next observe.
        var fallback: String?
        if let handle, (p.strategy ?? "auto") == "auto", !p.text.isEmpty, !p.text.contains(where: { "\n\r\t".contains($0) }),
           env.axValueSettable(handle: handle), (env.axValue(handle: handle) ?? "").isEmpty {
            if env.axSetValue(handle: handle, value: p.text) {
                sleep(0.1)
                if env.axValue(handle: handle).map(Self.normalizedLines) == Self.normalizedLines(p.text) {
                    f["via"] = "ax_value"
                    f["verified"] = true
                    return ["executed": true, "via": "ax_value", "verified": true, "app_reaction": "not_checked"]
                }
                _ = env.axSetValue(handle: handle, value: "")   // not what was asked: undo, then type it
                fallback = "readback_mismatch"
            } else {
                fallback = "set_failed"
            }
            f["set_value_fallback"] = .string(fallback!)
        }
        // Input method policy last, right before typing: a switch is made only when typing really starts.
        let grantPolicy = try activeGrant(p.taskId).imePolicy
        let policy: ChangePolicy
        switch p.imePolicy {
        case nil: policy = grantPolicy
        case "leave"?: policy = .leave
        default: throw RPCFailure(.invalidParams, "ime_policy on act.type can only be \"leave\"")
        }
        let ime = try state.prepareTyping(taskID: p.taskId, app: p.app.lowercased(), policy: policy, conn: conn, text: p.text)
        for (k, v) in ime where k != "ime_warning" { f[k] = v }
        defer { state.afterTyping(taskID: p.taskId, conn: conn) }
        let steps = TypingPlan.steps(p.text)
        let app = p.app.lowercased()
        let posted = env.type(steps) { env.frontmostBundleID()?.caseInsensitiveCompare(app) == .orderedSame }
        f["steps"] = .number(Double(steps.count))
        guard posted == steps.count else {
            throw Denial("focus_lost", "typing stopped after \(posted) of \(steps.count) steps: \(p.app) is no longer frontmost",
                         data: ["steps_posted": .number(Double(posted)), "steps_total": .number(Double(steps.count))])
        }
        // With an element target, check the text arrived: an input method holding an uncommitted composition (Pinyin
        // "ni" with candidates) swallowed every typed character in the VM while the events were posted fine
        // (bench/experiments/ime.py, 2026-09-29). verified false: posted, but the field does not contain the text.
        var out: [String: JSONValue] = ["executed": true, "via": "event", "steps": .number(Double(steps.count))]
        for (k, v) in ime { out[k] = v }
        if let fallback { out["set_value_fallback"] = .string(fallback) }
        if let handle, !p.text.isEmpty {
            sleep(0.1)
            let arrived = env.axValue(handle: handle).map { Self.normalizedLines($0).contains(Self.normalizedLines(p.text)) }
            out["verified"] = arrived.map { .bool($0) } ?? .null
            f["verified"] = out["verified"]
        }
        return .object(out)
    }

    private func key(_ p: KeyParams, _ f: inout [String: JSONValue]) throws -> JSONValue {
        try refuseSecureInput(p.app, handle: nil)
        try precheck(p.taskId, p.app, targets: [], chord: p.chord, snapshotGen: nil, &f)
        try refuseSecureInput(p.app, handle: nil)
        let chord = try KeyChord.parse(p.chord)   // parsed and allowed by precheck
        guard env.press(chord) else { throw Denial("action_failed", "posting the key events failed") }
        return ["executed": true, "via": "event"]
    }

    private func setValue(_ p: ElementValueParams, _ f: inout [String: JSONValue]) throws -> JSONValue {
        f["value_len"] = .number(Double(p.value.count))  // never the value itself
        guard let h = try axHandle(p.taskId, p.app, elementId: p.elementId, snapshotGen: p.snapshotGen, required: true, &f) else {
            throw Denial("ax_unsupported", "element \(Self.clip(p.elementId)) is not an AX element")
        }
        try refuseSecureInput(p.app, handle: h)
        guard env.axSetValue(handle: h, value: p.value) else {
            throw Denial("ax_unsupported", "element \(Self.clip(p.elementId))'s AXValue is not settable; use act.type")
        }
        return ["executed": true, "via": "ax"]
    }

    private func axAction(_ p: ElementActionParams, _ f: inout [String: JSONValue]) throws -> JSONValue {
        guard AXActionPolicy.allowed.contains(p.action) else {
            throw Denial("ax_action_not_allowed", "\(Self.clip(p.action)) is not one of \(AXActionPolicy.allowed.sorted())")
        }
        guard let h = try axHandle(p.taskId, p.app, elementId: p.elementId, snapshotGen: p.snapshotGen, required: true, &f) else {
            throw Denial("ax_unsupported", "element \(Self.clip(p.elementId)) is not an AX element")
        }
        guard env.axActions(handle: h)?.contains(p.action) == true else {
            throw Denial("ax_unsupported", "element \(Self.clip(p.elementId)) does not support \(p.action)")
        }
        return try performAX(h, p.action, &f)
    }

    private func performAX(_ handle: Int, _ action: String, _ f: inout [String: JSONValue]) throws -> JSONValue {
        f["ax_action"] = .string(action)
        f["via"] = "ax"
        // An AX error does not prove the action did not happen.
        guard env.axPerform(handle: handle, action: action) else { throw Denial("action_failed", "\(action) returned an error") }
        return ["executed": true, "via": "ax", "action": .string(action)]
    }

    /// No credentials are ever typed for the user (2026-09-29): typing, setting a value or pressing keys into a
    /// password field, or while the system's secure input is on, is refused. Keyboard events synthesized during
    /// secure input may be dropped anyway, which would make the outcome unknown; refusing is cleaner.
    private func refuseSecureInput(_ app: String, handle: Int?) throws {
        if let why = env.secureInputReason(bundleID: app.lowercased(), handle: handle) {
            throw Denial("secure_input", "\(why): this tool never types credentials; ask the user to enter it themselves")
        }
    }

    /// Line breaks compare equal whatever the field stores (\r, \r\n or \n).
    static func normalizedLines(_ s: String) -> String {
        s.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    }

    private func path(_ via: String?) throws -> ActionPath {
        guard let p = ActionPath(rawValue: via ?? "auto") else { throw RPCFailure(.invalidParams, "via must be auto, ax or event") }
        return p
    }

    /// The AX path's checks (PLAN-v2 §6): AX acts on the element itself, so no activation or hit test, but the grant,
    /// the hard-deny halt and the element's staleness are checked like for any action. Nil when the element is not
    /// an AX element (OCR text) and `required` is false.
    private func axHandle(_ taskID: String, _ app: String, elementId: String, snapshotGen: Int?, required: Bool,
                          _ f: inout [String: JSONValue]) throws -> Int? {
        f["task_id"] = .string(taskID)
        f["app"] = .string(app)
        if let g = snapshotGen { f["snapshot_gen"] = .number(Double(g)) }
        try checkApp(taskID: taskID, app: app)
        try requireUnlocked()
        if let front = env.frontmostBundleID(), let e = HardDeny.entry(for: front) {
            throw Denial("hard_denied_frontmost", "\(e.bundleID) (\(e.reason)) is frontmost; all actions stop")
        }
        // OCR text has no AX element: say so before any staleness check (cheaper, and the clearer reason).
        if let gen = snapshotGen, let se = snapshots.get(gen)?.elements[elementId], se.source == .ocr {
            if required { throw Denial("ax_unsupported", "element \(Self.clip(elementId)) is OCR text, not an AX element; use a point") }
            return nil
        }
        _ = try resolve(Target(elementId: elementId, point: nil), app: app, snapshotGen: snapshotGen)
        guard let gen = snapshotGen, let se = snapshots.get(gen)?.elements[elementId], se.source == .ax, let h = se.handle else {
            if required { throw Denial("ax_unsupported", "element \(Self.clip(elementId)) is not an AX element") }
            return nil
        }
        return h
    }

    /// Running bundle IDs, after waiting (bounded) for granted apps this daemon launched moments ago to register.
    private func waitForLaunched(_ granted: [String], _ f: inout [String: JSONValue]) -> Set<String> {
        let t = now()
        launchedAt = launchedAt.filter { t.timeIntervalSince($0.value) < Self.launchGrace }
        var running = env.runningBundleIDs()
        let pending = granted.filter { launchedAt[$0] != nil && !running.contains($0) }
        guard !pending.isEmpty else { return running }
        var waited: TimeInterval = 0
        while waited < Self.launchRegistrationTimeout && !pending.allSatisfy(running.contains) {
            sleep(0.1)
            waited += 0.1
            running = env.runningBundleIDs()
        }
        f["launch_wait_ms"] = .number((waited * 1000).rounded())
        return running
    }

    private func recordInterception(at pt: CGPoint, region: CGRect?, by: String) {
        let r = region ?? CGRect(x: pt.x - 0.5, y: pt.y - 0.5, width: 1, height: 1)
        interceptions.append(Interception(region: r, by: by, windows: env.currentWindowFrames()))
        if interceptions.count > 16 { interceptions.removeFirst(interceptions.count - 16) }
    }

    // MARK: - Checks (PLAN-v2 §5.3)

    /// Grant present and unexpired, app not hard-denied, app inside the grant.
    @discardableResult
    func checkApp(taskID: String, app: String) throws -> Grant {
        let grant = try activeGrant(taskID)
        // Defense in depth: grants.set already refuses these, but a grant must never be the only barrier.
        try GrantRules.checkGrantable(app, source: grant.source, config: config, settings: settings)
        try checkNotHost(taskID, app)
        guard grant.covers(app) else { throw Denial("not_granted", "\(app) is not in task \(taskID)'s grant") }
        return grant
    }

    /// Returns the verified global points of the targets (element centres or declared points).
    @discardableResult
    func precheck(_ taskID: String, _ app: String, targets: [Target], chord: String?, snapshotGen: Int?,
                          _ f: inout [String: JSONValue]) throws -> [CGPoint] {
        f["task_id"] = .string(taskID)
        f["app"] = .string(app)
        if let g = snapshotGen { f["snapshot_gen"] = .number(Double(g)) }
        try checkApp(taskID: taskID, app: app)
        try requireUnlocked()

        if let chord {
            let parsed: KeyChord
            do { parsed = try KeyChord.parse(chord) } catch {
                throw Denial("invalid_chord", "cannot parse chord \"\(Self.clip(chord))\": \(error)")
            }
            f["chord"] = .string(parsed.description)
            if let why = ChordPolicy.refusal(for: parsed, in: app, settings: settings.chords) {
                throw Denial("chord_not_allowed", "\(parsed): \(why)")
            }
        }

        let resolved = try targets.map { try resolve($0, app: app, snapshotGen: snapshotGen) }
        let points = resolved.map(\.point)
        let windows = resolved.map(\.window)

        // A hard-denied app in front (e.g. a link in the target launched a terminal) halts everything:
        // re-activating the target and carrying on would hide that something escaped.
        if let front = env.frontmostBundleID(), let e = HardDeny.entry(for: front) {
            throw Denial("hard_denied_frontmost", "\(e.bundleID) (\(e.reason)) is frontmost; all actions stop")
        }

        // Activation after the cheap checks (it has a side effect), hit-testing after activation
        // (the target's window is only expected on top once it is frontmost).
        guard env.activate(bundleID: app.lowercased(), timeout: Self.activationTimeout, method: activationMethod) else {
            throw Denial("activation_failed", "\(app) did not become frontmost within \(Int(Self.activationTimeout * 1000))ms")
        }
        for (pt, window) in zip(points, windows) {
            let hit = env.hitTest(at: pt)
            guard !hit.overlayUnknown || hit.cg?.caseInsensitiveCompare(app) == .orderedSame else {
                throw Denial("overlay_state_unknown", "the Dock did not report its visible area, so (\(pt.x), \(pt.y)) "
                             + "cannot be verified; retry in a moment (it does not answer while it animates a launch)")
            }
            guard let cg = hit.cg, cg.caseInsensitiveCompare(app) == .orderedSame else {
                throw Denial("hit_test_failed", "topmost window at (\(pt.x), \(pt.y)) belongs to \(hit.cg ?? "no window"), not \(app)")
            }
            // The window list shows the target on top, but the click would be routed elsewhere: an invisible window
            // of another app, or AX could not tell (fail closed). Remembered so the next observe flags the area.
            // Except an app that does not implement the AX hit test (WeChat 4): then the window list decides with
            // invisible windows counted, so an alpha-0 window that takes clicks over it still refuses (HitTest).
            let axAgrees = hit.ax?.caseInsensitiveCompare(app) == .orderedSame
            let listOnly = !axAgrees && hit.ax == nil && hit.axNotImplemented
                && hit.cgWithInvisible?.caseInsensitiveCompare(app) == .orderedSame
            if listOnly { f["hit_test"] = "window_list_only" }
            guard axAgrees || listOnly else {
                let by = hit.ax ?? (hit.axNotImplemented ? hit.cgWithInvisible : nil) ?? "unknown"
                recordInterception(at: pt, region: hit.axRegion, by: by)
                throw Denial("hit_test_failed", "a click at (\(pt.x), \(pt.y)) would go to \(by), not \(app), although the "
                             + "window list shows \(app) on top", data: ["intercepted_by": .string(by), "region": hit.axRegion?.json ?? .null])
            }
            // Element targets: the element's own window must be on top there, not another window of the same app.
            if let window, env.topWindowID(at: pt) != window {
                throw Denial("hit_test_failed", "the element's window \(window) is covered at (\(pt.x), \(pt.y)) by another window")
            }
        }
        return points
    }

    /// Element and coordinate targets are only meaningful against the snapshot they were read from; anything
    /// that changed since (element re-read differs, window moved or resized) is refused, never guessed.
    /// The verified point, plus the element's own window when the target is an element (checked after activation).
    private func resolve(_ t: Target, app: String, snapshotGen: Int?) throws -> (point: CGPoint, window: UInt32?) {
        if t.elementId == nil {
            guard let p = t.point else { throw RPCFailure(.invalidParams, "target needs element_id or point") }
            guard settings.behavior.allowPointTargets else {
                throw Denial("point_targets_off", "coordinate targets are switched off in the settings; target an element")
            }
            guard let space = p.space else {
                throw Denial("undeclared_coordinate_space", "point must declare space: \"screen\", \"image\" or \"zoom\"")
            }
            guard space == "screen" || space == "image" || space == "zoom" else {
                throw Denial("unknown_coordinate_space", "unknown coordinate space \"\(Self.clip(space))\"")
            }
        }
        guard let gen = snapshotGen else {
            throw Denial("snapshot_required", "element and coordinate targets must carry the snapshot_gen they came from")
        }
        guard let snap = snapshots.get(gen) else {
            throw Denial("stale_snapshot", "snapshot \(gen) is no longer retained; observe again")
        }

        if let id = t.elementId {
            guard let se = snap.elements[id] else { throw Denial("unknown_element", "element \(Self.clip(id)) is not in snapshot \(gen)") }
            guard se.app?.caseInsensitiveCompare(app) == .orderedSame else {
                throw Denial("element_not_in_app", "element \(id) does not belong to \(app)")
            }
            switch se.source {
            case .ax:
                guard let h = se.handle, let now = env.refreshElement(handle: h) else {
                    throw Denial("stale_element", "element \(id) no longer exists")
                }
                guard now.fingerprint == se.fingerprint, let fr = now.frame else {
                    throw Denial("stale_element", "element \(id) changed since snapshot \(gen); observe again")
                }
                return (CGPoint(x: fr.midX, y: fr.midY), se.windowID)
            case .ocr:
                guard let wid = se.windowID, let fr = se.frame, windowUnchanged(wid, in: snap) else {
                    throw Denial("stale_element", "the window of element \(id) moved, resized or closed since snapshot \(gen)")
                }
                // The window staying put does not mean the text did: a list can reorder under a still window
                // (T11). The pixels under the element must match the snapshot's, or it is stale.
                let centre = CGPoint(x: fr.midX, y: fr.midY)
                guard let (capturedID, ref) = snap.windowThumbs[wid].map({ (wid, $0) })
                        ?? snap.windowThumbs.first(where: { $0.value.frame.contains(centre) }).map({ ($0.key, $0.value) }),
                      let now = env.windowThumb(windowID: capturedID) else {
                    throw Denial("stale_element", "element \(id)'s window cannot be re-checked; observe again")
                }
                let local = fr.offsetBy(dx: -ref.frame.minX, dy: -ref.frame.minY)
                if OCRCache().regionChanged(ref.thumb, now, localRect: local) {
                    throw Denial("stale_element", "the content under element \(id) changed since snapshot \(gen); observe again")
                }
                return (centre, wid)
            }
        }

        let p = t.point!  // non-nil: checked above
        var pt = CGPoint(x: p.x, y: p.y)
        if p.space == "image" {
            guard let d = snap.desktop, let size = snap.sentSize else {
                throw Denial("no_image_mapping", "snapshot \(gen) has no image; observe with include_image")
            }
            pt = d.screenPoint(fromSentPixel: pt, sentSize: size)
        }
        if p.space == "zoom" {
            guard let zid = p.zoomId, let z = zooms.get(zid) else {
                throw Denial("unknown_zoom", "zoom \(Self.clip(p.zoomId ?? "(none)")) is not retained; zoom again")
            }
            guard z.baseGen == gen else {
                throw Denial("zoom_snapshot_mismatch", "zoom \(z.id) belongs to snapshot \(z.baseGen), not \(gen)")
            }
            pt = z.screenPoint(fromZoomPixel: pt)
        }
        guard let w = Composite.topmost(at: pt, in: snap.zOrder), w.app == app.lowercased() else {
            throw Denial("not_on_target_window", "in snapshot \(gen) the point (\(pt.x), \(pt.y)) was not on a window of \(app)")
        }
        guard windowUnchanged(w.id, in: snap) else {
            throw Denial("stale_coordinates", "window \(w.id) moved or resized since snapshot \(gen); observe again")
        }
        return (pt, nil)
    }

    private func windowUnchanged(_ id: UInt32, in snap: Snapshot) -> Bool {
        guard let then = snap.zOrder.first(where: { $0.id == id })?.frame, let now = env.currentWindowFrames()[id] else {
            return false
        }
        return abs(then.minX - now.minX) < 0.5 && abs(then.minY - now.minY) < 0.5
            && abs(then.width - now.width) < 0.5 && abs(then.height - now.height) < 0.5
    }

    /// Client-supplied strings echoed into denials/audit are clipped (audit L1).
    static func clip(_ s: String) -> String { s.count > 32 ? String(s.prefix(32)) + "…" : s }

    private static func describe(_ error: Error) -> String {
        switch error {
        case DecodingError.keyNotFound(let key, _): return "missing param \(key.stringValue)"
        case DecodingError.typeMismatch(_, let ctx), DecodingError.valueNotFound(_, let ctx):
            return "bad param \(ctx.codingPath.map(\.stringValue).joined(separator: "."))"
        default: return "invalid params"
        }
    }
}

// Observation, zoom and Electron AX handling: an extension in the same file (it sees the class's private state)
// only to keep the class body within SwiftLint's type_body_length.
extension Dispatcher {
    // MARK: - Zoom

    /// cu_zoom (ZoomPolicy). The rect comes from an element or a point rect of a retained snapshot that has an
    /// overview image; the granted windows under it must be unchanged since that snapshot, and no granted window
    /// may have appeared there since. Pixels come from a fresh capture composited with occlusion blocks, exactly
    /// like the overview, so a zoom can never show more of other apps than the overview does.
    private func zoom(_ p: ZoomParams, _ f: inout [String: JSONValue]) throws -> JSONValue {
        let grant = try activeGrant(p.taskId)
        let privacy = settings.privacy
        guard privacy.sendZoom, privacy.sendScreenshots else {
            throw Denial("zoom_off", "zoomed images are switched off in the settings")
        }
        guard let gen = p.snapshotGen else {
            throw Denial("snapshot_required", "zoom must carry the snapshot_gen of the observation it zooms into")
        }
        guard let snap = snapshots.get(gen) else {
            throw Denial("stale_snapshot", "snapshot \(gen) is no longer retained; observe again")
        }
        guard let display = snap.desktop, let overview = snap.sentSize else {
            throw Denial("no_image_mapping", "snapshot \(gen) has no image; observe with include_image")
        }
        guard (p.elementId == nil) != (p.rect == nil) else {
            throw RPCFailure(.invalidParams, "give exactly one of element_id or rect")
        }
        let rect: CGRect
        if let id = p.elementId {
            guard let se = snap.elements[id], let fr = se.frame else {
                throw Denial("unknown_element", "element \(Self.clip(id)) is not in snapshot \(gen)")
            }
            rect = fr.insetBy(dx: -ZoomPolicy.elementPaddingPt, dy: -ZoomPolicy.elementPaddingPt)
        } else {
            let r = p.rect!  // non-nil: checked above
            guard [r.x, r.y, r.w, r.h].allSatisfy(\.isFinite), r.w > 0, r.h > 0 else {
                throw RPCFailure(.invalidParams, "rect needs finite x, y and positive w, h")
            }
            switch r.space {
            case "screen"?:
                rect = CGRect(x: r.x, y: r.y, width: r.w, height: r.h)
            case "image"?:
                let a = display.screenPoint(fromSentPixel: CGPoint(x: r.x, y: r.y), sentSize: overview)
                let b = display.screenPoint(fromSentPixel: CGPoint(x: r.x + r.w, y: r.y + r.h), sentSize: overview)
                rect = CGRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y)
            case nil:
                throw Denial("undeclared_coordinate_space", "rect must declare space: \"screen\" or \"image\"")
            case let other?:
                throw Denial("unknown_coordinate_space", "unknown coordinate space \"\(Self.clip(other))\"")
            }
        }
        f["rect_pt"] = rect.json

        let plan: ZoomPolicy.Plan
        switch ZoomPolicy.plan(rect: rect, display: display, overviewSent: overview) {
        case .success(let pl): plan = pl
        case .failure(.empty): throw Denial("zoom_outside_display", "the zoom rect does not overlap the display")
        case .failure(.notMagnifying(let m)):
            throw Denial("zoom_not_magnifying", "at the pixel budget this rect shows no more detail than the overview "
                         + "(x\(Self.round2(m))); use a smaller rect, or cu_observe")
        }
        let zoomRect = plan.geometry.contentRect
        let covered = snap.zOrder.filter { $0.granted && $0.frame.intersects(zoomRect) && !snap.sheetIDs.contains($0.id) }
        guard !covered.isEmpty else {
            throw Denial("not_on_granted_window", "in snapshot \(gen) the zoom rect covers no granted window")
        }
        // The privacy settings hold for zooms as for the overview (VM round 17, 2026-10-17: with OCR off a zoom still
        // sent its OCR text): a text-only app's windows are drawn as blocks, never captured; no OCR when it is off.
        let under = covered.filter { !($0.app.map(privacy.isTextOnly) ?? false) }
        guard !under.isEmpty else {
            throw Denial("zoom_off", "the zoom rect covers only apps whose screenshots are switched off in the settings")
        }
        if under.count < covered.count { f["image_off_windows"] = .number(Double(covered.count - under.count)) }
        for w in under where !windowUnchanged(w.id, in: snap) {
            throw Denial("stale_coordinates", "window \(w.id) moved or resized since snapshot \(gen); observe again")
        }

        let running = env.runningBundleIDs()
        var apps: [String] = []
        for id in grant.bundleIDs.map({ $0.lowercased() }) where running.contains(id) && book.hostApp[p.taskId] != id {
            try GrantRules.checkGrantable(id, source: grant.source, config: config, settings: settings)
            if !privacy.isTextOnly(id) { apps.append(id) }
        }
        var ocr = p.ocr ?? true
        if ocr && !privacy.sendOCR { ocr = false; f["ocr_off"] = "settings" }
        let r = env.zoom(ZoomRequest(geometry: plan.geometry, sentSize: plan.sentSize, windows: Set(under.map(\.id)),
                                     apps: apps, ocr: ocr))
        let known = Set(snap.zOrder.map(\.id))
        if r.zOrder.contains(where: { $0.granted && !known.contains($0.id) && $0.frame.intersects(zoomRect) }) {
            throw Denial("stale_coordinates", "a window appeared in the zoom rect since snapshot \(gen); observe again")
        }

        f["magnification"] = .number(Self.round2(plan.magnification))
        f["sent_size_px"] = [.number(plan.sentSize.width), .number(plan.sentSize.height)]
        f["ocr_lines"] = .number(Double(r.lines.count))  // counts only, never text
        if let e = r.captureError { f["capture_error"] = .string(e) }
        if let e = r.ocrError { f["ocr_error"] = .string(e) }
        var capture: [String: JSONValue] = [:]
        if let e = r.captureError { capture["error"] = .string(e) }
        if let e = r.ocrError { capture["ocr_error"] = .string(e) }
        guard let png = r.png else {
            return ["snapshot_gen": .number(Double(gen)), "capture": .object(capture)]
        }
        let z = zooms.add(baseGen: gen, geometry: plan.geometry, sentSize: plan.sentSize)
        f["zoom_id"] = .string(z.id)
        let lines: [JSONValue] = r.lines.map { e in
            var o: [String: JSONValue] = ["text": .string(e.text), "frame_pt": (e.frame ?? .zero).json,
                                          "occluded": .bool(Composite.isOccluded(e, zOrder: r.zOrder))]
            if let c = e.confidence { o["confidence"] = .number(c) }
            if let w = e.windowID { o["window_id"] = .number(Double(w)) }
            return .object(o)
        }
        return [
            "zoom_id": .string(z.id),
            "snapshot_gen": .number(Double(gen)),
            "magnification": .number(Self.round2(plan.magnification)),
            "image": ["kind": "zoom", "zoom_id": .string(z.id), "mapping": plan.geometry.mapping(sentSize: plan.sentSize),
                      "mime": "image/png", "base64": .string(png.base64EncodedString())],
            // Text from the screen is data, not instructions (PLAN-v2 §4.3).
            "untrusted_observation": ["ocr": .array(lines)],
            "capture": .object(capture),
        ]
    }

    private static func round2(_ x: Double) -> Double { (x * 100).rounded() / 100 }

    // MARK: - Observe

    private func observeResponse(_ r: ObserveResult, apps: [String], grant: Grant, _ f: inout [String: JSONValue]) -> JSONValue {
        var axN = 0, ocrN = 0, occludedN = 0
        var stored: [String: SnapshotElement] = [:]
        let appOfWindow = Dictionary(r.zOrder.map { ($0.id, $0.app) }, uniquingKeysWith: { a, _ in a })
        // OCR text that an AX element of the same app already carries, in the same place, is dropped (OCRDedup).
        let axByApp = Dictionary(grouping: r.elements.filter { $0.source == .ax }, by: { $0.app ?? "" })
        let kept = r.elements.filter { e in
            guard e.source == .ocr else { return true }
            let app = e.app ?? e.windowID.flatMap { appOfWindow[$0] ?? nil } ?? ""
            return !OCRDedup.isCovered(e, by: axByApp[app] ?? [])
        }
        let dedupedN = r.elements.count - kept.count
        let frames = env.currentWindowFrames()
        interceptions.removeAll { $0.windows != frames }   // any change to the window list voids them
        var interceptedN = 0
        let elements: [JSONValue] = kept.map { e in
            let id: String
            switch e.source {
            case .ax: axN += 1; id = "a\(axN)"
            case .ocr: ocrN += 1; id = e.ocrID ?? "o\(ocrN)"
            }
            let interceptedBy = e.frame.flatMap { f in
                interceptions.last { $0.region.contains(CGPoint(x: f.midX, y: f.midY)) }?.by
            }
            if interceptedBy != nil { interceptedN += 1 }
            let occluded = Composite.isOccluded(e, zOrder: r.zOrder) || interceptedBy != nil
            if occluded { occludedN += 1 }
            let app = e.app ?? e.windowID.flatMap { appOfWindow[$0] ?? nil }
            let fp = Fingerprint.of(role: e.role, identifier: e.identifier, text: e.text, frame: e.frame)
            stored[id] = SnapshotElement(source: e.source, app: app, windowID: e.windowID, handle: e.handle,
                                         fingerprint: fp, frame: e.frame)
            var o: [String: JSONValue] = ["id": .string(id), "source": .string(e.source.rawValue),
                                          "key": .string(Fingerprint.key(source: e.source, windowID: e.windowID, fingerprint: fp)),
                                          "text": .string(e.source == .ax && !settings.privacy.sendAXText ? "" : e.text),
                                          "frame_pt": e.frame.json, "occluded": .bool(occluded)]
            if let a = app { o["app"] = .string(a) }
            if let role = e.role { o["role"] = .string(role) }
            if let c = e.confidence { o["confidence"] = .number(c) }
            if let w = e.windowID { o["window_id"] = .number(Double(w)) }
            if let by = interceptedBy { o["intercepted_by"] = .string(by) }
            return .object(o)
        }
        if interceptedN > 0 { f["intercepted_elements"] = .number(Double(interceptedN)) }
        snapshots.add(Snapshot(gen: snapshotGen, zOrder: r.zOrder, elements: stored, desktop: r.desktop, sentSize: r.compositeSize,
                               sheetIDs: r.sheetIDs, windowThumbs: r.windowThumbs))
        f["occluded"] = .number(Double(occludedN))
        // Audit: counts only, never element text.
        f["apps"] = .array(apps.map { .string($0) })
        f["ax_nodes"] = .number(Double(r.axStats.reduce(0) { $0 + $1.nodes }))
        f["ax_malformed"] = .number(Double(r.axStats.reduce(0) { $0 + $1.malformed }))
        f["ax_elements"] = .number(Double(axN))
        f["ocr_lines"] = .number(Double(ocrN))
        f["ocr_deduped"] = .number(Double(dedupedN))
        f["images"] = .number(r.compositePNG == nil ? 0 : 1)
        // Granted windows (nearly) all under other apps' windows: grey in the image. Said, with what covers them.
        let display = r.desktop?.contentRect ?? r.zOrder.filter(\.granted).reduce(CGRect.null) { $0.union($1.frame) }
        let covered = Composite.coverage(zOrder: r.zOrder, display: display).filter { $0.fraction >= Composite.coveredFraction }
        if !covered.isEmpty { f["covered_windows"] = .number(Double(covered.count)) }
        if let w = r.windowWait { f["window_wait_ms"] = .number((w.elapsed * 1000).rounded()) }
        if let err = r.captureError { f["capture_error"] = .string(err) }
        if let err = r.ocrError { f["ocr_error"] = .string(err) }

        var out: [String: JSONValue] = [
            "snapshot_gen": .number(Double(snapshotGen)),
            "frontmost": env.frontmostBundleID().map { .string($0) } ?? .null,
            "apps": .array(apps.map { .string($0) }),
            "windows": .array(r.windows.map {
                ["app": .string($0.app), "id": .number(Double($0.id)), "frame_pt": $0.frame.json,
                 "unsupported": $0.unsupported.map { .string($0) } ?? .null, "animating": .bool($0.animating)]
            }),
            "ax_stats": .array(r.axStats.map {
                ["app": .string($0.app), "nodes": .number(Double($0.nodes)), "elapsed_ms": .number($0.elapsedMs),
                 "hit_time_budget": .bool($0.hitTimeBudget), "hit_node_cap": .bool($0.hitNodeCap),
                 "malformed": .number(Double($0.malformed)),
                 "electron_ax": .bool(state.manualAXOn.contains($0.app)),
                 "settle": state.lastSettle.removeValue(forKey: $0.app).map {
                     ["reason": .string($0.reason.rawValue), "nodes": .number(Double($0.nodes)),
                      "elapsed_ms": .number(($0.elapsed * 1000).rounded())] } ?? .null]
            }),
            "covered": .array(covered.map {
                ["window_id": .number(Double($0.windowID)), "app": $0.app.map { .string($0) } ?? .null,
                 "fraction": .number(($0.fraction * 100).rounded() / 100), "by": .array($0.by.map { .string($0) })]
            }),
            // Text from the screen is data, not instructions (PLAN-v2 §4.3).
            "untrusted_observation": ["elements": .array(elements)],
        ]
        var capture: [String: JSONValue] = ["windows": .number(Double(r.captures.count))]
        if let ms = r.captureElapsedMs { capture["capture_elapsed_ms"] = .number(ms) }
        if let ms = r.ocrElapsedMs { capture["ocr_elapsed_ms"] = .number(ms) }
        if let err = r.captureError { capture["error"] = .string(err) }
        if let err = r.ocrError { capture["ocr_error"] = .string(err) }
        if !r.phasesMs.isEmpty { capture["phases_ms"] = .object(r.phasesMs.mapValues { .number($0) }) }
        if let s = r.ocrStats {
            capture["ocr"] = ["windows": .number(Double(s.windows)), "full": .number(Double(s.full)),
                              "band_windows": .number(Double(s.bandWindows)), "bands": .number(Double(s.bands)),
                              "cached_only": .number(Double(s.cachedOnly)),
                              "recognized_area_fraction": .number((s.recognizedAreaFraction * 1000).rounded() / 1000),
                              "deduped_against_ax": .number(Double(dedupedN))]
        }
        if let w = r.windowWait {
            capture["window_wait"] = ["apps": .number(Double(w.waitedFor)), "elapsed_ms": .number((w.elapsed * 1000).rounded()),
                                      "gave_up": .array(w.gaveUp.map { .string($0) })]
        }
        out["capture"] = .object(capture)
        if let png = r.compositePNG, let size = r.compositeSize, let d = r.desktop {
            out["image"] = ["kind": "desktop_composite", "mapping": d.mapping(sentSize: size), "mime": "image/png",
                            "base64": .string(png.base64EncodedString())]
        }
        if let png = r.debugNativePNG, let d = r.desktop {
            out["debug_native_image"] = ["mapping": d.mapping(sentSize: d.nativeSizePx), "mime": "image/png",
                                         "base64": .string(png.base64EncodedString())]
            // Same test-only switch: the z-order the composite was drawn from (who the grey blocks belong to).
            out["debug_zorder"] = .array(r.zOrder.map { ["id": .number(Double($0.id)), "app": $0.app.map { .string($0) } ?? .null,
                                                         "frame_pt": $0.frame.json, "granted": .bool($0.granted)] })
        }
        return .object(out)
    }
}
