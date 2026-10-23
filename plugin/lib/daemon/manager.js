/**
 * The daemon's management from dsh's plugin page: its status, the build-and-install task,
 * start, stop, restart, the permission prompts, the Command Line Tools installer, a self-check. host.ts exposes each
 * operation as one owner-only route without parameters; nothing here forwards a daemon RPC, and the status carries no
 * token, audit or screen content.
 *
 * Rules every operation keeps:
 * - Paths, identity name and bundle id are constants (paths.ts); the package directory is only read.
 * - Every command runs with a fixed minimal environment (childEnv): nothing of dsh's own environment (CU_*, DYLD_*,
 *   DEVELOPER_DIR, ZDOTDIR, a PATH with other directories first…) changes what build-app.sh builds, what it runs or
 *   what it signs with. The package's scripts run as `/bin/zsh -f`, which reads no startup file (~/.zshenv could set
 *   those again).
 * - The daemon app is launched only through LaunchServices (/usr/bin/open: -g to serve, -n for request-permissions and
 *   self-check), never as a child of dsh, so it runs with its own TCC permissions; `open -W` is never used (it does not
 *   always wait), the self-check result file is waited for instead.
 * - Before an app is started or launched, it must be a release build (Info.plist CUBench false: a bench build serves
 *   any state dir and takes config.json's test-harness switches), satisfy the designated requirement (paths.ts): this
 *   bundle id, signed by the local identity's certificate, and be signed with hardened runtime (the CodeDirectory's
 *   runtime flag, as build-app.sh checks it). There must be exactly one identity of that name: with several, an app
 *   signed by any of them would pass, so every operation that would sign, start or launch refuses (identity_ambiguous)
 *   and the status reports no valid signature. A fresh build is first copied into ~/Applications under a staging name;
 *   that copy is checked the same way, and must carry the source hash of the sources copied for the build
 *   (CUSourceHash), before it is renamed into place: the copy checked is the copy installed.
 * - The identity on record (paths.ts knownIdentity): the SHA-1 of the identity the host last signed with successfully
 *   or created. With no such record, the SHA-1 of the installed app's leaf certificate (read with `codesign -d
 *   --extract-certificates`, never by signing) stands in for it, and is never written to the record. One identity of
 *   the name that is not the known one (replaced by another of the same name) is not signed with: the install refuses
 *   (identity_changed) until the owner, having compared it with the backed-up certificate, accepts it on the page
 *   (acceptIdentity), which accepts only the identity a status this manager served showed as changed. With nothing
 *   known, the one there is recorded once it has signed. build-app.sh signs only with the SHA-1 preflight checked (or
 *   the one this install created): CU_SIGN_IDENTITY, set by the host alone. An identity counts as created by this
 *   install only when make-signing-identity.sh's own output names it (CREATED_LINE) and there was none before.
 * - One install at a time: a second install joins the running task, also from a manager made again for the same System
 *   (the row reloaded while the task ran: the new manager takes the task over). Across dsh processes (the everyday
 *   web, the Electron app, cu-std), and across loads of this module in one process (a package update), a lock file in
 *   the cache serialises the install and the actions; a manager with no task of its own reports the lock's live holder
 *   (status().busy). A task that finds at a phase change that its lock was taken over (it was found stale) fails
 *   (busy): two installs never go on together. While the daemon is stopped for a replacement, autoStart's stop mark
 *   keeps any cu_* call from starting it; the mark goes when the task ends, whether or not the daemon it stopped runs
 *   again (it was not stopped by the user).
 * - Every operation the page starts is appended to the action log (paths.ts actionLog), with its outcome (and a
 *   failure's message) and the identity it signed with or checked against; an identity the install created is
 *   recorded as such as soon as make-signing-identity.sh's run is over, however it ended (a cancel included).
 *
 * @module
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SAME_BOOT_S, stopMarkOfThisBoot, stopMarkText } from "../autostart.js";
import { BENCH_ONLY_CONFIG_KEYS, BIN, BUILD_INPUTS, designatedRequirement, IDENTITY_NAME, SETTINGS_PANES } from "./paths.js";
import { sourceHash } from "./source-hash.js";
export const LOG_LINES = 200;
const MAX_LINE = 2000;
export const POLL_MS = 500;
/** How long a stopped daemon gets to exit (scripts/uninstall.sh: 20 × 0.5 s). */
export const STOP_WAIT_MS = 10_000;
/** How long a started daemon gets to be up: its process there and its socket accepting a connection. */
export const START_WAIT_MS = 10_000;
/**
 * Once the started daemon's process shows up, how long it must stay up before its socket is tried (a release build
 * exits right after its check-in when config.json turns on a bench-only switch).
 */
export const START_SETTLE_MS = 1000;
/** How long one connection attempt to the daemon's socket may take. */
const SOCKET_PROBE_MS = 1000;
export const SELF_CHECK_WAIT_MS = 20_000;
export const PERMISSIONS_MAX_AGE_MS = 10 * 60_000;
/**
 * A lock whose time is older than this is stale whoever holds it: a running task refreshes the time at each phase
 * change, and no phase is bounded by more than BUILD_TIMEOUT_MS (an action takes a minute or two at most).
 */
export const LOCK_STALE_MS = 2 * 60 * 60_000;
/**
 * A lock's time may be this far ahead of the clock (the clock was set back a little since it was written) and still
 * count; further ahead it is stale, since a time in the future would never age.
 */
export const LOCK_SKEW_MS = 60_000;
/** How long the host's going away waits at most for the install task to end (dispose). */
export const DISPOSE_WAIT_MS = 30_000;
/**
 * build-app.sh's contract with the host: it prints this line alone on stdout right before it signs, and exits with
 * SIGN_FAILED_STATUS when signing (codesign, or its verification right after) fails.
 */
export const SIGN_MARKER = '== sign';
export const SIGN_FAILED_STATUS = 3;
/**
 * make-signing-identity.sh's line once it has imported a new identity and found it listed: `created code-signing
 * identity "<name>" (<SHA-1>) in the login keychain`. The only proof the host takes that an identity was created by
 * its run (the script prints "already exists" and exits 0 for one that was there).
 */
export const CREATED_LINE = /^created code-signing identity "([^"]*)" \(([0-9A-Fa-f]{40})\) in the login keychain$/;
/**
 * What a task that ended while signing says: the keychain dialog codesign asked for belongs to SecurityAgent and
 * outlives codesign (a cancel, a timeout or the host going away ends codesign, not the dialog; a second signing may
 * have asked again).
 */
export const KEYCHAIN_NOTE = 'a keychain password dialog for this signing may still be open on the Mac\'s screen '
    + '(it outlives codesign): answer it with 拒绝 (Deny)';
/**
 * The CodeDirectory flags in `codesign -d --verbose=1` output (it prints them on stderr), e.g. "flags=0x10000(runtime)",
 * with the hardened runtime among them: the pattern scripts/build-app.sh checks its own signature with.
 */
export const HARDENED_RUNTIME = /flags=0x[0-9a-f]+\(([^),]+,)*runtime[,)]/;
const BUILD_TIMEOUT_MS = 30 * 60_000;
const IDENTITY_TIMEOUT_MS = 2 * 60_000;
const COPY_TIMEOUT_MS = 5 * 60_000;
const QUICK_TIMEOUT_MS = 30_000;
/** Every command's PATH, and the only variables of this process's environment a command gets (childEnv). */
const CHILD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const CHILD_ENV_KEYS = ['USER', 'LOGNAME', 'TMPDIR', 'LANG'];
/** Cancel is accepted in these phases; from replace on the task runs to its end. */
const CANCELLABLE = new Set(['preflight', 'identity', 'copy', 'build', 'sign', 'verify', 'stop']);
const FINISHED = new Set(['done', 'failed', 'cancelled']);
/** The install task's phases that stop, replace or start the daemon: the settings routes answer busy then (settingsGate). */
export const SETTINGS_BUSY_PHASES = new Set(['stop', 'replace', 'start', 'selfcheck']);
class TaskFailure extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** Ends the install task as failed with this code. */
function fail(code, message) {
    throw new TaskFailure(code, message);
}
class Cancelled extends Error {
}
/**
 * The install task of each System (one per dsh process), shared by every manager made for it: a manager made again
 * (the row reloaded or updated while a task ran) reports that task, joins it on install and is busy while it runs,
 * instead of reporting no task while the earlier manager's task still holds the lock.
 */
const TASKS = new WeakMap();
const snapshot = (s) => ({ ...s, log: [...s.log], error: s.error === null ? null : { ...s.error } });
const failure = (code, message) => ({ ok: false, error: { code, message } });
const OK = { ok: true, error: null };
/**
 * A SHA-1 (40 hex digits) as `openssl x509 -noout -fingerprint -sha1` prints it: upper-case hex pairs joined by ':'.
 * Every SHA-1 in a message or a task log line (both are shown on the page) is written so; the action log and the
 * identity on record keep the 40 digits.
 */
