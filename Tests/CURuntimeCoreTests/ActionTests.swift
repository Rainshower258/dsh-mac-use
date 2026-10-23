import CoreGraphics
import XCTest
@testable import CURuntimeCore

/// R3 action layer (PLAN-v2 §6): AX first, real events as the fallback after every §5.3 check.
final class ActionTests: XCTestCase {
    private let frame = CGRect(x: 300, y: 300, width: 40, height: 20)

    private func harness(config: PolicyConfig = PolicyConfig(configGrants: true)) -> Harness {
        let h = Harness(config: config)
        h.autoSnapshot = false
        h.grant()
        return h
    }

    /// A snapshot with one AX element (handle 7) and one OCR line.
    private func snapshot(_ h: Harness) throws -> JSONValue {
        var r = ObserveResult()
        r.elements = [ObservedElement(source: .ax, app: fixture, role: "AXButton", text: "Send", frame: frame, confidence: nil,
                                      identifier: "send", handle: 7),
                      ObservedElement(source: .ocr, app: nil, role: nil, text: "hello", frame: CGRect(x: 200, y: 200, width: 40, height: 12),
                                      confidence: 0.9, windowID: h.env.windows[0].id)]
        // The window OCR read, as a thumbnail; unchanged now unless a test edits thumbsNow.
        let w = h.env.windows[0]
        let thumb = Self.thumb(for: w.rect)
        r.windowThumbs = [w.id: WindowThumb(thumb: thumb, frame: w.rect)]
        h.env.thumbsNow[w.id] = thumb
        h.env.observeResult = r
        h.env.elementNow[7] = (Fingerprint.of(role: "AXButton", identifier: "send", text: "Send", frame: frame), frame)
        return .number(Double(try h.snapshot()))
    }

    static func thumb(for rect: CGRect, value: UInt8 = 240) -> LumaThumb {
        let w = Int((rect.width / 4).rounded(.up)), hh = Int((rect.height / 4).rounded(.up))
        return LumaThumb(width: w, height: hh, pixels: [UInt8](repeating: value, count: w * hh))
    }

    private func act(_ h: Harness, _ method: String, _ p: [String: JSONValue]) -> Result<JSONValue, RPCFailure> {
        var params: [String: JSONValue] = ["task_id": "t1", "app": .string(fixture)]
        for (k, v) in p { params[k] = v }
        return h.call(method, .object(params))
    }

    // MARK: click

    func testElementClickPressesThroughAXWithoutActivating() throws {
        let h = harness()
        let g = try snapshot(h)
        let r = act(h, "act.click", ["element_id": "a1", "snapshot_gen": g])
        assertAllowed(r, in: h)
        XCTAssertEqual(try r.get()["via"], "ax")
        XCTAssertEqual(h.env.axPerformed.map(\.1), ["AXPress"])
        XCTAssertTrue(h.env.activations.isEmpty && h.env.clicks.isEmpty, "AX needs neither activation nor events")
        XCTAssertEqual(h.lastAudit["via"], "ax")
    }

    func testAXPathStillChecksGrantHardDenyAndStaleness() throws {
        let h = harness()
        let g = try snapshot(h)
        h.env.frontmost = "com.apple.terminal"
        assertDenied(act(h, "act.click", ["element_id": "a1", "snapshot_gen": g]), "hard_denied_frontmost", in: h)
        h.env.frontmost = nil
        let moved = frame.offsetBy(dx: 5, dy: 0)
        h.env.elementNow[7] = (Fingerprint.of(role: "AXButton", identifier: "send", text: "Send", frame: moved), moved)
        assertDenied(act(h, "act.click", ["element_id": "a1", "snapshot_gen": g]), "stale_element", in: h)
        XCTAssertTrue(h.env.axPerformed.isEmpty)
        h.call("grants.revoke", ["task_id": "t1"])
        assertDenied(act(h, "act.click", ["element_id": "a1", "snapshot_gen": g]), "no_grant", in: h)
    }

