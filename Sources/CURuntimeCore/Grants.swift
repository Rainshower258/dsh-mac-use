import Foundation

/// A refusal carries a stable machine-readable reason plus a human detail.
public struct Denial: Error, Equatable {
    public let reason: String
    public let detail: String
    /// Extra machine-readable fields for the client's error data and the audit line (never screen content).
    public let data: [String: JSONValue]

    public init(_ reason: String, _ detail: String, data: [String: JSONValue] = [:]) {
        self.reason = reason
        self.detail = detail
        self.data = data
    }
}

public struct PolicyConfig: Codable, Sendable {
    /// Finder can be granted only when this is set in the daemon's config file, and only by a config-sourced grant.
    public var allowFinder: Bool
    /// Test harness only (VM geometry suite): observe may return native-resolution composites. Audited when used; only
    /// a bench build starts with it on (LaunchPolicy), as with the other test-harness switches below.
    public var debugNativeImages: Bool
    /// How actions bring the target app to the front (ActivationMethod raw value); the default is the method that
    /// measured most reliable (bench/experiments/activation.py). Every method is followed by the same verification.
    public var activationMethod: String?
    /// Test harness only (VM activation experiment): enables runtime.debug_activate.
    public var debugActivation: Bool
    /// Test harness only (VM input method experiment): enables runtime.debug_ime.
    public var debugIme: Bool
    /// grants.set over the socket (config-sourced grants without a dialog). Off unless the config file turns it on:
    /// daily use approves apps only through access.request and the daemon's own dialog. The bench, which grants its
    /// fixture and apps up front, turns it on in its throwaway clones.
    public var configGrants: Bool

    public init(allowFinder: Bool = false, debugNativeImages: Bool = false, activationMethod: String? = nil,
                debugActivation: Bool = false, debugIme: Bool = false, configGrants: Bool = false) {
        self.allowFinder = allowFinder
        self.debugNativeImages = debugNativeImages
        self.activationMethod = activationMethod
        self.debugActivation = debugActivation
        self.debugIme = debugIme
        self.configGrants = configGrants
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        allowFinder = try c.decodeIfPresent(Bool.self, forKey: .allowFinder) ?? false
        debugNativeImages = try c.decodeIfPresent(Bool.self, forKey: .debugNativeImages) ?? false
        activationMethod = try c.decodeIfPresent(String.self, forKey: .activationMethod)
        debugActivation = try c.decodeIfPresent(Bool.self, forKey: .debugActivation) ?? false
        debugIme = try c.decodeIfPresent(Bool.self, forKey: .debugIme) ?? false
        configGrants = try c.decodeIfPresent(Bool.self, forKey: .configGrants) ?? false
    }
}

/// The daemon methods a grant's action allowlist (`actions` on grants.set) can name. The plugin's cu_read_text is a
/// zoom without the image, so it needs `zoom` here.
public enum ActionKind: String, CaseIterable, Sendable {
    case observe, zoom, click, scroll, drag, type, key, launch, menu
    case setValue = "set_value", axAction = "ax_action"

    /// The kind a method needs, or nil for methods every grant may use (grants.*, apps.list, runtime.*, ime.approve).
    public static func of(method: String) -> ActionKind? {
        switch method {
        case "observe": return .observe
        case "zoom": return .zoom
        case "apps.launch": return .launch
        case let m where m.hasPrefix("act."): return ActionKind(rawValue: String(m.dropFirst(4)))
        default: return nil
        }
    }
}

/// `click_limit` on grants.set: which buttons and how many clicks per act.click this task may use. T7 needs left
/// single clicks only: no double click (QQ "pokes" on a double-clicked avatar), no context menu (delete chat).
public struct ClickLimit: Sendable, Equatable {
    public let buttons: Set<MouseButton>
    public let maxCount: Int

    public init(buttons: Set<MouseButton>, maxCount: Int) {
        self.buttons = buttons
        self.maxCount = maxCount
    }

    var json: JSONValue {
        ["buttons": .array(buttons.map(\.rawValue).sorted().map { .string($0) }), "max_count": .number(Double(maxCount))]
    }
}

/// The client a person's approvals belong to: the peer that asked for them (PID, PID version and executable, from
/// the connection's audit token). Approvals answer one person in one client; another process that reaches the socket
/// (with the token, as any code of this user can) does not get to use them. All three must match, so a later process
/// on a reused PID does not either (R6); an unknown PID or version never matches.
public struct GrantOwner: Sendable, Equatable {
    public let pid: Int32?
    public let pidVersion: Int32?
    public let path: String?

