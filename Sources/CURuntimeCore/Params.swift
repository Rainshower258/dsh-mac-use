import CoreGraphics
import Foundation

/// Request parameters of the daemon's methods (decoded with snake_case keys by JSONCoding).
struct TaskParams: Decodable { let taskId: String }

/// access.turn_start; `late`: the plugin marks a turn that began while the daemon was not running (audited).
struct TurnStartParams: Decodable {
    let taskId: String
    let late: Bool?
}

struct ObserveParams: Decodable {
    let taskId: String
    let ocr: String?
    let includeImage: Bool?
    let debugNativeImage: Bool?
}

struct GrantSetParams: Decodable {
    let taskId: String
    let bundleIds: [String]
    let allowLaunch: Bool?
    let expiresInS: Double?
    let source: String
    let electronAx: Bool?
    let imePolicy: String?
    let actions: [String]?
    let clickLimit: ClickLimitParam?
}

struct ClickLimitParam: Decodable {
    let buttons: [String]
    let maxCount: Int
}

struct IMEApproveParams: Decodable {
    let taskId: String
    /// call | task
    let scope: String
}

struct GrantRequestParams: Decodable {
    let taskId: String
    let bundleId: String
    let reason: String?
}

struct LaunchParams: Decodable {
    let taskId: String
    /// `app` (bundle ID or a granted app's display name, resolved like every action's) or the older `bundle_id`.
    let app: String?
    let bundleId: String?
    /// A file (absolute path) or http(s) address for the app to open (OpenTarget).
    let open: String?
}

struct PointParam: Decodable {
    let x: Double
    let y: Double
    let space: String?
    /// With `space: "zoom"`: the zoom the point is in (pixels of that zoom image).
    let zoomId: String?
}

struct RectParam: Decodable {
    let x: Double
    let y: Double
    let w: Double
    let h: Double
    let space: String?
}

struct ZoomParams: Decodable {
    let taskId: String
    let snapshotGen: Int?
    let elementId: String?
    let rect: RectParam?
    let ocr: Bool?
}

struct Target: Decodable {
    let elementId: String?
    let point: PointParam?

    static func single(_ elementId: String?, _ point: PointParam?) throws -> Target {
        guard (elementId == nil) != (point == nil) else {
            throw RPCFailure(.invalidParams, "give exactly one of element_id or point")
        }
        return Target(elementId: elementId, point: point)
    }
}

struct DebugActivateParams: Decodable {
    let taskId: String
    let app: String
    let method: String
    let timeout: Double?
}

struct DebugIMEParams: Decodable {
    let taskId: String
    let app: String
    /// probe | select (with `id`)
    let op: String
    let id: String?
}

struct ClickParams: Decodable {
    let taskId: String
    let app: String
    let snapshotGen: Int?
    let elementId: String?
    let point: PointParam?
    let button: String?
    let count: Int?
    /// auto (default) | ax | event
    let via: String?
}

struct ScrollParams: Decodable {
    let taskId: String
    let app: String
    let snapshotGen: Int?
    let elementId: String?
    let point: PointParam?
    let direction: String
    let amount: Double?
}

struct DragParams: Decodable {
    let taskId: String
    let app: String
    let snapshotGen: Int?
    let from: Target
    let to: Target
}

struct TypeParams: Decodable {
    let taskId: String
    let app: String
    let snapshotGen: Int?
    let text: String
    let elementId: String?
    /// Only "leave" (a downgrade: after an approval was refused or a switch failed); the grant's policy otherwise.
    let imePolicy: String?
    /// auto (default): with an element, set the value through AX when that is equivalent to typing it; type: always
    /// post key events; paste: through the clipboard and ⌘V (P4).
    let strategy: String?
}

struct KeyParams: Decodable {
    let taskId: String
    let app: String
    let chord: String
}

struct ElementValueParams: Decodable {
    let taskId: String
    let app: String
    let snapshotGen: Int?
    let elementId: String
    let value: String
}

struct MenuParams: Decodable {
    let taskId: String
    let app: String
    let path: [String]
    /// false: only list, even when the path ends at an item (default: press an item, list a menu).
    let press: Bool?
}

struct ElementActionParams: Decodable {
    let taskId: String
    let app: String
    let snapshotGen: Int?
    let elementId: String
    let action: String
}

struct AccessRequestParams: Decodable {
    let taskId: String
    /// A bundle ID or a name; the daemon resolves it and the dialog shows what it resolved to.
    let app: String
    /// read | full
    let mode: String
    /// The model's reason, shown as untrusted text.
    let reason: String?
    /// Whether a person can answer (the plugin has an approval UI). False: refused without a dialog.
    let interactive: Bool?
    /// Task settings for a grant this request creates (like grants.set).
    let electronAx: Bool?
    let imePolicy: String?
    /// The person's language for the dialog (dsh's locale.preference); else the system's.
    let lang: String?
}

struct AccessStatusParams: Decodable {
    let taskId: String
    let requestId: String
}
