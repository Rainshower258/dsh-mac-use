import CoreGraphics
import Foundation

/// One on-screen window in the current z-order (any app, including the menu bar, Dock and other system UI).
public struct ZWindow: Sendable, Equatable {
    public let id: UInt32
    /// Lowercased bundle ID, or nil for windows without an owning app bundle.
    public let app: String?
    public let frame: CGRect
    public let granted: Bool

    public init(id: UInt32, app: String?, frame: CGRect, granted: Bool) {
        self.id = id
        self.app = app
        self.frame = frame
        self.granted = granted
    }
}

/// Builds the model's desktop image: only granted windows show content; any other window in
/// front of them is a flat block (no pixels from it), so the model never "sees" what is actually covered.
public enum Composite {
    public enum Op: Sendable, Equatable {
        case window(id: UInt32, frame: CGRect)
        case block(frame: CGRect)
    }

    /// Back-to-front draw operations clipped to `display`. `zOrder` is front-to-back. Granted windows without a
    /// capture are skipped. Non-granted windows only matter where they lie in front of some granted window, so
    /// windows behind every granted window are dropped.
    public static func plan(display: CGRect, zOrder: [ZWindow], captured: Set<UInt32>) -> [Op] {
        guard let deepestGranted = zOrder.lastIndex(where: { $0.granted && captured.contains($0.id) }) else { return [] }
        var ops: [Op] = []
        for w in zOrder[0...deepestGranted].reversed() {
            let clipped = w.frame.intersection(display)
            guard !clipped.isNull, clipped.width > 0, clipped.height > 0 else { continue }
            if w.granted {
                if captured.contains(w.id) { ops.append(.window(id: w.id, frame: w.frame)) }
            } else {
                ops.append(.block(frame: clipped))
            }
        }
        return ops
    }

    /// A granted window at least this much under other apps' windows is reported as covered (observe `covered`).
    public static let coveredFraction = 0.9

    /// How much of one granted window lies under windows of apps not granted: grey in the image.
    public struct Coverage: Sendable, Equatable {
        public let windowID: UInt32
        public let app: String?
        /// Share of the window's area on the display, 0…1, sampled.
        public let fraction: Double
        /// The apps of the windows over it, in the order met.
        public let by: [String]
    }

    /// Coverage of every granted window, sampled on a 16×16 grid over its part on `display` (2026-10-17, host: the
    /// Calculator lay wholly behind the browser dsh runs in, the image was one grey block, and it took the model a
    /// round to see why). Another granted window over it (a sheet, a second window) is content, not cover.
    public static func coverage(zOrder: [ZWindow], display: CGRect) -> [Coverage] {
        let n = 16
        return zOrder.filter(\.granted).compactMap { w in
            let r = w.frame.intersection(display)
            guard !r.isNull, r.width > 0, r.height > 0 else { return nil }
            var covered = 0
            var by: [String] = []
            for i in 0..<n {
                for j in 0..<n {
                    let p = CGPoint(x: r.minX + (CGFloat(i) + 0.5) * r.width / CGFloat(n),
                                    y: r.minY + (CGFloat(j) + 0.5) * r.height / CGFloat(n))
                    guard let top = topmost(at: p, in: zOrder), !top.granted else { continue }
                    covered += 1
                    if let a = top.app, !by.contains(a) { by.append(a) }
                }
            }
            return Coverage(windowID: w.id, app: w.app, fraction: Double(covered) / Double(n * n), by: by)
        }
    }

    /// Topmost window containing `p` (z-order is front-to-back).
    public static func topmost(at p: CGPoint, in zOrder: [ZWindow]) -> ZWindow? {
        zOrder.first { $0.frame.contains(p) }
    }

    /// Occluded unless the topmost window at the element's centre is the window it belongs to. For AX elements
    /// whose window could not be identified, the app is the best available unit.
    /// (A sheet or second window of the same app covers an element just like another app's window does.)
    public static func isOccluded(_ e: ObservedElement, zOrder: [ZWindow]) -> Bool {
        guard let f = e.frame else { return false }
        let top = topmost(at: CGPoint(x: f.midX, y: f.midY), in: zOrder)
        switch e.source {
        case .ax:
            if let wid = e.windowID { return top?.id != wid }
            return top?.app != e.app?.lowercased()
        case .ocr:
            // No known source window, or nothing on screen at its centre: not visible as read.
            guard let wid = e.windowID, let top else { return true }
            return top.id != wid
        }
    }
}

