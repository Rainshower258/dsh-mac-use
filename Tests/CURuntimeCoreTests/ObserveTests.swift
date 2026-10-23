import CoreGraphics
import XCTest
@testable import CURuntimeCore

final class CaptureGeometryTests: XCTestCase {
    /// Worked example: display 1470x956 pt @2x, sent at 1120x728 -> pt = img * (1470/1120).
    func testPlanExampleMapping() {
        let g = CaptureGeometry(contentRect: CGRect(x: 0, y: 0, width: 1470, height: 956), pointPixelScale: 2)
        XCTAssertEqual(g.nativeSizePx, CGSize(width: 2940, height: 1912))
        let sent = CGSize(width: 1120, height: 728)
        let p = g.screenPoint(fromSentPixel: CGPoint(x: 560, y: 364), sentSize: sent)
        XCTAssertEqual(p.x, 560 * 1470 / 1120, accuracy: 1e-9)
        XCTAssertEqual(p.y, 364 * 956.0 / 728, accuracy: 1e-9)
        XCTAssertEqual(g.mapping(sentSize: sent)["map"], "pt = origin + img * (1470/1120)")
        XCTAssertEqual(g.mapping(sentSize: sent)["point_pixel_scale"], 2)
    }

    func testNativePixelAndVisionBoxUseContentRectOrigin() {
        // A secondary display to the right: origin matters.
        let g = CaptureGeometry(contentRect: CGRect(x: 1440, y: 0, width: 1440, height: 900), pointPixelScale: 2)
        XCTAssertEqual(g.screenPoint(fromNativePixel: CGPoint(x: 200, y: 164)), CGPoint(x: 1540, y: 82))
        // Vision boxes are normalized with a bottom-left origin.
        let r = g.screenRect(fromVisionBox: CGRect(x: 0.5, y: 0.9, width: 0.25, height: 0.1))
        XCTAssertEqual(r, CGRect(x: 1440 + 720, y: 0, width: 360, height: 90))
    }

    /// Regression (2026-09-28): OCR boxes must land at the window's global position. A capture whose geometry
    /// is the window's global frame maps a box at the window's top-left corner to the window origin, not (0,0).
    func testPerWindowGeometryMapsVisionBoxesToGlobalWindowPosition() {
        let window = CGRect(x: 80, y: 80, width: 960, height: 712)
        let g = CaptureGeometry(contentRect: window, pointPixelScale: 2)
        XCTAssertEqual(g.nativeSizePx, CGSize(width: 1920, height: 1424))
        // "文件" button: window-relative (321, 594) size (29, 17) -> global (401, 674).
        let box = CGRect(x: 321 / 960.0, y: 1 - (594 + 17) / 712.0, width: 29 / 960.0, height: 17 / 712.0)
        let r = g.screenRect(fromVisionBox: box)
        XCTAssertEqual(r.minX, 401, accuracy: 1e-6)
        XCTAssertEqual(r.minY, 674, accuracy: 1e-6)
        XCTAssertEqual(r.width, 29, accuracy: 1e-6)
    }

    /// VM case: 1440x900 @2x = 2880x1800 native, ~2.85x per side under a 640k budget.
    func testSentSizeFitsBudgetDeterministically() {
        let native = CGSize(width: 2880, height: 1800)
        let s = CaptureGeometry.sentSize(native: native)
        XCTAssertLessThanOrEqual(s.width * s.height, CGFloat(CaptureGeometry.defaultPixelBudget))
        XCTAssertEqual(s, CGSize(width: 1011, height: 632))
        XCTAssertEqual(native.width / s.width, 2.85, accuracy: 0.01)
        XCTAssertEqual(CaptureGeometry.sentSize(native: native), s, "same input, same output")
        XCTAssertEqual(CaptureGeometry.sentSize(native: CGSize(width: 800, height: 600)), CGSize(width: 800, height: 600),
                       "never upscales")
    }

