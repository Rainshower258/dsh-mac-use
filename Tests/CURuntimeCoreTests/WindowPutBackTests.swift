import XCTest
@testable import CURuntimeCore

/// 2026-10-17: the approval dialog brought the settings window forward and never put it back. The
/// window's place is noted before the dialog and put back after it (WindowPutBack, applied by the Mac presenter);
/// the decision's audit line says whether it had to be.
final class WindowPutBackTests: XCTestCase {
    private let me: Int32 = 100
    private let settings = 812

    private func place(visible: Bool = true, miniaturized: Bool = false, key: Bool = false,
                       onActiveSpace: Bool = true, covering: [Int] = []) -> WindowPlace {
        WindowPlace(visible: visible, miniaturized: miniaturized, key: key, onActiveSpace: onActiveSpace, covering: covering)
    }

    private func steps(_ after: WindowPlace, _ before: WindowPlace, onScreen: Set<Int> = [1, 2, 3, 4],
                       daemonActive: Bool = true, setAside: Bool = false) -> [WindowStep] {
        WindowPutBack.steps(from: after, to: before, onScreen: onScreen, daemonActive: daemonActive, setAside: setAside)
    }

    // MARK: Reading the screen

    /// Front to back, as CGWindowList lists them: the windows in front of ours, nearest first, other apps' ordinary
    /// windows only (not the dialog, a daemon window; not the menu bar or a panel above everything).
    func testThePlaceListsOtherAppsOrdinaryWindowsInFrontNearestFirst() {
        let screen = [
            ScreenWindow(number: 50, pid: 300, layer: 25),   // the menu bar
            ScreenWindow(number: 900, pid: me, layer: 8),     // the dialog
            ScreenWindow(number: 1, pid: 200, layer: 0),      // Safari, frontmost
            ScreenWindow(number: 2, pid: 201, layer: 0),      // Terminal, directly in front of ours
            ScreenWindow(number: settings, pid: me, layer: 0),
            ScreenWindow(number: 3, pid: 200, layer: 0),      // behind ours
        ]
        let p = WindowPutBack.place(settings, visible: true, miniaturized: false, key: false, screen: screen, me: me)
        XCTAssertEqual(p, place(covering: [2, 1]))
        XCTAssertEqual(WindowPutBack.others(screen, me: me), [1, 2, 3])
    }

    /// Minimized, closed or on another Space, it is not listed: then nothing says where it is.
    func testAWindowNotListedIsNotOnTheActiveSpace() {
        let screen = [ScreenWindow(number: 1, pid: 200, layer: 0)]
        let p = WindowPutBack.place(settings, visible: false, miniaturized: true, key: false, screen: screen, me: me)
        XCTAssertEqual(p, place(visible: false, miniaturized: true, onActiveSpace: false, covering: []))
    }

    // MARK: Putting back

    /// Behind another app's window when the dialog opened, in front of everything after it closed (the 10-16 runs):
    /// back directly behind that window. Where it already is, nothing is done.
    func testAWindowThatCameForwardGoesBackBehindTheWindowThatCoveredIt() {
        XCTAssertEqual(steps(place(covering: []), place(covering: [2, 1])), [.orderBelow(2)])
        XCTAssertEqual(steps(place(covering: [1]), place(covering: [2, 1])), [.orderBelow(2)])
        // Still behind it, but another window now in between.
        XCTAssertEqual(steps(place(covering: [1, 2]), place(covering: [2, 1])), [.orderBelow(2)])
        XCTAssertEqual(steps(place(covering: [2, 1]), place(covering: [2, 1])), [])
    }

    /// Only the window directly in front counts: what the person brings forward elsewhere meanwhile changes nothing.
    func testWhatThePersonDoesElsewhereMeanwhileIsLeftAlone() {
        XCTAssertEqual(steps(place(covering: [2, 4, 1]), place(covering: [2, 1])), [])
    }

    /// The window that covered it closed meanwhile: the next one that did and is still there.
    func testAClosedCoveringWindowFallsBackToTheNextOne() {
        XCTAssertEqual(steps(place(covering: []), place(covering: [2, 1]), onScreen: [1, 3]), [.orderBelow(1)])
        XCTAssertEqual(steps(place(covering: [1]), place(covering: [2, 1]), onScreen: [1, 3]), [])
        XCTAssertEqual(steps(place(covering: []), place(covering: [2]), onScreen: [1, 3]), [])
    }

    /// In front of every other app's window before: left where it is, so it never covers what the person brought
    /// forward meanwhile.
    func testAWindowThatWasInFrontIsLeftWhereItIs() {
        XCTAssertEqual(steps(place(covering: [1]), place(covering: [])), [])
    }

    func testAMinimizedWindowIsMinimizedAgain() {
        XCTAssertEqual(steps(place(covering: []), place(visible: false, miniaturized: true, onActiveSpace: false)),
                       [.miniaturize])
        XCTAssertEqual(steps(place(visible: false, miniaturized: true, onActiveSpace: false),
                             place(visible: false, miniaturized: true, onActiveSpace: false)), [])
    }

