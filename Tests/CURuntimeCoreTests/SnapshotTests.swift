import CoreGraphics
import XCTest
@testable import CURuntimeCore

final class CompositeTests: XCTestCase {
    private let display = CGRect(x: 0, y: 0, width: 1440, height: 900)

    func testBackToFrontBlocksOnlyInFrontOfGrantedWindows() {
        let z = [
            ZWindow(id: 1, app: nil, frame: CGRect(x: 0, y: 0, width: 1440, height: 24), granted: false),     // menu bar
            ZWindow(id: 2, app: "com.other", frame: CGRect(x: 100, y: 100, width: 200, height: 200), granted: false),
            ZWindow(id: 3, app: "dev.fx", frame: CGRect(x: 50, y: 50, width: 800, height: 600), granted: true),
            ZWindow(id: 4, app: "com.behind", frame: CGRect(x: 0, y: 0, width: 1440, height: 900), granted: false),
        ]
        XCTAssertEqual(Composite.plan(display: display, zOrder: z, captured: [3]), [
            .window(id: 3, frame: CGRect(x: 50, y: 50, width: 800, height: 600)),
            .block(frame: CGRect(x: 100, y: 100, width: 200, height: 200)),
            .block(frame: CGRect(x: 0, y: 0, width: 1440, height: 24)),
        ], "window 4 is behind every granted window, so it is not drawn at all")
    }

    func testOffScreenPartsAreClippedAndUncapturedGrantedWindowsSkipped() {
        let z = [
            ZWindow(id: 5, app: "com.other", frame: CGRect(x: 1300, y: 800, width: 400, height: 300), granted: false),
            ZWindow(id: 6, app: "dev.fx", frame: CGRect(x: 1200, y: 700, width: 600, height: 400), granted: true),
            ZWindow(id: 7, app: "dev.fx", frame: CGRect(x: 0, y: 0, width: 100, height: 100), granted: true),
        ]
        XCTAssertEqual(Composite.plan(display: display, zOrder: z, captured: [6]), [
            .window(id: 6, frame: CGRect(x: 1200, y: 700, width: 600, height: 400)),
            .block(frame: CGRect(x: 1300, y: 800, width: 140, height: 100)),
        ])
    }

    func testCoverageCountsOnlyOtherAppsWindowsOverAGrantedOne() {
        let display = CGRect(x: 0, y: 0, width: 1710, height: 1112)
        let calc = ZWindow(id: 1, app: "com.apple.calculator", frame: CGRect(x: 911, y: 321, width: 230, height: 408), granted: true)
        let safari = ZWindow(id: 2, app: "com.apple.safari", frame: CGRect(x: 0, y: 0, width: 1710, height: 1112), granted: false)
        let sheet = ZWindow(id: 3, app: "com.apple.calculator", frame: CGRect(x: 911, y: 321, width: 230, height: 408), granted: true)
        let full = Composite.coverage(zOrder: [safari, calc], display: display)
        XCTAssertEqual(full.map(\.fraction), [1])
        XCTAssertEqual(full.first?.by, ["com.apple.safari"])
        XCTAssertEqual(Composite.coverage(zOrder: [calc, safari], display: display).map(\.fraction), [0], "in front: nothing over it")
        XCTAssertEqual(Composite.coverage(zOrder: [sheet, calc], display: display).map(\.fraction), [0, 0], "its own sheet is content")
        let half = ZWindow(id: 4, app: "com.apple.safari", frame: CGRect(x: 911, y: 321, width: 115, height: 408), granted: false)
        XCTAssertEqual(Composite.coverage(zOrder: [half, calc], display: display).first?.fraction ?? 0, 0.5, accuracy: 0.01)
        XCTAssertTrue(Composite.coverage(zOrder: [ZWindow(id: 5, app: "x", frame: CGRect(x: 3000, y: 0, width: 10, height: 10), granted: true)],
                                         display: display).isEmpty, "off the display")
    }

