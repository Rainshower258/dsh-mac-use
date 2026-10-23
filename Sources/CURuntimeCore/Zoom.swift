import CoreGraphics
import Foundation

/// cu_zoom (PLAN-v2 R2, decision 2026-09-29): a region of the occlusion-blocked composite at up to native
/// resolution, for text or controls too small in the downscaled overview. A zoom is just another capture geometry
/// (its rect in global points at the display's scale), so its mapping and `space: "zoom"` points work like the
/// overview's. Each zoom is tied to the snapshot it was requested against; points in it are checked against that
/// snapshot like any coordinate target.
public struct ZoomRecord: Sendable, Equatable {
    public let id: String
    public let baseGen: Int
    public let geometry: CaptureGeometry
    public let sentSize: CGSize

    public func screenPoint(fromZoomPixel p: CGPoint) -> CGPoint {
        geometry.screenPoint(fromSentPixel: p, sentSize: sentSize)
    }
}

public final class ZoomStore {
    public static let retained = 8
    private var list: [ZoomRecord] = []
    private var next = 1

    public init() {}

    public func add(baseGen: Int, geometry: CaptureGeometry, sentSize: CGSize) -> ZoomRecord {
        let r = ZoomRecord(id: "z\(next)", baseGen: baseGen, geometry: geometry, sentSize: sentSize)
        next += 1
        list.append(r)
        if list.count > Self.retained { list.removeFirst(list.count - Self.retained) }
        return r
    }

    public func get(_ id: String) -> ZoomRecord? { list.first { $0.id == id } }
}

public enum ZoomPolicy {
    /// Margin around an element's frame when zooming on an element.
    public static let elementPaddingPt: CGFloat = 16

    public struct Plan: Sendable, Equatable {
        public let geometry: CaptureGeometry
        public let sentSize: CGSize
        /// Sent pixels per point in the zoom over the same in the overview (> 1).
        public let magnification: Double
    }

    public enum Refusal: Error, Equatable {
        case empty
        case notMagnifying(Double)
    }

    /// `rect` in global points; `display` and `overviewSent` describe the snapshot's overview image. The zoom is
    /// clipped to the display, scaled down to the pixel budget if needed, and refused when it would not show more
    /// detail than the overview already does.
    public static func plan(rect: CGRect, display: CaptureGeometry, overviewSent: CGSize,
                            budget: Int = CaptureGeometry.defaultPixelBudget) -> Result<Plan, Refusal> {
        let clipped = rect.standardized.intersection(display.contentRect)
        guard !clipped.isNull, clipped.width >= 1, clipped.height >= 1 else { return .failure(.empty) }
        let geometry = CaptureGeometry(contentRect: clipped, pointPixelScale: display.pointPixelScale)
        let sent = CaptureGeometry.sentSize(native: geometry.nativeSizePx, budget: budget)
        let zoomK = Double(sent.width / clipped.width)
        let overviewK = Double(overviewSent.width / display.contentRect.width)
        let m = zoomK / overviewK
        guard m > 1.0001 else { return .failure(.notMagnifying(m)) }
        return .success(Plan(geometry: geometry, sentSize: sent, magnification: m))
    }
}

/// What the OS layer is asked to produce for a zoom.
public struct ZoomRequest: Sendable, Equatable {
    public let geometry: CaptureGeometry
    public let sentSize: CGSize
    /// Granted windows (in the snapshot) that intersect the zoom; only these are captured and drawn with content.
    public let windows: Set<UInt32>
    /// Granted apps: every other window in front of the captured ones becomes a flat block.
    public let apps: [String]
    public let ocr: Bool

    public init(geometry: CaptureGeometry, sentSize: CGSize, windows: Set<UInt32>, apps: [String], ocr: Bool) {
        self.geometry = geometry
        self.sentSize = sentSize
        self.windows = windows
        self.apps = apps
        self.ocr = ocr
    }
}

public struct ZoomResult: Sendable {
    public var png: Data?
    /// OCR lines (global points) of the captured windows whose centre lies in the zoom rect.
    public var lines: [ObservedElement] = []
    /// Current window order, for occlusion flags on the lines.
    public var zOrder: [ZWindow] = []
    public var captureError: String?
    public var ocrError: String?
    public var ocrStats: OCRStats?
    public init() {}
}