    func testWithoutAXPressAutoFallsBackToEventsAndViaAXRefuses() throws {
        let h = harness()
        let g = try snapshot(h)
        h.env.axActionsByHandle[7] = ["AXShowMenu"]
        assertDenied(act(h, "act.click", ["element_id": "a1", "snapshot_gen": g, "via": "ax"]), "ax_unsupported", in: h)
        let r = act(h, "act.click", ["element_id": "a1", "snapshot_gen": g])
        assertAllowed(r, in: h)
        XCTAssertEqual(try r.get()["via"], "event")
        XCTAssertEqual(h.env.clicks.first?.0, CGPoint(x: 320, y: 310))
    }

    func testOCRElementClickIsAnEventAndViaAXIsRefused() throws {
        let h = harness()
        let g = try snapshot(h)
        assertDenied(act(h, "act.click", ["element_id": "o1", "snapshot_gen": g, "via": "ax"]), "ax_unsupported", in: h)
        assertAllowed(act(h, "act.click", ["element_id": "o1", "snapshot_gen": g]), in: h)
        XCTAssertEqual(h.env.clicks.first?.0, CGPoint(x: 220, y: 206))
    }

    /// T11: a list reordered under a still window. The OCR element's window did not move, but the text under it did.
    func testOCRElementWhoseContentChangedIsStaleAndNothingIsClicked() throws {
        let h = harness()
        let g = try snapshot(h)
        let w = h.env.windows[0]
        var now = Self.thumb(for: w.rect)
        // The element (global 200,200 40x12) is window-local (200 - x, 200 - y): paint that area dark.
        let lx = Int((200 - w.rect.minX) / 4), ly = Int((200 - w.rect.minY) / 4)
        var px = now.pixels
        for y in ly..<(ly + 3) { for x in lx..<(lx + 10) { px[y * now.width + x] = 20 } }
        now = LumaThumb(width: now.width, height: now.height, pixels: px)
        h.env.thumbsNow[w.id] = now
        assertDenied(act(h, "act.click", ["element_id": "o1", "snapshot_gen": g]), "stale_element", in: h)
        h.env.thumbsNow[w.id] = nil   // cannot be re-checked: refused too
        assertDenied(act(h, "act.click", ["element_id": "o1", "snapshot_gen": g]), "stale_element", in: h)
        XCTAssertTrue(h.env.clicks.isEmpty)
    }

    func testOCRElementElsewhereInTheWindowChangingDoesNotMatter() throws {
        let h = harness()
        let g = try snapshot(h)
        let w = h.env.windows[0]
        var px = Self.thumb(for: w.rect).pixels
        for i in 0..<20 { px[i] = 0 }   // top-left corner, far from the element
        h.env.thumbsNow[w.id] = LumaThumb(width: Self.thumb(for: w.rect).width, height: Self.thumb(for: w.rect).height, pixels: px)
        assertAllowed(act(h, "act.click", ["element_id": "o1", "snapshot_gen": g]), in: h)
    }

    func testDoubleClickIsOneEventClickWithCountTwo() throws {
        let h = harness()
        let g = try snapshot(h)
        assertAllowed(act(h, "act.click", ["element_id": "a1", "snapshot_gen": g, "count": 2]), in: h)
        XCTAssertTrue(h.env.axPerformed.isEmpty, "AX cannot double-click")
        XCTAssertEqual(h.env.clicks.map(\.1), [2])
    }

    // MARK: scroll / drag

    func testScrollDirectionsAndAmount() throws {
        let h = harness()
        let g = try snapshot(h)
        for (dir, want) in [("up", (0, 3)), ("down", (0, -3)), ("left", (3, 0)), ("right", (-3, 0))] {
            assertAllowed(act(h, "act.scroll", ["point": screen(200, 200), "direction": .string(dir), "snapshot_gen": g]), in: h)
            XCTAssertEqual(h.env.scrolls.last.map { [$0.1, $0.2] }, [want.0, want.1], dir)
        }
        guard case .failure(let f) = act(h, "act.scroll", ["point": screen(200, 200), "direction": "up", "amount": 500,
                                                           "snapshot_gen": g]) else { return XCTFail() }
        XCTAssertEqual(f.code, .invalidParams)
    }

