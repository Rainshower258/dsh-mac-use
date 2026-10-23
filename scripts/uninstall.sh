#!/bin/zsh
# Uninstalls the cu-runtime daemon (what the plugin page's 守护进程 tab installs). By default: stops the daemon (on
# SIGTERM it restores the system state it changed: input source, Electron's AX switch), takes back the two permissions
# of ~/Applications/CURuntime.app (Accessibility, Screen Recording) and deletes it. When the app is not there, nothing
# is reset (tccutil cannot find a deleted app) and the script says where rows left by an earlier deletion, if any, are
# removed by hand; the 将会 list says the same before anything is done. The plugin itself is removed on dsh's plugin
# page: this script never touches dsh's profiles. Kept unless asked, and said where:
#   --all          also delete the daemon's data (~/Library/Application Support/cu-runtime: audit log, the "always
#                  allow" list, the settings)
#   --legacy-home  also delete ~/.dsh-cu-desktop, the retired cu-desktop profile's own dsh home (its sessions, with
#                  screenshots of your apps, and its copy of the API key); --all leaves it alone
#   --remove-cert  also delete the signing identity cu-runtime-signing (a later install then needs both permissions
#                  granted again); says so when none is found, and a delete that fails (the keychain is locked over
#                  SSH, or its prompt was denied) is reported and makes the script exit 1 once the rest is done
#   --yes          do not ask before deleting
# A log folder chosen in the settings window (logs.directory in the state dir's settings.json: its cu-runtime-logs
# subfolder) is never deleted, with or without --all, and is said to be kept.
# Never touches dsh, its profiles, Node.js, the Command Line Tools, your everyday ~/.dsh or this source folder.
set -euo pipefail

APP=$HOME/Applications/CURuntime.app
BUNDLE_ID=dev.cu-runtime.daemon
CU_HOME=$HOME/.dsh-cu-desktop   # the retired cu-desktop home: deleted only with --legacy-home
STATE="$HOME/Library/Application Support/cu-runtime"
CERT=cu-runtime-signing
all=0 legacy=0 cert=0 yes=0
for a in "$@"; do
  case $a in
    --all) all=1 ;;
    --legacy-home) legacy=1 ;;
    --remove-cert) cert=1 ;;
    --yes) yes=1 ;;
    *) print -u2 "unknown option: $a (see the comment at the top of this script)"; exit 1 ;;
  esac
done

