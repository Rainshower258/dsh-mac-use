import Foundation

// MARK: - A daemon window put back after the approval dialog (2026-10-17)
//
// The dialog activates the daemon, and AppKit brings an activated app's main window forward; when the dialog closes
// it hands that window the key and orders it where the dialog was, and the hand-back that follows activates the app
// that was in front, which covers it again (WindowServer log, 2026-10-16 21:45 and 21:47). The settings window, the
// daemon's only window that can be main, came forward with every dialog and never went back. It now stands aside
// while the dialog is open (SettingsNSWindow); as a backstop, its place is noted before the dialog and put back after.
//
// Pure: the Mac side (MacApprovalPresenter, SettingsWindowController) reads the window and the screen (CGWindowList)
// and applies the steps.

/// A window on screen as CGWindowList lists it, front to back.
public struct ScreenWindow: Equatable, Sendable {
    public let number: Int
    public let pid: Int32
    /// 0 for ordinary windows; menus, the Dock, the menu bar and panels above everything have others.
    public let layer: Int

    public init(number: Int, pid: Int32, layer: Int) {
        self.number = number
        self.pid = pid
        self.layer = layer
    }
}

/// Where a daemon window is.
public struct WindowPlace: Equatable, Sendable {
    /// Ordered in (on some Space) and not minimized.
    public var visible: Bool
    public var miniaturized: Bool
    /// The key window: the person was using it.
    public var key: Bool
    /// Listed on screen, so on the current Space: only then does `covering` say where it is.
    public var onActiveSpace: Bool
    /// Other apps' ordinary windows in front of it, nearest first.
    public var covering: [Int]

    public init(visible: Bool, miniaturized: Bool, key: Bool, onActiveSpace: Bool, covering: [Int]) {
        self.visible = visible
        self.miniaturized = miniaturized
        self.key = key
        self.onActiveSpace = onActiveSpace
        self.covering = covering
    }
}

public enum WindowStep: Equatable, Sendable {
    case miniaturize
    case deminiaturize
    case orderOut
    /// Directly behind this window (another app's).
    case orderBelow(Int)
    /// In front of every other app's window, without activating the daemon.
    case orderFront
    /// Key again, and so in front: the person was using it and the daemon is still the active app.
    case makeKey
}

public enum WindowPutBack {
    /// The window `number` as the screen lists it (`screen`, front to back); `me` is the daemon's PID, whose other
    /// windows (the dialog) do not count as covering it.
    public static func place(_ number: Int, visible: Bool, miniaturized: Bool, key: Bool, screen: [ScreenWindow],
                             me: Int32) -> WindowPlace {
        guard let i = screen.firstIndex(where: { $0.number == number }) else {
            return WindowPlace(visible: visible, miniaturized: miniaturized, key: key, onActiveSpace: false, covering: [])
        }
        let covering = screen[..<i].reversed().filter { $0.pid != me && $0.layer == 0 }.map(\.number)
        return WindowPlace(visible: visible, miniaturized: miniaturized, key: key, onActiveSpace: true, covering: covering)
    }

    /// Other apps' ordinary windows on screen now: a window that covered ours may have closed meanwhile.
    public static func others(_ screen: [ScreenWindow], me: Int32) -> Set<Int> {
        Set(screen.filter { $0.pid != me && $0.layer == 0 }.map(\.number))
    }

    /// Ordered out while the dialog is open: behind another app's window, which activating the daemon would bring
    /// forward (the app's windows come along, key or not, also when the person clicks the dialog; 2026-10-20).
    /// Only a window on screen has windows covering it: one minimized, closed or on another Space stays, and so does
    /// one in front already or in use.
    public static func setsAside(_ place: WindowPlace) -> Bool {
        !place.key && !place.covering.isEmpty
    }

    /// What takes the window from `after` back to `before`; empty when nothing moved. `onScreen` is `others` now;
    /// `setAside` says the window was ordered out for the dialog (setsAside).
    ///
    /// Only the window directly in front of it counts, so what the person does elsewhere on screen while the dialog
    /// is open changes nothing. A window that was in front of every other app's window is left where it is: what
    /// covers it now may be what the person brought forward meanwhile (they can switch apps while the dialog waits),
    /// and ordering it in front again would cover that. A window on another Space is left where it is too: where it
    /// is there is not listed.
    public static func steps(from after: WindowPlace, to before: WindowPlace, onScreen: Set<Int>,
                             daemonActive: Bool, setAside: Bool = false) -> [WindowStep] {
        if before.miniaturized { return after.miniaturized ? [] : [.miniaturize] }
        if !before.visible { return after.visible || after.miniaturized ? [.orderOut] : [] }
        if setAside && !after.visible {
            // Back in, behind the window that covered it; in front, when every window that did has closed meanwhile.
            return [before.covering.first(where: onScreen.contains).map { .orderBelow($0) } ?? .orderFront]
        }
        var steps: [WindowStep] = after.miniaturized ? [.deminiaturize] : []
        // Not on the current Space now (a Space changed meanwhile, or hidden with the daemon): left there.
        guard before.onActiveSpace, after.onActiveSpace || after.miniaturized else { return steps }
        if before.key {
            // The person was using it: key again while the daemon is still in front; else they went elsewhere.
            if daemonActive && !after.key { steps.append(.makeKey) }
            return steps
        }
        guard let target = before.covering.first(where: onScreen.contains) else { return steps }
        if after.covering.first != target { steps.append(.orderBelow(target)) }
        return steps
    }
}
