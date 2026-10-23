import AppKit
import CURuntimeCore
import ScreenCaptureKit

/// Minimal, fixture-independent reproduction of the display+including behaviour found on 2026-09-28: draws a red
/// square at a known global position in our own window, captures it with (a) a display filter including our app
/// and (b) a per-window filter, and reports where each capture's own geometry says the square is.
/// If (a) is ever fixed by Apple, or (b) ever breaks, this is the first thing to show it.
enum Canary {
    static let windowOrigin = CGPoint(x: 200, y: 200)   // global points, top-left origin
    static let windowSize = CGSize(width: 320, height: 200)
    static let markerOffset = CGPoint(x: 40, y: 40)
    static let markerSize: CGFloat = 20

    static var expectedCentre: CGPoint {
        CGPoint(x: windowOrigin.x + markerOffset.x + markerSize / 2, y: windowOrigin.y + markerOffset.y + markerSize / 2)
    }

    @MainActor
    static func run(out: String) {
        NSApplication.shared.setActivationPolicy(.accessory)
        let screenHeight = NSScreen.screens.first?.frame.height ?? 900
        let rect = NSRect(x: windowOrigin.x, y: screenHeight - windowOrigin.y - windowSize.height,
                          width: windowSize.width, height: windowSize.height)
        let window = NSWindow(contentRect: rect, styleMask: .borderless, backing: .buffered, defer: false)
        window.backgroundColor = .white
        window.level = .floating
        let marker = NSView(frame: NSRect(x: markerOffset.x, y: windowSize.height - markerOffset.y - markerSize,
                                          width: markerSize, height: markerSize))
        marker.wantsLayer = true
        marker.layer?.backgroundColor = NSColor(srgbRed: 1, green: 0, blue: 0, alpha: 1).cgColor
        window.contentView?.addSubview(marker)
        window.orderFrontRegardless()
        let windowNumber = CGWindowID(window.windowNumber)

        Task {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            var result: [String: Any] = ["expected_pt": [expectedCentre.x, expectedCentre.y]]
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
                guard let w = content.windows.first(where: { $0.windowID == windowNumber }),
                      let me = content.applications.first(where: { $0.processID == getpid() }),
                      let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
                    throw CocoaError(.featureUnsupported)
                }
                let a = SCContentFilter(display: display, including: [me], exceptingWindows: [])
                result["display_including"] = try await measure(a, CaptureGeometry(contentRect: a.contentRect,
                                                                                    pointPixelScale: Double(a.pointPixelScale)))
                let b = SCContentFilter(desktopIndependentWindow: w)
                result["per_window"] = try await measure(b, CaptureGeometry(contentRect: w.frame, pointPixelScale: Double(b.pointPixelScale)))
                let offA = (result["display_including"] as? [String: Any])?["error_pt"] as? Double ?? .infinity
                let offB = (result["per_window"] as? [String: Any])?["error_pt"] as? Double ?? .infinity
                result["display_including_shifted"] = offA > 2
                result["per_window_ok"] = offB <= 2
            } catch {
                result["error"] = String(describing: error)
            }
            let data = (try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys, .prettyPrinted])) ?? Data()
            FileManager.default.createFile(atPath: out, contents: data, attributes: [.posixPermissions: 0o600])
            exit(0)
        }
    }

    private static func measure(_ filter: SCContentFilter, _ g: CaptureGeometry) async throws -> [String: Any] {
        let conf = SCStreamConfiguration()
        conf.width = Int(g.nativeSizePx.width)
        conf.height = Int(g.nativeSizePx.height)
        conf.showsCursor = false
        conf.ignoreShadowsSingleWindow = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: conf)
        guard let c = redCentroid(image) else {
            return ["found": false, "content_rect": [g.contentRect.minX, g.contentRect.minY, g.contentRect.width, g.contentRect.height]]
        }
        let p = g.screenPoint(fromNativePixel: c)
        let err = hypot(p.x - expectedCentre.x, p.y - expectedCentre.y)
        return ["found": true, "found_pt": [p.x, p.y], "error_pt": Double(err),
                "content_rect": [g.contentRect.minX, g.contentRect.minY, g.contentRect.width, g.contentRect.height],
                "image_px": [image.width, image.height]]
    }

    /// Centroid of pure-red pixels, in image pixels (top-left origin).
    private static func redCentroid(_ image: CGImage) -> CGPoint? {
        let w = image.width, h = image.height
        var buf = [UInt8](repeating: 0, count: w * h * 4)
        guard let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        var sx = 0.0, sy = 0.0, n = 0.0
        for y in 0..<h {
            for x in 0..<w {
                let i = (y * w + x) * 4
                if buf[i] > 200 && buf[i + 1] < 70 && buf[i + 2] < 70 { sx += Double(x); sy += Double(y); n += 1 }
            }
        }
        guard n > 0 else { return nil }
        // CGContext memory is top-row-first for this layout, so y is already top-left based.
        return CGPoint(x: sx / n + 0.5, y: sy / n + 0.5)
    }
}

