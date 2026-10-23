import CoreGraphics
import Foundation
import XCTest
@testable import CURuntimeCore

struct FakeWindow {
    private static var next: UInt32 = 100
    let id: UInt32
    var rect: CGRect
    let owner: String

    init(_ rect: CGRect, _ owner: String, id: UInt32? = nil) {
        if let id { self.id = id } else { FakeWindow.next += 1; self.id = FakeWindow.next }
        self.rect = rect
        self.owner = owner
    }
}

final class FakeEnv: SystemEnvironment {
    var running: Set<String> = []
    /// Apps that come to the front when activated; anything else fails activation.
    var activatable: Set<String> = []
    /// Front-to-back.
    var windows: [FakeWindow] = []
    var frontmost: String?
    var activations: [String] = []
    var launched: [String] = []

    /// Apps that register as running only after this many runningBundleIDs() calls (a just-launched app).
    var registersAfter: [String: Int] = [:]
    var runningQueries = 0
    func runningBundleIDs() -> Set<String> {
        runningQueries += 1
        for (app, n) in registersAfter where runningQueries > n { running.insert(app) }
        return running
    }

    var pids: [String: [Int32]] = [:]
    func runningPIDs(bundleID: String) -> [Int32] { pids[bundleID] ?? (running.contains(bundleID) ? [1000] : []) }

    /// Clients by PID: every PID runs node unless set here; nil = the process has exited.
    var processes: [Int32: String?] = [:]
    func processPath(pid: Int32) -> String? { processes[pid] ?? "/usr/local/bin/node" }

    /// Display names by lowercased bundle ID, and every bundle ID whose names were asked for.
    var names: [String: [String]] = [:]
    var nameQueries: [String] = []
    func displayNames(bundleID: String) -> [String] {
        nameQueries.append(bundleID.lowercased())
        return names[bundleID.lowercased()] ?? []
    }

    func frontmostBundleID() -> String? { frontmost }

    /// P5: the screen lock as the daemon reads it (nil: unknown).
    var locked: Bool? = false
    func sessionLocked() -> Bool? { locked }

    /// P4: the clipboard. `pasteboardInterloper`: something else writes it right after our write (one more count).
    var pasteboard = PasteboardContents(items: [], bytes: 0)
    var pasteboardCount = 1
    var pasteboardUnreadable = false
    var pasteboardInterloper = false
    var pasteboardWrites: [String] = []
    var pasteboardClears = 0
    func pasteboardClear() -> Bool { pasteboardClears += 1; pasteboard = PasteboardContents(items: [], bytes: 0); return true }
    var pasteboardRestores: [PasteboardContents] = []
    /// The element ⌘V pastes into (its AXValue grows by the clipboard text), when the paste lands.
    var pasteTarget: Int?
    var pasteLands = true
    func pasteboardSnapshot(limit: Int) -> PasteboardContents? { pasteboardUnreadable ? nil : pasteboard }
    func pasteboardWrite(text: String) -> Int? {
        pasteboardWrites.append(text)
        pasteboardCount += 1
        let mine = pasteboardCount
        if pasteboardInterloper { pasteboardCount += 1 }
        return mine
    }
    func pasteboardChangeCount() -> Int { pasteboardCount }
    func pasteboardRestore(_ contents: PasteboardContents) -> Bool {
        pasteboardRestores.append(contents)
        pasteboardCount += 1
        return true
    }

    var activationMethods: [ActivationMethod] = []
    func activate(bundleID: String, timeout: TimeInterval, method: ActivationMethod) -> Bool {
        activateGate?.wait()
        activations.append(bundleID)
        activationMethods.append(method)
        guard activatable.contains(bundleID) else { return false }
        frontmost = bundleID
        return true
    }

