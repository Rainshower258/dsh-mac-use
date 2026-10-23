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
