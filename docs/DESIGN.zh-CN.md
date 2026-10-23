# cu-runtime 设计说明

[English](DESIGN.md) | 中文

本文是 cu-runtime 的设计报告：它如何工作、为什么这样设计、改什么要动哪里。读者是维护者，以及被要求理解或修改本项目的 agent；面向用户的介绍见 [README.zh-CN.md](../README.zh-CN.md)，使用说明见 [docs/desktop.md](desktop.md)。

cu-runtime 由两部分组成。守护进程（`CURuntime.app`，Swift）只在本机前的用户批准过的应用里查看、读取、点击和输入，所有安全决定都由它做出。dsh 插件包（TypeScript）增加「电脑操作」模式（这个模式的会话只有 `cu_*` 工具，没有别的工具），并提供一个插件页，用来安装、更新和设置守护进程。插件能做的永远不超过守护进程允许的范围。

## 仓库结构与修改指引

| 路径 | 内容 |
|---|---|
| `Sources/CURuntimeCore/` | 守护进程的逻辑，带测试的库：`Server.swift`（Unix socket、令牌、单一串行工作队列、看门狗）、`Dispatcher*.swift`（所有方法：观察、动作、授权、设置）、`Grants.swift` / `AppAccess.swift`（授权）、`Settings.swift` / `SettingsChange.swift`（设置，以及 socket 接受的封闭改动种类）、`OwnerCheck.swift`（Touch ID / 密码验证门）、`Refusals.swift`（拒绝码及其类别）、`HardDeny.swift`、`StopMark.swift`、`Audit.swift` |
| `Sources/cu-runtime/` | app 目标：`main.swift`（接线、信号处理）、`Mac*.swift`（AX、截屏、输入、输入源、授权弹窗、本机身份验证、选择框）、`Settings*.swift`（原生设置窗口） |
| `Tests/CURuntimeCoreTests/` | `swift test` |
| `plugin/src/index.ts`、`tools.ts`、`client.ts`、`autostart.ts` | 工具行：`cu_*` 工具和模型读到的所有文字（`tools.ts`）、socket 客户端、autoStart |
| `plugin/src/host.ts`、`plugin/src/daemon/` | 宿主行：安装和管理守护进程（`manager.ts`）、插件页的路由（`routes.ts`）、模式检查（`mode-check.ts`）、设置的窄接口和校验（`settings.ts`） |
| `plugin/src/client/` | 插件页（浏览器端）：「守护进程」标签（`page.ts`、`view.ts`）、设置标签（`settings/`）、文案（`locale.ts`、`settings/locale/`） |
| `plugin/tests/` | `node --test` |
| `profiles/bundle/`、`scripts/gen-bundle-patch.mjs`、`cordis.patch.yml` | 插件包的行；改模板，再重新生成 `cordis.patch.yml` |
| `profiles/presets/cu-desktop/` | 「电脑操作」模式的人设（目录沿用已退役 profile 的名字） |
| `scripts/` | `build-app.sh`（构建并签名）、`make-signing-identity.sh`、`install.sh`、`uninstall.sh`、`find-release-builds.sh`、`vm-*.sh`、`hooks/pre-push` |
| `bench/` | VM 基准测试；`bench/tests/` 同时是各脚本的测试 |
| `docs/desktop.md` | 使用说明（中文） |

构建与测试：在仓库根目录运行 `npm run build` 构建插件（宿主、工具和插件页）；`swift build` 构建守护进程；`swift test`、`(cd plugin && npm test)` 和 `python3 -m pytest -q bench/tests` 运行测试。`scripts/install-hooks.sh` 安装 pre-push 钩子，它会运行以上全部测试，外加 gitleaks、semgrep、swiftlint 和两项隐私检查。改过的守护进程经插件页更新到本机（源码哈希不同时，「守护进程」标签会提示更新）；改过的插件需要 `npm run build` 后重启 dsh。

必须一起改的地方：设置改动种类（`SettingsChange.swift`、宿主的校验 `plugin/src/daemon/settings.ts`、插件页的 `plugin/src/client/settings/change.ts`）；拒绝码（`Refusals.swift`、`plugin/src/daemon/settings.ts` 里的 `KNOWN_REASONS`、插件页的 `DAEMON_REASONS` 及文案）。必须守住的规则：任何放宽都要经过守护进程自己的本机身份验证；调用方自称"已验证"一律不算；文件路径不经过 socket 或路由；模型只能看到守护进程返回的内容。

## 威胁模型

- **防御的对象：**模型通过其工具越权。这包括：对任务授权范围以外的应用或硬拒绝的应用进行操作，使用允许名单以外的快捷键，点击落在目标窗口之外或其后方，以及被屏幕上的内容说动去执行危险步骤。
- **日常使用中，不经弹窗就没有授权。**`grants.set`（不弹窗的授权）会被拒绝，除非守护进程的配置文件将其打开（`config_grants`）；只有 bench 这样做，且只在用后即弃的 VM 克隆中，也只有 bench 构建接受这一设置：正式版构建带着它无法启动，状态目录不是默认目录时也无法启动（见「运行」）。bench 构建使用它自己的一张证书签名，只有 VM 基础镜像为这张证书授予了权限，因此在这台 Mac 上它两项权限都没有（见「签名」）。所以，连上 socket 的客户端无法自行授权某个应用；它只能通过 `access.request` 提出请求，而这会向本机前的用户显示守护进程自己的弹窗。它也无法使用其他客户端请求得到的授权：这些授权绑定在那个客户端的 PID 和可执行文件上（见「连接认证」）。
- **只有一道检查把守的地方：通知中心横幅。**横幅绘制在通知中心的全屏窗口内，不属于其所在应用的顶层 AX 元素，因此动作前命中测试中窗口列表这一侧、遮挡标记以及合成图都看不到它：模型看到的被遮住的元素是可点击的。在那里的点击仍会被拒绝，但只靠系统范围的 AX 命中测试（几何用例 `notification-banner`：`caught_by_ax_only`）。该次拒绝之后，惰性的 `occluded` 标记（见「动作前检查」第 7 步）会标出这一区域，模型不会再次走进去；在第一次拒绝之前，这一区域不会被发现。迄今发现的其他所有遮挡，两侧都能拦住。
- **与 bash 同处一个 dsh（每个日常模式）。**以上各点针对的都是 `cu_*` 工具：它们只能触及用户授权过的应用。插件包（见下文「可安装的 dsh 插件包（电脑操作模式）」）只在一个模式——电脑操作——中注册这些工具，该模式的 agent 看不到其他任何工具（`onlyCuTools`、`exclusive`）；日常 dsh 的其他模式保留 dsh 的 bash 和文件工具，与未装此插件的 dsh 相同，bash 能做什么取决于 dsh 的沙箱允许什么。dsh 的沙箱只限制写入，因此在每个模式下，dsh 沙箱内的 bash 和 dsh 自己的文件工具（`dsh-fs-sandbox`）都能读取状态目录中的 `token`；沙箱保持原样（维护者，2026-10-21：写入文档，不做修改）。持有令牌者能做的事：读取设置快照（不含令牌、状态目录路径和审计细节）；做出收紧的更改；通过 `access.request` 请求某个应用，这会显示守护进程的弹窗，弹窗写明发起请求的进程（可执行文件和 PID），并在这是该进程的首次请求时注明；为放宽的更改发起本机身份验证（Touch ID 或登录密码），该验证必须由本机前的用户通过，被拒绝后有 10 s 冷却。不能做的事：放宽任何设置，或在本机前的用户不参与的情况下授权某个应用。日常使用中 `grants.set` 是关闭的；授权绑定在发起请求的客户端上；授权只在发起请求的客户端标记过的一轮中给出（`access.turn_start`，见下文），且在第一个客户端运行期间，一个任务的各轮不能被另一个客户端接管。
- **bash 方面未覆盖的情况：**(1) 用户切换到 dsh 的 `danger-full-access` 模式的会话中，bash 不受限制地运行：此时 bash 与守护进程之间只剩守护进程自己的检查。这是有意留给用户的（维护者，2026-10-14）：切换模式是用户的决定，风险也由用户承担。(2) 命令通过 LaunchServices（`open`）打开的程序在沙箱之外运行。它能读取令牌，并以它自己的任务请求应用（不能以正在进行的对话的任务请求，也不能在两轮之间请求）；此时弹窗会写明发起请求的进程，并注明这是它的首次请求。在应用中显示文件的受管途径是带 `open` 的 `apps.launch`（已授权应用、可操作档、目标经过检查）。(3) dsh 自己的进程：在其中运行的代码（另一个插件、逃出隔离的 workflow 脚本）具有插件的 PID，也就随之拥有插件的授权。(4) bash 可以不经 cu 驱动图形界面（osascript、screencapture、CGEvents），能做到什么程度取决于 dsh 所在进程的 TCC 权限：不要给那个终端或 App 辅助功能、屏幕录制或自动化权限。
- **cu-std（一项实验）。**`scripts/install-cu-std.sh` 把 dsh 的标准模式安装到一个独立的 dsh home 中（`~/.dsh-cu-std`，带一份自己的 API key 副本），该模式带一个只有 cu_* 工具的 `screen` 子 agent；除非给出 `--real-mac`，否则安装在 VM 中。在那里 bash 受到进一步限制：受限运行的命令既不能读取状态目录，也不能连接 socket（`scripts/cu-sandbox-runner`）。离开沙箱的调用由 dsh 自己的提权提示询问，每次 workflow 调用都要等待用户批准（`cu-exec-gate`）；该门控的 `confirm: after-screen`（一旦对话中可能含有屏幕内容，每次 bash 调用都要确认）是一个选项，自 2026-10-16 起在 cu-std 中关闭（P3）。workflow 在 cu-std 中是关闭的：它的脚本在 dsh 自己的进程内运行（上文第 3 项缺口）。顶层提示词告诉模型不要在 bash 中使用 `open`，这只是建议，不是边界。
- **钥匙串提示框批准的是什么。**每次签名都会要求输入登录钥匙串密码（见「签名」），因此持有这台 Mac 授权的守护进程，只有在本机前的用户允许之后才会被安装。该提示框批准的，是 codesign 运行时包目录（源码和 `scripts/build-app.sh`）和构建缓存（对插件页的安装而言是 `~/Library/Caches/cu-runtime/build`：源码副本、swift 的 scratch 路径、输出；对检出目录（checkout）中的构建而言，是该检出目录及其 `.build/` 和 `dist/`）中存放的任何内容：能写入其中任一处的进程，就能决定下一次安装签的是什么。`build-app.sh` 让其余环节都避开 dsh 沙箱内工具进程可能写入的目录（`$TMPDIR`、`/tmp`）：它在输出目录旁的一个 0700 工作目录（`<CU_DIST's parent>/.build-app.*`：位于构建缓存或检出目录中，而它们本来就在提示框批准的范围内）中组装并签名 app，把 `TMPDIR`（swift 和 codesign 的临时文件）和 zsh 的 `TMPPREFIX` 指向该目录，并让 xcrun 跳过它的查找缓存（该缓存位于用户的临时目录中）。此前，app 在 `$TMPDIR` 中暂存，在复制与签名之间被换入的二进制文件会被签名并安装。
- **通过 socket 更改设置。**持有令牌的客户端可以读取设置（`settings.snapshot`：不含令牌、状态目录路径和审计细节），并且每次请求一项封闭的更改（`settings.apply`）；收紧可以立即生效，但凡是放宽的更改（把应用移出黑名单、加入始终允许名单或升到可操作档，更宽松的访问规则，启用或添加快捷键，再次批准签名已变化的始终允许名单应用，重新发送内容，把应用移出仅文本名单，坐标目标，更高的输入源上限，Electron AX，更短的保留期，放宽的重置或导入）都要等待守护进程在这台 Mac 上进行本机身份验证（Touch ID 或登录密码），一次一项，被拒绝后有 10 s 冷却，且授权弹窗打开期间从不进行；客户端永远无法自称已通过验证。结论在给出的那一刻即确定；若验证进行期间设置或始终允许名单发生了变化，则什么都不应用；导入会对照当前生效的设置进行预览，若自预览显示以来设置已经变化，确认导入会被拒绝（同时把预览更新为最新）。文件和文件夹（日志文件夹、导入、导出）只来自守护进程的面板，由本机前的用户选择。
- **不防御：**已经以同一用户身份运行的代码。这类代码能读取该用户可读的任何文件，并直接发送 CGEvents。架构无法阻止它，因此也不做尝试。E2E 运行都在用后即弃的 VM 克隆中进行，以此控制这一风险。

