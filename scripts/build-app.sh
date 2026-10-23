#!/bin/zsh
# Build dist/CURuntime.app and sign it, with hardened runtime, with a stable self-signed identity
# (scripts/make-signing-identity.sh). CFBundleVersion is stamped per build, so every build has a new cdhash; TCC grants
# must survive that because the designated requirement pins the certificate, not the hash.
# It runs as `/bin/zsh -f scripts/build-app.sh` with nothing but PATH=/usr/bin:/bin:/usr/sbin:/sbin, HOME, USER, LOGNAME,
# TMPDIR and LANG in the environment (the plugin's host runs it so). Every tool is called by its absolute path (swift
# through /usr/bin/xcrun), so neither PATH nor a ~/.zshenv (read when -f is left out) can put another program in the
# place of one. The TMPDIR given is not where the build writes: the app is assembled and signed in a 0700 work dir
# beside the output, and TMPDIR points there for the tools (see WORK below).
# Environment (all optional; unset, the build is what it always was):
#   CU_SCRATCH  swift build's scratch path (default <root>/.build)
#   CU_DIST     the directory the app goes into (default <root>/dist; for a bench build <root>/dist-bench); not a
#               symlink to a missing directory
#   CU_BENCH=1  a bench build (-DCU_BENCH; Info.plist CUBench true): only it takes --state-dir or starts with
#               config.json's test-harness switches (LaunchPolicy). It goes into <root>/dist-bench, where the VM scripts
#               take it from, and never into <root>/dist, the daily path (install.sh and docs/desktop.md copy the app
#               from there into ~/Applications): a CU_DIST that is <root>/dist is refused (exit status 2).
#               Otherwise a release build (CUBench false).
#   CU_SIGN_NAME      the identity to sign with, by its exact name. Default: cu-runtime-signing for a release build,
#                     cu-runtime-bench-signing for a bench build. Each kind refuses the other's (exit status 2): this
#                     Mac's grants of Accessibility and Screen Recording pin the release certificate, and a bench build
#                     (which takes --state-dir and the test-harness switches) must never carry them; only the VM base
#                     grants the bench certificate (scripts/vm-grant-base.sh). So a certificate tells the kind.
#   CU_SIGN_IDENTITY  the identity to sign with by its SHA-1 instead (40 hex digits), or - for an ad-hoc signature
#                     (scripts/vm-signing-check.sh's negative case); anything else, or the SHA-1 of an identity named
#                     as the other kind's, is refused (exit status 2).
# Info.plist CUSourceHash: scripts/source-hash.sh of the sources built (Package.swift, Sources/ and this script), which
# the plugin compares with its own copy.
# Output and exit status: the line "== sign", alone on stdout, right before codesign runs (the keychain asks the person
# at the Mac to allow it); exit status 3 when codesign or the check right after it fails (the keychain's prompt
# cancelled or denied, the screen locked, a signature that does not verify or lacks hardened runtime), 2 when the
# environment is refused, 1 for the other checks below, a failing build step's own status otherwise. The dist directory
# is changed only by a build that got through all of it.
set -euo pipefail

ROOT=${0:A:h:h}
# The environment first: a refusal of it (exit status 2) comes before anything else runs, and up to the Command
# Line Tools check below nothing is called (bench/tests/test_build_app_env.py runs this part alone). Relative paths
# are taken from the caller's directory (this script changes into the root below).
case ${CU_BENCH:-} in
  1) BENCH=(-Xswiftc -DCU_BENCH); BENCH_PLIST='<true/>'; KIND=bench; DIST_DEFAULT=$ROOT/dist-bench
     SIGN_DEFAULT=cu-runtime-bench-signing; SIGN_OTHER=cu-runtime-signing; KIND_OTHER=release ;;
  ''|0) BENCH=(); BENCH_PLIST='<false/>'; KIND=release; DIST_DEFAULT=$ROOT/dist
     SIGN_DEFAULT=cu-runtime-signing; SIGN_OTHER=cu-runtime-bench-signing; KIND_OTHER=bench ;;
  *) print -u2 "CU_BENCH is 1 (a bench build) or unset (a release build), not \"$CU_BENCH\""; exit 2 ;;
