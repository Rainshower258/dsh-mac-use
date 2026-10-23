import AppKit
import CURuntimeCore
import SwiftUI

// MARK: - The shortcuts page (SettingsWindow.swift, 2026-10-17)
//
// The built-in allowlist as switches (off at once, on again verified), the user's own chords (added verified,
// removed at once), the never-allowed list read-only. A chord is entered by pressing it in the recorder, or typed.

struct ShortcutsPage: View {
    @ObservedObject var model: SettingsModel
    @State private var adding = false
    var s: SettingsStrings { model.strings }
    private var chords: ChordSettings { model.snapshot?.settings.chords ?? ChordSettings() }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(s.shortcuts).font(.system(size: 24, weight: .bold))
            Text(s.shortcutsNote).font(.system(size: 12.5)).foregroundColor(DshPalette.labelSecondary)
        }
        if let m = model.message { Text(m).font(.system(size: 12)).foregroundColor(DshPalette.danger) }
        Card(title: s.builtinChords, subtitle: s.builtinChordsNote) {
            ChordFlow(strings: s, items: ChordPolicy.builtinOrder.map { c in
                let off = chords.isDisabled(c)
                return ChordFlow.Item(chord: c, label: s.chordLabel(c.description), off: off) {
                    off ? model.chordEnable(c.description) : model.chordDisable(c.description)
                }
            })
            .padding(.horizontal, 18).padding(.bottom, 14)
        }
        Card(title: s.customChords, subtitle: s.customChordsNote, trailing: AnyView(Button(s.addChord) { adding = true })) {
            if chords.custom.isEmpty {
                Row { Text(s.noneCustom).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary) }
            } else {
                BoundedList {
                    ForEach(Array(chords.custom.enumerated()), id: \.offset) { _, c in
                        Row {
                            KeyCaps(chord: c.chord).frame(width: 110, alignment: .leading)
                            Text(c.note.isEmpty ? "—" : c.note).font(.system(size: 12.5))
                                .foregroundColor(c.note.isEmpty ? DshPalette.labelTertiary : DshPalette.labelPrimary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Text(c.app.map { s.onlyIn(name(of: $0)) } ?? s.everyApp).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary)
                                .frame(width: 180, alignment: .leading)
                            Button(s.remove) { model.chordRemove(c.chord, app: c.app) }
                        }
                    }
                }
            }
        }
        .sheet(isPresented: $adding) { AddChordSheet(model: model, done: { adding = false }) }
        Card(title: s.neverChords, subtitle: s.neverChordsNote) {
            VStack(alignment: .leading, spacing: 8) {
                ChordFlow(strings: s, items: Self.neverOrder.map { c in ChordFlow.Item(chord: c, label: s.chordLabel(c.description), off: true, never: true) {} })
                HStack(spacing: 8) {
                    Chip(text: s.fKeys, fill: DshPalette.floorChip, fg: DshPalette.floorChipText)
                    Chip(text: s.fnCombos, fill: DshPalette.floorChip, fg: DshPalette.floorChipText)
                }
            }
            .padding(.horizontal, 18).padding(.bottom, 14)
        }
    }

    /// The never-allowed chords in a readable order (the set has none).
    private static let neverOrder: [KeyChord] = [
        "ctrl+cmd+q", "cmd+shift+q", "opt+cmd+escape", "cmd+space", "ctrl+space", "cmd+tab", "opt+cmd+h",
        "cmd+shift+3", "cmd+shift+4", "cmd+shift+5", "ctrl+up", "ctrl+down", "ctrl+left", "ctrl+right", "opt+cmd+d", "ctrl+f2",
    ].compactMap { try? KeyChord.parse($0) }
}

/// A chord as key caps: ⇧⌘Z, with each key on its own cap.
struct KeyCaps: View {
    let chord: String
    var struck = false

