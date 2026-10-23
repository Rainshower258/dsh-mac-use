import Foundation
import XCTest
@testable import CURuntimeCore

/// The settings window's side of the daemon (PLAN-v2 P1, 2026-10-15): the user's deny list, revoking from the
/// overview, the snapshot, the settings file, and reading refusals back from the audit.
final class SettingsTests: XCTestCase {
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

    // MARK: the deny list

    func testADeniedAppIsRefusedWithoutADialogInEveryModeAndEveryPath() throws {
        let h = Harness(settings: MemorySettingsStore(UserSettings(denylist: [DenyEntry(bundleId: textEdit, note: "private", addedAt: Date())])))
        for mode in ["read", "full"] {
            let r = request(h, textEdit, mode: mode)
            assertDenied(r, "user_denied", in: h)
            if case .failure(let f) = r { XCTAssertEqual(f.data?["note"], "private"); XCTAssertEqual(f.data?["retry"], "never") }
        }
        assertDenied(request(h, "TextEdit"), "user_denied", in: h)  // by name, before the identity is resolved
        // Like a hard-denied one, a denied bundle ID is refused even when no such app is installed.
        let h3 = Harness(settings: MemorySettingsStore(UserSettings(denylist: [DenyEntry(bundleId: "com.example.gone", note: "", addedAt: Date())])))
        assertDenied(request(h3, "com.example.gone"), "user_denied", in: h3)
        XCTAssertTrue(h.presenter.shown.isEmpty, "no dialog for a denied app")
        // grants.set (config grants) and the persistent list cannot carry it either.
        assertDenied(h.call("grants.set", ["task_id": "t2", "bundle_ids": .array([.string(textEdit)]), "source": "config"]), "user_denied", in: h)
        XCTAssertThrowsError(try PersistentGrants.add(AppIdentity(bundleID: textEdit, name: "TextEdit", path: "/System/Applications/TextEdit.app"),
                                                      mode: .read, via: "command", store: h.persistent, apps: h.apps, now: Date(),
                                                      settings: h.dispatcher.settings)) {
            XCTAssertEqual(($0 as? Denial)?.reason, "user_denied")
        }
        // The fixture, not on the list, is approved as usual.
        approve(h, fixture)
        assertAllowed(h.call("observe", ["task_id": "t1", "app": .string(fixture), "ocr": "off"]), in: h)
    }

    func testAddingToTheDenyListDropsTheAppFromActiveGrantsAndThePersistentListAtOnce() throws {
        let h = Harness()
        approve(h, fixture)
        approve(h, textEdit, .always)  // read "always": active now, and on the persistent list
        XCTAssertFalse(((try? h.persistent.load()) ?? []).isEmpty)
        XCTAssertTrue(h.dispatcher.settingsSnapshot().grants.flatMap(\.apps).map(\.bundleID).contains { $0.caseInsensitiveCompare(textEdit) == .orderedSame })

        try h.dispatcher.settingsDenylistAdd(bundleID: textEdit, note: "work chats")
        XCTAssertEqual(h.settingsStore.settings.denylist.map(\.bundleId), [textEdit], "saved through the store")
        XCTAssertEqual(h.lastAudit["method"], "settings.denylist_add")
        XCTAssertEqual(h.lastAudit["dropped_from"], ["t1"])
        XCTAssertEqual(h.lastAudit["persistent_removed"], true)
        XCTAssertTrue(((try? h.persistent.load()) ?? []).isEmpty)
        // The grant keeps the fixture and loses TextEdit, mid-task: an action on it and asking again are both refused
        // outright (the deny list is checked before the grant).
        assertDenied(h.call("apps.launch", ["task_id": "t1", "app": .string(textEdit)]), "user_denied", in: h)
        assertDenied(request(h, textEdit), "user_denied", in: h)
        assertAllowed(h.call("observe", ["task_id": "t1", "app": .string(fixture), "ocr": "off"]), in: h)
        let apps = h.dispatcher.settingsSnapshot().grants.flatMap(\.apps).map(\.bundleID)
        XCTAssertEqual(apps.map { $0.lowercased() }, [fixture.lowercased()])
        // A grant made only of the denied app goes entirely.
        let h2 = Harness()
        approve(h2, textEdit)
        try h2.dispatcher.settingsDenylistAdd(bundleID: textEdit, note: "")
        XCTAssertTrue(h2.dispatcher.settingsSnapshot().grants.isEmpty)
        assertDenied(h2.call("observe", ["task_id": "t1", "ocr": "off"]), "no_grant", in: h2)
        assertDenied(request(h2, textEdit), "user_denied", in: h2)
    }

    func testRemovingFromTheDenyListIsRecordedAsVerifiedAndAllowsTheAppAgain() throws {
        let h = Harness(settings: MemorySettingsStore(UserSettings(denylist: [DenyEntry(bundleId: textEdit, note: "", addedAt: Date())])))
        assertDenied(request(h, textEdit), "user_denied", in: h)
        try h.dispatcher.settingsDenylistRemove(bundleID: textEdit, verified: true)
        XCTAssertEqual(h.lastAudit["method"], "settings.denylist_remove")
        XCTAssertEqual(h.lastAudit["verified"], true)
        XCTAssertTrue(h.settingsStore.settings.denylist.isEmpty)
        approve(h, textEdit)
        XCTAssertEqual(h.presenter.shown.count, 1, "asked again, as any app")
        let before = h.audit.entries.count
        try h.dispatcher.settingsDenylistRemove(bundleID: "com.not.listed", verified: true)
        XCTAssertEqual(h.audit.entries.count, before, "nothing to remove: nothing saved, nothing audited")
    }

