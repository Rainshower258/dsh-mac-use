import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CURuntimeClient, DaemonUnavailable, REFUSED_HINT, START_HINT } from '../lib/client.js'
import { AutoStart, STOP_MARK, RETRY_AFTER_MS, currentBootTime, stopMarkOfThisBoot, stopMarkText } from '../lib/autostart.js'
import { Config } from '../lib/index.js'

// A fake daemon that a fake `open` starts in the state dir, and that can be killed with its connections.

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj))
  const h = Buffer.alloc(4); h.writeUInt32LE(body.length)
  return Buffer.concat([h, body])
}

// Everything a test opened is closed after it, even when an assertion failed first (a mutant must fail, not hang).
const opened = []
afterEach(async () => {
  for (const c of opened.splice(0)) await c()
})

function daemonIn(dir) {
  let server, socks = new Set()
  const d = {
    async start() {
      writeFileSync(join(dir, 'token'), 'tok\n')
      server = createServer((sock) => {
        socks.add(sock)
        let buf = Buffer.alloc(0)
        sock.on('data', (c) => {
          buf = Buffer.concat([buf, c])
          while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
            const len = buf.readUInt32LE(0)
            const msg = JSON.parse(buf.subarray(4, 4 + len)); buf = buf.subarray(4 + len)
            sock.write(frame({ jsonrpc: '2.0', id: msg.id, result: { ok: msg.method } }))
          }
        })
      })
      await new Promise((r) => server.listen(join(dir, 'daemon.sock'), r))
    },
    /** The daemon closes its connections but keeps listening (idle_timeout). */
    dropConnections() {
      for (const s of socks) s.destroy()
      socks = new Set()
    },
    async kill() {
      for (const s of socks) s.destroy()
      socks = new Set()
      if (server?.listening) await new Promise((r) => server.close(r))
    },
  }
  opened.push(() => d.kill())
  return d
}

/** The host's verdict on the app (daemon/manager.ts verifyApp), as the fake check gives it: null accepts it. */
const NOT_RELEASE = { code: 'not_release_build', message: '/A/CURuntime.app is not a release build: its Info.plist CUBench is true, not false' }

/**
 * `verdict`: what the check says of the app (null: verified; an Error: the check throws). `checked` lists each check
 * with what was launched before it, so a launch before its check shows.
 */
async function setup({ comesUp = true, boot = 1000, verdict = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cur-auto-'))
  const daemon = daemonIn(dir)
  const launched = []
  const checked = []
  let now = 0
  const auto = new AutoStart({ stateDir: dir, appPath: '/A/CURuntime.app', bootTime: () => boot, now: () => now,
    verify: async (app) => {
      checked.push({ app, launchedBefore: launched.length })
      if (s.verdict instanceof Error) throw s.verdict
      return s.verdict
    },
    launch: async (app) => { launched.push(app); if (comesUp) await daemon.start() } })
  const client = new CURuntimeClient({ stateDir: dir, autoStart: auto, startWaitMs: 300, closeProbeDelayMs: 20, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) })
  opened.push(async () => client.close())
  const settle = () => new Promise((r) => setTimeout(r, 120))
  const s = { dir, daemon, launched, checked, verdict, auto, client, settle, advance: (ms) => { now += ms } }
  return s
}

test('not running: the app is verified, then opened once, and the call goes through', { timeout: 10_000 }, async () => {
  const { launched, checked, client, dir, daemon } = await setup()
  assert.deepEqual(await client.request('runtime.ping'), { ok: 'runtime.ping' })
  assert.deepEqual(launched, ['/A/CURuntime.app'])
  assert.deepEqual(checked, [{ app: '/A/CURuntime.app', launchedBefore: 0 }], 'the app opened is the app checked, checked first')
  await client.request('runtime.ping')
  assert.equal(launched.length, 1, 'connected: not opened again')
  assert.ok(!existsSync(join(dir, STOP_MARK)))
  client.close(); await daemon.kill()
})

test('one-step stop: killed while connected, it is not started again until the user starts it', { timeout: 10_000 }, async () => {
  const { launched, client, dir, daemon, settle } = await setup()
  await client.request('runtime.ping')
  await daemon.kill()
  await settle()
  assert.ok(existsSync(join(dir, STOP_MARK)), 'the stop is marked')
  for (let i = 0; i < 2; i++) {
    await assert.rejects(client.request('runtime.ping'),
      (e) => e instanceof DaemonUnavailable && /not started again automatically/.test(e.message) && /Do not start it yourself/.test(e.message))
  }
  assert.equal(launched.length, 1, 'nothing opened after the stop')
  // A new dsh process (a new client) honours the same mark.
  const again = new CURuntimeClient({ stateDir: dir, autoStart: new AutoStart({ stateDir: dir, appPath: '/A/CURuntime.app',
    bootTime: () => 1000, verify: async () => null, launch: async () => { launched.push('second client') } }) })
  opened.push(async () => again.close())
  await assert.rejects(again.request('runtime.ping'), /not started again automatically/)
  assert.equal(launched.length, 1)
  // The user starts it: the next connection clears the mark.
  await daemon.start()
  assert.deepEqual(await client.request('runtime.ping'), { ok: 'runtime.ping' })
  assert.ok(!existsSync(join(dir, STOP_MARK)))
  client.close(); again.close(); await daemon.kill()
})

