# SETUP_NOTES — Phase 0

> 2026-09-30 起：下面关于 `--profile headless`、凭据从 `~/.dsh` 解析、在宿主机上跑 E2E 的描述已经过时，现行做法见 bench/README 的「E2E 层」和 `docs/incidents/2026-09-29-host-model-run.md`。本文保留为最初的调研记录。

> 记录时间：2026-09-26。本文件在 `bench/` 下，给上游提 PR 时不包含。

## 环境指纹（每次 run 都要记）

| 项 | 值 |
|---|---|
| 上游 commit | `a572908`（AzaiSakura/dsh-computer-use，共 4 个 commit） |
| 本地分支 | `feat/ocr-provider`（尚未 fork 到 GitHub，见文末待办） |
| dsh CLI | `@deepseek-ai/dsh@0.1.5-rc.3`（npm `latest` 就是它） |
| 插件 devDeps 实际解析到 | `dsh-tools` / `dsh-agent` / … `0.1.0-rc.8`，`cordis@4.0.1` |
| macOS | 26.3.1 (25D771280a)，M5 MacBook Air |
| 屏幕 | 1710×1112 pt，backingScale **2.0**（3420×2224 px），单显示器 |
| Swift / Node | Swift 6.3.3，Node 24.14.0 |

## 构建结果

| 步骤 | 结果 |
|---|---|
| `swift build -c release` | ✅（1 条弃用警告：`CGWindowListCreateImage`） |
| `swift test` | ✅ 5/5（全是 AX diff 的纯逻辑测试） |
| `npm install && npm run build && npm test` | ✅ 6/6 |
| `dsh plugin --profile web add link:…` | ✅（pnpm 报 peer deps 警告，不影响） |
| `./scripts/build-app.sh` | ✅ 生成 `dist/DSH Computer Use.app` |
| `./scripts/verify-install.sh` | ✅ 配置树里出现了 `id: computer-use` |
| 直接对守护进程做 IPC 冒烟（`bench/tools/cua-rpc.mjs`，不经过模型） | ✅ ping → `DSHComputerUseIPC-1`；list_apps → 46 个；对自建测试窗口 get_app_state → AX 树 + 800×664 PNG |

撤销注册：`dsh plugin --profile web remove dsh-computer-use`。

## 踩坑

1. **bundle 默认是"只连接"模式。** `cordis.patch.yml` 里的 `daemonCommand` 默认是 `process.env.DSH_COMPUTER_USE_DAEMON ?? ""`，值为空字符串时插件不会拉起守护进程，所有工具都会连接失败。直接跑 `dsh web` 之前，要么 export `DSH_COMPUTER_USE_DAEMON`，要么在 `~/.dsh/profiles/web/cordis.patch.yml` 里覆盖这一行（`verify-install.sh` 结尾会打印一份可以直接粘贴的片段）。
2. **`verify-install.sh` 有两个误导人的地方**
   - [2/6] 找不到 `.app` 时，它会去构建 `native/.build/release/CUADaemon`，但随后打印 OK 的仍是那个不存在的 `.app` 路径。
   - [5/6] 的"屏幕录制 OK"检查的是运行这个脚本的终端的权限，不是 CUADaemon 的。
