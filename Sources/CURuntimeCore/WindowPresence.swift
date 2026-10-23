import Foundation

/// Where a granted app's windows are, asked before observe waits for anything (2026-10-09: a minimized QQ cost 8 s,
/// 5 s waiting for an AX tree that could not grow and 2.5 s for a window that could not appear). Only `visible`
/// (or an app this daemon just launched) is worth waiting for; the others are said to the model at once, with what
/// brings the window back (apps.launch: read for a running app).
public enum WindowPresence: String, Sendable {
    case notRunning = "not_running"
    /// Every process of the app is hidden (cmd+H).
    case hidden
    /// It has windows, all minimized to the Dock.
    case minimized
    /// Running, not hidden, no window (closed, on another Space, or a menu-bar app).
    case noWindows = "no_windows"
    /// At least one window that is not minimized; also the answer when AX could not tell (the old behaviour).
    case visible
}