/// Single display only: a granted window whose centre is not on the main display is reported as
/// unsupported instead of being returned with coordinates nobody verified.
public enum DisplayPolicy {
    public static func unsupportedReason(windowFrame: CGRect, mainDisplay: CGRect, displayCount: Int) -> String? {
        let centre = CGPoint(x: windowFrame.midX, y: windowFrame.midY)
        if mainDisplay.contains(centre) { return nil }
        return displayCount > 1 ? "multi_display" : "off_screen"
    }
}

/// What an element looked like when it was observed; re-read before acting on it.
public enum Fingerprint {
    public static func of(role: String?, identifier: String?, text: String, frame: CGRect?) -> String {
        func r(_ v: CGFloat) -> Int { Int((v / 2).rounded()) * 2 }  // 2 pt grid absorbs sub-point jitter
        let f = frame.map { "\(r($0.minX)),\(r($0.minY)),\(r($0.width)),\(r($0.height))" } ?? "-"
        return [role ?? "-", identifier ?? "-", String(text.prefix(64)), f].joined(separator: "|")
    }

    /// Short stable key of an element across observes (the plugin's element ids): the fingerprint plus
    /// its source and window, FNV-1a 64-bit, 12 hex digits. Same element unchanged -> same key; any change to role,
    /// identifier, text or frame (2 pt grid) -> a new key. Never contains the text itself.
    public static func key(source: ObservedElement.Source, windowID: UInt32?, fingerprint: String) -> String {
        var h: UInt64 = 0xcbf2_9ce4_8422_2325
        for b in "\(source.rawValue)|\(windowID.map(String.init) ?? "-")|\(fingerprint)".utf8 {
            h ^= UInt64(b)
            h = h &* 0x0000_0100_0000_01b3
        }
        return String(String(h, radix: 16).leftPadding(to: 16).prefix(12))
    }
}

private extension String {
    func leftPadding(to n: Int) -> String { count >= n ? self : String(repeating: "0", count: n - count) + self }
}

public struct SnapshotElement: Sendable, Equatable {
    public let source: ObservedElement.Source
    public let app: String?
    public let windowID: UInt32?
    /// Opaque key the OS layer uses to re-read an AX element; nil for OCR elements.
    public let handle: Int?
    public let fingerprint: String
    public let frame: CGRect?
}

public struct Snapshot: Sendable {
    public let gen: Int
    public let zOrder: [ZWindow]
    public let elements: [String: SnapshotElement]
    /// Geometry and sent size of the composite image, when one was produced (needed for `space: image`).
    public let desktop: CaptureGeometry?
    public let sentSize: CGSize?
    /// Attached sheets (never captured on their own; their pixels come from the parent's capture).
    public var sheetIDs: Set<UInt32> = []
    /// Luma thumbnails of the windows OCR read in this snapshot, with the window frame then: an OCR element is
    /// re-validated against them before any action (its window may stay put while its content changes).
    public var windowThumbs: [UInt32: WindowThumb] = [:]
}

public struct WindowThumb: Sendable, Equatable {
    public let thumb: LumaThumb
    public let frame: CGRect
    public init(thumb: LumaThumb, frame: CGRect) {
        self.thumb = thumb
        self.frame = frame
    }
}

/// The last few snapshots; element IDs and snapshot-relative coordinates are only valid against these.
public final class SnapshotStore {
    public static let retained = 4
    private var list: [Snapshot] = []

    public init() {}

    public func add(_ s: Snapshot) {
        list.append(s)
        if list.count > Self.retained { list.removeFirst(list.count - Self.retained) }
    }

    public func get(_ gen: Int) -> Snapshot? { list.first { $0.gen == gen } }
}

/// System overlays (the Dock's full-display window at layer 20 is the known case) cover the whole screen in the
/// window list but are click-through except for their visible parts. Treating them as one opaque rectangle would
/// mark everything occluded and refuse every click. So a window above the normal layer that covers the whole
/// main display is replaced by the frames of its app's top-level AX elements (the Dock bar itself).
public enum OverlayPolicy {
    public struct RawWindow: Sendable, Equatable {
        public let id: UInt32
        public let app: String?
        public let pid: Int32
        public let layer: Int
        public let frame: CGRect
        /// kCGWindowOwnerName: identifies the Window Server's own windows (they have no bundle).
        public let ownerName: String?

        public init(id: UInt32, app: String?, pid: Int32, layer: Int, frame: CGRect, ownerName: String? = nil) {
            self.id = id
            self.app = app
            self.pid = pid
            self.ownerName = ownerName
            self.layer = layer
            self.frame = frame
        }
    }