    public init(_ conn: ConnectionInfo) {
        pid = conn.peerPID
        pidVersion = conn.peerPIDVersion
        path = conn.peerPath
    }

    public func matches(_ conn: ConnectionInfo) -> Bool {
        pid != nil && pidVersion != nil && pid == conn.peerPID && pidVersion == conn.peerPIDVersion && path == conn.peerPath
    }

    /// This connection's process holds the owner's PID but is not the owner: the owner has exited.
    public func isSucceeded(by conn: ConnectionInfo) -> Bool {
        pid != nil && pid == conn.peerPID && conn.peerPIDVersion != nil && pidVersion != conn.peerPIDVersion
    }
}

public struct Grant: Sendable, Equatable {
    public enum Source: String, Sendable { case config, approval }

    public let taskID: String
    public let bundleIDs: [String]
    public let allowLaunch: Bool
    public let expiresAt: Date
    public let source: Source
    /// `electron_ax`: set Electron's AXManualAccessibility on the granted apps so their web content appears in
    /// the AX tree. It changes the target app's behaviour, so it is off unless the task explicitly asks, and
    /// every switch on/off is audited. Turned back off when no active grant wants it.
    public let electronAX: Bool
    /// `ime_policy`: whether typing may switch the (global) input source away from an input method (ChangePolicy).
    /// Default leave: nothing outside the granted app changes unless the task asks.
    public let imePolicy: ChangePolicy
    /// `actions`: the only methods this task may call (ActionKind); nil = no task-level limit. A real messenger
    /// task that only reads (T7) leaves out type, key and set_value, so nothing can be sent however the model tries.
    public let actions: Set<ActionKind>?
    /// `click_limit`: nil = any button, 1–3 clicks.
    public let clickLimit: ClickLimit?
    /// Apps a person approved in the daemon's own dialog (access.request), by lowercased bundle ID: each with its
    /// mode (read | full), scope (turn | session | always) and expiry. Their bundle IDs are also in `bundleIDs`.
    /// Apps without an entry (grants.set) have no per-app limit beyond `actions` and `click_limit`.
    public let access: [String: AppAccess]
    /// Below an `access` entry, a narrower approval of the same app that outlives it (AppAccess.layers): what the
    /// app falls back to when the entry above ends (a turn's full over a session's read: read again after the turn).
    public let fallback: [String: AppAccess]
    /// Set for a grant made of a person's approvals (GrantOwner); nil for a config grant (grants.set, the bench).
    public let owner: GrantOwner?

    public init(taskID: String, bundleIDs: [String], allowLaunch: Bool, expiresAt: Date, source: Source,
                electronAX: Bool = false, imePolicy: ChangePolicy = .leave, actions: Set<ActionKind>? = nil,
                clickLimit: ClickLimit? = nil, access: [String: AppAccess] = [:], fallback: [String: AppAccess] = [:],
                owner: GrantOwner? = nil) {
        self.taskID = taskID
        self.bundleIDs = bundleIDs
        self.allowLaunch = allowLaunch
        self.expiresAt = expiresAt
        self.source = source
        self.electronAX = electronAX
        self.imePolicy = imePolicy
        self.actions = actions
        self.clickLimit = clickLimit
        self.access = access
        self.fallback = fallback
        self.owner = owner
    }

    public func allows(_ kind: ActionKind) -> Bool { actions?.contains(kind) ?? true }

    /// The mode a person approved for `app`, or nil if it has no per-app entry.
    public func mode(of app: String) -> AppMode? { access[app.lowercased()]?.mode }

