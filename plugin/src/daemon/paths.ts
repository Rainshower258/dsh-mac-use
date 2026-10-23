/**
 * Every path, name and executable the host service uses. All are constants (the home directory and the package
 * directory, which host.ts derives from its own location, are the only inputs): no route takes a parameter, so nothing
 * a request carries can point the service at another file, app, identity or program.
 *
 * @module
 */

import { join } from 'node:path'
import { STOP_MARK } from '../autostart.ts'

/** The daemon app's bundle id (scripts/build-app.sh). */
export const BUNDLE_ID = 'dev.cu-runtime.daemon'
/** The code-signing identity scripts/make-signing-identity.sh creates and build-app.sh signs with. */
export const IDENTITY_NAME = 'cu-runtime-signing'
/** What the package ships for the build (package.json files), copied in this order; Tests/ is optional. */
export const BUILD_INPUTS = ['Package.swift', 'Sources', 'Tests', 'scripts'] as const

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
} as const

/** The two System Settings panes the permissions route opens, one per call. */
export const SETTINGS_PANES = [
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
] as const

export interface DaemonPaths {
  /** The package root: Package.swift, Sources/, scripts/ (read, never written). */
  packageRoot: string
  /** ~/Applications/CURuntime.app, the installed daemon. */
  app: string
  appBinary: string
  appInfo: string
  /** ~/Applications: the replacement is staged here, on the same volume, and renamed into place. */
  applications: string
  /** ~/Library/Caches/cu-runtime: everything the host writes, except the app and the stop mark. */
  cache: string
  /** The build copy (Package.swift, Sources, Tests, scripts) build-app.sh runs in. */
  buildSrc: string
  /** build-app.sh's CU_SCRATCH (swift build --scratch-path) and CU_DIST (where CURuntime.app is assembled). */
  buildScratch: string
  buildDist: string
  /**
   * The app build-app.sh produces (removed before each build, so only the build just made can be there). It is
   * copied into ~/Applications under a staging name, and that copy is what is checked and renamed into place.
   */
  builtApp: string
  /** The last self-check result (`cu-runtime self-check --out`). */
  selfCheck: string
  /** The lock that lets one dsh process at a time install, start or stop the daemon. */
  lock: string
  /** One JSON line per action the plugin page started, with its outcome. */
  actionLog: string
  /**
   * The SHA-1 of the IDENTITY_NAME identity the host last signed with successfully, created, or the owner accepted (one
   * line: 40 upper-case hex digits): an identity of the name that is not this one is not signed with until the owner
   * accepts it. Without this file the installed app's certificate stands in for it (manager.ts), and is not written here.
   */
  knownIdentity: string
  /** The daemon's state dir and the autoStart stop mark in it (autostart.ts). */
  stateDir: string
  stopMark: string
  /** The socket a serving daemon listens on (Server.swift), and the config.json a daemon reads when it starts. */
  socket: string
  config: string
}

export function daemonPaths(home: string, packageRoot: string): DaemonPaths {
  const applications = join(home, 'Applications')
  const app = join(applications, 'CURuntime.app')
  const cache = join(home, 'Library/Caches/cu-runtime')
  const build = join(cache, 'build')
  const stateDir = join(home, 'Library/Application Support/cu-runtime')
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
  }
}

/**
 * The config.json switches a release build does not start with (LaunchPolicy.benchOnlyConfigKeys, as the file spells
 * them): named in start_failed when a daemon exits right after it started.
 */
export const BENCH_ONLY_CONFIG_KEYS = ['config_grants', 'debug_activation', 'debug_ime', 'debug_native_images'] as const

/**
 * The requirement a daemon app must satisfy before the host builds on it or starts it: this bundle id, signed by the
 * certificate of the local identity (its SHA-1 as `security find-identity` lists it). Exactly one identity: with none
 * there is nothing to check against (identity_missing), with several of the name an app signed by any of them would
 * pass (identity_ambiguous); the callers refuse both before they get here, and anything else throws. codesign's -R takes
 * a plain requirement (`=…`), not a requirement set (`designated => …` is a syntax error).
 */
export function designatedRequirement(identityHashes: readonly string[]): string {
  if (identityHashes.length !== 1) throw new Error(`one identity to check against, not ${identityHashes.length}`)
  return `=identifier "${BUNDLE_ID}" and certificate leaf = H"${identityHashes[0]}"`
}
