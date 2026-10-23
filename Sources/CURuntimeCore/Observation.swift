import CoreGraphics
import Foundation

/// Geometry of one SCK capture (PLAN-v2 §4.1). The only internal coordinate system is global screen points.
/// Captures are per window (`SCContentFilter(desktopIndependentWindow:)`): `contentRect` is that window's global
/// frame and `pointPixelScale` comes from the filter. Do NOT use a display filter with `including:` apps here:
/// on macOS 26 it draws the app's content at the image origin while its `contentRect` still reports the whole
/// display, which silently shifts every OCR box by the window's origin (found 2026-09-28, fixture dom geometry).
public struct CaptureGeometry: Equatable, Sendable {
    public static let defaultPixelBudget = 640_000

    public let contentRect: CGRect
    public let pointPixelScale: Double

    public init(contentRect: CGRect, pointPixelScale: Double) {
        self.contentRect = contentRect
        self.pointPixelScale = pointPixelScale
    }

    public var nativeSizePx: CGSize {
        CGSize(width: (contentRect.width * pointPixelScale).rounded(), height: (contentRect.height * pointPixelScale).rounded())
    }

    /// Native capture pixel -> global point.
    public func screenPoint(fromNativePixel p: CGPoint) -> CGPoint {
        CGPoint(x: contentRect.minX + p.x / pointPixelScale, y: contentRect.minY + p.y / pointPixelScale)
    }

    /// Vision bounding box (normalized, origin bottom-left) on the native image -> global point rect.
    public func screenRect(fromVisionBox b: CGRect) -> CGRect {
        CGRect(x: contentRect.minX + b.minX * contentRect.width,
               y: contentRect.minY + (1 - b.maxY) * contentRect.height,
               width: b.width * contentRect.width, height: b.height * contentRect.height)
    }

    /// Deterministic downscale that fits the model's pixel budget; never upscales.
    public static func sentSize(native: CGSize, budget: Int = defaultPixelBudget) -> CGSize {
        let area = native.width * native.height
        guard area > CGFloat(budget) else { return native }
        let f = (CGFloat(budget) / area).squareRoot()
        // Flooring both sides keeps w*h <= area*f^2 = budget.
        return CGSize(width: (native.width * f).rounded(.down), height: (native.height * f).rounded(.down))
    }

    /// Sent-image pixel -> global point: pt = origin + img * (content_width_pt / sent_width_px).
    public func screenPoint(fromSentPixel p: CGPoint, sentSize: CGSize) -> CGPoint {
        CGPoint(x: contentRect.minX + p.x * contentRect.width / sentSize.width,
                y: contentRect.minY + p.y * contentRect.height / sentSize.height)
    }

    /// The overview image's capture rect: the granted windows' bounding box on the display, in whole points, not the
    /// whole display (2026-10-17, host run on a 1710×1112 pt display: the composite was mostly black, and at the 640k
    /// px budget the 230×408 pt Calculator came out about a hundred pixels wide). Mapping, image-space clicks and
    /// zooms all go through `contentRect`, so they follow. No granted window on the display: the display.
    public static func overview(display: CGRect, windows: [CGRect], pointPixelScale: Double) -> CaptureGeometry {
        let box = windows.reduce(CGRect.null) { $0.union($1) }.integral.intersection(display)
        let rect = box.isNull || box.width < 1 || box.height < 1 ? display : box
        return CaptureGeometry(contentRect: rect, pointPixelScale: pointPixelScale)
    }

    /// Mapping metadata attached to every image sent to the model (§4.1).
    public func mapping(sentSize: CGSize) -> JSONValue {
        let r = contentRect
        return [
            "display_bounds_pt": [.number(r.minX), .number(r.minY), .number(r.width), .number(r.height)],
            "point_pixel_scale": .number(pointPixelScale),
            "native_size_px": [.number(nativeSizePx.width), .number(nativeSizePx.height)],
            "sent_size_px": [.number(sentSize.width), .number(sentSize.height)],
            "map": .string("pt = origin + img * (\(Self.fmt(r.width))/\(Self.fmt(sentSize.width)))"),
        ]
    }

    private static func fmt(_ v: CGFloat) -> String { v == v.rounded() ? String(Int(v)) : String(Double(v)) }
}