    /// AX hit-test answers that differ from the window list: (area, owner or nil for "no answer", region).
    var axOverrides: [(area: CGRect, owner: String?, region: CGRect?)] = []
    /// Simulates an unreadable Dock: the whole display counts as covered by it.
    var overlayUnknown = false
    /// Simulates an app that does not implement the AX hit test (WeChat 4): AX answers "not implemented" everywhere,
    /// and the window list with invisible windows counted shows `invisibleTop` (else the visible list's top).
    var axNotImplemented = false
    var invisibleTop: String?
    func hitTest(at point: CGPoint) -> HitTest {
        if overlayUnknown { return HitTest(cg: "com.apple.dock", ax: nil, overlayUnknown: true) }
        let cg = windows.first { $0.rect.contains(point) }?.owner.lowercased()
        if axNotImplemented { return HitTest(cg: cg, ax: nil, axNotImplemented: true, cgWithInvisible: invisibleTop ?? cg) }
        if let o = axOverrides.first(where: { $0.area.contains(point) }) { return HitTest(cg: cg, ax: o.owner, axRegion: o.region) }
        return HitTest(cg: cg, ax: cg)
    }

    func currentWindowFrames() -> [UInt32: CGRect] { Dictionary(windows.map { ($0.id, $0.rect) }, uniquingKeysWith: { a, _ in a }) }

    /// handle -> what re-reading the element returns now (nil entry: element gone).
    var elementNow: [Int: (fingerprint: String, frame: CGRect?)] = [:]
    func refreshElement(handle: Int) -> (fingerprint: String, frame: CGRect?)? { elementNow[handle] }

    func topWindowID(at point: CGPoint) -> UInt32? { windows.first { $0.rect.contains(point) }?.id }

    var focusFails = false
    /// Simulates the system repositioning the window when it becomes main.
    var moveOnFocus: CGFloat = 0
    var focused: [CGPoint] = []
    func focusWindow(at point: CGPoint, bundleID: String) -> Bool {
        focused.append(point)
        if moveOnFocus != 0, let i = windows.firstIndex(where: { $0.rect.contains(point) }) {
            windows[i].rect = windows[i].rect.offsetBy(dx: 0, dy: moveOnFocus)
        }
        return !focusFails
    }

    var clicks: [(CGPoint, Int)] = []
    var clickButtons: [MouseButton] = []
    func click(at point: CGPoint, button: MouseButton, count: Int) -> Bool {
        clicks.append((point, count))
        clickButtons.append(button)
        return true
    }

    var scrolls: [(CGPoint, Int, Int)] = []
    func scroll(at point: CGPoint, dx: Int, dy: Int) -> Bool {
        scrolls.append((point, dx, dy))
        return true
    }

    var drags: [(CGPoint, CGPoint)] = []
    func drag(from: CGPoint, to: CGPoint) -> Bool {
        drags.append((from, to))
        return true
    }

    /// Steps posted by type(). `loseFocusAfter`: the frontmost app changes after that many steps (as when a typed
    /// Return opens another app), so shouldContinue stops the rest.
    var typed: [TypingPlan.Step] = []
    var loseFocusAfter: Int?
    func type(_ steps: [TypingPlan.Step], shouldContinue: () -> Bool) -> Int {
        var n = 0
        for step in steps {
            if let k = loseFocusAfter, n == k { frontmost = "com.example.other" }
            guard shouldContinue() else { break }
            typed.append(step)
            n += 1
        }
        return n
    }

    var pressed: [KeyChord] = []
    func press(_ chord: KeyChord) -> Bool {
        pressed.append(chord)
        if chord.description == "cmd+v", pasteLands, let target = pasteTarget, let text = pasteboardWrites.last {
            axValues[target] = (axValues[target] ?? "") + text
        }
        return true
    }

