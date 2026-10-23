import AppKit
import CURuntimeCore
import SwiftUI

// MARK: - The settings window follows dsh's appearance (PLAN-v2 P1, 2026-10-15)

/// dsh's appearance preference: the ui-theme entry's `preference` (light | dark | system; absent means system), in a
/// home's settings.yaml up to dsh 0.2.0 or a profile's cordis.patch.yml in 0.2.x (DshThemePreference.resolve). The
/// daemon serves every dsh home on this Mac, so it follows the file edited most recently among the homes it knows.
enum DshTheme {
    static let homes: [URL] = [".dsh-cu-std", ".dsh-cu-desktop", ".dsh"].map {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent($0)
    }

    /// The NSAppearance dsh's preference asks for; nil follows the system, as dsh does for `system`.
    static func appearance(for pref: DshThemePreference) -> NSAppearance? {
        switch pref {
        case .light: return NSAppearance(named: .aqua)
        case .dark: return NSAppearance(named: .darkAqua)
        case .system: return nil
        }
    }
}

/// dsh's colours: the `--dsw-alias-*` tokens of its two built-in themes (dsh-client-ui-theme, design platform
/// CSS), resolved to the static values they point at. Each colour is dynamic: it follows the window's effective
/// appearance, so one palette serves both.
enum DshPalette {
    private static func hex(_ s: String) -> NSColor {
        var v: UInt64 = 0
        Scanner(string: s.replacingOccurrences(of: "#", with: "")).scanHexInt64(&v)
        let (r, g, b, a): (UInt64, UInt64, UInt64, UInt64)
        if s.count == 9 { (r, g, b, a) = (v >> 24 & 0xff, v >> 16 & 0xff, v >> 8 & 0xff, v & 0xff) } else { (r, g, b, a) = (v >> 16 & 0xff, v >> 8 & 0xff, v & 0xff, 0xff) }
        return NSColor(srgbRed: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: CGFloat(a) / 255)
    }

    private static func dynamic(light: String, dark: String) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? hex(dark) : hex(light)
        })
    }

    // --dsw-static-neutral-bluish-*: 00 #fff, 50 #f9fafb, 75 #f1f3f5, 100 #ebeef2, 150 #e9ecf2, 200 #e1e5ee,
    // 300 #cfd3d6, 400 #adb2b8, 500 #979da6, 600 #81858c, 700 #61666b, 750 #43454a, 800 #353638, 850 #2c2c2e,
    // 875 #232324, 950 #151517, 1000 #0f1115; deepseek 400 #679efe, 500 #4176e6; red 500 #ef4444; green 500 #22c55e;
    // amber 500 #f59e0b.
    static let bgBase = dynamic(light: "#ffffff", dark: "#151517")           // alias-bg-base
    static let bgLayer1 = dynamic(light: "#ffffff", dark: "#232324")         // alias-bg-layer-1
    static let bgLayer2 = dynamic(light: "#ffffff", dark: "#2c2c2e")         // alias-bg-layer-2
    static let bgSidebar = dynamic(light: "#f9fafb", dark: "#353638")        // alias-bg-module-platform
    static let bgOverlay = dynamic(light: "#e9ecf2", dark: "#61666b")        // alias-bg-overlay
    static let borderL2 = dynamic(light: "#0000001a", dark: "#ffffff1f")     // alias-border-l2
    static let borderL3 = dynamic(light: "#0000001f", dark: "#ffffff29")     // alias-border-l3
    static let labelPrimary = dynamic(light: "#0f1115", dark: "#f9fafb")     // alias-label-primary
    static let labelSecondary = dynamic(light: "#61666b", dark: "#cfd3d6")   // alias-label-secondary
    static let labelTertiary = dynamic(light: "#81858c", dark: "#adb2b8")    // alias-label-tertiary
    static let labelCaption = dynamic(light: "#adb2b8", dark: "#81858c")     // alias-label-caption
    static let brandPrimary = dynamic(light: "#0f1115", dark: "#f9fafb")     // alias-brand-primary (primary button fill)
    static let onBrand = dynamic(light: "#ffffff", dark: "#0f1115")          // alias-label-primary-foreground
    static let ghostFill = dynamic(light: "#ebeef2", dark: "#43454a")        // alias-button-ghost-active-fill
    static let link = dynamic(light: "#4176e6", dark: "#679efe")             // alias-link
    static let danger = dynamic(light: "#ef4444", dark: "#ef4444")           // static-red-500
    static let success = dynamic(light: "#22c55e", dark: "#22c55e")          // static-green-500
    static let warning = dynamic(light: "#f59e0b", dark: "#f59e0b")          // static-amber-500
    static let readChip = dynamic(light: "#e1f0ec", dark: "#17564f")
    static let readChipText = dynamic(light: "#17564f", dark: "#cfe9e2")
    static let fullChip = dynamic(light: "#e3ebf7", dark: "#1f4282")
    static let fullChipText = dynamic(light: "#1f4282", dark: "#d6e2f7")
    static let floorChip = dynamic(light: "#e9ecf2", dark: "#43454a")
    static let floorChipText = dynamic(light: "#3a3833", dark: "#e1e5ee")
}
