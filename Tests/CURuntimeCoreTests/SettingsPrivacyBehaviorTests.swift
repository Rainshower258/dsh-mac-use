import Foundation
import XCTest
@testable import CURuntimeCore

/// The settings window's side of the daemon, continued (SettingsTests grew past SwiftLint's type length, 2026-10-17):
/// privacy (batch 3), the log's place and retention, behavior with import and reset (batch 4).
final class SettingsPrivacyBehaviorTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("cu-settings-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    private func request(_ h: Harness, _ app: String, mode: String = "read", task: String = "t1") -> Result<JSONValue, RPCFailure> {
        h.call("access.request", ["task_id": .string(task), "app": .string(app), "mode": .string(mode),
                                  "reason": "read it", "interactive": true])
    }

    private func approve(_ h: Harness, _ app: String, mode: String = "read", _ answer: DialogAnswer = .session) {
        h.presenter.answer = answer
        let r = request(h, app, mode: mode)
        assertAllowed(h.call("access.status", ["task_id": "t1", "request_id": (try? r.get())?["request_id"] ?? "none"]), in: h)
    }


    // MARK: privacy (batch 3, 2026-10-17)

    private func observe(_ h: Harness, image: Bool = true, ocr: String = "on") -> Result<JSONValue, RPCFailure> {
        h.call("observe", ["task_id": "t1", "include_image": .bool(image), "ocr": .string(ocr)])
    }

    func testThePrivacySwitchesCutWhatObserveAndZoomSend() throws {
        let h = Harness()
        h.env.observeResult.elements = [
            ObservedElement(source: .ax, app: fixture, role: "AXStaticText", text: "a private line", frame: CGRect(x: 120, y: 120, width: 200, height: 20), confidence: nil),
            ObservedElement(source: .ocr, app: nil, role: nil, text: "read off the pixels", frame: CGRect(x: 120, y: 300, width: 200, height: 20), confidence: 0.9),
        ]
        approve(h, fixture)
        // Defaults: everything asked for goes through.
        assertAllowed(observe(h), in: h)
        XCTAssertEqual(h.env.observeRequests.last?.includeImage, true)
        XCTAssertEqual(h.env.observeRequests.last?.ocr, true)
        XCTAssertNil(h.lastAudit["image_off"])
        // Everything off: no image, no OCR, AX elements without their text; zoom refused.
        try XCTUnwrap(h.dispatcher).settingsSetPrivacy(PrivacySettings(sendScreenshots: false, sendAXText: false, sendOCR: false, sendZoom: false), verified: false)
        let r = observe(h)
        assertAllowed(r, in: h)
        XCTAssertEqual(h.env.observeRequests.last?.includeImage, false)
        XCTAssertEqual(h.env.observeRequests.last?.ocr, false)
        XCTAssertEqual(h.lastAudit["image_off"], "settings")
        XCTAssertEqual(h.lastAudit["ocr_off"], "settings")
        XCTAssertEqual(h.lastAudit["ax_text_off"], "settings")
        var texts: [String] = []
        if case .array(let els)? = (try? r.get())?["untrusted_observation"]?["elements"] { texts = els.compactMap { $0["text"]?.stringValue } }
        XCTAssertFalse(texts.isEmpty)
        XCTAssertFalse(texts.contains("a private line"), "AX text withheld: \(texts)")
        assertDenied(h.call("zoom", ["task_id": "t1", "snapshot_gen": 1, "element_id": "a1"]), "zoom_off", in: h)
    }

    // VM round 17 (2026-10-17): the window wrote back a whole copy taken at the click once the owner check passed,
    // undoing what changed while the check was open. An edit applies to the settings as they are then.
    func testAPrivacyEditAfterTheCheckKeepsWhatChangedMeanwhile() throws {
        let h = Harness(settings: MemorySettingsStore(UserSettings(privacy: PrivacySettings(sendScreenshots: false, sendOCR: false))))
        let d = try XCTUnwrap(h.dispatcher)
        try d.settingsEditPrivacy(verified: false) { $0.sendZoom = false }   // switched off while the OCR check is open
        try d.settingsEditPrivacy(verified: true) { $0.sendOCR = true }     // the check passes
        let p = d.settingsSnapshot().settings.privacy
        XCTAssertTrue(p.sendOCR)
        XCTAssertFalse(p.sendZoom, "the switch turned off meanwhile stays off")
        XCTAssertFalse(p.sendScreenshots)
        XCTAssertThrowsError(try d.settingsEditPrivacy(verified: false) { $0.sendScreenshots = true }, "still verified to loosen")
    }

    func testAnAccessEditAfterTheCheckKeepsWhatChangedMeanwhile() throws {
        let h = Harness()
        let d = try XCTUnwrap(h.dispatcher)
        try d.settingsEditAccess(verified: false) { $0.dialogsPerTurn = 1 }
        try d.settingsEditAccess(verified: true) { $0.sessionLimitMinutes = 60 }
        let a = d.settingsSnapshot().settings.access
        XCTAssertEqual(a.sessionLimitMinutes, 60)
        XCTAssertEqual(a.dialogsPerTurn, 1, "the tightening made meanwhile stays")
        XCTAssertThrowsError(try d.settingsEditAccess(verified: false) { $0.dialogsPerTurn = 3 }, "still verified to loosen")
    }

    func testATextOnlyAppNeverHasAScreenshotSent() throws {
        let h = Harness(settings: MemorySettingsStore(UserSettings(privacy: PrivacySettings(textOnlyApps: [fixture.uppercased()]))))
        approve(h, fixture)
        assertAllowed(observe(h), in: h)
        XCTAssertEqual(h.env.observeRequests.last?.includeImage, false)
        XCTAssertEqual(h.lastAudit["image_off"], "text_only_app")
        XCTAssertEqual(h.env.observeRequests.last?.ocr, true, "text still goes")
    }

    func testTheClipboardIsEmptiedWhenATurnStartsIfSet() throws {
        let h = Harness()
        assertAllowed(h.call("access.turn_start", ["task_id": "t9"]), in: h)
        XCTAssertEqual(h.env.pasteboardClears, 0)
        try XCTUnwrap(h.dispatcher).settingsSetPrivacy(PrivacySettings(clearClipboardOnTurnStart: true), verified: false)
        assertAllowed(h.call("access.turn_start", ["task_id": "t8"]), in: h)
        XCTAssertEqual(h.env.pasteboardClears, 1)
        XCTAssertEqual(h.lastAudit["clipboard_cleared"], true)
    }

    func testLooseningPrivacyNeedsVerificationTighteningDoesNot() throws {
        let h = Harness()
        let d = try XCTUnwrap(h.dispatcher)
        try d.settingsSetPrivacy(PrivacySettings(sendScreenshots: false, textOnlyApps: [textEdit], clearClipboardOnTurnStart: true), verified: false)
        XCTAssertEqual(h.lastAudit["method"], "settings.privacy")
        XCTAssertEqual(h.lastAudit["loosened"], .array([]))
        XCTAssertTrue(h.settingsStore.settings.privacy.clearClipboardOnTurnStart)
        for new in [PrivacySettings(sendScreenshots: true, textOnlyApps: [textEdit], clearClipboardOnTurnStart: true),
                    PrivacySettings(sendScreenshots: false, textOnlyApps: [], clearClipboardOnTurnStart: true)] {
            XCTAssertThrowsError(try d.settingsSetPrivacy(new, verified: false)) { XCTAssertEqual(($0 as? Denial)?.reason, "verification_required") }
        }
        // Neither: the clipboard switch off.
        try d.settingsSetPrivacy(PrivacySettings(sendScreenshots: false, textOnlyApps: [textEdit], clearClipboardOnTurnStart: false), verified: false)
        try d.settingsSetPrivacy(PrivacySettings(), verified: true)
        XCTAssertEqual(h.lastAudit["loosened"], .array(["send_screenshots", "text_only_apps"]))
    }

    // MARK: the log's place and retention (2026-10-17)

    func testTheLogSettingsAreValidatedAndAppliedAndAMissingFolderIsRefused() throws {
        let h = Harness()
        let d = try XCTUnwrap(h.dispatcher)
        XCTAssertNil(d.effectiveLogDirectory, "no default in tests")
        d.defaultLogDirectory = dir.appendingPathComponent("audit")
        XCTAssertEqual(d.effectiveLogDirectory, dir.appendingPathComponent("audit"))
        XCTAssertThrowsError(try d.settingsSetLogs(LogSettings(retentionDays: 45)))
        XCTAssertThrowsError(try d.settingsSetLogs(LogSettings(directory: "relative/path")))
        XCTAssertThrowsError(try d.settingsSetLogs(LogSettings(directory: dir.appendingPathComponent("nowhere").path))) {
            XCTAssertEqual(($0 as? Denial)?.reason, "log_directory_missing")
        }
        XCTAssertNil(h.settingsStore.settings.logs.directory, "nothing saved")
        let chosen = dir.appendingPathComponent("chosen")
        try FileManager.default.createDirectory(at: chosen, withIntermediateDirectories: true)
        // 30 -> 7 days deletes audit files at once: loosening (stage 3a), refused unverified with nothing changed.
        XCTAssertThrowsError(try d.settingsSetLogs(LogSettings(directory: chosen.path, retentionDays: 7))) {
            XCTAssertEqual(($0 as? Denial)?.reason, "verification_required")
        }
        XCTAssertNil(h.settingsStore.settings.logs.directory)
        try d.settingsSetLogs(LogSettings(directory: chosen.path, retentionDays: 7), verified: true)
        XCTAssertEqual(h.lastAudit["method"], "settings.logs")
        XCTAssertEqual(h.lastAudit["loosened"], .array(["retention_days"]))
        XCTAssertEqual(h.settingsStore.settings.logs.retentionDays, 7)
        XCTAssertEqual(d.effectiveLogDirectory?.path, chosen.appendingPathComponent(LogSettings.subdirectory).path)
        XCTAssertEqual(d.settingsSnapshot().logDirectory?.path, d.effectiveLogDirectory?.path)
        // A reset keeps the place.
        try d.settingsReset(verified: false)
        XCTAssertEqual(d.settings.logs.directory, chosen.path)
        // A v2 file without `logs` gets the defaults.
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        XCTAssertEqual(try decoder.decode(UserSettings.self, from: Data(#"{"version":2}"#.utf8)).logs, LogSettings())
    }

    // VM round 17 (2026-10-17): through the dispatcher (an AuditSink) the move never happened. FileAudit's
    // setDirectory returned Int, the protocol's did not, so the call went to the protocol's empty default: the setting
    // was saved, the log stayed where it was until the next start, and the days before were left behind.
    func testChangingTheLogPlaceThroughTheDispatcherMovesTheFilesAndTheWriting() throws {
        let fm = FileManager.default
        let base = dir.appendingPathComponent("default"), picked = dir.appendingPathComponent("picked")
        try fm.createDirectory(at: base, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try fm.createDirectory(at: picked, withIntermediateDirectories: true)
        fm.createFile(atPath: base.appendingPathComponent("audit-2026-10-10.jsonl").path, contents: Data("{}\n".utf8),
                      attributes: [.posixPermissions: 0o600])
        let audit = try FileAudit(directory: base)
        let d = Dispatcher(grants: GrantStore(), env: FakeEnv(), config: PolicyConfig(), audit: audit,
                           settingsStore: FileSettingsStore(stateDir: dir))
        d.defaultLogDirectory = base
        let moved = picked.appendingPathComponent(LogSettings.subdirectory)
        try d.settingsSetLogs(LogSettings(directory: picked.path))
        XCTAssertEqual(audit.currentDirectory.path, moved.path)
        XCTAssertTrue(fm.fileExists(atPath: moved.appendingPathComponent("audit-2026-10-10.jsonl").path), "the days before go too")
        XCTAssertFalse(fm.fileExists(atPath: base.appendingPathComponent("audit-2026-10-10.jsonl").path))
        let today = try String(contentsOf: audit.path(for: Date()), encoding: .utf8)
        XCTAssertTrue(today.contains("\"settings.logs\""), "the change is on record in the new place")
        try d.settingsSetLogs(LogSettings())
        XCTAssertEqual(audit.currentDirectory.path, base.path)
        XCTAssertTrue(fm.fileExists(atPath: base.appendingPathComponent("audit-2026-10-10.jsonl").path), "and back")
    }

    func testTheFileAuditMovesItsDayFilesToTheNewDirectoryAndWritesThereFromThenOn() throws {
        let fm = FileManager.default
        let old = dir.appendingPathComponent("old"), new = dir.appendingPathComponent("picked").appendingPathComponent(LogSettings.subdirectory)
        try fm.createDirectory(at: old, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try fm.createDirectory(at: dir.appendingPathComponent("picked"), withIntermediateDirectories: true)
        fm.createFile(atPath: old.appendingPathComponent("audit-2026-10-10.jsonl").path, contents: Data("{}\n".utf8), attributes: [.posixPermissions: 0o600])
        fm.createFile(atPath: old.appendingPathComponent("keep.txt").path, contents: Data(), attributes: [.posixPermissions: 0o600])
        let fmt = ISO8601DateFormatter()
        let now = try XCTUnwrap(fmt.date(from: "2026-10-17T12:00:00Z"))
        let audit = try FileAudit(directory: old, timeZone: TimeZone(secondsFromGMT: 0)!, now: { now })
        audit.record(["method": "before", "decision": "allow"])
        XCTAssertEqual(try audit.setDirectory(new), 2, "yesterday's file and today's")
        XCTAssertEqual(audit.currentDirectory.path, new.path)
        audit.record(["method": "after", "decision": "allow"])
        let todayNew = try String(contentsOf: new.appendingPathComponent("audit-2026-10-17.jsonl"), encoding: .utf8)
        XCTAssertTrue(todayNew.contains("\"before\"") && todayNew.contains("\"after\""), "the day's file continues in the new place")
        XCTAssertTrue(fm.fileExists(atPath: new.appendingPathComponent("audit-2026-10-10.jsonl").path))
        XCTAssertFalse(fm.fileExists(atPath: old.appendingPathComponent("audit-2026-10-10.jsonl").path))
        XCTAssertTrue(fm.fileExists(atPath: old.appendingPathComponent("keep.txt").path), "only this prefix's day files move")
        let mode = (try fm.attributesOfItem(atPath: new.path))[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o700)
        // A directory that cannot be ours: refused, nothing moved, writing goes on where it was.
        let bad = dir.appendingPathComponent("bad")
        try fm.createDirectory(at: bad, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
        XCTAssertThrowsError(try audit.setDirectory(bad))
        XCTAssertEqual(audit.currentDirectory.path, new.path)
        // The retention prunes in the new place.
        fm.createFile(atPath: new.appendingPathComponent("audit-2026-01-01.jsonl").path, contents: Data(), attributes: [.posixPermissions: 0o600])
        audit.setRetention(days: 7)
        XCTAssertFalse(fm.fileExists(atPath: new.appendingPathComponent("audit-2026-01-01.jsonl").path))
    }

    func testTheAuditKeepsOnlyTheRetentionDaysAndReadsSettingsChangesBack() throws {
        let fm = FileManager.default
        let dir = self.dir.appendingPathComponent("audit")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        for name in ["audit-2026-09-01.jsonl", "audit-2026-10-10.jsonl", "audit-2026-10-11.jsonl", "audit-2026-10-16.jsonl",
                     "notes.txt", "other-2026-09-01.jsonl"] {
            fm.createFile(atPath: dir.appendingPathComponent(name).path, contents: Data("{}\n".utf8), attributes: [.posixPermissions: 0o600])
        }
        let fmt = ISO8601DateFormatter()
        let now = try XCTUnwrap(fmt.date(from: "2026-10-17T12:00:00Z"))
        let audit = try FileAudit(directory: dir, timeZone: TimeZone(secondsFromGMT: 0)!, now: { now })
        audit.setRetention(days: 7)
        let left = Set(try fm.contentsOfDirectory(atPath: dir.path))
        // 7 days = 10-11 … 10-17, the export's days (until 2026-10-17 10-10 was kept too: 8 days).
        XCTAssertEqual(left, ["audit-2026-10-11.jsonl", "audit-2026-10-16.jsonl", "audit-2026-10-17.jsonl", "notes.txt", "other-2026-09-01.jsonl"])
        audit.record(["method": "settings.open", "decision": "allow"])
        audit.record(["method": "settings.privacy", "decision": "allow", "loosened": .array([])])
        audit.record(["method": "settings.self_check", "decision": "allow"])
        audit.record(["method": "access.request", "decision": "deny", "reason": "hard_denied"])
        let changes = AuditReader.recentSettingsChanges(directory: dir, now: now, timeZone: TimeZone(secondsFromGMT: 0)!)
        XCTAssertEqual(changes.map(\.method), ["settings.privacy"])
        XCTAssertEqual(changes.first?.fields["loosened"], .array([]))
        XCTAssertNil(changes.first?.fields["ts"])
    }

    func testTheLogsDaysAreLocalDaysTodayFirst() throws {
        let cst = try XCTUnwrap(TimeZone(identifier: "Asia/Shanghai"))
        // 07:00 on 10-18 in UTC+8 is still 10-17 in UTC: today's file is 10-18's, as FileAudit names it.
        let early = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-17T23:00:00Z"))
        XCTAssertEqual(AuditDays.last(2, now: early, timeZone: cst), ["2026-10-18", "2026-10-17"])
        XCTAssertEqual(AuditDays.last(7, now: early, timeZone: cst).last, "2026-10-12")
        let fm = FileManager.default
        let dir = self.dir.appendingPathComponent("audit")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let audit = try FileAudit(directory: dir, timeZone: cst, now: { early })
        audit.record(["method": "observe", "decision": "deny", "reason": "hard_denied"])
        XCTAssertTrue(fm.fileExists(atPath: dir.appendingPathComponent("audit-2026-10-18.jsonl").path))
        XCTAssertEqual(AuditReader.recentRefusals(directory: dir, now: early, timeZone: cst).count, 1, "read on the writer's day")
    }

    // MARK: behavior, import, reset (batch 4, 2026-10-17)

    func testTheBehaviorSettingsCapTheInputSourcePolicyAndElectronAXAndPickTheActivationMethod() throws {
        let h = Harness()
        let d = try XCTUnwrap(h.dispatcher)
        XCTAssertEqual(d.activationMethod, Dispatcher.defaultActivationMethod)
        try d.settingsSetBehavior(BehaviorSettings(imePolicyCap: .leave, electronAXAuto: false, activationMethod: "ax_raise"))
        XCTAssertEqual(h.lastAudit["method"], "settings.behavior")
        XCTAssertEqual(d.activationMethod, .axRaise)
        h.presenter.answer = .session
        let r = h.call("access.request", ["task_id": "t1", "app": .string(fixture), "mode": "full", "reason": "x", "interactive": true,
                                          "ime_policy": "takeover", "electron_ax": true])
        assertAllowed(h.call("access.status", ["task_id": "t1", "request_id": (try? r.get())?["request_id"] ?? "none"]), in: h)
        let g = try XCTUnwrap(d.grants.current("t1", now: h.clock))
        XCTAssertEqual(g.imePolicy, .leave)
        XCTAssertFalse(g.electronAX)
        XCTAssertThrowsError(try d.settingsSetBehavior(BehaviorSettings(activationMethod: "teleport")))
        // The default cap lets the plugin's choice through. Back to it raises the cap and switches Electron AX on:
        // loosening (stage 3a), so verified.
        XCTAssertThrowsError(try d.settingsSetBehavior(BehaviorSettings())) {
            XCTAssertEqual(($0 as? Denial)?.reason, "verification_required")
        }
        XCTAssertEqual(d.settings.behavior.imePolicyCap, .leave, "unchanged")
        try d.settingsSetBehavior(BehaviorSettings(), verified: true)
        XCTAssertEqual(h.lastAudit["loosened"], .array(["ime_policy_cap", "electron_ax_auto"]))
        XCTAssertEqual(BehaviorSettings().imePolicy(requested: .takeover), .takeover)
        XCTAssertEqual(BehaviorSettings(imePolicyCap: .ask).imePolicy(requested: .takeover), .ask)
        XCTAssertEqual(BehaviorSettings(imePolicyCap: .ask).imePolicy(requested: .leave), .leave)
    }

    func testCoordinateTargetsAndFocusRestoreCanBeSwitchedOff() throws {
        let h = Harness()
        let d = try XCTUnwrap(h.dispatcher)
        approve(h, fixture, mode: "full")
        let click: JSONValue = ["task_id": "t1", "app": .string(fixture), "point": ["x": 200, "y": 200, "space": "screen"]]
        h.autoSnapshot = false
        assertDenied(h.call("act.click", click), "snapshot_required", in: h)  // the gate under test is not this one
        try d.settingsSetBehavior(BehaviorSettings(restoreFocusOnTurnEnd: false, allowPointTargets: false))
        assertDenied(h.call("act.click", click), "point_targets_off", in: h)
        assertAllowed(h.call("access.turn_end", ["task_id": "t1", "restore_focus": true]), in: h)
        XCTAssertEqual(h.lastAudit["focus_restore_off"], "settings")
    }

    func testAnImportListsWhatItLoosensNeedsVerificationForItAndAResetKeepsTheRestrictions() throws {
        let h = Harness(settings: MemorySettingsStore(UserSettings(
            denylist: [DenyEntry(bundleId: textEdit, note: "", addedAt: Date())],
            access: AccessDefaults(dialogsPerTurn: 1),
            chords: ChordSettings(disabled: ["cmd+v"], custom: [CustomChord(chord: "cmd+k", app: nil, note: "", addedAt: Date())]),
            privacy: PrivacySettings(sendScreenshots: false, textOnlyApps: [fixture]))))
        let d = try XCTUnwrap(h.dispatcher)
        // The file loosens on every front.
        let file = UserSettings(access: AccessDefaults(dialogsPerTurn: 3), chords: ChordSettings(custom: [
            CustomChord(chord: "cmd+k", app: nil, note: "", addedAt: Date()), CustomChord(chord: "cmd+j", app: fixture, note: "", addedAt: Date())]))
        let loosened = d.settings.loosened(by: file)
        XCTAssertEqual(Set(loosened), ["access.dialogs_per_turn", "privacy.send_screenshots", "privacy.text_only_apps",
                                       "denylist.remove:\(textEdit)", "chords.enable:cmd+v", "chords.add:cmd+j"])
        XCTAssertThrowsError(try d.settingsImport(file, verified: false)) { XCTAssertEqual(($0 as? Denial)?.reason, "verification_required") }
        XCTAssertEqual(d.settings.access.dialogsPerTurn, 1, "unchanged")
        // A file that only tightens: no verification.
        var tighter = d.settings
        tighter.privacy.sendOCR = false
        try d.settingsImport(tighter, verified: false)
        XCTAssertEqual(h.lastAudit["method"], "settings.import")
        XCTAssertEqual(h.lastAudit["loosened"], .array([]))
        XCTAssertFalse(d.settings.privacy.sendOCR)
        // Verified: taken whole; the version is the daemon's.
        var old = file
        old.version = 1
        try d.settingsImport(old, verified: true)
        XCTAssertEqual(d.settings.version, UserSettings.currentVersion)
        XCTAssertEqual(d.settings.access.dialogsPerTurn, 3)
        XCTAssertTrue(d.settings.denylist.isEmpty)
        XCTAssertEqual(h.settingsStore.settings.chords.custom.count, 2)
        // Round trip through the file format.
        XCTAssertEqual(try UserSettings.decode(try d.settings.encoded()), d.settings)
        // The reset keeps the deny list, the text-only apps and the switched-off chords; drops the user's chords.
        try d.settingsImport(UserSettings(denylist: [DenyEntry(bundleId: textEdit, note: "", addedAt: Date())],
                                          access: AccessDefaults(dialogsPerTurn: 1), chords: ChordSettings(disabled: ["cmd+v"], custom: [
                                              CustomChord(chord: "cmd+k", app: nil, note: "", addedAt: Date())]),
                                          privacy: PrivacySettings(textOnlyApps: [fixture])), verified: false)
        XCTAssertThrowsError(try d.settingsReset(verified: false), "1 -> 3 dialogs is loosening") {
            XCTAssertEqual(($0 as? Denial)?.reason, "verification_required")
        }
        try d.settingsReset(verified: true)
        XCTAssertEqual(h.lastAudit["method"], "settings.reset")
        XCTAssertEqual(d.settings.denylist.map(\.bundleId), [textEdit])
        XCTAssertEqual(d.settings.privacy.textOnlyApps, [fixture])
        XCTAssertEqual(d.settings.chords.disabled, ["cmd+v"])
        XCTAssertTrue(d.settings.chords.custom.isEmpty)
        XCTAssertEqual(d.settings.access, AccessDefaults())
        XCTAssertEqual(d.settings.behavior, BehaviorSettings())
    }

    func testAnImportThatDeniesAnAppDropsItFromActiveGrants() throws {
        let h = Harness()
        let d = try XCTUnwrap(h.dispatcher)
        approve(h, fixture)
        var s = d.settings
        s.denylist = [DenyEntry(bundleId: fixture, note: "", addedAt: Date())]
        try d.settingsImport(s, verified: false)
        assertDenied(h.call("observe", ["task_id": "t1", "app": .string(fixture), "ocr": "off"]), "no_grant", in: h)
    }

}
