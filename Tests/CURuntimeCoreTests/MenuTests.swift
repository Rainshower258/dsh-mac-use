import XCTest
@testable import CURuntimeCore

/// cu_menu (2026-10-09, after 2e): an app's menu bar over AX, full mode only; the Services submenu never; menu
/// titles (app content) reach the client but never the audit.
final class MenuTests: XCTestCase {
    private func menu(_ h: Harness, _ path: [String], task: String = "t1") -> Result<JSONValue, RPCFailure> {
        h.call("act.menu", ["task_id": .string(task), "app": .string(fixture), "path": .array(path.map { .string($0) })])
    }

    private func approve(_ h: Harness, _ mode: String) {
        h.presenter.answer = .turn
        let r = h.call("access.request", ["task_id": "t1", "app": .string(fixture), "mode": .string(mode), "interactive": true])
        _ = h.call("access.status", ["task_id": "t1", "request_id": (try? r.get())?["request_id"] ?? "none"])
    }

    func testReadModeCannotUseTheMenuFullCan() throws {
        let h = Harness()
        approve(h, "read")
        let r = menu(h, ["格式", "字体", "粗体"])
        assertDenied(r, "action_not_allowed", in: h)
        if case .failure(let f) = r { XCTAssertEqual(f.data?["needs_mode"], "full") }
        XCTAssertTrue(h.env.menuCalls.isEmpty)
        approve(h, "full")
        XCTAssertEqual(try menu(h, ["格式", "字体", "粗体"]).get()["executed"], true)
        XCTAssertEqual(h.env.menuCalls.last?.1, ["格式", "字体", "粗体"])
        XCTAssertEqual(h.lastAudit["menu"], "pressed")
        XCTAssertEqual(h.lastAudit["menu_depth"], 3)
    }

    func testServicesIsNeverReachedAndTitlesNeverReachTheAudit() throws {
        let h = Harness()
        approve(h, "full")
        for path in [["TextEdit", "服务"], ["TextEdit", " Services ", "x"]] {
            assertDenied(menu(h, path), "menu_excluded", in: h)
        }
        XCTAssertTrue(h.env.menuCalls.isEmpty)

        h.env.menuOutcome = .notFound(level: 1, available: ["SECRET-TITLE"])
        let r = menu(h, ["格式", "nope"])
        assertDenied(r, "menu_not_found", in: h)
        if case .failure(let f) = r { XCTAssertEqual(f.data?["untrusted_available"], ["SECRET-TITLE"]) }
        XCTAssertFalse(h.audit.entries.contains { "\($0)".contains("SECRET-TITLE") })

        h.env.menuOutcome = .listed([MenuItemInfo(title: "SECRET-ITEM", enabled: true, submenu: false)])
        XCTAssertEqual(try menu(h, ["格式"]).get()["untrusted_items"], [["title": "SECRET-ITEM", "enabled": true, "submenu": false]])
        XCTAssertFalse(h.audit.entries.contains { "\($0)".contains("SECRET-ITEM") })
        h.env.menuOutcome = .disabled
        assertDenied(menu(h, ["编辑", "撤销"]), "menu_item_disabled", in: h)
    }

    func testTitlesCompareLoosely() {
        XCTAssertEqual(MenuPolicy.key(" Save As... "), MenuPolicy.key("save as…"))
        XCTAssertNotNil(MenuPolicy.exclusion(title: "SERVICES"))
        XCTAssertNil(MenuPolicy.exclusion(title: "格式"))
    }
}
