// The host service (plugin/src/host.ts, plugin/src/daemon/*): the plugin page's routes, the status, the install task,
// the actions. No real command runs and no real file outside a temporary directory is touched: the manager acts on a
// fake Mac (world) through the System facade.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as host from '../lib/host.js'
import { stopMarkOfThisBoot, stopMarkText } from '../lib/autostart.js'
import { CREATED_LINE, DaemonManager, fingerprint, HARDENED_RUNTIME, installedAppVerifier, KEYCHAIN_NOTE, LOCK_SKEW_MS, LOCK_STALE_MS, LOG_LINES,
  PERMISSIONS_MAX_AGE_MS, SIGN_MARKER, START_SETTLE_MS } from '../lib/daemon/manager.js'
import { BIN, daemonPaths, designatedRequirement } from '../lib/daemon/paths.js'
import { nodeFs, nodeRun, nodeSystem } from '../lib/daemon/system.js'
import { sourceHash, sourceHashFiles } from '../lib/daemon/source-hash.js'

const HOME = '/home/someone'
const PKG = host.PACKAGE_ROOT   // the routes' manager reads the package from here (the fake file system's copy)
const P = daemonPaths(HOME, PKG)
const SHA = 'AB'.repeat(20)
const OTHER_SHA = 'CD'.repeat(20)
const PKG_HASH = 'f'.repeat(64)
const T0 = Date.parse('2026-10-20T12:00:00Z')

const short = (s) => s.replaceAll(HOME, '~').replaceAll(PKG, '<pkg>')
/** A SHA-1 as openssl's -fingerprint prints it (how messages and the task log show one), written out here. */
const fp = (sha) => sha.match(/../g).join(':')
/** The designated requirement for one certificate, written out (not computed by the code under test). */
const requirementFor = (sha) => `=identifier "dev.cu-runtime.daemon" and certificate leaf = H"${sha}"`
/** SwiftPM's last line of `swift build --product cu-runtime` (Swift 6.3.3), as build-app.sh's output carries it. */
const SWIFT_DONE = "Build of product 'cu-runtime' complete! (12.34s)"
/** The whole environment every command gets: the system PATH, HOME, and four variables of dsh's environment. */
const CHILD_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME, USER: 'someone', LOGNAME: 'someone',
  TMPDIR: '/var/folders/xy/T/', LANG: 'zh_CN.UTF-8' }
/** The staged copy of a task's build in ~/Applications. */
const stagedOf = (id) => join(P.applications, `.CURuntime.app.new-${id}`)
/** make-signing-identity.sh's line once it has made an identity (CREATED_LINE), written out. */
const createdLine = (sha) => `created code-signing identity "cu-runtime-signing" (${sha}) in the login keychain`

/**
 * A fake Mac. Files are a map path → text; a directory exists when it was made or anything is under it. Commands act
 * on the world the way the real ones do, as far as the host can tell; `on[label]` replaces one (label: the command's
 * basename and its first argument, e.g. 'zsh build-app.sh', 'codesign --verify', 'open -g').
 */
function world(over = {}) {
  const w = {
    clock: T0,
    // dsh's environment: what a command may get (CHILD_ENV), and what would change what build-app.sh builds, runs or
    // signs with.
    env: { PATH: '/opt/evil/bin:/usr/bin:/bin', HOME: '/home/elsewhere', USER: 'someone', LOGNAME: 'someone',
      TMPDIR: '/var/folders/xy/T/', LANG: 'zh_CN.UTF-8', CU_SIGN_IDENTITY: 'EVIL', CU_BENCH: '1', CU_DIST: '/tmp/evil',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib', DEVELOPER_DIR: '/tmp/Xcode.app', SDKROOT: '/tmp/sdk', TOOLCHAINS: 'evil',
      SWIFT_EXEC: '/tmp/swiftc', GIT_DIR: '/tmp/git', ZDOTDIR: '/tmp/zdot' },
    files: new Map(),
    dirs: new Set([HOME, join(HOME, 'Library/Application Support/cu-runtime')]),
    identities: [SHA],
    clt: true,
    manager: 'Aqua',
    daemons: [],
    nextPid: 500,
    stubborn: false,
    appVersion: '20261020.100000-abc1234',
    builtVersion: '20261020.120000-nogit',
    builtHash: PKG_HASH,
    // The built app's CUBench: false (a release build), true (a bench build), null (no such key).
    builtBench: false,
    // The source hash of the build copy (what the build's CUSourceHash must be).
    copyHash: PKG_HASH,
    selfCheck: { ax: true, sck: true },
    // A started daemon serves its socket; startExits: it exits right after its process shows up (one ps sees it).
    serving: true,
    startExits: false,
    dying: new Set(),
    alivePids: [4242, 9999],
    calls: [],
    probes: [],
    hashed: [],
    killed: [],
    on: {},
    ...over,
  }
  const under = (path) => [...w.files.keys()].filter((k) => k === path || k.startsWith(`${path}/`))
  w.install = (version = w.appVersion, hash = PKG_HASH) => {
    w.files.set(P.appInfo, plist(version, hash))
    w.files.set(P.appBinary, 'bin')
  }
  w.fs = {
    exists: (p) => w.files.has(p) || w.dirs.has(p) || under(p).length > 0 || [...w.dirs].some((d) => d.startsWith(`${p}/`)),
    readText: (p) => w.files.get(p),
    mtimeMs: (p) => (w.files.has(p) ? (w.mtimes?.get(p) ?? w.clock) : undefined),
    writeText: (p, t) => { w.files.set(p, t) },
    appendText: (p, t) => { w.files.set(p, (w.files.get(p) ?? '') + t) },
    createExclusive: (p, t) => {
      if (w.files.has(p)) return false
      w.files.set(p, t)
      return true
    },
    mkdir: (p) => { w.dirs.add(p) },
    rm: (p) => {
      if (w.rmFails?.(p)) throw new Error(`rm ${p}: EPERM`)
      for (const k of under(p)) w.files.delete(k)
      for (const d of [...w.dirs]) if (d === p || d.startsWith(`${p}/`)) w.dirs.delete(d)
    },
    rename: (a, b) => {
      if (w.renameFails?.(a, b)) throw new Error(`rename ${a}: EPERM`)
      const moved = under(a)
      if (moved.length === 0) throw new Error(`rename ${a}: ENOENT`)
      for (const k of moved) {
        w.files.set(b + k.slice(a.length), w.files.get(k))
        w.files.delete(k)
      }
      w.renamed?.(a, b)
    },
  }
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
  const no = (stderr = 'failed', code = 1) => ({ code, stdout: '', stderr })
  const defaults = {
    'plutil -extract': (args) => {
      const text = w.files.get(args.at(-1))
      // nosemgrep: detect-non-literal-regexp -- test only: args[1] is a plist key the code under test names
      const m = text && new RegExp(`<key>${args[1]}</key>(?:<string>([^<]*)</string>|<(true|false)/>)`).exec(text)
      return m ? ok(`${m[1] ?? m[2]}\n`) : no(`Could not extract value`)
    },
    'security find-identity': () => ok(['Policy: Code Signing', '  Matching identities',
      ...w.identities.map((h, i) => `  ${i + 1}) ${h} "cu-runtime-signing" (CSSMERR_TP_NOT_TRUSTED)`),
      '  2) 1111111111111111111111111111111111111111 "Apple Development: someone"',
      `     ${w.identities.length + 1} identities found`, '', '  Valid identities only', '     0 valid identities found'].join('\n')),
    'codesign --verify': (args) => {
      const app = args.at(-1)
      const text = w.files.get(join(app, 'Contents/Info.plist'))
      if (text === undefined) return no(`${app}: No such file or directory`)
      const signer = /<key>signer<\/key><string>([^<]*)</.exec(text)?.[1]
      if (signer === 'none') return no(`${app}: code object is not signed at all`)
      if (args[2] !== '-R') return ok()
      return args[3] === requirementFor(signer) ? ok() : no('test-requirement: code failed to satisfy specified code requirement(s)', 3)
    },
    // As codesign prints it: on stderr, the CodeDirectory's flags among the lines (the plist's `flags` stands for them).
    // --extract-certificates=<prefix>: the leaf certificate goes to <prefix>0 (the fake's text names its SHA-1; an
    // ad-hoc signature has none).
    'codesign -d': (args) => {
      const app = args.at(-1)
      const text = w.files.get(join(app, 'Contents/Info.plist'))
      if (text === undefined) return no(`${app}: No such file or directory`)
      if (/<key>signer<\/key><string>none</.test(text)) return no(`${app}: code object is not signed at all`)
      const extract = /^--extract-certificates=(.*)$/.exec(args[1])?.[1]
      const signer = /<key>signer<\/key><string>([^<]*)</.exec(text)?.[1]
      if (extract !== undefined && signer !== 'adhoc') w.files.set(`${extract}0`, `certificate ${signer}`)
      const flags = /<key>flags<\/key><string>([^<]*)</.exec(text)?.[1]
      return { code: 0, stdout: '', stderr: [`Executable=${app}/Contents/MacOS/cu-runtime`, 'Identifier=dev.cu-runtime.daemon',
        'Format=app bundle with Mach-O thin (arm64)', `CodeDirectory v=20500 size=1234 flags=${flags} hashes=30+7 location=embedded`,
        'Signature size=1234', 'Info.plist entries=12', 'TeamIdentifier=not set', 'Runtime Version=26.0.0', 'Sealed Resources=none',
        'Internal requirements count=1 size=96', ''].join('\n') }
    },
    'ps -axww': () => {
      const listed = ok([...w.daemons.map((pid) => `  ${pid} ${P.appBinary}`),
        `  77 ${P.appBinary} self-check --out /tmp/x`, `  78 /opt/other/cu-runtime serve`, `  79 ${P.appBinary}-helper`].join('\n'))
      // A daemon that exits right after it started: seen once.
      w.daemons = w.daemons.filter((pid) => !w.dying.has(pid))
      return listed
    },
    // As LibreSSL prints a certificate's SHA-1 fingerprint.
    'openssl x509': (args) => {
      const m = /^certificate ([0-9A-F]{40})$/.exec(w.files.get(args.at(-1)) ?? '')
      return m ? ok(`SHA1 Fingerprint=${fp(m[1])}\n`) : no('unable to load certificate')
    },
    'xcode-select -p': () => (w.clt ? ok('/Library/Developer/CommandLineTools\n') : no('unable to get active developer directory', 2)),
    'xcode-select --install': () => ok(),
    'launchctl managername': () => ok(`${w.manager}\n`),
    'open -g': () => {
      if (w.files.has(P.appInfo)) {
        if (w.startExits) w.dying.add(w.nextPid)
        w.daemons.push(w.nextPid++)
      }
      return ok()
    },
    'open -n': (args) => {
      if (args[3] === 'self-check' && w.selfCheck !== null) {
        const version = /<key>CFBundleVersion<\/key><string>([^<]*)</.exec(w.files.get(P.appInfo))?.[1]
        w.files.set(args[5], JSON.stringify({ version, ax_trusted: w.selfCheck.ax, sck: { ok: w.selfCheck.sck } }))
      }
      return ok()
    },
    'open x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility': () => ok(),
    'open x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture': () => ok(),
    'ditto': (args) => {
      const [from, to] = args
      if (w.files.has(from)) w.files.set(to, w.files.get(from))
      for (const k of under(from)) w.files.set(to + k.slice(from.length), w.files.get(k))
      return ok()
    },
    'zsh make-signing-identity.sh': (_args, options) => {
      w.identities = [SHA]
      options.onLine?.(createdLine(SHA))
      return ok(`${createdLine(SHA)}\n`)
    },
    'zsh build-app.sh': (_args, options) => {
      for (const line of ['Compiling cu-runtime main.swift', SWIFT_DONE, SIGN_MARKER]) options.onLine?.(line)
      w.files.set(join(P.builtApp, 'Contents/Info.plist'), plist(w.builtVersion, w.builtHash, w.builtSigner ?? SHA, w.builtBench,
        w.builtFlags ?? RUNTIME_FLAGS))
      options.onLine?.(`built ${P.builtApp}`)
      return ok()
    },
  }
  w.defaults = defaults
  w.label = (file, args) => {
    const name = basename(file)
    if (name === 'zsh') return `zsh ${basename(args.at(-1))}`
    if (name === 'ditto') return 'ditto'
    if (name === 'open' && !args[0].startsWith('-')) return `open ${args[0]}`
    return `${name} ${args[0]}`
  }
  w.system = {
    run: async (file, args, options = {}) => {
      const label = w.label(file, args)
      w.calls.push({ label, line: short(`${basename(file)} ${args.join(' ')}`), options })
      await new Promise((r) => setImmediate(r))
      const handler = w.on[label] ?? defaults[label]
      if (handler === undefined) throw new Error(`unexpected command: ${label}`)
      return handler(args, options)
    },
    fs: w.fs,
    kill: (pid, signal) => {
      w.killed.push([pid, signal])
      if (!w.stubborn) w.daemons = w.daemons.filter((p) => p !== pid)
      return true
    },
    alive: (pid) => w.alivePids.includes(pid),
    connects: async (path) => {
      w.probes.push(path)
      await new Promise((r) => setImmediate(r))
      return path === P.socket && w.serving && w.daemons.length > 0
    },
    sleep: async (ms) => {
      w.clock += ms
      await new Promise((r) => setImmediate(r))
    },
    now: () => w.clock,
    get env() { return w.env },
    home: HOME,
    pid: 9999,
  }
  w.sourceHash = (root) => {
    w.hashed.push(root)
    if (w.hashFails) throw new Error(`${root}: ENOENT`)
    return root === P.buildSrc ? w.copyHash : PKG_HASH
  }
  w.manager_ = (options = {}) => new DaemonManager({ system: w.system, paths: P, packageSourceHash: () => PKG_HASH,
    sourceHash: w.sourceHash, bootTime: () => 1000, ...options })
  w.ran = () => w.calls.map((c) => c.label)
  w.files.set(join(PKG, 'package.json'), JSON.stringify({ name: 'cu-runtime', version: '0.2.0' }))
  for (const f of ['Package.swift', 'Sources/x.swift', 'Tests/t.swift', 'scripts/build-app.sh', 'scripts/make-signing-identity.sh']) {
    w.files.set(join(PKG, f), f)
  }
  return w
}

/** The CodeDirectory flags of a signature made with --options runtime (codesign -d --verbose=1). */
const RUNTIME_FLAGS = '0x10000(runtime)'

/**
 * An Info.plist as build-app.sh writes it; `signer` and `flags` stand for the signature (its certificate's SHA-1, and
 * the CodeDirectory flags codesign -d shows), bench is CUBench (null: no such key).
 */
function plist(version, hash, signer = SHA, bench = false, flags = RUNTIME_FLAGS) {
  return `<plist><dict><key>CFBundleIdentifier</key><string>dev.cu-runtime.daemon</string><key>CFBundleVersion</key><string>${version}</string>`
    + (bench === null ? '' : `<key>CUBench</key><${bench}/>`)
    + (hash === null ? '' : `<key>CUSourceHash</key><string>${hash}</string>`) + `<key>signer</key><string>${signer}</string>`
    + `<key>flags</key><string>${flags}</string></dict></plist>`
}

/** The task once it finished (read without probing, so the commands recorded are the task's alone). */
async function settle(m) {
  for (let i = 0; i < 10_000; i++) {
    const task = m.taskState()
    if (['done', 'failed', 'cancelled'].includes(task.phase)) return task
    await new Promise((r) => setImmediate(r))
  }
  throw new Error(`the task did not finish: ${JSON.stringify(m.taskState())}`)
}

/** Waits until the condition holds; fails (a mutant must fail, not hang) if the task finishes first. */
async function until(condition, m) {
  for (let i = 0; i < 10_000; i++) {
    if (condition()) return
    if (['done', 'failed', 'cancelled'].includes(m.taskState()?.phase)) throw new Error(`finished first: ${JSON.stringify(m.taskState())}`)
    await new Promise((r) => setImmediate(r))
  }
  throw new Error('the condition never held')
}

/** Waits until the condition holds, with no task to watch (a mutant must fail, not hang). */
async function eventually(condition) {
  for (let i = 0; i < 10_000; i++) {
    if (condition()) return
    await new Promise((r) => setImmediate(r))
  }
  throw new Error('the condition never held')
}

/** A command that runs until it is ended (cancel). */
const untilAborted = (signal) => new Promise((resolve) => {
  if (signal.aborted) resolve()
  else signal.addEventListener('abort', resolve, { once: true })
})

/** Waits until the task is in this phase; fails if it finishes first. */
async function reach(m, phase) {
  for (let i = 0; i < 10_000; i++) {
    const task = m.taskState()
    if (task.phase === phase) return
    if (['done', 'failed', 'cancelled'].includes(task.phase)) throw new Error(`finished before ${phase}: ${JSON.stringify(task)}`)
    await new Promise((r) => setImmediate(r))
  }
  throw new Error(`never reached ${phase}`)
}