    public static func isOverlay(_ w: RawWindow, display: CGRect) -> Bool {
        guard w.layer > 0, w.app != nil else { return false }
        let covered = w.frame.intersection(display)
        return !covered.isNull && covered.width * covered.height >= 0.99 * display.width * display.height
    }

    /// Front-to-back z-order with overlays expanded into their visible parts (`partsOf` returns the AX frames of
    /// the overlay app's top-level elements; an overlay with no known parts disappears).
    /// The mouse pointer's own window. In a VM without a hardware cursor the pointer is drawn as a real on-screen
    /// window at the pointer position: counted as a window, it "covered" whatever point the previous action left
    /// the mouse on, and refused the next action there (actions experiment, 2026-09-29). It never takes clicks, so
    /// it is not part of the z-order. Both conditions are required: any app can put a window at the cursor level,
    /// and such a window must stay an occluder (geometry suite `occlusion-cursor-level`).
    public static let cursorLayer = Int(CGWindowLevelForKey(.cursorWindow))
    public static let windowServerOwner = "Window Server"

    public static func isPointer(layer: Int, ownerName: String?, app: String?) -> Bool {
        layer == cursorLayer && ownerName == windowServerOwner && app == nil
    }

    /// The area remembered after a click was intercepted (lazy `occluded` flags): the interceptor's smallest window
    /// at the point, but never a full-display overlay window, which would flag the whole screen (a Notification
    /// Center banner lives in one, 2026-10-10). Else, from the AX hit element up (`axAncestors`): a notification
    /// banner or alert if the element is in one (its frame is the banner), otherwise the hit element itself. Small
    /// rather than large: another click elsewhere in the cover is refused and flagged too, while too large an area
    /// tells the model that clickable things are covered (the banner's container is half the screen). Else nil.
    public static func interceptionRegion(windows: [(layer: Int, frame: CGRect)], point: CGPoint, display: CGRect,
                                          axAncestors: [(frame: CGRect, subrole: String?)]) -> CGRect? {
        func fullDisplay(_ r: CGRect) -> Bool {
            let c = r.intersection(display)
            return !c.isNull && c.width * c.height >= 0.99 * display.width * display.height
        }
        let own = windows.filter { $0.frame.contains(point) && !($0.layer > 0 && fullDisplay($0.frame)) }.map(\.frame)
        if let w = own.min(by: { $0.width * $0.height < $1.width * $1.height }) { return w }
        let around = axAncestors.filter { $0.frame.contains(point) && !fullDisplay($0.frame) }
        return (around.first { $0.subrole?.hasPrefix("AXNotificationCenter") == true } ?? around.first)?.frame
    }

    /// An AX frame and a window-list bound for the same thing: both in points, AX's possibly fractional.
    static func sameFrame(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minX - b.minX) < 1 && abs(a.minY - b.minY) < 1 && abs(a.width - b.width) < 1 && abs(a.height - b.height) < 1
    }

    public static func expand(_ raw: [RawWindow], display: CGRect, granted: Set<String>,
                              partsOf: (Int32) -> [CGRect]?) -> [ZWindow] {
        raw.filter { !isPointer(layer: $0.layer, ownerName: $0.ownerName, app: $0.app) }.flatMap { w -> [ZWindow] in
            if isOverlay(w, display: display) {
                // nil: the overlay's parts are unknown right now. Callers deciding whether to allow an action pass
                // nil on failure, so the whole overlay counts as covering: unknown means refuse.
                guard let parts = partsOf(w.pid) else {
                    return [ZWindow(id: w.id, app: w.app, frame: w.frame, granted: false)]
                }
                // The app's top-level AX elements can be its other windows (Notification Center's desktop widgets,
                // at the desktop level, 2026-10-10): those keep their own place in the z-order, not the overlay's.
                let own = raw.filter { $0.pid == w.pid && $0.id != w.id }.map(\.frame)
                return parts.filter { p in p.width > 0 && p.height > 0 && p != w.frame && !own.contains { sameFrame($0, p) } }
                    .map { ZWindow(id: w.id, app: w.app, frame: $0, granted: false) }
            }
            // Any layer: a granted app's own menus, popovers and sheets must be visible to the model too.
            return [ZWindow(id: w.id, app: w.app, frame: w.frame, granted: w.app.map(granted.contains) == true)]
        }
    }
}