3. **`build-app.sh` 会重写已提交的 `dist/AppIcon.iconset/*.png`**，导致工作区出现改动。跑完用 `git checkout -- dist/AppIcon.iconset` 还原。
4. **`CGWindowListCreateImage` 在 macOS 15 SDK 里已被标为 obsoleted**，现在还能编译，只是因为 `Package.swift` 把部署目标写成了 macOS 14。以后如果调高部署目标，编译会直接失败；到时就得改用 ScreenCaptureKit（上游 README 也写了这是规划中的改进）。
5. **截图临时文件会一直留着**：`$TMPDIR/dsh-cua-<uuid>.png` 从来不删。权限是 0600（main.swift 里设了 `umask 077`），但文件会越积越多。Phase 3 加 `read_text` 时要一并处理（PLAN §4.3）。
6. **TCC 按"负责进程"归因。** 守护进程如果是从某个终端（包括 CC 的终端）拉起来的，就继承那个终端的授权。**CC 所在的这个终端已经同时拥有录屏和辅助功能权限**，所以 CC 能直接做离线层实测。但 `dsh web` 由什么进程拉起并不固定，维护者仍然需要按 `docs/accessibility-setup.md` 把 `dist/DSH Computer Use.app` 加进两个权限列表，这样才稳。
7. `docs/accessibility-setup.md`、`cordis.example.yml` 和 `scripts/grant-accessibility.sh` 里写死了上游作者的机器路径（`/Users/<upstream-author>/…`、`deepseek-computer-use-reverse`、debug 构建）。照着文档操作时，要把路径换成 `~/Desktop/dsh-cu-ocr/dsh-computer-use/…`。
8. **中英 README 的差异**：内容基本一致，只有一处——英文版"Project Structure"里 `docs/` 的注释还写着 "virtual cursor"，但虚拟光标在 08-21 已经删掉了（见 tasks.md 3.10），中文版是对的。另外，两个 README 都说截图走 ScreenCaptureKit，实际代码用的是 `CGWindowListCreateImage`（Known Limitations 里有说明）。
9. 编译好的插件在运行时只从 `@deepseek-ai/dsh-tools` 导入了 `defineTool`。用 `link:` 安装后，它解析到的是自己 `node_modules` 里的 rc.8，而宿主是 0.1.5-rc.3。上游只在 rc.7 上验证过。`defineTool` 本身多半没问题，但 `admitScreenshot` 里用到的 `exec.agent.session.requestHeader()`、`llm.resolveModelInfo` 这类宿主 API 如果有漂移，出错时会**静默**退回到"只给截图路径"（见 Q3）。

10. **守护进程的应用列表会冻结**（上游 bug，已在本地 commit `da3c83d` 修复，维护者同意保留）。原来 `main.swift` 的主线程一直阻塞在 `accept()`，不跑 run loop，而 `NSWorkspace.runningApplications` 要靠主 run loop 上的通知来刷新，所以列表停在第一次查询时的样子（复现程序：`bench/tools/runloop_stale_repro.swift <DSHFixture 可执行文件路径>`）。后果是：守护进程启动后才打开（或重启）的应用都找不到；即使按名字匹配上了，拿到的也是已经退出的旧 pid，截图为 `null`。修法是把 accept 循环放到后台线程，主线程跑 `RunLoop.main.run()`。修完以后，一个守护进程可以连续给 60 次重启的 fixture 各拍一张，全部正确。
    - A0 基线用的是**带这个修复**的守护进程，这一点在 baseline.md 里要注明。修复只影响"能不能找到应用"，不影响读屏能力。
11. **Chromium 窗口太早截图会拿到空白图。** 窗口 `show` 并完成 2 个 rAF 之后，合成帧也不一定已经到了窗口服务器，这时 `CGWindowListCreateImage` 只能截到背景色。fixture 在输出 READY 之前会先等 700ms；`bench/corpus/check.py` 会检查截图不是空白、真值框里有字迹。**对 read_text 的启示**：真实 app 刚切换会话后马上截图，也可能拿到空白或旧帧。要么先等界面稳定再截，要么检测到空白就重试。
12. `CGWindowListCreateImage` 截别的进程里 GPU 合成的窗口（Electron/Chromium），在 macOS 26 上目前仍然可用，截出来的图和 `screencapture -l`（走 ScreenCaptureKit）一致。
14. ⚠️ **隐私：AX 全量树里带着系统级的「最近使用的项目」。** 每个应用的 AX 树都包含菜单栏，菜单栏里的苹果菜单会列出系统最近打开的文档和应用（实测出现了真实的截图文件名、课程文件名等）。所以上游的 `get_app_state(disableDiff: true)` 会把这些文件名发给模型，diff 模式下第一次调用也一样。bench 这边的处理：
    - AX 后端只统计 AXWindow 子树（`metrics.window_subtree`）。
    - `corpus/*.ax.txt` 和 `results/offline/raw/` 都在 gitignore 里，不外传。
    - 已检查过 `results/offline/*.json` 和 `summary.md`，里面没有这类字符串。

    这应该作为一个 issue 或 PR 反馈给上游（建议 AX 树默认去掉 AXMenuBar，或者至少去掉 Apple 菜单）。A0 的 E2E transcript 里也会带着这些内容，**真实 transcript 不要外发**。