    func testOcclusion() {
        let z = [
            ZWindow(id: 2, app: "com.other", frame: CGRect(x: 100, y: 100, width: 100, height: 100), granted: false),
            ZWindow(id: 3, app: "dev.fx", frame: CGRect(x: 0, y: 0, width: 800, height: 600), granted: true),
        ]
        func ax(_ x: CGFloat, _ y: CGFloat) -> ObservedElement {
            ObservedElement(source: .ax, app: "dev.fx", role: nil, text: "t", frame: CGRect(x: x, y: y, width: 10, height: 10), confidence: nil)
        }
        func ocr(_ x: CGFloat, _ y: CGFloat, _ w: UInt32?) -> ObservedElement {
            ObservedElement(source: .ocr, app: nil, role: nil, text: "t", frame: CGRect(x: x, y: y, width: 10, height: 10),
                            confidence: 1, windowID: w)
        }
        XCTAssertTrue(Composite.isOccluded(ax(140, 140), zOrder: z))
        XCTAssertFalse(Composite.isOccluded(ax(400, 400), zOrder: z))
        XCTAssertTrue(Composite.isOccluded(ax(900, 700), zOrder: z), "off every window")
        XCTAssertTrue(Composite.isOccluded(ocr(140, 140, 3), zOrder: z))
        XCTAssertFalse(Composite.isOccluded(ocr(400, 400, 3), zOrder: z))
        XCTAssertTrue(Composite.isOccluded(ocr(400, 400, nil), zOrder: z), "unknown source window")
    }

    func testSameAppWindowOccludesAnAXElementOfAnotherWindow() {
        let z = [
            ZWindow(id: 20, app: "dev.fx", frame: CGRect(x: 500, y: 300, width: 360, height: 200), granted: true),   // sheet
            ZWindow(id: 10, app: "dev.fx", frame: CGRect(x: 300, y: 150, width: 800, height: 532), granted: true),   // parent
        ]
        let underSheet = ObservedElement(source: .ax, app: "dev.fx", role: nil, text: "t", frame: CGRect(x: 690, y: 400, width: 20, height: 20),
                                         confidence: nil, windowID: 10)
        XCTAssertTrue(Composite.isOccluded(underSheet, zOrder: z))
        let onSheet = ObservedElement(source: .ax, app: "dev.fx", role: nil, text: "t", frame: CGRect(x: 690, y: 400, width: 20, height: 20),
                                      confidence: nil, windowID: 20)
        XCTAssertFalse(Composite.isOccluded(onSheet, zOrder: z))
    }

    func testDisplayPolicy() {
        let main = CGRect(x: 0, y: 0, width: 1440, height: 900)
        XCTAssertNil(DisplayPolicy.unsupportedReason(windowFrame: CGRect(x: 1200, y: 100, width: 400, height: 300), mainDisplay: main, displayCount: 2),
                     "centre still on the main display: partially off-screen is fine")
        XCTAssertEqual(DisplayPolicy.unsupportedReason(windowFrame: CGRect(x: 1600, y: 100, width: 400, height: 300), mainDisplay: main, displayCount: 2),
                       "multi_display")
        XCTAssertEqual(DisplayPolicy.unsupportedReason(windowFrame: CGRect(x: -900, y: 100, width: 400, height: 300), mainDisplay: main, displayCount: 1),
                       "off_screen")
    }

    func testFingerprintAbsorbsJitterButNotMoves() {
        let a = Fingerprint.of(role: "AXButton", identifier: "m1", text: "M1", frame: CGRect(x: 100, y: 100, width: 40, height: 20))
        XCTAssertEqual(a, Fingerprint.of(role: "AXButton", identifier: "m1", text: "M1", frame: CGRect(x: 100.4, y: 99.6, width: 40, height: 20)))
        XCTAssertNotEqual(a, Fingerprint.of(role: "AXButton", identifier: "m1", text: "M1", frame: CGRect(x: 150, y: 100, width: 40, height: 20)))
        XCTAssertNotEqual(a, Fingerprint.of(role: "AXButton", identifier: "m2", text: "M1", frame: CGRect(x: 100, y: 100, width: 40, height: 20)))
    }
}

