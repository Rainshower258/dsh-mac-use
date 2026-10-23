import AppKit
import CURuntimeCore
import IOKit.hid
import ScreenCaptureKit
import SwiftUI

// MARK: - The settings window (2026-10-15, design revised 2026-10-16)
//
// A native window of the daemon itself, so the model can neither see nor click it (the daemon is hard-denied).
// It reads and writes daemon state only through Server.perform (the worker queue, never waiting on it), and the
// settings it changes never cross the socket. Its appearance follows dsh's (DshTheme), its colours are dsh's
// (DshPalette), its language is the one the approval dialog uses (UILanguage).

/// The three states a system permission shows (Input Monitoring is the only one macOS reports as "never asked").
enum PermissionState { case granted, missing, notRequested }

/// What the window shows, refreshed from the daemon; main thread only.
@MainActor
final class SettingsModel: ObservableObject {
    enum SelfCheck: Equatable { case idle, running, passed(ms: Int), failed(String) }

    @Published var snapshot: SettingsSnapshot?
    @Published var refusals: [AuditRefusal] = []
    @Published var settingsChanges: [AuditSettingsChange] = []
    @Published var axTrusted = false
    @Published var screenCapture = false
    @Published var inputMonitoring: PermissionState = .notRequested
    @Published var selfCheck: SelfCheck = .idle
    @Published var busy = false
    @Published var message: String?
    /// 0 overview, 1 app lists, 2 modes and defaults, 3 shortcuts, 4 privacy and audit, 5 behavior and model, 6 logs.
    @Published var page = 0 {
        didSet { if page != oldValue { ui("page", ["page": .string(Self.pageNames[page] ?? "\(page)")]) } }
    }
    static let pageNames = [0: "overview", 1: "apps", 2: "access", 3: "shortcuts", 4: "privacy", 5: "behavior", 6: "logs"]

    /// A click in the window that changes no setting, on record (decided 2026-10-17: every button traceable).
    func ui(_ action: String, _ fields: [String: JSONValue] = [:]) {
        var f = fields
        f["method"] = "settings.ui"
        f["decision"] = "allow"
        f["action"] = .string(action)
        audit.record(f)
    }
    let strings: SettingsStrings
    let version: String
    private let server: Server
    private let dispatcher: Dispatcher
    private let audit: AuditSink
    /// The daemon's one owner check gate (dispatcher.ownerCheck, set before the server started); nil: nothing can be
    /// verified, so no loosening change is made from the window.
    private let ownerCheck: OwnerCheck?
    /// Where the audit was when the window was made; the snapshot's directory wins once it is there.
    private let startupLogDir: URL
    var auditDir: URL { snapshot?.logDirectory ?? startupLogDir }

    init(server: Server, dispatcher: Dispatcher, audit: AuditSink, auditDir: URL, version: String, lang: UILanguage) {
        self.server = server
        self.dispatcher = dispatcher
        self.audit = audit
        self.ownerCheck = dispatcher.ownerCheck
        self.startupLogDir = auditDir
        self.version = version
        self.strings = SettingsStrings(lang: lang)
    }

