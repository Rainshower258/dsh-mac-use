import Foundation

// MARK: - User settings (2026-10-15)

/// An app the user put on their own deny list: never granted, never asked about, in any mode. A user-level
/// HardDeny, minus the "halts everything while frontmost" part (that stays for the system floor only).
public struct DenyEntry: Codable, Equatable, Sendable {
    public let bundleId: String
    public let note: String
    public let addedAt: Double

    public init(bundleId: String, note: String, addedAt: Date) {
        self.bundleId = bundleId
        self.note = note
        self.addedAt = addedAt.timeIntervalSince1970
    }
}

/// What an app outside every list gets the first time a task touches it (the settings window's "default mode",
/// 2026-10-16): a dialog, or a session approval of that mode without one. The full-power mode is
/// never a default (it is switched on for a limited time only).
public enum DefaultMode: String, Codable, Sendable, CaseIterable {
    case ask, read, full

    /// Higher is looser.
    var rank: Int {
        switch self {
        case .ask: return 0
        case .read: return 1
        case .full: return 2
        }
    }

    /// The mode granted without a dialog for a request of `mode`, if any.
    func covers(_ mode: AppMode) -> Bool {
        switch self {
        case .ask: return false
        case .read: return mode == .read
        case .full: return true
        }
    }
}

/// Which button of the approval dialog Return presses (the window's "default button", 2026-10-16). Refuse is the
/// default: a reflex press then changes nothing. Anything else is loosening.
public enum DialogDefault: String, Codable, Sendable, CaseIterable {
    case deny, turn, session, always

    var rank: Int {
        switch self {
        case .deny: return 0
        case .turn: return 1
        case .session: return 2
        case .always: return 3
        }
    }

    public var answer: DialogAnswer {
        switch self {
        case .deny: return .deny
        case .turn: return .turn
        case .session: return .session
        case .always: return .always
        }
    }
}

/// The access rules the window sets (the "modes and defaults" page). Each has the values the page offers; the
/// defaults are what the daemon did before they were settings (AccessRules).
public struct AccessDefaults: Codable, Equatable, Sendable {
    public var defaultMode: DefaultMode
    /// How long a session approval lasts at most, in minutes.
    public var sessionLimitMinutes: Int
    /// Dialogs per task and turn; more are refused without asking.
    public var dialogsPerTurn: Int
    /// The dialog closes by itself after this long; no answer counts as a refusal.
    public var dialogTimeoutSeconds: Int
    /// The button Return presses in the dialog.
    public var dialogDefault: DialogDefault

    public static let sessionChoices = [15, 30, 60]
    public static let dialogChoices = [1, 2, 3]
    public static let timeoutChoices = [60, 120, 180]

    public init(defaultMode: DefaultMode = .ask, sessionLimitMinutes: Int = 30, dialogsPerTurn: Int = 3,
                dialogTimeoutSeconds: Int = 120, dialogDefault: DialogDefault = .deny) {
        self.defaultMode = defaultMode
        self.sessionLimitMinutes = sessionLimitMinutes
        self.dialogsPerTurn = dialogsPerTurn
        self.dialogTimeoutSeconds = dialogTimeoutSeconds
        self.dialogDefault = dialogDefault
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = AccessDefaults()
        defaultMode = try c.decodeIfPresent(DefaultMode.self, forKey: .defaultMode) ?? d.defaultMode
        sessionLimitMinutes = try c.decodeIfPresent(Int.self, forKey: .sessionLimitMinutes) ?? d.sessionLimitMinutes
        dialogsPerTurn = try c.decodeIfPresent(Int.self, forKey: .dialogsPerTurn) ?? d.dialogsPerTurn
        dialogTimeoutSeconds = try c.decodeIfPresent(Int.self, forKey: .dialogTimeoutSeconds) ?? d.dialogTimeoutSeconds
        dialogDefault = try c.decodeIfPresent(DialogDefault.self, forKey: .dialogDefault) ?? d.dialogDefault
        try validate()
    }

    public var sessionLimit: TimeInterval { TimeInterval(sessionLimitMinutes * 60) }
    public var dialogTimeout: TimeInterval { TimeInterval(dialogTimeoutSeconds) }

