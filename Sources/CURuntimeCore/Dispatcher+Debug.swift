import Foundation

// MARK: - runtime.debug_* (test harness only; both need their switch in config.json)

extension Dispatcher {
    /// Activation experiment only (config `debug_activation`): one activation of a granted app by a given method,
    /// with the usual verification. Nothing else happens.
    func debugActivate(_ p: DebugActivateParams, _ f: inout [String: JSONValue]) throws -> JSONValue {
        guard config.debugActivation else { throw Denial("debug_disabled", "runtime.debug_activate needs debug_activation in config") }
        guard let method = ActivationMethod(rawValue: p.method) else {
            throw RPCFailure(.invalidParams, "method must be one of \(ActivationMethod.allCases.map(\.rawValue))")
        }
        f["task_id"] = .string(p.taskId)
        f["app"] = .string(p.app)
        f["activation_method"] = .string(method.rawValue)
        try checkApp(taskID: p.taskId, app: p.app)
        let t0 = Date()
        let ok = env.activate(bundleID: p.app.lowercased(), timeout: p.timeout ?? Self.activationTimeout, method: method)
        return ["ok": .bool(ok), "elapsed_ms": .number((Date().timeIntervalSince(t0) * 1000).rounded())]
    }

    /// Input method experiment only (config `debug_ime`): the probe, or selecting an input source directly (to measure
    /// whether this background daemon can switch it at all). Audited like everything else.
    func debugIME(_ p: DebugIMEParams, _ f: inout [String: JSONValue]) throws -> JSONValue {
        guard config.debugIme else { throw Denial("debug_disabled", "runtime.debug_ime needs debug_ime in config") }
        f["task_id"] = .string(p.taskId)
        f["app"] = .string(p.app)
        f["op"] = .string(p.op)
        try checkApp(taskID: p.taskId, app: p.app)
        switch p.op {
        case "probe": return env.debugIMEProbe(bundleID: p.app.lowercased())
        case "select":
            guard let id = p.id else { throw RPCFailure(.invalidParams, "select needs id") }
            let t0 = Date()
            let ok = env.selectInputSource(id: id)
            return ["ok": .bool(ok), "current": env.currentInputSource().map { .string($0.id) } ?? .null,
                    "elapsed_ms": .number((Date().timeIntervalSince(t0) * 1000).rounded())]
        default: throw RPCFailure(.invalidParams, "op must be probe or select")
        }
    }
}