esac
SCRATCH=${${CU_SCRATCH:-$ROOT/.build}:A}
# :A makes the path absolute, drops "." and ".." as text, then resolves symlinks. Every use below is of DIST as
# resolved here, so the directory checked is the directory written. A symlink :A leaves as it is points at nothing
# yet: where it would lead is not known, so it is not taken.
DIST=${${CU_DIST:-$DIST_DEFAULT}:A}
[[ ! -L $DIST ]] || { print -u2 "CU_DIST $DIST is a symlink to a missing directory: name the directory itself"; exit 2; }
# Letter case is ignored (APFS by default ignores it), the firmlinked /System/Volumes/Data/... spelling is taken as
# the plain path (also while <root>/dist does not exist yet), and -ef catches any other path to an existing one.
DAILY=${${:-$ROOT/dist}:A}
if [[ $KIND == bench ]] && [[ ${(L)${DIST#/System/Volumes/Data}} == ${(L)${DAILY#/System/Volumes/Data}} || $DIST -ef $DAILY ]]; then
  print -u2 "CU_BENCH=1 does not build into $DAILY: that is the daily path, from which install.sh and docs/desktop.md"
  print -u2 "copy the app into ~/Applications. Leave CU_DIST unset (a bench build goes into $ROOT/dist-bench) or set it"
  print -u2 "to another directory."
  exit 2
fi
# The identity by name: each kind of build has its own, and the other kind's is refused (by SHA-1 too, below).
NAME=${CU_SIGN_NAME:-$SIGN_DEFAULT}
if [[ $NAME == $SIGN_OTHER ]]; then
  print -u2 "a $KIND build is not signed with $SIGN_OTHER, the identity of $KIND_OTHER builds: each certificate stands for"
  print -u2 "one kind (this Mac's permissions are granted to cu-runtime-signing, the VM base's to cu-runtime-bench-signing)."
  print -u2 "Leave CU_SIGN_NAME unset (a $KIND build is signed with $SIGN_DEFAULT) or name another identity."
  exit 2
fi
[[ -z ${CU_SIGN_IDENTITY:-} || $CU_SIGN_IDENTITY == - || $CU_SIGN_IDENTITY =~ '^[0-9A-Fa-f]{40}$' ]] || {
  print -u2 "CU_SIGN_IDENTITY is the SHA-1 of an identity (40 hex digits) or - (ad-hoc), not \"$CU_SIGN_IDENTITY\""; exit 2; }
# Without the Command Line Tools, the first swift call only pops up macOS's installer: say what is missing instead.
/usr/bin/xcode-select -p >/dev/null 2>&1 || {
  print -u2 "the Xcode Command Line Tools are not installed (swift, git): see docs/desktop.md, 2.1 step 1"; exit 1; }
# Identities scripts/make-signing-identity.sh created, found by exact name. Not -v: the self-signed certificate is not
# marked trusted and needs not be. An ad-hoc signature needs no keychain at all.
LISTING=''
[[ ${CU_SIGN_IDENTITY:-} == - ]] || LISTING=$(/usr/bin/security find-identity -p codesigning)
# named NAME: the SHA-1s (upper case, one per line) of the code-signing identities named NAME.
named() { print -r -- "$LISTING" | /usr/bin/awk -v n="\"$1\"" '$3 == n {print toupper($2)}' | /usr/bin/sort -u }
if [[ -n ${CU_SIGN_IDENTITY:-} ]]; then
  IDENTITY=${(U)CU_SIGN_IDENTITY}
else
  # An array, not one string: inside ${x:-$(...)} zsh joins the lines with spaces, and the check below never fired.
  found=(${(f)"$(named $NAME)"})
  (( ${#found} )) || { print -u2 "no code-signing identity \"$NAME\": run scripts/make-signing-identity.sh $NAME first"; exit 1; }
  # Two of one name (re-created, an old one left behind): signing with the wrong one would void every TCC grant.
  (( ${#found} == 1 )) || { print -u2 "several code-signing identities named \"$NAME\"; delete all but the one your"
    print -u2 "permissions were granted to (security delete-identity -Z <SHA1>), or set CU_SIGN_IDENTITY to it:"
    print -u2 -l -- "  "${^found}; exit 1; }
  IDENTITY=${found[1]}
fi
others=(${(f)"$(named $SIGN_OTHER)"})
if [[ $IDENTITY != - ]] && (( ${others[(Ie)$IDENTITY]} )); then
  print -u2 "CU_SIGN_IDENTITY $IDENTITY is $SIGN_OTHER, the identity of $KIND_OTHER builds: a $KIND build is not signed with it"
  exit 2
fi
BUNDLE_ID=dev.cu-runtime.daemon
APP=$DIST/CURuntime.app
# Assemble and sign in a work dir; the dist dir only ever holds a verified, properly signed app. The work dir is made
# beside the output (<dist's parent>/.build-app.XXXXXXXX, 0700; for the plugin page's builds under
# ~/Library/Caches/cu-runtime/build), not in $TMPDIR: dsh's sandboxed tool processes may write $TMPDIR and /tmp, and
# what lies in the stage when codesign reads it is what the keychain prompt approves, so a binary put there between
# the copy and the signing would be signed and installed. Everything else the build writes on the way goes there too:
# TMPDIR (swift's and codesign's temporary files) and TMPPREFIX (zsh's, for the here-document below) point into it,
# and xcrun skips its lookup cache (kept in the user's temp dir). It is removed on every exit, also when a signal ends
# the build (the plugin's host cancels with SIGTERM to the process group). zsh runs an EXIT trap on exit and when
# errexit fires on a command at the top level, but neither when errexit fires inside a function or on a function's
# status (so nothing below calls one), nor when a signal ends it, hence the signal traps, each exiting with the status
# the signal would have given. A SIGKILL leaves it (git ignores .build-app.*/), holding at most an app no check has
# passed. No symlink is followed into it: mktemp makes it with mkdir(2) under a new random name (an entry already of
# that name, a symlink too, is never taken), 0700 from the start (umask 077 in its subshell; no chmod after, which
# would follow a symlink put in its place), and its path, built from DIST as resolved above, must still resolve to
# itself once it exists, so a directory on the way swapped for a symlink since then is refused (exit status 1)
# before anything is written into it. rm -rf removes a symlink itself, not what it points at.
WORK=''
cleanup() { [[ -z $WORK ]] || /bin/rm -rf -- "$WORK" }
trap cleanup EXIT
trap 'cleanup; exit 129' HUP
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
/bin/mkdir -p -- "${DIST:h}"
WORK=$(umask 077 && /usr/bin/mktemp -d "${DIST:h}/.build-app.XXXXXXXX")
[[ ${WORK:A} == $WORK ]] || {
  print -u2 "the work dir $WORK resolves to ${WORK:A}: a directory on its path was made a symlink while this ran"; exit 1; }
/bin/mkdir "$WORK/tmp"
export TMPDIR=$WORK/tmp TMPPREFIX=$WORK/tmp/zsh
STAGE=$WORK/CURuntime.app
# The commit: from git, or for a source zip (git archive / GitHub's Download ZIP) from scripts/source-commit, which
# the archive fills in (export-subst in .gitattributes). A plain copy of a checkout has neither: nogit.
COMMIT=$(/usr/bin/git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || /bin/cat "$ROOT/scripts/source-commit" 2>/dev/null || true)
[[ $COMMIT =~ '^[0-9a-f]+$' ]] || COMMIT=nogit
BUILD=$(/bin/date +%Y%m%d.%H%M%S)-$COMMIT
# Before the build: the hash names the sources as they were when it started.
# Through zsh, not its exec bit (a copy or an unpacked archive may not keep it).
SOURCE_HASH=$(/bin/zsh -f "$ROOT/scripts/source-hash.sh" "$ROOT")

cd "$ROOT"
/usr/bin/xcrun --no-cache swift build -c release --product cu-runtime --scratch-path "$SCRATCH" $BENCH
BIN=$(/usr/bin/xcrun --no-cache swift build -c release --scratch-path "$SCRATCH" $BENCH --show-bin-path)
/bin/mkdir -p "$STAGE/Contents/MacOS"
/bin/cp "$BIN/cu-runtime" "$STAGE/Contents/MacOS/cu-runtime"
/bin/cat >"$STAGE/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>CURuntime</string>
  <key>CFBundleExecutable</key><string>cu-runtime</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.1</string>
  <key>CFBundleVersion</key><string>$BUILD</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>CUBench</key>$BENCH_PLIST
  <key>CUSourceHash</key><string>$SOURCE_HASH</string>
</dict>
</plist>
EOF
# Hardened runtime (--options runtime), without entitlements: the daemon needs none of its exceptions. It generates no
# code (no JIT, no unsigned executable memory), loads only system libraries (otool -L: /System/Library and /usr/lib
# only, so library validation passes without a team ID), needs no DYLD_* variable, uses no camera, microphone,
# location, contacts, calendars or photos, and sends no Apple events (it only receives the reopen event; the apps it
# opens and the files it hands to them go through LaunchServices). With it, macOS keeps other code out of the process
# that holds the TCC grants: DYLD_* variables (as `open --env` could pass them) are ignored, and no debugger can attach
# (no get-task-allow).
# "== sign" first: from here on a failure is the signing's, which a caller (the plugin's host) reports as such.
print -r -- '== sign'
/usr/bin/codesign --force --sign "$IDENTITY" --identifier "$BUNDLE_ID" --options runtime --timestamp=none "$STAGE" || {
  print -u2 "codesign failed: the keychain's password prompt was cancelled or denied (the answer is Allow, 允许), or the"
  print -u2 "screen is locked (the login keychain is unusable while locked); $DIST left untouched"; exit 3; }
/usr/bin/codesign --verify --strict "$STAGE" || {
  print -u2 "the new signature does not verify (codesign --verify --strict); $DIST left untouched"; exit 3; }
# The CodeDirectory's flags, e.g. "flags=0x10000(runtime)": the hardened runtime must be among them.
[[ $(/usr/bin/codesign -d --verbose=1 "$STAGE" 2>&1) =~ 'flags=0x[0-9a-f]+\(([^),]+,)*runtime[,)]' ]] || {
  print -u2 "the new signature lacks the hardened runtime flag (codesign -d); $DIST left untouched"; exit 3; }
/bin/mkdir -p "$DIST"
/bin/rm -rf "$APP"
/bin/mv "$STAGE" "$APP"
print "built $APP ($BUILD, $KIND)"
/usr/bin/codesign -d -r- "$APP" 2>&1 | /usr/bin/grep designated
