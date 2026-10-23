import Foundation

/// cu_menu (2026-10-09, after 2e: the menu bar was out of reach): an app's own menu bar through AX only, no capture.
/// A path ending at a menu lists its items; one ending at an item presses it. Full mode only (ActionKind.menu).
/// Never reachable: the Apple menu (shut down, restart, sleep, log out, System Settings, force quit) and the Services
/// submenu (it runs any installed service on the selection).
public struct MenuItemInfo: Sendable, Equatable {
    public let title: String
    public let enabled: Bool
    public let submenu: Bool
    public init(title: String, enabled: Bool, submenu: Bool) {
        self.title = title
        self.enabled = enabled
        self.submenu = submenu
    }
}

public enum MenuOutcome: Sendable, Equatable {
    case listed([MenuItemInfo])
    case pressed
    /// No item at `level` (0-based in the path) has that title; `available` are the titles there.
    case notFound(level: Int, available: [String])
    case ambiguous(level: Int)
    case disabled
    case excluded(String)
    /// No menu bar over AX (not running, no AX answer).
    case unavailable
}

public enum MenuPolicy {
    /// Titles of the Services submenu (the app menu's "Services"), compared after `key`.
    static let services: Set<String> = ["services", "服务", "服務", "サービス"]

    /// Why an item at `level` may never be listed or pressed, or nil. The Apple menu is excluded by the environment
    /// by position (the menu bar's first item), not by title.
    public static func exclusion(title: String) -> String? {
        services.contains(key(title)) ? "the Services submenu runs any installed service" : nil
    }

    /// Titles compare trimmed, case-insensitively, with "..." and "…" alike.
    public static func key(_ s: String) -> String {
        s.precomposedStringWithCanonicalMapping.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "...", with: "…").lowercased()
    }
}
