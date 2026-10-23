import CoreGraphics
import Darwin
import XCTest
@testable import CURuntimeCore

/// M2: everything a target app returns through AX is untrusted input.
final class AXSanitizerTests: XCTestCase {
    private func el(role: AXRaw = .string("AXStaticText"), title: AXRaw = .missing, value: AXRaw = .string("hello"),
                    desc: AXRaw = .missing, pos: AXRaw = .point(CGPoint(x: 10, y: 20)),
                    size: AXRaw = .size(CGSize(width: 30, height: 40))) -> Result<ObservedElement?, AXSanitizer.Rejection> {
        AXSanitizer.element(app: "x", role: role, title: title, value: value, description: desc, position: pos, size: size)
    }

    func testWellFormedElement() throws {
        let e = try XCTUnwrap(try el().get())
        XCTAssertEqual(e.text, "hello")
        XCTAssertEqual(e.frame, CGRect(x: 10, y: 20, width: 30, height: 40))
        XCTAssertEqual(e.role, "AXStaticText")
    }

    func testNonFiniteOrAbsurdGeometryIsRejected() {
        let bad: [(AXRaw, AXRaw)] = [
            (.point(CGPoint(x: CGFloat.nan, y: 0)), .size(CGSize(width: 1, height: 1))),
            (.point(CGPoint(x: 0, y: CGFloat.infinity)), .size(CGSize(width: 1, height: 1))),
            (.point(CGPoint(x: 0, y: 0)), .size(CGSize(width: -CGFloat.infinity, height: 1))),
            (.point(CGPoint(x: 0, y: 0)), .size(CGSize(width: -5, height: 1))),
            (.point(CGPoint(x: 1e12, y: 0)), .size(CGSize(width: 1, height: 1))),
        ]
        for (p, s) in bad { XCTAssertEqual(el(pos: p, size: s), .failure(.badGeometry), "\(p) \(s)") }
    }

    func testWrongTypesAreRejectedNotTrapped() {
        XCTAssertEqual(el(pos: .other("CFNumber")), .failure(.wrongType))
        XCTAssertEqual(el(size: .string("big")), .failure(.wrongType))
        XCTAssertEqual(el(pos: .size(CGSize(width: 1, height: 1)), size: .point(.zero)), .failure(.wrongType))
    }

    func testMissingGeometryKeepsTextWithoutInventingAFrame() throws {
        let e = try XCTUnwrap(try el(pos: .missing).get())
        XCTAssertNil(e.frame)
        XCTAssertEqual(e.text, "hello")
    }

    func testNonStringValuesAndRolesAreIgnoredNotTrusted() throws {
        XCTAssertNil(try el(value: .other("CFNumber")).get(), "no text -> nothing to report")
        let e = try XCTUnwrap(try el(role: .other("CFArray"), title: .string("t"), value: .other("CFBoolean")).get())
        XCTAssertNil(e.role)
        XCTAssertEqual(e.text, "t")
    }

    func testTextIsCappedAndDeduplicated() throws {
        let long = String(repeating: "长", count: AXSanitizer.maxTextLength + 500)
        XCTAssertEqual(try XCTUnwrap(try el(value: .string(long)).get()).text.count, AXSanitizer.maxTextLength)
        XCTAssertEqual(try XCTUnwrap(try el(title: .string(" same "), value: .string("same")).get()).text, "same")
    }

    func testMalformedCountReachesAuditAndNilFrameEncodesAsNull() throws {
        let h = Harness()
        h.env.running.insert("com.tencent.qq")
        h.grant("t", ["com.tencent.qq"])
        var r = ObserveResult()
        r.elements = [ObservedElement(source: .ax, app: "com.tencent.qq", role: nil, text: "x", frame: nil, confidence: nil)]
        r.axStats = [AXStats(app: "com.tencent.qq", nodes: 9, elapsedMs: 1, hitTimeBudget: false, hitNodeCap: false, malformed: 3)]
        h.env.observeResult = r
        let out = try h.call("observe", ["task_id": "t", "ocr": "off"]).get()
        guard case .array(let els)? = out["untrusted_observation"]?["elements"], let e = els.first else { return XCTFail() }
        XCTAssertEqual(e["id"], "a1")
        XCTAssertEqual(e["frame_pt"], .null, "no frame is null, never a made-up (0,0)")
        XCTAssertEqual(e["occluded"], false)
        XCTAssertEqual(h.lastAudit["ax_malformed"], 3)
    }
}

