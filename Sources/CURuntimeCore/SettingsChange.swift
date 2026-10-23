import Foundation

// MARK: - One settings change, as the socket names it (2026-10-21)

/// One access rule set to one of the values the page offers (`access.set`).
public enum AccessEdit: Equatable, Sendable {
    case defaultMode(DefaultMode)
    case sessionLimitMinutes(Int)
    case dialogsPerTurn(Int)
    case dialogTimeoutSeconds(Int)
    case dialogDefault(DialogDefault)

    /// The `field` names, AccessDefaults' file keys.
    public static let fields: Set<String> = ["default_mode", "session_limit_minutes", "dialogs_per_turn",
                                             "dialog_timeout_seconds", "dialog_default"]

    public var field: String {
        switch self {
        case .defaultMode: return "default_mode"
        case .sessionLimitMinutes: return "session_limit_minutes"
        case .dialogsPerTurn: return "dialogs_per_turn"
        case .dialogTimeoutSeconds: return "dialog_timeout_seconds"
        case .dialogDefault: return "dialog_default"
        }
    }

    public var value: JSONValue {
        switch self {
        case .defaultMode(let m): return .string(m.rawValue)
        case .sessionLimitMinutes(let n), .dialogsPerTurn(let n), .dialogTimeoutSeconds(let n): return .number(Double(n))
        case .dialogDefault(let d): return .string(d.rawValue)
        }
    }

    public func apply(to a: inout AccessDefaults) {
        switch self {
        case .defaultMode(let m): a.defaultMode = m
        case .sessionLimitMinutes(let n): a.sessionLimitMinutes = n
        case .dialogsPerTurn(let n): a.dialogsPerTurn = n
        case .dialogTimeoutSeconds(let n): a.dialogTimeoutSeconds = n
        case .dialogDefault(let d): a.dialogDefault = d
        }
    }

    fileprivate static func decode(_ f: ChangeFields) throws -> AccessEdit {
        switch try f.string("field") {
        case "default_mode": return .defaultMode(try f.choice("value"))
        case "session_limit_minutes": return .sessionLimitMinutes(try f.int("value", in: AccessDefaults.sessionChoices))
        case "dialogs_per_turn": return .dialogsPerTurn(try f.int("value", in: AccessDefaults.dialogChoices))
        case "dialog_timeout_seconds": return .dialogTimeoutSeconds(try f.int("value", in: AccessDefaults.timeoutChoices))
        case "dialog_default": return .dialogDefault(try f.choice("value"))
        default: throw ChangeFields.bad("access.set: field must be one of \(fields.sorted())")
        }
    }
}

/// A kind of content the privacy page switches (`privacy.set`); the names are PrivacySettings' file keys.
public enum PrivacyField: String, CaseIterable, Sendable {
    case sendScreenshots = "send_screenshots"
    case sendAXText = "send_ax_text"
    case sendOCR = "send_ocr"
    case sendZoom = "send_zoom"

    public func get(_ p: PrivacySettings) -> Bool {
        switch self {
        case .sendScreenshots: return p.sendScreenshots
        case .sendAXText: return p.sendAXText
        case .sendOCR: return p.sendOCR
        case .sendZoom: return p.sendZoom
        }
    }

    /// What the owner check's text calls it.
    func label(zh: Bool) -> String {
        switch self {
        case .sendScreenshots: return zh ? "截图" : "screenshots"
        case .sendAXText: return zh ? "界面文字（AX）" : "UI text (accessibility)"
        case .sendOCR: return zh ? "OCR 文字" : "OCR text"
        case .sendZoom: return zh ? "放大图" : "zoomed images"
        }
    }

    public func set(_ on: Bool, in p: inout PrivacySettings) {
        switch self {
        case .sendScreenshots: p.sendScreenshots = on
        case .sendAXText: p.sendAXText = on
        case .sendOCR: p.sendOCR = on
        case .sendZoom: p.sendZoom = on
        }
    }
}

