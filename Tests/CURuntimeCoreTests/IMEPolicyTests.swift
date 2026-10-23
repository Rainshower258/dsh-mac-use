import XCTest
@testable import CURuntimeCore

/// Input method policy (decided 2026-09-29): leave / ask / takeover, never switching under an uncommitted
/// composition, and the input source as one kind of SystemStateChanges (ledger first, layered restores, audit).
final class IMEPolicyTests: XCTestCase {
    private let pinyin = "com.apple.inputmethod.SCIM.ITABC"
    private let abc = "com.apple.keylayout.ABC"

    private func harness(policy: String?, source: String? = nil) -> Harness {
        let h = Harness()
        h.autoSnapshot = false
        var p: [String: JSONValue] = ["task_id": "t1", "bundle_ids": .array([.string(fixture)]), "source": "config"]
        if let policy { p["ime_policy"] = .string(policy) }
        XCTAssertNoThrow(try h.call("grants.set", .object(p)).get())
        h.env.inputSource = InputSourceInfo(id: source ?? pinyin, isInputMethod: (source ?? pinyin).contains("inputmethod"),
                                            asciiCapable: false)
        return h
    }

    private func type(_ h: Harness, _ extra: [String: JSONValue] = [:]) -> Result<JSONValue, RPCFailure> {
        var p: [String: JSONValue] = ["task_id": "t1", "app": .string(fixture), "text": "你好 hello"]
        for (k, v) in extra { p[k] = v }
        return h.call("act.type", .object(p))
    }

    private func sourceAudits(_ h: Harness) -> [String] {
        func str(_ v: JSONValue?) -> String { if case .string(let s)? = v { return s } else { return "?" } }
        return h.audit.entries.filter { $0["method"] == "system.input_source" }.map { "\(str($0["change"])) \(str($0["trigger"]))" }
    }

    func testDefaultIsLeave() throws {
        let h = harness(policy: nil)
        let out = try type(h).get()
        XCTAssertEqual(out["ime"], "left")
        XCTAssertNotNil(out["ime_warning"])
        XCTAssertEqual(out["ime_composing"], "unknown")   // the fake, like the Mac side, cannot tell
        XCTAssertTrue(h.env.inputSourceSelections.isEmpty)
        XCTAssertFalse(h.env.typed.isEmpty)
        XCTAssertTrue(h.ledger.list.isEmpty)
    }

    func testAKeyboardLayoutNeedsNothing() throws {
        let h = harness(policy: "takeover", source: abc)
        h.env.inputSource = InputSourceInfo(id: abc, isInputMethod: false, asciiCapable: true)
        XCTAssertEqual(try type(h).get()["ime"], "none")
        XCTAssertTrue(h.env.inputSourceSelections.isEmpty)
    }

    func testTakeoverSwitchesBeforeTypingAndRestoresWhenTheTaskEnds() throws {
        let h = harness(policy: "takeover")
        h.env.onInputSourceSelect = { id in
            if id == self.abc {
                XCTAssertEqual(h.ledger.list.first?.original, self.pinyin, "ledger must be written before switching")
                XCTAssertTrue(h.env.typed.isEmpty, "switch before typing")
            }
        }
        let out = try type(h).get()
        XCTAssertEqual(out["ime"], "switched")
        XCTAssertEqual(out["original_input_source"], .string(pinyin))
        XCTAssertEqual(out["restores"], "when_the_task_ends")
        XCTAssertEqual(h.env.inputSource?.id, abc)
        // A second input in the same task: already switched, no second switch.
        XCTAssertEqual(try type(h).get()["ime"], "switched")
        XCTAssertEqual(h.env.inputSourceSelections, [abc])
        h.call("grants.revoke", ["task_id": "t1"])   // turn/end
        XCTAssertEqual(h.env.inputSource?.id, pinyin)
        XCTAssertEqual(h.env.inputSourceSelections, [abc, pinyin])
        XCTAssertTrue(h.ledger.list.isEmpty)
        XCTAssertEqual(sourceAudits(h), ["select takeover", "restore no_grant_wants_it"])
    }

    func testExpiryRestoresOnTheNextRequest() throws {
        let h = harness(policy: "takeover")
        _ = try type(h).get()
        h.clock.addTimeInterval(GrantRules.defaultTTL + 1)
        h.call("runtime.ping")
        XCTAssertEqual(h.env.inputSource?.id, pinyin)
    }