    /// AX actions per handle (default: AXPress); settable values per handle.
    var axActionsByHandle: [Int: [String]] = [:]
    var axPerformed: [(Int, String)] = []
    var axValues: [Int: String] = [:]
    var axSettable: Set<Int> = []
    var axFocused: [Int] = []
    /// act.menu: what the menu bar answers, and every call (bundle ID, path, press).
    var menuOutcome: MenuOutcome = .pressed
    var menuCalls: [(String, [String], Bool)] = []
    func menu(bundleID: String, path: [String], press: Bool) -> MenuOutcome {
        menuCalls.append((bundleID, path, press))
        return menuOutcome
    }
    func axActions(handle: Int) -> [String]? { axActionsByHandle[handle] ?? ["AXPress"] }
    func axPerform(handle: Int, action: String) -> Bool {
        axPerformed.append((handle, action))
        return axActions(handle: handle)?.contains(action) ?? false
    }
    func axSetValue(handle: Int, value: String) -> Bool {
        guard axSettable.contains(handle) else { return false }
        axValues[handle] = value.isEmpty ? value : axSetTransform?(value) ?? value
        return true
    }
    func axValueSettable(handle: Int) -> Bool { axSettable.contains(handle) }
    /// Values the app turns an AX set into (a field that reformats or rejects it); default: stored as given.
    var axSetTransform: ((String) -> String)?
    func axFocus(handle: Int) -> Bool {
        axFocused.append(handle)
        return true
    }

    /// axValue(handle:) answers from axValues, or with everything typed so far when `valueFollowsTyping`.
    var valueFollowsTyping = false
    func axValue(handle: Int) -> String? {
        if valueFollowsTyping {
            return typed.map { step -> String in
                switch step {
                case .text(let s): return s
                case .key(let k): return k.key == "return" ? "\n" : k.key == "tab" ? "\t" : ""
                }
            }.joined()
        }
        return axValues[handle]
    }

    /// Fresh window thumbnails by window id (nil: capture fails).
    var thumbsNow: [UInt32: LumaThumb] = [:]
    func windowThumb(windowID: UInt32) -> LumaThumb? { thumbsNow[windowID] }

    /// Password fields by handle; `focusedSecure`: the app's focused element is one; `secureInputOn`: system-wide.
    var secureHandles: Set<Int> = []
    var focusedSecure = false
    var secureInputOn = false
    func secureInputReason(bundleID: String, handle: Int?) -> String? {
        if secureInputOn { return "secure event input is on" }
        if let handle { return secureHandles.contains(handle) ? "the element is a password field" : nil }
        return focusedSecure ? "the focused element is a password field" : nil
    }

    /// The current input source; `selectable`: IDs selectInputSource can switch to (anything else fails).
    var inputSource: InputSourceInfo? = InputSourceInfo(id: "com.apple.keylayout.ABC", isInputMethod: false, asciiCapable: true)
    var asciiSource = "com.apple.keylayout.ABC"
    var selectable: Set<String> = ["com.apple.keylayout.ABC", "com.apple.inputmethod.SCIM.ITABC"]
    var inputSourceSelections: [String] = []
    func currentInputSource() -> InputSourceInfo? { inputSource }
    func asciiInputSourceID() -> String? { asciiSource }
    /// Called at the moment a source is selected (lets tests check the ledger was written first).
    var onInputSourceSelect: ((String) -> Void)?
    func selectInputSource(id: String) -> Bool {
        onInputSourceSelect?(id)
        inputSourceSelections.append(id)
        guard selectable.contains(id) else { return false }
        inputSource = InputSourceInfo(id: id, isInputMethod: id.contains("inputmethod"), asciiCapable: !id.contains("inputmethod"))
        return true
    }
    func debugIMEProbe(bundleID: String) -> JSONValue { ["probe": true] }
    /// nil: undetectable (the Mac implementation's answer until a method is measured reliable).
    var composing: Bool?
    func imeComposing(bundleID: String?) -> Bool? { composing }

    func launch(bundleID: String) -> Bool {
        launchGate?.wait()
        launched.append(bundleID)
        return true
    }

    var opened: [(url: URL, bundleID: String)] = []
    var openOutcome = OpenOutcome.opened
    func open(_ url: URL, bundleID: String) -> OpenOutcome {
        opened.append((url, bundleID))
        return openOutcome
    }

