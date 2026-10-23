@testable import CURuntimeCore
import XCTest

/// The approval dialog in both languages (1a, 2026-10-10: an English-language Mac got a Chinese-only dialog).
final class ApprovalTextTests: XCTestCase {
    private let qq = AppIdentity(bundleID: "com.tencent.qq", name: "QQ", path: "/Applications/QQ.app")

    private func text(_ lang: UILanguage, mode: AppMode = .read, reason: String? = "read the pinned chat",
                      always: Bool = true, running: Bool = true) -> ApprovalText {
        ApprovalText(DialogRequest(identity: qq, mode: mode, reason: reason, offerAlways: always, timeout: 120,
                                   running: running, lang: lang))
    }

    func testBothLanguagesSayTheSameThings() {
        for lang in [UILanguage.zh, .en] {
            for mode in [AppMode.read, .full] {
                let t = text(lang, mode: mode, always: true, running: false)
                let all = ([t.title] + t.lines).joined(separator: "\n")
                for needle in ["QQ", "com.tencent.qq", "/Applications/QQ.app", "“read the pinned chat”"] {
                    XCTAssertTrue(all.contains(needle), "\(lang)/\(mode): \(needle)")
                }
                XCTAssertTrue(all.contains(lang == .zh ? "会发送给模型服务商" : "is sent to the model provider"),
                              "\(lang)/\(mode): the data-egress warning")
                XCTAssertTrue(all.contains(lang == .zh ? "不可信" : "untrusted"), "\(lang)/\(mode): the reason is marked untrusted")
                XCTAssertTrue(all.contains(lang == .zh ? "没在运行" : "not running"), "\(lang)/\(mode)")
                XCTAssertEqual(t.buttons.count, 4, "\(lang)/\(mode): refuse, turn, session, always")
                if mode == .full {
                    XCTAssertTrue(all.contains(lang == .zh ? "Touch ID" : "Touch ID"), "\(lang): always for full passes the owner check")
                }
                XCTAssertEqual(text(lang, mode: mode, always: false, running: false).buttons.count, 3, "\(lang)/\(mode): unsigned app")
            }
        }
        XCTAssertEqual(text(.zh).buttons, ["拒绝", "仅本轮", "本次会话", "始终允许"])
        XCTAssertEqual(text(.en).buttons, ["Refuse", "This turn", "This session", "Always allow"])
        XCTAssertFalse(([text(.en).title] + text(.en).lines + text(.en).buttons).joined().contains { ("\u{4e00}"..."\u{9fff}").contains($0) },
                       "no Chinese in the English dialog")
        XCTAssertTrue(text(.en, reason: nil).lines.contains("(no reason given)"))
        XCTAssertEqual(text(.en).countdown(7), "Refused automatically in 7 s")
        XCTAssertEqual(text(.zh).countdown(7), "7 秒后自动拒绝")
    }

    func testLanguageComesFromTheRequestElseTheSystem() {
        XCTAssertEqual(UILanguage.resolve("zh", system: ["en-US"]), .zh)
        XCTAssertEqual(UILanguage.resolve("en", system: ["zh-Hans-CN"]), .en, "dsh's setting wins over the system")
        XCTAssertEqual(UILanguage.resolve(nil, system: ["zh-Hans-CN", "en-US"]), .zh)
        XCTAssertEqual(UILanguage.resolve("", system: ["en-US"]), .en)
        XCTAssertEqual(UILanguage.resolve(nil, system: ["fr-FR"]), .en, "only Chinese and English: anything else reads English")
        XCTAssertEqual(UILanguage.resolve(nil, system: []), .en)
    }
}
