import Darwin
import Foundation

/// What a daemon launch may use, decided before it touches its state (stage 2, R1). A release build serves only the
/// default state directory, reached by leaving `--state-dir` out, and does not start when its config file turns on a
/// test-harness switch: with either, any code of this user that can run `open` (a model's bash among it) could start
/// a second daemon holding this app's TCC permissions and grant itself apps with no dialog, or have observe hand out
/// native-resolution composites. A bench build (compiled with `-DCU_BENCH`, which `CU_BENCH=1 scripts/build-app.sh`
/// does) accepts both, as every build did before: the VM bench and experiments turn the switches on in throwaway
/// clones and run only bench builds.
public enum LaunchPolicy {
    /// A launch that must not go on: what is refused (`--state-dir`, or the config keys that are on) and a message
    /// naming it, for stderr (exit status 1) and the audit.
    public struct Refusal: Error, Equatable, CustomStringConvertible {
        public let refused: [String]
        public let message: String
        public var description: String { message }
    }

    /// The config.json switches only a bench build starts with, as the file spells them.
    public static let benchOnlyConfigKeys = ["config_grants", "debug_activation", "debug_ime", "debug_native_images"]

    private static let bench = "only a bench build (CU_BENCH=1 scripts/build-app.sh) accepts"

    /// The state directory serve and grants use, from their arguments (the command name removed), or the refusal of
    /// the launch. Without `--state-dir` among them: `defaultStateDir` itself, in either build. A release build refuses
    /// `--state-dir` whenever it is there, whatever follows it, the default in any spelling included: no comparison of
    /// paths stands between this check and the directory used. (`<default's parent>/<link>/../cu-runtime` standardizes
    /// to the default's path, but the file system takes that `..` from wherever the link points; the path comparison
    /// made here before let it through.) A bench build uses the value after the first `--state-dir` as given
    /// (`URL(fileURLWithPath:)`: relative to the current directory, nothing resolved), and refuses a `--state-dir` with
    /// no value after it.
    public static func stateDir(arguments: [String], defaultStateDir: URL, benchBuild: Bool) -> Result<URL, Refusal> {
        guard let i = arguments.firstIndex(of: "--state-dir") else { return .success(defaultStateDir) }
        let value = i + 1 < arguments.count ? arguments[i + 1] : nil
        guard benchBuild else {
            let given = value.map { "--state-dir \($0)" } ?? "--state-dir"
            return .failure(Refusal(refused: ["--state-dir"],
                                    message: "\(given): \(bench) --state-dir; this release build serves only the default "
                                        + "state directory (\(defaultStateDir.path)), reached without the option"))
        }
        guard let value else {
            return .failure(Refusal(refused: ["--state-dir"], message: "--state-dir needs a directory after it"))
        }
        return .success(URL(fileURLWithPath: value))
    }

    /// nil when serve may go on with this config.json (`configFile`, which the message names). A bench build is never
    /// refused; a release build is, for each benchOnlyConfigKeys switch that is on.
    public static func refusal(config: PolicyConfig, configFile: URL, benchBuild: Bool) -> Refusal? {
        guard !benchBuild else { return nil }
        let flags = [config.configGrants, config.debugActivation, config.debugIme, config.debugNativeImages]
        let on = zip(benchOnlyConfigKeys, flags).filter(\.1).map(\.0)
        guard !on.isEmpty else { return nil }
        let them = on.count == 1 ? "it" : "them"
        return Refusal(refused: on,
                       message: "\(on.joined(separator: ", ")) on in \(configFile.path): "
                           + "\(bench) \(on.count == 1 ? "this test-harness switch" : "these test-harness switches"); "
                           + "this release build does not start with \(them) (remove \(them) from the file)")
    }

    /// The home directory the user database gives this process's user. Not Foundation's home directory, which follows
    /// CFFIXED_USER_HOME: a launch through `open --env` could set that and move whatever is looked up there. nil when
    /// the user has no absolute home there.
    public static func userHomeDirectory() -> URL? {
        guard let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir else { return nil }
        let home = String(cString: dir)
        guard home.hasPrefix("/") else { return nil }
        return URL(fileURLWithPath: home, isDirectory: true)
    }

    /// The default state directory: Library/Application Support/cu-runtime in userHomeDirectory(); nil without it.
    public static func defaultStateDir() -> URL? {
        userHomeDirectory()?.appendingPathComponent("Library/Application Support/cu-runtime")
    }
}