## 运行

守护进程必须由 LaunchServices（`open`）或 LaunchAgent 启动，绝不能作为子进程派生。macOS 把 TCC 归属于*负责*进程（responsible process）。由 node 或 sshd 派生的守护进程继承的是该父进程的权限，而不是授予这个 app 的权限：TCC 检查的是启动这条进程链的 app（终端、dsh 的桌面 App，通过 SSH 时则什么都没有），因此守护进程自己的辅助功能和屏幕录制授权不会生效，它会以那个 app 被授予的权限行事。由 LaunchServices 启动时，app 就是它自己的负责进程。

```sh
scripts/build-app.sh                                  # dist/CURuntime.app, signed with the self-signed identity
open -n dist/CURuntime.app --args serve
scripts/cu-rpc.py runtime.ping
```

`build-app.sh` 生成正式版构建。bench 构建（`CU_BENCH=1 scripts/build-app.sh`，输出到 `dist-bench/`；以 `-DCU_BENCH` 编译，Info.plist 中 `CUBench` 为 true）是唯一接受 `--state-dir`（`serve --state-dir DIR`，`cu-rpc.py` 则配合 `CU_STATE_DIR=DIR`）、或在 `config.json` 中打开测试框架开关（`config_grants`、`debug_activation`、`debug_ime`、`debug_native_images`）时仍能启动的构建。正式版构建只服务默认状态目录，即不带该选项时使用的目录。它拒绝以任何形式带 `--state-dir` 启动（包括默认目录本身的路径），也拒绝在任一开关打开时启动，并退出，给出指明原因的消息（开关的情况还会记入审计日志）：否则该用户的任何程序都能以这个 app 的权限启动第二个守护进程，并且不经弹窗授权应用。VM 脚本只部署 `dist-bench/CURuntime.app`，`build-app.sh` 也拒绝把 bench 构建放进日常路径 `dist/`。其他可调项：`CU_SCRATCH`（swift build 的 scratch 路径，默认 `.build`）和 `CU_DIST`（默认 `dist`，bench 构建为 `dist-bench`）。Info.plist 的 `CUSourceHash` 是对所构建源码（`Package.swift`、`Sources/` 和 `scripts/build-app.sh`，后者决定 Info.plist 的键、bundle id 和签名）运行 `scripts/source-hash.sh` 的结果。`build-app.sh` 以绝对路径调用每个工具（swift 经由 `/usr/bin/xcrun`），因此它以 `/bin/zsh -f scripts/build-app.sh` 运行，环境中只有 `PATH=/usr/bin:/bin:/usr/sbin:/sbin`、`HOME`、`USER`、`LOGNAME`、`TMPDIR` 和 `LANG`，`PATH` 和 `~/.zshenv` 都无法替换工具。它在输出目录旁的一个 0700 工作目录（`<CU_DIST's parent>/.build-app.*`，对 `dist/` 而言就是检出目录；每次退出时都会删除，包括因信号退出；SIGKILL 会留下它，`scripts/find-release-builds.sh` 会列出遗留在那里的 app）中组装并签名 app，而不是在 `$TMPDIR` 中，并为它运行的工具把 `TMPDIR` 指向那里（见「威胁模型」）。它在 codesign 运行之前单独一行打印 `== sign`；codesign 或其签名检查失败时（钥匙串提示框被取消或拒绝、屏幕已锁定）以状态 3 退出，环境被拒绝时以 2 退出，其他检查不通过时以 1 退出。

默认状态目录是 `~/Library/Application Support/cu-runtime/`（0700），其中包含：

- `daemon.sock`（0600）
- `token`（0600）：每次启动时重新生成
- `audit/audit-YYYY-MM-DD.jsonl`（默认位置；设置窗口的「日志」页，或插件页通过守护进程的文件夹面板，可以把日志移到用户选择的文件夹 `<folder>/cu-runtime-logs/`，并设置保留的天数）
- 可选的 `config.json`：`{"allow_finder": false}`（测试框架开关仅用于 bench 构建，见上文）
- `state-changes.json`（0600）：本守护进程改动过而尚未还原的系统状态（见「系统状态改动」）：各应用的 Electron `AXManualAccessibility`，以及键盘输入源。在每次改动*之前*写入，以便崩溃后下次启动时撤销改动。旧版守护进程遗留的 `ax-manual.json` 会被并入。

状态目录和 `audit/` 必须是真实目录（不是符号链接），归当前用户所有，权限为 `0700`；否则守护进程拒绝启动。目录缺失时它会创建，但绝不接管或放宽已有的目录。

### 签名

`build-app.sh` 使用一张自签名的代码签名证书签名，按确切名称查找：正式版构建用 `cu-runtime-signing`，bench 构建用 `cu-runtime-bench-signing`（`CU_SIGN_NAME` 可覆盖名称；`CU_SIGN_IDENTITY` 接受一个 SHA-1，或用 `-` 表示 ad-hoc；同名的多个签名身份会被拒绝）。两种构建都拒绝对方的签名身份，无论按名称还是按 SHA-1 指定（退出状态 2）：这台 Mac 的 TCC 授权锁定的是正式版证书，而接受 `--state-dir` 和测试框架开关的 bench 构建绝不能带有这些授权；只有 VM 基础镜像为 bench 证书授予权限（`scripts/vm-grant-base.sh`）。因此由证书即可判断构建类型，`vm-lib.sh` 的 `require_bench_app` 只部署由 bench 证书签名的 app。`scripts/make-signing-identity.sh [name]` 在登录钥匙串中创建一个签名身份（只做一次，在 Mac 屏幕上的终端里进行：通过 SSH 时钥匙串是锁定的，codesign 会以 `errSecInternalComponent` 失败）；其私钥在磁盘上只以一次性密码加密的形式存在，脚本被中断或终止时也会删除其临时文件。它把证书本身（公开的部分；私钥留在钥匙串中）另存一份到 `~/.<name>/cert.pem`，供以后核对签名身份之用，因为再次列出钥匙串只能显示它现在的内容：`openssl x509 -noout -fingerprint -sha1 -in ~/.cu-runtime-signing/cert.pem` 以插件页显示的格式打印正式版签名身份的 SHA-1。这份副本只是为了方便：该用户的任何进程都能改写它，而脚本会把已经存在的副本改名为 `cert.pem.replaced-<time>`，所以旁边出现 `cert.pem.replaced-*` 就说明它被改写过（以它为准之前，先查明原因）。同一用户的代码无法替换的参照，是保存在这台 Mac 之外的签名身份 `.p12` 备份（或保存在这台 Mac 之外的 `cert.pem`）：`/usr/bin/openssl pkcs12 -in <the .p12> -nokeys -clcerts | /usr/bin/openssl x509 -noout -fingerprint -sha1` 以同样的格式打印其 SHA-1（它会要求输入 `.p12` 的密码，且不写出私钥）。在脚本开始保存这份副本之前创建的签名身份没有这个文件（再次运行脚本时会提示）：从该签名身份的 `.p12` 备份中取出证书，`/usr/bin/openssl pkcs12 -in <the .p12> -nokeys -clcerts -out ~/.cu-runtime-signing/cert.pem`（它会要求输入 `.p12` 的密码，且不写出私钥；`/usr/bin/openssl` 是系统自带的 LibreSSL，而 PATH 中排在前面的 OpenSSL 3，例如 Homebrew 的那个，不加 `-legacy` 就读不了这种 `.p12` 中的 RC2-40 bag）。该证书未被标记为受信任，也无需受信任，因此 `find-identity -v` 不会列出它。维护者的正式版签名身份是 `880B2E68…3B8D`（2026-10-21 轮换，替换了 `3C6EB892…88C7`）：其 `.p12` 保存在一个加密磁盘映像中，密码与之分开保存，`~/.cu-runtime-signing/cert.pem` 只存放证书，以便使用。私钥的访问控制列表不信任 `codesign`（自 2026-10-20 起）：每次签名都会要求输入登录钥匙串密码，因此这台 Mac 上没有任何进程能悄悄签出一个沿用 TCC 授权的仿冒 app；应回答「允许」，而不是「始终允许」（后者会把 `codesign` 重新加回去）。更早创建的签名身份信任 `codesign`；docs/desktop.md 2.3 说明了如何在“钥匙串访问”中将其移除，而不更换私钥。designated requirement（指定要求）锁定证书（`certificate leaf = H"…"`），因此 TCC 授权在重新构建后依然有效。ad-hoc 签名锁定的是 cdhash，重新构建后授权不再有效。`scripts/vm-signing-check.sh` 验证了这两个方向（见下文）。3ecf445 之前的构建都带有这台 Mac 的授权，且没有 hardened runtime：见下文「旧构建」。

每个构建都以 hardened runtime（`--options runtime`）签名，不带任何 entitlements，`build-app.sh` 在签名后检查这一标志。守护进程不需要该运行时的任何例外：没有 JIT 或未签名的可执行内存，只使用系统库（因此没有团队 ID 也能通过库验证），没有 `DYLD_*` 变量，不使用摄像头、麦克风、定位、通讯录、日历或照片，也不发送 Apple events（它只接收 reopen 事件；应用和文件通过 LaunchServices 打开）。有了它，持有 TCC 授权的进程会忽略 `DYLD_*` 变量（`open --env` 可能传入这些变量），也不接受调试器附加。

**旧构建。**TCC 为 bundle id `dev.cu-runtime.daemon` 的每项权限保存一行记录，其中存有被授权 app 的 requirement，而这个 requirement 锁定的是正式版证书。因此，用该证书签名的每个 bundle，无论放在哪里，都持有两项授权：LaunchServices 启动归档中或被遗忘的 worktree 中的副本，与启动 `~/Applications/CURuntime.app` 一样容易。只有带 hardened runtime 的正式版构建（Info.plist `CUBench` 为 false，带 hardened runtime：即 `build-app.sh` 自 3ecf445 起生成的构建）才适合保留。凡不属于这一类的正式版证书构建仍然持有授权：3ecf445 之前的所有构建、当时制作的 bench 构建，以及最初的几次 R1 尝试（d4faaeb 到 b0d4919，`CUBench` 为 false）都包括在内。它们都没有 hardened runtime，因此通过 `open --env` 传入的 `DYLD_*` 变量会进入进程。R1 之前的构建（没有 `CUBench` 键）还会服务任意 `--state-dir`，并且在测试框架开关打开时照样启动，因此该用户的任何程序都能启动第二个守护进程，不经弹窗授权应用；最初的几次 R1 尝试按文本比较 `--state-dir` 路径，经由符号链接的写法就能绕过。从早于 3ecf445 的检出目录安装的 `~/Applications/CURuntime.app` 就是其中之一：插件页的「守护进程」标签会把它显示为需要替换（它没有 `CUSourceHash`，也没有 hardened runtime），在那里点「重新安装守护进程」会重新构建并替换它；`autoStart` 不会打开它。对于其他位置的副本，有两种补救办法，由维护者决定采用哪一种：

