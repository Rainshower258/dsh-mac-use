import CURuntimeCore
import Foundation

// MARK: - The settings window's text (SettingsWindow.swift), by language

/// The strings, by language (ApprovalText does the same for the dialog). Written language, no second person
/// (the maintainer's review of the design, 2026-10-16).
struct SettingsStrings {
    let lang: UILanguage
    private func t(_ zh: String, _ en: String) -> String { lang == .zh ? zh : en }

    var title: String { t("CURuntime 设置", "CURuntime Settings") }
    var overview: String { t("概览", "Overview") }
    var overviewNote: String { t("守护进程状态、正在生效的授权与最近拦截记录。", "Daemon state, approvals in effect and recent refusals.") }
    var apps: String { t("应用名单", "App lists") }
    var appsNote: String { t("三份名单，由宽到严：始终允许、黑名单、系统底线。同一应用出现在多份名单时，按最严格的一份处理。", "Three lists, loosest to strictest: always allowed, the deny list, the system floor. An app on several lists gets the strictest.") }
    var stopAndRevoke: String { t("停止并撤销全部授权", "Stop and revoke every approval") }
    var onlyHere: String { t("设置可在本窗口或 dsh 插件页修改；放宽类改动须在本机完成身份验证。", "Settings change in this window or on dsh's plugin page; a change that loosens one needs verification on this Mac.") }
    var daemon: String { t("守护进程", "Daemon") }
    var running: String { t("运行中", "Running") }
    var uptime: String { t("已运行", "Up for") }
    var noAutostart: String { t("不随系统启动", "Does not start at login") }
    var stop: String { t("停止", "Stop") }
    var restart: String { t("重启", "Restart") }
    var selfCheck: String { t("运行自检", "Run self-check") }
    var selfCheckRunning: String { t("自检中…", "Checking…") }
    func selfCheckOK(ms: Int) -> String { t("自检通过 · 截屏 \(ms) ms", "Self-check passed · capture \(ms) ms") }
    func selfCheckFailed(_ why: String) -> String { t("自检失败：\(why)", "Self-check failed: \(why)") }
    var axUntrusted: String { t("辅助功能未授予", "Accessibility not granted") }
    var permissions: String { t("系统权限", "System permissions") }
    var accessibility: String { t("辅助功能", "Accessibility") }
    var screenRecording: String { t("屏幕录制", "Screen Recording") }
    var inputMonitoring: String { t("输入监控", "Input Monitoring") }
    var granted: String { t("已授予", "Granted") }
    var missing: String { t("未授予", "Not granted") }
    var notRequested: String { t("未申请", "Not requested") }
    var openSystemSettings: String { t("打开系统设置", "Open System Settings") }
    var inputMonitoringNote: String { t("当前版本不需要输入监控。", "This version does not need Input Monitoring.") }
    var newSessionDefault: String { t("新会话默认", "New session default") }
    var askEveryTime: String { t("每次询问", "Ask every time") }
    var newSessionNote: String { t("名单外的应用首次被访问时弹出申请。", "An app not on a list is asked about the first time it is touched.") }
    func newSessionGranted(_ m: DefaultMode) -> String { t("名单外的应用首次被访问时，本次会话内直接按「\(defaultModeName(m))」放行。", "An app not on a list gets “\(defaultModeName(m))” for the session the first time it is touched.") }
    var activeGrants: String { t("正在生效的授权", "Approvals in effect") }
    var noneActive: String { t("现在没有生效的授权。", "No approval is in effect now.") }
    var revokeAll: String { t("全部撤销", "Revoke all") }
    var revoke: String { t("撤销", "Revoke") }
    var app: String { t("应用", "App") }
    var mode: String { t("档位", "Mode") }
    var until: String { t("时效", "Lasts") }
    var source: String { t("来源", "Source") }
    var read: String { t("浏览", "Browse") }
    var full: String { t("可操作", "Operate") }
    var configGrant: String { t("配置授权", "Config grant") }
    var scopeTurn: String { t("仅本轮", "This turn") }
    var scopeSession: String { t("本次会话", "This session") }
    var scopeAlways: String { t("始终允许", "Always") }
    var left: String { t("剩", "left") }
    var byDialog: String { t("弹窗批准", "Approved in a dialog") }
    var session: String { t("会话", "session") }
    var processGone: String { t("进程已退出", "process exited") }
    var process: String { t("进程", "process") }
    var recentRefusals: String { t("最近拦截", "Recent refusals") }
    var refusalsNote: String { t("来源：审计日志，仅记录动作与原因，不含屏幕内容 · 保留最近 100 条。", "From the audit log: actions and reasons only, never screen text · the last 100.") }
    var noRefusals: String { t("近两天没有拦截记录。", "Nothing refused in the last two days.") }
    var yesterday: String { t("昨天", "yest.") }
    var time: String { t("时间", "Time") }
    var what: String { t("操作", "Action") }
    var why: String { t("原因", "Reason") }
    var always: String { t("始终允许", "Always allowed") }
    var alwaysNote: String { t("按 bundle ID 与应用签名记录；签名变化后授权自动作废。可在此添加，或在申请弹窗中选择「始终允许」，或在终端中添加；加入需 Touch ID 或密码。", "Recorded by bundle ID and code signature; a changed signature voids the entry. Added with “Always allow” in the dialog (Touch ID or password for operate) or in the terminal.") }
    var noneAlways: String { t("名单是空的。", "The list is empty.") }
    var addToAlways: String { t("添加到始终允许…", "Add to always allowed…") }
    var addToAlwaysNote: String { t("加入后，模型在任何会话中都可按所选档位使用该应用，不再弹窗；应用重新签名后自动作废。", "Once added, the model may use the app at the chosen mode in every session without a dialog; a re-signed app voids the entry.") }
    var alwaysReason: String { t("加入始终允许名单属于放宽操作，需要身份验证。", "Adding to the always list loosens things: verify it is you.") }
    var signature: String { t("签名", "Signature") }
    var signatureOK: String { t("匹配", "Matches") }
    var signatureChanged: String { t("签名已变化 · 已作废", "Signature changed · void") }
    var remove: String { t("移除", "Remove") }
    var denylist: String { t("黑名单", "Deny list") }
    var denylistNote: String { t("模型无法观察或操作这些应用，也不会发出申请。加入立即生效；移出需要身份验证。", "The model cannot see, touch or ask about these. Adding takes effect at once; removing needs the user to verify.") }
    var noneDenied: String { t("黑名单是空的。", "The deny list is empty.") }
    var addToDenylist: String { t("添加到黑名单…", "Add to deny list…") }
    var removeFromDenylist: String { t("移出…", "Remove…") }
    var note: String { t("备注", "Note") }
    var addedAt: String { t("加入时间", "Added") }
    var floor: String { t("系统底线", "System floor") }
    var floorNote: String { t("内置于守护进程，任何设置均不能修改：永不授权，且它们位于前台时所有动作停止。", "Compiled into the daemon; no setting changes it: never granted, and every action stops while one is in front.") }
    var items: String { t("项", "entries") }
    var bundleID: String { t("Bundle ID", "Bundle ID") }
    var chooseApp: String { t("选择应用…", "Choose app…") }
    var runningApps: String { t("正在运行的应用", "Running apps") }
    var add: String { t("加入", "Add") }
    var cancel: String { t("取消", "Cancel") }
    var denyReason: String { t("移出黑名单属于放宽操作，需要身份验证。", "Removing from the deny list loosens things: verify it is you.") }
    var stopReason: String { t("撤销全部授权并退出守护进程。dsh 不会自动重新启动它：再次使用屏幕前需先打开 CURuntime（open ~/Applications/CURuntime.app）。", "Revoke every approval and quit the daemon. dsh does not start it again by itself: to use the screen again, open CURuntime first (open ~/Applications/CURuntime.app).") }
    var stopDaemonReason: String { t("退出守护进程。正在生效的授权随之失效；dsh 不会自动重新启动它。", "Quit the daemon. Approvals in effect end with it; dsh does not start it again by itself.") }
    var restartReason: String { t("退出并重新启动守护进程。正在生效的授权随之失效。", "Quit and start the daemon again. Approvals in effect end with it.") }
    var notAnApp: String { t("当前不是以应用包运行，无法重启。", "Not running as an app bundle; cannot restart.") }
    var waiting: String { t("正在等守护进程…", "Waiting for the daemon…") }
    var version: String { t("版本", "Version") }
    var verifyFailed: String { t("没有通过验证，没有改动。", "Not verified; nothing changed.") }
    var verifyBusy: String { t("已有一项验证正在进行，请先完成或取消。此次点击未生效。", "A verification is already open; finish or cancel it first. This change was not made.") }
    var pid: String { "PID" }