    /// The action allowlist, checked before any handler runs (an unlisted method never reaches the screen): the
    /// task's `actions`, then the target app's mode. A read-mode app allows observe, zoom, click and scroll, and of
    /// ax_action only `AppMode.readAXActions` (`axAction`, the action's exact name). Without a target app (observe,
    /// zoom) only the task's list applies: both modes allow those.
    func checkAllows(_ kind: ActionKind, app: String? = nil, axAction: String? = nil) throws {
        guard allows(kind) else {
            throw Denial("action_not_allowed", "task \(taskID)'s grant does not allow \(kind.rawValue)",
                         data: ["action": .string(kind.rawValue)])
        }
        guard !AppMode.readKinds.contains(kind) else { return }
        if kind == .axAction, app != nil, let a = axAction, AppMode.readAXActions.contains(a) { return }
        let readOnly = if let app { mode(of: app) == .read } else {
            // An action with no target app while some app is read-only: refuse rather than guess (fail closed).
            access.values.contains { $0.mode == .read }
        }
        guard readOnly else { return }
        throw Denial("action_not_allowed", "\(app ?? "the target app") is granted read-only (observe, zoom, left click, "
                     + "scroll, AXPress, AXRaise); \(kind.rawValue) needs the full mode",
                     data: ["action": .string(kind.rawValue), "app_mode": "read", "needs_mode": "full"])
    }

    /// click_limit, then the read mode's own limit (left single clicks): refused before anything (activation
    /// included) happens.
    func checkClick(button: MouseButton, count: Int, app: String? = nil) throws {
        if let limit = clickLimit, !limit.buttons.contains(button) || count > limit.maxCount {
            throw Denial("click_not_allowed", "task \(taskID)'s grant allows only \(limit.buttons.map(\.rawValue).sorted().joined(separator: "/")) "
                         + "clicks, at most \(limit.maxCount) at a time", data: ["button": .string(button.rawValue), "count": .number(Double(count))])
        }
        let read = AppMode.readClickLimit
        if let app, mode(of: app) == .read, !read.buttons.contains(button) || count > read.maxCount {
            throw Denial("click_not_allowed", "\(app) is granted read-only: left single clicks only",
                         data: ["button": .string(button.rawValue), "count": .number(Double(count)), "app_mode": "read",
                                "needs_mode": "full"])
        }
    }

    /// This grant with `a` added to the app's approvals, kept as two layers (AppAccess.layers); the grant lives at
    /// least as long as it. The result belongs to `newOwner`, the client the approval was given to, so an approval
    /// never lands in a grant another client can use: a config grant (no owner) it joins becomes the requester's, and
    /// give() never merges into another client's grant.
    func adding(_ a: AppAccess, owner newOwner: GrantOwner) -> Grant {
        let key = a.bundleID.lowercased()
        var acc = access, below = fallback
        let l = AppAccess.layers([a] + [access[key], fallback[key]].compactMap { $0 })
        acc[key] = l?.top
        below[key] = l?.below
        let ids = covers(a.bundleID) ? bundleIDs : bundleIDs + [a.bundleID]
        return Grant(taskID: taskID, bundleIDs: ids, allowLaunch: allowLaunch, expiresAt: max(expiresAt, a.expiresAt),
                     source: source, electronAX: electronAX, imePolicy: imePolicy, actions: actions, clickLimit: clickLimit,
                     access: acc, fallback: below, owner: newOwner)
    }

    /// This grant without the per-app approvals `drop` selects: an app whose top approval goes falls back to the one
    /// below it, if that stays; an app with none left goes (with its bundle ID). Nil when no app is left.
    func removing(where drop: (AppAccess) -> Bool) -> Grant? {
        var acc = access, below = fallback, gone = Set<String>()
        for key in access.keys {
            let l = AppAccess.layers([access[key], fallback[key]].compactMap { $0 }.filter { !drop($0) })
            acc[key] = l?.top
            below[key] = l?.below
            if l == nil { gone.insert(key) }
        }
        guard acc != access || below != fallback else { return self }
        let ids = bundleIDs.filter { !gone.contains($0.lowercased()) }
        guard !ids.isEmpty else { return nil }
        return Grant(taskID: taskID, bundleIDs: ids, allowLaunch: allowLaunch, expiresAt: expiresAt, source: source,
                     electronAX: electronAX, imePolicy: imePolicy, actions: actions, clickLimit: clickLimit,
                     access: acc, fallback: below, owner: owner)
    }

    public func covers(_ bundleID: String) -> Bool {
        bundleIDs.contains { $0.caseInsensitiveCompare(bundleID) == .orderedSame }
    }

    var json: JSONValue {
        [
            "task_id": .string(taskID),
            "bundle_ids": .array(bundleIDs.map { .string($0) }),
            "allow_launch": .bool(allowLaunch),
            "expires_at": .number(expiresAt.timeIntervalSince1970),
            "source": .string(source.rawValue),
            "electron_ax": .bool(electronAX),
            "ime_policy": .string(imePolicy.rawValue),
            "actions": actions.map { a in .array(a.map(\.rawValue).sorted().map { .string($0) }) } ?? .null,
            "click_limit": clickLimit?.json ?? .null,
            "access": .array(access.keys.sorted().compactMap { access[$0]?.json }),
            "fallback": .array(fallback.keys.sorted().compactMap { fallback[$0]?.json }),
        ]
    }
}