export function fingerprint(sha1) {
    return sha1.toUpperCase().match(/../g)?.join(':') ?? sha1;
}
/** Why these identities cannot check an app: none (identity_missing) or several of the name (identity_ambiguous). */
function identityRefusal(identities) {
    if (identities.length === 0) {
        return { code: 'identity_missing', message: `no code-signing identity "${IDENTITY_NAME}" to check the app against` };
    }
    if (identities.length > 1) {
        return { code: 'identity_ambiguous', message: `several code-signing identities are named "${IDENTITY_NAME}" `
                + `(SHA-1 ${identities.map(fingerprint).join(', ')}): an app signed by any of them would pass; keep the one the `
                + 'permissions were granted to' };
    }
    return null;
}
/** What a known SHA-1 is, for a message: the identity on record, or the one the installed app at `app` is signed with. */
function knownText(known, app) {
    return `${known.source === 'record' ? 'the one this host last signed with or created' : `the one the installed app ${app} `
        + 'is signed with'} (SHA-1 ${fingerprint(known.sha1)})`;
}
/** install's refusal when the one identity of the name is not the known one (identity_changed): both SHA-1s. */
function identityChanged(known, current, app) {
    return { code: 'identity_changed', message: `the code-signing identity "${IDENTITY_NAME}" in the keychain (SHA-1 `
            + `${fingerprint(current)}) is not ${knownText(known, app)}: `
            + 'nothing is built or signed until the owner has compared the current SHA-1 with the backed-up certificate '
            + '(openssl x509 -noout -fingerprint -sha1 -in <the cert.pem kept with the identity\'s .p12 backup>) and accepted '
            + 'it on the plugin page' };
}
/** The lock file's fields (lock()), or null when its text is no JSON object. */
function parseLock(text) {
    let held = null;
    try {
        held = JSON.parse(text ?? 'null');
    }
    catch { /* junk */ }
    return typeof held === 'object' && held !== null && !Array.isArray(held) ? held : null;
}
/** The codes verifyInstalled refuses an installed app with: it is not one this host starts. */
const REFUSALS = new Set(['not_installed', 'identity_missing', 'identity_ambiguous', 'not_release_build',
    'signature_mismatch']);
/**
 * What the task log, and a failed task's message, say of a daemon the install stopped and did not start again: why,
 * and for an app this host refuses to start, that a release build must be installed.
 */