final class JSONHardeningTests: XCTestCase {
    func testNonFiniteNumbersEncodeAsNullInsteadOfTrapping() throws {
        let v: JSONValue = ["a": .number(.nan), "b": [.number(.infinity), .number(-.infinity), 1], "c": "ok"]
        let decoded = try JSONDecoder().decode(JSONValue.self, from: JSONCoding.encode(v))
        XCTAssertEqual(decoded, ["a": .null, "b": [.null, .null, 1], "c": "ok"])
    }

    func testChordAllowlistDroppedNothing() {
        XCTAssertEqual(ChordPolicy.allowedWithModifiers.count, 32)  // + cmd+l, cmd+shift+t (2026-10-14); cmd+b/i/u, 6 selection chords (2026-10-15)
    }
}

/// M1: the state dir and audit dir must be real, ours, 0700.
final class StateDirTests: XCTestCase {
    private var base: URL!

    override func setUpWithError() throws {
        base = URL(fileURLWithPath: "/tmp/cur-sd-\(Server.randomHex(bytes: 4))")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: base) }

    func testCreatesMissingDirWith0700() throws {
        let d = base.appendingPathComponent("a/b/state")
        try StateDir.prepare(d)
        var st = stat()
        XCTAssertEqual(lstat(d.path, &st), 0)
        XCTAssertEqual(st.st_mode & 0o777, 0o700)
    }

    func testRefusesSymlinkLooseModeAndPlainFile() throws {
        let real = base.appendingPathComponent("real")
        try StateDir.prepare(real)
        let link = base.appendingPathComponent("link")
        XCTAssertEqual(symlink(real.path, link.path), 0)
        XCTAssertThrowsError(try StateDir.prepare(link)) { XCTAssertEqual($0 as? StateDir.Problem, .symlink(link.path)) }

        let loose = base.appendingPathComponent("loose")
        XCTAssertEqual(mkdir(loose.path, 0o755), 0)
        chmod(loose.path, 0o755)
        XCTAssertThrowsError(try StateDir.prepare(loose)) { XCTAssertEqual($0 as? StateDir.Problem, .wrongMode(loose.path, 0o755)) }
        var st = stat()
        lstat(loose.path, &st)
        XCTAssertEqual(st.st_mode & 0o777, 0o755, "must not silently take over or fix someone else's dir")

        let file = base.appendingPathComponent("file")
        FileManager.default.createFile(atPath: file.path, contents: Data())
        XCTAssertThrowsError(try StateDir.prepare(file)) { XCTAssertEqual($0 as? StateDir.Problem, .notDirectory(file.path)) }
    }

    func testServerRefusesToStartInASymlinkedStateDir() throws {
        let real = base.appendingPathComponent("real")
        try StateDir.prepare(real)
        let link = base.appendingPathComponent("link")
        symlink(real.path, link.path)
        let h = Harness()
        XCTAssertThrowsError(try Server(stateDir: link, dispatcher: h.dispatcher, audit: h.audit).start())
    }

    private let utc = TimeZone(identifier: "UTC")!
    private func lines(_ url: URL) -> [String] {
        ((try? String(contentsOf: url, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
    }

    func testAuditFileIsNeverFollowedThroughASymlink() throws {
        let dir = base.appendingPathComponent("state/audit")
        try StateDir.prepare(dir)
        let target = base.appendingPathComponent("elsewhere.jsonl")
        FileManager.default.createFile(atPath: target.path, contents: Data())
        let t = Date(timeIntervalSince1970: 1_800_000_000)
        symlink(target.path, dir.appendingPathComponent("audit-2027-01-15.jsonl").path)
        XCTAssertThrowsError(try FileAudit(directory: dir, timeZone: utc, now: { t }))
    }

    /// L4: one file per local day; an entry lands in the file of its own day.
    func testAuditRotatesAtMidnight() throws {
        let dir = base.appendingPathComponent("rot/audit")
        var clock = ISO8601DateFormatter().date(from: "2027-01-15T23:59:59Z")!
        let audit = try FileAudit(directory: dir, timeZone: utc, now: { clock })
        audit.record(["method": "before"])
        clock = clock.addingTimeInterval(2)
        audit.record(["method": "after"])
        audit.record(["method": "after2"])
        let d1 = lines(dir.appendingPathComponent("audit-2027-01-15.jsonl"))
        let d2 = lines(dir.appendingPathComponent("audit-2027-01-16.jsonl"))
        XCTAssertEqual(d1.count, 1)
        XCTAssertTrue(d1[0].contains("\"before\"") && d1[0].contains("2027-01-15T23:59:59"))
        XCTAssertEqual(d2.count, 2)
        XCTAssertTrue(d2[0].contains("\"after\"") && d2[0].contains("2027-01-16T00:00:01"))
    }

    /// A symlink planted as tomorrow's file is not followed, and no entry is lost: it goes to today's file, and the
    /// switch is retried with the next entry.
    func testAuditRotationNeverFollowsASymlinkAndDropsNothing() throws {
        let dir = base.appendingPathComponent("rot2/audit")
        var clock = ISO8601DateFormatter().date(from: "2027-01-15T12:00:00Z")!
        let audit = try FileAudit(directory: dir, timeZone: utc, now: { clock })
        let target = base.appendingPathComponent("planted.jsonl")
        FileManager.default.createFile(atPath: target.path, contents: Data())
        let tomorrow = dir.appendingPathComponent("audit-2027-01-16.jsonl")
        symlink(target.path, tomorrow.path)
        clock = ISO8601DateFormatter().date(from: "2027-01-16T00:00:05Z")!
        audit.record(["method": "x"])
        XCTAssertEqual(lines(target), [], "the symlink target must never be written")
        XCTAssertEqual(lines(dir.appendingPathComponent("audit-2027-01-15.jsonl")).count, 1)
        unlink(tomorrow.path)
        audit.record(["method": "y"])
        XCTAssertEqual(lines(tomorrow).count, 1)
    }
}

/// M3: layered AXManualAccessibility cleanup (now one kind in SystemStateChanges).
final class ManualAXRecoveryTests: XCTestCase {
    private let qq = "com.tencent.qq"
    private func ax(_ app: String, _ pids: [Int32], _ at: Date) -> StateEntry {
        StateEntry(kind: SystemStateChanges.electronAX, target: app, pids: pids, setAt: at)
    }

    func testLedgerIsWrittenBeforeTheSwitchAndClearedAfterTurningOff() throws {
        let h = Harness()
        h.env.running.insert(qq)
        h.env.pids[qq] = [4711]
        h.env.onManualAX = { app, on in
            if on { XCTAssertEqual(h.ledger.list.map(\.target), [app], "ledger must be written before switching on") }
        }
        h.call("grants.set", ["task_id": "t", "bundle_ids": .array([.string(qq)]), "source": "config", "electron_ax": true])
        let before = h.clock  // the ledger is stamped before switching; settling then advances the clock
        _ = try h.call("observe", ["task_id": "t", "ocr": "off"]).get()
        XCTAssertEqual(h.ledger.list, [ax(qq, [4711], before)])
        h.call("grants.revoke", ["task_id": "t"])
        XCTAssertTrue(h.ledger.list.isEmpty)
    }

    func testStartupRecoveryRestoresOnlyLiveProcesses() {
        let ledger = MemoryStateLedger([ax(qq, [4711], Date()), ax("dev.gone.app", [99], Date())])
        let h = Harness(ledger: ledger)
        h.env.pids[qq] = [4711, 4712]
        h.env.pids["dev.gone.app"] = []
        h.dispatcher.recoverSystemState()
        XCTAssertEqual(h.env.manualAXCalls.map { "\($0.0)=\($0.1)" }, ["\(qq)=false"])
        XCTAssertTrue(ledger.list.isEmpty)
        let triggers = h.audit.entries.filter { $0["method"] == "ax.manual_accessibility" }.map { $0["trigger"] }
        XCTAssertEqual(triggers, ["startup_recovery", "startup_recovery"])
    }

    func testRecoveryIgnoresARestartedAppWithANewPID() {
        let ledger = MemoryStateLedger([ax(qq, [4711], Date())])
        let h = Harness(ledger: ledger)
        h.env.pids[qq] = [5000]  // QQ was restarted: the attribute is already gone
        h.dispatcher.recoverSystemState()
        XCTAssertTrue(h.env.manualAXCalls.isEmpty)
        XCTAssertTrue(ledger.list.isEmpty)
    }

    func testShutdownRestoresEverything() throws {
        let h = Harness()
        h.env.running.insert(qq)
        h.call("grants.set", ["task_id": "t", "bundle_ids": .array([.string(qq)]), "source": "config", "electron_ax": true])
        _ = try h.call("observe", ["task_id": "t", "ocr": "off"]).get()
        h.dispatcher.restoreAllSystemState(trigger: "signal_15")
        XCTAssertEqual(h.env.manualAXCalls.map(\.1), [true, false])
        XCTAssertEqual(h.audit.entries.last?["trigger"], "signal_15")
        XCTAssertTrue(h.ledger.list.isEmpty)
    }

    func testFileLedgerRoundTripIsPrivate() throws {
        let dir = URL(fileURLWithPath: "/tmp/cur-led-\(Server.randomHex(bytes: 4))")
        try StateDir.prepare(dir)
        defer { try? FileManager.default.removeItem(at: dir) }
        let l = FileStateLedger(stateDir: dir)
        let e = ax(qq, [1, 2], Date(timeIntervalSince1970: 1_800_000_000))
        let i = StateEntry(kind: SystemStateChanges.inputSource, target: "system", original: "pinyin", applied: "abc",
                           setAt: Date(timeIntervalSince1970: 1_800_000_000))
        l.record(e)
        l.record(i)
        XCTAssertEqual(FileStateLedger(stateDir: dir).entries(), [e, i])
        var st = stat()
        lstat(dir.appendingPathComponent("state-changes.json").path, &st)
        XCTAssertEqual(st.st_mode & 0o777, 0o600)
        l.remove(kind: SystemStateChanges.electronAX, target: qq)
        XCTAssertEqual(l.entries(), [i])
        l.remove(kind: SystemStateChanges.inputSource, target: "system")
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("state-changes.json").path))
    }

    /// A crash under the old daemon leaves ax-manual.json ({app, pids, setAt}); the generic ledger folds it in.
    func testLegacyAXLedgerIsFoldedIn() throws {
        let dir = URL(fileURLWithPath: "/tmp/cur-led-\(Server.randomHex(bytes: 4))")
        try StateDir.prepare(dir)
        defer { try? FileManager.default.removeItem(at: dir) }
        let legacy = dir.appendingPathComponent("ax-manual.json")
        try Data(#"[{"app":"com.tencent.qq","pids":[7],"setAt":1800000000}]"#.utf8).write(to: legacy)
        let l = FileStateLedger(stateDir: dir)
        XCTAssertEqual(l.entries(), [ax(qq, [7], Date(timeIntervalSince1970: 1_800_000_000))])
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacy.path))
        XCTAssertEqual(FileStateLedger(stateDir: dir).entries().count, 1)
    }
}