    func testNeverSwitchesUnderAComposition() {
        let h = harness(policy: "takeover")
        h.env.composing = true
        let r = type(h)
        assertDenied(r, "ime_composing", in: h)
        guard case .failure(let f) = r else { return XCTFail() }
        XCTAssertEqual(f.data?["retry"], "after_observe")
        XCTAssertTrue(h.env.inputSourceSelections.isEmpty && h.env.typed.isEmpty && h.ledger.list.isEmpty)
    }

    func testLeaveTypesEvenWhileComposingButSaysSo() throws {
        let h = harness(policy: "leave")
        h.env.composing = true
        let out = try type(h).get()
        XCTAssertEqual(out["ime_composing"], true)
        XCTAssertEqual(out["ime"], "left")
    }

    func testAskNeedsAnApprovalPerCall() throws {
        let h = harness(policy: "ask")
        let r = type(h)
        assertDenied(r, "ime_switch_needs_approval", in: h)
        guard case .failure(let f) = r else { return XCTFail() }
        XCTAssertEqual(f.data?["executed"], false)
        XCTAssertTrue(h.env.typed.isEmpty && h.env.inputSourceSelections.isEmpty)
        _ = try h.call("ime.approve", ["task_id": "t1", "scope": "call"]).get()
        let out = try type(h).get()
        XCTAssertEqual(out["restores"], "after_this_input")
        // Restored right after that input; the next one needs a new approval.
        XCTAssertEqual(h.env.inputSourceSelections, [abc, pinyin])
        XCTAssertEqual(sourceAudits(h), ["select ask", "restore after_input"])
        assertDenied(type(h), "ime_switch_needs_approval", in: h)
    }

    /// "896" into TextEdit asked a person to approve a switch (2026-10-09): digits, spaces and line breaks go through
    /// an idle input method as they are. Only when it verifiably holds nothing; letters or punctuation still switch.
    func testDigitsThroughAnIdleInputMethodNeedNoSwitch() throws {
        let h = harness(policy: "ask")
        h.env.composing = false
        XCTAssertEqual(try type(h, ["text": "896 12\n"]).get()["ime"], "not_needed")
        XCTAssertTrue(h.env.inputSourceSelections.isEmpty)
        XCTAssertFalse(h.env.typed.isEmpty)
        for text in ["8.96", "896a", "12,3"] { assertDenied(type(h, ["text": .string(text)]), "ime_switch_needs_approval", in: h) }
        h.env.composing = nil  // cannot tell: switch as before
        assertDenied(type(h, ["text": "896"]), "ime_switch_needs_approval", in: h)
    }

    func testTheApprovalRefusalNamesTheInputMethod() {
        let h = harness(policy: "ask")
        h.env.inputSource = InputSourceInfo(id: pinyin, isInputMethod: true, asciiCapable: false, name: "简体拼音")
        guard case .failure(let f) = type(h) else { return XCTFail() }
        XCTAssertEqual(f.data?["input_source_name"], "简体拼音")
    }

    func testAskApprovedForTheTaskLastsUntilItEnds() throws {
        let h = harness(policy: "ask")
        _ = try h.call("ime.approve", ["task_id": "t1", "scope": "task"]).get()
        _ = try type(h).get()
        _ = try type(h).get()
        XCTAssertEqual(h.env.inputSourceSelections, [abc])
        h.call("grants.revoke", ["task_id": "t1"])
        XCTAssertEqual(h.env.inputSourceSelections, [abc, pinyin])
    }

    func testApprovalNeedsAnActiveGrantAndAValidScope() {
        let h = harness(policy: "ask")
        assertDenied(h.call("ime.approve", ["task_id": "other", "scope": "task"]), "no_grant", in: h)
        XCTAssertThrowsError(try h.call("ime.approve", ["task_id": "t1", "scope": "forever"]).get())
    }

    func testTheClientCanOnlyDowngradeToLeave() throws {
        let h = harness(policy: "takeover")
        XCTAssertEqual(try type(h, ["ime_policy": "leave"]).get()["ime"], "left")
        XCTAssertTrue(h.env.inputSourceSelections.isEmpty)
        XCTAssertThrowsError(try type(h, ["ime_policy": "takeover"]).get())
        let h2 = harness(policy: "ask")
        XCTAssertThrowsError(try type(h2, ["ime_policy": "takeover"]).get())
        XCTAssertTrue(h2.env.inputSourceSelections.isEmpty)
    }

