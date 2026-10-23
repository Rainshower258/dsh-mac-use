import Foundation

/// Apps' display names by bundle ID, for the settings snapshot. Every snapshot names the
/// hard-denied apps and every grant, always and deny entry, and the page asks for one each second while a change is
/// pending or a panel is open; on the Mac each lookup is LaunchServices behind two main-thread hops. The names do not
/// change while the daemon runs, so one lookup serves `ttl` seconds.
///
/// - Keyed by the lowercased bundle ID (bundle IDs are case-insensitive): `com.Apple.TextEdit` and
///   `com.apple.textedit` share one entry.
/// - A found name and a not-found answer (nil) are both kept, each for `ttl` seconds from its lookup by `now`; after
///   that the next call looks up again and keeps the new answer. An answer kept at a time after `now` (the clock went
///   back) counts as expired.
/// - Thread-safe: any thread may call `name`. The lookup runs outside the lock (it may wait on the main thread), so two
///   calls that miss at the same time may both look up; the later answer is kept.
/// - Only names: nothing else about an app (its signature, its permissions) is cached here.
public final class AppNameCache: @unchecked Sendable {
    public let ttl: TimeInterval
    private let now: @Sendable () -> Date
    private let lock = NSLock()
    private var entries: [String: (name: String?, at: Date)] = [:]

    public init(ttl: TimeInterval = 60, now: @escaping @Sendable () -> Date = { Date() }) {
        self.ttl = ttl
        self.now = now
    }

    /// The name of `bundleID`: the kept answer while it is younger than `ttl`, else `lookup(bundleID)`'s, kept from now.
    public func name(_ bundleID: String, lookup: (String) -> String?) -> String? {
        let key = bundleID.lowercased()
        let t = now()
        lock.lock()
        if let e = entries[key], t.timeIntervalSince(e.at) < ttl, t >= e.at {
            lock.unlock()
            return e.name
        }
        lock.unlock()
        let found = lookup(bundleID)
        lock.lock()
        entries[key] = (found, t)
        lock.unlock()
        return found
    }
}
