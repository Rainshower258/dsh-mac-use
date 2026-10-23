import Foundation

// Daily use on the maintainer's Mac (PLAN-v2, "宿主机日常使用模式", 2026-10-03): an app becomes usable when a person
// approves it in the daemon's own dialog the first time the model touches it, observe included. The dialog belongs
// to this daemon (hard-denied, so the model can neither see nor click it) and shows the app as the system resolved
// it, never the model's string. "Always" is offered for signed apps in both modes (2026-10-16, P1: the plugin now
// asks for full by default, as the official cua-macos provider asks once per app); choosing it for full passes the
// device owner check (Touch ID / password) in the presenter first. The command `cu-runtime grants add --full`
// still works. Either way the app's signature is recorded at that moment.

/// What a person approved an app for. Neither mode lifts the floor: hard-deny, the chord allowlist, password
/// fields, hit tests, the frontmost check and staleness checks apply in both.
public enum AppMode: String, Sendable, CaseIterable {
    /// Look, left single clicks, scroll: nothing can be typed, sent by a key or set.
    case read
    /// Every action kind.
    case full

    public static let readKinds: Set<ActionKind> = [.observe, .zoom, .click, .scroll]
    public static let readClickLimit = ClickLimit(buttons: [.left], maxCount: 1)
    /// The AX actions a read-mode app allows: AXPress is a left single click on the element itself, AXRaise brings a
    /// window forward as that click's activation does (2026-10-03: a QQ run stalled on AXRaise refused in read mode).
    public static let readAXActions: Set<String> = ["AXPress", "AXRaise"]

    /// Whether an approval for `self` also covers a request for `other`.
    public func covers(_ other: AppMode) -> Bool { self == .full || other == .read }
}

/// How long an approval lasts.
public enum AccessScope: String, Sendable {
    /// Until the turn ends (the plugin's turn/end: access.turn_end).
    case turn
    /// The dsh session (the task), at most AccessRules.sessionLimit after the approval.
    case session
    /// The persistent list (read mode, or full added by command); in a task it lasts like a session and is
    /// re-checked against the app's signature on the next touch.
    case always
}

public struct AppAccess: Sendable, Equatable {
    public let bundleID: String
    public let mode: AppMode
    public let scope: AccessScope
    public let expiresAt: Date

    var json: JSONValue {
        ["bundle_id": .string(bundleID), "mode": .string(mode.rawValue), "scope": .string(scope.rawValue),
         "expires_at": .number(expiresAt.timeIntervalSince1970)]
    }

    /// How long it lasts, comparable: a turn's ends first (at the turn's end), then by expiry.
    private var lasts: (Int, Date) { (scope == .turn ? 0 : 1, expiresAt) }

    /// The entries one app holds, as two layers (2026-10-08: a turn's full replaced a session's read, and when the
    /// turn ended the app was gone, read included). On top the widest mode (the longest-lived of those); below it
    /// the longest-lived narrower entry that outlives the top one, if any. Entries neither layer keeps are covered.
    static func layers(_ entries: [AppAccess]) -> (top: AppAccess, below: AppAccess?)? {
        let rank = { (a: AppAccess) in (a.mode == .full ? 1 : 0, a.lasts.0, a.expiresAt) }
        guard let top = entries.max(by: { rank($0) < rank($1) }) else { return nil }
        let below = entries.filter { $0.mode != top.mode && $0.lasts > top.lasts }.max { $0.lasts < $1.lasts }
        return (top, below)
    }
}

/// An app as the system knows it: what the dialog shows instead of the model's string.
public struct AppIdentity: Sendable, Equatable {
    public let bundleID: String
    public let name: String
    public let path: String

    public init(bundleID: String, name: String, path: String) {
        self.bundleID = bundleID
        self.name = name
        self.path = path
    }

    var json: JSONValue { ["bundle_id": .string(bundleID), "name": .string(name), "path": .string(path)] }
}

