import XCTest
@testable import CURuntimeCore

final class FramingTests: XCTestCase {
    func testRoundTripAndPartialReads() {
        let a = Data(#"{"a":1}"#.utf8), b = Data(#"{"b":2}"#.utf8)
        var buf = Framing.encode(a) + Framing.encode(b)
        var partial = Data(buf.prefix(6))
        XCTAssertEqual(Framing.decode(&partial), .needMore)
        XCTAssertEqual(Framing.decode(&buf), .frame(a))
        XCTAssertEqual(Framing.decode(&buf), .frame(b))
        XCTAssertEqual(Framing.decode(&buf), .needMore)
    }

    func testLengthIsLittleEndian() {
        XCTAssertEqual([UInt8](Framing.encode(Data(count: 258)).prefix(4)), [2, 1, 0, 0])
    }

    func testOversizeIsReportedBeforeTheBodyArrives() {
        var len = UInt32(Framing.maxFrameBytes + 1).littleEndian
        var buf = Data(bytes: &len, count: 4)
        XCTAssertEqual(Framing.decode(&buf), .oversize(Framing.maxFrameBytes + 1))
    }
}

final class KeyChordTests: XCTestCase {
    func testNormalization() throws {
        XCTAssertEqual(try KeyChord.parse("Shift+CMD+q").description, "shift+cmd+q")
        XCTAssertEqual(try KeyChord.parse("option+control+Enter").description, "ctrl+opt+return")
        XCTAssertEqual(try KeyChord.parse("q+cmd"), try KeyChord.parse("cmd+q"))
    }

    func testParseErrors() {
        XCTAssertThrowsError(try KeyChord.parse("")) { XCTAssertEqual($0 as? KeyChord.ParseError, .empty) }
        XCTAssertThrowsError(try KeyChord.parse("cmd+shift")) { XCTAssertEqual($0 as? KeyChord.ParseError, .noKey) }
        XCTAssertThrowsError(try KeyChord.parse("cmd+a+b")) { XCTAssertEqual($0 as? KeyChord.ParseError, .multipleKeys) }
        XCTAssertThrowsError(try KeyChord.parse("cmd+power")) {
            XCTAssertEqual($0 as? KeyChord.ParseError, .unknownToken("power"))
        }
    }

    func testOrdinaryEditingChordsAreAllowed() throws {
        for s in ["cmd+a", "cmd+c", "cmd+v", "cmd+z", "cmd+shift+z", "return", "tab", "escape", "cmd+w", "cmd+f", "down", "shift+a", "cmd+l", "cmd+shift+t"] {
            XCTAssertNil(ChordPolicy.refusal(for: try KeyChord.parse(s)), s)
        }
    }
}

final class HardDenyTests: XCTestCase {
    /// The original hard-deny list must stay covered no matter how the table is edited.
    func testPlanListIsPresent() {
        for id in ["com.apple.loginwindow", "com.apple.dock", "com.apple.systemuiserver", "com.apple.controlcenter",
                   "com.apple.notificationcenterui", "com.apple.SecurityAgent", "com.apple.systempreferences",
                   "com.apple.Terminal", "com.apple.keychainaccess"] {
            XCTAssertNotNil(HardDeny.entry(for: id), id)
        }
        XCTAssertNil(HardDeny.entry(for: HardDeny.finder), "Finder is config-gated, not hard-denied")
    }

    func testNoDuplicates() {
        let ids = HardDeny.entries.map { $0.bundleID.lowercased() }
        XCTAssertEqual(ids.count, Set(ids).count)
    }
}

final class SessionTests: XCTestCase {
    private func session() -> (Session, MemoryAudit) {
        let h = Harness()
        return (Session(token: "tok123", dispatcher: h.dispatcher, audit: h.audit, conn: h.conn), h.audit)
    }

    private func frame(_ s: String) -> Data { Data(s.utf8) }

    private func errorCode(_ reply: Data) -> Int? {
        let v = try? JSONDecoder().decode(JSONValue.self, from: reply)
        if case .number(let n) = v?["error"]?["code"] { return Int(n) }
        return nil
    }

    func testFirstMessageMustBeHello() {
        let (s, audit) = session()
        let (reply, close) = s.handle(frame: frame(#"{"jsonrpc":"2.0","id":1,"method":"runtime.ping"}"#))
        XCTAssertEqual(errorCode(reply), RPCCode.unauthenticated.rawValue)
        XCTAssertTrue(close)
        XCTAssertEqual(audit.entries.last?["reason"], "unauthenticated")
    }

    func testWrongTokenClosesAndIsAudited() {
        for tok in ["tok124", "", "tok1234", "TOK123"] {
            let (s, audit) = session()
            let (reply, close) = s.handle(frame: frame(#"{"jsonrpc":"2.0","id":1,"method":"session.hello","params":{"token":"\#(tok)"}}"#))
            XCTAssertEqual(errorCode(reply), RPCCode.unauthenticated.rawValue, tok)
            XCTAssertTrue(close)
            XCTAssertFalse(s.authenticated)
            XCTAssertEqual(audit.entries.last?["reason"], "bad_token")
        }
    }

    func testHelloThenRequests() {
        let (s, _) = session()
        XCTAssertFalse(s.handle(frame: frame(#"{"jsonrpc":"2.0","id":1,"method":"session.hello","params":{"token":"tok123"}}"#)).close)
        let (reply, close) = s.handle(frame: frame(#"{"jsonrpc":"2.0","id":2,"method":"runtime.ping"}"#))
        XCTAssertFalse(close)
        XCTAssertNil(errorCode(reply))
        // Re-hello with a bad token drops the session.
        XCTAssertTrue(s.handle(frame: frame(#"{"jsonrpc":"2.0","id":3,"method":"session.hello","params":{"token":"x"}}"#)).close)
        XCTAssertFalse(s.authenticated)
    }

    func testGarbageBeforeAuthClosesAfterAuthDoesNot() {
        let (s, audit) = session()
        let (r1, c1) = s.handle(frame: frame("not json"))
        XCTAssertEqual(errorCode(r1), RPCCode.parseError.rawValue)
        XCTAssertTrue(c1)
        XCTAssertEqual(audit.entries.last?["reason"], "parse_error")
        _ = s.handle(frame: frame(#"{"jsonrpc":"2.0","id":1,"method":"session.hello","params":{"token":"tok123"}}"#))
        let (r2, c2) = s.handle(frame: frame("{"))
        XCTAssertEqual(errorCode(r2), RPCCode.parseError.rawValue)
        XCTAssertFalse(c2)
        let (r3, _) = s.handle(frame: frame(#"{"id":5}"#))
        XCTAssertEqual(errorCode(r3), RPCCode.invalidRequest.rawValue)
    }

    /// Routing is split by namespace (audit L6): unknown names inside a known namespace are still unknown.
    func testUnknownMethodsInEveryNamespace() {
        let h = Harness()
        for m in ["nope", "runtime.nope", "grants.nope", "apps.nope", "observe.nope", "zoom.nope", "act.nope", "act"] {
            guard case .failure(let f) = h.call(m) else { return XCTFail(m) }
            XCTAssertEqual(f.code, .methodNotFound, m)
        }
    }
}
