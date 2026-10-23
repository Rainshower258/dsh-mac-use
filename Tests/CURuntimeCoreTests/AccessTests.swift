import CoreGraphics
import XCTest
@testable import CURuntimeCore

/// Daily use (2026-10-03): the daemon's own approval dialog on first touch, read / full modes, turn / session /
/// always scopes, the persistent list pinned to signatures, and the anti-flood rules.
final class AccessTests: XCTestCase {
    private func request(_ h: Harness, _ app: String, mode: String = "read", task: String = "t1",
                         interactive: Bool = true) -> Result<JSONValue, RPCFailure> {
        h.call("access.request", ["task_id": .string(task), "app": .string(app), "mode": .string(mode),
                                  "reason": "read the latest messages", "interactive": .bool(interactive)])
    }

    private func status(_ h: Harness, _ r: Result<JSONValue, RPCFailure>, task: String = "t1") -> Result<JSONValue, RPCFailure> {
        h.call("access.status", ["task_id": .string(task), "request_id": (try? r.get())?["request_id"] ?? "none"])
    }

    /// Request, the person answers, poll: the poll's result.
    private func approve(_ h: Harness, _ app: String, mode: String = "read", _ answer: DialogAnswer,
                         task: String = "t1") -> Result<JSONValue, RPCFailure> {
        let r = request(h, app, mode: mode, task: task)
        h.presenter.respond(answer)
        return status(h, r, task: task)
    }

    private func act(_ h: Harness, _ method: String, _ extra: [String: JSONValue] = [:], task: String = "t1")
        -> Result<JSONValue, RPCFailure> {
        var p: [String: JSONValue] = ["task_id": .string(task), "app": .string(fixture)]
        for (k, v) in extra { p[k] = v }
        return h.call(method, .object(p))
    }

    // MARK: Dialog flow

    func testFirstTouchShowsTheResolvedAppNotTheModelsStringAndWaitsForAPerson() throws {
        let h = Harness()
        let r = request(h, "  dshfixture ")
        XCTAssertEqual(try r.get()["status"], "pending")
        XCTAssertEqual(h.lastAudit["decision"], "defer")
        XCTAssertNil(h.lastAudit["silent"], "a request that may show a dialog is not marked silent")
        XCTAssertEqual(h.lastAudit["app"], .string(fixture))
        XCTAssertEqual(h.lastAudit["app_resolved_from_name"], true)
        let d = try XCTUnwrap(h.presenter.shown.first)
        XCTAssertEqual(d.identity, AppIdentity(bundleID: fixture, name: "DSHFixture", path: "/Applications/DSHFixture.app"))
        XCTAssertEqual(d.mode, .read)
        XCTAssertEqual(d.reason, "read the latest messages")
        XCTAssertTrue(d.offerAlways, "read mode, signed app")
        XCTAssertEqual(d.timeout, 120)
        // Nothing is usable until the person answers.
        XCTAssertEqual(try status(h, r).get()["status"], "pending")
        assertDenied(act(h, "observe", ["ocr": "off"]), "no_grant", in: h)

        h.presenter.respond(.turn)
        let out = try status(h, r).get()
        XCTAssertEqual(out["status"], "granted")
        XCTAssertEqual(out["mode"], "read")
        XCTAssertEqual(out["scope"], "turn")
        let decision = try XCTUnwrap(h.audit.entries.last { $0["method"] == "access.decision" })
        XCTAssertEqual(decision["answer"], "turn")
        XCTAssertEqual(decision["decision"], "allow")
        XCTAssertEqual(decision["focus"], "restored")
        assertAllowed(act(h, "observe", ["ocr": "off"]), in: h)
    }

    /// The presenter reports where the focus went when the dialog closed; a failed hand-back (the daemon still
    /// frontmost, so the next action is refused) is in the decision's audit line, also for a refusal.
    func testTheDecisionRecordsWhereTheFocusWent() throws {
        let h = Harness()
        h.presenter.focus = .failed
        let r = request(h, fixture)
        h.presenter.respond(.deny)
        assertDenied(status(h, r), "approval_rejected", in: h)
        let decision = try XCTUnwrap(h.audit.entries.last { $0["method"] == "access.decision" })
        XCTAssertEqual(decision["focus"], "failed")
        XCTAssertEqual(decision["decision"], "deny")
    }

    /// 2026-10-16: the plugin asks for full by default, so "always" is offered for full too (signed apps); the
    /// presenter passes the device owner check before it answers .always, and the daemon pins a full entry.
    func testFullModeOffersAlwaysForASignedAppAndPinsAFullEntry() throws {
        let h = Harness()
        let r = request(h, fixture, mode: "full")
        XCTAssertTrue(try XCTUnwrap(h.presenter.shown.first).offerAlways)
        h.presenter.respond(.always)
        XCTAssertEqual(try status(h, r).get()["scope"], "always")
        let e = try XCTUnwrap(h.persistent.grants.first)
        XCTAssertEqual(e.appMode, .full)
        XCTAssertEqual(e.via, "dialog")
        XCTAssertEqual(try request(h, fixture, mode: "full", task: "t2").get()["via"], "persistent")
        XCTAssertEqual(h.presenter.shown.count, 1)
    }

