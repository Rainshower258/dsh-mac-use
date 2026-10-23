import Darwin
import Foundation

/// Unix-socket server. Layout under `stateDir` (0700): `daemon.sock` (0600) and `token` (0600).
/// Every request is handled on one serial worker queue; the caller keeps the main thread free for its run loop.
public final class Server {
    public enum StartError: Error, CustomStringConvertible {
        case pathTooLong(String)
        case alreadyRunning(String)
        case posix(String, Int32)

        public var description: String {
            switch self {
            case .pathTooLong(let p): return "socket path too long: \(p)"
            case .alreadyRunning(let p): return "another daemon is already serving \(p)"
            case .posix(let what, let e): return "\(what): \(String(cString: strerror(e)))"
            }
        }
    }

    public let stateDir: URL
    public var socketPath: String { stateDir.appendingPathComponent("daemon.sock").path }
    public var tokenPath: String { stateDir.appendingPathComponent("token").path }
    public private(set) var token = ""

    private let dispatcher: Dispatcher
    private let audit: AuditSink
    private let requestDeadline: TimeInterval
    private let clock: WatchdogClock
    private let worker = DispatchQueue(label: "cu-runtime.worker")
    private var listenFD: Int32 = -1
    /// Write end of the accept thread's wake pipe. The thread waits on the listening socket and this pipe together;
    /// stop() writes a byte here, and the thread closes the listening socket itself and exits.
    private var wakeFD: Int32 = -1
    /// Signalled by the accept thread once it has closed the listening socket and left.
    private var acceptExited: DispatchSemaphore?
    private let acceptLock = NSLock()
    private var acceptRunning = false
    /// Whether an accept thread of this server has not finished yet: set by start(), cleared by the thread as it
    /// leaves. stop() returns only after it is cleared (within `acceptExitWait`).
    var acceptThreadRunning: Bool { acceptLock.lock(); defer { acceptLock.unlock() }; return acceptRunning }
    /// Test hook, nil in the daemon: run by the accept thread on its way out, before it closes the listening socket (a
    /// slow way out shows whether stop() really waits for it). Set before start().
    var acceptThreadWillLeave: (() -> Void)?
    /// How long stop() waits for the accept thread; it only has to see the wake byte, close two descriptors and return.
    static let acceptExitWait: TimeInterval = 2
    private var nextConnID = 0

    /// One client (the dsh plugin) is expected; a few more cover reconnects and debugging tools. Each connection
    /// is a thread, so the cap bounds threads too (audit L2).
    public static let defaultMaxConnections = 4
    /// A connection that sends nothing for this long is closed; the time a request spends on the worker does not
    /// count, only waiting for the client's next bytes.
    public static let defaultIdleTimeout: TimeInterval = 300
    private let maxConnections: Int
    private let idleTimeout: TimeInterval
    private let connLock = NSLock()
    private var activeConnections = 0

    public init(stateDir: URL, dispatcher: Dispatcher, audit: AuditSink, requestDeadline: TimeInterval = Deadlines.request,
                clock: WatchdogClock = SystemWatchdogClock(), maxConnections: Int = Server.defaultMaxConnections,
                idleTimeout: TimeInterval = Server.defaultIdleTimeout) {
        self.stateDir = stateDir
        self.dispatcher = dispatcher
        self.audit = audit
        self.requestDeadline = requestDeadline
        self.clock = clock
        self.maxConnections = maxConnections
        self.idleTimeout = idleTimeout
        // Owner check verdicts and panel answers are settled on the worker as soon as they arrive, not at the next
        // settings.* request (Dispatcher+SettingsRPC); always asynchronously, since one may arrive on the worker
        // itself (inside OwnerCheck.begin) or on the main thread while the worker waits on main. The dispatcher is held
        // weakly (its state lives as long as it does, so a strong capture would keep both forever) and used only on
        // the worker.
        nonisolated(unsafe) weak let settling = dispatcher
        dispatcher.settingsRPC.onFinish = { [worker] in worker.async { settling?.settleSettingsRPC() } }
    }

