import Foundation

/// The three permissions the settings page shows. `inputMonitoring` is nil when it cannot be read.
public struct SettingsPermissions: Equatable, Sendable {
    public var accessibility, screenRecording: Bool
    public var inputMonitoring: Bool?

    public init(accessibility: Bool, screenRecording: Bool, inputMonitoring: Bool?) {
        self.accessibility = accessibility
        self.screenRecording = screenRecording
        self.inputMonitoring = inputMonitoring
    }
}

/// What only the Mac can do for the settings (main: open/save panels and NSWorkspace; tests: a fake; nil when
/// headless). Every file path the settings use comes from here, chosen by a person at the Mac, never over the socket
/// (PLAN 阶段3 二 A). Completions are called once, on any thread; nil or false means the person cancelled or it failed.
public protocol SettingsPanels: AnyObject {
    /// An existing directory the person picked (the log directory).
    func chooseDirectory(completion: @escaping @Sendable (URL?) -> Void)
    /// The bundle ID of the .app the person picked.
    func chooseApp(completion: @escaping @Sendable (String?) -> Void)                 // a bundle ID
    /// Writes `contents` where the person chose in a save panel, mode 0600; true when written.
    func saveFile(suggestedName: String, contents: Data, completion: @escaping @Sendable (Bool) -> Void)  // 0600
    /// The contents of the file the person picked in an open panel limited to `allowedExtensions`.
    func openFile(allowedExtensions: [String], completion: @escaping @Sendable (Data?) -> Void)
    /// Shows `url` in the Finder.
    func reveal(_ url: URL)
    /// The permissions as the system reports them now.
    func permissions() -> SettingsPermissions
    /// The installed app's display name, nil when it is not found.
    func appName(_ bundleID: String) -> String?
}