/// Every call into another process or OS service has a deadline (AX has its own messaging timeout and budget).
public enum Deadlines {
    public static let capture: TimeInterval = 10
    public static let ocr: TimeInterval = 15
    /// Watchdog per request; must exceed capture + ocr + AX budget.
    public static let request: TimeInterval = 30
    public static let shutdown: TimeInterval = 5
}

/// AX traversal limits (PLAN-v2 §3.1 AXSnapshot).
public struct AXLimits: Sendable, Equatable {
    public var messagingTimeout: TimeInterval = 1.5
    public var timeBudget: TimeInterval = 3.0
    public var nodeCap: Int = 5000

    public init() {}
}

public struct ObserveRequest: Sendable {
    /// Lowercased bundle IDs: granted and running.
    public let apps: [String]
    public let ocr: Bool
    public let includeImage: Bool
    public let limits: AXLimits
    /// Test-harness only (config `debug_native_images`): also return the native-resolution composite.
    public var debugNativeImage = false
    /// Apps the window wait may wait for (WindowAppearWait): visible ones and those just launched. Nil: all.
    public var waitFor: Set<String>?

    public init(apps: [String], ocr: Bool, includeImage: Bool, limits: AXLimits, debugNativeImage: Bool = false) {
        self.apps = apps
        self.ocr = ocr
        self.includeImage = includeImage
        self.limits = limits
        self.debugNativeImage = debugNativeImage
    }
}

public struct ObservedElement: Sendable, Equatable {
    public enum Source: String, Sendable { case ax, ocr }
    public let source: Source
    public let app: String?
    public let role: String?
    public let text: String
    /// Nil when the app reported no position/size; never a made-up (0,0).
    public let frame: CGRect?
    public let confidence: Double?
    public var identifier: String?
    /// OCR: the window the text was read from. AX: nil.
    public var windowID: UInt32?
    /// AX: opaque key the OS layer uses to re-read this element before acting on it.
    public var handle: Int?
    /// OCR: id from the OCR cache, stable across observes while the line is unchanged (OCRCache).
    public var ocrID: String?

    public init(source: Source, app: String?, role: String?, text: String, frame: CGRect?, confidence: Double?,
                identifier: String? = nil, windowID: UInt32? = nil, handle: Int? = nil) {
        self.source = source
        self.app = app
        self.role = role
        self.text = text
        self.frame = frame
        self.confidence = confidence
        self.identifier = identifier
        self.windowID = windowID
        self.handle = handle
    }
}

/// What the OCR cache did in one observe: data for tuning its parameters (R5).
public struct OCRStats: Sendable, Equatable {
    public var windows = 0
    /// Windows recognized whole (new, resized, or after a failure).
    public var full = 0
    /// Windows where only changed bands were recognized, and how many bands in total.
    public var bandWindows = 0
    public var bands = 0
    /// Windows served entirely from the cache.
    public var cachedOnly = 0
    /// Recognized area over captured window area (0…1).
    public var recognizedAreaFraction = 0.0
    public init() {}
}

public struct AXStats: Sendable, Equatable {
    public let app: String
    public let nodes: Int
    public let elapsedMs: Double
    public let hitTimeBudget: Bool
    public let hitNodeCap: Bool
    /// Elements skipped because the app returned values of the wrong type or non-finite geometry.
    public let malformed: Int

    public init(app: String, nodes: Int, elapsedMs: Double, hitTimeBudget: Bool, hitNodeCap: Bool, malformed: Int = 0) {
        self.app = app
        self.nodes = nodes
        self.elapsedMs = elapsedMs
        self.hitTimeBudget = hitTimeBudget
        self.hitNodeCap = hitNodeCap
        self.malformed = malformed
    }
}

/// One AX attribute as read from the target app, before any trust decision. The OS layer only tags what
/// the CF type is; everything the app returns is untrusted input and is judged here, where it is testable.
public enum AXRaw: Equatable, Sendable {
    case missing
    case string(String)
    case point(CGPoint)
    case size(CGSize)
    /// Some other CF type (numbers, arrays, unexpected AXValue kinds, ...).
    case other(String)
}

public enum AXSanitizer {
    public static let maxTextLength = 4000
    /// Larger than any real display arrangement; anything beyond is garbage from the app.
    public static let maxCoordinate: CGFloat = 1_000_000

    public enum Rejection: String, Error, Equatable, Sendable { case wrongType, badGeometry }