/// Element and coordinate targets are only valid against the snapshot they came from.
final class SnapshotTargetTests: XCTestCase {
    private func harness() -> Harness {
        let h = Harness()
        h.autoSnapshot = false
        h.grant()
        return h
    }

    private func click(_ h: Harness, _ extra: [String: JSONValue]) -> Result<JSONValue, RPCFailure> {
        var p: [String: JSONValue] = ["task_id": "t1", "app": .string(fixture)]
        for (k, v) in extra { p[k] = v }
        return h.call("act.click", .object(p))
    }

    func testTargetsNeedASnapshotAndOnlyRetainedOnesCount() throws {
        let h = harness()
        assertDenied(click(h, ["point": screen(200, 200)]), "snapshot_required", in: h)
        let first = try h.snapshot()
        for _ in 0..<SnapshotStore.retained { _ = try h.snapshot() }
        assertDenied(click(h, ["point": screen(200, 200), "snapshot_gen": .number(Double(first))]), "stale_snapshot", in: h)
        XCTAssertTrue(h.env.activations.isEmpty && h.env.clicks.isEmpty)
    }

    func testMovedWindowMakesCoordinatesStale() throws {
        let h = harness()
        let g = try h.snapshot()
        h.env.windows[0].rect = h.env.windows[0].rect.offsetBy(dx: 50, dy: 0)
        assertDenied(click(h, ["point": screen(200, 200), "snapshot_gen": .number(Double(g))]), "stale_coordinates", in: h)
        XCTAssertTrue(h.env.clicks.isEmpty)
        let g2 = try h.snapshot()
        assertAllowed(click(h, ["point": screen(200, 200), "snapshot_gen": .number(Double(g2))]), in: h)
    }

    func testOccluderAppearingAfterTheSnapshotIsCaughtByTheHitTest() throws {
        let h = harness()
        let g = try h.snapshot()
        h.env.windows.insert(FakeWindow(CGRect(x: 150, y: 150, width: 100, height: 100), textEdit.lowercased()), at: 0)
        assertDenied(click(h, ["point": screen(200, 200), "snapshot_gen": .number(Double(g))]), "hit_test_failed", in: h)
        XCTAssertTrue(h.env.clicks.isEmpty)
    }

    private func axElementSnapshot(_ h: Harness, frame: CGRect) throws -> Int {
        var r = ObserveResult()
        r.elements = [ObservedElement(source: .ax, app: fixture, role: "AXButton", text: "M1", frame: frame, confidence: nil,
                                      identifier: "m1", handle: 7)]
        h.env.observeResult = r
        h.env.elementNow[7] = (Fingerprint.of(role: "AXButton", identifier: "m1", text: "M1", frame: frame), frame)
        return try h.snapshot()
    }

    func testElementClickUsesTheReReadCentre() throws {
        let h = harness()
        let g = try axElementSnapshot(h, frame: CGRect(x: 300, y: 300, width: 40, height: 20))
        assertAllowed(click(h, ["element_id": "a1", "snapshot_gen": .number(Double(g)), "via": "event"]), in: h)
        XCTAssertEqual(h.env.clicks.first?.0, CGPoint(x: 320, y: 310))
    }

    func testChangedOrVanishedElementIsStale() throws {
        let h = harness()
        let frame = CGRect(x: 300, y: 300, width: 40, height: 20)
        let g = try axElementSnapshot(h, frame: frame)
        let moved = frame.offsetBy(dx: 50, dy: 0)
        h.env.elementNow[7] = (Fingerprint.of(role: "AXButton", identifier: "m1", text: "M1", frame: moved), moved)
        assertDenied(click(h, ["element_id": "a1", "snapshot_gen": .number(Double(g))]), "stale_element", in: h)
        h.env.elementNow[7] = nil
        assertDenied(click(h, ["element_id": "a1", "snapshot_gen": .number(Double(g))]), "stale_element", in: h)
        XCTAssertTrue(h.env.clicks.isEmpty)
    }