/// M4: a stuck request gets a timeout error; the daemon keeps answering. Time is a ManualWatchdogClock
/// advanced by the test, and "stuck" is a semaphore, so nothing here depends on how fast the machine is.
/// (The 10 s values below are hang guards only; they never decide pass or fail.)
final class WatchdogTests: XCTestCase {
    private var dir: URL!
    private var h: Harness!
    private var clock: ManualWatchdogClock!
    private var server: Server!
    private var fd: Int32 = -1

    override func setUpWithError() throws {
        dir = URL(fileURLWithPath: "/tmp/cur-wd-\(Server.randomHex(bytes: 4))")
        h = Harness()
        h.grant()
        clock = ManualWatchdogClock()
        server = Server(stateDir: dir, dispatcher: h.dispatcher, audit: h.audit, requestDeadline: 30, clock: clock)
        try server.start()
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = try Server.address(server.socketPath)
        _ = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        var tv = timeval(tv_sec: 10, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        send(#"{"jsonrpc":"2.0","id":1,"method":"session.hello","params":{"token":"\#(server.token)"}}"#)
        _ = receive()
    }

    override func tearDownWithError() throws {
        h.env.observeGate?.signal()
        h.env.activateGate?.signal()
        h.env.launchGate?.signal()
        close(fd)
        server.stop()
        try? FileManager.default.removeItem(at: dir)
    }

    private func send(_ json: String) { Server.writeAll(fd, Framing.encode(Data(json.utf8))) }

    private func receive() -> JSONValue? {
        var buf = Data(), chunk = [UInt8](repeating: 0, count: 4096)
        while true {
            if case .frame(let p) = Framing.decode(&buf) { return try? JSONDecoder().decode(JSONValue.self, from: p) }
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { return nil }
            buf.append(chunk, count: n)
        }
    }

    private func replyPending() -> Bool {
        var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        return poll(&p, 1, 0) == 0
    }

    /// Synchronisation, not timing: block until the server thread is parked in the watchdog wait.
    private func waitUntilWatchdogArmed() {
        for _ in 0..<100_000 where clock.waiterCount == 0 { usleep(100) }
        XCTAssertEqual(clock.waiterCount, 1, "hang guard: watchdog never armed")
    }

    func testStuckObserveTimesOutExactlyAtTheDeadlineAndDaemonRecovers() {
        h.env.observeGate = DispatchSemaphore(value: 0)
        send(#"{"jsonrpc":"2.0","id":2,"method":"observe","params":{"task_id":"t1","ocr":"off"}}"#)
        waitUntilWatchdogArmed()
        XCTAssertTrue(replyPending())
        clock.advance(by: 29.9)
        XCTAssertTrue(replyPending(), "no reply before the deadline")
        clock.advance(by: 0.1)
        let r = receive()
        XCTAssertEqual(r?["id"], 2)
        XCTAssertEqual(r?["error"]?["code"], .number(Double(RPCCode.requestTimeout.rawValue)))
        XCTAssertEqual(r?["error"]?["data"]?["action_may_have_executed"], false)
        XCTAssertTrue(h.audit.entries.contains { $0["reason"] == "request_timeout" && $0["method"] == "observe" })

        h.env.observeGate?.signal()  // the stuck call finishes; its late result is dropped
        send(#"{"jsonrpc":"2.0","id":3,"method":"runtime.ping"}"#)
        XCTAssertEqual(receive()?["result"]?["pong"], true)
    }

    func testTimedOutActionSaysItMayHaveExecuted() {
        h.env.activateGate = DispatchSemaphore(value: 0)
        send(#"{"jsonrpc":"2.0","id":4,"method":"act.key","params":{"task_id":"t1","app":"dev.dsh.bench.fixture","chord":"return"}}"#)
        waitUntilWatchdogArmed()
        clock.advance(by: 30)
        let e = receive()?["error"]
        XCTAssertEqual(e?["data"]?["action_may_have_executed"], true)
        XCTAssertTrue(e?["message"]?.stringValue?.contains("MAY ALREADY HAVE BEEN EXECUTED") ?? false)
        XCTAssertTrue(e?["message"]?.stringValue?.contains("observe before deciding whether to retry") ?? false)
    }

    /// Review 2026-10-23: a launch that timed out was answered after_delay, and the plugin opened the same file or URL
    /// up to 4 times. Like an act.*, it may already have happened: outcome_unknown, never retried automatically.
    func testTimedOutLaunchMayHaveHappenedAndIsNotRetried() {
        h.grant(allowLaunch: true)
        h.env.running.remove(fixture)
        h.env.launchGate = DispatchSemaphore(value: 0)
        send(#"{"jsonrpc":"2.0","id":5,"method":"apps.launch","params":{"task_id":"t1","app":"dev.dsh.bench.fixture"}}"#)
        waitUntilWatchdogArmed()
        clock.advance(by: 30)
        let r = receive()
        XCTAssertEqual(r?["id"], 5)
        let e = r?["error"]
        XCTAssertEqual(e?["code"], .number(Double(RPCCode.requestTimeout.rawValue)))
        XCTAssertEqual(e?["data"]?["action_may_have_executed"], true)
        XCTAssertEqual(e?["data"]?["retry"], "outcome_unknown")
        XCTAssertEqual(e?["data"]?["executed"], .null)
        let message = e?["message"]?.stringValue ?? ""
        XCTAssertTrue(message.contains("launch timed out") && message.contains("MAY ALREADY HAVE BEEN EXECUTED"), message)
        XCTAssertTrue(message.contains("observe before deciding whether to retry"), message)
        XCTAssertTrue(h.audit.entries.contains { $0["reason"] == "request_timeout" && $0["method"] == "apps.launch" })
    }

    func testOnlyMethodsThatMayActAreKeptFromAutomaticRetry() {
        for m in ["act.click", "act.key", "act.type", "apps.launch"] { XCTAssertTrue(Server.mayHaveActed(m), m) }
        for m in ["observe", "apps.list", "zoom", "runtime.ping", "apps.launcher", "act", nil] as [String?] {
            XCTAssertFalse(Server.mayHaveActed(m), String(describing: m))
        }
    }

    func testShutdownReturnsWhenTheClockRunsOutEvenIfTheWorkerIsStuck() {
        let gate = DispatchSemaphore(value: 0)
        let returned = expectation(description: "shutdown returned")
        Thread { [server] in
            server!.shutdown(timeout: 5) { gate.wait() }
            returned.fulfill()
        }.start()
        waitUntilWatchdogArmed()
        clock.advance(by: 4.9)
        XCTAssertTrue(FileManager.default.fileExists(atPath: server.socketPath), "still serving before the timeout")
        clock.advance(by: 0.1)
        wait(for: [returned], timeout: 10)  // hang guard
        XCTAssertFalse(FileManager.default.fileExists(atPath: server.socketPath))
        gate.signal()
    }
}

/// Waiting for Chromium's AX tree after switching electron_ax on. Time is the injected sleep, not the wall clock.
final class AXSettleTests: XCTestCase {
    private func run(baseline: Int, _ counts: [Int]) -> AXSettle.Outcome {
        var seq = counts
        return AXSettle.wait(baseline: baseline, count: { seq.count > 1 ? seq.removeFirst() : seq[0] }, sleep: { _ in })
    }

    func testGrowsThenSettles() {
        let o = run(baseline: 13, [13, 200, 700, 944, 944, 944])
        XCTAssertEqual(o.reason, .grewAndSettled)
        XCTAssertEqual(o.nodes, 944)
        XCTAssertEqual(o.reads, 6)
    }

    /// The trap: right after switching on, the count can sit at the baseline and look "stable".
    func testDoesNotMistakeTheUntouchedBaselineForSettled() {
        let o = run(baseline: 13, [13, 13, 13, 13, 500, 944, 944, 944])
        XCTAssertEqual(o.reason, .grewAndSettled)
        XCTAssertEqual(o.nodes, 944)
    }

    func testSwitchWithNoEffectReturnsAfterTheGracePeriod() {
        let o = run(baseline: 112, [112])
        XCTAssertEqual(o.reason, .unchanged)
        XCTAssertEqual(o.nodes, 112)
        XCTAssertGreaterThanOrEqual(o.elapsed, AXSettle.Params().unchangedGrace)
    }

    /// QQ on the host (2026-10-09): the tree stays at the baseline for 2-5 s, then arrives.
    func testWaitsForASlowTreeBeyondOneAndAHalfSeconds() {
        let o = run(baseline: 13, Array(repeating: 13, count: 13) + [253, 253, 253])   // 13 reads = 3 s
        XCTAssertEqual(o.reason, .grewAndSettled)
        XCTAssertEqual(o.nodes, 253)
    }

    /// QQ wobbled 12 -> 13 by itself on 2026-10-08, which was taken for "grew and settled".
    func testAOneNodeWobbleIsNotGrowth() {
        let o = run(baseline: 12, [13])
        XCTAssertEqual(o.reason, .unchanged)
        XCTAssertGreaterThanOrEqual(o.elapsed, AXSettle.Params().unchangedGrace)
    }

    func testNeverSettlingTimesOutAndSaysSo() {
        var n = 13
        let o = AXSettle.wait(baseline: 13, count: { n += 50; return n }, sleep: { _ in })
        XCTAssertEqual(o.reason, .timeout)
        XCTAssertFalse(o.settled)
        XCTAssertEqual(o.elapsed, AXSettle.Params().timeout, accuracy: 1e-9)
    }

    func testObserveWaitsForSettleAndAuditsIt() throws {
        let qq = "com.tencent.qq"
        let h = Harness()
        h.env.running.insert(qq)
        h.env.axNodeCounts[qq] = [13, 13, 13, 400, 944, 944, 944]
        h.call("grants.set", ["task_id": "t", "bundle_ids": .array([.string(qq)]), "source": "config", "electron_ax": true])
        let t0 = h.clock
        var r = ObserveResult()
        r.axStats = [AXStats(app: qq, nodes: 944, elapsedMs: 1, hitTimeBudget: false, hitNodeCap: false)]
        h.env.observeResult = r
        let out = try h.call("observe", ["task_id": "t", "ocr": "off"]).get()
        XCTAssertGreaterThan(h.clock.timeIntervalSince(t0), 0, "must have waited (injected time)")
        let on = try XCTUnwrap(h.audit.entries.first { $0["method"] == "ax.manual_accessibility" })
        XCTAssertEqual(on["settle"]?["reason"], "grew_and_settled")
        XCTAssertEqual(on["settle"]?["baseline_nodes"], 13)
        XCTAssertEqual(on["settle"]?["nodes"], 944)
        guard case .array(let stats) = out["ax_stats"] else { return XCTFail() }
        XCTAssertEqual(stats.first?["settle"]?["reason"], "grew_and_settled")
        XCTAssertEqual(stats.first?["electron_ax"], true)
    }

    func testElectronAXIsOffByDefault() throws {
        let h = Harness()
        let g = try h.grant().get()
        XCTAssertEqual(g["electron_ax"], false)
    }
}