    func refresh() {
        busy = true
        axTrusted = AXIsProcessTrusted()
        screenCapture = CGPreflightScreenCaptureAccess()
        switch IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) {
        case kIOHIDAccessTypeGranted: inputMonitoring = .granted
        case kIOHIDAccessTypeDenied: inputMonitoring = .missing
        default: inputMonitoring = .notRequested
        }
        readLog()
        let d = dispatcher
        server.perform({ d.settingsSnapshot() }) { [weak self] snap in
            guard let self else { return }
            let dirChanged = snap.logDirectory != self.snapshot?.logDirectory
            self.snapshot = snap
            self.busy = false
            if dirChanged { self.readLog() }
        }
    }

    /// The lists read from the log, and its size (the logs page).
    private func readLog() {
        refusals = AuditReader.recentRefusals(directory: auditDir)
        settingsChanges = AuditReader.recentSettingsChanges(directory: auditDir)
        let fm = FileManager.default
        let names = ((try? fm.contentsOfDirectory(atPath: auditDir.path)) ?? []).filter { $0.hasPrefix("audit-") && $0.hasSuffix(".jsonl") }
        logFiles = (names.count, names.reduce(Int64(0)) { $0 + Int64((try? fm.attributesOfItem(atPath: auditDir.appendingPathComponent($1).path))?[.size] as? Int ?? 0) })
    }
    @Published var logFiles: (count: Int, bytes: Int64) = (0, 0)

    /// The logs setting, one field (where, or for how long), applied to the daemon's settings as they are then
    /// (settingsEditLogs, never a copy from the click); the daemon moves the files. A shorter retention deletes audit
    /// files (LogSettings.loosened): the owner check first; the rest applies at once.
    func editLogs(_ edit: @escaping (inout LogSettings) -> Void) {
        let d = dispatcher
        let old = snapshot?.settings.logs ?? LogSettings()
        var new = old
        edit(&new)
        guard !old.loosened(by: new).isEmpty else { change { try d.settingsEditLogs(verified: false, edit) }; return }
        verify(reason: strings.retentionVerifyReason, purpose: "logs.retention") { [weak self] ok in
            guard ok else { return }
            self?.change { try d.settingsEditLogs(verified: true, edit) }
        }
    }

    func chooseLogDirectory() {
        ui("choose_log_directory")
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = strings.changeLocation.replacingOccurrences(of: "…", with: "")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let path = url.standardizedFileURL.path
        editLogs { $0.directory = path }
    }

    func revealLog() { reveal(auditDir, as: "reveal_log") }

    /// Shows a folder in the Finder. `open` on the folder's URL, not `selectFile(nil, inFileViewerRootedAtPath:)`:
    /// that one opened the default log folder but did nothing for a folder the daemon had just created under
    /// Desktop (VM, 2026-10-17). When even `open` refuses, the folder is selected in its parent. The outcome is on
    /// record, so a folder the Finder cannot show is traceable.
    private func reveal(_ url: URL, as action: String) {
        let opened = NSWorkspace.shared.open(url)
        var selected = false
        if !opened {
            NSWorkspace.shared.activateFileViewerSelecting([url])
            selected = true
        }
        ui(action, ["path": .string(url.path), "opened": .bool(opened), "selected_in_parent": .bool(selected)])
        if !opened && !FileManager.default.fileExists(atPath: url.path) { message = "\(url.path): \(strings.missingFolder)" }
    }

    /// Runs `body` on the worker queue, then refreshes. An error is shown, never thrown at the window.
    private func change(_ body: @escaping () throws -> Void) {
        busy = true
        message = nil
        server.perform({ () -> String? in
            do { try body(); return nil } catch { return "\(error)" }
        }) { [weak self] err in
            self?.message = err
            self?.refresh()
        }
    }

    func revoke(taskID: String) { let d = dispatcher; change { d.settingsRevoke(taskID: taskID) } }
    func revokeAll() { let d = dispatcher; change { d.settingsRevokeAll() } }
    func revokePersistent(_ bundleID: String) { let d = dispatcher; change { try d.settingsRevokePersistent(bundleID: bundleID) } }

    /// The access rules: a loosening change verifies the person first, a tightening one is applied at once. The
    /// edit (one control) is applied to the daemon's rules as they are then, never a copy from the click.
    func setAccess(_ edit: @escaping (inout AccessDefaults) -> Void) {
        let d = dispatcher
        let old = snapshot?.settings.access ?? AccessDefaults()
        var new = old
        edit(&new)
        guard !old.loosened(by: new).isEmpty else { change { try d.settingsEditAccess(verified: false, edit) }; return }
        verify(reason: strings.accessVerifyReason, purpose: "access.set") { [weak self] ok in
            guard let self else { return }
            guard ok else { return }
            self.change { try d.settingsEditAccess(verified: true, edit) }
        }
    }

    /// An app onto the always list from the window: verified first (loosening whichever the mode).
    func persistentAdd(_ bundleID: String, _ mode: AppMode, done: @escaping (Bool) -> Void) {
        let d = dispatcher
        verify(reason: strings.alwaysReason, purpose: "persistent.add") { [weak self] ok in
            guard let self else { return }
            guard ok else { done(false); return }
            self.change { try d.settingsPersistentAdd(bundleID: bundleID, mode: mode, verified: true) }
            done(true)
        }
    }

    /// A persistent entry's mode: raising to full verifies first.
    func setPersistentMode(_ bundleID: String, _ mode: AppMode) {
        let d = dispatcher
        guard mode == .full else { change { try d.settingsSetPersistentMode(bundleID: bundleID, mode: mode, verified: false) }; return }
        verify(reason: strings.raiseReason, purpose: "persistent.mode") { [weak self] ok in
            guard let self else { return }
            guard ok else { return }
            self.change { try d.settingsSetPersistentMode(bundleID: bundleID, mode: mode, verified: true) }
        }
    }

    /// Behavior, one switch or choice, applied to the daemon's settings as they are then (settingsEditBehavior, never
    /// a copy from the click). Coordinate targets on, a higher input-source cap and Electron AX on widen what the
    /// model can do (BehaviorSettings.loosened): the owner check first; the rest applies at once.
    func editBehavior(_ edit: @escaping (inout BehaviorSettings) -> Void) {
        let d = dispatcher
        let old = snapshot?.settings.behavior ?? BehaviorSettings()
        var new = old
        edit(&new)
        guard !old.loosened(by: new).isEmpty else { change { try d.settingsEditBehavior(verified: false, edit) }; return }
        verify(reason: strings.behaviorVerifyReason, purpose: "behavior.set") { [weak self] ok in
            guard ok else { return }
            self?.change { try d.settingsEditBehavior(verified: true, edit) }
        }
    }

    /// The settings file as the daemon writes it, to a place the person chooses.
    func exportSettings() {
        guard let s = snapshot?.settings else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "cu-runtime-settings.json"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try s.encoded().write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            audit.record(["method": "settings.export", "decision": "allow"])
            message = strings.exported
        } catch { message = "\(error)" }
    }

    /// Applies an imported file or the defaults: verified first when it loosens anything (the page listed them).
    func importSettings(_ new: UserSettings, loosens: Bool, reason: String, method: String = "settings.import", done: @escaping (Bool) -> Void) {
        let d = dispatcher
        let apply = { [weak self] (verified: Bool) in
            self?.change { try d.settingsImport(new, verified: verified, method: method) }
            self?.message = self?.strings.imported
            done(true)
        }
        guard loosens else { apply(false); return }
        verify(reason: reason, purpose: method == "settings.reset" ? "reset" : "import") { ok in
            guard ok else { done(false); return }
            apply(true)
        }
    }

    /// Privacy: switching content off, the clipboard setting and the retention apply at once; switching
    /// content back on or taking an app off the text-only list goes through the owner check.
    /// The edit (one switch or list entry) is applied to the daemon's settings as they are then (VM test, 2026-10-17: a
    /// whole copy from the click, written back after the check, switched OCR back off).
    func setPrivacy(_ edit: @escaping (inout PrivacySettings) -> Void) {
        let d = dispatcher
        let old = snapshot?.settings.privacy ?? PrivacySettings()
        var new = old
        edit(&new)
        guard !old.loosened(by: new).isEmpty else { change { try d.settingsEditPrivacy(verified: false, edit) }; return }
        verify(reason: strings.privacyVerifyReason, purpose: "privacy.set") { [weak self] ok in
            guard let self else { return }
            guard ok else { return }
            self.change { try d.settingsEditPrivacy(verified: true, edit) }
        }
    }

    /// The last 7 days' audit files, concatenated into one file the person chooses (0600).
    func exportAudit() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "cu-runtime-audit-7d.jsonl"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        var data = Data()
        // The same 7 days the retention keeps at its shortest (AuditDays), oldest first.
        for day in AuditDays.last(7).reversed() {
            if let d = try? Data(contentsOf: auditDir.appendingPathComponent(AuditDays.fileName(day))) { data.append(d) }
        }
        do {
            try data.write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            audit.record(["method": "settings.audit_export", "decision": "allow", "bytes": .number(Double(data.count))])
            message = strings.exportDone
        } catch { message = "\(error)" }
    }

    // The chord allowlist: switching a built-in off and removing a chord of the user's apply at once;
    // switching one on and adding go through the owner check.
    func chordDisable(_ chord: String) { let d = dispatcher; change { try d.settingsChordDisable(chord) } }
    func chordRemove(_ chord: String, app: String?) { let d = dispatcher; change { try d.settingsChordRemove(chord, app: app) } }
    func chordEnable(_ chord: String) {
        let d = dispatcher
        verify(reason: strings.chordEnableReason, purpose: "chord.enable") { [weak self] ok in
            guard let self else { return }
            guard ok else { return }
            self.change { try d.settingsChordEnable(chord, verified: true) }
        }
    }
    func chordAdd(_ chord: String, app: String?, note: String, done: @escaping (Bool) -> Void) {
        let d = dispatcher
        verify(reason: strings.chordAddReason, purpose: "chord.add") { [weak self] ok in
            guard let self else { return }
            guard ok else { done(false); return }
            self.change { try d.settingsChordAdd(chord, app: app, note: note, verified: true) }
            done(true)
        }
    }

    /// A voided persistent entry pinned to the app's current signature: verified first.
    func reapprovePersistent(_ bundleID: String) {
        let d = dispatcher
        verify(reason: strings.reapproveReason, purpose: "persistent.reapprove") { [weak self] ok in
            guard let self else { return }
            guard ok else { return }
            self.change { try d.settingsReapprovePersistent(bundleID: bundleID, verified: true) }
        }
    }
    func denylistAdd(_ bundleID: String, note: String) { let d = dispatcher; change { try d.settingsDenylistAdd(bundleID: bundleID, note: note) } }

    /// Loosening: the person first (Touch ID, Apple Watch or the password), then the change.
    func denylistRemove(_ bundleID: String) {
        verify(reason: strings.denyReason, purpose: "deny.remove") { [weak self] ok in
            guard let self else { return }
            guard ok else { return }
            let d = self.dispatcher
            self.change { try d.settingsDenylistRemove(bundleID: bundleID, verified: true) }
        }
    }

    /// The sidebar button: every approval goes, then the daemon exits, leaving the stop mark before it (StopMark), so
    /// dsh does not start it again by itself in this boot.
    func stopAndRevokeAll() {
        let d = dispatcher
        server.perform({ d.settingsRevokeAll() }) { [weak self] _ in
            guard let self else { return }
            StopMark.leave(stateDir: self.server.stateDir, audit: self.audit, trigger: "settings_stop")
            self.quit(trigger: "settings_stop")
        }
    }

    /// The daemon card's stop: the daemon exits; approvals, held in memory, end with it. The stop mark is left before
    /// it exits (StopMark), so dsh does not start it again by itself in this boot.
    func stopDaemon() {
        audit.record(["method": "settings.stop", "decision": "allow"])
        StopMark.leave(stateDir: server.stateDir, audit: audit, trigger: "settings_stop")
        quit(trigger: "settings_stop")
    }

    /// The daemon card's restart: the daemon exits and LaunchServices opens the app again a moment later (through
    /// `open`, so the new process is the TCC-responsible app, like every start). The plugin's stop mark, left when
    /// a connected daemon goes away, is cleared by its next connection to the new one.
    func restartDaemon() {
        let app = Bundle.main.bundleURL
        guard app.pathExtension == "app" else { message = strings.notAnApp; return }
        audit.record(["method": "settings.restart", "decision": "allow", "app": .string(app.path)])
        let relaunch = Process()
        relaunch.executableURL = URL(fileURLWithPath: "/bin/sh")
        relaunch.arguments = ["-c", "sleep 1; exec /usr/bin/open -g \"$0\"", app.path]
        do { try relaunch.run() } catch { message = "\(error)"; return }
        quit(trigger: "settings_restart")
    }

    private func quit(trigger: String) {
        let d = dispatcher
        DispatchQueue.global(qos: .userInitiated).async { [server] in
            server.shutdown { d.shutdownCleanup(trigger: trigger) }
            exit(0)
        }
    }

    /// The same check as `cu-runtime self-check`, in this process: Accessibility trust and one real ScreenCaptureKit
    /// capture (signing acceptance). The result stays on the card; the audit keeps it too.
    func runSelfCheck() {
        guard selfCheck != .running else { return }
        selfCheck = .running
        let t0 = Date()
        Task { @MainActor [weak self] in
            let ax = AXIsProcessTrusted()
            var sckError: String?
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let display = content.displays.first else { throw CocoaError(.featureUnsupported) }
                let conf = SCStreamConfiguration()
                conf.width = display.width
                conf.height = display.height
                _ = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: display, excludingWindows: []),
                                                               configuration: conf)
            } catch { sckError = String(describing: error) }
            guard let self else { return }
            let ms = Int(Date().timeIntervalSince(t0) * 1000)
            self.audit.record(["method": "settings.self_check", "decision": ax && sckError == nil ? "allow" : "error",
                               "ax_trusted": .bool(ax), "sck_error": sckError.map { .string($0) } ?? .null,
                               "ms": .number(Double(ms))])
            if let sckError { self.selfCheck = .failed(sckError) }
            else if !ax { self.selfCheck = .failed(self.strings.axUntrusted) }
            else { self.selfCheck = .passed(ms: ms) }
            self.refresh()
        }
    }

    /// The System Settings pane for a permission (Privacy & Security).
    func openSystemSettings(pane: String) {
        ui("open_system_settings", ["pane": .string(pane)])
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
            NSWorkspace.shared.open(url)
        }
    }

    /// The owner check before a loosening change, through the daemon's one gate (dispatcher.ownerCheck, shared with
    /// the settings socket methods and the approval dialog): one check at a time for the whole daemon, since a second
    /// one started while the first was open made macOS cancel the first (VM test, 2026-10-17, LAError -4) and that
    /// change was lost without the person noticing. OwnerCheck records every start and verdict (never the reason text).
    /// `done` runs once, on the main thread: true for an ok verdict; false otherwise, after the message says why
    /// (verifyBusy for a start refused while a check or an approval dialog is open, verifyFailed for any other verdict
    /// and for a start refused during the cool-down after a failed or cancelled check or without a verifier) and the
    /// page is redrawn (a switch flipped for the click goes back). `purpose` names the change for the audit (a
    /// SettingsChange kind).
    private func verify(reason: String, purpose: String, _ done: @escaping (Bool) -> Void) {
        let notVerified = { [weak self] (why: String?) in
            guard let self else { return }
            self.message = why ?? self.strings.verifyFailed
            self.objectWillChange.send()
            done(false)
        }
        let start = ownerCheck?.begin(reason: reason, purpose: "settings.window " + purpose) { verdict in
            DispatchQueue.main.async { if verdict == .ok { done(true) } else { notVerified(nil) } }
        } ?? .unavailable
        switch start {
        case .started: return
        case .busy, .approvalOpen: notVerified(strings.verifyBusy)
        case .cooldown, .unavailable: notVerified(nil)
        }
    }
}

