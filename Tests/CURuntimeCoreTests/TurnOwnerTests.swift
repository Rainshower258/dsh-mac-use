@testable import CURuntimeCore
import XCTest

/// M4 (2026-10-14): something new is granted (a dialog, the persistent list) only during a turn the asking client
/// marked, and a task's turns belong to the client that first marked them. A program outside dsh that reaches the
/// socket (bash's `open` runs one outside the sandbox) cannot ask under a running conversation's task, nor between
/// turns; under a task of its own it can, and the dialog then names it and says it is its first request.
final class TurnOwnerTests: XCTestCase {
    private let other = ConnectionInfo(id: 9, peerPID: 7777, peerPath: "/usr/bin/python3", peerPIDVersion: 3)

    private func harness() -> Harness {
        let h = Harness(config: PolicyConfig())
        h.autoTurn = false
        return h
    }

    private func handle(_ h: Harness, _ method: String, _ params: JSONValue, _ c: ConnectionInfo? = nil)
        -> Result<JSONValue, RPCFailure> {
        h.dispatcher.handle(method: method, params: params, conn: c ?? h.conn)
    }

    private func request(_ h: Harness, _ c: ConnectionInfo? = nil, task: String = "t1", app: String = fixture,
                         interactive: Bool = true) -> Result<JSONValue, RPCFailure> {
        handle(h, "access.request", ["task_id": .string(task), "app": .string(app), "mode": "read",
                                     "interactive": .bool(interactive)], c)
    }

    private func turnStart(_ h: Harness, _ c: ConnectionInfo? = nil, task: String = "t1", late: Bool = false)
        -> Result<JSONValue, RPCFailure> {
        handle(h, "access.turn_start", ["task_id": .string(task), "late": .bool(late)], c)
    }

    private func turnEnd(_ h: Harness, _ c: ConnectionInfo? = nil, task: String = "t1") -> Result<JSONValue, RPCFailure> {
        handle(h, "access.turn_end", ["task_id": .string(task)], c)
    }

    func testNoDialogWithoutAMarkedTurnAndNoneBetweenTurns() {
        let h = harness()
        assertDenied(request(h), "approval_no_turn", in: h)
        XCTAssertTrue(h.presenter.shown.isEmpty)
        assertAllowed(turnStart(h), in: h)
        XCTAssertEqual(try request(h).get()["status"], "pending", "positive control: the marked turn is asked")
        h.presenter.respond(.deny)
        assertAllowed(turnEnd(h), in: h)
        assertDenied(request(h, app: textEdit), "approval_no_turn", in: h)
        XCTAssertEqual(h.presenter.shown.count, 1, "between turns: no dialog")
    }

    func testThePersistentListNeedsAMarkedTurnTooButAnExistingApprovalDoesNot() throws {
        let h = harness()
        let id = try XCTUnwrap(h.apps.identity(bundleID: fixture))
        _ = try PersistentGrants.add(id, mode: .read, via: "command", store: h.persistent, apps: h.apps, now: h.clock)
        // Unmarked: the list is not consulted, and a silent probe is answered as before (the bench never marks).
        assertDenied(request(h, interactive: false), "approval_unavailable", in: h)
        XCTAssertNil(h.dispatcher.grants.current("t1", now: h.clock))
        assertAllowed(turnStart(h), in: h)
        XCTAssertEqual(try request(h, interactive: false).get()["via"], "persistent")
        assertAllowed(turnEnd(h), in: h)
        XCTAssertEqual(try request(h, interactive: false).get()["via"], "existing", "what it already has needs no turn")
    }

    func testAnotherClientCannotTakeOverATasksTurns() {
        let h = harness()
        assertAllowed(turnStart(h), in: h)
        assertDenied(turnStart(h, other), "turn_owner_mismatch", in: h)
        assertDenied(request(h, other), "approval_no_turn", in: h)
        assertDenied(turnEnd(h, other), "turn_owner_mismatch", in: h)
        XCTAssertTrue(h.presenter.shown.isEmpty)
        XCTAssertEqual(try request(h).get()["status"], "pending", "the owner's turn is still open")
        h.presenter.respond(.session)
        // While the owner holds the task's approvals as well, after its own turn ended.
        assertAllowed(turnEnd(h), in: h)
        assertDenied(turnStart(h, other), "turn_owner_mismatch", in: h)
    }

