import Foundation

// MARK: - apps.launch (2026-10-09)

/// Opening an app. grants.set opts in with allow_launch. A person's approval: bringing a running app forward with a
/// window (what clicking its Dock icon does) is read mode, the way AXRaise is; starting an app that is not running is
/// full, and the dialog says so (DialogRequest.running). A refusal for lack of approval names the mode that would
/// do (`needs_mode`), so the plugin escalates to read for a running app instead of asking for full. Handing the app a
/// file or web address to open (`open`, OpenTarget) is full, running or not: it puts new content into the app.
extension Dispatcher {
    /// Granted apps without a window to show, by lowercased bundle ID (visible ones are left out), audited as
    /// `app_states`. Asked of AX before observe waits for anything (WindowPresence).
    func windowPresence(granted: [String], running: [String], _ f: inout [String: JSONValue]) -> [String: WindowPresence] {
        var out: [String: WindowPresence] = [:]
        for id in granted.map({ $0.lowercased() }) {
            let p = running.contains(id) ? env.windowPresence(bundleID: id) : .notRunning
            if p != .visible { out[id] = p }
        }
        if !out.isEmpty { f["app_states"] = .object(out.mapValues { .string($0.rawValue) }) }
        return out
    }

    /// The mode opening `app` needs right now (`opening`: with something for it to open).
    func launchMode(_ app: String, opening: Bool = false) -> AppMode {
        !opening && env.runningBundleIDs().contains(app.lowercased()) ? .read : .full
    }

    /// admitAction for apps.launch: the task's action list, then the app's mode against launchMode.
    func admitLaunch(_ grant: Grant, app: String?, opening: Bool = false) throws {
        if grant.allows(.launch), let app, grant.mode(of: app) == .read, launchMode(app, opening: opening) == .read { return }
        try grant.checkAllows(.launch, app: app)
    }

    /// A no_grant / not_granted refusal of apps.launch, with the mode an approval would need.
    func launchDenial(_ d: Denial, app: String?, opening: Bool = false) -> Denial {
        guard let app, d.reason == "no_grant" || d.reason == "not_granted" else { return d }
        var data = d.data
        data["needs_mode"] = .string(launchMode(app, opening: opening).rawValue)
        return Denial(d.reason, d.detail, data: data)
    }

    func launch(_ p: LaunchParams, _ f: inout [String: JSONValue]) throws -> JSONValue {
        f["task_id"] = .string(p.taskId)
        guard let app = p.app ?? p.bundleId else { throw RPCFailure(.invalidParams, "apps.launch needs app") }
        f["app"] = .string(app)
        let opening = p.open != nil
        let grant: Grant
        do { grant = try checkApp(taskID: p.taskId, app: app) } catch let d as Denial {
            throw launchDenial(d, app: app, opening: opening)
        }
        try requireUnlocked()
        // Checked again here, not only in admitAction: the app may have quit in between, and then read is not enough.
        let wasRunning = env.runningBundleIDs().contains(app.lowercased())
        f["was_running"] = .bool(wasRunning)
        let mode = grant.mode(of: app)
        guard grant.allowLaunch || mode == .full || (mode == .read && wasRunning && !opening) else {
            if mode == .read {
                let why = opening ? "is granted read-only; having it open something needs the full mode"
                    : "is granted read-only and is not running; opening it needs the full mode"
                throw Denial("action_not_allowed", "\(app) \(why)",
                             data: ["action": "launch", "app_mode": "read", "needs_mode": "full"])
            }
            throw Denial("launch_not_allowed", "task \(p.taskId)'s grant does not allow launching apps")
        }
        if let raw = p.open {
            // Before anything runs: a refused target leaves the app as it was.
            let target = try OpenTarget.parse(raw, protectedDirs: protectedDirs)
            f["open_kind"] = .string(target.kind)
            f["open"] = .string(target.kind == "file" ? target.url.path : target.url.absoluteString)
            launchedAt[app.lowercased()] = now()  // whatever comes back, the app may be starting
            let folder = target.kind == "file" ? target.url.deletingLastPathComponent().path : nil
            switch env.open(target.url, bundleID: app) {
            case .opened:
                return ["launched": true, "was_running": .bool(wasRunning), "opened": .string(target.kind)]
            case .timedOut:
                // Not a failure: macOS asks the user, once per protected folder, whether this daemon may read it, and
                // the open waits for the answer (VM, 2026-10-15). Tell the model to have the user answer, not to retry.
                if let folder {
                    throw Denial("open_waiting", "\(app) has not opened it after \(Int(Self.openWait)) s. macOS is probably "
                                 + "asking the user, in a system dialog, whether the computer-use daemon (CURuntime) may "
                                 + "access the folder \(folder) (asked once per folder; the answer is kept). Tell the user to "
                                 + "answer it: either answer does, Don't Allow included (the app opens the file itself; the "
                                 + "daemon needs no access to the folder). Then cu_observe: the file opens by itself, do not "
                                 + "send this call again unless it is still not open", data: ["folder": .string(folder)])
                }
                throw Denial("open_waiting", "\(app) has not opened it after \(Int(Self.openWait)) s (it may be starting or "
                             + "busy): cu_observe before deciding whether to send it again")
            case .noPermission:
                throw Denial("open_no_permission", "macOS does not let the computer-use daemon (CURuntime) read "
                             + "\(folder ?? "that"): the user did not allow it. They can allow it in System Settings > "
                             + "Privacy & Security > Files and Folders > CURuntime, then this call can be sent again",
                             data: folder.map { ["folder": .string($0)] } ?? [:])
            case .failed(let why):
                throw Denial("open_failed", "\(app) could not open it: \(why)")
            }
        }
        guard env.launch(bundleID: app) else { throw Denial("launch_failed", "could not launch \(app)") }
        launchedAt[app.lowercased()] = now()
        return ["launched": true, "was_running": .bool(wasRunning)]
    }
}