    var manualAXCalls: [(String, Bool)] = []
    /// Apps whose processes refuse AXManualAccessibility (native apps).
    var manualAXRefuses: Set<String> = []
    var observeRequests: [ObserveRequest] = []
    var observeResult = ObserveResult()

    /// windowPresence per bundle ID; default visible when running, else not_running.
    var presence: [String: WindowPresence] = [:]
    func windowPresence(bundleID: String) -> WindowPresence {
        presence[bundleID] ?? (running.contains(bundleID) ? .visible : .notRunning)
    }
    /// Successive AX node counts per app (last value repeats); default 10.
    var axNodeCounts: [String: [Int]] = [:]
    func countAXNodes(bundleID: String) -> Int {
        guard var seq = axNodeCounts[bundleID], let first = seq.first else { return 10 }
        if seq.count > 1 { seq.removeFirst(); axNodeCounts[bundleID] = seq }
        return first
    }

    func setManualAccessibility(bundleID: String, enabled: Bool) -> Bool {
        onManualAX?(bundleID, enabled)
        manualAXCalls.append((bundleID, enabled))
        return !manualAXRefuses.contains(bundleID)
    }

    /// Called at the moment AXManualAccessibility is changed (lets tests check the ledger was written first).
    var onManualAX: ((String, Bool) -> Void)?

    /// When set, observe / activate block until the test signals it (deterministic "stuck" calls).
    var observeGate: DispatchSemaphore?
    var activateGate: DispatchSemaphore?
    /// Holds launch(bundleID:) until signalled (a launch that outlives the watchdog).
    var launchGate: DispatchSemaphore?

    var zoomRequests: [ZoomRequest] = []
    var zoomResult = ZoomResult()
    func zoom(_ request: ZoomRequest) -> ZoomResult {
        zoomRequests.append(request)
        return zoomResult
    }

    func observe(_ request: ObserveRequest) -> ObserveResult {
        observeRequests.append(request)
        observeGate?.wait()
        var r = observeResult
        if r.zOrder.isEmpty {
            r.zOrder = windows.map { ZWindow(id: $0.id, app: $0.owner.hasPrefix("pid:") ? nil : $0.owner.lowercased(),
                                             frame: $0.rect, granted: request.apps.contains($0.owner.lowercased())) }
        }
        return r
    }
}

let fixture = "dev.dsh.bench.fixture"
let textEdit = "com.apple.TextEdit"

final class Harness {
    let env = FakeEnv()
    let audit = MemoryAudit()
    var clock = Date(timeIntervalSince1970: 1_800_000_000)
    let conn = ConnectionInfo(id: 1, peerPID: 4242, peerPath: "/usr/local/bin/node", peerPIDVersion: 7)
    private(set) var dispatcher: Dispatcher!

    let ledger: MemoryStateLedger
    let apps = FakeApps()
    let presenter = FakePresenter()
    let persistent = MemoryPersistentGrants()

    let settingsStore: MemorySettingsStore

    init(config: PolicyConfig = PolicyConfig(configGrants: true), ledger: MemoryStateLedger = MemoryStateLedger(),
         settings: MemorySettingsStore = MemorySettingsStore()) {
        self.ledger = ledger
        self.settingsStore = settings
        dispatcher = Dispatcher(grants: GrantStore(), env: env, config: config, audit: audit, ledger: ledger,
                                now: { [weak self] in self?.clock ?? Date() },
                                sleep: { [weak self] in self?.clock.addTimeInterval($0) },
                                approvals: ApprovalDeps(apps: apps, presenter: presenter, persistent: persistent),
                                settingsStore: settings)
        env.running = [fixture, textEdit.lowercased()]
        env.activatable = [fixture]
        env.windows = [FakeWindow(CGRect(x: 100, y: 100, width: 800, height: 600), fixture)]
    }

    /// act.* calls get a fresh snapshot_gen injected (observe first) unless the test passes one or turns this off,
    /// so R1-era tests keep testing their check rather than the snapshot plumbing.
    var autoSnapshot = true
    /// access.request through call() marks the task's turn first when it is not open, as the plugin does (late), so
    /// tests of other checks keep testing them. Off in the tests of the turn rule itself (TurnOwnerTests).
    var autoTurn = true
    private var openTurns: Set<String> = []