    var body: some View {
        HStack(spacing: 3) {
            ForEach(Array(Self.caps(chord).enumerated()), id: \.offset) { _, cap in
                Text(cap)
                    .font(.system(size: 12.5, weight: .medium, design: .rounded))
                    .strikethrough(struck)
                    .frame(minWidth: 24, minHeight: 24)
                    .padding(.horizontal, 5)
                    .background(DshPalette.bgLayer2)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(DshPalette.borderL3, lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
    }

    /// The modifiers (one cap) and the key (another), in the Mac's order: ⌃ ⌥ ⇧ ⌘.
    static func caps(_ text: String) -> [String] {
        guard let c = try? KeyChord.parse(text) else { return [text] }
        let mods = c.modifiers.sorted().map { m -> String in
            switch m {
            case .ctrl: return "⌃"
            case .opt: return "⌥"
            case .shift: return "⇧"
            case .cmd: return "⌘"
            case .fn: return "fn"
            }
        }.joined()
        let keys: [String: String] = ["return": "↩", "tab": "⇥", "space": "Space", "escape": "⎋", "delete": "⌫", "forwarddelete": "⌦",
                                      "up": "↑", "down": "↓", "left": "←", "right": "→", "home": "↖", "end": "↘", "pageup": "⇞", "pagedown": "⇟",
                                      "minus": "-", "equal": "=", "comma": ",", "period": ".", "slash": "/", "backslash": "\\", "semicolon": ";",
                                      "quote": "'", "grave": "`", "leftbracket": "[", "rightbracket": "]"]
        let key = keys[c.key] ?? c.key.uppercased()
        return mods.isEmpty ? [key] : [mods, key]
    }
}

/// Chords with their labels, wrapped into lines; a built-in one toggles, a never-allowed one is struck through.
struct ChordFlow: View {
    let strings: SettingsStrings
    struct Item {
        let chord: KeyChord
        let label: String?
        let off: Bool
        var never = false
        let toggle: () -> Void
    }
    let items: [Item]

    init(strings: SettingsStrings, items: [Item]) {
        self.strings = strings
        self.items = items
    }

    var body: some View {
        var width: CGFloat = 0, height: CGFloat = 0
        return GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                    cell(item)
                        .padding(.trailing, 8).padding(.bottom, 8)
                        .alignmentGuide(.leading) { d in
                            if abs(width - d.width) > geo.size.width { width = 0; height -= d.height }
                            let x = width
                            if i == items.count - 1 { width = 0 } else { width -= d.width }
                            return x
                        }
                        .alignmentGuide(.top) { _ in
                            let y = height
                            if i == items.count - 1 { height = 0 }
                            return y
                        }
                }
            }
        }
        .frame(minHeight: CGFloat((items.count / 4 + 1) * 40))
    }

    @ViewBuilder private func cell(_ item: Item) -> some View {
        if item.never {
            ChordCell(item: item, strings: nil)
        } else {
            Button(action: item.toggle) { ChordCell(item: item, strings: strings) }
                .buttonStyle(.plain)
                .help(item.off ? strings.chordOnHelp : strings.chordOffHelp)
        }
    }
}

/// One chord in the flow. A built-in switched off is unmistakable: struck through, dimmed, tagged "off"
/// (changed 2026-10-17: it read as "selected"); a toggle lights up on hover so it reads as clickable.
private struct ChordCell: View {
    let item: ChordFlow.Item
    /// Nil for the never-allowed ones (no tag, no hover).
    let strings: SettingsStrings?
    @State private var hovering = false

    var body: some View {
        let off = item.off && !item.never
        HStack(spacing: 8) {
            KeyCaps(chord: item.chord.description, struck: item.never || off)
            if let label = item.label { Text(label).font(.system(size: 12.5)).strikethrough(off) }
            if off, let s = strings { Chip(text: s.off, fill: DshPalette.warning.opacity(0.18), fg: DshPalette.warning) }
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(hovering && strings != nil ? DshPalette.ghostFill.opacity(0.6) : DshPalette.bgLayer1)
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(off ? DshPalette.warning.opacity(0.6) : DshPalette.borderL2, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .contentShape(RoundedRectangle(cornerRadius: 10))
        .opacity(off || item.never ? 0.6 : 1)
        .onHover { hovering = $0 }
    }
}

/// The add form: a recorder (press the combination), a typed alternative, the scope, a note; the daemon's own
/// rules are checked live so the error shows before the owner check.
private struct AddChordSheet: View {
    @ObservedObject var model: SettingsModel
    let done: () -> Void
    @State private var chord = ""
    @State private var oneApp = false
    @State private var app = ""
    @State private var note = ""
    @State private var busy = false
    var s: SettingsStrings { model.strings }

    private var problem: String? {
        guard !chord.isEmpty else { return nil }
        let parsed: KeyChord
        do { parsed = try KeyChord.parse(chord) } catch { return s.chordError("invalid_chord", "\(error)") }
        if let r = ChordPolicy.addRefusal(for: parsed) { return s.chordError(r.reason, r.detail) }
        return nil
    }
    private var ready: Bool { !chord.isEmpty && problem == nil && (!oneApp || !app.trimmingCharacters(in: .whitespaces).isEmpty) && !busy }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(s.addChordTitle).font(.system(size: 15, weight: .semibold))
            VStack(alignment: .leading, spacing: 6) {
                Text(s.combo).font(.system(size: 12.5, weight: .semibold))
                HStack(spacing: 10) {
                    ChordRecorder(chord: $chord, placeholder: s.comboPlaceholder).frame(width: 220, height: 32)
                    Text(s.comboManual).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary)
                    TextField("cmd+shift+k", text: $chord).textFieldStyle(.roundedBorder).frame(width: 160)
                }
                if let problem {
                    Text(problem).font(.system(size: 12)).foregroundColor(DshPalette.danger)
                } else {
                    Text(s.comboHint).font(.system(size: 11.5)).foregroundColor(DshPalette.labelTertiary)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(s.scope).font(.system(size: 12.5, weight: .semibold))
                Seg(options: [("all", s.everyApp), ("one", s.oneApp)], selected: oneApp ? "one" : "all") { oneApp = $0 == "one" }
                if oneApp {
                    HStack {
                        TextField(s.bundleID, text: $app).textFieldStyle(.roundedBorder).frame(width: 280)
                        Menu(s.runningApps) {
                            ForEach(runningAppChoices(), id: \.0) { id, name in Button("\(name) — \(id)") { app = id } }
                        }.frame(width: 160)
                        Button(s.chooseApp) { if let id = chooseAppBundleID() { app = id } }
                    }
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(s.chordNote).font(.system(size: 12.5, weight: .semibold))
                TextField(s.chordNotePlaceholder, text: $note).textFieldStyle(.roundedBorder).frame(width: 400)
            }
            HStack {
                Spacer()
                Button(s.cancel) { done() }.keyboardShortcut(.cancelAction)
                Button(s.addVerified) {
                    busy = true
                    model.chordAdd(chord, app: oneApp ? app : nil, note: note) { ok in busy = false; if ok { done() } }
                }
                .disabled(!ready)
            }
        }
        .padding(20)
        .frame(width: 620)
    }
}

/// A field that turns the combination pressed in it into the daemon's chord text (cmd+shift+k). ⌘-chords reach a
/// view as key equivalents, so both paths are taken. The fn flag is ignored: arrows and F-keys carry it on their
/// own, and fn combinations are never allowed anyway (they can still be typed).
struct ChordRecorder: NSViewRepresentable {
    @Binding var chord: String
    let placeholder: String

