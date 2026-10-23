import AppKit
import CURuntimeCore
import SwiftUI

// MARK: - The behavior-and-model page (SettingsWindow.swift, 2026-10-17)
//
// How the model operates (one field per click; coordinate targets on, a higher input-source cap and Electron AX on
// widen its reach and pass the owner check first, SettingsModel.editBehavior), and the advanced part: activation, import / export (an import lists what it loosens and is verified
// for it), the defaults.

struct BehaviorPage: View {
    @ObservedObject var model: SettingsModel
    @State private var pendingImport: (settings: UserSettings, loosened: [String])?
    @State private var confirmReset = false
    @State private var busy = false
    var s: SettingsStrings { model.strings }
    private var b: BehaviorSettings { model.snapshot?.settings.behavior ?? BehaviorSettings() }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(s.behavior).font(.system(size: 24, weight: .bold))
            Text(s.behaviorNote).font(.system(size: 12.5)).foregroundColor(DshPalette.labelSecondary)
        }
        if let m = model.message { Text(m).font(.system(size: 12)).foregroundColor(DshPalette.danger) }
        Card(title: s.operation) {
            SettingRow(title: s.restoreFocus, note: s.restoreFocusNote) {
                Switch(on: b.restoreFocusOnTurnEnd) { v in model.editBehavior { $0.restoreFocusOnTurnEnd = v } }
            }
            SettingRow(title: s.pointTargets, note: s.pointTargetsNote) {
                Switch(on: b.allowPointTargets) { v in model.editBehavior { $0.allowPointTargets = v } }
            }
            SettingRow(title: s.imePolicy, note: s.imePolicyNote) {
                Seg(options: ChangePolicy.allCases.map { ($0.rawValue, s.imePolicyName($0)) }, selected: b.imePolicyCap.rawValue) { v in
                    if let p = ChangePolicy(rawValue: v) { model.editBehavior { $0.imePolicyCap = p } }
                }
            }
            SettingRow(title: s.electronAX, note: s.electronAXNote) {
                Seg(options: [("auto", s.auto), ("off", s.offWord)], selected: b.electronAXAuto ? "auto" : "off") { v in
                    let on = v == "auto"; model.editBehavior { $0.electronAXAuto = on }
                }
            }
        }
        Card(title: s.advanced) {
            SettingRow(title: s.activation, note: s.activationNote) {
                Picker("", selection: Binding(get: { b.activationMethod ?? "" }, set: { v in
                    let m = v.isEmpty ? nil : v; model.editBehavior { $0.activationMethod = m }
                })) {
                    Text(s.activationName(nil)).tag("")
                    ForEach(ActivationMethod.allCases.filter { $0 != .runningApplication }, id: \.rawValue) { m in
                        Text(s.activationName(m)).tag(m.rawValue)
                    }
                }
                .labelsHidden().frame(width: 220)
            }
            SettingRow(title: s.importExport, note: s.importExportNote) {
                HStack(spacing: 8) {
                    Button(s.importButton) { pickImport() }
                    Button(s.exportButton) { model.exportSettings() }
                }
            }
            SettingRow(title: s.resetDefaults, note: s.resetDefaultsNote) {
                Button(s.resetButton) { confirmReset = true }
            }
        }
        .sheet(isPresented: Binding(get: { pendingImport != nil }, set: { if !$0 { pendingImport = nil } })) { importSheet }
        .alert(s.resetDefaults, isPresented: $confirmReset) {
            Button(s.resetButton.replacingOccurrences(of: "…", with: ""), role: .destructive) { reset() }
            Button(s.cancel, role: .cancel) {}
        } message: { Text(s.resetDefaultsNote) }
    }

    private func pickImport() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let new = try UserSettings.decode(try Data(contentsOf: url))
            try new.access.validate(); try new.privacy.validate(); try new.behavior.validate()
            pendingImport = (new, (model.snapshot?.settings ?? UserSettings()).loosened(by: new))
        } catch { model.message = "\(error)" }
    }

    private var importSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(s.importButton.replacingOccurrences(of: "…", with: "")).font(.system(size: 15, weight: .semibold))
            if let p = pendingImport {
                if p.loosened.isEmpty {
                    Text(s.importNothingLoosened).font(.system(size: 12.5))
                } else {
                    Text(s.importLoosens).font(.system(size: 12.5))
                    ScrollView {
                        VStack(alignment: .leading, spacing: 3) {
                            ForEach(p.loosened, id: \.self) { Mono(text: $0) }
                        }
                    }
                    .frame(maxHeight: 200)
                }
            }
            HStack {
                Spacer()
                Button(s.cancel) { pendingImport = nil }.keyboardShortcut(.cancelAction)
                Button(pendingImport?.loosened.isEmpty == false ? s.applyVerified : s.apply) {
                    guard let p = pendingImport else { return }
                    busy = true
                    model.importSettings(p.settings, loosens: !p.loosened.isEmpty, reason: s.importReason) { _ in busy = false; pendingImport = nil }
                }
                .keyboardShortcut(.defaultAction).disabled(busy)
            }
        }
        .padding(20)
        .frame(width: 520)
    }

    private func reset() {
        let current = model.snapshot?.settings ?? UserSettings()
        let new = current.resetToDefaults()
        model.importSettings(new, loosens: !current.loosened(by: new).isEmpty, reason: s.resetReason, method: "settings.reset") { _ in }
    }
}