/// One behavior field set (`behavior.set`); the names are BehaviorSettings' file keys. `activation_method` takes
/// null for the daemon's default.
public enum BehaviorEdit: Equatable, Sendable {
    case restoreFocusOnTurnEnd(Bool)
    case allowPointTargets(Bool)
    case imePolicyCap(ChangePolicy)
    case electronAXAuto(Bool)
    case activationMethod(ActivationMethod?)

    public static let fields: Set<String> = ["restore_focus_on_turn_end", "allow_point_targets", "ime_policy_cap",
                                             "electron_ax_auto", "activation_method"]

    public var field: String {
        switch self {
        case .restoreFocusOnTurnEnd: return "restore_focus_on_turn_end"
        case .allowPointTargets: return "allow_point_targets"
        case .imePolicyCap: return "ime_policy_cap"
        case .electronAXAuto: return "electron_ax_auto"
        case .activationMethod: return "activation_method"
        }
    }

    public var value: JSONValue {
        switch self {
        case .restoreFocusOnTurnEnd(let b), .allowPointTargets(let b), .electronAXAuto(let b): return .bool(b)
        case .imePolicyCap(let p): return .string(p.rawValue)
        case .activationMethod(let m): return m.map { .string($0.rawValue) } ?? .null
        }
    }

    public func apply(to b: inout BehaviorSettings) {
        switch self {
        case .restoreFocusOnTurnEnd(let v): b.restoreFocusOnTurnEnd = v
        case .allowPointTargets(let v): b.allowPointTargets = v
        case .imePolicyCap(let p): b.imePolicyCap = p
        case .electronAXAuto(let v): b.electronAXAuto = v
        case .activationMethod(let m): b.activationMethod = m?.rawValue
        }
    }

    fileprivate static func decode(_ f: ChangeFields) throws -> BehaviorEdit {
        switch try f.string("field") {
        case "restore_focus_on_turn_end": return .restoreFocusOnTurnEnd(try f.bool("value"))
        case "allow_point_targets": return .allowPointTargets(try f.bool("value"))
        case "ime_policy_cap": return .imePolicyCap(try f.choice("value"))
        case "electron_ax_auto": return .electronAXAuto(try f.bool("value"))
        case "activation_method":
            if f.isNull("value") { return .activationMethod(nil) }
            return .activationMethod(try f.choice("value") as ActivationMethod)
        default: throw ChangeFields.bad("behavior.set: field must be one of \(fields.sorted())")
        }
    }
}

/// One settings change, each touching one item: the only way the socket changes the settings. The daemon
/// decides on its live settings whether it loosens (Dispatcher.settingsLoosens) and verifies the person itself; the
/// client never says whether it is verified, and never names a file or folder.
public enum SettingsChange: Equatable, Sendable {
    case revoke(taskID: String)
    case revokeAll
    case persistentRemove(bundleID: String)
    case persistentAdd(bundleID: String, mode: AppMode)
    case persistentMode(bundleID: String, mode: AppMode)
    case persistentReapprove(bundleID: String)
    case denyAdd(bundleID: String, note: String)
    case denyRemove(bundleID: String)
    case access(AccessEdit)
    case chordDisable(chord: String)
    case chordEnable(chord: String)
    /// `app` nil: every approved app.
    case chordAdd(chord: String, app: String?, note: String)
    case chordRemove(chord: String, app: String?)
    case privacy(PrivacyField, on: Bool)
    case textOnlyAdd(bundleID: String)
    case textOnlyRemove(bundleID: String)
    /// The clipboard is emptied when a turn starts.
    case clipboard(on: Bool)
    case behavior(BehaviorEdit)
    case logsRetention(days: Int)
    case useDefaultLogDirectory
    case reset
    /// Never decoded: a folder the person picked in the daemon's own panel (SettingsPanels.chooseDirectory).
    case logDirectory(URL)
    /// Never decoded: a file the person picked in the daemon's own panel, decoded and validated by the daemon.
    case importSettings(UserSettings)

