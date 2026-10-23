import Darwin
import Foundation

/// System state this daemon changed outside the granted app's content (SystemStateChanges), persisted *before* each
/// change. If the daemon crashes or is killed, the next start reads it and restores what is still restorable.
/// One entry per (kind, target): `electron_ax` per app, `input_source` for the whole system.
public protocol StateLedger: AnyObject {
    func entries() -> [StateEntry]
    func record(_ entry: StateEntry)
    func remove(kind: String, target: String)
}

public struct StateEntry: Codable, Equatable, Sendable {
    public let kind: String
    /// A lowercased bundle ID, or "system" for global state.
    public let target: String
    /// The value to restore (input_source: the source ID before the change); nil where "off" is implied.
    public let original: String?
    /// The value this daemon set (input_source: restore only if it is still this, i.e. nobody changed it since).
    public let applied: String?
    /// Processes the change applies to (electron_ax: the attribute dies with them); empty for global state.
    public let pids: [Int32]
    public let setAt: Date

    public init(kind: String, target: String, original: String? = nil, applied: String? = nil, pids: [Int32] = [], setAt: Date) {
        self.kind = kind
        self.target = target
        self.original = original
        self.applied = applied
        self.pids = pids
        self.setAt = setAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Entries written before the generic ledger (ax-manual.json) had only app, pids and setAt.
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? SystemStateChanges.electronAX
        target = try c.decodeIfPresent(String.self, forKey: .target) ?? c.decode(String.self, forKey: .app)
        original = try c.decodeIfPresent(String.self, forKey: .original)
        applied = try c.decodeIfPresent(String.self, forKey: .applied)
        pids = try c.decodeIfPresent([Int32].self, forKey: .pids) ?? []
        setAt = try c.decode(Date.self, forKey: .setAt)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        try c.encode(target, forKey: .target)
        try c.encodeIfPresent(original, forKey: .original)
        try c.encodeIfPresent(applied, forKey: .applied)
        try c.encode(pids, forKey: .pids)
        try c.encode(setAt, forKey: .setAt)
    }

    private enum CodingKeys: String, CodingKey { case kind, target, original, applied, pids, setAt, app }
}

/// `<stateDir>/state-changes.json`, 0600, replaced atomically. The state dir itself is checked by StateDir.
/// A leftover `ax-manual.json` (the M3 ledger before it became generic) is folded in on first read.
public final class FileStateLedger: StateLedger {
    private let url: URL
    private let legacy: URL

    public init(stateDir: URL) {
        url = stateDir.appendingPathComponent("state-changes.json")
        legacy = stateDir.appendingPathComponent("ax-manual.json")
    }

    public func entries() -> [StateEntry] {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        var list = (try? Data(contentsOf: url)).flatMap { try? decoder.decode([StateEntry].self, from: $0) } ?? []
        if let data = try? Data(contentsOf: legacy), let old = try? decoder.decode([StateEntry].self, from: data) {
            list += old.filter { o in !list.contains { $0.kind == o.kind && $0.target == o.target } }
            write(list)
            unlink(legacy.path)
        }
        return list
    }

    public func record(_ entry: StateEntry) {
        write(entries().filter { !($0.kind == entry.kind && $0.target == entry.target) } + [entry])
    }

    public func remove(kind: String, target: String) {
        let rest = entries().filter { !($0.kind == kind && $0.target == target) }
        if rest.isEmpty { unlink(url.path) } else { write(rest) }
    }

    private func write(_ list: [StateEntry]) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        guard let data = try? encoder.encode(list) else { return }
        let tmp = url.path + ".tmp"
        unlink(tmp)
        let fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return }
        let ok = Server.writeAll(fd, data)
        close(fd)
        if ok { rename(tmp, url.path) } else { unlink(tmp) }
    }
}

public final class MemoryStateLedger: StateLedger {
    public private(set) var list: [StateEntry] = []
    public init(_ list: [StateEntry] = []) { self.list = list }
    public func entries() -> [StateEntry] { list }
    public func record(_ entry: StateEntry) {
        list = list.filter { !($0.kind == entry.kind && $0.target == entry.target) } + [entry]
    }
    public func remove(kind: String, target: String) { list.removeAll { $0.kind == kind && $0.target == target } }
}