function notRestartedText(why) {
    return REFUSALS.has(why.code)
        ? `the daemon this install stopped is not started again (${why.code}: ${why.message}): a release build must be `
            + 'installed (the plugin page\'s install) to run it again'
        : `the daemon this install stopped could not be started again (${why.code}: ${why.message})`;
}
const tail = (r, n = 5) => `${r.stderr}\n${r.stdout}`.split('\n').filter((l) => l.trim() !== '').slice(-n).join(' | ');
const duration = (ms) => (ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1000} s`);
/** How a run that did not succeed ended, for a message. */
function ending(r, timeoutMs) {
    if (r.code !== null)
        return `exited with status ${r.code}`;
    return r.timedOut === true ? `timed out after ${duration(timeoutMs)}` : 'was ended, or could not be started';
}
// ------------------------------------------------------------------------------------------------ the app check
/**
 * How every command of the host runs on this System: with the fixed minimal environment (childEnv) and QUICK_TIMEOUT_MS
 * unless the options say otherwise. The manager's own runner (run), and the one installedAppVerifier checks an app with.
 */
export function hostRun(sys) {
    return (file, args, options = {}) => sys.run(file, args, { env: childEnv(sys), timeoutMs: QUICK_TIMEOUT_MS, ...options });
}
/**
 * The whole environment of every command: PATH of the system directories alone, HOME (the home the paths are made
 * from), and USER, LOGNAME, TMPDIR and LANG from this process's environment when set; nothing else. So no CU_*
 * (CU_SIGN_IDENTITY, CU_SIGN_NAME, CU_BENCH… would change what build-app.sh builds or signs with), and nothing that
 * changes what it runs (DYLD_*, DEVELOPER_DIR, SDKROOT, TOOLCHAINS, SWIFT*, GIT_*, ZDOTDIR, a PATH of other
 * directories).
 */
function childEnv(sys) {
    const env = { PATH: CHILD_PATH, HOME: sys.home };
    for (const key of CHILD_ENV_KEYS) {
        const value = sys.env[key];
        if (value !== undefined && value !== '')
            env[key] = value;
    }
    return env;
}
/** One value of an Info.plist (plutil's raw form: a string as is, a boolean as true or false), or null. */
async function plistValueWith(run, info, key) {
    const r = await run(BIN.plutil, ['-extract', key, 'raw', '-o', '-', info]);
    const value = r.stdout.trim();
    return r.code === 0 && value !== '' ? value : null;
}
/** The identities named IDENTITY_NAME, or why `security find-identity` could not list them (identity_failed). */
async function listIdentitiesWith(run) {
    const r = await run(BIN.security, ['find-identity', '-p', 'codesigning']);
    if (r.code !== 0) {
        return { code: 'identity_failed', message: `security find-identity ${ending(r, QUICK_TIMEOUT_MS)}: ${tail(r)}` };
    }
    const found = new Set();
    for (const line of r.stdout.split('\n')) {
        const m = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]*)"/.exec(line);
        if (m !== null && m[2] === IDENTITY_NAME)
            found.add(m[1].toUpperCase());
    }
    return { identities: [...found].sort() };
}
/**
 * The SHA-1s of the code-signing identities named IDENTITY_NAME (as scripts/build-app.sh finds them: not -v); none
 * also when `security find-identity` fails (listIdentitiesWith tells the two apart).
 */
async function identitiesWith(run) {
    const listed = await listIdentitiesWith(run);
    return 'identities' in listed ? listed.identities : [];
}
/**
 * null when the app's signature carries the hardened runtime flag (HARDENED_RUNTIME in `codesign -d --verbose=1`);
 * else not_release_build, naming the flags codesign showed.
 */
async function hardenedWith(app, run) {
    const r = await run(BIN.codesign, ['-d', '--verbose=1', app], { timeoutMs: 60_000 });
    const shown = `${r.stderr}\n${r.stdout}`;
    if (r.code === 0 && HARDENED_RUNTIME.test(shown))
        return null;
    const flags = /flags=0x[0-9a-f]+(\([^)]*\))?/.exec(shown)?.[0];
    return { code: 'not_release_build', message: `${app} is signed without hardened runtime (codesign -d shows `
            + `${flags ?? `no CodeDirectory flags: ${tail(r)}`}): reinstall it` };
}
/**
 * null when the app at this path is fit to run: a release build (Info.plist CUBench false, else
 * not_release_build), the build of these sources when a source hash is given (CUSourceHash equal, else
 * build_failed), satisfying the designated requirement of the one identity (else signature_mismatch), signed with
 * hardened runtime (HARDENED_RUNTIME in `codesign -d --verbose=1`, else not_release_build: a build from before
 * build-app.sh signed with --options runtime; reinstall).
 */
async function checkAppWith(app, identities, run, sourceHash) {
    const info = join(app, 'Contents/Info.plist');
    const bench = await plistValueWith(run, info, 'CUBench');
    if (bench !== 'false') {
        return { code: 'not_release_build', message: `${app} is not a release build: its Info.plist CUBench is `
                + `${bench ?? 'missing'}, not false` };
    }
    if (sourceHash !== undefined) {
        const built = await plistValueWith(run, info, 'CUSourceHash');
        if (built !== sourceHash) {
            return { code: 'build_failed', message: `${app} is not the build of the sources copied for it: its CUSourceHash is `
                    + `${built ?? 'missing'}, their source hash ${sourceHash}` };
        }
    }
    const requirement = designatedRequirement(identities);
    const r = await run(BIN.codesign, ['--verify', '--strict', '-R', requirement, app], { timeoutMs: 60_000 });
    if (r.code !== 0)
        return { code: 'signature_mismatch', message: `${app} does not satisfy ${requirement}: ${tail(r)}` };
    return hardenedWith(app, run);
}
/**
 * The host's rules for an app it may start or launch, in one place: the manager checks the installed app with them
 * before every start or launch (verifyInstalled), and autoStart checks the app it would open with them
 * (installedAppVerifier, index.ts), so the two cannot drift. null when the app at `app` may be started: installed
 * (else not_installed), one identity of IDENTITY_NAME (not none: identity_missing, nothing to check against; not
 * several: identity_ambiguous, an app signed by any of them would pass), and fit to run (checkAppWith: CUBench false,
 * the designated requirement of that identity, hardened runtime). The identity it is checked against goes into `note`.
 */
export async function verifyApp(app, check, note) {
    if (!check.exists(app))
        return { code: 'not_installed', message: `${app} is not installed` };
    const identities = await check.identities();
    const refused = identityRefusal(identities);
    if (refused !== null)
        return refused;
    if (note !== undefined)
        note.identity = identities[0];
    return checkAppWith(app, identities, check.run);
}
/**
 * verifyApp on this System as the manager runs it (hostRun: the fixed minimal environment; the identities as the
 * manager lists them, none when `security find-identity` fails): the check autoStart (index.ts) gives the app it would
 * open. It only reads: plutil -extract, security find-identity, codesign --verify and codesign -d.
 */
export function installedAppVerifier(sys) {
    const run = hostRun(sys);
    return (app) => verifyApp(app, { exists: (p) => sys.fs.exists(p), run, identities: () => identitiesWith(run) });
}
export class DaemonManager {
    sys;
    paths;
    packageSourceHash;
    sourceHashOf;
    bootTime;
    disposeWaitMs;
    /** This System's install task (TASKS), shared with any other manager made for it. */
    shared;
    /** An action (start, stop…) of this manager is running. */
    acting = false;
    /**
     * The identitySha1 of the last status this manager served with identityChanged true (null: none yet): the one
     * identity acceptIdentity accepts, the one the owner was shown and compared.
     */
    shownChanged = null;
    probing;
    constructor(options) {
        this.sys = options.system;
        this.paths = options.paths;
        this.sourceHashOf = options.sourceHash ?? sourceHash;
        this.packageSourceHash = options.packageSourceHash ?? (() => this.sourceHashOf(options.paths.packageRoot));
        this.bootTime = options.bootTime;
        this.disposeWaitMs = options.disposeWaitMs ?? DISPOSE_WAIT_MS;
        let shared = TASKS.get(options.system);
        if (shared === undefined)
            TASKS.set(options.system, shared = {});
        this.shared = shared;
    }
    /** The last install task of this System (finished or not). */
    get task() {
        return this.shared.task;
    }
    set task(task) {
        this.shared.task = task;
    }
    // ------------------------------------------------------------------------------------------------ status
    async status() {
        // Polled every second while a task runs: concurrent polls share one probe.
        this.probing ??= this.probe().finally(() => { this.probing = undefined; });
        const probe = await this.probing;
        if (probe.app.identityChanged)
            this.shownChanged = probe.app.identitySha1;
        return { ...probe, task: this.taskState(), busy: this.busy() };
    }
    /** status().busy: the lock's live holder, when this manager runs no task or action of its own (which hold it). */
    busy() {
        if ((this.task !== undefined && !FINISHED.has(this.task.state.phase)) || this.acting)
            return null;
        const holder = this.readLock().holder;
        if (holder === null)
            return null;
        return { pid: holder.pid, since: new Date(holder.since).toISOString(), self: holder.pid === this.sys.pid };
    }
    /** The install task as status() reports it (the last one, finished or not), without probing anything. */
    taskState() {
        return this.task === undefined ? null : snapshot(this.task.state);
    }
    async probe() {
        const { fs } = this.sys;
        const installed = fs.exists(this.paths.app);
        const info = this.paths.appInfo;
        const [version, appHash, bench, identities, pids, environment] = await Promise.all([
            installed ? this.plistValue(info, 'CFBundleVersion') : null,
            installed ? this.plistValue(info, 'CUSourceHash') : null,
            installed ? this.plistValue(info, 'CUBench') : null,
            this.identities(),
            this.daemonPids(),
            this.environment(),
        ]);
        // Not a release build (a bench build, or one from before CUBench): never ours to start, whoever signed it.
        const release = bench === 'false';
        const signature = installed && !release ? 'mismatch' : await this.signature(this.paths.app, identities);
        let packageHash = null;
        try {
            packageHash = this.packageSourceHash();
        }
        catch { /* no Package.swift, Sources/ or scripts/build-app.sh: the package cannot build the daemon */ }
        let packageVersion = null;
        try {
            const v = JSON.parse(fs.readText(join(this.paths.packageRoot, 'package.json')) ?? '{}').version;
            packageVersion = typeof v === 'string' ? v : null;
        }
        catch { /* unreadable: shown as unknown */ }
        const known = await this.known();
        return {
            app: { installed, version, sourceHash: appHash, signature,
                identity: identities.length === 0 ? 'missing' : identities.length === 1 ? 'present' : 'ambiguous',
                identitySha1: identities.length === 1 ? identities[0] : null,
                identityKnown: known.sha1,
                identityKnownSource: known.source,
                identityChanged: identities.length === 1 && known.sha1 !== null && identities[0] !== known.sha1 },
            package: { version: packageVersion, sourceHash: packageHash },
            upToDate: installed && release && appHash !== null && appHash === packageHash,
            running: pids.length > 0,
            permissions: installed ? this.recentPermissions(version) : null,
            environment,
        };
    }
    /** One value of an Info.plist (plutil's raw form: a string as is, a boolean as true or false), or null. */
    plistValue(info, key, run = (f, a, o) => this.run(f, a, o)) {
        return plistValueWith(run, info, key);
    }
    /** identitiesWith, run as every command of the manager. */
    identities() {
        return identitiesWith((f, a, o) => this.run(f, a, o));
    }
    /** The identities named IDENTITY_NAME, or why `security find-identity` could not list them (identity_failed). */
    listIdentities() {
        return listIdentitiesWith((f, a, o) => this.run(f, a, o));
    }
    /**
     * The known SHA-1 (Status identityKnown): the one on record (knownIdentity), else the installed app's leaf
     * certificate (installedCertificate), else none. Only reads: the installed app's SHA-1 is never put on record here.
     */
    async known() {
        const recorded = this.knownIdentity();
        if (recorded !== null)
            return { sha1: recorded, source: 'record' };
        const installed = await this.installedCertificate();
        return installed === null ? { sha1: null, source: null } : { sha1: installed, source: 'installedApp' };
    }
    /**
     * The SHA-1 of the installed app's leaf certificate, or null (not installed, unsigned, ad-hoc, unreadable). Display
     * only, nothing is signed: `codesign -d --extract-certificates` writes the signature's certificates (the leaf first,
     * as <prefix>0) into a directory of its own in the cache, `openssl x509` prints the leaf's SHA-1, and the directory
     * goes either way.
     */
    async installedCertificate() {
        const { fs } = this.sys;
        if (!fs.exists(this.paths.app))
            return null;
        const dir = join(this.paths.cache, `installed-cert.${randomUUID()}`);
        try {
            fs.mkdir(dir);
            const extracted = await this.run(BIN.codesign, ['-d', `--extract-certificates=${join(dir, 'cert')}`, this.paths.app], { timeoutMs: 60_000 });
            const leaf = join(dir, 'cert0');
            if (extracted.code !== 0 || !fs.exists(leaf))
                return null;
            const r = await this.run(BIN.openssl, ['x509', '-inform', 'DER', '-noout', '-fingerprint', '-sha1', '-in', leaf]);
            const m = /^\s*sha1 fingerprint=((?:[0-9A-F]{2}:){19}[0-9A-F]{2})\s*$/im.exec(r.stdout);
            return r.code === 0 && m !== null ? m[1].replaceAll(':', '').toUpperCase() : null;
        }
        catch {
            return null;
        }
        finally {
            try {
                fs.rm(dir);
            }
            catch { /* nothing to remove */ }
        }
    }
    /** The SHA-1 on record (paths.ts knownIdentity), or null: no file, unreadable, or not one line of 40 upper-case hex. */
    knownIdentity() {
        const m = /^([0-9A-F]{40})\n?$/.exec(this.sys.fs.readText(this.paths.knownIdentity) ?? '');
        return m === null ? null : m[1];
    }
    /**
     * Puts this SHA-1 on record (paths.ts knownIdentity), unless it is already: null once it is, else why it could not
     * be written. The text goes under a name of its own first and is renamed into place: no reader finds part of it.
     */
    recordIdentity(sha1) {
        const { fs } = this.sys;
        if (this.knownIdentity() === sha1)
            return null;
        const partial = `${this.paths.knownIdentity}.${randomUUID()}.tmp`;
        try {
            fs.mkdir(this.paths.cache);
            fs.writeText(partial, `${sha1}\n`);
            fs.rename(partial, this.paths.knownIdentity);
            return null;
        }
        catch (e) {
            try {
                fs.rm(partial);
            }
            catch { /* nothing to remove */ }
            return `cannot write ${this.paths.knownIdentity}: ${String(e)}`;
        }
    }
    /**
     * After make-signing-identity.sh's run, however it ended (preflight listed no identity of the name before it): the
     * identity the script's own output names as created (CREATED_LINE: `claimed`), when it is among those listed now,
     * is the one this install created. It goes on record at once, also for a task being cancelled or ended by the host
     * going away: the task log, the action log ('identity' 'created', with its SHA-1), task.identity (the install's own
     * record names it) and, when it is the only one, the identity on record (paths.ts knownIdentity), so that no later
     * install takes it for one that was there before. Any identity listed now that the run does not prove it created
     * (the script found one of the name and made none: "already exists", exit 0; or it ended before its CREATED_LINE)
     * is not taken as created: it is one that was there before, and installSteps applies the identity_changed rule.
     */
    noteCreated(task, identities, known, claimed) {
        if (identities.length === 0)
            return;
        if (claimed === null || !identities.includes(claimed)) {
            this.log(task, `identity ${IDENTITY_NAME} ${identities.map(fingerprint).join(', ')} shows up after `
                + 'make-signing-identity.sh, whose output does not say that it created it: it is taken as one that was there before');
            return;
        }
        task.identityCreated = true;
        if (identities.length > 1) {
            this.log(task, `several identities ${IDENTITY_NAME} show up after make-signing-identity.sh created ${fingerprint(claimed)} `
                + `(SHA-1 ${identities.map(fingerprint).join(', ')}): none is put on record`);
            this.record({ action: 'identity', task: task.state.id, outcome: 'created', identity: claimed,
                message: `several identities of the name show up: ${identities.join(', ')}` });
            return;
        }
        const sha1 = claimed;
        task.identity = sha1;
        this.log(task, `identity ${IDENTITY_NAME} ${fingerprint(sha1)}: created by this install`);
        if (known.sha1 !== null && known.sha1 !== sha1) {
            this.log(task, `${known.source === 'record' ? 'the identity on record before' : `the identity the installed app `
                + `${this.paths.app} is signed with`} (SHA-1 ${fingerprint(known.sha1)}) is not in the keychain any more: `
                + 'permissions granted to the apps it signed do not carry over to the new one');
        }
        this.record({ action: 'identity', task: task.state.id, outcome: 'created', identity: sha1 });
        const unwritten = this.recordIdentity(sha1);
        if (unwritten !== null)
            this.log(task, `could not put identity ${IDENTITY_NAME} ${fingerprint(sha1)} on record: ${unwritten}`);
    }
    async signature(app, identities) {
        if (!this.sys.fs.exists(app))
            return 'missing';
        // Several identities of the name: an app signed by any of them would pass, so none is taken as ours.
        if (identities.length > 1)
            return 'mismatch';
        const args = identities.length === 1
            ? ['--verify', '--strict', '-R', designatedRequirement(identities), app]
            : ['--verify', '--strict', app];
        const r = await this.run(BIN.codesign, args, { timeoutMs: 60_000 });
        if (/not signed at all/.test(r.stderr))
            return 'unsigned';
        // Without an identity a valid signature still is not ours; without hardened runtime it is not a build to start.
        if (r.code !== 0 || identities.length !== 1)
            return 'mismatch';
        return await this.hardened(app, (f, a, o) => this.run(f, a, o)) === null ? 'ok' : 'mismatch';
    }
    /** hardenedWith (the shared check's last rule), for the status's signature. */
    hardened(app, run) {
        return hardenedWith(app, run);
    }
    /** The installed app's daemons: `cu-runtime` or `cu-runtime serve…` from its own binary (not self-check etc.). */
    async daemonPids() {
        const r = await this.run(BIN.ps, ['-axww', '-o', 'pid=,args=']);
        if (r.code !== 0)
            return [];
        const bin = this.paths.appBinary;
        const pids = [];
        for (const line of r.stdout.split('\n')) {
            const m = /^\s*(\d+)\s(.*)$/.exec(line);
            if (m === null)
                continue;
            const args = m[2].trim();
            if (args === bin || args === `${bin} serve` || args.startsWith(`${bin} serve `))
                pids.push(Number(m[1]));
        }
        return pids;
    }
    async environment() {
        const sshSession = Boolean(this.sys.env.SSH_CONNECTION || this.sys.env.SSH_TTY);
        const [clt, manager] = await Promise.all([
            this.run(BIN.xcodeSelect, ['-p']).then((r) => r.code === 0),
            this.run(BIN.launchctl, ['managername']),
        ]);
        // Aqua: a login session at the Mac's screen (signing needs its unlocked keychain). launchctl unavailable: no
        // evidence against it beyond SSH.
        const gui = !sshSession && (manager.code !== 0 || manager.stdout.trim() === 'Aqua');
        return { gui, clt, sshSession };
    }
    readSelfCheck() {
        const text = this.sys.fs.readText(this.paths.selfCheck);
        if (text === undefined || text.trim() === '')
            return undefined;
        try {
            const r = JSON.parse(text);
            return { accessibility: r.ax_trusted === true, screenRecording: r.sck?.ok === true, version: r.version };
        }
        catch {
            return undefined;
        }
    }
    recentPermissions(version) {
        const at = this.sys.fs.mtimeMs(this.paths.selfCheck);
        if (at === undefined || this.sys.now() - at > PERMISSIONS_MAX_AGE_MS)
            return null;
        const result = this.readSelfCheck();
        if (result === undefined || result.version !== version)
            return null;
        return { accessibility: result.accessibility, screenRecording: result.screenRecording };
    }
    /**
     * Whether the settings routes may talk to the daemon now: busy while this System's install task is in
     * a phase that stops, replaces or starts it (SETTINGS_BUSY_PHASES); not_running unless the installed app is one this
     * host starts (verifyInstalled, what status() reports as signature ok: a release build satisfying the designated
     * requirement, with hardened runtime) and a daemon of that app's executable runs (daemonPids, status().running). null
     * when it may. Runs no action and takes no lock; only commands status() runs too (security, plutil, codesign, ps). The
     * messages name no path.
     */
    async settingsGate() {
        const busy = () => (this.task !== undefined && SETTINGS_BUSY_PHASES.has(this.task.state.phase)
            ? { code: 'busy', message: `the install task is in its ${this.task.state.phase} phase` } : null);
        if (busy() !== null)
            return busy();
        const notRunning = { code: 'not_running', message: 'the installed cu-runtime daemon is not running' };
        if (await this.verifyInstalled() !== null) {
            return busy() ?? { code: 'not_running', message: 'what is installed is not a release build this host verified' };
        }
        if ((await this.daemonPids()).length === 0)
            return busy() ?? notRunning;
        // The task may have moved on while the app was checked.
        return busy();
    }
    // ------------------------------------------------------------------------------------------------ install task
    /** Starts the install task, or joins the running one; returns its state at once (status polls it). */
    install() {
        if (this.task !== undefined && !FINISHED.has(this.task.state.phase))
            return snapshot(this.task.state);
        const state = { id: randomUUID(), phase: 'preflight', startedAt: new Date(this.sys.now()).toISOString(),
            log: [], error: null, endedIn: null };
        const task = { state, abort: new AbortController(), cancelRequested: false, wasRunning: false,
            stopped: false, markedStop: false, replaced: false, staged: null, identity: null, identityCreated: false,
            lockToken: randomUUID(), lockLost: false, ended: Promise.resolve() };
        this.task = task;
        task.ended = this.runInstall(task);
        return snapshot(state);
    }
    /** Cancels the running task if it has not begun replacing the app; returns the task as it is then. */
    cancel() {
        const task = this.task;
        if (task === undefined || FINISHED.has(task.state.phase)) {
            return { ...failure('no_task', 'no install task is running'), task: task === undefined ? null : snapshot(task.state) };
        }
        if (!CANCELLABLE.has(task.state.phase)) {
            return { ...failure('not_cancellable', 'the installed app is being replaced: the task runs to its end'),
                task: snapshot(task.state) };
        }
        task.cancelRequested = true;
        task.abort.abort();
        this.log(task, 'cancel requested');
        return { ok: true, error: null, task: snapshot(task.state) };
    }
    /**
     * The host is going away (dsh quits; the row is reloaded, updated or removed). A task that can still be cancelled
     * is, and the promise settles once the task has ended (a task past the cancellable phases runs to its end), so that
     * a daemon it stopped runs again and a stop mark it left is cleared before the host goes. Best effort: the wait is
     * bounded (disposeWaitMs, real time), a task still running after it goes on, and a manager made again for this
     * System takes it over. Never rejects.
     */
    async dispose() {
        const task = this.task;
        if (task === undefined || FINISHED.has(task.state.phase))
            return;
        if (CANCELLABLE.has(task.state.phase) && !task.cancelRequested) {
            task.cancelRequested = true;
            task.abort.abort();
            this.log(task, 'the plugin is being unloaded: cancel requested');
        }
        let timer;
        const bound = new Promise((resolve) => {
            timer = setTimeout(resolve, this.disposeWaitMs);
            // Nothing else left to wait for (a quitting dsh): the bound does not keep the process.
            timer.unref();
        });
        try {
            await Promise.race([task.ended, bound]);
        }
        finally {
            clearTimeout(timer);
        }
    }
    log(task, line) {
        task.state.log.push(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line);
        if (task.state.log.length > LOG_LINES)
            task.state.log.splice(0, task.state.log.length - LOG_LINES);
    }
    /** The next phase, after a cancel check: logged as `== <phase>`; a lock taken over meanwhile ends the task (checkLock). */
    enter(task, phase) {
        this.checkCancel(task);
        this.setPhase(task, phase);
        this.log(task, `== ${phase}`);
        this.checkLock(task);
    }
    /**
     * Every phase change of a running task: the lock's time is refreshed, so the lock's age rule catches dead holders
     * only. A lock that is no longer this task's (another process found it stale and took it over) sets task.lockLost;
     * the caller then ends the task (checkLock; for the sign phase, which build-app.sh's output line starts, the next
     * enter() does). It never throws.
     */
    setPhase(task, phase) {
        task.state.phase = phase;
        if (!this.refreshLock(task.lockToken))
            task.lockLost = true;
    }
    /** Ends the task (busy) once a phase change found its lock taken over: two installs never go on together. */
    checkLock(task) {
        if (!task.lockLost)
            return;
        fail('busy', `another dsh process took the lock ${this.paths.lock} over while this install ran (it found the lock `
            + 'stale, e.g. after a long sleep of the Mac): this install stops here, so that two installs never go on together');
    }
    checkCancel(task) {
        if (task.cancelRequested && CANCELLABLE.has(task.state.phase))
            throw new Cancelled();
    }
    /** A command of the task: cancellable, its output into the log when `echo`. */
    async taskRun(task, file, args, options = {}) {
        const { echo, ...rest } = options;
        const onLine = echo === true ? (line) => {
            this.log(task, line);
            rest.onLine?.(line);
        } : rest.onLine;
        const r = await this.run(file, args, { ...rest, onLine, signal: task.abort.signal });
        this.checkCancel(task);
        return r;
    }
    async runInstall(task) {
        const id = task.state.id;
        const held = this.acting ? 'an action on this page is managing the daemon' : this.lock(task.lockToken);
        if (held !== null) {
            task.state.error = { code: 'busy', message: held };
            task.state.endedIn = task.state.phase;
            task.state.phase = 'failed';
            this.record({ action: 'install', task: id, outcome: 'failed', ...task.state.error });
            return;
        }
        this.record({ action: 'install', task: id, outcome: 'started' });
        let notRestarted = null;
        try {
            await this.installSteps(task);
            task.state.phase = 'done';
            this.log(task, '== done');
        }
        catch (e) {
            // The task ends (and a new one may start) only once a daemon it stopped runs again, or is given up on.
            const endedIn = task.state.phase;
            this.discardStaged(task);
            if (e instanceof Cancelled) {
                this.log(task, `cancelled in ${endedIn}`);
                if (endedIn === 'sign')
                    this.log(task, KEYCHAIN_NOTE);
                notRestarted = await this.restoreAfterStop(task);
                task.state.endedIn = endedIn;
                task.state.phase = 'cancelled';
                this.log(task, '== cancelled');
            }
            else {
                const error = e instanceof TaskFailure ? { code: e.code, message: e.message }
                    : { code: 'internal', message: String(e instanceof Error ? e.message : e) };
                if (endedIn === 'sign')
                    error.message = `${error.message}; ${KEYCHAIN_NOTE}`;
                this.log(task, `failed in ${endedIn}: ${error.code}: ${error.message}`);
                notRestarted = await this.restoreAfterStop(task);
                if (notRestarted !== null)
                    error.message = `${error.message}; ${notRestartedText(notRestarted)}`;
                task.state.error = error;
                task.state.endedIn = endedIn;
                task.state.phase = 'failed';
            }
        }
        finally {
            this.unlock(task.lockToken);
            this.record({ action: 'install', task: id, outcome: task.state.phase, code: task.state.error?.code,
                message: task.state.error?.message, identity: task.identity ?? undefined,
                identityCreated: task.identityCreated ? true : undefined, notRestarted: notRestarted ?? undefined });
        }
    }
    async installSteps(task) {
        const { fs } = this.sys;
        const p = this.paths;
        const taskRun = (file, args, options) => this.taskRun(task, file, args, options);
        // 1. preflight: before any swift, git or keychain use; then the known identity (on record, else the installed
        //    app's): one identity of the name that is not it is refused before anything is changed (the owner compares it
        //    with the backed-up certificate and accepts it on the page first). A listing that fails is no "none": nothing
        //    is created on its word.
        this.log(task, '== preflight');
        const env = await this.environment();
        this.checkCancel(task);
        if (env.sshSession)
            fail('ssh_session', 'dsh runs in an SSH session: signing needs the login keychain of the session at the Mac\'s screen');
        if (!env.gui)
            fail('no_gui_session', 'dsh does not run in the login session at the Mac\'s screen (launchctl managername is not Aqua)');
        if (!env.clt)
            fail('clt_missing', 'the Xcode Command Line Tools are not installed (xcode-select -p failed)');
        const listed = await this.listIdentities();
        this.checkCancel(task);
        if (!('identities' in listed))
            fail(listed.code, listed.message);
        let identities = listed.identities;
        const known = await this.known();
        this.checkCancel(task);
        const refuseChanged = () => {
            if (identities.length === 1 && known.sha1 !== null && identities[0] !== known.sha1) {
                const changed = identityChanged(known, identities[0], p.app);
                fail(changed.code, changed.message);
            }
        };
        refuseChanged();
        // 2. identity: the one of the name (listed above), or one the package's script creates now. What the script
        //    created is put on record as soon as its run is over, however it ended (noteCreated), a cancel included; one
        //    it does not prove it created is one that was there before, under the identity_changed rule.
        this.enter(task, 'identity');
        if (identities.length === 0) {
            this.log(task, `no code-signing identity "${IDENTITY_NAME}": creating it with scripts/make-signing-identity.sh`);
            let made;
            let claimed = null;
            const onLine = (line) => {
                this.log(task, line);
                const m = CREATED_LINE.exec(line.trimEnd());
                if (m !== null && m[1] === IDENTITY_NAME)
                    claimed = m[2].toUpperCase();
            };
            try {
                // Not taskRun: its cancel check would end the task before what the script created is on record.
                made = await this.run(BIN.zsh, ['-f', join(p.packageRoot, 'scripts/make-signing-identity.sh')], { timeoutMs: IDENTITY_TIMEOUT_MS, signal: task.abort.signal, onLine });
            }
            finally {
                const after = await this.listIdentities();
                if (!('identities' in after))
                    this.log(task, `the identities cannot be listed again: ${after.message}`);
                identities = 'identities' in after ? after.identities : [];
                this.noteCreated(task, identities, known, claimed);
            }
            this.checkCancel(task);
            if (made.code !== 0) {
                fail('identity_failed', `make-signing-identity.sh ${ending(made, IDENTITY_TIMEOUT_MS)}: ${tail(made)}`
                    + (task.identityCreated ? '; the identity it created is on record' : ''));
            }
            if (identities.length === 0)
                fail('identity_failed', `the identity "${IDENTITY_NAME}" does not show up after it was created`);
            if (!task.identityCreated)
                refuseChanged();
        }
        const ambiguous = identityRefusal(identities);
        if (ambiguous !== null)
            fail(ambiguous.code, ambiguous.message);
        const identity = identities[0];
        task.identity = identity;
        if (!task.identityCreated) {
            this.log(task, `identity ${IDENTITY_NAME} ${fingerprint(identity)}${known.sha1 !== identity
                ? ': none is on record yet; it is put on record once this install has signed with it'
                : known.source === 'record' ? ' (the one on record)'
                    : ` (the one the installed app is signed with); it is put on record once this install has signed with it`}`);
        }
        // 3. copy: the package directory is never written; ditto keeps the mtimes, so the build stays incremental. The
        //    copy's source hash is what the build's CUSourceHash must be.
        this.enter(task, 'copy');
        try {
            fs.mkdir(p.cache);
            fs.rm(p.buildSrc);
            fs.mkdir(p.buildSrc);
        }
        catch (e) {
            fail('copy_failed', `cannot prepare ${p.buildSrc}: ${String(e)}`);
        }
        for (const input of BUILD_INPUTS) {
            const from = join(p.packageRoot, input);
            if (!fs.exists(from)) {
                if (input === 'Tests')
                    continue;
                fail('copy_failed', `the package has no ${input}`);
            }
            const r = await this.taskRun(task, BIN.ditto, [from, join(p.buildSrc, input)], { timeoutMs: COPY_TIMEOUT_MS });
            if (r.code !== 0)
                fail('copy_failed', `ditto ${input}: ${tail(r)}`);
        }
        let copyHash;
        try {
            copyHash = this.sourceHashOf(p.buildSrc);
        }
        catch (e) {
            fail('copy_failed', `cannot compute the source hash of ${p.buildSrc}: ${String(e)}`);
        }
        this.log(task, `source hash ${copyHash}`);
        // 4. build, and sign inside build-app.sh (the keychain asks the person at the Mac to allow the signing) with the
        //    identity checked above, by its SHA-1; its SIGN_MARKER line starts the sign phase. What an earlier build left
        //    is removed first: only this build's app can be there afterwards.
        this.enter(task, 'build');
        try {
            fs.rm(p.buildDist);
        }
        catch (e) {
            fail('build_failed', `cannot remove the earlier build output ${p.buildDist}: ${String(e)}`);
        }
        const built = await this.taskRun(task, BIN.zsh, ['-f', join(p.buildSrc, 'scripts/build-app.sh')], {
            cwd: p.buildSrc,
            // CU_SIGN_IDENTITY: build-app.sh signs with this SHA-1 alone (one swapped in since preflight is not signed with).
            env: { ...childEnv(this.sys), CU_SCRATCH: p.buildScratch, CU_DIST: p.buildDist, CU_SIGN_IDENTITY: identity },
            timeoutMs: BUILD_TIMEOUT_MS,
            echo: true,
            onLine: (line) => { if (task.state.phase === 'build' && line.trimEnd() === SIGN_MARKER)
                this.setPhase(task, 'sign'); },
        });
        if (built.code !== 0) {
            // A cancel has ended the task already (taskRun); null here is the timeout, or a run that could not start.
            if (task.state.phase === 'sign' && (built.code === SIGN_FAILED_STATUS || built.code === null)) {
                fail('sign_failed', `build-app.sh ${ending(built, BUILD_TIMEOUT_MS)} while signing: ${tail(built)}`);
            }
            fail('build_failed', `build-app.sh ${ending(built, BUILD_TIMEOUT_MS)}: ${tail(built)}`);
        }
        // Signed (build-app.sh exits 0 only once its signing succeeded): this identity is the one on record from now on.
        if (this.knownIdentity() !== identity) {
            const unwritten = this.recordIdentity(identity);
            this.log(task, unwritten === null ? `identity ${IDENTITY_NAME} ${fingerprint(identity)} is on record now`
                : `could not put identity ${IDENTITY_NAME} ${fingerprint(identity)} on record: ${unwritten}`);
        }
        // 5. verify, before anything is stopped or replaced (build-app.sh has exited: its signing is over): the build is
        //    copied into ~/Applications under a staging name, and that copy (the one renamed into place below) is checked:
        //    a release build (a bench build serves any state dir and takes config.json's test-harness switches; it never
        //    goes into ~/Applications), the build of the sources just copied, signed by the identity.
        this.enter(task, 'verify');
        if (!fs.exists(p.builtApp))
            fail('build_failed', `build-app.sh did not produce ${p.builtApp}`);
        const staged = join(p.applications, `.CURuntime.app.new-${task.state.id}`);
        try {
            fs.mkdir(p.applications);
            fs.rm(staged);
        }
        catch (e) {
            fail('replace_failed', `cannot prepare ${staged} (the installed app is unchanged): ${String(e)}`);
        }
        task.staged = staged;
        const copied = await this.taskRun(task, BIN.ditto, [p.builtApp, staged], { timeoutMs: COPY_TIMEOUT_MS });
        if (copied.code !== 0)
            fail('replace_failed', `cannot stage the new build at ${staged} (the installed app is unchanged): `
                + `ditto: ${tail(copied)}`);
        const unfit = await this.checkApp(staged, identities, taskRun, copyHash);
        if (unfit !== null)
            fail(unfit.code, unfit.message);
        // 6. stop: the stop mark first, so no cu_* call starts the daemon while it is being replaced.
        this.enter(task, 'stop');
        task.markedStop = this.leaveStopMark();
        const pids = await this.daemonPids();
        task.wasRunning = pids.length > 0;
        if (task.wasRunning) {
            task.stopped = true;
            const stopped = await this.stopDaemon(pids);
            if (stopped !== null)
                fail(stopped.code, stopped.message);
            this.log(task, `stopped the daemon (pid ${pids.join(', ')})`);
        }
        this.checkCancel(task);
        // 7. replace: the verified staged copy is renamed into place (same volume); from here on the task is not
        //    cancellable.
        this.setPhase(task, 'replace');
        this.log(task, '== replace');
        this.checkLock(task);
        const old = join(p.applications, `.CURuntime.app.old-${task.state.id}`);
        const hadOld = fs.exists(p.app);
        try {
            if (hadOld)
                fs.rename(p.app, old);
        }
        catch (e) {
            fail('replace_failed', `cannot move ${p.app} aside (it is unchanged): ${String(e)}`);
        }
        try {
            fs.rename(staged, p.app);
        }
        catch (e) {
            if (hadOld) {
                try {
                    fs.rename(old, p.app);
                }
                catch (back) {
                    // Neither app is in place: both copies are kept, and the message (on the page, in the task log and in the
                    // action log) says where they are.
                    task.staged = null;
                    const message = `${p.app} is missing: the installed app is at ${old}, the new build at ${staged} `
                        + `(moving the new build into place: ${String(e)}; moving the installed app back: ${String(back)})`;
                    this.log(task, message);
                    fail('replace_failed', message);
                }
            }
            fail('replace_failed', `cannot move the new build into place (${hadOld ? 'the installed app is back' : 'none was installed'}): `
                + String(e));
        }
        task.staged = null;
        task.replaced = true;
        try {
            fs.rm(old);
        }
        catch (e) {
            this.log(task, `could not remove ${old}: ${String(e)}`);
        }
        this.log(task, `installed ${p.app}`);
        // 8. start: the installed app is checked again (it is what open starts).
        this.setPhase(task, 'start');
        this.log(task, '== start');
        this.checkLock(task);
        const refused = await this.verifyInstalled(identities);
        if (refused !== null)
            fail(refused.code, refused.message);
        const started = await this.startDaemon();
        if (started !== null)
            fail(started.code, started.message);
        task.stopped = false;
        this.clearStopMark();
        this.log(task, 'the daemon is running');
        // 9. selfcheck: the permissions of the new app.
        this.setPhase(task, 'selfcheck');
        this.log(task, '== selfcheck');
        this.checkLock(task);
        const checked = await this.selfCheckOnce();
        if ('code' in checked)
            fail(checked.code, checked.message);
        this.log(task, `accessibility: ${checked.accessibility ? 'granted' : 'not granted'}; `
            + `screen recording: ${checked.screenRecording ? 'granted' : 'not granted'}`);
    }
    /** Removes the staged copy of a task that ends without it in place. */
    discardStaged(task) {
        if (task.staged === null)
            return;
        try {
            this.sys.fs.rm(task.staged);
        }
        catch (e) {
            this.log(task, `could not remove ${task.staged}: ${String(e)}`);
        }
        task.staged = null;
    }
    /**
     * After a cancel or a failure: a daemon this task stopped, and whose app was not replaced, runs again if the
     * installed app may be started (verifyInstalled). Returns why it does not when it does not (a refusal: e.g.
     * not_release_build for an older build without CUBench or one without hardened runtime; or the start's failure),
     * which the task log says (notRestartedText) and the caller adds to a failure's message and the action log. Either
     * way the stop mark this task left is removed: it is autoStart's sign of a stop by the user, which this was not.
     */
    async restoreAfterStop(task) {
        let notRestarted = null;
        try {
            if (task.stopped && task.wasRunning && !task.replaced) {
                const refused = await this.verifyInstalled();
                notRestarted = refused ?? await this.startDaemon();
                if (notRestarted === null) {
                    task.stopped = false;
                    this.log(task, 'the daemon that was stopped runs again');
                }
                else {
                    this.log(task, notRestartedText(notRestarted));
                }
            }
        }
        catch (e) {
            notRestarted = { code: 'internal', message: String(e instanceof Error ? e.message : e) };
            this.log(task, `could not restore the daemon: ${notRestarted.message}`);
        }
        if (task.markedStop)
            this.clearStopMark();
        return notRestarted;
    }
    // ------------------------------------------------------------------------------------------------ actions
    start() {
        return this.action('start', async (note) => {
            // Checked first, also when a daemon already runs: then the answer says whether the running app is ours.
            const refused = await this.verifyInstalled(undefined, note);
            if (refused !== null)
                return { ok: false, error: refused };
            if ((await this.daemonPids()).length > 0)
                return OK;
            const started = await this.startDaemon();
            if (started !== null)
                return { ok: false, error: started };
            this.clearStopMark();
            return OK;
        });
    }
    /** Stops the daemon; the stop mark keeps autoStart from starting it again (until it is started from here, or by hand). */
    stop() {
        return this.action('stop', async () => {
            this.leaveStopMark();
            const stopped = await this.stopDaemon(await this.daemonPids());
            return stopped === null ? OK : { ok: false, error: stopped };
        });
    }
    /**
     * Stop, then start. The stop mark it leaves for the time between goes again also when the restart fails: the
     * daemon was not stopped by the user (a mark of the user's from before is kept then).
     */
    restart() {
        return this.action('restart', async (note) => {
            // Checked before anything is stopped: an app that may not be started is not stopped either.
            const refused = await this.verifyInstalled(undefined, note);
            if (refused !== null)
                return { ok: false, error: refused };
            const marked = this.leaveStopMark();
            const stopped = await this.stopDaemon(await this.daemonPids());
            const started = stopped ?? await this.startDaemon();
            if (started !== null) {
                if (marked)
                    this.clearStopMark();
                return { ok: false, error: started };
            }
            this.clearStopMark();
            return OK;
        });
    }
    /**
     * The app asks for both permissions (macOS shows its prompts), and System Settings opens one pane per call:
     * Accessibility, or Screen Recording once a recent self-check shows Accessibility granted. The page's flow is
     * therefore 授予权限 → (the grant, in System Settings) → 检查权限 (selfCheck) → 授予权限 again for the next pane.
     * Earlier grants are never reset here (no tccutil; scripts/install.sh resets only the ones its self-check finds not
     * in effect): a click on the page is not proof that a person is there, and a reset would revoke them.
     */
    permissions() {
        return this.action('permissions', async (note) => {
            const refused = await this.verifyInstalled(undefined, note);
            if (refused !== null)
                return { ok: false, error: refused };
            const asked = await this.run(BIN.open, ['-n', this.paths.app, '--args', 'request-permissions']);
            if (asked.code !== 0)
                return failure('start_failed', `open: ${tail(asked)}`);
            const known = this.recentPermissions(await this.plistValue(this.paths.appInfo, 'CFBundleVersion'));
            const pane = known?.accessibility === true ? SETTINGS_PANES[1] : SETTINGS_PANES[0];
            await this.run(BIN.open, [pane]);
            return OK;
        });
    }
    /** Runs a self-check of the installed app now; its result shows in status().permissions. */
    selfCheck() {
        return this.action('selfcheck', async (note) => {
            const refused = await this.verifyInstalled(undefined, note);
            if (refused !== null)
                return { ok: false, error: refused };
            const checked = await this.selfCheckOnce();
            return 'code' in checked ? { ok: false, error: checked } : OK;
        });
    }
    /** macOS's own installer for the Command Line Tools (`xcode-select --install`, nothing else). */
    async installClt() {
        const r = await this.run(BIN.xcodeSelect, ['--install']);
        const result = r.code === 0 ? OK : failure('clt_install_failed', tail(r));
        this.record({ action: 'clt', outcome: result.ok ? 'ok' : 'failed', code: result.error?.code, message: result.error?.message });
        return result;
    }
    /**
     * The owner accepts the one identity of the name now in the keychain as the identity on record, after comparing its
     * SHA-1 with the backed-up certificate (the page says how). Only when the status says identityChanged (the known
     * SHA-1, on record or the installed app's, is another): then, if the current identity is the one the last status
     * this manager served with identityChanged showed (the one the owner compared), its SHA-1 is written to paths.ts
     * knownIdentity and the action log gets { action: 'identity', outcome: 'accepted', previous, current }; if it is not
     * (it changed again since, or no such status was served), nothing is written, the answer is identity_changed and the
     * action log gets the refusal. Otherwise nothing is changed (no identity, several, none known, or the known one) and
     * the answer is ok. Under the lock like the other actions; busy while a task runs.
     */
    acceptIdentity() {
        return this.action('identity', async () => {
            const identities = await this.identities();
            const previous = (await this.known()).sha1;
            if (identities.length !== 1 || previous === null || identities[0] === previous)
                return OK;
            const current = identities[0];
            if (current !== this.shownChanged) {
                const message = `the code-signing identity "${IDENTITY_NAME}" in the keychain (SHA-1 ${fingerprint(current)}) is not `
                    + (this.shownChanged === null ? 'one the plugin page was shown'
                        : `the one the plugin page was shown (SHA-1 ${fingerprint(this.shownChanged)})`)
                    + ': the certificate changed again since it was shown; read it again and compare it with the backed-up '
                    + 'certificate before accepting it';
                this.record({ action: 'identity', outcome: 'failed', code: 'identity_changed', message, previous, current });
                return failure('identity_changed', message);
            }
            const unwritten = this.recordIdentity(current);
            if (unwritten !== null) {
                this.record({ action: 'identity', outcome: 'failed', code: 'internal', message: unwritten, previous, current });
                return failure('internal', unwritten);
            }
            this.record({ action: 'identity', outcome: 'accepted', previous, current });
            return OK;
        }, false);
    }
    /**
     * One action under the lock (its own token in the lock file). Its record carries what the body noted (the identity
     * it checked against), unless `recorded` is false: the body writes its own record then.
     */
    async action(name, body, recorded = true) {
        if (this.task !== undefined && !FINISHED.has(this.task.state.phase)) {
            return failure('busy', 'the install task is running');
        }
        const token = randomUUID();
        const held = this.acting ? 'another action on this page is managing the daemon' : this.lock(token);
        if (held !== null)
            return failure('busy', held);
        this.acting = true;
        const note = {};
        let result;
        try {
            result = await body(note);
        }
        catch (e) {
            result = failure('internal', String(e instanceof Error ? e.message : e));
        }
        finally {
            this.acting = false;
            this.unlock(token);
        }
        if (recorded) {
            this.record({ action: name, outcome: result.ok ? 'ok' : 'failed', code: result.error?.code,
                message: result.error?.message, identity: note.identity });
        }
        return result;
    }
    // ------------------------------------------------------------------------------------------------ steps
    /**
     * null when the installed app may be started or launched (verifyApp, the rules autoStart checks with too); with
     * `known`, these identities stand for the keychain's. The identity it is checked against goes into `note`.
     */
    verifyInstalled(known, note) {
        return verifyApp(this.paths.app, { exists: (p) => this.sys.fs.exists(p), run: (f, a, o) => this.run(f, a, o),
            identities: async () => known ?? await this.identities() }, note);
    }
    /** checkAppWith (the shared check's rules for a present app), for the staged copy of a build with its source hash. */
    checkApp(app, identities, run, sourceHash) {
        return checkAppWith(app, identities, run, sourceHash);
    }
    /** SIGTERM to each daemon (it restores the system state it changed before it exits), then waits for them to go. */
    async stopDaemon(pids) {
        if (pids.length === 0)
            return null;
        for (const pid of pids)
            this.sys.kill(pid, 'SIGTERM');
        for (let waited = 0; waited < STOP_WAIT_MS; waited += POLL_MS) {
            await this.sys.sleep(POLL_MS);
            if ((await this.daemonPids()).length === 0)
                return null;
        }
        return { code: 'stop_failed', message: `the daemon (pid ${pids.join(', ')}) did not exit within ${STOP_WAIT_MS / 1000} s` };
    }
    /**
     * `open -g` (the focus stays where the person is), then waits until the daemon is up: its process shows up, is
     * still there START_SETTLE_MS later, and its socket accepts a connection, all within START_WAIT_MS of polling (and
     * the commands' and connection attempts' own time). Otherwise start_failed says which of these did not happen, and
     * names the bench-only switches config.json turns on (a release build does not start with them).
     */
    async startDaemon() {
        const r = await this.run(BIN.open, ['-g', this.paths.app]);
        if (r.code !== 0)
            return { code: 'start_failed', message: `open: ${tail(r)}` };
        const failed = (what) => ({ code: 'start_failed', message: `${what}${this.benchOnlyConfig()}` });
        let waited = 0;
        let pids;
        for (;; waited += POLL_MS) {
            pids = await this.daemonPids();
            if (pids.length > 0)
                break;
            if (waited >= START_WAIT_MS)
                return failed(`no daemon of ${this.paths.app} showed up within ${START_WAIT_MS / 1000} s`);
            await this.sys.sleep(POLL_MS);
        }
        await this.sys.sleep(START_SETTLE_MS);
        waited += START_SETTLE_MS;
        for (;; waited += POLL_MS) {
            if ((await this.daemonPids()).length === 0)
                return failed(`the daemon (pid ${pids.join(', ')}) exited right after it started`);
            if (await this.sys.connects(this.paths.socket, SOCKET_PROBE_MS))
                return null;
            if (waited >= START_WAIT_MS) {
                return failed(`the daemon (pid ${pids.join(', ')}) runs, but ${this.paths.socket} accepted no connection `
                    + `within ${START_WAIT_MS / 1000} s`);
            }
            await this.sys.sleep(POLL_MS);
        }
    }
    /** For a failed start: '; <config.json> turns on <switches> …' when it turns on bench-only switches, else ''. */
    benchOnlyConfig() {
        let config;
        try {
            config = JSON.parse(this.sys.fs.readText(this.paths.config) ?? 'null');
        }
        catch {
            return '';
        }
        if (typeof config !== 'object' || config === null)
            return '';
        const on = BENCH_ONLY_CONFIG_KEYS.filter((key) => config[key] === true);
        if (on.length === 0)
            return '';
        return `; ${this.paths.config} turns on ${on.join(', ')}, which only a bench build starts with (this release build `
            + `refuses to): remove ${on.length === 1 ? 'it' : 'them'} from the file`;
    }
    /** `open -n <app> --args self-check --out <file>`, then the file is waited for (never `open -W`). */
    async selfCheckOnce() {
        const { fs } = this.sys;
        try {
            fs.mkdir(this.paths.cache);
            fs.rm(this.paths.selfCheck);
        }
        catch (e) {
            return { code: 'selfcheck_failed', message: String(e) };
        }
        const r = await this.run(BIN.open, ['-n', this.paths.app, '--args', 'self-check', '--out', this.paths.selfCheck]);
        if (r.code !== 0)
            return { code: 'selfcheck_failed', message: `open: ${tail(r)}` };
        for (let waited = 0; waited <= SELF_CHECK_WAIT_MS; waited += POLL_MS) {
            const result = this.readSelfCheck();
            if (result !== undefined)
                return { accessibility: result.accessibility, screenRecording: result.screenRecording };
            await this.sys.sleep(POLL_MS);
        }
        return { code: 'selfcheck_timeout', message: `no self-check result within ${SELF_CHECK_WAIT_MS / 1000} s` };
    }
    /**
     * Leaves autoStart's stop mark of this boot unless there is one; true when this call left it (the caller clears it
     * again). A mark from an earlier boot, or one that cannot be read, is none to autoStart, and is replaced.
     */
    leaveStopMark() {
        const { fs } = this.sys;
        if (!fs.exists(this.paths.stateDir))
            return false;
        if (stopMarkOfThisBoot(fs.readText(this.paths.stopMark), this.bootTime()))
            return false;
        try {
            fs.writeText(this.paths.stopMark, stopMarkText(this.bootTime(), this.sys.now()));
            return true;
        }
        catch {
            return false;
        }
    }
    clearStopMark() {
        try {
            this.sys.fs.rm(this.paths.stopMark);
        }
        catch { /* nothing to clear */ }
    }
    // ------------------------------------------------------------------------------------------------ plumbing
    /** hostRun: the fixed minimal environment (childEnv), QUICK_TIMEOUT_MS unless the options say otherwise. */
    run(file, args, options = {}) {
        return hostRun(this.sys)(file, args, options);
    }
    /**
     * Takes the cross-process lock for this holder's token: null when taken, else why it is not (for busy). The lock
     * file holds the holder's pid, its token, when it took the lock (since) and its time (at), which a running task
     * refreshes at each phase change (refreshLock). A lock is held (readLock) while its process is alive and this
     * process may signal it (a pid of another user's process, launchd's among them, holds nothing), and its time is at
     * most LOCK_SKEW_MS ahead of the clock, younger than LOCK_STALE_MS, and not from before this boot (more than
     * SAME_BOOT_S before its start: pids start over at a restart, so a live process with that pid now is not the
     * holder). Any other lock, and one that cannot be read, is stale and taken over, atomically: the file is renamed
     * to a name of its own (rename(2) moves one file, whichever is there then), and only when the file moved is the
     * text found stale is it removed. Otherwise another process took the lock over meanwhile: its lock is put back
     * (unless a lock is there again) and the answer is busy. A holder whose lock still went (a third process took the
     * place meanwhile) finds it at its next phase change and stops (checkLock).
     */
    lock(token) {
        const { fs } = this.sys;
        const path = this.paths.lock;
        try {
            fs.mkdir(this.paths.cache);
            const now = this.sys.now();
            const mine = `${JSON.stringify({ pid: this.sys.pid, at: now, since: now, token })}\n`;
            for (let attempt = 0; attempt < 2; attempt++) {
                if (fs.createExclusive(path, mine))
                    return null;
                const { text, holder } = this.readLock();
                if (holder !== null)
                    return this.busyMessage(holder);
                const aside = `${path}.${randomUUID()}.stale`;
                try {
                    fs.rename(path, aside);
                }
                catch {
                    continue; // gone meanwhile (its holder released it, or another process moved it): try again
                }
                const moved = fs.readText(aside);
                if (moved !== text) {
                    if (moved !== undefined)
                        fs.createExclusive(path, moved);
                    fs.rm(aside);
                    const { holder: taker } = this.readLock();
                    return taker !== null ? this.busyMessage(taker) : `${path} was taken over by another process while it was found stale`;
                }
                fs.rm(aside);
            }
            return `${path} was taken again by another process right after it was cleared`;
        }
        catch (e) {
            return `cannot take the lock ${path}: ${String(e)}`;
        }
    }
    /**
     * The lock file's text (undefined: none, or unreadable) and its live holder under lock()'s rules (null: none, or a
     * stale lock). Reads only.
     */
    readLock() {
        const text = this.sys.fs.readText(this.paths.lock);
        const { pid, at, since, token } = parseLock(text) ?? {};
        const now = this.sys.now();
        const bootStart = (this.bootTime() - SAME_BOOT_S) * 1000;
        if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || typeof at !== 'number' || !Number.isFinite(at)
            || at > now + LOCK_SKEW_MS || now - at >= LOCK_STALE_MS || at < bootStart || !this.sys.alive(pid)) {
            return { text, holder: null };
        }
        return { text, holder: { pid, since: typeof since === 'number' && Number.isFinite(since) && since <= at ? since : at,
                token: typeof token === 'string' ? token : undefined } };
    }
    /** busy's message for the lock's live holder: who, since when, and when the lock is taken over. */
    busyMessage(holder) {
        const since = new Date(holder.since).toISOString();
        if (holder.pid === this.sys.pid) {
            return `this dsh process (pid ${holder.pid}: another row of this plugin, or an earlier load of it, e.g. before a `
                + `package update) has been managing the daemon since ${since} and is still finishing: try again once it has `
                + `ended (its outcome goes to ${this.paths.actionLog})`;
        }
        return `another dsh process (pid ${holder.pid}) has been managing the daemon since ${since}: it holds `
            + `${this.paths.lock}, which is taken over once that process is gone, ${LOCK_STALE_MS / 3_600_000} h after its `
            + 'last sign of life, or after a restart of the Mac';
    }
    /**
     * A running task's sign of life (at each phase change): the lock's time becomes now, while the lock is still this
     * token's. The file is replaced whole (written beside it, renamed into place): no reader finds it partly written.
     * False when the lock is not this token's any more (none there, or another holder's: taken over); true otherwise,
     * also when the new time could not be written.
     */
    refreshLock(token) {
        const { fs } = this.sys;
        const path = this.paths.lock;
        const partial = `${path}.${token}.tmp`;
        let held;
        try {
            held = parseLock(fs.readText(path));
        }
        catch {
            return true;
        }
        if (held === null || held.token !== token)
            return false;
        try {
            fs.writeText(partial, `${JSON.stringify({ ...held, at: this.sys.now() })}\n`);
            fs.rename(partial, path);
        }
        catch {
            try {
                fs.rm(partial);
            }
            catch { /* nothing to remove */ }
        }
        return true;
    }
    /** Removes the lock only while it is still this token's: one taken over meanwhile (by another holder) stays. */
    unlock(token) {
        try {
            if (parseLock(this.sys.fs.readText(this.paths.lock))?.token === token)
                this.sys.fs.rm(this.paths.lock);
        }
        catch { /* already gone */ }
    }
    /**
     * One JSON line: when, which process, the action, its task, its outcome, for a failure its code and message, and the
     * identity it signed with or checked against (identityCreated: the install created it).
     */
    record(entry) {
        try {
            this.sys.fs.mkdir(this.paths.cache);
            this.sys.fs.appendText(this.paths.actionLog, `${JSON.stringify({ at: new Date(this.sys.now()).toISOString(), pid: this.sys.pid, ...entry })}\n`);
        }
        catch { /* the log is a record, not a precondition */ }
    }
}