    func makeNSView(context: Context) -> RecorderView {
        let v = RecorderView()
        v.placeholder = placeholder
        v.onChord = { chord = $0 }
        return v
    }

    func updateNSView(_ v: RecorderView, context: Context) {
        v.shown = chord.isEmpty ? nil : KeyCaps.caps(chord).joined(separator: " ")
        v.needsDisplay = true
    }

    /// The chord text for a key event, or nil when it is not a key the daemon knows.
    static func chord(from event: NSEvent) -> String? {
        var parts: [String] = []
        let f = event.modifierFlags
        if f.contains(.control) { parts.append("ctrl") }
        if f.contains(.option) { parts.append("opt") }
        if f.contains(.shift) { parts.append("shift") }
        if f.contains(.command) { parts.append("cmd") }
        let codes: [UInt16: String] = [36: "return", 48: "tab", 49: "space", 53: "escape", 51: "delete", 117: "forwarddelete",
                                       123: "left", 124: "right", 125: "down", 126: "up", 115: "home", 119: "end", 116: "pageup", 121: "pagedown",
                                       122: "f1", 120: "f2", 99: "f3", 118: "f4", 96: "f5", 97: "f6", 98: "f7", 100: "f8", 101: "f9", 109: "f10", 103: "f11", 111: "f12"]
        let punctuation: [String: String] = ["-": "minus", "=": "equal", ",": "comma", ".": "period", "/": "slash", "\\": "backslash",
                                             ";": "semicolon", "'": "quote", "`": "grave", "[": "leftbracket", "]": "rightbracket"]
        let key: String
        if let k = codes[event.keyCode] {
            key = k
        } else if let ch = event.charactersIgnoringModifiers?.lowercased(), ch.count == 1 {
            key = punctuation[ch] ?? ch
        } else {
            return nil
        }
        guard KeyChord.validKeys.contains(key) else { return nil }
        return (parts + [key]).joined(separator: "+")
    }

    final class RecorderView: NSView {
        var onChord: ((String) -> Void)?
        var placeholder = ""
        var shown: String?

        override var acceptsFirstResponder: Bool { true }
        override func becomeFirstResponder() -> Bool { needsDisplay = true; return super.becomeFirstResponder() }
        override func resignFirstResponder() -> Bool { needsDisplay = true; return super.resignFirstResponder() }
        override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self) }

        override func keyDown(with event: NSEvent) {
            guard let c = ChordRecorder.chord(from: event) else { NSSound.beep(); return }
            onChord?(c)
        }

        override func performKeyEquivalent(with event: NSEvent) -> Bool {
            guard window?.firstResponder === self, event.type == .keyDown, let c = ChordRecorder.chord(from: event) else { return false }
            onChord?(c)
            return true
        }

        override func draw(_ dirtyRect: NSRect) {
            let focused = window?.firstResponder === self
            let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 7, yRadius: 7)
            NSColor.textBackgroundColor.setFill()
            path.fill()
            (focused ? NSColor.keyboardFocusIndicatorColor : NSColor.separatorColor).setStroke()
            path.lineWidth = focused ? 2 : 1
            path.stroke()
            let text = shown ?? placeholder
            let attrs: [NSAttributedString.Key: Any] = [
                .font: shown == nil ? NSFont.systemFont(ofSize: 12) : NSFont.systemFont(ofSize: 14, weight: .semibold),
                .foregroundColor: shown == nil ? NSColor.placeholderTextColor : NSColor.labelColor,
            ]
            let size = (text as NSString).size(withAttributes: attrs)
            (text as NSString).draw(at: NSPoint(x: 10, y: (bounds.height - size.height) / 2), withAttributes: attrs)
        }
    }
}
