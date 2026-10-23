/**
 * The installable bundle's top-level row, the package itself (`cu-runtime`, cordis.patch.yml at the repository root).
 * It registers no tools (the cu_* tools are the `cu-runtime/tools` row, inside the 电脑操作 preset only). It does two
 * things:
 * - dsh 0.1.5 checks no version metadata at install or start, has no agent presets and no profile context: there this
 *   row fails the start with the supported range and the commit that still runs on 0.1.5, instead of the
 *   missing-package error the preset row would give.
 * - With dsh's `connection` (the web and Electron hosts; headless has none, and then nothing is registered), it serves
 *   the plugin page's routes (daemon/routes.ts): the daemon's status, its build and install, start, stop, the
 *   permission prompts, and the daemon's settings (daemon/settings.ts: snapshot, one change at a time, the cancel of
 *   an owner check, the daemon's panels), and the mode check (daemon/mode-check.ts). dsh mounts the package's page
 *   only on a top-level row named exactly as the package.
 * - Once, STARTUP_DELAY_MS after the row loads (headless too), it runs the mode check and logs one warning per
 *   failing line and per skipped profile's reason; that run never throws and never holds up loading, and the page's
 *   first read finds its result.
 *
 * Its top-level imports are node built-ins and this package's own modules only: an import that fails takes the plugin
 * page with it, while an error thrown in apply leaves the page there.
 *
 * @module cu-runtime-plugin/host
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentBootTime } from "./autostart.js";
import { CURuntimeClient } from "./client.js";
import { DaemonManager } from "./daemon/manager.js";
import { ModeCheckCache, runModeCheck, STARTUP_DELAY_MS } from "./daemon/mode-check.js";
import { daemonPaths } from "./daemon/paths.js";
import { registerRoutes } from "./daemon/routes.js";
import { DaemonSettings } from "./daemon/settings.js";
import { nodeSystem } from "./daemon/system.js";
export const name = 'cu-runtime-host';
/** The message dsh 0.1.5 stops with. */
export const UNSUPPORTED_DSH = 'cu-runtime needs dsh 0.2.x (>=0.2.0-rc.2 <0.3.0): this dsh starts profiles without a '
    + 'profile context, as 0.1.5 does. On dsh 0.1.5 use cu-runtime at commit 9c6f36d; or update dsh.';
/** The package root: this file is plugin/lib/host.js. */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
/** The settings routes' default client: connects only (no autoStart), to the state dir it is given. */
const defaultSettingsClient = ({ stateDir, timeoutMs }) => new CURuntimeClient({ stateDir, timeoutMs });
/**
 * The real system, made once per module instance (so once per dsh process, until the package is updated): every
 * manager made for it shares its install task, so a row reloaded while a task runs finds that task again
 * (daemon/manager.ts). A package update loads this module anew; its managers see the earlier instance's task only
 * through the lock, as status().busy.
 */
let realSystem;
/** The plugin's apply with these options (the row's config, which dsh passes as apply's second argument, is unused). */
export function applyWith(options = {}) {
    return (ctx) => {
        // dsh 0.2.x provides profileContext to every profile it starts (dsh-app-boot); 0.1.5 has no such service.
        if (ctx.get('profileContext') === undefined)
            throw new Error(UNSUPPORTED_DSH);
        // One manager per row: its install task outlives a change of the connection service. When the row goes, a task
        // that can still be cancelled is, and the row's disposal waits (bounded) for the task to end, so that a daemon it
        // stopped runs again first; a task still running then is taken over by the next manager made for the same System
        // (the row reloaded); after a package update the new module's managers report it as status().busy.
        let manager;
        ctx.effect(() => () => manager?.dispose(), 'cu-runtime: end the install task, restoring a daemon it stopped');
        const systemOf = () => options.system ?? (realSystem ??= (options.makeSystem ?? nodeSystem)());
        // One cache per row, made when first needed (the routes, or the run after loading): the routes of a connection
        // that comes again share it.
        let modeCheck;
        const modeCheckOf = () => {
            const system = systemOf();
            return modeCheck ??= new ModeCheckCache(() => runModeCheck(system, options.modeCheck), () => system.now());
        };
        const delay = options.modeCheck?.startupDelayMs === undefined ? STARTUP_DELAY_MS : options.modeCheck.startupDelayMs;
        if (delay !== null) {
            ctx.effect(() => {
                const timer = setTimeout(() => void startupCheck(), delay);
                timer.unref?.();
                return () => clearTimeout(timer);
            }, 'cu-runtime: the mode check after loading');
        }
        /**
         * The run after loading: each line of a failing profile, and each reason of a skipped one (`not checked: …`), is one
         * warning, `cu-runtime: mode check: profile <p>: <line>` (`cu-runtime: mode check: <line>` for the entry of a home
         * with no profile); ok profiles log nothing. Nothing it meets is thrown.
         */
        const startupCheck = async () => {
            const warn = (text) => {
                try {
                    ctx.logger.warn(text);
                }
                catch { /* a context without a logger */ }
            };
            try {
                const result = await modeCheckOf().get();
                for (const p of result.profiles) {
                    if (p.status === 'ok')
                        continue;
                    const prefix = p.profile === '' ? 'cu-runtime: mode check:' : `cu-runtime: mode check: profile ${p.profile}:`;
                    for (const line of p.lines)
                        warn(`${prefix} ${line}`);
                }
            }
            catch (e) {
                warn(`cu-runtime: the mode check could not run: ${String(e instanceof Error ? e.message : e)}`);
            }
        };
        // connection is optional: requested here rather than in `inject`, so that the check above runs without it.
        ctx.inject(['connection'], (scope) => {
            const system = systemOf();
            const paths = daemonPaths(system.home, PACKAGE_ROOT);
            manager ??= new DaemonManager({
                system,
                paths,
                packageSourceHash: options.packageSourceHash,
                sourceHash: options.sourceHash,
                bootTime: options.bootTime ?? currentBootTime,
            });
            // The fixed state dir (paths.ts): the daemon this host installs and starts serves its socket there.
            const settings = new DaemonSettings({ stateDir: paths.stateDir, client: options.settingsClient ?? defaultSettingsClient });
            registerRoutes(scope.connection, manager, settings, modeCheckOf());
        });
    };
}
export const apply = applyWith();