1. **轮换正式版证书。**这种办法是彻底的：为用新证书签名的构建授权时，会替换该行记录中的 requirement，因此用旧证书签名的每个 bundle 会同时失去两项授权，归档、备份以及任何工具都找不到的位置中的副本也包括在内。在 Mac 屏幕上的终端中：
   1. 停止守护进程（插件页的「停止」，或 `pkill -x cu-runtime`）。
   2. 把旧的备份移到一边，让新证书有它自己的目录：`mv ~/.cu-runtime-signing ~/.cu-runtime-signing.old-$(date +%Y%m%d)`。
   3. 删除旧的签名身份：在“钥匙串访问”中，在“登录”下搜索 `cu-runtime-signing`，删除其证书和私钥（可能会要求输入登录密码）。`security find-identity -p codesigning` 必须不再列出 `cu-runtime-signing`：`build-app.sh` 和插件的宿主程序都会拒绝同名的多个签名身份。
   4. `zsh scripts/make-signing-identity.sh`：生成新的签名身份，其证书保存在 `~/.cu-runtime-signing/cert.pem`。
   5. 在插件页的「守护进程」标签上安装由它签名的构建。曾经安装或签名过的插件页会记住旧的签名身份：它会显示两个 SHA-1，并在点「确认当前证书」之前暂停其安装、启动、权限和自检按钮。只有当前 SHA-1 正是第 4 步打印的那个（`its certificate (SHA-1 …)`）时才点它；只要此后没有任何东西改写过该文件，`openssl x509 -noout -fingerprint -sha1 -in ~/.cu-runtime-signing/cert.pem` 也会打印出这个值；然后点「重新安装守护进程」（已安装的 app 不满足新签名身份的 requirement）。钥匙串会要求输入登录密码：点「允许」，而不是「始终允许」。
   6. 新构建两项权限都没有：旧的记录行指向的是旧证书，而插件页的「授予权限」从不重置记录行。`zsh scripts/install.sh --permissions-only` 会清除它们（它跳过预检和构建，因此也适用于 dsh 的桌面 App 或其他 dsh 版本）：它对已安装 app 的自检发现两项权限都未生效，于是为 `dev.cu-runtime.daemon` 重置这些记录行（已生效的行保持不动），并退出系统设置（若让它开着，它可能把旧记录写回去），然后说明清除了哪几项。接着在插件页点「授予权限」，每点一次打开一个系统设置面板，中间点「检查权限」（docs/desktop.md 2.5）：在“辅助功能”和“屏幕与系统录音”下打开 CURuntime。也可以手动操作：退出系统设置，然后执行 `tccutil reset Accessibility dev.cu-runtime.daemon` 和 `tccutil reset ScreenCapture dev.cu-runtime.daemon`。
   7. 检查：插件页的「检查权限」显示两项权限均已授予；`zsh scripts/find-release-builds.sh` 把用旧证书签名的 bundle 列为 REMOVE（"not the current release identity"）。它们已不再持有任何授权，可以从容删除（`--delete`）。
   8. 像备份旧签名身份那样备份新的签名身份（从“钥匙串访问”导出的 `.p12`；它与它的密码绝不同时放在这台 Mac 上，docs/desktop.md 2.3），并在新签名身份可用后删除 `~/.cu-runtime-signing.old-*`。

   bench 签名身份和 VM 基础镜像不受影响。
2. **删除 `scripts/find-release-builds.sh` 标出的每个 bundle。**它列出找到的每个 CURuntime.app——通过 Spotlight，以及对 Spotlight 跳过的位置用 find 查找（本检出目录及其 `.claude/worktrees`、Spotlight 显示有 `dist*/` 构建的其他每个检出目录的 `.claude/worktrees`、`~/Library/Caches/cu-runtime`、宿主程序在 `~/Applications` 中使用的暂存名称、`~/Archives`、`/private/tmp`、`$TMPDIR`，以及给定的任何目录，例如用 `~` 搜索全部）——并给出其版本、`CUBench`、hardened runtime 和证书：它只保留由当前正式版签名身份签名、带 hardened runtime 的正式版构建，把其他所有正式版证书 bundle 标为 REMOVE；`--delete` 在终端上回答 "yes" 后删除这些 bundle。它无法担保废纸篓、Time Machine 备份、它不搜索的隐藏目录或它看不到的卷中的副本，因此这种补救办法永远不彻底。git worktree 中被忽略的 `dist/` 和 `dist-bench/` 必须随 worktree 一起删除：`git worktree remove` 会删除整个目录，包括被忽略的文件；而只删除其分支，或者执行 `git worktree prune`（它只遗忘目录已经不存在的 worktree），都会把仍然存在的目录连同其中的构建留在原处；脚本会列出剩下的一切。

## 连接认证

1. 连接上的第一帧必须是 `session.hello {"token": …}`，携带 `token` 文件的内容。其他任何内容或错误的令牌都会得到错误 `-32001`，连接随即关闭。
2. **令牌的强度恰好等于该文件 0600 权限的强度。**它能挡住误连的连接和旧守护进程遗留下来的客户端。它挡不住以该用户身份运行的代码（见「威胁模型」）。
3. 对端的 PID、该 PID 的版本和可执行文件路径取自 audit token，写入审计日志。它们本身从不授予任何东西，但**用户的授权绑定在它们上面**：弹窗给出的授权属于发起请求（`access.request`）的对端，来自其他对端的任何使用（其他 PID、其他可执行文件、同一 PID 上后来的进程——由 audit token 的 PID 版本区分——或未知的对端）都会以 `grant_owner_mismatch`（retry never）被拒绝，即使已回答的弹窗是在另一个客户端的调用期间结算的也是如此。一旦该对端退出（没有进程使用它的 PID、该 PID 现在运行的是另一个可执行文件，或者该 PID 就是发起请求的连接自己的 PID 但版本不同），其授权即告结束（`access.owner_gone`，记入审计）：dsh 重启后同一对话继续进行时，新进程会再次通过弹窗被询问，而不是被拒绝。配置授权（bench 的 `config_grants`）没有所有者。新进程（包括一行 node 命令）有新的 PID，至少也有新的 PID 版本，因此仅凭令牌已无法使用别人的授权。没有 audit token（没有 PID 版本）的对端永远不拥有授权。
4. 同时最多 4 个连接；多出的一个会得到 `-32010`（`too_many_connections`）并被关闭。5 分钟内没有发送任何内容的连接会被关闭（`idle_timeout`）；请求处理所花的时间不计在内。两者都记入审计。
## 协议

通过 Unix socket 传输 JSON-RPC 2.0。每帧为 4 字节小端长度，后接 JSON 正文。大于 256 KiB 的帧返回错误 `-32600`，并关闭连接。

拒绝为错误 `-32010`，附带机器可读的 `data.reason`、`data.retry` 和 `data.executed`（见「拒绝类别」）。每个请求另有看门狗（30 s）：若届时工作线程仍未完成，客户端收到 `-32003`。这表示**结果未知**，客户端应重新查询状态。对于 `act.*`，该错误带有 `data.action_may_have_executed: true`，因为事件可能已经发出：应先观察，绝不自动重试动作。守护进程继续提供服务，外部调用各有截止时间（SCK 10 s，Vision 15 s，AX 每条消息 1.5 s，且整体遍历预算为 3 s）。每个请求，无论被允许还是被拒绝，都恰好产生一行审计记录。对于 `act.type`，该行记录文本长度，从不记录文本本身。

