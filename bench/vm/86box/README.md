# 86Box in the VM base (T6)

T6 (`bench/tasks/T6-86box-dir.yaml`) reads a DOS `dir` listing off an 86Box window: pixels only, no AX text — the
"emulator screen" case of the MVP scope. Everything here is installed into the `cu-base` VM by
`scripts/vm-install-86box.sh`; the runner (`bench/run_e2e.py`, `REAL_APPS`) copies the VM folder fresh for every job
and waits (daemon OCR, outside the job's audit window) until the listing is on screen (~50 s from cold).

| guest path | what | source |
|---|---|---|
| `~/Applications/86Box.app` | 86Box v6.0 build 9001, macOS universal, Developer ID signed (Team 824AP7LZ7M) | `86Box-macOS-x86_64+arm64-b9001.zip`, sha256 `fc66fc97…3140a5a9` |
| `~/86box/roms` | 86Box ROM set v6.0 (`86Box-roms-26761b5`) | GitHub `86Box/roms` zipball v6.0, sha256 `4b5f723f…c8e0c48d` |
| `~/86box/t6/86box.cfg` | AMI 286 (`ami286`), 12.5 MHz, 1 MB, ET4000AX, one 1.44 MB drive (write-protected `t6.img`) | `t6/86box.cfg` here (as 86Box rewrote it on first start) |
| `~/86box/t6/nvr/ami286.nvr` | CMOS: drive A 1.44 MB 3½", display VGA/EGA, keyboard installed | `t6/ami286.nvr` here, set once by hand in the BIOS setup (a fresh CMOS stops at a setup menu) |
| `~/86box/t6/t6.img` | FreeDOS 1.3 boot floppy that runs `dir A:\` | `build-t6.sh` from `FD13-FloppyEdition.zip`, sha256 `75a4e11a…d80eb072` |

The listing shows the build date of `t6.img` next to each file; the answer (COMMAND.COM, 85,480 bytes) does not
depend on it. The installed image is `t6.img` sha256 `d4deeb68…68145df9` (built 2026-10-01).

Notes:
- 86Box ignores SIGTERM; the runner stops it with SIGKILL, which is fine because the folder is a throwaway copy.
- The daemon reports the app as `net.86box.86box` (lower case); grants and audits compare case-insensitively.
- Downloads and the built image live outside the repo in `vm/86box/` (they are not ours to redistribute, or are
  rebuilt from a script).