15. **坐标点击护栏**（本地 commit，维护者 2026-09-26 同意）。上游守护进程会在全屏任意位置点击模型给的坐标。一次 A1 run 里，agent 把截图像素 `(1823, 112)` 当成屏幕坐标去点，结果点到了 维护者的桌面上。同一个 run 里它还打开了 fixture 的 View 菜单、DevTools，并在控制台里敲 JS（fixture 已经去掉了菜单、DevTools 和缩放）。现在，按坐标执行的 click 和 drag 如果落在目标应用所有屏上窗口之外，会直接报错，报错信息写明窗口范围，并提示"x/y 是屏幕 point，不是截图像素"（`CUADaemonCore/PointerGuard.swift`，含单测；`tests/click_plumbing.mjs` 覆盖三种渲染模式）。按 element_index 的点击不受影响。**A0 基线同样带着这道护栏**，baseline.md 里要注明。
16. **苹果菜单剪枝 + 按键前台护栏**（两个本地 commit，维护者 2026-09-26 同意）。第一次跑完整基线时，A0 在 canvas/image 模式下读不到字，就去点苹果菜单：「强制退出」两次、「最近使用的项目」、App Store、系统信息。它按的 `⌘N`/`⌘V` 还落进了文本编辑，新建了文档并粘贴了 维护者的剪贴板。同一个菜单里就有关机、重启、注销。修复如下：
    - (a) AX 树不再采集 AXMenuBar 下的第一个 AXMenuBarItem，也就是苹果菜单（`AXPrunePolicy`）。模型读不到它，也按编号点不到它。这一条同时修掉了第 14 条的「最近使用的项目」泄露。
    - (b) press_key 和 type_text 先激活目标应用，最多等 1 秒，如果它还不在最前面就报错，不发出按键。
    - 真机验证：fixture 的菜单栏只剩 `DSHFixture`；对 fixture 按键正常；对 `com.apple.controlcenter` 按键会被拒绝，并提示"终端在最前"。
    - 被这一版之前的守护进程跑出来的 49 个基线结果作废，基线从头重跑。
13. npm 11 默认**不跑** electron 的 postinstall，要手动执行：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`。npmmirror 实测 3.4MB/s，比 GitHub 直连和 gh-proxy 都快。

---

## 五个问题的答案

### Q1. `RUN_E2E=1` 的 headless agent 怎么起的？能否复用来无人值守批量跑 bench？

链路是 `verify-install.sh` → `scripts/e2e-headless.sh` → 对每个任务执行：

```sh
dsh --profile headless --patch <临时 yml> "<任务文本>"
```

临时 yml 把插件插进来（`name` 写 `lib/index.js` 的绝对路径，`requireAppApproval: false`，`daemonCommand` 取环境变量里的值）。

`dsh-headless` 的约定：一次调用只跑一个任务，不能追问；推理过程流到 stderr（`dsh: reasoning:` 段），最终回答打到 stdout；以 `turn/end` 结束时退出码为 0，abort 或出错为 1。它不开端口，也不留常驻进程。

**结论：可以复用。** `bench/run_e2e.sh` 的做法是：每个 (任务 × arm × 第 k 次) 起一个 headless 进程，从 stdout 取 `ANSWER:` 行，再从 jsonl 里取工具调用次数和 token。

需要注意：
- web profile 的 `dsh plugin add` 对 headless 无效，headless 必须靠 `--patch` 插入插件（`e2e-headless.sh` 就是这么做的）。
- `requireAppApproval: false` 的时候，插件自己的审批弹窗不会触发，所以 E2E 里的"审批弹窗次数"这项指标在 headless 下永远是 0，只能在 web 手动跑时统计。
- 其他需要审批的工具（比如 bash）在 headless 下多半没有应答者。按 `dsh-user-approval` 的约定，没有应答者时结果是 `unavailable`，等同于拒绝。**这一点还没实测**。它会影响 bench 的公平性：agent 如果能用 fs/bash 工具直接去读 `file://` 截图或者跑 OCR，就等于绕开了被测的读屏路径。第一次 run 时要检查 transcript 里 agent 实际调用了哪些工具，必要时在 overlay 里只放行 `computer_use_*`。

### Q2. 会话/transcript 存在哪？能否导出 JSON？

