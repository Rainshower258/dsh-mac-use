import AppKit
import ApplicationServices
import CURuntimeCore
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import Vision

extension MacEnvironment {
    private func runningApps(_ bundleID: String) -> [NSRunningApplication] {
        DispatchQueue.main.sync {
            NSWorkspace.shared.runningApplications
                .filter { $0.bundleIdentifier?.caseInsensitiveCompare(bundleID) == .orderedSame && !$0.isTerminated }
        }
    }

    private func pids(_ bundleID: String) -> [pid_t] { runningApps(bundleID).map(\.processIdentifier) }

    func setManualAccessibility(bundleID: String, enabled: Bool) -> Bool {
        let targets = pids(bundleID)
        guard !targets.isEmpty else { return false }
        var ok = true
        for pid in targets {
            let el = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(el, Float(AXLimits().messagingTimeout))
            let err = AXUIElementSetAttributeValue(el, "AXManualAccessibility" as CFString,
                                                   (enabled ? kCFBooleanTrue : kCFBooleanFalse) as CFTypeRef)
            ok = ok && err == .success
        }
        return ok
    }

    // MARK: - Observe

    func observe(_ request: ObserveRequest) -> ObserveResult {
        var result = ObserveResult()
        var mark = Date()
        func phase(_ name: String) {
            result.phasesMs[name] = (Date().timeIntervalSince(mark) * 1000).rounded()
            result.phasesMs["overlay_ax"] = Self.overlayAXTime().rounded()   // cumulative, part of the phases above
            mark = Date()
        }
        _ = Self.overlayAXTime(reset: true)
        let apps = Set(request.apps)
        let main = CGDisplayBounds(CGMainDisplayID())
        let displayCount = DispatchQueue.main.sync { NSScreen.screens.count }

        let candidates = Set(request.apps.filter { request.waitFor?.contains($0) ?? true }.flatMap { app in
            runningApps(app).filter { r in !DispatchQueue.main.sync(execute: { r.isHidden }) }
                .map { WindowAppearWait.App(bundleID: app, pid: $0.processIdentifier) }
        })
        let wait = windowWait.wait(candidates: candidates,
                                   listed: { Set(expandedZOrder(granted: apps).filter(\.granted).compactMap(\.app)) },
                                   sleep: { usleep(UInt32($0 * 1_000_000)) })
        if wait.waitedFor > 0 { result.windowWait = wait }
        phase("window_wait")

        result.zOrder = expandedZOrder(granted: apps)
        result.windows = result.zOrder.filter(\.granted).map { w in
            ObservedWindow(app: w.app ?? "", frame: w.frame, id: w.id,
                           unsupported: DisplayPolicy.unsupportedReason(windowFrame: w.frame, mainDisplay: main,
                                                                        displayCount: displayCount))
        }
        let servable = Set(result.windows.filter { $0.unsupported == nil }.map(\.id))

        var batch: [Int] = []
        var sheets: [AttachedSheet] = []
        for app in request.apps {
            for running in runningApps(app) where !DispatchQueue.main.sync(execute: { running.isHidden }) {
                let appWindows = result.zOrder.filter { $0.app == app && $0.granted }
                let (elements, stats) = axSnapshot(pid: running.processIdentifier, app: app, limits: request.limits,
                                                   handles: &batch, cgWindows: appWindows, sheets: &sheets)
                result.elements += elements
                result.axStats.append(stats)
            }
        }
        retire(batch)
        result.sheetIDs = Set(sheets.map(\.id))
        phase("zorder_ax")
        guard request.ocr || request.includeImage, !servable.isEmpty else { return result }

        // Windows still moving (drag, fullscreen/Space transition) are captured after they settle, or flagged.
        let settled = waitForStillWindows(servable)
        for i in result.windows.indices where !settled.contains(result.windows[i].id) && servable.contains(result.windows[i].id) {
            result.windows[i].animating = true
        }
        if !settled.isEmpty { result.zOrder = expandedZOrder(granted: apps) }
        phase("settle")

        let t0 = Date()
        // Attached sheets are never captured on their own: SCK renders a scaled copy of the whole parent into a
        // sheet's single-window capture (canary --sheet, 2026-09-29). The parent's capture includes the sheet,
        // correctly placed, so the sheet's pixels come from there.
        let sheetIDs = Set(sheets.map(\.id))
        switch captureWindows(ids: servable.subtracting(sheetIDs)) {
        case .failure(let e):
            result.captureError = String(describing: e)
        case .success(let shots):
            result.captureElapsedMs = Date().timeIntervalSince(t0) * 1000
            phase("capture")
            if request.ocr {
                let t1 = Date()
                result.ocrStats = cachedOCR(shots, sheets: sheets, into: &result, pruneOthers: true)
                result.ocrElapsedMs = Date().timeIntervalSince(t1) * 1000
                phase("ocr")
            }
            let scale = shots.first.map(\.geometry.pointPixelScale)
                ?? Double(DispatchQueue.main.sync { NSScreen.main?.backingScaleFactor ?? 2 })
            let desktop = CaptureGeometry.overview(display: main, windows: result.zOrder.filter(\.granted).map(\.frame),
                                                   pointPixelScale: scale)
            result.desktop = desktop
            result.captures = shots.map { WindowCapture(app: $0.app, geometry: $0.geometry) }
            if request.includeImage, let composite = Self.composite(desktop: desktop, zOrder: result.zOrder, shots: shots) {
                let size = CaptureGeometry.sentSize(native: desktop.nativeSizePx)
                result.compositeSize = size
                result.compositePNG = Self.png(composite, size: size)
                if request.debugNativeImage { result.debugNativePNG = Self.png(composite, size: desktop.nativeSizePx) }
                phase("image")
            }
        }
        return result
    }