    // MARK: Ownership of grants.revoke, grants.list, access.status and the decision (2026-10-23 finding)

    /// The requester polls and settles its own dialog: the task's grant for `c` (the person answered `answer`).
    private func approve(_ h: Harness, _ c: ConnectionInfo? = nil, task: String = "t1", app: String = fixture,
                         _ answer: DialogAnswer = .session) -> Result<JSONValue, RPCFailure> {
        let r = request(h, c, task: task, app: app)
        h.presenter.respond(answer)
        return handle(h, "access.status", ["task_id": .string(task), "request_id": (try? r.get())?["request_id"] ?? "none"], c)
    }

    private func revoke(_ h: Harness, _ c: ConnectionInfo? = nil, task: String = "t1") -> Result<JSONValue, RPCFailure> {
        handle(h, "grants.revoke", ["task_id": .string(task)], c)
    }

    private func listed(_ h: Harness, _ c: ConnectionInfo? = nil) throws -> [String] {
        guard case .array(let gs) = try handle(h, "grants.list", [:], c).get() else { throw RPCFailure(.invalidParams, "no list") }
        return gs.compactMap { $0["task_id"]?.stringValue }
    }

    func testAnotherClientCannotRevokeATaskToTakeItsTurnsOver() throws {
        // grants.revoke used to forget the task's turn owner unchecked: revoke, then turn_start, and dsh's own next
        // turn_start was refused while the outsider could raise dialogs under the conversation's task.
        let h = harness()
        h.env.processes[7777] = "/usr/bin/python3"  // the other client runs
        assertAllowed(turnStart(h), in: h)
        assertAllowed(approve(h), in: h)
        assertDenied(revoke(h, other), "grant_owner_mismatch", in: h)
        XCTAssertNotNil(h.dispatcher.grants.current("t1", now: h.clock), "the owner's approvals stay")
        assertDenied(turnStart(h, other), "turn_owner_mismatch", in: h)
        assertAllowed(turnEnd(h), in: h)
        assertAllowed(turnStart(h), in: h)
        XCTAssertEqual(try request(h, app: textEdit).get()["status"], "pending", "the owner's turn is intact")
        h.presenter.respond(.deny)
        XCTAssertEqual(h.presenter.shown.count, 2)

        // A task whose turns are marked but which holds no approval yet: the turn owner is what is refused.
        assertAllowed(turnStart(h, task: "t2"), in: h)
        assertDenied(revoke(h, other, task: "t2"), "turn_owner_mismatch", in: h)
        assertDenied(turnStart(h, other, task: "t2"), "turn_owner_mismatch", in: h)
        XCTAssertTrue(h.dispatcher.book.turnOwner["t2"]?.matches(h.conn) ?? false)

        // The owner ends its own task; once a client has exited, its tasks are anyone's to clean up.
        XCTAssertEqual(try revoke(h).get()["revoked"], true)
        assertAllowed(turnStart(h, task: "t3"), in: h)
        h.env.processes[4242] = .some(nil)  // dsh exited
        assertAllowed(revoke(h, other, task: "t3"), in: h)
    }

    func testAConfigGrantNobodyHoldsIsRevokedByAnyClientAsTheBenchDoes() {
        // scripts/cu-rpc.py and the bench: grants.set and grants.revoke from separate processes, no turns.
        let h = Harness()
        h.autoTurn = false
        assertAllowed(handle(h, "grants.set", ["task_id": "inspect", "bundle_ids": [.string(fixture)], "source": "config"],
                             other), in: h)
        XCTAssertEqual(try revoke(h, task: "inspect").get()["revoked"], true)
    }

    func testGrantsListShowsOnlyTheCallersTasks() throws {
        let h = Harness()  // config grants on, for a task nobody holds
        h.autoTurn = false
        h.env.processes[7777] = "/usr/bin/python3"
        assertAllowed(turnStart(h), in: h)
        assertAllowed(approve(h), in: h)
        assertAllowed(turnStart(h, other, task: "x"), in: h)
        assertAllowed(approve(h, other, task: "x"), in: h)
        h.grant("cfg")
        XCTAssertEqual(try listed(h), ["cfg", "t1"])
        XCTAssertEqual(h.lastAudit["withheld"], 1)
        XCTAssertEqual(try listed(h, other), ["cfg", "x"])
        // A config grant on a task whose turns another client marks is that client's too.
        h.grant("t2")
        assertAllowed(turnStart(h, task: "t2"), in: h)
        XCTAssertEqual(try listed(h, other), ["cfg", "x"])
        XCTAssertEqual(try listed(h), ["cfg", "t1", "t2"])
    }

