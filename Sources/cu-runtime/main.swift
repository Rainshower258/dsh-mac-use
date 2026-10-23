import AppKit
import ApplicationServices
import CURuntimeCore
import ScreenCaptureKit

// Launch only through LaunchServices (`open -a CURuntime.app --args …`) or a LaunchAgent, so this app,
// not whoever spawned it, is the TCC-responsible process.
//
//   serve [--state-dir DIR] [--settings]   default DIR: ~/Library/Application Support/cu-runtime; --settings opens
//                                  the settings window at start; SIGUSR1 opens it later (a reopen Apple event too,
//                                  but LaunchServices sends none to a background-only app). --state-dir (any DIR, the
//                                  default too) and the test-harness switches in config.json only in a bench build
//                                  (LaunchPolicy); a release build serves the default, without the option
//   settings                       open the settings window of the running daemon (SIGUSR1), or start one with it
//   self-check --out FILE          JSON: AX trust + one real SCK capture (signing acceptance)
//   canary --out FILE              display+including vs per-window capture on a known marker (regression canary)
//   request-permissions            trigger the AX / Screen Recording prompts once
//   grants list [--state-dir DIR]                the persistent list (apps approved "always", or added by command)
//   grants revoke <bundle ID|name> [--state-dir DIR]
//   grants add --full <bundle ID> [--state-dir DIR]   a permanent full grant, pinned to the app's signature now
//                                  (--state-dir as for serve: a bench build only)
//   ocr-files [--band-pt N] [--scale S] PNG…   offline bench: the daemon's own OCR on image files, one JSON line
//                                  per image (same format as bench/tools/vision-ocr); --band-pt reads in bands
//   version

/// The daemon's NSApplication delegate: a reopen (the app opened again while it serves) shows the settings window.
/// The daemon runs the main run loop itself, not NSApp.run(), so the reopen Apple event ('rapp') is taken straight
/// from NSAppleEventManager: without NSApp's own launch sequence the delegate method alone is never called.
final class ReopenDelegate: NSObject, NSApplicationDelegate {
    let onReopen: @MainActor () -> Void
    init(onReopen: @escaping @MainActor () -> Void) {
        self.onReopen = onReopen
        super.init()
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleReopen(_:with:)),
                                                     forEventClass: AEEventClass(kCoreEventClass), andEventID: AEEventID(kAEReopenApplication))
    }
    @objc func handleReopen(_ event: NSAppleEventDescriptor, with reply: NSAppleEventDescriptor) {
        MainActor.assumeIsolated { onReopen() }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        MainActor.assumeIsolated { onReopen() }
        return false
    }
}

let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "dev"
var args = Array(CommandLine.arguments.dropFirst())
let command = args.first ?? "serve"
if !args.isEmpty { args.removeFirst() }

func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("cu-runtime: \(message)\n".utf8))
    exit(1)
}

umask(0o077)
signal(SIGPIPE, SIG_IGN)

#if CU_BENCH
/// A bench build (`CU_BENCH=1 scripts/build-app.sh`): --state-dir and the test-harness switches (LaunchPolicy).
let benchBuild = true
#else
let benchBuild = false
#endif

/// The state directory of serve and grants, exactly the URL LaunchPolicy.stateDir decided on: the default itself
/// without --state-dir; in a release build --state-dir in any form is refused here (exit status 1), before anything
/// is created or read. Serve checks its config.json too.
func launchStateDir() -> URL {
    guard let standard = LaunchPolicy.defaultStateDir() else { fail("this user has no home directory in the user database") }
    switch LaunchPolicy.stateDir(arguments: args, defaultStateDir: standard, benchBuild: benchBuild) {
    case .success(let dir): return dir
    case .failure(let r): fail(r.message)
    }
}

