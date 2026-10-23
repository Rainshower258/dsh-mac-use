#!/usr/bin/env node
// No-model integration check for T5: in each render mode, click fixture
// elements through CUADaemon by *global point* coordinates derived from the
// ground truth (content origin + bbox centre) and verify clicks.jsonl logs the
// intended target. Validates the pixel/point mapping read_text will rely on.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const BENCH = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LEGACY = process.env.DSH_CU_LEGACY ?? resolve(BENCH, '../../dsh-computer-use')
const { DaemonClient } = await import(pathToFileURL(join(LEGACY, 'packages/computer-use/dsh-computer-use/lib/daemon.js')).href)
const FIXTURE = join(BENCH, 'fixture-app/dist/DSHFixture.app/Contents/MacOS/Electron')
const TARGETS = ['btn:收藏', 'conv:c4', 'btn:发送']
let failures = 0

for (const mode of ['dom', 'canvas', 'image']) {
  const dir = mkdtempSync(join(tmpdir(), 'cua-click-'))
  const gtPath = join(dir, 'gt.json')
  const child = spawn(FIXTURE, ['--mode', mode, '--conv', 'c3', '--run-dir', dir, '--gt-out', gtPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((ok, fail) => {
    let out = ''
    const t = setTimeout(() => fail(new Error('fixture not ready')), 20000)
    child.stdout.on('data', (c) => { out += c; if (out.includes('READY')) { clearTimeout(t); ok() } })
  })
  const gt = JSON.parse(readFileSync(gtPath, 'utf8'))
  const socketPath = join(dir, 'c.sock')
  const client = new DaemonClient({ socketPath, daemonCommand: join(LEGACY, 'native/.build/release/CUADaemon'), daemonArgs: ['--socket', socketPath] })
  await client.start()
  for (const id of TARGETS) {
    const region = gt.regions.find((r) => r.id === id)
    const x = gt.window.contentBounds.x + region.bbox[0] + region.bbox[2] / 2
    const y = gt.window.contentBounds.y + region.bbox[1] + region.bbox[3] / 2
    await client.request('ComputerUseIPCAppPerformActionRequest', {
      app: 'DSHFixture', action: { click: { at: { coordinate: { _0: [x, y] } }, clickCount: 1, mouseButton: 0 } },
    })
    await new Promise((r) => setTimeout(r, 400))
  }
  // Pointer guard: a point outside the window (screenshot-pixel style) must be refused.
  const b = gt.window.bounds
  const outside = [b.x + b.width + 40, b.y + 20]
  let refused = false
  try {
    await client.request('ComputerUseIPCAppPerformActionRequest', {
      app: 'DSHFixture', action: { click: { at: { coordinate: { _0: outside } }, clickCount: 1, mouseButton: 0 } },
    })
  } catch (error) {
    refused = /outside/.test(String(error))
  }
  failures += !refused
  console.log(`${refused ? 'PASS' : 'FAIL'} ${mode}: out-of-window click at ${JSON.stringify(outside)} refused`)
  client.stop()
  child.kill('SIGTERM')
  const clicks = existsSync(join(dir, 'clicks.jsonl')) ? readFileSync(join(dir, 'clicks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
  const got = clicks.map((c) => c.target)
  const ok = JSON.stringify(got) === JSON.stringify(TARGETS)
  failures += !ok
  console.log(`${ok ? 'PASS' : 'FAIL'} ${mode}: clicked ${JSON.stringify(got)}`)
  await new Promise((r) => setTimeout(r, 800))
}
process.exit(failures ? 1 : 0)