    /// Only the values the page offers are accepted (a hand-edited file with others is refused whole).
    public func validate() throws {
        guard Self.sessionChoices.contains(sessionLimitMinutes) else {
            throw RPCFailure(.invalidParams, "session_limit_minutes must be one of \(Self.sessionChoices)")
        }
        guard Self.dialogChoices.contains(dialogsPerTurn) else {
            throw RPCFailure(.invalidParams, "dialogs_per_turn must be one of \(Self.dialogChoices)")
        }
        guard Self.timeoutChoices.contains(dialogTimeoutSeconds) else {
            throw RPCFailure(.invalidParams, "dialog_timeout_seconds must be one of \(Self.timeoutChoices)")
        }
    }

    /// The fields that `new` loosens compared to these: a higher default mode, a longer session, more dialogs, a
    /// default button that approves. The dialog timeout is neither (the design shows no lock on it). Loosening
    /// needs the person verified.
    public func loosened(by new: AccessDefaults) -> [String] {
        var out: [String] = []
        if new.defaultMode.rank > defaultMode.rank { out.append("default_mode") }
        if new.sessionLimitMinutes > sessionLimitMinutes { out.append("session_limit_minutes") }
        if new.dialogsPerTurn > dialogsPerTurn { out.append("dialogs_per_turn") }
        if new.dialogDefault.rank > dialogDefault.rank { out.append("dialog_default") }
        return out
    }

    var json: JSONValue {
        ["default_mode": .string(defaultMode.rawValue), "session_limit_minutes": .number(Double(sessionLimitMinutes)),
         "dialogs_per_turn": .number(Double(dialogsPerTurn)), "dialog_timeout_seconds": .number(Double(dialogTimeoutSeconds)),
         "dialog_default": .string(dialogDefault.rawValue)]
    }
}

/// A chord the user added (the shortcuts page, 2026-10-16): allowed in one app, or in every approved app.
public struct CustomChord: Codable, Equatable, Sendable {
    /// Normalized (KeyChord.description), e.g. "cmd+k".
    public let chord: String
    /// The bundle ID it is limited to; nil: every approved app.
    public let app: String?
    public let note: String
    public let addedAt: Double

    public init(chord: String, app: String?, note: String, addedAt: Date) {
        self.chord = chord
        self.app = app
        self.note = note
        self.addedAt = addedAt.timeIntervalSince1970
    }

    func applies(to bundleID: String) -> Bool {
        guard let app else { return true }
        return app.caseInsensitiveCompare(bundleID) == .orderedSame
    }
}

/// The user's changes to the chord allowlist: built-in chords switched off (tightening) and chords added
/// (loosening, verified). The never-allowed chords are compiled in (ChordPolicy.neverAllowed) and win over both.
public struct ChordSettings: Codable, Equatable, Sendable {
    public var disabled: [String]
    public var custom: [CustomChord]

    public init(disabled: [String] = [], custom: [CustomChord] = []) {
        self.disabled = disabled
        self.custom = custom
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        disabled = try c.decodeIfPresent([String].self, forKey: .disabled) ?? []
        custom = try c.decodeIfPresent([CustomChord].self, forKey: .custom) ?? []
    }

    public func isDisabled(_ chord: KeyChord) -> Bool { disabled.contains(chord.description) }
    public func allows(_ chord: KeyChord, in bundleID: String) -> Bool {
        custom.contains { $0.chord == chord.description && $0.applies(to: bundleID) }
    }
}

/// What leaves the machine, and what is kept (the privacy-and-audit page, 2026-10-17). Switching a kind of
/// content off is tightening (at once); back on is loosening (verified). Apps on `textOnlyApps` never have a
/// screenshot sent, whatever the switches.
public struct PrivacySettings: Codable, Equatable, Sendable {
    public var sendScreenshots: Bool
    public var sendAXText: Bool
    public var sendOCR: Bool
    public var sendZoom: Bool
    public var textOnlyApps: [String]
    /// The clipboard is emptied when a turn starts (the model cannot paste what the user copied before).
    public var clearClipboardOnTurnStart: Bool

