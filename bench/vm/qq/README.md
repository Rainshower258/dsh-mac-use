# QQ in the VM base (T7)

**Own base: `cu-base-qq`** (2026-10-10). QQ starts by itself at every login (not a launch agent, login item, BTM
entry or its login helper; mechanism not found), and its "login expired" window then sat in the middle of every
cu-base clone. So cu-base never has QQ; `cu-base-qq`, cloned from cu-base, is T7's base: `vm-qq-base.sh` and
`bench/vm/t7_run.sh` use it by default (`CU_BASE` overrides). It keeps QQ's local data between rounds. Something that
changes cu-base (a new daemon is deployed by `prepare` anyway) does not reach cu-base-qq by itself.

T7 (`bench/tasks/T7-qq-*.yaml`) reads a real QQ conversation inside the VM. Set up once, with the maintainer at
the Mac, by `scripts/vm-qq-base.sh prepare|inspect|finish`:

1. backup clone of the base (`cu-base-preqq-<date>`); the daemon built from HEAD (with the action allowlist) is
   deployed into the base in the same session (same signing identity: no new TCC grant; `finish` self-checks);
2. QQ 7.0.2 (`com.tencent.qq`, Tencent signed, app bundle only — no user data from the host) into
   `~/Applications/QQ.app` in the base, as a zip unpacked with ditto;
3. the maintainer logs in a **test account** by QR code in the VM window (auto-login on) and sends
   `messages.md` from another account; the conversation is pinned, then closed;
   - the test account's friend list holds **only** that other account, and it is in **no group** (checked on site);
   - `inspect` prints how QQ shows the scripted lines (AX with electron_ax off/on, and OCR): if the emoji show as
     QQ's own faces ("[微笑]"-style AX text, nothing from OCR), the accepted spellings go into T7-qq-latest's
     `equivalents`; empty means Unicode only;
4. QQ quit with SIGTERM (keeps the login), base shut down clean.

Every T7 job starts QQ in a throwaway clone (the runner's `REAL_APPS['QQ']`), waits for the main window, and
stops it again (SIGTERM, then SIGKILL after 10 s). The model's grant covers QQ only.

**Read only, enforced** (2026-10-02): every T7 task carries `actions: [observe, zoom, read_text, click, scroll]`.
The plugin offers no other cu_* tool, and the daemon refuses every other method for that grant
(`action_not_allowed`, retry `never`): no cu_type, cu_set_value or cu_key, so no character and no Return can reach
QQ. The runner refuses a QQ task without such a list, or on a non-cu-runtime arm. Second safeguard: allowed typing,
value setting and key presses are still counted per job (`audit.text_input_actions`, score.md "text input
allowed"); it must stay 0. Clicks are limited too (`click_limit: {buttons: [left], max_count: 1}`, refused
`click_not_allowed`): no double click (QQ pokes a double-clicked avatar), no right-click menu (delete chat). Still
possible: a left click in the sticker panel sends a sticker; check the other account's chat after the T7 runs.

**Clean start or environment failure**: QQ syncs with its server whenever a clone starts and may show a
new-device / update / security notice that differs run to run. Ready = the ready text on screen, no second QQ
window, QQ frontmost, nothing covering it, none of the task's `popup_text` keywords (checked again after
settle_s). Otherwise the job is an environment failure: no model call, left out of every metric, counted in
score.md "env failures".

**The login is good for one clone**: QQ renews its login token on every auto-login, and the renewed token lives
only in the clone that logged in (thrown away with it), so the base's copy is dead after the first clone that starts
QQ (2026-10-02: smoke test and trial ran, then every B1 job found "login expired"). So: log the test account in again
in the base right before a T7 batch, and run the whole batch in one clone (`bench/vm/t7_run.sh`, run_vm.sh ARMS mode;
QQ restarts between jobs inside that clone keep working). Also in the base: macOS update checks are off and the update
hosts blocked in /etc/hosts, because the update notification covered QQ (the readiness check caught it).

**Read state is shared between clones**: opening the conversation in one clone marks it read on the server, so the
next clone's list may show a different unread badge. No T7 task depends on it; the report says so.

Privacy: no nickname or account in any prompt or file here; the conversation is addressed as "the pinned one".
The test account's chat history lives only in the VM base.