    func testAlwaysIsNotOfferedForAnUnsignedAppInFullModeEither() {
        let h = Harness()
        h.apps.requirements.removeValue(forKey: "/Applications/DSHFixture.app")
        let r = request(h, fixture, mode: "full")
        XCTAssertEqual(h.presenter.shown.first?.offerAlways, false)
        h.presenter.respond(.always)  // a presenter that offered it anyway: unsigned, so it stays in the session
        XCTAssertEqual(try? status(h, r).get()["scope"], "session")
        XCTAssertEqual(h.persistent.grants, [])
    }

    func testAlwaysIsNotOfferedForAnUnsignedApp() {
        let h = Harness()
        h.apps.requirements.removeValue(forKey: "/Applications/DSHFixture.app")
        _ = request(h, fixture)
        XCTAssertEqual(h.presenter.shown.first?.offerAlways, false)
    }

    func testRefusalAndTimeoutAreRefusalsAndARefusedAppIsNotAskedAgainThisTurn() {
        let h = Harness()
        assertDenied(approve(h, fixture, .timeout), "approval_timeout", in: h)
        // A timeout is not the person's no: the next touch may ask again.
        assertDenied(approve(h, fixture, .deny), "approval_rejected", in: h)
        XCTAssertEqual(h.presenter.shown.count, 2)
        assertDenied(request(h, fixture), "approval_refused_earlier", in: h)
        assertDenied(request(h, fixture, mode: "full"), "approval_refused_earlier", in: h)
        XCTAssertEqual(h.presenter.shown.count, 2, "not asked again")
        // Another session (task) is asked.
        _ = request(h, fixture, task: "t2")
        XCTAssertEqual(h.presenter.shown.count, 3)
    }

    /// 2026-10-08 (choice B): a refusal holds for the turn; the person's next message may lead to one more ask.
    func testARefusalEndsWithTheTurnAndOnlyThere() {
        let h = Harness()
        assertDenied(approve(h, fixture, .deny), "approval_rejected", in: h)
        assertAllowed(h.call("access.turn_end", ["task_id": "t2"]), in: h)
        assertDenied(request(h, fixture), "approval_refused_earlier", in: h)  // another task's turn end changes nothing
        assertAllowed(h.call("access.turn_end", ["task_id": "t1"]), in: h)
        XCTAssertEqual(try request(h, fixture).get()["status"], "pending", "asked again in the next turn")
        XCTAssertEqual(h.presenter.shown.count, 2)
        // Without a turn end the refusal still lapses after AccessRules.refusalMemory, as before.
        let h2 = Harness()
        assertDenied(approve(h2, fixture, .deny), "approval_rejected", in: h2)
        h2.clock.addTimeInterval(AccessRules.refusalMemory - 1)
        assertDenied(request(h2, fixture), "approval_refused_earlier", in: h2)
        h2.clock.addTimeInterval(2)
        XCTAssertEqual(try request(h2, fixture).get()["status"], "pending")
    }

    func testAtMostThreeDialogsPerTurn() {
        let h = Harness()
        h.presenter.answer = .turn
        for app in [fixture, textEdit, "com.example.notes-a"] { assertAllowed(status(h, request(h, app)), in: h) }
        assertDenied(request(h, "com.tencent.qq"), "approval_limit", in: h)
        XCTAssertEqual(h.presenter.shown.count, 3)
        assertAllowed(h.call("access.turn_end", ["task_id": "t1"]), in: h)
        _ = request(h, "com.tencent.qq")
        XCTAssertEqual(h.presenter.shown.count, 4, "a new turn may ask again")
    }

    /// Widening an app's read approval to full in the same turn is not one of the counted dialogs.
    func testWideningReadToFullIsNotACountedDialog() {
        let h = Harness()
        h.presenter.answer = .turn
        for app in [fixture, textEdit, "com.example.notes-a"] { assertAllowed(status(h, request(h, app)), in: h) }
        assertAllowed(status(h, request(h, fixture, mode: "full")), in: h)
        XCTAssertEqual(h.presenter.shown.count, 4, "the upgrade dialog was shown")
        XCTAssertEqual(h.audit.entries.last { $0["method"] == "access.request" }?["upgrade"], true)
        assertDenied(request(h, "com.tencent.qq"), "approval_limit", in: h)
        // A full approval asked first for a new app still counts.
        let h2 = Harness()
        h2.presenter.answer = .turn
        for app in [fixture, textEdit, "com.example.notes-a"] { assertAllowed(status(h2, request(h2, app, mode: "full")), in: h2) }
        assertDenied(request(h2, "com.tencent.qq", mode: "full"), "approval_limit", in: h2)
    }

    func testTheDialogSpeaksThePersonsLanguage() {
        let h = Harness()
        _ = h.call("access.request", ["task_id": "t1", "app": .string(fixture), "mode": "read", "interactive": true, "lang": "en"])
        XCTAssertEqual(h.presenter.shown.last?.lang, .en)
        XCTAssertEqual(h.lastAudit["lang"], "en")
        h.presenter.respond(.deny)
        _ = h.call("access.request", ["task_id": "t2", "app": .string(textEdit), "mode": "read", "interactive": true, "lang": "zh"])
        XCTAssertEqual(h.presenter.shown.last?.lang, .zh)
    }

    // MARK: Approvals belong to the client that asked (GrantOwner)