    func testDragChecksBothEnds() throws {
        let h = harness()
        let g = try snapshot(h)
        assertAllowed(act(h, "act.drag", ["from": ["point": screen(200, 200)], "to": ["point": screen(300, 300)], "snapshot_gen": g]), in: h)
        XCTAssertEqual(h.env.drags.count, 1)
        assertDenied(act(h, "act.drag", ["from": ["point": screen(200, 200)], "to": ["point": screen(5000, 5000)], "snapshot_gen": g]),
                     "not_on_target_window", in: h)
        XCTAssertEqual(h.env.drags.count, 1)
    }

    // MARK: type / key

    func testTypingIsChunkedAndLineBreaksArePresses() throws {
        let h = harness()
        let text = "你好，世界 Hello world 这是一段超过二十个字的中英混合文本\nsecond line"
        assertAllowed(act(h, "act.type", ["text": .string(text)]), in: h)
        XCTAssertEqual(h.env.typed, TypingPlan.steps(text))
        XCTAssertTrue(h.env.typed.allSatisfy { if case .text(let s) = $0 { s.utf16.count <= 20 } else { true } })
        XCTAssertEqual(h.env.typed.compactMap { if case .text(let s) = $0 { s } else { nil } }.joined(),
                       text.replacingOccurrences(of: "\n", with: ""))
        XCTAssertEqual(h.lastAudit["text_len"], .number(Double(text.count)))
        XCTAssertFalse(String(describing: h.audit.entries).contains("Hello"), "typed text is never audited")
    }

    func testTypingStopsWhenTheTargetLosesFocusAndSaysHowFarItGot() throws {
        let h = harness()
        h.env.loseFocusAfter = 2
        let r = act(h, "act.type", ["text": "0123456789abcdefghijKLMNOPQRSTUVWXYZ\nmore"])
        assertDenied(r, "focus_lost", in: h)
        guard case .failure(let f) = r else { return XCTFail() }
        XCTAssertEqual(f.data?["steps_posted"], 2)
        XCTAssertEqual(f.data?["retry"], "outcome_unknown")
        XCTAssertEqual(f.data?["action_may_have_executed"], true)
        XCTAssertEqual(h.env.typed.count, 2)
    }

    func testTypingIntoAnElementFocusesItThroughAXAndVerifiesTheText() throws {
        let h = harness()
        let g = try snapshot(h)
        h.env.valueFollowsTyping = true
        let r = act(h, "act.type", ["text": "hi\nthere", "element_id": "a1", "snapshot_gen": g])
        assertAllowed(r, in: h)
        XCTAssertEqual(h.env.axFocused, [7])
        XCTAssertEqual(try r.get()["verified"], true)
        h.env.valueFollowsTyping = false
        h.env.axValues[7] = "ni"   // an input method swallowed it
        let g2 = try snapshot(h)
        XCTAssertEqual(try act(h, "act.type", ["text": "lost", "element_id": "a1", "snapshot_gen": g2]).get()["verified"], false)
        XCTAssertEqual(h.lastAudit["verified"], false)
        assertDenied(act(h, "act.type", ["text": "hi", "element_id": "o1", "snapshot_gen": g]), "ax_unsupported", in: h)
    }

    func testKeyChordIsPressedAfterTheChecksAndRefusedChordsNever() throws {
        let h = harness()
        assertAllowed(act(h, "act.key", ["chord": "cmd+shift+z"]), in: h)
        XCTAssertEqual(h.env.pressed.map(\.description), ["shift+cmd+z"])
        assertDenied(act(h, "act.key", ["chord": "cmd+q+w"]), "invalid_chord", in: h)
        assertDenied(act(h, "act.key", ["chord": "cmd+tab"]), "chord_not_allowed", in: h)
        XCTAssertEqual(h.env.pressed.count, 1)
    }

