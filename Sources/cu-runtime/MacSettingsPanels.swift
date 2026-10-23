import AppKit
import ApplicationServices
import CURuntimeCore
import IOKit.hid
import UniformTypeIdentifiers

/// What only the Mac can do for the settings socket methods (SettingsPanels, C-C): the open and save panels, the
/// Finder, the permissions and the apps' names. Every path the settings use comes from a panel here, chosen by a
/// person at the Mac, never over the socket.
///
/// - The panels are asynchronous: each method returns at once, so the worker never waits on a person. A panel opens
///   from a main run-loop block in the default mode (so never inside the approval dialog's modal loop), non-modal
///   (`begin`), with the daemon activated so it comes up in front of the plugin page that asked for it; when it
///   closes, the app that was frontmost before gets the focus back (the daemon is hard-denied: left frontmost, it
///   would stop the model's next action). Each completion is called exactly once, on any thread; nil or false when the
///   person cancelled or it failed.
/// - Files are read and written off the main thread. A saved file is mode 0600 (written whole, then the mode set
///   again in case the name was an existing file); an opened file must be a regular file of at most `maxOpenBytes`.
/// - `reveal` shows a folder in the Finder (as the settings window does: `open`, else selected in its parent).
/// - `permissions` and `appName` may be called on any thread (the worker): the permissions from AXIsProcessTrusted,
///   CGPreflightScreenCaptureAccess and IOHIDCheckAccess (Input Monitoring nil when the system has no answer yet);
///   names from NSWorkspace (MacAppDirectory: a running app's bundle first, else LaunchServices' copy), nil when the
///   app is not found, each answer (a name or nil) kept for a minute by one AppNameCache (the permissions are not).
final class MacSettingsPanels: SettingsPanels, @unchecked Sendable {
    /// The largest file `openFile` reads (a settings file is a few KiB).
    static let maxOpenBytes = 1 << 20
    private let apps = MacAppDirectory()
    private let names = AppNameCache()

    func chooseDirectory(completion: @escaping @Sendable (URL?) -> Void) {
        Self.run(completion, nil) {
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.canCreateDirectories = true
            panel.allowsMultipleSelection = false
            return panel
        } picked: { url, done in
            var isDir: ObjCBool = false
            let dir = url.standardizedFileURL
            done(FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir) && isDir.boolValue ? dir : nil)
        }
    }

    func chooseApp(completion: @escaping @Sendable (String?) -> Void) {
        Self.run(completion, nil) {
            let panel = NSOpenPanel()
            panel.allowedContentTypes = [.applicationBundle]
            panel.directoryURL = URL(fileURLWithPath: "/Applications")
            panel.canChooseDirectories = false
            panel.allowsMultipleSelection = false
            return panel
        } picked: { url, done in
            done(Bundle(url: url)?.bundleIdentifier)
        }
    }

    func saveFile(suggestedName: String, contents: Data, completion: @escaping @Sendable (Bool) -> Void) {
        Self.run(completion, false) {
            let panel = NSSavePanel()
            panel.nameFieldStringValue = suggestedName
            panel.canCreateDirectories = true
            return panel
        } picked: { url, done in
            DispatchQueue.global(qos: .userInitiated).async { done(Self.write(contents, to: url)) }
        }
    }

    func openFile(allowedExtensions: [String], completion: @escaping @Sendable (Data?) -> Void) {
        Self.run(completion, nil) {
            let panel = NSOpenPanel()
            let types = allowedExtensions.compactMap { UTType(filenameExtension: $0) }
            if !types.isEmpty { panel.allowedContentTypes = types }
            panel.canChooseDirectories = false
            panel.canChooseFiles = true
            panel.allowsMultipleSelection = false
            return panel
        } picked: { url, done in
            DispatchQueue.global(qos: .userInitiated).async { done(Self.read(url)) }
        }
    }

    func reveal(_ url: URL) {
        DispatchQueue.main.async {
            if !NSWorkspace.shared.open(url) { NSWorkspace.shared.activateFileViewerSelecting([url]) }
        }
    }

    func permissions() -> SettingsPermissions {
        let input: Bool?
        switch IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) {
        case kIOHIDAccessTypeGranted: input = true
        case kIOHIDAccessTypeDenied: input = false
        default: input = nil
        }
        return SettingsPermissions(accessibility: AXIsProcessTrusted(), screenRecording: CGPreflightScreenCaptureAccess(),
                                   inputMonitoring: input)
    }

    func appName(_ bundleID: String) -> String? {
        names.name(bundleID) { apps.identity(bundleID: $0)?.name }
    }

    // MARK: helpers

    /// Opens the panel `make` builds on the main thread and hands the picked URL to `picked`, which calls `done` once
    /// with the result; a cancelled panel (or no URL) gives `cancelled`. `completion` is called exactly once.
    private static func run<T>(_ completion: @escaping @Sendable (T) -> Void, _ cancelled: T,
                               make: @escaping @MainActor () -> NSSavePanel,
                               picked: @escaping @MainActor (URL, @escaping @Sendable (T) -> Void) -> Void) {
        let fired = Locked(false)
        let once: @Sendable (T) -> Void = { value in
            guard fired.withLock({ f in defer { f = true }; return !f }) else { return }
            completion(value)
        }
        RunLoop.main.perform(inModes: [.default]) {
            MainActor.assumeIsolated {
                let previous = NSWorkspace.shared.frontmostApplication
                    .flatMap { $0.processIdentifier == ProcessInfo.processInfo.processIdentifier ? nil : $0 }
                let panel = make()
                NSApp.activate(ignoringOtherApps: true)
                panel.level = .modalPanel
                panel.begin { response in
                    MainActor.assumeIsolated {
                        handBack(to: previous)
                        guard response == .OK, let url = panel.url else { once(cancelled); return }
                        picked(url, once)
                    }
                }
            }
        }
    }

    /// The app that was frontmost before the panel gets the focus back; none (the person was in the settings window):
    /// the daemon stays in front.
    @MainActor
    private static func handBack(to previous: NSRunningApplication?) {
        guard let previous, !previous.isTerminated else { return }
        NSApp.yieldActivation(to: previous)
        previous.activate()
    }

    /// Writes `data` to `url` whole, mode 0600; false when it could not.
    /// Writes `data` to `url` as a 0600 file from its first byte: created with O_CREAT's mode (no chmod after a
    /// write under the umask), an existing file truncated and set to 0600, a symlink at `url` refused (O_NOFOLLOW).
    static func write(_ data: Data, to url: URL) -> Bool {
        let fd = open(url.path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        guard fchmod(fd, 0o600) == 0 else { return false }
        return data.withUnsafeBytes { buf -> Bool in
            guard let base = buf.baseAddress else { return true }
            var off = 0
            while off < buf.count {
                let n = Darwin.write(fd, base + off, buf.count - off)
                if n < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                off += n
            }
            return true
        }
    }

    /// The contents of the regular file at `url` when it is at most `maxOpenBytes`, else nil.
    static func read(_ url: URL) -> Data? {
        guard let v = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]), v.isRegularFile == true,
              (v.fileSize ?? 0) <= maxOpenBytes,
              let data = try? Data(contentsOf: url), data.count <= maxOpenBytes else { return nil }
        return data
    }
}
