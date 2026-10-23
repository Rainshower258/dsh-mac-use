import Darwin
import Foundation
import XCTest
@testable import CURuntimeCore

/// Only a bench build takes --state-dir or starts with a test-harness switch on.
final class LaunchPolicyTests: XCTestCase {
    private let standard = URL(fileURLWithPath: "/var/empty/home/Library/Application Support/cu-runtime")
    private let other = "/private/tmp/cu-elsewhere"

    private func stateDir(_ arguments: [String], bench: Bool, standard: URL? = nil) -> Result<URL, LaunchPolicy.Refusal> {
        LaunchPolicy.stateDir(arguments: arguments, defaultStateDir: standard ?? self.standard, benchBuild: bench)
    }

    private func refusal(_ config: PolicyConfig, bench: Bool) -> LaunchPolicy.Refusal? {
        LaunchPolicy.refusal(config: config, configFile: standard.appendingPathComponent("config.json"), benchBuild: bench)
    }

    private func decode(_ json: String) throws -> PolicyConfig {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(PolicyConfig.self, from: Data(json.utf8))
    }

    private func refused(_ result: Result<URL, LaunchPolicy.Refusal>, _ what: String,
                         file: StaticString = #filePath, line: UInt = #line) -> LaunchPolicy.Refusal? {
        switch result {
        case .success(let url):
            XCTFail("\(what): accepted as \(url.path)", file: file, line: line)
            return nil
        case .failure(let r):
            XCTAssertEqual(r.refused, ["--state-dir"], what, file: file, line: line)
            return r
        }
    }

    private func realPath(_ path: String) -> String? {
        guard let r = realpath(path, nil) else { return nil }
        defer { free(r) }
        return String(cString: r)
    }

    /// Spellings of a state directory that a path comparison with the default would have judged differently: the
    /// default itself, other spellings of it, ".." forms that end at it or elsewhere, a relative path, another dir.
    private var spellings: [String] {
        let parent = standard.deletingLastPathComponent().path
        return [standard.path, standard.path + "/", standard.path + "/./", parent + "/x/../cu-runtime",
                standard.path + "/../cu-runtime", parent + "/../Application Support/cu-runtime", standard.path + "/sub",
                parent, standard.path + "/../cu-runtime-2", "Library/Application Support/cu-runtime", other]
    }

    func testWithoutTheOptionEitherBuildUsesTheDefaultItself() throws {
        for bench in [false, true] {
            for arguments in [[], ["--settings"], ["--settings-page", "logs"], ["list"], ["revoke", "com.example.app"],
                              ["add", "--full", "com.example.app"], ["--state-dir-x", other]] {
                XCTAssertEqual(try stateDir(arguments, bench: bench).get(), standard, "\(arguments), bench \(bench)")
            }
        }
    }

    func testReleaseBuildRefusesTheOptionWhateverItNames() throws {
        for given in spellings {
            let r = try XCTUnwrap(refused(stateDir(["--state-dir", given], bench: false), given))
            XCTAssertTrue(r.message.hasPrefix("--state-dir \(given): only a bench build"), r.message)
            XCTAssertTrue(r.message.contains("serves only the default state directory (\(standard.path))"), r.message)
            // Wherever the option stands among the others (grants: after the subcommand; serve: after --settings).
            XCTAssertNotNil(refused(stateDir(["list", "--state-dir", given], bench: false), given))
            XCTAssertNotNil(refused(stateDir(["--settings", "--state-dir", given, "--settings-page", "logs"], bench: false),
                                    given))
        }
        // The exact default, as main.swift would be handed it: refused all the same (leave the option out instead).
        XCTAssertNotNil(refused(stateDir(["--state-dir", standard.path], bench: false), "the default"))
        // The option with nothing after it, and given twice.
        let bare = try XCTUnwrap(refused(stateDir(["--state-dir"], bench: false), "no value"))
        XCTAssertTrue(bare.message.hasPrefix("--state-dir: only a bench build"), bare.message)
        XCTAssertNotNil(refused(stateDir(["--state-dir", other, "--state-dir", standard.path], bench: false), "twice"))
    }

