import CoreGraphics
import Foundation

/// Grayscale thumbnail of a window for change detection: one sample per `ptPerSample` points (area-averaged by the
/// OS layer when it downsamples the capture). Row-major, top row first.
public struct LumaThumb: Sendable, Equatable {
    public let width: Int
    public let height: Int
    public let pixels: [UInt8]
    public init(width: Int, height: Int, pixels: [UInt8]) {
        precondition(pixels.count == width * height)
        self.width = width
        self.height = height
        self.pixels = pixels
    }
}

/// A line of OCR text held in the cache, in window-local points (origin: the window's top-left).
public struct OCRLine: Sendable, Equatable {
    public let id: String
    public let text: String
    public let confidence: Double
    public let frame: CGRect
}

/// Per-window OCR cache (decided 2026-09-29). Lines are kept in window-local points, so a window that
/// only moved needs no OCR at all; a resize drops the window's entry. Between observes the window is compared on a
/// grid of `cellPt` cells by mean absolute luma difference (not exact hashes: a blinking caret must not count as a
/// change). Changed cells widen to full-width bands, because text runs in lines and a partial crop would cut them;
/// a band also grows to cover every cached line it touches. Re-recognized lines that match a replaced line (same
/// text, overlapping) keep its id, so element ids stay stable across observes.
public struct OCRCache: Sendable {
    public struct Params: Sendable, Equatable {
        public var cellPt: Double = 32
        /// Thumbnail resolution: samples per cell edge (8 → one sample per 4 pt).
        public var samplesPerCell = 8
        /// Mean absolute difference (0–255) over a cell's samples above which the cell counts as changed. Biased
        /// low: a missed change serves stale text, a false one only re-reads one band (ids are reused). Estimated at
        /// 4 pt/sample: one changed digit ≈ 3.4, a 1 pt caret blink ≈ 4 (re-read, cheap), a changed period ≈ 1
        /// (missed). Tuned with data in R5 (bench/r5/).
        public var madThreshold: Double = 2
        /// Extra margin above and below each band, for text straddling a cell row boundary.
        public var bandPadPt: Double = 8
        public init() {}
        public var ptPerSample: Double { cellPt / Double(samplesPerCell) }
    }

    public enum Plan: Sendable, Equatable {
        /// Nothing changed: serve the cached lines.
        case none
        /// No usable entry (new window, resized, or the last OCR failed): recognize the whole window.
        case full
        /// Recognize these full-width bands (window-local points, sorted, non-overlapping).
        case bands([CGRect])
    }

    private struct Entry: Sendable {
        let size: CGSize
        let thumb: LumaThumb
        let lines: [OCRLine]
    }

    public let params: Params
    private var entries: [UInt32: Entry] = [:]
    private var nextID = 1

    public init(params: Params = Params()) {
        self.params = params
    }

    public func plan(window: UInt32, size: CGSize, thumb: LumaThumb) -> Plan {
        guard let e = entries[window], e.size == size, e.thumb.width == thumb.width, e.thumb.height == thumb.height else {
            return .full
        }
        let rows = changedCellRows(e.thumb, thumb)
        if rows.isEmpty { return .none }
        var bands: [CGRect] = []
        for r in rows.sorted() {
            let y0 = max(0, Double(r) * params.cellPt - params.bandPadPt)
            let y1 = min(Double(size.height), Double(r + 1) * params.cellPt + params.bandPadPt)
            bands.append(CGRect(x: 0, y: y0, width: size.width, height: y1 - y0))
        }
        // Grow bands over the cached lines they touch, then merge overlaps; repeat until stable.
        while true {
            let grown = bands.map { b -> CGRect in
                e.lines.filter { $0.frame.minY < b.maxY && $0.frame.maxY > b.minY }.reduce(b) { $0.union(
                    CGRect(x: 0, y: max(0, $1.frame.minY), width: size.width,
                           height: min(size.height, $1.frame.maxY) - max(0, $1.frame.minY))) }
            }
            let merged = Self.merge(grown)
            if merged == bands { break }
            bands = merged
        }
        return .bands(bands)
    }

