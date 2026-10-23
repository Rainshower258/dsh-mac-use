// DSHFixture main process: parses flags, opens one fixed-size window, relays
// the renderer's ground-truth snapshots and click hits to disk.
//
// Flags (all optional):
//   --mode dom|canvas|image   how text reaches pixels (default dom)
//   --theme light|dark        (default light)
//   --conv c3 | 3             initially selected conversation (default c1)
//   --scroll N                pixels scrolled up from the bottom of the chat (default 0)
//   --run-dir DIR             clicks.jsonl / events.jsonl go here (default bench/runs/adhoc)
//   --gt-out FILE             write the first stable ground-truth snapshot here, then print READY
//   --ax on|off               force Chromium accessibility on (default on; off mimics apps that never enable it)
//   --x N --y N               window position in global points (default 80, 80)
//   --content FILE            content YAML (default bench/fixtures/content.yaml)
//   --composer on             a real text box over the input area: Enter or the send button sends, logged as a
//                             `sent` event with the exact text (T10; off by default, so the other tasks are unchanged)
//   --cmd-file FILE           commands from the harness ({seq, op}); op `reorder` moves the last conversation to
//                             the top of the list (T11: elements go stale between observe and act)
'use strict'

const { app, BrowserWindow, Menu, ipcMain, nativeTheme, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')

// Fail loudly on stderr instead of Electron's modal error dialog, which would
// sit on the user's screen during unattended corpus runs.
process.on('uncaughtException', (error) => {
  process.stderr.write(`FATAL ${error.stack ?? error}\n`)
  process.exit(1)
})

const BENCH = path.resolve(__dirname, '..')
const CONTENT_W = 960
const CONTENT_H = 680

function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) flags[arg.slice(2)] = true
    else { flags[arg.slice(2)] = next; i++ }
  }
  return flags
}

const flags = parseFlags(process.argv.slice(1))
if (flags.calibrate) {
  // Geometry-suite calibration mode (bench/geometry); the chat fixture below is not loaded at all.
  require('./calibrate-main.js')(flags)
  return
}
const config = {
  mode: ['dom', 'canvas', 'image'].includes(flags.mode) ? flags.mode : 'dom',
  theme: flags.theme === 'dark' ? 'dark' : 'light',
  conv: /^\d+$/.test(String(flags.conv ?? '')) ? `c${flags.conv}` : (flags.conv || 'c1'),
  scroll: Number(flags.scroll ?? 0) || 0,
  ax: flags.ax !== 'off',
  composer: flags.composer === 'on',
  x: Number(flags.x ?? 80),
  y: Number(flags.y ?? 80),
}
const runDir = path.resolve(flags['run-dir'] ?? path.join(BENCH, 'runs', 'adhoc'))
const gtOut = flags['gt-out'] ? path.resolve(flags['gt-out']) : undefined
const contentPath = path.resolve(flags.content ?? path.join(BENCH, 'fixtures', 'content.yaml'))
const content = yaml.load(fs.readFileSync(contentPath, 'utf8'))

app.setName('DSHFixture')

function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n')
}

let win
let gtWritten = false

app.whenReady().then(() => {
  // No menu bar items, no DevTools, no zoom: an agent that cannot read the
  // pixels must not be able to open the console and read the page source, or
  // zoom the window away from the ground-truth layout (both observed in a run).
  // setApplicationMenu(null) keeps Electron's default menu on macOS; install a
  // minimal one explicitly.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'DSHFixture', submenu: [{ role: 'quit' }] },
    // With the composer, the standard Edit menu (cmd+A/C/V/X/Z are menu key equivalents in Electron).
    ...(config.composer ? [{ role: 'editMenu' }] : [])]))
  if (config.ax) app.setAccessibilitySupportEnabled(true)
  nativeTheme.themeSource = config.theme
  win = new BrowserWindow({
    x: config.x,
    y: config.y,
    width: CONTENT_W,
    height: CONTENT_H,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'DSHFixture',
    backgroundColor: config.theme === 'dark' ? '#1e1e1e' : '#f5f5f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      zoomFactor: 1,
      devTools: false,
    },
  })
  win.webContents.setVisualZoomLevelLimits(1, 1)
  win.webContents.on('zoom-changed', () => win.webContents.setZoomFactor(1))
  win.webContents.on('before-input-event', (event, input) => {
    if ((input.meta || input.control) && ['=', '+', '-', '0', 'i', 'I'].includes(input.key)) event.preventDefault()
  })
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(1))
  win.loadFile(path.join(__dirname, 'index.html'))
  win.once('ready-to-show', () => { win.show(); win.focus() })
  win.on('page-title-updated', (event) => event.preventDefault())
})

ipcMain.handle('fixture:init', () => ({ config, content }))

// Harness commands (--cmd-file): polled, each {seq, op} applied once, forwarded to the renderer.
const cmdFile = flags['cmd-file'] ? path.resolve(flags['cmd-file']) : undefined
let lastCmdSeq = -1
if (cmdFile !== undefined) {
  setInterval(() => {
    let cmd
    try { cmd = JSON.parse(fs.readFileSync(cmdFile, 'utf8')) } catch { return }
    if (typeof cmd.seq !== 'number' || cmd.seq <= lastCmdSeq || win === undefined) return
    lastCmdSeq = cmd.seq
    win.webContents.send('fixture:cmd', cmd)
  }, 150)
}

ipcMain.on('fixture:click', (_event, hit) => {
  appendJsonl(path.join(runDir, 'clicks.jsonl'), { mode: config.mode, ...hit })
})

ipcMain.on('fixture:event', (_event, record) => {
  appendJsonl(path.join(runDir, 'events.jsonl'), { mode: config.mode, ...record })
})

// The renderer posts a snapshot after every paint; the first one after the
// window is visible is the corpus ground truth.
ipcMain.on('fixture:rendered', (_event, snapshot) => {
  if (gtOut === undefined || gtWritten || win === undefined || !win.isVisible()) return
  gtWritten = true
  const bounds = win.getBounds()
  const contentBounds = win.getContentBounds()
  const display = screen.getDisplayMatching(bounds)
  const record = {
    config,
    content: path.relative(BENCH, contentPath),
    window: {
      bounds,
      contentBounds,
      // Offset of the web content inside the captured window image, in points.
      contentOffset: { x: contentBounds.x - bounds.x, y: contentBounds.y - bounds.y },
      scaleFactor: display.scaleFactor,
    },
    ...snapshot,
  }
  fs.mkdirSync(path.dirname(gtOut), { recursive: true })
  fs.writeFileSync(gtOut, JSON.stringify(record, null, 2))
  // A painted frame reaches the window server a little after rAF; give it
  // time so an immediate window capture is not blank.
  setTimeout(() => process.stdout.write(`READY ${gtOut}\n`), 700)
})

app.on('window-all-closed', () => app.quit())
