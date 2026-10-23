import AppKit
import CURuntimeCore
import SwiftUI

// MARK: - The app lists page (SettingsWindow.swift): always allowed, the deny list, the system floor

struct AppsPage: View {
    @ObservedObject var model: SettingsModel
    @State private var adding = false
    @State private var newID = ""
    @State private var newNote = ""
    /// The always-list sheet: the app chosen in the open panel (the panel comes first), then its mode.
    @State private var addingAlways = false
    @State private var alwaysID = ""
    @State private var alwaysMode: AppMode = .read
    @State private var alwaysBusy = false
    var s: SettingsStrings { model.strings }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(s.apps).font(.system(size: 24, weight: .bold))
            Text(s.appsNote).font(.system(size: 12.5)).foregroundColor(DshPalette.labelSecondary)
        }
        if let m = model.message { Text(m).font(.system(size: 12)).foregroundColor(DshPalette.danger) }
        Card(title: s.always, subtitle: s.alwaysNote, trailing: AnyView(
            Button(s.addToAlways) {
                guard let id = chooseAppBundleID() else { return }
                alwaysID = id; alwaysMode = .read; addingAlways = true
            }
        )) {
            if let snap = model.snapshot, !snap.persistent.isEmpty {
                BoundedList {
                    ForEach(snap.persistent, id: \.bundleId) { e in
                        Row {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(name(of: e.bundleId)).font(.system(size: 13, weight: .semibold))
                                Mono(text: e.bundleId)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            (e.appMode == .full ? Chip(text: s.full, fill: DshPalette.fullChip, fg: DshPalette.fullChipText)
                                : Chip(text: s.read, fill: DshPalette.readChip, fg: DshPalette.readChipText)).frame(width: 90, alignment: .leading)
                            signature(snap.persistentValid[e.bundleId.lowercased()]).frame(width: 150, alignment: .leading)
                            Text(Self.day.string(from: Date(timeIntervalSince1970: e.addedAt))).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary).frame(width: 120, alignment: .leading)
                            if snap.persistentValid[e.bundleId.lowercased()] == false {
                                Button(s.reapprove) { model.reapprovePersistent(e.bundleId) }
                            }
                            Menu(s.changeMode) {
                                Button(s.read) { model.setPersistentMode(e.bundleId, .read) }.disabled(e.appMode == .read)
                                Button(s.full) { model.setPersistentMode(e.bundleId, .full) }.disabled(e.appMode == .full)
                            }.frame(width: 96)
                            Button(s.remove) { model.revokePersistent(e.bundleId) }
                        }
                    }
                }
            } else {
                Row { Text(s.noneAlways).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary) }
            }
        }
        Card(title: s.denylist, subtitle: s.denylistNote, trailing: AnyView(
            Button(s.addToDenylist) { newID = ""; newNote = ""; adding = true }
        )) {
            if let list = model.snapshot?.settings.denylist, !list.isEmpty {
                BoundedList {
                    ForEach(list, id: \.bundleId) { e in
                        Row {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(name(of: e.bundleId)).font(.system(size: 13, weight: .semibold))
                                Mono(text: e.bundleId)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            Text(e.note.isEmpty ? "—" : e.note).font(.system(size: 12)).foregroundColor(e.note.isEmpty ? DshPalette.labelTertiary : DshPalette.labelPrimary).frame(width: 220, alignment: .leading)
                            Text(Self.day.string(from: Date(timeIntervalSince1970: e.addedAt))).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary).frame(width: 120, alignment: .leading)
                            Button(s.removeFromDenylist) { model.denylistRemove(e.bundleId) }
                        }
                    }
                }
            } else {
                Row { Text(s.noneDenied).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary) }
            }
        }
        .sheet(isPresented: $adding) { addSheet }
        .sheet(isPresented: $addingAlways) { addAlwaysSheet }
        Card(title: s.floor, subtitle: s.floorNote, trailing: AnyView(
            Text("\(model.snapshot?.hardDeny.count ?? 0) \(s.items)").font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary)
        )) {
            if let floor = model.snapshot?.hardDeny {
                ForEach(HardDeny.Category.allCases, id: \.self) { c in
                    let items = floor.filter { $0.category == c }
                    if !items.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(s.category(c)).font(.system(size: 12.5, weight: .semibold))
                            FlowChips(items: items.map { floorName($0) })
                        }
                        .padding(.horizontal, 18).padding(.vertical, 10)
                        .overlay(Rectangle().frame(height: 1).foregroundColor(DshPalette.borderL2), alignment: .top)
                    }
                }
                Spacer().frame(height: 6)
            }
        }
    }

    /// A floor entry's name: the installed app's, else (namespaces, apps not installed here) the bundle ID or prefix.
    private func floorName(_ e: HardDeny.Entry) -> String {
        let n = name(of: e.bundleID)
        return n == e.bundleID && HardDeny.namespaces.contains { $0.bundleID == e.bundleID } ? "\(e.bundleID).*" : n
    }

    private static let day: DateFormatter = { let f = DateFormatter(); f.dateStyle = .medium; f.timeStyle = .short; return f }()

    /// The signature column: matches, changed (the entry is void and goes at its next use), or unknown (no
    /// app directory, tests only).
    @ViewBuilder private func signature(_ valid: Bool?) -> some View {
        switch valid {
        case true: Text(s.signatureOK).font(.system(size: 12, weight: .semibold)).foregroundColor(DshPalette.success)
        case false: Chip(text: s.signatureChanged, fill: DshPalette.warning.opacity(0.18), fg: DshPalette.warning)
        case nil: Text("—").font(.system(size: 12)).foregroundColor(DshPalette.labelTertiary)
        }
    }

    private var addAlwaysSheet: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(s.addToAlways).font(.system(size: 15, weight: .semibold))
            HStack(spacing: 12) {
                if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: alwaysID) {
                    Image(nsImage: NSWorkspace.shared.icon(forFile: url.path)).resizable().frame(width: 40, height: 40)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(name(of: alwaysID)).font(.system(size: 14, weight: .semibold))
                    Mono(text: alwaysID)
                }
                Spacer()
                Button(s.chooseApp) { if let id = chooseAppBundleID() { alwaysID = id } }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(s.mode).font(.system(size: 12.5, weight: .semibold))
                Seg(options: [("read", s.read), ("full", s.full)], selected: alwaysMode.rawValue) { alwaysMode = $0 == "full" ? .full : .read }
            }
            Text(s.addToAlwaysNote).font(.system(size: 12)).foregroundColor(DshPalette.labelSecondary)
            HStack {
                Spacer()
                Button(s.cancel) { addingAlways = false }.keyboardShortcut(.cancelAction)
                Button(s.addVerified) {
                    alwaysBusy = true
                    model.persistentAdd(alwaysID, alwaysMode) { ok in alwaysBusy = false; if ok { addingAlways = false } }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(alwaysBusy || alwaysID.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 520)
    }

    private var addSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(s.addToDenylist).font(.system(size: 15, weight: .semibold))
            HStack {
                TextField(s.bundleID, text: $newID).textFieldStyle(.roundedBorder).frame(width: 320)
                Menu(s.runningApps) {
                    ForEach(runningAppChoices(), id: \.0) { id, name in Button("\(name) — \(id)") { newID = id } }
                }.frame(width: 160)
                Button(s.chooseApp) { if let id = chooseAppBundleID() { newID = id } }
            }
            TextField(s.note, text: $newNote).textFieldStyle(.roundedBorder).frame(width: 500)
            HStack {
                Spacer()
                Button(s.cancel) { adding = false }.keyboardShortcut(.cancelAction)
                Button(s.add) { model.denylistAdd(newID, note: newNote); adding = false }
                    .keyboardShortcut(.defaultAction).disabled(newID.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(20)
    }

}

/// Chips wrapped into lines (the system floor).
struct FlowChips: View {
    let items: [String]
    var body: some View {
        var width: CGFloat = 0, height: CGFloat = 0
        return GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    Chip(text: item, fill: DshPalette.floorChip, fg: DshPalette.floorChipText)
                        .padding(.trailing, 6).padding(.bottom, 6)
                        .alignmentGuide(.leading) { d in
                            if abs(width - d.width) > geo.size.width { width = 0; height -= d.height }
                            let x = width
                            if item == items.last { width = 0 } else { width -= d.width }
                            return x
                        }
                        .alignmentGuide(.top) { _ in
                            let y = height
                            if item == items.last { height = 0 }
                            return y
                        }
                }
            }
        }
        .frame(minHeight: CGFloat((items.count / 5 + 1) * 28))
    }
}
