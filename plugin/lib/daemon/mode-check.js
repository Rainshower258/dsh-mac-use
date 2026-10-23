/**
 * The plugin's mode self-check (stage 4b, G1): every profile of the running dsh's home is checked through its composed
 * config (`dsh --profile <p> --dump-config`), by the rules the retired scripts/check-dsh-profiles.sh applied to the
 * everyday home: the cu_* tools only in the bundle's own mode (preset-cu-runtime), with onlyCuTools on,
 * approval by dialog and exclusive not off; no other computer-use plugin anywhere. The runtime layer of the same rule
 * (the tools' exclusive refusal, onlyCuTools) is the tools plugin's and is not changed here.
 *
 * The rules are pure functions over the dump's text (checkDump, bundleProblems) and over an Electron-managed profile's
 * files (checkElectronFiles); runModeCheck lists the profiles and runs the dumps through the host's System;
 * ModeCheckCache keeps the last result for CACHE_MS and lets concurrent requests share one run.
 *
 * Which dsh: the one running this process (process.execPath with its entry script, when that is dsh's bin), else `dsh`
 * on the PATH of this process; never a path from the page or a config value. Without either, every profile is
 * `skipped`.
 *
 * A result is ok only when at least one profile was found and every one is ok: a home with no profile (or whose
 * profiles directory cannot be listed) gives one `skipped` entry, since the host row itself runs in a profile of the
 * running home and finding none means the check looked in the wrong place.
 *
 * A result names profiles, never their absolute paths; its lines carry no environment and no token, and are clipped
 * (MAX_LINES per profile, MAX_LINE_CHARS each).
 *
 * @module
 */
import { readdirSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
/** How long a result is served before a request runs the check again. */
export const CACHE_MS = 60_000;
/** How long one `dsh --dump-config` may take. */
export const DUMP_TIMEOUT_MS = 30_000;
/**
 * How much of a dump's output (each of stdout and stderr) is read: far above any realistic composed config. A dump
 * whose output reaches it may have been cut, and is skipped (SKIP_TOO_LARGE) rather than checked on a part of it.
 */
export const DUMP_MAX_CHARS = 8 * 1024 * 1024;
/** When the host row runs the check once after it loads (its failing and skipped lines go to the log). */
export const STARTUP_DELAY_MS = 10_000;
/** At most this many lines per profile, each at most MAX_LINE_CHARS characters. */
export const MAX_LINES = 20;
export const MAX_LINE_CHARS = 300;
/** The bundle's mode: its preset row, a top-level row of the composed config. */
const MODE_ID = '- id: preset-cu-runtime';
const HOST_ID = '- id: cu-runtime-host';
/** A row loading the cu_* tools, one line of a composed config: its name (the package's ./tools), or the built file. */
const TOOLS_ROW = /^ *name: ["']?cu-runtime\/tools["']?$|plugin\/lib\/index\.js/;
/** A row naming the package root: the host service now, the tools plugin in the bundle from before the plugin page. */
const ROOT_ROW = /^ *name: ["']?cu-runtime["']?$/;
/** A top-level row loading a computer-use plugin by id, or any row naming another computer-use package. */
const CU_ROWS = /^- id: (cu-runtime|computer-use)$|cu-runtime-plugin|dsh-computer-use/i;
/** Any trace of the bundle: then its mode is checked (bundleProblems). */
const BUNDLE_MARK = /^# == cu-runtime$|^- id: (preset-cu-runtime|cu-runtime-host)$|^ +name: '?cu-runtime(\/host|\/tools)?'?$/;
/** What dsh prints for a profile of its Electron app, whose composed config the command line cannot dump. */
export const ELECTRON_MANAGED = 'managed exclusively by the Electron application';
export const OK_BUNDLE = 'the cu-runtime bundle, cu_* tools in its own mode only (onlyCuTools, dialog, exclusive)';
export const OK_NONE = 'no computer-use plugin';
export const OK_ELECTRON_BUNDLE = 'the cu-runtime bundle only (Electron-managed: its files checked; its composed config '
    + 'cannot be dumped here)';
export const OK_ELECTRON_NONE = 'no computer-use plugin (Electron-managed: its files checked)';
export const FAIL_ELECTRON = 'loads a computer-use plugin (Electron-managed: its files)';
export const FAIL_CU_ROWS = 'loads a computer-use plugin';
export const SKIP_NO_DSH = 'not checked: no dsh found (this process\'s entry script is not dsh\'s bin, and no dsh is on its PATH)';
export const SKIP_TOO_LARGE = 'not checked: dump-config output too large to check';
export const SKIP_NO_PROFILES = 'not checked: no profiles under the dsh home';
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** awk's default fields of a line: split on blanks, leading ones ignored. */
const fields = (line) => line.trim().split(/[ \t]+/);
/**
 * Whether these lines have one that is exactly `id` with, on the line right after it, a name that is exactly `name`,
 * quoted or not (the script's row_named; the line after a matching id is not itself looked at as an id).
 */
export function rowNamed(lines, id, name) {
    // nosemgrep: detect-non-literal-regexp -- name is one of this module's constant package names, escaped
    const re = new RegExp(`^ *name: ["']?(${escapeRegExp(name)})["']?$`);
    for (let i = 0; i < lines.length; i++) {
        if (lines[i] !== id)
            continue;
        if (i + 1 < lines.length && re.test(lines[i + 1]))
            return true;
        i++;
    }
    return false;
}
/** The bundle's mode: from its preset row's id line up to the next top-level row. */
function modeRow(lines) {
    const row = [];
    let inside = false;
    for (const line of lines) {
        if (line === MODE_ID) {
            inside = true;
            row.push(line);
        }
        else if (inside && /^- id:/.test(line)) {
            break;
        }
        else if (inside) {
            row.push(line);
        }
    }
    return row;
}
const count = (lines, re) => lines.filter((l) => re.test(l)).length;
/**
 * The rows outside the bundle's mode that load the cu_* tools, next to the bundle from before the plugin page: by
 * TOOLS_ROW, or named as the package root (the tools plugin in that layout) except on the line right after the host
 * row's id. Each is named by its id, a nested one with its top-level row, in order, once.
 */
function outdatedExtraRows(lines) {
    const names = [];
    let top = '';
    let mode = false;
    let id = '';
    let prev = '';
    for (const line of lines) {
        if (/^ *- id: /.test(line)) {
            const third = fields(line)[2] ?? '';
            if (/^- id: /.test(line)) {
                top = third;
                mode = line === MODE_ID;
            }
            id = third;
            prev = line;
            continue;
        }
        if (!mode && (TOOLS_ROW.test(line) || (ROOT_ROW.test(line) && prev !== HOST_ID))) {
            const name = id === '' ? '(a line before any row)' : id === top ? id : `${id} (in ${top})`;
            if (!names.includes(name))
                names.push(name);
        }
        prev = line;
    }
    return names;
}
/**
 * What is wrong with the bundle's mode in a composed config (the script's bundle_problems); empty when it is as
 * shipped.
 * @param dump - the composed config.
 * @param profile - the profile's name, for the update command of an outdated bundle.
 * @param dsh - how the update command calls dsh in this home: `dsh` in ~/.dsh, else `DSH_HOME=<home> dsh`.
 */
export function bundleProblems(dump, profile, dsh) {
    const lines = dump.split('\n');
    const row = modeRow(lines);
    if (row.length === 0)
        return ['the cu-runtime bundle\'s mode (preset-cu-runtime) is missing'];
    const out = [];
    const ids = row.filter((l) => /^ {6}- id: [A-Za-z0-9_-]+$/.test(l)).map((l) => fields(l)[2]).sort();
    if (ids.join(' ') !== 'cu-runtime persona')
        out.push(`its mode holds other rows than persona and cu-runtime: ${ids.join(' ')}`.trimEnd());
    if (rowNamed(lines, HOST_ID, 'cu-runtime/host') || rowNamed(row, '      - id: cu-runtime', 'cu-runtime')) {
        // The bundle from before the plugin page: its host row loaded the package's ./host and its tools row the package
        // root, which then was the tools plugin. The current layout's checks are untrue of it, so it gets this line
        // instead (and the one after it when other rows load the tools); the profile still fails.
        out.push('the installed cu-runtime bundle is outdated (from before the plugin page: host row cu-runtime/host, tools '
            + `row cu-runtime); update it by removing it and adding this version again: '${dsh} plugin --profile ${profile} `
            + 'remove cu-runtime\', then add this version\'s package on dsh\'s plugin page');
        const extra = outdatedExtraRows(lines);
        if (extra.length > 0) {
            out.push(`rows outside its mode load the cu_* tools too: ${extra.join(', ')}; they are not part of the bundle, `
                + 'so removing it leaves them: remove them from the profile as well');
        }
    }
    else {
        // The tools row loads the package's ./tools (the package root is the host service, which registers no tools).
        if (!rowNamed(row, '      - id: cu-runtime', 'cu-runtime/tools'))
            out.push('its cu-runtime row does not load cu-runtime/tools');
        // And no other row anywhere does: at the top level it gives every mode the cu_* tools, inside another preset that
        // mode's agents (without onlyCuTools and the dialog).
        const tools = count(lines, TOOLS_ROW);
        const mine = count(row, TOOLS_ROW);
        if (tools !== 1 || mine !== 1) {
            out.push(`${tools} rows load the cu_* tools, ${mine} of them inside preset-cu-runtime: exactly one, inside it, is allowed`);
        }
        // The host row: the package root, at the top level (where dsh mounts the plugin page).
        if (!rowNamed(lines, HOST_ID, 'cu-runtime')) {
            out.push('the host row cu-runtime-host is missing or does not load the package root (cu-runtime)');
        }
    }
    if (!row.some((l) => /^ +onlyCuTools: true$/.test(l)))
        out.push('onlyCuTools is not on in its mode');
    if (!row.some((l) => /^ +appApproval: dialog$/.test(l)))
        out.push('appApproval is not dialog in its mode');
    if (row.some((l) => /^ +exclusive: false$/.test(l)))
        out.push('exclusive is switched off in its mode');
    return out;
}
/**
 * The verdict on one profile's composed config (the script's loop for a profile of the everyday home): another
 * computer-use plugin fails; with the bundle, every bundleProblems line fails; without it, any row loading the cu_*
 * tools fails.
 */
export function checkDump(dump, profile, dsh) {
    const lines = dump.split('\n');
    if (count(lines, CU_ROWS) > 0)
        return { status: 'fail', lines: [FAIL_CU_ROWS] };
    if (lines.some((l) => BUNDLE_MARK.test(l))) {
        const problems = bundleProblems(dump, profile, dsh).map((l) => l.trim()).filter((l) => l !== '');
        return problems.length > 0 ? { status: 'fail', lines: problems } : { status: 'ok', lines: [OK_BUNDLE] };
    }
    const tools = count(lines, TOOLS_ROW);
    if (tools > 0)
        return { status: 'fail', lines: [`${tools} rows load the cu_* tools, without the bundle's mode`] };
    return { status: 'ok', lines: [OK_NONE] };
}
/** The bundle's own entries in package.json: its dependency, its place in dsh.profile.bundles. */
const BUNDLE_DEPENDENCY = /^ *"cu-runtime"(: "[^"]*")?,?$/;
const CU_MENTION = /cu-runtime|computer-use|computer_use|plugin\/lib\/index\.js/i;
/**
 * The verdict on a profile of dsh's Electron app, from its files (its composed config cannot be dumped from the
 * command line): the bundle's own entries (its dependency, its place in dsh.profile.bundles, node_modules/cu-runtime)
 * are allowed; any other mention, in the profile's config layers above all, fails.
 */
export function checkElectronFiles(files) {
    const seen = [
        ...files.configs.flatMap((text) => (text === undefined ? [] : text.split('\n'))),
        ...(files.packageJson === undefined ? [] : files.packageJson.split('\n').filter((l) => !BUNDLE_DEPENDENCY.test(l))),
        ...files.modules.filter((name) => name !== 'cu-runtime'),
    ];
    if (seen.some((l) => CU_MENTION.test(l)))
        return { status: 'fail', lines: [FAIL_ELECTRON] };
    return { status: 'ok', lines: [files.bundleInstalled ? OK_ELECTRON_BUNDLE : OK_ELECTRON_NONE] };
}
/** Whether a path is dsh's bin: the `dsh` command, or the package's lib/bin.js. */
export const isDshBin = (path) => basename(path) === 'dsh' || /(^|\/)@deepseek-ai\/dsh\/lib\/bin\.js$/.test(path);
/**
 * The dsh that runs this process: `execPath` with its entry script when that is dsh's bin (and is there); else the
 * first `dsh` in the PATH's absolute directories; else null.
 */
export function findDsh(o) {
    if (o.argv1 !== undefined && isAbsolute(o.argv1) && isDshBin(o.argv1) && o.exists(o.argv1)) {
        return { file: o.execPath, args: [o.argv1] };
    }
    for (const dir of (o.env.PATH ?? '').split(':')) {
        if (!isAbsolute(dir))
            continue;
        const file = join(dir, 'dsh');
        if (o.exists(file))
            return { file, args: [] };
    }
    return null;
}
/**
 * The running dsh's home: DSH_HOME of this process (~ expanded), default ~/.dsh; a DSH_HOME that is empty or only
 * whitespace counts as unset, as dsh itself treats it.
 */
export function dshHome(system) {
    const set = system.env.DSH_HOME;
    if (set === undefined || set.trim() === '')
        return join(system.home, '.dsh');
    if (set === '~')
        return system.home;
    if (set.startsWith('~/'))
        return join(system.home, set.slice(2));
    return resolve(set);
}
/** How the update command calls dsh in this home: plain `dsh` in ~/.dsh, else with DSH_HOME (the user's home as ~). */
export function dshPrefix(home, userHome) {
    if (home === join(userHome, '.dsh'))
        return 'dsh';
    const shown = home.startsWith(`${userHome}/`) ? `~/${home.slice(userHome.length + 1)}` : home;
    return `DSH_HOME=${shown} dsh`;
}
/** A directory's entries (not following a symbolic link), or undefined when it cannot be read. */
export function nodeListDir(path) {
    try {
        return readdirSync(path, { withFileTypes: true }).map((d) => ({ name: d.name, directory: d.isDirectory() }));
    }
    catch {
        return undefined;
    }
}
const clipLine = (line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line);
const clipped = (profile, status, lines) => ({ profile, status, lines: lines.slice(0, MAX_LINES).map(clipLine) });
/**
 * Checks every profile of the running dsh's home: the directories under <home>/profiles but node_modules (and hidden
 * ones), in name order, one `dsh --profile <p> --dump-config` at a time (cwd /tmp, stdin closed, DUMP_TIMEOUT_MS, the
 * environment of this process with DSH_HOME set to the home, DUMP_MAX_CHARS of its output). Never rejects for one
 * profile: a profile whose check throws is skipped with the reason, and so is one whose dump reached DUMP_MAX_CHARS.
 * No profile found (or the profiles directory cannot be listed): one skipped entry, profile '', SKIP_NO_PROFILES.
 */
export async function runModeCheck(system, options = {}) {
    const home = dshHome(system);
    const listDir = options.listDir ?? nodeListDir;
    const names = (listDir(join(home, 'profiles')) ?? [])
        .filter((e) => e.directory && e.name !== 'node_modules' && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
    const dsh = names.length === 0 ? null : findDsh({ execPath: options.execPath ?? process.execPath,
        argv1: 'argv1' in options ? options.argv1 : process.argv[1], env: system.env, exists: (p) => system.fs.exists(p) });
    const env = {};
    for (const [k, v] of Object.entries(system.env))
        if (v !== undefined)
            env[k] = v;
    env.DSH_HOME = home;
    const prefix = dshPrefix(home, system.home);
    const profiles = [];
    for (const profile of names) {
        if (dsh === null) {
            profiles.push(clipped(profile, 'skipped', [SKIP_NO_DSH]));
            continue;
        }
        try {
            const r = await system.run(dsh.file, [...dsh.args, '--profile', profile, '--dump-config'], { cwd: '/tmp', env, timeoutMs: DUMP_TIMEOUT_MS, outputLimit: DUMP_MAX_CHARS });
            if (r.stdout.length >= DUMP_MAX_CHARS || r.stderr.length >= DUMP_MAX_CHARS) {
                profiles.push(clipped(profile, 'skipped', [SKIP_TOO_LARGE]));
                continue;
            }
            const output = r.stderr === '' ? r.stdout : `${r.stdout}\n${r.stderr}`;
            let verdict;
            if (r.code === 0) {
                verdict = checkDump(output, profile, prefix);
            }
            else if (output.includes(ELECTRON_MANAGED)) {
                const dir = join(home, 'profiles', profile);
                const modulesDir = join(dir, 'node_modules');
                const top = (listDir(modulesDir) ?? []).filter((e) => !e.name.startsWith('.'));
                const scoped = top.filter((e) => e.directory && e.name.startsWith('@'))
                    .flatMap((e) => (listDir(join(modulesDir, e.name)) ?? []).filter((s) => !s.name.startsWith('.')));
                verdict = checkElectronFiles({
                    configs: [system.fs.readText(join(dir, 'cordis.yml')), system.fs.readText(join(dir, 'cordis.patch.yml'))],
                    packageJson: system.fs.readText(join(dir, 'package.json')),
                    modules: [...top, ...scoped].map((e) => e.name),
                    bundleInstalled: system.fs.exists(join(modulesDir, 'cu-runtime')),
                });
            }
            else {
                const why = r.timedOut === true ? `timed out after ${DUMP_TIMEOUT_MS / 1000} s`
                    : r.code === null ? 'could not be run' : `exit code ${r.code}`;
                verdict = { status: 'fail', lines: [`dump-config failed (${why})`] };
            }
            profiles.push(clipped(profile, verdict.status, verdict.lines));
        }
        catch (e) {
            profiles.push(clipped(profile, 'skipped', [`not checked: ${String(e instanceof Error ? e.message : e)}`]));
        }
    }
    if (names.length === 0)
        profiles.push(clipped('', 'skipped', [SKIP_NO_PROFILES]));
    return {
        checked_at: new Date(system.now()).toISOString(),
        ok: profiles.every((p) => p.status === 'ok'),
        profiles,
    };
}
/**
 * The host's last result: served for CACHE_MS after its run ended; one run in flight at a time, which every request
 * meanwhile shares.
 */
export class ModeCheckCache {
    #last;
    #running;
    #run;
    #now;
    constructor(run, now) {
        this.#run = run;
        this.#now = now;
    }
    /** The last result while it is younger than CACHE_MS; else the run in flight, or a new one. */
    get() {
        const last = this.#last;
        if (last !== undefined && this.#now() - last.at < CACHE_MS)
            return Promise.resolve(last.result);
        return this.refresh();
    }
    /** A fresh run: the one in flight, or a new one. */
    refresh() {
        this.#running ??= this.#run().then((result) => {
            this.#last = { result, at: this.#now() };
            return result;
        }).finally(() => {
            this.#running = undefined;
        });
        return this.#running;
    }
}