| 方法 | 参数 | 说明 |
|---|---|---|
| `session.hello` | `token` | 必须是第一个请求 |
| `runtime.ping` | | |
| `grants.set` | `task_id`, `bundle_ids[]`, `source: config\|approval`, `allow_launch?`, `expires_in_s?`, `electron_ax?`, `ime_policy?: leave\|ask\|takeover`, `actions?[]`, `click_limit?: {buttons[], max_count}` | TTL 默认为 1h，上限 24h。硬拒绝的 ID 会被拒绝。Finder 需要配置中的 `allow_finder` 且来源为 `config`。`electron_ax`（默认 false）为已授权应用开启 Electron 的 `AXManualAccessibility`；`ime_policy`（默认 leave）规定输入时是否可以切换输入源（见「输入法」）。`actions`（默认：不限制）是该任务的动作允许名单，取值范围为 observe、zoom、click、scroll、drag、type、key、set_value、ax_action、launch；该任务的其他任何方法在执行前即被拒绝，返回 `action_not_allowed`（retry never）；未知名称视为无效参数。`click_limit`（默认：无）将 act.click 限制为指定的按键，且最多 max_count 次点击；其余点击被拒绝，返回 `click_not_allowed`（retry never）。**除非守护进程配置设置了 `config_grants: true`，否则此方法关闭**（拒绝为 `config_grants_disabled`，retry never）：日常使用只通过 `access.request` 和授权弹窗授权应用；bench 在其一次性克隆中开启此项。 |
| `ime.approve` | `task_id`, `scope: call\|task` | 用户已批准为该任务的下一次输入、或为该任务的剩余部分切换输入源；由插件在其授权服务给出同意后调用 |
| `grants.revoke` / `grants.list` | `task_id` / – | |
| `grants.request` | `task_id`, `bundle_id`, `reason` | 从不放宽授权；返回 `needs_approval`。获批的授权通过 `grants.set` 返回 |
| `access.request` | `task_id`, `app`（bundle ID 或名称）, `mode: read\|full`, `reason?`, `interactive?`, `electron_ax?`, `ime_policy?` | 日常使用（`docs/desktop.md`）：守护进程自己的授权弹窗。先解析应用（已安装或正在运行；名称必须恰好匹配一个应用，否则返回 `app_name_ambiguous`）；在由策略决定的情形下不弹窗直接拒绝（硬拒绝；本任务中此前已拒绝时为 `approval_refused_earlier`；非交互时为 `approval_unavailable`（插件借此探测是否已有授权；审计时带 `silent: true`）；一轮中超过 3 个弹窗时为 `approval_limit`（将本任务对同一应用的 read 授权放宽为 full 的弹窗不计入）；另一个弹窗打开期间为 `approval_busy`）；已有授权覆盖时不弹窗直接授权（本任务的授权，或在应用仍满足固定签名时的始终允许名单）；否则显示弹窗，并返回带 `request_id` 的 `pending`。始终允许名单和弹窗仅在该客户端已标记的轮内（`access.turn_start`）生效：否则不查询该名单，弹窗被拒绝为 `approval_no_turn`。弹窗会写明发起请求的进程（可执行文件与 PID），并在守护进程启动以来尚无用户为该进程批准过任何内容时予以说明 |
| `access.status` | `task_id`, `request_id` | `pending`、`granted`（mode，scope turn\|session\|always），或拒绝 `approval_rejected` / `approval_timeout`（120 s）。每个回答对应一行 `access.decision` 审计记录 |
| `access.turn_start` | `task_id`, `late?` | 插件的 turn/start：记住处于前台的应用（该任务的宿主，`dsh_host_app`；`late` 标记在某轮开始时守护进程未运行的情况下、于该轮首次调用之前发送，仅为尚无宿主的任务指定宿主），并为授权开启该轮。一个任务的各轮属于第一个标记它们的客户端，直到该客户端退出：其他客户端被拒绝为 `turn_owner_mismatch`（另一客户端持有该任务的授权时亦然） |
| `access.turn_end` | `task_id` | 插件的 turn/end：结束轮级授权以及 `grants.set`（config）授权；会话级与始终级授权自授权时起持续 30 min |
| `apps.list` | `task_id` | 已授权 ∩ 正在运行 |
| `act.menu` | `task_id`, `app`, `path[]`（菜单标题，顶层在前，最多 6 个）, `press?` | 通过 AX 操作应用自身的菜单栏，不截屏。路径止于菜单时列出其菜单项（`untrusted_items`：title、enabled、submenu）；止于菜单项时按下该项。仅限 full 模式（read 被拒绝为 `action_not_allowed`，`needs_mode: full`）。Apple 菜单（菜单栏第一项）和“服务”子菜单从不列出、也从不匹配（`menu_excluded`）。未知标题：`menu_not_found`，附带 `untrusted_available`；已禁用：`menu_item_disabled`。标题属于应用内容：从不审计（只记录 `menu_depth` 以及列出/按下） |
| `settings.snapshot` | – | **用户设置**（`settings.json`，Settings.swift），供插件页使用：授权、始终允许名单、黑名单（含应用名称）、硬拒绝名单（系统底线）、访问规则、快捷键、隐私、行为、日志（仅当用户选择了文件夹时才包含该文件夹，主目录写作 `~`）、近期的拒绝与设置改动（时间、方法、应用、原因，或仅 verified）、三项权限、等待本机身份验证的改动（`pending`）、`last_outcome`、`picked_app`、`import_preview` 以及打开的 `panel`。不含令牌（token）、状态目录路径或审计细节。守护进程自己的设置窗口（`cu-runtime settings`，SettingsWindow.swift）在进程内修改同一套设置；每次改动都以 `settings.*` 审计 |
| `settings.apply` | `change`（`{kind, …}`，每项一个封闭的 kind，键须完全一致） | socket 修改设置的唯一途径（SettingsChange.swift；不接受其他任何键，`verified` 也不例外）。不放宽的改动立即生效（`applied`）。放宽的改动返回带摘要的 `pending`，同时守护进程显示自己的本机身份验证（Touch ID 或密码，文案由守护进程生成）；只有验证结果为通过才会应用，由下一个 `settings.*` 请求结算，并依据当前生效的设置重新判定。验证之前即拒绝的情形：`approval_open`（授权弹窗正打开）、`verify_busy`（另一个改动或验证正在等待）、`verify_cooldown`（验证失败或取消后的 10 s 内）、`verify_unavailable`（无法进行本机身份验证）。黑名单在所有路径上拒绝该应用（`user_denied`，与 `hard_denied` 相同，但不触发前台停止），并在应用加入的那一刻将其从活动授权和始终允许名单中移除 |
| `settings.cancel_verify` | – | 结束等待中改动的本机身份验证（没有等待中的改动时返回 `nothing_pending`） |
| `settings.action` | `name` | 守护进程自己的面板，因此任何路径都不会经过 socket：`choose_log_directory`、`use_default_log_directory`、`choose_app`（写入 `picked_app`）、`export_settings` 和 `export_audit`（7 天；写到用户保存的位置，从不经 socket 发送）、`import`（打开面板，校验后写入 `import_preview`；保留当前生效的日志文件夹）、`import_confirm`（严格按预览内容导入，放宽时需经本机身份验证）、`reveal_log`。结果结算到下一次快照中。无界面运行（没有面板）时：`settings_unavailable` |
| `apps.launch` | `task_id`, `app`（或旧的 `bundle_id`），可选 `open` | 需要 `allow_launch`（grants.set）或用户对该应用的授权：**read** 将正在运行的应用带到前台并重新打开窗口（`was_running: true`）；启动未运行的应用需要 **full**（read 被拒绝为 `action_not_allowed`，`needs_mode: full`；在启动时检查）。no_grant / not_granted 拒绝附带对应当前状态的 `needs_mode`。`open`：由应用打开的文件（绝对路径）或 http(s) 地址（`opened: file\|web`），始终需要 **full**。在任何操作执行之前检查（`OpenTarget`）：仅限 http/https；文件必须存在，且经符号链接解析后为任何人都不可执行的普通文件，不属于 `.command`/`.pkg`/`.webloc` 之类的类型，也不位于守护进程的状态目录下（`open_not_allowed`、`open_not_found`）。审计记录为 `open_kind` 和解析后的 `open`。首次打开 macOS 保护的文件夹（Desktop、Documents、Downloads 等）中的文件时，macOS 会询问用户是否允许 CURuntime 访问该文件夹；打开操作会等待回答，10 s 后返回 `open_waiting`（outcome_unknown：用户回答后会自行完成），并写明该文件夹。两种回答都可以：选择 Don't Allow（不允许）时，LaunchServices 不再询问，直接把文件交给应用，应用将其打开（VM，2026-10-15），因此守护进程无需访问用户的文件夹。`open_no_permission`（never）保留给直接的权限错误，上述回答不会产生该错误 |
| `observe` | `task_id`, `ocr: on\|off`, `include_image?` | 已授权应用窗口的 AX 快照，另对每个窗口做一次 SCK 截取（仅限已授权应用）。`image` 是一张桌面合成图，缩小至 ≤640k px，附带其 `mapping`：已授权窗口显示其像素，位于其前方的其他任何窗口显示为纯灰色块。OCR 以原生分辨率经由 OCR 缓存（见下文）运行。屏幕文本在 `untrusted_observation` 下返回；审计日志只记录计数。`capture` 报告 `ocr` 统计、`phases_ms`，以及等待过窗口时的 `window_wait` |
| `zoom` | `task_id`, `snapshot_gen`, `element_id` \| `rect{x,y,w,h,space: screen\|image}`, `ocr?` | 合成图中的一个区域，最高可达原生分辨率（见下文「cu_zoom」）。返回 `zoom_id`、带 `mapping` 的 `image`、`magnification`，以及该区域的 OCR 行 |
| `act.click` | `task_id`, `app`, `element_id` \| `point{x,y,space,zoom_id?}`, `button?: left\|right\|middle`, `count?: 1–3`, `via?: auto\|ax\|event` | `space`：`screen`（全局坐标点）、`image`（快照概览图的像素）或 `zoom`（缩放图 `zoom_id` 的像素，该缩放图必须属于同一快照）。支持 AXPress 的 AX 元素通过 AX 按下，除非指定 `via: event`（见「动作」） |
| `act.scroll` | `task_id`, `app`, `element_id` \| `point`, `direction`, `amount?`（行数，1–50，默认 3） | |
| `act.drag` | `task_id`, `app`, `from`, `to`（各为 `{element_id}` \| `{point}`） | 两端都须通过每一项检查 |
| `act.type` | `task_id`, `app`, `text`, `element_id?`, `strategy?: auto\|type`, `ime_policy?: leave` | 按 ≤20 个 UTF-16 单元分块发送；**换行即按下 Return，在多数单行输入框中会提交内容**；带 `element_id` 时先通过 AX 聚焦该元素，结果中含 `verified`（文本已出现在其值中）；向空输入框输入不含换行或制表符的文本时，改为通过 AX 设置（`via: "ax_value"`，除非指定 `strategy: type`）；结果报告输入源（`ime`，见下文）；`ime_policy: leave` 只能降低授权中的策略；拒绝向密码框输入 |
| `act.key` | `task_id`, `app`, `chord`，例如 `cmd+shift+z` | 仅限允许名单中的快捷键；发送真实的修饰键事件 |
| `act.set_value` / `act.ax_action` | `task_id`, `app`, `element_id`, `value` / `action` | 仅 AX；`action` ∈ AXPress、AXConfirm、AXRaise、AXCancel |

### 快照与点击

元素目标和坐标目标都必须带上读取它们时的 `snapshot_gen`。出现以下情况时，守护进程拒绝该目标：
- 其元素已改变（`stale_element`）；
- 其窗口已移动或改变大小（`stale_coordinates`）；
- 在该快照中它不在目标应用的窗口上（`not_on_target_window`）。

守护进程**无法**检测到客户端把旧坐标与较新的 `snapshot_gen` 配对使用。任何 `stale_*` 拒绝之后，都应重新观察，并从新快照推导出所有目标。

在真实点击之前，守护进程还会：
1. 聚焦该点下方的窗口，使点击不会被当作激活点击吞掉；
2. 等待该窗口保持静止 150 ms，因为系统可能在聚焦时调整其位置；
3. 如果窗口在点击后仍立即发生变化，报告 `window_changed_after_click`。

### OCR 缓存

OCR 结果按窗口、以窗口本地坐标点保存（`OCRCache`），因此连续的 observe 只重新读取发生变化的部分：
- 只是**移动**过的窗口不重新读取；其文本行随窗口一起移动。
- **改变大小**的窗口，或上次 OCR 失败的窗口，整体读取。
- 其他情况下，窗口与上次读取的结果在 32 pt 网格上比较（平均绝对亮度差，0–255 范围内阈值为 2）。每个发生变化的格子扩展为整宽的条带，因为文字按行排列，而条带会扩展到覆盖它所触及的每一条已缓存的行。只重新读取这些条带。
- 重新读取后文本相同且位置相同的行保留其 id，因此 OCR 元素 id（`o<n>`）在多次 observe 之间保持稳定。
- 若同一应用的某个 AX 元素已在同一位置携带相同文本，该 OCR 文本被丢弃，以 AX 元素为准（`deduped_against_ax`）。

离线语料（60 张图像，`bench/offline/run.py --backend cu-runtime`，它运行 `cu-runtime ocr-files`，即守护进程自己的 OCR）：CER 3.6%，关键字符串 74.5%（152/204），bbox 命中 95.3%，与参考后端 `apple-vision` 完全相同。以强制的 96 pt 条带读取时（`cu-runtime-bands`，作为条带重读的悲观替代）：CER 3.5%，关键字符串 76.0%，但 bbox 命中为 90.8%，因为在条带边缘被截断的行只得到部分框。

VM 数据（2026-09-29，`bench/experiments/ocr_cache.py`，1440×900 @2x，12 行）：未变化时 p50 ≈ 0.14–0.24 s，改变一行时 p50 ≈ 0.31 s（重新读取约 10% 的窗口），整个窗口 ≈ 0.75 s。尽管有启动预热，启动后的第一次 OCR 仍需 ≈ 2.5–3.4 s。

### cu_zoom

`zoom` 从一次新的截取中裁剪与概览图相同的、已遮挡屏蔽的合成图，因此它显示的其他应用内容绝不会多于概览图。规则：
- 它需要一次产生了图像的 observe 的 `snapshot_gen`。自那以后，矩形区域下方的已授权窗口必须没有变化，且该区域不得出现新的已授权窗口（`stale_coordinates`）。
- 裁剪结果在 640k px 预算之内为原生分辨率，超出则缩小；`magnification` 表示其细节相对于概览图的比例。显示的细节不会多于概览图的矩形会被拒绝（`zoom_not_magnifying`）。
- 元素目标按其边框外扩 16 pt 进行缩放。
- OCR 行来自 OCR 缓存（它们属于数据，位于 `untrusted_observation` 下）。要点击在缩放图中看到的内容，使用 `point{space: "zoom", zoom_id}`：守护进程会将其映射回去，并像对待任何点一样，对照该缩放图所属的快照进行检查。
- 守护进程中没有按任务的次数限制；每次缩放都会审计。按任务的预算归插件（R4）负责。

### 等待窗口

- 在任何等待之前，observe 会通过 AX 查询每个已授权应用的窗口所在（WindowPresence：not_running、hidden、minimized、no_windows、visible），并把没有可显示窗口的应用作为 `app_states` 返回。只有可见的应用，以及本守护进程刚刚启动的应用，才会被等待（窗口等待、electron_ax 稳定）；过去一个最小化的 QQ 会白白耗费 8 s 的等待（2026-10-09）。拒绝 AXManualAccessibility 的应用（原生应用）在重新启动之前不会再被询问。
- 正在运行但未列出任何窗口的已授权应用，通常是刚刚启动或被激活：窗口服务器列出新窗口最多会晚约 2 s。`observe` 会轮询最多 2.5 s，而不是什么都不返回。此后仍没有窗口的应用（所有窗口已关闭、菜单栏应用）按 pid 记住，在它显示窗口之前不再等待。
- 本守护进程启动的应用（`apps.launch`）会被等待：在启动后 10 s 内，最多等待 2.5 s，直到 macOS 报告其正在运行。其他人启动的应用不会被等待。
- 启动时，守护进程在后台预热窗口列表、SCK 和 Vision（审计日志中的 `runtime.prewarm`）。
- 用于显示时（observe、zoom），程序坞的栏位（OverlayPolicy）通过 AX 读取，超时为 0.25 s，并复用 0.5 s；如果程序坞没有响应（在播放启动动画期间它确实不响应），则使用最后已知的边框。允许/拒绝的判定从不使用这些数据：见「动作前检查」。
- 启动后的第一次 OCR 仍需约 2.5–3.4 s。启动时的 Vision 预热（即便使用窗口大小、中英混排、并在 OCR 自己的队列上执行）也未能消除这一延迟。bench 运行和插件（R4）会在计时或开始任务前先做一次预热 `observe`。