    public static let maxBundleID = 255
    public static let maxNote = 200
    public static let maxChord = 64
    public static let maxTaskID = 255

    /// The keys each decodable kind takes besides `kind`: exactly these, no more, no fewer.
    public static let keys: [String: Set<String>] = [
        "revoke": ["task_id"], "revoke_all": [],
        "persistent.remove": ["bundle_id"], "persistent.add": ["bundle_id", "mode"],
        "persistent.mode": ["bundle_id", "mode"], "persistent.reapprove": ["bundle_id"],
        "deny.add": ["bundle_id", "note"], "deny.remove": ["bundle_id"],
        "access.set": ["field", "value"],
        "chord.disable": ["chord"], "chord.enable": ["chord"],
        "chord.add": ["chord", "app", "note"], "chord.remove": ["chord", "app"],
        "privacy.set": ["field", "on"],
        "text_only.add": ["bundle_id"], "text_only.remove": ["bundle_id"],
        "clipboard.set": ["on"],
        "behavior.set": ["field", "value"],
        "logs.retention": ["days"], "logs.default_directory": [],
        "reset": [],
    ]

    public var kind: String {
        switch self {
        case .revoke: return "revoke"
        case .revokeAll: return "revoke_all"
        case .persistentRemove: return "persistent.remove"
        case .persistentAdd: return "persistent.add"
        case .persistentMode: return "persistent.mode"
        case .persistentReapprove: return "persistent.reapprove"
        case .denyAdd: return "deny.add"
        case .denyRemove: return "deny.remove"
        case .access: return "access.set"
        case .chordDisable: return "chord.disable"
        case .chordEnable: return "chord.enable"
        case .chordAdd: return "chord.add"
        case .chordRemove: return "chord.remove"
        case .privacy: return "privacy.set"
        case .textOnlyAdd: return "text_only.add"
        case .textOnlyRemove: return "text_only.remove"
        case .clipboard: return "clipboard.set"
        case .behavior: return "behavior.set"
        case .logsRetention: return "logs.retention"
        case .useDefaultLogDirectory: return "logs.default_directory"
        case .reset: return "reset"
        case .logDirectory: return "logs.directory"
        case .importSettings: return "import"
        }
    }