    public init(sendScreenshots: Bool = true, sendAXText: Bool = true, sendOCR: Bool = true, sendZoom: Bool = true,
                textOnlyApps: [String] = [], clearClipboardOnTurnStart: Bool = false) {
        self.sendScreenshots = sendScreenshots
        self.sendAXText = sendAXText
        self.sendOCR = sendOCR
        self.sendZoom = sendZoom
        self.textOnlyApps = textOnlyApps
        self.clearClipboardOnTurnStart = clearClipboardOnTurnStart
    }

    /// The file is snake_case (convertToSnakeCase / convertFromSnakeCase): "send_ocr" reads back as "sendOcr", so an
    /// acronym property needs that spelling as its key, or it is never found and takes its default (VM test,
    /// 2026-10-17: OCR and UI text, switched off, were on again after every daemon start). The names on disk do not
    /// change.
    enum CodingKeys: String, CodingKey {
        case sendScreenshots, sendZoom, textOnlyApps, clearClipboardOnTurnStart
        case sendAXText = "sendAxText", sendOCR = "sendOcr"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = PrivacySettings()
        sendScreenshots = try c.decodeIfPresent(Bool.self, forKey: .sendScreenshots) ?? d.sendScreenshots
        sendAXText = try c.decodeIfPresent(Bool.self, forKey: .sendAXText) ?? d.sendAXText
        sendOCR = try c.decodeIfPresent(Bool.self, forKey: .sendOCR) ?? d.sendOCR
        sendZoom = try c.decodeIfPresent(Bool.self, forKey: .sendZoom) ?? d.sendZoom
        textOnlyApps = try c.decodeIfPresent([String].self, forKey: .textOnlyApps) ?? d.textOnlyApps
        clearClipboardOnTurnStart = try c.decodeIfPresent(Bool.self, forKey: .clearClipboardOnTurnStart) ?? d.clearClipboardOnTurnStart
    }

    /// Nothing to check since the retention moved to LogSettings (2026-10-17); kept so callers read the same.
    public func validate() throws {}

    public func isTextOnly(_ bundleID: String) -> Bool {
        textOnlyApps.contains { $0.caseInsensitiveCompare(bundleID) == .orderedSame }
    }

    /// What `new` loosens: a kind of content switched back on, an app taken off the text-only list. The clipboard
    /// switch and the retention are neither.
    public func loosened(by new: PrivacySettings) -> [String] {
        var out: [String] = []
        if new.sendScreenshots && !sendScreenshots { out.append("send_screenshots") }
        if new.sendAXText && !sendAXText { out.append("send_ax_text") }
        if new.sendOCR && !sendOCR { out.append("send_ocr") }
        if new.sendZoom && !sendZoom { out.append("send_zoom") }
        let kept = Set(new.textOnlyApps.map { $0.lowercased() })
        if textOnlyApps.contains(where: { !kept.contains($0.lowercased()) }) { out.append("text_only_apps") }
        return out
    }

    var json: JSONValue {
        ["send_screenshots": .bool(sendScreenshots), "send_ax_text": .bool(sendAXText), "send_ocr": .bool(sendOCR),
         "send_zoom": .bool(sendZoom), "text_only_apps": .array(textOnlyApps.map { .string($0) }),
         "clear_clipboard_on_turn_start": .bool(clearClipboardOnTurnStart)]
    }
}

/// Where the audit log lives and how long it is kept (the logs page, 2026-10-17). The user picks a folder; the
/// files go into its `cu-runtime-logs` subdirectory, which the daemon owns (mode 0700, StateDir) so the chosen
/// folder's own permissions are not changed. Nil: the default under the state directory.
public struct LogSettings: Codable, Equatable, Sendable {
    public var directory: String?
    /// Day files older than this are deleted (7 | 30 | 90).
    public var retentionDays: Int

    public static let retentionChoices = [7, 30, 90]
    public static let subdirectory = "cu-runtime-logs"

    public init(directory: String? = nil, retentionDays: Int = 30) {
        self.directory = directory
        self.retentionDays = retentionDays
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        directory = try c.decodeIfPresent(String.self, forKey: .directory)
        retentionDays = try c.decodeIfPresent(Int.self, forKey: .retentionDays) ?? 30
        try validate()
    }

