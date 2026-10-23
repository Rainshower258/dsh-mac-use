import Foundation

/// A normalized key chord such as "cmd+shift+q".
public struct KeyChord: Hashable, Sendable, CustomStringConvertible {
    public enum Modifier: String, CaseIterable, Sendable, Comparable {
        case ctrl, opt, shift, cmd, fn
        public static func < (a: Modifier, b: Modifier) -> Bool {
            allCases.firstIndex(of: a)! < allCases.firstIndex(of: b)!
        }
    }

    public let modifiers: Set<Modifier>
    public let key: String

    public var description: String { (modifiers.sorted().map(\.rawValue) + [key]).joined(separator: "+") }

    public enum ParseError: Error, Equatable {
        case empty
        case unknownToken(String)
        case noKey
        case multipleKeys
    }

    private static let modifierAliases: [String: Modifier] = [
        "cmd": .cmd, "command": .cmd, "super": .cmd, "meta": .cmd,
        "ctrl": .ctrl, "control": .ctrl,
        "opt": .opt, "option": .opt, "alt": .opt,
        "shift": .shift,
        "fn": .fn, "globe": .fn,
    ]

    private static let keyAliases: [String: String] = [
        "enter": "return", "esc": "escape", "backspace": "delete",
        "pgup": "pageup", "pgdn": "pagedown", "arrowup": "up", "arrowdown": "down",
        "arrowleft": "left", "arrowright": "right",
    ]

    /// Anything else (power, eject, media keys, …) is rejected outright.
    public static let validKeys: Set<String> = {
        var keys = Set("abcdefghijklmnopqrstuvwxyz0123456789".map { String($0) })
        keys.formUnion((1...20).map { "f\($0)" })
        keys.formUnion([
            "return", "tab", "space", "escape", "delete", "forwarddelete",
            "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
            "minus", "equal", "comma", "period", "slash", "backslash", "semicolon",
            "quote", "grave", "leftbracket", "rightbracket",
        ])
        return keys
    }()

    public init(modifiers: Set<Modifier>, key: String) {
        self.modifiers = modifiers
        self.key = key
    }

    public static func parse(_ text: String) throws -> KeyChord {
        let tokens = text.lowercased().split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
        guard !tokens.isEmpty, !tokens.allSatisfy(\.isEmpty) else { throw ParseError.empty }
        var mods = Set<Modifier>()
        var key: String?
        for raw in tokens {
            if let m = modifierAliases[raw] {
                mods.insert(m)
                continue
            }
            let k = keyAliases[raw] ?? raw
            guard validKeys.contains(k) else { throw ParseError.unknownToken(raw) }
            guard key == nil else { throw ParseError.multipleKeys }
            key = k
        }
        guard let key else { throw ParseError.noKey }
        return KeyChord(modifiers: mods, key: key)
    }
}

/// Chord allowlist (PLAN-v2 §5.3 item 4, revised 2026-09-28). A blocklist always leaks: user-defined
/// shortcuts and third-party global hotkeys (QQ/WeChat screenshot, Raycast, Alfred) fire whatever is
/// frontmost, and F-key behaviour depends on the fn-lock setting. So:
/// - no modifiers, or only ⇧: allowed (typing, navigation, return/tab/escape…), except F-keys;
/// - any ⌘/⌃/⌥/fn: allowed only when listed below; extend it when a real task needs more.
public enum ChordPolicy {
    /// The built-in allowlist in the order the settings page shows it.
    public static let builtinOrder: [KeyChord] = [
        "cmd+a", "cmd+c", "cmd+v", "cmd+x", "cmd+z", "cmd+shift+z", "cmd+f", "cmd+g",
        "cmd+w", "cmd+n", "cmd+s", "cmd+q", "cmd+delete",
        // 2026-10-14 (real use): a browser's address bar; TextEdit's plain text, a browser's closed tab back.
        "cmd+l", "cmd+shift+t",
        // 2026-10-15 (VM round 14): bold, italic, underline in an editor (the model fell back to the menu).
        "cmd+b", "cmd+i", "cmd+u",
        // 2026-10-15 (VM round 15): selecting to the line's start/end, by word, to the text's start/end; the model
        // had pressed shift+right six times in a batch instead. Selection only, no side effect.
        "cmd+shift+left", "cmd+shift+right", "cmd+shift+up", "cmd+shift+down", "opt+shift+left", "opt+shift+right",
        "opt+left", "opt+right", "opt+up", "opt+down",
        "cmd+left", "cmd+right", "cmd+up", "cmd+down",
    ].compactMap { try? KeyChord.parse($0) }  // ChordPolicyTests asserts none was dropped
    public static let allowedWithModifiers: Set<KeyChord> = Set(builtinOrder)

    /// Chords that reach past the approved window: the session, other apps, system UI (the design's "never allowed",
    /// 2026-10-16). Compiled in: the user cannot add them either, and the full-power mode refuses them too.
    public static let neverAllowed: Set<KeyChord> = Set([
        "ctrl+cmd+q",      // lock screen
        "cmd+shift+q",     // log out
        "opt+cmd+escape",  // force quit
        "cmd+space",       // Spotlight
        "ctrl+space",      // input source
        "cmd+tab",         // app switcher
        "opt+cmd+h",       // hide others
        "cmd+shift+3", "cmd+shift+4", "cmd+shift+5",  // screenshots
        "ctrl+up", "ctrl+down", "ctrl+left", "ctrl+right",  // Mission Control, spaces
        "opt+cmd+d",       // the Dock
        "ctrl+f2",         // focus the menu bar
    ].compactMap { try? KeyChord.parse($0) })

    /// Why a chord can never be allowed, by anyone: nil when it is one the lists may allow.
    public static func neverReason(for chord: KeyChord) -> String? {
        if chord.key.count > 1, chord.key.hasPrefix("f"), Int(chord.key.dropFirst()) != nil {
            return "function keys are refused (their meaning depends on system settings)"
        }
        if chord.modifiers.contains(.fn) { return "fn (globe) combinations are refused (they reach system functions)" }
        if neverAllowed.contains(chord) { return "it reaches past the approved window (system-wide shortcut)" }
        return nil
    }

    /// Nil when allowed; otherwise why it is refused. The built-in allowlist (minus what the user switched off),
    /// then the user's own chords for this app; the never-allowed ones first.
    public static func refusal(for chord: KeyChord, in bundleID: String? = nil, settings: ChordSettings = ChordSettings()) -> String? {
        if let why = neverReason(for: chord) { return why }
        if chord.modifiers.isSubset(of: [.shift]) { return nil }
        if allowedWithModifiers.contains(chord) {
            return settings.isDisabled(chord) ? "switched off in the settings" : nil
        }
        if let bundleID, settings.allows(chord, in: bundleID) { return nil }
        return "not on the chord allowlist"
    }

    /// Why a chord cannot be added as a custom one: never allowed, or built in already (switch it on instead).
    public static func addRefusal(for chord: KeyChord) -> (reason: String, detail: String)? {
        if let why = neverReason(for: chord) { return ("chord_never_allowed", why) }
        if chord.modifiers.isSubset(of: [.shift]) { return ("chord_builtin", "allowed already (no modifier, or shift only)") }
        if allowedWithModifiers.contains(chord) { return ("chord_builtin", "on the built-in list already") }
        return nil
    }
}
