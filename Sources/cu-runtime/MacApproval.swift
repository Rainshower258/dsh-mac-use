import AppKit
import CURuntimeCore
import Security

/// Apps as LaunchServices and the code-signing system know them (AppDirectory). The dialog shows what this
/// resolves, never the model's string.
final class MacAppDirectory: AppDirectory {
    /// The folders an app name is looked up in, besides the running apps. The user's own ~/Applications is the one in
    /// the home the user database gives (LaunchPolicy.userHomeDirectory, as for the state directory), not Foundation's
    /// home, which follows CFFIXED_USER_HOME: an environment set at launch (`open --env`) cannot add a folder of its
    /// choosing to the places a name in an approval request or `grants revoke` resolves in.
    static let appFolders: [String] = [
        "/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
    ] + [LaunchPolicy.userHomeDirectory()?.appendingPathComponent("Applications").path].compactMap { $0 }

    private func onMain<T>(_ body: () -> T) -> T {
        Thread.isMainThread ? body() : DispatchQueue.main.sync(execute: body)
    }

    func identity(bundleID: String) -> AppIdentity? {
        let running = onMain {
            NSWorkspace.shared.runningApplications.first {
                $0.bundleIdentifier?.caseInsensitiveCompare(bundleID) == .orderedSame && $0.bundleURL != nil
            }?.bundleURL
        }
        guard let url = running ?? onMain({ NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) })
        else { return nil }
        return Self.identity(at: url)
    }

    func identities(named name: String) -> [AppIdentity] {
        let key = Self.key(name)
        guard !key.isEmpty else { return [] }
        var urls: [URL] = onMain {
            NSWorkspace.shared.runningApplications.filter { app in
                [app.localizedName].compactMap { $0 }.contains { Self.key($0) == key }
            }.compactMap(\.bundleURL)
        }
        for folder in Self.appFolders {
            let items = (try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []
            for item in items where item.hasSuffix(".app") {
                let url = URL(fileURLWithPath: folder).appendingPathComponent(item)
                if Self.names(at: url).contains(where: { Self.key($0) == key }) { urls.append(url) }
            }
        }
        var seen = Set<String>()
        return urls.compactMap(Self.identity(at:)).filter { seen.insert($0.bundleID.lowercased()).inserted }
    }

    func similarIdentities(to name: String, limit: Int) -> [AppIdentity] {
        guard !AppNameMatch.key(name).isEmpty, limit > 0 else { return [] }
        var urls: [URL] = onMain {
            NSWorkspace.shared.runningApplications.filter { app in
                [app.localizedName].compactMap { $0 }.contains { AppNameMatch.isSimilar($0, to: name) }
            }.compactMap(\.bundleURL)
        }
        for folder in Self.appFolders {
            let items = (try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []
            for item in items where item.hasSuffix(".app") {
                let url = URL(fileURLWithPath: folder).appendingPathComponent(item)
                if Self.names(at: url).contains(where: { AppNameMatch.isSimilar($0, to: name) }) { urls.append(url) }
            }
        }
        var seen = Set<String>()
        return Array(urls.compactMap(Self.identity(at:)).filter { seen.insert($0.bundleID.lowercased()).inserted }.prefix(limit))
    }

    func designatedRequirement(path: String) -> String? {
        guard let code = Self.staticCode(path), Self.valid(code, nil) else { return nil }
        var req: SecRequirement?
        guard SecCodeCopyDesignatedRequirement(code, [], &req) == errSecSuccess, let req else { return nil }
        var text: CFString?
        guard SecRequirementCopyString(req, [], &text) == errSecSuccess, let text else { return nil }
        return text as String
    }

    func satisfies(path: String, requirement: String) -> Bool {
        guard let code = Self.staticCode(path) else { return false }
        var req: SecRequirement?
        guard SecRequirementCreateWithString(requirement as CFString, [], &req) == errSecSuccess, let req else { return false }
        return Self.valid(code, req)
    }

    // MARK: helpers

    private static func staticCode(_ path: String) -> SecStaticCode? {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code) == errSecSuccess else { return nil }
        return code
    }

    /// The signature is intact (resources not re-hashed: a large app would take seconds) and, if given, the code
    /// satisfies the requirement.
    private static func valid(_ code: SecStaticCode, _ req: SecRequirement?) -> Bool {
        SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSDoNotValidateResources), req) == errSecSuccess
    }

    static func identity(at url: URL) -> AppIdentity? {
        guard let id = Bundle(url: url)?.bundleIdentifier else { return nil }
        var name = FileManager.default.displayName(atPath: url.path)
        if name.hasSuffix(".app") { name = String(name.dropLast(4)) }
        return AppIdentity(bundleID: id, name: name, path: url.path)
    }

    private static func names(at url: URL) -> [String] {
        var names = [url.deletingPathExtension().lastPathComponent, FileManager.default.displayName(atPath: url.path)]
        if let bundle = Bundle(url: url) {
            for key in ["CFBundleDisplayName", "CFBundleName"] {
                if let n = bundle.localizedInfoDictionary?[key] as? String { names.append(n) }
                if let n = bundle.infoDictionary?[key] as? String { names.append(n) }
            }
        }
        return names.map { $0.hasSuffix(".app") ? String($0.dropLast(4)) : $0 }
    }

    private static func key(_ s: String) -> String {
        s.precomposedStringWithCanonicalMapping.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

/// The approval dialog: a native alert of this daemon. The daemon is hard-denied, so the model can neither see this
/// window (other apps' windows are grey blocks in observe) nor click it (the hit test names this daemon).
///
/// It runs from a main run-loop block, not from a main-queue block: while it is open, the main queue must keep
/// serving the worker's `DispatchQueue.main.sync` calls (NSWorkspace, TIS), which the modal loop does in its mode.
///
/// The dialog activates the daemon, and the daemon is hard-denied: left frontmost, it stops the very action the
/// approval was for (hard_denied_frontmost, 2026-10-03 QQ run). So the app that was frontmost before gets the focus
/// back, and the answer goes out only once the daemon is no longer frontmost (or the wait ran out).
///
/// Activating the daemon also brought its settings window forward, and it never went back (2026-10-16): it stands
/// aside while the dialog is open (ordered out when it was behind another app's window), and is put back where the
/// dialog found it (SettingsNSWindow, WindowPutBack).
///
/// From `present` until the person has answered (the dialog's modal loop returned), `open` counts the dialog: the
/// daemon's owner check (OwnerCheck's `approvalOpen`) refuses to start meanwhile, so no Touch ID prompt of the
/// settings comes up over a dialog. The dialog's own owner check for "always" with full access goes through the same
/// OwnerCheck once the dialog has closed: one gate and one cool-down for the whole daemon.
final class MacApprovalPresenter: ApprovalPresenter {
    /// How long to wait for the focus to leave the daemon after the dialog closed.
    static let focusWait: TimeInterval = 1
    /// How long the dialog's owner check may stay open before it is cancelled.
    static let ownerCheckWait: TimeInterval = 120

    /// The daemon's owner check (the same object as Dispatcher.ownerCheck); nil: "always" with full access cannot be
    /// verified and is held for this session.
    private let ownerCheck: OwnerCheck?
    /// The dialogs asked for and not yet answered (thread-safe; OwnerCheck reads it on any thread).
    private let open: Locked<Int>

    init(ownerCheck: OwnerCheck?, open: Locked<Int>) {
        self.ownerCheck = ownerCheck
        self.open = open
    }

    func present(_ request: DialogRequest,
                 completion: @escaping @Sendable (DialogAnswer, DialogFocus?, DialogWindows?) -> Void) {
        open.withLock { $0 += 1 }
        let (open, ownerCheck) = (open, ownerCheck)
        RunLoop.main.perform(inModes: [.default]) {
            let (answer, focus, windows) = MainActor.assumeIsolated {
                let previous = Self.frontmostOther()
                let settings = SettingsWindowController.shared
                settings?.standAside()
                let answer = Self.run(request, ownerCheck: ownerCheck) { open.withLock { $0 -= 1 } }
                // One more turn: AppKit finishes closing the dialog (or the Touch ID sheet after it).
                RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
                // Put back twice: what closing the dialog moved, before the earlier app comes forward over it; then
                // what the hand-back moved.
                let movedByDialog = settings?.putBack() ?? false
                let focus = Self.handBack(to: previous, keepWindows: settings?.onScreen ?? false)
                let movedByHandBack = settings?.putBack() ?? false
                settings?.endAside()
                return (answer, focus, movedByDialog || movedByHandBack ? DialogWindows.restored : .untouched)
            }
            completion(answer, focus, windows)
        }
    }

    /// The frontmost app, unless it is this daemon (then there is nothing to hand back to).
    @MainActor
    private static func frontmostOther() -> NSRunningApplication? {
        guard let app = NSWorkspace.shared.frontmostApplication,
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return nil }
        return app
    }

    /// Gives the focus back to `previous` (or hides the daemon without one), then waits, turning the main run loop so
    /// NSWorkspace sees the change, until the daemon is no longer frontmost. A hard-denied `previous` (a terminal)
    /// gets it back too: the actions that then stop are stopped for the right reason.
    ///
    /// With the settings window on screen or set aside for the dialog (`keepWindows`) the daemon is never hidden,
    /// which would hide the window too. Without `previous` the person was using the window: the daemon stays in front, and the next action is
    /// refused as it would have been before the dialog.
    @MainActor
    private static func handBack(to previous: NSRunningApplication?, keepWindows: Bool) -> DialogFocus {
        let me = ProcessInfo.processInfo.processIdentifier
        if let previous, !previous.isTerminated {
            NSApp.yieldActivation(to: previous)
            if !previous.activate(), !keepWindows { NSApp.hide(nil) }
        } else if keepWindows {
            return NSWorkspace.shared.frontmostApplication?.processIdentifier == me ? .failed : .hidden
        } else {
            NSApp.hide(nil)
        }
        let deadline = Date().addingTimeInterval(focusWait)
        while NSWorkspace.shared.frontmostApplication?.processIdentifier == me, Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == me { return .failed }
        guard let previous else { return .hidden }
        return NSWorkspace.shared.frontmostApplication?.processIdentifier == previous.processIdentifier ? .restored : .hidden
    }

    /// Shows the dialog and returns the answer; `answered` is called once, as soon as its modal loop has returned
    /// (before the owner check for "always" with full access).
    @MainActor
    private static func run(_ r: DialogRequest, ownerCheck: OwnerCheck?, answered: () -> Void) -> DialogAnswer {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.icon = NSWorkspace.shared.icon(forFile: r.identity.path)
        let text = ApprovalText(r)
        alert.messageText = text.title
        alert.informativeText = text.lines.joined(separator: "\n")
        // Return presses the button the settings name (refuse unless the user chose otherwise, behind the owner
        // check); "always" when it is not offered falls back to "this session". Buttons: refuse, turn, session, always.
        for title in text.buttons { alert.addButton(withTitle: title) }
        var defaultIndex: Int
        switch r.defaultAnswer {
        case .turn: defaultIndex = 1
        case .session: defaultIndex = 2
        case .always: defaultIndex = 3
        default: defaultIndex = 0
        }
        if defaultIndex >= alert.buttons.count { defaultIndex = 2 }
        for (i, b) in alert.buttons.enumerated() { b.keyEquivalent = i == defaultIndex ? "\r" : "" }

        // A live countdown (2026-10-09: a static "120 s" line did not say how much was left).
        let deadline = Date().addingTimeInterval(r.timeout)
        let countdown = NSTextField(labelWithString: "")
        countdown.font = .monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .semibold)
        countdown.textColor = .systemRed
        func tick() { countdown.stringValue = text.countdown(max(0, Int(deadline.timeIntervalSinceNow.rounded(.up)))) }
        tick()
        countdown.sizeToFit()
        countdown.frame.size.width = 260
        alert.accessoryView = countdown
        let timer = Timer(timeInterval: 1, repeats: true) { t in
            MainActor.assumeIsolated {
                tick()
                if Date() >= deadline { t.invalidate(); NSApp.abortModal() }
            }
        }
        RunLoop.main.add(timer, forMode: .modalPanel)
        // Activated the old way: without other apps yielding, neither `NSApp.activate()` nor activating without all
        // windows made the daemon active (2026-10-20: the keys stayed with the app in front, so Return would have
        // gone there). Any activation brings the settings window along, so it is out of sight meanwhile (standAside).
        NSApp.activate(ignoringOtherApps: true)
        alert.window.level = .modalPanel
        let response = alert.runModal()
        timer.invalidate()
        answered()
        switch response {
        case .abort: return .timeout
        case .alertSecondButtonReturn: return .turn
        case .alertThirdButtonReturn: return .session
        case NSApplication.ModalResponse(rawValue: NSApplication.ModalResponse.alertThirdButtonReturn.rawValue + 1):
            guard r.offerAlways else { return .deny }
            // A permanent full grant is a widening, and widenings pass the device owner check (as every
            // loosening of the settings does): not passed, the approval still holds for this session.
            if r.mode == .full, !verifyOwner(r, ownerCheck) { return .session }
            return .always
        default: return .deny
        }
    }

    /// The owner check for "always" with full access, through the daemon's one gate (OwnerCheck: Touch ID or the
    /// login password, in the system's own prompt). True only for an ok verdict: a refused start (another check in
    /// flight, the cool-down after a failed or cancelled one, no verifier) or any other verdict is false. The main run
    /// loop keeps turning while the person answers, so the worker's main-queue calls are still served; after
    /// `ownerCheckWait` without a verdict the check, still the one in flight, is cancelled (which frees the gate).
    @MainActor
    private static func verifyOwner(_ r: DialogRequest, _ ownerCheck: OwnerCheck?) -> Bool {
        guard let ownerCheck else { return false }
        let reason = r.lang == .zh ? "把「\(r.identity.name)」的可操作档加入始终允许名单"
            : "add “\(r.identity.name)” (operate) to the always-allow list"
        let verdict = Locked<OwnerVerdict?>(nil)
        let start = ownerCheck.begin(reason: reason, purpose: "approval.always full") { v in verdict.withLock { $0 = v } }
        guard start == .started else { return false }
        let deadline = Date().addingTimeInterval(ownerCheckWait)
        while verdict.value == nil, Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        if verdict.value == nil { ownerCheck.cancel() }
        return verdict.value == .ok
    }
}
