#!/bin/zsh
# Creates a self-signed code-signing identity that scripts/build-app.sh signs CURuntime.app with, in your login
# keychain. Run it once, in Terminal on your Mac's screen (not over SSH: the login keychain is locked there).
#   scripts/make-signing-identity.sh                            # identity "cu-runtime-signing": release builds
#   scripts/make-signing-identity.sh cu-runtime-bench-signing   # the bench identity (CU_BENCH=1 builds; maintainers)
# Why your own certificate: macOS ties the two permissions (Accessibility, Screen Recording) to the certificate an
# app is signed with, not to one build, so rebuilding later keeps them. Keep the identity: if it is deleted, the next
# build is a "different app" to macOS and both permissions have to be granted again.
# The bench identity is a second certificate, so that a bench build (it takes --state-dir and the test-harness
# switches) never carries the permissions granted on this Mac: only the VM base grants it, once
# (scripts/vm-grant-base.sh); never grant a bench build on this Mac.
# Same recipe as the maintainer's (PLAN-v2 §3.2): RSA 2048, CA:FALSE, key usage digitalSignature, extended key usage
# codeSigning only, 10 years. It is not marked trusted: signing and the permissions work without that, and trusting it
# would need a password prompt for nothing. So `security find-identity -v` (valid only) does not list it; without -v
# it shows as CSSMERR_TP_NOT_TRUSTED, which is expected. The private key never leaves the keychain afterwards, and it
# is never on disk unencrypted: openssl writes it encrypted with a random one-time password, which only this process
# holds (passed to openssl through a pipe; to security import, which takes it no other way, as an argument), and the
# temporary files (the encrypted key, the certificate, the .p12) are deleted when the script ends, also when it is
# interrupted or terminated (INT, TERM, HUP); a SIGKILL leaves them in $TMPDIR, of no use without the password. A copy
# of the certificate alone, which is public, stays in ~/.<name>/cert.pem (see the end).
# Every tool is called by its absolute path (the plugin's host runs this as /bin/zsh -f with a minimal environment).
set -euo pipefail

NAME=${1:-cu-runtime-signing}
OPENSSL=/usr/bin/openssl   # LibreSSL: its .p12 is what `security import` reads (OpenSSL 3 would need -legacy)
KEYCHAIN=$HOME/Library/Keychains/login.keychain-db

existing=$(/usr/bin/security find-identity -p codesigning | /usr/bin/awk -v n="\"$NAME\"" '$3 == n {print $2}' | /usr/bin/sort -u)
if [[ -n $existing ]]; then
  print "identity \"$NAME\" already exists ($existing): nothing to do"
  # Created before 2026-10-20, the key trusts codesign and signing never asks; docs/desktop.md 2.3 says how to
  # remove codesign from the key's access list (Keychain Access) without changing the key, so the permissions stay.
  print "if signing never asks for the keychain password, codesign is still on the key's access list: see docs/desktop.md 2.3"
  # An identity made before this script kept its certificate has no ~/.<name>/cert.pem; docs/DESIGN.md (Signing) says how
  # to take it from the identity's .p12 backup. Nothing is written here.
  if [[ ! -e $HOME/.$NAME/cert.pem ]]; then
    print "no certificate is kept in $HOME/.$NAME/cert.pem to check the identity against: docs/DESIGN.md (Signing) says how to"
    print "take it from the identity's .p12 backup"
  fi
  exit 0
fi

# The traps before the directory exists, so no moment is left without them. zsh runs an EXIT trap on exit and errexit
# at the top level (not when errexit fires inside a function: none of the steps below is in one), but not when a signal
# ends it, hence the three signal traps, each exiting with the status the signal would have given.
TMP=''
cleanup() { [[ -z $TMP ]] || /bin/rm -rf -- "$TMP" }
trap cleanup EXIT
trap 'cleanup; exit 129' HUP
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
umask 077
TMP=$(/usr/bin/mktemp -d)
/bin/chmod 700 "$TMP"
/bin/cat > "$TMP/req.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = ext
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF
PASS=$("$OPENSSL" rand -hex 24)
# No -nodes: key.pem is written encrypted with PASS. pkcs12 reads two lines when -passin and -passout are both stdin:
# the key's password, then the .p12's.
print -r -- "$PASS" | "$OPENSSL" req -x509 -newkey rsa:2048 -days 3650 -config "$TMP/req.cnf" \
  -keyout "$TMP/key.pem" -passout stdin -out "$TMP/cert.pem" 2>/dev/null
