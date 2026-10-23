// host.ts makes the real System once per process (`realSystem ??= …`): every row of a dsh process then has the same
// System, and with it the same install task (daemon/manager.ts keeps the task per System), so a row reloaded while a
// task runs finds that task again. This file runs in a process of its own (node --test runs each file in its own),
// so host.js's module state is fresh here. The System is a fake made through HostOptions.makeSystem: nothing real
// runs, and the count of makeSystem calls is checked before any route is called (a host that ignored makeSystem
// would otherwise reach the real system). The last test is the real runner's output limit (system.ts nodeRun), on
// this process's node only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as host from '../lib/host.js'
import { nodeRun } from '../lib/daemon/system.js'

const HOME = '/home/someone'
const HASH = 'f'.repeat(64)

/**
 * A fake Mac with no identity, no app and no daemon: the install task gets as far as make-signing-identity.sh, which
 * runs until release() (or a cancel) and then fails. Every other command fails, which the status reads as nothing there.
 */
function fakeSystem() {
  const files = new Map()
  const dirs = new Set([HOME])
  const under = (path) => [...files.keys()].filter((k) => k === path || k.startsWith(`${path}/`))
  let release
  const released = new Promise((resolve) => { release = resolve })
  const ok = (stdout) => ({ code: 0, stdout, stderr: '' })
  let clock = Date.parse('2026-10-20T12:00:00Z')
  const sys = {
    calls: [],
    release: () => release(),
    run: async (file, args, options = {}) => {
      sys.calls.push(`${file} ${args.join(' ')}`)
      await new Promise((resolve) => setImmediate(resolve))
      if (file === '/usr/bin/xcode-select' && args[0] === '-p') return ok('/Library/Developer/CommandLineTools\n')
      if (file === '/bin/launchctl') return ok('Aqua\n')
      if (file === '/usr/bin/security') return ok('Policy: Code Signing\n  Matching identities\n     0 identities found\n')
      if (file === '/bin/zsh') {
        await Promise.race([released, new Promise((resolve) => options.signal?.addEventListener('abort', resolve, { once: true }))])
        return { code: 1, stdout: '', stderr: 'import failed' }
      }
      return { code: 1, stdout: '', stderr: `${file}: not on this fake Mac` }
    },
    fs: {
      exists: (p) => files.has(p) || dirs.has(p) || under(p).length > 0,
      readText: (p) => files.get(p),
      mtimeMs: (p) => (files.has(p) ? clock : undefined),
      writeText: (p, t) => { files.set(p, t) },
      appendText: (p, t) => { files.set(p, (files.get(p) ?? '') + t) },
      createExclusive: (p, t) => {
        if (files.has(p)) return false
        files.set(p, t)
        return true
      },
      mkdir: (p) => { dirs.add(p) },
      rm: (p) => { for (const k of under(p)) files.delete(k) },
      rename: (a, b) => {
        for (const k of under(a)) {
          files.set(b + k.slice(a.length), files.get(k))
          files.delete(k)
        }
      },
    },
    kill: () => false,
    alive: (pid) => pid === 9999,
    connects: async () => false,
    sleep: async (ms) => {
      clock += ms
      await new Promise((resolve) => setImmediate(resolve))
    },
    now: () => clock,
    env: { HOME, USER: 'someone' },
    home: HOME,
    pid: 9999,
  }
  return sys
}

/** One row of the package on a fake dsh context (web: profileContext and connection); its routes and disposers. */
function row(options) {
  const routes = []
  const effects = []
  const ctx = {
    get: (name) => (name === 'profileContext' ? { name: 'web' } : undefined),
    effect: (fn) => { effects.push(fn()) },
    inject: (_deps, callback) => callback({ connection: { fetch: { register: (r) => { routes.push(r); return async () => {} } } } }),
  }
  host.applyWith(options)(ctx)
  const call = async (op) => {
    const route = routes.find((r) => r.path === `/api/cu-runtime.${op}`)
    return (await route.fetch(new Request(`http://127.0.0.1:1/api/cu-runtime.${op}`, { method: 'POST' }))).json()
  }
  return { call, effects }
}

async function eventually(condition) {
  for (let i = 0; i < 10_000; i++) {
    if (await condition()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('the condition never held')
}

test('the real System is made once per process: every row shares it, and with it the running install task', async () => {
  const sys = fakeSystem()
  let made = 0
  const options = { makeSystem: () => { made++; return sys }, packageSourceHash: () => HASH, sourceHash: () => HASH,
    bootTime: () => 1000 }
  const first = row(options)
  const second = row(options)   // the row reloaded (a manager of its own), in the same process
  assert.equal(made, 1, 'made once, for the first row that needed it, and kept for the next')
  // A later apply with another maker and no system still gets the System made first; one with a system of its own
  // does not ask for the real one.
  let others = 0
  row({ ...options, makeSystem: () => { others++; return fakeSystem() } })
  row({ ...options, system: fakeSystem(), makeSystem: () => { others++; return fakeSystem() } })
  assert.equal(others, 0)

  // The first row's task, held in make-signing-identity.sh, is the second row's task too.
  const started = await first.call('install')
  assert.equal(started.phase, 'preflight')
  await eventually(() => sys.calls.some((c) => c.startsWith('/bin/zsh -f ')))
  const seen = (await second.call('status')).task
  assert.deepEqual([seen?.id, seen?.phase], [started.id, 'identity'], 'not task: null')
  assert.equal((await second.call('status')).busy, null, 'its own task: no other holder to report')
  assert.equal((await second.call('install')).id, started.id, 'install joins it')
  assert.equal((await second.call('start')).error?.code, 'busy')
  sys.release()
  let ended
  await eventually(async () => ['done', 'failed', 'cancelled'].includes((ended = (await second.call('status')).task).phase))
  assert.deepEqual([ended.id, ended.phase, ended.error?.code], [started.id, 'failed', 'identity_failed'])
  assert.equal(made, 1)
})

// RunOptions.outputLimit (the mode check reads a dump whole through it): each stream's last that many characters,
// 64 Ki by default. The command is this process's node printing to both streams; nothing else runs.
test('nodeRun keeps the last 64 Ki characters of each stream by default, or the last outputLimit', async () => {
  const script = "process.stdout.write('a' + 'b'.repeat(99_999)); process.stderr.write('c' + 'd'.repeat(99_999))"
  const plain = await nodeRun(process.execPath, ['-e', script], { env: {} })
  assert.equal(plain.code, 0)
  assert.equal(plain.stdout, 'b'.repeat(64 * 1024))
  assert.equal(plain.stderr, 'd'.repeat(64 * 1024))
  const whole = await nodeRun(process.execPath, ['-e', script], { env: {}, outputLimit: 8 * 1024 * 1024 })
  assert.equal(whole.stdout, `a${'b'.repeat(99_999)}`)
  assert.equal(whole.stderr, `c${'d'.repeat(99_999)}`)
  const small = await nodeRun(process.execPath, ['-e', script], { env: {}, outputLimit: 10 })
  assert.deepEqual([small.stdout, small.stderr], ['b'.repeat(10), 'd'.repeat(10)])
})
