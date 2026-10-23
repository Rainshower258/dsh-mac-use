#!/usr/bin/env node
// Build the synthetic corpus: fixture app × {dom, canvas, image} × {light, dark}
// × a set of conversation/scroll positions. Each shot goes through the real
// CUADaemon `get_app_state` path (same capture code the agent sees) and yields:
//   corpus/synthetic/<name>.png       window screenshot (2x on Retina)
//   corpus/synthetic/<name>.ax.txt    full AX tree text (the A0 "what AX reveals" input)
//   corpus/synthetic/<name>.gt.json   ground truth in screenshot pixels
//
//   node bench/corpus/capture_synthetic.mjs [--only dom-light-c3] [--modes dom,canvas]
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import yaml from '../fixture-app/node_modules/js-yaml/dist/js-yaml.mjs'

const BENCH = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LEGACY = process.env.DSH_CU_LEGACY ?? resolve(BENCH, '../../dsh-computer-use')
const { DaemonClient } = await import(pathToFileURL(join(LEGACY, 'packages/computer-use/dsh-computer-use/lib/daemon.js')).href)
const OUT = join(BENCH, 'corpus/synthetic')
const FIXTURE = join(BENCH, 'fixture-app/dist/DSHFixture.app/Contents/MacOS/Electron')

const args = process.argv.slice(2)
const argValue = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const modes = (argValue('--modes') ?? 'dom,canvas,image').split(',')
const themes = (argValue('--themes') ?? 'light,dark').split(',')
const only = argValue('--only')

// Conversation/scroll positions. scroll = points scrolled up from the bottom.
const POSITIONS = [
  { conv: 'c1', scroll: 0 },
  { conv: 'c1', scroll: 130 },
  { conv: 'c1', scroll: 260 },
  { conv: 'c1', scroll: 390 },
  { conv: 'c1', scroll: 520 },
  { conv: 'c1', scroll: 9999 },
  { conv: 'c2', scroll: 0 },
  { conv: 'c3', scroll: 0 },
  { conv: 'c3', scroll: 9999 },
  { conv: 'c4', scroll: 0 },
  { conv: 'c5', scroll: 0 },
  { conv: 'c5', scroll: 9999 },
]

const content = yaml.load(readFileSync(join(BENCH, 'fixtures/content.yaml'), 'utf8'))
const messages = new Map(content.conversations.flatMap((c) => c.messages.map((m) => [m.id, m])))

const stripWs = (s) => s.replace(/\s+/g, '')

function toPixels(gt) {
  const { contentOffset, scaleFactor: s } = gt.window
  return ([x, y, w, h]) => [
    Math.round((contentOffset.x + x) * s), Math.round((contentOffset.y + y) * s),
    Math.round(w * s), Math.round(h * s),
  ]
}

/** Convert the fixture snapshot into the bench ground-truth format. */
function buildGroundTruth(name, gt) {
  const px = toPixels(gt)
  const visible = gt.lines.filter((l) => !l.clipped)
  // A keystring counts only if every character is on fully visible lines of its message.
  const byMsg = new Map()
  for (const l of visible) if (l.msgId) byMsg.set(l.msgId, (byMsg.get(l.msgId) ?? '') + l.text)
  const keystrings = []
  for (const [msgId, joined] of byMsg) {
    for (const k of messages.get(msgId)?.keystrings ?? []) {
      if (stripWs(joined).includes(stripWs(k))) keystrings.push({ text: k, msgId })
    }
  }
  return {
    image: `${name}.png`,
    source: 'fixture',
    fixture: { ...gt.config, conv: gt.state.conv, scroll: gt.state.scroll, maxScroll: gt.state.maxScroll },
    scaleFactor: gt.window.scaleFactor,
    contentOffsetPt: gt.window.contentOffset,
    windowBoundsPt: gt.window.bounds,
    lines: visible.map((l) => l.text),
    keystrings: keystrings.map((k) => k.text),
    keystringsDetail: keystrings,
    regions: gt.regions.map((r) => ({ text: r.label, id: r.id, role: r.role, bbox: px(r.bbox) })),
    linesDetail: gt.lines.map((l) => ({ ...l, bbox: px(l.bbox), bboxPt: l.bbox })),
  }
}