    /// Records the result of `plan`. `recognized` are the lines Vision returned for the planned region(s), in
    /// window-local points. The stored thumbnail is updated only where OCR ran (everywhere for `.full`, the bands'
    /// sample rows for `.bands`, nowhere for `.none`), so changes below the threshold still add up elsewhere.
    public mutating func apply(window: UInt32, size: CGSize, thumb: LumaThumb, plan: Plan,
                               recognized: [(text: String, confidence: Double, frame: CGRect)]) {
        let old = entries[window]?.lines ?? []
        var stored = thumb
        var kept: [OCRLine] = []
        var replaced: [OCRLine] = []
        switch plan {
        case .none:
            return
        case .full:
            replaced = old
        case .bands(let bands):
            if let prev = entries[window]?.thumb { stored = Self.blend(prev, thumb, rowsIn: bands, ptPerSample: params.ptPerSample) }
            for l in old {
                if bands.contains(where: { $0.contains(CGPoint(x: $0.midX, y: l.frame.midY)) }) {
                    replaced.append(l)
                } else {
                    kept.append(l)
                }
            }
        }
        var fresh: [OCRLine] = []
        var reusable = replaced
        for r in recognized {
            if let i = reusable.firstIndex(where: { $0.text == r.text && Self.iou($0.frame, r.frame) >= 0.5 }) {
                fresh.append(OCRLine(id: reusable[i].id, text: r.text, confidence: r.confidence, frame: r.frame))
                reusable.remove(at: i)
            } else {
                fresh.append(OCRLine(id: "o\(nextID)", text: r.text, confidence: r.confidence, frame: r.frame))
                nextID += 1
            }
        }
        entries[window] = Entry(size: size, thumb: stored, lines: (kept + fresh).sorted {
            ($0.frame.minY, $0.frame.minX) < ($1.frame.minY, $1.frame.minX)
        })
    }

    /// After a failed OCR the entry is dropped, so the next observe recognizes the whole window again.
    public mutating func invalidate(window: UInt32) {
        entries[window] = nil
    }

    public func lines(window: UInt32) -> [OCRLine] {
        entries[window]?.lines ?? []
    }

    /// Drops windows that are gone (closed, no longer granted or no longer captured).
    public mutating func retain(windows: Set<UInt32>) {
        entries = entries.filter { windows.contains($0.key) }
    }

    public var cachedWindows: Set<UInt32> { Set(entries.keys) }

    /// Whether the pixels under a window-local rect (plus a 4 pt margin) differ between two thumbnails by more than
    /// the change threshold: an OCR element's text may have been replaced while its window stayed put.
    public func regionChanged(_ a: LumaThumb, _ b: LumaThumb, localRect: CGRect) -> Bool {
        guard a.width == b.width, a.height == b.height else { return true }
        let s = params.ptPerSample
        let r = localRect.insetBy(dx: -4, dy: -4)
        let x0 = max(0, Int((Double(r.minX) / s).rounded(.down))), x1 = min(b.width, Int((Double(r.maxX) / s).rounded(.up)))
        let y0 = max(0, Int((Double(r.minY) / s).rounded(.down))), y1 = min(b.height, Int((Double(r.maxY) / s).rounded(.up)))
        guard x0 < x1, y0 < y1 else { return true }
        var sum = 0
        for y in y0..<y1 {
            for x in x0..<x1 { sum += abs(Int(a.pixels[y * b.width + x]) - Int(b.pixels[y * b.width + x])) }
        }
        return Double(sum) / Double((x1 - x0) * (y1 - y0)) > params.madThreshold
    }

    // MARK: - Helpers

