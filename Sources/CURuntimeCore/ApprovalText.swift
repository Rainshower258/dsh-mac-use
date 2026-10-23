import Foundation

/// The language the person reads the daemon's dialogs in. The plugin sends dsh's own setting (`locale.preference`);
/// without one (a request from elsewhere, dsh left to the browser) the system's first preferred language decides.
/// Chinese and English only, as dsh ships; anything else reads English (1a, 2026-10-10: an English-language Mac got a
/// Chinese-only dialog, data-egress warning included).
public enum UILanguage: String, Sendable, Equatable {
    case zh, en

    public static func resolve(_ tag: String?, system: [String] = Locale.preferredLanguages) -> UILanguage {
        let chosen = tag.flatMap { $0.isEmpty ? nil : $0 } ?? system.first ?? "en"
        return chosen.lowercased().hasPrefix("zh") ? .zh : .en
    }
}

/// Everything the approval dialog says, per language. Pure, so both languages are tested for the same content: the
/// app's identity, what the mode allows, the data-egress warning, the model's reason marked untrusted, the buttons
/// in the order the presenter maps to answers (refuse, turn, session, always).
public struct ApprovalText: Equatable, Sendable {
    public let title: String
    public let lines: [String]
    public let buttons: [String]
    public let lang: UILanguage

    public init(_ r: DialogRequest) {
        lang = r.lang
        let zh = r.lang == .zh
        let name = r.identity.name
        title = zh ? "允许 computer use 使用「\(name)」？" : "Allow computer use to use “\(name)”?"
        let mode = switch (r.mode, zh) {
        case (.read, true):
            "浏览：查看窗口、左键单击、滚动、按下按钮（包括“发送”这类按钮）、把窗口提到前面（没有窗口时重开一个）；不能输入文字、按键、设值，也不能启动没在运行的应用"
        case (.read, false):
            "Browse: see its windows, left-click, scroll, press buttons (including ones like “Send”), bring a window to the "
            + "front (reopen one if there is none); no typing, keys or setting values, and it cannot start the app if it is not running"
        case (.full, true):
            "可操作：查看、点击、滚动，并且可以输入文字、按键（包括 ⌘Q 退出）、设值，以及在它没开时打开它"
        case (.full, false):
            "Operate: see, click and scroll, and also type, press keys (⌘Q, which quits, included), set values, and open "
            + "it when it is not running"
        }
        var lines = zh
            ? ["应用：\(name)", "Bundle ID：\(r.identity.bundleID)", "位置：\(r.identity.path)", "档位：\(mode)"]
            : ["App: \(name)", "Bundle ID: \(r.identity.bundleID)", "Location: \(r.identity.path)", "Mode: \(mode)"]
        // Who asks: the dsh process, normally. A first request from a process is said so, since a program outside
        // dsh that reaches the socket can ask too (M4): if the person did not just ask dsh for screen work, refuse.
        if let who = r.requester {
            lines.append(zh ? "申请者：\(who)" : "Asked by: \(who)")
            if r.firstFromRequester {
                lines.append(zh ? "这是这个进程第一次申请。如果你刚才没有让 dsh 操作屏幕，请拒绝。"
                                : "This is the first request from this process. If you did not just ask dsh to work on the screen, refuse.")
            }
        } else {
            lines.append(zh ? "申请者：未知进程。如果你刚才没有让 dsh 操作屏幕，请拒绝。"
                            : "Asked by: an unknown process. If you did not just ask dsh to work on the screen, refuse.")
        }
        if !r.running {
            let notRunning = switch (r.mode, zh) {
            case (.full, true): "它现在没在运行。批准后模型可以打开它。"
            case (.read, true): "它现在没在运行。浏览档不能打开它，要你自己打开。"
            case (.full, false): "It is not running now. If you approve, the model can open it."
            case (.read, false): "It is not running now. Browse cannot open it: you have to open it yourself."
            }
            lines.append(notRunning)
        }
        lines += zh
            ? ["", "批准后，该应用窗口中的内容（截图、AX 文字、OCR 结果）会发送给模型服务商。", "",
               "模型的说法（不可信，可能被屏幕上的文字操纵）：", r.reason.map { "“\($0)”" } ?? "（模型未说明）"]
            : ["", "If you approve, what this app's windows show (screenshots, accessibility text, OCR) is sent to the model provider.", "",
               "What the model says (untrusted: text on the screen can steer it):", r.reason.map { "“\($0)”" } ?? "(no reason given)"]
        if r.offerAlways && r.mode == .full {
            lines.append(zh ? "选“始终允许”要先通过 Touch ID 或密码验证。"
                            : "“Always allow” first asks for Touch ID or your password.")
        }
        self.lines = lines
        buttons = (zh ? ["拒绝", "仅本轮", "本次会话"] : ["Refuse", "This turn", "This session"])
            + (r.offerAlways ? [zh ? "始终允许" : "Always allow"] : [])
    }

    /// The live countdown under the text.
    public func countdown(_ seconds: Int) -> String {
        lang == .zh ? "\(seconds) 秒后自动拒绝" : "Refused automatically in \(seconds) s"
    }
}