public enum GrantRules {
    public static let defaultTTL: TimeInterval = 3600
    public static let maxTTL: TimeInterval = 24 * 3600

    /// grants.set `actions` and `click_limit`, validated: unknown names are invalid params, never ignored.
    static func actionLimits(_ p: GrantSetParams) throws -> (Set<ActionKind>?, ClickLimit?) {
        let actions = try p.actions.map { names in
            Set(try names.map { n in
                guard let k = ActionKind(rawValue: n) else {
                    throw RPCFailure(.invalidParams, "unknown action \(n) (known: \(ActionKind.allCases.map(\.rawValue).joined(separator: ", ")))")
                }
                return k
            })
        }
        let clickLimit = try p.clickLimit.map { c in
            let buttons = try c.buttons.map { b in
                guard let m = MouseButton(rawValue: b) else { throw RPCFailure(.invalidParams, "click_limit: unknown button \(b)") }
                return m
            }
            guard !buttons.isEmpty, (1...3).contains(c.maxCount) else {
                throw RPCFailure(.invalidParams, "click_limit needs buttons and max_count 1–3")
            }
            return ClickLimit(buttons: Set(buttons), maxCount: c.maxCount)
        }
        return (actions, clickLimit)
    }

    /// Throws when `bundleID` may never be granted from `source`: the system floor (HardDeny), then the user's own
    /// deny list (UserSettings, the settings window), then Finder's switch.
    public static func checkGrantable(_ bundleID: String, source: Grant.Source, config: PolicyConfig,
                                      settings: UserSettings = UserSettings()) throws {
        if let e = HardDeny.entry(for: bundleID) {
            throw Denial("hard_denied", "\(e.bundleID) is hard-denied (\(e.reason)); no approval or configuration can allow it")
        }
        if let d = settings.denies(bundleID) {
            throw Denial("user_denied", "\(d.bundleId) is on the user's deny list; it is never granted to the model and never "
                         + "asked about, in any mode. Do not ask for it again", data: d.note.isEmpty ? [:] : ["note": .string(d.note)])
        }
        if bundleID.caseInsensitiveCompare(HardDeny.finder) == .orderedSame {
            guard config.allowFinder, source == .config else {
                throw Denial("finder_not_enabled", "Finder needs allow_finder in the daemon config and a config-sourced grant")
            }
        }
    }
}

/// Grants keyed by task. Accessed only from the daemon's serial worker queue.
public final class GrantStore {
    private var grants: [String: Grant] = [:]

    public init() {}

    public func set(_ grant: Grant) { grants[grant.taskID] = grant }

    @discardableResult
    public func revoke(_ taskID: String) -> Bool { grants.removeValue(forKey: taskID) != nil }

    public func all(now: Date) -> [Grant] {
        grants.keys.forEach { prune($0, now: now) }
        return grants.values.filter { $0.expiresAt > now }.sorted { $0.taskID < $1.taskID }
    }

    public func active(_ taskID: String, now: Date) throws -> Grant {
        prune(taskID, now: now)
        guard let g = grants[taskID] else { throw Denial("no_grant", "no grant for task \(taskID)") }
        guard g.expiresAt > now else {
            grants.removeValue(forKey: taskID)
            throw Denial("grant_expired", "grant for task \(taskID) expired")
        }
        return g
    }

    /// The task's grant if it has one that has not expired, without refusing.
    func current(_ taskID: String, now: Date) -> Grant? { try? active(taskID, now: now) }

    /// Drops per-app entries that expired (a session's 30 minutes); a grant left with no app goes.
    private func prune(_ taskID: String, now: Date) {
        guard let g = grants[taskID], !g.access.isEmpty else { return }
        grants[taskID] = g.removing { $0.expiresAt <= now }
    }

    /// The task's grant as stored, expired or not, without pruning (active() reports an expiry once, then drops it).
    func stored(_ taskID: String) -> Grant? { grants[taskID] }

    /// Replaces the task's grant, or removes it when nil.
    func update(_ taskID: String, _ grant: Grant?) { grants[taskID] = grant }
}