    // The modes-and-defaults page (batch 1, 2026-10-16).
    var access: String { t("档位与默认", "Modes and defaults") }
    var accessNote: String { t("收紧立即生效。放宽（提高档位、延长时效、增加弹窗次数）需 Touch ID 或密码确认。", "Tightening takes effect at once. Loosening (a higher mode, a longer session, more dialogs) needs Touch ID or the password.") }
    var tierReadTitle: String { t("查看、点击、滚动", "Look, click, scroll") }
    var tierReadItems: [String] { [t("截图、界面结构、读字、放大", "Screenshots, the UI tree, text, zoom"), t("左键单击、按下按钮（含“发送”）", "Left click, press buttons (including “Send”)"), t("将已运行应用的窗口置于前台", "Bring a running app's window to the front"), t("不能输入文字或使用快捷键", "No typing, no shortcuts")] }
    var tierFullTitle: String { t("在浏览基础上可输入与操作", "Browse, and type and operate") }
    var tierFullItems: [String] { [t("输入文字、设值、允许列表内的快捷键", "Type, set values, allowlisted shortcuts"), t("打开应用、⌘Q 退出应用", "Open apps, quit with ⌘Q"), t("使用应用菜单", "Use the app's menus"), t("申请弹窗不提供“始终允许”", "The dialog offers no “always” for it")] }
    var tierMaxTitle: String { t("不弹申请窗口，高危操作需确认", "No approval dialogs; risky actions confirmed") }
    var tierMaxItems: [String] { [t("仅可在「完全放权」页由用户开启", "Switched on by the user, on its own page only"), t("模型无法申请此档位", "The model cannot ask for it"), t("有时限，到期自动关闭", "Time-limited; ends by itself"), t("系统底线仍然拒绝", "The system floor still refuses")] }
    var fullPower: String { t("完全放权", "Full power") }
    var notYet: String { t("尚未提供", "Not available yet") }
    var defaultModeTitle: String { t("默认档位", "Default mode") }
    var defaultModeNote: String { t("名单外的应用首次被访问时：「每次询问」弹出申请；「浏览」或「可操作」在本次会话内按该档位直接放行，更高的档位仍需申请。", "An app outside every list, the first time it is touched: “ask” shows the dialog; “browse” or “operate” grants that mode for the session without one, and a higher mode still asks.") }
    var defaultModeLock: String { t("提高需验证 · 完全放权不能设为默认", "Raising needs verification · full power is never the default") }
    var sessionTitle: String { t("「本次会话」最长", "“This session” lasts at most") }
    var sessionNote: String { t("到期或会话结束，以先到者为准；对之后的授权生效。「仅本轮」固定为本轮对话结束。", "Until it expires or the session ends, whichever is first; applies to approvals from now on. “This turn” always ends with the turn.") }
    var sessionLock: String { t("延长需验证", "Lengthening needs verification") }
    func minutes(_ m: Int) -> String { t("\(m) 分钟", "\(m) min") }
    var dialogsTitle: String { t("每轮最多弹窗", "Dialogs per turn at most") }
    var dialogsNote: String { t("超出后直接拒绝，避免频繁弹窗导致习惯性允许。", "Beyond that, refused without asking: a flood of dialogs trains people to click allow.") }
    var dialogsLock: String { t("增加需验证", "More needs verification") }
    func times(_ n: Int) -> String { t("\(n) 次", n == 1 ? "1" : "\(n)") }
    var timeoutTitle: String { t("超时处理", "Unanswered dialog") }
    var timeoutNote: String { t("倒计时结束按拒绝处理。", "When the countdown ends it counts as a refusal.") }
    func seconds(_ s: Int) -> String { t("\(s) 秒", "\(s) s") }
    var defaultButtonTitle: String { t("默认按钮", "Default button") }
    var defaultButtonNote: String { t("申请弹窗中回车键按下的按钮。「始终允许」在弹窗不提供它时退为「本次会话」。", "The button Return presses in the approval dialog. “Always” falls back to “this session” when the dialog does not offer it.") }
    var defaultButtonLock: String { t("拒绝以外需验证", "Anything but refuse needs verification") }
    func dialogDefaultName(_ d: DialogDefault) -> String {
        switch d {
        case .deny: return t("拒绝", "Refuse")
        case .turn: return scopeTurn
        case .session: return scopeSession
        case .always: return scopeAlways
        }
    }
    var fixedRules: String { t("固定规则（不能在设置里改）", "Fixed rules (not settings)") }
    var fixedRuleItems: [String] { [
        t("模型仅在被拒绝后可附理由申请一次；同一次拒绝只能申请一次。", "The model may ask once, with a reason, only after a refusal; once per refusal."),
        t("本轮已拒绝的应用，本轮不再弹窗；下一条消息起方可重新申请。", "An app refused this turn is not asked about again this turn; the next message may ask again."),
        t("弹窗显示系统解析的应用身份（图标、名称、bundle ID、路径）；模型提供的理由标注为“模型陈述”。", "The dialog shows the app's identity as the system resolves it (icon, name, bundle ID, path); the model's reason is marked as its own words."),
        t("系统底线中的应用不弹窗，直接拒绝。", "Apps on the system floor are refused without a dialog."),
    ] }
    var accessVerifyReason: String { t("放宽授权规则需要身份验证。", "Loosening the access rules needs verification.") }
    var changeMode: String { t("改档位", "Change mode") }
    var raiseReason: String { t("提高到可操作需要身份验证。", "Raising to operate needs verification.") }
    var reapprove: String { t("重新批准…", "Approve again…") }
    var reapproveReason: String { t("重新批准属于放宽操作，需要身份验证。", "Approving again loosens things: verify it is you.") }
    var editDefaults: String { t("修改默认档位", "Change the default mode") }
    func defaultModeName(_ m: DefaultMode) -> String {
        switch m {
        case .ask: return t("每次询问", "Ask every time")
        case .read: return read
        case .full: return full
        }
    }
    // The shortcuts page (batch 2, 2026-10-17).
    var shortcuts: String { t("快捷键", "Shortcuts") }
    var shortcutsNote: String { t("仅可操作档可以使用快捷键。不带修饰键或仅带 ⇧ 的按键（字母、回车、Tab、方向键等）始终可用；带 ⌘ ⌃ ⌥ 的组合仅放行下列项。", "Only the operate mode may press shortcuts. Keys without a modifier or with ⇧ alone (letters, Return, Tab, arrows…) are always allowed; combinations with ⌘ ⌃ ⌥ only when listed below.") }
    var builtinChords: String { t("内置允许", "Built in") }
    var builtinChordsNote: String { t("编辑与光标移动的常用组合。点击一项即停用（立即生效）；再点一次恢复，需 Touch ID 或密码。不能删除。", "Common editing and cursor combinations. They can be switched off, not removed; off at once, on again verified.") }
    var customChords: String { t("自定义", "Added by the user") }
    var customChordsNote: String { t("可限定仅在指定应用内生效。添加需验证，删除立即生效。", "May be limited to one app. Adding is verified; removing takes effect at once.") }
    var noneCustom: String { t("还没有自定义快捷键。", "No shortcut has been added.") }
    var everyApp: String { t("所有已授权应用", "Every approved app") }
    func onlyIn(_ app: String) -> String { t("仅 \(app)", "\(app) only") }
    var addChord: String { t("添加快捷键…", "Add a shortcut…") }
    var addChordTitle: String { t("添加快捷键", "Add a shortcut") }
    var combo: String { t("组合键", "Combination") }
    var comboHint: String { t("点击后按下组合键，或在右侧按 cmd+shift+k 的写法输入。", "Click, then press the combination; or type it on the right as cmd+shift+k.") }
    var comboPlaceholder: String { t("点击后按下组合键", "Click, then press") }
    var comboManual: String { t("或手动输入", "or type") }
    var scope: String { t("在哪里生效", "Where it applies") }
    var oneApp: String { t("仅一个应用", "One app") }
    var chordNote: String { t("说明", "Note") }
    var chordNotePlaceholder: String { t("例如：加粗", "e.g. bold") }
    var addVerified: String { t("验证并添加", "Verify and add") }
    var chordAddReason: String { t("添加快捷键属于放宽操作，需要身份验证。", "Adding a shortcut loosens things: verify it is you.") }
    var chordEnableReason: String { t("重新启用快捷键属于放宽操作，需要身份验证。", "Switching a shortcut on again loosens things: verify it is you.") }
    var neverChords: String { t("永不允许", "Never allowed") }
    var neverChordsNote: String { t("影响整机或其他应用的组合。不可添加；完全放权下同样拒绝。", "Combinations that reach the whole machine or other apps. Cannot be added; refused under full power too.") }
    var fKeys: String { t("F1–F12 功能键", "F1–F12") }
    var fnCombos: String { t("fn 组合键", "fn combinations") }
    var off: String { t("已停用", "off") }
    var chordOffHelp: String { t("点击后：此快捷键立即停用，模型不能再按它。之后再点一次可恢复，恢复需要 Touch ID 或密码。", "Click: this shortcut is switched off at once and the model can no longer press it. Clicking again switches it back on, with Touch ID or the password.") }
    var chordOnHelp: String { t("已停用，模型不能按它。点击后：弹出 Touch ID 或密码验证，通过即恢复允许；取消则保持停用。", "Off: the model cannot press it. Click: Touch ID or the password is asked; passing switches it back on, cancelling leaves it off.") }
    func chordError(_ reason: String, _ detail: String) -> String {
        switch reason {
        case "chord_never_allowed": return t("无法添加：该组合会影响授权范围之外的窗口或系统功能。", "Cannot be added: it reaches outside the approved window or into system functions.")
        case "chord_builtin": return t("无需添加：该组合已在允许范围内。", "No need: it is allowed already.")
        case "invalid_chord": return t("无法识别的组合键：\(detail)", "Not a recognisable combination: \(detail)")
        default: return "\(reason): \(detail)"
        }
    }
    /// What a built-in or never-allowed chord does, for the chips.
    func chordLabel(_ chord: String) -> String? {
        let zh: [String: String] = [
            "cmd+a": "全选", "cmd+c": "拷贝", "cmd+v": "粘贴", "cmd+x": "剪切", "cmd+z": "撤销", "shift+cmd+z": "重做",
            "cmd+f": "查找", "cmd+g": "查找下一个", "cmd+w": "关闭窗口", "cmd+n": "新建", "cmd+s": "存储", "cmd+q": "退出应用",
            "cmd+delete": "删到行首", "cmd+l": "地址栏", "shift+cmd+t": "恢复标签 / 纯文本", "cmd+b": "粗体", "cmd+i": "斜体", "cmd+u": "下划线",
            "shift+cmd+left": "选到行首", "shift+cmd+right": "选到行尾", "shift+cmd+up": "选到文首", "shift+cmd+down": "选到文末",
            "opt+shift+left": "按词选择", "opt+shift+right": "按词选择", "opt+left": "按词移动", "opt+right": "按词移动",
            "opt+up": "按段移动", "opt+down": "按段移动", "cmd+left": "行首", "cmd+right": "行尾", "cmd+up": "文首", "cmd+down": "文末",
            "ctrl+cmd+q": "锁屏", "shift+cmd+q": "注销", "opt+cmd+escape": "强制退出", "cmd+space": "聚焦", "ctrl+space": "切换输入法",
            "cmd+tab": "切换应用", "opt+cmd+h": "隐藏其他", "shift+cmd+3": "截屏", "shift+cmd+4": "截屏", "shift+cmd+5": "截屏",
            "ctrl+up": "调度中心", "ctrl+down": "应用窗口", "ctrl+left": "切换空间", "ctrl+right": "切换空间", "opt+cmd+d": "隐藏程序坞", "ctrl+f2": "焦点到菜单栏",
        ]
        let en: [String: String] = [
            "cmd+a": "select all", "cmd+c": "copy", "cmd+v": "paste", "cmd+x": "cut", "cmd+z": "undo", "shift+cmd+z": "redo",
            "cmd+f": "find", "cmd+g": "find next", "cmd+w": "close window", "cmd+n": "new", "cmd+s": "save", "cmd+q": "quit",
            "cmd+delete": "delete to line start", "cmd+l": "address bar", "shift+cmd+t": "reopen tab / plain text", "cmd+b": "bold", "cmd+i": "italic", "cmd+u": "underline",
            "shift+cmd+left": "select to line start", "shift+cmd+right": "select to line end", "shift+cmd+up": "select to start", "shift+cmd+down": "select to end",
            "opt+shift+left": "select by word", "opt+shift+right": "select by word", "opt+left": "move by word", "opt+right": "move by word",
            "opt+up": "move by paragraph", "opt+down": "move by paragraph", "cmd+left": "line start", "cmd+right": "line end", "cmd+up": "start", "cmd+down": "end",
            "ctrl+cmd+q": "lock screen", "shift+cmd+q": "log out", "opt+cmd+escape": "force quit", "cmd+space": "Spotlight", "ctrl+space": "input source",
            "cmd+tab": "switch app", "opt+cmd+h": "hide others", "shift+cmd+3": "screenshot", "shift+cmd+4": "screenshot", "shift+cmd+5": "screenshot",
            "ctrl+up": "Mission Control", "ctrl+down": "app windows", "ctrl+left": "switch space", "ctrl+right": "switch space", "opt+cmd+d": "hide the Dock", "ctrl+f2": "focus the menu bar",
        ]
        return (lang == .zh ? zh : en)[chord]
    }