    // MARK: the overview's actions and snapshot

    func testTheSnapshotSaysWhetherEachPersistentEntryStillMatchesItsSignature() throws {
        let h = Harness()
        approve(h, textEdit, .always)
        XCTAssertEqual(h.dispatcher.settingsSnapshot().persistentValid[textEdit.lowercased()], true)
        // The app was replaced by one signed differently (2026-10-16: the app lists page shows "signature changed").
        h.apps.requirements["/System/Applications/TextEdit.app"] = "identifier \"com.apple.TextEdit\" and certificate leaf = H\"cccc\""
        XCTAssertEqual(h.dispatcher.settingsSnapshot().persistentValid[textEdit.lowercased()], false)
        XCTAssertEqual(h.dispatcher.settingsSnapshot().persistent.count, 1, "the snapshot only reports; the next use voids the entry")
    }

    // MARK: the access rules (batch 1, 2026-10-16)

    func testTheDialogCountTimeoutAndSessionLengthComeFromTheSettings() throws {
        let rules = AccessDefaults(defaultMode: .ask, sessionLimitMinutes: 15, dialogsPerTurn: 1, dialogTimeoutSeconds: 60)
        let h = Harness(settings: MemorySettingsStore(UserSettings(access: rules)))
        approve(h, fixture, .session)
        XCTAssertEqual(h.presenter.shown.last?.timeout, 60)
        let a = try XCTUnwrap(h.dispatcher.settingsSnapshot().grants.first?.apps.first)
        XCTAssertEqual(a.expiresAt.timeIntervalSince(h.clock), 15 * 60, accuracy: 2)
        // One dialog a turn: the second app is refused without asking.
        assertDenied(request(h, textEdit), "approval_limit", in: h)
        XCTAssertEqual(h.presenter.shown.count, 1)
    }

    func testTheDialogsDefaultButtonComesFromTheSettingsAndApprovingOnesAreLoosening() throws {
        let h = Harness()
        let d = try XCTUnwrap(h.dispatcher)
        h.presenter.answer = nil
        _ = request(h, fixture, mode: "full")
        XCTAssertEqual(h.presenter.shown.last?.defaultAnswer, .deny, "refuse unless set otherwise")
        XCTAssertThrowsError(try d.settingsSetAccess(AccessDefaults(dialogDefault: .turn), verified: false)) {
            XCTAssertEqual(($0 as? Denial)?.reason, "verification_required")
        }
        try d.settingsSetAccess(AccessDefaults(dialogDefault: .session), verified: true)
        XCTAssertEqual(h.lastAudit["loosened"], .array(["dialog_default"]))
        XCTAssertEqual(h.lastAudit["after"]?["dialog_default"], "session")
        h.presenter.respond(.deny)
        _ = request(h, textEdit, mode: "full")
        XCTAssertEqual(h.presenter.shown.last?.defaultAnswer, .session)
        // Back to refuse: tightening, no verification.
        try d.settingsSetAccess(AccessDefaults(dialogDefault: .deny), verified: false)
        XCTAssertEqual(AccessDefaults().dialogDefault, .deny)
    }

    func testTheDefaultModeGrantsASessionWithoutADialogUpToThatModeOnly() throws {
        let h = Harness(settings: MemorySettingsStore(UserSettings(access: AccessDefaults(defaultMode: .read))))
        // A read request: granted at once, no dialog, audited as the default mode's doing.
        let r = request(h, fixture)
        assertAllowed(r, in: h)
        XCTAssertEqual((try? r.get())?["via"], "default_mode")
        XCTAssertEqual(h.lastAudit["default_mode"], "read")
        XCTAssertTrue(h.presenter.shown.isEmpty)
        XCTAssertEqual(h.dispatcher.settingsSnapshot().grants.first?.apps.first?.scope, .session)
        assertAllowed(h.call("observe", ["task_id": "t1", "app": .string(fixture), "ocr": "off"]), in: h)
        // A full request still asks.
        h.presenter.answer = nil
        let full = request(h, fixture, mode: "full")
        XCTAssertEqual((try? full.get())?["status"], "pending")
        XCTAssertEqual(h.presenter.shown.count, 1)
        // The lists still win: denied and hard-denied apps are refused, not granted.
        let h2 = Harness(settings: MemorySettingsStore(UserSettings(denylist: [DenyEntry(bundleId: textEdit, note: "", addedAt: Date())],
                                                                    access: AccessDefaults(defaultMode: .full))))
        assertDenied(request(h2, textEdit), "user_denied", in: h2)
        assertDenied(request(h2, "com.apple.Terminal", mode: "full"), "hard_denied", in: h2)
        // With the default "ask" (the default), nothing changes: a dialog as before.
        let h3 = Harness()
        h3.presenter.answer = nil
        XCTAssertEqual((try? request(h3, fixture).get())?["status"], "pending")
    }

