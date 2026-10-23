import Foundation

/// Apps no grant can ever cover (docs/DESIGN.md "Hard-deny list"), and whose being frontmost halts every action.
/// Compiled in; configuration cannot unlock them. Matching is case-insensitive, like LaunchServices.
/// This is a backstop: the main defence is that grants name exact bundle IDs.
public enum HardDeny {
    public enum Verified: String, Sendable {
        /// Read from the app's Info.plist on macOS 26.3.1, 2026-09-28.
        case localInfoPlist
        /// Read from the project's own source repo (Info.plist / Xcode project / build metadata).
        case upstreamSource
        /// Best available secondary evidence (Homebrew cask); kept anyway because a false entry costs nothing.
        case unverified
    }

    /// How the settings window groups the list (the design's four groups).
    public enum Category: String, Sendable, CaseIterable {
        /// The system's own surfaces: login, Dock, menu bar, settings, utilities that change the machine.
        case systemUI
        /// Authentication prompts and secret stores.
        case authentication
        /// Anything that runs arbitrary code: terminals, editors, script runners.
        case runsCode
        /// This daemon, and remote control or whole-machine transfer.
        case selfAndRemote
    }

    public struct Entry: Sendable {
        public let bundleID: String
        public let reason: String
        public let verified: Verified
        public let category: Category

        public init(bundleID: String, reason: String, verified: Verified, category: Category) {
            self.bundleID = bundleID
            self.reason = reason
            self.verified = verified
            self.category = category
        }
    }

    /// This daemon's own bundle ID (scripts/build-app.sh).
    public static let daemon = "dev.cu-runtime.daemon"