    // The privacy-and-audit page (batch 3, 2026-10-17).
    var privacy: String { t("隐私与审计", "Privacy and audit") }
    var privacyNote: String { t("已授权应用窗口的内容将发送至模型服务商（当前为 DeepSeek）。本页配置发送范围、审计记录与保留期限。", "What is inside an approved app's windows goes to the model's provider (DeepSeek now). This page sets what is sent, what is recorded and for how long.") }
    var sentContent: String { t("发送内容", "Sent content") }
    var sentContentLock: String { t("关闭立即生效 · 开启需验证", "Off at once · on again verified") }
    var sendScreenshots: String { t("截图", "Screenshots") }
    var sendScreenshotsNote: String { t("仅包含已授权应用窗口，其余区域遮蔽。关闭后仅发送文本。", "Only approved apps' windows; the rest is grey. Off, the model gets text only.") }
    var sendAXText: String { t("界面文本", "UI text") }
    var sendAXTextNote: String { t("控件标题、消息内容等。关闭后仅发送控件位置与类型。", "Button titles, message text and the like. Off, the tree carries positions and roles only.") }
    var sendOCR: String { t("本地识别文本（OCR）", "Locally recognised text (OCR)") }
    var sendOCRNote: String { t("识别在本地完成，仅发送结果。", "Recognised here; only the result is sent.") }
    var sendZoom: String { t("局部放大图", "Zoomed images") }
    var sendZoomNote: String { t("模型核对细节时请求的局部高分辨率图像。", "The close-ups the model asks for to read small text or an emoji.") }
    var textOnlyApps: String { t("仅文本应用", "Text-only apps") }
    var textOnlyAppsNote: String { t("列表内的应用不发送截图。加入立即生效，移除需验证。", "Even approved, no screenshot of these leaves this Mac. Adding is at once; removing verified.") }
    var addApp: String { t("添加应用…", "Add app…") }
    var noTextOnlyApps: String { t("暂无。", "None.") }
    var clipboard: String { t("剪贴板", "Clipboard") }
    var clearClipboard: String { t("每轮开始时清空剪贴板", "Empty the clipboard when a turn starts") }
    var clearClipboardNote: String { t("避免模型粘贴用户此前复制的内容。", "So the model cannot paste what was copied before with ⌘V.") }
    var auditLog: String { t("审计日志", "Audit log") }
    var retention: String { t("保留期限", "Kept for") }
    var retentionNote: String { t("按天分文件，含当天在内保留所选天数，更早的自动删除。", "One file a day; the chosen number of days is kept, today included, and older files are deleted.") }
    var retentionVerifyReason: String { t("缩短保留期限会立即删除较早的审计日志，需要身份验证。", "A shorter retention deletes older audit files at once: verify it is you.") }
    func days(_ n: Int) -> String { t("\(n) 天", "\(n) days") }
    var recorded: String { t("记录内容", "What is recorded") }
    var recordedNote: String { t("放行与拒绝的动作及原因、授权与撤销、设置变更。不记录屏幕内容与模型理由原文（仅记录长度）。", "Every allowed and refused action with its reason, approvals and revocations, settings changes. Never screen content, never the model's reason text (its length only).") }
    var fixed: String { t("固定", "Fixed") }
    var location: String { t("位置", "Location") }
    var exportWeek: String { t("导出最近 7 天", "Export the last 7 days") }
    var exportDone: String { t("已导出。", "Exported.") }
    var recentChanges: String { t("最近设置变更", "Recent settings changes") }
    var noChanges: String { t("近 7 天没有设置变更。", "No settings change in the last 7 days.") }
    var privacyVerifyReason: String { t("开启发送内容或移出仅文本应用属于放宽操作，需要身份验证。", "Sending that content again, or removing an app from the text-only list, loosens things: verify it is you.") }
    var verifiedTag: String { t("已验证", "verified") }