    public func validate() throws {
        guard Self.retentionChoices.contains(retentionDays) else {
            throw RPCFailure(.invalidParams, "retention_days must be one of \(Self.retentionChoices)")
        }
        if let d = directory {
            guard d.hasPrefix("/") else { throw RPCFailure(.invalidParams, "the log directory must be an absolute path") }
        }
    }

    /// What `new` loosens compared to these: a shorter retention (it deletes audit files at once, so a request
    /// could erase the record of what it did). The directory is neither: it only ever comes from the daemon's own
    /// folder panel or "use the default", never from a client.
    public func loosened(by new: LogSettings) -> [String] {
        new.retentionDays < retentionDays ? ["retention_days"] : []
    }

    /// The directory the files are written to: the chosen folder's subdirectory, else `fallback` (the default).
    public func effectiveDirectory(default fallback: URL) -> URL {
        guard let d = directory else { return fallback }
        return URL(fileURLWithPath: d, isDirectory: true).appendingPathComponent(Self.subdirectory, isDirectory: true)
    }

    var json: JSONValue {
        ["directory": directory.map { .string($0) } ?? .null, "retention_days": .number(Double(retentionDays))]
    }
}

/// How the model operates the machine (the behavior-and-model page, 2026-10-17). Turning a switch towards
/// what the daemon allows by default widens what the model can do (since settings reach the socket, 2026-10-21):
/// coordinate targets on, a higher input-source cap, Electron AX on are loosening (verified); the rest applies at once.
public struct BehaviorSettings: Codable, Equatable, Sendable {
    /// At a turn's end the focus goes back to the app that was in front when it started (when the plugin asks).
    public var restoreFocusOnTurnEnd: Bool
    /// Targets given as coordinates (not as an element of the snapshot) are accepted.
    public var allowPointTargets: Bool
    /// The loosest input-source policy a task gets, whatever the plugin asks for: leave < ask < takeover.
    public var imePolicyCap: ChangePolicy
    /// Electron apps get AXManualAccessibility switched on for the task (and back off after).
    public var electronAXAuto: Bool
    /// ActivationMethod raw value; nil: the daemon's default (config.json may still set one, this wins when set).
    public var activationMethod: String?

    public init(restoreFocusOnTurnEnd: Bool = true, allowPointTargets: Bool = true, imePolicyCap: ChangePolicy = .takeover,
                electronAXAuto: Bool = true, activationMethod: String? = nil) {
        self.restoreFocusOnTurnEnd = restoreFocusOnTurnEnd
        self.allowPointTargets = allowPointTargets
        self.imePolicyCap = imePolicyCap
        self.electronAXAuto = electronAXAuto
        self.activationMethod = activationMethod
    }

    /// electronAXAuto: see PrivacySettings.CodingKeys.
    enum CodingKeys: String, CodingKey {
        case restoreFocusOnTurnEnd, allowPointTargets, imePolicyCap, activationMethod
        case electronAXAuto = "electronAxAuto"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = BehaviorSettings()
        restoreFocusOnTurnEnd = try c.decodeIfPresent(Bool.self, forKey: .restoreFocusOnTurnEnd) ?? d.restoreFocusOnTurnEnd
        allowPointTargets = try c.decodeIfPresent(Bool.self, forKey: .allowPointTargets) ?? d.allowPointTargets
        imePolicyCap = try c.decodeIfPresent(ChangePolicy.self, forKey: .imePolicyCap) ?? d.imePolicyCap
        electronAXAuto = try c.decodeIfPresent(Bool.self, forKey: .electronAXAuto) ?? d.electronAXAuto
        activationMethod = try c.decodeIfPresent(String.self, forKey: .activationMethod)
        try validate()
    }

    public func validate() throws {
        if let m = activationMethod, ActivationMethod(rawValue: m) == nil {
            throw RPCFailure(.invalidParams, "activation_method must be one of \(ActivationMethod.allCases.map(\.rawValue))")
        }
    }

    /// What `new` loosens: coordinate targets switched on, the input-source cap raised (leave < ask < takeover),
    /// Electron AX switched on. Focus restore and the activation method are neither.
    public func loosened(by new: BehaviorSettings) -> [String] {
        var out: [String] = []
        if new.allowPointTargets && !allowPointTargets { out.append("allow_point_targets") }
        if new.imePolicyCap.rank > imePolicyCap.rank { out.append("ime_policy_cap") }
        if new.electronAXAuto && !electronAXAuto { out.append("electron_ax_auto") }
        return out
    }

