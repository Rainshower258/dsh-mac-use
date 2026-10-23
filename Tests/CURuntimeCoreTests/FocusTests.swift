import XCTest
@testable import CURuntimeCore

/// Turn focus (2026-10-08 QQ run): at a turn's end the focus goes back to the app in front at its start (the browser
/// with dsh), only if an app the turn's actions targeted is in front now.
final class FocusTests: XCTestCase {
    private let browser = "com.google.chrome"

    private func harness() -> Harness {
        let h = Harness()
        h.env.running.insert(browser)
        h.env.activatable.insert(browser)
        h.env.frontmost = browser
        return h
    }

    /// Approval for the fixture this session, as the dialog gives it.
    private func approve(_ h: Harness, task: String = "t1") {
        let r = h.call("access.request", ["task_id": .string(task), "app": .string(fixture), "mode": "read",
                                          "reason": "read", "interactive": true])
        h.presenter.respond(.session)
        assertAllowed(h.call("access.status", ["task_id": .string(task), "request_id": (try? r.get())?["request_id"] ?? "none"]),
                      in: h)
    }

    private func click(_ h: Harness) {
        assertAllowed(h.call("act.click", ["task_id": "t1", "app": .string(fixture), "point": screen(200, 200)]), in: h)
    }

    private func turnEnd(_ h: Harness, restore: Bool? = true) -> [String: JSONValue] {
        var p: [String: JSONValue] = ["task_id": "t1"]
        if let restore { p["restore_focus"] = .bool(restore) }
        assertAllowed(h.call("access.turn_end", .object(p)), in: h)
        return h.lastAudit
    }

    func testTheFocusGoesBackToTheAppInFrontAtTheTurnsStart() {
        let h = harness()
        assertAllowed(h.call("access.turn_start", ["task_id": "t1"]), in: h)
        XCTAssertEqual(h.lastAudit["front"], .string(browser))
        approve(h)
        click(h)
        XCTAssertEqual(h.env.frontmost, fixture, "the click brought the fixture forward")
        let a = turnEnd(h)
        XCTAssertEqual(a["focus"], "restored")
        XCTAssertEqual(a["focus_from"], .string(fixture))
        XCTAssertEqual(a["focus_to"], .string(browser))
        XCTAssertEqual(h.env.frontmost, browser)
        XCTAssertEqual(h.env.activations.last, browser)
    }

    func testAnAppTheUserSwitchedToIsLeftAlone() {
        let h = harness()
        _ = h.call("access.turn_start", ["task_id": "t1"])
        approve(h)
        click(h)
        h.env.frontmost = "com.apple.finder"
        let before = h.env.activations.count
        let a = turnEnd(h)
        XCTAssertEqual(a["focus"], "skipped")
        XCTAssertEqual(a["focus_skipped"], "front_not_targeted")
        XCTAssertEqual(h.env.activations.count, before)
        XCTAssertEqual(h.env.frontmost, "com.apple.finder")
    }

    func testOffUnlessAskedAndTheRecordEndsWithTheTurnEitherWay() {
        let h = harness()
        _ = h.call("access.turn_start", ["task_id": "t1"])
        approve(h)
        click(h)
        let a = turnEnd(h, restore: nil)
        XCTAssertNil(a["focus"])
        XCTAssertEqual(h.env.frontmost, fixture)
        // The next turn was not marked: nothing is restored from the old record.
        XCTAssertEqual(turnEnd(h)["focus_skipped"], "no_turn_start")
        XCTAssertEqual(h.env.frontmost, fixture)
    }

    func testOnlyActionsOfAMarkedTurnAreRecorded() {
        let h = harness()
        _ = h.call("access.turn_start", ["task_id": "t1"])
        approve(h)
        _ = turnEnd(h, restore: nil)
        click(h)  // between turns: nothing recorded
        XCTAssertTrue(h.dispatcher.book.turnTargets.isEmpty)
        XCTAssertEqual(turnEnd(h)["focus_skipped"], "no_turn_start")
    }

    func testTheDaemonInFrontIsNotRemembered() {
        let h = harness()
        h.env.frontmost = HardDeny.daemon
        assertAllowed(h.call("access.turn_start", ["task_id": "t1"]), in: h)
        XCTAssertNil(h.lastAudit["front"])
        h.env.frontmost = browser  // the dialog closed
        approve(h)
        click(h)
        XCTAssertEqual(turnEnd(h)["focus_skipped"], "no_turn_start")
    }

    func testRestoredEvenAfterTheGrantExpired() {
        let h = harness()
        _ = h.call("access.turn_start", ["task_id": "t1"])
        approve(h)
        click(h)
        h.clock.addTimeInterval(AccessRules.sessionLimit + 1)
        XCTAssertEqual(turnEnd(h)["focus"], "restored")
        XCTAssertEqual(h.env.frontmost, browser)
    }

    func testANoActionTurnLeavesTheFocus() {
        let h = harness()
        _ = h.call("access.turn_start", ["task_id": "t1"])
        approve(h)
        assertAllowed(h.call("observe", ["task_id": "t1", "ocr": "off"]), in: h)
        XCTAssertEqual(turnEnd(h)["focus_skipped"], "already_front")
    }

    func testAFailedActivationTriesAXFrontmostThenSaysFailed() {
        let h = harness()
        _ = h.call("access.turn_start", ["task_id": "t1"])
        approve(h)
        click(h)
        h.env.activatable.remove(browser)
        let methods = h.env.activationMethods.count
        XCTAssertEqual(turnEnd(h)["focus"], "failed")
        XCTAssertEqual(Array(h.env.activationMethods.dropFirst(methods)),
                       [Dispatcher.defaultActivationMethod, .axFrontmost])
    }

    func testAPreviousAppThatQuitIsNotRelaunched() {
        let h = harness()
        _ = h.call("access.turn_start", ["task_id": "t1"])
        approve(h)
        click(h)
        h.env.running.remove(browser)
        XCTAssertEqual(turnEnd(h)["focus_skipped"], "previous_gone")
        XCTAssertEqual(h.env.frontmost, fixture)
    }
}