    private let otherPID = ConnectionInfo(id: 2, peerPID: 999, peerPath: "/usr/local/bin/node", peerPIDVersion: 7)
    private let otherPath = ConnectionInfo(id: 3, peerPID: 4242, peerPath: "/usr/bin/python3", peerPIDVersion: 7)
    private let unknownPeer = ConnectionInfo(id: 4, peerPID: nil, peerPath: nil, peerPIDVersion: nil)
    /// Same PID and executable, another process (the PID was reused): only the audit token's version tells.
    private let reusedPID = ConnectionInfo(id: 6, peerPID: 4242, peerPath: "/usr/local/bin/node", peerPIDVersion: 8)
    private let noVersion = ConnectionInfo(id: 7, peerPID: 4242, peerPath: "/usr/local/bin/node", peerPIDVersion: nil)

    private func observe(_ h: Harness, _ c: ConnectionInfo, task: String = "t1") -> Result<JSONValue, RPCFailure> {
        h.dispatcher.handle(method: "observe", params: ["task_id": .string(task), "ocr": "off"], conn: c)
    }

    func testApprovalsBelongToTheClientThatAskedForThem() {
        let h = Harness(config: PolicyConfig())
        h.presenter.answer = .turn
        assertAllowed(status(h, request(h, fixture)), in: h)
        for c in [otherPID, otherPath, unknownPeer] {
            assertDenied(observe(h, c), "grant_owner_mismatch", in: h)
            assertDenied(h.dispatcher.handle(method: "act.click", params: ["task_id": "t1", "app": .string(fixture),
                                                                          "point": ["x": 10, "y": 10]], conn: c),
                         "grant_owner_mismatch", in: h)
            assertDenied(h.dispatcher.handle(method: "access.request", params: ["task_id": "t1", "app": .string(fixture),
                                                                               "mode": "read", "interactive": true], conn: c),
                         "grant_owner_mismatch", in: h)
        }
        XCTAssertEqual(h.presenter.shown.count, 1, "another client reusing the task asks nothing")
        assertAllowed(observe(h, h.conn), in: h)
    }

    func testAnApprovalSettledDuringAnotherClientsCallStaysTheRequesters() {
        let h = Harness(config: PolicyConfig())
        XCTAssertEqual(try request(h, fixture).get()["status"], "pending")
        h.presenter.respond(.turn)
        // The next access.request (any client) settles the answered dialog first.
        _ = h.dispatcher.handle(method: "access.request", params: ["task_id": "t2", "app": .string(textEdit), "mode": "read",
                                                                  "interactive": false], conn: otherPID)
        assertDenied(observe(h, otherPID), "grant_owner_mismatch", in: h)
        assertAllowed(observe(h, h.conn), in: h)
    }

    func testApprovalsEndWhenTheClientThatAskedForThemHasExited() throws {
        // dsh restarted mid-turn: the same conversation (task) goes on from a new process, which is asked again.
        // Exited, or its PID now runs another program; the successor's first call an observe or an access.request.
        for (gone, observeFirst) in [(String?.none, true), (String?.none, false), ("/usr/bin/python3", true),
                                     ("/usr/bin/python3", false)] {
            let h = Harness(config: PolicyConfig())
            assertAllowed(approve(h, fixture, .session), in: h)
            _ = request(h, textEdit)  // the turn's second dialog: no more this turn
            h.presenter.respond(.deny)
            let successor = ConnectionInfo(id: 5, peerPID: 5000, peerPath: "/usr/local/bin/node", peerPIDVersion: 1)
            assertDenied(observe(h, successor), "grant_owner_mismatch", in: h)  // the requester still runs
            h.env.processes[4242] = .some(gone)
            if observeFirst { assertDenied(observe(h, successor), "no_grant", in: h) }
            assertAllowed(h.dispatcher.handle(method: "access.turn_start", params: ["task_id": "t1", "late": true],
                                              conn: successor), in: h)
            let r = h.dispatcher.handle(method: "access.request", params: ["task_id": "t1", "app": .string(fixture),
                                                                          "mode": "read", "interactive": true], conn: successor)
            XCTAssertTrue(h.audit.entries.contains { $0["method"] == "access.owner_gone" && $0["task_id"] == "t1" })
            XCTAssertEqual(try r.get()["status"], "pending", "the successor is asked, not refused")
            h.presenter.respond(.session)
            _ = h.dispatcher.handle(method: "access.status", params: ["task_id": "t1", "request_id": try r.get()["request_id"]!],
                                    conn: successor)
            assertAllowed(observe(h, successor), in: h)
            h.env.processes[4242] = nil
            assertDenied(observe(h, h.conn), "grant_owner_mismatch", in: h)  // now the successor's
            XCTAssertEqual(h.presenter.shown.count, 3)
        }
    }

    func testALaterProcessOnTheOwnersPIDIsNotTheOwner() throws {
        // Same PID, same executable, another PID version. It cannot use the approvals; they end (their owner has
        // exited: its PID is this connection's), and it is asked again like any successor.
        let h = Harness(config: PolicyConfig())
        assertAllowed(approve(h, fixture, .session), in: h)
        assertDenied(observe(h, reusedPID), "no_grant", in: h)
        XCTAssertTrue(h.audit.entries.contains { $0["method"] == "access.owner_gone" && $0["task_id"] == "t1" })
        XCTAssertEqual(h.lastAudit["peer_pidversion"], 8)
        assertAllowed(h.dispatcher.handle(method: "access.turn_start", params: ["task_id": "t1"], conn: reusedPID), in: h)
        let r = h.dispatcher.handle(method: "access.request", params: ["task_id": "t1", "app": .string(fixture),
                                                                      "mode": "read", "interactive": true], conn: reusedPID)
        XCTAssertEqual(try r.get()["status"], "pending", "asked again")
        assertDenied(observe(h, h.conn), "no_grant", in: h)  // nothing is left for the old version either
    }