    /// The policy a task gets for what it asked.
    public func imePolicy(requested: ChangePolicy) -> ChangePolicy {
        requested.rank <= imePolicyCap.rank ? requested : imePolicyCap
    }

    var json: JSONValue {
        ["restore_focus_on_turn_end": .bool(restoreFocusOnTurnEnd), "allow_point_targets": .bool(allowPointTargets),
         "ime_policy_cap": .string(imePolicyCap.rawValue), "electron_ax_auto": .bool(electronAXAuto),
         "activation_method": activationMethod.map { .string($0) } ?? .null]
    }
}

extension ChangePolicy: Codable {
    /// Looser is higher.
    var rank: Int {
        switch self {
        case .leave: return 0
        case .ask: return 1
        case .takeover: return 2
        }
    }
}

/// What the settings window owns. Kept in the daemon's state dir as `settings.json` (0600), read at start, written
/// by the window and, since 2026-10-21, by the socket's settings methods one closed SettingsChange at a time: the
/// daemon decides what loosens and verifies the person itself; the file never crosses the socket whole.
/// Tightening takes effect at once; loosening (the person verified first) is recorded as verified.
public struct UserSettings: Codable, Equatable, Sendable {
    public static let currentVersion = 2
    public var version: Int
    public var denylist: [DenyEntry]
    /// The access rules (version 2, 2026-10-16); a version-1 file gets the defaults.
    public var access: AccessDefaults
    /// The chord allowlist's changes (version 2).
    public var chords: ChordSettings
    /// What is sent and kept (version 2).
    public var privacy: PrivacySettings
    /// How the model operates (version 2).
    public var behavior: BehaviorSettings
    /// Where the audit log lives and how long it is kept (version 2).
    public var logs: LogSettings

    public init(version: Int = UserSettings.currentVersion, denylist: [DenyEntry] = [], access: AccessDefaults = AccessDefaults(),
                chords: ChordSettings = ChordSettings(), privacy: PrivacySettings = PrivacySettings(),
                behavior: BehaviorSettings = BehaviorSettings(), logs: LogSettings = LogSettings()) {
        self.version = version
        self.denylist = denylist
        self.access = access
        self.chords = chords
        self.privacy = privacy
        self.behavior = behavior
        self.logs = logs
    }

    /// Everything `new` loosens compared to these settings, as the import confirmation lists it: the access rules,
    /// privacy, behavior and logs fields by name, apps taken off the deny list, chords switched on or added.
    public func loosened(by new: UserSettings) -> [String] {
        var out = access.loosened(by: new.access).map { "access.\($0)" }
        out += privacy.loosened(by: new.privacy).map { "privacy.\($0)" }
        out += behavior.loosened(by: new.behavior).map { "behavior.\($0)" }
        out += logs.loosened(by: new.logs).map { "logs.\($0)" }
        let keptDenied = Set(new.denylist.map { $0.bundleId.lowercased() })
        out += denylist.filter { !keptDenied.contains($0.bundleId.lowercased()) }.map { "denylist.remove:\($0.bundleId)" }
        let stillDisabled = Set(new.chords.disabled)
        out += chords.disabled.filter { !stillDisabled.contains($0) }.map { "chords.enable:\($0)" }
        let had = Set(chords.custom.map { "\($0.chord)@\($0.app?.lowercased() ?? "*")" })
        out += new.chords.custom.filter { !had.contains("\($0.chord)@\($0.app?.lowercased() ?? "*")") }.map { "chords.add:\($0.chord)" }
        return out
    }

    /// The defaults, keeping what the user restricted: the deny list, the text-only apps, the built-in chords
    /// switched off. Chords the user added go (they widen). The log location stays (a reset moves no files).
    public func resetToDefaults() -> UserSettings {
        UserSettings(denylist: denylist, access: AccessDefaults(), chords: ChordSettings(disabled: chords.disabled),
                     privacy: PrivacySettings(textOnlyApps: privacy.textOnlyApps), behavior: BehaviorSettings(),
                     logs: LogSettings(directory: logs.directory))
    }