### 系统状态改动

本守护进程所做的某些改动会比单个动作持续更久，或超出已授权应用内容的范围：Electron 的 `AXManualAccessibility`（改变目标应用）和键盘输入源（全局：所有应用都会受到影响）。它们经由同一套机制处理（`SystemStateChanges`）：
- 每项改动一个策略：`leave`（从不改动）、`ask`（仅在用户批准后改动）、`takeover`（在任务期间改动，之后恢复）；
- 在改动**之前**写入一条台账记录（`state-changes.json`）；
- 分层恢复：当没有任何活动授权再需要该改动时（插件在 `turn/end` 时撤销授权；过期在下一个请求时被发现）、收到 SIGTERM/SIGINT 时，以及崩溃后的下一次启动时；
- 每次改动和每次恢复都有一行审计记录（`ax.manual_accessibility`、`system.input_source`）。

### electron_ax

Electron 应用只有在设置了 `AXManualAccessibility` 时，才会向 AX 暴露其网页内容。对于 QQ（QQNT），可见文本覆盖率从 0 提高到约 60%（PLAN-v2 R2）。设置它会改变目标应用，因此：
- 它是每个授权显式选择开启的选项，每次切换（开或关）都会审计；
- 它在第一次 observe 时才惰性应用；
- 开启之后，守护进程会等待 AX 树稳定后再读取（`AXSettle`：节点数必须离开切换前的基线并保持不变；超时会被报告，从不隐藏）；
- 当没有任何活动授权再需要它时、收到 SIGTERM/SIGINT 时，以及下一次启动时通过台账（见「系统状态改动」），它会被关闭。重启应用仍是唯一彻底的复位方式。`electron_ax: true` 即此项改动的 `takeover` 策略，`false` 即 `leave`。

### 动作

- **AX 优先**（PLAN-v2 §6）。对支持 AXPress 的 AX 元素进行 `element_id` 点击时，执行的是 AXPress：不激活应用，也不受遮挡该元素的内容影响。`act.set_value` 设置 AXValue，`act.ax_action` 执行允许名单中的动作。AX 路径仍会检查授权、硬拒绝停止以及元素是否过期。结果中写明 `via: "ax"` 或 `via: "event"`。
- **其余情况使用真实事件**，并在通过下文的每一项动作前检查之后发出：坐标点、OCR 元素、右键/中键、双击和三击（`kCGMouseEventClickState` 1…n）、滚动、拖拽（按下、12 次拖动移动、松开）、输入和快捷键。
- **输入**：文本以 Unicode 键盘事件发出（中间不经过输入法，因此中文按原样到达），每块最多 20 个 UTF-16 单元，绝不拆分字符。换行和制表符分别为按下 Return 和 Tab。发送每一块之前，目标必须仍在前台；否则输入以 `focus_lost` 停止，`steps_posted` 说明进行到了哪一步。
- **粘贴**（`act.type` 配合 `strategy: paste`，P4 2026-10-16，参照官方 cua-macos provider）：文本经由剪贴板和 ⌘V 输入，因此不会被任何输入法吞掉，也不会改变输入源。剪贴板先被保存（每一项的每一种类型，最多 32 MB，否则返回 `clipboard_too_large` 且不粘贴任何内容），并在应用有 0.3 s 读取之后放回，除非期间有其他程序写入了剪贴板（`clipboard_changed`：保持不动）。带元素目标时会读回该输入框（`verified`）。底线与输入相同：full 模式、拒绝密码框、应用须在前台（`focus_lost` 时恢复剪贴板）。当输入的文本没有到达时，插件会建议使用此方式。
- **屏幕锁定**（P5，2026-10-16）：macOS 处于锁定状态时（`CGSSessionScreenIsLocked`），observe、每个动作和 `apps.launch` 都会在任何操作发生之前被拒绝为 `session_locked`（retry never：由用户解锁，模型再重新观察）。锁定状态未知时不拒绝。
- **快捷键**：修饰键作为真实按键按下（按顺序按下，按相反顺序松开），每个事件都携带当时按住的标志位。
- **激活**：`NSRunningApplication.activate()`，随后照常检查应用是否在 500 ms 内成为前台应用。在 VM 中实测（`bench/experiments/activation.py`，每项 20 次试验）：`running_application` 在有其他应用位于前台时为 20/20，目标被隐藏时为 20/20；`ax_frontmost` 分别为 20/20 和 0/20；`ax_raise` 分别为 0/20 和 0/20（它会提升窗口，但不会激活应用）。config.json 中的 `activation_method` 可覆盖默认方式。
- **指针自身的窗口**不属于窗口次序。在 VM 中，它是位于指针位置的一个真实屏幕窗口，曾使鼠标最后停留的点看起来被遮挡。只有**属于 Window Server 且**处于光标层级的窗口才会被排除：任何应用都可以把窗口放到该层级，而这样的窗口仍构成遮挡（几何测试集 `occlusion-cursor-level`：6/6 由窗口列表本身拒绝；按旧的仅看层级的规则，只有 AX 命中测试能拦住它们）。
- **不输入凭据**。当目标元素（若无目标元素，则为应用的焦点元素）是密码框（角色或子角色为 AXSecureTextField），或系统的安全事件输入处于开启状态时，`act.type`、`act.set_value` 和 `act.key` 会被拒绝（`secure_input`，retry `never`，“请用户自行输入”）。在动作执行时检查，激活前后各一次。允许点击密码框。VM：在其获得焦点时进行输入、设置值、输入和按键：4/4 被拒绝，输入框保持为空。
- **输入法**。选中拼音且没有正在组字时，输入的文本准确到达（3/3）。当输入框中有未提交的组字内容时（按键 n、i：带候选词的 "ni"），尽管事件已经发出，每个输入的字符都被吞掉了（3/3）。因此，带元素目标时，`act.type` 会读回值并报告 `verified: true|false`；false 表示文本没有到达（`bench/experiments/ime.py`）。`act.type` 对此的处理见下文「输入法」。

### 输入法

对于 `act.type`，依次为：
1. 在与输入等效的情况下**以设置代替输入**：元素目标的 AXValue 可设置、输入框为空（输入是在插入点插入，设置则替换全部内容）、不含换行或制表符、不是密码框。设置后会读回值；若不一致，则将其重新设为空，改为输入（`set_value_fallback`）。这样可以绕过输入法，且不改变任何系统状态。Chromium 在 AX 设置时会触发其 `input` 事件：DOM 值、页面自己的副本以及监听 `input` 的发送按钮全部随之更新，6/6（input 和 textarea，`bench/experiments/ime_probe.py`）。某个具体应用是否作出了反应，守护进程无法普遍判断：结果中写明 `app_reaction: "not_checked"`，插件会告知模型在下一次 observe 中检查。
2. **否则依据授权的 `ime_policy`**，前提是当前输入源是一个输入法（键盘布局无需处理：Unicode 事件会直接穿过它们）：
   - `leave`：按原样输入；结果中含 `ime: "left"` 和一条 `ime_warning`；
   - `ask`：在 `ime.approve` 之前拒绝为 `ime_switch_needs_approval`（不输入任何内容）；`call` 作用域在该次输入之后立即恢复，`task` 作用域在任务结束时恢复；
   - `takeover`：切换到系统为该输入法配对的 ASCII 布局（`TISCopyCurrentASCIICapableKeyboardLayoutInputSource`；在 VM 基础镜像中为 British，而非 ABC），并在任务结束时恢复。
3. **从不在组字期间切换**。切换会提交或丢弃用户正在组字的内容：`ime_composing`（retry `after_observe`：用 Escape 取消或让用户完成，然后重新观察）。检测方式（`ime_probe.py`，VM，macOS 26）：组字进行期间，拼音的候选词面板是**应用自身进程**中处于程序坞窗口层级（20）的一个窗口，6/6；空闲时、按 Escape 后和提交后均不存在，9/9。AX 没有 marked-text 属性（值中的 "ni" 与输入的文本无异；属性字符串只携带字体和颜色）。对于实测过的拼音（`com.apple.inputmethod.SCIM.*`）以外的输入法，没有面板意味着 `ime_composing: "unknown"`，而不是 false。
4. **只恢复仍属于自己的改动**：仅当当前输入源仍是守护进程所设置的那个时，恢复操作才会选回原输入源；如果用户此后切换过，以用户的选择为准（`restore_skipped`，会审计）。

在 VM 中实测：
- 通过 LaunchServices 启动的守护进程可以用 `TISSelectInputSource` 选择输入源：6/6，1–12 ms，通过读回当前输入源验证（TIS 调用在主线程上进行）。
- 端到端（`bench/experiments/ime_policy.py`，7/7）：takeover 准确输入，并在撤销时恢复；组字期间被拒绝且不输入任何内容；ask 先拒绝，在 `ime.approve` 之后输入并立即恢复；leave 发出警告且不改变任何内容；SIGTERM 会恢复；SIGKILL 之后输入源保持切换状态并留有台账记录，下一次启动时将其恢复；空输入框通过 AX 设置，完全不改变输入源。
- 过程中修复的问题：信号处理程序曾在主线程上等待工作线程，而恢复操作又需要主线程（TIS），因此 SIGTERM 会跳过恢复，直到关闭超时。现在关闭流程在主线程之外运行。
- **未验证**：“自动切换到文稿的输入源”。用 `defaults write com.apple.HIToolbox AppleGlobalTextInputProperties -dict TextInputGlobalPropertyPerContextInput -bool true` 写入并重新启动 Finder 和测试夹具后，VM 的行为仍是全局的（Finder 显示的是在测试夹具中选中的输入源）。如果按文稿模式确实开启，可能的影响是恢复被跳过（位于前台的另一个应用显示它自己的输入源），这会以 `restore_skipped` 审计。

默认值：插件的 `imePolicy` 在真实 Mac 上为 `ask`（切换会影响其他应用），在 VM bench 的各组中为 `takeover`。
- VM 结果（`bench/experiments/actions.py`，两种显示配置）：通过 AX 的元素点击 9/9，通过事件的元素点击 9/9，坐标点点击 9/9，双击、右键点击、45 个字符的中英混排文本准确输入、两行 textarea、cmd+A 后输入替换文本、AXValue 设置、双向滚动、落点偏差 0 pt 的拖拽，以及已移动窗口中的元素被两条路径都以过期拒绝，且没有任何内容到达测试夹具。

### 拒绝类别

每个拒绝都携带 `data.retry`（`Refusals.classes`；若源码中有未分类的拒绝，测试会失败）：

| `retry` | 含义 | 客户端 |
|---|---|---|
| `after_delay` | 在任何操作执行之前、因暂时性原因被拒绝（`overlay_state_unknown`、`activation_failed`、`window_focus_failed`、`too_many_connections`、`launch_failed`） | 可在短暂延迟后重发同一请求若干次 |
| `after_observe` | 在任何操作执行之前、因屏幕与快照所述不符而被拒绝（`stale_*`、`hit_test_failed`、`not_on_target_window` 等） | 重新观察并构建新请求；绝不重发 |
| `never` | 因策略被拒绝，或请求格式错误（也包括 `ime_switch_needs_approval` 和 `ime_switch_failed`，插件对此的处理是询问用户，或以 `ime_policy: leave` 重发；未输入任何内容） | 不要原样重试 |
| `outcome_unknown` | 动作可能已全部或部分发生（`action_failed`、`focus_lost`、`act.*` 的 `request_timeout`）；`data.action_may_have_executed: true` | 绝不自动重试：先观察 |