    /// 2026-10-17 host run: the whole 1710×1112 pt display was sent, mostly black, the Calculator ~100 px wide.
    func testTheOverviewCoversTheGrantedWindowsNotTheDisplay() {
        let display = CGRect(x: 0, y: 0, width: 1710, height: 1112)
        let calculator = CGRect(x: 911, y: 321, width: 230, height: 408), popover = CGRect(x: 951, y: 228, width: 328, height: 101)
        let g = CaptureGeometry.overview(display: display, windows: [calculator, popover], pointPixelScale: 2)
        XCTAssertEqual(g.contentRect, CGRect(x: 911, y: 228, width: 368, height: 501), "the bounding box of both windows")
        // The Calculator's width in the sent image: ~133 px from the whole display (992 px wide), ~428 px now.
        let before = 230 * CaptureGeometry.sentSize(native: CaptureGeometry(contentRect: display, pointPixelScale: 2).nativeSizePx).width / 1710
        let after = 230 * CaptureGeometry.sentSize(native: g.nativeSizePx).width / g.contentRect.width
        XCTAssertEqual(before, 133, accuracy: 1)
        XCTAssertGreaterThan(after / before, 3)
        // Its mapping and image-space points go through the box: image (0, 0) is the box's corner.
        XCTAssertEqual(g.screenPoint(fromSentPixel: .zero, sentSize: g.nativeSizePx), CGPoint(x: 911, y: 228))
        // Clipped to the display, in whole points; nothing granted on it: the display.
        let off = CaptureGeometry.overview(display: display, windows: [CGRect(x: 1600.4, y: -20, width: 300, height: 200.2)], pointPixelScale: 2)
        XCTAssertEqual(off.contentRect, CGRect(x: 1600, y: 0, width: 110, height: 181))
        XCTAssertEqual(CaptureGeometry.overview(display: display, windows: [], pointPixelScale: 2).contentRect, display)
        XCTAssertEqual(CaptureGeometry.overview(display: display, windows: [CGRect(x: 2000, y: 0, width: 50, height: 50)],
                                                pointPixelScale: 2).contentRect, display, "only off the display")
    }
}

final class ObserveDispatchTests: XCTestCase {
    private let qq = "com.tencent.qq"

    /// 2026-10-17, host: the Calculator wholly behind the browser dsh runs in; the image was one grey block.
    func testAGrantedWindowBehindAnotherAppsWindowIsReportedAsCovered() throws {
        let h = Harness()
        let win = CGRect(x: 100, y: 100, width: 800, height: 600)
        h.env.windows = [FakeWindow(CGRect(x: 0, y: 0, width: 1440, height: 900), "com.apple.Safari"), FakeWindow(win, fixture)]
        h.env.running.insert("com.apple.safari")
        h.grant()
        let out = try h.call("observe", ["task_id": "t1", "ocr": "off"]).get()
        guard case .array(let covered)? = out["covered"] else { return XCTFail("no covered list") }
        XCTAssertEqual(covered.count, 1)
        XCTAssertEqual(covered.first?["app"], .string(fixture))
        XCTAssertEqual(covered.first?["by"], ["com.apple.safari"])
        XCTAssertEqual(h.lastAudit["covered_windows"], 1)
        h.env.windows.reverse()   // the fixture in front: nothing covered
        guard case .array(let none)? = try h.call("observe", ["task_id": "t1", "ocr": "off"]).get()["covered"] else { return XCTFail() }
        XCTAssertTrue(none.isEmpty)
        XCTAssertNil(h.lastAudit["covered_windows"])
    }

    func testObservesOnlyGrantedRunningAppsAndAuditsCountsNotText() throws {
        let h = Harness()
        h.env.running.insert(qq)
        h.grant("t", [qq, "com.example.notrunning"])
        var r = ObserveResult()
        r.elements = [ObservedElement(source: .ax, app: qq, role: "AXStaticText", text: "secret chat line",
                                      frame: .zero, confidence: nil),
                      ObservedElement(source: .ocr, app: nil, role: nil, text: "another secret", frame: .zero, confidence: 0.9)]
        r.axStats = [AXStats(app: qq, nodes: 42, elapsedMs: 12, hitTimeBudget: false, hitNodeCap: false)]
        h.env.observeResult = r
        let out = try h.call("observe", ["task_id": "t", "ocr": "on"]).get()
        XCTAssertEqual(h.env.observeRequests.last?.apps, [qq])
        guard case .array(let els)? = out["untrusted_observation"]?["elements"] else { return XCTFail() }
        let withoutKeys = els.map { e -> JSONValue in
            guard case .object(var o) = e else { return e }
            XCTAssertEqual(o["key"]?.stringValue?.count, 12, "every element carries a 12-hex stable key")
            o["key"] = nil
            return .object(o)
        }
        XCTAssertEqual(withoutKeys, [
            ["id": "a1", "source": "ax", "app": .string(qq), "role": "AXStaticText", "text": "secret chat line",
             "frame_pt": [0, 0, 0, 0], "occluded": true],
            ["id": "o1", "source": "ocr", "text": "another secret", "frame_pt": [0, 0, 0, 0], "confidence": 0.9,
             "occluded": true],
        ])
        let e = h.lastAudit
        XCTAssertEqual(e["ax_nodes"], 42)
        XCTAssertEqual(e["ocr_lines"], 1)
        XCTAssertFalse(String(describing: h.audit.entries).contains("secret"), "element text must never be audited")
    }