    /// The `change` of a `settings.apply`, strictly: an object with a known `kind` and exactly its keys; strings,
    /// booleans and whole numbers where they belong; only the values the page offers. Bundle IDs: 1–255 characters,
    /// no space or control character; notes: up to 200, no control character; chords: 1–64, no control character
    /// (parsed when applied: invalid_chord). Anything else, an extra `verified`, `path`, `directory` or `state_dir`
    /// included, is RPCFailure(.invalidParams).
    public static func decode(_ params: JSONValue?) throws -> SettingsChange {
        guard case .object(let o)? = params else { throw ChangeFields.bad("a change is an object with a kind") }
        guard case .string(let kind)? = o["kind"] else { throw ChangeFields.bad("kind must be a string") }
        guard let expected = keys[kind] else { throw ChangeFields.bad("unknown kind \"\(ChangeFields.clip(kind))\"") }
        let given = Set(o.keys).subtracting(["kind"])
        let extra = given.subtracting(expected), missing = expected.subtracting(given)
        guard extra.isEmpty else {
            throw ChangeFields.bad("\(kind) takes no \(extra.sorted().prefix(5).map(ChangeFields.clip).joined(separator: ", "))")
        }
        guard missing.isEmpty else { throw ChangeFields.bad("\(kind) needs \(missing.sorted().joined(separator: ", "))") }
        let f = ChangeFields(kind: kind, o: o)
        switch kind {
        case "revoke": return .revoke(taskID: try f.text("task_id", max: maxTaskID))
        case "revoke_all": return .revokeAll
        case "persistent.remove": return .persistentRemove(bundleID: try f.bundleID())
        case "persistent.add": return .persistentAdd(bundleID: try f.bundleID(), mode: try f.choice("mode"))
        case "persistent.mode": return .persistentMode(bundleID: try f.bundleID(), mode: try f.choice("mode"))
        case "persistent.reapprove": return .persistentReapprove(bundleID: try f.bundleID())
        case "deny.add": return .denyAdd(bundleID: try f.bundleID(), note: try f.text("note", max: maxNote, allowEmpty: true))
        case "deny.remove": return .denyRemove(bundleID: try f.bundleID())
        case "access.set": return .access(try AccessEdit.decode(f))
        case "chord.disable": return .chordDisable(chord: try f.text("chord", max: maxChord))
        case "chord.enable": return .chordEnable(chord: try f.text("chord", max: maxChord))
        case "chord.add":
            return .chordAdd(chord: try f.text("chord", max: maxChord), app: try f.optionalBundleID("app"),
                             note: try f.text("note", max: maxNote, allowEmpty: true))
        case "chord.remove": return .chordRemove(chord: try f.text("chord", max: maxChord), app: try f.optionalBundleID("app"))
        case "privacy.set": return .privacy(try f.choice("field"), on: try f.bool("on"))
        case "text_only.add": return .textOnlyAdd(bundleID: try f.bundleID())
        case "text_only.remove": return .textOnlyRemove(bundleID: try f.bundleID())
        case "clipboard.set": return .clipboard(on: try f.bool("on"))
        case "behavior.set": return .behavior(try BehaviorEdit.decode(f))
        case "logs.retention": return .logsRetention(days: try f.int("days", in: LogSettings.retentionChoices))
        case "logs.default_directory": return .useDefaultLogDirectory
        case "reset": return .reset
        default: throw ChangeFields.bad("unknown kind \"\(ChangeFields.clip(kind))\"")   // `keys` lists every kind above
        }
    }
}

/// Reads one change's fields; every refusal is invalidParams, naming the kind and the key (never echoing a long value).
private struct ChangeFields {
    let kind: String
    let o: [String: JSONValue]

    static func bad(_ message: String) -> RPCFailure { RPCFailure(.invalidParams, message) }
    static func clip(_ s: String) -> String { s.count > 40 ? String(s.prefix(40)) + "…" : s }

    func isNull(_ key: String) -> Bool { o[key] == .null }

    func string(_ key: String) throws -> String {
        guard case .string(let s)? = o[key] else { throw Self.bad("\(kind): \(key) must be a string") }
        return s
    }

    func text(_ key: String, max: Int, allowEmpty: Bool = false) throws -> String {
        let s = try string(key)
        guard s.count <= max else { throw Self.bad("\(kind): \(key) is longer than \(max) characters") }
        guard !s.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw Self.bad("\(kind): \(key) contains a control character")
        }
        guard allowEmpty || !s.trimmingCharacters(in: .whitespaces).isEmpty else { throw Self.bad("\(kind): \(key) is empty") }
        return s
    }

    func bundleID(_ key: String = "bundle_id") throws -> String {
        let s = try text(key, max: SettingsChange.maxBundleID)
        guard !s.contains(where: \.isWhitespace) else { throw Self.bad("\(kind): \(key) contains a space") }
        return s
    }

    func optionalBundleID(_ key: String) throws -> String? { isNull(key) ? nil : try bundleID(key) }

    func bool(_ key: String) throws -> Bool {
        guard case .bool(let b)? = o[key] else { throw Self.bad("\(kind): \(key) must be true or false") }
        return b
    }

    func int(_ key: String, in choices: [Int]) throws -> Int {
        guard case .number(let n)? = o[key], let i = Int(exactly: n), choices.contains(i) else {
            throw Self.bad("\(kind): \(key) must be one of \(choices)")
        }
        return i
    }

    func choice<T: RawRepresentable & CaseIterable>(_ key: String) throws -> T where T.RawValue == String {
        guard case .string(let s)? = o[key], let v = T(rawValue: s) else {
            throw Self.bad("\(kind): \(key) must be one of \(T.allCases.map(\.rawValue))")
        }
        return v
    }
}

