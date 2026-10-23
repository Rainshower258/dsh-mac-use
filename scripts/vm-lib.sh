# Sourced by the vm-*.sh scripts. Guest layout is fixed (PLAN-v2 §3.2): the app always lives at
# ~/Applications/CURuntime.app inside the guest.
VMDIR=${VMDIR:-$HOME/Desktop/dsh-cu-ocr/vm}
TART=$VMDIR/tart.app/Contents/MacOS/tart
BASE=${CU_BASE:-cu-base}
GUEST_USER=a1
# Guest password: env CU_GUEST_PASS or the untracked file $VMDIR/guest-pass. Never commit it.
GUEST_PASS=${CU_GUEST_PASS:-$(cat "$VMDIR/guest-pass" 2>/dev/null)}
[[ -n "$GUEST_PASS" ]] || { print "set CU_GUEST_PASS or create $VMDIR/guest-pass" >&2; exit 1; }
GUEST_APP='Applications/CURuntime.app'
# The guest always gets a bench build: the VM scripts turn config.json's test-harness switches on (config_grants,
# debug_activation, debug_ime, debug_native_images), and a release build refuses to start with any of them
# (LaunchPolicy). Built with (dist-bench is also where CU_BENCH=1 builds by default)
#   CU_BENCH=1 CU_DIST=$ROOT/dist-bench scripts/build-app.sh
# and signed with the bench identity, a certificate of its own (build-app.sh refuses the release one for a bench
# build): this Mac's grants pin the release certificate, so a bench build never carries them, and the VM base's grants
# pin the bench certificate. The base must grant the bench identity once (again only if it is ever made anew): the
# steps are in scripts/vm-grant-base.sh's header (make the identity, build, prepare, grant by hand, finish, check).
BENCH_APP=$ROOT/dist-bench/CURuntime.app
BENCH_SIGN_NAME=cu-runtime-bench-signing
BUNDLE_ID=dev.cu-runtime.daemon
SSH_OPTS=(-o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new
          -o UserKnownHostsFile="$VMDIR/known_hosts" -o ConnectTimeout=5)

# Password auth is occasionally refused for a moment ("Too many authentication failures": right after boot on
# 2026-09-28, and mid-run for two clones in a row on 2026-09-29). Retry only transport-level failures (ssh 255;
# rsync 255/12). A remote command's own exit status (0-254) is returned as-is. Everything run through these in the
# guest must be safe to repeat. `cmd || rc=$?`, not `cmd; rc=$?`: callers run under errexit (with_clone), which
# would otherwise abort on the first failure and skip the retries (it did, 2026-09-29).
gssh() {
  local rc
  for i in 1 2 3; do
    rc=0
    SSHPASS=$GUEST_PASS sshpass -e ssh "${SSH_OPTS[@]}" "$GUEST_USER@$IP" "$@" || rc=$?
    (( rc == 255 )) || return $rc
    sleep 2
  done
  return $rc
}
grsync() {
  local rc
  for i in 1 2 3; do
    rc=0
    SSHPASS=$GUEST_PASS sshpass -e rsync -a -e "ssh ${SSH_OPTS[*]}" "$@" || rc=$?
    (( rc == 255 || rc == 12 )) || return $rc
    sleep 2
  done
  return $rc
}

# boot_vm NAME [extra tart run args…]; sets IP, waits for the auto-login GUI session. tart's own output goes to
# $VM_LOG when set (runners keep it for failed boots).
boot_vm() {
  local name=$1; shift
  # --no-audio: no sound device. Otherwise the guest's sound (86Box's POST beeps in T6) plays on the host and macOS
  # shows the VM as using the microphone; nothing in the bench needs audio.
  "$TART" run "$name" --no-audio "$@" >>"${VM_LOG:-/dev/null}" 2>&1 &
  IP=$("$TART" ip "$name" --wait 180)
  for i in {1..90}; do
    gssh 'pgrep -x Dock >/dev/null' 2>/dev/null && return 0
    sleep 2
  done
  print "guest $name never reached a GUI session" >&2
  return 1
}

