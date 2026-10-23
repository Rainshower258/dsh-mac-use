#!/bin/zsh
# Build the T6 boot floppy from the FreeDOS 1.3 Floppy Edition: boots without the language menu and the installer,
# clears the screen and runs `dir A:\` (COMMAND.COM copied to the root: its size is T6's answer, 85480 bytes).
#   bench/vm/86box/build-t6.sh <FD13-FloppyEdition.zip> <out dir>
# Needs mtools (brew install mtools): writing through a macOS mount would add a .fseventsd folder to the listing.
set -euo pipefail
ZIP=$1; OUT=$2
TMP=$(mktemp -d); trap 'rm -rf $TMP' EXIT
export MTOOLS_SKIP_CHECK=1
unzip -q -o "$ZIP" 144m/x86BOOT.img -d "$TMP"
IMG=$OUT/t6.img
mkdir -p "$OUT"; cp "$TMP/144m/x86BOOT.img" "$IMG"
mcopy -i "$IMG" ::/FREEDOS/BIN/COMMAND.COM "$TMP/COMMAND.COM"
mcopy -i "$IMG" "$TMP/COMMAND.COM" ::/COMMAND.COM
mdel -i "$IMG" ::/SETUP.BAT ::/FDCONFIG.SYS ::/FDAUTO.BAT
printf '!LASTDRIVE=Z\r\n!FILES=20\r\nSHELL=\\COMMAND.COM \\ /E:1024 /P=\\FDAUTO.BAT\r\n' > "$TMP/FDCONFIG.SYS"
printf '@ECHO OFF\r\nCLS\r\nDIR A:\\\r\n' > "$TMP/FDAUTO.BAT"
mcopy -i "$IMG" "$TMP/FDCONFIG.SYS" "$TMP/FDAUTO.BAT" ::/
mdir -i "$IMG" ::/