    /// A settings change in words, from its audit line.
    func describe(_ c: AuditSettingsChange, appName: (String) -> String) -> String {
        let app = c.fields["app"]?.stringValue.map { "「\(appName($0))」" } ?? ""
        let chord = c.fields["chord"]?.stringValue ?? ""
        let mode = c.fields["mode"]?.stringValue.map { $0 == "full" ? full : read } ?? ""
        switch c.method {
        case "settings.denylist_add": return t("黑名单加入\(app)", "Deny list: \(app) added")
        case "settings.denylist_remove": return t("黑名单移出\(app)", "Deny list: \(app) removed")
        case "settings.persistent_add": return t("始终允许加入\(app) · \(mode)", "Always allowed: \(app) added · \(mode)")
        case "settings.persistent_revoke": return t("始终允许移除\(app)", "Always allowed: \(app) removed")
        case "settings.persistent_mode":
            let to = c.fields["to"]?.stringValue == "full" ? full : read
            return t("\(app)的始终允许档位改为\(to)", "Always allowed: \(app) set to \(to)")
        case "settings.persistent_reapprove": return t("重新批准\(app)", "\(app) approved again")
        case "settings.access": return t("授权规则变更", "Access rules changed")
        case "settings.privacy": return t("隐私设置变更", "Privacy settings changed")
        case "settings.chord_disable": return t("停用快捷键 \(chord)", "Shortcut \(chord) switched off")
        case "settings.chord_enable": return t("启用快捷键 \(chord)", "Shortcut \(chord) switched on")
        case "settings.chord_add": return t("添加快捷键 \(chord)\(app.isEmpty ? "" : "（仅\(app)）")", "Shortcut \(chord) added\(app.isEmpty ? "" : " (\(app) only)")")
        case "settings.chord_remove": return t("删除快捷键 \(chord)", "Shortcut \(chord) removed")
        case "settings.revoke": return t("撤销一项授权", "An approval revoked")
        case "settings.revoke_all": return t("撤销全部授权", "Every approval revoked")
        case "settings.behavior": return t("行为设置变更", "Behavior settings changed")
        case "settings.import": return t("导入设置", "Settings imported")
        case "settings.reset": return t("恢复默认设置", "Defaults restored")
        case "settings.audit_export": return t("导出审计日志", "Audit exported")
        case "settings.logs": return t("日志设置变更", "Log settings changed")
        case "settings.export": return t("导出设置", "Settings exported")
        case "settings.stop": return t("停止守护进程", "Daemon stopped")
        case "settings.restart": return t("重启守护进程", "Daemon restarted")
        default: return c.method
        }
    }

