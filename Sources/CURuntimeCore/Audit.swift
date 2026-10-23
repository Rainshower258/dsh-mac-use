import Foundation

public protocol AuditSink: AnyObject {
    func record(_ entry: [String: JSONValue])
    /// Files older than `days` go (the logs setting); a sink without files ignores it.
    func setRetention(days: Int)
    /// Moves the log to `directory` (the logs setting): the day files so far go with it. Throws when the directory
    /// cannot be made the daemon's own (StateDir); the log then stays where it was. Returns how many files moved.
    /// The signature must be FileAudit's exactly: when it was `throws` without `-> Int`, FileAudit's method did not
    /// satisfy it and every call through AuditSink went to the empty default below (VM round 17, 2026-10-17).
    @discardableResult
    func setDirectory(_ directory: URL) throws -> Int
}

public extension AuditSink {
    func setRetention(days: Int) {}
    @discardableResult
    func setDirectory(_ directory: URL) throws -> Int { 0 }
}

public struct ConnectionInfo: Sendable {
    public let id: Int
    /// Audited; also binds a person's approvals to the client that asked for them (GrantOwner): another peer cannot
    /// use them. Never used to grant anything.
    public let peerPID: Int32?
    public let peerPath: String?
    /// The PID's version from the audit token (audit_token_to_pidversion): a PID is reused, a PID and its version
    /// name one process. nil without an audit token.
    public let peerPIDVersion: Int32?

    public init(id: Int, peerPID: Int32?, peerPath: String?, peerPIDVersion: Int32?) {
        self.id = id
        self.peerPID = peerPID
        self.peerPath = peerPath
        self.peerPIDVersion = peerPIDVersion
    }

    var auditFields: [String: JSONValue] {
        [
            "conn": .number(Double(id)),
            "peer_pid": peerPID.map { .number(Double($0)) } ?? .null,
            "peer_exe": peerPath.map { .string($0) } ?? .null,
            "peer_pidversion": peerPIDVersion.map { .number(Double($0)) } ?? .null,
        ]
    }
}

/// The log's days as FileAudit names its files: one per local day. The retention, the export and every reader count
/// them the same way: "the last N days" are today and the N−1 days before it (2026-10-17: the retention kept N+1
/// days, and the readers named days in UTC while the writer used local time, so from midnight to 08:00 in UTC+8
/// today's file was not read at all).
public enum AuditDays {
    /// "yyyy-MM-dd" of each of the last `days` local days, today first.
    public static func last(_ days: Int, now: Date = Date(), timeZone: TimeZone = .current) -> [String] {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withFullDate]
        f.timeZone = timeZone
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        return (0..<max(1, days)).compactMap { cal.date(byAdding: .day, value: -$0, to: now).map(f.string) }
    }

    public static func fileName(_ day: String, prefix: String = "audit") -> String { "\(prefix)-\(day).jsonl" }
}

/// Append-only JSONL, one line per request, including refusals, in one file per local day
/// (`<prefix>-YYYY-MM-DD.jsonl`). Each entry goes to the file of the day of its own timestamp, so a daemon that runs
/// past midnight switches files (audit L4).
public final class FileAudit: AuditSink {
    private var directory: URL
    private let prefix: String
    private let now: () -> Date
    private let dayFormatter: ISO8601DateFormatter
    private var fd: Int32 = -1
    private var day = ""
    private var retentionDays: Int?
    private let lock = NSLock()
    private let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// The directory must pass StateDir checks; a day's file is never followed through a symlink. Throws if today's
    /// file cannot be opened.
    public init(directory: URL, prefix: String = "audit", timeZone: TimeZone = .current,
                now: @escaping () -> Date = Date.init) throws {
        self.directory = directory
        self.prefix = prefix
        self.now = now
        dayFormatter = ISO8601DateFormatter()
        dayFormatter.formatOptions = [.withFullDate]
        dayFormatter.timeZone = timeZone
        lock.lock()
        defer { lock.unlock() }
        try openFile(for: now())
    }