    func testAPeerWithoutAPIDVersionNeverOwnsApprovals() {
        // No audit token (LOCAL_PEERPID only): it cannot be told apart from a later process on its PID, so it never
        // owns anything (fail closed): its own turn mark does not count, so it gets no dialog and no approval.
        let h = Harness(config: PolicyConfig())
        _ = h.dispatcher.handle(method: "access.turn_start", params: ["task_id": "t1"], conn: noVersion)
        let r = h.dispatcher.handle(method: "access.request", params: ["task_id": "t1", "app": .string(fixture),
                                                                      "mode": "read", "interactive": true], conn: noVersion)
        assertDenied(r, "approval_no_turn", in: h)
        XCTAssertTrue(h.presenter.shown.isEmpty)
        assertDenied(observe(h, noVersion), "no_grant", in: h)
        XCTAssertFalse(GrantOwner(noVersion).matches(noVersion))
        XCTAssertTrue(GrantOwner(h.conn).matches(h.conn))
        XCTAssertFalse(GrantOwner(h.conn).matches(reusedPID))
    }

    func testConfigGrantsHaveNoOwner() {
        // The bench grants with grants.set (config_grants on) and may act from another process.
        let h = Harness()
        assertAllowed(h.call("grants.set", ["task_id": "t1", "bundle_ids": .array([.string(fixture)]), "source": "config"]), in: h)
        assertAllowed(observe(h, otherPID), in: h)
    }