// MARK: - Views

struct Chip: View {
    let text: String
    let fill: Color
    let fg: Color
    var body: some View {
        Text(text).font(.system(size: 12, weight: .semibold)).foregroundColor(fg)
            .padding(.horizontal, 8).padding(.vertical, 2).background(fill).clipShape(Capsule())
    }
}

struct Card<Content: View>: View {
    let title: String
    var subtitle: String?
    var trailing: AnyView?
    /// In a row of cards: take the row's full height, so the cards line up (the overview, 2026-10-17).
    var fill = false
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.system(size: 15, weight: .semibold)).foregroundColor(DshPalette.labelPrimary)
                    if let subtitle { Text(subtitle).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary) }
                }
                Spacer()
                trailing
            }
            .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 10)
            content
        }
        .frame(maxWidth: fill ? .infinity : nil, maxHeight: fill ? .infinity : nil, alignment: .topLeading)
        .background(DshPalette.bgLayer1)
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(DshPalette.borderL2, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

struct Row<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        HStack(alignment: .center, spacing: 12) { content }
            .padding(.horizontal, 18).padding(.vertical, 10)
            .overlay(Rectangle().frame(height: 1).foregroundColor(DshPalette.borderL2), alignment: .top)
    }
}

struct Mono: View {
    let text: String
    var body: some View { Text(text).font(.system(size: 11.5, design: .monospaced)).foregroundColor(DshPalette.labelTertiary) }
}

