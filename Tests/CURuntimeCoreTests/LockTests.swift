import XCTest
@testable import CURuntimeCore

/// P5 (2026-10-16): with the screen locked nothing is observed, posted or opened; unknown lock state is not refused.
final class LockTests: XCTestCase {
    func testALockedScreenRefusesObservingActingAndOpeningBeforeAnythingHappens() throws {
        let h = Harness(config: PolicyConfig(configGrants: true))
        h.autoSnapshot = false
        h.grant()
        h.env.locked = true
        assertDenied(h.call("observe", ["task_id": "t1", "ocr": "off"]), "session_locked", in: h)
        assertDenied(h.call("act.key", ["task_id": "t1", "app": .string(fixture), "chord": "return"]), "session_locked", in: h)
        assertDenied(h.call("apps.launch", ["task_id": "t1", "app": .string(fixture)]), "session_locked", in: h)
        XCTAssertTrue(h.env.pressed.isEmpty && h.env.launched.isEmpty && h.env.activations.isEmpty, "nothing reached the screen")
        XCTAssertEqual(Refusals.retry(for: "session_locked"), .never, "the person unlocks; the plugin does not retry on its own")

        h.env.locked = nil   // unknown: not a refusal (the session dictionary is missing under some launch paths)
        assertAllowed(h.call("act.key", ["task_id": "t1", "app": .string(fixture), "chord": "return"]), in: h)
        h.env.locked = false
        assertAllowed(h.call("act.key", ["task_id": "t1", "app": .string(fixture), "chord": "return"]), in: h)
        XCTAssertEqual(h.env.pressed.count, 2)
    }
}
