# bench/ — 读屏（OCR / VLM）效果 bench

用来量化 dsh-computer-use 在"字只存在于像素里"的场景下能读对多少、会不会编，并在同一套数据上比较各个读屏后端。任务书是 `../../PLAN.md`，环境踩坑和 Phase 0 的结论见 [`SETUP_NOTES.md`](SETUP_NOTES.md)。

> **2026-09-28 起 bench 住在 `cu-runtime/bench/`**，从 `dsh-computer-use` 用 git subtree 迁过来，历史保留。`dsh-computer-use` 此后只作参考：A0/A1 这两组上游基线仍然用它的插件和守护进程，路径由 `DSH_CU_LEGACY` 指定，默认是 `../../dsh-computer-use`。E2E 用 `bench/vm/run_vm.sh` 在虚拟机里跑，客体里的目录结构没有变。
>
> 这个目录**不进**给上游的 PR。`corpus/real/`、`runs/`、`*.ax.txt` 可能包含隐私内容（见 SETUP_NOTES 第 14 条），已加入 gitignore，只留在本机。

bench 分两层：

| 层 | 跑什么 | 谁跑 | 花不花钱 |
|---|---|---|---|
| 离线组件层 | 读屏后端直接吃截图，对照真值打分 | CC 全自动 | 不花（云端 VLM 后端除外） |
| E2E agent 层 | dsh agent 带着工具做任务，对照答案打分 | headless 自动跑，由 维护者触发；或 维护者在 dsh web 里手动跑 | 花 DeepSeek API 费用 |

## 目录

```
bench/
├── SETUP_NOTES.md            Phase 0：环境指纹、踩坑、五个问题的答案
├── fixture-app/              可控的"AX 盲区制造机"（Electron）
├── fixtures/content.yaml     题库：所有消息的真值文本 + 关键串
├── corpus/
│   ├── capture_synthetic.mjs 批量截 fixture → synthetic/*.png|.ax.txt|.gt.json
│   ├── check.py              语料自检（空白图、真值框有没有字迹、AX 覆盖率）
│   ├── draft_real_gt.py      给真实截图起草真值（维护者校对）
│   ├── synthetic/            （gitignore，可以重新生成）
│   └── real/                 （gitignore，只留本机）
├── offline/                  离线评分：metrics.py / run.py / summarize.py
├── results/offline/          各后端结果 JSON + summary.md
├── tasks/                    E2E 任务（T1–T8），_common.yaml 是统一追加的规则
├── arms/                     A0、A1…：模型 + 插件配置
├── run_e2e.py / run_e2e.sh   E2E 运行器（headless 或生成手动清单）
├── score_e2e.py              E2E 打分
├── tests/                    单测和不走模型的集成检查
└── tools/                    cua-rpc.mjs、vision-ocr.swift、坐标和 run loop 复现程序
```

## 一次性准备

```sh
# 守护进程和插件（仓库根目录下）
(cd native && swift build -c release)
(cd packages/computer-use/dsh-computer-use && npm install && npm run build)
./scripts/build-app.sh && git checkout -- dist/AppIcon.iconset   # 顺手还原被重写的图标

# fixture app（npm 11 不跑 postinstall，所以 electron 要手动装）
cd bench/fixture-app
npm install
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
node scripts/bundle.mjs            # → dist/DSHFixture.app，app 目录是软链接指回源码，改代码不用重新打包

# 命令行工具（vision-ocr、inputsource → tools/bin，git 不跟踪；VM 实验的 runner 也会自动调用）
cd .. && tools/build-tools.sh
```

权限：从 CC 所在的终端拉起的进程，会继承这个终端的「屏幕录制」和「辅助功能」授权。dsh web 用的是 `dist/DSH Computer Use.app`，需要按 `docs/accessibility-setup.md` 把它加进这两个权限列表。

## fixture app

同一份内容，三种渲染方式：

| `--mode` | 字怎么变成像素 | AX 能看到多少（实测行覆盖率） |
|---|---|---|
| `dom` | 真实的 DOM 文本节点 | 90–100%（缺的正好是图片消息里的字） |
| `canvas` | 整个界面画在一个 `<canvas>` 上 | 约 2% |
| `image` | 每个区块预先渲染成不带 alt 的 `<img>` | 约 2% |

```sh
bench/fixture-app/fixture --mode canvas --theme dark --conv 3 [--scroll 260] [--run-dir DIR] [--gt-out F] [--ax off] &
```

- 窗口固定为 960×680 pt，字体固定。所有换行都用 canvas 的 `measureText` 统一算一次，所以三种模式的真值（每一行的文字和 bbox）完全一致。
- 点击会写进 `<run-dir>/clicks.jsonl`（字段 `target` 取值如 `btn:收藏`、`conv:c4`、`msg:c3m3`），这就是 T5 的真值。
- 滚轮滚动的是消息区；消息列表像真实聊天软件一样做了虚拟化，视口外的消息不渲染，也就不会出现在 AX 里。
- 守护进程按应用名 `DSHFixture` 查找窗口，所以**同一时间只能开一个实例**。启动脚本会先杀掉旧实例。