/// The design's button: bordered, filled on hover, darker while pressed (decided 2026-10-16: plain-text
/// buttons gave no feedback). Applied to the pages as a whole; a control with its own style opts out.
struct DshButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { Label(configuration: configuration) }

    private struct Label: View {
        let configuration: Configuration
        @Environment(\.isEnabled) private var enabled
        @State private var hovering = false

        var body: some View {
            let shape = RoundedRectangle(cornerRadius: 8)
            configuration.label
                .font(.system(size: 12.5, weight: .medium))
                .foregroundColor(DshPalette.labelPrimary)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(configuration.isPressed ? DshPalette.ghostFill : hovering && enabled ? DshPalette.ghostFill.opacity(0.5) : DshPalette.bgLayer2)
                .overlay(shape.stroke(DshPalette.borderL3, lineWidth: 1))
                .clipShape(shape)
                .contentShape(shape)
                .opacity(enabled ? 1 : 0.45)
                .onHover { hovering = $0 }
        }
    }
}

struct HeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// A list that grows with its rows up to `maxHeight`, then scrolls (the design's bounded lists, 2026-10-16). The
/// indicators stay visible, so a cut-off list is recognisable as one.
struct BoundedList<Content: View>: View {
    var maxHeight: CGFloat = 320
    @ViewBuilder let content: Content
    @State private var contentHeight: CGFloat = 0

