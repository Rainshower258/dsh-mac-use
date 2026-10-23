import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CURuntimeCore

/// Text Input Sources (the keyboard layout or input method typing goes through). TIS belongs to HIToolbox, which
/// expects the main thread: every call hops there (the worker queue is never the main thread).
extension MacEnvironment {
    private static func onMain<T>(_ body: () -> T) -> T {
        Thread.isMainThread ? body() : DispatchQueue.main.sync(execute: body)
    }

    private static func string(_ src: TISInputSource, _ key: CFString) -> String? {
        guard let p = TISGetInputSourceProperty(src, key) else { return nil }
        return Unmanaged<CFString>.fromOpaque(p).takeUnretainedValue() as String
    }

    private static func bool(_ src: TISInputSource, _ key: CFString) -> Bool? {
        guard let p = TISGetInputSourceProperty(src, key) else { return nil }
        return CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(p).takeUnretainedValue())
    }

    private static func info(_ src: TISInputSource) -> InputSourceInfo? {
        guard let id = string(src, kTISPropertyInputSourceID) else { return nil }
        let type = string(src, kTISPropertyInputSourceType) ?? ""
        // Input methods (Pinyin, Kotoeri…) come as an input mode or a mode-less method; layouts are plain layouts.
        let isIM = type == (kTISTypeKeyboardInputMode as String) || type == (kTISTypeKeyboardInputMethodWithoutModes as String)
            || type == (kTISTypeKeyboardInputMethodModeEnabled as String)
        return InputSourceInfo(id: id, isInputMethod: isIM, asciiCapable: bool(src, kTISPropertyInputSourceIsASCIICapable) ?? false,
                               bundleID: string(src, kTISPropertyBundleID), name: string(src, kTISPropertyLocalizedName))
    }

    func currentInputSource() -> InputSourceInfo? {
        Self.onMain { Self.info(TISCopyCurrentKeyboardInputSource().takeRetainedValue()) }
    }

    /// The layout the system itself uses for ASCII while an input method is active (typically ABC or US).
    func asciiInputSourceID() -> String? {
        Self.onMain { Self.info(TISCopyCurrentASCIICapableKeyboardLayoutInputSource().takeRetainedValue())?.id }
    }

    /// Selects an enabled source by ID, then reads the current one back (for up to 0.5 s): true only if it
    /// verifiably became `id`.
    func selectInputSource(id: String) -> Bool {
        let selected: Bool = Self.onMain {
            let filter = [kTISPropertyInputSourceID as String: id] as CFDictionary
            guard let list = TISCreateInputSourceList(filter, false)?.takeRetainedValue() as? [TISInputSource],
                  let src = list.first else { return false }
            return TISSelectInputSource(src) == noErr
        }
        guard selected else { return false }
        for _ in 0..<10 {
            if currentInputSource()?.id == id { return true }
            usleep(50_000)
        }
        return false
    }

    /// Input methods whose composition state was measured (bench/experiments/ime_probe.py, 2026-09-29, VM, macOS 26):
    /// Pinyin draws its candidate panel as a window of the *app's own process* at the Dock window level (20) while a
    /// composition is open, 6/6; none while idle, after Escape or after committing, 9/9. (The input mode indicator is
    /// also in-process, at the floating level 3, and does not count.) AX exposes no marked-text attribute: the value
    /// holds the raw "ni" like typed text.
    static let measuredCompositionIMs = ["com.apple.inputmethod.SCIM."]

    /// true: a candidate panel is up (of the app, or of the input method's own process). false: none, for a measured
    /// input method. nil: none, but for an input method whose panel behaviour is unmeasured, so absence proves nothing.
    func imeComposing(bundleID: String?) -> Bool? {
        guard let src = currentInputSource() else { return nil }
        guard src.isInputMethod else { return false }
        var owners = Set<pid_t>()
        if let bundleID { owners.formUnion(apps(bundleID).map(\.processIdentifier)) }
        if let imBundle = src.bundleID {
            owners.formUnion(NSRunningApplication.runningApplications(withBundleIdentifier: imBundle).map(\.processIdentifier))
        }
        let panelLevel = Int(CGWindowLevelForKey(.dockWindow))
        let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
        let panel = list.contains { w in
            guard let pid = w[kCGWindowOwnerPID as String] as? pid_t, owners.contains(pid),
                  (w[kCGWindowLayer as String] as? Int) == panelLevel else { return false }
            return (w[kCGWindowAlpha as String] as? Double ?? 1) > 0
        }
        if panel { return true }
        return Self.measuredCompositionIMs.contains { src.id.hasPrefix($0) } ? false : nil
    }

    // MARK: - Debug probe (config `debug_ime`, VM experiment only)

    /// What might tell an uncommitted composition apart (bench/experiments/ime_policy.py compares both states):
    /// on-screen windows that belong to no granted app (the candidate panel) and the focused element's attributes.
    /// Window owners, layers and bounds only; no pixels, no text of other apps.
    func debugIMEProbe(bundleID: String) -> JSONValue {
        var out: [String: JSONValue] = [:]
        if let s = currentInputSource() {
            out["source"] = ["id": .string(s.id), "input_method": .bool(s.isInputMethod), "ascii": .bool(s.asciiCapable),
                             "bundle_id": s.bundleID.map { .string($0) } ?? .null]
        }
        out["ascii_source"] = asciiInputSourceID().map { .string($0) } ?? .null
        let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
        out["windows"] = .array(list.compactMap { w -> JSONValue? in
            let pid = w[kCGWindowOwnerPID as String] as? Int32 ?? 0
            let bundle = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier?.lowercased()
            let b = (w[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) } ?? .zero
            // The granted app's own windows too: a candidate panel may belong to the app's process.
            return ["owner": .string(w[kCGWindowOwnerName as String] as? String ?? "?"), "bundle": bundle.map { .string($0) } ?? .null,
                    "id": .number(Double(w[kCGWindowNumber as String] as? UInt32 ?? 0)),
                    "name": (w[kCGWindowName as String] as? String).map { .string(String($0.prefix(40))) } ?? .null,
                    "layer": .number(Double(w[kCGWindowLayer as String] as? Int ?? 0)),
                    "alpha": .number(w[kCGWindowAlpha as String] as? Double ?? 1), "frame_pt": [.number(b.minX), .number(b.minY), .number(b.width), .number(b.height)]]
        })
        guard let app = apps(bundleID).first(where: { !$0.isTerminated }) else { return .object(out) }
        let appEl = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(appEl, 1.0)
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appEl, kAXFocusedUIElementAttribute as CFString, &ref) == .success, let ref,
              CFGetTypeID(ref) == AXUIElementGetTypeID() else { return .object(out) }
        let el = unsafeBitCast(ref, to: AXUIElement.self)
        var names: CFArray?
        var pnames: CFArray?
        AXUIElementCopyAttributeNames(el, &names)
        AXUIElementCopyParameterizedAttributeNames(el, &pnames)
        let attrs = (names as? [String]) ?? []
        var values: [String: JSONValue] = [:]
        for a in attrs {
            var v: CFTypeRef?
            guard AXUIElementCopyAttributeValue(el, a as CFString, &v) == .success, let v else { continue }
            values[a] = .string(Self.describe(v))
        }
        // Marked (uncommitted) text may show up only as an attribute of the text runs (underline, marked clause).
        var runs: [JSONValue] = []
        var count: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXNumberOfCharactersAttribute as CFString, &count) == .success,
           let n = count as? Int, n > 0 {
            var range = CFRange(location: 0, length: n)
            var attributed: CFTypeRef?
            if let param = AXValueCreate(.cfRange, &range),
               AXUIElementCopyParameterizedAttributeValue(el, kAXAttributedStringForRangeParameterizedAttribute as CFString,
                                                          param, &attributed) == .success,
               let a = attributed as? NSAttributedString {
                a.enumerateAttributes(in: NSRange(location: 0, length: a.length)) { attrs, r, _ in
                    runs.append(["range": [.number(Double(r.location)), .number(Double(r.length))],
                                 "keys": .object(Dictionary(uniqueKeysWithValues: attrs.map {
                                     ($0.key.rawValue, JSONValue.string(Self.describe($0.value as CFTypeRef))) }))])
                }
            }
        }
        out["focused_runs"] = .array(runs)
        out["focused"] = ["attributes": .array(attrs.map { .string($0) }),
                          "parameterized": .array(((pnames as? [String]) ?? []).map { .string($0) }),
                          "values": .object(values)]
        return .object(out)
    }

    private static func describe(_ v: CFTypeRef) -> String {
        if CFGetTypeID(v) == AXValueGetTypeID() {
            let av = unsafeBitCast(v, to: AXValue.self)
            var range = CFRange()
            if AXValueGetType(av) == .cfRange, AXValueGetValue(av, .cfRange, &range) { return "range(\(range.location),\(range.length))" }
            return "axvalue(\(AXValueGetType(av).rawValue))"
        }
        if CFGetTypeID(v) == AXUIElementGetTypeID() { return "element" }
        if let a = v as? [Any] { return "array(\(a.count))" }
        return String(String(describing: v).prefix(120))
    }
}