// MARK: - The daemon applies it (worker queue only)

extension Dispatcher {
    private func persistentEntry(_ bundleID: String) -> PersistentGrant? {
        ((try? approvals.persistent.load()) ?? []).first { $0.bundleId.caseInsensitiveCompare(bundleID) == .orderedSame }
    }

    /// Whether applying `c` to the live settings loosens anything, i.e. needs the person verified first. A change
    /// the setter would refuse anyway (a hard-denied or missing app, an unparsable or never-allowed chord, an entry
    /// not on its list) and one that changes nothing do not: they are applied (refused, or a no-op) at once instead
    /// of asking for a check that cannot help. The setters re-check `verified` themselves, so a wrong "no" here
    /// ends in verification_required, never in an unverified loosening.
    public func settingsLoosens(_ c: SettingsChange) -> Bool {
        let s = settings
        switch c {
        case .revoke, .revokeAll, .persistentRemove, .denyAdd, .chordDisable, .chordRemove, .textOnlyAdd, .clipboard,
             .useDefaultLogDirectory, .logDirectory:
            return false
        case .persistentAdd(let id, _):
            let grantable = (try? GrantRules.checkGrantable(id, source: .approval, config: config, settings: s)) != nil
            return grantable && apps?.identity(bundleID: id) != nil
        case .persistentMode(let id, let mode):
            guard mode == .full, let e = persistentEntry(id) else { return false }
            return e.appMode != .full
        case .persistentReapprove(let id): return persistentEntry(id) != nil
        case .denyRemove(let id): return s.denies(id) != nil
        case .access(let e):
            var n = s.access
            e.apply(to: &n)
            return !s.access.loosened(by: n).isEmpty
        case .chordEnable(let text):
            guard let k = try? KeyChord.parse(text) else { return false }
            return s.chords.isDisabled(k)
        case .chordAdd(let text, let app, _):
            guard let k = try? KeyChord.parse(text), ChordPolicy.addRefusal(for: k) == nil else { return false }
            if let app, HardDeny.entry(for: app) != nil || s.denies(app) != nil { return false }
            return true
        case .privacy(let field, let on): return on && !field.get(s.privacy)
        case .textOnlyRemove(let id): return s.privacy.isTextOnly(id)
        case .behavior(let e):
            var n = s.behavior
            e.apply(to: &n)
            return !s.behavior.loosened(by: n).isEmpty
        case .logsRetention(let days): return days < s.logs.retentionDays
        case .reset: return !s.loosened(by: s.resetToDefaults()).isEmpty
        case .importSettings(let n): return !s.loosened(by: n).isEmpty
        }
    }