    // MARK: secure input

    func testNothingIsTypedIntoPasswordFields() throws {
        let h = harness()
        let g = try snapshot(h)
        h.env.secureHandles = [7]
        h.env.axSettable = [7]
        for (method, p) in [("act.type", ["text": "hunter2", "element_id": "a1", "snapshot_gen": g]),
                            ("act.set_value", ["value": "hunter2", "element_id": "a1", "snapshot_gen": g])] as [(String, [String: JSONValue])] {
            let r = act(h, method, p)
            assertDenied(r, "secure_input", in: h)
            guard case .failure(let f) = r else { return XCTFail() }
            XCTAssertEqual(f.data?["retry"], "never")
            XCTAssertTrue(f.message.contains("ask the user"))
        }
        XCTAssertTrue(h.env.typed.isEmpty && h.env.axValues.isEmpty && h.env.activations.isEmpty)
        XCTAssertFalse(String(describing: h.audit.entries).contains("hunter2"))
    }

    func testFocusedPasswordFieldOrSecureInputBlocksTypingAndKeys() {
        let h = harness()
        h.env.focusedSecure = true
        assertDenied(act(h, "act.type", ["text": "x"]), "secure_input", in: h)
        assertDenied(act(h, "act.key", ["chord": "return"]), "secure_input", in: h)
        h.env.focusedSecure = false
        h.env.secureInputOn = true
        assertDenied(act(h, "act.key", ["chord": "cmd+v"]), "secure_input", in: h)
        XCTAssertTrue(h.env.typed.isEmpty && h.env.pressed.isEmpty)
        h.env.secureInputOn = false
        assertAllowed(act(h, "act.type", ["text": "x"]), in: h)
    }

    func testClickingAPasswordFieldIsStillAllowed() throws {
        let h = harness()
        let g = try snapshot(h)
        h.env.secureHandles = [7]
        assertAllowed(act(h, "act.click", ["element_id": "a1", "snapshot_gen": g]), in: h)
    }

    // MARK: set_value / ax_action

    func testSetValueNeedsASettableAXValueAndIsNotAudited() throws {
        let h = harness()
        let g = try snapshot(h)
        assertDenied(act(h, "act.set_value", ["element_id": "a1", "value": "secret", "snapshot_gen": g]), "ax_unsupported", in: h)
        h.env.axSettable = [7]
        assertAllowed(act(h, "act.set_value", ["element_id": "a1", "value": "secret", "snapshot_gen": g]), in: h)
        XCTAssertEqual(h.env.axValues[7], "secret")
        XCTAssertFalse(String(describing: h.audit.entries).contains("secret"))
        assertDenied(act(h, "act.set_value", ["element_id": "o1", "value": "x", "snapshot_gen": g]), "ax_unsupported", in: h)
    }

    func testAXActionsAreAllowlisted() throws {
        let h = harness()
        let g = try snapshot(h)
        assertDenied(act(h, "act.ax_action", ["element_id": "a1", "action": "AXShowMenu", "snapshot_gen": g]), "ax_action_not_allowed", in: h)
        assertDenied(act(h, "act.ax_action", ["element_id": "a1", "action": "AXConfirm", "snapshot_gen": g]), "ax_unsupported", in: h)
        h.env.axActionsByHandle[7] = ["AXPress", "AXConfirm"]
        assertAllowed(act(h, "act.ax_action", ["element_id": "a1", "action": "AXConfirm", "snapshot_gen": g]), in: h)
        XCTAssertEqual(h.env.axPerformed.map(\.1), ["AXConfirm"])
    }

    // MARK: activation