    /// For the export: the file as the daemon writes it.
    public func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(self)
    }

    /// For the import: a file as the daemon writes it (unknown keys ignored, missing ones defaulted).
    public static func decode(_ data: Data) throws -> UserSettings {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(UserSettings.self, from: data)
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? UserSettings.currentVersion
        denylist = try c.decodeIfPresent([DenyEntry].self, forKey: .denylist) ?? []
        access = try c.decodeIfPresent(AccessDefaults.self, forKey: .access) ?? AccessDefaults()
        chords = try c.decodeIfPresent(ChordSettings.self, forKey: .chords) ?? ChordSettings()
        privacy = try c.decodeIfPresent(PrivacySettings.self, forKey: .privacy) ?? PrivacySettings()
        behavior = try c.decodeIfPresent(BehaviorSettings.self, forKey: .behavior) ?? BehaviorSettings()
        logs = try c.decodeIfPresent(LogSettings.self, forKey: .logs) ?? LogSettings()
    }

    public func denies(_ bundleID: String) -> DenyEntry? {
        denylist.first { $0.bundleId.caseInsensitiveCompare(bundleID) == .orderedSame }
    }
}

public protocol SettingsStore: AnyObject {
    func load() throws -> UserSettings
    func save(_ settings: UserSettings) throws
}

public final class MemorySettingsStore: SettingsStore {
    public var settings: UserSettings
    public init(_ settings: UserSettings = UserSettings()) { self.settings = settings }
    public func load() throws -> UserSettings { settings }
    public func save(_ settings: UserSettings) throws { self.settings = settings }
}

/// `settings.json` in the state dir, like FilePersistentGrants: 0600, refused when readable by others, replaced
/// atomically.
public final class FileSettingsStore: SettingsStore {
    public let url: URL
    public init(stateDir: URL) { url = stateDir.appendingPathComponent("settings.json") }

    public func load() throws -> UserSettings {
        guard FileManager.default.fileExists(atPath: url.path) else { return UserSettings() }
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attrs[.type] as? FileAttributeType == .typeRegular else {
            throw RPCFailure(.internalError, "\(url.path) is not a regular file")
        }
        if let mode = attrs[.posixPermissions] as? Int, mode & 0o077 != 0 {
            throw RPCFailure(.internalError, "\(url.path) must not be readable by others (mode 0600)")
        }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(UserSettings.self, from: Data(contentsOf: url))
    }

    public func save(_ settings: UserSettings) throws {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(settings)
        let tmp = url.deletingLastPathComponent().appendingPathComponent(".settings.json.\(getpid()).tmp")
        let fd = open(tmp.path, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
        guard fd >= 0 else { throw RPCFailure(.internalError, "cannot create \(tmp.path): errno \(errno)") }
        defer { close(fd) }
        try data.withUnsafeBytes { buf in
            var off = 0
            while off < buf.count {
                let n = write(fd, buf.baseAddress! + off, buf.count - off)
                guard n > 0 else { throw RPCFailure(.internalError, "cannot write \(tmp.path): errno \(errno)") }
                off += n
            }
        }
        guard fsync(fd) == 0, rename(tmp.path, url.path) == 0 else {
            throw RPCFailure(.internalError, "cannot replace \(url.path): errno \(errno)")
        }
    }
}

// MARK: - Reading the audit back (the overview's "recent refusals")

/// One refusal as the audit recorded it: what was attempted and why it was refused, never screen content (the
/// audit holds none).
public struct AuditRefusal: Sendable, Equatable {
    public let at: Date
    public let method: String
    public let app: String?
    public let reason: String
    public let detail: String?
    public let chord: String?
}

public enum AuditReader {
    /// Refusals that are part of the normal flow (every first call is refused and then escalated; the plugin's probes)
    /// and would drown the list: left out.
    public static let routineReasons: Set<String> = [
        "no_grant", "not_granted", "grant_expired", "action_not_allowed", "approval_unavailable",
        "ime_switch_needs_approval", "snapshot_required", "stale_snapshot", "stale_element", "unknown_element",
    ]