    /// Applies `c` through the setters (Dispatcher+Settings), each one-field edit on the live settings; each loosening
    /// setter refuses with verification_required unless `verified` (true only after the daemon's own owner check).
    /// Returns `{"applied": true}`; a refusal is thrown as the setter throws it.
    @discardableResult
    public func settingsApply(_ c: SettingsChange, verified: Bool) throws -> JSONValue {
        switch c {
        case .revoke(let id): settingsRevoke(taskID: id)
        case .revokeAll: settingsRevokeAll()
        case .persistentRemove(let id): try settingsRevokePersistent(bundleID: id)
        case .persistentAdd(let id, let mode): try settingsPersistentAdd(bundleID: id, mode: mode, verified: verified)
        case .persistentMode(let id, let mode): try settingsSetPersistentMode(bundleID: id, mode: mode, verified: verified)
        case .persistentReapprove(let id): try settingsReapprovePersistent(bundleID: id, verified: verified)
        case .denyAdd(let id, let note): try settingsDenylistAdd(bundleID: id, note: note)
        case .denyRemove(let id): try settingsDenylistRemove(bundleID: id, verified: verified)
        case .access(let e): try settingsEditAccess(verified: verified) { e.apply(to: &$0) }
        case .chordDisable(let k): try settingsChordDisable(k)
        case .chordEnable(let k): try settingsChordEnable(k, verified: verified)
        case .chordAdd(let k, let app, let note): try settingsChordAdd(k, app: app, note: note, verified: verified)
        case .chordRemove(let k, let app): try settingsChordRemove(k, app: app)
        case .privacy(let field, let on): try settingsEditPrivacy(verified: verified) { field.set(on, in: &$0) }
        case .textOnlyAdd(let id):
            try settingsEditPrivacy(verified: verified) { p in if !p.isTextOnly(id) { p.textOnlyApps.append(id) } }
        case .textOnlyRemove(let id):
            try settingsEditPrivacy(verified: verified) { $0.textOnlyApps.removeAll { $0.caseInsensitiveCompare(id) == .orderedSame } }
        case .clipboard(let on): try settingsEditPrivacy(verified: verified) { $0.clearClipboardOnTurnStart = on }
        case .behavior(let e): try settingsEditBehavior(verified: verified) { e.apply(to: &$0) }
        case .logsRetention(let days): try settingsEditLogs(verified: verified) { $0.retentionDays = days }
        case .useDefaultLogDirectory: try settingsEditLogs(verified: verified) { $0.directory = nil }
        case .logDirectory(let url): try settingsEditLogs(verified: verified) { $0.directory = url.standardizedFileURL.path }
        case .reset: try settingsReset(verified: verified)
        case .importSettings(var new):
            // The log folder in force when it is applied: only its panel or "use the default" moves it, never a file,
            // and a preview taken before the folder changed must not put the old one back.
            new.logs.directory = settings.logs.directory
            try settingsImport(new, verified: verified)
        }
        return ["applied": true]
    }

    /// What the page shows for a change (the one waiting for the owner check): `kind` and its keys, fixed fields;
    /// notes clipped to 60 characters. A picked folder shows as the window shows it (home as ~); an import or a reset
    /// lists what it loosens on the live settings.
    public func settingsChangeSummary(_ c: SettingsChange) -> JSONValue {
        var o: [String: JSONValue] = ["kind": .string(c.kind)]
        let note = { (s: String) -> JSONValue in .string(String(s.prefix(60))) }
        switch c {
        case .revoke(let id): o["task_id"] = .string(id)
        case .revokeAll, .useDefaultLogDirectory: break
        case .persistentRemove(let id), .persistentReapprove(let id), .denyRemove(let id), .textOnlyAdd(let id),
             .textOnlyRemove(let id):
            o["bundle_id"] = .string(id)
        case .persistentAdd(let id, let mode), .persistentMode(let id, let mode):
            o["bundle_id"] = .string(id)
            o["mode"] = .string(mode.rawValue)
        case .denyAdd(let id, let n):
            o["bundle_id"] = .string(id)
            o["note"] = note(n)
        case .access(let e):
            o["field"] = .string(e.field)
            o["value"] = e.value
        case .chordDisable(let k), .chordEnable(let k): o["chord"] = .string(k)
        case .chordAdd(let k, let app, let n):
            o["chord"] = .string(k)
            o["app"] = app.map { .string($0) } ?? .null
            o["note"] = note(n)
        case .chordRemove(let k, let app):
            o["chord"] = .string(k)
            o["app"] = app.map { .string($0) } ?? .null
        case .privacy(let field, let on):
            o["field"] = .string(field.rawValue)
            o["on"] = .bool(on)
        case .clipboard(let on): o["on"] = .bool(on)
        case .behavior(let e):
            o["field"] = .string(e.field)
            o["value"] = e.value
        case .logsRetention(let days): o["days"] = .number(Double(days))
        case .logDirectory(let url): o["directory"] = .string(Self.shownPath(url))
        case .reset: o["loosened"] = .array(settings.loosened(by: settings.resetToDefaults()).map { .string($0) })
        case .importSettings(let new): o["loosened"] = .array(settings.loosened(by: new).map { .string($0) })
        }
        return .object(o)
    }