    // The behavior-and-model page (batch 4, 2026-10-17).
    var behavior: String { t("行为与模型", "Behavior and model") }
    var behaviorNote: String { t("模型操作本机的方式，以及与用户同时操作时的让行规则。", "How the model operates this Mac, and how it yields when the user is operating too.") }
    var operation: String { t("操作", "Operation") }
    var restoreFocus: String { t("每轮结束后归还焦点", "Return the focus when a turn ends") }
    var restoreFocusNote: String { t("回到本轮开始时的前台应用；用户中途切换过则不再改变。", "Back to the app that was in front when the turn began; left alone if the user switched meanwhile.") }
    var pointTargets: String { t("允许按坐标点击", "Allow coordinate targets") }
    var pointTargetsNote: String { t("关闭后仅可点击已识别的界面元素；纯图像界面中的部分目标将无法点击。", "Off, only recognised elements can be clicked; some targets in image-only interfaces become unreachable.") }
    var imePolicy: String { t("中文输入法处理", "Input source handling") }
    var imePolicyNote: String { t("拼音输入存在未确认候选时，输入的字符会丢失。接管：本轮临时切换到英文键盘，结束后恢复。此处为上限，插件可要求更严格。", "With a pending pinyin candidate, typed characters are lost. Take over: switch to the ABC keyboard for the turn and switch back. This is the ceiling; the plugin may ask for less.") }
    func imePolicyName(_ p: ChangePolicy) -> String {
        switch p {
        case .leave: return t("不切换", "Leave")
        case .ask: return t("每次询问", "Ask")
        case .takeover: return t("本轮接管", "Take over")
        }
    }
    var electronAX: String { t("Electron 应用的无障碍开关", "Accessibility switch for Electron apps") }
    var electronAXNote: String { t("QQ 等应用需开启此项，界面结构中才包含消息文字。使用后自动恢复。", "QQ and the like need it for message text to appear in the UI tree. Restored afterwards.") }
    var behaviorVerifyReason: String { t("允许按坐标点击、提高输入法处理上限或开启 Electron 无障碍开关属于放宽操作，需要身份验证。", "Allowing coordinate targets, raising the input source ceiling or switching Electron accessibility on loosens things: verify it is you.") }
    var auto: String { t("自动", "Auto") }
    var offWord: String { t("关", "Off") }
    var advanced: String { t("高级", "Advanced") }
    var activation: String { t("激活应用的方式", "How apps are activated") }
    var activationNote: String { t("仅在激活持续失败时需要更改。", "Change it only when activation keeps failing.") }
    func activationName(_ m: ActivationMethod?) -> String {
        switch m {
        case .runningApplication, nil: return t("标准（推荐）", "Standard (recommended)")
        case .axFrontmost: return t("无障碍前台属性", "Accessibility frontmost attribute")
        case .axRaise: return t("无障碍窗口前置", "Accessibility window raise")
        }
    }
    var importExport: String { t("导入 / 导出设置", "Import / export settings") }
    var importExportNote: String { t("导入内容若比当前宽松，将逐项列出并需验证。黑名单随设置文件导入导出；始终允许名单不在其中。", "An import that loosens anything lists the items and needs verification. The deny list travels with the file; the always list does not.") }
    var importButton: String { t("导入…", "Import…") }
    var exportButton: String { t("导出…", "Export…") }
    var importLoosens: String { t("导入将放宽以下项，需要身份验证：", "The import loosens the following and needs verification:") }
    var importNothingLoosened: String { t("导入内容不比当前宽松，可直接应用。", "The import loosens nothing; it can be applied at once.") }
    var apply: String { t("应用", "Apply") }
    var applyVerified: String { t("验证并应用", "Verify and apply") }
    var importReason: String { t("导入的设置比当前宽松，需要身份验证。", "The imported settings loosen things: verify it is you.") }
    var resetDefaults: String { t("恢复默认设置", "Restore defaults") }
    var resetDefaultsNote: String { t("不清空黑名单与仅文本应用，不恢复已停用的快捷键；自定义快捷键将删除。", "Keeps the deny list, the text-only apps and the switched-off shortcuts; removes the added shortcuts.") }
    var resetButton: String { t("恢复默认设置…", "Restore defaults…") }
    var resetReason: String { t("恢复默认会放宽当前更严格的设置，需要身份验证。", "Restoring the defaults loosens stricter settings: verify it is you.") }
    var exported: String { t("已导出。", "Exported.") }
    var imported: String { t("已导入。", "Imported.") }

