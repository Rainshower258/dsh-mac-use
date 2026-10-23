#!/bin/zsh
# Preflight and guide for cu-runtime in the everyday dsh (docs/desktop.md). First it checks everything you install
# yourself (Command Line Tools, Node.js, dsh and its version, pnpm, the API key in ~/.dsh) and lists all that is missing
# at once. Then:
#   1. when ~/Applications/CURuntime.app is installed, it asks the app (its self-check, through LaunchServices) which of
#      its two permissions are in effect, and clears the System Settings rows of those that are not (`tccutil reset`
#      for the app's bundle ID: a row that does not match this app loses nothing), so the plugin page's 守护进程 tab →
#      授予权限 asks again from a clean slate. A permission in effect is never reset, and nothing is requested here;
#   2. installs the plugin's dependencies and builds the plugin (`npm run build` at the repository root), so this
#      checkout can be added on dsh's plugin page by its path;
#   3. prints the steps that are left, all on dsh's plugin page.
# It never builds or signs the daemon app and never makes a signing identity: the plugin page's 守护进程 tab does that
# (安装守护进程). It never uses sudo, never replaces a dsh you already have and never writes a dsh home. Run it again
# whenever you like. Run it in Terminal on your Mac's screen, not over SSH.
#   zsh scripts/install.sh
#   zsh scripts/install.sh --permissions-only
# --permissions-only skips the preflight and the build and does step 1 alone (the self-check, the reset of the rows not
# in effect, quitting System Settings), which needs none of the tools the preflight checks: for a permission switched on
# that still checks as missing (a row of another certificate), with any dsh, the desktop app's included. The preflight's
# failure message names it. The commands printed for copying quote their paths, so a checkout path with a space
# survives a paste; 添加插件 is given the checkout's absolute path, since dsh's add form takes no ~/….
set -euo pipefail