/** The host plugin on a fake context; routes are what it registered on the fake connection. */
function hostOn(w, { connection = true, profileContext = true } = {}) {
  const routes = []
  const effects = []
  const ctx = {
    get: (name) => (name === 'profileContext' && profileContext ? { name: 'web' } : undefined),
    effect: (fn) => { effects.push(fn()) },
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['connection'])
      if (connection) callback({ connection: { fetch: { register: (r) => { routes.push(r); return async () => {} } } } })
    },
  }
  host.applyWith({ system: w.system, packageSourceHash: () => PKG_HASH, sourceHash: w.sourceHash, bootTime: () => 1000 })(ctx)
  const call = async (op, init = {}) => {
    const route = routes.find((r) => r.path === `/api/cu-runtime.${op}`)
    const res = await route.fetch(new Request(`http://127.0.0.1:1/api/cu-runtime.${op}${init.query ?? ''}`,
      { method: 'POST', body: init.body }))
    return { res, body: await res.json() }
  }
  return { routes, effects, call }
}

// ------------------------------------------------------------------------------------------------ routes

test('routes: one POST route per operation under /api/cu-runtime.<op>, buffered, JSON, no-store', async () => {
  const w = world()
  const { routes, call } = hostOn(w)
  // The settings routes besides (host-settings.test.mjs covers them), and the mode check's
  // (mode-check.test.mjs).
  assert.deepEqual(routes.map((r) => r.path).filter((p) => !p.startsWith('/api/cu-runtime.settings.')).sort(), ['acceptIdentity',
    'cancel', 'clt', 'install', 'modeCheck', 'modeCheckRefresh', 'permissions', 'restart', 'selfcheck', 'start', 'status',
    'stop'].map((op) => `/api/cu-runtime.${op}`))
  assert.equal(routes.length, 10 + 2 + 3 + 8)
  for (const r of routes) {
    assert.deepEqual(r.methods, ['POST'])
    assert.equal(r.requestBody, 'buffered')
  }
  const { res, body } = await call('status')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.match(res.headers.get('content-type'), /application\/json/)
  assert.equal(body.app.installed, false)
})

// Every route but settings.apply, whose body is one checked change (host-settings.test.mjs); the other settings
// routes' no-body pin is there too.
test('routes take no parameter: a body or a query naming another app, identity or path changes nothing', async () => {
  const w = world()
  w.install()
  const { call } = hostOn(w)
  const plain = (await call('status')).body
  const evil = JSON.stringify({ app: '/tmp/Evil.app', identity: 'evil', path: '/etc', args: ['--state-dir', '/tmp'] })
  const withParams = (await call('status', { body: evil, query: '?app=/tmp/Evil.app&identity=evil' })).body
  assert.deepEqual(withParams, plain)
  w.calls.length = 0
  await call('start', { body: evil, query: '?app=/tmp/Evil.app' })
  const lines = w.calls.map((c) => c.line).join('\n')
  assert.doesNotMatch(lines, /Evil|evil|\/etc|state-dir/)
  assert.match(lines, /^open -g ~\/Applications\/CURuntime\.app$/m)
})

test('the status carries no token, audit or screen content', async () => {
  const w = world()
  w.install()
  w.daemons = [400]
  w.files.set(join(P.stateDir, 'token'), 'SECRET-TOKEN')
  w.files.set(P.selfCheck, JSON.stringify({ version: w.appVersion, ax_trusted: true, sck: { ok: true, width: 10, height: 10 } }))
  const { call } = hostOn(w)
  const text = JSON.stringify((await call('status')).body)
  assert.doesNotMatch(text, /SECRET|token|audit|width|height/i)
})

test('headless (no connection service): the routes are not registered, and nothing runs', () => {
  const w = world()
  const { routes } = hostOn(w, { connection: false })
  assert.deepEqual(routes, [])
  assert.deepEqual(w.calls, [])
})

test('real cordis: the routes come with the connection service, the 0.1.5 refusal comes first', async () => {
  const w = world()
  const ctx = new Context()
  ctx.provide('profileContext', { name: 'web' })
  const routes = []
  const fiber = ctx.plugin({ name: 'host', apply: host.applyWith({ system: w.system }) })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(fiber._error, undefined)
  assert.deepEqual(routes, [], 'no connection, no routes')
  ctx.provide('connection', { fetch: { register: (r) => { routes.push(r.path); return async () => {} } } })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(routes.length, 23)
  const old = new Context()
  old.provide('connection', { fetch: { register: (r) => { routes.push(r.path); return async () => {} } } })
  const refused = old.plugin({ name: 'host', apply: host.applyWith({ system: w.system }) })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(String(refused._error?.message), host.UNSUPPORTED_DSH)
  assert.equal(routes.length, 23, 'a dsh without profileContext gets no routes')
})

test('the package root is two levels above plugin/lib/host.js', () => {
  assert.ok(existsSync(join(host.PACKAGE_ROOT, 'Package.swift')))
  assert.ok(existsSync(join(host.PACKAGE_ROOT, 'plugin/lib/host.js')))
})

// ------------------------------------------------------------------------------------------------ status

test('the designated requirement, written out: the bundle id and the certificate of exactly one identity', () => {
  assert.equal(designatedRequirement(['ABABABABABABABABABABABABABABABABABABABAB']),
    '=identifier "dev.cu-runtime.daemon" and certificate leaf = H"ABABABABABABABABABABABABABABABABABABABAB"')
  assert.equal(designatedRequirement([SHA]), requirementFor(SHA))
  // None is nothing to check against, several would admit an app signed by any: the callers refuse both first.
  assert.throws(() => designatedRequirement([]), /one identity/)
  assert.throws(() => designatedRequirement([SHA, OTHER_SHA]), /one identity/)
})

test('status: installed, current, signed by the identity, running, with a recent self-check', async () => {
  const w = world()
  w.install()
  w.daemons = [400]
  w.files.set(P.selfCheck, JSON.stringify({ version: w.appVersion, ax_trusted: true, sck: { ok: false } }))
  const s = await w.manager_().status()
  assert.deepEqual(s, {
    app: { installed: true, version: w.appVersion, sourceHash: PKG_HASH, signature: 'ok', identity: 'present', identitySha1: SHA,
      identityKnown: SHA, identityKnownSource: 'installedApp', identityChanged: false },
    package: { version: '0.2.0', sourceHash: PKG_HASH },
    upToDate: true,
    running: true,
    permissions: { accessibility: true, screenRecording: false },
    environment: { gui: true, clt: true, sshSession: false },
    task: null,
    busy: null,
  })
  // The installed app's own daemon only: not self-check, not another binary named cu-runtime, not a lookalike path.
  assert.ok(w.calls.some((c) => c.line === 'ps -axww -o pid=,args='))
  assert.ok(w.calls.some((c) => c.line === `codesign --verify --strict -R ${requirementFor(SHA)} ~/Applications/CURuntime.app`))
  assert.ok(w.calls.some((c) => c.line === 'codesign -d --verbose=1 ~/Applications/CURuntime.app'), 'and its hardened runtime')
})

test('status: not installed; an older build; unsigned; another signer; no identity', async () => {
  let w = world()
  let s = await w.manager_().status()
  assert.deepEqual(s.app, { installed: false, version: null, sourceHash: null, signature: 'missing', identity: 'present',
    identitySha1: SHA, identityKnown: null, identityKnownSource: null, identityChanged: false })
  assert.equal(s.upToDate, false)
  assert.equal(s.running, false)
  assert.equal(s.permissions, null)

  w = world()
  w.install(w.appVersion, null)   // built before CUSourceHash
  s = await w.manager_().status()
  assert.equal(s.app.sourceHash, null)
  assert.equal(s.upToDate, false)

  w = world()
  w.install(w.appVersion, 'e'.repeat(64))
  assert.equal((await w.manager_().status()).upToDate, false)

  w = world()
  w.files.set(P.appInfo, plist(w.appVersion, PKG_HASH, 'none'))
  assert.equal((await w.manager_().status()).app.signature, 'unsigned')

  w = world()
  w.files.set(P.appInfo, plist(w.appVersion, PKG_HASH, OTHER_SHA))
  assert.equal((await w.manager_().status()).app.signature, 'mismatch')

  w = world({ identities: [] })
  w.install()
  s = await w.manager_().status()
  assert.equal(s.app.identity, 'missing')
  assert.equal(s.app.identitySha1, null)
  assert.equal(s.app.signature, 'mismatch', 'a valid signature is not ours without the identity to check it against')
})

test('several identities of the name: the status says ambiguous, no signature counts as ours, nothing is launched', async () => {
  let w = world({ identities: [SHA, OTHER_SHA] })
  w.install()   // signed by one of them
  let s = await w.manager_().status()
  assert.equal(s.app.identity, 'ambiguous')
  assert.equal(s.app.identitySha1, null, 'no one identity to name')
  assert.equal(s.app.signature, 'mismatch')
  assert.ok(!w.ran().includes('codesign --verify'), 'no requirement admitting either certificate is ever checked')

  w = world({ identities: [SHA, OTHER_SHA] })
  s = await w.manager_().status()
  assert.deepEqual([s.app.identity, s.app.signature], ['ambiguous', 'missing'], 'not installed: no signature at all')

  w = world({ identities: [SHA, OTHER_SHA] })
  w.install()
  const m = w.manager_()
  for (const op of ['start', 'permissions', 'selfCheck', 'restart']) {
    w.daemons = op === 'restart' ? [400] : []
    w.calls.length = 0
    const r = await m[op]()
    assert.equal(r.ok, false, op)
    assert.equal(r.error.code, 'identity_ambiguous', op)
    assert.ok(r.error.message.includes(`(SHA-1 ${fp(SHA)}, ${fp(OTHER_SHA)})`), r.error.message)
    assert.ok(!w.ran().some((l) => l.startsWith('open') || l.startsWith('codesign')), `${op}: ${w.ran()}`)
  }
  assert.deepEqual(w.killed, [], 'restart is refused before the running daemon is stopped')
  w.daemons = [400]
  assert.equal((await m.start()).error?.code, 'identity_ambiguous', 'start refuses even while a daemon runs')
  // install: refused in its identity step, before anything is copied, built or signed (FAILURES has the details).
  m.install()
  const done = await settle(m)
  assert.equal(done.error.code, 'identity_ambiguous')
  assert.ok(!w.ran().includes('zsh build-app.sh'))
})

test('status: permissions only from a self-check of this version in the last 10 minutes', async () => {
  const w = world()
  w.install()
  const m = w.manager_()
  w.files.set(P.selfCheck, JSON.stringify({ version: 'an-older-build', ax_trusted: true, sck: { ok: true } }))
  assert.equal((await m.status()).permissions, null)
  w.files.set(P.selfCheck, JSON.stringify({ version: w.appVersion, ax_trusted: true, sck: { ok: true } }))
  w.mtimes = new Map([[P.selfCheck, T0 - PERMISSIONS_MAX_AGE_MS - 1]])
  assert.equal((await m.status()).permissions, null)
  w.mtimes = new Map([[P.selfCheck, T0 - 1000]])
  assert.deepEqual((await m.status()).permissions, { accessibility: true, screenRecording: true })
  w.files.set(P.selfCheck, '{not json')
  assert.equal((await m.status()).permissions, null)
})

test('status: an SSH session is no GUI session; launchctl says whether dsh runs at the Mac\'s screen', async () => {
  let w = world({ env: { SSH_CONNECTION: '10.0.0.2 5000 10.0.0.1 22' } })
  assert.deepEqual((await w.manager_().status()).environment, { gui: false, clt: true, sshSession: true })
  w = world({ env: { SSH_TTY: '/dev/ttys001' } })
  assert.deepEqual((await w.manager_().status()).environment, { gui: false, clt: true, sshSession: true })
  w = world({ manager: 'Background', clt: false })
  assert.deepEqual((await w.manager_().status()).environment, { gui: false, clt: false, sshSession: false })
})

test('status: concurrent polls share one probe', async () => {
  const w = world()
  const m = w.manager_()
  await Promise.all([m.status(), m.status(), m.status()])
  assert.equal(w.calls.filter((c) => c.label === 'security find-identity').length, 1)
})

// ------------------------------------------------------------------------------------------------ install task

test('install: the phases in order, the build from a copy with the cache dirs, the stop mark around the replacement', async () => {
  const w = world()
  w.install()
  w.daemons = [400]
  const m = w.manager_()
  const first = m.install()
  assert.equal(first.phase, 'preflight')
  assert.equal(m.install().id, first.id, 'a second install joins the running task')
  const phases = new Set()
  w.on['open -g'] = (args) => {
    phases.add(`mark at start: ${w.files.has(P.stopMark)}`)
    w.daemons.push(w.nextPid++)
    return { code: 0, stdout: '', stderr: '' }
  }
  const done = await settle(m)
  assert.equal(done.phase, 'done', done.log.join('\n'))
  assert.equal(done.error, null)
  assert.deepEqual(w.ran(), [
    'xcode-select -p', 'launchctl managername',                          // preflight
    'security find-identity',                                            // preflight: one identity, none on record:
    'codesign -d', 'openssl x509',                                       // the installed app's certificate is known
    'ditto', 'ditto', 'ditto', 'ditto',                                  // copy: Package.swift Sources Tests scripts
    'zsh build-app.sh',                                                  // build + sign
    'ditto', 'plutil -extract', 'plutil -extract', 'codesign --verify',  // verify the staged copy: release, this build, DR,
    'codesign -d',                                                       // hardened runtime
    'ps -axww', 'ps -axww',                                              // stop: running, then gone
                                                                         // replace: renames only
    'plutil -extract', 'codesign --verify', 'codesign -d',               // start: checked,
    'open -g', 'ps -axww', 'ps -axww',                                   // open, up and still up
    'open -n',                                                           // selfcheck
  ])
  const lines = w.calls.map((c) => c.line)
  const staged = short(stagedOf(first.id))
  assert.deepEqual(lines.filter((l) => l.startsWith('ditto')), [...['Package.swift', 'Sources', 'Tests', 'scripts']
    .map((f) => `ditto <pkg>/${f} ~/Library/Caches/cu-runtime/build/src/${f}`),
  `ditto ~/Library/Caches/cu-runtime/build/dist/CURuntime.app ${staged}`], 'the build is read once, into the staging name')
  assert.deepEqual(w.hashed, [P.buildSrc], 'the build copy\'s source hash, once')
  const build = w.calls.find((c) => c.label === 'zsh build-app.sh')
  assert.equal(build.line, 'zsh -f ~/Library/Caches/cu-runtime/build/src/scripts/build-app.sh', 'no startup file')
  assert.equal(build.options.cwd, P.buildSrc)
  assert.deepEqual(build.options.env, { ...CHILD_ENV, CU_SCRATCH: join(HOME, 'Library/Caches/cu-runtime/build/.build'),
    CU_DIST: join(HOME, 'Library/Caches/cu-runtime/build/dist'), CU_SIGN_IDENTITY: SHA },
  'nothing else of dsh\'s environment (CU_*, DYLD_*, ZDOTDIR…); it signs with the identity preflight checked alone')
  // The staged copy is what is checked: a release build, of the sources copied, signed by the identity, with hardened
  // runtime.
  assert.match(lines.find((l) => l.startsWith('codesign')),
    /^codesign -d --extract-certificates=~\/Library\/Caches\/cu-runtime\/installed-cert\.[0-9a-f-]{36}\/cert ~\/Applications\/CURuntime\.app$/)
  assert.deepEqual(lines.filter((l) => l.startsWith('plutil') || l.startsWith('codesign')).slice(1, 5), [
    `plutil -extract CUBench raw -o - ${staged}/Contents/Info.plist`,
    `plutil -extract CUSourceHash raw -o - ${staged}/Contents/Info.plist`,
    `codesign --verify --strict -R ${requirementFor(SHA)} ${staged}`,
    `codesign -d --verbose=1 ${staged}`])
  // The installed app is checked again before it is started: a release build, signed by the identity, hardened.
  assert.deepEqual(lines.filter((l) => l.startsWith('plutil') || l.startsWith('codesign')).slice(5), [
    'plutil -extract CUBench raw -o - ~/Applications/CURuntime.app/Contents/Info.plist',
    `codesign --verify --strict -R ${requirementFor(SHA)} ~/Applications/CURuntime.app`,
    'codesign -d --verbose=1 ~/Applications/CURuntime.app'])
  assert.deepEqual(w.probes, [P.socket], 'up: its socket accepts a connection')
  assert.deepEqual(w.killed, [[400, 'SIGTERM']])
  assert.ok(lines.includes('open -g ~/Applications/CURuntime.app'))
  assert.ok(lines.includes(`open -n ~/Applications/CURuntime.app --args self-check --out ${short(P.selfCheck)}`))
  assert.ok(!lines.some((l) => / -W( |$)/.test(l)), 'never open -W')
  assert.deepEqual([...phases], ['mark at start: true'], 'autoStart is held off while the app is replaced')
  assert.equal(w.files.has(P.stopMark), false, 'and released once the new daemon runs')
  // The new app is in place, the staging and the old copy are gone, the package was never written.
  assert.match(w.files.get(P.appInfo), /20261020\.120000-nogit/)
  assert.deepEqual([...w.files.keys()].filter((k) => k.includes('.CURuntime.app.')), [])
  assert.deepEqual([...w.files.keys()].filter((k) => k.startsWith(PKG)).sort(), ['Package.swift', 'Sources/x.swift',
    'Tests/t.swift', 'package.json', 'scripts/build-app.sh', 'scripts/make-signing-identity.sh'].map((f) => join(PKG, f)).sort())
  const s = await m.status()
  assert.equal(s.upToDate, true)
  assert.deepEqual(s.permissions, { accessibility: true, screenRecording: true })
  assert.equal(s.task.id, first.id, 'the finished task stays visible (a reloaded page finds it)')
  // The page's operations are on record, and the lock is released.
  const log = w.files.get(P.actionLog).trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(log.map((e) => [e.action, e.outcome]), [['install', 'started'], ['install', 'done']])
  assert.equal(log[1].identity, SHA, 'the identity it signed with is on record')
  assert.equal(log[1].identityCreated, undefined, 'one already there')
  assert.equal(w.files.has(P.lock), false)
  // The phases the page saw, in the log (build-app.sh's own line starts the sign phase).
  assert.deepEqual(done.log.filter((l) => l.startsWith('== ')), ['preflight', 'identity', 'copy', 'build', 'sign', 'verify',
    'stop', 'replace', 'start', 'selfcheck', 'done'].map((p) => `== ${p}`))
  assert.ok(done.log.includes(SWIFT_DONE), 'the build output is in the log')
  assert.ok(done.log.includes(`identity cu-runtime-signing ${fp(SHA)} (the one the installed app is signed with); it is put on `
    + 'record once this install has signed with it'), done.log.join('\n'))
  assert.ok(done.log.includes(`identity cu-runtime-signing ${fp(SHA)} is on record now`))
  assert.deepEqual([...w.files.keys(), ...w.dirs].filter((k) => k.includes('installed-cert')), [], 'the extracted certificate goes')
  assert.equal(w.files.get(P.knownIdentity), `${SHA}\n`, 'signed with: the identity on record')
  assert.equal(done.endedIn, null, 'a task that is done ended in no phase')
})