    /// A path as the window shows it: the home directory as ~.
    static func shownPath(_ url: URL) -> String { (url.standardizedFileURL.path as NSString).abbreviatingWithTildeInPath }

    /// The text the daemon's owner check (Touch ID / password) shows, naming the exact change; macOS puts it after
    /// "CURuntime is trying to". Built here from the decoded change and the system's app names (`names`, the
    /// daemon's panels; nil: the bundle ID alone), never from client text: notes are left out, a chord is shown as
    /// parsed. In the person's language (UILanguage, Chinese or English).
    public func settingsVerifyReason(_ c: SettingsChange, lang: UILanguage = .resolve(nil),
                                     names: (String) -> String? = { _ in nil }) -> String {
        let zh = lang == .zh
        func app(_ id: String) -> String {
            guard let n = names(id), !n.isEmpty else { return zh ? "「\(id)」" : "“\(id)”" }
            return zh ? "「\(n)」（\(id)）" : "“\(n)” (\(id))"
        }
        func mode(_ m: AppMode) -> String { m == .full ? (zh ? "可操作" : "operate") : (zh ? "浏览" : "browse") }
        func chord(_ t: String) -> String { (try? KeyChord.parse(t))?.description ?? ChangeFields.clip(t) }
        func list(_ items: [String]) -> String {
            let shown = items.prefix(4).joined(separator: zh ? "、" : ", ")
            return items.count > 4 ? shown + (zh ? " 等 \(items.count) 项" : " and \(items.count - 4) more") : shown
        }
        switch c {
        case .revoke(let id): return zh ? "撤销任务 \(ChangeFields.clip(id)) 的授权" : "revoke the approvals of task \(ChangeFields.clip(id))"
        case .revokeAll: return zh ? "撤销全部授权" : "revoke every approval"
        case .persistentRemove(let id): return zh ? "把\(app(id))移出始终允许名单" : "remove \(app(id)) from the always-allow list"
        case .persistentAdd(let id, let m):
            return zh ? "把\(app(id))（\(mode(m))）加入始终允许名单" : "add \(app(id)) (\(mode(m))) to the always-allow list"
        case .persistentMode(let id, let m):
            return zh ? "把始终允许名单里的\(app(id))改为\(mode(m))" : "change \(app(id)) on the always-allow list to \(mode(m))"
        case .persistentReapprove(let id):
            return zh ? "按\(app(id))现在的签名重新批准它的始终允许" : "approve \(app(id)) on the always-allow list again with its current signature"
        case .denyAdd(let id, _): return zh ? "把\(app(id))加入黑名单" : "add \(app(id)) to the deny list"
        case .denyRemove(let id): return zh ? "把\(app(id))移出黑名单" : "remove \(app(id)) from the deny list"
        case .access(let e):
            let v = e.value.stringValue ?? e.value.numberText
            return zh ? "把授权规则 \(e.field) 改为 \(v)" : "change the access rule \(e.field) to \(v)"
        case .chordDisable(let k): return zh ? "停用快捷键 \(chord(k))" : "switch the shortcut \(chord(k)) off"
        case .chordEnable(let k): return zh ? "重新启用快捷键 \(chord(k))" : "switch the shortcut \(chord(k)) on again"
        case .chordAdd(let k, let a, _):
            let scope = a.map(app) ?? (zh ? "所有已批准的应用" : "every approved app")
            return zh ? "为\(scope)添加快捷键 \(chord(k))" : "add the shortcut \(chord(k)) for \(scope)"
        case .chordRemove(let k, _): return zh ? "删除快捷键 \(chord(k))" : "remove the shortcut \(chord(k))"
        case .privacy(let field, let on):
            let what = field.label(zh: zh)
            if zh { return on ? "重新向模型发送\(what)" : "停止向模型发送\(what)" }
            return on ? "send \(what) to the model again" : "stop sending \(what) to the model"
        case .textOnlyAdd(let id): return zh ? "把\(app(id))加入仅文本应用" : "add \(app(id)) to the text-only apps"
        case .textOnlyRemove(let id):
            return zh ? "把\(app(id))移出仅文本应用（它的截图会再发送）" : "remove \(app(id)) from the text-only apps (its screenshots are sent again)"
        case .clipboard(let on):
            if zh { return on ? "每轮开始时清空剪贴板" : "每轮开始时不再清空剪贴板" }
            return on ? "empty the clipboard when a turn starts" : "stop emptying the clipboard when a turn starts"
        case .behavior(let e): return behaviorReason(e, zh: zh)
        case .logsRetention(let days):
            guard days < settings.logs.retentionDays else { return zh ? "把日志保留期限改为 \(days) 天" : "keep the log for \(days) days" }
            return zh ? "把日志保留期限缩短到 \(days) 天（更早的审计文件会立即删除）"
                : "shorten the log retention to \(days) days (older audit files are deleted at once)"
        case .useDefaultLogDirectory: return zh ? "把日志移回默认位置" : "move the log back to its default place"
        case .logDirectory(let url): return zh ? "把日志移到 \(Self.shownPath(url))" : "move the log to \(Self.shownPath(url))"
        case .reset:
            let l = settings.loosened(by: settings.resetToDefaults())
            if l.isEmpty { return zh ? "恢复默认设置" : "restore the default settings" }
            return zh ? "恢复默认设置（会放宽：\(list(l))）" : "restore the default settings (this loosens: \(list(l)))"
        case .importSettings(let new):
            let l = settings.loosened(by: new)
            if l.isEmpty { return zh ? "导入设置文件" : "import a settings file" }
            return zh ? "导入设置文件（会放宽：\(list(l))）" : "import a settings file (it loosens: \(list(l)))"
        }
    }

