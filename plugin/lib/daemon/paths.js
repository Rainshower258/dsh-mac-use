/**
 * Every path, name and executable the host service uses. All are constants (the home directory and the package
 * directory, which host.ts derives from its own location, are the only inputs): no route takes a parameter, so nothing
 * a request carries can point the service at another file, app, identity or program.
 *
 * @module
 */
import { join } from 'node:path';
import { STOP_MARK } from "../autostart.js";
/** The daemon app's bundle id (scripts/build-app.sh). */
export const BUNDLE_ID = 'dev.cu-runtime.daemon';
/** The code-signing identity scripts/make-signing-identity.sh creates and build-app.sh signs with. */
export const IDENTITY_NAME = 'cu-runtime-signing';
/** What the package ships for the build (package.json files), copied in this order; Tests/ is optional. */
export const BUILD_INPUTS = ['Package.swift', 'Sources', 'Tests', 'scripts'];
export const BIN = {
    codesign: '/usr/bin/codesign',
    ditto: '/usr/bin/ditto',
    launchctl: '/bin/launchctl',
    open: '/usr/bin/open',
    openssl: '/usr/bin/openssl',
    plutil: '/usr/bin/plutil',
    ps: '/bin/ps',
    security: '/usr/bin/security',
    xcodeSelect: '/usr/bin/xcode-select',
    zsh: '/bin/zsh',
};
/** The two System Settings panes the permissions route opens, one per call. */
export const SETTINGS_PANES = [
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
];
export function daemonPaths(home, packageRoot) {
    const applications = join(home, 'Applications');
    const app = join(applications, 'CURuntime.app');
    const cache = join(home, 'Library/Caches/cu-runtime');
    const build = join(cache, 'build');
    const stateDir = join(home, 'Library/Application Support/cu-runtime');
    return {
        packageRoot,
        app,
        appBinary: join(app, 'Contents/MacOS/cu-runtime'),
        appInfo: join(app, 'Contents/Info.plist'),
        applications,
        cache,
        buildSrc: join(build, 'src'),
        buildScratch: join(build, '.build'),
        buildDist: join(build, 'dist'),
        builtApp: join(build, 'dist/CURuntime.app'),
        selfCheck: join(cache, 'self-check.json'),
        lock: join(cache, 'host.lock'),
        actionLog: join(cache, 'host-actions.log'),
        knownIdentity: join(cache, 'known-identity'),
        stateDir,
        stopMark: join(stateDir, STOP_MARK),
        socket: join(stateDir, 'daemon.sock'),
        config: join(stateDir, 'config.json'),
    };
}
/**
 * The config.json switches a release build does not start with (LaunchPolicy.benchOnlyConfigKeys, as the file spells
 * them): named in start_failed when a daemon exits right after it started.
 */
export const BENCH_ONLY_CONFIG_KEYS = ['config_grants', 'debug_activation', 'debug_ime', 'debug_native_images'];
/**
 * The requirement a daemon app must satisfy before the host builds on it or starts it: this bundle id, signed by the
 * certificate of the local identity (its SHA-1 as `security find-identity` lists it). Exactly one identity: with none
 * there is nothing to check against (identity_missing), with several of the name an app signed by any of them would
 * pass (identity_ambiguous); the callers refuse both before they get here, and anything else throws. codesign's -R takes
 * a plain requirement (`=…`), not a requirement set (`designated => …` is a syntax error).
 */
export function designatedRequirement(identityHashes) {
    if (identityHashes.length !== 1)
        throw new Error(`one identity to check against, not ${identityHashes.length}`);
    return `=identifier "${BUNDLE_ID}" and certificate leaf = H"${identityHashes[0]}"`;
}