switch command {
case "version":
    print(version)

case "serve":
    let stateDir = launchStateDir()
    do { try StateDir.prepare(stateDir) } catch { fail("\(error)") }
    // Approval dialogs need an NSApplication; LSUIElement keeps the daemon out of the Dock.
    MainActor.assumeIsolated { _ = NSApplication.shared.setActivationPolicy(.accessory) }
    let wantSettings = args.contains("--settings")
    let settingsPage = ["apps": 1, "access": 2, "shortcuts": 3, "privacy": 4, "behavior": 5, "logs": 6][option("--settings-page") ?? ""] ?? 0  // debugging aid: open on a page
    var config = PolicyConfig()
    if let data = try? Data(contentsOf: stateDir.appendingPathComponent("config.json")) {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard let c = try? decoder.decode(PolicyConfig.self, from: data) else { fail("config.json is invalid") }
        config = c
    }
    // The audit opens where the logs setting says (read once here, before the dispatcher reads the file for real);
    // a folder that cannot be used falls back to the default, on record once the audit is open.
    let settingsStore = FileSettingsStore(stateDir: stateDir)
    let defaultLogDir = stateDir.appendingPathComponent("audit")
    let wantedLogDir = ((try? settingsStore.load()) ?? UserSettings()).logs.effectiveDirectory(default: defaultLogDir)
    var logFallback: String?
    let audit: FileAudit
    do {
        audit = try FileAudit(directory: wantedLogDir)
    } catch {
        guard wantedLogDir != defaultLogDir else { fail("cannot open audit log: \(error)") }
        logFallback = "\(error)"
        do { audit = try FileAudit(directory: defaultLogDir) } catch { fail("cannot open audit log: \(error)") }
    }
    if let why = logFallback {
        audit.record(["method": "runtime.logs_dir_fallback", "decision": "error", "wanted": .string(wantedLogDir.path),
                      "detail": .string(why)])
    }
    // A test-harness switch in a release build: refused on record, so a daemon that never came up says why.
    if let r = LaunchPolicy.refusal(config: config, configFile: stateDir.appendingPathComponent("config.json"), benchBuild: benchBuild) {
        audit.record(["method": "runtime.start_refused", "decision": "deny", "version": .string(version),
                      "refused": .array(r.refused.map { .string($0) }), "detail": .string(r.message)])
        fail(r.message)
    }
    let env = MacEnvironment()
    // The one owner check gate (OwnerCheck) of the settings window, the settings socket methods and the approval
    // dialog's "always" with full access; it refuses to start while an approval dialog is open (`approvalOpen`).
    let approvalOpen = Locked(0)
    let ownerCheck = OwnerCheck(verifier: MacOwnerVerifier(), audit: audit, approvalOpen: { approvalOpen.value > 0 })
    let dispatcher = Dispatcher(grants: GrantStore(), env: env, config: config, audit: audit,
                                ledger: FileStateLedger(stateDir: stateDir),
                                approvals: ApprovalDeps(apps: MacAppDirectory(),
                                                        presenter: MacApprovalPresenter(ownerCheck: ownerCheck, open: approvalOpen),
                                                        persistent: FilePersistentGrants(stateDir: stateDir)),
                                settingsStore: settingsStore)
    // Both set before the server starts, so the worker and the window read them without a race.
    dispatcher.ownerCheck = ownerCheck
    dispatcher.settingsPanels = MacSettingsPanels()
    dispatcher.defaultLogDirectory = defaultLogDir
    dispatcher.protectedDirs = [OpenTarget.resolvedDir(stateDir.path)]
    dispatcher.recoverSystemState()  // a previous daemon may have crashed with system state changed
    dispatcher.applyAuditRetention()
    let server = Server(stateDir: stateDir, dispatcher: dispatcher, audit: audit)
    do { try server.start() } catch { fail("\(error)") }
    // The settings window (SettingsWindow.swift): opened by a reopen of this app, or at start with --settings.
    MainActor.assumeIsolated {
        let controller = SettingsWindowController(server: server, dispatcher: dispatcher, audit: audit,
                                                  auditDir: audit.currentDirectory, version: version)
        SettingsWindowController.shared = controller
        let delegate = ReopenDelegate { controller.show() }
        NSApplication.shared.delegate = delegate
        _ = Unmanaged.passRetained(delegate)
        if wantSettings { controller.show(page: settingsPage) }
        // `cu-runtime settings` (below) asks a running daemon for the window this way.
        signal(SIGUSR1, SIG_IGN)
        let usr1 = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        usr1.setEventHandler { MainActor.assumeIsolated { controller.show() } }
        usr1.resume()
        _ = Unmanaged.passRetained(usr1)
    }
    audit.record(["method": "runtime.start", "decision": "allow", "version": .string(version),
                  "pid": .number(Double(getpid())), "ax_trusted": .bool(AXIsProcessTrusted()),
                  "allow_finder": .bool(config.allowFinder)])
    DispatchQueue.global(qos: .utility).async {
        let t = env.prewarm()
        var f: [String: JSONValue] = ["method": "runtime.prewarm", "decision": t.values.contains { $0 == nil } ? "error" : "allow"]
        for (k, v) in t { f[k] = v.map { .number($0) } ?? .null }
        audit.record(f)
    }
    for sig in [SIGTERM, SIGINT] {
        signal(sig, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        src.setEventHandler {
            // Not on the main thread: restoring the input source hops to it (TIS), and a main thread blocked here
            // waiting for the worker would deadlock that until the shutdown timeout, skipping the restore (VM,
            // bench/experiments/ime_policy.py, 2026-09-29).
            DispatchQueue.global(qos: .userInitiated).async {
                // A stop on purpose (pkill, the plugin page, uninstall.sh): the plugin's autoStart must not open the
                // daemon again in this boot, connected client or not (StopMark). First, so a slow shutdown cannot
                // skip it; a failure is audited and the stop goes on.
                StopMark.leave(stateDir: stateDir, audit: audit, trigger: "signal_\(sig)")
                server.shutdown { dispatcher.shutdownCleanup(trigger: "signal_\(sig)") }
                exit(0)
            }
        }
        src.resume()
        _ = Unmanaged.passRetained(src)
    }
    // NSApp's own loop, not RunLoop.main.run(): windows get their mouse and keyboard events only from it (the
    // settings window drew but took no clicks under a bare run loop, 2026-10-15); the approval dialog's runModal and
    // the main-queue blocks the worker relies on run inside it as before.
    MainActor.assumeIsolated { NSApplication.shared.run() }

case "ocr-files":
    let bandPt = option("--band-pt").flatMap(Double.init)
    let scale = option("--scale").flatMap(Double.init) ?? 2
    var files: [String] = []
    var skip = false
    for a in args {
        if skip { skip = false; continue }
        if a == "--band-pt" || a == "--scale" { skip = true; continue }
        files.append(a)
    }
    guard !files.isEmpty else { fail("ocr-files needs PNG files") }
    for f in files { print(MacEnvironment.ocrFile(path: f, bandPt: bandPt, scale: scale)) }

case "canary":
    guard let out = option("--out") else { fail("canary needs --out FILE") }
    if args.contains("--sheet") {
        MainActor.assumeIsolated { SheetCanary.run(out: out) }
    } else {
        MainActor.assumeIsolated { Canary.run(out: out) }
    }
    RunLoop.main.run()

case "grants":
    // The persistent list, edited from a terminal (a permanent full grant cannot come from the dialog). Every change
    // goes to the daemon's audit log; a running daemon reads the list on each use.
    let stateDir = launchStateDir()
    do { try StateDir.prepare(stateDir) } catch { fail("\(error)") }
    let store = FilePersistentGrants(stateDir: stateDir)
    let apps = MacAppDirectory()
    let positional = args.filter { !$0.hasPrefix("--") && $0 != option("--state-dir") }
    func record(_ fields: [String: JSONValue]) {
        // The same place the daemon writes (the logs setting), the default when that cannot be opened.
        let fallback = stateDir.appendingPathComponent("audit")
        let wanted = ((try? FileSettingsStore(stateDir: stateDir).load()) ?? UserSettings()).logs.effectiveDirectory(default: fallback)
        guard let audit = (try? FileAudit(directory: wanted)) ?? (try? FileAudit(directory: fallback)) else {
            fail("cannot open the audit log")
        }
        var f = fields
        f["peer_pid"] = .number(Double(getpid()))
        f["peer_exe"] = .string(CommandLine.arguments[0])
        audit.record(f)
    }
    do {
        switch positional.first {
        case "list", nil:
            let list = try store.load()
            if list.isEmpty { print("(empty)") }
            for e in list {
                let added = Date(timeIntervalSince1970: e.addedAt).formatted(date: .numeric, time: .shortened)
                print("\(e.bundleId)\t\(e.mode)\tvia \(e.via), \(added)\t\(e.path)")
            }
        case "revoke":
            guard positional.count == 2 else { fail("usage: grants revoke <bundle ID|name>") }
            let arg = positional[1]
            var id = arg
            if try !store.load().contains(where: { $0.bundleId.caseInsensitiveCompare(arg) == .orderedSame }) {
                let named = apps.identities(named: arg)
                if named.count == 1 { id = named[0].bundleID }
            }
            let gone = try PersistentGrants.revoke(bundleID: id, store: store)
            guard !gone.isEmpty else { fail("\(arg) is not in the list") }
            for e in gone {
                record(["method": "grants.persistent_revoke", "decision": "revoke", "app": .string(e.bundleId),
                        "mode": .string(e.mode), "via": "command"])
                print("revoked \(e.bundleId) (\(e.mode))")
            }
        case "add":
            guard args.contains("--full"), positional.count == 2 else {
                fail("usage: grants add --full <bundle ID>  (read-only \"always\" comes from the dialog)")
            }
            guard let identity = apps.identity(bundleID: positional[1]) else { fail("no app with bundle ID \(positional[1])") }
            let settings = (try? FileSettingsStore(stateDir: stateDir).load()) ?? UserSettings()
            let e = try PersistentGrants.add(identity, mode: .full, via: "command", store: store, apps: apps, now: Date(),
                                             settings: settings)
            record(["method": "grants.persistent_add", "decision": "allow", "app": .string(e.bundleId),
                    "mode": .string(e.mode), "path": .string(e.path), "requirement": .string(e.requirement), "via": "command"])
            print("added \(e.bundleId) (full), pinned to: \(e.requirement)")
        default:
            fail("usage: grants list | revoke <bundle ID|name> | add --full <bundle ID>")
        }
    } catch let d as Denial {
        fail("\(d.reason): \(d.detail)")
    } catch {
        fail("\(error)")
    }

case "settings":
    // A running daemon (this app's bundle ID, another process) gets SIGUSR1 and opens the window; none running: start
    // one through LaunchServices with the window (so it, not this shell, is the TCC-responsible process).
    let me = ProcessInfo.processInfo.processIdentifier
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: HardDeny.daemon)
        .filter { $0.processIdentifier != me && !$0.isTerminated }
    if let daemon = running.first {
        guard kill(daemon.processIdentifier, SIGUSR1) == 0 else { fail("cannot signal the daemon (pid \(daemon.processIdentifier)): errno \(errno)") }
        print("asked the daemon (pid \(daemon.processIdentifier)) to open its settings window")
    } else {
        let config = NSWorkspace.OpenConfiguration()
        config.arguments = ["serve", "--settings"]
        config.activates = true
        let done = DispatchSemaphore(value: 0)
        var problem: String?
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: config) { _, error in
            problem = error.map { "\($0)" }
            done.signal()
        }
        _ = done.wait(timeout: .now() + 15)
        if let problem { fail(problem) }
        print("started the daemon with its settings window")
    }

case "request-permissions":
    _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary)
    _ = CGRequestScreenCaptureAccess()

case "self-check":
    guard let out = option("--out") else { fail("self-check needs --out FILE") }
    Task {
        var result: [String: Any] = [
            "version": version,
            "ax_trusted": AXIsProcessTrusted(),
            "screen_capture_preflight": CGPreflightScreenCaptureAccess(),
        ]
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first else { throw CocoaError(.featureUnsupported) }
            let conf = SCStreamConfiguration()
            conf.width = display.width * 2
            conf.height = display.height * 2
            let image = try await SCScreenshotManager.captureImage(
                contentFilter: SCContentFilter(display: display, excludingWindows: []), configuration: conf)
            result["sck"] = ["ok": true, "width": image.width, "height": image.height]
        } catch {
            result["sck"] = ["ok": false, "error": String(describing: error)]
        }
        let data = (try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
            ?? Data(#"{"error":"self-check result not serializable"}"#.utf8)
        FileManager.default.createFile(atPath: out, contents: data, attributes: [.posixPermissions: 0o600])
        exit(0)
    }
    RunLoop.main.run()

default:
    fail("unknown command \(command)")
}
