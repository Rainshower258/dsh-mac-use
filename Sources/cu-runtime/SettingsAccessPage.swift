import CURuntimeCore
import SwiftUI

// MARK: - The modes-and-defaults page (SettingsWindow.swift; design: Access.html, batch 1, 2026-10-16)
//
// The three modes explained, then the rules the user sets (UserSettings.access). Each control applies at once when
// it tightens; a loosening choice goes through the owner check first (SettingsModel.setAccess), and the control
// shows the stored value again until the daemon has taken the change.

struct AccessPage: View {
    @ObservedObject var model: SettingsModel
    var s: SettingsStrings { model.strings }
    private var rules: AccessDefaults { model.snapshot?.settings.access ?? AccessDefaults() }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(s.access).font(.system(size: 24, weight: .bold))
            Text(s.accessNote).font(.system(size: 12.5)).foregroundColor(DshPalette.labelSecondary)
        }
        if let m = model.message { Text(m).font(.system(size: 12)).foregroundColor(DshPalette.danger) }
        HStack(alignment: .top, spacing: 14) {
            tier(Chip(text: s.read, fill: DshPalette.readChip, fg: DshPalette.readChipText), s.tierReadTitle, s.tierReadItems)
            tier(Chip(text: s.full, fill: DshPalette.fullChip, fg: DshPalette.fullChipText), s.tierFullTitle, s.tierFullItems)
            tier(Chip(text: s.fullPower, fill: DshPalette.danger.opacity(0.15), fg: DshPalette.danger), s.tierMaxTitle, s.tierMaxItems, note: s.notYet)
        }
        Card(title: s.newSessionDefault) {
            SettingRow(title: s.defaultModeTitle, note: s.defaultModeNote, lock: s.defaultModeLock) {
                Seg(options: DefaultMode.allCases.map { ($0.rawValue, s.defaultModeName($0)) } + [("max", s.fullPower)],
                    selected: rules.defaultMode.rawValue, disabled: ["max"]) { v in
                    if let m = DefaultMode(rawValue: v) { model.setAccess { $0.defaultMode = m } }
                }
            }
        }
        Card(title: s.sessionTitle) {
            SettingRow(title: s.sessionTitle, note: s.sessionNote, lock: s.sessionLock) {
                Seg(options: AccessDefaults.sessionChoices.map { (String($0), s.minutes($0)) },
                    selected: String(rules.sessionLimitMinutes)) { v in
                    if let n = Int(v) { model.setAccess { $0.sessionLimitMinutes = n } }
                }
            }
        }
        Card(title: s.dialogsTitle) {
            SettingRow(title: s.dialogsTitle, note: s.dialogsNote, lock: s.dialogsLock) {
                Seg(options: AccessDefaults.dialogChoices.map { (String($0), s.times($0)) },
                    selected: String(rules.dialogsPerTurn)) { v in
                    if let n = Int(v) { model.setAccess { $0.dialogsPerTurn = n } }
                }
            }
            SettingRow(title: s.timeoutTitle, note: s.timeoutNote) {
                Seg(options: AccessDefaults.timeoutChoices.map { (String($0), s.seconds($0)) },
                    selected: String(rules.dialogTimeoutSeconds)) { v in
                    if let n = Int(v) { model.setAccess { $0.dialogTimeoutSeconds = n } }
                }
            }
            SettingRow(title: s.defaultButtonTitle, note: s.defaultButtonNote, lock: s.defaultButtonLock) {
                Seg(options: DialogDefault.allCases.map { ($0.rawValue, s.dialogDefaultName($0)) },
                    selected: rules.dialogDefault.rawValue) { v in
                    if let d = DialogDefault(rawValue: v) { model.setAccess { $0.dialogDefault = d } }
                }
            }
        }
        Card(title: s.fixedRules) {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(s.fixedRuleItems.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .top, spacing: 6) {
                        Text("·").font(.system(size: 12.5))
                        Text(item).font(.system(size: 12.5)).foregroundColor(DshPalette.labelSecondary)
                    }
                }
            }.padding(.horizontal, 18).padding(.bottom, 14)
        }
    }

    private func tier(_ chip: Chip, _ title: String, _ items: [String], note: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            chip
            Text(title).font(.system(size: 13, weight: .semibold))
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .top, spacing: 6) {
                        Text("·").font(.system(size: 12))
                        Text(item).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary)
                    }
                }
            }
            if let note { Text(note).font(.system(size: 11.5)).foregroundColor(DshPalette.labelTertiary) }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DshPalette.bgLayer1)
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(DshPalette.borderL2, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

/// A setting with its explanation on the left and its control on the right; `lock` says which direction needs the
/// owner check.
struct SettingRow<Control: View>: View {
    let title: String
    let note: String
    var lock: String?
    @ViewBuilder let control: Control

    var body: some View {
        Row {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13, weight: .semibold))
                Text(note).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 6) {
                control
                if let lock {
                    HStack(spacing: 4) {
                        Image(systemName: "lock").font(.system(size: 10))
                        Text(lock).font(.system(size: 11))
                    }
                    .foregroundColor(DshPalette.warning)
                }
            }
        }
    }
}

/// A segmented choice drawn like the design's: the chosen value filled, a disabled one struck through.
struct Seg: View {
    let options: [(String, String)]
    let selected: String
    var disabled: Set<String> = []
    let choose: (String) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(options.enumerated()), id: \.offset) { i, o in
                let on = o.0 == selected
                let off = disabled.contains(o.0)
                Button { if !on && !off { choose(o.0) } } label: {
                    Text(o.1)
                        .font(.system(size: 12.5, weight: on ? .semibold : .regular))
                        .strikethrough(off)
                        .foregroundColor(on ? DshPalette.onBrand : off ? DshPalette.labelCaption : DshPalette.labelPrimary)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(on ? DshPalette.brandPrimary : Color.clear)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(off)
                if i < options.count - 1 { Rectangle().frame(width: 1).foregroundColor(DshPalette.borderL3) }
            }
        }
        .background(DshPalette.bgLayer2)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(DshPalette.borderL3, lineWidth: 1))
        .fixedSize()
    }
}