- 由 `dsh-base` 里的 `session-persistence-jsonl` 负责，`root = dshHomePath('sessions')`，也就是 `~/.dsh/sessions/<规范化 cwd 目录>/<转义后的 session id>/session.vN.jsonl[.zstd]`。
- 默认开启 **Zstandard 压缩**（`.jsonl.zstd`，由多个独立 frame 拼接而成），每行一个 `SessionEvent`，只追加不改写。
- web 端的 `/export` 命令或会话菜单里的 "Download session log" 会导出一个 ZIP（`dsh-session-<id>.zip`，里面是 `session.vN.jsonl` 加 `media/`）。这条路走浏览器下载，不适合脚本调用。
- **bench 的做法**：给 headless 叠一层 overlay，把会话存储改到隔离目录，并关掉压缩：
  ```yaml
  - id: session-persistence-jsonl
    config:
      root: <bench/runs/<run_id>/sessions>
      compression: none
  ```
  这样每个 run 得到的都是明文 JSONL，scorer 直接解析，也不会碰 `~/.dsh/sessions`。
- ⚠️ CC 在这次会话里读 `~/.dsh` 下的文件被权限分类器拦截了（那里有 `.credentials.yaml`），所以上面的路径是从 dsh 源码和 README 推出来的，**还没有用真实 run 验证过**。第一次跑 E2E 时顺带确认。

### Q3. 当前模型是否声明 image input？截图是否真的以图像送进模型？

`dsh-llm-deepseek@0.1.5-rc.3` 内置的模型目录：

| model id | 名称 | inputModalities |
|---|---|---|
| `deepseek-flash` | DeepSeek-V41-Flash | **text + image**（`dsh-base` 的默认模型就是它） |
| `deepseek-v4-flash` | DeepSeek-V4-Flash | text |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | text |
| `deepseek-v4-flash-vision-exp` | DeepSeek-V4-Flash-Vision-Exp | **text + image** |

插件的判定逻辑在 `tools.ts` 的 `admitScreenshot`：只有 ① 挂载了 `attachments` 服务（`dsh-base` 里有 `attachment-local`），**并且** ② `llm.resolveModelInfo(provider, model)` 返回的 `inputModalities` 包含 `image`，才会把 PNG 存成附件，并用 `finalizeContent` 输出 `text + image` 两个块。其余情况下模型只会看到一行字符串 `Screenshot: file:///…png (image/png)`。任何一步抛异常都会静默回退到这行字符串。纯文本模型那边，dsh 还会把历史里的图片替换成一段确定性的占位文字。

结论：
- **Arm A1 能否成立，取决于用的是哪个模型。** 用 `deepseek-flash` 或 `deepseek-v4-flash-vision-exp` 时，理论上截图会作为图像送进去；用 `v4-flash` / `v4-pro` 时则**一定不会**。
- 维护者的 web 当前选的是哪个模型存在 `~/.dsh/settings.yaml` 的 `agent-default-model` 段里，而 settings 的优先级**高于** patch 里的 config。CC 没有读这个文件。**bench 不依赖它**：headless 的 overlay 会把 `settings.path` 指向 `bench/dsh-settings/<arm>.yaml`，只写这一段：
  ```yaml
  agent-default-model: { provider: deepseek-official, model: deepseek-v4-flash-vision-exp }
  ```
  这样每个 arm 用的模型都是钉死、有记录的。凭据仍然由 `credentials-local` 从 `~/.dsh/.credentials.yaml` 或 `DEEPSEEK_API_KEY` 环境变量里解析，CC 不会碰。风险是：如果 维护者在 settings 里配过自定义 `baseURL` 或 pi-ai provider，隔离之后就丢了。第一次跑的时候确认。
- **分辨率约束（对 A1 很关键）**：带图模型的 `imagePixelBudget` 是 **640,000 像素**，单张不超过 1 MB。截图是 2x 的，比如一个 1400×900 pt 的窗口就是 2800×1800 = 5.04 M px，会被缩到大约 0.356 倍，相当于 **1 pt 约等于 0.71 px**：11px 的字只剩约 8 px 高，中文笔画会糊。也就是说，A1 的读字上限主要被这个预算卡住，而不是模型本身。A2+ 的 OCR 后端吃的是原始 2x 图，这一点在报告里必须写明，否则对比不公平。
- 结合第 9 条踩坑（宿主 API 漂移会导致静默回退），**第一次 A1 run 必须检查 session jsonl 里的 `computer_use_get_app_state` 结果中是否真的有 image block**，确认之后才能把 A1 的数据当真。

