import Foundation

/// How the system's owner check (Touch ID or the account password) ended.
public enum OwnerVerdict: String, Sendable { case ok, failed, cancelled, unavailable }

/// The system's owner check (main: LAContext `.deviceOwnerAuthentication`; tests: a fake). Only OwnerCheck calls it.
public protocol OwnerVerifier: AnyObject {
    /// Shows the system's owner check (Touch ID or password) with `reason`; completion once, on any thread.
    func evaluate(reason: String, completion: @escaping @Sendable (OwnerVerdict) -> Void)
    /// Ends a check in progress (its completion then reports cancelled).
    func cancel()
}

/// What OwnerCheck.begin did: started a check, or why not.
public enum OwnerCheckStart: Equatable, Sendable { case started, busy, cooldown(until: Date), unavailable, approvalOpen }

/// The daemon's one gate for the owner check: the only source of `verified: true` on the socket path,
/// shared by the settings window, the settings socket methods and the approval dialog's owner check. One check at a
/// time for the whole daemon: two system checks open at once cancel each other (VM test, 2026-10-17, LAError -4), and
/// that change was lost without the person noticing.
///
/// - A start is refused, in this order, with no verifier (`unavailable`), while a check is in flight (`busy`), during
///   the cool-down after a failed, cancelled or unavailable verdict (`cooldown(until:)`, refused while now < until;
///   it keeps repeated prompts from training people to tap through them) or while an approval dialog is open
///   (`approvalOpen`). An ok verdict starts no cool-down.
/// - The completion is called exactly once per started check, on any thread, possibly before `begin` returns (a
///   verifier that answers at once): a verifier that calls back twice, or late after `cancel()`, is ignored.
/// - Audit: one `settings.verify` line per refused start (`decision` deny, `stage` start, `detail` busy, cooldown,
///   unavailable or approval_open) and per verdict (`decision` allow for ok else deny, `stage` verdict, `detail` the
///   verdict); both carry `purpose`. The reason text is never audited: it names the change for the person only.
///
/// Thread-safe: one lock guards the state; the verifier, the audit, `approvalOpen` and the completion are called with
/// the lock released, so any of them may call back into this object (the clock `now` is called with it held).
public final class OwnerCheck: @unchecked Sendable {
    private let verifier: OwnerVerifier?
    private let audit: AuditSink
    private let now: () -> Date
    private let cooldown: TimeInterval
    private let approvalOpen: () -> Bool

    private let lock = NSLock()
    /// The check in flight: its number (a verdict for any other number is stale and dropped), purpose and completion.
    private var current: (id: UInt64, purpose: String, completion: @Sendable (OwnerVerdict) -> Void)?
    private var lastID: UInt64 = 0
    /// Starts are refused until then (after a verdict other than ok).
    private var cooldownUntil: Date?

    /// `now` is the clock for the cool-down; `approvalOpen` says whether an approval dialog is up (thread-safe; it is
    /// called on the thread of `begin`).
    public init(verifier: OwnerVerifier?, audit: AuditSink, now: @escaping () -> Date = Date.init,
                cooldown: TimeInterval = 10, approvalOpen: @escaping () -> Bool = { false }) {
        self.verifier = verifier
        self.audit = audit
        self.now = now
        self.cooldown = cooldown
        self.approvalOpen = approvalOpen
    }

    /// Starts a check unless one is in flight (busy), the cool-down after a failed/cancelled/unavailable check is
    /// running (cooldown), there is no verifier (unavailable) or an approval dialog is open (approvalOpen).
    /// `purpose` is a short machine label for the audit (e.g. "settings.apply deny.remove").
    /// The completion is called only when this returns `.started` (it may already have been).
    public func begin(reason: String, purpose: String,
                      completion: @escaping @Sendable (OwnerVerdict) -> Void) -> OwnerCheckStart {
        let dialogOpen = approvalOpen()
        lock.lock()
        let refusal: OwnerCheckStart?
        let at = now()
        if verifier == nil {
            refusal = .unavailable
        } else if current != nil {
            refusal = .busy
        } else if let until = cooldownUntil, at < until {
            refusal = .cooldown(until: until)
        } else if dialogOpen {
            refusal = .approvalOpen
        } else {
            refusal = nil
        }
        guard refusal == nil, let verifier else {
            lock.unlock()
            let start = refusal ?? .unavailable
            audit.record(["method": "settings.verify", "decision": "deny", "stage": "start", "purpose": .string(purpose),
                          "detail": .string(Self.label(start))])
            return start
        }
        lastID += 1
        let id = lastID
        current = (id, purpose, completion)
        cooldownUntil = nil
        lock.unlock()
        // Held strongly until the verifier lets go of the completion: the verdict must reach the caller.
        verifier.evaluate(reason: reason) { verdict in self.settle(id, verdict) }
        return .started
    }

    /// Whether a check is in flight (started, no verdict yet).
    public var inFlight: Bool {
        lock.lock()
        defer { lock.unlock() }
        return current != nil
    }

    /// Ends the check in flight: its verdict is cancelled at once (with the cool-down, so no new check can start
    /// before the verifier has been told), the verifier is told to close its prompt, and whatever the verifier reports
    /// afterwards is dropped. Nothing in flight: does nothing (the verifier is not told).
    public func cancel() {
        lock.lock()
        let c = current.flatMap { take($0.id, .cancelled) }
        lock.unlock()
        guard let c else { return }
        verifier?.cancel()
        deliver(c, .cancelled)
    }

    /// The verdict of check `id`: delivered once if it is the check in flight, else dropped.
    private func settle(_ id: UInt64, _ verdict: OwnerVerdict) {
        lock.lock()
        let c = take(id, verdict)
        lock.unlock()
        if let c { deliver(c, verdict) }
    }

    /// Ends check `id` if it is the one in flight, starting the cool-down unless the verdict is ok; nil otherwise.
    /// Call with the lock held.
    private func take(_ id: UInt64, _ verdict: OwnerVerdict) -> (purpose: String, completion: @Sendable (OwnerVerdict) -> Void)? {
        guard let c = current, c.id == id else { return nil }
        current = nil
        if verdict != .ok { cooldownUntil = now().addingTimeInterval(cooldown) }
        return (c.purpose, c.completion)
    }

    /// Audits a verdict and hands it to the caller. Call with the lock released.
    private func deliver(_ c: (purpose: String, completion: @Sendable (OwnerVerdict) -> Void), _ verdict: OwnerVerdict) {
        audit.record(["method": "settings.verify", "decision": verdict == .ok ? "allow" : "deny", "stage": "verdict",
                      "purpose": .string(c.purpose), "detail": .string(verdict.rawValue)])
        c.completion(verdict)
    }

    /// The audit's word for a refused start.
    static func label(_ start: OwnerCheckStart) -> String {
        switch start {
        case .started: return "started"
        case .busy: return "busy"
        case .cooldown: return "cooldown"
        case .unavailable: return "unavailable"
        case .approvalOpen: return "approval_open"
        }
    }
}