    func testOCRElementIsStaleOnceItsWindowMoved() throws {
        let h = harness()
        var r = ObserveResult()
        r.elements = [ObservedElement(source: .ocr, app: nil, role: nil, text: "hi", frame: CGRect(x: 300, y: 300, width: 40, height: 20),
                                      confidence: 1, windowID: h.env.windows[0].id)]
        h.env.observeResult = r
        let g = try h.snapshot()
        h.env.windows[0].rect = h.env.windows[0].rect.offsetBy(dx: 0, dy: 50)
        assertDenied(click(h, ["element_id": "o1", "snapshot_gen": .number(Double(g))]), "stale_element", in: h)
    }

    func testElementOfAnotherAppIsRefused() throws {
        let h = harness()
        var r = ObserveResult()
        r.elements = [ObservedElement(source: .ax, app: "com.other", role: "AXButton", text: "x",
                                      frame: CGRect(x: 1, y: 1, width: 1, height: 1), confidence: nil, handle: 9)]
        h.env.observeResult = r
        let g = try h.snapshot()
        assertDenied(click(h, ["element_id": "a1", "snapshot_gen": .number(Double(g))]), "element_not_in_app", in: h)
    }

    func testImageSpaceMapsThroughTheSnapshotComposite() throws {
        let h = harness()
        var r = ObserveResult()
        r.desktop = CaptureGeometry(contentRect: CGRect(x: 0, y: 0, width: 1440, height: 900), pointPixelScale: 2)
        r.compositeSize = CGSize(width: 720, height: 450)  // half scale: pt = img * 2
        h.env.observeResult = r
        let g = try h.snapshot()
        assertAllowed(click(h, ["point": ["x": 100, "y": 100, "space": "image"], "snapshot_gen": .number(Double(g))]), in: h)
        XCTAssertEqual(h.env.clicks.first?.0, CGPoint(x: 200, y: 200))
    }

    func testElementCoveredByAnotherWindowOfTheSameAppIsRefused() throws {
        let h = harness()
        let parent = h.env.windows[0].id
        var r = ObserveResult()
        let frame = CGRect(x: 300, y: 300, width: 40, height: 20)
        r.elements = [ObservedElement(source: .ax, app: fixture, role: "AXButton", text: "M1", frame: frame, confidence: nil,
                                      identifier: "m1", windowID: parent, handle: 7)]
        h.env.observeResult = r
        h.env.elementNow[7] = (Fingerprint.of(role: "AXButton", identifier: "m1", text: "M1", frame: frame), frame)
        let g = try h.snapshot()
        h.env.windows.insert(FakeWindow(CGRect(x: 250, y: 250, width: 200, height: 200), fixture), at: 0)   // a sheet opens
        // Real events only: AXPress acts on the element itself and is not affected by what covers it (PLAN-v2 §6).
        assertDenied(click(h, ["element_id": "a1", "snapshot_gen": .number(Double(g)), "via": "event"]), "hit_test_failed", in: h)
        XCTAssertTrue(h.env.clicks.isEmpty)
    }

    func testClickIsRefusedWhenItsWindowCannotBeFocused() throws {
        let h = harness()
        let g = try h.snapshot()
        h.env.focusFails = true
        assertDenied(click(h, ["point": screen(200, 200), "snapshot_gen": .number(Double(g))]), "window_focus_failed", in: h)
        XCTAssertTrue(h.env.clicks.isEmpty)
        h.env.focusFails = false
        assertAllowed(click(h, ["point": screen(200, 200), "snapshot_gen": .number(Double(g))]), in: h)
        XCTAssertEqual(h.env.focused.last, CGPoint(x: 200, y: 200))
    }

    /// Found by the geometry suite (1x, oversized window): focusing made macOS move the window, and the click
    /// went to the old coordinates. The point must be re-validated after focusing.
    func testWindowMovedByFocusingRefusesTheClick() throws {
        let h = harness()
        let g = try h.snapshot()
        h.env.moveOnFocus = -30
        assertDenied(click(h, ["point": screen(200, 200), "snapshot_gen": .number(Double(g))]), "stale_coordinates", in: h)
        XCTAssertTrue(h.env.clicks.isEmpty)
    }

