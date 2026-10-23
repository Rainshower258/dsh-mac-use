import Foundation
import XCTest
@testable import CURuntimeCore

/// Stage 3a, contract C-B2 (2026-10-21): the settings over the socket. A loosening change waits for the daemon's own
/// owner check and only its ok applies it; nothing from the client stands in for that check; the panels are the
/// daemon's, and no path, token or audit content goes back over the socket.
final class SettingsRPCTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("cu-settings-rpc-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    /// Tightened on every front (as SettingsChangeTests' tight harness), so each loosening kind has something to loosen.
    private static func tight(sendOCR: Bool = false) -> UserSettings {
        UserSettings(
            denylist: [DenyEntry(bundleId: textEdit, note: "", addedAt: Date())],
            access: AccessDefaults(sessionLimitMinutes: 15, dialogsPerTurn: 1),
            chords: ChordSettings(disabled: ["cmd+v"]),
            privacy: PrivacySettings(sendScreenshots: false, sendAXText: false, sendOCR: sendOCR, sendZoom: false, textOnlyApps: [fixture]),
            behavior: BehaviorSettings(allowPointTargets: false, imePolicyCap: .leave, electronAXAuto: false),
            logs: LogSettings(retentionDays: 90))
    }

    private struct Rig {
        let h: Harness
        let d: Dispatcher
        let verifier: FakeOwnerVerifier
        let panels: FakeSettingsPanels
    }

    /// A harness with the daemon's owner check (a fake verifier: `verdict` nil keeps each check open until finish)
    /// and, unless `panels` is false, the fake panels with app names.
    private func rig(_ s: UserSettings = tight(), verdict: OwnerVerdict? = nil, panels: Bool = true) -> Rig {
        let h = Harness(settings: MemorySettingsStore(s))
        h.persistent.grants = [PersistentGrant(bundleId: fixture, mode: .read, requirement: "an old signature",
                                               path: "/Applications/DSHFixture.app", addedAt: Date(), via: "dialog")]
        h.dispatcher.defaultLogDirectory = dir.appendingPathComponent("state-dir-marker").appendingPathComponent("audit")
        let v = FakeOwnerVerifier(verdict: verdict)
        h.dispatcher.ownerCheck = OwnerCheck(verifier: v, audit: h.audit, now: { [weak h] in h?.clock ?? Date() })
        let p = FakeSettingsPanels()
        p.names = [textEdit: "TextEdit", fixture: "DSHFixture", "com.tencent.qq": "QQ"]
        if panels { h.dispatcher.settingsPanels = p }
        return Rig(h: h, d: h.dispatcher, verifier: v, panels: p)
    }

    @discardableResult
    private func apply(_ r: Rig, _ change: JSONValue) -> Result<JSONValue, RPCFailure> {
        r.h.call("settings.apply", ["change": change])
    }

    @discardableResult
    private func action(_ r: Rig, _ name: String) -> Result<JSONValue, RPCFailure> {
        r.h.call("settings.action", ["name": .string(name)])
    }

    private func snapshot(_ r: Rig, file: StaticString = #filePath, line: UInt = #line) throws -> JSONValue {
        try r.h.call("settings.snapshot").get()
    }

    private func assertInvalid(_ out: Result<JSONValue, RPCFailure>, _ why: String, file: StaticString = #filePath, line: UInt = #line) {
        guard case .failure(let f) = out else { return XCTFail("\(why): expected invalid params, got \(out)", file: file, line: line) }
        XCTAssertEqual(f.code, .invalidParams, why, file: file, line: line)
    }

    private let denyRemove: JSONValue = ["kind": "deny.remove", "bundle_id": .string(textEdit)]

    // MARK: the trust rule: verified never comes from the caller

    func testAVerifiedFlagFromTheSocketNeverSkipsTheCheck() throws {
        let r = rig(verdict: .ok)
        let before = r.d.settings
        assertInvalid(r.h.call("settings.apply", ["change": denyRemove, "verified": true]), "verified beside the change")
        assertInvalid(apply(r, ["kind": "deny.remove", "bundle_id": .string(textEdit), "verified": true]), "verified in the change")
        assertInvalid(r.h.call("settings.apply", ["kind": "deny.remove", "bundle_id": .string(textEdit)]), "a change not under change")
        assertInvalid(r.h.call("settings.snapshot", ["verified": true]), "snapshot takes nothing")
        assertInvalid(r.h.call("settings.cancel_verify", ["verified": true]), "cancel_verify takes nothing")
        assertInvalid(r.h.call("settings.action", ["name": "import_confirm", "verified": true]), "an action takes its name only")
        XCTAssertEqual(r.verifier.reasons, [], "no check was even shown")
        _ = try snapshot(r)
        XCTAssertEqual(r.d.settings, before, "nothing changed")
        // The same change without the flag goes through the check, and only then applies.
        XCTAssertEqual(try apply(r, denyRemove).get()["status"], "pending")
        XCTAssertEqual(r.verifier.reasons.count, 1)
        XCTAssertEqual(r.d.settings, before, "not before a settings request settles the verdict")
        _ = try snapshot(r)
        XCTAssertTrue(r.d.settings.denylist.isEmpty)
    }

    func testEveryLooseningKindGoesPendingAndOnlyAnOkVerdictAppliesIt() throws {
        let loosening: [JSONValue] = [
            ["kind": "persistent.add", "bundle_id": "com.tencent.qq", "mode": "read"],
            ["kind": "persistent.mode", "bundle_id": .string(fixture), "mode": "full"],
            ["kind": "persistent.reapprove", "bundle_id": .string(fixture)],
            denyRemove,
            ["kind": "access.set", "field": "default_mode", "value": "read"],
            ["kind": "access.set", "field": "session_limit_minutes", "value": 30],
            ["kind": "access.set", "field": "dialogs_per_turn", "value": 2],
            ["kind": "access.set", "field": "dialog_default", "value": "session"],
            ["kind": "chord.enable", "chord": "cmd+v"],
            ["kind": "chord.add", "chord": "cmd+k", "app": nil, "note": "palette"],
            ["kind": "privacy.set", "field": "send_screenshots", "on": true],
            ["kind": "privacy.set", "field": "send_ax_text", "on": true],
            ["kind": "privacy.set", "field": "send_ocr", "on": true],
            ["kind": "privacy.set", "field": "send_zoom", "on": true],
            ["kind": "text_only.remove", "bundle_id": .string(fixture)],
            ["kind": "behavior.set", "field": "allow_point_targets", "value": true],
            ["kind": "behavior.set", "field": "ime_policy_cap", "value": "ask"],
            ["kind": "behavior.set", "field": "electron_ax_auto", "value": true],
            ["kind": "logs.retention", "days": 30],
            ["kind": "reset"],
        ]
        for json in loosening {
            let r = rig()
            let c = try SettingsChange.decode(json)
            let kind = c.kind
            let before = (r.d.settings, r.h.persistent.grants)
            let summary = r.d.settingsChangeSummary(c)
            let reason = r.d.settingsVerifyReason(c, names: { r.panels.names[$0] })
            XCTAssertEqual(try apply(r, json).get(), ["status": "pending", "summary": summary], kind)
            XCTAssertEqual(r.h.lastAudit["status"], "pending", kind)
            XCTAssertTrue(AuditReader.isRequestOnly(method: "settings.apply", r.h.lastAudit), "\(kind): not listed as a change")
            XCTAssertEqual(r.verifier.reasons, [reason], "\(kind): the daemon's own text")
            XCTAssertEqual(try snapshot(r)["pending"], summary, kind)
            XCTAssertEqual(r.d.settings, before.0, "\(kind): nothing yet")
            XCTAssertEqual(r.h.persistent.grants, before.1, "\(kind): nothing yet")
            r.verifier.finish(.ok)
            let snap = try snapshot(r)
            XCTAssertTrue(r.d.settings != before.0 || r.h.persistent.grants != before.1, "\(kind): applied")
            XCTAssertEqual(snap["pending"], .null, kind)
            XCTAssertEqual(snap["last_outcome"]?["outcome"], "applied", kind)
            XCTAssertEqual(snap["last_outcome"]?["kind"], .string(kind), kind)
            let settled = try XCTUnwrap(r.h.audit.entries.last { $0["stage"] == "settled" }, kind)
            XCTAssertEqual(settled["verified"], true, kind)
            XCTAssertEqual(settled["peer_pid"], r.h.lastAudit["peer_pid"], "\(kind): the requester is on record")
        }
    }

    func testFailedCancelledAndUnavailableVerdictsChangeNothingAndShowInTheLastOutcome() throws {
        for verdict in [OwnerVerdict.failed, .cancelled, .unavailable] {
            let r = rig()
            let before = r.d.settings
            XCTAssertEqual(try apply(r, denyRemove).get()["status"], "pending")
            r.verifier.finish(verdict)
            let snap = try snapshot(r)
            XCTAssertEqual(r.d.settings, before, "\(verdict)")
            XCTAssertEqual(snap["pending"], .null)
            XCTAssertEqual(snap["last_outcome"]?["outcome"], .string("verify_\(verdict.rawValue)"))
            XCTAssertEqual(snap["last_outcome"]?["kind"], "deny.remove")
            let settled = try XCTUnwrap(r.h.audit.entries.last { $0["stage"] == "settled" })
            XCTAssertEqual(settled["decision"], "deny")
            XCTAssertEqual(settled["reason"], .string("verify_\(verdict.rawValue)"))
        }
        // A verifier that answers at once, and one that answers on another thread.
        let r = rig(verdict: .failed)
        XCTAssertEqual(try apply(r, denyRemove).get()["status"], "pending")
        XCTAssertEqual(try snapshot(r)["last_outcome"]?["outcome"], "verify_failed")
        let r2 = rig()
        XCTAssertEqual(try apply(r2, denyRemove).get()["status"], "pending")
        let answered = expectation(description: "verdict")
        DispatchQueue.global().async {
            r2.verifier.finish(.ok)
            answered.fulfill()
        }
        wait(for: [answered], timeout: 5)
        XCTAssertEqual(r2.d.settings.denylist.count, 1, "settled on the worker, by the next request")
        XCTAssertEqual(try snapshot(r2)["last_outcome"]?["outcome"], "applied")
        XCTAssertTrue(r2.d.settings.denylist.isEmpty)
    }

    // MARK: refusals before a check

    func testBusyCooldownAndUnavailableRefusals() throws {
        let r = rig()
        XCTAssertEqual(try apply(r, denyRemove).get()["status"], "pending")
        let other: JSONValue = ["kind": "privacy.set", "field": "send_ocr", "on": true]
        assertDenied(apply(r, other), "verify_busy", in: r.h)
        XCTAssertEqual(try apply(r, denyRemove).get()["status"], "pending", "the same change asked again still waits")
        XCTAssertEqual(r.verifier.reasons.count, 1, "one check shown")
        XCTAssertEqual(try apply(r, ["kind": "privacy.set", "field": "send_ocr", "on": false]).get(), ["status": "applied"],
                       "a tightening change is never held up")
        r.verifier.finish(.failed)
        _ = try snapshot(r)
        assertDenied(apply(r, other), "verify_cooldown", in: r.h)
        if case .failure(let f) = apply(r, other) {
            XCTAssertEqual(f.data?["until"], .number(r.h.clock.addingTimeInterval(10).timeIntervalSince1970))
        }
        r.h.clock.addTimeInterval(11)
        XCTAssertEqual(try apply(r, other).get()["status"], "pending", "after the cool-down")

        // A check the window opened through the same gate keeps the page's waiting.
        let w = rig()
        let check = try XCTUnwrap(w.d.ownerCheck)
        XCTAssertEqual(check.begin(reason: "the window's", purpose: "settings.window") { _ in }, .started)
        assertDenied(apply(w, denyRemove), "verify_busy", in: w.h)
        XCTAssertEqual(try snapshot(w)["pending"], .null)

        // No owner check at all, or one without a verifier: the change cannot be verified here.
        let none = rig()
        none.d.ownerCheck = nil
        assertDenied(apply(none, denyRemove), "verify_unavailable", in: none.h)
        none.d.ownerCheck = OwnerCheck(verifier: nil, audit: none.h.audit)
        assertDenied(apply(none, denyRemove), "verify_unavailable", in: none.h)
        XCTAssertEqual(none.d.settings.denylist.count, 1)
        XCTAssertEqual(try snapshot(none)["pending"], .null)
    }

    func testAnOpenApprovalDialogRefusesALooseningChangeWithoutACheck() throws {
        let r = rig()
        let req = try r.h.call("access.request", ["task_id": "t1", "app": .string(fixture), "mode": "read", "reason": "x",
                                                  "interactive": true]).get()
        XCTAssertEqual(req["status"], "pending")
        assertDenied(apply(r, denyRemove), "approval_open", in: r.h)
        XCTAssertEqual(r.verifier.reasons, [])
        XCTAssertEqual(try apply(r, ["kind": "chord.disable", "chord": "cmd+c"]).get(), ["status": "applied"], "tightening still applies")
        r.h.presenter.respond(.deny)
        XCTAssertEqual(try apply(r, denyRemove).get()["status"], "pending", "an answered dialog is not open")

        // The gate's own question (main: the approval presenter's state), asked by OwnerCheck.begin.
        let g = rig()
        g.d.ownerCheck = OwnerCheck(verifier: g.verifier, audit: g.h.audit, approvalOpen: { true })
        assertDenied(apply(g, denyRemove), "approval_open", in: g.h)
        XCTAssertEqual(try snapshot(g)["pending"], .null)
    }

    // MARK: the verdict meets the live settings

    func testAVerdictForSettingsThatChangedMeanwhileIsNotApplied() throws {
        let r = rig()
        XCTAssertEqual(try apply(r, ["kind": "access.set", "field": "session_limit_minutes", "value": 30]).get()["status"], "pending")
        try r.d.settingsEditAccess(verified: true) { $0.sessionLimitMinutes = 60 }   // the window, meanwhile
        r.verifier.finish(.ok)
        let changed = try snapshot(r)["last_outcome"]
        XCTAssertEqual(changed?["outcome"], "refused", "the person approved 15 to 30, not 60 to 30")
        XCTAssertEqual(changed?["reason"], "settings_changed")
        XCTAssertEqual(r.d.settings.access.sessionLimitMinutes, 60, "the later change stays")
        XCTAssertEqual(r.h.audit.entries.last { $0["stage"] == "settled" }?["reason"], "settings_changed")

        // What a reset loosens grew while the person looked at the old list: not applied.
        let s = rig(Self.tight(sendOCR: true))
        XCTAssertEqual(try apply(s, ["kind": "reset"]).get()["status"], "pending")
        try s.d.settingsEditPrivacy(verified: false) { $0.sendOCR = false }
        let before = s.d.settings
        s.verifier.finish(.ok)
        let out = try snapshot(s)["last_outcome"]
        XCTAssertEqual(out?["outcome"], "refused")
        XCTAssertEqual(out?["reason"], "settings_changed")
        XCTAssertEqual(s.d.settings, before)

        // A change the setter now refuses, the settings unchanged (the app is gone): the outcome says why.
        let t = rig()
        XCTAssertEqual(try apply(t, ["kind": "persistent.reapprove", "bundle_id": .string(fixture)]).get()["status"], "pending")
        t.h.apps.installed.removeAll { $0.bundleID == fixture }
        let grants = t.h.persistent.grants
        t.verifier.finish(.ok)
        let refused = try snapshot(t)["last_outcome"]
        XCTAssertEqual(refused?["outcome"], "refused")
        XCTAssertEqual(refused?["reason"], "app_not_found", "the setter's reason, never its text")
        XCTAssertEqual(t.h.persistent.grants, grants)
        XCTAssertEqual(t.h.audit.entries.last { $0["stage"] == "settled" }?["reason"], "app_not_found")
    }

    func testATighteningOfAnotherFieldOrAnAlwaysListChangeBeforeTheVerdictRefusesIt() throws {
        let screenshots: JSONValue = ["kind": "privacy.set", "field": "send_screenshots", "on": true]
        // Another field tightened in the window while the check was open.
        let r = rig()
        XCTAssertEqual(try apply(r, screenshots).get()["status"], "pending")
        try r.d.settingsDenylistAdd(bundleID: "com.tencent.qq", note: "")
        r.verifier.finish(.ok)
        let out = try snapshot(r)["last_outcome"]
        XCTAssertEqual(out?["outcome"], "refused")
        XCTAssertEqual(out?["reason"], "settings_changed")
        XCTAssertFalse(r.d.settings.privacy.sendScreenshots, "the loosening is not applied")
        XCTAssertNotNil(r.d.settings.denies("com.tencent.qq"), "the tightening stays")

        // An always-list entry removed meanwhile.
        let s = rig()
        XCTAssertEqual(try apply(s, screenshots).get()["status"], "pending")
        try s.d.settingsRevokePersistent(bundleID: fixture)
        s.verifier.finish(.ok)
        XCTAssertEqual(try snapshot(s)["last_outcome"]?["reason"], "settings_changed")
        XCTAssertFalse(s.d.settings.privacy.sendScreenshots)
        XCTAssertTrue(s.h.persistent.grants.isEmpty, "the removal stays")

        // Nothing changed meanwhile: applied, verified.
        let t = rig()
        XCTAssertEqual(try apply(t, screenshots).get()["status"], "pending")
        t.verifier.finish(.ok)
        XCTAssertEqual(try snapshot(t)["last_outcome"]?["outcome"], "applied")
        XCTAssertTrue(t.d.settings.privacy.sendScreenshots)
        XCTAssertEqual(t.h.audit.entries.last { $0["stage"] == "settled" }?["verified"], true)
    }

    // MARK: settled on arrival, with a server

    /// Runs `body` on the server's worker queue (where it settles), waiting for it.
    private func onWorker<T>(_ server: Server, _ body: @escaping () -> T) -> T {
        let done = expectation(description: "worker")
        var out: T?
        server.perform(body) { out = $0; done.fulfill() }
        wait(for: [done], timeout: 5)
        return out!
    }

    func testWithAServerAVerdictAndAPanelAnswerAreSettledAsSoonAsTheyArrive() throws {
        let r = rig()
        let server = Server(stateDir: dir.appendingPathComponent("state"), dispatcher: r.d, audit: r.h.audit)
        XCTAssertEqual(try onWorker(server) { self.apply(r, self.denyRemove) }.get()["status"], "pending")
        r.verifier.finish(.ok)   // here, off the worker, as the system's check answers; no settings.* request follows
        let (denylist, pending, outcome) = onWorker(server) {
            (r.d.settings.denylist, r.d.settingsRPC.pending == nil, r.d.settingsRPC.lastOutcome?["outcome"])
        }
        XCTAssertTrue(denylist.isEmpty, "applied")
        XCTAssertTrue(pending)
        XCTAssertEqual(outcome, "applied")
        XCTAssertEqual(onWorker(server) { r.h.audit.entries.last { $0["stage"] == "settled" }?["verified"] }, true)

        // An export's line is written when the person saves, not at the page's next poll.
        r.panels.hold = true
        XCTAssertEqual(try onWorker(server) { self.action(r, "export_settings") }.get(), ["status": "open"])
        XCTAssertFalse(onWorker(server) { r.h.audit.entries.contains { $0["method"] == "settings.export" } })
        r.panels.release()
        XCTAssertTrue(onWorker(server) { r.h.audit.entries.contains { $0["method"] == "settings.export" } })
        XCTAssertEqual(onWorker(server) { r.d.settingsRPC.panel == nil }, true)
        XCTAssertEqual(onWorker(server) { r.d.settingsRPC.lastOutcome?["kind"] }, "export_settings")
    }

    func testCancelVerifyEndsTheCheckAndALateOkIsDropped() throws {
        let r = rig()
        assertDenied(r.h.call("settings.cancel_verify"), "nothing_pending", in: r.h)
        XCTAssertEqual(try apply(r, denyRemove).get()["status"], "pending")
        let late = try XCTUnwrap(r.verifier.completions.first)
        let out = try r.h.call("settings.cancel_verify").get()
        XCTAssertEqual(out["status"], "cancelled")
        XCTAssertEqual(r.verifier.cancels, 1)
        late(.ok)
        let snap = try snapshot(r)
        XCTAssertEqual(snap["pending"], .null)
        XCTAssertEqual(snap["last_outcome"]?["outcome"], "cancelled")
        XCTAssertEqual(r.d.settings.denylist.count, 1, "the late ok changed nothing")
        assertDenied(r.h.call("settings.cancel_verify"), "nothing_pending", in: r.h)
        assertDenied(apply(r, denyRemove), "verify_cooldown", in: r.h)
    }

    // MARK: actions and panels

    func testEachActionGoesThroughThePanelsAndSettlesOnTheWorker() throws {
        let r = rig()
        // The log folder from the folder panel; cancelled; a folder that is gone.
        let picked = dir.appendingPathComponent("picked")
        try FileManager.default.createDirectory(at: picked, withIntermediateDirectories: true)
        r.panels.directory = picked
        XCTAssertEqual(try action(r, "choose_log_directory").get(), ["status": "open"])
        XCTAssertNil(r.d.settings.logs.directory, "not before the next request")
        var snap = try snapshot(r)
        XCTAssertEqual(snap["logs"]?["directory_custom"], true)
        XCTAssertEqual(snap["last_outcome"]?["kind"], "choose_log_directory")
        XCTAssertEqual(snap["last_outcome"]?["outcome"], "applied")
        XCTAssertEqual(try action(r, "use_default_log_directory").get(), ["status": "applied"])
        XCTAssertNil(r.d.settings.logs.directory)
        r.panels.directory = nil
        action(r, "choose_log_directory")
        XCTAssertEqual(try snapshot(r)["last_outcome"]?["outcome"], "cancelled")
        r.panels.directory = dir.appendingPathComponent("gone")
        action(r, "choose_log_directory")
        snap = try snapshot(r)
        XCTAssertEqual(snap["last_outcome"]?["outcome"], "refused")
        XCTAssertEqual(snap["last_outcome"]?["reason"], "log_directory_missing")
        XCTAssertNil(r.d.settings.logs.directory)

        // An app from the app panel, while the panel is still open another action waits.
        r.panels.hold = true
        r.panels.app = textEdit
        XCTAssertEqual(try action(r, "choose_app").get(), ["status": "open"])
        XCTAssertEqual(try action(r, "export_settings").get(), ["status": "busy", "panel": "choose_app"])
        XCTAssertEqual(try snapshot(r)["panel"], "choose_app")
        r.panels.hold = false
        r.panels.release()
        snap = try snapshot(r)
        XCTAssertEqual(snap["picked_app"], ["bundle_id": .string(textEdit), "name": "TextEdit"])
        XCTAssertEqual(snap["panel"], .null)
        r.panels.app = "not a bundle id"
        action(r, "choose_app")
        snap = try snapshot(r)
        XCTAssertEqual(snap["last_outcome"]?["reason"], "invalid_params")
        XCTAssertEqual(snap["picked_app"]?["bundle_id"], .string(textEdit), "the earlier pick stays")

        // Exports go to the file the person saves, never into the answer.
        let exported = try action(r, "export_settings").get()
        XCTAssertEqual(exported, ["status": "open"])
        XCTAssertEqual(r.panels.saved.last?.name, "cu-runtime-settings.json")
        XCTAssertEqual(r.panels.saved.last?.contents, try r.d.settings.encoded())
        _ = try snapshot(r)
        XCTAssertTrue(r.h.audit.entries.contains { $0["method"] == "settings.export" })
        r.panels.saveSucceeds = false
        action(r, "export_settings")
        XCTAssertEqual(try snapshot(r)["last_outcome"]?["outcome"], "cancelled")

        // reveal: the Finder shows the log folder; the answer names no path.
        XCTAssertEqual(try action(r, "reveal_log").get(), ["status": "done"])
        XCTAssertEqual(r.panels.revealed, [try XCTUnwrap(r.d.effectiveLogDirectory)])

        assertInvalid(action(r, "delete_audit"), "not one of the names")
        assertInvalid(r.h.call("settings.action", ["name": "reveal_log", "path": "/tmp"]), "no path")
        assertInvalid(r.h.call("settings.action", [:]), "a name is needed")
    }

    func testTheAuditExportWritesSevenDaysThroughTheSavePanelAndNeverOverTheSocket() throws {
        let r = rig()
        let logDir = try XCTUnwrap(r.d.effectiveLogDirectory)
        try FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        let days = AuditDays.last(8, now: r.h.clock)
        for (i, day) in days.enumerated() {
            try Data("{\"day\":\(i),\"detail\":\"audit-secret-\(i)\"}\n".utf8).write(to: logDir.appendingPathComponent(AuditDays.fileName(day)))
        }
        let out = try action(r, "export_audit").get()
        XCTAssertEqual(out, ["status": "open"])
        let saved = try XCTUnwrap(r.panels.saved.last)
        XCTAssertEqual(saved.name, "cu-runtime-audit-7d.jsonl")
        let text = try XCTUnwrap(String(bytes: saved.contents, encoding: .utf8))
        XCTAssertEqual(text, (0..<7).reversed().map { "{\"day\":\($0),\"detail\":\"audit-secret-\($0)\"}\n" }.joined(), "7 days, oldest first")
        let snap = try snapshot(r)
        let answer = try XCTUnwrap(String(bytes: JSONCoding.encode(out) + JSONCoding.encode(snap), encoding: .utf8))
        XCTAssertFalse(answer.contains("audit-secret"))
        let line = try XCTUnwrap(r.h.audit.entries.last { $0["method"] == "settings.audit_export" })
        XCTAssertEqual(line["bytes"], .number(Double(saved.contents.count)))
    }

    func testImportPreviewThenConfirmAppliesExactlyThePreviewedSettings() throws {
        let r = rig()
        assertDenied(action(r, "import_confirm"), "nothing_pending", in: r.h)
        var file = Self.tight()
        file.denylist = [DenyEntry(bundleId: "com.tencent.qq", note: "chat", addedAt: Date())]   // TextEdit off the list
        file.behavior.allowPointTargets = true
        file.access.dialogTimeoutSeconds = 60
        file.logs.directory = "/Volumes/elsewhere"
        r.panels.openData = try file.encoded()
        XCTAssertEqual(try action(r, "import").get(), ["status": "open"])
        XCTAssertEqual(r.panels.openedExtensions, [["json"]])
        let preview = try XCTUnwrap(try snapshot(r)["import_preview"])
        XCTAssertEqual(preview["loosened"], ["behavior.allow_point_targets", .string("denylist.remove:\(textEdit)")])
        XCTAssertEqual(preview["changes"], ["access.dialog_timeout_seconds", "behavior.allow_point_targets", "denylist.add:com.tencent.qq",
                                            .string("denylist.remove:\(textEdit)")])
        XCTAssertEqual(preview["log_directory_ignored"], true)
        XCTAssertEqual(try snapshot(r)["last_outcome"]?["outcome"], "done")

        // Another file in the panel now changes nothing: the preview is what is applied.
        r.panels.openData = try UserSettings().encoded()
        XCTAssertEqual(try action(r, "import_confirm").get()["status"], "pending")
        XCTAssertEqual(r.verifier.reasons.count, 1)
        r.verifier.finish(.ok)
        let snap = try snapshot(r)
        XCTAssertEqual(snap["last_outcome"]?["outcome"], "applied")
        XCTAssertEqual(snap["import_preview"], .null)
        var expected = file
        expected.logs.directory = nil   // the folder in force, never the file's
        XCTAssertEqual(r.d.settings, expected)

        // A file that only tightens applies at once; a broken one is refused and leaves no preview.
        var tighter = r.d.settings
        tighter.behavior.allowPointTargets = false
        r.panels.openData = try tighter.encoded()
        action(r, "import")
        XCTAssertEqual(try snapshot(r)["import_preview"]?["loosened"], [])
        XCTAssertEqual(try action(r, "import_confirm").get(), ["status": "applied"])
        XCTAssertFalse(r.d.settings.behavior.allowPointTargets)
        for (data, reason) in [(Data("not json".utf8), "invalid_file"), (Data(#"{"access":{"session_limit_minutes":45}}"#.utf8), "invalid_params")] {
            r.panels.openData = data
            action(r, "import")
            let s = try snapshot(r)
            XCTAssertEqual(s["last_outcome"]?["reason"], .string(reason))
            XCTAssertEqual(s["import_preview"], .null)
        }
        r.panels.openData = nil
        action(r, "import")
        XCTAssertEqual(try snapshot(r)["last_outcome"]?["outcome"], "cancelled")
    }

    func testTheImportPreviewFollowsTheLiveSettingsAndAConfirmOnAStalePreviewIsRefused() throws {
        let r = rig()
        var file = Self.tight()
        file.denylist = []
        file.behavior.imePolicyCap = .ask
        r.panels.openData = try file.encoded()
        action(r, "import")
        XCTAssertEqual(try snapshot(r)["import_preview"]?["changes"], ["behavior.ime_policy_cap", .string("denylist.remove:\(textEdit)")])

        // A change made after the preview shows in the next snapshot's preview.
        try r.d.settingsDenylistAdd(bundleID: "com.tencent.qq", note: "")
        let shown = try XCTUnwrap(try snapshot(r)["import_preview"])
        XCTAssertEqual(shown["changes"], ["behavior.ime_policy_cap", .string("denylist.remove:\(textEdit)"), "denylist.remove:com.tencent.qq"])
        XCTAssertEqual(shown["changes_count"], 3)
        XCTAssertEqual(shown["loosened"], shown["changes"], "each one loosens")

        // A change made after the last snapshot: the confirm is refused, nothing applied, the preview refreshed.
        try r.d.settingsDenylistAdd(bundleID: "com.apple.Terminal", note: "")
        let before = r.d.settings
        assertDenied(action(r, "import_confirm"), "settings_changed", in: r.h)
        XCTAssertEqual(r.d.settings, before)
        XCTAssertEqual(r.verifier.reasons, [], "no check for a confirm on a stale preview")
        let fresh = try XCTUnwrap(try snapshot(r)["import_preview"])
        XCTAssertEqual(fresh["changes_count"], 4)
        XCTAssertEqual(fresh["changes"], ["behavior.ime_policy_cap", .string("denylist.remove:\(textEdit)"), "denylist.remove:com.tencent.qq",
                                          "denylist.remove:com.apple.Terminal"])

        // Confirmed again on the preview shown: applied after the check.
        XCTAssertEqual(try action(r, "import_confirm").get()["status"], "pending")
        r.verifier.finish(.ok)
        XCTAssertEqual(try snapshot(r)["last_outcome"]?["outcome"], "applied")
        XCTAssertEqual(r.d.settings, file)
    }

    func testWithoutPanelsEveryActionButTheDefaultFolderIsUnavailable() throws {
        let r = rig(panels: false)
        for name in Dispatcher.settingsActions.subtracting(["use_default_log_directory"]).sorted() {
            assertDenied(action(r, name), "settings_unavailable", in: r.h)
        }
        XCTAssertEqual(try action(r, "use_default_log_directory").get(), ["status": "applied"])
        let snap = try snapshot(r)
        XCTAssertEqual(snap["permissions"], .null)
        XCTAssertEqual(snap["denylist"]?.objectValueFirst?["name"], .null, "no panels: no names")
    }

    // MARK: the snapshot

    func testTheSnapshotCarriesNoTokenStatePathOrAuditDetailAndNamesComeFromThePanels() throws {
        let r = rig()
        let state = dir.appendingPathComponent("state-dir-marker")
        let logDir = try XCTUnwrap(r.d.effectiveLogDirectory)
        try FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        try Data("token-secret-value".utf8).write(to: state.appendingPathComponent("token"))
        let day = try XCTUnwrap(AuditDays.last(1, now: r.h.clock).first)
        let ts = ISO8601DateFormatter.string(from: r.h.clock, timeZone: .current, formatOptions: [.withInternetDateTime, .withFractionalSeconds])
        let raw = [
            #"{"ts":"\#(ts)","method":"observe","decision":"deny","reason":"hard_denied","app":"com.apple.Terminal","detail":"a-secret-detail"}"#,
            #"{"ts":"\#(ts)","method":"settings.apply","decision":"allow","status":"applied","kind":"deny.add"}"#,
            #"{"ts":"\#(ts)","method":"settings.denylist_add","decision":"allow","app":"com.tencent.qq","detail":"more-secret-detail"}"#,
        ].joined(separator: "\n") + "\n"
        try Data(raw.utf8).write(to: logDir.appendingPathComponent(AuditDays.fileName(day)))
        r.panels.currentPermissions = SettingsPermissions(accessibility: true, screenRecording: false, inputMonitoring: nil)
        XCTAssertEqual(try apply(r, ["kind": "deny.add", "bundle_id": "com.tencent.qq", "note": "a private note"]).get(), ["status": "applied"])
        XCTAssertEqual(try apply(r, denyRemove).get()["status"], "pending")

        let snap = try snapshot(r)
        XCTAssertTrue(Set(snap.objectValue.keys).isSuperset(of: ["permissions", "pending", "last_outcome", "picked_app", "import_preview",
                                                                  "panel", "denylist", "recent_changes", "recent_refusals"]))
        XCTAssertEqual(snap["permissions"], ["accessibility": true, "screen_recording": false, "input_monitoring": nil])
        XCTAssertEqual(snap["pending"]?["bundle_id"], .string(textEdit))
        guard case .array(let deny)? = snap["denylist"] else { return XCTFail("denylist") }
        XCTAssertEqual(Set(deny.compactMap { $0["name"]?.stringValue }), ["TextEdit", "QQ"], "names from the panels")
        XCTAssertTrue(r.verifier.reasons.last?.contains("TextEdit") == true, "the check's text names the app as the panels do")
        guard case .array(let changes)? = snap["recent_changes"] else { return XCTFail("recent_changes") }
        XCTAssertEqual(changes.map { $0["method"] }, ["settings.denylist_add"], "the setter's line, not the request's")
        let text = try XCTUnwrap(String(bytes: JSONCoding.encode(snap), encoding: .utf8))
        for secret in ["token-secret-value", "token", "state-dir-marker", "a-secret-detail", "more-secret-detail", "\"detail\"",
                       dir.path] {
            XCTAssertFalse(text.contains(secret), secret)
        }
    }

    func testTheSettingsNamespaceSkipsAppNameResolution() throws {
        let r = rig()
        r.h.grant("t1", ["com.example.notes-a", "com.example.notes-b"])
        r.h.env.names = ["com.example.notes-a": ["Notes"], "com.example.notes-b": ["Notes"]]
        // Under another namespace this name is refused app_name_ambiguous before the method runs.
        assertDenied(r.h.call("apps.list", ["task_id": "t1", "app": "Notes"]), "app_name_ambiguous", in: r.h)
        assertInvalid(r.h.call("settings.action", ["name": "reveal_log", "app": "Notes", "task_id": "t1"]), "strict params, not a name lookup")
        XCTAssertNil(r.h.lastAudit["app_name"])
    }
}

private extension JSONValue {
    var objectValueFirst: JSONValue? {
        if case .array(let a) = self { return a.first }
        return nil
    }
}