插件（R4）只自动重试 `after_delay`，且次数有限。前三类的 `data.executed` 为 `false`，最后一类为 `null`（未知）。

### 动作前检查

以下检查对每个 `act.*` 按顺序执行（PLAN-v2 §5.3）。第一项失败即拒绝该动作，并记入审计。

0. **以显示名称指定的应用**（用 "DSHFixture" 代替 `dev.dsh.bench.fixture`）会首先被解析，且只在该任务的已授权应用中查找，仅当恰好匹配一个时才解析成功（本地化名称、bundle 显示名称/简称或 .app 文件名；忽略大小写和首尾空格）。多个匹配会被拒绝为 `app_name_ambiguous`；没有匹配则保持原样，并被拒绝为 `not_granted`。守护进程从不查询授权范围之外的应用名称，因此这一步不会放宽授权，解析得到的 bundle ID 仍要经过下面的各项检查。审计中保留 `app_name` 和 `app_resolved_from_name`。（R4：每一次 `not_granted` 都是模型使用了显示名称。）
1. 授权存在且未过期。
2. 应用未被硬拒绝（纵深防御），且授权覆盖该应用。
3. 快捷键可以解析，并通过允许名单（见下文）。
4. 每个目标都是来自有效快照的 `element_id`，或声明了 `space` 的坐标点。R1 中没有快照，也没有图像映射，因此只有 `space: "screen"` 的坐标点能通过。
5. **硬拒绝的应用不在前台**。如果在前台（例如目标中的链接启动了终端），所有动作都会停止。守护进程不会悄悄把目标应用拉回到它上面。
6. **先激活，再验证**：应用必须在 500 ms 内成为前台应用。
7. **命中测试**：在每个坐标点上，窗口列表中最上层的窗口**和**系统范围的 AX 命中测试都必须指向该应用。
   - **安全前提**：AX 命中测试遵循窗口服务器的点击路由，因此会指出另一个应用中接收点击的不可见（alpha 0）窗口，而窗口列表会跳过这种窗口。如果 AX 没有给出回答，动作被拒绝（失败即关闭）。一个例外：对于完全没有实现 AX 命中测试的应用（`kAXErrorNotImplemented`，WeChat 4 对每个点都如此回答，2026-10-14），改由重新读取的、计入不可见窗口的窗口列表来判定，因此坐标点上方若有另一个应用的 alpha-0 窗口，仍会拒绝；这类点击以 `hit_test: window_list_only` 审计。其他任何 AX 失败仍会拒绝。该回退未覆盖的情形：允许点击穿透的窗口在它看来构成遮挡，因此点击被拒绝（偏向安全一侧）。几何测试集保留 `occlusion-invisible`（覆盖层接收点击：每次点击都被拒绝；去掉 AX 检查后，6/6 被拦截）及其点击穿透对照 `occlusion-invisible-clickthrough`（每次点击都落到目标上），作为长期回归测试，使 macOS 在任一方面的变化都能被发现。
   - 因两者不一致而被拒绝的点击携带 `data.intercepted_by`（拦截者的 bundle ID，或 `unknown`）。守护进程会记住该区域，并在之后的 observe 中把其中的元素标记为 `occluded`（附 `intercepted_by`），直到窗口列表发生变化。observe 期间不会逐元素运行 AX 命中测试。
   - 程序坞的可见区域会为此项检查重新读取。如果程序坞没有响应（在播放启动动画期间它不响应），拒绝为 `overlay_state_unknown`：稍后重试。复用的或最后已知的程序坞边框只用于显示（遮挡标记、合成图）。

### 快捷键：允许名单

黑名单式的阻止列表总会有漏洞。用户会自定义快捷键，第三方应用会注册全局热键，无论哪个应用在前台都会触发（QQ/WeChat 截图、Raycast、Alfred），而 F 键的含义会随 fn 锁定设置而改变。因此规则如下：

- 没有修饰键、或只带 ⇧ 的按键**允许**。这涵盖字母、数字、标点、return、tab、escape、方向键、delete、Home/End/PgUp/PgDn 和空格。
- 带有 ⌘ ⌃ ⌥ fn 中任意一个的快捷键，**仅当**在以下名单中时才允许：⌘A C V X Z、⌘⇧Z、⌘F G W N S Q、⌘⌫、⌘L（浏览器地址栏）和 ⌘⇧T（2026-10-14），以及 ⌥ 或 ⌘ 加方向键。真实任务需要更多时再扩充名单。
- F1–F20 一律拒绝，无论是否带修饰键。

R1 的旧阻止列表现在作为验收集保存在测试中（`legacyBlockedChords`）：其中每个快捷键都必须被拒绝。按其构造方式，允许名单也会拒绝影响其他应用的快捷键，例如 ⌘⌥H。

### 硬拒绝名单

该表位于 `Sources/CURuntimeCore/HardDeny.swift`。每个条目都记录了其 bundle ID 的验证方式：

- **`localInfoPlist`**：从本机上的应用中读取。
- **`upstreamSource`**：从应用自己的源码仓库中读取：iTerm2、kitty、WezTerm、Alacritty、Ghostty、Zed、Python Launcher。
- **`unverified`**：取自 Homebrew cask：Cursor、Android Studio、Sublime Text、JetBrains。

厂商命名空间**按完整的点分段**匹配：`com.jetbrains` 覆盖 `com.jetbrains` 和 `com.jetbrains.pycharm`，但不覆盖 `com.jetbrainsfoo.app`。这涵盖了 Ghostty 的 `.debug` 构建、带有主版本号的 Sublime Text ID，以及全部 JetBrains 产品。Zed 的各发布渠道以 `-Suffix` 区分，而不是点分段，因此四个 ID 全部精确列出。

Finder 不在硬拒绝名单中，而是由配置控制：它需要守护进程配置中的 `allow_finder`，以及来源为 `config` 的授权。

上游代码：截至 R1，未复用 `AzaiSakura/dsh-computer-use` 的任何代码。整体框架遵循 PLAN-v2 的协议规范。今后任何移植（例如 `AXTreeDiff`）都必须附带其 MIT 许可声明。
## 维护者 Mac 上的日常使用

`docs/desktop.md`（中文，面向本机前的用户）涵盖：如何停止、数据存放位置、通过插件页安装（`scripts/install.sh` 作为预检与引导）、日常使用、autoStart、授权弹窗、设置、始终允许名单（`cu-runtime grants list | revoke | add --full`）、权限、模式检查、令牌（token）与沙箱、卸载，以及作为实验的 cu-std。简言之：电脑操作在日常使用的 dsh 中借助插件包运行（见下文「可安装的 dsh 插件包（电脑操作模式）」）：其「电脑操作」模式是唯一带有 cu_* 工具的模式，该模式的 agent 没有任何其他工具；「守护进程」标签中的「模式检查」会确认：正在运行的 dsh 的 home 下，没有任何 profile 在别处加载 cu_* 工具，也没有任何 profile 加载其他任何电脑操作插件。会话的模型由本机前的用户选择，须为支持图像输入的模型。应用不预先授权：首个涉及某应用的调用会使守护进程以自己的弹窗请求完整模式的授权，每个应用一次（P2，2026-10-16；此前该调用会被拒绝，只有附带 `access` 与理由重新发送时才会询问，类似 dsh 的 bash 提升其沙箱权限的方式）；调用可携带可选的 `justification`，由弹窗显示。守护进程为较早的始终允许名单条目及 `grants add` 保留 `read` 模式（观察、缩放、左键单击、滚动、AXPress、AXRaise）。弹窗关闭时，焦点会返回原先持有焦点的应用（守护进程本身在硬拒绝名单中，若留在最前，下一个动作会被停止），该决定的审计记录会注明这一点（`focus`）；系统底线（硬拒绝、快捷键允许名单、密码字段、命中测试、最前应用检查与过期检查）在两种模式下均有效。守护进程自身的 bundle ID 在硬拒绝名单中，因此模型既看不到也无法点击该弹窗。`bench/experiments/approval_dialog.py` 在 VM 中检查真实的弹窗。

## 插件（R4）

`plugin/` 是 dsh 插件：即 PLAN-v2 §7 中的 `cu_*` 工具。它只连接守护进程的 socket，从不将守护进程作为其子进程启动（否则 TCC 会把权限记在 node 而非该应用名下）；启用 `autoStart` 时（插件包的模式、cu-std），它通过 LaunchServices 打开已安装的应用，且仅限宿主已验证的正式版构建（见下文「可安装的 dsh 插件包（电脑操作模式）」）；否则在无法连接时说明应在何处启动守护进程。所有策略决定都留在守护进程中。每个 dsh 会话（一个任务）中：
- 首次工具调用会授权所配置的 `apps`（来源为 `config`，显式设置 `electronAx`），并执行一次预热观察；该授权在 `turn/end` 时撤销；
- 元素 id 在多次观察之间保持稳定（`e…`/`o…`，由每个元素的 key 生成，key 是角色、identifier、文本、frame 与窗口的哈希）。插件将其映射到最新快照，因此在首次 `cu_observe` 之后只列出变化；发生变化的元素获得新 id，旧 id 视为未知，而不会被重新指向别的元素；
- 只有带 `retry: after_delay` 的拒绝会被重试（3 次，分别在 0.5/1/2 s 之后）；其他所有拒绝都会连同发生了什么、下一步该做什么一起返回给模型；
- 在 `appApproval: none`（默认值：bench、headless）下，`cu_request_app(app, mode, reason)` 进入守护进程的授权流程，该流程不弹窗直接拒绝。在 `appApproval: dialog`（插件包的模式、cu-std）下没有 `cu_request_app`：若某调用因应用未获授权（`not_granted`、`no_grant`，或带 `app` 的 `cu_observe`）或其 read 模式不允许（`needs_mode: full`）而在任何操作执行之前被拒绝，则先采用已覆盖该调用的现有授权（静默的 `access.request`）；否则立即向用户请求完整模式（以交互方式发送带调用中 `justification` 的 `access.request`，随后每秒发送一次 `access.status`，直到有人作答），然后重新发送该调用。以下情况不会询问：会话的 dsh 授权策略为 `never`（或没有授权服务），或该应用的弹窗在本轮已失败（被拒绝、超时、超出守护进程的上限）：此时仍由守护进程的 `approval_refused_earlier`、`approval_limit`、硬拒绝名单与黑名单决定。`justification` 字段及相应的系统提示词文本仅存在于该模式，因此 bench 的工具保持不变；
- `exclusive`（默认 true）：只要模型同时能看到任何非 cu_* 工具（bash、文件、run_code……），每个 cu_* 工具都会拒绝，因此即使 profile 配置有误，电脑操作也绝不会与 shell 并存运行；
- `onlyCuTools`（默认 false；即下文可安装插件包的模式）：该行位于一个 agent 预设内，该预设的每个 agent 在其第一步之前会被逐个名称地拒绝宿主提供给它的每个工具：在 `agent/created` 时；对于用户选择该模式时被移入其中的新会话 agent，则在 `agent-preset/selected` 与 `turn/start` 时；此后在每一步之前，对期间新增的宿主工具再次执行。dsh 在此处不会拒绝的工具（由同一预设的另一行注册的工具）仍然可见，此时 `exclusive` 会拒绝 cu_* 调用。它不能与 `hideFromRoot` 同时使用；
- `imePolicy`（默认 `ask`）与 `imeApproval`（默认 `call`，或 `task`）会写入授权。遇到 `ime_switch_needs_approval` 时，插件询问 `ctx.approval`（dsh 只有一次性授权，因此范围由配置决定），调用 `ime.approve` 并再发送一次文本；若被拒绝或处于 headless，则以 `ime_policy: leave` 发送，并说明输入源未被切换。`ime_switch_failed` 采用同样的降级处理；
- 屏幕文本被标注为不可信的观察内容，系统提示词中有一节说明规则（优先使用元素 id、声明坐标空间、换行即提交、不涉及凭据）。