print -r -- "$PASS"$'\n'"$PASS" | "$OPENSSL" pkcs12 -export -inkey "$TMP/key.pem" -passin stdin -in "$TMP/cert.pem" \
  -name "$NAME" -out "$TMP/id.p12" -passout stdin
/bin/rm -f "$TMP/key.pem"
# No -T: the key's access list does not name codesign, so every signing (scripts/build-app.sh, the plugin page's
# daemon install) makes macOS ask for the login keychain password. Nothing else on this Mac can then sign a look-alike
# CURuntime.app, which would keep both permissions, without the user seeing it. The answer is Allow (允许); Always
# Allow (始终允许) puts codesign on the list and signing stops asking.
/usr/bin/security import "$TMP/id.p12" -k "$KEYCHAIN" -P "$PASS" >/dev/null || {
  print -u2 "import failed: is the login keychain locked? Run this in Terminal on the Mac's screen, logged in."; exit 1; }

created=$(/usr/bin/security find-identity -p codesigning | /usr/bin/awk -v n="\"$NAME\"" '$3 == n {print $2}' | /usr/bin/sort -u)
[[ -n $created ]] || { print -u2 "the identity does not show up in security find-identity -p codesigning"; exit 1; }
print "created code-signing identity \"$NAME\" ($created) in the login keychain"
# The certificate, which is public, is kept (the key never is): ~/.<name>/cert.pem is what the identity is checked
# against later, e.g. the SHA-1 the plugin page shows (openssl x509 -noout -fingerprint -sha1 -in it), since listing
# the keychain again only shows what it holds now. A cert.pem already there (of an identity no longer in the keychain;
# a symlink too) is renamed to cert.pem.replaced-<time>, never followed or overwritten. Best effort: the identity is
# made either way. Only for a name that is a plain file name (both of ours are).
KEEP=$HOME/.$NAME
fingerprint=$("$OPENSSL" x509 -noout -fingerprint -sha1 -in "$TMP/cert.pem" 2>/dev/null) || fingerprint=''
fingerprint=${fingerprint#*=}
if [[ $NAME =~ '^[A-Za-z0-9][A-Za-z0-9._-]*$' ]] \
   && { [[ -d $KEEP && ! -L $KEEP ]] || /bin/mkdir -m 700 "$KEEP" 2>/dev/null; } \
   && { [[ ! -e $KEEP/cert.pem && ! -L $KEEP/cert.pem ]] \
        || /bin/mv "$KEEP/cert.pem" "$KEEP/cert.pem.replaced-$(/bin/date +%Y%m%d-%H%M%S)"; } \
   && /bin/cp "$TMP/cert.pem" "$KEEP/cert.pem"; then
  print "its certificate (SHA-1 ${fingerprint:-unknown}) is kept in $KEEP/cert.pem; to check the identity later:"
  print "  /usr/bin/openssl x509 -noout -fingerprint -sha1 -in $KEEP/cert.pem"
else
  print -u2 "its certificate could not be kept in $KEEP/cert.pem (the identity is made all the same)"
fi
[[ ${fingerprint//:/} == ${(U)created} ]] \
  || print -u2 "the certificate just made (SHA-1 ${fingerprint:-unknown}) is not the identity listed ($created): check the keychain"
print "each signing asks for the login keychain password: enter it and choose Allow (允许), not Always Allow (始终允许)"
if [[ $NAME == cu-runtime-bench-signing ]]; then
  print "bench builds (CU_BENCH=1 scripts/build-app.sh) are signed with it; the VM base must grant it once:"
  print "see scripts/vm-grant-base.sh (never grant a bench build on this Mac)"
fi