    /// Runs `body` on the worker queue, where all dispatcher state lives, and never waits for it: the worker may be
    /// waiting on the main thread itself (an approval dialog), so the main thread (the settings window) must not wait
    /// on the worker. The result comes back on the main queue.
    public func perform<T>(_ body: @escaping () -> T, then: @escaping (T) -> Void) {
        worker.async {
            let r = body()
            DispatchQueue.main.async { then(r) }
        }
    }

    /// Runs `cleanup` on the worker queue (where all dispatcher state lives), waiting at most `timeout`
    /// in case the worker is stuck, then stops serving. Anything not cleaned up here is covered by the
    /// ManualAXLedger on the next start.
    public func shutdown(timeout: TimeInterval = Deadlines.shutdown, _ cleanup: @escaping () -> Void) {
        let done = Pending<Void>()
        worker.async { cleanup(); done.complete(()) }
        _ = done.await(clock, timeout: timeout)
        stop()
    }

    public func start() throws {
        try StateDir.prepare(stateDir)

        var addr = try Self.address(socketPath)
        if FileManager.default.fileExists(atPath: socketPath) {
            if Self.canConnect(&addr) { throw StartError.alreadyRunning(socketPath) }
            unlink(socketPath)
        }

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw StartError.posix("socket", errno) }
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0 else { let e = errno; close(fd); throw StartError.posix("bind \(socketPath)", e) }
        chmod(socketPath, 0o600)
        guard listen(fd, 16) == 0 else { let e = errno; close(fd); throw StartError.posix("listen", e) }
        // Non-blocking: the accept thread waits in poll(), and a connection gone before its accept() must not block it.
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        var wake: [Int32] = [-1, -1]
        guard pipe(&wake) == 0 else { let e = errno; close(fd); throw StartError.posix("pipe", e) }
        for w in wake { _ = fcntl(w, F_SETFD, FD_CLOEXEC) }

        token = Self.randomHex(bytes: 32)
        do { try writeToken(token) } catch {
            close(fd); close(wake[0]); close(wake[1]); unlink(socketPath)
            throw error
        }

