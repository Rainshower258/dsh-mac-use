import CoreGraphics
import XCTest
@testable import CURuntimeCore

final class ZoomPolicyTests: XCTestCase {
    // VM display: 1440×900 pt @2x, overview 1011×632 (≈0.70 sent px per pt).
    private let display = CaptureGeometry(contentRect: CGRect(x: 0, y: 0, width: 1440, height: 900), pointPixelScale: 2)
    private let overview = CGSize(width: 1011, height: 632)

    func testSmallRectIsNativeResolution() throws {
        let plan = try ZoomPolicy.plan(rect: CGRect(x: 100, y: 100, width: 300, height: 200), display: display,
                                       overviewSent: overview).get()
        XCTAssertEqual(plan.sentSize, CGSize(width: 600, height: 400), "within budget: native pixels")
        XCTAssertEqual(plan.magnification, 2 / (1011.0 / 1440), accuracy: 1e-9)
    }

    func testLargeRectIsScaledToTheBudgetAndStillMagnifies() throws {
        let plan = try ZoomPolicy.plan(rect: CGRect(x: 0, y: 0, width: 800, height: 600), display: display,
                                       overviewSent: overview).get()
        XCTAssertLessThanOrEqual(plan.sentSize.width * plan.sentSize.height, CGFloat(CaptureGeometry.defaultPixelBudget))
        XCTAssertGreaterThan(plan.magnification, 1)
    }

    func testWholeDisplayDoesNotMagnifyAndIsRefused() {
        guard case .failure(.notMagnifying(let m)) = ZoomPolicy.plan(rect: display.contentRect, display: display,
                                                                     overviewSent: overview) else { return XCTFail() }
        XCTAssertEqual(m, 1, accuracy: 0.01)
    }

    func testRectIsClippedToTheDisplayAndOutsideIsEmpty() throws {
        let plan = try ZoomPolicy.plan(rect: CGRect(x: 1300, y: 800, width: 400, height: 400), display: display,
                                       overviewSent: overview).get()
        XCTAssertEqual(plan.geometry.contentRect, CGRect(x: 1300, y: 800, width: 140, height: 100))
        XCTAssertEqual(ZoomPolicy.plan(rect: CGRect(x: 2000, y: 0, width: 50, height: 50), display: display,
                                       overviewSent: overview), .failure(.empty))
    }

    func testZoomPixelMapsBackToScreenPoints() throws {
        let plan = try ZoomPolicy.plan(rect: CGRect(x: 100, y: 100, width: 300, height: 200), display: display,
                                       overviewSent: overview).get()
        let z = ZoomStore().add(baseGen: 1, geometry: plan.geometry, sentSize: plan.sentSize)
        XCTAssertEqual(z.screenPoint(fromZoomPixel: CGPoint(x: 300, y: 200)), CGPoint(x: 250, y: 200))
    }

    func testStoreKeepsTheLastFew() {
        let s = ZoomStore()
        let first = s.add(baseGen: 1, geometry: display, sentSize: overview)
        for _ in 0..<ZoomStore.retained { _ = s.add(baseGen: 1, geometry: display, sentSize: overview) }
        XCTAssertNil(s.get(first.id))
    }
}

final class ZoomDispatchTests: XCTestCase {
    private let win = CGRect(x: 100, y: 100, width: 600, height: 400)

    /// A harness with the fixture's window on screen and a snapshot that has an overview image.
    private func setUp(_ h: Harness, also other: (app: String, rect: CGRect, id: UInt32)? = nil) throws -> Int {
        h.env.running = [fixture]
        h.env.windows = [FakeWindow(win, fixture, id: 5)]
        if let o = other {
            h.env.running.insert(o.app.lowercased())
            h.env.windows.insert(FakeWindow(o.rect, o.app, id: o.id), at: 0)   // in front
        }
        h.grant("t1", [fixture] + (other.map { [$0.app] } ?? []))
        var r = ObserveResult()
        r.desktop = CaptureGeometry(contentRect: CGRect(x: 0, y: 0, width: 1440, height: 900), pointPixelScale: 2)
        r.compositeSize = CGSize(width: 1011, height: 632)
        r.compositePNG = Data([1])
        h.env.observeResult = r
        return try h.snapshot()
    }

    private func zoomResult(lines: [ObservedElement] = []) -> ZoomResult {
        var z = ZoomResult()
        z.png = Data([2])
        z.lines = lines
        z.zOrder = [ZWindow(id: 5, app: fixture, frame: win, granted: true)]
        return z
    }

