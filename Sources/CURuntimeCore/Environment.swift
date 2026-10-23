import CoreGraphics
import Foundation

/// What came of handing an app something to open (apps.launch `open`).
public enum OpenOutcome: Equatable {
    case opened
    /// No answer within the wait. For a file in a folder macOS protects (Desktop, Documents, Downloads, …) the usual
    /// reason: macOS is asking the user whether this daemon may read that folder, and LaunchServices waits for the
    /// answer (VM, 2026-10-15: 10 s, then the dialog was answered at 27 s and the file opened).
    case timedOut
    /// macOS refused this daemon the file. Not seen for a folder the user did not allow: LaunchServices then hands
    /// the file to the app without asking, and the app opens it (VM, 2026-10-15). Kept for whatever else answers so.
    case noPermission
    case failed(String)
}

/// Who would receive a click at a point. Owners are lowercased bundle IDs, or "pid:<n>" without a bundle.
/// Safety premise (audit L3): the system-wide AX hit test follows the window server's click routing, so it names an
/// invisible (alpha 0) window that takes clicks, which the window list skips. An action proceeds only if both
/// agree on the target app; no AX answer means refuse (fail closed). Regression: geometry suite
/// `occlusion-invisible` and its click-through control `occlusion-invisible-clickthrough`.
/// One exception (2026-10-14): an app that does not implement the AX hit test at all (kAXErrorNotImplemented, as
/// WeChat 4 answers for every point) is decided by the window list with invisible windows counted, so an alpha-0
/// window that takes clicks still refuses the click; the decision is audited as `hit_test: window_list_only`.
public struct HitTest: Sendable, Equatable {
    /// Topmost window in the window list (overlays expanded, read fresh), or nil if there is none.
    public let cg: String?
    /// Owner of the AX element at the point, or nil if the AX hit test gave no answer.
    public let ax: String?
    /// When `ax` differs from `cg`: the intercepting window's frame (or the AX element's), if known.
    public let axRegion: CGRect?
    /// A system overlay's visible parts (the Dock bar) could not be read now, so the window list treats the whole
    /// overlay as covering (unknown means refuse). Transient: the Dock does not answer while it animates a launch.
    public let overlayUnknown: Bool
    /// The AX hit test answered "not implemented" (the app under the point does not support it), not merely no
    /// answer. Only then `cgWithInvisible` is read.
    public let axNotImplemented: Bool
    /// Topmost window at the point counting invisible (alpha 0) windows too, overlays expanded; nil unless
    /// `axNotImplemented`.
    public let cgWithInvisible: String?

    public init(cg: String?, ax: String?, axRegion: CGRect? = nil, overlayUnknown: Bool = false,
                axNotImplemented: Bool = false, cgWithInvisible: String? = nil) {
        self.cg = cg
        self.ax = ax
        self.axRegion = axRegion
        self.overlayUnknown = overlayUnknown
        self.axNotImplemented = axNotImplemented
        self.cgWithInvisible = cgWithInvisible
    }
}

/// One pasteboard type's data of one clipboard item (PasteboardContents).
public struct PasteboardEntry: Sendable, Equatable {
    public let type: String
    public let data: Data
    public init(type: String, data: Data) {
        self.type = type
        self.data = data
    }
}

/// The clipboard as found before a paste: items in order, each with every type it carries, and their total bytes.
public struct PasteboardContents: Sendable, Equatable {
    public var items: [[PasteboardEntry]]
    public var bytes: Int
    public init(items: [[PasteboardEntry]], bytes: Int) {
        self.items = items
        self.bytes = bytes
    }
}