    func testTheDefaultModeDoesNotOverrideARefusalThisTurn() throws {
        let h = Harness(settings: MemorySettingsStore(UserSettings(access: AccessDefaults(defaultMode: .ask))))
        h.presenter.answer = .deny
        let r = request(h, fixture, mode: "full")
        assertDenied(h.call("access.status", ["task_id": "t1", "request_id": (try? r.get())?["request_id"] ?? "none"]), "approval_rejected", in: h)
        // Loosened to full after the refusal: still refused in this turn.
        try XCTUnwrap(h.dispatcher).settingsSetAccess(AccessDefaults(defaultMode: .full), verified: true)
        assertDenied(request(h, fixture, mode: "full"), "approval_refused_earlier", in: h)
    }

    func testLooseningTheRulesNeedsVerificationTighteningDoesNot() throws {
        let h = Harness()
        let d = try XCTUnwrap(h.dispatcher)
        // Tightening, unverified: fine, and in force at once.
        try d.settingsSetAccess(AccessDefaults(defaultMode: .ask, sessionLimitMinutes: 15, dialogsPerTurn: 2, dialogTimeoutSeconds: 180), verified: false)
        XCTAssertEqual(h.lastAudit["method"], "settings.access")
        XCTAssertEqual(h.lastAudit["loosened"], .array([]))
        XCTAssertEqual(d.settings.access.dialogsPerTurn, 2)
        XCTAssertEqual(h.settingsStore.settings.access.sessionLimitMinutes, 15, "written to the store")
        // Each loosening direction, unverified: refused and unchanged.
        for new in [AccessDefaults(defaultMode: .read, sessionLimitMinutes: 15, dialogsPerTurn: 2, dialogTimeoutSeconds: 180),
                    AccessDefaults(defaultMode: .ask, sessionLimitMinutes: 30, dialogsPerTurn: 2, dialogTimeoutSeconds: 180),
                    AccessDefaults(defaultMode: .ask, sessionLimitMinutes: 15, dialogsPerTurn: 3, dialogTimeoutSeconds: 180)] {
            XCTAssertThrowsError(try d.settingsSetAccess(new, verified: false)) { XCTAssertEqual(($0 as? Denial)?.reason, "verification_required") }
            XCTAssertEqual(d.settings.access.dialogsPerTurn, 2)
        }
        // A shorter timeout is neither: no verification.
        try d.settingsSetAccess(AccessDefaults(defaultMode: .ask, sessionLimitMinutes: 15, dialogsPerTurn: 2, dialogTimeoutSeconds: 60), verified: false)
        // Verified: taken, and recorded as such.
        try d.settingsSetAccess(AccessDefaults(defaultMode: .read, sessionLimitMinutes: 60, dialogsPerTurn: 3, dialogTimeoutSeconds: 60), verified: true)
        XCTAssertEqual(h.lastAudit["verified"], true)
        XCTAssertEqual(h.lastAudit["loosened"], .array(["default_mode", "session_limit_minutes", "dialogs_per_turn"]))
        // Values the page does not offer are refused, in the method and in a hand-edited file.
        XCTAssertThrowsError(try d.settingsSetAccess(AccessDefaults(sessionLimitMinutes: 45), verified: true))
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        XCTAssertThrowsError(try decoder.decode(UserSettings.self, from: Data(#"{"access":{"dialogs_per_turn":9}}"#.utf8)))
        // A version-1 file (no access section) gets the defaults.
        let v1 = try decoder.decode(UserSettings.self, from: Data(#"{"version":1,"denylist":[]}"#.utf8))
        XCTAssertEqual(v1.access, AccessDefaults())
        XCTAssertEqual(AccessDefaults().sessionLimit, AccessRules.sessionLimit)
        XCTAssertEqual(AccessDefaults().dialogTimeout, AccessRules.dialogTimeout)
        XCTAssertEqual(AccessDefaults().dialogsPerTurn, AccessRules.dialogsPerTurn)
    }

    func testAPersistentEntrysModeCanBeLoweredAtOnceAndRaisedOnlyVerified() throws {
        let h = Harness()
        let d = try XCTUnwrap(h.dispatcher)
        approve(h, textEdit, mode: "full", .always)
        XCTAssertEqual(try h.persistent.load().first?.appMode, .full)
        // Lowering: no verification; the task loses the app at once.
        try d.settingsSetPersistentMode(bundleID: textEdit, mode: .read, verified: false)
        XCTAssertEqual(try h.persistent.load().first?.appMode, .read)
        XCTAssertEqual(h.lastAudit["method"], "settings.persistent_mode")
        XCTAssertEqual(h.lastAudit["dropped_from"], .array(["t1"]))
        assertDenied(h.call("observe", ["task_id": "t1", "app": .string(textEdit), "ocr": "off"]), "no_grant", in: h)
        // Raising: verified only.
        XCTAssertThrowsError(try d.settingsSetPersistentMode(bundleID: textEdit, mode: .full, verified: false)) {
            XCTAssertEqual(($0 as? Denial)?.reason, "verification_required")
        }
        XCTAssertEqual(try h.persistent.load().first?.appMode, .read)
        try d.settingsSetPersistentMode(bundleID: textEdit, mode: .full, verified: true)
        XCTAssertEqual(try h.persistent.load().first?.appMode, .full)
        XCTAssertEqual(try h.persistent.load().first?.requirement, h.apps.requirements["/System/Applications/TextEdit.app"], "the pin is kept")
        XCTAssertThrowsError(try d.settingsSetPersistentMode(bundleID: "com.example.none", mode: .read, verified: false))
    }

    func testTheWindowAddsToTheAlwaysListOnlyVerifiedAndNeverTheFloorOrTheDenyList() throws {
        let h = Harness(settings: MemorySettingsStore(UserSettings(denylist: [DenyEntry(bundleId: "com.example.notes-a", note: "", addedAt: Date())])))
        let d = try XCTUnwrap(h.dispatcher)
        XCTAssertThrowsError(try d.settingsPersistentAdd(bundleID: textEdit, mode: .full, verified: false)) {
            XCTAssertEqual(($0 as? Denial)?.reason, "verification_required")
        }
        XCTAssertTrue(try h.persistent.load().isEmpty)
        try d.settingsPersistentAdd(bundleID: textEdit, mode: .full, verified: true)
        let e = try XCTUnwrap(try h.persistent.load().first)
        XCTAssertEqual(e.appMode, .full)
        XCTAssertEqual(e.via, "settings")
        XCTAssertEqual(e.requirement, h.apps.requirements["/System/Applications/TextEdit.app"])
        XCTAssertEqual(h.lastAudit["method"], "settings.persistent_add")
        // The task gets it without a dialog, like any always entry.
        assertAllowed(request(h, textEdit, mode: "full"), in: h)
        XCTAssertTrue(h.presenter.shown.isEmpty)
        for (app, reason) in [("com.apple.Terminal", "hard_denied"), ("com.example.notes-a", "user_denied"),
                              ("com.example.notes-b", "unsigned_app"), ("com.example.missing", "app_not_found")] {
            XCTAssertThrowsError(try d.settingsPersistentAdd(bundleID: app, mode: .read, verified: true), app) {
                XCTAssertEqual(($0 as? Denial)?.reason, reason, app)
            }
        }
        XCTAssertEqual(try h.persistent.load().count, 1)
    }

    func testAVoidedPersistentEntryIsPinnedAgainOnlyVerified() throws {
        let h = Harness()
        let d = try XCTUnwrap(h.dispatcher)
        approve(h, textEdit, .always)
        let newReq = "identifier \"com.apple.TextEdit\" and certificate leaf = H\"cccc\""
        h.apps.requirements["/System/Applications/TextEdit.app"] = newReq
        XCTAssertEqual(d.settingsSnapshot().persistentValid[textEdit.lowercased()], false)
        XCTAssertThrowsError(try d.settingsReapprovePersistent(bundleID: textEdit, verified: false)) {
            XCTAssertEqual(($0 as? Denial)?.reason, "verification_required")
        }
        try d.settingsReapprovePersistent(bundleID: textEdit, verified: true)
        XCTAssertEqual(try h.persistent.load().first?.requirement, newReq)
        XCTAssertEqual(try h.persistent.load().first?.appMode, .read, "the mode is kept")
        XCTAssertEqual(d.settingsSnapshot().persistentValid[textEdit.lowercased()], true)
        XCTAssertEqual(h.lastAudit["method"], "settings.persistent_reapprove")
        XCTAssertThrowsError(try d.settingsReapprovePersistent(bundleID: "com.example.none", verified: true))
    }

    func testTheFloorIsCategorisedAndIncludesTheNamespaces() throws {
        let floor = Harness().dispatcher.settingsSnapshot().hardDeny
        XCTAssertTrue(floor.contains { $0.bundleID == "com.jetbrains" })
        for c in HardDeny.Category.allCases { XCTAssertTrue(floor.contains { $0.category == c }, "\(c)") }
        XCTAssertEqual(floor.first { $0.bundleID == "com.apple.Terminal" }?.category, .runsCode)
        XCTAssertEqual(floor.first { $0.bundleID == HardDeny.daemon }?.category, .selfAndRemote)
    }

    // MARK: the chord allowlist (batch 2, 2026-10-17)

    private func key(_ h: Harness, _ chord: String, app: String = fixture, task: String = "t1") -> Result<JSONValue, RPCFailure> {
        h.call("act.key", ["task_id": .string(task), "app": .string(app), "chord": .string(chord)])
    }

    func testABuiltInChordSwitchedOffIsRefusedAndSwitchedOnAgainOnlyVerified() throws {
        let h = Harness()
        let d = try XCTUnwrap(h.dispatcher)
        approve(h, fixture, mode: "full")
        assertAllowed(key(h, "cmd+v"), in: h)
        try d.settingsChordDisable("cmd+v")
        XCTAssertEqual(h.lastAudit["method"], "settings.chord_disable")
        XCTAssertEqual(h.settingsStore.settings.chords.disabled, ["cmd+v"])
        assertDenied(key(h, "cmd+v"), "chord_not_allowed", in: h)
        assertAllowed(key(h, "cmd+c"), in: h)  // the others stay
        XCTAssertThrowsError(try d.settingsChordEnable("cmd+v", verified: false)) { XCTAssertEqual(($0 as? Denial)?.reason, "verification_required") }
        assertDenied(key(h, "cmd+v"), "chord_not_allowed", in: h)
        try d.settingsChordEnable("cmd+v", verified: true)
        assertAllowed(key(h, "cmd+v"), in: h)
        XCTAssertThrowsError(try d.settingsChordDisable("cmd+k")) { XCTAssertEqual(($0 as? Denial)?.reason, "not_found") }
        XCTAssertThrowsError(try d.settingsChordDisable("cmd+nope")) { XCTAssertEqual(($0 as? Denial)?.reason, "invalid_chord") }
    }

    func testAChordOfTheUsersIsAllowedInItsAppOrEverywhereAndGoesWhenRemoved() throws {
        let h = Harness()
        let d = try XCTUnwrap(h.dispatcher)
        h.env.running.insert(textEdit.lowercased())
        h.env.activatable.insert(textEdit.lowercased())
        approve(h, fixture, mode: "full")
        approve(h, textEdit, mode: "full")
        assertDenied(key(h, "cmd+k"), "chord_not_allowed", in: h)
        XCTAssertThrowsError(try d.settingsChordAdd("cmd+k", app: fixture, note: "search", verified: false)) {
            XCTAssertEqual(($0 as? Denial)?.reason, "verification_required")
        }
        try d.settingsChordAdd("Cmd+K", app: fixture, note: "search", verified: true)
        XCTAssertEqual(h.lastAudit["method"], "settings.chord_add")
        XCTAssertEqual(h.settingsStore.settings.chords.custom.first?.chord, "cmd+k", "normalized")
        assertAllowed(key(h, "cmd+k"), in: h)
        assertDenied(key(h, "cmd+k", app: textEdit), "chord_not_allowed", in: h)  // limited to its app
        // The same chord for every approved app.
        try d.settingsChordAdd("cmd+k", app: "", note: "", verified: true)
        assertAllowed(key(h, "cmd+k", app: textEdit), in: h)
        XCTAssertEqual(h.settingsStore.settings.chords.custom.count, 2)
        try d.settingsChordRemove("cmd+k", app: nil)
        assertDenied(key(h, "cmd+k", app: textEdit), "chord_not_allowed", in: h)
        assertAllowed(key(h, "cmd+k"), in: h)  // the per-app one stays
        try d.settingsChordRemove("cmd+k", app: fixture)
        assertDenied(key(h, "cmd+k"), "chord_not_allowed", in: h)
        XCTAssertThrowsError(try d.settingsChordRemove("cmd+k", app: fixture)) { XCTAssertEqual(($0 as? Denial)?.reason, "not_found") }
    }

    func testNeverAllowedAndBuiltInChordsCannotBeAddedAndNeverAllowedWinsOverAHandEditedFile() throws {
        let h = Harness()
        let d = try XCTUnwrap(h.dispatcher)
        for (chord, reason) in [("cmd+tab", "chord_never_allowed"), ("ctrl+cmd+q", "chord_never_allowed"), ("cmd+shift+4", "chord_never_allowed"),
                                ("f5", "chord_never_allowed"), ("fn+a", "chord_never_allowed"), ("cmd+c", "chord_builtin"), ("a", "chord_builtin"),
                                ("shift+a", "chord_builtin")] {
            XCTAssertThrowsError(try d.settingsChordAdd(chord, app: nil, note: "", verified: true), chord) {
                XCTAssertEqual(($0 as? Denial)?.reason, reason, chord)
            }
        }
        XCTAssertThrowsError(try d.settingsChordAdd("cmd+k", app: "com.apple.Terminal", note: "", verified: true)) {
            XCTAssertEqual(($0 as? Denial)?.reason, "app_not_grantable")
        }
        XCTAssertTrue(h.settingsStore.settings.chords.custom.isEmpty)
        // Written into the file by hand: still refused at the key.
        let h2 = Harness(settings: MemorySettingsStore(UserSettings(chords: ChordSettings(custom: [
            CustomChord(chord: "cmd+tab", app: nil, note: "", addedAt: Date()), CustomChord(chord: "f5", app: nil, note: "", addedAt: Date())]))))
        approve(h2, fixture, mode: "full")
        assertDenied(key(h2, "cmd+tab"), "chord_not_allowed", in: h2)
        assertDenied(key(h2, "f5"), "chord_not_allowed", in: h2)
        XCTAssertEqual(ChordPolicy.neverAllowed.count, 16, "every listed chord parsed")
        XCTAssertTrue(ChordPolicy.neverAllowed.isDisjoint(with: ChordPolicy.allowedWithModifiers))
    }

    func testRevokeOneRevokeAllAndTheSnapshot() throws {
        let h = Harness()
        approve(h, fixture)
        h.call("grants.set", ["task_id": "t2", "bundle_ids": .array([.string(textEdit)]), "source": "config"])
        let snap = h.dispatcher.settingsSnapshot()
        XCTAssertEqual(snap.grants.map(\.taskID), ["t1", "t2"])
        XCTAssertEqual(snap.grants[0].apps.first?.mode, .read)
        XCTAssertEqual(snap.grants[0].apps.first?.scope, .session)
        XCTAssertEqual(snap.grants[0].ownerPID, h.conn.peerPID)
        XCTAssertFalse(snap.grants[0].ownerGone)
        XCTAssertFalse(snap.grants[1].ownerGone, "a config grant has no owner")
        // The approving dsh exited (2026-10-16: a restarted dsh left its session's rows unexplained): the row says so.
        h.env.processes[try XCTUnwrap(h.conn.peerPID)] = .some(nil)
        XCTAssertTrue(h.dispatcher.settingsSnapshot().grants[0].ownerGone)
        h.env.processes.removeValue(forKey: try XCTUnwrap(h.conn.peerPID))
        XCTAssertNil(snap.grants[1].apps.first?.mode, "a config grant has no per-app mode")
        XCTAssertEqual(snap.grants[1].source, .config)
        XCTAssertFalse(snap.hardDeny.isEmpty)
        XCTAssertEqual(snap.startedAt, h.dispatcher.startedAt)

        XCTAssertTrue(h.dispatcher.settingsRevoke(taskID: "t2"))
        XCTAssertEqual(h.lastAudit["method"], "settings.revoke")
        XCTAssertFalse(h.dispatcher.settingsRevoke(taskID: "t2"))
        assertDenied(h.call("observe", ["task_id": "t2", "app": .string(textEdit), "ocr": "off"]), "no_grant", in: h)
        XCTAssertEqual(h.dispatcher.settingsRevokeAll(), 1)
        XCTAssertEqual(h.lastAudit["method"], "settings.revoke_all")
        XCTAssertTrue(h.dispatcher.settingsSnapshot().grants.isEmpty)
        assertDenied(h.call("observe", ["task_id": "t1", "app": .string(fixture), "ocr": "off"]), "no_grant", in: h)

        approve(h, fixture, .always)
        XCTAssertEqual(h.dispatcher.settingsSnapshot().persistent.map(\.bundleId), [fixture])
        try h.dispatcher.settingsRevokePersistent(bundleID: fixture)
        XCTAssertEqual(h.lastAudit["method"], "settings.persistent_revoke")
        XCTAssertTrue(h.dispatcher.settingsSnapshot().persistent.isEmpty)
    }

    // MARK: the file

    func testTheSettingsFileRoundTripsIsPrivateAndABrokenOneOpensNothing() throws {
        let store = FileSettingsStore(stateDir: dir)
        XCTAssertEqual(try store.load(), UserSettings())
        let s = UserSettings(denylist: [DenyEntry(bundleId: textEdit, note: "私人笔记", addedAt: Date(timeIntervalSince1970: 1_700_000_000))])
        try store.save(s)
        XCTAssertEqual(try store.load(), s)
        let attrs = try FileManager.default.attributesOfItem(atPath: store.url.path)
        XCTAssertEqual((attrs[.posixPermissions] as? Int).map { $0 & 0o777 }, 0o600)
        let text = try String(contentsOf: store.url, encoding: .utf8)
        XCTAssertTrue(text.contains("\"bundle_id\""), "snake_case on disk, like grants.json")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: store.url.path)
        XCTAssertThrowsError(try store.load())
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: store.url.path)
        try Data("{not json".utf8).write(to: store.url)
        // A daemon started on a broken file runs with empty settings and says so in the audit.
        let audit = MemoryAudit()
        let d = Dispatcher(grants: GrantStore(), env: FakeEnv(), config: PolicyConfig(), audit: audit, settingsStore: store)
        XCTAssertEqual(d.settings, UserSettings())
        XCTAssertEqual(audit.entries.last?["method"], "settings.load")
        XCTAssertEqual(audit.entries.last?["decision"], "error")
    }

    // VM round 17 (2026-10-17): OCR and UI text switched off came back on at every daemon start. On disk sendOCR is
    // "send_ocr", which convertFromSnakeCase reads back as "sendOcr", not the property's key: the field looked
    // absent and took its default (on). Every field, off its default, must come back from the file and the export.
    func testEveryFieldOffItsDefaultSurvivesTheFileAndTheExport() throws {
        let s = UserSettings(
            denylist: [DenyEntry(bundleId: textEdit, note: "n", addedAt: Date(timeIntervalSince1970: 1_700_000_000))],
            access: AccessDefaults(defaultMode: .read, sessionLimitMinutes: 15, dialogsPerTurn: 1, dialogTimeoutSeconds: 60, dialogDefault: .turn),
            chords: ChordSettings(disabled: ["cmd+c"], custom: [CustomChord(chord: "cmd+k", app: textEdit, note: "n",
                                                                             addedAt: Date(timeIntervalSince1970: 1_700_000_000))]),
            privacy: PrivacySettings(sendScreenshots: false, sendAXText: false, sendOCR: false, sendZoom: false,
                                     textOnlyApps: [textEdit], clearClipboardOnTurnStart: true),
            behavior: BehaviorSettings(restoreFocusOnTurnEnd: false, allowPointTargets: false, imePolicyCap: .leave,
                                       electronAXAuto: false, activationMethod: ActivationMethod.axFrontmost.rawValue),
            logs: LogSettings(directory: "/tmp/somewhere", retentionDays: 7))
        let store = FileSettingsStore(stateDir: dir)
        try store.save(s)
        XCTAssertEqual(try store.load(), s)
        XCTAssertEqual(try UserSettings.decode(s.encoded()), s)
        // The names on disk do not change: files written before the fix read back the same.
        let text = try String(contentsOf: store.url, encoding: .utf8)
        for key in ["\"send_ocr\"", "\"send_ax_text\"", "\"electron_ax_auto\""] { XCTAssertTrue(text.contains(key), key) }
    }

    // MARK: the audit, read back

    func testRecentRefusalsComeFromTodayAndYesterdayNewestFirstWithoutSilentProbes() throws {
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.timeZone = TimeZone(secondsFromGMT: 0)
        fmt.dateFormat = "yyyy-MM-dd"
        let now = Date()
        let lines = [
            #"{"method":"act.key","decision":"deny","reason":"chord_not_allowed","app":"com.apple.TextEdit","chord":"cmd+t","detail":"cmd+t: not on the chord allowlist","ts":"2026-10-15T11:01:00.000Z"}"#,
            #"{"method":"access.request","decision":"deny","reason":"approval_unavailable","silent":true,"app":"x","ts":"2026-10-15T11:02:00.000Z"}"#,
            #"{"method":"observe","decision":"allow","ts":"2026-10-15T11:03:00.000Z"}"#,
            "not json at all",
            #"{"method":"access.request","decision":"deny","reason":"dsh_host_app","app_requested":"Safari","ts":"2026-10-15T11:04:00.000Z"}"#,
            #"{"method":"apps.launch","decision":"deny","reason":"no_grant","ts":"2026-10-15T11:05:00.000Z"}"#,
            #"{"method":"act.type","decision":"deny","reason":"action_not_allowed","app":"x","ts":"2026-10-15T11:06:00.000Z"}"#,
        ]
        try lines.joined(separator: "\n").write(to: dir.appendingPathComponent("audit-\(fmt.string(from: now)).jsonl"), atomically: true, encoding: .utf8)
        try #"{"method":"act.click","decision":"deny","reason":"hit_test_failed","app":"com.tencent.xinWeChat","ts":"2026-10-14T11:00:00.000Z"}"#
            .write(to: dir.appendingPathComponent("audit-\(fmt.string(from: now.addingTimeInterval(-86400))).jsonl"), atomically: true, encoding: .utf8)
        let all = AuditReader.recentRefusals(directory: dir, now: now, timeZone: TimeZone(secondsFromGMT: 0)!)
        XCTAssertEqual(all.map(\.reason), ["dsh_host_app", "chord_not_allowed", "hit_test_failed"])
        XCTAssertEqual(all[0].app, "Safari")
        XCTAssertEqual(all[1].chord, "cmd+t")
        XCTAssertEqual(AuditReader.recentRefusals(directory: dir, now: now, limit: 1, timeZone: TimeZone(secondsFromGMT: 0)!).count, 1)
        XCTAssertTrue(AuditReader.recentRefusals(directory: dir.appendingPathComponent("missing"), now: now, timeZone: TimeZone(secondsFromGMT: 0)!).isEmpty)
    }

    // Both readers skip a line without their word before parsing it (stage 3 review, daemon-3): the lists are the same
    // as a parse of every line gives, with noise around them, the word only inside other text, and lines laid out
    // with spaces (valid JSON the audit itself does not write).
    func testTheAuditReadersGiveTheSameListsAmongNoiseLines() throws {
        let utc = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-21T12:00:00Z"))
        let lines = [
            #"{"method":"observe","decision":"allow","ts":"2026-10-21T10:00:00.000Z"}"#,
            #"{ "method" : "act.click" , "decision" : "deny" , "reason" : "hit_test_failed" , "app" : "com.apple.TextEdit" }"#,
            #"{"method":"act.key","decision":"allow","detail":"not on the denylist","ts":"2026-10-21T10:01:00.000Z"}"#,
            #"{"method":"act.key","decision":"deny","reason":"chord_not_allowed","chord":"cmd+q""#,
            #"{"method":"observe","decision":"allow","detail":"read settings.yaml","ts":"2026-10-21T10:02:00.000Z"}"#,
            #"{"method":"settings.denylist_add","decision":"allow","app":"com.apple.Notes","ts":"2026-10-21T10:03:00.000Z"#,
            #"{"method":"act.type","decision":"denied","reason":"typed","detail":"deny","ts":"2026-10-21T10:04:00.000Z"}"#,
            #"{ "method" : "settings.denylist_add" , "decision" : "allow" , "app" : "com.apple.Notes" , "ts" : "2026-10-21T10:05:00.000Z" }"#,
            "deny settings. not json",
            #"{"method":"settings.snapshot","decision":"allow","ts":"2026-10-21T10:06:00.000Z"}"#,
            #"{"method":"apps.launch","decision":"deny","reason":"dsh_host_app","app":"com.example.dsh","detail":"settings.","ts":"2026-10-21T10:07:00.000Z"}"#,
            #"{"method":"settings.privacy_set","decision":"allow","screenshots":false,"ts":"2026-10-21T10:08:00.000Z"}"#,
            "",
        ]
        try lines.joined(separator: "\n").write(to: dir.appendingPathComponent("audit-2026-10-21.jsonl"), atomically: true, encoding: .utf8)
        let refusals = AuditReader.recentRefusals(directory: dir, now: now, timeZone: utc)
        XCTAssertEqual(refusals.map(\.reason), ["dsh_host_app", "hit_test_failed"])
        XCTAssertEqual(refusals.map(\.method), ["apps.launch", "act.click"])
        XCTAssertEqual(refusals.first?.detail, "settings.")
        XCTAssertEqual(refusals.last?.app, "com.apple.TextEdit")
        XCTAssertEqual(refusals.last?.at, now, "no ts: read as now")
        XCTAssertEqual(AuditReader.recentRefusals(directory: dir, now: now, limit: 1, timeZone: utc).map(\.reason), ["dsh_host_app"])
        let changes = AuditReader.recentSettingsChanges(directory: dir, now: now, timeZone: utc)
        XCTAssertEqual(changes.map(\.method), ["settings.privacy_set", "settings.denylist_add"])
        XCTAssertEqual(changes.first?.fields, ["screenshots": false])
        XCTAssertEqual(changes.last?.fields, ["app": "com.apple.Notes"])
        XCTAssertEqual(changes.last?.at, ISO8601DateFormatter().date(from: "2026-10-21T10:05:00Z"))
        XCTAssertEqual(AuditReader.recentSettingsChanges(directory: dir, now: now, limit: 1, timeZone: utc).map(\.method),
                       ["settings.privacy_set"])
    }

    // dsh 0.2.x (seen with 0.2.1-rc.2, 2026-10-17) renames settings.yaml at a profile's start and keeps its values as
    // rows of the profile's cordis.patch.yml, as its settings pages write them.
    func testDshEntryValuesAreReadFromAProfilePatchAsDsh021WritesThem() throws {
        let patch = """
        # header comment
        - id: tool-todo
          disabled: true
        - id: agent-default-model
          config:
            provider: deepseek-official
            model: deepseek-flash
        - id: ui-theme
          name: "@deepseek-ai/dsh-client-ui-theme"
          config:
            fontSize: 14
            preference: dark
        - id: agent-default-model
          name: "@deepseek-ai/dsh-agent-default-model"
          config:
            reasoningEffort: high
            nested:
              model: not-this-one
        """
        XCTAssertEqual(DshEntryValue.inPatch(patch, entry: "agent-default-model", key: "model"), "deepseek-flash")
        XCTAssertEqual(DshEntryValue.inPatch(patch, entry: "agent-default-model", key: "reasoningEffort"), "high", "a later row of the entry")
        XCTAssertEqual(DshThemePreference.parsePatch(patch), .dark)
        XCTAssertNil(DshEntryValue.inPatch(patch, entry: "ui-theme", key: "name"), "row fields are not config")
        XCTAssertNil(DshThemePreference.parsePatch("- id: locale\n  config:\n    preference: dark\n"))
        // resolve() reads the profiles' patches too: here the newest file, in a home without settings.yaml.
        let home = dir.appendingPathComponent("h021"), web = home.appendingPathComponent("profiles/web")
        try FileManager.default.createDirectory(at: web, withIntermediateDirectories: true)
        try patch.write(to: web.appendingPathComponent("cordis.patch.yml"), atomically: true, encoding: .utf8)
        XCTAssertEqual(DshThemePreference.resolve(homes: [home]).0, .dark)
        XCTAssertEqual(DshThemePreference.resolve(homes: [home]).1?.lastPathComponent, "cordis.patch.yml")
    }

    func testDshThemePreferenceIsReadFromTheNewestSettingsFileThatSetsOne() throws {
        XCTAssertEqual(DshThemePreference.parse("ui-theme:\n  preference: dark\n  fontSize: 14\n"), .dark)
        XCTAssertEqual(DshThemePreference.parse("locale:\n  preference: zh\nui-theme:\n  fontSize: 15\n  preference: 'light'\nagent-presets:\n  default: x\n"), .light)
        XCTAssertNil(DshThemePreference.parse("locale:\n  preference: dark\n"), "another section's preference is not the theme's")
        XCTAssertNil(DshThemePreference.parse("ui-theme:\n  fontSize: 14\nother:\n  preference: dark\n"))
        XCTAssertNil(DshThemePreference.parse("ui-theme:\n  preference: neon\n"))
        let a = dir.appendingPathComponent("a"), b = dir.appendingPathComponent("b"), c = dir.appendingPathComponent("c")
        for h in [a, b, c] { try FileManager.default.createDirectory(at: h, withIntermediateDirectories: true) }
        try "ui-theme:\n  preference: dark\n".write(to: a.appendingPathComponent("settings.yaml"), atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -100)], ofItemAtPath: a.appendingPathComponent("settings.yaml").path)
        try "locale:\n  preference: zh\n".write(to: b.appendingPathComponent("settings.yaml"), atomically: true, encoding: .utf8)  // newest, says nothing
        XCTAssertEqual(DshThemePreference.resolve(homes: [a, b, c]).0, .dark)
        XCTAssertEqual(DshThemePreference.resolve(homes: [a, b, c]).1, a.appendingPathComponent("settings.yaml"))
        try "ui-theme:\n  preference: light\n".write(to: c.appendingPathComponent("settings.yaml"), atomically: true, encoding: .utf8)
        XCTAssertEqual(DshThemePreference.resolve(homes: [a, b, c]).0, .light, "the newest file that sets one wins")
        XCTAssertEqual(DshThemePreference.resolve(homes: [b]).0, .system)
        XCTAssertNil(DshThemePreference.resolve(homes: [dir.appendingPathComponent("none")]).1)
    }
}
