import Darwin
import XCTest
@testable import CURuntimeCore

/// The daemon's stop mark (StopMark): the plugin's file, in the plugin's format (plugin/src/autostart.ts stopMarkText,
/// read by stopMarkOfThisBoot), 0600, never written through a symlink, and a failure audited instead of thrown.
final class StopMarkTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("cu-stopmark-\(UUID().uuidString)")
        try StateDir.prepare(dir)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private var mark: URL { dir.appendingPathComponent("autostart-stopped.json") }

    private func mode(_ url: URL) throws -> mode_t {
        var st = stat()
        XCTAssertEqual(lstat(url.path, &st), 0)
        return st.st_mode & 0o777
    }

    /// The plugin's own boot time, `Date.now()/1000 - os.uptime()`, from a clock independent of kern.boottime that
    /// counts sleep as Node's uptime does (CLOCK_MONOTONIC on macOS keeps running while asleep; ProcessInfo's
    /// systemUptime does not, and drifts from it by the time spent asleep).
    private func uptimeBootTime() -> TimeInterval {
        var ts = timespec()
        clock_gettime(CLOCK_MONOTONIC, &ts)
        return Date().timeIntervalSince1970 - (TimeInterval(ts.tv_sec) + TimeInterval(ts.tv_nsec) / 1e9)
    }

    func testTheWrittenFileIsThePluginsMarkOfThisBoot() throws {
        let now = Date(timeIntervalSince1970: 1_792_000_000.25)
        try StopMark.write(stateDir: dir, now: now)
        XCTAssertEqual(StopMark.fileName, "autostart-stopped.json", "the plugin's STOP_MARK")
        let data = try Data(contentsOf: mark)
        let text = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertTrue(text.hasSuffix("}\n"), "one JSON object and a newline, as stopMarkText writes")
        XCTAssertEqual(text.filter { $0 == "\n" }.count, 1)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(obj.keys), ["boot", "at"])
        let boot = try XCTUnwrap(obj["boot"] as? NSNumber)
        XCTAssertFalse(CFGetTypeID(boot) == CFBooleanGetTypeID(), "a number, not a boolean")
        XCTAssertLessThan(abs(boot.doubleValue - uptimeBootTime()), 120, "within the plugin's SAME_BOOT_S: seconds, this boot")
        XCTAssertEqual(obj["at"] as? String, "2026-10-14T17:46:40.250Z", "toISOString's form: UTC, milliseconds, Z")
        XCTAssertEqual(try mode(mark), 0o600)
    }

    func testTheTextIsStopMarkTextsJSON() {
        // stopMarkText(1792000000.5, Date.UTC(2026, 9, 22, 1, 2, 3, 4)) in Node gives the same keys in the same order,
        // the same `at` and the same number (written there as 1792000000.5).
        XCTAssertEqual(StopMark.text(bootTime: 1_792_000_000.5, now: Date(timeIntervalSince1970: 1_792_630_923.004)),
                       "{\"boot\":1792000000.500,\"at\":\"2026-10-22T01:02:03.004Z\"}\n")
    }

    func testAnExistingFileIsReplacedAndMade0600() throws {
        XCTAssertTrue(FileManager.default.createFile(atPath: mark.path, contents: Data(String(repeating: "x", count: 500).utf8),
                                                     attributes: [.posixPermissions: 0o644]))
        try StopMark.write(stateDir: dir)
        XCTAssertEqual(try mode(mark), 0o600)
        let text = try String(contentsOf: mark, encoding: .utf8)
        XCTAssertTrue(text.hasPrefix("{\"boot\":") && !text.contains("x"), "truncated, not written over the old bytes")
    }

    func testASymlinkAtThePathIsNotFollowed() throws {
        let elsewhere = FileManager.default.temporaryDirectory.appendingPathComponent("cu-stopmark-target-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: elsewhere) }
        try Data("keep".utf8).write(to: elsewhere)
        try FileManager.default.createSymbolicLink(at: mark, withDestinationURL: elsewhere)

        XCTAssertThrowsError(try StopMark.write(stateDir: dir)) { error in
            XCTAssertEqual(error as? StopMark.Failure, .open(self.mark.path, ELOOP))
        }
        XCTAssertEqual(try String(contentsOf: elsewhere, encoding: .utf8), "keep", "nothing written through the link")

        let audit = MemoryAudit()
        StopMark.leave(stateDir: dir, audit: audit, trigger: "signal_15")   // must not throw: the stop goes on
        XCTAssertEqual(try String(contentsOf: elsewhere, encoding: .utf8), "keep")
        let entry = try XCTUnwrap(audit.entries.first)
        XCTAssertEqual(audit.entries.count, 1)
        XCTAssertEqual(entry["method"], .string("runtime.stop_mark"))
        XCTAssertEqual(entry["decision"], .string("error"))
        XCTAssertEqual(entry["trigger"], .string("signal_15"))
    }

    func testLeaveWritesTheMarkAndAuditsNothingWhenItWorks() throws {
        let audit = MemoryAudit()
        StopMark.leave(stateDir: dir, audit: audit, trigger: "settings_stop")
        XCTAssertTrue(audit.entries.isEmpty)
        XCTAssertEqual(try mode(mark), 0o600)
    }

    func testAMissingStateDirIsAuditedNotThrown() throws {
        let audit = MemoryAudit()
        StopMark.leave(stateDir: dir.appendingPathComponent("gone"), audit: audit, trigger: "signal_2")
        XCTAssertEqual(audit.entries.first?["decision"], .string("error"))
    }

    func testTheBootTimeIsKernBoottimeInSeconds() throws {
        let boot = try XCTUnwrap(StopMark.bootTime())
        XCTAssertLessThan(abs(boot - uptimeBootTime()), 120)
    }
}