    /// Polls the windows' frames until two samples 100 ms apart agree (max 1 s). Returns the ids that settled.
    private func waitForStillWindows(_ ids: Set<UInt32>) -> Set<UInt32> {
        var last = currentWindowFrames().filter { ids.contains($0.key) }
        var still = Set<UInt32>()
        for _ in 0..<10 {
            usleep(100_000)
            let now = currentWindowFrames().filter { ids.contains($0.key) }
            still = Set(now.filter { last[$0.key] == $0.value }.map(\.key))
            if still == ids { return still }
            last = now
        }
        return still
    }

    // MARK: - AX

    private static let attributes = [kAXRoleAttribute, kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute,
                                     kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute,
                                     kAXIdentifierAttribute] as CFArray

    /// Breadth-first from the app's windows (so the menu bar is never visited), skipping minimized windows,
    /// deduplicated because AX is a graph. Everything the app returns is untrusted: values are only type-tagged
    /// here and judged by AXSanitizer; malformed elements are skipped and counted, never trapped on.
    struct AttachedSheet {
        let id: UInt32
        let parent: UInt32?
        let frame: CGRect
    }

    private static func match(_ f: CGRect, _ cgWindows: [ZWindow]) -> UInt32? {
        cgWindows.first { abs($0.frame.minX - f.minX) < 1.5 && abs($0.frame.minY - f.minY) < 1.5
            && abs($0.frame.width - f.width) < 1.5 && abs($0.frame.height - f.height) < 1.5 }?.id
    }