    public static let entries: [Entry] = [
        // The first list: system UI, authentication prompts, secrets, Terminal.
        .init(bundleID: "com.apple.loginwindow", reason: "session/login", verified: .localInfoPlist, category: .systemUI),
        .init(bundleID: "com.apple.dock", reason: "system shell", verified: .localInfoPlist, category: .systemUI),
        .init(bundleID: "com.apple.systemuiserver", reason: "menu bar extras", verified: .localInfoPlist, category: .systemUI),
        .init(bundleID: "com.apple.controlcenter", reason: "system controls", verified: .localInfoPlist, category: .systemUI),
        .init(bundleID: "com.apple.notificationcenterui", reason: "system notifications", verified: .localInfoPlist, category: .systemUI),
        .init(bundleID: "com.apple.SecurityAgent", reason: "authentication prompts", verified: .localInfoPlist, category: .authentication),
        .init(bundleID: "com.apple.systempreferences", reason: "System Settings", verified: .localInfoPlist, category: .systemUI),
        .init(bundleID: "com.apple.keychainaccess", reason: "secrets", verified: .localInfoPlist, category: .authentication),
        .init(bundleID: "com.apple.Terminal", reason: "terminal", verified: .localInfoPlist, category: .runsCode),
        // This daemon: its approval dialogs must be out of the model's reach (no observe, no click on "allow").
        .init(bundleID: HardDeny.daemon, reason: "this daemon (approval dialogs)", verified: .upstreamSource, category: .selfAndRemote),

        // Decided 2026-09-28. Auth / consent prompts: the hit test already refuses clicks on them;
        // listing them guarantees they can never be granted either.
        .init(bundleID: "com.apple.LocalAuthentication.UIAgent", reason: "Touch ID / password prompt", verified: .localInfoPlist, category: .authentication),
        // Hosts CFUserNotification alerts; believed to host TCC consent prompts (not observed in the VM yet).
        .init(bundleID: "com.apple.UserNotificationCenter", reason: "system alerts / consent prompts", verified: .localInfoPlist, category: .authentication),
        .init(bundleID: "com.apple.Passwords", reason: "secrets", verified: .localInfoPlist, category: .authentication),
        .init(bundleID: "com.apple.ScreenSharing", reason: "remote control", verified: .localInfoPlist, category: .selfAndRemote),
        .init(bundleID: "com.apple.MigrateAssistant", reason: "moves all user data", verified: .localInfoPlist, category: .selfAndRemote),
        .init(bundleID: "com.apple.ScriptEditor2", reason: "runs scripts", verified: .localInfoPlist, category: .runsCode),
        .init(bundleID: "com.apple.Automator", reason: "runs workflows", verified: .localInfoPlist, category: .runsCode),
        .init(bundleID: "com.apple.shortcuts", reason: "runs shortcuts", verified: .localInfoPlist, category: .runsCode),
        .init(bundleID: "com.apple.ActivityMonitor", reason: "kills processes", verified: .localInfoPlist, category: .systemUI),
        .init(bundleID: "com.apple.DiskUtility", reason: "erases disks", verified: .localInfoPlist, category: .systemUI),
        .init(bundleID: "com.apple.installer", reason: "installs software", verified: .localInfoPlist, category: .systemUI),
        .init(bundleID: "com.apple.SoftwareUpdate", reason: "system updates", verified: .localInfoPlist, category: .systemUI),
        .init(bundleID: "com.apple.DirectoryUtility", reason: "directory services", verified: .localInfoPlist, category: .systemUI),
        .init(bundleID: "com.apple.Spotlight", reason: "launches anything", verified: .localInfoPlist, category: .systemUI),
        .init(bundleID: "com.apple.Siri", reason: "system assistant", verified: .localInfoPlist, category: .systemUI),
        .init(bundleID: "com.apple.WindowManager", reason: "Stage Manager", verified: .localInfoPlist, category: .systemUI),

        // Terminals.
        .init(bundleID: "dev.warp.Warp-Stable", reason: "terminal", verified: .localInfoPlist, category: .runsCode),
        .init(bundleID: "com.googlecode.iterm2", reason: "terminal", verified: .upstreamSource, category: .runsCode),  // iTerm2.xcodeproj
        .init(bundleID: "net.kovidgoyal.kitty", reason: "terminal", verified: .upstreamSource, category: .runsCode),  // setup.py + constants.py
        .init(bundleID: "com.github.wez.wezterm", reason: "terminal", verified: .upstreamSource, category: .runsCode),  // assets/macos Info.plist
        .init(bundleID: "org.alacritty", reason: "terminal", verified: .upstreamSource, category: .runsCode),  // extra/osx Info.plist

        // Editors / IDEs / launchers that run arbitrary code.
        .init(bundleID: "com.apple.dt.Xcode", reason: "runs code", verified: .localInfoPlist, category: .runsCode),
        .init(bundleID: "com.microsoft.VSCode", reason: "integrated terminal", verified: .localInfoPlist, category: .runsCode),
        .init(bundleID: "org.python.PythonLauncher", reason: "runs .py files", verified: .upstreamSource, category: .runsCode),  // cpython Mac/PythonLauncher
        .init(bundleID: "com.todesktop.230313mzl4w4u92", reason: "Cursor: integrated terminal", verified: .unverified, category: .runsCode),
        .init(bundleID: "com.google.android.studio", reason: "runs code", verified: .unverified, category: .runsCode),
        // Zed's channels differ by "-Suffix", not by a dot segment, so they are listed exactly (crates/zed/Cargo.toml).
        .init(bundleID: "dev.zed.Zed", reason: "runs code", verified: .upstreamSource, category: .runsCode),
        .init(bundleID: "dev.zed.Zed-Preview", reason: "runs code", verified: .upstreamSource, category: .runsCode),
        .init(bundleID: "dev.zed.Zed-Nightly", reason: "runs code", verified: .upstreamSource, category: .runsCode),
        .init(bundleID: "dev.zed.Zed-Dev", reason: "runs code", verified: .upstreamSource, category: .runsCode),
    ]

    /// Namespaces matched by whole dot-separated segments: "com.jetbrains" covers "com.jetbrains" and
    /// "com.jetbrains.pycharm", but not "com.jetbrainsfoo.app".
    public static let namespaces: [Entry] = [
        .init(bundleID: "com.mitchellh.ghostty", reason: "terminal (incl. .debug build)", verified: .upstreamSource, category: .runsCode),
        .init(bundleID: "com.sublimetext", reason: "Python console (ID carries the major version)", verified: .unverified, category: .runsCode),
        .init(bundleID: "com.jetbrains", reason: "JetBrains IDEs and Toolbox run code", verified: .unverified, category: .runsCode),
    ]

    public static let finder = "com.apple.finder"

    private static let index: [String: Entry] = Dictionary(
        entries.map { ($0.bundleID.lowercased(), $0) }, uniquingKeysWith: { a, _ in a })

    public static func entry(for bundleID: String) -> Entry? {
        let id = bundleID.lowercased()
        return index[id] ?? namespaces.first {
            let ns = $0.bundleID.lowercased()
            return id == ns || id.hasPrefix(ns + ".")
        }
    }
}