test('install: the sign phase starts at build-app.sh\'s own marker line, not at SwiftPM\'s; the log keeps the last 200 lines', async () => {
  const w = world()
  const m = w.manager_()
  const seen = []
  w.on['zsh build-app.sh'] = async (_args, options) => {
    for (let i = 0; i < 300; i++) options.onLine(`line ${i}`)
    // SwiftPM's summary (either wording), a lookalike: still building.
    for (const line of [SWIFT_DONE, 'Build complete! (1.00s)', `${SIGN_MARKER} now`, `  ${SIGN_MARKER}`]) {
      options.onLine(line)
      seen.push(m.taskState().phase)
    }
    options.onLine(SIGN_MARKER)
    seen.push(m.taskState().phase)
    w.files.set(join(P.builtApp, 'Contents/Info.plist'), plist(w.builtVersion, PKG_HASH))
    return { code: 0, stdout: '', stderr: '' }
  }
  m.install()
  const done = await settle(m)
  assert.equal(done.phase, 'done')
  assert.deepEqual(seen, ['build', 'build', 'build', 'build', 'sign'])
  assert.equal(done.log.length, LOG_LINES)
})

test('install: a missing identity is created with the package\'s script, then used', async () => {
  const w = world({ identities: [] })
  const m = w.manager_()
  m.install()
  const done = await settle(m)
  assert.equal(done.phase, 'done', done.log.join('\n'))
  const make = w.calls.find((c) => c.label === 'zsh make-signing-identity.sh')
  assert.equal(make.line, 'zsh -f <pkg>/scripts/make-signing-identity.sh', 'no startup file')
  assert.deepEqual(make.options.env, CHILD_ENV)
  assert.deepEqual(w.ran().slice(0, 5), ['xcode-select -p', 'launchctl managername', 'security find-identity',
    'zsh make-signing-identity.sh', 'security find-identity'])
  // On record when it is made, and with the install's outcome; the task log says so too.
  const log = w.files.get(P.actionLog).trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(log.map(({ action, outcome, identity, identityCreated }) => ({ action, outcome, identity, identityCreated })), [
    { action: 'install', outcome: 'started', identity: undefined, identityCreated: undefined },
    { action: 'identity', outcome: 'created', identity: SHA, identityCreated: undefined },
    { action: 'install', outcome: 'done', identity: SHA, identityCreated: true },
  ])
  assert.ok(done.log.includes(`identity cu-runtime-signing ${fp(SHA)}: created by this install`))
  assert.equal(w.files.get(P.knownIdentity), `${SHA}\n`, 'created: the identity on record')
})

test('install: an SSH session is refused before anything runs', async () => {
  for (const env of [{ SSH_CONNECTION: '10.0.0.2 5000 10.0.0.1 22' }, { SSH_TTY: '/dev/ttys003' }]) {
    const w = world({ env })
    const m = w.manager_()
    m.install()
    const done = await settle(m)
    assert.equal(done.phase, 'failed')
    assert.equal(done.error.code, 'ssh_session')
    assert.deepEqual(w.ran().filter((l) => !['xcode-select -p', 'launchctl managername'].includes(l)), [])
  }
})

/** build-app.sh's run as the fake world does it, up to its sign marker when `signing`, then this result. */
const buildThen = (result, { signing = true } = {}) => (_a, o) => {
  for (const line of ['Compiling cu-runtime main.swift', SWIFT_DONE, ...(signing ? [SIGN_MARKER] : [])]) o.onLine(line)
  return { stdout: '', stderr: '', ...result }
}

/**
 * Each failure: the world's change, the code, the last command that ran, the phase the task ended in, and what the
 * message says (a pattern).
 */
const FAILURES = [
  ['not at the Mac\'s screen', (w) => { w.manager = 'Background' }, 'no_gui_session', 'launchctl managername', 'preflight', /Aqua/],
  ['no Command Line Tools', (w) => { w.clt = false }, 'clt_missing', 'launchctl managername', 'preflight', /xcode-select -p/],
  // The identities are listed again after the script, however it ended (nothing new: nothing on record).
  ['the identity cannot be made', (w) => {
    w.identities = []
    w.on['zsh make-signing-identity.sh'] = () => ({ code: 1, stdout: '', stderr: 'import failed: is the login keychain locked?' })
  }, 'identity_failed', 'security find-identity', 'identity', /exited with status 1: import failed: is the login keychain locked\?$/],
  ['two identities of the name', (w) => { w.identities = [SHA, OTHER_SHA] }, 'identity_ambiguous', 'openssl x509',
    'identity', /several/],
  // A listing that fails is no "none": nothing is created on its word (a look-alike the script would find is not taken).
  ['security find-identity fails in preflight', (w) => {
    w.identities = []
    w.on['security find-identity'] = () => ({ code: 1, stdout: '', stderr: 'security: SecKeychainSearchCopyNext: interrupted' })
  }, 'identity_failed', 'security find-identity', 'preflight',
  /^security find-identity exited with status 1: security: SecKeychainSearchCopyNext: interrupted$/],
  ['the copy fails', (w) => { w.on.ditto = () => ({ code: 1, stdout: '', stderr: 'ditto: No space left on device' }) }, 'copy_failed',
    'ditto', 'copy', /No space/],
  ['the package has no Sources', (w) => { w.files.delete(join(PKG, 'Sources/x.swift')) }, 'copy_failed', 'ditto', 'copy',
    /has no Sources/],
  ['the copy\'s source hash cannot be computed', (w) => { w.hashFails = true }, 'copy_failed', 'ditto', 'copy',
    /source hash of .*build\/src: Error: .*ENOENT/],
  ['swift build fails', (w) => {
    w.on['zsh build-app.sh'] = (_a, o) => { o.onLine('error: no such module'); return { code: 1, stdout: '', stderr: 'error' } }
  }, 'build_failed', 'zsh build-app.sh', 'build', /exited with status 1/],
  // SwiftPM's summary is no sign of signing: a failure after it, before build-app.sh's marker, is the build's.
  ['the build fails after SwiftPM\'s summary, before the sign marker', (w) => {
    w.on['zsh build-app.sh'] = buildThen({ code: 3, stderr: 'cp: Permission denied' }, { signing: false })
  }, 'build_failed', 'zsh build-app.sh', 'build', /^build-app\.sh exited with status 3: cp: Permission denied$/],
  ['the build times out', (w) => {
    w.on['zsh build-app.sh'] = buildThen({ code: null, timedOut: true }, { signing: false })
  }, 'build_failed', 'zsh build-app.sh', 'build', /timed out after 30 min/],
  ['the earlier build output cannot be removed', (w) => { w.rmFails = (p) => p === P.buildDist }, 'build_failed', 'ditto', 'build',
    /cannot remove the earlier build output/],
  ['an earlier build is left and build-app.sh makes none', (w) => {
    w.files.set(join(P.builtApp, 'Contents/Info.plist'), plist('an-earlier-build', PKG_HASH))
    w.on['zsh build-app.sh'] = buildThen({ code: 0 })
  }, 'build_failed', 'zsh build-app.sh', 'verify', /did not produce/],
  ['signing is denied (build-app.sh exits 3 after its marker)', (w) => {
    w.on['zsh build-app.sh'] = buildThen({ code: 3, stderr: 'codesign failed (screen locked?' })
  }, 'sign_failed', 'zsh build-app.sh', 'sign', /^build-app\.sh exited with status 3 while signing: codesign failed/],
  ['the run times out while signing', (w) => {
    w.on['zsh build-app.sh'] = buildThen({ code: null, timedOut: true })
  }, 'sign_failed', 'zsh build-app.sh', 'sign', /timed out after 30 min while signing/],
  ['another failure after the marker', (w) => {
    w.on['zsh build-app.sh'] = buildThen({ code: 1, stderr: 'mv: rename failed' })
  }, 'build_failed', 'zsh build-app.sh', 'sign', /exited with status 1: mv: rename failed/],
  ['the build cannot be staged in ~/Applications', (w) => {
    w.on.ditto = (args) => (args[0] === P.builtApp ? { code: 1, stdout: '', stderr: 'ditto: Permission denied' } : w.defaults.ditto(args))
  }, 'replace_failed', 'ditto', 'verify', /cannot stage the new build .*the installed app is unchanged/],
  ['the build is a bench build', (w) => { w.builtBench = true }, 'not_release_build', 'plutil -extract', 'verify',
    /CUBench is true, not false/],
  ['the build says nothing of CUBench', (w) => { w.builtBench = null }, 'not_release_build', 'plutil -extract', 'verify',
    /CUBench is missing/],
  ['the build is not of the sources copied for it', (w) => { w.builtHash = 'e'.repeat(64) }, 'build_failed', 'plutil -extract',
    'verify', new RegExp(`its CUSourceHash is ${'e'.repeat(64)}, their source hash ${PKG_HASH}`)],
  ['the build signed with another certificate', (w) => { w.builtSigner = OTHER_SHA }, 'signature_mismatch', 'codesign --verify',
    'verify', /does not satisfy/],
  ['the build signed without hardened runtime', (w) => { w.builtFlags = '0x0(none)' }, 'not_release_build', 'codesign -d',
    'verify', /is signed without hardened runtime \(codesign -d shows flags=0x0\(none\)\): reinstall it$/],
]

/** Failures before the identity is known: their record names none. */
const BEFORE_IDENTITY = new Set(['preflight', 'identity'])

for (const [what, change, code, last, endedIn, says] of FAILURES) {
  test(`install fails with ${code} (${what}), before anything is stopped or replaced`, async () => {
    const w = world()
    w.install()
    w.daemons = [400]
    change(w)
    const before = w.files.get(P.appInfo)
    const m = w.manager_()
    m.install()
    const done = await settle(m)
    assert.equal(done.phase, 'failed')
    assert.equal(done.error.code, code, done.log.join('\n'))
    assert.equal(done.endedIn, endedIn)
    assert.equal(w.ran().at(-1), last)
    // Ended while signing: the keychain dialog may outlive codesign, and the message says how to answer it.
    if (endedIn === 'sign') {
      assert.ok(done.error.message.endsWith(`; ${KEYCHAIN_NOTE}`), done.error.message)
      assert.match(done.error.message.slice(0, -KEYCHAIN_NOTE.length - 2), says)
    } else {
      assert.match(done.error.message, says)
      assert.ok(!done.error.message.includes('keychain password dialog'))
    }
    assert.match(KEYCHAIN_NOTE, /拒绝 \(Deny\)/)
    assert.deepEqual(w.killed, [])
    assert.ok(!w.ran().includes('open -g'))
    assert.equal(w.files.get(P.appInfo), before)
    assert.deepEqual([...w.files.keys()].filter((k) => k.includes('.CURuntime.app.')), [], 'no staged copy is left')
    assert.equal(w.files.has(P.stopMark), false)
    assert.equal(w.files.has(P.lock), false, 'the lock is released')
    assert.deepEqual(w.files.get(P.actionLog).trim().split('\n').map((l) => JSON.parse(l)).at(-1),
      { at: new Date(w.clock).toISOString(), pid: 9999, action: 'install', task: done.id, outcome: 'failed', code,
        message: done.error.message, ...(BEFORE_IDENTITY.has(endedIn) ? {} : { identity: SHA }) })
  })
}

test('install fails with stop_failed when the daemon does not exit; it is not replaced', async () => {
  const w = world({ stubborn: true })
  w.install()
  w.daemons = [400]
  const before = w.files.get(P.appInfo)
  const m = w.manager_()
  m.install()
  const done = await settle(m)
  assert.equal(done.error.code, 'stop_failed')
  assert.equal(done.endedIn, 'stop')
  assert.deepEqual(w.killed, [[400, 'SIGTERM']])
  assert.equal(w.files.get(P.appInfo), before)
  assert.equal(w.calls.filter((c) => c.label === 'ditto').length, 5, 'the build copy and the staged copy')
  assert.deepEqual([...w.files.keys()].filter((k) => k.includes('.CURuntime.app.')), [], 'the staged copy is removed')
  assert.equal(w.files.has(P.stopMark), false)
})

test('install fails with replace_failed; the old app stays and its daemon runs again', async () => {
  const w = world()
  w.install()
  w.daemons = [400]
  const before = w.files.get(P.appInfo)
  w.renameFails = (_a, b) => b === P.app && _a.includes('.new-')
  const m = w.manager_()
  m.install()
  const done = await settle(m)
  assert.equal(done.error.code, 'replace_failed', done.log.join('\n'))
  assert.equal(w.files.get(P.appInfo), before, 'the old app is back in place')
  assert.deepEqual([...w.files.keys()].filter((k) => k.includes('.CURuntime.app.')), [])
  assert.deepEqual(w.ran().slice(-5), ['codesign --verify', 'codesign -d', 'open -g', 'ps -axww', 'ps -axww'],
    'the stopped daemon is checked and started again')
  assert.equal(w.daemons.length, 1)
  assert.equal(w.files.has(P.stopMark), false)
})

test('install: when neither the new build nor the old app can be moved into place, both are kept and named', async () => {
  const w = world()
  w.install()
  w.daemons = [400]
  const before = w.files.get(P.appInfo)
  // The old app moves aside; then nothing can be moved to ~/Applications/CURuntime.app: not the new build, not it back.
  w.renameFails = (_from, to) => to === P.app
  const m = w.manager_()
  m.install()
  const done = await settle(m)
  assert.equal(done.error.code, 'replace_failed')
  const old = join(P.applications, `.CURuntime.app.old-${done.id}`)
  const staged = join(P.applications, `.CURuntime.app.new-${done.id}`)
  assert.ok(done.error.message.includes(`${P.app} is missing`), done.error.message)
  assert.ok(done.error.message.includes(`the installed app is at ${old}`), done.error.message)
  assert.ok(done.error.message.includes(`the new build at ${staged}`), done.error.message)
  assert.equal(w.files.get(join(old, 'Contents/Info.plist')), before, 'the installed app is where the message says')
  assert.match(w.files.get(join(staged, 'Contents/Info.plist')), /120000-nogit/, 'the new build is kept too')
  assert.equal(w.fs.exists(P.app), false)
  // Nothing is started from where the app is not; the message says so too, and the stop mark goes.
  assert.ok(!w.ran().includes('open -g'))
  const said = `the daemon this install stopped is not started again (not_installed: ${P.app} is not installed): a release `
    + 'build must be installed (the plugin page\'s install) to run it again'
  assert.ok(done.error.message.endsWith(`; ${said}`), done.error.message)
  assert.ok(done.log.includes(done.error.message.slice(0, -said.length - 2)), 'where they are: in the task log')
  assert.ok(done.log.includes(said), done.log.join('\n'))
  const record = JSON.parse(w.files.get(P.actionLog).trim().split('\n').at(-1))
  assert.deepEqual([record.code, record.message], ['replace_failed', done.error.message], 'and in the action log')
  assert.deepEqual(record.notRestarted, { code: 'not_installed', message: `${P.app} is not installed` })
  assert.equal(w.files.has(P.stopMark), false)
})