        listenFD = fd
        wakeFD = wake[1]
        let exited = DispatchSemaphore(value: 0)
        acceptExited = exited
        acceptLock.lock(); acceptRunning = true; acceptLock.unlock()
        let wakeRead = wake[0]
        let willLeave = acceptThreadWillLeave
        let t = Thread { [weak self] in
            self?.acceptLoop(fd, wake: wakeRead)
            willLeave?()
            // The thread owns the listening socket: closed here, after its last poll() and accept(), so nothing ever
            // closes it under a waiting call, and its number is not reused while this thread may still use it.
            close(fd)
            close(wakeRead)
            self?.acceptLock.lock(); self?.acceptRunning = false; self?.acceptLock.unlock()
            exited.signal()
        }
        t.name = "cu-runtime.accept"
        t.start()
    }

    /// Wakes the accept thread, which closes the listening socket itself and exits, waits for that (at most
    /// `acceptExitWait`; closing the pipe's write end after that wakes it as well), then removes the socket and token
    /// files. The listening socket is never closed while the thread may be waiting on it: on 2026-10-21 a close() that
    /// raced the thread's accept() never returned. Safe to call twice, or without a start().
    public func stop() {
        if wakeFD >= 0 {
            var byte: UInt8 = 1
            _ = write(wakeFD, &byte, 1)
            _ = acceptExited?.wait(timeout: .now() + Self.acceptExitWait)
            close(wakeFD)
            wakeFD = -1
        }
        acceptExited = nil
        listenFD = -1
        unlink(socketPath)
        unlink(tokenPath)
    }

    // MARK: - Connections

    /// Waits on the listening socket and the wake pipe together; returns when stop() writes to (or closes) the pipe,
    /// or the socket fails. The caller closes both.
    private func acceptLoop(_ fd: Int32, wake: Int32) {
        var fds = [pollfd(fd: fd, events: Int16(POLLIN), revents: 0), pollfd(fd: wake, events: Int16(POLLIN), revents: 0)]
        while true {
            fds[0].revents = 0
            fds[1].revents = 0
            if poll(&fds, 2, -1) < 0 {
                if errno == EINTR { continue }
                return
            }
            if fds[1].revents != 0 { return }   // stop()
            if fds[0].revents == 0 { continue }
            let client = accept(fd, nil, nil)
            if client < 0 {
                if errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK || errno == ECONNABORTED { continue }
                return  // the listening socket failed
            }
            // BSD hands the listening socket's O_NONBLOCK to the accepted one; serve() reads and writes blocking.
            _ = fcntl(client, F_SETFL, fcntl(client, F_GETFL) & ~O_NONBLOCK)
            nextConnID += 1
            let id = nextConnID
            var one: Int32 = 1
            setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            connLock.lock()
            let admitted = activeConnections < maxConnections
            if admitted { activeConnections += 1 }
            connLock.unlock()
            guard admitted else {
                refuse(client, id: id)
                continue
            }
            let t = Thread { [weak self] in
                self?.serve(client, id: id)
                self?.connLock.lock()
                self?.activeConnections -= 1
                self?.connLock.unlock()
            }
            t.name = "cu-runtime.conn.\(id)"
            t.start()
        }
    }

    private func refuse(_ fd: Int32, id: Int) {
        defer { close(fd) }
        var f = Self.peer(fd, id: id).auditFields
        f["method"] = .null
        f["decision"] = "deny"
        f["reason"] = "too_many_connections"
        f["detail"] = .string("limit \(maxConnections)")
        audit.record(f)
        let err = RPCFailure(.denied, "too many connections (limit \(maxConnections))",
                             data: Refusals.data(reason: "too_many_connections"))
        Self.writeAll(fd, Framing.encode(RPCMessage.error(id: nil, err)))
    }

    private func serve(_ fd: Int32, id: Int) {
        defer { close(fd) }
        var tv = timeval(tv_sec: Int(idleTimeout), tv_usec: Int32((idleTimeout - idleTimeout.rounded(.down)) * 1_000_000))
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        let conn = Self.peer(fd, id: id)
        let session = Session(token: token, dispatcher: dispatcher, audit: audit, conn: conn)

        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = read(fd, &chunk, chunk.count)
            if n < 0 && errno == EINTR { continue }
            if n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
                var f = conn.auditFields
                f["method"] = .null
                f["decision"] = "close"
                f["reason"] = "idle_timeout"
                f["detail"] = .string("nothing received for \(idleTimeout)s")
                audit.record(f)
                return
            }
            if n <= 0 { return }
            buffer.append(chunk, count: n)
            while true {
                switch Framing.decode(&buffer) {
                case .needMore:
                    break
                case .oversize(let length):
                    var f = conn.auditFields
                    f["method"] = .null
                    f["decision"] = "deny"
                    f["reason"] = "frame_too_large"
                    f["detail"] = .string("\(length) bytes > \(Framing.maxFrameBytes)")
                    audit.record(f)
                    let err = RPCFailure(.invalidRequest, "frame of \(length) bytes exceeds \(Framing.maxFrameBytes)",
                                         data: Refusals.data(reason: "frame_too_large"))
                    Self.writeAll(fd, Framing.encode(RPCMessage.error(id: nil, err)))
                    return
                case .frame(let payload):
                    guard let (reply, shouldClose) = handleWithWatchdog(session, payload) else {
                        guard Self.writeAll(fd, Framing.encode(timeoutReply(conn, payload))) else { return }
                        continue
                    }
                    guard Self.writeAll(fd, Framing.encode(reply)), !shouldClose else { return }
                    continue
                }
                break
            }
        }
    }

    /// Nil when the worker did not finish in time. The request may still complete later (its outcome is
    /// then unknown to the client, who should re-query state); the daemon itself keeps answering.
    private func handleWithWatchdog(_ session: Session, _ payload: Data) -> (Data, Bool)? {
        let pending = Pending<(Data, Bool)>()
        worker.async { pending.complete(session.handle(frame: payload)) }
        return pending.await(clock, timeout: requestDeadline)
    }

    /// Methods whose effect may outlast a timeout: every `act.*`, and `apps.launch` (the app may be starting, the
    /// file or URL may be opening; a retry would open it again, review 2026-10-23).
    static func mayHaveActed(_ method: String?) -> Bool {
        guard let method else { return false }
        return method.hasPrefix("act.") || method == "apps.launch"
    }

    /// An action that timed out may already have happened (the event can be posted before the reply is
    /// ready), so the client must observe before retrying: blind retries click twice / send twice / open twice.
    private func timeoutReply(_ conn: ConnectionInfo, _ payload: Data) -> Data {
        let request = try? JSONDecoder().decode(JSONValue.self, from: payload)
        let method = request?["method"]?.stringValue
        let isAction = Self.mayHaveActed(method)
        var f = conn.auditFields
        f["method"] = method.map { .string($0) } ?? .null
        f["decision"] = "error"
        f["reason"] = "request_timeout"
        f["detail"] = .string("no result within \(requestDeadline)s; outcome unknown")
        audit.record(f)
        let message = method == "apps.launch"
            ? "launch timed out after \(requestDeadline)s and MAY ALREADY HAVE BEEN EXECUTED (the app may be starting, "
                + "the file or URL may be opening): observe before deciding whether to retry"
            : isAction
            ? "action timed out after \(requestDeadline)s and MAY ALREADY HAVE BEEN EXECUTED: observe before deciding whether to retry"
            : "request timed out after \(requestDeadline)s; outcome unknown, re-query state"
        // An action's outcome is unknown: never retried automatically. Anything else had no side effect worth
        // guarding: the same request may be sent again after a moment.
        let data: JSONValue = ["reason": "request_timeout", "action_may_have_executed": .bool(isAction),
                               "executed": isAction ? .null : .bool(false),
                               "retry": .string((isAction ? RetryClass.outcomeUnknown : .afterDelay).rawValue)]
        return RPCMessage.error(id: request?["id"], RPCFailure(.requestTimeout, message, data: data))
    }

    // MARK: - Helpers

    private func writeToken(_ token: String) throws {
        let tmp = stateDir.appendingPathComponent(".token.\(getpid())").path
        unlink(tmp)
        let fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw StartError.posix("create token", errno) }
        let ok = Self.writeAll(fd, Data(token.utf8))
        close(fd)
        guard ok, rename(tmp, tokenPath) == 0 else { unlink(tmp); throw StartError.posix("write token", errno) }
    }

    @discardableResult
    static func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { buf in
            var off = 0
            while off < buf.count {
                let n = write(fd, buf.baseAddress! + off, buf.count - off)
                if n < 0 && errno == EINTR { continue }
                if n <= 0 { return false }
                off += n
            }
            return true
        }
    }

    static func address(_ path: String) throws -> sockaddr_un {
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { throw StartError.pathTooLong(path) }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        return addr
    }

    private static func canConnect(_ addr: inout sockaddr_un) -> Bool {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        return withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        } == 0
    }

    /// Peer identity: audited, and a person's approvals are bound to it (GrantOwner); never grants anything.
    /// Prefers the audit token, whose PID version tells a reused PID apart; falls back to LOCAL_PEERPID (no version:
    /// such a peer never owns approvals, GrantOwner).
    static func peer(_ fd: Int32, id: Int) -> ConnectionInfo {
        var pid: Int32?
        var version: Int32?
        var tok = audit_token_t()
        var len = socklen_t(MemoryLayout<audit_token_t>.size)
        if getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &tok, &len) == 0 {
            pid = Int32(bitPattern: tok.val.5)  // audit_token_to_pid() reads val[5]
            version = Int32(bitPattern: tok.val.7)  // audit_token_to_pidversion() reads val[7]
        } else {
            var p: pid_t = 0
            var plen = socklen_t(MemoryLayout<pid_t>.size)
            if getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &p, &plen) == 0 { pid = p }
        }
        var path: String?
        if let pid {
            var buf = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
            if proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 { path = String(cString: buf) }
        }
        return ConnectionInfo(id: id, peerPID: pid, peerPath: path, peerPIDVersion: version)
    }

    static func randomHex(bytes: Int) -> String {
        var b = [UInt8](repeating: 0, count: bytes)
        arc4random_buf(&b, bytes)
        return b.map { String(format: "%02x", $0) }.joined()
    }
}