    func testClickWaitsForTheWindowToHoldStillAfterFocusing() throws {
        let h = harness()
        let g = try h.snapshot()
        let t0 = h.clock
        assertAllowed(click(h, ["point": screen(200, 200), "snapshot_gen": .number(Double(g))]), in: h)
        XCTAssertGreaterThanOrEqual(h.clock.timeIntervalSince(t0), 0.15, "three 50 ms stability samples (injected time)")
        XCTAssertEqual(h.lastAudit["window_changed_after_click"], nil)
    }

    func testRightAndMiddleClicksAreRealEventsAfterEveryCheck() throws {
        let h = harness()
        let g = try h.snapshot()
        assertAllowed(click(h, ["point": screen(200, 200), "button": "right", "snapshot_gen": .number(Double(g))]), in: h)
        assertAllowed(click(h, ["point": screen(200, 200), "button": "middle", "snapshot_gen": .number(Double(g))]), in: h)
        XCTAssertEqual(h.env.clickButtons, [.right, .middle])
        XCTAssertEqual(h.env.activations.count, 2)
    }

    func testDebugNativeImageOnlyWithConfig() throws {
        let off = harness()
        _ = try off.call("observe", ["task_id": "t1", "debug_native_image": true]).get()
        XCTAssertEqual(off.env.observeRequests.last?.debugNativeImage, false)
        XCTAssertNil(off.lastAudit["debug_native_image"])
        let on = Harness(config: PolicyConfig(debugNativeImages: true, configGrants: true))
        on.grant()
        _ = try on.call("observe", ["task_id": "t1", "debug_native_image": true]).get()
        XCTAssertEqual(on.env.observeRequests.last?.debugNativeImage, true)
        XCTAssertEqual(on.lastAudit["debug_native_image"], true)
    }
}

final class OverlayTests: XCTestCase {
    func testDockFullScreenWindowBecomesJustTheDockBar() {
        let display = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let raw = [
            OverlayPolicy.RawWindow(id: 4, app: nil, pid: 90, layer: 24, frame: CGRect(x: 0, y: 0, width: 1440, height: 30)),  // menu bar
            OverlayPolicy.RawWindow(id: 5, app: "com.apple.dock", pid: 91, layer: 20, frame: display),
            OverlayPolicy.RawWindow(id: 6, app: "dev.fx", pid: 92, layer: 0, frame: CGRect(x: 80, y: 80, width: 960, height: 712)),
        ]
        let dockBar = CGRect(x: 400, y: 830, width: 640, height: 70)
        let z = OverlayPolicy.expand(raw, display: display, granted: ["dev.fx"], partsOf: { $0 == 91 ? [dockBar, display] : [] })
        XCTAssertEqual(z.map(\.frame), [raw[0].frame, dockBar, raw[2].frame])
        XCTAssertEqual(z.map(\.granted), [false, false, true])
        let inWindow = ObservedElement(source: .ax, app: "dev.fx", role: nil, text: "t", frame: CGRect(x: 500, y: 400, width: 10, height: 10), confidence: nil)
        XCTAssertFalse(Composite.isOccluded(inWindow, zOrder: z), "the Dock's transparent area must not occlude")
        let underDock = ObservedElement(source: .ax, app: "dev.fx", role: nil, text: "t", frame: CGRect(x: 500, y: 840, width: 10, height: 10), confidence: nil)
        XCTAssertTrue(Composite.isOccluded(underDock, zOrder: z), "under the Dock bar it is occluded")
        XCTAssertEqual(Composite.topmost(at: CGPoint(x: 500, y: 850), in: z)?.app, "com.apple.dock")
    }