    func testConfigGrantsAreOffUnlessTheConfigTurnsThemOn() throws {
        // Daily use: apps are approved only through access.request and the daemon's dialog, never by grants.set.
        let h = Harness(config: PolicyConfig())
        assertDenied(h.call("grants.set", ["task_id": "t1", "bundle_ids": .array([.string(fixture)]), "source": "config"]),
                     "config_grants_disabled", in: h)
        h.presenter.answer = .turn
        assertAllowed(status(h, request(h, fixture)), in: h)
        XCTAssertEqual(h.presenter.shown.count, 1, "nothing was granted (else no dialog), and the dialog path works")
        // The config file: absent means off; only an explicit true turns it on.
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        XCTAssertFalse(try decoder.decode(PolicyConfig.self, from: Data("{}".utf8)).configGrants)
        XCTAssertTrue(try decoder.decode(PolicyConfig.self, from: Data(#"{"config_grants": true}"#.utf8)).configGrants)
        XCTAssertFalse(PolicyConfig().configGrants)
    }

    func testNoPersonMeansNoDialog() {
        let h = Harness()
        let r = request(h, fixture, interactive: false)
        assertDenied(r, "approval_unavailable", in: h)
        XCTAssertEqual(h.lastAudit["silent"], true, "a probe's refusal must not read as the user's in the audit")
        if case .failure(let f) = r { XCTAssertEqual(f.data?["app_running"], true) }
        h.env.running.remove(fixture)
        if case .failure(let f) = request(h, fixture, interactive: false) { XCTAssertEqual(f.data?["app_running"], false) }
        XCTAssertTrue(h.presenter.shown.isEmpty)
    }

    func testOneDialogAtATimeAndTheSameRequestJoinsIt() throws {
        let h = Harness()
        let first = try request(h, fixture).get()
        let again = try request(h, fixture).get()
        XCTAssertEqual(first["request_id"], again["request_id"])
        assertDenied(request(h, textEdit), "approval_busy", in: h)
        XCTAssertEqual(h.presenter.shown.count, 1)
    }

    func testAnUnknownOrForeignRequestIdIsRefused() {
        let h = Harness()
        let r = request(h, fixture)
        assertDenied(status(h, r, task: "t2"), "unknown_request", in: h)
        assertDenied(h.call("access.status", ["task_id": "t1", "request_id": "dlg-99"]), "unknown_request", in: h)
    }

    func testAPresenterThatNeverAnswersTimesOutOnTheDaemonsSideToo() {
        let h = Harness()
        let r = request(h, fixture)
        h.clock.addTimeInterval(AccessRules.dialogTimeout + 11)
        assertDenied(status(h, r), "approval_timeout", in: h)
    }

    // MARK: What is never asked

    func testHardDeniedAppsAndTheDaemonItselfAreRefusedWithoutADialog() {
        let h = Harness()
        for app in ["com.apple.Terminal", "Terminal", "com.apple.keychainaccess", HardDeny.daemon, "CURuntime",
                    "com.googlecode.iterm2"] {
            assertDenied(request(h, app), "hard_denied", in: h)
        }
        XCTAssertTrue(h.presenter.shown.isEmpty)
        // Nor can a grant name the daemon.
        assertDenied(h.grant("t1", [HardDeny.daemon]), "hard_denied", in: h)
    }

    func testAmbiguousAndUnknownNamesAreRefusedWithoutADialog() throws {
        let h = Harness()
        let r = request(h, "Notes")
        assertDenied(r, "app_name_ambiguous", in: h)
        guard case .failure(let f) = r else { return }
        XCTAssertEqual(f.data?["candidates"], ["com.example.notes-a", "com.example.notes-b"])
        assertDenied(request(h, "No Such App"), "app_not_found", in: h)
        XCTAssertTrue(h.presenter.shown.isEmpty)
    }

    /// 2026-10-23: the model asked for "Millionaire Tycoon" (as the App Store shows it); it is installed as
    /// "Millionaire". The refusal names it as a suggestion, with its bundle ID; nothing is asked or chosen by itself,
    /// and an app the model could not get anyway (hard-denied, on the deny list) is never suggested.
    func testAnUnknownNameSuggestsInstalledAppsWithANearNameWithoutChoosingOne() throws {
        let h = Harness()
        h.apps.installed.append(AppIdentity(bundleID: "com.savysoda.millionaire", name: "Millionaire",
                                            path: "/Applications/Millionaire.app"))
        let r = request(h, "Millionaire Tycoon")
        assertDenied(r, "app_not_found", in: h)
        guard case .failure(let f) = r else { return }
        XCTAssertEqual(f.data?["candidates"], ["com.savysoda.millionaire"])
        XCTAssertTrue(f.message.contains("Millionaire (com.savysoda.millionaire)"), f.message)
        XCTAssertTrue(f.message.contains("ask again with its bundle ID"), f.message)
        XCTAssertTrue(h.presenter.shown.isEmpty, "a suggestion asks nothing")
        XCTAssertNil(h.dispatcher.grants.current("t1", now: h.clock), "and grants nothing")

        // Terminal is near "Terminal Pro" but hard-denied: no suggestion, the plain refusal.
        let t = request(h, "Terminal Pro")
        assertDenied(t, "app_not_found", in: h)
        guard case .failure(let tf) = t else { return }
        XCTAssertNil(tf.data?["candidates"])
        XCTAssertFalse(tf.message.contains("similar"), tf.message)
    }

    func testNearNamesAreContainmentOrASharedWordNeverEquality() {
        XCTAssertTrue(AppNameMatch.isSimilar("Millionaire", to: "Millionaire Tycoon"))
        XCTAssertTrue(AppNameMatch.isSimilar("Millionaire Tycoon™", to: "millionaire"))
        XCTAssertTrue(AppNameMatch.isSimilar("Microsoft Word", to: "Microsoft Excel"))
        XCTAssertTrue(AppNameMatch.isSimilar("微信读书", to: "微信"))
        XCTAssertFalse(AppNameMatch.isSimilar("Millionaire", to: "大富翁"))
        XCTAssertFalse(AppNameMatch.isSimilar("Notes", to: " notes "), "equal is an exact match, not a near one")
        XCTAssertFalse(AppNameMatch.isSimilar("QQ音乐", to: "Q"))
        XCTAssertFalse(AppNameMatch.isSimilar("Go", to: "Google Chrome"), "too short to count")
    }

    /// The dialog is a window of the daemon: a click the model aims at it ("allow") is refused by the hit test,
    /// and nothing is posted.
    func testAClickOnTheDaemonsDialogIsRefused() {
        let h = Harness()
        h.presenter.answer = .turn
        assertAllowed(status(h, request(h, fixture)), in: h)
        let g = try? h.snapshot()
        h.env.windows.insert(FakeWindow(CGRect(x: 300, y: 250, width: 260, height: 160), HardDeny.daemon), at: 0)
        let r = act(h, "act.click", ["point": screen(400, 300), "snapshot_gen": .number(Double(g ?? 0))])
        guard case .failure(let f) = r else { return XCTFail("the click went through") }
        XCTAssertEqual(f.code, .denied)
        XCTAssertTrue(h.env.clicks.isEmpty)
    }

    // MARK: Modes

    func testReadModeAllowsLookingLeftClicksAndScrollingOnly() throws {
        let h = Harness()
        h.presenter.answer = .session
        assertAllowed(status(h, request(h, fixture)), in: h)
        assertAllowed(act(h, "observe", ["ocr": "off"]), in: h)
        assertAllowed(act(h, "act.click", ["point": screen(200, 200)]), in: h)
        assertAllowed(act(h, "act.scroll", ["point": screen(200, 200), "direction": "down"]), in: h)
        let g = try h.snapshot()
        for (method, extra) in [("act.type", ["text": "hi\n"]), ("act.key", ["chord": "return"]),
                                ("act.set_value", ["value": "hi", "element_id": "a1", "snapshot_gen": .number(Double(g))]),
                                ("act.ax_action", ["action": "AXConfirm", "element_id": "a1", "snapshot_gen": .number(Double(g))]),
                                ("act.drag", ["from": ["point": screen(200, 200)], "to": ["point": screen(300, 300)]])]
            as [(String, [String: JSONValue])] {
            let r = act(h, method, extra)
            assertDenied(r, "action_not_allowed", in: h)
            guard case .failure(let f) = r else { continue }
            XCTAssertEqual(f.data?["needs_mode"], "full", method)
        }
        for extra: [String: JSONValue] in [["count": 2], ["button": "right"]] {
            var p = extra
            p["point"] = screen(200, 200)
            assertDenied(act(h, "act.click", p), "click_not_allowed", in: h)
        }
        XCTAssertEqual(h.env.clicks.count, 1)
        XCTAssertTrue(h.env.typed.isEmpty)
        XCTAssertTrue(h.env.pressed.isEmpty)
    }

    /// Of ax_action, read mode allows AXPress (a left single click on the element) and AXRaise (what that click's
    /// activation does), matched exactly; every other AX action still needs full (2026-10-03 QQ run).
    func testReadModeAllowsAXPressAndAXRaiseOnly() throws {
        let h = Harness()
        h.presenter.answer = .session
        assertAllowed(status(h, request(h, fixture)), in: h)
        assertAllowed(act(h, "observe", ["ocr": "off"]), in: h)
        let g = try h.snapshot()
        for action in ["AXPress", "AXRaise"] {
            let r = act(h, "act.ax_action", ["action": .string(action), "element_id": "a1", "snapshot_gen": .number(Double(g))])
            if case .failure(let f) = r { XCTAssertNotEqual(f.data?["reason"]?.stringValue, "action_not_allowed", "\(action): \(f.message)") }
        }
        for action in ["AXConfirm", "AXCancel", "axpress", "AXPress "] {
            let r = act(h, "act.ax_action", ["action": .string(action), "element_id": "a1", "snapshot_gen": .number(Double(g))])
            assertDenied(r, "action_not_allowed", in: h)
            guard case .failure(let f) = r else { continue }
            XCTAssertEqual(f.data?["needs_mode"], "full", action)
        }
    }

    func testFullModeAllowsInputButKeepsTheFloor() {
        let h = Harness()
        h.presenter.answer = .turn
        assertAllowed(status(h, request(h, fixture, mode: "full")), in: h)
        assertAllowed(act(h, "act.type", ["text": "hi"]), in: h)
        assertAllowed(act(h, "act.click", ["point": screen(200, 200), "count": 2]), in: h)
        assertDenied(act(h, "act.key", ["chord": .string(legacyBlockedChords[0])]), "chord_not_allowed", in: h)
        h.env.focusedSecure = true
        assertDenied(act(h, "act.type", ["text": "secret"]), "secure_input", in: h)
    }

    /// Opening an app is part of the full mode (2026-10-09: a task that needs the user to open the app first is not
    /// full control). Read cannot open it; full can, only the approved app; the dialog says when it is not running.
    func testOnlyAFullApprovalOpensTheAppAndTheDialogSaysItIsNotRunning() throws {
        let h = Harness()
        h.env.running.remove(fixture)
        h.presenter.answer = .turn
        let r = request(h, fixture)
        XCTAssertFalse(try XCTUnwrap(h.presenter.shown.last).running)
        XCTAssertEqual(h.lastAudit["app_running"], false)
        assertAllowed(status(h, r), in: h)
        let refused = act(h, "apps.launch")
        assertDenied(refused, "action_not_allowed", in: h)
        if case .failure(let f) = refused { XCTAssertEqual(f.data?["needs_mode"], "full") }
        XCTAssertTrue(h.env.launched.isEmpty)

        assertAllowed(status(h, request(h, fixture, mode: "full")), in: h)
        XCTAssertFalse(try XCTUnwrap(h.presenter.shown.last).running)
        XCTAssertEqual(try act(h, "apps.launch").get()["was_running"], false)
        XCTAssertEqual(h.env.launched, [fixture])
        assertDenied(act(h, "apps.launch", ["app": .string(textEdit)]), "not_granted", in: h)
        XCTAssertEqual(h.env.launched, [fixture])

        h.env.running.insert(fixture)
        let h2 = Harness()
        _ = request(h2, fixture)
        XCTAssertTrue(try XCTUnwrap(h2.presenter.shown.last).running)
        XCTAssertNil(h2.lastAudit["app_running"])
    }

    /// Bringing a running app forward with a window is read, like AXRaise or a Dock click (2026-10-09: QQ running
    /// without a window needed a full approval just to be read). Starting it is still full, checked at launch time.
    func testReadBringsARunningAppForwardButDoesNotStartOne() throws {
        let h = Harness()
        let noGrant = act(h, "apps.launch")
        assertDenied(noGrant, "no_grant", in: h)
        if case .failure(let f) = noGrant { XCTAssertEqual(f.data?["needs_mode"], "read", "running: read is enough") }
        h.env.running.remove(fixture)
        if case .failure(let f) = act(h, "apps.launch") { XCTAssertEqual(f.data?["needs_mode"], "full") }
        h.env.running.insert(fixture)

        h.presenter.answer = .turn
        assertAllowed(status(h, request(h, fixture)), in: h)
        XCTAssertEqual(try act(h, "apps.launch").get()["was_running"], true)
        XCTAssertEqual(h.env.launched, [fixture])
        h.env.running.remove(fixture)
        let refused = act(h, "apps.launch")
        assertDenied(refused, "action_not_allowed", in: h)
        if case .failure(let f) = refused { XCTAssertEqual(f.data?["needs_mode"], "full") }
        XCTAssertEqual(h.env.launched, [fixture], "a read approval never starts an app")
    }

    /// 2f (2026-10-09): the model asked for Safari, the browser dsh runs in; approved, it could click its own approval
    /// buttons. The app in front at a turn's start is the task's host: refused like a hard-denied app, no dialog, in
    /// every mode, kept across turns, also when a config grant names it.
    func testTheAppDshRunsInIsNeverGrantedToTheTask() throws {
        let h = Harness()
        h.env.frontmost = fixture
        _ = h.call("access.turn_start", ["task_id": "t1"])
        for mode in ["read", "full"] {
            assertDenied(request(h, fixture, mode: mode), "dsh_host_app", in: h)
            assertDenied(request(h, fixture, mode: mode, interactive: false), "dsh_host_app", in: h)
        }
        XCTAssertTrue(h.presenter.shown.isEmpty)
        _ = h.call("access.turn_end", ["task_id": "t1"])
        h.env.frontmost = textEdit
        assertDenied(request(h, fixture), "dsh_host_app", in: h)

        h.env.frontmost = fixture
        _ = h.call("access.turn_start", ["task_id": "t2"])
        h.call("grants.set", ["task_id": "t2", "bundle_ids": .array([.string(fixture), .string(textEdit)]), "source": "config"])
        let out = try h.call("observe", ["task_id": "t2", "ocr": "off"]).get()
        XCTAssertEqual(out["apps"], .array([.string(textEdit.lowercased())]))
        assertDenied(act(h, "act.click", ["point": screen(200, 200)], task: "t2"), "dsh_host_app", in: h)
        XCTAssertTrue(h.env.clicks.isEmpty)
        XCTAssertEqual(try request(h, textEdit, task: "t1").get()["status"], "pending", "other apps are asked as usual")
    }

    func testAReadApprovalDoesNotCoverFullButFullCoversRead() throws {
        let h = Harness()
        h.presenter.answer = .session
        assertAllowed(status(h, request(h, fixture)), in: h)
        XCTAssertEqual(try request(h, fixture).get()["via"], "existing")
        XCTAssertEqual(try request(h, fixture, mode: "full").get()["status"], "pending", "an upgrade asks again")
        h.presenter.respond(.session)
        XCTAssertEqual(h.presenter.shown.count, 2)
    }

    // MARK: Scopes

    func testTurnApprovalsEndWithTheTurnSessionOnesAfterThirtyMinutes() {
        let h = Harness()
        h.presenter.answer = .turn
        assertAllowed(status(h, request(h, fixture)), in: h)
        h.presenter.answer = .session
        assertAllowed(status(h, request(h, textEdit)), in: h)
        assertAllowed(h.call("access.turn_end", ["task_id": "t1"]), in: h)
        XCTAssertEqual(h.lastAudit["dropped"], [.string(fixture)])
        assertDenied(act(h, "act.click", ["point": screen(200, 200)]), "not_granted", in: h)
        guard case .success(let list) = h.call("grants.list"), case .array(let gs) = list else { return XCTFail() }
        XCTAssertEqual(gs.first?["bundle_ids"], [.string(textEdit)])
        h.clock.addTimeInterval(AccessRules.sessionLimit + 1)
        assertDenied(h.call("apps.list", ["task_id": "t1"]), "no_grant", in: h)
    }

    /// 2026-10-08 QQ run: read for the session, then full for one turn (to press Return). The turn's end took the
    /// app away, read included, and the next turn had to ask for read again. Now it falls back to read.
    func testATurnsFullOverASessionsReadFallsBackToReadWhenTheTurnEnds() throws {
        let h = Harness()
        h.presenter.answer = .session
        assertAllowed(status(h, request(h, fixture)), in: h)
        h.presenter.answer = .turn
        assertAllowed(status(h, request(h, fixture, mode: "full")), in: h)
        assertAllowed(act(h, "act.type", ["text": "hi"]), in: h)
        let during = try XCTUnwrap(h.dispatcher.grants.current("t1", now: h.clock))
        XCTAssertEqual(during.access[fixture]?.mode, .full)
        XCTAssertEqual(during.fallback[fixture]?.scope, .session)

        assertAllowed(h.call("access.turn_end", ["task_id": "t1"]), in: h)
        XCTAssertEqual(h.lastAudit["dropped"], [], "the app stays, narrower")
        let after = try XCTUnwrap(h.dispatcher.grants.current("t1", now: h.clock))
        XCTAssertEqual(after.access[fixture]?.mode, .read)
        XCTAssertEqual(after.access[fixture]?.scope, .session)
        XCTAssertTrue(after.fallback.isEmpty)
        assertAllowed(act(h, "act.click", ["point": screen(200, 200)]), in: h)
        assertDenied(act(h, "act.type", ["text": "hi"]), "action_not_allowed", in: h)
        // Read is still the session's: asking again (next turn, the person back in dsh's browser) finds it, no dialog.
        h.env.frontmost = "com.google.chrome"
        let shown = h.presenter.shown.count
        XCTAssertEqual(try request(h, fixture).get()["via"], "existing")
        XCTAssertEqual(h.presenter.shown.count, shown)
        // And it ends with the session's 30 minutes, counted from the read approval.
        h.clock.addTimeInterval(AccessRules.sessionLimit + 1)
        assertDenied(act(h, "observe", ["ocr": "off"]), "no_grant", in: h)
    }

    func testAnApprovalThatCoversAndOutlivesTheEarlierOneReplacesIt() throws {
        let h = Harness()
        // Read for a turn, then full for the session: full covers read and lasts longer, nothing kept below.
        h.presenter.answer = .turn
        assertAllowed(status(h, request(h, fixture)), in: h)
        h.presenter.answer = .session
        assertAllowed(status(h, request(h, fixture, mode: "full")), in: h)
        var g = try XCTUnwrap(h.dispatcher.grants.current("t1", now: h.clock))
        XCTAssertEqual(g.access[fixture]?.mode, .full)
        XCTAssertTrue(g.fallback.isEmpty)
        assertAllowed(h.call("access.turn_end", ["task_id": "t1"]), in: h)
        g = try XCTUnwrap(h.dispatcher.grants.current("t1", now: h.clock))
        XCTAssertEqual(g.access[fixture]?.mode, .full, "the session's full is not a turn approval")
        // A turn's full alone still ends with the turn, app and all.
        let h2 = Harness()
        h2.presenter.answer = .turn
        assertAllowed(status(h2, request(h2, fixture, mode: "full")), in: h2)
        assertAllowed(h2.call("access.turn_end", ["task_id": "t1"]), in: h2)
        XCTAssertEqual(h2.lastAudit["dropped"], [.string(fixture)])
    }

    func testTurnEndStillRevokesAConfigGrantAsBefore() {
        let h = Harness()
        assertAllowed(h.grant(), in: h)
        assertAllowed(h.call("access.turn_end", ["task_id": "t1"]), in: h)
        assertDenied(act(h, "observe", ["ocr": "off"]), "no_grant", in: h)
    }

    // MARK: Persistent list

    func testAlwaysPinsTheSignatureAndLaterSessionsSkipTheDialog() throws {
        let h = Harness()
        h.presenter.answer = .always
        XCTAssertEqual(try status(h, request(h, fixture)).get()["scope"], "always")
        let e = try XCTUnwrap(h.persistent.grants.first)
        XCTAssertEqual(e.bundleId, fixture)
        XCTAssertEqual(e.appMode, .read)
        XCTAssertEqual(e.via, "dialog")
        XCTAssertEqual(e.requirement, h.apps.requirements["/Applications/DSHFixture.app"])

        let later = try request(h, fixture, task: "t2").get()
        XCTAssertEqual(later["status"], "granted")
        XCTAssertEqual(later["via"], "persistent")
        XCTAssertEqual(h.presenter.shown.count, 1)
        // Always read does not cover full.
        h.presenter.answer = nil
        XCTAssertEqual(try request(h, fixture, mode: "full", task: "t3").get()["status"], "pending")
    }

    func testASignatureChangeVoidsTheEntryAndAsksAgain() throws {
        let h = Harness()
        h.presenter.answer = .always
        assertAllowed(status(h, request(h, fixture)), in: h)
        h.apps.requirements["/Applications/DSHFixture.app"] = "identifier \"dev.dsh.bench.fixture\" and certificate leaf = H\"ffff\""
        h.presenter.answer = nil
        XCTAssertEqual(try request(h, fixture, task: "t2").get()["status"], "pending")
        XCTAssertEqual(h.persistent.grants, [])
        let voided = try XCTUnwrap(h.audit.entries.last { $0["method"] == "access.persistent_invalidated" })
        XCTAssertEqual(voided["app"], .string(fixture))
    }

    func testThePermanentFullCommandPinsTheSignatureAndRefusesUnsignedOrDeniedApps() throws {
        let h = Harness()
        let id = try XCTUnwrap(h.apps.identity(bundleID: fixture))
        let e = try PersistentGrants.add(id, mode: .full, via: "command", store: h.persistent, apps: h.apps, now: h.clock)
        XCTAssertEqual(e.requirement, h.apps.requirements[id.path])
        let r = try request(h, fixture, mode: "full").get()
        XCTAssertEqual(r["via"], "persistent")
        XCTAssertEqual(r["mode"], "full")
        assertAllowed(act(h, "act.type", ["text": "hi"]), in: h)
        XCTAssertEqual(try PersistentGrants.revoke(bundleID: fixture.uppercased(), store: h.persistent).count, 1)
        XCTAssertEqual(h.persistent.grants, [])

        h.apps.requirements.removeValue(forKey: id.path)
        XCTAssertThrowsError(try PersistentGrants.add(id, mode: .full, via: "command", store: h.persistent, apps: h.apps, now: h.clock))
        let terminal = try XCTUnwrap(h.apps.identity(bundleID: "com.apple.Terminal"))
        XCTAssertThrowsError(try PersistentGrants.add(terminal, mode: .read, via: "command", store: h.persistent, apps: h.apps, now: h.clock))
    }

    func testTheListFileIsPrivateAndRefusedWhenOthersCanReadIt() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cu-grants-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = FilePersistentGrants(stateDir: dir)
        XCTAssertEqual(try store.load(), [])
        let e = PersistentGrant(bundleId: fixture, mode: .read, requirement: "r", path: "/p", addedAt: Date(), via: "dialog")
        try store.save([e])
        let perms = try FileManager.default.attributesOfItem(atPath: store.url.path)[.posixPermissions] as? Int
        XCTAssertEqual(perms, 0o600)
        XCTAssertEqual(try store.load(), [e])
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: store.url.path)
        XCTAssertThrowsError(try store.load())
    }
}