    var body: some View {
        ScrollView(.vertical) {
            VStack(spacing: 0) { content }
                .background(GeometryReader { g in Color.clear.preference(key: HeightKey.self, value: g.size.height) })
        }
        .onPreferenceChange(HeightKey.self) { contentHeight = $0 }
        .frame(height: contentHeight == 0 ? nil : min(contentHeight, maxHeight))
        .scrollIndicators(.visible)
    }
}

struct SettingsRootView: View {
    @ObservedObject var model: SettingsModel
    @State private var confirmStop = false
    private var page: Int { model.page }

    var s: SettingsStrings { model.strings }

    var body: some View {
        HStack(spacing: 0) {
            sidebar.frame(width: 220).background(DshPalette.bgSidebar)
            Rectangle().frame(width: 1).foregroundColor(DshPalette.borderL2)
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    switch page {
                    case 1: AppsPage(model: model)
                    case 2: AccessPage(model: model)
                    case 3: ShortcutsPage(model: model)
                    case 4: PrivacyPage(model: model)
                    case 5: BehaviorPage(model: model)
                    case 6: LogsPage(model: model)
                    default: OverviewPage(model: model)
                    }
                }
                .padding(28)
                .frame(maxWidth: 900, alignment: .leading)
                .buttonStyle(DshButtonStyle())
            }
            .scrollIndicators(.visible)   // 2026-10-16: with overlay scroll bars the long overview looked unscrollable
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(DshPalette.bgBase)
        }
        .foregroundColor(DshPalette.labelPrimary)
        .frame(minWidth: 860, minHeight: 560)
        .onAppear { model.refresh() }
        .alert(s.stopAndRevoke, isPresented: $confirmStop) {
            Button(s.stop, role: .destructive) { model.stopAndRevokeAll() }
            Button(s.cancel, role: .cancel) {}
        } message: { Text(s.stopReason) }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 4) {
            VStack(alignment: .leading, spacing: 2) {
                Text("CURuntime").font(.system(size: 15, weight: .bold))
                Mono(text: "\(s.version) \(model.version)")
            }
            .padding(.horizontal, 12).padding(.top, 18).padding(.bottom, 12)
            navButton(0, s.overview)
            navButton(2, s.access)
            navButton(1, s.apps)
            navButton(3, s.shortcuts)
            navButton(4, s.privacy)
            navButton(5, s.behavior)
            navButton(6, s.logs)
            Spacer()
            Button { confirmStop = true } label: {
                Text(s.stopAndRevoke).font(.system(size: 13, weight: .semibold)).foregroundColor(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 9)
                    .background(DshPalette.danger).clipShape(RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)
            Text(s.onlyHere).font(.system(size: 11)).foregroundColor(DshPalette.labelTertiary).padding(.top, 6)
        }
        .padding(12)
    }

    private func navButton(_ i: Int, _ title: String) -> some View {
        NavItem(title: title, selected: page == i) { model.page = i }
    }
}