    // The logs page (2026-10-17).
    var logs: String { t("日志", "Logs") }
    var logsNote: String { t("守护进程的审计日志：每个操作的放行与拒绝、授权与撤销、设置变更、启动与停止。按天分文件。", "The daemon's audit log: every action allowed or refused, approvals and revocations, settings changes, starts and stops. One file a day.") }
    var logLocation: String { t("存放位置", "Location") }
    var logLocationNote: String { t("更改后现有日志随之迁移；日志写入所选文件夹下的 cu-runtime-logs 子目录，仅本用户可读。", "Changing it moves the existing files; the log is written to a cu-runtime-logs subfolder of the chosen folder, readable by this user only.") }
    var changeLocation: String { t("更改…", "Change…") }
    var useDefaultLocation: String { t("恢复默认位置", "Use the default location") }
    var openLogFolder: String { t("打开日志目录", "Open the log folder") }
    var defaultTag: String { t("默认", "default") }
    var missingFolder: String { t("文件夹不存在。", "the folder does not exist.") }
    var logFiles: String { t("当前文件", "Files now") }
    func fileCount(_ n: Int, _ bytes: Int64) -> String { t("\(n) 个文件 · \(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file))", "\(n) file(s) · \(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file))") }

    func category(_ c: HardDeny.Category) -> String {
        switch c {
        case .systemUI: return t("系统界面", "System UI")
        case .authentication: return t("认证与密钥", "Authentication and secrets")
        case .runsCode: return t("可执行代码", "Runs code")
        case .selfAndRemote: return t("CURuntime 本体与远程控制", "CURuntime itself and remote control")
        }
    }