/// The OS surface the policy layer needs. The daemon supplies an AppKit implementation; tests supply a fake.
/// Bundle IDs returned here are lowercased.
public protocol SystemEnvironment: AnyObject {
    func runningBundleIDs() -> Set<String>
    func runningPIDs(bundleID: String) -> [Int32]
    /// The executable a process runs now, or nil if no process has the PID (GrantOwner: approvals of a client that
    /// has exited end, so its successor is asked again).
    func processPath(pid: Int32) -> String?
    /// The names an app goes by on screen: the running app's localized name, the bundle's display and short names,
    /// the .app's file name. Only asked about bundle IDs already in a grant (Dispatcher.resolveAppName).
    func displayNames(bundleID: String) -> [String]
    func frontmostBundleID() -> String?
    /// macOS session lock state (2026-10-16): true locked, false unlocked on the console, nil unknown.
    func sessionLocked() -> Bool?
    /// act.type strategy paste: the clipboard's items (every type's data), or nil if any cannot be read.
    /// Reading stops past `limit` bytes (`bytes` then exceeds it).
    func pasteboardSnapshot(limit: Int) -> PasteboardContents?
    /// Replaces the clipboard with plain text; the new change count, or nil if writing failed.
    func pasteboardWrite(text: String) -> Int?
    func pasteboardChangeCount() -> Int
    /// Puts saved contents back; true if written.
    func pasteboardRestore(_ contents: PasteboardContents) -> Bool
    /// Empties the clipboard (the privacy setting "clear the clipboard when a turn starts"); true if done.
    func pasteboardClear() -> Bool
    /// Brings the app forward, then polls frontmost until `timeout`. True only if it verifiably became frontmost.
    func activate(bundleID: String, timeout: TimeInterval, method: ActivationMethod) -> Bool
    /// Who would receive a click at a global point, asked two ways (see HitTest).
    func hitTest(at point: CGPoint) -> HitTest
    func launch(bundleID: String) -> Bool
    /// Has the app open a file or web address (apps.launch `open`, checked by OpenTarget first), starting it if needed.
    func open(_ url: URL, bundleID: String) -> OpenOutcome
    /// Sets Electron's AXManualAccessibility on every process of the app. True if all writes succeeded.
    func setManualAccessibility(bundleID: String, enabled: Bool) -> Bool
    /// Cheap AX node count over the app's windows (same limits as a snapshot); used to wait for the tree to settle.
    func countAXNodes(bundleID: String) -> Int
    /// Whether the app has a window a capture could show (no tree walk): asked before any wait (WindowPresence).
    func windowPresence(bundleID: String) -> WindowPresence
    /// AX snapshot of the requested apps' windows, plus (optionally) one SCK capture of only those apps and OCR.
    func observe(_ request: ObserveRequest) -> ObserveResult
    /// Current frames of on-screen windows by ID (to detect windows that moved since a snapshot).
    func currentWindowFrames() -> [UInt32: CGRect]
    /// Re-reads an AX element observed earlier: its fingerprint and frame now, or nil if it is gone.
    func refreshElement(handle: Int) -> (fingerprint: String, frame: CGRect?)?
    /// ID of the topmost on-screen window at a global point (overlays expanded), if any.
    func topWindowID(at point: CGPoint) -> UInt32?
    /// Raises the app's window under `point` and makes it main/focused, so the click is not swallowed as a
    /// window-activation click. True only once that window verifiably is the app's focused window.
    func focusWindow(at point: CGPoint, bundleID: String) -> Bool
    /// Posts a real click (mouseMoved, then down/up `count` times with the click state set) at a global point.
    func click(at point: CGPoint, button: MouseButton, count: Int) -> Bool
    /// Scroll-wheel lines at a global point (mouse moved there first). Positive dy scrolls content up.
    func scroll(at point: CGPoint, dx: Int, dy: Int) -> Bool
    /// Left-button drag: down at `from`, dragged moves in steps, up at `to`.
    func drag(from: CGPoint, to: CGPoint) -> Bool
    /// Posts the steps in order; before each step asks `shouldContinue` (the target still frontmost) and stops if
    /// not. Returns how many steps were posted.
    func type(_ steps: [TypingPlan.Step], shouldContinue: () -> Bool) -> Int
    /// Real key events: modifier downs, the key down/up, modifier ups in reverse.
    func press(_ chord: KeyChord) -> Bool
    /// AX actions an element observed earlier supports, or nil if it is gone.
    func axActions(handle: Int) -> [String]?
    func axPerform(handle: Int, action: String) -> Bool
    /// The app's menu bar over AX (Menu.swift): list the menu at `path`, or press the item it ends at.
    func menu(bundleID: String, path: [String], press: Bool) -> MenuOutcome
    /// Whether the element's AXValue can be set (without setting it).
    func axValueSettable(handle: Int) -> Bool
    /// True if the element's AXValue is settable and was set.
    func axSetValue(handle: Int, value: String) -> Bool
    /// Makes the element the focused element (kAXFocusedAttribute).
    func axFocus(handle: Int) -> Bool
    /// The element's current AXValue as a string, or nil if it has none (used to verify typed text arrived).
    func axValue(handle: Int) -> String?
    /// A fresh luma thumbnail of one window (same resolution as the OCR cache's), or nil if it cannot be captured.
    func windowThumb(windowID: UInt32) -> LumaThumb?
    /// Why typing must not happen now, or nil: the element (else the app's focused element) is a password field
    /// (AXSecureTextField, as role or subrole), or the system's secure event input is on. Read at action time.
    func secureInputReason(bundleID: String, handle: Int?) -> String?
    /// cu_zoom: fresh capture of `request.windows`, composited with occlusion blocks over `request.geometry`,
    /// scaled to `request.sentSize`; plus OCR (cached) of those windows, restricted to the zoom rect.
    func zoom(_ request: ZoomRequest) -> ZoomResult
    /// The keyboard input source typing currently goes through (global system state).
    func currentInputSource() -> InputSourceInfo?
    /// The ASCII-capable layout the system pairs with the current input method (ABC, US…).
    func asciiInputSourceID() -> String?
    /// Selects an enabled input source; true only if it then verifiably is the current one.
    func selectInputSource(id: String) -> Bool
    /// Whether the current input method holds an uncommitted composition (the user is mid-word): true / false, or
    /// nil when it cannot be told. `bundleID`: the app being typed into, if known.
    func imeComposing(bundleID: String?) -> Bool?
    /// VM experiment only (config `debug_ime`): raw material for telling an uncommitted composition apart.
    func debugIMEProbe(bundleID: String) -> JSONValue
}

public struct InputSourceInfo: Sendable, Equatable {
    public let id: String
    /// An input method (Pinyin, Kotoeri…), which can hold an uncommitted composition, as opposed to a layout.
    public let isInputMethod: Bool
    public let asciiCapable: Bool
    public let bundleID: String?
    /// The name the system shows for it (简体拼音), for the person asked to approve a switch.
    public let name: String?

    public init(id: String, isInputMethod: Bool, asciiCapable: Bool, bundleID: String? = nil, name: String? = nil) {
        self.id = id
        self.isInputMethod = isInputMethod
        self.asciiCapable = asciiCapable
        self.bundleID = bundleID
        self.name = name
    }
}