    private func axSnapshot(pid: pid_t, app: String, limits: AXLimits, handles batch: inout [Int],
                            cgWindows: [ZWindow], sheets: inout [AttachedSheet]) -> ([ObservedElement], AXStats) {
        let start = Date()
        let root = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(root, Float(limits.messagingTimeout))
        var windowsRef: CFTypeRef?
        AXUIElementCopyAttributeValue(root, kAXWindowsAttribute as CFString, &windowsRef)
        let axWindows = Self.elements(in: windowsRef).filter { !Self.isMinimized($0) }
        // Which on-screen (CG) window each AX window is: matched by frame, so elements can be tied to a window.
        var queue = axWindows
        // The CG window each queued element belongs to (a sheet's subtree belongs to the sheet's own window).
        var owner: [UInt32?] = axWindows.map { w in Self.frame(of: w).flatMap { Self.match($0, cgWindows) } }
        var seen = Set<AXUIElement>()
        var out: [ObservedElement] = []
        var nodes = 0, malformed = 0, hitBudget = false, hitCap = false, i = 0

        while i < queue.count {
            if Date().timeIntervalSince(start) > limits.timeBudget { hitBudget = true; break }
            if nodes >= limits.nodeCap { hitCap = true; break }
            let el = queue[i]
            i += 1
            guard seen.insert(el).inserted else { continue }
            nodes += 1
            guard let r = Self.read(el) else { continue }
            var mine = owner[i - 1]
            if case .string("AXSheet") = r.values[0], case .point(let o) = r.values[4], case .size(let sz) = r.values[5] {
                let f = CGRect(origin: o, size: sz)
                if let sheet = Self.match(f, cgWindows) {
                    sheets.append(AttachedSheet(id: sheet, parent: mine, frame: f))
                    mine = sheet
                }
            }
            let children = Self.elements(in: r.children)
            queue += children
            owner += Array(repeating: mine, count: children.count)
            switch Self.sanitize(r, app: app) {
            case .success(var e?):
                e.handle = register(el, into: &batch)
                e.windowID = mine
                out.append(e)
            case .success(nil): break
            case .failure: malformed += 1
            }
        }
        let stats = AXStats(app: app, nodes: nodes, elapsedMs: Date().timeIntervalSince(start) * 1000,
                            hitTimeBudget: hitBudget, hitNodeCap: hitCap, malformed: malformed)
        return (out, stats)
    }

    func refreshElement(handle: Int) -> (fingerprint: String, frame: CGRect?)? {
        guard let el = handles[handle] else { return nil }
        AXUIElementSetMessagingTimeout(el, Float(AXLimits().messagingTimeout))
        guard let r = Self.read(el), case .success(let e?) = Self.sanitize(r, app: "") else { return nil }
        return (Fingerprint.of(role: e.role, identifier: e.identifier, text: e.text, frame: e.frame), e.frame)
    }

    func windowPresence(bundleID: String) -> WindowPresence {
        let running = runningApps(bundleID)
        guard !running.isEmpty else { return .notRunning }
        let shown = running.filter { r in !DispatchQueue.main.sync(execute: { r.isHidden }) }
        guard !shown.isEmpty else { return .hidden }
        var minimized = false
        for app in shown {
            let root = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(root, Float(AXLimits().messagingTimeout))
            var windowsRef: CFTypeRef?
            // AX could not tell: answer visible, so observe behaves as it did before this check.
            guard AXUIElementCopyAttributeValue(root, kAXWindowsAttribute as CFString, &windowsRef) == .success else {
                return .visible
            }
            let windows = Self.elements(in: windowsRef)
            if windows.contains(where: { !Self.isMinimized($0) }) { return .visible }
            minimized = minimized || !windows.isEmpty
        }
        return minimized ? .minimized : .noWindows
    }

