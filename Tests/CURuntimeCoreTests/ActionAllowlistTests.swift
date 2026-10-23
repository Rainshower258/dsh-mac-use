import CoreGraphics
import XCTest
@testable import CURuntimeCore

/// Per-task action allowlist (grants.set `actions`; T7 on a real messenger: read only, nothing can be sent).
final class ActionAllowlistTests: XCTestCase {
    private let readOnly: [String] = ["observe", "zoom", "click", "scroll"]

    private func harness(actions: [String]?) -> Harness {
        let h = Harness()
        var p: [String: JSONValue] = ["task_id": "t1", "bundle_ids": [.string(fixture)], "source": "config"]
        if let actions { p["actions"] = .array(actions.map { .string($0) }) }
        assertAllowed(h.call("grants.set", .object(p)), in: h)
        return h
    }

    private func act(_ h: Harness, _ method: String, _ extra: [String: JSONValue] = [:]) -> Result<JSONValue, RPCFailure> {
        var p: [String: JSONValue] = ["task_id": "t1", "app": .string(fixture)]
        for (k, v) in extra { p[k] = v }
        return h.call(method, .object(p))
    }

    func testListedActionsRunAndTheGrantReportsThem() throws {
        let h = harness(actions: readOnly)
        XCTAssertEqual(h.lastAudit["actions"], ["click", "observe", "scroll", "zoom"])
        assertAllowed(act(h, "observe", ["ocr": "off"]), in: h)
        assertAllowed(act(h, "act.click", ["point": screen(200, 200)]), in: h)
        assertAllowed(act(h, "act.scroll", ["point": screen(200, 200), "direction": "down"]), in: h)
        XCTAssertEqual(h.env.clicks.count, 1)
        guard case .array(let list) = try h.call("grants.list").get() else { return XCTFail("no list") }
        XCTAssertEqual(list.first?["actions"], ["click", "observe", "scroll", "zoom"])
    }

    func testUnlistedActionsAreRefusedBeforeAnythingRuns() throws {
        let h = harness(actions: readOnly)
        let g = try h.snapshot()
        let refused: [(String, [String: JSONValue])] = [
            ("act.type", ["text": "hi\n"]),
            ("act.key", ["chord": "return"]),
            ("act.key", ["chord": "cmd+v"]),
            ("act.set_value", ["value": "hi", "element_id": "a1", "snapshot_gen": .number(Double(g))]),
            ("act.ax_action", ["action": "AXConfirm", "element_id": "a1", "snapshot_gen": .number(Double(g))]),
            ("act.drag", ["from": ["point": screen(200, 200)], "to": ["point": screen(300, 300)]]),
            ("apps.launch", ["bundle_id": .string(fixture)]),
        ]
        for (method, extra) in refused {
            let r = act(h, method, extra)
            assertDenied(r, "action_not_allowed", in: h)
            guard case .failure(let f) = r else { continue }
            XCTAssertEqual(f.data?["retry"], "never", method)
            XCTAssertEqual(f.data?["executed"], false, method)
        }
        XCTAssertTrue(h.env.typed.isEmpty)
        XCTAssertTrue(h.env.drags.isEmpty)
        XCTAssertTrue(h.env.clicks.isEmpty)
    }

    /// Positive control: the same calls without an allowlist reach their own checks (so the refusals above come
    /// from the allowlist, not from a request the daemon would have refused anyway).
    func testWithoutAnAllowlistTheSameCallsAreNotRefusedForIt() {
        let h = harness(actions: nil)
        XCTAssertNil(h.lastAudit["actions"])
        assertAllowed(act(h, "act.type", ["text": "hi"]), in: h)
        assertAllowed(act(h, "act.key", ["chord": "return"]), in: h)
        XCTAssertEqual(h.env.typed.isEmpty, false)
    }

    func testAnEmptyAllowlistRefusesEvenObserve() {
        let h = harness(actions: [])
        assertDenied(act(h, "observe", ["ocr": "off"]), "action_not_allowed", in: h)
    }

    func testUnknownActionNamesAreRejectedNotIgnored() {
        let h = Harness()
        let r = h.call("grants.set", ["task_id": "t1", "bundle_ids": [.string(fixture)], "source": "config",
                                      "actions": ["observe", "read_text"]])
        guard case .failure(let f) = r else { return XCTFail("expected invalid params") }
        XCTAssertEqual(f.code, .invalidParams)
        XCTAssertEqual(try h.call("grants.list").get(), [])
    }

    func testMethodsOutsideTheVocabularyStayUsable() {
        let h = harness(actions: [])
        assertAllowed(h.call("apps.list", ["task_id": "t1"]), in: h)
        assertAllowed(h.call("grants.revoke", ["task_id": "t1"]), in: h)
    }

    // MARK: click_limit (T7: left single clicks only)

    private func clickLimited() -> Harness {
        let h = Harness()
        assertAllowed(h.call("grants.set", ["task_id": "t1", "bundle_ids": [.string(fixture)], "source": "config",
                                            "actions": ["observe", "click"],
                                            "click_limit": ["buttons": ["left"], "max_count": 1]]), in: h)
        XCTAssertEqual(h.lastAudit["click_limit"], ["buttons": ["left"], "max_count": 1])
        return h
    }

    func testClickLimitAllowsLeftSingleClicks() {
        let h = clickLimited()
        assertAllowed(act(h, "act.click", ["point": screen(200, 200)]), in: h)
        assertAllowed(act(h, "act.click", ["point": screen(200, 200), "button": "left", "count": 1]), in: h)
        XCTAssertEqual(h.env.clicks.count, 2)
    }

    func testClickLimitRefusesDoubleAndOtherButtonsBeforeAnythingRuns() {
        let h = clickLimited()
        for extra: [String: JSONValue] in [["count": 2], ["count": 3], ["button": "right"], ["button": "middle"],
                                           ["button": "right", "count": 2]] {
            var p = extra
            p["point"] = screen(200, 200)
            let r = act(h, "act.click", p)
            assertDenied(r, "click_not_allowed", in: h)
            guard case .failure(let f) = r else { continue }
            XCTAssertEqual(f.data?["retry"], "never")
            XCTAssertEqual(f.data?["executed"], false)
        }
        XCTAssertTrue(h.env.clicks.isEmpty)
        XCTAssertTrue(h.env.activations.isEmpty, "refused before the app is even activated")
    }

    /// Positive control: without click_limit a double click is not refused for it.
    func testWithoutClickLimitDoubleClicksPass() {
        let h = harness(actions: ["observe", "click"])
        assertAllowed(act(h, "act.click", ["point": screen(200, 200), "count": 2]), in: h)
    }

    func testBadClickLimitsAreRejected() {
        let h = Harness()
        for bad: JSONValue in [["buttons": [], "max_count": 1], ["buttons": ["left"], "max_count": 0],
                               ["buttons": ["thumb"], "max_count": 1], ["buttons": ["left"]]] {
            let r = h.call("grants.set", ["task_id": "t1", "bundle_ids": [.string(fixture)], "source": "config", "click_limit": bad])
            guard case .failure(let f) = r else { XCTFail("accepted \(bad)"); continue }
            XCTAssertEqual(f.code, .invalidParams)
        }
        XCTAssertEqual(try h.call("grants.list").get(), [])
    }

    func testNoGrantStillReportsNoGrant() {
        let h = Harness()
        assertDenied(act(h, "act.type", ["text": "hi"]), "no_grant", in: h)
    }
}
