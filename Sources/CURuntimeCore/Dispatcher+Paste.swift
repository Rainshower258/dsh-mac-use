import Foundation

// MARK: - act.type strategy paste and the screen lock, 2026-10-16

extension Dispatcher {
    /// act.type strategy paste (2026-10-16, after the official cua-macos provider's paste): the text goes through
    /// the clipboard and ⌘V, so no input method sees it and no system state (the input source) changes. The clipboard
    /// is saved first (every type of every item, at most pasteboardLimit bytes) and put back once the app had its
    /// chance to read, unless something else wrote the clipboard meanwhile: then it is left alone and the result says
    /// `clipboard_changed`. Whether the app took the paste is not judged here beyond the field's value (an element
    /// target); the plugin tells the model to observe. The floor is the same as for typing: full mode, password
    /// fields refused, the app frontmost, no key event but ⌘V (on the chord allowlist).
    static let pasteboardLimit = 32 * 1024 * 1024
    static let pasteSettle: TimeInterval = 0.3
    func paste(_ p: TypeParams, handle: Int?, _ f: inout [String: JSONValue]) throws -> JSONValue {
        f["via"] = "paste"
        guard let saved = env.pasteboardSnapshot(limit: Self.pasteboardLimit) else {
            throw Denial("clipboard_unavailable", "the clipboard could not be read to save it, so nothing was pasted")
        }
        guard saved.bytes <= Self.pasteboardLimit else {
            throw Denial("clipboard_too_large", "the clipboard holds more than \(Self.pasteboardLimit / 1024 / 1024) MB, which "
                         + "would not be saved; nothing was pasted (strategy type still works)")
        }
        f["clipboard_saved_bytes"] = .number(Double(saved.bytes))
        guard let count = env.pasteboardWrite(text: p.text) else {
            throw Denial("clipboard_unavailable", "writing the clipboard failed; nothing was pasted")
        }
        var out: [String: JSONValue] = ["executed": true, "via": "paste", "app_reaction": "not_checked"]
        let app = p.app.lowercased()
        // Put the clipboard back if it still holds our text: "restored", "restore_failed", or "changed" (left alone).
        let restoreIfOurs = { () -> String in
            guard self.env.pasteboardChangeCount() == count else { return "changed" }
            return self.env.pasteboardRestore(saved) ? "restored" : "restore_failed"
        }
        guard env.frontmostBundleID()?.caseInsensitiveCompare(app) == .orderedSame else {
            f["clipboard"] = .string(restoreIfOurs())
            throw Denial("focus_lost", "\(p.app) is no longer frontmost; nothing was pasted", data: ["clipboard": f["clipboard"]!])
        }
        guard env.press(try KeyChord.parse("cmd+v")) else {
            f["clipboard"] = .string(restoreIfOurs())
            throw Denial("action_failed", "posting ⌘V failed", data: ["clipboard": f["clipboard"]!])
        }
        sleep(Self.pasteSettle)
        if let handle, !p.text.isEmpty {
            let arrived = env.axValue(handle: handle).map { Self.normalizedLines($0).contains(Self.normalizedLines(p.text)) }
            out["verified"] = arrived.map { .bool($0) } ?? .null
            f["verified"] = out["verified"]
        }
        let clipboard = restoreIfOurs()
        f["clipboard"] = .string(clipboard)
        if clipboard == "changed" { out["clipboard_changed"] = true }
        if clipboard == "restore_failed" { out["clipboard_restore_failed"] = true }
        return .object(out)
    }

    /// Screen lock (2026-10-16): with the screen locked nothing is observed or posted. A screenshot of the lock screen
    /// is not a current observation, and input would go to the lock screen (or, worse, the password field). Unknown
    /// (nil) is not refused: the session dictionary is missing under some launch paths, and this guards against
    /// waste, not against an adversary (locking the screen is the person's own act).
    func requireUnlocked() throws {
        if env.sessionLocked() == true {
            throw Denial("session_locked", "macOS is locked: nothing was done. Ask the user to unlock it, then observe again")
        }
    }
}