/// A sidebar entry: the whole row is the click target (a plain button hit-tests only its opaque content, so without
/// contentShape a clear row took clicks on the text alone), outlined so the target is visible, filled on hover.
struct NavItem: View {
    let title: String
    let selected: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 8)
        Button(action: action) {
            Text(title).font(.system(size: 13, weight: selected ? .semibold : .regular))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(selected ? DshPalette.ghostFill : hovering ? DshPalette.ghostFill.opacity(0.5) : Color.clear)
                .clipShape(shape)
                .overlay(shape.strokeBorder(selected ? DshPalette.borderL3 : DshPalette.borderL2, lineWidth: 1))
                .contentShape(shape)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

private struct OverviewPage: View {
    @ObservedObject var model: SettingsModel
    @State private var confirm: Confirm?
    var s: SettingsStrings { model.strings }

    private enum Confirm: Identifiable { case stop, restart; var id: Int { self == .stop ? 0 : 1 } }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(s.overview).font(.system(size: 24, weight: .bold))
            Text(s.overviewNote).font(.system(size: 12.5)).foregroundColor(DshPalette.labelSecondary)
        }
        if let m = model.message { Text(m).font(.system(size: 12)).foregroundColor(DshPalette.danger) }
        // One row of three cards, equal width and height (the design's status grid).
        HStack(alignment: .top, spacing: 14) {
            daemonCard
            permissionsCard
            defaultCard
        }
        .fixedSize(horizontal: false, vertical: true)
        grantsCard
        refusalsCard
    }

    private var defaultCard: some View {
        Card(title: s.newSessionDefault, fill: true) {
            let m = model.snapshot?.settings.access.defaultMode ?? .ask
            VStack(alignment: .leading, spacing: 6) {
                Text(s.defaultModeName(m)).font(.system(size: 15, weight: .semibold))
                Text(m == .ask ? s.newSessionNote : s.newSessionGranted(m)).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary)
                Button(s.editDefaults) { model.page = 2 }.padding(.top, 2)
            }.padding(.horizontal, 18).padding(.bottom, 14)
        }
    }

    private var daemonCard: some View {
        Card(title: s.daemon, fill: true) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Circle().fill(DshPalette.success).frame(width: 8, height: 8)
                    Text(s.running).font(.system(size: 15, weight: .semibold))
                }
                if let snap = model.snapshot {
                    Text("\(s.uptime) \(uptime(since: snap.startedAt)) · \(s.noAutostart)").font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary)
                } else {
                    Text(s.waiting).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary)
                }
                HStack(spacing: 8) {
                    Button(s.stop) { confirm = .stop }
                    Button(s.restart) { confirm = .restart }
                    Button(s.selfCheck) { model.runSelfCheck() }.disabled(model.selfCheck == .running)
                }
                switch model.selfCheck {
                case .idle: EmptyView()
                case .running: Text(s.selfCheckRunning).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary)
                case .passed(let ms): Text(s.selfCheckOK(ms: ms)).font(.system(size: 12, weight: .semibold)).foregroundColor(DshPalette.success)
                case .failed(let why): Text(s.selfCheckFailed(why)).font(.system(size: 12)).foregroundColor(DshPalette.danger)
                }
            }.padding(.horizontal, 18).padding(.bottom, 14)
        }
        .alert(confirm == .restart ? s.restart : s.stop, isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } })) {
            if confirm == .restart {
                Button(s.restart) { model.restartDaemon() }
            } else {
                Button(s.stop, role: .destructive) { model.stopDaemon() }
            }
            Button(s.cancel, role: .cancel) {}
        } message: { Text(confirm == .restart ? s.restartReason : s.stopDaemonReason) }
    }

    private var permissionsCard: some View {
        Card(title: s.permissions, fill: true) {
            VStack(alignment: .leading, spacing: 6) {
                permission(s.accessibility, model.axTrusted ? .granted : .missing, pane: "Privacy_Accessibility")
                permission(s.screenRecording, model.screenCapture ? .granted : .missing, pane: "Privacy_ScreenCapture")
                permission(s.inputMonitoring, model.inputMonitoring, pane: "Privacy_ListenEvent")
                Text(s.inputMonitoringNote).font(.system(size: 11.5)).foregroundColor(DshPalette.labelTertiary).padding(.top, 2)
            }.padding(.horizontal, 18).padding(.bottom, 14)
        }
    }

    private var grantsCard: some View {
        Card(title: s.activeGrants, trailing: AnyView(
            Button(s.revokeAll) { model.revokeAll() }.disabled(model.snapshot?.grants.isEmpty ?? true)
        )) {
            if let snap = model.snapshot, !snap.grants.isEmpty {
                BoundedList {
                    ForEach(snap.grants, id: \.taskID) { g in
                        ForEach(g.apps, id: \.bundleID) { a in
                            Row {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(name(of: a.bundleID)).font(.system(size: 13, weight: .semibold))
                                    Mono(text: a.bundleID)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                                modeChip(a.mode).frame(width: 90, alignment: .leading)
                                Text(lasts(a)).font(.system(size: 12)).frame(width: 150, alignment: .leading)
                                // One row per task (dsh conversation): two conversations in one dsh show the same app
                                // twice, each with its own approval, so the session is named (2026-10-16).
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(sourceText(g)).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary)
                                    if g.ownerGone {
                                        Text(s.processGone).font(.system(size: 11, weight: .semibold)).foregroundColor(DshPalette.danger)
                                    } else {
                                        Mono(text: "\(s.session) \(shortTask(g.taskID))")
                                    }
                                }.frame(width: 190, alignment: .leading)
                                Button(s.revoke) { model.revoke(taskID: g.taskID) }
                            }
                            .opacity(g.ownerGone ? 0.55 : 1)
                        }
                    }
                }
            } else {
                Row { Text(model.snapshot == nil ? s.waiting : s.noneActive).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary) }
            }
        }
    }

    private var refusalsCard: some View {
        Card(title: s.recentRefusals, subtitle: s.refusalsNote) {
            if model.refusals.isEmpty {
                Row { Text(s.noRefusals).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary) }
            } else {
                BoundedList {
                    ForEach(Array(model.refusals.enumerated()), id: \.offset) { _, r in
                        Row {
                            Mono(text: when(r.at)).frame(width: 96, alignment: .leading)
                            Text(s.attempted(r, appName: name(of:))).font(.system(size: 12.5)).frame(maxWidth: .infinity, alignment: .leading)
                            HStack(spacing: 6) {
                                Chip(text: s.reason(r), fill: DshPalette.floorChip, fg: DshPalette.floorChipText)
                                Mono(text: r.reason)
                            }.frame(width: 300, alignment: .leading)
                        }
                    }
                }
            }
        }
    }

    private static let clock: DateFormatter = { let f = DateFormatter(); f.dateFormat = "HH:mm:ss"; return f }()

    /// "HH:mm:ss" today; yesterday's rows (the list covers two days) say so.
    private func when(_ d: Date) -> String {
        Calendar.current.isDateInToday(d) ? Self.clock.string(from: d) : "\(s.yesterday) \(Self.clock.string(from: d))"
    }

    private func permission(_ label: String, _ state: PermissionState, pane: String) -> some View {
        HStack(spacing: 10) {
            Text(label).font(.system(size: 13))
            Spacer()
            switch state {
            case .granted: Text(s.granted).font(.system(size: 13, weight: .semibold)).foregroundColor(DshPalette.success)
            case .missing: Text(s.missing).font(.system(size: 13, weight: .semibold)).foregroundColor(DshPalette.danger)
            case .notRequested: Text(s.notRequested).font(.system(size: 13)).foregroundColor(DshPalette.labelSecondary)
            }
            Button(s.openSystemSettings) { model.openSystemSettings(pane: pane) }
        }
    }

    private func modeChip(_ m: AppMode?) -> some View {
        switch m {
        case .read: return Chip(text: s.read, fill: DshPalette.readChip, fg: DshPalette.readChipText)
        case .full: return Chip(text: s.full, fill: DshPalette.fullChip, fg: DshPalette.fullChipText)
        case nil: return Chip(text: s.configGrant, fill: DshPalette.floorChip, fg: DshPalette.floorChipText)
        }
    }

    private func lasts(_ a: ActiveAppInfo) -> String {
        switch a.scope {
        case .turn: return s.scopeTurn
        case .always: return s.scopeAlways
        default:
            let left = max(0, Int(a.expiresAt.timeIntervalSinceNow))
            return "\(a.scope == .session ? s.scopeSession : s.configGrant) · \(s.left) \(left / 60):\(String(format: "%02d", left % 60))"
        }
    }

    /// The task id as dsh shows a session: without the `dsh-` prefix, its first 8 characters.
    private func shortTask(_ id: String) -> String { String(id.replacingOccurrences(of: "dsh-", with: "").prefix(8)) }

    private func sourceText(_ g: ActiveGrantInfo) -> String {
        g.source == .config ? s.configGrant : "\(s.byDialog) · \(s.process) \(g.ownerPID.map(String.init) ?? "?")"
    }

    private func uptime(since: Date) -> String {
        let secs = Int(Date().timeIntervalSince(since))
        return secs >= 3600 ? "\(secs / 3600) h \(secs % 3600 / 60) min" : "\(secs / 60) min"
    }
}