/// `canary --sheet`: which capture method sees a native AppKit sheet correctly?
///   parent_window   desktopIndependentWindow(parent): does it contain the attached sheet, correctly placed?
///   sheet_window    desktopIndependentWindow(sheet): the capture that looked wrong in the geometry suite
///   window_list     display filter including [parent, sheet]: mapping, and whether a region of the parent that
///                   an excluded (non-included) window covers is revealed (it must then be blocked by us)
/// Truth: AppKit's own convertToScreen for each marker, independent of ScreenCaptureKit.
enum SheetCanary {
    struct Marker { let name: String; let rgb: (UInt8, UInt8, UInt8); let view: NSView }

    @MainActor
    static func run(out: String) {
        NSApplication.shared.setActivationPolicy(.accessory)
        let screenH = NSScreen.screens.first?.frame.height ?? 900
        func window(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, titled: Bool, color: NSColor) -> NSWindow {
            let win = NSWindow(contentRect: NSRect(x: x, y: screenH - y - h, width: w, height: h),
                               styleMask: titled ? [.titled] : [.borderless], backing: .buffered, defer: false)
            win.backgroundColor = color
            win.isReleasedWhenClosed = false
            return win
        }
        func marker(_ name: String, in win: NSWindow, x: CGFloat, y: CGFloat, _ rgb: (UInt8, UInt8, UInt8)) -> Marker {
            let h = win.contentView?.bounds.height ?? 0
            let v = NSView(frame: NSRect(x: x, y: h - y - 20, width: 20, height: 20))
            v.wantsLayer = true
            v.layer?.backgroundColor = NSColor(srgbRed: CGFloat(rgb.0) / 255, green: CGFloat(rgb.1) / 255,
                                               blue: CGFloat(rgb.2) / 255, alpha: 1).cgColor
            win.contentView?.addSubview(v)
            return Marker(name: name, rgb: rgb, view: v)
        }
        let parent = window(200, 150, 600, 400, titled: true, color: .white)
        let sheet = window(0, 0, 300, 160, titled: true, color: .white)
        let occluder = window(640, 420, 220, 160, titled: false, color: NSColor(srgbRed: 0, green: 1, blue: 0, alpha: 1))
        let markers = [marker("parent_red", in: parent, x: 40, y: 40, (255, 0, 0)),
                       marker("parent_yellow_under_occluder", in: parent, x: 520, y: 340, (255, 255, 0)),
                       marker("sheet_blue", in: sheet, x: 30, y: 30, (0, 0, 255))]
        parent.orderFrontRegardless()
        parent.beginSheet(sheet)
        occluder.level = .floating
        occluder.orderFrontRegardless()

        Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)   // sheet slide-in animation
            var result: [String: Any] = [:]
            // Truth: AppKit's screen rects (bottom-left origin) -> global top-left points.
            var truth: [String: CGPoint] = [:]
            for m in markers {
                guard let w = m.view.window else { continue }
                let r = w.convertToScreen(m.view.convert(m.view.bounds, to: nil))
                truth[m.name] = CGPoint(x: r.midX, y: screenH - r.midY)
            }
            result["truth"] = truth.mapValues { [$0.x, $0.y] }
            result["frames"] = ["parent": frameJSON(parent, screenH), "sheet": frameJSON(sheet, screenH),
                                "occluder": frameJSON(occluder, screenH)]
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
                guard let p = content.windows.first(where: { $0.windowID == CGWindowID(parent.windowNumber) }),
                      let s = content.windows.first(where: { $0.windowID == CGWindowID(sheet.windowNumber) }),
                      let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
                    throw CocoaError(.featureUnsupported)
                }
                let pf = SCContentFilter(desktopIndependentWindow: p)
                result["parent_window"] = try await probe(pf, CaptureGeometry(contentRect: p.frame, pointPixelScale: Double(pf.pointPixelScale)),
                                                          markers, truth)
                let sf = SCContentFilter(desktopIndependentWindow: s)
                result["sheet_window"] = try await probe(sf, CaptureGeometry(contentRect: s.frame, pointPixelScale: Double(sf.pointPixelScale)),
                                                         markers, truth)
                let lf = SCContentFilter(display: display, including: [p, s])
                result["window_list"] = try await probe(lf, CaptureGeometry(contentRect: lf.contentRect, pointPixelScale: Double(lf.pointPixelScale)),
                                                        markers, truth)
                result["sck_frames"] = ["parent": [p.frame.minX, p.frame.minY, p.frame.width, p.frame.height],
                                        "sheet": [s.frame.minX, s.frame.minY, s.frame.width, s.frame.height]]
            } catch {
                result["error"] = String(describing: error)
            }
            let data = (try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys, .prettyPrinted])) ?? Data()
            FileManager.default.createFile(atPath: out, contents: data, attributes: [.posixPermissions: 0o600])
            exit(0)
        }
    }

    private static func frameJSON(_ w: NSWindow, _ screenH: CGFloat) -> [CGFloat] {
        [w.frame.minX, screenH - w.frame.maxY, w.frame.width, w.frame.height]
    }

    private static func probe(_ filter: SCContentFilter, _ g: CaptureGeometry, _ markers: [Marker],
                              _ truth: [String: CGPoint]) async throws -> [String: Any] {
        let conf = SCStreamConfiguration()
        conf.width = Int(g.nativeSizePx.width)
        conf.height = Int(g.nativeSizePx.height)
        conf.showsCursor = false
        conf.ignoreShadowsSingleWindow = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: conf)
        if let dir = ProcessInfo.processInfo.environment["CU_CANARY_DUMP"] ?? Optional("/tmp"),
           let png = MacEnvironment.png(image, size: CGSize(width: image.width, height: image.height)) {
            let name = "sheet-canary-\(Int(g.contentRect.minX))-\(Int(g.contentRect.minY)).png"
            FileManager.default.createFile(atPath: "\(dir)/\(name)", contents: png, attributes: [.posixPermissions: 0o600])
        }
        var found: [String: Any] = [:]
        for m in markers {
            guard let c = centroid(image, m.rgb), let t = truth[m.name] else { found[m.name] = "not found"; continue }
            let p = g.screenPoint(fromNativePixel: c)
            found[m.name] = ["pt": [p.x, p.y], "error_pt": Double(hypot(p.x - t.x, p.y - t.y))]
        }
        return ["content_rect": [g.contentRect.minX, g.contentRect.minY, g.contentRect.width, g.contentRect.height],
                "expected_px": [g.nativeSizePx.width, g.nativeSizePx.height], "image_px": [image.width, image.height],
                "markers": found]
    }

    private static func centroid(_ image: CGImage, _ rgb: (UInt8, UInt8, UInt8)) -> CGPoint? {
        let w = image.width, h = image.height
        var buf = [UInt8](repeating: 0, count: w * h * 4)
        guard let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        func near(_ v: UInt8, _ target: UInt8) -> Bool { target > 127 ? v > 190 : v < 90 }
        var sx = 0.0, sy = 0.0, n = 0.0
        for y in 0..<h {
            for x in 0..<w {
                let i = (y * w + x) * 4
                if near(buf[i], rgb.0) && near(buf[i + 1], rgb.1) && near(buf[i + 2], rgb.2) {
                    sx += Double(x); sy += Double(y); n += 1
                }
            }
        }
        guard n > 20 else { return nil }
        return CGPoint(x: sx / n + 0.5, y: sy / n + 0.5)
    }
}
