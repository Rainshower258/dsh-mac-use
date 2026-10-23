import Darwin
import Foundation

/// The daemon's private directories (state dir and its audit/ subdir). They hold the socket and the token,
/// so they must be real directories, owned by us, mode 0700. Anything else refuses to start: a directory
/// pre-created by someone else on a shared path could otherwise be used to swap the socket or token.
public enum StateDir {
    public enum Problem: Error, Equatable, CustomStringConvertible {
        case symlink(String)
        case notDirectory(String)
        case wrongOwner(String, uid_t)
        case wrongMode(String, mode_t)
        case posix(String, Int32)

        public var description: String {
            switch self {
            case .symlink(let p): return "\(p) is a symlink; refusing to use it"
            case .notDirectory(let p): return "\(p) exists and is not a directory"
            case .wrongOwner(let p, let u): return "\(p) is owned by uid \(u), not \(getuid())"
            case .wrongMode(let p, let m): return "\(p) has mode \(String(m, radix: 8)); it must be 700 (chmod 700 it yourself)"
            case .posix(let p, let e): return "\(p): \(String(cString: strerror(e)))"
            }
        }
    }

    /// Creates `url` (and its parents) if missing, then verifies it. Never loosens or takes over an existing dir.
    public static func prepare(_ url: URL) throws {
        let path = url.path
        var st = stat()
        if lstat(path, &st) != 0 {
            guard errno == ENOENT else { throw Problem.posix(path, errno) }
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            guard mkdir(path, 0o700) == 0 || errno == EEXIST else { throw Problem.posix(path, errno) }
        }
        try verify(url)
    }

    public static func verify(_ url: URL) throws {
        let path = url.path
        var st = stat()
        guard lstat(path, &st) == 0 else { throw Problem.posix(path, errno) }
        if st.st_mode & S_IFMT == S_IFLNK { throw Problem.symlink(path) }
        guard st.st_mode & S_IFMT == S_IFDIR else { throw Problem.notDirectory(path) }
        guard st.st_uid == getuid() else { throw Problem.wrongOwner(path, st.st_uid) }
        guard st.st_mode & 0o777 == 0o700 else { throw Problem.wrongMode(path, st.st_mode & 0o777) }
    }
}
