import Foundation
import XCTest
@testable import CURuntimeCore

/// The settings snapshot's app names, kept for a while: a hit, a kept miss, expiry by the
/// injected clock, and the key that ignores case.
final class AppNameCacheTests: XCTestCase {
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var t = Date(timeIntervalSince1970: 1_000_000)
        var now: Date {
            lock.lock()
            defer { lock.unlock() }
            return t
        }
        func advance(_ seconds: TimeInterval) {
            lock.lock()
            t = t.addingTimeInterval(seconds)
            lock.unlock()
        }
    }

    private let clock = Clock()
    private var calls: [String] = []

    private func cache(ttl: TimeInterval = 60) -> AppNameCache {
        let clock = clock
        return AppNameCache(ttl: ttl, now: { clock.now })
    }

    private func lookup(_ names: [String: String]) -> (String) -> String? {
        { id in
            self.calls.append(id)
            return names[id.lowercased()]
        }
    }

    func testAFoundNameIsLookedUpOnceWithinTheTTL() {
        let c = cache()
        let names = lookup(["com.apple.textedit": "TextEdit"])
        XCTAssertEqual(c.name("com.apple.TextEdit", lookup: names), "TextEdit")
        clock.advance(59)
        XCTAssertEqual(c.name("com.apple.TextEdit", lookup: names), "TextEdit")
        XCTAssertEqual(c.name("com.apple.TextEdit", lookup: { _ in XCTFail("looked up again"); return nil }), "TextEdit")
        XCTAssertEqual(calls, ["com.apple.TextEdit"])
    }

    func testANotFoundAnswerIsKeptToo() {
        let c = cache()
        let names = lookup([:])
        XCTAssertNil(c.name("com.example.gone", lookup: names))
        clock.advance(30)
        XCTAssertNil(c.name("com.example.gone", lookup: lookup(["com.example.gone": "Back"])))
        XCTAssertEqual(calls, ["com.example.gone"])
    }

    func testAnAnswerExpiresAfterTheTTLAndTheNewOneIsKept() {
        let c = cache(ttl: 60)
        XCTAssertNil(c.name("com.example.app", lookup: lookup([:])))
        clock.advance(60)
        XCTAssertEqual(c.name("com.example.app", lookup: lookup(["com.example.app": "App"])), "App")
        clock.advance(10)
        XCTAssertEqual(c.name("com.example.app", lookup: lookup([:])), "App", "the new answer is kept from its lookup")
        XCTAssertEqual(calls.count, 2)
        clock.advance(-120)
        XCTAssertNil(c.name("com.example.app", lookup: lookup([:])), "a clock that went back expires the answer")
        XCTAssertEqual(calls.count, 3)
    }

    func testTheKeyIgnoresCaseAndOtherAppsAreSeparate() {
        let c = cache()
        let names = lookup(["com.apple.textedit": "TextEdit", "com.apple.safari": "Safari"])
        XCTAssertEqual(c.name("com.apple.TextEdit", lookup: names), "TextEdit")
        XCTAssertEqual(c.name("COM.APPLE.TEXTEDIT", lookup: names), "TextEdit")
        XCTAssertEqual(c.name("com.apple.textedit", lookup: names), "TextEdit")
        XCTAssertEqual(c.name("com.apple.Safari", lookup: names), "Safari")
        XCTAssertEqual(calls, ["com.apple.TextEdit", "com.apple.Safari"])
    }

    func testTheDefaultTTLIsAMinute() {
        XCTAssertEqual(AppNameCache().ttl, 60)
    }

    func testCallsFromManyThreadsAgree() {
        let c = cache()
        let lock = NSLock()
        var looked = 0
        DispatchQueue.concurrentPerform(iterations: 200) { i in
            let id = "com.example.app\(i % 4)"
            let name = c.name(id) { id in
                lock.lock()
                looked += 1
                lock.unlock()
                return id.uppercased()
            }
            XCTAssertEqual(name, id.uppercased())
        }
        XCTAssertGreaterThanOrEqual(looked, 4)
    }
}
