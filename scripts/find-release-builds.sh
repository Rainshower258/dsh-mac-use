#!/bin/zsh
# scripts/find-release-builds.sh [--delete] [dir ...]: every CURuntime.app of this user, what signed it, and whether
# it has to go. Run it in Terminal; --delete asks there before it removes anything.
#
# Why: this Mac's Accessibility and Screen Recording grants are recorded for the bundle id dev.cu-runtime.daemon with
# a requirement that pins the release certificate (cu-runtime-signing), not one build. So every bundle that
# certificate signed holds both grants wherever it lies, and LaunchServices starts it from an archive or a forgotten
# worktree as readily as from ~/Applications. Only a hardened release build (Info.plist CUBench false, signed with
# hardened runtime: what build-app.sh makes from 3ecf445 on) is fit to keep. Every build from before 3ecf445 (bench
# builds made then and the first R1 attempts, d4faaeb up to b0d4919, included) has no hardened runtime, so DYLD_*
# variables passed with `open --env` reach the process that holds the grants. Those from before R1 (no CUBench key)
# also serve any --state-dir and start with config.json's test-harness switches (config_grants approves apps without
# the dialog), and the first R1 attempts compared the --state-dir path as text, which a spelling through a symlink got
# past. Rotating the release certificate is the complete remedy (docs/DESIGN.md, Signing): one re-grant replaces the
# requirement, and every old bundle loses the grants at once, also the copies this script cannot find. This script
# serves the other remedy, deleting them.
#
# Where it looks: Spotlight (mdfind: every bundle with that bundle id the index knows), plus find over places Spotlight
# skips (it indexes no hidden directory and no temp directory): this checkout (dist/, dist-bench/ and
# .claude/worktrees/*/dist*; the main checkout's when this one is a linked worktree under .claude/worktrees),
# ~/Library/Caches/cu-runtime (the plugin page's build, and a work dir of build-app.sh that a SIGKILL left),
# ~/Applications (also the host's staging names .CURuntime.app.new-* and .CURuntime.app.old-*), ~/Archives,
# /private/tmp, $TMPDIR, every directory given, and the .claude/worktrees of every other checkout Spotlight shows a
# build of (a bundle it lists at <checkout>/dist*/CURuntime.app). find skips .git and node_modules directories, does
# not follow symlinks, and skips directories this user cannot read. Not seen: copies in the Trash, in Time Machine
# backups, in a hidden directory of a checkout Spotlight shows no build of, and on volumes neither indexed nor given.
#
# Per bundle it prints the path, CFBundleVersion, CUBench, whether the hardened runtime flag is set (matched as
# build-app.sh checks it), the signing certificate's name and the leaf SHA-1 its designated requirement names (in
# openssl's form, upper-case hex pairs joined by ':'; what `openssl x509 -noout -fingerprint -sha1` prints for that
# certificate), the pids of processes running from it, and a verdict:
#   keep    a hardened release build (CUBench false, runtime flag) signed with the current release identity: the one
#           identity named cu-runtime-signing in the keychain, the one build-app.sh signs with
#   REMOVE  every other bundle signed with that identity or with a certificate named cu-runtime-signing (an earlier
#           release certificate, or a look-alike), with the reasons
#   bench   signed with the bench certificate (cu-runtime-bench-signing), which only the VM base grants: not flagged
#   other   unsigned, ad-hoc, or signed with another certificate: not flagged
# Everything is read without changing anything and with nothing that asks for a password: plutil -extract, codesign
# -d (display only), mdfind, find, ps, and security find-identity (it lists identities and uses no key). The one
# question macOS may ask is its own, once per folder: whether Terminal may read Documents or Downloads, when Spotlight
# finds a bundle there.
#
# --delete: after the listing, removes the REMOVE bundles (rm -rf, not to the Trash, from which they would still
# launch) once "yes" is typed on the terminal (/dev/tty; with no terminal it refuses). Before asking it refuses while a
# process runs from one of them (removing a bundle does not stop it: quit it first), while several identities are named
# cu-runtime-signing (which one is current is not known), and when the keychain could not be listed. Right before each
# removal it checks the bundle again, and leaves it alone ("changed since it was listed") unless all of this holds:
# every directory on its path is still the one listed (the listing resolves each path, so none of them may be a
# symlink now; the bundle's parent is entered with cd -P, and the bundle is then read and removed as ./<name> in it, so
# a directory higher up swapped after this check changes nothing about what goes), the bundle is still a directory and
# not a symlink, it still has that bundle id, and what the verdict was drawn from is still what it holds (CFBundleVersion
# and CUBench, whether and how it is signed, the certificate's name and leaf SHA-1, the hardened runtime flag and the
# CDHash, read again the same way: a build put in its place since the listing differs, also a fresh hardened one).
# Last, nothing may run from it. When ~/Applications/CURuntime.app is among them it says that the plugin and cu-std have
# no daemon from then on until the next install (安装守护进程 on the plugin page's 守护进程 tab).
# Exit status: 0 when nothing is flagged or --delete removed all of it, 1 when flagged bundles are left (only listed,
# or --delete declined, refused or failed), 2 for a usage error.
# Every tool is called by its absolute path.
set -euo pipefail

