import Foundation

/// After switching Electron's AXManualAccessibility on, Chromium builds the AX tree asynchronously. Reading
/// immediately returns a partial tree, and the node count can sit at the old value for a moment, which
/// looks "stable" too. So: take a baseline before switching, then poll until the count has left the baseline
/// (by at least `minGrowth` nodes: QQ wobbles 12 -> 13 on its own) and held still for `stableReads` reads. If it
/// never leaves the baseline within `unchangedGrace` (the switch has no effect on this app), accept a still count
/// after the grace period. Give up after `timeout`. QQ on the host takes 2-5 s to hand over its tree (2026-10-09:
/// a 1.5 s grace missed it on all 5 first switches), so the grace is 5 s; apps that refuse the attribute (native
/// ones) never get here.
public enum AXSettle {
    public struct Params: Sendable, Equatable {
        public var interval: TimeInterval = 0.25
        public var stableReads = 3
        public var minGrowth = 3
        public var unchangedGrace: TimeInterval = 5
        public var timeout: TimeInterval = 8
        public init() {}
    }

    public struct Outcome: Sendable, Equatable {
        public enum Reason: String, Sendable { case grewAndSettled = "grew_and_settled", unchanged, timeout }
        public let reason: Reason
        public let baseline: Int
        public let nodes: Int
        public let reads: Int
        public let elapsed: TimeInterval
        public var settled: Bool { reason != .timeout }
    }

    public static func wait(baseline: Int, params: Params = Params(), count: () -> Int,
                            sleep: (TimeInterval) -> Void) -> Outcome {
        var elapsed: TimeInterval = 0, reads = 0, last = -1, same = 0, left = false
        while true {
            let n = count()
            reads += 1
            if abs(n - baseline) >= params.minGrowth { left = true }
            same = n == last ? same + 1 : 1
            last = n
            if same >= params.stableReads {
                if left { return Outcome(reason: .grewAndSettled, baseline: baseline, nodes: n, reads: reads, elapsed: elapsed) }
                if elapsed >= params.unchangedGrace {
                    return Outcome(reason: .unchanged, baseline: baseline, nodes: n, reads: reads, elapsed: elapsed)
                }
            }
            if elapsed >= params.timeout { return Outcome(reason: .timeout, baseline: baseline, nodes: n, reads: reads, elapsed: elapsed) }
            sleep(params.interval)
            elapsed += params.interval
        }
    }
}
