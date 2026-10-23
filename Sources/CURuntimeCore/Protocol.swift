import Foundation

/// Wire format: each frame is a 4-byte little-endian payload length followed by a JSON-RPC 2.0 message.
public enum Framing {
    public static let maxFrameBytes = 256 * 1024

    public enum Decoded: Equatable {
        case needMore
        case frame(Data)
        case oversize(Int)
    }

    public static func encode(_ payload: Data) -> Data {
        var length = UInt32(payload.count).littleEndian
        var out = Data(bytes: &length, count: 4)
        out.append(payload)
        return out
    }

    /// Pops one frame off the front of `buffer` when complete.
    public static func decode(_ buffer: inout Data) -> Decoded {
        guard buffer.count >= 4 else { return .needMore }
        let b = [UInt8](buffer.prefix(4))
        let length = Int(UInt32(b[0]) | UInt32(b[1]) << 8 | UInt32(b[2]) << 16 | UInt32(b[3]) << 24)
        if length > maxFrameBytes { return .oversize(length) }
        guard buffer.count >= 4 + length else { return .needMore }
        let payload = Data(buffer.dropFirst(4).prefix(length))
        buffer = Data(buffer.dropFirst(4 + length))
        return .frame(payload)
    }
}

public enum RPCCode: Int {
    case parseError = -32700
    case invalidRequest = -32600
    case methodNotFound = -32601
    case invalidParams = -32602
    case internalError = -32603
    case unauthenticated = -32001
    case requestTimeout = -32003
    case denied = -32010
}

struct RPCRequest: Decodable {
    let jsonrpc: String?
    let id: JSONValue?
    let method: String
    let params: JSONValue?
}

public struct RPCFailure: Error, Equatable {
    public let code: RPCCode
    public let message: String
    public let data: JSONValue?

    public init(_ code: RPCCode, _ message: String, data: JSONValue? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }
}

enum RPCMessage {
    static func result(id: JSONValue?, _ result: JSONValue) -> Data {
        JSONCoding.encode(["jsonrpc": "2.0", "id": id ?? .null, "result": result])
    }

    static func error(id: JSONValue?, _ failure: RPCFailure) -> Data {
        var err: [String: JSONValue] = ["code": .number(Double(failure.code.rawValue)), "message": .string(failure.message)]
        if let data = failure.data { err["data"] = data }
        return JSONCoding.encode(["jsonrpc": "2.0", "id": id ?? .null, "error": .object(err)])
    }
}