    func countAXNodes(bundleID: String) -> Int {
        let limits = AXLimits()
        var total = 0
        for pid in pids(bundleID) {
            let start = Date()
            let root = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(root, Float(limits.messagingTimeout))
            var windowsRef: CFTypeRef?
            AXUIElementCopyAttributeValue(root, kAXWindowsAttribute as CFString, &windowsRef)
            var queue = Self.elements(in: windowsRef)
            var seen = Set<AXUIElement>(), i = 0
            while i < queue.count, total < limits.nodeCap, Date().timeIntervalSince(start) <= limits.timeBudget {
                let el = queue[i]
                i += 1
                guard seen.insert(el).inserted else { continue }
                total += 1
                var children: CFTypeRef?
                AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children)
                queue += Self.elements(in: children)
            }
        }
        return total
    }

    private struct RawNode {
        let values: [AXRaw]
        let children: CFTypeRef?
    }

    private static func read(_ el: AXUIElement) -> RawNode? {
        var valuesRef: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(el, attributes, AXCopyMultipleAttributeOptions(rawValue: 0), &valuesRef) == .success,
              let values = valuesRef as? [AnyObject], values.count == 8 else { return nil }
        return RawNode(values: values.map(raw), children: values[6])
    }

    private static func sanitize(_ r: RawNode, app: String) -> Result<ObservedElement?, AXSanitizer.Rejection> {
        let v = r.values
        return AXSanitizer.element(app: app, role: v[0], title: v[1], value: v[2], description: v[3],
                                   position: v[4], size: v[5], identifier: v[7])
    }

    static func frame(of el: AXUIElement) -> CGRect? {
        var p: CFTypeRef?, s: CFTypeRef?
        var origin = CGPoint.zero, size = CGSize.zero
        guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &p) == .success,
              AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &s) == .success,
              let p, let s, CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID(),
              AXValueGetValue(unsafeBitCast(p, to: AXValue.self), .cgPoint, &origin),
              AXValueGetValue(unsafeBitCast(s, to: AXValue.self), .cgSize, &size),
              origin.x.isFinite, origin.y.isFinite, size.width.isFinite, size.height.isFinite else { return nil }
        return CGRect(origin: origin, size: size)
    }

    func topWindowID(at point: CGPoint) -> UInt32? {
        Composite.topmost(at: point, in: expandedZOrder(granted: [], forDecision: true))?.id
    }

    func focusWindow(at point: CGPoint, bundleID: String) -> Bool {
        for pid in pids(bundleID) {
            let app = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(app, Float(AXLimits().messagingTimeout))
            var ref: CFTypeRef?
            AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &ref)
            // AXWindows is front-to-back: the first one containing the point is the one being clicked.
            guard let target = Self.elements(in: ref).first(where: { Self.frame(of: $0)?.contains(point) == true }) else { continue }
            AXUIElementPerformAction(target, kAXRaiseAction as CFString)
            AXUIElementSetAttributeValue(target, kAXMainAttribute as CFString, kCFBooleanTrue)
            let deadline = Date().addingTimeInterval(0.4)
            repeat {
                var focused: CFTypeRef?
                if AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &focused) == .success,
                   let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() {
                    let f = unsafeBitCast(focused, to: AXUIElement.self)
                    if CFEqual(f, target) { return true }
                    // With a sheet attached, the sheet is the focused window: fine when the click is on it.
                    var role: CFTypeRef?
                    if AXUIElementCopyAttributeValue(f, kAXRoleAttribute as CFString, &role) == .success,
                       (role as? String) == "AXSheet", Self.frame(of: f)?.contains(point) == true {
                        return true
                    }
                }
                usleep(25_000)
            } while Date() < deadline
            return false
        }
        return false
    }

    private static func isMinimized(_ window: AXUIElement) -> Bool {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXMinimizedAttribute as CFString, &ref) == .success, let ref,
              CFGetTypeID(ref) == CFBooleanGetTypeID() else { return false }
        return CFBooleanGetValue(unsafeBitCast(ref, to: CFBoolean.self))
    }

    /// Only genuine AXUIElements from a CF array; anything else the app put there is dropped.
    private static func elements(in ref: CFTypeRef?) -> [AXUIElement] {
        guard let ref, CFGetTypeID(ref) == CFArrayGetTypeID(), let items = ref as? [AnyObject] else { return [] }
        return items.compactMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? unsafeBitCast($0, to: AXUIElement.self) : nil }
    }

    /// Type-tags one attribute value. The bit-cast is guarded by the CF type ID check.
    private static func raw(_ o: AnyObject) -> AXRaw {
        let type = CFGetTypeID(o)
        if type == CFStringGetTypeID() { return (o as? String).map(AXRaw.string) ?? .other("CFString") }
        guard type == AXValueGetTypeID() else { return .other(String(describing: CFCopyTypeIDDescription(type))) }
        let v = unsafeBitCast(o, to: AXValue.self)
        switch AXValueGetType(v) {
        case .axError:
            return .missing
        case .cgPoint:
            var p = CGPoint.zero
            return AXValueGetValue(v, .cgPoint, &p) ? .point(p) : .other("AXValue.cgPoint")
        case .cgSize:
            var sz = CGSize.zero
            return AXValueGetValue(v, .cgSize, &sz) ? .size(sz) : .other("AXValue.cgSize")
        default:
            return .other("AXValue")
        }
    }

    // MARK: - Capture: one SCK capture per window (see CaptureGeometry for why not a display filter)

    private final class Box<T>: @unchecked Sendable { var value: T?; init() {} }

    private struct DeadlineExceeded: Error, CustomStringConvertible {
        let what: String
        let seconds: TimeInterval
        var description: String { "\(what) exceeded its \(Int(seconds))s deadline" }
    }

    struct Shot {
        let id: UInt32
        let app: String
        let image: CGImage
        let geometry: CaptureGeometry
    }

    private func captureWindows(ids: Set<UInt32>) -> Result<[Shot], Error> {
        let box = Box<Result<[Shot], Error>>()
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
                var shots: [Shot] = []
                for w in content.windows where ids.contains(w.windowID) {
                    let filter = SCContentFilter(desktopIndependentWindow: w)
                    let geometry = CaptureGeometry(contentRect: w.frame, pointPixelScale: Double(filter.pointPixelScale))
                    let conf = SCStreamConfiguration()
                    conf.width = Int(geometry.nativeSizePx.width)
                    conf.height = Int(geometry.nativeSizePx.height)
                    conf.showsCursor = false
                    conf.ignoreShadowsSingleWindow = true
                    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: conf)
                    shots.append(Shot(id: w.windowID, app: w.owningApplication?.bundleIdentifier.lowercased() ?? "",
                                      image: image, geometry: geometry))
                }
                box.value = .success(shots)
            } catch {
                box.value = .failure(error)
            }
            done.signal()
        }
        guard done.wait(timeout: .now() + Deadlines.capture) == .success, let value = box.value else {
            return .failure(DeadlineExceeded(what: "SCK capture", seconds: Deadlines.capture))
        }
        return value
    }

    /// The overview at native scale over `desktop.contentRect` (the granted windows' area, CaptureGeometry.overview):
    /// granted windows drawn back-to-front with their own pixels, any other window in front of them as a flat grey
    /// block (no content), everything else black.
    static func composite(desktop: CaptureGeometry, zOrder: [ZWindow], shots: [Shot]) -> CGImage? {
        let size = desktop.nativeSizePx
        let s = CGFloat(desktop.pointPixelScale)
        guard let ctx = CGContext(data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8,
                                  bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
        ctx.fill(CGRect(origin: .zero, size: size))
        let byID = Dictionary(shots.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        // Global points (top-left origin) -> bitmap pixels (bottom-left origin).
        func px(_ r: CGRect) -> CGRect {
            CGRect(x: (r.minX - desktop.contentRect.minX) * s, y: size.height - (r.maxY - desktop.contentRect.minY) * s,
                   width: r.width * s, height: r.height * s)
        }
        for op in Composite.plan(display: desktop.contentRect, zOrder: zOrder, captured: Set(byID.keys)) {
            switch op {
            case .window(let id, let frame):
                if let shot = byID[id] { ctx.draw(shot.image, in: px(frame)) }
            case .block(let frame):
                ctx.setFillColor(CGColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1))
                ctx.fill(px(frame))
            }
        }
        return ctx.makeImage()
    }

    func windowThumb(windowID: UInt32) -> LumaThumb? {
        guard case .success(let shots) = captureWindows(ids: [windowID]), let shot = shots.first else { return nil }
        return Self.lumaThumb(shot.image, size: shot.geometry.contentRect.size, ptPerSample: ocrCache.params.ptPerSample)
    }

    // MARK: - Zoom

    func zoom(_ request: ZoomRequest) -> ZoomResult {
        var result = ZoomResult()
        result.zOrder = expandedZOrder(granted: Set(request.apps))
        let ids = request.windows.intersection(result.zOrder.filter(\.granted).map(\.id))
        guard !ids.isEmpty else {
            result.captureError = "the zoomed windows are no longer on screen"
            return result
        }
        switch captureWindows(ids: ids) {
        case .failure(let e):
            result.captureError = String(describing: e)
        case .success(let shots):
            // Same composite as the overview (occlusion blocks, nothing of other apps), over the zoom rect only.
            if let image = Self.composite(desktop: request.geometry, zOrder: result.zOrder, shots: shots) {
                result.png = Self.png(image, size: request.sentSize)
            }
            if request.ocr {
                var scratch = ObserveResult()
                result.ocrStats = cachedOCR(shots, sheets: [], into: &scratch, pruneOthers: false)
                result.ocrError = scratch.ocrError
                let rect = request.geometry.contentRect
                result.lines = scratch.elements.filter { e in e.frame.map { rect.contains(CGPoint(x: $0.midX, y: $0.midY)) } ?? false }
            }
        }
        return result
    }

    // MARK: - OCR (native resolution; boxes converted to global points)

    /// Recognizes only what changed since the last observe (OCRCache) and appends every cached line of each
    /// captured window, in global points, to `result.elements`. A window whose recognition fails is dropped from
    /// the cache (recognized whole next time) and contributes no lines this time; the error is reported.
    /// `pruneOthers`: drop cache entries of windows not captured now (observe captures every granted window;
    /// a zoom only some, so it must not).
    private func cachedOCR(_ shots: [Shot], sheets: [AttachedSheet], into result: inout ObserveResult,
                           pruneOthers: Bool) -> OCRStats {
        var stats = OCRStats()
        var windowArea = 0.0, recognizedArea = 0.0
        for shot in shots {
            let size = shot.geometry.contentRect.size
            let origin = shot.geometry.contentRect.origin
            stats.windows += 1
            windowArea += Double(size.width * size.height)
            guard let thumb = Self.lumaThumb(shot.image, size: size, ptPerSample: ocrCache.params.ptPerSample) else {
                ocrCache.invalidate(window: shot.id)
                result.ocrError = "window \(shot.id): thumbnail failed"
                continue
            }
            result.windowThumbs[shot.id] = WindowThumb(thumb: thumb, frame: shot.geometry.contentRect)
            let plan = ocrCache.plan(window: shot.id, size: size, thumb: thumb)
            let regions: [CGRect]
            switch plan {
            case .none: regions = []; stats.cachedOnly += 1
            case .full: regions = [CGRect(origin: .zero, size: size)]; stats.full += 1
            case .bands(let b): regions = b; stats.bandWindows += 1; stats.bands += b.count
            }
            var recognized: [(text: String, confidence: Double, frame: CGRect)] = []
            var failure: Error?
            for region in regions where failure == nil {
                recognizedArea += Double(region.width * region.height)
                switch recognizeRegion(shot, local: region) {
                case .success(let lines):
                    recognized += lines.compactMap { e in
                        e.frame.map { (e.text, e.confidence ?? 0, $0.offsetBy(dx: -origin.x, dy: -origin.y)) }
                    }
                case .failure(let e): failure = e
                }
            }
            if let failure {
                ocrCache.invalidate(window: shot.id)
                result.ocrError = String(describing: failure)
                continue
            }
            ocrCache.apply(window: shot.id, size: size, thumb: thumb, plan: plan, recognized: recognized)
            for line in ocrCache.lines(window: shot.id) {
                let frame = line.frame.offsetBy(dx: origin.x, dy: origin.y)
                var e = ObservedElement(source: .ocr, app: nil, role: nil, text: line.text, frame: frame,
                                        confidence: line.confidence, windowID: shot.id)
                e.ocrID = line.id
                // Text read from the parent's capture but lying on its attached sheet belongs to the sheet.
                if let sheet = sheets.first(where: { $0.parent == shot.id && $0.frame.contains(CGPoint(x: frame.midX, y: frame.midY)) }) {
                    e.windowID = sheet.id
                }
                result.elements.append(e)
            }
        }
        if pruneOthers { ocrCache.retain(windows: Set(shots.map(\.id))) }
        stats.recognizedAreaFraction = windowArea > 0 ? recognizedArea / windowArea : 0
        return stats
    }

    /// OCR of one window-local region of a shot (the whole window or a band); boxes in global points.
    private func recognizeRegion(_ shot: Shot, local region: CGRect) -> Result<[ObservedElement], Error> {
        let s = CGFloat(shot.geometry.pointPixelScale)
        let px = CGRect(x: 0, y: (region.minY * s).rounded(.down), width: CGFloat(shot.image.width),
                        height: (region.height * s).rounded(.up))
            .intersection(CGRect(x: 0, y: 0, width: shot.image.width, height: shot.image.height))
        guard !px.isEmpty, let crop = shot.image.cropping(to: px) else { return .success([]) }
        let origin = shot.geometry.contentRect.origin
        let geometry = CaptureGeometry(contentRect: CGRect(x: origin.x, y: origin.y + px.minY / s,
                                                           width: px.width / s, height: px.height / s),
                                       pointPixelScale: shot.geometry.pointPixelScale)
        return recognizeText(crop, geometry: geometry, windowID: shot.id)
    }

    /// Grayscale thumbnail, one sample per `ptPerSample` points, top row first (OCRCache change detection).
    static func lumaThumb(_ image: CGImage, size: CGSize, ptPerSample: Double) -> LumaThumb? {
        let w = max(1, Int((Double(size.width) / ptPerSample).rounded(.up)))
        let h = max(1, Int((Double(size.height) / ptPerSample).rounded(.up)))
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
        else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let data = ctx.data else { return nil }
        let bytes = data.assumingMemoryBound(to: UInt8.self)
        var px = [UInt8](repeating: 0, count: w * h)
        for y in 0..<h { for x in 0..<w { px[y * w + x] = bytes[y * ctx.bytesPerRow + x] } }
        return LumaThumb(width: w, height: h, pixels: px)
    }

    private static func textRequest() -> VNRecognizeTextRequest {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = true
        return request
    }

    /// The first observe after start took 5-6 s in the VM against ~0.15 s later (2026-09-29): ~1 s per window-list
    /// pass (the first AX calls to the Dock, for OverlayPolicy), a slow first SCK query, and Vision loading its
    /// models. Doing each once at start moves that out of the first cu_observe. Times in ms (nil: that part failed).
    func prewarm() -> [String: Double?] {
        func timed(_ body: () -> Bool) -> Double? {
            let t0 = Date()
            return body() ? (Date().timeIntervalSince(t0) * 1000).rounded() : nil
        }
        return [
            "window_list_ms": timed { _ = expandedZOrder(granted: []); return true },
            "sck_ms": timed {
                let done = DispatchSemaphore(value: 0)
                Task.detached { _ = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true); done.signal() }
                return done.wait(timeout: .now() + Deadlines.capture) == .success
            },
            "vision_ms": timed { Self.prewarmVision() },
        ]
    }

    /// Recognizes a line of text once with the real request settings (textRequest). What it buys is unclear: the
    /// first real whole-window OCR stayed at ~2.5-3.4 s even after a window-sized mixed zh/en prewarm run twice on
    /// OCR's own queue (2026-09-29, 15 min timebox). Unverified lead: the cost may be the first read of an SCK
    /// (IOSurface-backed) image rather than Vision's models. Kept cheap; bench and plugin do a warm-up observe instead.
    private static func prewarmVision() -> Bool {
        let size = CGSize(width: 480, height: 64)
        guard let ctx = CGContext(data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8,
                                  bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(origin: .zero, size: size))
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
        ("Warm up 2026 预热" as NSString).draw(at: CGPoint(x: 12, y: 14), withAttributes: [.font: NSFont.systemFont(ofSize: 30)])
        NSGraphicsContext.restoreGraphicsState()
        guard let image = ctx.makeImage() else { return false }
        do { try VNImageRequestHandler(cgImage: image).perform([textRequest()]) } catch { return false }
        return true
    }

    /// Offline bench (`cu-runtime ocr-files`): the exact OCR of cachedOCR on an image file. Without `bandPt` the
    /// whole image, as for a new window. With it, full-width bands of `bandPt` points padded by the cache's band
    /// margin, keeping only lines centred in each band's core: a pessimistic stand-in for band re-reads (real bands
    /// also grow over cached lines), to measure what cutting costs. One JSON line, boxes in image pixels.
    static func ocrFile(path: String, bandPt: Double?, scale: Double) -> String {
        func json(_ o: [String: Any]) -> String {
            String(data: (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) ?? Data(), encoding: .utf8) ?? "{}"
        }
        guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return json(["image": path, "error": "unreadable"]) }
        let w = CGFloat(image.width), h = CGFloat(image.height)
        var cores: [(crop: CGRect, core: ClosedRange<CGFloat>)] = []
        if let bandPt {
            let band = CGFloat(bandPt * scale), pad = CGFloat(OCRCache.Params().bandPadPt * scale)
            var y: CGFloat = 0
            while y < h {
                let crop = CGRect(x: 0, y: max(0, y - pad), width: w, height: min(h, y + band + pad) - max(0, y - pad))
                cores.append((crop, y...min(h, y + band)))
                y += band
            }
        } else {
            cores = [(CGRect(x: 0, y: 0, width: w, height: h), 0...h)]
        }
        let t0 = Date()
        var blocks: [[String: Any]] = []
        for (crop, core) in cores {
            guard let part = image.cropping(to: crop) else { continue }
            let request = textRequest()
            do { try VNImageRequestHandler(cgImage: part).perform([request]) } catch {
                return json(["image": path, "error": String(describing: error)])
            }
            for obs in request.results ?? [] {
                guard let top = obs.topCandidates(1).first else { continue }
                let b = obs.boundingBox
                let r = CGRect(x: crop.minX + b.minX * crop.width, y: crop.minY + (1 - b.maxY) * crop.height,
                               width: b.width * crop.width, height: b.height * crop.height)
                guard core.contains(r.midY) else { continue }
                blocks.append(["text": top.string, "confidence": Double(top.confidence),
                               "bbox": [r.minX, r.minY, r.width, r.height].map { (Double($0) * 10).rounded() / 10 }])
            }
        }
        return json(["image": path, "blocks": blocks, "latency_ms": (Date().timeIntervalSince(t0) * 1000).rounded()])
    }

    private func recognizeText(_ image: CGImage, geometry: CaptureGeometry, windowID: UInt32) -> Result<[ObservedElement], Error> {
        let request = Self.textRequest()
        let box = Box<Error?>()
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async {
            do { try VNImageRequestHandler(cgImage: image).perform([request]) } catch { box.value = error }
            done.signal()
        }
        guard done.wait(timeout: .now() + Deadlines.ocr) == .success else {
            request.cancel()
            return .failure(DeadlineExceeded(what: "Vision OCR", seconds: Deadlines.ocr))
        }
        if let err = box.value ?? nil { return .failure(err) }
        return .success((request.results ?? []).compactMap { obs in
            guard let top = obs.topCandidates(1).first else { return nil }
            return ObservedElement(source: .ocr, app: nil, role: nil, text: top.string,
                                   frame: geometry.screenRect(fromVisionBox: obs.boundingBox), confidence: Double(top.confidence),
                                   windowID: windowID)
        })
    }

    static func png(_ image: CGImage, size: CGSize) -> Data? {
        guard let ctx = CGContext(data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8,
                                  bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(origin: .zero, size: size))
        guard let scaled = ctx.makeImage() else { return nil }
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, scaled, nil)
        return CGImageDestinationFinalize(dest) ? data as Data : nil
    }
}