/// Regular apps running now, (bundle ID, name), by name: the pickers' menu.
func runningAppChoices() -> [(String, String)] {
    NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular }
        .compactMap { a in a.bundleIdentifier.map { ($0, a.localizedName ?? $0) } }
        .sorted { $0.1.localizedCaseInsensitiveCompare($1.1) == .orderedAscending }
}

/// An app chosen in the open panel, as a bundle ID; nil when cancelled.
func chooseAppBundleID() -> String? {
    let panel = NSOpenPanel()
    panel.allowedContentTypes = [.applicationBundle]
    panel.directoryURL = URL(fileURLWithPath: "/Applications")
    panel.canChooseDirectories = false
    guard panel.runModal() == .OK, let url = panel.url else { return nil }
    return Bundle(url: url)?.bundleIdentifier
}

/// An app's display name as the system knows it, falling back to the bundle ID.
func name(of bundleID: String) -> String {
    if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
        let n = FileManager.default.displayName(atPath: url.path)
        return n.hasSuffix(".app") ? String(n.dropLast(4)) : n
    }
    return bundleID
}

// MARK: - The window

/// The settings window can stand aside while an approval dialog is open (MacApprovalPresenter): then it can be neither
/// key nor main, so AppKit does not hand it the key when the dialog closes (WindowServer log, 2026-10-16 21:45 and
/// 21:47; WindowPutBack). That does not keep it back when the dialog activates the daemon: the app's windows come
/// forward together (2026-10-20), so one behind another app's window is also ordered out meanwhile (standAside).
final class SettingsNSWindow: NSWindow {
    var standsAside = false
    override var canBecomeKey: Bool { !standsAside && super.canBecomeKey }
    override var canBecomeMain: Bool { !standsAside && super.canBecomeMain }
}

