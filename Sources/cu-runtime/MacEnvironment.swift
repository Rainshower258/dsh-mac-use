import AppKit
import CURuntimeCore

final class MacEnvironment: SystemEnvironment {
    /// AX elements observed recently, by opaque handle, for re-reading before an action. Kept for as many
    /// observes as the Dispatcher retains snapshots. Touched only from the daemon's serial worker queue.
    var handles: [Int: AXUIElement] = [:]
    var handleHistory: [[Int]] = []
    var nextHandle = 1
    /// Bounded wait for windows of just-launched/activated granted apps (see WindowAppearWait). Worker queue only.
    var windowWait = WindowAppearWait()
    /// Per-window OCR results between observes (OCRCache). Worker queue only.
    var ocrCache = OCRCache()
    /// Top-level AX frames of overlay owners (the Dock), see overlayParts. Also used by prewarm: locked.
    private static let overlayLock = NSLock()
    private static var overlayCache: [pid_t: (parts: [CGRect], at: Date)] = [:]
    /// Time spent in overlay AX queries since the last reset (observe reports it as a phase).
    private static var overlayAXMs = 0.0
    /// Set when a decision-time overlay read failed (see freshOverlayParts); reset by the hit test.
    private static var decisionOverlayUnknown = false
    static func takeDecisionOverlayUnknown() -> Bool {
        overlayLock.lock()
        defer { overlayLock.unlock() }
        let v = decisionOverlayUnknown
        decisionOverlayUnknown = false
        return v
    }
    static func overlayAXTime(reset: Bool = false) -> Double {
        overlayLock.lock()
        defer { overlayLock.unlock() }
        let t = overlayAXMs
        if reset { overlayAXMs = 0 }
        return t
    }

    func register(_ el: AXUIElement, into batch: inout [Int]) -> Int {
        let h = nextHandle
        nextHandle += 1
        handles[h] = el
        batch.append(h)
        return h
    }

    func retire(_ batch: [Int]) {
        handleHistory.append(batch)
        while handleHistory.count > SnapshotStore.retained {
            for h in handleHistory.removeFirst() { handles.removeValue(forKey: h) }
        }
    }

