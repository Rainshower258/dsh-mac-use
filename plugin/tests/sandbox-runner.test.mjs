import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// scripts/cu-sandbox-runner, run as dsh-sandbox-local runs a runnerCommand: the runner's own options, then dsh's
// bwrap-compatible profile, `--`, the command. Only temp dirs and sockets this test creates are touched.

const RUNNER = fileURLToPath(new URL('../../scripts/cu-sandbox-runner', import.meta.url))
const darwin = { skip: process.platform !== 'darwin' && 'Seatbelt is macOS only', timeout: 20_000 }
const READ_ONLY = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
const workspaceWrite = (ws) => [...READ_ONLY, '--tmpfs', '/tmp', '--bind', ws, ws]

const servers = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

function world() {
  const base = mkdtempSync(join(tmpdir(), 'cu-runner-'))
  const dirs = Object.fromEntries(['ws', 'state', 'outside', 'tmp', 'other'].map((d) => [d, join(base, d)]))
  for (const d of Object.values(dirs)) mkdirSync(d)
  writeFileSync(join(dirs.state, 'token'), 'secret-for-test\n')
  writeFileSync(join(dirs.outside, 'plain.txt'), 'plain\n')
  return dirs
}

function run(dirs, profile, script, { own = ['--deny-dir', dirs.state, '--deny-socket', join(dirs.state, 'daemon.sock'),
  '--deny-socket', join(dirs.other, 'd.sock')] } = {}) {
  const r = spawnSync(RUNNER, [...own, ...profile, '--', '/bin/sh', '-c', script],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', TMPDIR: dirs.tmp, HOME: process.env.HOME } })
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
}

async function listen(path) {
  const server = createServer((s) => s.end('hello\n'))
  await new Promise((r) => server.listen(path, r))
  servers.push(server)
}

/** A connect from inside the sandbox, by node (its own binary is readable there). */
const connect = (path) => `"${process.execPath}" -e 'const s=require("net").connect(${JSON.stringify(path)});`
  + `s.on("connect",()=>{console.log("connected");s.destroy()});s.on("error",(e)=>{console.log(e.code);process.exitCode=3})'`

test('positive controls: the workspace and temp dir are writable, ordinary files readable, other sockets reachable', darwin, async () => {
  const dirs = world()
  await listen(join(dirs.outside, 'ok.sock'))
  const r = run(dirs, workspaceWrite(dirs.ws),
    `echo a > "${dirs.ws}/f" && echo b > "${dirs.tmp}/g" && cat "${dirs.outside}/plain.txt" && ${connect(join(dirs.outside, 'ok.sock'))}`)
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out, 'plain\nconnected')
  assert.ok(existsSync(join(dirs.ws, 'f')) && existsSync(join(dirs.tmp, 'g')))
})

test("dsh's own write rules stay: nothing outside the roots, and nothing at all in read-only", darwin, () => {
  const dirs = world()
  assert.notEqual(run(dirs, workspaceWrite(dirs.ws), `echo x > "${dirs.outside}/w"`).code, 0)
  assert.notEqual(run(dirs, READ_ONLY, `echo x > "${dirs.ws}/w"`).code, 0)
  assert.ok(!existsSync(join(dirs.outside, 'w')) && !existsSync(join(dirs.ws, 'w')))
})

test("negative control: the daemon's state dir can be neither read nor written", darwin, () => {
  const dirs = world()
  for (const profile of [workspaceWrite(dirs.ws), READ_ONLY]) {
    const read = run(dirs, profile, `cat "${dirs.state}/token"`)
    assert.notEqual(read.code, 0)
    assert.doesNotMatch(read.out, /secret-for-test/)
    assert.match(read.err, /Operation not permitted/)
    assert.notEqual(run(dirs, profile, `ls "${dirs.state}"`).code, 0, 'not even listed')
  }
  assert.notEqual(run(dirs, workspaceWrite(dirs.ws), `echo x > "${dirs.state}/planted"`).code, 0)
  assert.ok(!existsSync(join(dirs.state, 'planted')))
})

test("negative control: the daemon's socket cannot be connected to (the socket rule alone, too)", darwin, async () => {
  const dirs = world()
  await listen(join(dirs.state, 'daemon.sock'))
  await listen(join(dirs.other, 'd.sock'))   // outside the denied dir: only --deny-socket covers it
  for (const sock of [join(dirs.state, 'daemon.sock'), join(dirs.other, 'd.sock')]) {
    const r = run(dirs, workspaceWrite(dirs.ws), connect(sock))
    assert.notEqual(r.code, 0, sock)
    assert.doesNotMatch(r.out, /connected/)
  }
  // Positive control: the same sockets answer outside the runner.
  const plain = spawnSync('/bin/sh', ['-c', connect(join(dirs.other, 'd.sock'))], { encoding: 'utf8' })
  assert.equal(plain.stdout.trim(), 'connected')
})

test('anything but the shapes dsh emits fails closed, with the signature, and runs nothing', darwin, () => {
  const dirs = world()
  const marker = join(dirs.ws, 'ran')
  const bad = [
    { own: [], profile: workspaceWrite(dirs.ws) },
    { own: ['--deny-dir', dirs.state], profile: workspaceWrite(dirs.ws) },
    { profile: ['--bind', '/', '/'] },
    { profile: [...READ_ONLY, '--tmpfs', '/tmp', '--bind', dirs.ws, '/elsewhere'] },
    { profile: [...READ_ONLY, '--share-net'] },
  ]
  for (const { own, profile } of bad) {
    const r = run(dirs, profile, `touch "${marker}"`, own === undefined ? undefined : { own })
    assert.equal(r.code, 125, JSON.stringify(profile))
    assert.match(r.err, /^cu-sandbox-runner: /)
  }
  assert.ok(!existsSync(marker))
})

test("cu-std runs dsh's sandbox through the runner, away from the daemon's state dir and socket", () => {
  const patch = readFileSync(new URL('../../profiles/cu-std/cordis.patch.yml.in', import.meta.url), 'utf8')
  const row = patch.match(/^- id: sandbox\n  config:\n((?:    .*\n)+)/m)
  assert.ok(row, 'a sandbox row')
  assert.match(row[1], /runnerCommand: \[@RUNNER@, --deny-dir, @STATE_DIR@, --deny-socket, @SOCKET@\]/)
  assert.match(row[1], /runnerFailureSignatures: \['cu-sandbox-runner: '/)
  const install = readFileSync(new URL('../../scripts/install-cu-std.sh', import.meta.url), 'utf8')
  assert.match(install, /RUNNER=\$ROOT\/scripts\/cu-sandbox-runner/)
  assert.match(install, /DAEMON_STATE=\$HOME\/Library\/Application\\ Support\/cu-runtime/)
})