    func testAnOverlaysPartsThatAreItsAppsOtherWindowsKeepThoseWindowsPlace() {
        // VM 2026-10-10 (sysui-dock-left): Notification Center's full-display banner window (layer 21) came and went;
        // its app's top-level AX elements include the desktop widgets, which are its own desktop-level windows.
        // Expanded as overlay parts they were drawn above the fixture (a 360 pt grey block nobody could see).
        let display = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let widgets = [CGRect(x: 8, y: 38, width: 180, height: 180), CGRect(x: 188, y: 38, width: 180, height: 180),
                       CGRect(x: 8, y: 218, width: 360, height: 180)]
        let banner = CGRect(x: 1080, y: 38, width: 352, height: 80)
        let raw = [OverlayPolicy.RawWindow(id: 12, app: "com.apple.notificationcenterui", pid: 60, layer: 21, frame: display),
                   OverlayPolicy.RawWindow(id: 20, app: "dev.fx", pid: 92, layer: 0, frame: CGRect(x: 53, y: 250, width: 700, height: 482))]
            + widgets.enumerated().map { OverlayPolicy.RawWindow(id: UInt32(13 + $0.offset), app: "com.apple.notificationcenterui", pid: 60,
                                                                 layer: -2_147_483_601, frame: $0.element) }
        let z = OverlayPolicy.expand(raw, display: display, granted: ["dev.fx"], partsOf: { $0 == 60 ? widgets + [banner] : [] })
        XCTAssertEqual(Composite.topmost(at: CGPoint(x: 93, y: 322), in: z)?.app, "dev.fx",
                       "a desktop widget stays below the window that covers it")
        XCTAssertEqual(Composite.topmost(at: CGPoint(x: 1200, y: 60), in: z)?.app, "com.apple.notificationcenterui",
                       "a part that is no other window (the banner) still covers")
        XCTAssertEqual(z.filter { $0.app == "com.apple.notificationcenterui" }.map(\.frame), [banner] + widgets)
    }

    func testAnInterceptionInsideAFullDisplayOverlayRemembersTheBannerNotTheScreen() {
        // VM 2026-10-10 (notification-banner): first the whole screen, then the banner's half-screen container
        // (AXScrollArea 688,0 752x801) was remembered, and the clear marker was flagged too. Chain from the VM.
        let display = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let p = CGPoint(x: 1396, y: 102)
        let banner = CGRect(x: 1080, y: 46, width: 344, height: 57)
        let ncWindows: [(layer: Int, frame: CGRect)] = [(21, display), (-2_147_483_601, CGRect(x: 8, y: 38, width: 180, height: 180))]
        let container = CGRect(x: 688, y: 0, width: 752, height: 801)
        let label = CGRect(x: 1380, y: 90, width: 40, height: 20)
        func region(_ chain: [(frame: CGRect, subrole: String?)]) -> CGRect? {
            OverlayPolicy.interceptionRegion(windows: ncWindows, point: p, display: display, axAncestors: chain)
        }
        XCTAssertEqual(region([(label, nil), (banner, "AXNotificationCenterAlert"), (container, nil), (display, nil)]), banner,
                       "inside a notification: the banner, not its container")
        XCTAssertEqual(region([(banner, "AXNotificationCenterBanner"), (container, nil)]), banner)
        XCTAssertEqual(region([(label, nil), (container, nil), (display, nil)]), label,
                       "unknown structure: the hit element itself, never a larger ancestor")
        XCTAssertNil(region([(display, nil)]), "nothing smaller than the screen: the caller falls back to the hit element")
        // The invisible blocker of occlusion-invisible: its own window, as before.
        let blocker = CGRect(x: 500, y: 120, width: 520, height: 632)
        XCTAssertEqual(OverlayPolicy.interceptionRegion(windows: [(3, blocker)], point: CGPoint(x: 550, y: 222), display: display,
                                                        axAncestors: [(display, nil)]), blocker)
        // A normal-layer window as large as the display is a real window, not an overlay.
        XCTAssertEqual(OverlayPolicy.interceptionRegion(windows: [(0, display)], point: p, display: display,
                                                        axAncestors: [(banner, "AXNotificationCenterAlert")]), display)
    }