    func testOCRUsesCacheIdsDropsTextAXAlreadyHasAndReportsStats() throws {
        let h = Harness()
        h.env.running.insert(qq)
        h.grant("t", [qq])
        let button = CGRect(x: 100, y: 48, width: 100, height: 22)
        var r = ObserveResult()
        r.zOrder = [ZWindow(id: 5, app: qq, frame: CGRect(x: 0, y: 0, width: 800, height: 600), granted: true)]
        var dup = ObservedElement(source: .ocr, app: nil, role: nil, text: "Send message",
                                  frame: CGRect(x: 102, y: 51, width: 90, height: 16), confidence: 0.9, windowID: 5)
        dup.ocrID = "o7"
        var only = ObservedElement(source: .ocr, app: nil, role: nil, text: "Unread: 3",
                                   frame: CGRect(x: 300, y: 300, width: 80, height: 16), confidence: 0.8, windowID: 5)
        only.ocrID = "o12"
        r.elements = [ObservedElement(source: .ax, app: qq, role: "AXButton", text: "Send message", frame: button, confidence: nil),
                      dup, only]
        var stats = OCRStats()
        stats.windows = 1; stats.bandWindows = 1; stats.bands = 2; stats.recognizedAreaFraction = 0.1234
        r.ocrStats = stats
        h.env.observeResult = r
        let out = try h.call("observe", ["task_id": "t", "ocr": "on"]).get()
        guard case .array(let els)? = out["untrusted_observation"]?["elements"] else { return XCTFail() }
        XCTAssertEqual(els.map { $0["id"] }, ["a1", "o12"], "the OCR duplicate of the AX button is dropped; ids come from the cache")
        let ocr = out["capture"]?["ocr"]
        XCTAssertEqual(ocr?["bands"], 2)
        XCTAssertEqual(ocr?["recognized_area_fraction"], 0.123)
        XCTAssertEqual(ocr?["deduped_against_ax"], 1)
        XCTAssertEqual(h.lastAudit["ocr_deduped"], 1)

        // The cache id is what an action names; it resolves in this snapshot.
        let g = out["snapshot_gen"]!
        guard case .failure(let f) = h.call("act.click", ["task_id": "t", "app": .string(qq), "element_id": "o7",
                                                          "snapshot_gen": g]) else { return XCTFail() }
        XCTAssertEqual(f.data?["reason"], "unknown_element", "a dropped duplicate is not addressable")
    }

    func testOCRAutoIsRefusedUntilItHasAThreshold() {
        let h = Harness()
        h.grant()
        guard case .failure(let f) = h.call("observe", ["task_id": "t1", "ocr": "auto"]) else { return XCTFail() }
        XCTAssertEqual(f.code, .invalidParams)
    }

    func testManualAccessibilityIsOffUnlessTheGrantAsks() throws {
        let h = Harness()
        h.env.running.insert(qq)
        h.grant("t", [qq])
        _ = try h.call("observe", ["task_id": "t", "ocr": "off"]).get()
        XCTAssertTrue(h.env.manualAXCalls.isEmpty)
    }

    func testManualAccessibilityIsAuditedAndTurnedBackOff() throws {
        let h = Harness()
        h.env.running.insert(qq)
        func grant(_ on: Bool) {
            h.call("grants.set", ["task_id": "t", "bundle_ids": .array([.string(qq)]), "source": "config",
                                  "electron_ax": .bool(on)])
        }
        grant(true)
        XCTAssertTrue(h.env.manualAXCalls.isEmpty, "applied lazily, only when the app is observed")
        _ = try h.call("observe", ["task_id": "t", "ocr": "off"]).get()
        _ = try h.call("observe", ["task_id": "t", "ocr": "off"]).get()
        XCTAssertEqual(h.env.manualAXCalls.map(\.1), [true], "set once, not on every observe")
        let on = h.audit.entries.first { $0["method"] == "ax.manual_accessibility" }
        XCTAssertEqual(on?["value"], true)
        XCTAssertEqual(on?["app"], .string(qq))

        grant(false)  // the task no longer wants it
        XCTAssertEqual(h.env.manualAXCalls.map(\.1), [true, false])
        XCTAssertEqual(h.audit.entries.last { $0["method"] == "ax.manual_accessibility" }?["value"], false)

        grant(true)
        _ = try h.call("observe", ["task_id": "t", "ocr": "off"]).get()
        h.call("grants.revoke", ["task_id": "t"])  // revoked
        XCTAssertEqual(h.env.manualAXCalls.map(\.1), [true, false, true, false])

        h.call("grants.set", ["task_id": "t", "bundle_ids": .array([.string(qq)]), "source": "config",
                              "electron_ax": true, "expires_in_s": 60])
        _ = try h.call("observe", ["task_id": "t", "ocr": "off"]).get()
        h.clock += 61  // expired: the next request of any kind turns it off
        h.call("runtime.ping")
        XCTAssertEqual(h.env.manualAXCalls.last?.1, false)
    }