    func testAClosedWindowIsOrderedOutAgain() {
        let closed = place(visible: false, onActiveSpace: false)
        XCTAssertEqual(steps(place(covering: []), closed), [.orderOut])
        XCTAssertEqual(steps(place(visible: false, miniaturized: true, onActiveSpace: false), closed), [.orderOut])
        XCTAssertEqual(steps(closed, closed), [])
    }

    /// Visible before, minimized after: out of the Dock, then back behind the window that covered it.
    func testAVisibleWindowThatGotMinimizedComesBackToItsPlace() {
        XCTAssertEqual(steps(place(visible: false, miniaturized: true, onActiveSpace: false), place(covering: [2])),
                       [.deminiaturize, .orderBelow(2)])
    }

    /// The person was using it: the key again while the daemon is still in front (no app to hand back to); left
    /// alone once they went to another app.
    func testTheWindowInUseGetsTheKeyBackWhileTheDaemonIsInFront() {
        XCTAssertEqual(steps(place(), place(key: true)), [.makeKey])
        XCTAssertEqual(steps(place(key: true), place(key: true)), [])
        XCTAssertEqual(steps(place(covering: [1]), place(key: true), daemonActive: false), [])
    }

    /// On another Space before, or the Space changed meanwhile: where it is there is not listed, so it stays.
    func testAWindowOnAnotherSpaceStays() {
        XCTAssertEqual(steps(place(covering: []), place(onActiveSpace: false)), [])
        XCTAssertEqual(steps(place(), place(key: true, onActiveSpace: false)), [])
        XCTAssertEqual(steps(place(onActiveSpace: false), place(covering: [2])), [])
        // Hidden with the daemon: not listed, nothing to order.
        XCTAssertEqual(steps(place(visible: false, onActiveSpace: false), place(covering: [2])), [])
    }

    // MARK: Ordered out while the dialog is open (2026-10-20)

    /// Only a window that activating the daemon would bring forward: on screen, behind another app's window. One in
    /// front already, in use, minimized, closed or on another Space stays.
    func testOnlyACoveredWindowOnScreenIsSetAside() {
        XCTAssertTrue(WindowPutBack.setsAside(place(covering: [2])))
        XCTAssertFalse(WindowPutBack.setsAside(place(covering: [])))
        XCTAssertFalse(WindowPutBack.setsAside(place(key: true, covering: [2])))
        XCTAssertFalse(WindowPutBack.setsAside(place(visible: false, miniaturized: true, onActiveSpace: false)))
        XCTAssertFalse(WindowPutBack.setsAside(place(visible: false, onActiveSpace: false)))
        XCTAssertFalse(WindowPutBack.setsAside(place(onActiveSpace: false)))
    }

    /// Set aside, it comes back in behind the window that covered it (the next one still there, if that closed), in
    /// front when none is left; ordered back in already, it is put back like any window.
    func testASetAsideWindowComesBackBehindTheWindowThatCoveredIt() {
        let out = place(visible: false, onActiveSpace: false)
        XCTAssertEqual(steps(out, place(covering: [2, 1]), setAside: true), [.orderBelow(2)])
        XCTAssertEqual(steps(out, place(covering: [2, 1]), onScreen: [1, 3], setAside: true), [.orderBelow(1)])
        XCTAssertEqual(steps(out, place(covering: [2]), onScreen: [1, 3], setAside: true), [.orderFront])
        XCTAssertEqual(steps(place(covering: [2, 1]), place(covering: [2, 1]), setAside: true), [])
        XCTAssertEqual(steps(place(covering: []), place(covering: [2, 1]), setAside: true), [.orderBelow(2)])
        // Without the mark, a window out of sight is one hidden with the daemon: left there.
        XCTAssertEqual(steps(out, place(covering: [2, 1])), [])
    }

    // MARK: The audit line

    /// What the presenter did to the settings window is in the decision's audit line, for a refusal too.
    func testTheDecisionRecordsWhatBecameOfTheSettingsWindow() throws {
        let h = Harness()
        h.presenter.windows = .restored
        let r = h.call("access.request", ["task_id": "t1", "app": .string(fixture), "mode": "read", "interactive": true])
        h.presenter.respond(.deny)
        assertDenied(h.call("access.status", ["task_id": "t1", "request_id": (try? r.get())?["request_id"] ?? "none"]),
                     "approval_rejected", in: h)
        let decision = try XCTUnwrap(h.audit.entries.last { $0["method"] == "access.decision" })
        XCTAssertEqual(decision["settings_window"], "restored")

        let h2 = Harness()
        h2.presenter.answer = .turn
        let r2 = h2.call("access.request", ["task_id": "t1", "app": .string(fixture), "mode": "read", "interactive": true])
        assertAllowed(h2.call("access.status", ["task_id": "t1", "request_id": (try? r2.get())?["request_id"] ?? "none"]),
                      in: h2)
        XCTAssertEqual(h2.audit.entries.last { $0["method"] == "access.decision" }?["settings_window"], "untouched")
    }
}