    func testZoomReturnsImageMappingAndTextAndAuditsNoText() throws {
        let h = Harness()
        let g = try setUp(h)
        h.env.zoomResult = zoomResult(lines: [ObservedElement(source: .ocr, app: nil, role: nil, text: "tiny secret",
                                                              frame: CGRect(x: 210, y: 210, width: 40, height: 8),
                                                              confidence: 0.7, windowID: 5)])
        let out = try h.call("zoom", ["task_id": "t1", "snapshot_gen": .number(Double(g)),
                                      "rect": ["x": 200, "y": 200, "w": 100, "h": 50, "space": "screen"]]).get()
        XCTAssertEqual(out["zoom_id"], "z1")
        XCTAssertEqual(out["image"]?["mapping"]?["sent_size_px"], [200, 100])
        guard case .array(let ocr)? = out["untrusted_observation"]?["ocr"] else { return XCTFail() }
        XCTAssertEqual(ocr.first?["text"], "tiny secret")
        XCTAssertEqual(h.env.zoomRequests.last?.windows, [5])
        XCTAssertEqual(h.lastAudit["ocr_lines"], 1)
        XCTAssertFalse(String(describing: h.audit.entries).contains("secret"))
    }

    func testImageRectIsMappedThroughTheOverview() throws {
        let h = Harness()
        let g = try setUp(h)
        h.env.zoomResult = zoomResult()
        _ = try h.call("zoom", ["task_id": "t1", "snapshot_gen": .number(Double(g)),
                                "rect": ["x": .number(1011.0 / 1440 * 200), "y": .number(632.0 / 900 * 200),
                                         "w": .number(1011.0 / 1440 * 100), "h": .number(632.0 / 900 * 50),
                                         "space": "image"]]).get()
        let rect = try XCTUnwrap(h.env.zoomRequests.last?.geometry.contentRect)
        XCTAssertEqual(rect.minX, 200, accuracy: 1e-6)
        XCTAssertEqual(rect.height, 50, accuracy: 1e-6)
    }

    func testRefusals() throws {
        let h = Harness()
        let g = Double(try setUp(h))
        func zoom(_ p: [String: JSONValue]) -> Result<JSONValue, RPCFailure> {
            h.call("zoom", .object(["task_id": "t1", "snapshot_gen": .number(g)].merging(p) { $1 }))
        }
        let rect: JSONValue = ["x": 200, "y": 200, "w": 100, "h": 50, "space": "screen"]
        assertDenied(zoom(["rect": ["x": 200, "y": 200, "w": 100, "h": 50]]), "undeclared_coordinate_space", in: h)
        assertDenied(zoom(["rect": ["x": 0, "y": 0, "w": 1440, "h": 900, "space": "screen"]]), "zoom_not_magnifying", in: h)
        assertDenied(zoom(["rect": ["x": 900, "y": 700, "w": 100, "h": 50, "space": "screen"]]), "not_on_granted_window", in: h)
        assertDenied(h.call("zoom", ["task_id": "t1", "rect": rect]), "snapshot_required", in: h)
        assertDenied(zoom(["snapshot_gen": 999, "rect": rect]), "stale_snapshot", in: h)

        h.env.windows[0].rect = win.offsetBy(dx: 10, dy: 0)   // moved since the snapshot
        assertDenied(zoom(["rect": rect]), "stale_coordinates", in: h)
        XCTAssertTrue(h.env.zoomRequests.isEmpty, "nothing is captured for a refused zoom")
    }

    func testWithOCROffAZoomRunsNoOCR() throws {
        let h = Harness()
        let g = try setUp(h)
        h.env.zoomResult = zoomResult()
        let rect: JSONValue = ["x": 200, "y": 200, "w": 100, "h": 50, "space": "screen"]
        assertAllowed(h.call("zoom", ["task_id": "t1", "snapshot_gen": .number(Double(g)), "rect": rect]), in: h)
        XCTAssertEqual(h.env.zoomRequests.last?.ocr, true)
        XCTAssertNil(h.lastAudit["ocr_off"])
        // VM round 17 (2026-10-17): with OCR switched off, a zoom still sent its OCR text.
        try XCTUnwrap(h.dispatcher).settingsSetPrivacy(PrivacySettings(sendOCR: false), verified: false)
        assertAllowed(h.call("zoom", ["task_id": "t1", "snapshot_gen": .number(Double(g)), "rect": rect]), in: h)
        XCTAssertEqual(h.env.zoomRequests.last?.ocr, false)
        XCTAssertEqual(h.lastAudit["ocr_off"], "settings")
    }

    func testATextOnlyAppIsNeverCapturedIntoAZoom() throws {
        let h = Harness()
        let g = try setUp(h, also: (textEdit, CGRect(x: 650, y: 150, width: 300, height: 200), 6))
        h.env.zoomResult = zoomResult()
        try XCTUnwrap(h.dispatcher).settingsSetPrivacy(PrivacySettings(textOnlyApps: [textEdit]), verified: false)
        // Over both windows: only the fixture's is captured; TextEdit is not a captured app (a block, like other apps).
        assertAllowed(h.call("zoom", ["task_id": "t1", "snapshot_gen": .number(Double(g)),
                                      "rect": ["x": 600, "y": 200, "w": 100, "h": 50, "space": "screen"]]), in: h)
        XCTAssertEqual(h.env.zoomRequests.last?.windows, [5])
        XCTAssertEqual(h.env.zoomRequests.last?.apps, [fixture])
        XCTAssertEqual(h.lastAudit["image_off_windows"], 1)
        // Over TextEdit only: refused, nothing captured.
        let n = h.env.zoomRequests.count
        assertDenied(h.call("zoom", ["task_id": "t1", "snapshot_gen": .number(Double(g)),
                                     "rect": ["x": 800, "y": 200, "w": 100, "h": 50, "space": "screen"]]), "zoom_off", in: h)
        XCTAssertEqual(h.env.zoomRequests.count, n)
    }

