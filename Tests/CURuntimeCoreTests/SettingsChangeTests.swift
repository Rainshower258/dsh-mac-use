import Foundation
import XCTest
@testable import CURuntimeCore

/// 2026-10-21: the settings over the socket, daemon side. The closed SettingsChange and its strict decode,
/// loosening decided by the daemon and enforced by every setter, one-field edits, the snapshot the page reads and the
/// audit lines it lists.
final class SettingsChangeTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("cu-settings-change-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    /// One sample of every decodable kind, with the change it decodes to.
    private let samples: [(JSONValue, SettingsChange)] = [
        (["kind": "revoke", "task_id": "t1"], .revoke(taskID: "t1")),
        (["kind": "revoke_all"], .revokeAll),
        (["kind": "persistent.remove", "bundle_id": .string(fixture)], .persistentRemove(bundleID: fixture)),
        (["kind": "persistent.add", "bundle_id": "com.tencent.qq", "mode": "full"], .persistentAdd(bundleID: "com.tencent.qq", mode: .full)),
        (["kind": "persistent.mode", "bundle_id": .string(fixture), "mode": "read"], .persistentMode(bundleID: fixture, mode: .read)),
        (["kind": "persistent.reapprove", "bundle_id": .string(fixture)], .persistentReapprove(bundleID: fixture)),
        (["kind": "deny.add", "bundle_id": .string(textEdit), "note": "mail"], .denyAdd(bundleID: textEdit, note: "mail")),
        (["kind": "deny.remove", "bundle_id": .string(textEdit)], .denyRemove(bundleID: textEdit)),
        (["kind": "access.set", "field": "default_mode", "value": "read"], .access(.defaultMode(.read))),
        (["kind": "access.set", "field": "session_limit_minutes", "value": 60], .access(.sessionLimitMinutes(60))),
        (["kind": "access.set", "field": "dialogs_per_turn", "value": 2], .access(.dialogsPerTurn(2))),
        (["kind": "access.set", "field": "dialog_timeout_seconds", "value": 180], .access(.dialogTimeoutSeconds(180))),
        (["kind": "access.set", "field": "dialog_default", "value": "turn"], .access(.dialogDefault(.turn))),
        (["kind": "chord.disable", "chord": "cmd+v"], .chordDisable(chord: "cmd+v")),
        (["kind": "chord.enable", "chord": "cmd+v"], .chordEnable(chord: "cmd+v")),
        (["kind": "chord.add", "chord": "cmd+k", "app": nil, "note": ""], .chordAdd(chord: "cmd+k", app: nil, note: "")),
        (["kind": "chord.add", "chord": "cmd+j", "app": .string(fixture), "note": "jump"], .chordAdd(chord: "cmd+j", app: fixture, note: "jump")),
        (["kind": "chord.remove", "chord": "cmd+k", "app": nil], .chordRemove(chord: "cmd+k", app: nil)),
        (["kind": "privacy.set", "field": "send_screenshots", "on": false], .privacy(.sendScreenshots, on: false)),
        (["kind": "privacy.set", "field": "send_ax_text", "on": true], .privacy(.sendAXText, on: true)),
        (["kind": "privacy.set", "field": "send_ocr", "on": true], .privacy(.sendOCR, on: true)),
        (["kind": "privacy.set", "field": "send_zoom", "on": false], .privacy(.sendZoom, on: false)),
        (["kind": "text_only.add", "bundle_id": .string(fixture)], .textOnlyAdd(bundleID: fixture)),
        (["kind": "text_only.remove", "bundle_id": .string(fixture)], .textOnlyRemove(bundleID: fixture)),
        (["kind": "clipboard.set", "on": true], .clipboard(on: true)),
        (["kind": "behavior.set", "field": "restore_focus_on_turn_end", "value": false], .behavior(.restoreFocusOnTurnEnd(false))),
        (["kind": "behavior.set", "field": "allow_point_targets", "value": true], .behavior(.allowPointTargets(true))),
        (["kind": "behavior.set", "field": "ime_policy_cap", "value": "ask"], .behavior(.imePolicyCap(.ask))),
        (["kind": "behavior.set", "field": "electron_ax_auto", "value": false], .behavior(.electronAXAuto(false))),
        (["kind": "behavior.set", "field": "activation_method", "value": "ax_raise"], .behavior(.activationMethod(.axRaise))),
        (["kind": "behavior.set", "field": "activation_method", "value": nil], .behavior(.activationMethod(nil))),
        (["kind": "logs.retention", "days": 7], .logsRetention(days: 7)),
        (["kind": "logs.default_directory"], .useDefaultLogDirectory),
        (["kind": "reset"], .reset),
    ]

    private func decodeFails(_ v: JSONValue?, _ why: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try SettingsChange.decode(v), why, file: file, line: line) {
            XCTAssertEqual(($0 as? RPCFailure)?.code, .invalidParams, why, file: file, line: line)
        }
    }

    // MARK: the closed change and its strict decode

    func testEveryKindDecodesAndAnExtraOrMissingKeyIsRefused() throws {
        XCTAssertEqual(Set(samples.compactMap { $0.0["kind"]?.stringValue }), Set(SettingsChange.keys.keys), "every kind sampled")
        for (json, change) in samples {
            let kind = try XCTUnwrap(json["kind"]?.stringValue)
            XCTAssertEqual(try SettingsChange.decode(json), change, kind)
            XCTAssertEqual(change.kind, kind)
            for extra in ["verified", "path", "directory", "state_dir", "kind2"] {
                var o = json.objectValue
                o[extra] = extra == "verified" ? true : "/tmp/x"
                decodeFails(.object(o), "\(kind) + \(extra)")
            }
            for key in SettingsChange.keys[kind] ?? [] {
                var o = json.objectValue
                o.removeValue(forKey: key)
                decodeFails(.object(o), "\(kind) - \(key)")
            }
        }
    }

    func testUnknownKindsWrongTypesAndValuesOutsideTheChoicesAreRefused() {
        decodeFails(nil, "no change")
        decodeFails(["revoke_all"], "not an object")
        decodeFails(["kind": 1], "kind not a string")
        for kind in ["logs.directory", "import", "settings.import", "deny.clear", ""] { decodeFails(["kind": .string(kind)], kind) }
        let bad: [(JSONValue, String)] = [
            (["kind": "clipboard.set", "on": "true"], "a string for a bool"),
            (["kind": "logs.retention", "days": 45], "45 days is not offered"),
            (["kind": "logs.retention", "days": 30.5], "not a whole number"),
            (["kind": "logs.retention", "days": "30"], "a string for a number"),
            (["kind": "persistent.add", "bundle_id": "com.tencent.qq", "mode": "admin"], "no such mode"),
            (["kind": "access.set", "field": "session_limit_minutes", "value": 45], "45 minutes is not offered"),
            (["kind": "access.set", "field": "dialog_default", "value": "always_full"], "no such button"),
            (["kind": "access.set", "field": "verified", "value": true], "no such field"),
            (["kind": "behavior.set", "field": "ime_policy_cap", "value": "anything"], "no such policy"),
            (["kind": "behavior.set", "field": "activation_method", "value": "teleport"], "no such method"),
            (["kind": "behavior.set", "field": "allow_point_targets", "value": nil], "null for a bool"),
            (["kind": "privacy.set", "field": "send_ui_text", "on": true], "the file key is send_ax_text"),
            (["kind": "deny.add", "bundle_id": "", "note": ""], "empty bundle ID"),
            (["kind": "deny.add", "bundle_id": "com.example app", "note": ""], "a space in a bundle ID"),
            (["kind": "deny.add", "bundle_id": .string(String(repeating: "a", count: 256)), "note": ""], "bundle ID over 255"),
            (["kind": "deny.add", "bundle_id": .string(textEdit), "note": .string(String(repeating: "n", count: 201))], "note over 200"),
            (["kind": "deny.add", "bundle_id": .string(textEdit), "note": "line\nbreak"], "a control character in a note"),
            (["kind": "deny.add", "bundle_id": .string(textEdit), "note": "rtl \u{202E}override"], "a format character in a note"),
            (["kind": "chord.add", "chord": .string(String(repeating: "k", count: 65)), "app": nil, "note": ""], "chord over 64"),
            (["kind": "chord.add", "chord": "cmd+k", "app": "", "note": ""], "an empty app (null is every app)"),
            (["kind": "chord.disable", "chord": " "], "a blank chord"),
            (["kind": "revoke", "task_id": 7], "a number for a task ID"),
        ]
        for (json, why) in bad { decodeFails(json, why) }
        XCTAssertNoThrow(try SettingsChange.decode(["kind": "deny.add", "bundle_id": .string(String(repeating: "a", count: 255)),
                                                    "note": .string(String(repeating: "n", count: 200))]), "the limits themselves")
    }

    // MARK: loosening decided by the daemon, enforced by the setters

    /// Settings tightened on every front, a persistent entry (read, pinned to an old signature), and a log folder.
    private func tightHarness() -> Harness {
        let h = Harness(settings: MemorySettingsStore(UserSettings(
            denylist: [DenyEntry(bundleId: textEdit, note: "", addedAt: Date())],
            access: AccessDefaults(sessionLimitMinutes: 15, dialogsPerTurn: 1),
            chords: ChordSettings(disabled: ["cmd+v"]),
            privacy: PrivacySettings(sendScreenshots: false, sendAXText: false, sendOCR: false, sendZoom: false, textOnlyApps: [fixture]),
            behavior: BehaviorSettings(allowPointTargets: false, imePolicyCap: .leave, electronAXAuto: false),
            logs: LogSettings(retentionDays: 90))))
        h.persistent.grants = [PersistentGrant(bundleId: fixture, mode: .read, requirement: "an old signature",
                                               path: "/Applications/DSHFixture.app", addedAt: Date(), via: "dialog")]
        h.dispatcher.defaultLogDirectory = dir.appendingPathComponent("audit")
        return h
    }

    func testEveryLooseningChangeIsRefusedUnverifiedAndAppliedVerified() throws {
        let loosening: [SettingsChange] = [
            .persistentAdd(bundleID: "com.tencent.qq", mode: .read), .persistentMode(bundleID: fixture, mode: .full),
            .persistentReapprove(bundleID: fixture), .denyRemove(bundleID: textEdit),
            .access(.defaultMode(.read)), .access(.sessionLimitMinutes(30)), .access(.dialogsPerTurn(2)), .access(.dialogDefault(.session)),
            .chordEnable(chord: "cmd+v"), .chordAdd(chord: "cmd+k", app: nil, note: "palette"),
            .privacy(.sendScreenshots, on: true), .privacy(.sendAXText, on: true), .privacy(.sendOCR, on: true), .privacy(.sendZoom, on: true),
            .textOnlyRemove(bundleID: fixture),
            .behavior(.allowPointTargets(true)), .behavior(.imePolicyCap(.ask)), .behavior(.electronAXAuto(true)),
            .logsRetention(days: 30), .reset, .importSettings(UserSettings()),
        ]
        for c in loosening {
            let h = tightHarness()
            let d = try XCTUnwrap(h.dispatcher)
            let before = (d.settings, h.persistent.grants)
            XCTAssertTrue(d.settingsLoosens(c), "\(c)")
            XCTAssertThrowsError(try d.settingsApply(c, verified: false), "\(c)") {
                XCTAssertEqual(($0 as? Denial)?.reason, "verification_required", "\(c)")
            }
            XCTAssertEqual(d.settings, before.0, "\(c): nothing changed")
            XCTAssertEqual(h.persistent.grants, before.1, "\(c): nothing changed")
            XCTAssertEqual(try d.settingsApply(c, verified: true), ["applied": true], "\(c)")
            XCTAssertTrue(d.settings != before.0 || h.persistent.grants != before.1, "\(c): applied")
        }
    }

    func testTighteningAndNoOpChangesApplyWithoutVerification() throws {
        let tightening: [SettingsChange] = [
            .revoke(taskID: "t9"), .revokeAll, .persistentRemove(bundleID: fixture), .persistentMode(bundleID: fixture, mode: .read),
            .denyAdd(bundleID: "com.tencent.qq", note: "chat"), .denyRemove(bundleID: "com.not.listed"),
            .access(.defaultMode(.ask)), .access(.dialogTimeoutSeconds(60)), .chordDisable(chord: "cmd+c"), .chordEnable(chord: "cmd+c"),
            .privacy(.sendOCR, on: false), .textOnlyAdd(bundleID: textEdit), .textOnlyRemove(bundleID: "com.not.listed"), .clipboard(on: true),
            .behavior(.allowPointTargets(false)), .behavior(.imePolicyCap(.leave)), .behavior(.restoreFocusOnTurnEnd(false)),
            .behavior(.activationMethod(.axRaise)), .logsRetention(days: 90), .useDefaultLogDirectory,
        ]
        for c in tightening {
            let h = tightHarness()
            let d = try XCTUnwrap(h.dispatcher)
            XCTAssertFalse(d.settingsLoosens(c), "\(c)")
            XCTAssertNoThrow(try d.settingsApply(c, verified: false), "\(c)")
        }
        // Changes the setter refuses anyway do not ask for a check first; they are refused for what they are.
        let h = tightHarness()
        let d = try XCTUnwrap(h.dispatcher)
        for (c, reason) in [(SettingsChange.persistentAdd(bundleID: "com.apple.Terminal", mode: .read), "hard_denied"),
                            (.persistentAdd(bundleID: "com.example.missing", mode: .read), "app_not_found"),
                            (.persistentReapprove(bundleID: "com.example.none"), "not_found"),
                            (.chordAdd(chord: "cmd+tab", app: nil, note: ""), "chord_never_allowed"),
                            (.chordEnable(chord: "cmd+nonsense+"), "invalid_chord")] {
            XCTAssertFalse(d.settingsLoosens(c), "\(c)")
            XCTAssertThrowsError(try d.settingsApply(c, verified: false), "\(c)") { XCTAssertEqual(($0 as? Denial)?.reason, reason, "\(c)") }
        }
    }

    func testTakingAnAppOffTheDenyListNeedsVerificationEvenFromTheWindowsSetter() throws {
        let h = tightHarness()
        let d = try XCTUnwrap(h.dispatcher)
        let lines = h.audit.entries.count
        XCTAssertThrowsError(try d.settingsDenylistRemove(bundleID: "COM.APPLE.TEXTEDIT", verified: false)) {
            XCTAssertEqual(($0 as? Denial)?.reason, "verification_required")
        }
        XCTAssertEqual(h.settingsStore.settings.denylist.map(\.bundleId), [textEdit], "still denied, nothing saved")
        XCTAssertEqual(h.audit.entries.count, lines, "nothing on record as removed")
        try d.settingsDenylistRemove(bundleID: textEdit, verified: true)
        XCTAssertTrue(d.settings.denylist.isEmpty)
        XCTAssertEqual(h.lastAudit["verified"], true)
    }

    func testOneFieldEditsApplyToTheLiveSettingsAndNeverUndoEachOther() throws {
        let h = Harness()
        let d = try XCTUnwrap(h.dispatcher)
        let stale = d.settings.behavior   // what a page showed before both edits
        try d.settingsApply(.behavior(.restoreFocusOnTurnEnd(false)), verified: false)
        try d.settingsApply(.behavior(.activationMethod(.axRaise)), verified: false)
        XCTAssertFalse(d.settings.behavior.restoreFocusOnTurnEnd, "the first edit is kept")
        XCTAssertEqual(d.settings.behavior.activationMethod, "ax_raise")
        XCTAssertTrue(stale.restoreFocusOnTurnEnd, "a whole copy from before would have undone it")
        try d.settingsEditBehavior(verified: false) { $0.allowPointTargets = false }
        XCTAssertEqual(d.settings.behavior, BehaviorSettings(restoreFocusOnTurnEnd: false, allowPointTargets: false, activationMethod: "ax_raise"))
        XCTAssertEqual(h.settingsStore.settings.behavior, d.settings.behavior, "saved")
        // The logs: a picked folder, then a retention, then the default place: each keeps the other field.
        d.defaultLogDirectory = dir.appendingPathComponent("audit")
        let picked = dir.appendingPathComponent("picked")
        try FileManager.default.createDirectory(at: picked, withIntermediateDirectories: true)
        XCTAssertFalse(d.settingsLoosens(.logDirectory(picked)), "the folder comes from the daemon's panel: not loosening")
        try d.settingsApply(.logDirectory(picked), verified: false)
        try d.settingsApply(.logsRetention(days: 90), verified: false)
        XCTAssertEqual(d.settings.logs, LogSettings(directory: picked.standardizedFileURL.path, retentionDays: 90))
        try d.settingsApply(.useDefaultLogDirectory, verified: false)
        XCTAssertEqual(d.settings.logs, LogSettings(retentionDays: 90))
        XCTAssertThrowsError(try d.settingsEditLogs(verified: false) { $0.retentionDays = 7 })
        XCTAssertEqual(d.settings.logs.retentionDays, 90)
    }

    func testAnImportOrResetThatChangesBehaviorOrTheRetentionCountsAsLoosening() throws {
        let tight = UserSettings(behavior: BehaviorSettings(allowPointTargets: false, imePolicyCap: .leave, electronAXAuto: false),
                                 logs: LogSettings(retentionDays: 90))
        XCTAssertEqual(Set(tight.loosened(by: UserSettings())), ["behavior.allow_point_targets", "behavior.ime_policy_cap",
                                                                 "behavior.electron_ax_auto", "logs.retention_days"])
        XCTAssertEqual(tight.loosened(by: UserSettings(behavior: BehaviorSettings(allowPointTargets: false, imePolicyCap: .ask, electronAXAuto: false),
                                                       logs: LogSettings(retentionDays: 90))), ["behavior.ime_policy_cap"])
        // Neither focus restore, the activation method nor a longer retention loosens.
        XCTAssertTrue(UserSettings().loosened(by: UserSettings(behavior: BehaviorSettings(restoreFocusOnTurnEnd: false, activationMethod: "ax_raise"),
                                                               logs: LogSettings(retentionDays: 90))).isEmpty)
        let h = Harness(settings: MemorySettingsStore(tight))
        let d = try XCTUnwrap(h.dispatcher)
        for c in [SettingsChange.importSettings(UserSettings()), .reset] {
            XCTAssertTrue(d.settingsLoosens(c))
            XCTAssertThrowsError(try d.settingsApply(c, verified: false)) { XCTAssertEqual(($0 as? Denial)?.reason, "verification_required") }
            XCTAssertEqual(d.settings, tight)
        }
        try d.settingsApply(.importSettings(UserSettings()), verified: true)
        XCTAssertEqual(d.settings.behavior, BehaviorSettings())
        XCTAssertEqual(d.settings.logs.retentionDays, 30)
        XCTAssertEqual(h.lastAudit["verified"], true)
    }

    // MARK: the audit's settings changes

    func testRecentSettingsChangesLeaveOutRequestOnlyLines() throws {
        let fmt = ISO8601DateFormatter()
        let now = try XCTUnwrap(fmt.date(from: "2026-10-21T12:00:00Z"))
        let utc = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let audit = try FileAudit(directory: dir.appendingPathComponent("audit"), timeZone: utc, now: { now })
        let lines: [[String: JSONValue]] = [
            ["method": "settings.load", "decision": "allow"],
            ["method": "settings.snapshot", "decision": "allow"],
            ["method": "settings.verify", "decision": "deny", "purpose": "settings.apply deny.remove", "detail": "failed"],
            ["method": "settings.cancel_verify", "decision": "allow"],
            ["method": "settings.ui", "decision": "allow", "action": "choose_log_directory"],
            ["method": "settings.action", "decision": "allow", "name": "reveal_log"],
            ["method": "settings.action", "decision": "allow", "name": "choose_log_directory", "changed": false],
            ["method": "settings.apply", "decision": "allow", "kind": "deny.remove", "status": "pending"],
            ["method": "settings.apply", "decision": "allow", "kind": "deny.remove", "outcome": "pending"],
            ["method": "settings.action", "decision": "allow", "name": "use_default_log_directory", "changed": true],
            ["method": "settings.apply", "decision": "allow", "kind": "deny.add", "status": "applied"],
            ["method": "settings.apply", "decision": "deny", "kind": "deny.remove", "stage": "settled", "outcome": "verify_failed"],
            ["method": "settings.denylist_remove", "decision": "allow", "app": .string(textEdit), "verified": true],
        ]
        for l in lines { audit.record(l) }
        let changes = AuditReader.recentSettingsChanges(directory: dir.appendingPathComponent("audit"), now: now, timeZone: utc)
        // No settings.apply line, applied or settled: the setter's own line is the change (listed once), and a failed
        // owner check is not a change.
        XCTAssertEqual(changes.map(\.method), ["settings.denylist_remove", "settings.action"])
    }

    func testAnImportKeepsTheLogFolderInForceWhenItIsApplied() throws {
        let h = Harness(settings: MemorySettingsStore(UserSettings()))
        let d = try XCTUnwrap(h.dispatcher)
        let chosen = dir.appendingPathComponent("chosen-logs")
        try FileManager.default.createDirectory(at: chosen, withIntermediateDirectories: true)
        var file = UserSettings()
        file.logs.directory = dir.appendingPathComponent("from-the-file").path
        // Taken before the folder changed (a preview), applied after: the folder in force stays.
        try d.settingsApply(SettingsChange.logDirectory(chosen), verified: false)
        let inForce = d.settings.logs.directory
        XCTAssertNotNil(inForce)
        try d.settingsApply(SettingsChange.importSettings(file), verified: true)
        XCTAssertEqual(d.settings.logs.directory, inForce)
    }

    // MARK: the snapshot the page reads

    func testTheSnapshotJSONHasThePagesFieldsAndNothingSecret() throws {
        let h = Harness(settings: MemorySettingsStore(UserSettings(
            denylist: [DenyEntry(bundleId: "com.tencent.qq", note: "chat", addedAt: Date())],
            chords: ChordSettings(disabled: ["cmd+v"], custom: [CustomChord(chord: "cmd+k", app: fixture, note: "palette", addedAt: Date())]))))
        let d = try XCTUnwrap(h.dispatcher)
        // The default log folder sits under the state directory: its path must not reach the page.
        let state = dir.appendingPathComponent("state-dir-marker")
        let logDir = state.appendingPathComponent("audit")
        try FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        d.defaultLogDirectory = logDir
        let day = try XCTUnwrap(AuditDays.last(1, now: h.clock).first)
        let ts = ISO8601DateFormatter.string(from: h.clock, timeZone: .current, formatOptions: [.withInternetDateTime, .withFractionalSeconds])
        let raw = [
            #"{"ts":"\#(ts)","method":"observe","decision":"deny","reason":"hard_denied","app":"com.apple.Terminal","detail":"a-secret-detail-text"}"#,
            #"{"ts":"\#(ts)","method":"settings.denylist_add","decision":"allow","app":"com.tencent.qq","note_len":4,"detail":"another-secret-detail"}"#,
            #"{"ts":"\#(ts)","method":"settings.privacy","decision":"allow","verified":true,"before":{"send_ocr":false}}"#,
        ].joined(separator: "\n") + "\n"
        try Data(raw.utf8).write(to: logDir.appendingPathComponent(AuditDays.fileName(day)))
        h.persistent.grants = [PersistentGrant(bundleId: textEdit, mode: .read, requirement: "identifier \"com.apple.TextEdit\" and anchor apple",
                                               path: "/System/Applications/TextEdit.app", addedAt: Date(), via: "dialog")]
        h.presenter.answer = .session
        let r = h.call("access.request", ["task_id": "t1", "app": .string(fixture), "mode": "read", "reason": "x", "interactive": true])
        assertAllowed(h.call("access.status", ["task_id": "t1", "request_id": (try? r.get())?["request_id"] ?? "none"]), in: h)

        let names: (String) -> String? = { ["com.tencent.qq": "QQ", fixture: "DSHFixture", textEdit: "TextEdit"][$0] }
        let snap = d.settingsSnapshotJSON(names: names)
        XCTAssertEqual(Set(snap.objectValue.keys), ["started_at", "grants", "persistent", "denylist", "hard_deny", "access", "access_choices",
                                                     "chords", "privacy", "behavior", "logs", "recent_refusals", "recent_changes"])
        guard case .array(let grants)? = snap["grants"], let g = grants.first, case .array(let apps)? = g["apps"], let a = apps.first else {
            return XCTFail("one grant with one app: \(snap["grants"] ?? .null)")
        }
        XCTAssertEqual(g["task_id"], "t1")
        XCTAssertEqual(g["by_dialog"], true)
        XCTAssertEqual(Set(a.objectValue.keys), ["bundle_id", "name", "mode", "scope", "expires_at"])
        XCTAssertEqual(a["name"], "DSHFixture")
        XCTAssertEqual(a["scope"], "session")
        XCTAssertEqual(snap["persistent"], [["bundle_id": .string(textEdit), "name": "TextEdit", "mode": "read",
                                             "added_at": h.persistent.grants[0].addedAt.json, "signature_ok": true]])
        XCTAssertEqual(snap["denylist"], [["bundle_id": "com.tencent.qq", "name": "QQ", "note": "chat"]])
        guard case .array(let floor)? = snap["hard_deny"] else { return XCTFail("hard_deny") }
        XCTAssertEqual(floor.count, HardDeny.entries.count + HardDeny.namespaces.count)
        XCTAssertTrue(floor.contains(["namespace": "com.jetbrains", "name": nil, "category": "runsCode"]))
        XCTAssertEqual(snap["access_choices"]?["session_limit_minutes"], [15, 30, 60])
        XCTAssertEqual(snap["chords"]?["custom"], [["chord": "cmd+k", "app": .string(fixture), "note": "palette"]])
        if case .array(let builtin)? = snap["chords"]?["builtin"] {
            XCTAssertEqual(builtin.count, ChordPolicy.builtinOrder.count)
            XCTAssertTrue(builtin.contains(["chord": "cmd+v", "enabled": false]))
        } else { XCTFail("builtin chords") }
        XCTAssertEqual(snap["logs"], ["directory": nil, "directory_custom": false, "retention_days": 30, "files": 1,
                                      "bytes": .number(Double(raw.utf8.count))])
        XCTAssertEqual(snap["recent_refusals"], [["at": .number(snap["recent_refusals"]?.arrayFirst?["at"]?.numberValue ?? -1),
                                                  "method": "observe", "app": "com.apple.Terminal", "reason": "hard_denied"]])
        guard case .array(let changes)? = snap["recent_changes"] else { return XCTFail("recent_changes") }
        XCTAssertEqual(changes.map { Set($0.objectValue.keys) }, Array(repeating: ["at", "method", "app", "reason", "verified"], count: 2))
        XCTAssertEqual(changes.first?["method"], "settings.privacy")
        XCTAssertEqual(changes.first?["verified"], true)
        XCTAssertEqual(changes.last?["app"], "com.tencent.qq")
        let text = try XCTUnwrap(String(bytes: JSONCoding.encode(snap), encoding: .utf8))
        for secret in ["a-secret-detail-text", "another-secret-detail", "state-dir-marker", "token", "\"detail\"", "requirement",
                       "anchor apple", "note_len", "before"] {
            XCTAssertFalse(text.contains(secret), secret)
        }
        // A folder the person picked is shown, under ~ when it is in the home directory.
        let picked = dir.appendingPathComponent("picked")
        try FileManager.default.createDirectory(at: picked, withIntermediateDirectories: true)
        try d.settingsApply(.logDirectory(picked), verified: false)
        XCTAssertEqual(d.settingsSnapshotJSON()["logs"]?["directory_custom"], true)
        XCTAssertEqual(d.settingsSnapshotJSON()["logs"]?["directory"]?.stringValue,
                       Dispatcher.shownPath(picked.appendingPathComponent(LogSettings.subdirectory)))
        XCTAssertNil(d.settingsSnapshotJSON()["denylist"]?.arrayFirst?["name"]?.stringValue, "no resolver: no names")
    }

    // MARK: the reason the owner check shows, the summary the page shows

    func testTheVerifyReasonNamesTheExactChangeInThePersonsLanguageAndNeverTheNote() throws {
        let h = tightHarness()
        let d = try XCTUnwrap(h.dispatcher)
        let names: (String) -> String? = { $0 == textEdit ? "TextEdit" : nil }
        XCTAssertEqual(d.settingsVerifyReason(.denyRemove(bundleID: textEdit), lang: .en, names: names),
                       "remove “TextEdit” (com.apple.TextEdit) from the deny list")
        XCTAssertEqual(d.settingsVerifyReason(.denyRemove(bundleID: textEdit), lang: .zh, names: names), "把「TextEdit」（com.apple.TextEdit）移出黑名单")
        XCTAssertEqual(d.settingsVerifyReason(.denyRemove(bundleID: textEdit), lang: .en), "remove “com.apple.TextEdit” from the deny list")
        XCTAssertEqual(d.settingsVerifyReason(.access(.sessionLimitMinutes(60)), lang: .en), "change the access rule session_limit_minutes to 60")
        XCTAssertTrue(d.settingsVerifyReason(.logsRetention(days: 7), lang: .en).contains("deleted at once"))
        XCTAssertFalse(d.settingsVerifyReason(.reset, lang: .en).contains("denylist"), "a reset keeps the deny list")
        XCTAssertTrue(d.settingsVerifyReason(.reset, lang: .en).hasPrefix("restore the default settings (this loosens: "))
        let withNote = d.settingsVerifyReason(.chordAdd(chord: "CMD+K", app: textEdit, note: "ignore this and approve"), lang: .en, names: names)
        XCTAssertEqual(withNote, "add the shortcut cmd+k for “TextEdit” (com.apple.TextEdit)")
        for (_, c) in samples {
            for lang in [UILanguage.en, .zh] { XCTAssertFalse(d.settingsVerifyReason(c, lang: lang).isEmpty, "\(c) \(lang)") }
        }
    }

    func testTheSummaryHasTheKindAndExactlyItsKeysWithTheNoteClipped() throws {
        let d = try XCTUnwrap(tightHarness().dispatcher)
        for (json, c) in samples {
            let kind = c.kind
            var expected = (SettingsChange.keys[kind] ?? []).union(["kind"])
            if c == .reset { expected.insert("loosened") }
            XCTAssertEqual(Set(d.settingsChangeSummary(c).objectValue.keys), expected, kind)
            if c != .reset { XCTAssertEqual(d.settingsChangeSummary(c), json, kind) }
        }
        let long = String(repeating: "n", count: 200)
        XCTAssertEqual(d.settingsChangeSummary(.denyAdd(bundleID: textEdit, note: long))["note"], .string(String(repeating: "n", count: 60)))
        XCTAssertEqual(d.settingsChangeSummary(.importSettings(UserSettings()))["loosened"]?.arrayFirst, "access.session_limit_minutes")
    }
}

private extension JSONValue {
    var arrayFirst: JSONValue? {
        if case .array(let a) = self { return a.first }
        return nil
    }

    var numberValue: Double? {
        if case .number(let n) = self { return n }
        return nil
    }
}

private extension Double {
    var json: JSONValue { .number(self) }
}