    func testOnlyTheRequesterPollsItsDialog() throws {
        let h = harness()
        h.env.processes[7777] = "/usr/bin/python3"
        assertAllowed(turnStart(h), in: h)
        let id = try XCTUnwrap(try request(h).get()["request_id"])
        let poll = { (c: ConnectionInfo?) in self.handle(h, "access.status", ["task_id": "t1", "request_id": id], c) }
        assertDenied(poll(other), "grant_owner_mismatch", in: h)
        XCTAssertNil(h.lastAudit["app"], "the app stays out of a refused poll")
        h.presenter.respond(.session)
        assertDenied(poll(other), "grant_owner_mismatch", in: h)
        XCTAssertNil(h.dispatcher.grants.current("t1", now: h.clock), "a refused poll settles nothing")
        XCTAssertNotNil(h.dispatcher.book.pending)
        XCTAssertEqual(try poll(nil).get()["status"], "granted")
        XCTAssertTrue(h.dispatcher.grants.current("t1", now: h.clock)?.owner?.matches(h.conn) ?? false)
    }

    func testTheDecisionIsRecordedUnderTheRequesterWhoeverSettlesIt() throws {
        let h = harness()
        assertAllowed(turnStart(h), in: h)
        XCTAssertEqual(try request(h).get()["status"], "pending")
        h.presenter.respond(.session)
        // Another client's access.request settles the answered dialog first (settleAbandonedDialog).
        _ = request(h, other, task: "x", interactive: false)
        let line = try XCTUnwrap(h.audit.entries.last { $0["method"] == "access.decision" })
        XCTAssertEqual(line["peer_pid"], 4242)
        XCTAssertEqual(line["peer_exe"], "/usr/local/bin/node")
        XCTAssertEqual(line["conn"], 1)
        XCTAssertEqual(line["settled_by"]?["peer_pid"], 7777)
        XCTAssertTrue(h.dispatcher.grants.current("t1", now: h.clock)?.owner?.matches(h.conn) ?? false)
    }

    func testAnApprovalJoinsAConfigGrantOnlyAsTheRequestersOwn() {
        // A person's approval used to join a config grant (no owner) and stay usable by any client.
        let h = Harness()
        h.autoTurn = false
        h.env.processes[7777] = "/usr/bin/python3"
        h.grant("t1", [textEdit])
        assertAllowed(handle(h, "observe", ["task_id": "t1", "ocr": "off"], other), in: h)  // a config grant: anyone's
        assertAllowed(turnStart(h), in: h)
        assertAllowed(approve(h), in: h)
        let g = h.dispatcher.grants.current("t1", now: h.clock)
        XCTAssertEqual(g?.bundleIDs, [textEdit, fixture])
        XCTAssertTrue(g?.owner?.matches(h.conn) ?? false)
        assertDenied(handle(h, "observe", ["task_id": "t1", "ocr": "off"], other), "grant_owner_mismatch", in: h)
    }

    func testAnApprovalNeverLandsInAnotherClientsGrant() {
        let h = harness()
        h.env.processes[7777] = "/usr/bin/python3"
        assertAllowed(turnStart(h), in: h)
        XCTAssertEqual(try request(h).get()["status"], "pending")
        // Meanwhile the task's grant became another running client's (no RPC path leads here now: defense in depth).
        let theirs = Grant(taskID: "t1", bundleIDs: [textEdit], allowLaunch: false, expiresAt: h.clock.addingTimeInterval(600),
                           source: .approval, owner: GrantOwner(other))
        h.dispatcher.grants.set(theirs)
        h.presenter.respond(.session)
        assertDenied(handle(h, "access.status", ["task_id": "t1", "request_id": "dlg-1"]), "grant_owner_mismatch", in: h)
        XCTAssertEqual(h.dispatcher.grants.current("t1", now: h.clock), theirs, "nothing merged into it")
        let line = h.audit.entries.last { $0["method"] == "access.decision" }
        XCTAssertEqual(line?["decision"], "deny")
        XCTAssertEqual(line?["reason"], "grant_owner_mismatch")
        XCTAssertFalse(h.dispatcher.book.approvedClients.contains(GrantOwner(h.conn)))
    }