    func testUnknownOverlayPartsCoverTheWholeOverlaySoDecisionsRefuse() {
        let display = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let raw = [
            OverlayPolicy.RawWindow(id: 5, app: "com.apple.dock", pid: 91, layer: 20, frame: display),
            OverlayPolicy.RawWindow(id: 6, app: "dev.fx", pid: 92, layer: 0, frame: CGRect(x: 80, y: 80, width: 960, height: 712)),
        ]
        let z = OverlayPolicy.expand(raw, display: display, granted: ["dev.fx"], partsOf: { _ in nil })
        XCTAssertEqual(Composite.topmost(at: CGPoint(x: 500, y: 400), in: z)?.app, "com.apple.dock",
                       "the Dock's parts could not be read: every point counts as covered, so a click there is refused")
    }

    func testThePointerWindowIsNotPartOfTheZOrder() {
        let display = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let raw = [
            OverlayPolicy.RawWindow(id: 3, app: nil, pid: 205, layer: OverlayPolicy.cursorLayer, frame: CGRect(x: 545, y: 437, width: 20, height: 24),
                                    ownerName: "Window Server"),
            OverlayPolicy.RawWindow(id: 6, app: "dev.fx", pid: 92, layer: 0, frame: CGRect(x: 80, y: 80, width: 960, height: 712)),
        ]
        let z = OverlayPolicy.expand(raw, display: display, granted: ["dev.fx"], partsOf: { _ in [] })
        XCTAssertEqual(Composite.topmost(at: CGPoint(x: 550, y: 442), in: z)?.app, "dev.fx",
                       "the pointer must not cover the point it rests on")
    }

    func testAnAppWindowAtTheCursorLevelStillCovers() {
        let display = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let fx = OverlayPolicy.RawWindow(id: 6, app: "dev.fx", pid: 92, layer: 0, frame: CGRect(x: 80, y: 80, width: 960, height: 712))
        let cover = CGRect(x: 500, y: 400, width: 200, height: 100)
        for (app, owner) in [("com.evil.overlay", "Evil"), (nil, "Evil"), ("com.evil.overlay", "Window Server")] as [(String?, String)] {
            let raw = [OverlayPolicy.RawWindow(id: 9, app: app, pid: 77, layer: OverlayPolicy.cursorLayer, frame: cover, ownerName: owner), fx]
            let z = OverlayPolicy.expand(raw, display: display, granted: ["dev.fx"], partsOf: { _ in [] })
            XCTAssertNotEqual(Composite.topmost(at: CGPoint(x: 550, y: 442), in: z)?.app, "dev.fx",
                              "\(app ?? "nil")/\(owner): only the Window Server's own pointer window is ignored")
        }
    }

    func testGrantedAppWindowsOnAnyLayerAreGranted() {
        let display = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let raw = [OverlayPolicy.RawWindow(id: 9, app: "dev.fx", pid: 5, layer: 101, frame: CGRect(x: 300, y: 300, width: 180, height: 60))]
        XCTAssertEqual(OverlayPolicy.expand(raw, display: display, granted: ["dev.fx"], partsOf: { _ in [] }).map(\.granted), [true],
                       "the app's own context menu (layer 101) must be drawn, not blocked out")
    }

    func testNormalLayerFullScreenWindowsAreNotOverlays() {
        let display = CGRect(x: 0, y: 0, width: 1440, height: 900)
        XCTAssertFalse(OverlayPolicy.isOverlay(.init(id: 1, app: "dev.fx", pid: 1, layer: 0, frame: display), display: display),
                       "a fullscreen app window is a real window")
        XCTAssertTrue(OverlayPolicy.isOverlay(.init(id: 2, app: "com.apple.dock", pid: 2, layer: 20, frame: display), display: display))
        XCTAssertFalse(OverlayPolicy.isOverlay(.init(id: 3, app: nil, pid: 3, layer: 24, frame: display), display: display),
                       "bundle-less system windows stay opaque (conservative)")
    }
}
