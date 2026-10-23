import CURuntimeCore
import Foundation
import LocalAuthentication

/// A value behind a lock, for state that more than one thread reads or writes (the approval dialog's open count, a
/// verdict waited for on the main run loop, the check in progress).
final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value

    init(_ value: Value) { stored = value }

    /// The value now.
    var value: Value { withLock { $0 } }

    /// Runs `body` on the value with the lock held; `body` must not call back into this object.
    func withLock<R>(_ body: (inout Value) -> R) -> R {
        lock.lock()
        defer { lock.unlock() }
        return body(&stored)
    }
}

/// The system's owner check for OwnerCheck (C-C): LAContext with `.deviceOwnerAuthentication`, so Touch ID, an
/// Apple Watch or the account password, through the system's own prompt, which also appears for this accessory
/// (LSUIElement) app. Only OwnerCheck calls it, one check at a time.
///
/// - `evaluate` uses a new context per check and calls its completion exactly once, on LAContext's queue (or on the
///   caller's thread when the check cannot run at all): ok when the person passed it; cancelled when the person, the
///   system or `cancel()` ended it; unavailable when this Mac cannot run it (no password set, no biometrics and no
///   password fallback, not interactive), or the context refused at once; failed otherwise (wrong finger or password
///   too often).
/// - `cancel()` invalidates the context in progress, which closes its prompt; its completion then reports cancelled
///   (OwnerCheck has already reported cancelled to its caller and drops it). A cancel that finds no check in
///   progress is held for `earlyCancelWindow`: OwnerCheck calls `evaluate` just after releasing its lock, so its
///   cancel can overtake the start, and the check that then starts reports cancelled without a prompt. It cannot hit
///   a later check: OwnerCheck only cancels a check it had in flight, and the cool-down that follows (10 s) is longer.
///
/// The reason text is shown by the system only ("CURuntime is trying to <reason>"); it is never logged here.
final class MacOwnerVerifier: OwnerVerifier, @unchecked Sendable {
    /// How long a cancel that found no check in progress waits for the start it overtook (seconds of uptime).
    static let earlyCancelWindow: TimeInterval = 1

    /// The context of the check in progress (nil between checks) and an early cancel's time (uptime), under one lock.
    private struct State {
        var context: LAContext?
        var earlyCancel: TimeInterval?
    }
    private let state = Locked(State())

    func evaluate(reason: String, completion: @escaping @Sendable (OwnerVerdict) -> Void) {
        let fired = Locked(false)
        let once: @Sendable (OwnerVerdict) -> Void = { verdict in
            guard fired.withLock({ f in defer { f = true }; return !f }) else { return }
            completion(verdict)
        }
        let ctx = LAContext()
        let overtaken = state.withLock { s -> Bool in
            defer { s.earlyCancel = nil }
            if let t = s.earlyCancel, ProcessInfo.processInfo.systemUptime - t < Self.earlyCancelWindow { return true }
            s.context = ctx
            return false
        }
        guard !overtaken else { once(.cancelled); return }
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
            once(.unavailable)
            finish(ctx)
            return
        }
        // Invalidated meanwhile (cancel): evaluatePolicy then fails at once with invalidContext, i.e. cancelled.
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { [weak self] ok, error in
            once(ok ? .ok : Self.verdict(error))
            self?.finish(ctx)
        }
    }

    func cancel() {
        let ctx = state.withLock { s -> LAContext? in
            guard let c = s.context else { s.earlyCancel = ProcessInfo.processInfo.systemUptime; return nil }
            s.context = nil
            return c
        }
        ctx?.invalidate()
    }

    /// The check with `ctx` is over (after its completion, so a cancel racing the verdict still finds it in progress
    /// and is not held for the next check).
    private func finish(_ ctx: LAContext) {
        state.withLock { s in if s.context === ctx { s.context = nil } }
    }

    /// The verdict for a check that did not pass, from LAContext's error.
    static func verdict(_ error: Error?) -> OwnerVerdict {
        guard let code = (error as? LAError)?.code else { return .failed }
        switch code {
        case .userCancel, .systemCancel, .appCancel, .invalidContext:
            return .cancelled
        case .passcodeNotSet, .biometryNotAvailable, .biometryNotEnrolled, .notInteractive:
            return .unavailable
        default:
            return .failed
        }
    }
}