    /// The last `limit` refusals (`decision` deny) from today's and yesterday's files, newest first, without the
    /// routine ones. A malformed line is skipped; a missing file is an empty day. 100 since 2026-10-16 (the
    /// overview keeps the last 100, scrolled). A line without the text `deny` is skipped before it is parsed (the
    /// snapshot reads these files on the worker, and most lines are allowed requests): every line the parse accepts
    /// contains it, since the audit's encoder never escapes letters, so the result is the same.
    public static func recentRefusals(directory: URL, prefix: String = "audit", now: Date = Date(), limit: Int = 100,
                                      timeZone: TimeZone = .current) -> [AuditRefusal] {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var out: [AuditRefusal] = []
        for day in AuditDays.last(2, now: now, timeZone: timeZone) {
            let url = directory.appendingPathComponent(AuditDays.fileName(day, prefix: prefix))
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
            for line in text.split(separator: "\n").reversed() {
                guard line.contains("deny"), let data = line.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      obj["decision"] as? String == "deny", let reason = obj["reason"] as? String,
                      let method = obj["method"] as? String else { continue }
                if obj["silent"] as? Bool == true || routineReasons.contains(reason) { continue }
                let at = (obj["ts"] as? String).flatMap { iso.date(from: $0) } ?? now
                out.append(AuditRefusal(at: at, method: method, app: obj["app"] as? String ?? obj["app_requested"] as? String,
                                        reason: reason, detail: obj["detail"] as? String, chord: obj["chord"] as? String))
                if out.count >= limit { return out }
            }
        }
        return out
    }
}

/// One settings change as the audit recorded it (method `settings.*`, minus the lines that record only a request:
/// AuditReader.isRequestOnly).
public struct AuditSettingsChange: Sendable, Equatable {
    public let at: Date
    public let method: String
    public let fields: [String: JSONValue]
}

extension AuditReader {
    /// `settings.*` methods whose lines never record a change: opening the window, its self-check and UI events,
    /// loading the file at start, reading the settings, the owner check itself (the change it was for writes its
    /// own line) and cancelling one.
    public static let requestOnlySettingsMethods: Set<String> = [
        "settings.open", "settings.self_check", "settings.ui", "settings.load", "settings.snapshot",
        "settings.verify", "settings.cancel_verify",
    ]

    /// Whether a `settings.*` line records only a request, not a change: the methods above; a `settings.action`
    /// line unless it says `changed: true`; every `settings.apply` line (the request, and the settled verdict): the
    /// setter an applied change goes through writes its own line, and a refused one is among the recent refusals, so
    /// the window and the page list each change once and never a failed owner check as a change.
    public static func isRequestOnly(method: String, _ line: [String: JSONValue]) -> Bool {
        if requestOnlySettingsMethods.contains(method) { return true }
        if method == "settings.action" { return line["changed"] != .bool(true) }
        if method == "settings.apply" { return true }
        return false
    }

    /// The last `limit` settings changes from the last `days` days, newest first; request-only lines left out. A
    /// line without the text `settings.` is skipped before it is decoded (settings lines are rare, so the limit
    /// seldom ends the read early): every line with a `settings.*` method contains it, since the audit's encoder never
    /// escapes letters or dots, so the result is the same. One decoder serves the whole read.
    public static func recentSettingsChanges(directory: URL, prefix: String = "audit", now: Date = Date(), days: Int = 7,
                                             limit: Int = 50, timeZone: TimeZone = .current) -> [AuditSettingsChange] {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let decoder = JSONDecoder()
        var out: [AuditSettingsChange] = []
        for day in AuditDays.last(days, now: now, timeZone: timeZone) {
            let url = directory.appendingPathComponent(AuditDays.fileName(day, prefix: prefix))
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
            for line in text.split(separator: "\n").reversed() {
                guard line.contains("settings."), let data = line.data(using: .utf8),
                      case .object(let obj)? = try? decoder.decode(JSONValue.self, from: data),
                      case .string(let method)? = obj["method"], method.hasPrefix("settings."),
                      !isRequestOnly(method: method, obj) else { continue }
                var fields = obj
                let at = (obj["ts"]?.stringValue).flatMap { iso.date(from: $0) } ?? now
                fields.removeValue(forKey: "ts")
                fields.removeValue(forKey: "method")
                fields.removeValue(forKey: "decision")
                out.append(AuditSettingsChange(at: at, method: method, fields: fields))
                if out.count >= limit { return out }
            }
        }
        return out
    }
}

// MARK: - values dsh keeps for its entries (the window shows a few, read-only)

/// One value dsh keeps for one of its entries, read without a YAML library (only scalar `key: value` lines). Up to
/// dsh 0.2.0 a home's settings.yaml held them, one top-level section per entry. dsh 0.2.x renames that file to
/// settings.yaml.imported at a profile's start and writes its sections into the profile's cordis.patch.yml, where
/// the settings pages keep them from then on: `- id: <entry>` … `config:` … `<key>: value` (2026-10-17, 0.2.1).
public enum DshEntryValue {
    private static func scalar(_ line: String, _ key: String) -> String? {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.hasPrefix(key + ":") else { return nil }
        let v = t.dropFirst(key.count + 1).trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
        return v.isEmpty ? nil : v
    }

