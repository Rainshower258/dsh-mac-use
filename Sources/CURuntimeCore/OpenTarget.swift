import Foundation

// MARK: - apps.launch `open` (2026-10-15)

/// What apps.launch hands the app to open: a file bash made, or a web address (cua-driver's
/// `launch_app({bundle_id, urls})`). It replaces `open` in bash, which runs outside both the sandbox and the daemon's
/// approvals. The person's approval of the app (full mode) is the main control; these checks keep a file or address
/// from doing more than show content in that app: only http(s) addresses; only an existing regular file, by its
/// resolved path, that nobody may execute, outside the daemon's state dir (its token), and not of a kind whose
/// opening runs, installs or redirects to something else.
public enum OpenTarget: Equatable {
    case file(URL)
    case web(URL)

    var kind: String {
        switch self {
        case .file: return "file"
        case .web: return "web"
        }
    }

    var url: URL {
        switch self {
        case .file(let u), .web(let u): return u
        }
    }

    static let maxLength = 2048

    /// Kinds whose opening runs or installs something, or points to another target the checks never saw.
    static let launcherExtensions: Set<String> = [
        "command", "tool", "terminal", "workflow", "shortcut", "pkg", "mpkg", "mobileconfig", "webloc", "inetloc",
        "fileloc", "app", "prefpane", "kext", "action", "osax",
    ]

    /// `protectedDirs`: resolved directories no file may be opened from (the daemon's state dir).
    static func parse(_ raw: String, protectedDirs: [String]) throws -> OpenTarget {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { throw RPCFailure(.invalidParams, "open is empty") }
        guard s.count <= maxLength else { throw Denial("open_not_allowed", "open is longer than \(maxLength) characters") }
        guard !s.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw Denial("open_not_allowed", "open contains control characters")
        }
        if s.hasPrefix("/") { return try file(s, protectedDirs: protectedDirs) }
        return try web(s)
    }

    private static func web(_ s: String) throws -> OpenTarget {
        guard let u = URL(string: s), let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = u.host, !host.isEmpty else {
            throw Denial("open_not_allowed", "open takes an absolute file path or an http(s) address; nothing else "
                         + "(no file://, no other schemes, no relative paths)")
        }
        return .web(u)
    }

    private static func file(_ s: String, protectedDirs: [String]) throws -> OpenTarget {
        guard let resolved = realpath(s, nil) else { throw Denial("open_not_found", "no file at \(s)") }
        let path = String(cString: resolved)
        free(resolved)
        var st = stat()
        guard stat(path, &st) == 0 else { throw Denial("open_not_found", "no file at \(s)") }
        guard st.st_mode & S_IFMT == S_IFREG else {
            throw Denial("open_not_allowed", "\(s) is not a regular file (folders and app bundles are never opened)")
        }
        guard st.st_mode & 0o111 == 0 else {
            throw Denial("open_not_allowed", "\(s) is executable; executable files are never opened")
        }
        let ext = (path as NSString).pathExtension.lowercased()
        guard !launcherExtensions.contains(ext) else {
            throw Denial("open_not_allowed", "a .\(ext) file runs, installs or redirects to something when opened; never opened")
        }
        for dir in protectedDirs where path == dir || path.hasPrefix(dir.hasSuffix("/") ? dir : dir + "/") {
            throw Denial("open_not_allowed", "files of the computer-use daemon itself are never opened")
        }
        return .file(URL(fileURLWithPath: path))
    }

    /// A directory's resolved path (Seatbelt-style: /var → /private/var), or the path as given if it does not exist.
    public static func resolvedDir(_ path: String) -> String {
        guard let r = realpath(path, nil) else { return path }
        defer { free(r) }
        return String(cString: r)
    }
}
