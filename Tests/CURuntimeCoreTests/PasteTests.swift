import CoreGraphics
import XCTest
@testable import CURuntimeCore

/// act.type strategy paste (P4, 2026-10-16): the text goes through the clipboard and ⌘V, the clipboard is saved
/// first and put back, and no input method or input source is touched.
final class PasteTests: XCTestCase {
    private let frame = CGRect(x: 300, y: 300, width: 200, height: 24)
    private let old = PasteboardContents(items: [[PasteboardEntry(type: "public.utf8-plain-text", data: Data("old".utf8)),
                                                  PasteboardEntry(type: "public.rtf", data: Data("{rtf}".utf8))]], bytes: 8)

    /// A granted fixture with one AX text field (handle 7) under Pinyin, ime_policy takeover; ⌘V lands in the field.
    private func setUp() throws -> (Harness, JSONValue) {
        let h = Harness()
        h.autoSnapshot = false
        _ = try h.call("grants.set", ["task_id": "t1", "bundle_ids": .array([.string(fixture)]), "source": "config",
                                      "ime_policy": "takeover"]).get()
        h.env.inputSource = InputSourceInfo(id: "com.apple.inputmethod.SCIM.ITABC", isInputMethod: true, asciiCapable: false)
        var r = ObserveResult()
        r.elements = [ObservedElement(source: .ax, app: fixture, role: "AXTextField", text: "", frame: frame, confidence: nil,
                                      identifier: "in1", handle: 7)]
        h.env.observeResult = r
        h.env.elementNow[7] = (Fingerprint.of(role: "AXTextField", identifier: "in1", text: "", frame: frame), frame)
        h.env.axValues[7] = ""
        h.env.pasteboard = old
        h.env.pasteTarget = 7
        return (h, .number(Double(try h.snapshot())))
    }

    private func paste(_ h: Harness, _ gen: JSONValue, _ text: String, element: Bool = true) -> Result<JSONValue, RPCFailure> {
        var p: [String: JSONValue] = ["task_id": "t1", "app": .string(fixture), "text": .string(text), "snapshot_gen": gen,
                                      "strategy": "paste"]
        if element { p["element_id"] = "a1" }
        return h.call("act.type", .object(p))
    }

    func testThePasteGoesThroughTheClipboardAndPutsItBackWithoutTouchingTheInputSource() throws {
        let (h, g) = try setUp()
        let out = try paste(h, g, "你好 hello，二十个字符以上的中英混合文本").get()
        XCTAssertEqual(out["via"], "paste")
        XCTAssertEqual(out["verified"], true)
        XCTAssertEqual(out["app_reaction"], "not_checked")
        XCTAssertNil(out["clipboard_changed"])
        XCTAssertTrue(h.env.typed.isEmpty, "no Unicode key events")
        XCTAssertEqual(h.env.pressed.map(\.description), ["cmd+v"])
        XCTAssertEqual(h.env.pasteboardWrites, ["你好 hello，二十个字符以上的中英混合文本"])
        XCTAssertEqual(h.env.pasteboardRestores, [old], "the clipboard holds what it held before")
        XCTAssertTrue(h.env.inputSourceSelections.isEmpty, "no input source switch for a paste")
        XCTAssertEqual(h.lastAudit["via"], "paste")
        XCTAssertEqual(h.lastAudit["clipboard"], "restored")
        XCTAssertEqual(h.lastAudit["text_len"], .number(23))
        XCTAssertFalse(String(describing: h.lastAudit).contains("你好"), "the text itself is never audited")
    }

    func testAClipboardChangedMeanwhileIsLeftAloneAndSaid() throws {
        let (h, g) = try setUp()
        h.env.pasteboardInterloper = true
        let out = try paste(h, g, "hi").get()
        XCTAssertEqual(out["clipboard_changed"], true)
        XCTAssertEqual(h.env.pasteboardRestores, [], "not ours any more: not restored")
        XCTAssertEqual(h.lastAudit["clipboard"], "changed")
    }

    func testTextThatDidNotArriveIsReportedUnverifiedAndTheClipboardIsStillRestored() throws {
        let (h, g) = try setUp()
        h.env.pasteLands = false
        let out = try paste(h, g, "hi").get()
        XCTAssertEqual(out["verified"], false)
        XCTAssertEqual(h.env.pasteboardRestores, [old])
        // Without an element nothing can be verified.
        let bare = try paste(h, g, "hi", element: false).get()
        XCTAssertNil(bare["verified"])
    }

    func testAClipboardTooLargeToSaveOrUnreadableRefusesBeforeAnything() throws {
        let (h, g) = try setUp()
        h.env.pasteboard = PasteboardContents(items: [], bytes: Dispatcher.pasteboardLimit + 1)
        assertDenied(paste(h, g, "hi"), "clipboard_too_large", in: h)
        h.env.pasteboardUnreadable = true
        assertDenied(paste(h, g, "hi"), "clipboard_unavailable", in: h)
        XCTAssertTrue(h.env.pasteboardWrites.isEmpty && h.env.pressed.isEmpty, "nothing written, nothing pressed")
        XCTAssertEqual(Refusals.retry(for: "clipboard_too_large"), .never)
    }

    func testAPasswordFieldIsRefusedBeforeTheClipboardIsTouched() throws {
        let (h, g) = try setUp()
        h.env.secureHandles = [7]
        assertDenied(paste(h, g, "hunter2"), "secure_input", in: h)
        XCTAssertTrue(h.env.pasteboardWrites.isEmpty && h.env.pressed.isEmpty)
    }
}