    /// The hole a path comparison left: `<default's parent>/<link>/../cu-runtime`, while nothing exists there yet,
    /// standardizes to the default's path; the file system resolves that `..` from the link's target, so StateDir would
    /// create and serve a directory elsewhere.
    func testASymlinkOutOfTheDefaultsParentIsRefusedInReleaseAndServedAsGivenInBench() throws {
        let fm = FileManager.default
        let root = try XCTUnwrap(realPath(NSTemporaryDirectory())) + "/cu-launch-\(UUID().uuidString)"
        defer { try? fm.removeItem(atPath: root) }
        let standard = URL(fileURLWithPath: root + "/home/Library/Application Support/cu-runtime")
        let parent = standard.deletingLastPathComponent().path
        try fm.createDirectory(atPath: standard.path, withIntermediateDirectories: true)
        try fm.createDirectory(atPath: root + "/elsewhere/deep", withIntermediateDirectories: true)
        try fm.createSymbolicLink(atPath: parent + "/link", withDestinationPath: root + "/elsewhere/deep")
        let given = parent + "/link/../cu-runtime"
        // What made it a hole: the old comparison saw the default, the file system goes elsewhere.
        XCTAssertEqual(URL(fileURLWithPath: given).standardizedFileURL.path, standard.standardizedFileURL.path)
        XCTAssertEqual(realPath(parent + "/link/.."), root + "/elsewhere")

        let r = try XCTUnwrap(refused(stateDir(["--state-dir", given], bench: false, standard: standard), given))
        XCTAssertTrue(r.message.hasPrefix("--state-dir \(given): only a bench build"), r.message)
        // The link itself, and a link straight to the default, are refused as well.
        XCTAssertNotNil(refused(stateDir(["--state-dir", parent + "/link"], bench: false, standard: standard), "link"))
        try fm.createSymbolicLink(atPath: root + "/to-default", withDestinationPath: standard.path)
        XCTAssertNotNil(refused(stateDir(["--state-dir", root + "/to-default"], bench: false, standard: standard),
                                "a link to the default"))

        // A bench build serves what it was told, unresolved (a state dir that is itself a symlink is StateDir's to refuse).
        XCTAssertEqual(try stateDir(["--state-dir", given], bench: true, standard: standard).get(), URL(fileURLWithPath: given))
        XCTAssertEqual(try stateDir(["--state-dir", root + "/to-default"], bench: true, standard: standard).get(),
                       URL(fileURLWithPath: root + "/to-default"))
    }

    func testBenchBuildUsesTheDirectoryAsGiven() throws {
        for given in spellings {
            XCTAssertEqual(try stateDir(["--state-dir", given], bench: true).get(), URL(fileURLWithPath: given), given)
            XCTAssertEqual(try stateDir(["list", "--state-dir", given], bench: true).get(), URL(fileURLWithPath: given), given)
        }
        // The first --state-dir counts, as main.swift's option() reads it.
        XCTAssertEqual(try stateDir(["--state-dir", other, "--state-dir", standard.path], bench: true).get(),
                       URL(fileURLWithPath: other))
        // No value after it: a usage error in a bench build too, never a silent default.
        let bare = try XCTUnwrap(refused(stateDir(["--state-dir"], bench: true), "no value"))
        XCTAssertEqual(bare.message, "--state-dir needs a directory after it")
        XCTAssertNotNil(refused(stateDir(["list", "--state-dir"], bench: true), "no value after grants list"))
    }