#### Q3 补充：2026-09-26 在 web 端手动冒烟的实测结果（`runs/manual-smoke/2026-09-26-web-run-findings.md`，由 维护者会话里的 dsh agent 记录）

- **实际生效的模型目录由 settings 决定，不是包里的默认值。** 维护者的 settings 里只有三个模型：`deepseek-v4.1-flash-expires-on-0910`（text，当前默认）、`deepseek-v4-pro`（text）、`deepseek-v4-flash-vision-exp`（text+image），**没有** `deepseek-flash`。上面那张表只描述了包自带的默认值。bench 的 A0/A1 统一用 `deepseek-v4-flash-vision-exp`。
- 用 text-only 模型时，`get_app_state` 的 `tool/result` 里恰好是两个 text 块：AX 树，外加一行 `Screenshot: file://…`，**没有 image 块**。这证实了 A0 的形态。canvas 模式下 AX 树是 `AXWebArea → AXEmptyGroup → AXImage`，一个字都没有。
- ⚠️ **bench 泄漏已经实证。** agent 自己用 bash 调了 `bench/tools/bin/vision-ocr` 去读截图文件，读出了正确的订单号（它在报告里如实说明，并且仍然回答了 null）。所以从此以后：
  - `run_e2e.py` 的 overlay 会关掉所有非 `computer_use_*` 工具（`DISABLED_TOOL_ROWS`，`--dump-config` 已确认生效）。
  - `_common.yaml` 的规则里明确禁止使用其他工具；这一条主要是给 web 手动 run 用的，web 里没法用 overlay 关工具。
  - `score_e2e.py` 会报告 "runs using non-CU tools"。**这一列不为 0 的 run 不计入结论。**
- dsh web 默认是"只连接"模式，不会自己拉起守护进程，第一次调用会报 `connect ENOENT ~/.dsh-computer-use/computeruse.sock`，与第 1 条踩坑一致。
  - agent 认为"只 export `DSH_COMPUTER_USE_DAEMON` 不够，守护进程会去监听 `/tmp/…`"。但 `src/index.ts:70` 在 `daemonArgs` 为空时会自动补上 `--socket <socketPath>`，而 agent 是拿不带参数的裸二进制推出这个结论的，它自己也注明了"没有端到端测过"。**CC 的判断是 export 一个变量就够了，但同样还没在 web 上实测。** 如果实测不行，就再加 `DSH_COMPUTER_USE_SOCKET=/tmp/dsh-computer-use.sock`。
  - 在 dsh 的 bash 沙箱（workspace-write）里 `bind()` 工作区外的 socket 会失败（errno=1）。只有让 agent 用 bash 手动起守护进程时才会遇到这个问题；插件自己拉起守护进程不走沙箱。
- **第一次有效的 A1（web，`deepseek-v4-flash-vision-exp`，canvas，T2-keystring-order）：答对了 `20260926-0042`，没有被同屏的 `0024` 骗到。** AX 树里没有任何字，agent 自述只调用了 `computer_use_*`（web 里没法用 overlay 关工具，所以这一条只能凭它自述），因此内容只可能来自截图的 image block，图像通路是通的。
  - 它顺带转述了其他消息，**易混字符照样读错**：`尾号 0l7O` 读成 `0170`，`400-820-1l0O` 读成 `…1100`，而且以"逐字符核对"的语气把错误结果当事实说了出来。这和 Apple Vision 错在同一个地方。T2-keystring-code 和 T8 要重点看这类"自信的误读"。
  - 它试过 `super+equal` 放大页面，失败了：守护进程的 `keyCodes` 表里没有 `equal` 或 `plus`。
  - 之前两轮 web run 作废：一轮是 text-only 模型（维护者忘了切），另一轮 prompt 里混进了标准答案。
- 首次访问 DSHFixture 时弹出了审批，`allowed-once`。agent 说"approvals.json 里已经有 DSHFixture 却仍然弹了"，更可能的情况是这一行正是这次批准写进去的。后续 web run 如果重复弹出，再当作 bug 来查。