dsh 0.1.5 不允许插件从对话历史中删除旧图像（`agent/request` 无法修改消息），因此长任务中每次观察都会累积一张图像；`cu_observe({image: false})` 可跳过图像。

```sh
plugin/scripts/link-deps.sh                       # use the reference plugin's dsh packages (same dsh version)
(cd plugin && npm run build && npm test)          # build: the host tsc, then the plugin page (scripts/build-client.mjs)
bench/experiments/run_vm_experiment.sh plugin_smoke.py   # the tools against the real daemon in a VM, no model
```

## 可安装的 dsh 插件包（电脑操作模式）

仓库根目录同时也是一个 dsh 插件包（`package.json`、`cordis.patch.yml`、`locale/`、`icon.svg`）：通过 dsh 的「添加插件」，或 `dsh plugin --profile <p> add`，可将其安装到日常使用的 dsh home 的某个 profile 中。它新增一个模式（agent 预设）「电脑操作」，以及管理守护进程及其设置的插件页；不改动其他模式中的任何内容：
- 包根（`cu-runtime`，`plugin/lib/host.js`）是一个顶层行 `cu-runtime-host`，不含工具。它在 dsh 0.1.5（无 profile 上下文）上终止加载并给出支持的版本范围（自 0.2.1-alpha.4 起，dsh 本身会拒绝 `engines.dsh` 范围之外的版本），并提供插件页（dsh 只在与包同名的顶层行上挂载包的页面）；
- 预设的插件为人设（`profiles/presets/cu-desktop`，名称沿用已退役的 cu-desktop profile）和工具行 `cu-runtime/tools`（`plugin/lib/index.js`），配置为 `apps: []`、`appApproval: dialog`、`electronAx: true`、`imePolicy: ask`、`imeApproval: call`、`restoreFocus: true`、`autoStart: true` 和 `onlyCuTools: true`。cu_* 工具注册在预设内部，因此只有该预设的会话能看到它们，而这些会话看不到其他任何工具（已在 dsh 0.2.1-rc.2 web 中针对一个记录请求的模型端点做过端到端检查：该模式下有 14 个 cu_* 工具，「标准模式」中一个也没有）。cu-std 与 bench 按路径加载 `plugin/lib/index.js`；
- `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery` 是 peer 依赖：使用正在运行的 dsh 自带的副本；
- `cordis.patch.yml` 由 `node scripts/gen-bundle-patch.mjs` 根据 `profiles/bundle/cordis.patch.yml.in` 与 `profiles/presets/cu-desktop` 生成；`plugin/tests/bundle.test.mjs` 检查它是否为最新、检查清单（manifest），并检查打包后的包是否包含已构建的插件及守护进程的源码。

添加插件需要 pnpm：dsh 的「添加插件」与 `dsh plugin` 会运行 dsh PATH 上的 `pnpm`。用 npm 安装的 dsh 不附带 pnpm，因此须先运行 `npm i -g pnpm`；缺少它时，「添加插件」只显示 "exit code 127"，没有其他任何输出（dsh 的日志中有 `spawn pnpm ENOENT`）。桌面应用（DeepSeek Harness.app）自带 pnpm。更新插件包的方式是在插件页上移除它，再添加新包，这同样需要 pnpm；插件页底部对此有说明。

插件页通过仅限所有者的路由 `POST api/cu-runtime.<op>` 与宿主行通信，除 `settings.apply` 外均不带参数（`plugin/src/daemon/`）：`status`（已安装的应用、版本、是否依据 `CUSourceHash` 由本包源码构建、签名、签名身份及其证书的 SHA-1、该身份是否为宿主上次签名所用或所创建的身份、是否在运行、近期自检得出的权限、Command Line Tools、SSH、安装任务，以及还有谁持有宿主的锁）、`install`、`cancel`、`permissions`、`start`、`stop`、`restart`、`selfcheck`、`clt` 与 `acceptIdentity`。在 dsh 0.2.1-rc.2 web 中，这些路由已用 curl 加所有者 cookie 检查过，页面也另行检查过；Electron 应用尚未检查，headless 则两者皆无。安装会在 `~/Library/Caches/cu-runtime/build` 中，用本包 `Package.swift`、`Sources/`、`Tests/` 与 `scripts/` 的副本构建守护进程（从不写入包目录），用 `cu-runtime-signing` 签名（缺失时创建；钥匙串会请本机前的用户允许签名，取消或拒绝该提示会使安装失败；终止 codesign 并不会关闭其密码对话框，因此在签名失败后，或任务在签名期间结束后，页面会提示可能仍有一个对话框开着，应点「拒绝」（Deny）将其关闭），检查新应用是否为正式版构建（Info.plist 中 `CUBench` 为 false：bench 构建绝不会替换已安装的应用）且满足 designated requirement（指定要求），停止正在运行的守护进程，替换 `~/Applications/CURuntime.app`，用 `open -g` 启动它并执行一次自检。若新应用和旧应用都无法就位，失败信息会指明两者分别留在何处。安装会拒绝 SSH 会话以及未安装 Command Line Tools 的 Mac（`clt` 会打开 macOS 的安装程序）。该指定要求由 bundle id 以及唯一一个名为 `cu-runtime-signing` 的本地签名身份的证书构成；若存在多个同名身份，install、start、restart、permissions 与 selfcheck 均会拒绝（`identity_ambiguous`）。页面的 start、restart、permissions 与 selfcheck 只有在已安装应用满足该要求且为正式版构建时才会启动它（已安装的 bench 构建显示为签名不匹配并被拒绝，`not_release_build`）；工具行的 `autoStart` 在打开已安装应用之前执行同样的检查（`open -g`；`plugin/src/autostart.ts`）：未通过检查的应用不会被打开，调用以 `the installed CURuntime.app is not a release build the plugin verified: <code>`（`not_installed`、`identity_missing`、`identity_ambiguous`、`not_release_build`、`signature_mismatch` 或 `internal`）被拒绝，并提示在「守护进程」标签中安装或更新它；此后 30 s 内给出同样的答复。`permissions` 每次调用打开一个“系统设置”面板：先是“辅助功能”，待自检（`selfcheck`，「检查权限」）显示辅助功能已授予后再打开“屏幕录制”，且从不重置任何授权。宿主把它上次成功签名所用或所创建身份的 SHA-1 保存在 `~/Library/Caches/cu-runtime/known-identity` 中；当该文件缺失、不可读或格式错误时，宿主所知的 SHA-1 取已安装的 `~/Applications/CURuntime.app` 叶证书的 SHA-1，仅为显示而读取（`codesign -d`，从不签名；页面将其标为「已安装应用的证书 SHA-1」（Installed app's certificate SHA-1），而非「上次使用的证书 SHA-1」），且只有在成功签名、创建或确认之后才会写入该文件。当唯一的 `cu-runtime-signing` 身份不是宿主所知的那个时（例如有同名的仿冒身份被放到了它的位置），安装会拒绝（`identity_changed`），直到所有者在页面上确认当前身份（「确认当前证书」，`acceptIdentity`，日志记录两个 SHA-1）；在此之前，页面也会暂停 start、restart、permissions 与 selfcheck，因此不会有任何权限授予该身份的应用。`acceptIdentity` 只接受页面显示过的那个身份：若证书此后又发生变化，它会拒绝（`identity_changed`）；无论哪种情况，页面随后都会重新读取状态，因此此时显示的就是新的 SHA-1。确认之前须核对：页面以 openssl 的格式显示两个 SHA-1，当前那个必须等于保存在本机之外的该身份 `.p12` 备份中证书的指纹（或保存在本机之外的 `cert.pem` 的指纹），这是同一用户下的代码无法调换的参照：`/usr/bin/openssl pkcs12 -in <the .p12> -nokeys -clcerts | /usr/bin/openssl x509 -noout -fingerprint -sha1`。`scripts/make-signing-identity.sh` 在本机上保留的副本（`openssl x509 -noout -fingerprint -sha1 -in ~/.cu-runtime-signing/cert.pem`）仅为方便之用：该用户的任何进程都能改写它，因此与它匹配并不能排除仿冒身份；若其旁边有 `cert.pem.replaced-*`（脚本再次创建身份时会这样重命名已有的 `cert.pem`），则说明它已被改写：确认之前应先查明原因。`security find-identity` 无法判断这一点：它列出的是钥匙串当前持有的内容，与宿主读取的是同一来源，而且加 `-v` 时根本不会列出这个不受信任的身份。同一时间只运行一个安装，跨 dsh 进程也是如此：当另一个 dsh 进程，或同一进程中较早加载的本包（更新后仍在收尾）持有锁时，状态会给出其 pid 及起始时间（`busy`），页面会禁用其按钮并每秒读取一次状态。每项操作连同其结果及失败信息都会记录到 `~/Library/Caches/cu-runtime/host-actions.log`。状态中不含令牌、审计或屏幕内容。

守护进程的设置经由同一行到达插件页（`plugin/src/daemon/settings.ts`）：`settings.snapshot`、`settings.apply`、`settings.cancelVerify`，以及用于 `choose_log_directory`、`use_default_log_directory`、`choose_app`、`export_settings`、`export_audit`、`import`、`import_confirm` 和 `reveal_log` 的 `settings.action.<name>`。它们只调用守护进程的 `settings.snapshot`、`settings.apply {change}`、`settings.cancel_verify` 和 `settings.action {name}`，每次都通过一条连接到固定状态目录中 socket 的连接进行，用完即关闭，且不会启动守护进程；仅在宿主已验证的已安装应用（满足 designated requirement 并启用 hardened runtime 的正式版构建）运行时可用（否则为 `not_running`），在安装任务停止、替换或启动它期间也不可用（`busy`）。`settings.apply` 是唯一读取请求体的路由：要求 `content-type: application/json`、请求头 `x-cu-runtime-page: 1`、最多 4096 字节，以及恰好含一项、符合守护进程解码方式的改动的 `{"change": {...}}`（已知的 `kind` 且恰好是其所需的键、页面提供的取值，以及 bundle ID、备注、快捷键与任务 ID 的限制）；其他任何情况均返回 HTTP 400 `bad_request`，既不会到达守护进程，也不会到达验证关卡，实际发送的是由已检查字段新建的对象。快照只保留页面显示的顶层键；页面认识的守护进程拒绝会保留其原因（`verify_cooldown` 带 `data.until`），其他一律为 `daemon_error`，消息截断至 300 个字符。守护进程会再次检查每项改动，并在任何有所放宽的改动之前自行验证用户身份（Touch ID 或密码）；宿主从不打开或在 Finder 中显示来自页面或守护进程的路径。没有其他路由转发守护进程请求。

