import XCTest
@testable import CURuntimeCore

final class OCRCacheTests: XCTestCase {
    // 320×256 pt window → 10×8 cells of 32 pt → thumbnail 80×64 samples (4 pt each).
    private let size = CGSize(width: 320, height: 256)
    private let w: UInt32 = 7

    private func thumb(_ edit: ((inout [UInt8]) -> Void)? = nil) -> LumaThumb {
        var px = [UInt8](repeating: 240, count: 80 * 64)
        edit?(&px)
        return LumaThumb(width: 80, height: 64, pixels: px)
    }

    /// Sets samples [x0, x1) × [y0, y1) (sample coordinates) to `v`.
    private func paint(_ px: inout [UInt8], _ x0: Int, _ y0: Int, _ x1: Int, _ y1: Int, _ v: UInt8) {
        for y in y0..<y1 { for x in x0..<x1 { px[y * 80 + x] = v } }
    }

    private func line(_ text: String, y: Double, x: Double = 10, h: Double = 14) -> (text: String, confidence: Double, frame: CGRect) {
        (text, 0.9, CGRect(x: x, y: y, width: 120, height: h))
    }

    private func seeded() -> OCRCache {
        var c = OCRCache()
        let t = thumb()
        XCTAssertEqual(c.plan(window: w, size: size, thumb: t), .full)
        c.apply(window: w, size: size, thumb: t, plan: .full,
                recognized: [line("alpha", y: 10), line("beta", y: 100), line("gamma", y: 200)])
        return c
    }

    func testUnchangedWindowNeedsNoOCR() {
        let c = seeded()
        XCTAssertEqual(c.plan(window: w, size: size, thumb: thumb()), .none)
        XCTAssertEqual(c.lines(window: w).map(\.text), ["alpha", "beta", "gamma"])
    }

    func testResizeRecognizesTheWholeWindow() {
        let c = seeded()
        XCTAssertEqual(c.plan(window: w, size: CGSize(width: 320, height: 300), thumb: thumb()), .full)
    }

    func testChangedCellWidensToAFullWidthPaddedBand() {
        let c = seeded()
        // Cell (col 8, row 4): samples x 64..<72, y 32..<40 — well away from the cached lines.
        let changed = thumb { self.paint(&$0, 64, 32, 72, 40, 0) }
        guard case .bands(let bands) = c.plan(window: w, size: size, thumb: changed) else { return XCTFail() }
        XCTAssertEqual(bands, [CGRect(x: 0, y: 128 - 8, width: 320, height: 32 + 16)])
    }

    func testBandGrowsOverCachedLinesItTouches() {
        var c = OCRCache()
        c.apply(window: w, size: size, thumb: thumb(), plan: .full, recognized: [line("straddles", y: 58, h: 20)])  // 58..78
        // Change in row 1 (32..64): the band 24..72 touches the line (58..78) and must cover it whole.
        let changed = thumb { self.paint(&$0, 0, 8, 8, 16, 0) }
        guard case .bands(let bands) = c.plan(window: w, size: size, thumb: changed) else { return XCTFail() }
        XCTAssertEqual(bands.count, 1)
        XCTAssertEqual(bands[0].minY, 24)
        XCTAssertEqual(bands[0].maxY, 78)
    }

    func testAdjacentRowsMergeIntoOneBand() {
        let c = seeded()
        let changed = thumb { self.paint(&$0, 0, 32, 8, 48, 0) }   // rows 4 and 5
        guard case .bands(let bands) = c.plan(window: w, size: size, thumb: changed) else { return XCTFail() }
        XCTAssertEqual(bands, [CGRect(x: 0, y: 120, width: 320, height: 80)])   // 128-8 ..< 192+8
    }

    func testSmallDifferencesBelowThresholdAreIgnored() {
        let c = seeded()
        // One sample in a cell off by 100: mean over 64 samples ≈ 1.6 < 2.
        let noisy = thumb { $0[33 * 80 + 1] = 140 }
        XCTAssertEqual(c.plan(window: w, size: size, thumb: noisy), .none)
    }

    func testCharacterSizedChangeIsDetected() {
        let c = seeded()
        // ≈ one changed digit: 4 samples fully inked (MAD 240*4/64 = 15), well above threshold.
        let changed = thumb { self.paint(&$0, 20, 50, 22, 52, 0) }
        XCTAssertNotEqual(c.plan(window: w, size: size, thumb: changed), .none)
    }

