import Darwin
import Foundation

/// The daemon's own stop mark: the same file the plugin leaves (plugin/src/autostart.ts STOP_MARK, stopMarkText), in
/// the same format, so the plugin's autoStart does not open the daemon again after the person stopped it on purpose,
/// whether or not a tools client was connected at that moment (the daemon closes idle connections after 300 s, and a
/// client that is not connected leaves no mark).
///
/// Left on SIGTERM and SIGINT (pkill, the plugin page's stop, restart and install, uninstall.sh) before the daemon
/// exits, and by the settings window's stop and stop-and-revoke (not by its restart, which opens the app again at
/// once). A force quit (SIGKILL) cannot be caught: then only the plugin's own mark, left by a connected client, holds.
/// The plugin reads the mark and clears it on its next connection; nothing here reads or removes it.
///
/// The content is `{"boot":<this boot's start, epoch seconds>,"at":"<ISO 8601 time, UTC, milliseconds>"}` and a
/// newline, mode 0600. The plugin counts it as this boot's stop when its boot time is within SAME_BOOT_S (120 s) of
/// its own (`Date.now()/1000 - os.uptime()`, which on macOS is kern.boottime to the second); after a restart it is
/// stale, so the first use after a reboot starts the daemon again.
public enum StopMark {
    /// The plugin's STOP_MARK: the file's name in the daemon's state dir.
    public static let fileName = "autostart-stopped.json"

    public enum Failure: Error, Equatable, CustomStringConvertible {
        /// sysctl kern.boottime failed (errno).
        case bootTime(Int32)
        /// The file could not be opened (a symlink at the path among the causes: ELOOP) or written (path, errno).
        case open(String, Int32)
        case write(String, Int32)

        public var description: String {
            switch self {
            case .bootTime(let e): return "kern.boottime: \(String(cString: strerror(e)))"
            case .open(let p, let e): return "\(p): \(String(cString: strerror(e)))"
            case .write(let p, let e): return "write \(p): \(String(cString: strerror(e)))"
            }
        }
    }

    /// This boot's start in seconds since the epoch (sysctl kern.boottime, microseconds kept); nil when it fails.
    public static func bootTime() -> TimeInterval? {
        var tv = timeval()
        var size = MemoryLayout<timeval>.size
        var mib: [Int32] = [CTL_KERN, KERN_BOOTTIME]
        guard sysctl(&mib, u_int(mib.count), &tv, &size, nil, 0) == 0 else { return nil }
        return TimeInterval(tv.tv_sec) + TimeInterval(tv.tv_usec) / 1_000_000
    }

    /// The mark's text, the plugin's stopMarkText's JSON: the keys in its order, boot in seconds (three decimals, where
    /// JavaScript writes the number's shortest form), `at` as toISOString writes it (UTC, milliseconds, `Z`), a newline.
    public static func text(bootTime: TimeInterval, now: Date) -> String {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        iso.timeZone = TimeZone(identifier: "UTC")
        return "{\"boot\":\(String(format: "%.3f", bootTime)),\"at\":\"\(iso.string(from: now))\"}\n"
    }

    /// Writes the mark into `stateDir` (the daemon's own, StateDir-checked): created 0600 from its first byte, an
    /// existing file truncated and set to 0600, a symlink at the path refused (O_NOFOLLOW: nothing is written through
    /// it). Throws Failure; the signal and settings paths call leave(stateDir:audit:trigger:) instead.
    public static func write(stateDir: URL, now: Date = Date()) throws {
        guard let boot = bootTime() else { throw Failure.bootTime(errno) }
        let path = stateDir.appendingPathComponent(fileName).path
        let fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw Failure.open(path, errno) }
        defer { close(fd) }
        guard fchmod(fd, 0o600) == 0 else { throw Failure.write(path, errno) }
        guard Server.writeAll(fd, Data(text(bootTime: boot, now: now).utf8)) else { throw Failure.write(path, errno) }
    }

    /// write(stateDir:), never throwing: a failure is audited (runtime.stop_mark, decision error, the trigger and the
    /// failure) and otherwise ignored, so the stop goes on whatever happens to the mark.
    public static func leave(stateDir: URL, audit: AuditSink, trigger: String, now: Date = Date()) {
        do {
            try write(stateDir: stateDir, now: now)
        } catch {
            audit.record(["method": "runtime.stop_mark", "decision": "error", "trigger": .string(trigger),
                          "detail": .string("\(error)")])
        }
    }
}