ROOT=${0:A:h:h}
DSH_VERSION=0.2.1-rc.2        # the version cu-runtime is tested on (docs/desktop.md); 0.2.0-rc.2 until 2026-10-17
NODE_MAJOR=24
APP=$HOME/Applications/CURuntime.app
BUNDLE_ID=dev.cu-runtime.daemon
# A path as a command to paste shows it: under HOME as ~/ and the rest quoted where it needs it (a space, a quote), the
# ~ outside the quotes so the shell still expands it; elsewhere the whole path quoted the same way.
pasted() {
  local rest
  if [[ $1 == $HOME/* ]]; then rest=${1#$HOME/}; print -r -- "~/${(q-)rest}"; else print -r -- "${(q-)1}"; fi
}
AGAIN="zsh $(pasted $ROOT/scripts/install.sh)"
perms_only=0
for a in "$@"; do
  case $a in
    --permissions-only) perms_only=1 ;;
    *) print -u2 "unknown option: $a (see the comment at the top of this script)"; exit 1 ;;
  esac
done

step() { print; print -P "%B[$1/2] $2%b" }
ok() { print "  ✓ $*" }
info() { print "  · $*" }
# Something only you can do: say what, then stop.
need() {
  print -r -u2 -- "  ✗ $1"
  shift
  for line in "$@"; do print -u2 "    $line"; done
  print -u2
  print -r -u2 -- "  做完以后重新运行：$AGAIN"
  exit 2
}

# ---------------------------------------------------------------- the permission step (step 1, or alone)
# self-check runs through LaunchServices, as the app itself, so it reports the app's own permissions. `open -W` cannot
# always wait for it ("Unable to block on application", VM 2026-10-11), so the result file is waited for instead. It
# prints "answered" once the app wrote its result, then which permissions are in effect.
permissions() {
  local out=$(mktemp -d)/self-check.json
  open -n $APP --args self-check --out $out 2>/dev/null || true
  for _ in {1..40}; do [[ -s $out ]] && break; sleep 0.5; done
  [[ -s $out ]] || return 0
  print -n 'answered '
  # plutil reads JSON and comes with macOS (python3 is only a stub until the Command Line Tools are in).
  [[ $(plutil -extract ax_trusted raw -o - $out 2>/dev/null) == true ]] && print -n 'ax '
  [[ $(plutil -extract sck.ok raw -o - $out 2>/dev/null) == true ]] && print -n 'screen'
  print
}
# A permission granted to an earlier build signed with another certificate (the identity was deleted and made again, or
# the app came from another Mac) stays listed as "CURuntime" in System Settings but does not match this app: turning
# that row on changes nothing, and System Settings, if left open, can even write the old row back (VM 2026-10-11). So
# the rows of a permission not in effect are reset (such a row loses nothing) and System Settings is quit, so it lists
# the app afresh when 授予权限 opens it. A permission in effect is left alone, and so is everything when the app did
# not answer: then which one is in effect is not known.
permission_step() {
  if [[ ! -d $APP ]]; then
    info "还没有安装 ${APP/#$HOME/~}：之后在插件页的“守护进程”标签里点“安装守护进程”安装它。"
  else
    granted=$(permissions)
    if [[ $granted != answered* ]]; then
      info "${APP/#$HOME/~} 的权限自检没有返回结果，没有清除任何授权记录。"
      info "之后在插件页的“守护进程”标签里点“检查权限”查看；若权限没有生效，点“重新安装守护进程”后再点“授予权限”。"
    elif [[ $granted == *ax* && $granted == *screen* ]]; then
      ok "辅助功能、屏幕录制都已生效"
    else
      cleared=()
      [[ $granted == *ax* ]] || { tccutil reset Accessibility $BUNDLE_ID >/dev/null 2>&1 || true; cleared+=(辅助功能); }
      [[ $granted == *screen* ]] || { tccutil reset ScreenCapture $BUNDLE_ID >/dev/null 2>&1 || true; cleared+=(屏幕录制); }
      osascript -e 'tell application "System Settings" to quit' >/dev/null 2>&1 || true
      ok "已清除未生效的授权记录：${(j:、:)cleared}（已生效的权限没有动）"
      info "之后在插件页的“守护进程”标签里点“授予权限”重新申请；这里不申请任何权限。"
    fi
  fi
}

# --permissions-only: step 1 alone, without the preflight (it needs none of those tools) and without the build.
if (( perms_only )); then
  print -P "%B系统权限：辅助功能、屏幕录制%b（只做这一步：--permissions-only）"
  permission_step
  exit 0
fi

# ---------------------------------------------------------------- preflight: everything you install yourself
# All of it is checked before anything is done, and everything missing is listed at once, in the order to install it
# (Node.js before dsh and pnpm, which npm installs).
print -P "%B预检%b"
missing=()
miss() { print -u2 "  ✗ $1"; missing+=("${(pj:\n:)@}") }
[[ $(uname) == Darwin ]] || { print -u2 "只支持 macOS。"; exit 2; }
macos=$(sw_vers -productVersion)
(( ${macos%%.*} >= 14 )) || { print -u2 "需要 macOS 14 或更新的版本，这台是 $macos。"; exit 2; }
if [[ -n ${SSH_CONNECTION:-} ]]; then
  miss "在 SSH 里运行" "请在这台 Mac 屏幕上的“终端”里运行：权限检查要通过 LaunchServices 以 CURuntime 自己的身份运行，" \
    "之后的授权和插件页也都在这台 Mac 的屏幕上操作。"
else
  ok "macOS $macos"
fi

if xcode-select -p >/dev/null 2>&1; then
  ok "Xcode 命令行工具：$(xcode-select -p)"
else
  xcode-select --install >/dev/null 2>&1 || true
  miss "没有 Xcode 命令行工具（插件页安装守护进程时要用其中的 Swift 编译器）" "已经弹出安装窗口：点“安装”，等它装完。" \
    "提示磁盘空间不够（它要求先空出约 25 GB）时，见 docs/desktop.md 安装一节的替代办法。"
fi

node_version=$(node --version 2>/dev/null || true)
if [[ $node_version == v$NODE_MAJOR.* ]]; then
  ok "Node.js $node_version"
else
  if [[ -n $node_version ]]; then node_problem="Node.js 是 $node_version，需要 $NODE_MAJOR 版本"; else node_problem="没有 Node.js"; fi
  miss $node_problem \
    "到 https://nodejs.org 下载 $NODE_MAJOR 版本的 macOS 安装包（.pkg），双击装完。"
fi

dsh_version=$(dsh --version 2>/dev/null | tail -1 || true)
if [[ $dsh_version == $DSH_VERSION ]]; then
  ok "dsh $dsh_version"
elif [[ -z $dsh_version ]]; then
  miss "没有 dsh（要先装好 Node.js）" "在终端执行这两行（sudo 会要求输入登录密码）：" \
    "sudo npm install -g @deepseek-ai/dsh@$DSH_VERSION" 'sudo chown -R "$(id -u):$(id -g)" ~/.npm'
else
  # Not replaced here: it is also your everyday dsh, and another version may be what you use.
  miss "dsh 是 $dsh_version，cu-runtime 目前只在 $DSH_VERSION 上测过" \
    "要换成这个版本，执行：sudo npm install -g @deepseek-ai/dsh@$DSH_VERSION" \
    "（会替换现在的 dsh；不想换的话，先不要装 cu-runtime。）"
fi

# dsh installs a plugin with the pnpm on its PATH; the dsh npm installs comes without it, and adding the plugin then
# shows only "exit code 127".
if (( $+commands[pnpm] )); then
  ok "pnpm"
else
  miss "没有 pnpm（在 dsh 的插件页添加插件时要用它，缺了只显示“退出码 127”）" "在终端执行：npm i -g pnpm" \
    '报 EACCES 的话执行：sudo npm i -g pnpm，再执行：sudo chown -R "$(id -u):$(id -g)" ~/.npm'
fi

# Whether a key is there, never what it is.
has_key() { [[ -f $1 ]] && grep -Eq '^[[:space:]]+DEEPSEEK_API_KEY:[[:space:]]*[^[:space:]]' $1 }
if has_key $HOME/.dsh/.credentials.yaml; then
  ok "DeepSeek API key"
else
  miss "没有 DeepSeek API key（要先装好 dsh）" "在 https://platform.deepseek.com 创建一个 key，然后在终端执行：cd ~ && dsh web" \
    "浏览器里弹出“Add an API key to get started”时填进去，点 Save and continue，再在终端按 Ctrl+C。"
fi

if (( ${#missing} )); then
  print -u2
  print -r -u2 -- "还缺 ${#missing} 样，按下面的顺序装好，然后重新运行：$AGAIN"
  integer i=0
  for item in $missing; do
    lines=("${(@f)item}")
    print -u2 "  $((++i)). ${lines[1]}"
    for line in ${lines[2,-1]}; do print -u2 "     $line"; done
  done
  print -u2
  print -r -u2 -- "只是要清除失效的授权记录（“辅助功能”或“屏幕录制”的开关已打开，检查仍显示缺少）时，不需要上面这些，执行：$AGAIN --permissions-only"
  exit 2
fi

# ---------------------------------------------------------------- 1. the two permissions: clear the rows not in effect
step 1 "系统权限：辅助功能、屏幕录制"
permission_step

# ---------------------------------------------------------------- 2. the plugin: dependencies and the build
step 2 "插件依赖与构建"
if [[ -L $ROOT/plugin/node_modules ]]; then
  ok "plugin/node_modules 是链接（开发机上的做法），不动它"
elif [[ -e $ROOT/plugin/node_modules/@deepseek-ai/cordis && $ROOT/plugin/node_modules/.package-lock.json -nt $ROOT/plugin/package-lock.json ]]; then
  ok "依赖已安装"
else
  info "从 npm 下载依赖（版本已锁定）"
  (cd $ROOT/plugin && npm ci --no-audit --no-fund 2>&1 | tail -2 | sed 's/^/  · /') || need "npm 安装失败。报 EACCES 的话执行：sudo chown -R \"\$(id -u):\$(id -g)\" ~/.npm"
  ok "依赖已安装"
fi
# The documented build, as docs/DESIGN.md "Installable dsh bundle" and scripts/hooks/pre-push run it: the root package.json's
# build (the host tsc into plugin/lib, then the plugin page plugin/lib/web-client.js), so the checkout added by its path
# serves a page and a host from one commit.
build_log=$(mktemp -t cu-runtime-plugin-build)
(cd $ROOT && npm run --silent build) >$build_log 2>&1 || {
  tail -20 $build_log | sed 's/^/    /' >&2
  need "插件构建失败（重试：cd $(pasted $ROOT) && npm run build），上面是最后 20 行，完整输出在 $build_log。"
}
[[ -f $ROOT/plugin/lib/index.js && -f $ROOT/plugin/lib/web-client.js ]] \
  || need "构建没有生成 plugin/lib/index.js 和 plugin/lib/web-client.js，完整输出在 $build_log。"
ok "已构建 ${ROOT/#$HOME/~}/plugin/lib（每次更新源码以后，在 dsh 重启之前重新运行 npm run build）"

# ---------------------------------------------------------------- the guide
print
# dsh's add form takes an absolute path only (a ~/… path is read as a package name and refused); a path with a space is
# shown in quotes, to be filled in without them.
if [[ $ROOT == *[[:space:]]* ]]; then add_path="\"$ROOT\"（填入引号里面的部分）"; else add_path=$ROOT; fi
print -P "%B预检和构建都已完成。%b接下来在 dsh 里操作："
print "  1. 启动 dsh：dsh --profile web，或打开 dsh 的桌面版。"
print -r -- "  2. 插件页 → 添加插件 → 填入这份源码的完整路径：$add_path → 启用。"
print "  3. 插件详情页 → 守护进程 → 安装守护进程 → 授予权限；“模式检查”应显示“正常”。"
print "  4. 新建会话，选择“电脑操作”模式，并自行选择一个支持图片输入的模型。"
print "  随时让它立刻停下：pkill -x cu-runtime"
print "  设置窗口（黑名单、撤销授权）：~/Applications/CURuntime.app/Contents/MacOS/cu-runtime settings"
print -r -- "  卸载：先在 dsh 的插件页移除本插件，再运行 zsh $(pasted $ROOT/scripts/uninstall.sh)"