插件页有一个标签栏（`plugin/src/client/settings/shell.ts`；若正在运行的 dsh 提供 SegmentedTabs 则使用它）：「守护进程」（Daemon），即上文所述、最先显示的页面；随后是守护进程的各项设置，顺序与设置窗口一致：「概览」「档位与默认」「应用名单」「快捷键」「隐私与审计」「行为与模型」和「日志」。设置标签仅在其中某一个显示时读取 `settings.snapshot`：当有改动在等待本机身份验证、或守护进程的某个面板正在本机上打开时每秒一次，其他情况每 10 s 一次，并在每次改动、操作或取消之后立即读取。等待 Touch ID 或登录密码的改动会在每个设置标签上显示一条横幅，说明它的作用并提供「取消」（`settings.cancelVerify`），且在其有结果之前禁用所有会改动内容的控件；有结果后显示一次该结果。「概览」显示三项权限、新会话默认值、当前生效的授权及其剩余时间（按任务「撤销」、「全部撤销」）以及最近的拒绝。「档位与默认」设置访问规则（`access.set`）。「应用名单」维护始终允许名单（以某一模式添加、更改模式、重新授权签名已变化的应用、移除）和黑名单（带备注添加、移除），应用通过守护进程的应用选择面板（`choose_app`）挑选，并显示任何设置都无法改变的硬拒绝名单（系统底线）。「快捷键」可关闭或开启内置快捷键，并添加或移除自定义快捷键（通过键入而非录制）。「隐私与审计」设置发送给模型的内容（`privacy.set`）、仅文本应用，以及每轮开始时是否清空剪贴板。「行为与模型」设置行为字段，在确认后重置设置，并通过守护进程的面板导出与导入设置：导入的文件在应用之前，会与当前生效的设置比较，显示它改动了什么、放宽了什么。「日志」显示日志文件夹（只能通过守护进程的文件夹面板更改，或恢复为默认），设置保留期限，导出最近 7 天，在 Finder 中显示该文件夹，并列出最近的设置改动。页面从不判断何为放宽；每项改动都由守护进程判断。设置窗口（`cu-runtime settings`）具有相同的页面。

「守护进程」标签还显示模式检查（`plugin/src/daemon/mode-check.ts`，路由 `modeCheck` 与 `modeCheckRefresh`，均返回 `{ok: true, result}`）：正在运行的 dsh 的 home（`DSH_HOME`，默认 `~/.dsh`；不检查其他 home）下的每个 profile 都通过 `dsh --profile <p> --dump-config` 检查（dsh Electron 应用的 profile 则通过其文件检查）：cu_* 工具只能出现在插件包的模式中、且只在一行中，该行须开启 `onlyCuTools`、设为 `appApproval: dialog` 且未关闭 `exclusive`；任何 profile 中都不得有其他电脑操作插件。结果缓存 60 s；「重新检查」会再次运行。宿主行加载约 10 s 后会运行一次，每条未通过的行都会作为警告写入 dsh 的日志：`cu-runtime: mode check: profile <p>: …`。

尚未实现：该模式的设置不在 dsh 的插件页上（预设中的行无法在那里配置）。模型及其推理强度属于会话，由用户选择：应选择支持图像输入的模型。该模式的会话（包括截图）与日常 home 的其他会话保存在一起；dsh 的遥测与反馈上传属于 dsh 自身的设置，其反馈上传（`FEEDBACK_ONLY`）会发送用户所提交的会话。

在检出的仓库中（`plugin/node_modules` 由 `plugin/scripts/link-deps.sh` 生成，见上文），在仓库根目录运行 `npm run build` 会构建插件包入口点所指的每个文件：宿主服务与工具（宿主 tsc 输出到 `plugin/lib`）以及插件页（`plugin/lib/web-client.js`，由 `scripts/build-client.mjs` 生成）。`scripts/install.sh` 与 `scripts/install-cu-std.sh` 执行同样的构建，因此从同一检出以 link 方式安装的插件包，其页面与宿主来自同一提交。`plugin/lib` 不受版本跟踪，而 link 安装按原样运行检出中的文件，因此每次 pull 之后、dsh 重启之前都须再次运行 `npm run build`：否则 dsh 运行的是上一次的构建；而当页面文件缺失时（自加入插件页以来尚未构建过的检出），dsh 会拒绝启动整个 profile，而不仅仅是该页面。仍持有插件页出现之前那版插件包的 profile（其顶层行名为 `cu-runtime/host`，工具行名为 `cu-runtime`），须移除插件包并重新添加此版本来更新；模式检查会判定此类 profile 不通过，并说明处理方法。

```sh
npm run build                                     # from the repository root; again after every pull, before dsh restarts
dsh plugin --profile web add link:$PWD            # from the repository root; remove: dsh plugin --profile web remove cu-runtime
```

## 测试

钩子不会随克隆复制，因此须在**每台机器上**运行一次 `scripts/install-hooks.sh`。它设置 `core.hooksPath=scripts/hooks`；在 `.git/info/private-patterns` 写入使用者自己的私有字符串之前，pre-push 钩子会拒绝推送。每次推送前，该钩子会运行：
- Swift 测试与 pytest；
- 对完整历史运行 gitleaks、semgrep，以及 SwiftLint（仅错误）；
- 隐私检查：已跟踪文件中的通用模式、每个被推送提交的作者与提交者是否为 GitHub noreply 地址，以及 `.git/info/private-patterns` 中使用者自己的私有字符串。该文件从不推送。

审计报告位于 `docs/audits/`。

**测量结果依赖守护进程的行为。** 测量脚本读取的是守护进程返回的内容，因此当该行为发生变化（过滤、去重、几何）时，应先重新验证测量，再信任其结果。QQ AX 覆盖率脚本写于 OCRDedup 出现之前；去重开始丢弃 AX 已覆盖的 OCR 行之后，其 "on" 数值低得离谱（comparison.md，Result 1e）。

`swift test` 运行 206 个测试。`RedTeamTests` 是 R1 红队测试集：每次尝试都必须被拒绝并记入审计。阳性对照用于防范一个干脆拒绝一切的守护进程。2026-09-28 对该测试集做了变异检查：分别移除命中测试、快捷键过滤和最前应用停止；每次移除都使本应发现它的测试失败。

VM 脚本需要 `cu-base` Tart VM 和 `vm-lib.sh`，并部署 bench 构建：须先运行 `CU_BENCH=1 scripts/build-app.sh`（输出到 `dist-bench/`）（`vm-signing-check.sh` 会自行构建）。克隆之前，`require_bench_app` 会检查它是否为由唯一的 `cu-runtime-bench-signing` 身份签名（以该身份的证书执行 `codesign --verify -R`）且启用 hardened runtime 的 bench 构建。基础镜像须对 bench 身份授权一次；具体步骤（创建身份、构建、`prepare`、手动授权、`finish`、`vm-signing-check.sh`，对 `cu-base-qq` 同样执行）见 `scripts/vm-grant-base.sh` 的文件头。

- `scripts/vm-grant-base.sh prepare|finish`：一次性安装，加上维护者在基础镜像中进行的 TCC 授权；仅当 bench 签名身份变化时才需重做。`prepare` 会先在客户机中重置该应用的条目（授予另一证书的条目仍会列出，但不匹配）；`finish` 仅在自检显示两项授权均已授予时才关闭基础镜像。
- `scripts/vm-signing-check.sh`：重新构建，部署到一个不重新授权的全新克隆，然后检查 `AXIsProcessTrusted()` 及一次真实的 SCK 捕获。使用 `CU_SIGN_IDENTITY=-`（ad-hoc）时它必须失败（FAIL），实际也确实如此。

### 几何测试集

`bench/geometry/run_vm.sh` 针对每种显示配置，在一次性的 `cu-base` 克隆中运行 `bench/geometry/collect.py`：`hidpi`（1440×900 pt @2x）与 `1x`。须先运行 `CU_BENCH=1 scripts/build-app.sh`（输出到 `dist-bench/`）；仅运行 `swift build` 不会更新 `dist-bench/`。该测试集会开启 `debug_native_images`，只有 bench 构建在启动时带有此开关。可用 `ONLY="pos-center occlusion"`（场景前缀）和 `CONFIGS=hidpi|1x` 筛选。结果（仅数值）及失败用例的叠加图写入 `bench/runs/geometry-<ts>/`（已加入 gitignore）。

真值从不来自被测的流水线：标记位置来自 fixture 自身的布局，点击落点来自其 `mousedown` 事件。以此为准检查四条路径：

| 路径 | 内容 | 通过标准 |
|---|---|---|
| A | 在原生合成图中找到的标记，映射到全局坐标点 | ≤ 2 pt |
| B | 标记按钮的 AX frame | ≤ 2 pt |
| C | 在 A 点的一次真实点击，以 fixture 所见的落点为准 | ≤ 2 pt |
| D | 在缩小后的（模型）图像中找到的标记，映射回去 | ≤ 1 个发送像素 |

场景涵盖窗口位置与尺寸、屏幕外窗口与超大窗口、无边框窗口、两个窗口、sheet、上下文菜单、被未授权应用遮挡、另一应用的一个不可见（alpha 0）、始终置顶且接收点击的窗口，以及作为阳性对照的其点击穿透版本、最小化与隐藏的应用、过期快照、动画、全屏，以及菜单栏与 Dock（包括自动隐藏和停靠在左侧）。点击要么落在其标记上，要么被拒绝；落在其他任何位置即为失败。场景可标记为 `xfail`（已知缺陷，且有计划中的修复）：其失败会显示但被容忍，而通过反而会使本次运行失败，以便移除该标记。除非每个配置都产生了结果且全部通过，运行器都会以非零状态退出；每个配置的完整输出见 `runner.log`。

两项结果塑造了守护进程：

- **附着的 sheet 从不单独捕获。** SCK 会在 sheet 的单窗口捕获中渲染整个父窗口的缩放副本（偏差 39.6 pt）；父窗口的捕获已包含该 sheet，且位置正确（0 pt）。sheet 的像素取自父窗口的捕获；sheet 上的 OCR 文本与 AX 元素归属于 sheet 窗口（`canary --sheet`，2026-09-29）。
- **泄漏测试。** 一个未授权窗口显示随机的 `LEAKCANARY` 字符串；已授权窗口显示 `POSCTRL` 作为阳性对照（仅像素，对 AX 隐藏，因此检验的是 OCR）。该 canary 不得出现在守护进程的 OCR 中、覆盖两段文本的 `zoom` 中（其 OCR 与图像）、任一合成图或在宿主机上经 OCR 重读的 zoom 图像中，也不得出现在守护进程写入的任何文件中。`LEAK_SELFTEST=1` 会把 canary 放进已授权窗口，此时测试必须失败（FAIL）。
- **系统叠加层被展开为其可见部分，而非其应用的其他窗口。** Dock 与通知中心覆盖整个显示器的窗口（层级 20 和 21）被替换为其应用的顶层 AX frame；通知中心的这些 frame 包括其桌面小组件，而小组件是独立的桌面层级窗口，因此与同一进程另一窗口相匹配的部分保留该窗口的位置（2026-10-10：此前只要有横幅窗口出现，小组件就会被绘制在 fixture 之上）。
- **fixture 上方的真实横幅（`notification-banner`）。** fixture 发布一条通知（从 GUI 会话发出；经 ssh 由 osascript 发送的通知会立即被撤回）。横幅出现前不久，同样的两次点击都能正确落点；横幅出现时，被遮挡的那次点击被拒绝并指明通知中心，未被遮挡的那次正确落点。
- **不可见叠加层（审计 L3）。** CG 窗口列表会跳过 alpha 为 0 的窗口，但在点击之前，AX 命中测试（窗口服务器的路由）必须指向同一应用，而它指向的是该叠加层：6/6 次点击被拒绝。移除 AX 检查后，6/6 次被拦截，说明该场景能发现此问题；点击穿透对照 6/6 次正确落点。

该测试集在测量前会等待守护进程列出 fixture 的窗口（`meta.launch_wait_s`）：窗口服务器可能比 fixture 自身报告的“可见”滞后最多约 2 s。

2026-09-29：56/56（28 个场景 × 2 种配置）。2026-10-10：64/64（32 × 2）。在全屏场景之前，指针会被移到屏幕中央：若被上一次点击留在 Dock 栏上，它会阻止 Dock 自动隐藏，底部一行确实会被遮挡。失败的场景附带守护进程的 z 顺序（`debug_zorder`，仅供测试的开关）和窗口服务器的列表；`GRAPHICS=1` 会显示 VM 窗口。
