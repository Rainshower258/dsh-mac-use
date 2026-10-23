import AppKit
import ApplicationServices
import CURuntimeCore

/// Input through real events and AX (PLAN-v2 §6). Every call here comes after the policy layer's checks.
extension MacEnvironment {
    private static let source = CGEventSource(stateID: .hidSystemState)

    private func post(_ e: CGEvent?) -> Bool {
        guard let e else { return false }
        e.post(tap: .cghidEventTap)
        return true
    }

    private func moveMouse(to point: CGPoint) -> Bool {
        let ok = post(CGEvent(mouseEventSource: Self.source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
        usleep(30_000)
        return ok
    }

    // MARK: - Mouse

    /// Move first (some apps ignore clicks without a preceding move), then down/up with the click state set, so
    /// a double click registers as one (kCGMouseEventClickState 1, then 2).
    func click(at point: CGPoint, button: MouseButton, count: Int) -> Bool {
        let (downType, upType, cgButton): (CGEventType, CGEventType, CGMouseButton) = switch button {
        case .left: (.leftMouseDown, .leftMouseUp, .left)
        case .right: (.rightMouseDown, .rightMouseUp, .right)
        case .middle: (.otherMouseDown, .otherMouseUp, .center)
        }
        guard moveMouse(to: point) else { return false }
        for n in 1...max(1, count) {
            guard let down = CGEvent(mouseEventSource: Self.source, mouseType: downType, mouseCursorPosition: point, mouseButton: cgButton),
                  let up = CGEvent(mouseEventSource: Self.source, mouseType: upType, mouseCursorPosition: point, mouseButton: cgButton)
            else { return false }
            down.setIntegerValueField(.mouseEventClickState, value: Int64(n))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(n))
            down.post(tap: .cghidEventTap)
            usleep(15_000)
            up.post(tap: .cghidEventTap)
            usleep(15_000)
        }
        return true
    }

    func scroll(at point: CGPoint, dx: Int, dy: Int) -> Bool {
        guard moveMouse(to: point),
              let e = CGEvent(scrollWheelEvent2Source: Self.source, units: .line, wheelCount: 2,
                              wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0) else { return false }
        e.location = point
        e.post(tap: .cghidEventTap)
        return true
    }

    /// Down at `from`, 12 dragged moves, up at `to`: apps that track drags need the intermediate events.
    func drag(from: CGPoint, to: CGPoint) -> Bool {
        guard moveMouse(to: from),
              post(CGEvent(mouseEventSource: Self.source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left))
        else { return false }
        usleep(60_000)
        let steps = 12
        for i in 1...steps {
            let t = CGFloat(i) / CGFloat(steps)
            let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
            _ = post(CGEvent(mouseEventSource: Self.source, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left))
            usleep(16_000)
        }
        usleep(60_000)
        return post(CGEvent(mouseEventSource: Self.source, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left))
    }

    // MARK: - Keyboard

    /// Text chunks as Unicode keyboard events (no input method involved, so CJK arrives as typed), keys as real
    /// key presses; a short gap between steps.
    func type(_ steps: [TypingPlan.Step], shouldContinue: () -> Bool) -> Int {
        var posted = 0
        for step in steps {
            guard shouldContinue() else { break }
            switch step {
            case .text(let s):
                let units = Array(s.utf16)
                guard let down = CGEvent(keyboardEventSource: Self.source, virtualKey: 0, keyDown: true),
                      let up = CGEvent(keyboardEventSource: Self.source, virtualKey: 0, keyDown: false) else { return posted }
                down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                down.post(tap: .cghidEventTap)
                up.post(tap: .cghidEventTap)
            case .key(let chord):
                guard press(chord) else { return posted }
            }
            posted += 1
            usleep(20_000)
        }
        return posted
    }

    /// Modifiers are pressed as real keys (down in order, up in reverse), each event carrying the flags held at
    /// that moment, so apps that track modifier state see a real chord.
    func press(_ chord: KeyChord) -> Bool {
        guard let code = KeyCodes.keys[chord.key] else { return false }
        let order = chord.modifiers.sorted()
        func flag(_ m: KeyChord.Modifier) -> CGEventFlags {
            switch m {
            case .cmd: .maskCommand
            case .shift: .maskShift
            case .opt: .maskAlternate
            case .ctrl: .maskControl
            case .fn: .maskSecondaryFn
            }
        }
        func keyEvent(_ vk: UInt16, down: Bool, flags: CGEventFlags) -> Bool {
            guard let e = CGEvent(keyboardEventSource: Self.source, virtualKey: vk, keyDown: down) else { return false }
            e.flags = flags
            e.post(tap: .cghidEventTap)
            usleep(8_000)
            return true
        }
        var held: CGEventFlags = []
        for m in order {
            held.insert(flag(m))
            guard let vk = KeyCodes.modifiers[m], keyEvent(vk, down: true, flags: held) else { return false }
        }
        guard keyEvent(code, down: true, flags: held), keyEvent(code, down: false, flags: held) else { return false }
        for m in order.reversed() {
            held.remove(flag(m))
            guard let vk = KeyCodes.modifiers[m], keyEvent(vk, down: false, flags: held) else { return false }
        }
        return true
    }

    // MARK: - Activation

    func activate(bundleID: String, timeout: TimeInterval, method: ActivationMethod) -> Bool {
        guard let app = apps(bundleID).first(where: { !$0.isTerminated }) else { return false }
        switch method {
        case .runningApplication:
            onMain { _ = app.activate() }
        case .axFrontmost:
            let el = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(el, 1.0)
            AXUIElementSetAttributeValue(el, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        case .axRaise:
            let el = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(el, 1.0)
            var ref: CFTypeRef?
            if AXUIElementCopyAttributeValue(el, kAXMainWindowAttribute as CFString, &ref) != .success || ref == nil {
                var list: CFTypeRef?
                AXUIElementCopyAttributeValue(el, kAXWindowsAttribute as CFString, &list)
                ref = (list as? [AnyObject])?.first
            }
            if let ref, CFGetTypeID(ref) == AXUIElementGetTypeID() {
                AXUIElementPerformAction(unsafeBitCast(ref, to: AXUIElement.self), kAXRaiseAction as CFString)
            }
        }
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            let front = onMain { NSWorkspace.shared.frontmostApplication?.bundleIdentifier }
            if front?.caseInsensitiveCompare(bundleID) == .orderedSame { return true }
            usleep(25_000)
        } while Date() < deadline
        return false
    }

    // MARK: - AX

    private func element(_ handle: Int) -> AXUIElement? {
        guard let el = handles[handle] else { return nil }
        AXUIElementSetMessagingTimeout(el, Float(AXLimits().messagingTimeout))
        return el
    }

    func axActions(handle: Int) -> [String]? {
        guard let el = element(handle) else { return nil }
        var names: CFArray?
        guard AXUIElementCopyActionNames(el, &names) == .success else { return [] }
        return (names as? [String]) ?? []
    }

    func axPerform(handle: Int, action: String) -> Bool {
        guard let el = element(handle) else { return false }
        return AXUIElementPerformAction(el, action as CFString) == .success
    }

    func axSetValue(handle: Int, value: String) -> Bool {
        guard let el = element(handle) else { return false }
        var settable: DarwinBoolean = false
        guard AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue
        else { return false }
        return AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFString) == .success
    }

    func axValueSettable(handle: Int) -> Bool {
        guard let el = element(handle) else { return false }
        var settable: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
    }

    func axValue(handle: Int) -> String? {
        guard let el = element(handle) else { return nil }
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &v) == .success else { return nil }
        return v as? String
    }

    func axFocus(handle: Int) -> Bool {
        guard let el = element(handle) else { return false }
        return AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success
    }
}
