import XCTest
@testable import CURuntimeCore

final class WindowAppearTests: XCTestCase {
    private let qq = WindowAppearWait.App(bundleID: "com.tencent.qq", pid: 100)
    private let fx = WindowAppearWait.App(bundleID: "dev.dsh.bench.fixture", pid: 200)

    /// listed() returns `before` for the first `reads` calls, then `after`.
    private func script(_ before: Set<String>, then after: Set<String>, afterReads reads: Int) -> () -> Set<String> {
        var n = 0
        return { n += 1; return n <= reads ? before : after }
    }

    func testNoWaitWhenEveryAppHasAWindow() {
        var w = WindowAppearWait()
        var slept = 0.0
        let o = w.wait(candidates: [qq], listed: { ["com.tencent.qq"] }, sleep: { slept += $0 })
        XCTAssertEqual(o.waitedFor, 0)
        XCTAssertEqual(slept, 0)
    }

    func testWaitsUntilTheWindowIsListed() {
        var w = WindowAppearWait()
        var slept = 0.0
        let o = w.wait(candidates: [qq], listed: script([], then: ["com.tencent.qq"], afterReads: 8), sleep: { slept += $0 })
        XCTAssertEqual(o.waitedFor, 1)
        XCTAssertEqual(o.gaveUp, [])
        XCTAssertEqual(o.elapsed, 0.8, accuracy: 1e-9)   // read 1 is before any sleep; reads 2..8 empty, read 9 lists it
        XCTAssertEqual(slept, o.elapsed, accuracy: 1e-9)
        XCTAssertTrue(w.windowless.isEmpty)
    }

    func testGivesUpAtTheTimeoutAndDoesNotWaitAgain() {
        var w = WindowAppearWait()
        var slept = 0.0
        let first = w.wait(candidates: [qq], listed: { [] }, sleep: { slept += $0 })
        XCTAssertEqual(first.gaveUp, ["com.tencent.qq"])
        XCTAssertEqual(first.elapsed, w.params.timeout, accuracy: 0.11)

        slept = 0
        let second = w.wait(candidates: [qq], listed: { [] }, sleep: { slept += $0 })
        XCTAssertEqual(second.waitedFor, 0, "a confirmed windowless app costs the wait once, not on every observe")
        XCTAssertEqual(slept, 0)
    }

    func testWindowlessAppIsWaitedForAgainAfterShowingAWindow() {
        var w = WindowAppearWait()
        _ = w.wait(candidates: [qq], listed: { [] }, sleep: { _ in })
        _ = w.wait(candidates: [qq], listed: { ["com.tencent.qq"] }, sleep: { _ in })   // it showed a window
        XCTAssertTrue(w.windowless.isEmpty)
        let o = w.wait(candidates: [qq], listed: { [] }, sleep: { _ in })              // and closed it again
        XCTAssertEqual(o.waitedFor, 1)
    }

    func testRelaunchWithANewPidIsWaitedForAgain() {
        var w = WindowAppearWait()
        _ = w.wait(candidates: [qq], listed: { [] }, sleep: { _ in })
        let relaunched = WindowAppearWait.App(bundleID: "com.tencent.qq", pid: 101)
        let o = w.wait(candidates: [relaunched], listed: { [] }, sleep: { _ in })
        XCTAssertEqual(o.waitedFor, 1)
        XCTAssertFalse(w.windowless.contains(qq), "entries for apps no longer running are dropped")
    }

    func testOnlyPendingAppsAreWaitedFor() {
        var w = WindowAppearWait()
        let o = w.wait(candidates: [qq, fx],
                       listed: script(["com.tencent.qq"], then: ["com.tencent.qq", "dev.dsh.bench.fixture"], afterReads: 3),
                       sleep: { _ in })
        XCTAssertEqual(o.waitedFor, 1)
        XCTAssertEqual(o.elapsed, 0.3, accuracy: 1e-9)   // reads 1..3 without the fixture, read 4 after 3 sleeps
        XCTAssertEqual(o.gaveUp, [])
    }

    func testBundleIDsAreComparedCaseInsensitively() {
        var w = WindowAppearWait()
        let o = w.wait(candidates: [WindowAppearWait.App(bundleID: "Com.Tencent.QQ", pid: 1)],
                       listed: { ["com.tencent.qq"] }, sleep: { _ in XCTFail("must not wait") })
        XCTAssertEqual(o.waitedFor, 0)
    }
}