    func testAFailedSwitchTypesNothingAndLeavesNoLedger() {
        let h = harness(policy: "takeover")
        h.env.selectable = []
        assertDenied(type(h), "ime_switch_failed", in: h)
        XCTAssertTrue(h.env.typed.isEmpty && h.ledger.list.isEmpty)
        XCTAssertEqual(sourceAudits(h), ["select takeover"])
        XCTAssertEqual(h.audit.entries.first { $0["method"] == "system.input_source" }?["ok"], false)
    }

    func testASourceTheUserChoseSinceIsLeftAlone() throws {
        let h = harness(policy: "takeover")
        _ = try type(h).get()
        h.env.inputSource = InputSourceInfo(id: "com.apple.keylayout.US", isInputMethod: false, asciiCapable: true)
        h.call("grants.revoke", ["task_id": "t1"])
        XCTAssertEqual(h.env.inputSource?.id, "com.apple.keylayout.US")
        XCTAssertEqual(h.env.inputSourceSelections, [abc])
        XCTAssertEqual(sourceAudits(h), ["select takeover", "restore_skipped no_grant_wants_it"])
        XCTAssertTrue(h.ledger.list.isEmpty)
    }

    func testShutdownRestores() throws {
        let h = harness(policy: "takeover")
        _ = try type(h).get()
        h.dispatcher.restoreAllSystemState(trigger: "signal_15")
        XCTAssertEqual(h.env.inputSource?.id, pinyin)
        XCTAssertEqual(sourceAudits(h).last, "restore signal_15")
        XCTAssertTrue(h.ledger.list.isEmpty)
    }

    func testStartupRecoveryRestoresOnlyWhatIsStillOurs() {
        let entry = StateEntry(kind: SystemStateChanges.inputSource, target: "system", original: pinyin, applied: abc, setAt: Date())
        let ledger = MemoryStateLedger([entry])
        let h = Harness(ledger: ledger)
        h.env.inputSource = InputSourceInfo(id: abc, isInputMethod: false, asciiCapable: true)
        h.dispatcher.recoverSystemState()
        XCTAssertEqual(h.env.inputSource?.id, pinyin)
        XCTAssertTrue(ledger.list.isEmpty)

        let ledger2 = MemoryStateLedger([entry])
        let h2 = Harness(ledger: ledger2)
        h2.env.inputSource = InputSourceInfo(id: "com.apple.keylayout.US", isInputMethod: false, asciiCapable: true)
        h2.dispatcher.recoverSystemState()
        XCTAssertTrue(h2.env.inputSourceSelections.isEmpty)
        XCTAssertTrue(ledger2.list.isEmpty)
    }

    func testAFailedRestoreStaysInTheLedgerForTheNextStart() throws {
        let h = harness(policy: "takeover")
        _ = try type(h).get()
        h.env.selectable = [abc]   // pinyin can no longer be selected
        h.call("grants.revoke", ["task_id": "t1"])
        XCTAssertEqual(h.ledger.list.first?.original, pinyin)
    }

    func testFocusLostStillRestoresAPerCallSwitch() throws {
        let h = harness(policy: "ask")
        _ = try h.call("ime.approve", ["task_id": "t1", "scope": "call"]).get()
        h.env.loseFocusAfter = 0
        assertDenied(type(h), "focus_lost", in: h)
        XCTAssertEqual(h.env.inputSourceSelections, [abc, pinyin])
    }

    func testGrantCarriesThePolicyAndRejectsUnknownOnes() throws {
        let h = Harness()
        let g = try h.call("grants.set", ["task_id": "t", "bundle_ids": .array([.string(fixture)]), "source": "config",
                                          "ime_policy": "ask"]).get()
        XCTAssertEqual(g["ime_policy"], "ask")
        XCTAssertEqual(h.lastAudit["ime_policy"], "ask")
        XCTAssertThrowsError(try h.call("grants.set", ["task_id": "t", "bundle_ids": .array([.string(fixture)]),
                                                       "source": "config", "ime_policy": "always"]).get())
    }
}