    func changedCellRows(_ a: LumaThumb, _ b: LumaThumb) -> Set<Int> {
        let n = params.samplesPerCell
        var rows = Set<Int>()
        var cy = 0
        while cy * n < b.height {
            var cx = 0
            while cx * n < b.width {
                var sum = 0, count = 0
                for y in (cy * n)..<min((cy + 1) * n, b.height) {
                    let row = y * b.width
                    for x in (cx * n)..<min((cx + 1) * n, b.width) {
                        sum += abs(Int(a.pixels[row + x]) - Int(b.pixels[row + x]))
                        count += 1
                    }
                }
                if count > 0 && Double(sum) / Double(count) > params.madThreshold {
                    rows.insert(cy)
                    break
                }
                cx += 1
            }
            cy += 1
        }
        return rows
    }

    /// `old` with the sample rows covered by `bands` taken from `new`.
    static func blend(_ old: LumaThumb, _ new: LumaThumb, rowsIn bands: [CGRect], ptPerSample: Double) -> LumaThumb {
        var px = old.pixels
        for b in bands {
            let y0 = max(0, Int((Double(b.minY) / ptPerSample).rounded(.down)))
            let y1 = min(new.height, Int((Double(b.maxY) / ptPerSample).rounded(.up)))
            guard y0 < y1 else { continue }
            px.replaceSubrange((y0 * new.width)..<(y1 * new.width), with: new.pixels[(y0 * new.width)..<(y1 * new.width)])
        }
        return LumaThumb(width: new.width, height: new.height, pixels: px)
    }

    static func merge(_ bands: [CGRect]) -> [CGRect] {
        var out: [CGRect] = []
        for b in bands.sorted(by: { $0.minY < $1.minY }) {
            if let last = out.last, b.minY <= last.maxY {
                out[out.count - 1] = last.union(b)
            } else {
                out.append(b)
            }
        }
        return out
    }

    static func iou(_ a: CGRect, _ b: CGRect) -> Double {
        let i = a.intersection(b)
        guard !i.isNull, i.width > 0, i.height > 0 else { return 0 }
        let inter = Double(i.width * i.height)
        return inter / (Double(a.width * a.height) + Double(b.width * b.height) - inter)
    }
}

/// Output-side dedup of OCR against AX (decision 2026-09-29): an OCR line that lies inside an AX element carrying
/// the same text is dropped and the AX element kept (it can be acted on precisely). Geometry alone is not enough:
/// large AX containers (a web area, a group with a description) cover everything.
public enum OCRDedup {
    public static let minContainment = 0.8

    public static func isCovered(_ ocr: ObservedElement, by ax: [ObservedElement]) -> Bool {
        guard let f = ocr.frame, f.width > 0, f.height > 0 else { return false }
        let needle = normalize(ocr.text)
        guard !needle.isEmpty else { return false }
        let allowed = max(1, needle.count / 5)
        return ax.contains { a in
            guard let af = a.frame, !a.text.isEmpty else { return false }
            let i = af.intersection(f)
            guard !i.isNull, Double(i.width * i.height) / Double(f.width * f.height) >= minContainment else { return false }
            return approxSubstringDistance(needle, normalize(a.text)) <= allowed
        }
    }

    static func normalize(_ s: String) -> [Character] {
        Array(s.lowercased().filter { !$0.isWhitespace })
    }

    /// Smallest edit distance between `needle` and any substring of `hay` (Sellers).
    static func approxSubstringDistance(_ needle: [Character], _ hay: [Character]) -> Int {
        if needle.isEmpty { return 0 }
        if hay.isEmpty { return needle.count }
        var prev = [Int](repeating: 0, count: hay.count + 1)   // row 0: a match may start anywhere
        var cur = prev
        for (i, c) in needle.enumerated() {
            cur[0] = i + 1
            for j in 1...hay.count {
                cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (c == hay[j - 1] ? 0 : 1))
            }
            swap(&prev, &cur)
        }
        return prev.min()!
    }
}
