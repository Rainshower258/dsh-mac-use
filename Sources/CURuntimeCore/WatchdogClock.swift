import Foundation

/// Time source for the request watchdog and shutdown wait. Injected so tests advance time by hand and
/// never depend on how fast the machine happens to be.
public protocol WatchdogClock: AnyObject {
    /// With `cond` locked by the caller: waits until `ready()` or until `timeout` of this clock's time has
    /// passed. Returns `ready()`.
    func wait(on cond: NSCondition, timeout: TimeInterval, until ready: () -> Bool) -> Bool
}

public final class SystemWatchdogClock: WatchdogClock {
    public init() {}

    public func wait(on cond: NSCondition, timeout: TimeInterval, until ready: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !ready() {
            if !cond.wait(until: deadline) { return ready() }
        }
        return true
    }
}

/// Test clock: time moves only when `advance(by:)` is called.
public final class ManualWatchdogClock: WatchdogClock {
    private let lock = NSLock()
    private var now: TimeInterval = 0
    private var waiting: [NSCondition] = []

    public init() {}

    /// Number of threads currently blocked in `wait`.
    public var waiterCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return waiting.count
    }

    public func advance(by seconds: TimeInterval) {
        lock.lock()
        now += seconds
        let conds = waiting
        lock.unlock()
        for c in conds {
            c.lock()
            c.broadcast()
            c.unlock()
        }
    }

    public func wait(on cond: NSCondition, timeout: TimeInterval, until ready: () -> Bool) -> Bool {
        lock.lock()
        let start = now
        waiting.append(cond)
        lock.unlock()
        defer {
            lock.lock()
            if let i = waiting.firstIndex(where: { $0 === cond }) { waiting.remove(at: i) }
            lock.unlock()
        }
        while !ready() {
            lock.lock()
            let expired = now - start >= timeout
            lock.unlock()
            if expired { return false }
            cond.wait()
        }
        return true
    }
}

/// A result slot that a worker fills and a watchdog waits on.
final class Pending<T>: @unchecked Sendable {
    let cond = NSCondition()
    private(set) var value: T?

    func complete(_ v: T) {
        cond.lock()
        value = v
        cond.broadcast()
        cond.unlock()
    }

    /// Nil when the clock ran out first.
    func await(_ clock: WatchdogClock, timeout: TimeInterval) -> T? {
        cond.lock()
        defer { cond.unlock() }
        return clock.wait(on: cond, timeout: timeout, until: { value != nil }) ? value : nil
    }
}