/// Finds apps and reads their signatures (AppKit / Security in the daemon, a fake in tests).
public protocol AppDirectory: AnyObject {
    /// The app with this bundle ID (case-insensitive): running, or installed where LaunchServices finds it.
    func identity(bundleID: String) -> AppIdentity?
    /// Apps that go by this name (localized, display, bundle or file name; case and surrounding space ignored):
    /// running apps, and apps in /Applications, ~/Applications and /System/Applications.
    func identities(named name: String) -> [AppIdentity]
    /// The app's designated requirement as text, or nil if it has none (unsigned) or cannot be read.
    func designatedRequirement(path: String) -> String?
    /// Whether the app at `path` is validly signed and satisfies `requirement`.
    func satisfies(path: String, requirement: String) -> Bool
    /// Apps whose name is near `name` (AppNameMatch.isSimilar), running or installed where `identities(named:)`
    /// looks, at most `limit`: suggestions for a refusal, never chosen by themselves.
    func similarIdentities(to name: String, limit: Int) -> [AppIdentity]
}

extension AppDirectory {
    public func similarIdentities(to name: String, limit: Int) -> [AppIdentity] { [] }
}

/// How an app name the model gave is compared with the names apps go by.
public enum AppNameMatch {
    /// The key names are compared by: canonical composition, surrounding space trimmed, lowercased.
    public static func key(_ s: String) -> String {
        s.precomposedStringWithCanonicalMapping.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// Whether an app's `name` is near the `query` without being equal to it (2026-10-23: "Millionaire Tycoon", as the
    /// App Store shows it, for an app installed as "Millionaire"): one contains the other, or they share a word, where
    /// the shorter string or the word has at least 3 characters (2 when it holds CJK). Only ever a suggestion.
    public static func isSimilar(_ name: String, to query: String) -> Bool {
        let n = key(name), q = key(query)
        guard !n.isEmpty, !q.isEmpty, n != q else { return false }
        let shorter = n.count <= q.count ? n : q
        if longEnough(shorter) && (n.contains(q) || q.contains(n)) { return true }
        return !words(n).isDisjoint(with: words(q))
    }

    private static func longEnough(_ s: String) -> Bool {
        s.count >= 3 || (s.count >= 2 && s.unicodeScalars.contains { $0.value >= 0x2E80 })
    }

    private static func words(_ s: String) -> Set<String> {
        Set(s.split { !($0.isLetter || $0.isNumber) }.map(String.init).filter(longEnough))
    }
}

public enum DialogAnswer: String, Sendable {
    case deny, turn, session, always, timeout
}

public struct DialogRequest: Sendable {
    public let identity: AppIdentity
    public let mode: AppMode
    /// The model's reason: untrusted text, shown as "what the model says".
    public let reason: String?
    /// "Always" is offered only for a signed app (it is pinned to the signature); for the full mode the presenter
    /// verifies the device owner before it answers `.always`.
    public let offerAlways: Bool
    public let timeout: TimeInterval
    /// False when the app is not running: the dialog says so (a full approval lets the model open it, apps.launch).
    public var running: Bool = true
    /// The language of the dialog's text (ApprovalText).
    public var lang: UILanguage = .resolve(nil)
    /// The process that asked (from the connection's audit token): its executable's name and PID, or nil if unknown.
    public var requester: String?
    /// No person has approved anything for this process since the daemon started.
    public var firstFromRequester: Bool = false
    /// The button Return presses (UserSettings.access.dialogDefault); `.always` falls back to `.session` when the
    /// dialog does not offer always.
    public var defaultAnswer: DialogAnswer = .deny
}

/// Where the keyboard focus went when the dialog closed. The daemon is hard-denied, so while it stays frontmost every
/// action stops (hard_denied_frontmost); the presenter hands the focus back before it answers.
public enum DialogFocus: String, Sendable {
    /// The app that was frontmost before the dialog is frontmost again.
    case restored
    /// The daemon is no longer frontmost, but neither is the earlier app (there was none and the daemon hid itself,
    /// or another app came forward meanwhile).
    case hidden
    /// Still frontmost after the wait: the next action is refused (the safe direction).
    case failed
}

/// What became of the daemon's settings window when the dialog closed (WindowPutBack).
public enum DialogWindows: String, Sendable {
    /// Nothing to put back: it was not open, or it was where the dialog found it.
    case untouched
    /// It had moved (forward, out of the Dock, into view) or lost the key, and was put back.
    case restored
}

/// Shows the approval dialog. `completion` is called exactly once, on any thread, also on timeout (the presenter
/// closes the dialog itself, so it never outlives a client that stopped asking), and only after the focus was handed
/// back (`DialogFocus`), so the action the plugin sends next does not find the daemon frontmost, and the daemon's
/// own windows were put back where the dialog found them (`DialogWindows`).
public protocol ApprovalPresenter: AnyObject {
    func present(_ request: DialogRequest,
                 completion: @escaping @Sendable (DialogAnswer, DialogFocus?, DialogWindows?) -> Void)
}

/// The defaults; the values in force are the user's (UserSettings.access, the "modes and defaults" page, 2026-10-16):
/// the daemon reads `settings.access`, these stay as the documented defaults and the refusal memory's backstop.
public enum AccessRules {
    /// A session approval (and an always approval within a task) lasts at most this long.
    public static let sessionLimit: TimeInterval = 30 * 60
    /// The dialog closes by itself after this long; no answer counts as a refusal.
    public static let dialogTimeout: TimeInterval = 120
    /// Dialogs per task and turn; more are refused without asking (a flood of dialogs trains people to click allow).
    /// 3 since 2026-10-16 (P1; 2 was hit by every two-app task). A dialog that widens an app's read approval to full
    /// is not counted: the person already said yes to that app once.
    public static let dialogsPerTurn = 3
    /// An app the person refused is refused without asking until the turn ends (access.turn_end forgets it): the
    /// person's next message may lead to one more ask (2026-10-08: a misclicked "refuse" used to need a new session).
    /// The model cannot fake that message, so screen text steering it gets at most one ask per message, after a real
    /// refusal and with a justification. This is the backstop when no turn end arrives.
    public static let refusalMemory: TimeInterval = sessionLimit
}

// MARK: - Persistent list

/// One entry of the persistent list: the app is pinned to the designated requirement it had when it was added, so
/// another app under the same bundle ID (a different signer) does not inherit it.
public struct PersistentGrant: Codable, Equatable, Sendable {
    public let bundleId: String
    public let mode: String
    public let requirement: String
    public let path: String
    public let addedAt: Double
    /// dialog | command
    public let via: String