    func testAWindowThatAppearedInTheRectRefusesTheZoom() throws {
        let h = Harness()
        let g = try setUp(h)
        var z = zoomResult()
        z.zOrder.insert(ZWindow(id: 9, app: fixture, frame: CGRect(x: 180, y: 180, width: 200, height: 100), granted: true), at: 0)
        h.env.zoomResult = z
        assertDenied(h.call("zoom", ["task_id": "t1", "snapshot_gen": .number(Double(g)),
                                     "rect": ["x": 200, "y": 200, "w": 100, "h": 50, "space": "screen"]]),
                     "stale_coordinates", in: h)
    }

    func testClickInZoomSpaceLandsOnTheMappedScreenPoint() throws {
        let h = Harness()
        let g = try setUp(h)
        h.env.zoomResult = zoomResult()
        let out = try h.call("zoom", ["task_id": "t1", "snapshot_gen": .number(Double(g)),
                                      "rect": ["x": 200, "y": 200, "w": 100, "h": 50, "space": "screen"]]).get()
        let zid = try XCTUnwrap(out["zoom_id"])
        // Zoom is 200×100 px for 100×50 pt: pixel (50, 20) is (225, 210).
        assertAllowed(h.call("act.click", ["task_id": "t1", "app": .string(fixture), "snapshot_gen": .number(Double(g)),
                                           "point": ["x": 50, "y": 20, "space": "zoom", "zoom_id": zid]]), in: h)
        XCTAssertEqual(h.env.clicks.last?.0, CGPoint(x: 225, y: 210))

        assertDenied(h.call("act.click", ["task_id": "t1", "app": .string(fixture), "snapshot_gen": .number(Double(g)),
                                          "point": ["x": 50, "y": 20, "space": "zoom", "zoom_id": "z99"]]), "unknown_zoom", in: h)
        let g2 = try h.snapshot()
        assertDenied(h.call("act.click", ["task_id": "t1", "app": .string(fixture), "snapshot_gen": .number(Double(g2)),
                                          "point": ["x": 50, "y": 20, "space": "zoom", "zoom_id": zid]]),
                     "zoom_snapshot_mismatch", in: h)
    }
}

final class LaunchWaitTests: XCTestCase {
    func testObserveWaitsForAnAppThisDaemonJustLaunched() throws {
        let h = Harness()
        h.env.running.remove(fixture)   // the harness starts with it running
        h.grant("t1", [fixture], allowLaunch: true)
        assertAllowed(h.call("apps.launch", ["task_id": "t1", "bundle_id": .string(fixture)]), in: h)
        h.env.registersAfter = [fixture: h.env.runningQueries + 5]
        let t0 = h.clock
        _ = try h.call("observe", ["task_id": "t1", "ocr": "off"]).get()
        XCTAssertEqual(h.env.observeRequests.last?.apps, [fixture], "observed once it registered")
        // Registers on the 6th query: the first is before any sleep, then 5 sleeps of 0.1 s.
        XCTAssertEqual(h.clock.timeIntervalSince(t0), 0.5, accuracy: 0.05)
        XCTAssertEqual(h.lastAudit["launch_wait_ms"], 500)
    }

    func testNoWaitForAppsLaunchedElsewhereOrLongAgo() throws {
        let h = Harness()
        h.env.running.remove(fixture)   // the harness starts with it running
        h.grant("t1", [fixture], allowLaunch: true)
        let t0 = h.clock
        _ = try h.call("observe", ["task_id": "t1", "ocr": "off"]).get()   // not running, not launched by us
        XCTAssertEqual(h.clock, t0)

        assertAllowed(h.call("apps.launch", ["task_id": "t1", "bundle_id": .string(fixture)]), in: h)
        h.clock += Dispatcher.launchGrace + 1
        let t1 = h.clock
        _ = try h.call("observe", ["task_id": "t1", "ocr": "off"]).get()
        XCTAssertEqual(h.clock, t1, "past the grace period it is simply not running")
    }

    func testWaitIsBounded() throws {
        let h = Harness()
        h.env.running.remove(fixture)   // the harness starts with it running
        h.grant("t1", [fixture], allowLaunch: true)
        assertAllowed(h.call("apps.launch", ["task_id": "t1", "bundle_id": .string(fixture)]), in: h)
        let t0 = h.clock
        _ = try h.call("observe", ["task_id": "t1", "ocr": "off"]).get()   // never registers
        XCTAssertEqual(h.clock.timeIntervalSince(t0), Dispatcher.launchRegistrationTimeout, accuracy: 0.11)
        XCTAssertEqual(h.env.observeRequests.last?.apps, [])
    }
}
