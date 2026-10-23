import Darwin
import XCTest
@testable import CURuntimeCore

final class ServerTests: XCTestCase {
    private var dir: URL!
    private var harness: Harness!
    private var server: Server!

    override func setUpWithError() throws {
        // Short path: sun_path is 104 bytes.
        dir = URL(fileURLWithPath: "/tmp/cur-\(Server.randomHex(bytes: 4))")
        harness = Harness()
        server = Server(stateDir: dir, dispatcher: harness.dispatcher, audit: harness.audit)
        try server.start()
    }

    override func tearDownWithError() throws {
        server.stop()
        try? FileManager.default.removeItem(at: dir)
    }

    // MARK: Client

    private func connectClient() throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = try Server.address(server.socketPath)
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        XCTAssertEqual(rc, 0)
        var tv = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        return fd
    }

    private func send(_ fd: Int32, _ json: String) { Server.writeAll(fd, Framing.encode(Data(json.utf8))) }

    /// Nil on EOF.
    private func receive(_ fd: Int32) -> JSONValue? {
        var buf = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        while true {
            if case .frame(let p) = Framing.decode(&buf) { return try? JSONDecoder().decode(JSONValue.self, from: p) }
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { return nil }
            buf.append(chunk, count: n)
        }
    }

    private func hello(_ fd: Int32, token: String? = nil) -> JSONValue? {
        send(fd, #"{"jsonrpc":"2.0","id":1,"method":"session.hello","params":{"token":"\#(token ?? server.token)"}}"#)
        return receive(fd)
    }

    // MARK: Tests

    func testFilePermissions() throws {
        func mode(_ p: String) throws -> Int {
            try XCTUnwrap(FileManager.default.attributesOfItem(atPath: p)[.posixPermissions] as? NSNumber).intValue
        }
        XCTAssertEqual(try mode(dir.path), 0o700)
        XCTAssertEqual(try mode(server.socketPath), 0o600)
        XCTAssertEqual(try mode(server.tokenPath), 0o600)
        XCTAssertEqual(try String(contentsOfFile: server.tokenPath, encoding: .utf8), server.token)
        XCTAssertEqual(server.token.count, 64)
    }

    func testHelloPingAndPeerIdentityInAudit() throws {
        let fd = try connectClient()
        defer { close(fd) }
        XCTAssertEqual(hello(fd)?["result"]?["protocol"], .string(Session.protocolVersion))
        send(fd, #"{"jsonrpc":"2.0","id":2,"method":"runtime.ping"}"#)
        XCTAssertEqual(receive(fd)?["result"]?["pong"], true)
        let e = harness.audit.entries.last!
        XCTAssertEqual(e["peer_pid"], .number(Double(getpid())), "the audit token should resolve to this test process")
        XCTAssertNotNil(e["peer_exe"]?.stringValue)
    }

    func testWrongTokenGetsErrorThenEOF() throws {
        let fd = try connectClient()
        defer { close(fd) }
        XCTAssertEqual(hello(fd, token: String(repeating: "0", count: 64))?["error"]?["code"], .number(-32001))
        XCTAssertNil(receive(fd), "connection must be closed after a bad token")
        XCTAssertEqual(harness.audit.entries.last?["reason"], "bad_token")
    }

    func testOversizeFrameGetsErrorThenEOF() throws {
        let fd = try connectClient()
        defer { close(fd) }
        _ = hello(fd)
        var len = UInt32(Framing.maxFrameBytes + 1).littleEndian
        Server.writeAll(fd, Data(bytes: &len, count: 4) + Data(repeating: 0x20, count: 1024))
        XCTAssertEqual(receive(fd)?["error"]?["code"], .number(-32600))
        XCTAssertNil(receive(fd))
        XCTAssertEqual(harness.audit.entries.last?["reason"], "frame_too_large")
    }

    func testRefusalsFlowThroughTheSocket() throws {
        let fd = try connectClient()
        defer { close(fd) }
        _ = hello(fd)
        send(fd, #"{"jsonrpc":"2.0","id":2,"method":"grants.set","params":{"task_id":"t","bundle_ids":["com.apple.Terminal"],"source":"config"}}"#)
        let r = receive(fd)
        XCTAssertEqual(r?["error"]?["code"], .number(-32010))
        XCTAssertEqual(r?["error"]?["data"]?["reason"], "hard_denied")
    }

    func testSecondDaemonOnSameStateDirRefusesToStart() {
        let other = Server(stateDir: dir, dispatcher: harness.dispatcher, audit: harness.audit)
        XCTAssertThrowsError(try other.start()) {
            guard case Server.StartError.alreadyRunning = $0 else { return XCTFail("\($0)") }
        }
    }

    /// stop() right after start(), and right after a client came in, over and over: the accept thread is then about to
    /// enter accept(), or back into it. A close() of the listening socket that raced that once never returned (a
    /// test's restart() hung in close() for 10 minutes, 2026-10-21). stop() must return each time, and leave the path
    /// free for the next start().
    func testStopRightAfterStartOrAConnectionNeverHangs() throws {
        server.stop()
        for i in 0..<1000 {
            let s = Server(stateDir: dir, dispatcher: harness.dispatcher, audit: harness.audit)
            try s.start()
            server = s
            if i % 2 == 1 { close(try connectClient()) }
            // Sweeps the moment of stop() across the accept thread's way into accept(): 0 to 980 µs.
            usleep(UInt32(i % 50) * 20)
            let stopped = DispatchSemaphore(value: 0)
            DispatchQueue.global().async { s.stop(); stopped.signal() }
            if stopped.wait(timeout: .now() + 3) == .timedOut {
                // A connection lets the stuck accept() return, and the close() with it, so the suite goes on to
                // report this instead of hanging.
                if let fd = try? connectClient() { close(fd) }
                _ = stopped.wait(timeout: .now() + 3)
                return XCTFail("stop() did not return within 3 s on cycle \(i)")
            }
            XCTAssertFalse(FileManager.default.fileExists(atPath: s.socketPath), "cycle \(i)")
        }
    }

    /// stop() returns only once the accept thread has left: the thread closes the listening socket itself, so no close()
    /// ever runs under its poll() or accept() (the hang above), and the socket's number is not reused while the thread
    /// may still use it. The thread's way out is made slow (20 ms), so a stop() that did not wait for it would return
    /// with the thread still there on every cycle, not just now and then.
    func testStopReturnsOnlyAfterTheAcceptThreadHasLeft() throws {
        server.stop()
        for i in 0..<20 {
            let s = Server(stateDir: dir, dispatcher: harness.dispatcher, audit: harness.audit)
            s.acceptThreadWillLeave = { usleep(20_000) }
            try s.start()
            server = s
            if i % 2 == 1 { close(try connectClient()) }
            XCTAssertTrue(s.acceptThreadRunning, "cycle \(i)")
            s.stop()
            XCTAssertFalse(s.acceptThreadRunning, "cycle \(i)")
            XCTAssertFalse(FileManager.default.fileExists(atPath: s.socketPath), "cycle \(i)")
        }
        server.stop()   // again: nothing left to wake
        XCTAssertFalse(server.acceptThreadRunning)
    }

    /// Restarts the server with a small connection cap and idle timeout.
    private func restart(maxConnections: Int = Server.defaultMaxConnections,
                         idleTimeout: TimeInterval = Server.defaultIdleTimeout) throws {
        server.stop()
        server = Server(stateDir: dir, dispatcher: harness.dispatcher, audit: harness.audit,
                        maxConnections: maxConnections, idleTimeout: idleTimeout)
        try server.start()
    }

    func testConnectionCapRefusesThenAdmitsAfterAClose() throws {
        try restart(maxConnections: 2)
        let a = try connectClient(), b = try connectClient()
        defer { close(a); close(b) }
        XCTAssertNotNil(hello(a)?["result"])
        XCTAssertNotNil(hello(b)?["result"])

        let c = try connectClient()
        let r = receive(c)
        XCTAssertEqual(r?["error"]?["code"], .number(-32010))
        XCTAssertEqual(r?["error"]?["data"]?["reason"], "too_many_connections")
        XCTAssertNil(receive(c), "a refused connection is closed")
        close(c)
        XCTAssertEqual(harness.audit.entries.last?["reason"], "too_many_connections")

        close(a)   // frees a slot once its thread has ended
        var admitted = false
        for _ in 0..<40 where !admitted {
            usleep(50_000)
            let d = try connectClient()
            admitted = hello(d)?["result"] != nil
            close(d)
        }
        XCTAssertTrue(admitted, "closing a connection must free its slot")
    }

    func testIdleConnectionIsClosedAndAudited() throws {
        try restart(idleTimeout: 0.3)
        let fd = try connectClient()
        defer { close(fd) }
        XCTAssertNotNil(hello(fd)?["result"])
        let t0 = Date()
        XCTAssertNil(receive(fd), "the daemon closes a connection that stays silent")
        XCTAssertGreaterThan(Date().timeIntervalSince(t0), 0.2)
        XCTAssertEqual(harness.audit.entries.last?["reason"], "idle_timeout")
    }

    func testActiveConnectionIsNotClosedByIdleTimeout() throws {
        try restart(idleTimeout: 0.3)
        let fd = try connectClient()
        defer { close(fd) }
        XCTAssertNotNil(hello(fd)?["result"])
        for i in 0..<5 {   // 1 s in total, each gap below the timeout
            usleep(150_000)
            send(fd, #"{"jsonrpc":"2.0","id":\#(i + 2),"method":"runtime.ping"}"#)
            XCTAssertEqual(receive(fd)?["result"]?["pong"], true)
        }
    }

    func testStopRemovesSocketAndToken() {
        server.stop()
        XCTAssertFalse(FileManager.default.fileExists(atPath: server.socketPath))
        XCTAssertFalse(FileManager.default.fileExists(atPath: server.tokenPath))
    }
}
