import Foundation

/// A granted app that is running and not hidden but has no on-screen window has usually just launched or been
/// activated: the window server listed a new window up to ~2 s after the app itself reported it visible (geometry
/// suite, 2026-09-29). cu_observe waits for it, bounded, instead of returning an empty window list. An app still
/// windowless after one full wait (all windows closed, a menu-bar app) is remembered by pid and not waited for again
/// until it shows a window, so it costs the wait once, not on every observe. A relaunch has a new pid and is waited
/// for again. The wait is reported in the observe output, never hidden.
public struct WindowAppearWait: Sendable {
    public struct App: Hashable, Sendable {
        public let bundleID: String
        public let pid: Int32
        public init(bundleID: String, pid: Int32) {
            self.bundleID = bundleID.lowercased()
            self.pid = pid
        }
    }

    public struct Params: Sendable, Equatable {
        public var interval: TimeInterval = 0.1
        public var timeout: TimeInterval = 2.5
        public init() {}
    }

    public struct Outcome: Sendable, Equatable {
        /// Apps waited for (0 when nothing was pending).
        public let waitedFor: Int
        public let elapsed: TimeInterval
        /// Apps that still had no window when the wait ended; they are not waited for again.
        public let gaveUp: [String]
    }

    public private(set) var windowless: Set<App> = []
    public let params: Params

    public init(params: Params = Params()) {
        self.params = params
    }

    /// candidates: granted apps that are running and not hidden. listed: bundle IDs that currently have at least one
    /// granted on-screen window.
    public mutating func wait(candidates: Set<App>, listed: () -> Set<String>,
                              sleep: (TimeInterval) -> Void) -> Outcome {
        var have = listed()
        // Forget apps that showed a window since, quit, or were hidden (they are waited for again next time).
        windowless = windowless.filter { candidates.contains($0) && !have.contains($0.bundleID) }
        var pending = candidates.filter { !have.contains($0.bundleID) && !windowless.contains($0) }
        let waitedFor = pending.count
        var elapsed: TimeInterval = 0
        while !pending.isEmpty && elapsed < params.timeout {
            sleep(params.interval)
            elapsed += params.interval
            have = listed()
            pending = pending.filter { !have.contains($0.bundleID) }
        }
        windowless.formUnion(pending)
        return Outcome(waitedFor: waitedFor, elapsed: elapsed, gaveUp: pending.map(\.bundleID).sorted())
    }
}