    /// `<key>:` in the top-level `<entry>:` section of a settings.yaml.
    public static func inSettingsYAML(_ yaml: String, entry: String, key: String) -> String? {
        var inSection = false
        for raw in yaml.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix(entry + ":") { inSection = true; continue }
            guard inSection else { continue }
            if !line.hasPrefix(" ") && !line.isEmpty && !line.hasPrefix("#") { break }  // the next top-level key
            if let v = scalar(line, key) { return v }
        }
        return nil
    }

    /// `<key>:` in the `config:` of the row `- id: <entry>` of a cordis patch list. The last such row wins (a later
    /// row patches an earlier one).
    public static func inPatch(_ yaml: String, entry: String, key: String) -> String? {
        var inRow = false, inConfig = false
        var found: String?
        for raw in yaml.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix("- ") {
                inRow = line.trimmingCharacters(in: .whitespaces) == "- id: \(entry)"
                inConfig = false
                continue
            }
            guard inRow, !line.hasPrefix("#") else { continue }
            if line.hasPrefix("  ") && !line.hasPrefix("   ") {   // a row field: name, config, disabled…
                inConfig = line.trimmingCharacters(in: .whitespaces) == "config:"
                continue
            }
            if inConfig, line.hasPrefix("    "), !line.hasPrefix("     "), let v = scalar(line, key) { found = v }
        }
        return found
    }
}

// MARK: - dsh's appearance preference (the settings window follows it)

/// The ui-theme entry's `preference` (dsh-client-ui-theme): light | dark | system. Absent means system.
public enum DshThemePreference: String, Sendable {
    case light, dark, system

    /// From a settings.yaml (dsh up to 0.2.0); nil when the file does not set one.
    public static func parse(_ yaml: String) -> DshThemePreference? {
        DshEntryValue.inSettingsYAML(yaml, entry: "ui-theme", key: "preference").flatMap(DshThemePreference.init(rawValue:))
    }

    /// From a profile's cordis.patch.yml (dsh 0.2.x); nil when it does not set one.
    public static func parsePatch(_ yaml: String) -> DshThemePreference? {
        DshEntryValue.inPatch(yaml, entry: "ui-theme", key: "preference").flatMap(DshThemePreference.init(rawValue:))
    }

    /// The preference in effect across several dsh homes: of every home's settings.yaml and every profile's
    /// cordis.patch.yml, the file changed most recently that says anything wins; none: system. Returns that file.
    public static func resolve(homes: [URL]) -> (DshThemePreference, URL?) {
        let fm = FileManager.default
        let candidates = homes.flatMap { home -> [URL] in
            let profiles = home.appendingPathComponent("profiles")
            let patches = ((try? fm.contentsOfDirectory(atPath: profiles.path)) ?? [])
                .map { profiles.appendingPathComponent($0).appendingPathComponent("cordis.patch.yml") }
            return [home.appendingPathComponent("settings.yaml")] + patches
        }
        let files = candidates
            .compactMap { url -> (URL, Date)? in
                guard let m = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date else { return nil }
                return (url, m)
            }
            .sorted { $0.1 > $1.1 }
        for (url, _) in files {
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
            let p = url.lastPathComponent == "settings.yaml" ? parse(text) : parsePatch(text)
            if let p { return (p, url) }
        }
        return (.system, nil)
    }
}