    func testReleaseBuildRefusesEachTestHarnessSwitch() throws {
        let cases: [(String, PolicyConfig)] = [
            ("config_grants", PolicyConfig(configGrants: true)),
            ("debug_activation", PolicyConfig(debugActivation: true)),
            ("debug_ime", PolicyConfig(debugIme: true)),
            ("debug_native_images", PolicyConfig(debugNativeImages: true)),
        ]
        XCTAssertEqual(cases.map(\.0), LaunchPolicy.benchOnlyConfigKeys)
        for (key, config) in cases {
            let r = try XCTUnwrap(refusal(config, bench: false), key)
            XCTAssertEqual(r.refused, [key])
            XCTAssertTrue(r.message.hasPrefix("\(key) on in \(standard.path)/config.json"), r.message)
            XCTAssertTrue(r.message.contains("only a bench build"), r.message)
            XCTAssertTrue(r.message.contains("does not start with it (remove it from the file)"), r.message)
            // As config.json spells it, through the daemon's own decoding.
            XCTAssertEqual(refusal(try decode(#"{"\#(key)": true}"#), bench: false)?.refused, [key])
            XCTAssertNil(refusal(try decode(#"{"\#(key)": false}"#), bench: false), key)
        }
        let all = try XCTUnwrap(refusal(PolicyConfig(debugNativeImages: true, debugActivation: true, debugIme: true,
                                                     configGrants: true), bench: false))
        XCTAssertEqual(all.refused, LaunchPolicy.benchOnlyConfigKeys)
        XCTAssertTrue(all.message.hasPrefix("config_grants, debug_activation, debug_ime, debug_native_images on in"),
                      all.message)
        XCTAssertTrue(all.message.contains("does not start with them (remove them from the file)"), all.message)
        XCTAssertNil(refusal(PolicyConfig(), bench: false))
    }

    func testReleaseBuildKeepsTheDailySettings() throws {
        // Daily-use settings are not test-harness switches.
        let daily = try decode(#"{"allow_finder": true, "activation_method": "ax_frontmost"}"#)
        XCTAssertNil(refusal(daily, bench: false))
        XCTAssertNil(refusal(try decode("{}"), bench: false))
    }

    func testBenchBuildAcceptsEverySwitch() {
        let all = PolicyConfig(debugNativeImages: true, debugActivation: true, debugIme: true, configGrants: true)
        XCTAssertNil(refusal(all, bench: true))
        for config in [PolicyConfig(configGrants: true), PolicyConfig(debugActivation: true), PolicyConfig(debugIme: true),
                       PolicyConfig(debugNativeImages: true)] {
            XCTAssertNil(refusal(config, bench: true))
        }
    }

    func testHomeAndDefaultStateDirComeFromTheUserDatabase() throws {
        let pw = try XCTUnwrap(getpwuid(getuid()))
        let home = String(cString: try XCTUnwrap(pw.pointee.pw_dir))
        let expected = home + "/Library/Application Support/cu-runtime"
        XCTAssertEqual(LaunchPolicy.userHomeDirectory()?.path, home)
        XCTAssertEqual(LaunchPolicy.defaultStateDir()?.path, expected)
        // CFFIXED_USER_HOME moves Foundation's home directory (and `open --env` can set it); not this one.
        let saved = getenv("CFFIXED_USER_HOME").map { String(cString: $0) }
        setenv("CFFIXED_USER_HOME", "/private/tmp/cu-fake-home", 1)
        defer { if let saved { setenv("CFFIXED_USER_HOME", saved, 1) } else { unsetenv("CFFIXED_USER_HOME") } }
        XCTAssertEqual(LaunchPolicy.userHomeDirectory()?.path, home)
        XCTAssertEqual(LaunchPolicy.defaultStateDir()?.path, expected)
        // Without the option, the launch uses exactly that.
        let standard = try XCTUnwrap(LaunchPolicy.defaultStateDir())
        XCTAssertEqual(try LaunchPolicy.stateDir(arguments: [], defaultStateDir: standard, benchBuild: false).get().path, expected)
    }
}