    public init(bundleId: String, mode: AppMode, requirement: String, path: String, addedAt: Date, via: String) {
        self.bundleId = bundleId
        self.mode = mode.rawValue
        self.requirement = requirement
        self.path = path
        self.addedAt = addedAt.timeIntervalSince1970
        self.via = via
    }

    public var appMode: AppMode? { AppMode(rawValue: mode) }

    var json: JSONValue {
        ["bundle_id": .string(bundleId), "mode": .string(mode), "requirement": .string(requirement),
         "path": .string(path), "added_at": .number(addedAt), "via": .string(via)]
    }
}

public protocol PersistentGrantStore: AnyObject {
    func load() throws -> [PersistentGrant]
    func save(_ grants: [PersistentGrant]) throws
}

public final class MemoryPersistentGrants: PersistentGrantStore {
    public var grants: [PersistentGrant]
    public init(_ grants: [PersistentGrant] = []) { self.grants = grants }
    public func load() throws -> [PersistentGrant] { grants }
    public func save(_ grants: [PersistentGrant]) throws { self.grants = grants }
}

/// `grants.json` in the state dir, mode 0600, replaced atomically. Read on every use (no cache), so the
/// `cu-runtime grants` command and a running daemon never disagree.
public final class FilePersistentGrants: PersistentGrantStore {
    public let url: URL

    public init(stateDir: URL) { url = stateDir.appendingPathComponent("grants.json") }