    func testOnceTheOwnerHasExitedTheNextClientTakesTheTurnsOver() {
        let h = harness()
        assertAllowed(turnStart(h), in: h)
        h.env.processes[4242] = .some(nil)  // dsh exited
        assertAllowed(turnStart(h, other, late: true), in: h)
        XCTAssertEqual(try request(h, other).get()["status"], "pending")
        assertDenied(request(h, task: "t1", app: textEdit), "approval_no_turn", in: h)
    }

    func testAClientUnderATaskOfItsOwnIsNamedInTheDialogAsAFirstRequest() {
        // The residual (M4): it can mark a task of its own and ask; the person sees who asks.
        let h = harness()
        assertAllowed(turnStart(h, other, task: "x"), in: h)
        XCTAssertEqual(try request(h, other, task: "x").get()["status"], "pending")
        let shown = h.presenter.shown.last
        XCTAssertEqual(shown?.requester, "python3 (PID 7777)")
        XCTAssertEqual(shown?.firstFromRequester, true)
        XCTAssertEqual(h.lastAudit["first_from_requester"], true)
        h.presenter.respond(.deny)
        // dsh, once a person approved something for it, is no longer a first.
        assertAllowed(turnStart(h), in: h)
        _ = request(h)
        XCTAssertEqual(h.presenter.shown.last?.firstFromRequester, true)
        h.presenter.respond(.session)
        _ = handle(h, "access.status", ["task_id": "t1", "request_id": "dlg-2"])
        _ = request(h, app: textEdit)
        XCTAssertEqual(h.presenter.shown.last?.requester, "node (PID 4242)")
        XCTAssertEqual(h.presenter.shown.last?.firstFromRequester, false)
    }

    func testALateMarkNeverReplacesTheHostAStartFound() {
        let h = harness()
        h.env.frontmost = "com.google.chrome"
        assertAllowed(turnStart(h), in: h)
        assertAllowed(turnEnd(h), in: h)
        h.env.frontmost = fixture  // the daemon came up mid-turn, with the fixture in front by then
        assertAllowed(turnStart(h, late: true), in: h)
        XCTAssertEqual(h.lastAudit["late"], true)
        XCTAssertEqual(h.dispatcher.book.hostApp["t1"], "com.google.chrome")
        XCTAssertEqual(try request(h).get()["status"], "pending", "the fixture is not taken for the host")
        h.presenter.respond(.deny)
        // A task with no host yet takes the late mark's; a real start replaces it.
        assertAllowed(turnStart(h, task: "t2", late: true), in: h)
        XCTAssertEqual(h.dispatcher.book.hostApp["t2"], fixture)
        h.env.frontmost = "com.google.chrome"
        assertAllowed(turnStart(h, task: "t2"), in: h)
        XCTAssertEqual(h.dispatcher.book.hostApp["t2"], "com.google.chrome")
    }

    func testTheDialogTextNamesTheRequester() {
        let qq = AppIdentity(bundleID: "com.tencent.qq", name: "QQ", path: "/Applications/QQ.app")
        for lang in [UILanguage.zh, .en] {
            var r = DialogRequest(identity: qq, mode: .read, reason: nil, offerAlways: false, timeout: 120, lang: lang,
                                  requester: "node (PID 1)", firstFromRequester: true)
            var all = ApprovalText(r).lines.joined(separator: "\n")
            XCTAssertTrue(all.contains("node (PID 1)"), "\(lang)")
            XCTAssertTrue(all.contains(lang == .zh ? "第一次申请" : "first request"), "\(lang)")
            r.firstFromRequester = false
            all = ApprovalText(r).lines.joined(separator: "\n")
            XCTAssertFalse(all.contains(lang == .zh ? "第一次申请" : "first request"), "\(lang)")
            r.requester = nil
            all = ApprovalText(r).lines.joined(separator: "\n")
            XCTAssertTrue(all.contains(lang == .zh ? "未知进程" : "unknown process"), "\(lang)")
        }
        XCTAssertNil(Dispatcher.requesterLabel(ConnectionInfo(id: 1, peerPID: nil, peerPath: nil, peerPIDVersion: nil)))
    }
}