test("the plugin's own close is not a stop", { timeout: 10_000 }, async () => {
  const { client, dir, daemon, settle } = await setup()
  await client.request('runtime.ping')
  client.close()
  await settle()
  assert.ok(!existsSync(join(dir, STOP_MARK)))
  await daemon.kill()
})

test('a mark from an earlier boot is stale: after a restart the first use starts it', { timeout: 10_000 }, async () => {
  const { client, dir, launched, daemon } = await setup({ boot: 50_000 })
  writeFileSync(join(dir, STOP_MARK), JSON.stringify({ boot: 1000 }))
  await client.request('runtime.ping')
  assert.equal(launched.length, 1)
  client.close(); await daemon.kill()
})

test('a mark from this boot (within the uptime jitter) stands; a broken one does not', { timeout: 10_000 }, async () => {
  const { auto, dir } = await setup({ boot: 1000 })
  writeFileSync(join(dir, STOP_MARK), JSON.stringify({ boot: 1060 }))
  assert.equal(auto.stoppedByUser(), true)
  writeFileSync(join(dir, STOP_MARK), 'not json')
  assert.equal(auto.stoppedByUser(), false)
  auto.markStopped()
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, STOP_MARK), 'utf8'))), ['boot', 'at'])
})

test('opened but never reachable: a clear error, then no new open for a while', { timeout: 10_000 }, async () => {
  const { client, launched, advance } = await setup({ comesUp: false })
  await assert.rejects(client.request('runtime.ping'), (e) => e instanceof DaemonUnavailable
    && e.message === `cu-runtime daemon is not reachable (started, but not reachable after 0.3 s). ${START_HINT}`)
  // The hint is true with autoStart too: the plugin only asks macOS to open a verified app, it never spawns one.
  assert.ok(START_HINT.endsWith('The plugin never spawns it: with autoStart on, it only asks macOS to open the installed '
    + 'app, and only a release build it verified.'), START_HINT)
  await assert.rejects(client.request('runtime.ping'), (e) => e instanceof DaemonUnavailable)
  assert.equal(launched.length, 1, 'cooling down')
  advance(RETRY_AFTER_MS)
  await assert.rejects(client.request('runtime.ping'), /not reachable/)
  assert.equal(launched.length, 2)
})

test('a refused app is never opened: start() is refused with the reason, the model is told to install it on the page', { timeout: 10_000 }, async () => {
  const r = await setup({ verdict: NOT_RELEASE })
  assert.deepEqual(await r.auto.start(), { result: 'refused', reason: NOT_RELEASE })
  assert.equal(r.launched.length, 0)
  const s = await setup({ verdict: NOT_RELEASE })
  await assert.rejects(s.client.request('observe'), (e) => e instanceof DaemonUnavailable
    && e.message === 'cu-runtime daemon is not reachable (the installed CURuntime.app is not a release build the plugin '
      + `verified: not_release_build). ${REFUSED_HINT}`)
  assert.match(REFUSED_HINT, /^The daemon is not started\. .*install or update CURuntime\.app on the plugin page's 守护进程 tab\.$/)
  assert.equal(s.launched.length, 0)
  assert.equal(s.checked.length, 1)
})

test('within RETRY_AFTER_MS of a refusal the app is not checked again (codesign is slow); the same refusal stands', { timeout: 10_000 }, async () => {
  const s = await setup({ verdict: NOT_RELEASE })
  for (let i = 0; i < 3; i++) {
    await assert.rejects(s.client.request('observe'), /not a release build the plugin verified: not_release_build/)
    s.advance(RETRY_AFTER_MS / 4)
  }
  assert.equal(s.checked.length, 1, 'checked once')
  assert.deepEqual(await s.auto.start(), { result: 'refused', reason: NOT_RELEASE })
  assert.equal(s.checked.length, 1)
  // Past the cool-down it is checked again: a release build installed meanwhile is opened.
  s.advance(RETRY_AFTER_MS)
  s.verdict = null
  assert.deepEqual(await s.client.request('observe'), { ok: 'observe' })
  assert.equal(s.checked.length, 2)
  assert.deepEqual(s.launched, ['/A/CURuntime.app'])
})

test('a check that throws is a refusal: nothing is opened', { timeout: 10_000 }, async () => {
  const s = await setup({ verdict: new Error('spawn codesign ENOENT') })
  assert.deepEqual(await s.auto.start(), { result: 'refused',
    reason: { code: 'internal', message: 'checking /A/CURuntime.app failed: Error: spawn codesign ENOENT' } })
  assert.equal(s.launched.length, 0)
  s.advance(RETRY_AFTER_MS)
  await assert.rejects(s.client.request('observe'), /not a release build the plugin verified: internal\)/)
  assert.equal(s.launched.length, 0)
})

