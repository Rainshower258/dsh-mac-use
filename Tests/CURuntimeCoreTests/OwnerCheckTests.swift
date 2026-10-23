import Foundation
import XCTest
@testable import CURuntimeCore

/// The daemon's one owner check (OwnerCheck.swift, PLAN 阶段3 二 A): refused starts, exactly one verdict per check,
/// the cool-down, the audit, and one check at a time across threads.
final class OwnerCheckTests: XCTestCase {
    /// A settable clock several threads may read.
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var t = Date(timeIntervalSince1970: 1_800_000_000)
        var now: Date {
            get { lock.lock(); defer { lock.unlock() }; return t }
            set { lock.lock(); t = newValue; lock.unlock() }
        }
    }

    /// The verdicts a completion received, from any thread.
    private final class Verdicts: @unchecked Sendable {
        private let lock = NSLock()
        private var all: [OwnerVerdict] = []
        var list: [OwnerVerdict] { lock.lock(); defer { lock.unlock() }; return all }
        func add(_ v: OwnerVerdict) { lock.lock(); all.append(v); lock.unlock() }
    }

    /// A thread-safe yes/no for approvalOpen.
    private final class Flag: @unchecked Sendable {
        private let lock = NSLock()
        private var v = false
        var value: Bool {
            get { lock.lock(); defer { lock.unlock() }; return v }
            set { lock.lock(); v = newValue; lock.unlock() }
        }
    }

    private let clock = Clock()
    private let audit = MemoryAudit()
    private let dialog = Flag()

    private func check(_ verifier: OwnerVerifier?, cooldown: TimeInterval = 10) -> OwnerCheck {
        OwnerCheck(verifier: verifier, audit: audit, now: { [clock] in clock.now }, cooldown: cooldown,
                   approvalOpen: { [dialog] in dialog.value })
    }

    private func begin(_ c: OwnerCheck, _ got: Verdicts, purpose: String = "settings.apply deny.remove") -> OwnerCheckStart {
        c.begin(reason: "remove Example (com.example.app) from the deny list", purpose: purpose) { got.add($0) }
    }

    private var verifyLines: [[String: JSONValue]] { audit.entries.filter { $0["method"] == "settings.verify" } }

    // MARK: refused starts

    func testEachRefusedStartSaysWhyIsAuditedAndNeverReachesTheVerifierOrTheCompletion() {
        let got = Verdicts()
        XCTAssertEqual(begin(check(nil), got), .unavailable, "no verifier")

        let v = FakeOwnerVerifier()
        let c = check(v)
        dialog.value = true
        XCTAssertEqual(begin(c, got), .approvalOpen, "an approval dialog is up")
        dialog.value = false
        XCTAssertEqual(begin(c, got), .started)
        XCTAssertTrue(c.inFlight)
        XCTAssertEqual(begin(c, got), .busy, "one at a time")
        v.finish(.failed)
        XCTAssertFalse(c.inFlight)
        XCTAssertEqual(begin(c, got), .cooldown(until: clock.now.addingTimeInterval(10)))

        XCTAssertEqual(v.reasons.count, 1, "only the started check was shown")
        XCTAssertEqual(got.list, [.failed], "a refused start never calls its completion")
        let refused = verifyLines.filter { $0["stage"] == "start" }
        XCTAssertEqual(refused.map { $0["detail"] }, ["unavailable", "approval_open", "busy", "cooldown"])
        XCTAssertTrue(refused.allSatisfy { $0["decision"] == "deny" && $0["purpose"] == "settings.apply deny.remove" })
    }

    func testBusyComesBeforeACooldownOrAnOpenApprovalDialog() {
        let v = FakeOwnerVerifier()
        let c = check(v)
        let got = Verdicts()
        XCTAssertEqual(begin(c, got), .started)
        dialog.value = true
        XCTAssertEqual(begin(c, got), .busy)
    }

    // MARK: exactly one verdict

    func testAVerifierThatCallsBackTwiceOrLateReachesTheCallerOnce() throws {
        let v = FakeOwnerVerifier()
        let c = check(v)
        let first = Verdicts()
        XCTAssertEqual(begin(c, first), .started)
        let completion = try XCTUnwrap(v.completions.first)
        completion(.ok)
        completion(.failed)
        completion(.ok)
        XCTAssertEqual(first.list, [.ok])
        // A late call from the first check does not end the next one.
        let second = Verdicts()
        XCTAssertEqual(begin(c, second), .started, "ok starts no cool-down")
        completion(.failed)
        XCTAssertTrue(c.inFlight)
        XCTAssertEqual(second.list, [])
        v.finish(.ok)
        XCTAssertEqual(second.list, [.ok])
        XCTAssertEqual(first.list, [.ok])
        XCTAssertEqual(verifyLines.filter { $0["stage"] == "verdict" }.count, 2, "one line per verdict")
    }

    func testAVerifierThatAnswersAtOnceStillGivesOneVerdict() {
        let v = FakeOwnerVerifier(verdict: .ok)
        let c = check(v)
        let got = Verdicts()
        XCTAssertEqual(begin(c, got), .started)
        XCTAssertEqual(got.list, [.ok], "delivered before begin returned")
        XCTAssertFalse(c.inFlight)
        XCTAssertEqual(begin(c, got), .started)
        XCTAssertEqual(got.list, [.ok, .ok])
    }

    func testCancelEndsTheCheckAsCancelledThroughTheVerifierAndDropsWhatItReportsAfter() throws {
        let v = FakeOwnerVerifier()
        let c = check(v)
        let got = Verdicts()
        XCTAssertEqual(begin(c, got), .started)
        c.cancel()
        XCTAssertEqual(v.cancels, 1, "the prompt is closed through the verifier")
        XCTAssertFalse(c.inFlight)
        XCTAssertEqual(got.list, [.cancelled], "the fake reports cancelled too: still one verdict")
        try XCTUnwrap(v.completions.first)(.ok)  // an ok that lost the race
        XCTAssertEqual(got.list, [.cancelled])
        XCTAssertEqual(begin(c, got), .cooldown(until: clock.now.addingTimeInterval(10)), "a cancelled check cools down")
        // Nothing in flight: cancel does nothing, the verifier is not told.
        c.cancel()
        XCTAssertEqual(v.cancels, 1)
        XCTAssertEqual(got.list, [.cancelled])
        // A verifier whose cancel reports nothing still ends the check.
        let quiet = FakeOwnerVerifier()
        quiet.verdictOnCancel = nil
        let c2 = check(quiet)
        let got2 = Verdicts()
        XCTAssertEqual(begin(c2, got2), .started)
        c2.cancel()
        XCTAssertEqual(got2.list, [.cancelled])
        XCTAssertFalse(c2.inFlight)
    }

    func testCancelRacingAVerdictGivesExactlyOneVerdict() {
        for _ in 0..<300 {
            let v = FakeOwnerVerifier()
            let c = check(v, cooldown: 0)
            let got = Verdicts()
            XCTAssertEqual(begin(c, got), .started)
            DispatchQueue.concurrentPerform(iterations: 3) { i in
                switch i {
                case 0: c.cancel()
                case 1: v.finish(.ok)
                default: v.completions.first?(.failed)
                }
            }
            XCTAssertEqual(got.list.count, 1, "\(got.list)")
            XCTAssertFalse(c.inFlight)
        }
    }

    // MARK: the cool-down

    func testTheCooldownRunsTenSecondsAfterAFailedCancelledOrUnavailableVerdict() {
        for verdict in [OwnerVerdict.failed, .cancelled, .unavailable] {
            let v = FakeOwnerVerifier()
            let c = check(v)
            let got = Verdicts()
            XCTAssertEqual(begin(c, got), .started)
            let failedAt = clock.now
            v.finish(verdict)
            let until = failedAt.addingTimeInterval(10)
            clock.now = failedAt.addingTimeInterval(9.999)
            XCTAssertEqual(begin(c, got), .cooldown(until: until), "\(verdict)")
            clock.now = until
            XCTAssertEqual(begin(c, got), .started, "\(verdict): allowed again at the boundary")
            v.finish(.ok)
        }
    }

    func testAnOkVerdictStartsNoCooldownAndTheCooldownLengthIsInjected() {
        let v = FakeOwnerVerifier()
        let c = check(v, cooldown: 3)
        let got = Verdicts()
        XCTAssertEqual(begin(c, got), .started)
        v.finish(.ok)
        XCTAssertEqual(begin(c, got), .started, "right after ok")
        v.finish(.failed)
        XCTAssertEqual(begin(c, got), .cooldown(until: clock.now.addingTimeInterval(3)))
        clock.now = clock.now.addingTimeInterval(3)
        XCTAssertEqual(begin(c, got), .started)
    }

    // MARK: one at a time across threads

    func testConcurrentBeginsStartExactlyOneCheck() {
        for _ in 0..<50 {
            let v = FakeOwnerVerifier()
            let c = check(v)
            let got = Verdicts()
            let starts = Verdicts()  // reused as a thread-safe list: .ok = started, .failed = busy
            DispatchQueue.concurrentPerform(iterations: 8) { _ in
                switch begin(c, got) {
                case .started: starts.add(.ok)
                case .busy: starts.add(.failed)
                default: starts.add(.unavailable)
                }
            }
            XCTAssertEqual(starts.list.filter { $0 == .ok }.count, 1)
            XCTAssertEqual(starts.list.filter { $0 == .failed }.count, 7)
            XCTAssertEqual(v.reasons.count, 1)
            v.finish(.ok)
            XCTAssertEqual(got.list, [.ok])
        }
    }

    // MARK: the audit

    func testTheAuditRecordsEachVerdictWithItsPurposeAndNeverTheReasonText() {
        let v = FakeOwnerVerifier()
        let c = check(v, cooldown: 0)
        let got = Verdicts()
        let secret = "remove Secret Diary (com.example.diary) from the deny list"
        for (purpose, verdict) in [("settings.apply deny.remove", OwnerVerdict.ok), ("settings.apply behavior.set", .failed),
                                   ("settings.import_confirm", .cancelled), ("access.always_full", .unavailable)] {
            XCTAssertEqual(c.begin(reason: secret, purpose: purpose) { got.add($0) }, .started)
            v.finish(verdict)
        }
        XCTAssertEqual(v.reasons, Array(repeating: secret, count: 4), "the verifier shows the reason")
        let lines = verifyLines
        XCTAssertEqual(lines.count, 4)
        XCTAssertEqual(lines.map { $0["decision"] }, ["allow", "deny", "deny", "deny"])
        XCTAssertEqual(lines.map { $0["detail"] }, ["ok", "failed", "cancelled", "unavailable"])
        XCTAssertEqual(lines.map { $0["purpose"] }, ["settings.apply deny.remove", "settings.apply behavior.set",
                                                      "settings.import_confirm", "access.always_full"])
        XCTAssertTrue(lines.allSatisfy { $0["stage"] == "verdict" })
        let text = audit.entries.map { "\($0)" }.joined()
        XCTAssertFalse(text.contains("Secret Diary") || text.contains("com.example.diary"), "the reason text is never audited")
    }

    // MARK: the dispatcher's slots

    func testTheDispatcherHasNoOwnerCheckOrPanelsUntilMainSetsThem() {
        let h = Harness()
        XCTAssertNil(h.dispatcher.ownerCheck)
        XCTAssertNil(h.dispatcher.settingsPanels)
        let panels = FakeSettingsPanels()
        panels.names["com.example.app"] = "Example"
        h.dispatcher.ownerCheck = check(FakeOwnerVerifier())
        h.dispatcher.settingsPanels = panels
        XCTAssertEqual(h.dispatcher.settingsPanels?.appName("com.example.app"), "Example")
        XCTAssertNotNil(h.dispatcher.ownerCheck)
    }
}