    public func load() throws -> [PersistentGrant] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attrs[.type] as? FileAttributeType == .typeRegular else {
            throw RPCFailure(.internalError, "\(url.path) is not a regular file")
        }
        guard let perms = attrs[.posixPermissions] as? Int, perms & 0o077 == 0 else {
            throw RPCFailure(.internalError, "\(url.path) must not be readable by others (mode 0600)")
        }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode([PersistentGrant].self, from: Data(contentsOf: url))
    }

    public func save(_ grants: [PersistentGrant]) throws {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let tmp = url.deletingLastPathComponent().appendingPathComponent(".grants.json.\(getpid()).tmp")
        guard FileManager.default.createFile(atPath: tmp.path, contents: try encoder.encode(grants),
                                             attributes: [.posixPermissions: 0o600]) else {
            throw RPCFailure(.internalError, "cannot write \(tmp.path)")
        }
        guard rename(tmp.path, url.path) == 0 else {
            try? FileManager.default.removeItem(at: tmp)
            throw RPCFailure(.internalError, "cannot replace \(url.path): errno \(errno)")
        }
    }
}

/// The persistent list's operations, shared by the daemon and the `cu-runtime grants` command. Every change is
/// audited by the caller.
public enum PersistentGrants {
    /// Adds (or replaces) the app's entry, pinned to its designated requirement read now.
    public static func add(_ identity: AppIdentity, mode: AppMode, via: String, store: PersistentGrantStore,
                           apps: AppDirectory, now: Date, settings: UserSettings = UserSettings()) throws -> PersistentGrant {
        try GrantRules.checkGrantable(identity.bundleID, source: .approval, config: PolicyConfig(), settings: settings)
        guard let requirement = apps.designatedRequirement(path: identity.path) else {
            throw Denial("unsigned_app", "\(identity.bundleID) has no code signature to pin a permanent grant to")
        }
        let entry = PersistentGrant(bundleId: identity.bundleID, mode: mode, requirement: requirement,
                                    path: identity.path, addedAt: now, via: via)
        let rest = try store.load().filter { $0.bundleId.caseInsensitiveCompare(identity.bundleID) != .orderedSame }
        try store.save(rest + [entry])
        return entry
    }

    /// Changes the entry's mode, keeping its signature pin (the app lists page's "change mode"). Nil: no entry.
    public static func setMode(bundleID: String, mode: AppMode, store: PersistentGrantStore) throws -> PersistentGrant? {
        var all = try store.load()
        guard let i = all.firstIndex(where: { $0.bundleId.caseInsensitiveCompare(bundleID) == .orderedSame }) else { return nil }
        let e = all[i]
        let changed = PersistentGrant(bundleId: e.bundleId, mode: mode, requirement: e.requirement, path: e.path,
                                      addedAt: Date(timeIntervalSince1970: e.addedAt), via: e.via)
        all[i] = changed
        try store.save(all)
        return changed
    }

    /// Pins the entry to the signature the app carries now (the page's "approve again" for an entry whose app was
    /// re-signed). Nil: no entry; throws when the app is gone or unsigned.
    public static func repin(bundleID: String, store: PersistentGrantStore, apps: AppDirectory, now: Date) throws -> PersistentGrant? {
        let all = try store.load()
        guard let e = all.first(where: { $0.bundleId.caseInsensitiveCompare(bundleID) == .orderedSame }) else { return nil }
        guard let identity = apps.identity(bundleID: e.bundleId) else {
            throw Denial("app_not_found", "\(e.bundleId) is not installed")
        }
        guard let mode = e.appMode else { throw RPCFailure(.internalError, "\(e.bundleId): unknown mode \(e.mode)") }
        return try add(identity, mode: mode, via: "settings", store: store, apps: apps, now: now)
    }

    /// Removes the app's entries; returns them.
    @discardableResult
    public static func revoke(bundleID: String, store: PersistentGrantStore) throws -> [PersistentGrant] {
        let all = try store.load()
        let gone = all.filter { $0.bundleId.caseInsensitiveCompare(bundleID) == .orderedSame }
        if !gone.isEmpty { try store.save(all.filter { $0.bundleId.caseInsensitiveCompare(bundleID) != .orderedSame }) }
        return gone
    }
}