    func testBandReplacesOnlyItsLinesAndReusesIdsOfUnchangedText() {
        var c = seeded()
        let ids = Dictionary(uniqueKeysWithValues: c.lines(window: w).map { ($0.text, $0.id) })
        let changed = thumb { self.paint(&$0, 40, 24, 48, 32, 0) }   // row 3 (96..128): the "beta" line at 100
        let plan = c.plan(window: w, size: size, thumb: changed)
        guard case .bands = plan else { return XCTFail() }
        // Vision reads "beta" again (same place) plus a new line in the band.
        c.apply(window: w, size: size, thumb: changed, plan: plan,
                recognized: [line("beta", y: 100.5), line("delta", y: 116, x: 150)])
        let now = Dictionary(uniqueKeysWithValues: c.lines(window: w).map { ($0.text, $0.id) })
        XCTAssertEqual(now["alpha"], ids["alpha"], "outside the band: untouched")
        XCTAssertEqual(now["gamma"], ids["gamma"])
        XCTAssertEqual(now["beta"], ids["beta"], "re-read with the same text in the same place keeps its id")
        XCTAssertNotNil(now["delta"])
        XCTAssertFalse(ids.values.contains(now["delta"]!), "new text gets a new id")
        XCTAssertEqual(c.plan(window: w, size: size, thumb: changed), .none, "the band's samples were stored")
    }

    func testChangedTextInTheBandGetsANewIdAndTheOldLineIsGone() {
        var c = seeded()
        let oldBeta = c.lines(window: w).first { $0.text == "beta" }!.id
        let changed = thumb { self.paint(&$0, 40, 24, 48, 32, 0) }
        let plan = c.plan(window: w, size: size, thumb: changed)
        c.apply(window: w, size: size, thumb: changed, plan: plan, recognized: [line("betb", y: 100)])
        XCTAssertNil(c.lines(window: w).first { $0.text == "beta" })
        XCTAssertNotEqual(c.lines(window: w).first { $0.text == "betb" }?.id, oldBeta)
    }

    func testSubThresholdDriftOutsideBandsAccumulates() {
        var c = seeded()
        // Row 0 drifts by 1.5 per step (below threshold each time); row 3 changes and is re-read each step.
        var level: UInt8 = 240
        var flagged = false
        for step in 1...3 {
            level -= 2
            let t = thumb { px in
                self.paint(&px, 0, 0, 80, 8, level)
                self.paint(&px, 40, 24, 48, 32, UInt8(step * 50))
            }
            let plan = c.plan(window: w, size: size, thumb: t)
            if case .bands(let b) = plan, b.contains(where: { $0.minY == 0 }) { flagged = true }
            c.apply(window: w, size: size, thumb: t, plan: plan, recognized: [])
        }
        XCTAssertTrue(flagged, "row 0 must eventually count as changed: its stored samples were never replaced")
    }

    func testFailedOCRInvalidatesAndRetainDropsClosedWindows() {
        var c = seeded()
        c.invalidate(window: w)
        XCTAssertEqual(c.plan(window: w, size: size, thumb: thumb()), .full)
        c = seeded()
        c.retain(windows: [99])
        XCTAssertTrue(c.cachedWindows.isEmpty)
    }

    // MARK: - Dedup

    private func el(_ source: ObservedElement.Source, _ text: String, _ f: CGRect) -> ObservedElement {
        ObservedElement(source: source, app: "x", role: nil, text: text, frame: f, confidence: nil)
    }

    func testOCRInsideAXWithSameTextIsDropped() {
        let ocr = el(.ocr, "Send message", CGRect(x: 102, y: 51, width: 90, height: 16))
        let ax = el(.ax, "Send message", CGRect(x: 100, y: 48, width: 100, height: 22))
        XCTAssertTrue(OCRDedup.isCovered(ocr, by: [ax]))
    }

    func testMinorMisreadStillCountsAsTheSameText() {
        let ocr = el(.ocr, "Send rnessage", CGRect(x: 102, y: 51, width: 90, height: 16))
        let ax = el(.ax, "Send message", CGRect(x: 100, y: 48, width: 100, height: 22))
        XCTAssertTrue(OCRDedup.isCovered(ocr, by: [ax]))
    }

    func testLargeContainerWithOtherTextDoesNotSwallowOCR() {
        let ocr = el(.ocr, "Unread: 3", CGRect(x: 300, y: 300, width: 80, height: 16))
        let webArea = el(.ax, "QQ", CGRect(x: 0, y: 0, width: 1000, height: 800))
        XCTAssertFalse(OCRDedup.isCovered(ocr, by: [webArea]))
    }

    func testSameTextElsewhereIsNotADuplicate() {
        let ocr = el(.ocr, "OK", CGRect(x: 10, y: 10, width: 30, height: 16))
        let ax = el(.ax, "OK", CGRect(x: 500, y: 500, width: 40, height: 22))
        XCTAssertFalse(OCRDedup.isCovered(ocr, by: [ax]))
    }

    func testApproxSubstringDistance() {
        func d(_ a: String, _ b: String) -> Int { OCRDedup.approxSubstringDistance(Array(a), Array(b)) }
        XCTAssertEqual(d("abc", "xxabcxx"), 0)
        XCTAssertEqual(d("abd", "xxabcxx"), 1)
        XCTAssertEqual(d("abc", ""), 3)
        XCTAssertEqual(d("", "abc"), 0)
    }
}