@MainActor
final class SettingsWindowController {
    static var shared: SettingsWindowController?
    private let window: SettingsNSWindow
    private let model: SettingsModel

    private let audit: AuditSink
    /// Where the window was when the open approval dialog appeared (standAside); nil without one, or once the window
    /// was asked for meanwhile (show).
    private var aside: WindowPlace?
    /// Ordered out for the open dialog (WindowPutBack.setsAside), to be ordered back in by putBack.
    private var setAside = false

    init(server: Server, dispatcher: Dispatcher, audit: AuditSink, auditDir: URL, version: String) {
        self.audit = audit
        model = SettingsModel(server: server, dispatcher: dispatcher, audit: audit, auditDir: auditDir, version: version, lang: .resolve(nil))
        window = SettingsNSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 660),
                                  styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = model.strings.title
        window.contentView = NSHostingView(rootView: SettingsRootView(model: model))
        window.isReleasedWhenClosed = false
        window.center()
    }

    /// Shows the window with dsh's current appearance and fresh state; the daemon is brought forward for it.
    func show(page: Int? = nil) {
        let (pref, from) = DshThemePreference.resolve(homes: DshTheme.homes)
        window.appearance = DshTheme.appearance(for: pref)
        audit.record(["method": "settings.open", "decision": "allow", "appearance": .string(pref.rawValue),
                      "appearance_from": from.map { .string($0.path) } ?? .null])
        if let page { model.page = page }
        model.refresh()
        // Asked for while a dialog is open: it stays where the person asked for it, and takes the key after the
        // dialog like any window.
        aside = nil
        setAside = false
        window.standsAside = false
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    // MARK: Standing aside for the approval dialog (MacApprovalPresenter)

    /// Visible on some Space, or ordered out for the dialog: the hand-back then does not hide the daemon, which would
    /// hide the window too.
    var onScreen: Bool { window.isVisible || setAside }

    /// The dialog is about to open: the window's place is noted and it stands aside.
    func standAside() {
        let before = place(ScreenWindows.list())
        aside = before
        window.standsAside = true
        // Behind another app's window, it would come forward with the daemon's activation all the same (the window
        // group comes along, key or not; 2026-10-20): out of sight until the dialog has closed.
        setAside = WindowPutBack.setsAside(before)
        if setAside { window.orderOut(nil) }
    }

    /// After the dialog closed (right after, then again once the focus went back): puts the window back where the
    /// dialog found it. True when it had moved.
    func putBack() -> Bool {
        guard let before = aside else { return false }
        let screen = ScreenWindows.list()
        let me = ProcessInfo.processInfo.processIdentifier
        let steps = WindowPutBack.steps(from: place(screen), to: before, onScreen: WindowPutBack.others(screen, me: me),
                                        daemonActive: NSApp.isActive, setAside: setAside)
        for step in steps {
            switch step {
            case .miniaturize: window.miniaturize(nil)
            case .deminiaturize: window.deminiaturize(nil)
            case .orderOut: window.orderOut(nil)
            case .orderBelow(let other): window.order(.below, relativeTo: other)
            case .orderFront: window.orderFrontRegardless()
            case .makeKey:
                window.standsAside = false
                window.makeKeyAndOrderFront(nil)
            }
        }
        return !steps.isEmpty
    }

    /// The dialog is over: the window may be key and main again.
    func endAside() {
        aside = nil
        setAside = false
        window.standsAside = false
    }

    private func place(_ screen: [ScreenWindow]) -> WindowPlace {
        WindowPutBack.place(window.windowNumber, visible: window.isVisible, miniaturized: window.isMiniaturized,
                            key: window.isKeyWindow, screen: screen, me: ProcessInfo.processInfo.processIdentifier)
    }
}

/// The windows on screen now (the current Space), front to back: numbers, owners and layers, no titles.
enum ScreenWindows {
    static func list() -> [ScreenWindow] {
        let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
        return info.compactMap { w in
            guard let number = (w[kCGWindowNumber as String] as? NSNumber)?.intValue,
                  let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                  let layer = (w[kCGWindowLayer as String] as? NSNumber)?.intValue else { return nil }
            return ScreenWindow(number: number, pid: pid, layer: layer)
        }
    }
}