    /// `.success(nil)`: nothing to report (no text). `.failure`: malformed; skip it and count it.
    public static func element(app: String, role: AXRaw, title: AXRaw, value: AXRaw, description: AXRaw,
                               position: AXRaw, size: AXRaw, identifier: AXRaw = .missing) -> Result<ObservedElement?, Rejection> {
        var texts: [String] = []
        for raw in [value, title, description] {
            // Non-string values (e.g. a slider's number) are legitimate; they just carry no text.
            guard case .string(let s) = raw else { continue }
            var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.count > maxTextLength { t = String(t.prefix(maxTextLength)) }
            if !t.isEmpty && !texts.contains(t) { texts.append(t) }
        }

        let frame: CGRect?
        switch (position, size) {
        case (.missing, _), (_, .missing):
            frame = nil
        case let (.point(p), .size(s)):
            let parts = [p.x, p.y, s.width, s.height]
            guard parts.allSatisfy({ $0.isFinite && abs($0) <= maxCoordinate }), s.width >= 0, s.height >= 0 else {
                return .failure(.badGeometry)
            }
            frame = CGRect(origin: p, size: s)
        default:
            return .failure(.wrongType)
        }

        guard !texts.isEmpty else { return .success(nil) }
        var roleName: String?
        if case .string(let r) = role { roleName = String(r.prefix(64)) }
        var ident: String?
        if case .string(let i) = identifier, !i.isEmpty { ident = String(i.prefix(128)) }
        return .success(ObservedElement(source: .ax, app: app, role: roleName, text: texts.joined(separator: "\n"),
                                        frame: frame, confidence: nil, identifier: ident))
    }
}

public struct ObservedWindow: Sendable, Equatable {
    public let app: String
    public let frame: CGRect
    public var id: UInt32 = 0
    /// Set when the window cannot be served (e.g. "multi_display"); it is then excluded from capture and OCR.
    public var unsupported: String?
    /// The window's frame was still changing when it was captured (e.g. a move or fullscreen animation).
    public var animating = false

    public init(app: String, frame: CGRect, id: UInt32 = 0, unsupported: String? = nil, animating: Bool = false) {
        self.app = app
        self.frame = frame
        self.id = id
        self.unsupported = unsupported
        self.animating = animating
    }
}

/// One window's capture. The native image never leaves the daemon; `sentPNG` is the downscaled copy for the
/// model, present only when requested.
public struct WindowCapture: Sendable {
    public let app: String
    public let geometry: CaptureGeometry
    public var sentPNG: Data?
    public var sentSize: CGSize?

    public init(app: String, geometry: CaptureGeometry, sentPNG: Data? = nil, sentSize: CGSize? = nil) {
        self.app = app
        self.geometry = geometry
        self.sentPNG = sentPNG
        self.sentSize = sentSize
    }
}

public struct ObserveResult: Sendable {
    public var windows: [ObservedWindow] = []
    public var elements: [ObservedElement] = []
    public var axStats: [AXStats] = []
    public var captures: [WindowCapture] = []
    /// Every on-screen window, front-to-back (for occlusion and the composite).
    public var zOrder: [ZWindow] = []
    /// Main display geometry; the composite image is in this space.
    public var desktop: CaptureGeometry?
    /// Downscaled composite for the model (only granted windows show content; see Composite).
    public var compositePNG: Data?
    public var compositeSize: CGSize?
    /// Native-resolution composite, only with ObserveRequest.debugNativeImage.
    public var debugNativePNG: Data?
    public var captureError: String?
    public var ocrError: String?
    public var ocrElapsedMs: Double?
    public var captureElapsedMs: Double?
    /// Set when a granted app had no window yet and observe waited for one (WindowAppearWait).
    public var windowWait: WindowAppearWait.Outcome?
    public var ocrStats: OCRStats?
    /// Windows that are sheets attached to a parent window (see Snapshot.sheetIDs).
    public var sheetIDs: Set<UInt32> = []
    /// Thumbnails of the windows OCR read (see Snapshot.windowThumbs).
    public var windowThumbs: [UInt32: WindowThumb] = [:]
    /// Time per stage of the observe, in ms (the OS layer names the stages): latency data for R5.
    public var phasesMs: [String: Double] = [:]

    public init() {}
}

extension CGRect {
    var json: JSONValue { [.number(minX), .number(minY), .number(width), .number(height)] }
}

extension Optional where Wrapped == CGRect {
    var json: JSONValue { map(\.json) ?? .null }
}
