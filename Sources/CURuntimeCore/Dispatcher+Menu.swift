import Foundation

// MARK: - act.menu (Menu.swift)

extension Dispatcher {
    static let menuPathLimit = 6

    func menu(_ p: MenuParams, _ f: inout [String: JSONValue]) throws -> JSONValue {
        guard p.path.count <= Self.menuPathLimit, p.path.allSatisfy({ !$0.isEmpty && $0.count <= 80 }) else {
            throw RPCFailure(.invalidParams, "path: at most \(Self.menuPathLimit) non-empty titles")
        }
        // Grant, hard-denied frontmost, activation: the app's menu bar is only the one on screen once it is in front.
        try precheck(p.taskId, p.app, targets: [], chord: nil, snapshotGen: nil, &f)
        f["menu_depth"] = .number(Double(p.path.count))  // titles are app content: counted, never audited
        if let t = p.path.first(where: { MenuPolicy.exclusion(title: $0) != nil }), let why = MenuPolicy.exclusion(title: t) {
            throw Denial("menu_excluded", why)
        }
        switch env.menu(bundleID: p.app.lowercased(), path: p.path, press: p.press ?? true) {
        case .listed(let items):
            f["menu"] = "listed"
            return ["executed": false, "untrusted_items": .array(items.map {
                ["title": .string($0.title), "enabled": .bool($0.enabled), "submenu": .bool($0.submenu)]
            })]
        case .pressed:
            f["menu"] = "pressed"
            return ["executed": true, "via": "ax"]
        case .notFound(let level, let available):
            throw Denial("menu_not_found", "no menu item with that title at level \(level + 1) of the path",
                         data: ["level": .number(Double(level)), "untrusted_available": .array(available.map { .string($0) })])
        case .ambiguous(let level):
            throw Denial("menu_not_found", "several menu items have that title at level \(level + 1) of the path")
        case .disabled:
            throw Denial("menu_item_disabled", "that menu item is disabled right now")
        case .excluded(let why):
            throw Denial("menu_excluded", why)
        case .unavailable:
            throw Denial("menu_unavailable", "\(p.app) has no menu bar over accessibility")
        }
    }
}