test('install fails with start_failed, and with selfcheck_timeout, after the app was replaced', async () => {
  let w = world()
  w.on['open -g'] = () => ({ code: 1, stdout: '', stderr: 'LSOpenURLsWithRole() failed' })
  let m = w.manager_()
  m.install()
  let done = await settle(m)
  assert.equal(done.error.code, 'start_failed')
  assert.match(w.files.get(P.appInfo), /120000-nogit/)

  w = world({ selfCheck: null })
  m = w.manager_()
  m.install()
  done = await settle(m)
  assert.equal(done.error.code, 'selfcheck_timeout')
  assert.equal(w.daemons.length, 1, 'the new daemon runs')
  assert.ok(w.clock - T0 >= 20_000, 'the result file was waited for 20 s')
})

test('install: the copy that is checked is the copy installed; a build changed after the check does not get in', async () => {
  const w = world()
  w.install()
  w.daemons = [400]
  // While the daemon is being stopped (after the check), the build output is swapped for a bench build signed otherwise.
  const kill = w.system.kill
  w.system.kill = (pid, signal) => {
    w.files.set(join(P.builtApp, 'Contents/Info.plist'), plist('swapped', PKG_HASH, OTHER_SHA, true))
    return kill(pid, signal)
  }
  const m = w.manager_()
  m.install()
  const done = await settle(m)
  assert.equal(done.phase, 'done', done.log.join('\n'))
  assert.match(w.files.get(P.appInfo), /20261020\.120000-nogit/, 'the verified build is installed')
  assert.doesNotMatch(w.files.get(P.appInfo), /swapped/)
  assert.equal(w.calls.filter((c) => c.line.startsWith('ditto ~/Library/Caches/cu-runtime/build/dist')).length, 1,
    'the build output is read once, before the check')
})

test('install refuses to start a replaced app that fails the designated requirement', async () => {
  const w = world()
  // The app in place after the replacement is not what was verified (swapped underneath, right after the rename).
  w.renamed = (_from, to) => {
    if (to === P.app) w.files.set(P.appInfo, plist('swapped', PKG_HASH, OTHER_SHA))
  }
  const m = w.manager_()
  m.install()
  const done = await settle(m)
  assert.equal(done.error.code, 'signature_mismatch')
  assert.equal(done.endedIn, 'start')
  assert.equal(done.log.filter((l) => l.startsWith('== ')).at(-1), '== start')
  assert.ok(!w.ran().includes('open -g'))
})

test('install refuses to start a replaced app that is not a release build', async () => {
  const w = world()
  w.renamed = (_from, to) => {
    if (to === P.app) w.files.set(P.appInfo, plist('swapped', PKG_HASH, SHA, true))
  }
  const m = w.manager_()
  m.install()
  const done = await settle(m)
  assert.equal(done.error.code, 'not_release_build')
  assert.equal(done.endedIn, 'start')
  assert.ok(!w.ran().includes('open -g'))
})

test('cancel during the build: the build is ended, nothing is stopped or replaced, a new install can start', async () => {
  const w = world()
  w.install()
  w.daemons = [400]
  let aborted = false
  w.on['zsh build-app.sh'] = async (_args, options) => {
    await untilAborted(options.signal)
    aborted = true
    return { code: null, stdout: '', stderr: '' }
  }
  const m = w.manager_()
  m.install()
  await reach(m, 'build')
  const r = m.cancel()
  assert.equal(r.ok, true)
  const done = await settle(m)
  assert.equal(done.phase, 'cancelled')
  assert.equal(done.error, null)
  assert.equal(done.endedIn, 'build')
  assert.ok(!done.log.includes(KEYCHAIN_NOTE), 'nothing was being signed')
  assert.ok(aborted, 'the running build was ended')
  assert.equal(w.ran().at(-1), 'zsh build-app.sh')
  assert.deepEqual(w.killed, [])
  assert.deepEqual(m.cancel().error.code, 'no_task')
  delete w.on['zsh build-app.sh']
  const again = m.install()
  assert.notEqual(again.id, done.id)
  assert.equal((await settle(m)).phase, 'done')
})

test('cancel while the daemon is being stopped: it runs again, the app is not replaced', async () => {
  const w = world()
  w.install()
  w.daemons = [400]
  const before = w.files.get(P.appInfo)
  const m = w.manager_()
  w.system.kill = (pid, signal) => {
    w.killed.push([pid, signal])
    w.daemons = []
    m.cancel()
    return true
  }
  m.install()
  const done = await settle(m)
  assert.equal(done.phase, 'cancelled')
  assert.equal(done.endedIn, 'stop')
  assert.equal(w.files.get(P.appInfo), before)
  assert.deepEqual(w.ran().slice(-5), ['codesign --verify', 'codesign -d', 'open -g', 'ps -axww', 'ps -axww'])
  assert.equal(w.daemons.length, 1)
  assert.equal(w.files.has(P.stopMark), false)
  assert.deepEqual([...w.files.keys()].filter((k) => k.includes('.CURuntime.app.')), [], 'the staged copy is removed')
})

test('cancel once the replacement began is refused: the task runs to its end', async () => {
  const w = world()
  const m = w.manager_()
  const refused = []
  w.renamed = (_from, to) => { if (to === P.app) refused.push(m.cancel()) }
  let release
  const gate = new Promise((r) => { release = r })
  w.on['open -g'] = async () => {
    refused.push(m.cancel())
    await gate
    w.daemons.push(w.nextPid++)
    return { code: 0, stdout: '', stderr: '' }
  }
  m.install()
  await until(() => refused.length === 2, m)
  assert.deepEqual(refused.map((r) => [r.ok, r.error.code, r.task.phase]), [[false, 'not_cancellable', 'replace'],
    [false, 'not_cancellable', 'start']])
  release()
  assert.equal((await settle(m)).phase, 'done')
})

test('cancel while the build is being staged: the staged copy is removed, nothing is stopped', async () => {
  const w = world()
  w.install()
  w.daemons = [400]
  const m = w.manager_()
  w.on.ditto = async (args, options) => {
    const copied = w.defaults.ditto(args)
    if (args[0] !== P.builtApp) return copied
    m.cancel()
    await untilAborted(options.signal)
    return { code: null, stdout: '', stderr: '' }
  }
  m.install()
  const done = await settle(m)
  assert.equal(done.phase, 'cancelled')
  assert.equal(done.endedIn, 'verify')
  assert.deepEqual([...w.files.keys()].filter((k) => k.includes('.CURuntime.app.')), [])
  assert.deepEqual(w.killed, [])
})

test('cancel while signing: the task says a keychain dialog may still be open (endedIn sign)', async () => {
  const w = world()
  const m = w.manager_()
  w.on['zsh build-app.sh'] = async (_a, options) => {
    for (const line of [SWIFT_DONE, SIGN_MARKER]) options.onLine(line)
    m.cancel()
    await untilAborted(options.signal)
    return { code: null, stdout: '', stderr: '' }
  }
  m.install()
  const done = await settle(m)
  assert.equal(done.phase, 'cancelled')
  assert.equal(done.endedIn, 'sign')
  assert.equal(done.error, null)
  assert.ok(done.log.includes(KEYCHAIN_NOTE), done.log.join('\n'))
})

test('one install at a time across dsh processes: a live lock makes it busy, a stale one is taken over', async () => {
  let w = world()
  w.files.set(P.lock, JSON.stringify({ pid: 4242, at: T0 - 1000 }))
  let m = w.manager_()
  const busy = m.install()
  assert.equal(busy.phase, 'failed')
  assert.equal(busy.error.code, 'busy')
  assert.equal(busy.endedIn, 'preflight')
  // The message names the holder and the lock file, and when it is taken over.
  assert.equal(busy.error.message, `another dsh process (pid 4242) has been managing the daemon since ${new Date(T0 - 1000).toISOString()}: `
    + `it holds ${P.lock}, which is taken over once that process is gone, 2 h after its last sign of life, or after a `
    + 'restart of the Mac')
  assert.deepEqual(w.calls, [])
  assert.equal(w.files.get(P.lock), JSON.stringify({ pid: 4242, at: T0 - 1000 }), 'another process\'s lock is left alone')
  const refused = await m.start()
  assert.deepEqual([refused.error.code, refused.error.message], ['busy', busy.error.message])

  w = world()
  w.files.set(P.lock, JSON.stringify({ pid: 31337, at: T0 - 1000 }))   // that process is gone
  m = w.manager_()
  m.install()
  assert.equal((await settle(m)).phase, 'done')
  assert.equal(w.files.has(P.lock), false)
})

test('the lock: a holder that is not a live process of this user, a time in the future or too old, or junk, is stale', async () => {
  const held = (lock) => {
    const w = world()
    w.files.set(P.lock, typeof lock === 'string' ? lock : JSON.stringify(lock))
    const task = w.manager_().install()
    return task.phase === 'failed' && task.error.code === 'busy'
  }
  // Live: a process of this user (4242 here), at a time up to now (or a little ahead: the clock was set back).
  assert.equal(held({ pid: 4242, at: T0 }), true)
  assert.equal(held({ pid: 4242, at: T0 + LOCK_SKEW_MS }), true)
  assert.equal(held({ pid: 4242, at: T0 - LOCK_STALE_MS + 1 }), true)
  // Stale: further in the future (it would never age), too old, a process this user may not signal (EPERM: pid 1,
  // another user's: alive() says no), no pid, a pid that names no process, junk.
  assert.equal(held({ pid: 4242, at: T0 + LOCK_SKEW_MS + 1 }), false)
  assert.equal(held({ pid: 4242, at: T0 + 365 * 24 * 3_600_000 }), false)
  assert.equal(held({ pid: 4242, at: T0 - LOCK_STALE_MS }), false)
  assert.equal(held({ pid: 1, at: T0 }), false)
  for (const pid of [0, -1, 4242.5, '4242', null]) assert.equal(held({ pid, at: T0 }), false, String(pid))
  for (const at of ['2026-10-20', null, Number.NaN]) assert.equal(held({ pid: 4242, at }), false, String(at))
  for (const junk of ['', '{', 'null', '42', '[4242]']) assert.equal(held(junk), false, junk)
})

test('nodeSystem().alive: a process this user may signal; not pid 1 (EPERM), not a process group, not a gone pid', () => {
  const sys = nodeSystem()
  assert.equal(sys.alive(process.pid), true)
  assert.equal(sys.alive(1), false, 'launchd: there, but not this user\'s')
  for (const pid of [0, -1, -process.pid, 1.5, Number.NaN]) assert.equal(sys.alive(pid), false, String(pid))
  const gone = execFileSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' }).trim()
  assert.equal(sys.alive(Number(gone)), false)
})

test('nodeSystem().connects: a listening Unix socket accepts, a missing one does not', { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cu-sock-'))
  const path = join(dir, 'daemon.sock')
  const sys = nodeSystem()
  assert.equal(await sys.connects(path, 500), false)
  const server = createServer((c) => c.end())
  await new Promise((r) => server.listen(path, r))
  try {
    assert.equal(await sys.connects(path, 500), true)
  } finally {
    await new Promise((r) => server.close(r))
  }
  assert.equal(await sys.connects(path, 500), false)
})

test('while the task runs, start, stop and restart are busy', async () => {
  const w = world()
  w.install()
  let release
  w.on['zsh build-app.sh'] = () => new Promise((r) => { release = r })
  const m = w.manager_()
  m.install()
  await until(() => release !== undefined, m)
  for (const op of ['start', 'stop', 'restart', 'permissions', 'selfCheck']) {
    assert.equal((await m[op]()).error.code, 'busy', op)
  }
  m.cancel()
  release({ code: null, stdout: '', stderr: '' })
  assert.equal((await settle(m)).phase, 'cancelled')
})

// ------------------------------------------------------------------------------------------------ actions

test('start: the designated requirement is checked first; a mismatch or a missing app is refused and nothing opens', async () => {
  let w = world()
  w.files.set(P.appInfo, plist(w.appVersion, PKG_HASH, OTHER_SHA))
  let r = await w.manager_().start()
  assert.deepEqual(r.error.code, 'signature_mismatch')
  assert.ok(!w.ran().includes('open -g'))

  w = world()
  r = await w.manager_().start()
  assert.equal(r.error.code, 'not_installed')

  w = world({ identities: [] })
  w.install()
  r = await w.manager_().start()
  assert.equal(r.error.code, 'identity_missing')
  assert.ok(!w.ran().includes('open -g'))

  w = world()
  w.install()
  w.files.set(P.stopMark, 'mark')
  r = await w.manager_().start()
  assert.deepEqual(r, { ok: true, error: null })
  assert.deepEqual(w.ran(), ['security find-identity', 'plutil -extract', 'codesign --verify', 'codesign -d', 'ps -axww', 'open -g',
    'ps -axww', 'ps -axww'])
  assert.deepEqual(w.probes, [P.socket])
  assert.equal(w.files.has(P.stopMark), false, 'started from the page: autoStart may start it again')
  assert.deepEqual(JSON.parse(w.files.get(P.actionLog)), { at: new Date(T0 + START_SETTLE_MS).toISOString(), pid: 9999,
    action: 'start', outcome: 'ok', identity: SHA })
})

test('start: up means still running after the settle time and serving its socket; otherwise start_failed says why', async () => {
  // Never shows up.
  let w = world()
  w.install()
  w.on['open -g'] = () => ({ code: 0, stdout: '', stderr: '' })
  let r = await w.manager_().start()
  assert.equal(r.error.code, 'start_failed')
  assert.equal(r.error.message, `no daemon of ${P.app} showed up within 10 s`)

  // Shows up, exits right away (a release build with a bench-only switch on in config.json): the switch is named.
  w = world({ startExits: true })
  w.install()
  w.files.set(P.config, JSON.stringify({ config_grants: true, debug_ime: false, debug_native_images: true, allow_finder: true }))
  r = await w.manager_().start()
  assert.equal(r.error.code, 'start_failed')
  assert.equal(r.error.message, `the daemon (pid 500) exited right after it started; ${P.config} turns on config_grants, `
    + 'debug_native_images, which only a bench build starts with (this release build refuses to): remove them from the file')
  assert.deepEqual(w.probes, [], 'gone before its socket was tried')
  // Without such a switch the message says only what happened.
  w = world({ startExits: true })
  w.install()
  w.files.set(P.config, JSON.stringify({ config_grants: false }))
  assert.equal((await w.manager_().start()).error.message, 'the daemon (pid 500) exited right after it started')

  // Runs, but its socket accepts nothing: tried until the wait is over.
  w = world({ serving: false })
  w.install()
  r = await w.manager_().start()
  assert.equal(r.error.code, 'start_failed')
  assert.equal(r.error.message, `the daemon (pid 500) runs, but ${P.socket} accepted no connection within 10 s`)
  assert.ok(w.probes.length >= 10, String(w.probes.length))
  assert.ok(w.clock - T0 >= 10_000 && w.clock - T0 <= 11_000, String(w.clock - T0))

  // Its socket answers on a later try: started.
  w = world({ serving: false })
  w.install()
  w.system.connects = async (path) => {
    w.probes.push(path)
    return w.probes.length >= 3
  }
  assert.deepEqual(await w.manager_().start(), { ok: true, error: null })
})

test('install: a new daemon that exits right after it started is start_failed, not done, and says why', async () => {
  const w = world({ startExits: true })
  w.files.set(P.config, JSON.stringify({ debug_activation: true }))
  const m = w.manager_()
  m.install()
  const done = await settle(m)
  assert.equal(done.phase, 'failed')
  assert.equal(done.error.code, 'start_failed')
  assert.equal(done.endedIn, 'start')
  assert.match(done.error.message, /exited right after it started; .*config\.json turns on debug_activation, which only a bench build/)
  assert.ok(!w.ran().includes('open -n'), 'no self-check of a daemon that is not up')
})

test('not a release build installed (a bench build, or one from before CUBench): mismatch, not up to date, never started', async () => {
  for (const bench of [true, null]) {
    const w = world()
    w.files.set(P.appInfo, plist(w.appVersion, PKG_HASH, SHA, bench))
    w.files.set(P.appBinary, 'bin')
    w.daemons = [400]
    const m = w.manager_()
    const s = await m.status()
    assert.deepEqual([s.app.signature, s.upToDate, s.app.identitySha1], ['mismatch', false, SHA], String(bench))
    assert.ok(!w.ran().includes('codesign --verify'), 'whoever signed it')
    for (const op of ['start', 'restart', 'permissions', 'selfCheck']) {
      w.calls.length = 0
      const r = await m[op]()
      assert.equal(r.error?.code, 'not_release_build', `${op}: ${JSON.stringify(r)}`)
      assert.match(r.error.message, new RegExp(`CUBench is ${bench ?? 'missing'}, not false`))
      assert.ok(!w.ran().some((l) => l.startsWith('open') || l.startsWith('codesign')), `${op}: ${w.ran()}`)
    }
    assert.deepEqual(w.killed, [], 'restart does not stop it either')
  }
})