    deinit { if fd >= 0 { close(fd) } }

    public func path(for date: Date) -> URL {
        directory.appendingPathComponent("\(prefix)-\(dayFormatter.string(from: date)).jsonl")
    }

    /// Where the files are now.
    public var currentDirectory: URL {
        lock.lock()
        defer { lock.unlock() }
        return directory
    }

    /// Moves the log: the new directory is prepared (StateDir: ours, 0700), this prefix's day files are moved over
    /// (renamed; copied and removed across volumes), today's file is reopened there. On failure nothing moved.
    /// Returns how many files moved.
    @discardableResult
    public func setDirectory(_ new: URL) throws -> Int {
        lock.lock()
        defer { lock.unlock() }
        let newPath = new.standardizedFileURL.path
        guard newPath != directory.standardizedFileURL.path else { return 0 }
        try StateDir.prepare(new)
        let fm = FileManager.default
        var moved = 0
        for name in (try? fm.contentsOfDirectory(atPath: directory.path)) ?? []
        where name.hasPrefix(prefix + "-") && name.hasSuffix(".jsonl") {
            let from = directory.appendingPathComponent(name), to = new.appendingPathComponent(name)
            if fm.fileExists(atPath: to.path) { continue }  // never overwrite a day already there
            if rename(from.path, to.path) == 0 { moved += 1; continue }
            if (try? fm.copyItem(at: from, to: to)) != nil {
                try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: to.path)
                try? fm.removeItem(at: from)
                moved += 1
            }
        }
        if fd >= 0 { close(fd) }
        fd = -1
        day = ""
        directory = new
        try openFile(for: now())
        return moved
    }

    /// Keeps the last `days` days' files, now and at every day switch.
    public func setRetention(days: Int) {
        lock.lock()
        defer { lock.unlock() }
        retentionDays = days
        prune(now())
    }

    /// Caller holds the lock. Keeps this prefix's files of the last `retentionDays` days (AuditDays: today and the
    /// days before it, the export's days too) and deletes older ones; the name carries the day, so nothing else in
    /// the directory is touched.
    private func prune(_ date: Date) {
        guard let days = retentionDays,
              let cutoff = AuditDays.last(days, now: date, timeZone: dayFormatter.timeZone).last else { return }
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else { return }
        for name in names where name.hasPrefix(prefix + "-") && name.hasSuffix(".jsonl") {
            let d = String(name.dropFirst(prefix.count + 1).dropLast(6))
            guard d.count == cutoff.count, d < cutoff else { continue }
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
        }
    }

    /// Caller holds the lock. On failure the current file stays open.
    private func openFile(for date: Date) throws {
        let d = dayFormatter.string(from: date)
        guard d != day else { return }
        try StateDir.prepare(directory)
        let newFD = open(path(for: date).path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard newFD >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        if fd >= 0 { close(fd) }
        fd = newFD
        day = d
        prune(date)
    }

    public func record(_ entry: [String: JSONValue]) {
        let date = now()
        var e = entry
        e["ts"] = .string(formatter.string(from: date))
        var line = JSONCoding.encode(.object(e))
        line.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        // If the new day's file cannot be opened (e.g. something planted a symlink there), the entry still goes to
        // the previous file rather than being dropped; the switch is retried with the next entry.
        try? openFile(for: date)
        line.withUnsafeBytes { buf in
            var off = 0
            while off < buf.count {
                let n = write(fd, buf.baseAddress! + off, buf.count - off)
                if n < 0 && errno == EINTR { continue }
                if n <= 0 { return }
                off += n
            }
        }
    }
}

public final class MemoryAudit: AuditSink {
    private let lock = NSLock()
    private var _entries: [[String: JSONValue]] = []

    public init() {}

    public var entries: [[String: JSONValue]] {
        lock.lock()
        defer { lock.unlock() }
        return _entries
    }

    public func record(_ entry: [String: JSONValue]) {
        lock.lock()
        _entries.append(entry)
        lock.unlock()
    }
}