## 离线层

```sh
node bench/corpus/capture_synthetic.mjs          # 60 张：3 种模式 × 亮/暗 × 10 个会话/滚动位置，约 3 分钟
python3 bench/corpus/check.py                    # 应该显示 0 with problems
python3 bench/offline/run.py --backend ax
python3 bench/offline/run.py --backend apple-vision
python3 bench/offline/summarize.py               # → results/offline/summary.md
```

截图全部走真实的 `CUADaemon get_app_state` 管线：2x Retina，包含标题栏。真值的 bbox 已经换算成截图像素，换算关系是 `px = (contentOffset + pt) × scale`。

指标（口径细节写在 `summary.md` 开头）：
- **CER**：逐行计算，只做空白归一。*loose* 口径额外做 NFKC 全半角折叠。
- **关键串召回**：关键串必须逐字符出现，只忽略空白；`l/1/I`、`O/0` 混淆一律算错。
- **bbox 命中**：识别出某个按钮或会话标签的框，其中心点落在该元素内就算命中。
- 另外报告 p50/p95 延迟、冷启动时间和峰值 RSS。

新增后端的方法：在 `offline/run.py` 的 `BACKENDS` 里注册一个函数，接收图片列表，返回 `{图片名: {blocks: [{text, bbox?, confidence?}], latency_ms}}` 和一份 meta。`http-ocr` 后端会把 PNG POST 到 `$HTTP_OCR_URL`，期望返回 `{"blocks": [...]}`。

真实集的做法：维护者把截图放进 `corpus/real/`，命名如 `qq_01.png`，然后运行 `python3 bench/corpus/draft_real_gt.py` 起草真值，逐个校对，补上 `keystrings` 和 `regions`，最后删掉 `"draft": true`，再执行 `run.py --corpus bench/corpus/real`。

## E2E 层

```sh
CU_BENCH=1 scripts/build-app.sh                  # 先构建 bench 版守护进程 → dist-bench/CURuntime.app（不会进 dist/）
bench/vm/run_vm.sh --arm B3 -k 5                 # 在一次性 VM 克隆里跑：全部启用的任务 × dom/canvas/image × 5 次
bench/smoke.sh                                   # 冒烟：B3，2 个任务，canvas，1 次（同样在 VM 里）
bench/vm/run_vm.sh --arm B3 --preflight-only     # 只做工具自检，不调模型
python3 bench/score_e2e.py bench/runs/<run_id>   # → score.md / score.json（宿主机上跑即可）
```