    func testDebugActivateOnlyWithConfig() throws {
        let off = harness()
        assertDenied(off.call("runtime.debug_activate", ["task_id": "t1", "app": .string(fixture), "method": "ax_raise"]),
                     "debug_disabled", in: off)
        XCTAssertTrue(off.env.activations.isEmpty)
        let on = harness(config: PolicyConfig(debugActivation: true, configGrants: true))
        let r = try on.call("runtime.debug_activate", ["task_id": "t1", "app": .string(fixture), "method": "ax_raise"]).get()
        XCTAssertEqual(r["ok"], true)
        XCTAssertEqual(on.env.activationMethods, [.axRaise])
        assertDenied(on.call("runtime.debug_activate", ["task_id": "t1", "app": "com.example.ungranted", "method": "ax_raise"]),
                     "not_granted", in: on)
    }

    func testActivationMethodComesFromConfig() throws {
        let h = harness(config: PolicyConfig(activationMethod: "ax_frontmost", configGrants: true))
        assertAllowed(act(h, "act.key", ["chord": "return"]), in: h)
        XCTAssertEqual(h.env.activationMethods, [.axFrontmost])
        let d = harness()
        assertAllowed(act(d, "act.key", ["chord": "return"]), in: d)
        XCTAssertEqual(d.env.activationMethods, [Dispatcher.defaultActivationMethod])
    }
}

final class RefusalClassTests: XCTestCase {
    /// Every `Denial("reason"` in the sources has a retry class: a new refusal cannot ship unclassified.
    func testEveryRefusalInTheSourcesIsClassified() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources")
        var reasons = Set<String>()
        let files = FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil)!
        for case let url as URL in files where url.pathExtension == "swift" {
            let text = try String(contentsOf: url, encoding: .utf8)
            let rx = try NSRegularExpression(pattern: #"(?:Denial\(|Refusals\.data\(reason: )"([a-z_]+)""#)
            for m in rx.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                reasons.insert(String(text[Range(m.range(at: 1), in: text)!]))
            }
        }
        XCTAssertGreaterThan(reasons.count, 30)
        XCTAssertEqual(reasons.subtracting(Refusals.classes.keys), [], "unclassified refusal reasons")
    }

    func testRefusalDataSaysWhatWasExecutedAndHowToRetry() {
        let h = Harness()
        h.grant()
        h.env.overlayUnknown = true
        guard case .failure(let f) = h.call("act.click", ["task_id": "t1", "app": .string(fixture), "point": screen(200, 200)])
        else { return XCTFail() }
        XCTAssertEqual(f.data?["retry"], "after_delay")
        XCTAssertEqual(f.data?["executed"], false)
        XCTAssertEqual(h.lastAudit["retry"], "after_delay")
        XCTAssertEqual(Refusals.data(reason: "action_failed")["executed"], .null)
        XCTAssertEqual(Refusals.data(reason: "action_failed")["action_may_have_executed"], true)
        XCTAssertEqual(Refusals.retry(for: "something_new"), .outcomeUnknown, "unknown reasons default to the safe class")
    }
}

final class InputPlanTests: XCTestCase {
    func testChunksNeverExceedTheLimitOrSplitACharacter() {
        let text = String(repeating: "😀", count: 15) + "漢字かなabc" + String(repeating: "x", count: 30)
        let steps = TypingPlan.steps(text)
        let chunks = steps.compactMap { if case .text(let s) = $0 { s } else { nil } }
        XCTAssertTrue(chunks.allSatisfy { $0.utf16.count <= 20 })
        XCTAssertEqual(chunks.joined(), text)
    }

    func testLineBreaksAndTabsAreKeys() {
        XCTAssertEqual(TypingPlan.steps("a\nb\r\nc\td"), [
            .text("a"), .key(KeyChord(modifiers: [], key: "return")), .text("b"), .key(KeyChord(modifiers: [], key: "return")),
            .text("c"), .key(KeyChord(modifiers: [], key: "tab")), .text("d"),
        ])
        XCTAssertEqual(TypingPlan.steps(""), [])
    }

    func testEveryAcceptedKeyHasAKeyCode() {
        XCTAssertEqual(KeyChord.validKeys.subtracting(KeyCodes.keys.keys), [])
        XCTAssertEqual(Set(KeyChord.Modifier.allCases).subtracting(KeyCodes.modifiers.keys), [])
    }
}
