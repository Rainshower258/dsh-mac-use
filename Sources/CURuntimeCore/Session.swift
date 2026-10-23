import Foundation

/// One connection's state. The first message must be `session.hello` carrying the daemon's token.
/// The token only proves the peer can read a 0600 file (docs/DESIGN.md "Connection authentication"): it stops stray
/// connections and stale clients, not code already running as this user.
public final class Session {
    public static let protocolVersion = "cu-runtime/1"

    private let token: String
    private let dispatcher: Dispatcher
    private let audit: AuditSink
    public let conn: ConnectionInfo
    public private(set) var authenticated = false

    public init(token: String, dispatcher: Dispatcher, audit: AuditSink, conn: ConnectionInfo) {
        self.token = token
        self.dispatcher = dispatcher
        self.audit = audit
        self.conn = conn
    }

    /// Returns the reply frame payload and whether the connection must be closed afterwards.
    public func handle(frame: Data) -> (reply: Data, close: Bool) {
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: frame) else {
            record(nil, "error", "parse_error", "payload is not JSON")
            return (RPCMessage.error(id: nil, RPCFailure(.parseError, "parse error")), !authenticated)
        }
        guard let request = try? JSONCoding.decodeParams(RPCRequest.self, json) else {
            record(nil, "error", "invalid_request", "not a JSON-RPC request")
            return (RPCMessage.error(id: json["id"], RPCFailure(.invalidRequest, "invalid request")), !authenticated)
        }

        if request.method == "session.hello" || !authenticated {
            guard request.method == "session.hello" else {
                record(request.method, "deny", "unauthenticated", "first message must be session.hello")
                return (RPCMessage.error(id: request.id, RPCFailure(.unauthenticated, "send session.hello first")), true)
            }
            guard Self.constantTimeEquals(request.params?["token"]?.stringValue ?? "", token) else {
                record(request.method, "deny", "bad_token", "token mismatch")
                authenticated = false
                return (RPCMessage.error(id: request.id, RPCFailure(.unauthenticated, "bad token")), true)
            }
            authenticated = true
            record(request.method, "allow", nil, nil)
            return (RPCMessage.result(id: request.id, ["protocol": .string(Self.protocolVersion)]), false)
        }

        switch dispatcher.handle(method: request.method, params: request.params, conn: conn) {
        case .success(let v): return (RPCMessage.result(id: request.id, v), false)
        case .failure(let e): return (RPCMessage.error(id: request.id, e), false)
        }
    }

    private func record(_ method: String?, _ decision: String, _ reason: String?, _ detail: String?) {
        var f = conn.auditFields
        f["method"] = method.map { .string($0) } ?? .null
        f["decision"] = .string(decision)
        if let reason { f["reason"] = .string(reason) }
        if let detail { f["detail"] = .string(detail) }
        audit.record(f)
    }

    static func constantTimeEquals(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        guard x.count == y.count, !x.isEmpty else { return false }
        var diff: UInt8 = 0
        for i in 0..<x.count { diff |= x[i] ^ y[i] }
        return diff == 0
    }
}