    /// The refusal reasons the audit records, in words; an unknown one is shown as recorded.
    private var reasons: [String: String] {[
        "hard_denied": t("系统底线", "system floor"), "hard_denied_frontmost": t("系统底线", "system floor"),
        "user_denied": t("黑名单", "deny list"),
        "dsh_host_app": t("dsh 所在的应用", "the app dsh runs in"),
        "chord_not_allowed": t("快捷键不在允许列表", "chord not on the allowlist"), "invalid_chord": t("快捷键不在允许列表", "chord not on the allowlist"),
        "not_granted": t("没有授权", "no approval"), "no_grant": t("没有授权", "no approval"), "grant_expired": t("没有授权", "no approval"),
        "action_not_allowed": t("档位不够", "mode too narrow"), "click_not_allowed": t("档位不够", "mode too narrow"),
        "ax_action_not_allowed": t("档位不够", "mode too narrow"), "launch_not_allowed": t("档位不够", "mode too narrow"),
        "approval_rejected": t("用户已拒绝", "refused by the user"), "approval_refused_earlier": t("用户已拒绝", "refused by the user"),
        "approval_limit": t("本轮弹窗已到上限", "dialog limit this turn"),
        "approval_timeout": t("弹窗超时", "dialog timed out"),
        "secure_input": t("安全输入（密码框）", "secure input (password field)"),
        "hit_test_failed": t("点在授权窗口外", "outside the approved window"), "not_on_target_window": t("点在授权窗口外", "outside the approved window"),
        "not_on_granted_window": t("点在授权窗口外", "outside the approved window"),
        "open_not_allowed": t("文件不可打开", "file not openable"), "open_not_found": t("文件不可打开", "file not openable"),
        "ime_switch_needs_approval": t("输入法切换需确认", "input source switch needs approval"),
        "finder_not_enabled": t("未启用访达", "Finder not enabled"),
        "session_locked": t("屏幕已锁定", "screen locked"),
    ]}

    func reason(_ r: AuditRefusal) -> String { reasons[r.reason] ?? r.reason }

    func attempted(_ r: AuditRefusal, appName: (String) -> String) -> String {
        let app = r.app.map { "「\(appName($0))」" } ?? t("未知应用", "an app")
        switch r.method {
        case "access.request": return t("申请\(app)", "Ask for \(app)")
        case "apps.launch": return t("打开\(app)", "Open \(app)")
        case "act.key": return t("在\(app)中按 \(r.chord ?? "")", "Press \(r.chord ?? "") in \(app)")
        case "act.type": return t("向\(app)输入", "Type into \(app)")
        case "act.click": return t("在\(app)中点击", "Click in \(app)")
        case "act.menu": return t("使用\(app)菜单", "Use \(app)'s menu")
        case "observe", "zoom": return t("查看\(app)", "Look at \(app)")
        case "apps.list": return t("列出应用", "List apps")
        default: return "\(r.method) \(app)"
        }
    }
}