test("the user's stop mark is checked before the app: a stop stands without a check", { timeout: 10_000 }, async () => {
  const s = await setup({ verdict: NOT_RELEASE })
  writeFileSync(join(s.dir, STOP_MARK), stopMarkText(1000, 0))
  assert.equal(await s.auto.start(), 'stopped-by-user')
  await assert.rejects(s.client.request('observe'), /not started again automatically/)
  assert.equal(s.checked.length, 0)
  assert.equal(s.launched.length, 0)
})

test('the plugin checks the app autoStart opens with the host\'s check, on the real system made once', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(src, /^import \{ installedAppVerifier \} from '\.\/daemon\/manager\.ts'$/m)
  assert.match(src, /^const verifyApp = \(app: string\) => installedAppVerifier\(realSystem \?\?= nodeSystem\(\)\)\(app\)$/m)
  assert.match(src, /new AutoStart\(\{ stateDir, appPath: expandHome\(config\.appPath\), verify: verifyApp \}\)/)
})

test('off by default (the bench, headless); cu-std and the bundle\'s mode turn it on', { timeout: 10_000 }, async () => {
  assert.equal(Config({ stateDir: '/x', apps: [], electronAx: false }).autoStart, false)
  const patch = readFileSync(new URL('../../profiles/cu-std/cordis.patch.yml.in', import.meta.url), 'utf8')
  assert.match(patch, /^\s+autoStart: true$/m)
  const bundle = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(bundle, /^\s+autoStart: true$/m)
})

test('only a cu_* call starts it: a request with start: false (the turn markers) only connects', { timeout: 10_000 }, async () => {
  const { client, launched } = await setup()
  await assert.rejects(client.request('access.turn_start', {}, undefined, { start: false }), (e) => e instanceof DaemonUnavailable)
  assert.equal(launched.length, 0)
  assert.deepEqual(await client.request('observe'), { ok: 'observe' })
  assert.equal(launched.length, 1)
})

test('a cu_* call that comes while a start: false connect is in flight still starts it', { timeout: 10_000 }, async () => {
  const { client, launched } = await setup()
  const marker = client.request('access.turn_start', {}, undefined, { start: false }).catch((e) => e)
  const call = client.request('observe')
  assert.ok((await marker) instanceof DaemonUnavailable)
  assert.deepEqual(await call, { ok: 'observe' })
  assert.equal(launched.length, 1)
})

test('the plugin marks turns with start: false (a turn without the screen starts nothing)', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const markers = src.match(/client\.request\('access\.turn_(start|end)'[^\n]*/g)
  assert.equal(markers.length, 3)
  for (const m of markers) assert.match(m, /undefined, \{ start: false \}\)/)
})

test('an idle close is no stop: the daemon closed the connection but still listens (2026-10-14)', { timeout: 10_000 }, async () => {
  const { launched, client, dir, daemon, settle } = await setup()
  await client.request('runtime.ping')
  daemon.dropConnections()
  await settle()
  assert.ok(!existsSync(join(dir, STOP_MARK)), 'not marked: it still listens')
  assert.deepEqual(await client.request('runtime.ping'), { ok: 'runtime.ping' }, 'the next call reconnects')
  assert.equal(launched.length, 1)
  client.close(); await daemon.kill()
})

// The daemon leaves the same mark itself on SIGTERM/SIGINT and the settings window's stops (Sources/CURuntimeCore/
// StopMark.swift): boot from kern.boottime in seconds with three decimals, `at` in toISOString's form, a newline.
test("the daemon's own mark (StopMark.swift's shape) is a stop of this boot; one from another boot is not", { timeout: 10_000 }, async () => {
  const daemonMark = (boot) => `{"boot":${boot.toFixed(3)},"at":"2026-10-22T01:02:03.004Z"}\n`
  assert.deepEqual(JSON.parse(daemonMark(1792000000.5)), JSON.parse(stopMarkText(1792000000.5, Date.UTC(2026, 9, 22, 1, 2, 3, 4))),
    "the same JSON as the plugin's own mark")
  assert.equal(stopMarkOfThisBoot(daemonMark(1792000000.5), 1792000119.9), true)
  assert.equal(stopMarkOfThisBoot(daemonMark(1792000000.5), 1792000200), false, 'another boot')

  const { auto, dir } = await setup({ boot: 1792000030 })
  writeFileSync(join(dir, STOP_MARK), daemonMark(1792000000.818), { mode: 0o600 })
  assert.equal(auto.stoppedByUser(), true)
  auto.connected()
  assert.ok(!existsSync(join(dir, STOP_MARK)), "cleared by the next connection, as the plugin's own")

  if (process.platform === 'darwin') {
    // The daemon's boot (kern.boottime) against the plugin's (now - os.uptime()), on this machine.
    const m = /sec = (\d+), usec = (\d+)/.exec(execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' }))
    assert.ok(m)
    assert.equal(stopMarkOfThisBoot(daemonMark(Number(m[1]) + Number(m[2]) / 1e6), currentBootTime()), true)
  }
})