# Stop and delete a clone, retrying until it is really gone (a delete right after stop can race and leak it;
# leaked running clones then hit the 2-concurrent-macOS-VM limit).
destroy_vm() {
  local name=$1
  "$TART" stop "$name" --timeout 20 >/dev/null 2>&1 || true
  for i in {1..15}; do
    "$TART" delete "$name" >/dev/null 2>&1 && return 0
    "$TART" list | grep -q " $name " || return 0
    sleep 2
  done
  print -u2 "WARNING: clone $name could not be deleted; remove it with: tart stop $name; tart delete $name"
}

# Clone the base, run "$@" (a function and its args) in a subshell with errexit, and ALWAYS destroy the clone.
# zsh does not run `trap ... EXIT`, TRAPEXIT or `always` blocks when errexit fires inside a function (verified
# 2026-09-28), which is how clones used to leak; a subshell plus an unconditional cleanup does not have that gap.
# Callers must not rely on variables set inside "$@" afterwards (it runs in a subshell).
with_clone() {
  local name=$1; shift
  "$TART" clone "$BASE" "$name" || return 1
  trap "destroy_vm $name; exit 130" INT TERM HUP
  ( set -euo pipefail; "$@" )
  local rc=$?
  trap - INT TERM HUP
  destroy_vm "$name"
  return $rc
}

# Fails, saying how to build one, unless $BENCH_APP is a bench build (Info.plist CUBench true).
bench_app_built() {
  [[ $(plutil -extract CUBench raw "$BENCH_APP/Contents/Info.plist" 2>/dev/null) == true ]] || {
    print -u2 "$BENCH_APP is not a bench build: run CU_BENCH=1 CU_DIST=$ROOT/dist-bench $ROOT/scripts/build-app.sh"
    return 1; }
}

# Prints the SHA-1 of the one code-signing identity named $BENCH_SIGN_NAME; fails, saying what to do, when there is
# none or more than one.
bench_identity() {
  local found
  found=(${(f)"$(security find-identity -p codesigning | awk -v n="\"$BENCH_SIGN_NAME\"" '$3 == n {print toupper($2)}' | sort -u)"})
  (( ${#found} )) || {
    print -u2 "no code-signing identity \"$BENCH_SIGN_NAME\": set it up as scripts/vm-grant-base.sh's header says (make it, build, grant it in the base)"
    return 1; }
  (( ${#found} == 1 )) || {
    print -u2 "several code-signing identities named \"$BENCH_SIGN_NAME\": keep the one the base granted (security delete-identity -Z <SHA1>):"
    print -u2 -l -- "  "${^found}; return 1; }
  print -r -- ${found[1]}
}

# Runners call this before cloning: a bench build, signed by the bench identity (the designated requirement pins its
# certificate, so the base's TCC grants hold, and no build signed with the release certificate passes), with hardened
# runtime.
require_bench_app() {
  bench_app_built || return 1
  local sha
  sha=$(bench_identity) || return 1
  codesign --verify --strict -R "=identifier \"$BUNDLE_ID\" and certificate leaf = H\"$sha\"" "$BENCH_APP" 2>/dev/null || {
    print -u2 "$BENCH_APP is not signed by $BENCH_SIGN_NAME ($sha): run CU_BENCH=1 CU_DIST=$ROOT/dist-bench $ROOT/scripts/build-app.sh"
    return 1; }
  [[ $(codesign -d --verbose=1 "$BENCH_APP" 2>&1) =~ 'flags=0x[0-9a-f]+\(([^),]+,)*runtime[,)]' ]] || {
    print -u2 "$BENCH_APP is signed without hardened runtime (an older build-app.sh): run CU_BENCH=1 CU_DIST=$ROOT/dist-bench $ROOT/scripts/build-app.sh"
    return 1; }
}

# Only the build kind is checked here, not the signature: vm-signing-check.sh deploys an ad-hoc signed build on
# purpose (CU_SIGN_IDENTITY=-) to see the TCC grants fail.
deploy_app() {
  bench_app_built || return 1
  gssh "mkdir -p Applications"
  grsync --delete "$BENCH_APP/" "$GUEST_USER@$IP:$GUEST_APP/"
}

# Runs self-check through LaunchServices (so the app owns its TCC grants) and prints its JSON.
self_check() {
  gssh "rm -f /tmp/cu-selfcheck.json; open -W -n ~/$GUEST_APP --args self-check --out /tmp/cu-selfcheck.json; cat /tmp/cu-selfcheck.json"
}