    private func behaviorReason(_ e: BehaviorEdit, zh: Bool) -> String {
        switch e {
        case .allowPointTargets(let on):
            if zh { return on ? "允许按坐标指定目标" : "不再允许按坐标指定目标" }
            return on ? "allow targets given as coordinates" : "refuse targets given as coordinates"
        case .imePolicyCap(let p):
            return zh ? "把输入法策略上限改为 \(p.rawValue)" : "set the input-source policy cap to \(p.rawValue)"
        case .electronAXAuto(let on):
            if zh { return on ? "为 Electron 应用自动开启辅助功能（AX）" : "不再为 Electron 应用自动开启辅助功能（AX）" }
            return on ? "switch accessibility (AX) on for Electron apps automatically" : "stop switching accessibility (AX) on for Electron apps"
        case .restoreFocusOnTurnEnd(let on):
            if zh { return on ? "每轮结束时恢复原来的前台应用" : "每轮结束时不再恢复前台应用" }
            return on ? "bring the earlier app back to the front when a turn ends" : "stop bringing the earlier app back when a turn ends"
        case .activationMethod(let m):
            let v = m?.rawValue ?? (zh ? "默认" : "the default")
            return zh ? "把激活方式改为 \(v)" : "set the activation method to \(v)"
        }
    }
}

private extension JSONValue {
    /// A whole number as the page shows it ("30", not "30.0").
    var numberText: String {
        if case .number(let n) = self, let i = Int(exactly: n) { return String(i) }
        return "\(self)"
    }
}
