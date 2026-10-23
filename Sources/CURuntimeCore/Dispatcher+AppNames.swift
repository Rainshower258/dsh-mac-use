import Foundation

// MARK: - App display names

extension Dispatcher {
    /// A model may name an app the way the screen shows it ("DSHFixture") rather than by bundle ID (every
    /// not_granted in the plugin's test runs was that). The name is looked up among the task's granted apps only, and
    /// used only when exactly one matches, so it can never reach an app the grant does not already cover; the bundle ID
    /// it becomes still goes through checkApp (hard-deny, grant). Several matches are refused; no match leaves the
    /// request as it was (refused as not_granted). Grants are never resolved (they take bundle IDs).
    func resolveAppName(_ params: JSONValue?, _ f: inout [String: JSONValue]) throws -> JSONValue? {
        guard case .object(var o)? = params, let name = o["app"]?.stringValue, let taskID = o["task_id"]?.stringValue,
              // Read-only lookup: grants.active() drops an expired grant, and the real check must still see it.
              let grant = grants.all(now: now()).first(where: { $0.taskID == taskID }), !grant.covers(name)
        else { return params }
        let key = Self.nameKey(name)
        let matches = grant.bundleIDs.filter { id in env.displayNames(bundleID: id).contains { Self.nameKey($0) == key } }
        guard !matches.isEmpty else { return params }
        f["app_name"] = .string(Self.clip(name))
        guard matches.count == 1 else {
            throw Denial("app_name_ambiguous", "\"\(Self.clip(name))\" is the name of \(matches.count) granted apps "
                         + "(\(matches.joined(separator: ", "))): use the bundle id")
        }
        o["app"] = .string(matches[0])
        f["app_resolved_from_name"] = true
        return .object(o)
    }

    static func nameKey(_ s: String) -> String {
        s.precomposedStringWithCanonicalMapping.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}