app=0
[[ -d $APP ]] && app=1
# The log folder chosen in the settings window, read before --all deletes the settings: plutil reads JSON and comes
# with macOS; an unset folder (null), a missing or unreadable file gives no absolute path, so nothing is said.
log_dir=
[[ -f $STATE/settings.json ]] && log_dir=$(plutil -extract logs.directory raw -o - "$STATE/settings.json" 2>/dev/null || true)
[[ $log_dir == /* ]] || log_dir=
kept_logs=${log_dir%/}/cu-runtime-logs

print "将会："
if (( app )); then
  print "  · 停止守护进程，删除 ${APP/#$HOME/~}，撤销它的“辅助功能”和“屏幕录制”权限"
else
  print "  · 停止守护进程（在运行的话）；${APP/#$HOME/~} 没有安装，不用删除，也没有权限可以撤销"
fi
(( all )) && print "  · 删除 ${STATE/#$HOME/~}（审计日志、“始终允许”名单、设置）"
[[ -n $log_dir ]] && print -r -- "  · 保留 ${kept_logs/#$HOME/~}（设置里选的日志位置，其中有审计日志）"
(( legacy )) && print "  · 删除 ${CU_HOME/#$HOME/~}（已停用的 cu-desktop 主目录：会话记录，含截图；API key 的副本）"
(( cert )) && print "  · 删除签名证书 $CERT"
if (( ! yes )); then
  [[ -t 0 ]] || { print -u2 "不是在终端里运行：加 --yes 才会执行"; exit 1; }
  read -r "?继续吗？[y/N] " answer
  [[ $answer == [yY]* ]] || { print "没有做任何改动。"; exit 0; }
fi

if pgrep -x cu-runtime >/dev/null; then
  pkill -x cu-runtime || true
  for _ in {1..20}; do pgrep -x cu-runtime >/dev/null || break; sleep 0.5; done
  pgrep -x cu-runtime >/dev/null && { print -u2 "守护进程没有退出：在“活动监视器”里退出 cu-runtime，再运行一次。"; exit 1; }
  print "✓ 已停止守护进程"
fi
# System Settings, if open, can write a row back from its own list: quit it first. tccutil finds the app by its bundle
# ID through LaunchServices, so the rows are reset while the app is still there: once it is deleted, the reset fails
# (-10814), and rows of an earlier certificate outlive a new one, where turning them on changes nothing (VM, 2026-10-22).
# With no app there is nothing tccutil can reset, so nothing is tried and nothing is reported as failed: rows left by an
# earlier deletion, if any, are removed in System Settings.
if (( app )); then
  osascript -e 'tell application "System Settings" to quit' >/dev/null 2>&1 || true
  not_reset=()
  for service name in Accessibility 辅助功能 ScreenCapture 屏幕录制; do
    tccutil reset $service $BUNDLE_ID >/dev/null 2>&1 || not_reset+=($name)
  done
  rm -rf $APP && print "✓ 已删除 ${APP/#$HOME/~}"
  if (( ${#not_reset} )); then
    print -u2 "! 没能撤销${(j:、:)not_reset}权限：到“系统设置 → 隐私与安全性”的对应列表里，选中 CURuntime 后点“−”删掉"
  else
    print "✓ 已撤销辅助功能、屏幕录制权限"
  fi
else
  print "· ${APP/#$HOME/~} 没有安装，没有可以撤销的权限。之前删除它时留下的授权记录（如果有）在“系统设置 → 隐私与安全性”的“辅助功能”和“屏幕录制”列表里：选中 CURuntime 后点“−”删掉"
fi

if (( all )); then
  rm -rf "$STATE"
  print "✓ 已删除 ${STATE/#$HOME/~}"
else
  [[ -d $STATE ]] && print "· 保留了 ${STATE/#$HOME/~}（审计日志、“始终允许”名单、设置）：要删的话加 --all"
fi
[[ -n $log_dir ]] && print -r -- "· 保留了 ${kept_logs/#$HOME/~}（设置里选的日志位置，其中有审计日志）：这个脚本不删除它，不再需要的话自行删除"
if (( legacy )); then
  rm -rf $CU_HOME
  print "✓ 已删除 ${CU_HOME/#$HOME/~}"
else
  [[ -d $CU_HOME ]] && print "· 保留了 ${CU_HOME/#$HOME/~}（已停用的 cu-desktop 主目录：会话记录、API key 副本）：要删的话加 --legacy-home"
fi

# Each identity named $CERT is deleted by its SHA-1; none found is said, and a listing or a delete that fails is
# reported and makes the script exit 1 after the rest is done.
cert_failed=0
if (( cert )); then
  if ! listing=$(security find-identity -p codesigning 2>/dev/null); then
    print -u2 "! 没能读取钥匙串里的签名证书，$CERT 没有删除：请在这台 Mac 屏幕上的“终端”里再运行一次"
    cert_failed=1
  else
    ids=(${(f)"$(print -r -- $listing | awk -v n="\"$CERT\"" '$3 == n {print $2}' | sort -u)"})
    (( ${#ids} )) || print "· 没有找到签名证书 $CERT，不用删除"
    for id in $ids; do
      if security delete-identity -Z $id >/dev/null; then
        print "✓ 已删除签名证书 $CERT ($id)"
      else
        print -u2 "! 没能删除签名证书 $CERT ($id)：请在这台 Mac 屏幕上的“终端”里再运行一次（SSH 里钥匙串是锁定的），钥匙串询问时点“允许”"
        cert_failed=1
      fi
    done
  fi
else
  print "· 保留了签名证书 $CERT（重新安装时不用再给权限）：要删的话加 --remove-cert"
fi
print "dsh 及其 profile、Node.js、命令行工具和源码文件夹都没有动。插件本身在 dsh 的插件页移除。"
if (( cert_failed )); then exit 1; fi