    /// 2026-10-09: a minimized QQ cost 8 s per observe (5 s AX settle, 2.5 s window wait) for nothing. An app without
    /// a window to show is said at once (`app_states`), not waited for and not switched to electron_ax; once its
    /// window is back (or it was just launched by the daemon) everything happens as before.
    func testAppsWithoutAWindowAreSaidAtOnceNotWaitedFor() throws {
        let h = Harness()
        h.env.running.insert(qq)
        h.env.running.remove(textEdit.lowercased())
        h.env.presence[qq] = .minimized
        h.call("grants.set", ["task_id": "t", "bundle_ids": .array([.string(qq), .string(textEdit)]), "source": "config",
                              "electron_ax": true])
        let out = try h.call("observe", ["task_id": "t", "ocr": "off"]).get()
        XCTAssertEqual(out["app_states"], ["com.tencent.qq": "minimized", "com.apple.textedit": "not_running"])
        XCTAssertEqual(h.audit.entries.last { $0["method"] == "observe" }?["app_states"], out["app_states"])
        XCTAssertEqual(h.env.observeRequests.last?.waitFor, [], "nothing to wait for")
        XCTAssertTrue(h.env.manualAXCalls.isEmpty, "no tree to wait for")

        h.env.presence[qq] = nil  // restored: visible
        let back = try h.call("observe", ["task_id": "t", "ocr": "off"]).get()
        XCTAssertEqual(back["app_states"], ["com.apple.textedit": "not_running"])
        XCTAssertEqual(h.env.observeRequests.last?.waitFor, [qq])
        XCTAssertEqual(h.env.manualAXCalls.map(\.1), [true])

        h.env.presence[qq] = .noWindows
        h.call("grants.set", ["task_id": "t", "bundle_ids": .array([.string(qq)]), "source": "config",
                              "allow_launch": true])
        _ = try h.call("apps.launch", ["task_id": "t", "app": .string(qq)]).get()
        _ = try h.call("observe", ["task_id": "t", "ocr": "off"]).get()
        XCTAssertEqual(h.env.observeRequests.last?.waitFor, [qq], "just launched: its window is worth the wait")
    }

    /// A native app refuses AXManualAccessibility; it was tried (and audited) on every observe (2026-10-09). Now once
    /// per launch: a new pid set tries again.
    func testARefusedManualAccessibilityIsNotRetriedUntilARelaunch() throws {
        let h = Harness()
        h.env.running.insert(qq)
        h.env.manualAXRefuses = [qq]
        h.call("grants.set", ["task_id": "t", "bundle_ids": .array([.string(qq)]), "source": "config", "electron_ax": true])
        for _ in 0..<3 { _ = try h.call("observe", ["task_id": "t", "ocr": "off"]).get() }
        XCTAssertEqual(h.env.manualAXCalls.count, 1)
        h.env.pids[qq] = [4242]  // relaunched
        _ = try h.call("observe", ["task_id": "t", "ocr": "off"]).get()
        XCTAssertEqual(h.env.manualAXCalls.count, 2)
    }

    func testElementKeysAreStableAndChangeWithTheElement() {
        let fp = Fingerprint.of(role: "AXButton", identifier: "send", text: "Send", frame: CGRect(x: 10, y: 10, width: 40, height: 20))
        let k = Fingerprint.key(source: .ax, windowID: 5, fingerprint: fp)
        XCTAssertEqual(k, Fingerprint.key(source: .ax, windowID: 5, fingerprint: fp))
        XCTAssertEqual(k.count, 12)
        XCTAssertNotEqual(k, Fingerprint.key(source: .ax, windowID: 6, fingerprint: fp))
        XCTAssertNotEqual(k, Fingerprint.key(source: .ocr, windowID: 5, fingerprint: fp))
        let moved = Fingerprint.of(role: "AXButton", identifier: "send", text: "Send", frame: CGRect(x: 30, y: 10, width: 40, height: 20))
        XCTAssertNotEqual(k, Fingerprint.key(source: .ax, windowID: 5, fingerprint: moved))
    }
}