ROOT=${0:A:h:h}
BUNDLE_ID=dev.cu-runtime.daemon
RELEASE_NAME=cu-runtime-signing
BENCH_NAME=cu-runtime-bench-signing
# As build-app.sh checks the CodeDirectory's flags, e.g. "flags=0x10000(runtime)".
RUNTIME_FLAG='flags=0x[0-9a-f]+\(([^),]+,)*runtime[,)]'
INSTALLED=${HOME:A}/Applications/CURuntime.app

DELETE=0
extra=()
for arg in "$@"; do
  case $arg in
    --delete) DELETE=1 ;;
    -*) print -u2 "usage: find-release-builds.sh [--delete] [dir ...]"; exit 2 ;;
    *) if [[ -d $arg ]]; then extra+=(${arg:A}); else print -u2 "$arg is not a directory"; exit 2; fi ;;
  esac
done

# The checkout this script belongs to, or the main one when this is a linked worktree under .claude/worktrees (the
# main checkout holds every worktree).
MAIN=$ROOT
if [[ $ROOT == */.claude/worktrees/* ]]; then MAIN=${ROOT%%/.claude/worktrees/*}; fi
roots=($MAIN)
for d in $HOME/Library/Caches/cu-runtime $HOME/Applications $HOME/Archives /private/tmp ${TMPDIR:-}; do
  if [[ -n $d && -d $d ]]; then roots+=(${d:A}); fi
done
roots+=($extra)
roots=(${(u)roots})

# The identities by exact name, as build-app.sh finds them (not -v: the self-signed certificates are not trusted).
keychain_listed=1
listing=$(/usr/bin/security find-identity -p codesigning 2>/dev/null) || { keychain_listed=0; listing=''; }
named() { print -r -- "$listing" | /usr/bin/awk -v n="\"$1\"" '$3 == n {print toupper($2)}' | /usr/bin/sort -u }
release=(${(f)"$(named $RELEASE_NAME)"})
bench=(${(f)"$(named $BENCH_NAME)"})

# ossl SHA1: in openssl's form (AB:CD:...).
ossl() {
  local h=${(U)1} out='' i
  for (( i = 1; i < ${#h}; i += 2 )); do out+=${out:+:}${h[i,i+1]}; done
  print -r -- $out
}
identities() {
  if (( $# == 0 )); then print -r -- none; return; fi
  local out=() s
  for s in "$@"; do out+=($(ossl $s)); done
  print -r -- ${(j:, :)out}
}

# The processes, as "pid executable-path" lines; pids_in APP prints the pids of those whose executable lies in APP,
# as ps spells the path or resolved (APP is resolved; ps may give /var/... or /tmp/... for /private/...).
procs=''
take_procs() { procs=$(/bin/ps -axww -o pid=,comm= 2>/dev/null) || procs='' }
pids_in() {
  local line pid exe out=()
  for line in ${(f)procs}; do
    line=${line#"${line%%[! ]*}"}
    pid=${line%% *}
    exe=${line#* }
    if [[ $exe == $1/* || ${exe:A} == $1/* ]]; then out+=($pid); fi
  done
  print -r -- ${(j:, :)out}
}
take_procs

bundle_id() { /usr/bin/plutil -extract CFBundleIdentifier raw -o - "$1/Contents/Info.plist" 2>/dev/null || true }

# read_bundle APP: what a verdict is drawn from, read from APP's Info.plist and codesign -d (display only), into the
# globals version and cubench ('(none)' when the key is missing), signed and adhoc (1 or 0), authority (the first
# Authority line: the leaf certificate's name), leaf (the SHA-1 the designated requirement names, upper case), hardened
# (1 when the CodeDirectory's flags hold runtime) and cdhash (the CDHash line; every build has its own, as
# CFBundleVersion is stamped per build), each '' when codesign prints no such line; and all of them in one line in
# state, which --delete compares with the listing's right before a removal.
read_bundle() {
  version=$(/usr/bin/plutil -extract CFBundleVersion raw -o - "$1/Contents/Info.plist" 2>/dev/null) || version='(none)'
  cubench=$(/usr/bin/plutil -extract CUBench raw -o - "$1/Contents/Info.plist" 2>/dev/null) || cubench='(none)'
  signed=1
  sig=$(/usr/bin/codesign -d --verbose=3 -r- "$1" 2>&1) || signed=0
  authority=''
  leaf=''
  hardened=0
  adhoc=0
  cdhash=''
  if (( signed )); then
    local l
    for l in ${(f)sig}; do
      case $l in
        Authority=*) if [[ -z $authority ]]; then authority=${l#Authority=}; fi ;;
        Signature=adhoc) adhoc=1 ;;
        CDHash=*) cdhash=${l#CDHash=} ;;
      esac
    done
    if [[ $sig =~ $RUNTIME_FLAG ]]; then hardened=1; fi
    if [[ $sig =~ 'certificate leaf = H"([0-9A-Fa-f]{40})"' ]]; then leaf=${(U)match[1]}; fi
  fi
  state="version=$version cubench=$cubench signed=$signed adhoc=$adhoc authority=$authority leaf=$leaf"
  state+=" hardened=$hardened cdhash=$cdhash"
}

spotlight=''
if ! spotlight=$(/usr/bin/mdfind "kMDItemCFBundleIdentifier == \"$BUNDLE_ID\"" 2>/dev/null); then
  print -u2 "mdfind failed: only what find sees below is listed"
  spotlight=''
fi
# Other checkouts' hidden places: <checkout>/.claude/worktrees and build-app.sh's work dirs <checkout>/.build-app.* (a
# SIGKILL leaves one, maybe holding a signed app) for each <checkout>/dist*/CURuntime.app Spotlight lists, unless a root
# already holds them. Symlinks are not followed.
for p in ${(f)spotlight}; do
  [[ ${p:t} == CURuntime.app && ${p:h:t} == dist* ]] || continue
  for wt in ${p:h:h}/.claude/worktrees(N/) ${p:h:h}/.build-app.*(N/); do
    [[ -L $wt ]] && continue
    wt=${wt:A}
    held=0
    for r in $roots; do if [[ $wt == $r || $wt == $r/* ]]; then held=1; fi; done
    if (( ! held )); then roots+=($wt); fi
  done
done
found=''
found=$(/usr/bin/find $roots \( -name .git -o -name node_modules \) -prune -o \
  \( -name '*.app' -o -name '.CURuntime.app.*' \) -type d -prune -print 2>/dev/null) || true

typeset -A seen
apps=()
for p in ${(f)spotlight} ${(f)found}; do
  if [[ -z $p || ! -d $p || -L $p ]]; then continue; fi
  p=${p:A}
  if (( ${+seen[$p]} )); then continue; fi
  seen[$p]=1
  if [[ $(bundle_id $p) == $BUNDLE_ID ]]; then apps+=($p); fi
done
apps=(${(o)apps})

print -r -- "Release identity ($RELEASE_NAME in the keychain): $(identities $release)"
print -r -- "Bench identity ($BENCH_NAME): $(identities $bench)"
(( keychain_listed )) || print -u2 "security find-identity failed: the keychain's identities are not known"
print -r -- "Searched: Spotlight (bundle id $BUNDLE_ID) and, with find, ${(j:, :)roots}"
print

flagged=()
busy=()
# judged[APP]: read_bundle's state of each flagged bundle as the listing read it.
typeset -A count shown_blocks judged
count=(keep 0 REMOVE 0 bench 0 other 0)
shown_blocks=(keep '' REMOVE '' bench '' other '')
for app in $apps; do
  read_bundle $app
  current=0
  if [[ -n $leaf ]] && (( ${release[(Ie)$leaf]} )); then current=1; fi
  benchcert=0
  if [[ -n $leaf ]] && (( ${bench[(Ie)$leaf]} )); then benchcert=1; fi
  why=()
  if (( ! signed )); then
    verdict=other; why=('not signed: not flagged')
  elif (( adhoc )); then
    verdict=other; why=('an ad-hoc signature: not flagged')
  elif [[ $authority == $RELEASE_NAME ]] || (( current )); then
    if (( ! current )); then
      if (( ${#release} )); then
        why+=("signed with a certificate named $RELEASE_NAME that is not the current release identity (an earlier release certificate, or a look-alike)")
      else
        why+=("no identity named $RELEASE_NAME is in the keychain, so no build signed with that name is kept")
      fi
    fi
    case $cubench in
      false) ;;
      true) why+=('a bench build (CUBench true) signed with the release certificate: it takes --state-dir and the test-harness switches') ;;
      '(none)') why+=('no CUBench key: built before R1, it takes --state-dir and the test-harness switches') ;;
      *) why+=("CUBench $cubench") ;;
    esac
    if (( ! hardened )); then why+=('no hardened runtime: built before 3ecf445'); fi
    if (( ${#why} )); then
      verdict=REMOVE
    else
      verdict=keep; why=('a hardened release build signed with the current release identity')
    fi
  elif [[ $authority == $BENCH_NAME ]] || (( benchcert )); then
    verdict=bench; why=('signed with the bench certificate, which only the VM base grants: not flagged')
  else
    verdict=other; why=("signed with another certificate (${authority:-no name}): not flagged")
  fi
  running=$(pids_in $app)
  (( count[$verdict] += 1 ))
  if [[ $verdict == REMOVE ]]; then
    flagged+=($app)
    judged[$app]=$state
    if [[ -n $running ]]; then busy+=("$app (pid $running)"); fi
  fi
  runtime=no
  if (( hardened )); then runtime=yes; fi
  shown='(none)'
  if [[ -n $leaf ]]; then shown=$(ossl $leaf); fi
  block="${(r:8:)verdict}$app"
  block+=$'\n'"        CFBundleVersion $version, CUBench $cubench, hardened runtime $runtime"
  block+=$'\n'"        certificate ${authority:-(none)}, leaf SHA-1 $shown"
  block+=$'\n'"        ${(j:; :)why}"
  if [[ -n $running ]]; then block+=$'\n'"        running: pid $running"; fi
  shown_blocks[$verdict]+="$block"$'\n\n'
done
# The flagged first, then what stays (by path within each).
for verdict in REMOVE keep bench other; do print -rn -- "${shown_blocks[$verdict]}"; done

if (( ! ${#apps} )); then print "No CURuntime.app found."; print; fi
print -r -- "${#apps} bundles: ${count[keep]} keep, ${count[REMOVE]} REMOVE, ${count[bench]} bench, ${count[other]} other"

if (( ! DELETE )); then
  if (( ${#flagged} )); then
    print "To remove the REMOVE bundles: zsh scripts/find-release-builds.sh --delete. Or rotate the release certificate"
    print "(docs/DESIGN.md, Signing): none of them holds the permissions afterwards, wherever it lies."
    exit 1
  fi
  exit 0
fi

if (( ! ${#flagged} )); then print "Nothing to remove."; exit 0; fi
if (( ! keychain_listed )); then
  print -u2 "nothing removed: the keychain's identities could not be listed, so which release build is current is not known"
  exit 1
fi
if (( ${#release} > 1 )); then
  print -u2 "nothing removed: several identities are named $RELEASE_NAME ($(identities $release)), so which one is current"
  print -u2 "is not known. Keep the one this Mac's permissions were granted to (security delete-identity -Z <SHA-1> for the"
  print -u2 "others), then run this again."
  exit 1
fi
if (( ${#busy} )); then
  print -u2 "nothing removed: a process runs from these, and removing a bundle does not stop it. Quit it first (the plugin"
  print -u2 "page's 停止, or kill <pid>), then run this again:"
  print -u2 -l -- "  "${^busy}
  exit 1
fi
if (( ${flagged[(Ie)$INSTALLED]} )); then
  print -r -- "$INSTALLED is among them: once it is removed, the plugin and cu-std have no daemon until the next install"
  print "(安装守护进程 on the plugin page's 守护进程 tab)."
fi
if ! ( : </dev/tty ) 2>/dev/null; then
  print -u2 "nothing removed: --delete asks on the terminal, and this process has none (/dev/tty): run it in Terminal"
  exit 1
fi
print -rn -- "Type yes to remove the ${#flagged} bundles marked REMOVE (rm -rf, not to the Trash): " >/dev/tty
answer=''
IFS= read -r answer </dev/tty || answer=''
if [[ $answer != yes ]]; then print "Nothing removed (the answer was not yes)."; exit 1; fi

failed=0
take_procs
for app in $flagged; do
  # Into the bundle's parent as it is now (cd -P resolves every symlink on the way): it must be the directory listed,
  # whose path was resolved. From here on the bundle is ./<name> in it, so a directory higher up swapped for a symlink
  # after this check changes nothing about what is read and removed.
  if ! cd -P -- ${app:h} 2>/dev/null || [[ $PWD != ${app:h} ]]; then
    print -u2 -r -- "left alone: $app changed since it was listed (a directory on its path is gone or a symlink now)"
    failed=1; continue
  fi
  here=./${app:t}
  if [[ ! -d $here || -L $here || $(bundle_id $here) != $BUNDLE_ID ]]; then
    print -u2 -r -- "left alone: $app changed since it was listed"; failed=1; continue
  fi
  read_bundle $here
  if [[ $state != ${judged[$app]} ]]; then
    print -u2 -r -- "left alone: $app changed since it was listed (its Info.plist or signature is not the one judged)"
    failed=1; continue
  fi
  running=$(pids_in $app)
  if [[ -n $running ]]; then
    print -u2 -r -- "left alone: $app (a process runs from it since the listing: pid $running)"; failed=1; continue
  fi
  if /bin/rm -rf -- "$here"; then
    print -r -- "removed $app"
  else
    print -u2 -r -- "could not remove $app"; failed=1
  fi
done
if (( ${flagged[(Ie)$INSTALLED]} )) && [[ ! -e $INSTALLED ]]; then
  print -r -- "$INSTALLED is gone: the plugin and cu-std have no daemon until the next install (安装守护进程 on the"
  print "plugin page's 守护进程 tab)."
fi
print "Run this again without --delete to check that nothing is left."
exit $failed