test('the action log names the identity an action checked the app against', async () => {
  const w = world()
  w.install()
  const m = w.manager_()
  await m.selfCheck()
  await m.stop()
  const log = w.files.get(P.actionLog).trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(log.map((e) => [e.action, e.outcome, e.identity]), [['selfcheck', 'ok', SHA], ['stop', 'ok', undefined]])
})

test('restart: a mismatching app is refused before the running daemon is stopped', async () => {
  const w = world()
  w.files.set(P.appInfo, plist(w.appVersion, PKG_HASH, OTHER_SHA))
  w.daemons = [400]
  const r = await w.manager_().restart()
  assert.equal(r.error.code, 'signature_mismatch')
  assert.deepEqual(w.killed, [])
  assert.deepEqual(w.daemons, [400])
})

test('stop: SIGTERM to the installed app\'s daemons only, waits for them, and leaves autoStart\'s stop mark', async () => {
  let w = world()
  w.install()
  w.daemons = [400, 401]
  let r = await w.manager_().stop()
  assert.deepEqual(r, { ok: true, error: null })
  assert.deepEqual(w.killed, [[400, 'SIGTERM'], [401, 'SIGTERM']], 'not the self-check (77), not another cu-runtime (78, 79)')
  assert.deepEqual(JSON.parse(w.files.get(P.stopMark)), { boot: 1000, at: new Date(T0).toISOString() })

  w = world({ stubborn: true })
  w.install()
  w.daemons = [400]
  r = await w.manager_().stop()
  assert.equal(r.error.code, 'stop_failed')
  assert.ok(w.clock - T0 >= 10_000)
})

test('the stop mark: one from an earlier boot (or unreadable) is replaced by this boot\'s, one of this boot is left', async () => {
  // Stop: an earlier boot's mark would not keep autoStart off.
  for (const earlier of [stopMarkText(1000 - 3600, T0 - 3_600_000), '{not json']) {
    const w = world()
    w.install()
    w.daemons = [400]
    w.files.set(P.stopMark, earlier)
    assert.deepEqual(await w.manager_().stop(), { ok: true, error: null })
    assert.equal(w.files.get(P.stopMark), stopMarkText(1000, T0))
    assert.equal(stopMarkOfThisBoot(w.files.get(P.stopMark), 1000), true)
  }
  // Install: the mark is this boot's while the app is replaced, and removed once the new daemon runs.
  let w = world()
  w.install()
  w.daemons = [400]
  w.files.set(P.stopMark, stopMarkText(1000 - 3600, T0 - 3_600_000))
  const marks = []
  w.on['open -g'] = () => {
    marks.push(stopMarkOfThisBoot(w.files.get(P.stopMark), 1000))
    w.daemons.push(w.nextPid++)
    return { code: 0, stdout: '', stderr: '' }
  }
  let m = w.manager_()
  m.install()
  assert.equal((await settle(m)).phase, 'done')
  assert.deepEqual(marks, [true])
  assert.equal(w.files.has(P.stopMark), false)
  // A failure before the start: the mark the task wrote over the stale one goes again.
  w = world()
  w.install()
  w.daemons = [400]
  w.files.set(P.stopMark, stopMarkText(1000 - 3600, T0 - 3_600_000))
  w.renameFails = (_a, b) => b === P.app && _a.includes('.new-')
  m = w.manager_()
  m.install()
  assert.equal((await settle(m)).error.code, 'replace_failed')
  assert.equal(w.files.has(P.stopMark), false)
  // A mark of this boot is the person's: kept through a stop, not taken as the task's.
  w = world()
  w.install()
  w.files.set(P.stopMark, stopMarkText(1000 + 30, T0 - 1000))
  await w.manager_().stop()
  assert.equal(w.files.get(P.stopMark), stopMarkText(1000 + 30, T0 - 1000))
})

test('stopMarkOfThisBoot: a mark of this boot (within the boot time\'s jitter) only', () => {
  assert.equal(stopMarkOfThisBoot(stopMarkText(1000, T0), 1000), true)
  assert.equal(stopMarkOfThisBoot(stopMarkText(1100, T0), 1000), true)
  assert.equal(stopMarkOfThisBoot(stopMarkText(1000 - 3600, T0), 1000), false)
  for (const text of [undefined, '', '{', 'null', '{"boot":"1000"}', '[]']) assert.equal(stopMarkOfThisBoot(text, 1000), false, String(text))
})

test('restart: stop, then start through open -g', async () => {
  const w = world()
  w.install()
  w.daemons = [400]
  const r = await w.manager_().restart()
  assert.deepEqual(r, { ok: true, error: null })
  assert.deepEqual(w.killed, [[400, 'SIGTERM']])
  assert.deepEqual(w.daemons, [500])
  assert.equal(w.files.has(P.stopMark), false)
})

test('every command gets the fixed environment only: nothing of dsh\'s CU_*, DYLD_*, PATH, ZDOTDIR…', async () => {
  const w = world({ identities: [] })
  w.install()
  w.daemons = [400]
  const m = w.manager_()
  await m.status()
  m.install()
  assert.equal((await settle(m)).phase, 'done')
  await m.restart()
  await m.permissions()
  await m.installClt()
  assert.ok(w.calls.length > 30)
  for (const c of w.calls) {
    const extra = c.label === 'zsh build-app.sh' ? { CU_SCRATCH: P.buildScratch, CU_DIST: P.buildDist, CU_SIGN_IDENTITY: SHA } : {}
    assert.deepEqual(c.options.env, { ...CHILD_ENV, ...extra }, c.line)
  }
  // Variables dsh does not have are left out, not set empty.
  const bare = world({ env: { PATH: '/usr/bin', SSH_AUTH_SOCK: '/tmp/agent' } })
  await bare.manager_().status()
  for (const c of bare.calls) assert.deepEqual(c.options.env, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME }, c.line)
})

test('permissions: the app asks through LaunchServices, System Settings opens; no grant is ever reset', async () => {
  const w = world()
  w.install()
  let r = await w.manager_().permissions()
  assert.deepEqual(r, { ok: true, error: null })
  const lines = w.calls.map((c) => c.line)
  assert.ok(lines.includes('open -n ~/Applications/CURuntime.app --args request-permissions'))
  assert.ok(lines.includes('open x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'))
  assert.ok(!lines.some((l) => /tccutil/.test(l)))
  // Accessibility already granted (a recent self-check): Screen Recording is the pane to open.
  w.calls.length = 0
  w.files.set(P.selfCheck, JSON.stringify({ version: w.appVersion, ax_trusted: true, sck: { ok: false } }))
  r = await w.manager_().permissions()
  assert.ok(w.calls.some((c) => c.line === 'open x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'))
  // A mismatching app is not launched to ask for permissions.
  const bad = world()
  bad.files.set(P.appInfo, plist(bad.appVersion, PKG_HASH, OTHER_SHA))
  assert.equal((await bad.manager_().permissions()).error.code, 'signature_mismatch')
  assert.ok(!bad.ran().includes('open -n'))
})