### Q4. 截图像素 vs 屏幕 point、窗口坐标原点

用自建测试窗口实测（`bench/tools/coordprobe.swift`，只截自己的窗口；编译需 `swiftc -target arm64-apple-macosx14.0`），截图方式与 `Screenshot.swift` 完全相同：

- 窗口 `kCGWindowBounds`：x300 y480 w400 h332（pt，**全局坐标，原点在主屏左上角，y 向下**）。
- 截图：800×664 px，**比例正好 2.0**。截图包含标题栏（332 = 300 内容区 + 32 标题栏），`.boundsIgnoreFraming` 去掉了阴影。
- 在内容区放一个红块，预期全局坐标 (400, 562)，在截图里找到的位置是 px (200, 164)，按公式反推回来正好是 (400, 562)。✅
- AX 的 `kAXPosition` 与 `kCGWindowBounds` 一致（300, 480）。`InputEvents.click` 用 `CGEvent(mouseCursorPosition:)`，也在同一个全局 pt 坐标系里。

**换算公式**（read_text 的 bbox 就按这个换）：

```
global_x = window.X + px_x / scale
global_y = window.Y + px_y / scale      (scale = 截图宽 / window.Width，本机为 2.0)
```

附带发现（Phase 3 要处理，也会直接影响 A1 的 T5 结果）：
- `computer_use_click` 的参数说明写的是 "at pixel coordinates from a screenshot"，但守护进程把 `x/y` 当**全局 point** 直接发给 CGEvent。模型如果照着截图像素去点，会差一个 2 倍再加上窗口偏移。
- `get_app_state` 的返回里**没有窗口 bounds 和 scale**，AX 树文本里也**不含元素坐标**。所以即使模型看得到截图，它在结构上也没法把像素换算成点击坐标。A1 在 T5 上的失败有一部分是这个接口缺陷造成的，而不完全是模型能力问题。报告里要把这两类失败分开归因。
- 截图像素的颜色经过了显示器色彩配置（纯红 1,0,0 截出来是 0.92,0.20,0.14）。对 OCR 影响很小，但 fixture 的"低对比度灰字"要以截出来的实际像素为准来标注对比度。

### Q5（补充）. dsh 版本锁定

- dsh 处于 developer preview。本次锁定 `0.1.5-rc.3`；npm 上 `dsh-tools` 已经有 `0.1.7-rc.2`，但 CLI 的 `latest` 仍是 0.1.5-rc.3。**bench 期间不要升级 dsh。** `run_e2e.sh` 每次 run 都会把 `dsh --version` 写进 `runs/<id>/env.json`。

---

## 对后续 Phase 的影响（小结）

1. headless 可以无人值守跑：隔离 sessions 和 settings，钉死模型，stdout 拿 ANSWER，jsonl 拿指标。
2. A1 只在 `deepseek-flash` / `deepseek-v4-flash-vision-exp` 上成立，而且受 640k px 预算限制。第一次 run 要验证图像块确实送进去了。
3. `read_text` 的 bbox 直接输出全局 pt，这样 `computer_use_click(x, y)` 可以直接用。这也顺带修掉了 click 参数说明和实际语义不一致的问题（给上游的 PR 可以单独拆出来）。
4. 离线层（corpus 截图 + OCR 评分）CC 可以在这个终端里全自动跑，不依赖 维护者授权。

## 待办 / 需要 维护者的

- [ ] **Fork 到 GitHub**：属于 GitHub 写操作，auto 模式下会被拦截。需要的时候 维护者自己跑 `! gh repo fork AzaiSakura/dsh-computer-use --remote --remote-name fork`，或者临时切到 accept 模式。bench 阶段不急。
- [ ] 按 `docs/accessibility-setup.md` 把 `~/Desktop/dsh-cu-ocr/dsh-computer-use/dist/DSH Computer Use.app` 加进「辅助功能」和「屏幕录制」（路径替换见第 7 条踩坑）。
- [ ] 第一次 E2E 冒烟时确认三件事：sessions 落盘路径、隔离 settings 后 key 和 baseURL 是否正常、A1 是否真的收到了 image block。
