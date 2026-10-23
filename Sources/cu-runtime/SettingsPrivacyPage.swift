import AppKit
import CURuntimeCore
import SwiftUI

// MARK: - The privacy-and-audit page (SettingsWindow.swift, 2026-10-17)
//
// What leaves the machine (four switches and the text-only apps), the clipboard, the audit (retention, place,
// export, the recent settings changes). A switch turned off applies at once; turned on
// again it goes through the owner check first and shows the stored value until the daemon has taken the change.

struct PrivacyPage: View {
    @ObservedObject var model: SettingsModel
    var s: SettingsStrings { model.strings }
    private var p: PrivacySettings { model.snapshot?.settings.privacy ?? PrivacySettings() }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(s.privacy).font(.system(size: 24, weight: .bold))
            Text(s.privacyNote).font(.system(size: 12.5)).foregroundColor(DshPalette.labelSecondary)
        }
        if let m = model.message { Text(m).font(.system(size: 12)).foregroundColor(DshPalette.danger) }
        sentCard
        Card(title: s.clipboard) {
            SettingRow(title: s.clearClipboard, note: s.clearClipboardNote) {
                Switch(on: p.clearClipboardOnTurnStart) { v in model.setPrivacy { $0.clearClipboardOnTurnStart = v } }
            }
        }
    }

    private var sentCard: some View {
        Card(title: s.sentContent, trailing: AnyView(
            HStack(spacing: 4) {
                Image(systemName: "lock").font(.system(size: 10))
                Text(s.sentContentLock).font(.system(size: 11))
            }.foregroundColor(DshPalette.warning)
        )) {
            SettingRow(title: s.sendScreenshots, note: s.sendScreenshotsNote) {
                Switch(on: p.sendScreenshots) { v in model.setPrivacy { $0.sendScreenshots = v } }
            }
            SettingRow(title: s.sendAXText, note: s.sendAXTextNote) {
                Switch(on: p.sendAXText) { v in model.setPrivacy { $0.sendAXText = v } }
            }
            SettingRow(title: s.sendOCR, note: s.sendOCRNote) {
                Switch(on: p.sendOCR) { v in model.setPrivacy { $0.sendOCR = v } }
            }
            SettingRow(title: s.sendZoom, note: s.sendZoomNote) {
                Switch(on: p.sendZoom) { v in model.setPrivacy { $0.sendZoom = v } }
            }
            Row {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(s.textOnlyApps).font(.system(size: 13, weight: .semibold))
                            Text(s.textOnlyAppsNote).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary)
                        }
                        Spacer()
                        Button(s.addApp) {
                            guard let id = chooseAppBundleID(), !p.isTextOnly(id) else { return }
                            model.setPrivacy { $0.textOnlyApps.append(id) }
                        }
                    }
                    if p.textOnlyApps.isEmpty {
                        Text(s.noTextOnlyApps).font(.system(size: 12)).foregroundColor(DshPalette.labelTertiary)
                    } else {
                        HStack(spacing: 8) {
                            ForEach(p.textOnlyApps, id: \.self) { id in
                                HStack(spacing: 6) {
                                    Text(name(of: id)).font(.system(size: 12.5, weight: .semibold))
                                    Mono(text: id)
                                    Button {
                                        model.setPrivacy { $0.textOnlyApps.removeAll { $0.caseInsensitiveCompare(id) == .orderedSame } }
                                    } label: { Image(systemName: "xmark").font(.system(size: 10, weight: .bold)) }
                                        .buttonStyle(.plain).help(s.remove)
                                }
                                .padding(.horizontal, 10).padding(.vertical, 5)
                                .background(DshPalette.floorChip).clipShape(Capsule())
                            }
                        }
                    }
                }
            }
        }
    }

}

/// A switch bound to a stored value: the change goes to the model, the control shows the store until it changes.
struct Switch: View {
    let on: Bool
    let set: (Bool) -> Void
    var body: some View {
        Toggle("", isOn: Binding(get: { on }, set: { set($0) })).toggleStyle(.switch).labelsHidden()
    }
}
