import Foundation
@testable import CURuntimeCore

/// The owner check without LAContext. With `verdict` set, evaluate answers with it at once, on the calling thread;
/// with nil the check stays open until `finish(_:)`. `cancel()` is counted and, like LAContext.invalidate, reports
/// `verdictOnCancel` through the open completion (nil: reports nothing). Thread-safe.
final class FakeOwnerVerifier: OwnerVerifier, @unchecked Sendable {
    private let lock = NSLock()
    private var _verdict: OwnerVerdict?
    private var _verdictOnCancel: OwnerVerdict? = .cancelled
    private var _reasons: [String] = []
    private var _completions: [@Sendable (OwnerVerdict) -> Void] = []
    private var _open: (@Sendable (OwnerVerdict) -> Void)?
    private var _cancels = 0

    init(verdict: OwnerVerdict? = nil) { _verdict = verdict }

    var verdict: OwnerVerdict? {
        get { locked { _verdict } }
        set { locked { _verdict = newValue } }
    }
    var verdictOnCancel: OwnerVerdict? {
        get { locked { _verdictOnCancel } }
        set { locked { _verdictOnCancel = newValue } }
    }
    /// The reason text of every check shown, in order.
    var reasons: [String] { locked { _reasons } }
    /// Every completion handed over, in order (a test may call one again: a verifier that calls back twice).
    var completions: [@Sendable (OwnerVerdict) -> Void] { locked { _completions } }
    var cancels: Int { locked { _cancels } }
    /// Whether a check is shown and not finished.
    var isOpen: Bool { locked { _open != nil } }

    func evaluate(reason: String, completion: @escaping @Sendable (OwnerVerdict) -> Void) {
        let now: OwnerVerdict? = locked {
            _reasons.append(reason)
            _completions.append(completion)
            if _verdict == nil { _open = completion }
            return _verdict
        }
        if let now { completion(now) }
    }

    /// Ends the open check with `verdict`. Nothing open: does nothing.
    func finish(_ verdict: OwnerVerdict = .ok) {
        let c: (@Sendable (OwnerVerdict) -> Void)? = locked {
            defer { _open = nil }
            return _open
        }
        c?(verdict)
    }

    func cancel() {
        let (c, v): ((@Sendable (OwnerVerdict) -> Void)?, OwnerVerdict?) = locked {
            _cancels += 1
            defer { _open = nil }
            return (_open, _verdictOnCancel)
        }
        if let c, let v { c(v) }
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

/// The Mac's panels without AppKit: each panel answers with its scripted result and records the call. With `hold`
/// on, answers wait in `held` until `release()` (a panel the person is still looking at). Thread-safe.
final class FakeSettingsPanels: SettingsPanels, @unchecked Sendable {
    private let lock = NSLock()
    var directory: URL?
    var app: String?
    var saveSucceeds = true
    var openData: Data?
    var currentPermissions = SettingsPermissions(accessibility: true, screenRecording: true, inputMonitoring: nil)
    var names: [String: String] = [:]
    var hold = false

    private(set) var calls: [String] = []
    private(set) var saved: [(name: String, contents: Data)] = []
    private(set) var openedExtensions: [[String]] = []
    private(set) var revealed: [URL] = []
    private var held: [() -> Void] = []

    func chooseDirectory(completion: @escaping @Sendable (URL?) -> Void) {
        answer("chooseDirectory") { [directory] in completion(directory) }
    }

    func chooseApp(completion: @escaping @Sendable (String?) -> Void) {
        answer("chooseApp") { [app] in completion(app) }
    }

    func saveFile(suggestedName: String, contents: Data, completion: @escaping @Sendable (Bool) -> Void) {
        lock.lock()
        let ok = saveSucceeds
        if ok { saved.append((suggestedName, contents)) }
        lock.unlock()
        answer("saveFile") { completion(ok) }
    }

    func openFile(allowedExtensions: [String], completion: @escaping @Sendable (Data?) -> Void) {
        lock.lock()
        openedExtensions.append(allowedExtensions)
        lock.unlock()
        answer("openFile") { [openData] in completion(openData) }
    }

    func reveal(_ url: URL) {
        lock.lock()
        calls.append("reveal")
        revealed.append(url)
        lock.unlock()
    }

    func permissions() -> SettingsPermissions {
        lock.lock()
        defer { lock.unlock() }
        return currentPermissions
    }

    func appName(_ bundleID: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return names[bundleID]
    }

    /// Delivers every held answer, in order.
    func release() {
        lock.lock()
        let all = held
        held = []
        lock.unlock()
        all.forEach { $0() }
    }

    private func answer(_ call: String, _ deliver: @escaping () -> Void) {
        lock.lock()
        calls.append(call)
        let wait = hold
        if wait { held.append(deliver) }
        lock.unlock()
        if !wait { deliver() }
    }
}