    @discardableResult
    func call(_ method: String, _ params: JSONValue = [:]) -> Result<JSONValue, RPCFailure> {
        let task = params["task_id"]?.stringValue
        if autoTurn, method == "access.request", let task, !openTurns.contains(task),
           case .success = dispatcher.handle(method: "access.turn_start", params: ["task_id": .string(task), "late": true],
                                             conn: conn) {
            openTurns.insert(task)
        }
        let out = route(method, params)
        if case .success = out, let task {
            if method == "access.turn_start" { openTurns.insert(task) }
            if method == "access.turn_end" { openTurns.remove(task) }
        }
        return out
    }

    private func route(_ method: String, _ params: JSONValue) -> Result<JSONValue, RPCFailure> {
        var params = params
        let hasTarget = params["point"] != nil || params["element_id"] != nil || params["from"] != nil
        if autoSnapshot, hasTarget, method.hasPrefix("act."), params["snapshot_gen"] == nil, let task = params["task_id"],
           case .success(let obs) = dispatcher.handle(method: "observe", params: ["task_id": task, "ocr": "off"], conn: conn),
           case .object(var o) = params {
            o["snapshot_gen"] = obs["snapshot_gen"] ?? .null
            params = .object(o)
        }
        return dispatcher.handle(method: method, params: params, conn: conn)
    }

    /// Takes a snapshot explicitly and returns its generation.
    func snapshot(_ task: String = "t1") throws -> Int {
        let out = try dispatcher.handle(method: "observe", params: ["task_id": .string(task), "ocr": "off"], conn: conn).get()
        guard case .number(let g) = out["snapshot_gen"] else { throw RPCFailure(.invalidParams, "no gen") }
        return Int(g)
    }

    @discardableResult
    func grant(_ task: String = "t1", _ apps: [String] = [fixture], source: String = "config",
               allowLaunch: Bool = false, ttl: Double? = nil) -> Result<JSONValue, RPCFailure> {
        var p: [String: JSONValue] = ["task_id": .string(task), "bundle_ids": .array(apps.map { .string($0) }),
                                      "source": .string(source), "allow_launch": .bool(allowLaunch)]
        if let ttl { p["expires_in_s"] = .number(ttl) }
        return call("grants.set", .object(p))
    }

    var lastAudit: [String: JSONValue] { audit.entries.last ?? [:] }
}

func assertDenied(_ r: Result<JSONValue, RPCFailure>, _ reason: String, in h: Harness,
                  file: StaticString = #filePath, line: UInt = #line) {
    guard case .failure(let f) = r else { return XCTFail("expected denial \(reason), got \(r)", file: file, line: line) }
    XCTAssertEqual(f.code, .denied, file: file, line: line)
    XCTAssertEqual(f.data?["reason"]?.stringValue, reason, "detail: \(f.message)", file: file, line: line)
    XCTAssertEqual(h.lastAudit["decision"], "deny", file: file, line: line)
    XCTAssertEqual(h.lastAudit["reason"]?.stringValue, reason, file: file, line: line)
}

func assertAllowed(_ r: Result<JSONValue, RPCFailure>, in h: Harness, file: StaticString = #filePath, line: UInt = #line) {
    if case .failure(let f) = r { XCTFail("expected allow, got \(f)", file: file, line: line) }
    XCTAssertEqual(h.lastAudit["decision"], "allow", file: file, line: line)
}

func screen(_ x: Double, _ y: Double) -> JSONValue { ["x": .number(x), "y": .number(y), "space": "screen"] }