test('permissions: one System Settings pane per call, Accessibility until a self-check shows it granted; never tccutil', async () => {
  const w = world()
  w.install()
  const { call } = hostOn(w)
  const panes = []
  for (const result of [null, { ax: false, sck: false }, { ax: true, sck: false }, { ax: true, sck: true }]) {
    if (result === null) w.files.delete(P.selfCheck)
    else w.files.set(P.selfCheck, JSON.stringify({ version: w.appVersion, ax_trusted: result.ax, sck: { ok: result.sck } }))
    w.calls.length = 0
    assert.deepEqual((await call('permissions')).body, { ok: true, error: null })
    const pane = w.ran().at(-1)
    // Every command of the call, in order: nothing else runs (no tccutil reset, no second pane).
    assert.deepEqual(w.ran(), ['security find-identity', 'plutil -extract', 'codesign --verify', 'codesign -d', 'open -n',
      'plutil -extract', pane])
    assert.match(pane, /^open x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_\w+$/)
    panes.push(pane.split('?')[1])
  }
  assert.deepEqual(panes, ['Privacy_Accessibility', 'Privacy_Accessibility', 'Privacy_ScreenCapture', 'Privacy_ScreenCapture'])
  // No code path of the host service can run it: no executable of that name, no mention outside comments.
  assert.ok(!Object.values(BIN).some((b) => /tccutil/.test(b)))
  const lib = join(PKG, 'plugin/lib')
  const modules = ['host.js', ...readdirSync(join(lib, 'daemon')).filter((f) => f.endsWith('.js')).map((f) => `daemon/${f}`)]
  assert.ok(modules.includes('daemon/manager.js'))
  for (const f of modules) {
    const code = readFileSync(join(lib, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.doesNotMatch(code, /tccutil/, f)
  }
})

test('selfcheck: runs the installed app\'s self-check and the status shows its result', async () => {
  const w = world({ selfCheck: { ax: false, sck: true } })
  w.install()
  const m = w.manager_()
  assert.equal((await m.status()).permissions, null)
  assert.deepEqual(await m.selfCheck(), { ok: true, error: null })
  assert.deepEqual((await m.status()).permissions, { accessibility: false, screenRecording: true })
})

test('clt: runs xcode-select --install and nothing else', async () => {
  const w = world({ clt: false })
  const { call } = hostOn(w)
  const { body } = await call('clt', { body: JSON.stringify({ args: ['--switch', '/tmp'] }) })
  assert.deepEqual(body, { ok: true, error: null })
  assert.deepEqual(w.calls.map((c) => c.line), ['xcode-select --install'])
  w.on['xcode-select --install'] = () => ({ code: 1, stdout: '', stderr: 'xcode-select: note: Command line tools are already installed.' })
  assert.equal((await call('clt')).body.error.code, 'clt_install_failed')
})

test('the host going away cancels a task that can still be cancelled, and waits for it to end', async () => {
  const w = world()
  w.on['zsh build-app.sh'] = async (_a, options) => {
    await untilAborted(options.signal)
    return { code: null, stdout: '', stderr: '' }
  }
  const { effects, call } = hostOn(w)
  await call('install')
  for (let i = 0; i < 1000 && (await call('status')).body.task.phase !== 'build'; i++) await new Promise((r) => setImmediate(r))
  await Promise.all(effects.map((dispose) => dispose()))
  const task = (await call('status')).body.task
  assert.equal(task.phase, 'cancelled', JSON.stringify(task))
  assert.equal(task.endedIn, 'build')
})

test('the host going away while the task stops the daemon: the disposal ends after the daemon runs again', async () => {
  const w = world()
  w.install()
  w.daemons = [400]
  const { effects, call } = hostOn(w)
  let disposing
  w.system.kill = (pid, signal) => {
    w.killed.push([pid, signal])
    w.daemons = []
    disposing = Promise.all(effects.map((dispose) => dispose()))
    return true
  }
  await call('install')
  await eventually(() => disposing !== undefined)
  await disposing
  const task = (await call('status')).body.task
  assert.equal(task.phase, 'cancelled', JSON.stringify(task))
  assert.equal(task.endedIn, 'stop')
  assert.equal(w.daemons.length, 1, 'the daemon that was stopped runs again')
  assert.equal(w.files.has(P.stopMark), false, 'the stop mark the task left is gone')
  assert.ok(task.log.includes('the plugin is being unloaded: cancel requested'))
})

test('dispose waits a bounded time: a task past the cancellable phases runs on', { timeout: 10_000 }, async () => {
  const w = world()
  let release
  w.on['open -n'] = () => new Promise((r) => { release = r })   // the self-check never comes back
  const m = w.manager_({ disposeWaitMs: 50 })
  m.install()
  await until(() => release !== undefined, m)
  const at = Date.now()
  await m.dispose()
  assert.ok(Date.now() - at >= 40, 'it waited')
  assert.equal(m.taskState().phase, 'selfcheck', 'and the task goes on')
  release({ code: 0, stdout: '', stderr: '' })
  await settle(m)
})

test('a row reloaded while the task runs: the new manager reports that task, joins it, is busy, and shows how it ended', async () => {
  const w = world()
  let release
  w.on['open -n'] = () => new Promise((r) => { release = r })
  const first = hostOn(w)
  const started = (await first.call('install')).body
  await eventually(() => release !== undefined)
  // The row is reloaded: the old one's disposal (bounded) is over, the task still runs.
  const old = w.manager_({ disposeWaitMs: 10 })
  await old.dispose()
  const second = hostOn(w)
  const seen = (await second.call('status')).body.task
  assert.deepEqual([seen.id, seen.phase], [started.id, 'selfcheck'], 'not task: null')
  assert.equal((await second.call('install')).body.id, started.id, 'install joins it')
  assert.deepEqual((await second.call('start')).body.error.code, 'busy')
  // Its outcome shows on the new row's page.
  release({ code: 0, stdout: '', stderr: '' })
  for (let i = 0; i < 10_000 && (await second.call('status')).body.task.phase === 'selfcheck'; i++) await new Promise((r) => setImmediate(r))
  const ended = (await second.call('status')).body.task
  assert.deepEqual([ended.id, ended.phase, ended.error?.code], [started.id, 'failed', 'selfcheck_timeout'])
  // Another System (another dsh process) has its own: none.
  assert.equal((await world().manager_().status()).task, null)
})

// ------------------------------------------------------------------------------------------------ hardened runtime

test('HARDENED_RUNTIME: the runtime flag among the CodeDirectory flags, as build-app.sh matches it', () => {
  for (const flags of ['0x10000(runtime)', '0x12000(library-validation,runtime)', '0x10002(adhoc,runtime)',
    '0x10200(kill,runtime,restrict)']) {
    assert.match(`CodeDirectory v=20500 size=1 flags=${flags} hashes=1+1`, HARDENED_RUNTIME, flags)
  }
  for (const flags of ['0x0(none)', '0x2(adhoc)', '0x10000(runtimeX)', '0x10000(noruntime)', '0x10000', '0x10000()']) {
    assert.doesNotMatch(`CodeDirectory v=20500 size=1 flags=${flags} hashes=1+1\nRuntime Version=26.0.0`, HARDENED_RUNTIME, flags)
  }
})

test('hardened runtime: an installed app signed without it is mismatch, never started, launched or stopped from here', async () => {
  for (const flags of ['0x0(none)', '0x2(adhoc)']) {
    const w = world()
    w.files.set(P.appInfo, plist(w.appVersion, PKG_HASH, SHA, false, flags))
    w.files.set(P.appBinary, 'bin')
    w.daemons = [400]
    const m = w.manager_()
    const s = await m.status()
    assert.equal(s.app.signature, 'mismatch', flags)
    assert.ok(w.calls.some((c) => c.line === 'codesign -d --verbose=1 ~/Applications/CURuntime.app'))
    for (const op of ['start', 'restart', 'permissions', 'selfCheck']) {
      w.calls.length = 0
      const r = await m[op]()
      assert.deepEqual(r.error, { code: 'not_release_build', message: `${P.app} is signed without hardened runtime `
        + `(codesign -d shows flags=${flags}): reinstall it` }, `${op} ${flags}`)
      assert.ok(!w.ran().some((l) => l.startsWith('open')), `${op}: ${w.ran()}`)
    }
    assert.deepEqual(w.killed, [], 'restart does not stop it either')
  }
  // codesign -d cannot show the flags: not taken as hardened.
  const w = world()
  w.install()
  w.on['codesign -d'] = () => ({ code: 1, stdout: '', stderr: 'codesign: internal error' })
  const r = await w.manager_().start()
  assert.deepEqual(r.error, { code: 'not_release_build', message: `${P.app} is signed without hardened runtime (codesign -d `
    + 'shows no CodeDirectory flags: codesign: internal error): reinstall it' })
  assert.equal((await w.manager_().status()).app.signature, 'mismatch')
})

// ------------------------------------------------------------------------------------------------ the shared app check

/** An installed app's Info.plist and binary at `app` (default the installed path), as build-app.sh leaves them. */
function installAt(w, app = P.app, { signer = SHA, bench = false, flags = RUNTIME_FLAGS } = {}) {
  w.files.set(join(app, 'Contents/Info.plist'), plist(w.appVersion, PKG_HASH, signer, bench, flags))
  w.files.set(join(app, 'Contents/MacOS/cu-runtime'), 'bin')
}

/** The verdicts the host's rules give (Status signature aside); each world is checked by both the export and start(). */
const VERDICTS = [
  ['a release build of the one identity, hardened', (w) => installAt(w), null],
  ['not installed', () => {}, 'not_installed'],
  ['no identity of the name', (w) => { installAt(w); w.identities = [] }, 'identity_missing'],
  ['security find-identity failing (none listed)', (w) => {
    installAt(w)
    w.on['security find-identity'] = () => ({ code: 1, stdout: '', stderr: 'security: SecKeychainSearchCopyNext failed' })
  }, 'identity_missing'],
  ['several identities of the name', (w) => { installAt(w); w.identities = [SHA, OTHER_SHA] }, 'identity_ambiguous'],
  ['CUBench true (a bench build)', (w) => installAt(w, P.app, { bench: true }), 'not_release_build'],
  ['CUBench missing (an older build)', (w) => installAt(w, P.app, { bench: null }), 'not_release_build'],
  ['signed by another certificate', (w) => installAt(w, P.app, { signer: OTHER_SHA }), 'signature_mismatch'],
  ['codesign --verify failing', (w) => {
    installAt(w)
    w.on['codesign --verify'] = () => ({ code: 1, stdout: '', stderr: 'a sealed resource is missing or invalid' })
  }, 'signature_mismatch'],
  ['signed without hardened runtime', (w) => installAt(w, P.app, { flags: '0x0(none)' }), 'not_release_build'],
  ['codesign -d failing (no flags shown)', (w) => {
    installAt(w)
    w.on['codesign -d'] = () => ({ code: 1, stdout: '', stderr: 'codesign: internal error' })
  }, 'not_release_build'],
]
/** The commands the check runs: it only reads. */
const CHECK_COMMANDS = new Set(['plutil -extract', 'security find-identity', 'codesign --verify', 'codesign -d'])

test("the shared check (installedAppVerifier, autoStart's) gives the manager's verdicts, running only reads, as the host runs commands", async () => {
  for (const [what, arrange, code] of VERDICTS) {
    const w = world()
    arrange(w)
    const verdict = await installedAppVerifier(w.system)(P.app)
    assert.equal(verdict?.code ?? null, code, what)
    assert.ok(w.calls.every((c) => CHECK_COMMANDS.has(c.label)), `${what}: ${w.ran()}`)
    for (const c of w.calls) {
      assert.deepEqual(c.options.env, CHILD_ENV, `${what}: ${c.line}`)
      assert.ok(c.options.timeoutMs > 0, `${what}: ${c.line}`)
    }
    // The manager refuses to start the same app with the same TaskError (or starts it).
    w.calls.length = 0
    const r = await w.manager_().start()
    assert.deepEqual(r.error, verdict, `${what}: the manager's start`)
    assert.equal(w.ran().includes('open -g'), code === null, `${what}: ${w.ran()}`)
  }
})

test('the shared check checks the app it is given (autoStart: the configured appPath), not the installed path', async () => {
  const other = join(HOME, 'Elsewhere/CURuntime.app')
  const w = world()
  installAt(w)
  assert.deepEqual(await installedAppVerifier(w.system)(other), { code: 'not_installed', message: `${other} is not installed` })
  installAt(w, other, { bench: true })
  assert.deepEqual(await installedAppVerifier(w.system)(other), { code: 'not_release_build', message: `${other} is not a `
    + 'release build: its Info.plist CUBench is true, not false' })
  installAt(w, other)
  w.calls.length = 0
  assert.equal(await installedAppVerifier(w.system)(other), null)
  assert.ok(w.calls.some((c) => c.line === `codesign --verify --strict -R ${requirementFor(SHA)} ~/Elsewhere/CURuntime.app`), w.ran())
})

test("the manager's own check is the shared one (verifyApp): its rules are written once", () => {
  const src = readFileSync(new URL('../src/daemon/manager.ts', import.meta.url), 'utf8')
  const body = /\n {2}private verifyInstalled\([^\n]*\n([\s\S]*?)\n {2}\}\n/.exec(src)?.[1]
  assert.match(body ?? '', /^ {4}return verifyApp\(this\.paths\.app, /)
  assert.match(src, /\n {2}private checkApp\([^\n]*\n {4}return checkAppWith\(app, identities, run, sourceHash\)\n {2}\}\n/)
  assert.equal(src.match(/HARDENED_RUNTIME\.test\(/g)?.length, 1, 'one hardened-runtime rule')
  assert.equal(src.match(/bench !== 'false'/g)?.length, 1, 'one CUBench rule')
})

// ------------------------------------------------------------------------------------------------ the stop mark of a task that ends

/** The action log's records. */
const records = (w) => (w.files.get(P.actionLog) ?? '').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l))

test('an install that stopped a daemon it may not start again (an older build without CUBench, or one without hardened runtime): '
  + 'its stop mark goes, and the log says why and that a release build must be installed', async () => {
  for (const [what, old] of [['no CUBench', plist('20261020.133925-b071a06', null, SHA, null, '0x0(none)')],
    ['no hardened runtime', plist('20261020.150000-abc1234', PKG_HASH, SHA, false, '0x0(none)')]]) {
    // Cancelled while the daemon is stopped.
    let w = world()
    w.files.set(P.appInfo, old)
    w.files.set(P.appBinary, 'bin')
    w.daemons = [400]
    let m = w.manager_()
    w.system.kill = (pid, signal) => {
      w.killed.push([pid, signal])
      w.daemons = []
      m.cancel()
      return true
    }
    m.install()
    let done = await settle(m)
    assert.deepEqual([done.phase, done.endedIn, done.error], ['cancelled', 'stop', null], what)
    assert.equal(w.files.get(P.appInfo), old, 'not replaced')
    assert.deepEqual(w.daemons, [], 'not started again')
    assert.equal(w.files.has(P.stopMark), false, `${what}: autoStart does not take it for a stop by the user`)
    const said = done.log.find((l) => l.startsWith('the daemon this install stopped is not started again (not_release_build: '))
    assert.ok(said?.endsWith('): a release build must be installed (the plugin page\'s install) to run it again'), done.log.join('\n'))
    assert.equal(records(w).at(-1).notRestarted.code, 'not_release_build')
    assert.equal((await m.start()).error.code, 'not_release_build', 'the page does not start it either')

    // replace_failed: the failure's message says it too.
    w = world()
    w.files.set(P.appInfo, old)
    w.files.set(P.appBinary, 'bin')
    w.daemons = [400]
    w.renameFails = (from, to) => to === P.app && from.includes('.new-')
    m = w.manager_()
    m.install()
    done = await settle(m)
    assert.equal(done.error.code, 'replace_failed', what)
    assert.match(done.error.message, /; the daemon this install stopped is not started again \(not_release_build: .*\): a release build must be installed/)
    assert.equal(records(w).at(-1).message, done.error.message)
    assert.equal(w.files.has(P.stopMark), false)
  }
})

test('the stop mark a task left goes also when the daemon it stopped could not be started; a mark of the user\'s stays', async () => {
  // The old daemon's app is fine, but it does not come up again (replace failed, then the start fails).
  let w = world()
  w.install()
  w.daemons = [400]
  w.renameFails = (from, to) => to === P.app && from.includes('.new-')
  w.on['open -g'] = () => ({ code: 1, stdout: '', stderr: 'LSOpenURLsWithRole() failed' })
  let m = w.manager_()
  m.install()
  let done = await settle(m)
  assert.equal(done.error.code, 'replace_failed')
  assert.ok(done.error.message.endsWith('; the daemon this install stopped could not be started again (start_failed: open: '
    + 'LSOpenURLsWithRole() failed)'), done.error.message)
  assert.equal(w.files.has(P.stopMark), false)
  // The new daemon does not start after the replacement.
  w = world({ startExits: true })
  w.install()
  w.daemons = [400]
  m = w.manager_()
  m.install()
  done = await settle(m)
  assert.deepEqual([done.error.code, done.endedIn], ['start_failed', 'start'])
  assert.equal(w.files.has(P.stopMark), false)
  // A stop mark of this boot that was there before is the user's: the task did not leave it and leaves it alone.
  w = world()
  w.install()
  w.daemons = [400]
  const users = stopMarkText(1000, T0 - 60_000)
  w.files.set(P.stopMark, users)
  w.renameFails = (from, to) => to === P.app && from.includes('.new-')
  w.on['open -g'] = () => ({ code: 1, stdout: '', stderr: 'failed' })
  m = w.manager_()
  m.install()
  await settle(m)
  assert.equal(w.files.get(P.stopMark), users)
})

test('restart: a failed start removes the stop mark the restart left, a mark of the user\'s stays', async () => {
  let w = world({ startExits: true })
  w.install()
  w.daemons = [400]
  let r = await w.manager_().restart()
  assert.equal(r.error.code, 'start_failed')
  assert.equal(w.files.has(P.stopMark), false, 'not a stop by the user')
  w = world({ stubborn: true })
  w.install()
  w.daemons = [400]
  r = await w.manager_().restart()
  assert.equal(r.error.code, 'stop_failed')
  assert.equal(w.files.has(P.stopMark), false)
  w = world({ startExits: true })
  w.install()
  w.daemons = [400]
  const users = stopMarkText(1000, T0 - 60_000)
  w.files.set(P.stopMark, users)
  r = await w.manager_().restart()
  assert.equal(r.error.code, 'start_failed')
  assert.equal(w.files.get(P.stopMark), users)
})

// ------------------------------------------------------------------------------------------------ an identity the install creates

/** A task's records in the action log, as [action, outcome, identity, identityCreated]. */
const taskRecords = (w, id) => records(w).filter((e) => e.task === id).map((e) => [e.action, e.outcome, e.identity, e.identityCreated])

/** The next install after one that created the identity: it finds it on record, as no new one. */
async function nextInstallFindsItOnRecord(w, m) {
  for (const label of Object.keys(w.on)) delete w.on[label]
  const s = await m.status()
  assert.deepEqual([s.app.identitySha1, s.app.identityKnown, s.app.identityChanged], [SHA, SHA, false])
  w.calls.length = 0
  m.install()
  const next = await settle(m)
  assert.equal(next.phase, 'done', next.log.join('\n'))
  assert.ok(next.log.includes(`identity cu-runtime-signing ${fp(SHA)} (the one on record)`), next.log.join('\n'))
  assert.ok(!w.ran().includes('zsh make-signing-identity.sh'))
  assert.deepEqual(taskRecords(w, next.id), [['install', 'started', undefined, undefined], ['install', 'done', SHA, undefined]])
}

test('an identity the install creates is on record when the task is cancelled while make-signing-identity.sh runs', async () => {
  const w = world({ identities: [] })
  const m = w.manager_()
  w.on['zsh make-signing-identity.sh'] = async (_a, options) => {
    w.identities = [SHA]   // security import has committed, the script has said so; keeping the certificate still runs
    options.onLine(createdLine(SHA))
    m.cancel()
    await untilAborted(options.signal)
    return { code: null, stdout: '', stderr: '' }
  }
  m.install()
  const done = await settle(m)
  assert.deepEqual([done.phase, done.endedIn], ['cancelled', 'identity'])
  assert.ok(done.log.includes(`identity cu-runtime-signing ${fp(SHA)}: created by this install`), done.log.join('\n'))
  assert.deepEqual(taskRecords(w, done.id), [['install', 'started', undefined, undefined], ['identity', 'created', SHA, undefined],
    ['install', 'cancelled', SHA, true]])
  assert.equal(w.files.get(P.knownIdentity), `${SHA}\n`)
  await nextInstallFindsItOnRecord(w, m)
})

test('an identity the install creates is on record when the cancel comes right after make-signing-identity.sh exits', async () => {
  const w = world({ identities: [] })
  const m = w.manager_()
  let made = false
  w.on['zsh make-signing-identity.sh'] = (_a, options) => {
    w.identities = [SHA]
    made = true
    options.onLine(createdLine(SHA))
    return { code: 0, stdout: `${createdLine(SHA)}\n`, stderr: '' }
  }
  // The cancel arrives while the identities are listed again.
  w.on['security find-identity'] = () => {
    if (made) m.cancel()
    return w.defaults['security find-identity']()
  }
  m.install()
  const done = await settle(m)
  assert.deepEqual([done.phase, done.endedIn], ['cancelled', 'identity'])
  assert.deepEqual(taskRecords(w, done.id), [['install', 'started', undefined, undefined], ['identity', 'created', SHA, undefined],
    ['install', 'cancelled', SHA, true]])
  assert.equal(w.files.get(P.knownIdentity), `${SHA}\n`)
  await nextInstallFindsItOnRecord(w, m)
})

test('an identity the install creates is on record when the host goes away while make-signing-identity.sh runs', async () => {
  const w = world({ identities: [] })
  let disposing
  let effects
  w.on['zsh make-signing-identity.sh'] = async (_a, options) => {
    w.identities = [SHA]
    options.onLine(createdLine(SHA))
    disposing = Promise.all(effects.map((dispose) => dispose()))
    await untilAborted(options.signal)
    return { code: null, stdout: '', stderr: '' }
  }
  const row = hostOn(w)
  effects = row.effects
  await row.call('install')
  await eventually(() => disposing !== undefined)
  await disposing
  const task = (await row.call('status')).body.task
  assert.deepEqual([task.phase, task.endedIn], ['cancelled', 'identity'])
  assert.ok(task.log.includes('the plugin is being unloaded: cancel requested'))
  assert.deepEqual(taskRecords(w, task.id), [['install', 'started', undefined, undefined], ['identity', 'created', SHA, undefined],
    ['install', 'cancelled', SHA, true]])
  assert.equal(w.files.get(P.knownIdentity), `${SHA}\n`)
})

test('make-signing-identity.sh ends without success after its import: identity_failed, and the identity is on record', async () => {
  const w = world({ identities: [] })
  w.on['zsh make-signing-identity.sh'] = (_a, options) => {
    w.identities = [SHA]
    options.onLine(createdLine(SHA))
    return { code: null, timedOut: true, stdout: '', stderr: 'cp hung' }
  }
  const m = w.manager_()
  m.install()
  const done = await settle(m)
  assert.equal(done.error.code, 'identity_failed')
  assert.equal(done.error.message, 'make-signing-identity.sh timed out after 2 min: cp hung; the identity it created is on record')
  assert.deepEqual(taskRecords(w, done.id).slice(1), [['identity', 'created', SHA, undefined], ['install', 'failed', SHA, true]])
  assert.equal(w.files.get(P.knownIdentity), `${SHA}\n`)
})

test('a new identity in place of the one on record (deleted): created, put on record, and the log says the old one is gone', async () => {
  const w = world({ identities: [] })
  w.files.set(P.knownIdentity, `${OTHER_SHA}\n`)
  w.on['zsh make-signing-identity.sh'] = (_a, options) => {
    w.identities = [SHA]
    options.onLine(createdLine(SHA))
    return { code: 0, stdout: '', stderr: '' }
  }
  const m = w.manager_()
  m.install()
  const done = await settle(m)
  assert.equal(done.phase, 'done', done.log.join('\n'))
  assert.ok(done.log.includes(`the identity on record before (SHA-1 ${fp(OTHER_SHA)}) is not in the keychain any more: `
    + 'permissions granted to the apps it signed do not carry over to the new one'), done.log.join('\n'))
  assert.equal(w.files.get(P.knownIdentity), `${SHA}\n`)
})

// ------------------------------------------------------------------------------------------------ the identity on record

test('fingerprint: a SHA-1 as openssl -fingerprint prints it', () => {
  assert.equal(fingerprint('3c6eb892' + '0'.repeat(28) + '88c7'), '3C:6E:B8:92:' + '00:'.repeat(14) + '88:C7')
  assert.equal(fingerprint(SHA), fp(SHA))
})

test('the identity on record: one line of 40 upper-case hex digits; anything else is none', async () => {
  for (const [text, known] of [[`${SHA}\n`, SHA], [SHA, SHA], [`${SHA.toLowerCase()}\n`, null], [`${SHA}\n${SHA}\n`, null],
    [`${SHA.slice(1)}\n`, null], [`${SHA}\r\n`, null], [` ${SHA}\n`, null], ['', null], [undefined, null]]) {
    const w = world()
    if (text !== undefined) w.files.set(P.knownIdentity, text)
    const s = await w.manager_().status()
    assert.equal(s.app.identityKnown, known, JSON.stringify(text))
    assert.equal(s.app.identityChanged, false, JSON.stringify(text))
  }
})

test('a changed identity: status says so, install refuses in preflight before anything changes, acceptIdentity records it', async () => {
  const w = world()
  w.install()   // signed by SHA, the identity on record
  w.daemons = [400]
  w.files.set(P.knownIdentity, `${SHA}\n`)
  w.identities = [OTHER_SHA]   // another identity of the name in its place
  const { call } = hostOn(w)
  let s = (await call('status')).body
  assert.deepEqual([s.app.identity, s.app.identitySha1, s.app.identityKnown, s.app.identityChanged, s.app.signature],
    ['present', OTHER_SHA, SHA, true, 'mismatch'])
  // install: refused in preflight, after the identities are listed, before anything else runs or changes.
  w.calls.length = 0
  const before = new Map(w.files)
  await call('install')
  let task
  for (let i = 0; i < 1000 && !['done', 'failed', 'cancelled'].includes((task = (await call('status')).body.task).phase); i++) {
    await new Promise((r) => setImmediate(r))
  }
  assert.deepEqual([task.phase, task.endedIn, task.error.code], ['failed', 'preflight', 'identity_changed'])
  assert.equal(task.error.message, `the code-signing identity "cu-runtime-signing" in the keychain (SHA-1 ${fp(OTHER_SHA)}) `
    + `is not the one this host last signed with or created (SHA-1 ${fp(SHA)}): nothing is built or signed until the owner `
    + 'has compared the current SHA-1 with the backed-up certificate (openssl x509 -noout -fingerprint -sha1 -in <the cert.pem '
    + 'kept with the identity\'s .p12 backup>) and accepted it on the plugin page')
  assert.doesNotMatch(task.error.message, /find-identity/)
  const ran = w.ran().filter((l) => !['plutil -extract', 'codesign --verify', 'ps -axww'].includes(l))   // the status polls
  assert.deepEqual([...new Set(ran)].sort(), ['launchctl managername', 'security find-identity', 'xcode-select -p'])
  assert.ok(!w.ran().includes('zsh build-app.sh') && !w.ran().includes('ditto'))
  assert.deepEqual(w.killed, [])
  for (const [path, text] of before) if (path !== P.actionLog) assert.equal(w.files.get(path), text, path)
  assert.equal(w.files.has(P.lock), false)
  assert.deepEqual(records(w).at(-1), { at: new Date(w.clock).toISOString(), pid: 9999, action: 'install', task: task.id,
    outcome: 'failed', code: 'identity_changed', message: task.error.message })
  // The owner accepts it: on record now, with the action log saying from what to what.
  assert.deepEqual((await call('acceptIdentity', { body: JSON.stringify({ sha1: SHA }) })).body, { ok: true, error: null })
  assert.equal(w.files.get(P.knownIdentity), `${OTHER_SHA}\n`)
  assert.deepEqual(records(w).at(-1), { at: new Date(w.clock).toISOString(), pid: 9999, action: 'identity', outcome: 'accepted',
    previous: SHA, current: OTHER_SHA })
  s = (await call('status')).body
  assert.deepEqual([s.app.identityKnown, s.app.identityChanged], [OTHER_SHA, false])
  // Nothing more to accept: nothing changes, nothing is recorded.
  const count = records(w).length
  assert.deepEqual((await call('acceptIdentity')).body, { ok: true, error: null })
  assert.equal(records(w).length, count)
  assert.equal(w.files.has(P.lock), false)
  // The install goes ahead now (the build signed with the accepted identity).
  w.builtSigner = OTHER_SHA
  const m = w.manager_()
  m.install()
  assert.equal((await settle(m)).phase, 'done')
})

test('acceptIdentity changes nothing unless the identity changed: none on record, none, several, the one on record', async () => {
  for (const [identities, known] of [[[SHA], undefined], [[], `${SHA}\n`], [[SHA, OTHER_SHA], `${OTHER_SHA}\n`], [[SHA], `${SHA}\n`],
    [[OTHER_SHA], 'junk\n']]) {
    const w = world({ identities })
    if (known !== undefined) w.files.set(P.knownIdentity, known)
    const m = w.manager_()
    assert.equal((await m.status()).app.identityChanged, false)
    assert.deepEqual(await m.acceptIdentity(), { ok: true, error: null })
    assert.equal(w.files.get(P.knownIdentity), known, JSON.stringify(identities))
    assert.deepEqual(records(w), [])
  }
})

test('acceptIdentity is busy while the install task runs or another process holds the lock; a write failure is no ok', async () => {
  let w = world()
  w.files.set(P.knownIdentity, `${OTHER_SHA}\n`)   // changed: SHA is in the keychain
  w.files.set(P.lock, JSON.stringify({ pid: 4242, at: T0 - 1000 }))
  let r = await w.manager_().acceptIdentity()
  assert.equal(r.error.code, 'busy')
  assert.equal(w.files.get(P.knownIdentity), `${OTHER_SHA}\n`)
  // The task runs (it is past preflight here: the identity was the one on record then).
  w = world()
  w.files.set(P.knownIdentity, `${SHA}\n`)
  let release
  w.on['zsh build-app.sh'] = (args, options) => new Promise((resolve) => { release = () => resolve(w.defaults['zsh build-app.sh'](args, options)) })
  const m = w.manager_()
  m.install()
  await until(() => release !== undefined, m)
  w.identities = [OTHER_SHA]
  r = await m.acceptIdentity()
  assert.deepEqual([r.ok, r.error.code], [false, 'busy'])
  assert.equal(w.files.get(P.knownIdentity), `${SHA}\n`)
  release()
  await settle(m)
  // The file cannot be written.
  w = world()
  w.files.set(P.knownIdentity, `${OTHER_SHA}\n`)
  w.renameFails = (_from, to) => to === P.knownIdentity
  const shown = w.manager_()
  assert.equal((await shown.status()).app.identityChanged, true)
  r = await shown.acceptIdentity()
  assert.equal(r.error.code, 'internal')
  assert.match(r.error.message, /cannot write .*known-identity: Error: rename .*EPERM/)
  assert.equal(w.files.get(P.knownIdentity), `${OTHER_SHA}\n`)
  assert.deepEqual([records(w).at(-1).outcome, records(w).at(-1).previous, records(w).at(-1).current], ['failed', OTHER_SHA, SHA])
  assert.deepEqual([...w.files.keys()].filter((k) => k.includes('known-identity.')), [], 'no partial file is left')
})

const THIRD_SHA = 'EF'.repeat(20)

test('the known identity: the one on record, else the installed app\'s certificate (read, never put on record), else none', async () => {
  // On record: 'record'; the installed app's certificate is not read then.
  let w = world()
  w.install()
  w.files.set(P.knownIdentity, `${SHA}\n`)
  let s = (await w.manager_().status()).app
  assert.deepEqual([s.identityKnown, s.identityKnownSource, s.identityChanged], [SHA, 'record', false])
  assert.ok(!w.ran().includes('openssl x509'))
  // None on record (no file, or one that is not one SHA-1): the installed app's leaf certificate, display only.
  for (const text of [undefined, 'junk\n']) {
    w = world()
    w.install()
    if (text !== undefined) w.files.set(P.knownIdentity, text)
    s = (await w.manager_().status()).app
    assert.deepEqual([s.identityKnown, s.identityKnownSource, s.identityChanged], [SHA, 'installedApp', false], String(text))
    assert.equal(w.files.get(P.knownIdentity), text, 'nothing is put on record')
    assert.deepEqual([...w.files.keys(), ...w.dirs].filter((k) => k.includes('installed-cert')), [], 'the extracted certificate goes')
    const codesign = w.calls.filter((c) => c.label.startsWith('codesign')).map((c) => c.line)
    assert.ok(codesign.every((l) => /^codesign (--verify|-d) /.test(l)) && !codesign.some((l) => / (-s|--sign) /.test(l)), codesign.join('\n'))
    assert.match(w.calls.find((c) => c.label === 'openssl x509').line,
      /^openssl x509 -inform DER -noout -fingerprint -sha1 -in ~\/Library\/Caches\/cu-runtime\/installed-cert\.[0-9a-f-]{36}\/cert0$/)
  }
  // The one identity did not sign the installed app: changed, before anything is on record.
  w = world({ identities: [OTHER_SHA] })
  w.install()
  s = (await w.manager_().status()).app
  assert.deepEqual([s.identityKnown, s.identityKnownSource, s.identityChanged], [SHA, 'installedApp', true])
  // Not installed, unsigned, ad-hoc, a certificate that cannot be read: none known.
  for (const [what, setup] of [['not installed', () => {}],
    ['unsigned', (v) => v.files.set(P.appInfo, plist(v.appVersion, PKG_HASH, 'none'))],
    ['ad-hoc', (v) => v.files.set(P.appInfo, plist(v.appVersion, PKG_HASH, 'adhoc'))],
    ['unreadable', (v) => { v.install(); v.on['openssl x509'] = () => ({ code: 1, stdout: '', stderr: 'unable to load certificate' }) }]]) {
    w = world({ identities: [OTHER_SHA] })
    setup(w)
    s = (await w.manager_().status()).app
    assert.deepEqual([s.identityKnown, s.identityKnownSource, s.identityChanged], [null, null, false], what)
    assert.deepEqual([...w.files.keys(), ...w.dirs].filter((k) => k.includes('installed-cert')), [], what)
  }
})

test('nothing on record, the installed app signed by another identity: install refuses, acceptIdentity puts the current one on record', async () => {
  const w = world({ identities: [OTHER_SHA] })
  w.install()   // signed by SHA, before any record (a Mac upgrading from a host without it)
  w.daemons = [400]
  const m = w.manager_()
  assert.equal((await m.status()).app.identityChanged, true)
  m.install()
  const task = await settle(m)
  assert.deepEqual([task.phase, task.endedIn, task.error.code], ['failed', 'preflight', 'identity_changed'])
  assert.equal(task.error.message, `the code-signing identity "cu-runtime-signing" in the keychain (SHA-1 ${fp(OTHER_SHA)}) `
    + `is not the one the installed app ${P.app} is signed with (SHA-1 ${fp(SHA)}): nothing is built or signed until the owner `
    + 'has compared the current SHA-1 with the backed-up certificate (openssl x509 -noout -fingerprint -sha1 -in <the cert.pem '
    + 'kept with the identity\'s .p12 backup>) and accepted it on the plugin page')
  assert.ok(!w.ran().includes('zsh build-app.sh') && !w.ran().includes('ditto'))
  assert.deepEqual(w.killed, [])
  assert.equal(w.files.has(P.knownIdentity), false, 'the installed app\'s SHA-1 is never put on record')
  assert.deepEqual(await m.acceptIdentity(), { ok: true, error: null })
  assert.equal(w.files.get(P.knownIdentity), `${OTHER_SHA}\n`)
  assert.deepEqual(records(w).at(-1), { at: new Date(w.clock).toISOString(), pid: 9999, action: 'identity', outcome: 'accepted',
    previous: SHA, current: OTHER_SHA })
  const s = (await m.status()).app
  assert.deepEqual([s.identityKnown, s.identityKnownSource, s.identityChanged], [OTHER_SHA, 'record', false])
})

test('acceptIdentity accepts only the identity a status showed: one changed again since, or none shown, is refused', async () => {
  const w = world()
  w.files.set(P.knownIdentity, `${SHA}\n`)
  w.identities = [OTHER_SHA]
  const m = w.manager_()
  // No status has shown it.
  let r = await m.acceptIdentity()
  assert.deepEqual([r.ok, r.error.code], [false, 'identity_changed'])
  assert.equal(r.error.message, `the code-signing identity "cu-runtime-signing" in the keychain (SHA-1 ${fp(OTHER_SHA)}) is not one `
    + 'the plugin page was shown: the certificate changed again since it was shown; read it again and compare it with the '
    + 'backed-up certificate before accepting it')
  assert.equal(w.files.get(P.knownIdentity), `${SHA}\n`)
  // Shown, then replaced by a look-alike while the owner compares.
  assert.equal((await m.status()).app.identitySha1, OTHER_SHA)
  w.identities = [THIRD_SHA]
  r = await m.acceptIdentity()
  assert.deepEqual([r.ok, r.error.code], [false, 'identity_changed'])
  assert.match(r.error.message, new RegExp(`\\(SHA-1 ${fp(THIRD_SHA)}\\) is not the one the plugin page was shown \\(SHA-1 `
    + `${fp(OTHER_SHA)}\\): the certificate changed again since it was shown`))
  assert.equal(w.files.get(P.knownIdentity), `${SHA}\n`)
  assert.deepEqual(records(w).at(-1), { at: new Date(w.clock).toISOString(), pid: 9999, action: 'identity', outcome: 'failed',
    code: 'identity_changed', message: r.error.message, previous: SHA, current: THIRD_SHA })
  assert.equal(w.files.has(P.lock), false)
  // The page reads the status again: the one shown now is the one accepted.
  assert.equal((await m.status()).app.identitySha1, THIRD_SHA)
  assert.deepEqual(await m.acceptIdentity(), { ok: true, error: null })
  assert.equal(w.files.get(P.knownIdentity), `${THIRD_SHA}\n`)
})

test('CREATED_LINE is the line make-signing-identity.sh prints once it made an identity, and not its "already exists"', () => {
  const script = readFileSync(join(PKG, 'scripts/make-signing-identity.sh'), 'utf8')
  assert.ok(script.includes('print "created code-signing identity \\"$NAME\\" ($created) in the login keychain"'))
  assert.ok(script.includes('print "identity \\"$NAME\\" already exists ($existing): nothing to do"'))
  assert.match(createdLine(SHA), CREATED_LINE)
  assert.doesNotMatch(`identity "cu-runtime-signing" already exists (${SHA}): nothing to do`, CREATED_LINE)
  assert.doesNotMatch(`created code-signing identity "cu-runtime-signing" (${SHA}`, CREATED_LINE, 'several: split over lines')
})

test('an identity make-signing-identity.sh did not make (it found one: "already exists") is not taken as created: '
  + 'the identity_changed rule applies to it', async () => {
  const already = `identity "cu-runtime-signing" already exists (${SHA}): nothing to do`
  // Its output says it made none; or names another SHA-1 than the one listed; or the listed SHA-1 under another name
  // (an identity of another name is none of this host's).
  const otherName = createdLine(SHA).replace('"cu-runtime-signing"', '"cu-runtime-bench-signing"')
  for (const said of [already, createdLine(THIRD_SHA), otherName]) {
    const w = world({ identities: [] })
    w.files.set(P.knownIdentity, `${OTHER_SHA}\n`)
    w.on['zsh make-signing-identity.sh'] = (_a, options) => {
      w.identities = [SHA]   // one of the name showed up after preflight listed none
      options.onLine(said)
      return { code: 0, stdout: `${said}\n`, stderr: '' }
    }
    const m = w.manager_()
    m.install()
    const done = await settle(m)
    assert.deepEqual([done.phase, done.endedIn, done.error?.code], ['failed', 'identity', 'identity_changed'], done.log.join('\n'))
    assert.match(done.error.message, new RegExp(`\\(SHA-1 ${fp(SHA)}\\) is not the one this host last signed with or created `
      + `\\(SHA-1 ${fp(OTHER_SHA)}\\)`))
    assert.ok(done.log.includes(`identity cu-runtime-signing ${fp(SHA)} shows up after make-signing-identity.sh, whose output `
      + 'does not say that it created it: it is taken as one that was there before'), done.log.join('\n'))
    assert.equal(w.files.get(P.knownIdentity), `${OTHER_SHA}\n`, 'the record is kept')
    assert.deepEqual(taskRecords(w, done.id), [['install', 'started', undefined, undefined], ['install', 'failed', undefined, undefined]])
    assert.ok(!w.ran().includes('zsh build-app.sh'))
  }
  // Nothing known: the install goes on with it as one that was there, put on record once it has signed.
  const w = world({ identities: [] })
  w.on['zsh make-signing-identity.sh'] = (_a, options) => {
    w.identities = [SHA]
    options.onLine(already)
    return { code: 0, stdout: `${already}\n`, stderr: '' }
  }
  const m = w.manager_()
  m.install()
  const done = await settle(m)
  assert.equal(done.phase, 'done', done.log.join('\n'))
  assert.ok(done.log.includes(`identity cu-runtime-signing ${fp(SHA)}: none is on record yet; it is put on record once this `
    + 'install has signed with it'), done.log.join('\n'))
  assert.deepEqual(taskRecords(w, done.id), [['install', 'started', undefined, undefined], ['install', 'done', SHA, undefined]])
  assert.equal(w.files.get(P.knownIdentity), `${SHA}\n`)
})

// ------------------------------------------------------------------------------------------------ the lock

/** Another dsh process on the same Mac: the same files and processes, its own pid (and its own System). */
const otherProcess = (w, pid = 4242) => w.manager_({ system: { ...w.system, pid } })
/** A later load of this module in the same dsh process (a package update): its own System, the same pid. */
const laterLoad = (w) => w.manager_({ system: { ...w.system } })

test('the lock: one written before this boot is stale, though a live process has its pid now (pid reuse after a restart)', async () => {
  const boot = (T0 - 10 * 60_000) / 1000   // the Mac started 10 minutes ago
  const held = (at) => {
    const w = world()
    w.files.set(P.lock, JSON.stringify({ pid: 4242, at }))   // 4242 is alive
    const task = w.manager_({ bootTime: () => boot }).install()
    return task.phase === 'failed' && task.error.code === 'busy'
  }
  assert.equal(held(T0 - 30 * 60_000), false, 'from before the restart')
  assert.equal(held(T0 - 5 * 60_000), true, 'from this boot')
  // Within the boot time's jitter (SAME_BOOT_S) of its start: this boot's.
  assert.equal(held(T0 - 10 * 60_000 - 120_000), true)
  assert.equal(held(T0 - 10 * 60_000 - 120_001), false)
  // The page's actions are not held up by it either (stop included), nor does the status call it busy.
  const w = world()
  w.install()
  w.daemons = [400]
  w.files.set(P.lock, JSON.stringify({ pid: 4242, at: T0 - 30 * 60_000, since: T0 - 30 * 60_000, token: 'x' }))
  const m = w.manager_({ bootTime: () => boot })
  assert.equal((await m.status()).busy, null)
  assert.deepEqual(await m.stop(), { ok: true, error: null })
  assert.equal(w.files.has(P.lock), false, 'taken over, then released')
})

test('a stale lock is taken over atomically: a lock another process took over meanwhile is put back, and the answer is busy', async () => {
  const w = world()
  const stale = JSON.stringify({ pid: 31337, at: T0 - 1000 })   // 31337 is no live process: stale
  const theirs = `${JSON.stringify({ pid: 4242, at: T0, since: T0, token: 'theirs' })}\n`
  w.files.set(P.lock, stale)
  const rename = w.fs.rename
  let race = true
  w.fs.rename = (from, to) => {
    // Right before this process moves the stale lock aside, another one takes it over.
    if (from === P.lock && race) {
      race = false
      w.files.set(P.lock, theirs)
    }
    rename(from, to)
  }
  const task = w.manager_().install()
  assert.deepEqual([task.phase, task.error?.code], ['failed', 'busy'])
  assert.match(task.error.message, /^another dsh process \(pid 4242\) has been managing the daemon since /)
  assert.equal(w.files.get(P.lock), theirs, 'its lock is back in place')
  assert.deepEqual([...w.files.keys()].filter((k) => k.startsWith(`${P.lock}.`)), [], 'nothing is left aside')
  // Without a race the stale lock is taken over, and released after.
  w.files.set(P.lock, stale)
  assert.deepEqual(await w.manager_().stop(), { ok: true, error: null })
  assert.deepEqual([...w.files.keys()].filter((k) => k.startsWith(P.lock)), [])
})

test('the lock holds its holder\'s token; a lock another holder took over survives the first holder\'s refresh and unlock', async () => {
  const w = world()
  let release
  w.on['zsh build-app.sh'] = (args, options) => new Promise((resolve) => { release = () => resolve(w.defaults['zsh build-app.sh'](args, options)) })
  const m = w.manager_()
  m.install()
  await until(() => release !== undefined, m)
  const mine = JSON.parse(w.files.get(P.lock))
  assert.deepEqual(Object.keys(mine).sort(), ['at', 'pid', 'since', 'token'])
  assert.deepEqual([mine.pid, mine.since, mine.at], [9999, T0, T0])
  assert.match(mine.token, /^[0-9a-f-]{36}$/)
  // Meanwhile another process takes the lock over (it found this one stale: e.g. after a long sleep of the Mac).
  const theirs = `${JSON.stringify({ pid: 4242, at: T0, since: T0, token: 'theirs' })}\n`
  w.files.set(P.lock, theirs)
  release()
  const done = await settle(m)
  // It stops at its next phase change (busy): two installs never go on together. Nothing was stopped or replaced.
  assert.deepEqual([done.phase, done.endedIn, done.error.code], ['failed', 'verify', 'busy'], done.log.join('\n'))
  assert.equal(done.error.message, `another dsh process took the lock ${P.lock} over while this install ran (it found the lock `
    + 'stale, e.g. after a long sleep of the Mac): this install stops here, so that two installs never go on together')
  assert.ok(!w.calls.some((c) => c.line.includes('.CURuntime.app.new-')), 'not even staged')
  assert.deepEqual(w.killed, [])
  assert.equal(w.files.get(P.lock), theirs, 'not refreshed by the first holder, and not removed by its unlock')
  // An action's unlock leaves another holder's lock alone too.
  w.files.delete(P.lock)
  w.on['ps -axww'] = () => {
    w.files.set(P.lock, theirs)
    return w.defaults['ps -axww']()
  }
  await m.stop()
  assert.equal(w.files.get(P.lock), theirs)
})

test('a running task refreshes the lock\'s time at each phase change: a task longer than LOCK_STALE_MS still holds it', async () => {
  const w = world()
  w.install()
  w.daemons = [400]
  const at = {}
  w.on['zsh build-app.sh'] = (args, options) => {
    w.clock += LOCK_STALE_MS + 60_000   // a long build (or the Mac asleep during it)
    return w.defaults['zsh build-app.sh'](args, options)
  }
  let release
  w.on['open -n'] = () => new Promise((resolve) => { release = resolve })
  const m = w.manager_()
  const first = m.install()
  const watch = setInterval(() => {
    const lock = w.files.get(P.lock)
    if (lock !== undefined) at[m.taskState().phase] = JSON.parse(lock).at
  }, 0)
  await until(() => release !== undefined, m)
  clearInterval(watch)
  const lock = JSON.parse(w.files.get(P.lock))
  assert.equal(lock.since, T0, 'when it took the lock')
  assert.ok(w.clock - lock.since > LOCK_STALE_MS)
  assert.ok(w.clock - lock.at < 60_000, `refreshed: ${w.clock - lock.at} ms ago`)
  // Another process sees a live holder, since the task began, and is busy.
  const other = otherProcess(w)
  const s = await other.status()
  assert.deepEqual([s.task, s.busy], [null, { pid: 9999, since: new Date(T0).toISOString(), self: false }])
  const theirs = other.install()
  assert.deepEqual([theirs.phase, theirs.error.code], ['failed', 'busy'])
  assert.match(theirs.error.message, /^another dsh process \(pid 9999\) has been managing the daemon since 2026-10-20T12:00:00\.000Z: /)
  assert.equal(JSON.parse(w.files.get(P.lock)).token, lock.token, 'the lock is left to its holder')
  release({ code: 0, stdout: '', stderr: '' })
  assert.equal((await settle(m)).id, first.id)
  assert.equal(w.files.has(P.lock), false)
})

test('nodeFs.createExclusive: the file appears with its whole text; a second create is refused; no temporary file stays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cu-lock-'))
  try {
    const path = join(dir, 'host.lock')
    assert.equal(nodeFs.createExclusive(path, 'first\n'), true)
    assert.equal(nodeFs.createExclusive(path, 'second\n'), false)
    assert.equal(readFileSync(path, 'utf8'), 'first\n')
    assert.deepEqual(readdirSync(dir), ['host.lock'])
    assert.equal((execFileSync('/usr/bin/stat', ['-f', '%Lp', path], { encoding: 'utf8' })).trim(), '600')
    assert.throws(() => nodeFs.createExclusive(join(dir, 'missing/host.lock'), 'x'), /ENOENT/)
    assert.deepEqual(readdirSync(dir), ['host.lock'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------------------------------------ status.busy

test('status.busy: the lock\'s live holder, when this manager has no task or action of its own', async () => {
  // Another process (an older host's lock: no token, no since).
  let w = world()
  w.files.set(P.lock, JSON.stringify({ pid: 4242, at: T0 - 1000 }))
  assert.deepEqual((await w.manager_().status()).busy, { pid: 4242, since: new Date(T0 - 1000).toISOString(), self: false })
  // A stale lock is no holder.
  for (const lock of [{ pid: 31337, at: T0 - 1000 }, { pid: 4242, at: T0 - LOCK_STALE_MS }, '{junk']) {
    w = world()
    w.files.set(P.lock, typeof lock === 'string' ? lock : JSON.stringify(lock))
    assert.equal((await w.manager_().status()).busy, null, JSON.stringify(lock))
  }
  // Its own task, or its own action, holds the lock: not busy (the task shows as status.task).
  w = world()
  let release
  w.on['zsh build-app.sh'] = (args, options) => new Promise((resolve) => { release = () => resolve(w.defaults['zsh build-app.sh'](args, options)) })
  let m = w.manager_()
  m.install()
  await until(() => release !== undefined, m)
  let s = await m.status()
  assert.deepEqual([s.task.phase, s.busy], ['build', null])
  release()
  await settle(m)
  w = world()
  w.install()
  m = w.manager_()
  let during
  w.on['open -g'] = async () => {
    during = await m.status()
    w.daemons.push(w.nextPid++)
    return { code: 0, stdout: '', stderr: '' }
  }
  assert.deepEqual(await m.start(), { ok: true, error: null })
  assert.equal(during.busy, null)
})

test('status.busy after a package update: the earlier load\'s task, still running, shows as busy (self), install and the '
  + 'actions are busy with a message that says so, and busy clears when it ends', async () => {
  const w = world()
  let release
  w.on['open -n'] = () => new Promise((resolve) => { release = resolve })   // the earlier load's task, at its self-check
  const earlier = w.manager_({ disposeWaitMs: 10 })
  const task = earlier.install()
  await until(() => release !== undefined, earlier)
  await earlier.dispose()
  const later = laterLoad(w)
  const s = await later.status()
  assert.deepEqual([s.task, s.busy], [null, { pid: 9999, since: new Date(T0).toISOString(), self: true }])
  const refused = later.install()
  assert.deepEqual([refused.phase, refused.error.code], ['failed', 'busy'])
  assert.equal(refused.error.message, `this dsh process (pid 9999: another row of this plugin, or an earlier load of it, e.g. `
    + `before a package update) has been managing the daemon since ${new Date(T0).toISOString()} and is still finishing: try `
    + `again once it has ended (its outcome goes to ${P.actionLog})`)
  assert.doesNotMatch(refused.error.message, /taken over once that process is gone/)
  for (const op of ['start', 'stop', 'restart', 'permissions', 'selfCheck', 'acceptIdentity']) {
    assert.equal((await later[op]()).error?.code, 'busy', op)
  }
  // The later load's own failed task is its status.task; the holder is still reported until it is gone.
  assert.deepEqual([(await later.status()).task.id, (await later.status()).busy?.self], [refused.id, true])
  release({ code: 0, stdout: '', stderr: '' })
  await settle(earlier)
  assert.equal(earlier.taskState().id, task.id)
  assert.equal((await later.status()).busy, null)
  assert.deepEqual(await later.start(), { ok: true, error: null })
})

// ------------------------------------------------------------------------------------------------ the real runner

/** Whether no process has this pid any more (ended and reaped), within 2 s. */
async function goneSoon(pid) {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0)
    } catch (e) {
      if (e.code === 'ESRCH') return true
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  return false
}

/**
 * A real short-lived shell that exits at once and leaves a sleep, in its process group, holding its stdout (the
 * sleep's pid is the first line). The run is over only when the sleep is gone: 30 s unless the runner ends it.
 */
async function runLeavingSleep(options) {
  const lines = []
  const at = Date.now()
  const result = await nodeRun('/bin/sh', ['-c', 'sleep 30 & echo $!; exit 0'],
    { env: { PATH: '/usr/bin:/bin' }, onLine: (l) => lines.push(l), ...options })
  return { result, ms: Date.now() - at, pid: Number(lines[0]) }
}

test('nodeRun: a command that finishes gives its exit status and its output', async () => {
  const r = await nodeRun('/bin/sh', ['-c', 'echo out; echo err >&2; exit 3'], { env: { PATH: '/usr/bin:/bin' } })
  assert.deepEqual(r, { code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false })
})

test('nodeRun: the timeout ends a run whose command exited but left a process holding its output', { timeout: 20_000 }, async () => {
  const { result, ms, pid } = await runLeavingSleep({ timeoutMs: 300 })
  try {
    assert.ok(Number.isInteger(pid) && pid > 0, String(pid))
    assert.equal(result.code, null, 'ended by the timeout: not the shell\'s exit 0')
    assert.equal(result.timedOut, true)
    assert.ok(ms < 4000, `resolved after ${ms} ms`)
    assert.ok(await goneSoon(pid), 'the sleep was ended with the group')
  } finally {
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }
})

test('nodeRun: a cancel (abort) ends such a run the same way', { timeout: 20_000 }, async () => {
  const abort = new AbortController()
  setTimeout(() => abort.abort(), 300)
  const { result, ms, pid } = await runLeavingSleep({ signal: abort.signal, timeoutMs: 60_000 })
  try {
    assert.ok(Number.isInteger(pid) && pid > 0, String(pid))
    assert.equal(result.code, null)
    assert.equal(result.timedOut, false, 'a cancel is no timeout')
    assert.ok(ms < 4000, `resolved after ${ms} ms`)
    assert.ok(await goneSoon(pid), 'the sleep was ended with the group')
  } finally {
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }
})

test('nodeRun: output held from outside the group is let go after the SIGKILL\'s grace: the run still resolves', { timeout: 20_000 }, async () => {
  // The command (node) starts a sleep in a session of its own holding its stdout, prints its pid and exits.
  const script = 'const c = require("node:child_process").spawn("/bin/sleep", ["30"], '
    + '{ detached: true, stdio: ["ignore", "inherit", "inherit"] }); console.log(c.pid); c.unref()'
  const lines = []
  const at = Date.now()
  const result = await nodeRun(process.execPath, ['-e', script],
    { env: { PATH: '/usr/bin:/bin' }, timeoutMs: 200, onLine: (l) => lines.push(l) })
  const ms = Date.now() - at
  const pid = Number(lines[0])
  try {
    assert.ok(Number.isInteger(pid) && pid > 0, String(pid))
    assert.equal(result.code, null)
    assert.ok(ms >= 5000 && ms < 9000, `resolved after ${ms} ms (timeout 0.2 s, SIGKILL 5 s later, let go 1 s after)`)
  } finally {
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }
})

// ------------------------------------------------------------------------------------------------ source hash

/** A package tree that exercises the contract: nesting, byte order, .DS_Store, a symlink, files outside Sources/. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cu-source-hash-'))
  const put = (rel, text) => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  put('Package.swift', '// swift-tools-version:5.10\n')
  put('Sources/cu-runtime/main.swift', 'print("hi")\n')
  put('Sources/CURuntimeCore/Z.swift', 'struct Z {}\n')
  put('Sources/CURuntimeCore/a.swift', 'struct a {}\n')
  put('Sources/CURuntimeCore/Ä.swift', 'struct Ae {}\n')
  put('Sources/CURuntimeCore/sub dir/B.swift', 'struct B {}\n')
  put('Sources/CURuntimeCore/.DS_Store', 'junk')
  put('Sources/.DS_Store', 'junk')
  put('Sources/CURuntimeCore/.hidden.swift', 'hidden\n')
  put('Sources/empty.txt', '')
  put('Tests/T.swift', 'not covered\n')
  put('scripts/build-app.sh', '#!/bin/zsh\n')
  put('scripts/source-hash.sh', 'not covered\n')
  symlinkSync(join(root, 'Package.swift'), join(root, 'Sources/link.swift'))
  return root
}

test('source hash: the shared contract, computed independently here', () => {
  const root = fixture()
  // Byte order (LC_ALL=C), not case-insensitive: "." (0x2e) < "Z" < "a" < "s" ("sub dir") < "Ä" (UTF-8 0xc3 0x84);
  // "Sources/…" < "scripts/…" ("S" 0x53 < "s" 0x73).
  const expectedFiles = ['Package.swift', 'Sources/CURuntimeCore/.hidden.swift', 'Sources/CURuntimeCore/Z.swift',
    'Sources/CURuntimeCore/a.swift', 'Sources/CURuntimeCore/sub dir/B.swift', 'Sources/CURuntimeCore/Ä.swift',
    'Sources/cu-runtime/main.swift', 'Sources/empty.txt', 'scripts/build-app.sh']
  assert.deepEqual(sourceHashFiles(root), expectedFiles)
  const contents = { 'Package.swift': '// swift-tools-version:5.10\n', 'Sources/CURuntimeCore/.hidden.swift': 'hidden\n',
    'Sources/CURuntimeCore/Z.swift': 'struct Z {}\n', 'Sources/CURuntimeCore/a.swift': 'struct a {}\n',
    'Sources/CURuntimeCore/sub dir/B.swift': 'struct B {}\n', 'Sources/CURuntimeCore/Ä.swift': 'struct Ae {}\n',
    'Sources/cu-runtime/main.swift': 'print("hi")\n', 'Sources/empty.txt': '', 'scripts/build-app.sh': '#!/bin/zsh\n' }
  const sha = (data) => createHash('sha256').update(data).digest('hex')
  const expected = sha(expectedFiles.map((f) => `${f}\t${sha(Buffer.from(contents[f], 'utf8'))}\n`).join(''))
  assert.equal(sourceHash(root), expected)
  assert.match(expected, /^[0-9a-f]{64}$/)
  // Anything outside Package.swift, Sources/ and scripts/build-app.sh does not count; any byte inside does.
  writeFileSync(join(root, 'Tests/T.swift'), 'changed')
  writeFileSync(join(root, 'Sources/.DS_Store'), 'changed')
  writeFileSync(join(root, 'scripts/source-hash.sh'), 'changed')
  assert.equal(sourceHash(root), expected)
  writeFileSync(join(root, 'scripts/build-app.sh'), '#!/bin/zsh\n# changed\n')
  const changed = sourceHash(root)
  assert.notEqual(changed, expected, 'how the app is assembled and signed counts')
  writeFileSync(join(root, 'Sources/empty.txt'), ' ')
  assert.notEqual(sourceHash(root), changed)
})

test('source hash: a package without scripts/build-app.sh has none (status shows it unknown)', () => {
  const root = fixture()
  rmSync(join(root, 'scripts/build-app.sh'))
  assert.throws(() => sourceHash(root), /ENOENT/)
})

const SHELL_HASH = join(host.PACKAGE_ROOT, 'scripts/source-hash.sh')
test('source hash: scripts/source-hash.sh gives the same output as the node implementation',
  { skip: !existsSync(SHELL_HASH) && 'scripts/source-hash.sh is not in this tree' }, () => {
    for (const root of [fixture(), host.PACKAGE_ROOT]) {
      const out = execFileSync('/bin/zsh', [SHELL_HASH, root], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } })
      assert.equal(out, `${sourceHash(root)}\n`)
    }
  })
