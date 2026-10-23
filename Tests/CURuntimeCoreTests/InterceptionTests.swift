import CoreGraphics
import XCTest
@testable import CURuntimeCore

/// Audit L3 follow-up (2026-09-29): a click the window list would allow but the AX hit test routes elsewhere is
/// refused with `intercepted_by`, and the next observe flags that area as occluded until the window list changes.
final class InterceptionTests: XCTestCase {
    private let overlay = CGRect(x: 150, y: 150, width: 120, height: 120)

    private func click(_ h: Harness, _ x: Double, _ y: Double) -> Result<JSONValue, RPCFailure> {
        h.call("act.click", ["task_id": "t1", "app": .string(fixture), "point": screen(x, y)])
    }

    private func observeElements(_ h: Harness) throws -> [JSONValue] {
        var r = ObserveResult()
        r.elements = [ObservedElement(source: .ax, app: fixture, role: "AXButton", text: "under",
                                      frame: CGRect(x: 190, y: 190, width: 20, height: 20), confidence: nil),
                      ObservedElement(source: .ax, app: fixture, role: "AXButton", text: "clear",
                                      frame: CGRect(x: 400, y: 400, width: 20, height: 20), confidence: nil)]
        h.env.observeResult = r
        let out = try h.call("observe", ["task_id": "t1", "ocr": "off"]).get()
        guard case .array(let els)? = out["untrusted_observation"]?["elements"] else { XCTFail(); return [] }
        return els
    }

    func testInterceptedClickNamesTheInterceptorAndTheNextObserveFlagsTheArea() throws {
        let h = Harness()
        h.grant()
        h.env.axOverrides = [(overlay, "com.example.overlay", overlay)]
        let r = click(h, 200, 200)
        assertDenied(r, "hit_test_failed", in: h)
        guard case .failure(let f) = r else { return XCTFail() }
        XCTAssertEqual(f.data?["intercepted_by"], "com.example.overlay")
        XCTAssertEqual(h.lastAudit["intercepted_by"], "com.example.overlay")
        XCTAssertTrue(h.env.clicks.isEmpty)

        let els = try observeElements(h)
        XCTAssertEqual(els[0]["occluded"], true)
        XCTAssertEqual(els[0]["intercepted_by"], "com.example.overlay")
        XCTAssertNil(els[1]["intercepted_by"], "outside the intercepting window")
        XCTAssertEqual(h.lastAudit["intercepted_elements"], 1)

        // Still valid while nothing moved; void once the window list changes.
        XCTAssertEqual(try observeElements(h)[0]["intercepted_by"], "com.example.overlay")
        h.env.windows[0].rect = h.env.windows[0].rect.offsetBy(dx: 1, dy: 0)
        XCTAssertNil(try observeElements(h)[0]["intercepted_by"])
    }

    func testNoAXAnswerRefusesAsUnknown() {
        let h = Harness()
        h.grant()
        h.env.axOverrides = [(overlay, nil, nil)]
        let r = click(h, 200, 200)
        assertDenied(r, "hit_test_failed", in: h)
        guard case .failure(let f) = r else { return XCTFail() }
        XCTAssertEqual(f.data?["intercepted_by"], "unknown", "fail closed")
    }

    func testOrdinaryCoverIsNotAnInterception() throws {
        let h = Harness()
        h.grant()
        let other = FakeWindow(CGRect(x: 150, y: 150, width: 120, height: 120), textEdit)
        h.env.windows.insert(other, at: 0)
        // Refused as covered (here already by the snapshot check), never as an interception.
        guard case .failure(let f) = click(h, 200, 200) else { return XCTFail() }
        XCTAssertEqual(f.code, .denied)
        XCTAssertNil(f.data?["intercepted_by"], "the window list already shows the cover")
        XCTAssertNil(try observeElements(h)[0]["intercepted_by"])
    }

    func testUnreadableDockRefusesWithARetryableReason() {
        let h = Harness()
        h.grant()
        h.env.overlayUnknown = true
        assertDenied(click(h, 200, 200), "overlay_state_unknown", in: h)
        XCTAssertTrue(h.env.clicks.isEmpty)
        h.env.overlayUnknown = false
        assertAllowed(click(h, 200, 200), in: h)
    }
}

/// 2026-10-14 (WeChat 4 on the maintainer's Mac): the app answers the AX hit test with kAXErrorNotImplemented for
/// every point, so every click was refused. Then, and only then, the window list decides with invisible windows
/// counted; an invisible window of another app over the point still refuses.
final class AXNotImplementedTests: XCTestCase {
    private func click(_ h: Harness) -> Result<JSONValue, RPCFailure> {
        h.call("act.click", ["task_id": "t1", "app": .string(fixture), "point": screen(200, 200)])
    }

    func testAnAppWithoutAnAXHitTestIsDecidedByTheWindowListAndAudited() {
        let h = Harness()
        h.grant()
        h.env.axNotImplemented = true
        assertAllowed(click(h), in: h)
        XCTAssertEqual(h.env.clicks.count, 1)
        XCTAssertEqual(h.lastAudit["hit_test"], "window_list_only")
    }

    func testAnInvisibleWindowOfAnotherAppOverItStillRefuses() {
        let h = Harness()
        h.grant()
        h.env.axNotImplemented = true
        h.env.invisibleTop = "com.example.overlay"
        let r = click(h)
        assertDenied(r, "hit_test_failed", in: h)
        guard case .failure(let f) = r else { return XCTFail() }
        XCTAssertEqual(f.data?["intercepted_by"], "com.example.overlay")
        XCTAssertTrue(h.env.clicks.isEmpty)
        XCTAssertNil(h.lastAudit["hit_test"])
    }

    func testNoAnswerForAnyOtherReasonStillRefuses() {
        // Positive control of the fallback's narrowness: AX gave no answer (not "not implemented").
        let h = Harness()
        h.grant()
        h.env.axOverrides = [(CGRect(x: 0, y: 0, width: 2000, height: 2000), nil, nil)]
        assertDenied(click(h), "hit_test_failed", in: h)
        XCTAssertTrue(h.env.clicks.isEmpty)
    }
}