/// The R1 blocklist, kept as an acceptance set for the allowlist: every one of these must be refused.
let legacyBlockedChords: [String] = [
    "cmd+space", "cmd+opt+space", "ctrl+space", "ctrl+opt+space", "ctrl+cmd+space",
    "cmd+tab", "cmd+shift+tab", "cmd+opt+escape", "cmd+opt+shift+escape",
    "ctrl+cmd+q", "cmd+shift+q", "cmd+opt+shift+q",
    "ctrl+up", "ctrl+down", "ctrl+left", "ctrl+right", "f3", "f4",
    "ctrl+1", "ctrl+2", "ctrl+3", "ctrl+4", "ctrl+5", "ctrl+6", "ctrl+7", "ctrl+8", "ctrl+9",
    "cmd+shift+3", "cmd+shift+4", "cmd+shift+5", "cmd+shift+6", "ctrl+cmd+shift+3", "ctrl+cmd+shift+4",
    "cmd+opt+d", "ctrl+f1", "ctrl+f2", "ctrl+f3", "ctrl+f7", "ctrl+f8",
    "cmd+f5", "cmd+opt+f5", "cmd+opt+8", "ctrl+cmd+opt+8",
    "fn+q", "globe+e", "fn+ctrl+f",
]

/// Installed apps by bundle ID, with names and designated requirements (nil: unsigned).
final class FakeApps: AppDirectory {
    var installed: [AppIdentity] = [
        AppIdentity(bundleID: "com.tencent.qq", name: "QQ", path: "/Applications/QQ.app"),
        AppIdentity(bundleID: fixture, name: "DSHFixture", path: "/Applications/DSHFixture.app"),
        AppIdentity(bundleID: textEdit, name: "TextEdit", path: "/System/Applications/TextEdit.app"),
        AppIdentity(bundleID: "com.apple.Terminal", name: "Terminal", path: "/System/Applications/Utilities/Terminal.app"),
        AppIdentity(bundleID: HardDeny.daemon, name: "CURuntime", path: "/Applications/CURuntime.app"),
        AppIdentity(bundleID: "com.example.notes-a", name: "Notes", path: "/Applications/Notes A.app"),
        AppIdentity(bundleID: "com.example.notes-b", name: "Notes", path: "/Applications/Notes B.app"),
    ]
    /// The requirement each app satisfies now (by path); missing = unsigned.
    var requirements: [String: String] = [
        "/Applications/QQ.app": "identifier \"com.tencent.qq\" and certificate leaf = H\"aaaa\"",
        "/Applications/DSHFixture.app": "identifier \"dev.dsh.bench.fixture\" and certificate leaf = H\"bbbb\"",
        "/System/Applications/TextEdit.app": "identifier \"com.apple.TextEdit\" and anchor apple",
    ]
    func identity(bundleID: String) -> AppIdentity? {
        installed.first { $0.bundleID.caseInsensitiveCompare(bundleID) == .orderedSame }
    }
    func identities(named name: String) -> [AppIdentity] {
        let key = name.trimmingCharacters(in: .whitespaces).lowercased()
        return installed.filter { $0.name.lowercased() == key }
    }
    func designatedRequirement(path: String) -> String? { requirements[path] }
    func satisfies(path: String, requirement: String) -> Bool { requirements[path] == requirement }
    func similarIdentities(to name: String, limit: Int) -> [AppIdentity] {
        Array(installed.filter { AppNameMatch.isSimilar($0.name, to: name) }.prefix(limit))
    }
}

/// Records each dialog; answers it right away with `answer` if set, else leaves it open for `respond`.
final class FakePresenter: ApprovalPresenter {
    var shown: [DialogRequest] = []
    var answer: DialogAnswer?
    var focus: DialogFocus? = .restored
    var windows: DialogWindows? = .untouched
    private var open: (@Sendable (DialogAnswer, DialogFocus?, DialogWindows?) -> Void)?
    func present(_ request: DialogRequest,
                 completion: @escaping @Sendable (DialogAnswer, DialogFocus?, DialogWindows?) -> Void) {
        shown.append(request)
        if let answer { completion(answer, focus, windows) } else { open = completion }
    }
    func respond(_ a: DialogAnswer) {
        open?(a, focus, windows)
        open = nil
    }
}