    func currentWindowFrames() -> [UInt32: CGRect] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return [:] }
        var out: [UInt32: CGRect] = [:]
        for w in list {
            guard let id = w[kCGWindowNumber as String] as? UInt32, let b = w[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: b),
                  // The pointer's window moves with the mouse: it would void every "window list unchanged" check.
                  // app: nil: the Window Server has no bundle, and isPointer requires it to be the owner.
                  !OverlayPolicy.isPointer(layer: w[kCGWindowLayer as String] as? Int ?? 0,
                                           ownerName: w[kCGWindowOwnerName as String] as? String, app: nil)
                else { continue }
            out[id] = rect
        }
        return out
    }

    /// P5: as the official cua-macos provider reads it (CGSSessionScreenIsLocked; else on console and logged in).
    func sessionLocked() -> Bool? {
        guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return nil }
        func flag(_ key: String) -> Bool? { (d[key] as? NSNumber)?.boolValue }
        if flag("CGSSessionScreenIsLocked") == true { return true }
        return flag("kCGSSessionOnConsoleKey") == true && flag("kCGSessionLoginDoneKey") == true ? false : nil
    }

    // P4: the general pasteboard, on the main thread (AppKit).
    func pasteboardSnapshot(limit: Int) -> PasteboardContents? {
        onMain { () -> PasteboardContents? in
            let pb = NSPasteboard.general
            var items: [[PasteboardEntry]] = []
            var bytes = 0
            for item in pb.pasteboardItems ?? [] {
                var entries: [PasteboardEntry] = []
                for type in item.types {
                    guard let data = item.data(forType: type) else { return nil }
                    bytes += data.count
                    if bytes > limit { return PasteboardContents(items: items, bytes: bytes) }
                    entries.append(PasteboardEntry(type: type.rawValue, data: data))
                }
                items.append(entries)
            }
            return PasteboardContents(items: items, bytes: bytes)
        }
    }
    func pasteboardClear() -> Bool {
        onMain { NSPasteboard.general.clearContents() >= 0 }
    }

    func pasteboardWrite(text: String) -> Int? {
        onMain { () -> Int? in
            let pb = NSPasteboard.general
            pb.clearContents()
            return pb.setString(text, forType: .string) ? pb.changeCount : nil
        }
    }
    func pasteboardChangeCount() -> Int { onMain { NSPasteboard.general.changeCount } }
    func pasteboardRestore(_ contents: PasteboardContents) -> Bool {
        onMain { () -> Bool in
            let pb = NSPasteboard.general
            pb.clearContents()
            if contents.items.isEmpty { return true }
            let objects = contents.items.map { entries -> NSPasteboardItem in
                let item = NSPasteboardItem()
                for e in entries { item.setData(e.data, forType: NSPasteboard.PasteboardType(e.type)) }
                return item
            }
            return pb.writeObjects(objects)
        }
    }

    func onMain<T>(_ body: () -> T) -> T {
        Thread.isMainThread ? body() : DispatchQueue.main.sync(execute: body)
    }

    func apps(_ bundleID: String) -> [NSRunningApplication] {
        onMain {
            NSWorkspace.shared.runningApplications.filter {
                $0.bundleIdentifier?.caseInsensitiveCompare(bundleID) == .orderedSame
            }
        }
    }

    func runningBundleIDs() -> Set<String> {
        onMain { Set(NSWorkspace.shared.runningApplications.compactMap { $0.bundleIdentifier?.lowercased() }) }
    }

    func runningPIDs(bundleID: String) -> [Int32] { apps(bundleID).filter { !$0.isTerminated }.map(\.processIdentifier) }

    func processPath(pid: Int32) -> String? {
        var buf = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        return proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 ? String(cString: buf) : nil
    }

    func displayNames(bundleID: String) -> [String] {
        var names = apps(bundleID).compactMap(\.localizedName)
        if let url = onMain({ NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) }) {
            names.append(url.deletingPathExtension().lastPathComponent)
            if let bundle = Bundle(url: url) {
                for key in ["CFBundleDisplayName", "CFBundleName"] {
                    if let n = bundle.localizedInfoDictionary?[key] as? String { names.append(n) }
                    if let n = bundle.infoDictionary?[key] as? String { names.append(n) }
                }
            }
        }
        return names
    }

    func frontmostBundleID() -> String? {
        onMain { NSWorkspace.shared.frontmostApplication?.bundleIdentifier?.lowercased() }
    }

    /// Every on-screen window front-to-back, with system overlays (the Dock's full-display window) expanded into
    /// their visible parts (see OverlayPolicy). Only geometry and ownership are read for non-granted windows.
    ///
    /// `forDecision`: the result decides whether an action is allowed (the CG side of the pre-action hit test,
    /// an element's window being on top). Then the Dock's parts are read fresh (1 s timeout, no reuse), and if
    /// that fails the whole Dock overlay counts as covering the screen, so the action is refused. Otherwise
    /// (observe, zoom: occlusion flags, the composite, the snapshot's z-order) reused or last-known parts are
    /// fine: they only shape what the model sees. The snapshot's z-order does feed `not_on_target_window`, but
    /// every action is re-checked afterwards against a fresh hit test, which is what allows it.
    func expandedZOrder(granted: Set<String>, forDecision: Bool = false, includeInvisible: Bool = false) -> [ZWindow] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return [] }
        var bundleOf: [pid_t: String?] = [:]
        let raw: [OverlayPolicy.RawWindow] = list.compactMap { w in
            guard let id = w[kCGWindowNumber as String] as? UInt32, let pid = w[kCGWindowOwnerPID as String] as? pid_t,
                  let b = w[kCGWindowBounds as String] as? NSDictionary, let rect = CGRect(dictionaryRepresentation: b),
                  includeInvisible || (w[kCGWindowAlpha as String] as? Double ?? 1) > 0, rect.width > 0, rect.height > 0 else { return nil }
            if bundleOf[pid] == nil {
                bundleOf[pid] = onMain { NSRunningApplication(processIdentifier: pid)?.bundleIdentifier?.lowercased() }
            }
            return OverlayPolicy.RawWindow(id: id, app: bundleOf[pid] ?? nil, pid: pid,
                                           layer: w[kCGWindowLayer as String] as? Int ?? 0, frame: rect,
                                           ownerName: w[kCGWindowOwnerName as String] as? String)
        }
        return OverlayPolicy.expand(raw, display: CGDisplayBounds(CGMainDisplayID()), granted: granted,
                                    partsOf: forDecision ? Self.freshOverlayParts : Self.overlayParts)
    }

    /// For allow/refuse decisions: the Dock's parts now, or nil (unknown: refuse). Refreshes the display cache.
    /// A failure is noted in `decisionOverlayUnknown` so the hit test can say why it refuses.
    static func freshOverlayParts(_ pid: pid_t) -> [CGRect]? {
        let parts = topLevelAXFrames(pid, timeout: 1.0)
        guard !parts.isEmpty else {
            overlayLock.lock()
            decisionOverlayUnknown = true
            overlayLock.unlock()
            return nil
        }
        overlayLock.lock()
        overlayCache[pid] = (parts, Date())
        overlayLock.unlock()
        return parts
    }

    /// The Dock bar's frames for DISPLAY purposes only (observe/zoom: occlusion flags, the composite; see
    /// expandedZOrder(forDecision:)). While an app launches the Dock animates its icon and answered no AX query
    /// within 1 s: each window-list pass then cost ~1 s, 3 s for the first observe after a launch (2026-09-29).
    /// The bar rarely moves, so: reuse a result for 0.5 s, query with a short timeout, and fall back to the last
    /// known frames when the query fails. Never used to allow an action: decisions use freshOverlayParts.
    static func overlayParts(_ pid: pid_t) -> [CGRect]? {
        overlayLock.lock()
        let cached = overlayCache[pid]
        overlayLock.unlock()
        if let cached, Date().timeIntervalSince(cached.at) < 0.5 { return cached.parts }
        let t0 = Date()
        let parts = topLevelAXFrames(pid, timeout: 0.25)
        overlayLock.lock()
        defer { overlayLock.unlock() }
        overlayAXMs += Date().timeIntervalSince(t0) * 1000
        if !parts.isEmpty {
            overlayCache[pid] = (parts, Date())
            return parts
        }
        // Failed: keep the last known frames and back off for the same 0.5 s, so a busy Dock costs one short
        // timeout per observe, not one per window-list pass.
        guard let cached else { return [] }
        overlayCache[pid] = (cached.parts, Date())
        return cached.parts
    }

    /// Frames of an app's top-level AX elements (for the Dock: the Dock bar).
    static func topLevelAXFrames(_ pid: pid_t, timeout: Float) -> [CGRect] {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, timeout)
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXChildrenAttribute as CFString, &ref) == .success, let ref,
              CFGetTypeID(ref) == CFArrayGetTypeID(), let items = ref as? [AnyObject] else { return [] }
        return items.compactMap { item -> CGRect? in
            guard CFGetTypeID(item) == AXUIElementGetTypeID() else { return nil }
            let el = unsafeBitCast(item, to: AXUIElement.self)
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
    }

    /// Who would receive a click at `point`: the topmost window (overlays expanded, read fresh) and the AX hit test.
    /// The window list catches the menu bar (Window Server); the AX hit test catches click-through areas, system UI
    /// inside overlays (the Dock bar) and invisible windows that take clicks. The caller refuses unless both agree.
    func hitTest(at point: CGPoint) -> HitTest {
        _ = Self.takeDecisionOverlayUnknown()
        let cg = Composite.topmost(at: point, in: expandedZOrder(granted: [], forDecision: true)).map { $0.app ?? "window \($0.id) (no app bundle)" }
        let overlayUnknown = Self.takeDecisionOverlayUnknown()
        var hit: AXUIElement?
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 1.0)
        let err = AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit)
        guard err == .success, let hit else {
            // An app that does not implement the AX hit test (WeChat 4, 2026-10-14): the window list with invisible
            // windows counted is read too, for the caller to decide on (Dispatcher.precheck). Any other failure: no.
            guard err == .notImplemented else { return HitTest(cg: cg, ax: nil, overlayUnknown: overlayUnknown) }
            let all = Composite.topmost(at: point, in: expandedZOrder(granted: [], forDecision: true, includeInvisible: true))
                .map { $0.app ?? "window \($0.id) (no app bundle)" }
            let unknownToo = Self.takeDecisionOverlayUnknown()
            return HitTest(cg: cg, ax: nil, overlayUnknown: overlayUnknown || unknownToo, axNotImplemented: true,
                           cgWithInvisible: all)
        }
        var pid: pid_t = 0
        AXUIElementGetPid(hit, &pid)
        let ax = onMain { NSRunningApplication(processIdentifier: pid)?.bundleIdentifier?.lowercased() } ?? "pid:\(pid)"
        guard ax != cg else { return HitTest(cg: cg, ax: ax, overlayUnknown: overlayUnknown) }
        let region = OverlayPolicy.interceptionRegion(windows: Self.windows(ofPID: pid), point: point,
                                                      display: CGDisplayBounds(CGMainDisplayID()), axAncestors: Self.ancestorFrames(of: hit))
        return HitTest(cg: cg, ax: ax, axRegion: region ?? Self.frame(of: hit), overlayUnknown: overlayUnknown)
    }

    /// On-screen windows of `pid`, alpha 0 included (an intercepting window may be invisible).
    static func windows(ofPID pid: pid_t) -> [(layer: Int, frame: CGRect)] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return [] }
        return list.compactMap { w in
            guard (w[kCGWindowOwnerPID as String] as? pid_t) == pid, let b = w[kCGWindowBounds as String] as? NSDictionary,
                  let r = CGRect(dictionaryRepresentation: b) else { return nil }
            return (layer: w[kCGWindowLayer as String] as? Int ?? 0, frame: r)
        }
    }

    /// Frames and subroles of an AX element and its ancestors, from the element up (at most 30 levels).
    static func ancestorFrames(of el: AXUIElement) -> [(frame: CGRect, subrole: String?)] {
        var frames: [(frame: CGRect, subrole: String?)] = [], cur: AXUIElement? = el
        for _ in 0..<30 {
            guard let e = cur else { break }
            var sub: CFTypeRef?
            AXUIElementCopyAttributeValue(e, kAXSubroleAttribute as CFString, &sub)
            if let f = frame(of: e) { frames.append((f, sub as? String)) }
            var parent: CFTypeRef?
            guard AXUIElementCopyAttributeValue(e, kAXParentAttribute as CFString, &parent) == .success, let parent,
                  CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
            cur = unsafeBitCast(parent, to: AXUIElement.self)
        }
        return frames
    }

    func launch(bundleID: String) -> Bool {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else { return false }
        let done = DispatchSemaphore(value: 0)
        var ok = false
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { app, error in
            ok = app != nil && error == nil
            done.signal()
        }
        return done.wait(timeout: .now() + 10) == .success && ok
    }

    func open(_ url: URL, bundleID: String) -> OpenOutcome {
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else { return .failed("no such app") }
        let done = DispatchSemaphore(value: 0)
        var outcome = OpenOutcome.failed("no answer")
        NSWorkspace.shared.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration()) { app, error in
            if let error {
                let e = error as NSError
                let noPermission = (e.domain == NSCocoaErrorDomain && (e.code == NSFileReadNoPermissionError || e.code == NSFileNoSuchFileError))
                    || (e.domain == NSPOSIXErrorDomain && (e.code == Int(EPERM) || e.code == Int(EACCES)))
                outcome = noPermission ? .noPermission : .failed("\(e.domain) \(e.code): \(e.localizedDescription)")
            } else {
                outcome = app != nil ? .opened : .failed("no app returned")
            }
            done.signal()
        }
        return done.wait(timeout: .now() + Dispatcher.openWait) == .success ? outcome : .timedOut
    }
}