// MARK: - Pending dialogs and per-session bookkeeping

/// A dialog on screen. The presenter's answer arrives on another thread; everything else is the worker's.
final class PendingDialog: @unchecked Sendable {
    let id: String
    let taskID: String
    let identity: AppIdentity
    let mode: AppMode
    let electronAX: Bool
    let imePolicy: ChangePolicy
    let startedAt: Date
    /// Who asked (the requesting connection's peer): the approval is theirs even when another call settles it.
    let owner: GrantOwner
    private let lock = NSLock()
    private var _answer: DialogAnswer?
    private var _focus: DialogFocus?
    private var _windows: DialogWindows?

    init(id: String, taskID: String, identity: AppIdentity, mode: AppMode, electronAX: Bool, imePolicy: ChangePolicy,
         startedAt: Date, owner: GrantOwner) {
        self.id = id
        self.taskID = taskID
        self.identity = identity
        self.mode = mode
        self.electronAX = electronAX
        self.imePolicy = imePolicy
        self.startedAt = startedAt
        self.owner = owner
    }

    var answer: DialogAnswer? {
        lock.lock()
        defer { lock.unlock() }
        return _answer
    }

    var focus: DialogFocus? {
        lock.lock()
        defer { lock.unlock() }
        return _focus
    }

    var windows: DialogWindows? {
        lock.lock()
        defer { lock.unlock() }
        return _windows
    }

    /// First answer wins (a late timeout after a click, or the reverse, is ignored).
    func answer(_ a: DialogAnswer, focus: DialogFocus? = nil, windows: DialogWindows? = nil) {
        lock.lock()
        defer { lock.unlock() }
        if _answer == nil { (_answer, _focus, _windows) = (a, focus, windows) }
    }
}

/// Per task: apps the person refused (and when), dialogs shown this turn; plus the one dialog on screen.
/// Worker queue only.
final class ApprovalBook {
    var refused: [String: [String: Date]] = [:]
    var dialogsThisTurn: [String: Int] = [:]
    var pending: PendingDialog?
    /// Turn focus (Dispatcher+Focus.swift), by task: the app in front when the turn started, and the apps its
    /// actions targeted since.
    var turnFront: [String: String] = [:]
    var turnTargets: [String: Set<String>] = [:]
    /// The app the user talks to the model in (the browser with dsh: in front at the latest turn start), by task. Kept
    /// across turns. Never granted to that task, so the model cannot click its own approval buttons (2026-10-09, 2f).
    var hostApp: [String: String] = [:]
    /// Who marks the task's turns (the plugin in the dsh process that started them), by task: the first client to mark
    /// it, kept across turns until that client has exited. Another client cannot take the task's turns over.
    var turnOwner: [String: GrantOwner] = [:]
    /// Tasks whose current turn is marked (access.turn_start since the last access.turn_end).
    var turnOpen: Set<String> = []
    /// Clients a person has approved an app for since this daemon started; the dialog says when a request is the
    /// first from its process.
    var approvedClients: [GrantOwner] = []
    private var nextID = 0

    func newID() -> String {
        nextID += 1
        return "dlg-\(nextID)"
    }

    func refusedRecently(_ taskID: String, _ bundleID: String, now: Date) -> Bool {
        guard let at = refused[taskID]?[bundleID.lowercased()] else { return false }
        return now.timeIntervalSince(at) < AccessRules.refusalMemory
    }

    func forget(_ taskID: String) {
        refused.removeValue(forKey: taskID)
        dialogsThisTurn.removeValue(forKey: taskID)
        turnFront.removeValue(forKey: taskID)
        turnTargets.removeValue(forKey: taskID)
        hostApp.removeValue(forKey: taskID)
        turnOwner.removeValue(forKey: taskID)
        turnOpen.remove(taskID)
    }
}