- ⚠️ **E2E 只在 VM 里跑。** `run_e2e.py` 和所有实验脚本在宿主机上会直接拒绝启动（`vmguard.py`，判据是 `kern.hv_vmm_present` 和 `hw.model`）。起因见 `docs/incidents/2026-09-29-host-model-run.md`。
- **VM 里只部署 bench 构建**（`dist-bench/CURuntime.app`，Info.plist 的 `CUBench` 为 true）。bench 和各实验在克隆的 `config.json` 里打开 `config_grants`、`debug_activation`、`debug_ime`（几何套件还有 `debug_native_images`），release 构建见到这些开关（或任何 `--state-dir`，写成默认目录也一样）会拒绝启动。所有 VM 脚本经 `scripts/vm-lib.sh` 部署，部署前检查 `CUBench`；`dist/` 里的 release 构建不会进 VM，`build-app.sh` 也不会把 bench 构建放进 `dist/`。
- **bench 构建用单独的签名身份 `cu-runtime-bench-signing`**（`build-app.sh` 在 `CU_BENCH=1` 时默认用它，拒绝用 release 的 `cu-runtime-signing`，反之亦然；两种构建都带 hardened runtime）。这台 Mac 上的两项权限绑定的是 release 证书，bench 构建拿不到；只有 VM 底板授予 bench 证书。部署前 `require_bench_app` 用 `codesign --verify -R` 核对 bench 证书和 hardened runtime 标志。底板只需授权一次（bench 身份重新生成时再做一次），步骤见 `scripts/vm-grant-base.sh` 开头：生成身份（`zsh scripts/make-signing-identity.sh cu-runtime-bench-signing`）→ `CU_BENCH=1 zsh scripts/build-app.sh`（钥匙串弹窗点"允许"，不要点"始终允许"）→ `scripts/vm-grant-base.sh prepare` → 在底板窗口里打开 CURuntime 的辅助功能和屏幕录制 → `scripts/vm-grant-base.sh finish`（自检两项都通过才关机）→ `scripts/vm-signing-check.sh` 应为 PASS（它会重新构建，钥匙串再要一次登录密码，同样点"允许"）。QQ 底板有自己的授权，也要做一次：`CU_BASE=cu-base-qq scripts/vm-grant-base.sh prepare` → 同样在底板窗口里授权 → 收尾用 `scripts/vm-qq-base.sh finish`（自检相同；关机前先用 SIGTERM 退出 QQ 并等它退出，测试账号的登录才保得住，见 `bench/vm/qq/README.md`）。`vm-grant-base.sh finish` 遇到装了 QQ 的底板会拒绝，并提示改用它。不要在宿主机上给 bench 构建授权。
- **3ecf445 之前的构建都是用 release 证书签的**（当时的 bench 构建和第一版 R1 也一样），没有 hardened runtime，在这台 Mac 上照样带着两项权限；R1 之前的还认 `--state-dir` 和上面那些调试开关。旧的 `dist-bench/`、`dist/`、worktree 里被忽略的 `dist*/` 和归档里的副本都算。`zsh scripts/find-release-builds.sh` 把本机所有 CURuntime.app 列出来，这类标为 REMOVE（`--delete` 在终端输入 yes 后删除）；更彻底的做法是轮换 release 证书，见 README.md「Signing」。用 bench 证书签的构建只列出、不标记。
- 每个任务 × 模式 × 第 k 次，都会重启一次 fixture，再跑一个 `dsh --profile cu-bench` 进程。已经有 `result.json` 的任务会跳过，所以中断后可以接着跑。
- **bench 自己的 dsh profile**（`dsh-profile/cu-bench`）：runner 每次把它拷进这次 run 的 `runs/<id>/dsh-home`，并用它作 `DSH_HOME`。profile **本身**就关闭了 bash、文件、web、subagent 等全部非 `cu_*` 工具，钉死 native 工具模式、只读沙箱，并关闭遥测；overlay 或 settings 加载失败也不会退回带 bash 的默认配置。
- **key**：profile 只认 `CU_BENCH_DEEPSEEK_KEY`，只从客体里的 `/Users/a1/.cu-bench/credentials.yaml` 读取。`run_vm.sh` 在每个克隆里用 `vm/guest_key.py` 把 key 从 dsh 默认库挪过去，底板不改。宿主机上没有这个文件，用这个 profile 跑会在第一次调模型前报 `MISSING_CREDENTIAL`。
- **环境**：dsh 只继承白名单里的环境变量（`DSH_ENV_ALLOW`）。
- **自检**：启动时 dsh 的请求发往一个探测过、确认拒绝连接的本地端口（`$DEEPSEEK_BASE_URL` 和 settings 两层都设），只有报 `TRANSPORT` 到该端口才算通过，然后断言请求头里只有 `cu_*` 工具。每个 job 结束后按实际请求头再查一遍。
- **隔离**：dsh 的所有状态（sessions、storages、附件、file-id 缓存）都在这次 run 的 `dsh-home` 和 run 目录里，不读也不写 `~/.dsh`；sessions 不压缩，便于直接解析 JSONL；settings 写到 run 目录，用来钉死模型。
- **A0 和 A1 用同一个模型**（`deepseek-v4-flash-vision-exp`）。A0 在隔离的 settings 里把这个模型声明为 text-only，于是截图只以 `file://` 路径的形式出现；A1 让截图作为 image block 送进模型。`score.md` 里的「images reached model」一列用来核对 arm 是否真的生效。
- 判定方式：`exact`（忽略空白、逐字符比较）、`cer_list`、`click`（查 `clicks.jsonl`）、`bait`（正确答案是 null）。答错的分三类：弃答、读错/认错位置（答案是屏幕上另一处的真实文本）、**编造**（fixture 里根本没有这个串）。
- **R5 固定参数**：步数上限 25（`MAX_STEPS`，由插件执行：超过后工具拒绝并要求作答，再过 2 步结束这一轮），每个 job 超时 240 秒（`TIMEOUT_S`）。开跑后不改；`env.json` 里的 `limits.r5_fixed` 会标明。
- **记录**：`vm/run_vm.sh` 在销毁克隆前拷回客体完整审计（`guest-audit/`），并把 run 归档到被忽略的 `bench/archive/`，保留 30 天。**删除 run 目录只用 `python3 bench/records.py clean <run>`**，它会先归档；不要直接 rm。
- 两台 VM 并行时设 `PARALLEL_VMS=2`，score.md 会注明耗时不能当延迟数据。阶段 1 结束后用 `python3 bench/discriminate.py <各组 run>` 选出阶段 2 要跑的组合。
- `--manual`（生成在 dsh web 里手动跑的清单）同样只能在 VM 里用。
- headless 模式下审批永远是 0（`requireAppApproval: false`）。

## 测试

```sh
python3 -m unittest discover -s bench/tests -p 'test_*.py'   # 打分逻辑，纯函数
node bench/tests/click_plumbing.mjs                          # 不走模型：三种模式下按 point 坐标点击，确认命中（会真实移动鼠标）
```
