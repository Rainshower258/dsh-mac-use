import AppKit
import ApplicationServices
import Carbon.HIToolbox

extension MacEnvironment {
    func secureInputReason(bundleID: String, handle: Int?) -> String? {
        if IsSecureEventInputEnabled() { return "secure event input is on" }
        if let handle {
            guard let el = handles[handle] else { return nil }
            return Self.isSecureField(el) ? "the element is a password field" : nil
        }
        for app in apps(bundleID) where !app.isTerminated {
            let appEl = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(appEl, 1.0)
            var ref: CFTypeRef?
            if AXUIElementCopyAttributeValue(appEl, kAXFocusedUIElementAttribute as CFString, &ref) == .success, let ref,
               CFGetTypeID(ref) == AXUIElementGetTypeID(), Self.isSecureField(unsafeBitCast(ref, to: AXUIElement.self)) {
                return "the focused element is a password field"
            }
        }
        return nil
    }

    /// Role or subrole AXSecureTextField (AppKit reports it as the subrole of an AXTextField).
    static func isSecureField(_ el: AXUIElement) -> Bool {
        AXUIElementSetMessagingTimeout(el, 1.0)
        for attr in [kAXRoleAttribute, kAXSubroleAttribute] {
            var v: CFTypeRef?
            if AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success, (v as? String) == "AXSecureTextField" {
                return true
            }
        }
        return false
    }
}
