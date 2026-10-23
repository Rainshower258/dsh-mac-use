import AppKit
import CURuntimeCore
import SwiftUI

// MARK: - The logs page (SettingsWindow.swift; the maintainer, 2026-10-17)
//
// Where the audit log lives (changeable: the daemon moves the files), how long it is kept, a way to the folder,
// the export, what is recorded, and the recent settings changes read back from it.

struct LogsPage: View {
    @ObservedObject var model: SettingsModel
    var s: SettingsStrings { model.strings }
    private var l: LogSettings { model.snapshot?.settings.logs ?? LogSettings() }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(s.logs).font(.system(size: 24, weight: .bold))
            Text(s.logsNote).font(.system(size: 12.5)).foregroundColor(DshPalette.labelSecondary)
        }
        if let m = model.message { Text(m).font(.system(size: 12)).foregroundColor(DshPalette.danger) }
        Card(title: s.auditLog) {
            Row {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(s.logLocation).font(.system(size: 13, weight: .semibold))
                        if l.directory == nil { Chip(text: s.defaultTag, fill: DshPalette.floorChip, fg: DshPalette.floorChipText) }
                    }
                    Mono(text: model.auditDir.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                    Text(s.logLocationNote).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .trailing, spacing: 6) {
                    HStack(spacing: 8) {
                        Button(s.openLogFolder) { model.revealLog() }
                        Button(s.changeLocation) { model.chooseLogDirectory() }
                    }
                    if l.directory != nil {
                        Button(s.useDefaultLocation) { model.editLogs { $0.directory = nil } }
                    }
                }
            }
            SettingRow(title: s.retention, note: s.retentionNote) {
                Seg(options: LogSettings.retentionChoices.map { (String($0), s.days($0)) }, selected: String(l.retentionDays)) { v in
                    if let n = Int(v) { model.editLogs { $0.retentionDays = n } }
                }
            }
            Row {
                VStack(alignment: .leading, spacing: 2) {
                    Text(s.logFiles).font(.system(size: 13, weight: .semibold))
                    Text(s.fileCount(model.logFiles.count, model.logFiles.bytes)).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button(s.exportWeek) { model.exportAudit() }
            }
            SettingRow(title: s.recorded, note: s.recordedNote) {
                Chip(text: s.fixed, fill: DshPalette.floorChip, fg: DshPalette.floorChipText)
            }
        }
        Card(title: s.recentChanges) {
            if model.settingsChanges.isEmpty {
                Row { Text(s.noChanges).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary) }
            } else {
                BoundedList(maxHeight: 320) {
                    ForEach(Array(model.settingsChanges.enumerated()), id: \.offset) { _, c in
                        Row {
                            Mono(text: Self.stamp.string(from: c.at)).frame(width: 96, alignment: .leading)
                            Text(s.describe(c, appName: name(of:))).font(.system(size: 12.5)).frame(maxWidth: .infinity, alignment: .leading)
                            if c.fields["verified"] == true {
                                Chip(text: s.verifiedTag, fill: DshPalette.readChip, fg: DshPalette.readChipText)
                            }
                        }
                    }
                }
            }
        }
    }

    private static let stamp: DateFormatter = { let f = DateFormatter(); f.dateFormat = "MM-dd HH:mm"; return f }()
}