async function launchFixture(opts, gtPath) {
  const argv = ['--mode', opts.mode, '--theme', opts.theme, '--conv', opts.conv, '--scroll', String(opts.scroll), '--gt-out', gtPath, '--run-dir', join(BENCH, 'runs/corpus')]
  const child = spawn(FIXTURE, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture not READY: ${out}`)), 20_000)
    const onData = (chunk) => {
      out += chunk
      if (out.includes('READY')) { clearTimeout(timer); resolveReady() }
      if (out.includes('FATAL')) { clearTimeout(timer); reject(new Error(out)) }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
  })
  await ready
  return child
}

async function stop(child) {
  if (child.exitCode !== null) return
  const exited = new Promise((r) => child.once('exit', r))
  child.kill('SIGTERM')
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))])
}

/** CUADaemon resolves apps by name, so a stale fixture would be captured instead of ours. */
function fixturePids() {
  try {
    return execFileSync('pgrep', ['-f', 'DSHFixture.app/Contents/MacOS/Electron'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)
  } catch { return [] }
}

async function main() {
  for (const pid of fixturePids()) process.kill(pid, 'SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  mkdirSync(OUT, { recursive: true })
  const socketPath = join(mkdtempSync(join(tmpdir(), 'cua-corpus-')), 'cua.sock')
  const daemonCommand = process.env.DSH_COMPUTER_USE_DAEMON ?? join(LEGACY, 'native/.build/release/CUADaemon')
  const client = new DaemonClient({ socketPath, daemonCommand, daemonArgs: ['--socket', socketPath], toolCallTimeoutMs: 60_000 })
  await client.start()
  const seen = new Set()
  const index = []
  try {
    for (const mode of modes) for (const theme of themes) for (const pos of POSITIONS) {
      const tmpGt = join(mkdtempSync(join(tmpdir(), 'cua-gt-')), 'gt.json')
      const child = await launchFixture({ mode, theme, ...pos }, tmpGt)
      try {
        const gt = JSON.parse(readFileSync(tmpGt, 'utf8'))
        const name = `${mode}-${theme}-${gt.state.conv}-s${Math.round(gt.state.scroll)}`
        if (seen.has(name) || (only && name !== only)) continue
        seen.add(name)
        const pids = fixturePids()
        if (pids.length !== 1 || pids[0] !== child.pid) throw new Error(`expected only fixture pid ${child.pid}, found ${pids}`)
        // Fresh session per shot: the fixture pid changes on every launch.
        await client.request('ComputerUseIPCCodexTurnEndedRequest', {})
        const state = await client.request('ComputerUseIPCAppGetSkyshotRequest', { app: 'DSHFixture', disableDiff: true })
        if (state.screenshot === null) throw new Error(`${name}: screenshot is null (Screen Recording?)`)
        const shot = fileURLToPath(state.screenshot.url)
        copyFileSync(shot, join(OUT, `${name}.png`))
        rmSync(shot, { force: true })
        writeFileSync(join(OUT, `${name}.ax.txt`), state.text)
        writeFileSync(join(OUT, `${name}.gt.json`), JSON.stringify(buildGroundTruth(name, gt), null, 2))
        index.push({ name, mode, theme, conv: gt.state.conv, scroll: gt.state.scroll })
        process.stdout.write(`captured ${name}\n`)
      } finally {
        await stop(child)
        rmSync(dirname(tmpGt), { recursive: true, force: true })
      }
    }
  } finally {
    client.stop()
  }
  if (!only) writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2))
  process.stdout.write(`${index.length} shots -> ${OUT}\n`)
}

main().catch((error) => { console.error(error); process.exit(1) })
