import AppKit
import ApplicationServices
import CURuntimeCore

// MARK: - Menu bar over AX (CURuntimeCore/Menu.swift)

extension MacEnvironment {
    func menu(bundleID: String, path: [String], press: Bool) -> MenuOutcome {
        guard let pid = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first?.processIdentifier
            ?? NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier?.lowercased() == bundleID })?.processIdentifier
        else { return .unavailable }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, Float(AXLimits().messagingTimeout))
        guard let bar = Self.axElement(app, kAXMenuBarAttribute) else { return .unavailable }
        // The first menu bar item is the Apple menu: never listed, never matched.
        var level = Array(Self.axChildren(bar).dropFirst())
        var current: AXUIElement?
        for (i, wanted) in path.enumerated() {
            let key = MenuPolicy.key(wanted)
            let named = Self.visible(level)
            let hits = named.filter { MenuPolicy.key($0.title) == key }
            guard !hits.isEmpty else { return .notFound(level: i, available: named.map(\.title)) }
            guard hits.count == 1 else { return .ambiguous(level: i) }
            if let why = MenuPolicy.exclusion(title: hits[0].title) { return .excluded(why) }
            current = hits[0].element
            let sub = Self.submenu(hits[0].element)
            if i < path.count - 1 {
                guard let sub else { return .notFound(level: i + 1, available: []) }
                level = Self.axChildren(sub)
            } else if let sub {
                level = Self.axChildren(sub)
                current = nil  // ends at a menu: list it
            }
        }
        guard let item = current, press else { return .listed(Self.visible(level).map(\.info)) }
        guard Self.bool(item, kAXEnabledAttribute) != false else { return .disabled }
        return AXUIElementPerformAction(item, kAXPressAction as CFString) == .success ? .pressed : .unavailable
    }

    private struct Named {
        let element: AXUIElement
        let title: String
        let info: MenuItemInfo
    }

    /// Items with a title (separators have none), Services left out.
    private static func visible(_ items: [AXUIElement]) -> [Named] {
        items.compactMap { el in
            guard let t = string(el, kAXTitleAttribute), !t.isEmpty, MenuPolicy.exclusion(title: t) == nil else { return nil }
            let info = MenuItemInfo(title: String(t.prefix(120)), enabled: bool(el, kAXEnabledAttribute) ?? true,
                                    submenu: submenu(el) != nil)
            return Named(element: el, title: t, info: info)
        }
    }

    private static func submenu(_ el: AXUIElement) -> AXUIElement? {
        axChildren(el).first { string($0, kAXRoleAttribute) == (kAXMenuRole as String) }
    }

    private static func axElement(_ el: AXUIElement, _ attr: String) -> AXUIElement? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &ref) == .success, let ref,
              CFGetTypeID(ref) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(ref, to: AXUIElement.self)
    }

    private static func axChildren(_ el: AXUIElement) -> [AXUIElement] {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &ref) == .success, let ref,
              CFGetTypeID(ref) == CFArrayGetTypeID(), let items = ref as? [AnyObject] else { return [] }
        return items.compactMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? unsafeBitCast($0, to: AXUIElement.self) : nil }
    }

    private static func string(_ el: AXUIElement, _ attr: String) -> String? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &ref) == .success, let ref,
              CFGetTypeID(ref) == CFStringGetTypeID() else { return nil }
        return unsafeBitCast(ref, to: CFString.self) as String
    }

    private static func bool(_ el: AXUIElement, _ attr: String) -> Bool? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &ref) == .success, let ref,
              CFGetTypeID(ref) == CFBooleanGetTypeID() else { return nil }
        return CFBooleanGetValue(unsafeBitCast(ref, to: CFBoolean.self))
    }
}
