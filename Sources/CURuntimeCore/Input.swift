import Foundation

/// Input vocabulary shared by the policy layer and the OS layer (docs/DESIGN.md "Actions").

public enum MouseButton: String, Sendable, CaseIterable {
    case left, right, middle
}

/// How an app is brought to the front. Each is followed by the same verification (the app must become frontmost
/// within the activation timeout); which one is the default is decided by measurement (bench/experiments).
public enum ActivationMethod: String, Sendable, CaseIterable {
    /// NSRunningApplication.activate()
    case runningApplication = "running_application"
    /// AX: kAXFrontmostAttribute = true on the application element
    case axFrontmost = "ax_frontmost"
    /// AX: AXRaise on the app's main (else first) window
    case axRaise = "ax_raise"
}

/// Which way an action is carried out. `auto`: AX when the target is an AX element that supports it, else events.
public enum ActionPath: String, Sendable {
    case auto, ax, event
}

/// AX actions a client may request with act.ax_action. Anything else is refused.
public enum AXActionPolicy {
    public static let allowed: Set<String> = ["AXPress", "AXConfirm", "AXRaise", "AXCancel"]
}

/// macOS virtual key codes (ANSI layout) for every key KeyChord accepts, and for the modifiers.
public enum KeyCodes {
    public static let keys: [String: UInt16] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
        "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "equal": 24,
        "9": 25, "7": 26, "minus": 27, "8": 28, "0": 29, "rightbracket": 30, "o": 31, "u": 32, "leftbracket": 33,
        "i": 34, "p": 35, "return": 36, "l": 37, "j": 38, "quote": 39, "k": 40, "semicolon": 41, "backslash": 42,
        "comma": 43, "slash": 44, "n": 45, "m": 46, "period": 47, "tab": 48, "space": 49, "grave": 50,
        "delete": 51, "escape": 53, "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "left": 123, "right": 124, "down": 125, "up": 126,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
        "f11": 103, "f12": 111, "f13": 105, "f14": 107, "f15": 113, "f16": 106, "f17": 64, "f18": 79, "f19": 80,
        "f20": 90,
    ]

    public static let modifiers: [KeyChord.Modifier: UInt16] = [.cmd: 55, .shift: 56, .opt: 58, .ctrl: 59, .fn: 63]
}

/// Text input split into what the OS layer posts: text in chunks of at most `maxUnits` UTF-16 units
/// (never splitting a character: an emoji or a CJK surrogate pair stays whole), and each line break as a separate
/// Return key press, a tab as a Tab key press. A line break submits in most single-line fields: the tool
/// description says so.
public enum TypingPlan {
    public enum Step: Equatable, Sendable {
        case text(String)
        case key(KeyChord)
    }

    public static let maxUnits = 20

    public static func steps(_ text: String, maxUnits: Int = maxUnits) -> [Step] {
        var steps: [Step] = []
        var chunk = ""
        func flush() {
            if !chunk.isEmpty { steps.append(.text(chunk)); chunk = "" }
        }
        for ch in text {
            if ch == "\n" || ch == "\r" || ch == "\r\n" {
                flush()
                steps.append(.key(KeyChord(modifiers: [], key: "return")))
            } else if ch == "\t" {
                flush()
                steps.append(.key(KeyChord(modifiers: [], key: "tab")))
            } else {
                if chunk.utf16.count + String(ch).utf16.count > maxUnits { flush() }
                chunk.append(ch)
            }
        }
        flush()
        return steps
    }
}
