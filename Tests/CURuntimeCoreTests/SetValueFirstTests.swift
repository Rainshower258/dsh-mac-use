import CoreGraphics
import XCTest
@testable import CURuntimeCore

/// act.type with an element sets the value through AX where that equals typing (2026-09-29 night): it bypasses the
/// input method and changes no system state. Otherwise, or if the value does not read back, it types.
final class SetValueFirstTests: XCTestCase {
    private let frame = CGRect(x: 300, y: 300, width: 200, height: 24)

    /// A granted fixture with one AX text field (handle 7, settable) under Pinyin, ime_policy takeover.
    private func setUp(value: String = "") throws -> (Harness, JSONValue) {
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
        h.env.axSettable = [7]
        h.env.axValues[7] = value
        return (h, .number(Double(try h.snapshot())))
    }

    private func type(_ h: Harness, _ gen: JSONValue, _ text: String, _ extra: [String: JSONValue] = [:]) -> Result<JSONValue, RPCFailure> {
        var p: [String: JSONValue] = ["task_id": "t1", "app": .string(fixture), "text": .string(text), "element_id": "a1",
                                      "snapshot_gen": gen]
        for (k, v) in extra { p[k] = v }
        return h.call("act.type", .object(p))
    }

    func testAnEmptyFieldIsSetThroughAXWithoutTouchingTheInputSource() throws {
        let (h, g) = try setUp()
        let out = try type(h, g, "你好 hello，二十个字符以上的中英混合文本").get()
        XCTAssertEqual(out["via"], "ax_value")
        XCTAssertEqual(out["verified"], true)
        XCTAssertEqual(out["app_reaction"], "not_checked")
        XCTAssertTrue(h.env.typed.isEmpty)
        XCTAssertTrue(h.env.inputSourceSelections.isEmpty, "no input source switch needed")
        XCTAssertEqual(h.lastAudit["via"], "ax_value")
        XCTAssertFalse(String(describing: h.audit.entries).contains("你好"), "the audit never holds the text")
    }

    func testLineBreaksNonEmptyFieldsAndStrategyTypeAreTyped() throws {
        for (value, text, extra) in [("", "line\nbreak", [:]), ("already", "more", [:]), ("", "x", ["strategy": JSONValue.string("type")])] {
            let (h, g) = try setUp(value: value)
            let out = try type(h, g, text, extra).get()
            XCTAssertEqual(out["via"], "event", "\(value)/\(text)")
            XCTAssertFalse(h.env.typed.isEmpty)
            XCTAssertEqual(h.env.axValues[7], value, "never set through AX")
        }
    }

    func testAValueThatDoesNotReadBackIsUndoneAndTyped() throws {
        let (h, g) = try setUp()
        h.env.axSetTransform = { $0.uppercased() }
        let out = try type(h, g, "abc").get()
        XCTAssertEqual(out["via"], "event")
        XCTAssertEqual(out["set_value_fallback"], "readback_mismatch")
        XCTAssertFalse(h.env.typed.isEmpty)
        XCTAssertEqual(h.lastAudit["set_value_fallback"], "readback_mismatch")
    }

    func testPasswordFieldsAreRefusedBeforeAnySet() throws {
        let (h, g) = try setUp()
        h.env.secureHandles = [7]
        assertDenied(type(h, g, "hunter2"), "secure_input", in: h)
        XCTAssertEqual(h.env.axValues[7], "")
    }

    func testUnknownStrategyIsInvalid() throws {
        let (h, g) = try setUp()
        XCTAssertThrowsError(try type(h, g, "x", ["strategy": "magic"]).get())
    }
}
