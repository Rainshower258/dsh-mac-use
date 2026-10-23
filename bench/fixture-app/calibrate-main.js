// Calibration mode for the geometry suite (bench/geometry). Ground truth comes from here, never from the
// pipeline under test:
//   - markers: 9 colour-coded squares (corners, edge midpoints, centre), also exposed to AX as buttons;
//     their global position = Electron's own getContentBounds() origin + the renderer's layout rect.
//   - clicks: every mousedown's screenX/screenY (global points) is logged to clicks.jsonl.
//   - text lines (OCR experiments): the `lines` op places text; each line's global rect comes back as `texts`.
//   - control: the harness writes cmd.json ({seq, op, ...}); results and the current state go to state.json.
//
// Flags: --calibrate --run-dir DIR [--role fixture|blocker] [--x --y --w --h] [--frameless] [--label TEXT]
'use strict'

const { app, BrowserWindow, Menu, Notification, ipcMain, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

module.exports = function runCalibration(flags) {
  const runDir = path.resolve(flags['run-dir'] ?? path.join(__dirname, '..', 'runs', 'calib-adhoc'))
  const role = flags.role === 'blocker' ? 'blocker' : 'fixture'
  const statePath = path.join(runDir, 'state.json')
  const cmdPath = path.join(runDir, 'cmd.json')
  fs.mkdirSync(runDir, { recursive: true })

  app.setName(role === 'blocker' ? 'DSHBlocker' : 'DSHFixture')
  const windows = new Map()   // name -> BrowserWindow
  const markers = new Map()   // name -> [{id, hue, cx, cy}] in content coordinates
  const texts = new Map()     // name -> [{id, text, x, y, w, h}] in content coordinates
  const fieldValues = new Map()  // name -> {fieldId: value}
  let lastSeq = -1
  let lastResult = null

  function writeJsonAtomic(file, obj) {
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
    fs.renameSync(tmp, file)
  }

  function snapshot() {
    const displays = screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor }))
    const wins = {}
    for (const [name, w] of windows) {
      if (w.isDestroyed()) continue
      const cb = w.getContentBounds()
      wins[name] = {
        bounds: w.getBounds(), contentBounds: cb, visible: w.isVisible(), minimized: w.isMinimized(),
        fullScreen: w.isFullScreen(), simpleFullScreen: w.isSimpleFullScreen(), focused: w.isFocused(),
        mediaSourceId: w.getMediaSourceId(),
        markers: (markers.get(name) ?? []).map((m) => ({ id: m.id, hue: m.hue, x: cb.x + m.cx, y: cb.y + m.cy })),
        texts: (texts.get(name) ?? []).map((t) => ({ id: t.id, text: t.text, x: cb.x + t.x, y: cb.y + t.y, w: t.w, h: t.h })),
        fields: fieldValues.get(name) ?? {},
      }
    }
    return { role, pid: process.pid, lastSeq, lastResult, displays, windows: wins, writtenAt: Date.now() }
  }

  function publish() { writeJsonAtomic(statePath, snapshot()) }

  function open(name, { x, y, w, h, frameless, parent, modal }) {
    const win = new BrowserWindow({
      x, y, width: w, height: h, useContentSize: true, frame: !frameless, show: false, title: `${role}-${name}`,
      resizable: true, fullscreenable: true, parent, modal: Boolean(modal),
      backgroundColor: role === 'blocker' ? '#303030' : '#eeeeee',
      webPreferences: { preload: path.join(__dirname, 'calibrate-preload.js'), contextIsolation: true, sandbox: false,
                        zoomFactor: 1, devTools: false },
    })
    win.webContents.setVisualZoomLevelLimits(1, 1)
    win.loadFile(path.join(__dirname, 'calibrate.html'), { query: { role, name, label: name === 'main' ? (flags.label ?? '') : '' } })
    win.once('ready-to-show', () => { win.show(); publish() })
    for (const ev of ['move', 'resize', 'minimize', 'restore', 'enter-full-screen', 'leave-full-screen', 'show', 'hide']) {
      win.on(ev, () => setTimeout(publish, 50))
    }
    win.on('closed', () => { windows.delete(name); markers.delete(name); texts.delete(name); publish() })
    windows.set(name, win)
    return win
  }

  const ops = {
    move: (a) => windows.get(a.win ?? 'main').setPosition(a.x, a.y),
    moveAnimated: (a) => { const w = windows.get(a.win ?? 'main'); w.setBounds({ ...w.getBounds(), x: a.x, y: a.y }, true) },
    resize: (a) => windows.get(a.win ?? 'main').setContentSize(a.w, a.h),
    fullscreen: (a) => windows.get(a.win ?? 'main').setFullScreen(Boolean(a.on)),
    simpleFullscreen: (a) => windows.get(a.win ?? 'main').setSimpleFullScreen(Boolean(a.on)),
    minimize: (a) => windows.get(a.win ?? 'main').minimize(),
    restore: (a) => windows.get(a.win ?? 'main').restore(),
    hideApp: () => app.hide(),
    showApp: () => { app.show(); windows.get('main')?.show() },
    focus: (a) => { app.focus({ steal: true }); windows.get(a.win ?? 'main').focus() },
    open: (a) => open(a.name, a),
    close: (a) => windows.get(a.win)?.close(),
    sheet: () => open('sheet', { x: 0, y: 0, w: 360, h: 200, parent: windows.get('main'), modal: true }),
    contextMenu: (a) => Menu.buildFromTemplate([{ label: 'Calibration item A' }, { label: 'Calibration item B' }])
      .popup({ window: windows.get(a.win ?? 'main'), x: a.x, y: a.y }),
    // Window alpha (kCGWindowAlpha), not content transparency. catchMouse: true explicitly keeps mouse events, so
    // an invisible window still intercepts clicks (audit L3); false makes it click-through.
    opacity: (a) => {
      const w = windows.get(a.win ?? 'main')
      w.setOpacity(a.value)
      if (a.catchMouse !== undefined) w.setIgnoreMouseEvents(!a.catchMouse)
    },
    // [{id, text, x, y, size, ax}] in content points; a line with an existing id is replaced, text '' removes it;
    // ax: false hides the line from accessibility (only its pixels show it, like canvas text).
    lines: (a) => windows.get(a.win ?? 'main').webContents.send('calib:lines', a.lines),
    // [{id, kind: input|textarea|password, x, y, w, h, label}] in content points: R3 action tests. Values come back
    // in state (a password field's value too: it is the test's own synthetic string).
    fields: (a) => windows.get(a.win ?? 'main').webContents.send('calib:fields', a.fields),
    // level/relative: an Electron level name plus levels above it (relative up to the cursor level is possible).
    alwaysOnTop: (a) => windows.get(a.win ?? 'main').setAlwaysOnTop(Boolean(a.on), a.level ?? 'floating', a.relative ?? 0),
    // A real Notification Center banner (geometry notification-banner). Sent from this app, which runs in the GUI
    // session: osascript over ssh got a banner withdrawn as soon as it peeked in (2026-10-10).
    notify: (a) => new Notification({ title: a.title ?? 'DSH bench', body: a.body ?? 'geometry banner' }).show(),
    quit: () => app.quit(),
  }

  function pollCommands() {
    let cmd
    try { cmd = JSON.parse(fs.readFileSync(cmdPath, 'utf8')) } catch { return }
    if (typeof cmd.seq !== 'number' || cmd.seq <= lastSeq) return
    lastSeq = cmd.seq
    try {
      const fn = ops[cmd.op]
      if (!fn) throw new Error(`unknown op ${cmd.op}`)
      fn(cmd)
      lastResult = { seq: cmd.seq, ok: true }
    } catch (error) {
      lastResult = { seq: cmd.seq, ok: false, error: String(error) }
    }
    setTimeout(publish, 50)
  }

  ipcMain.on('calib:markers', (event, list) => {
    for (const [name, w] of windows) if (w.webContents === event.sender) markers.set(name, list)
    publish()
  })
  // R3 action tests: keyboard, click/dblclick, wheel and mouseup events go to events.jsonl, field values to state.
  ipcMain.on('calib:event', (event, e) => {
    let name = null
    for (const [n, w] of windows) if (w.webContents === event.sender) name = n
    fs.appendFileSync(path.join(runDir, 'events.jsonl'), JSON.stringify({ t: Date.now(), win: name, ...e }) + '\n')
  })
  ipcMain.on('calib:values', (event, v) => {
    for (const [name, w] of windows) if (w.webContents === event.sender) fieldValues.set(name, v)
    publish()
  })
  ipcMain.on('calib:texts', (event, list) => {
    for (const [name, w] of windows) if (w.webContents === event.sender) texts.set(name, list)
    publish()
  })
  ipcMain.on('calib:click', (event, hit) => {
    let name = null
    for (const [n, w] of windows) if (w.webContents === event.sender) name = n
    fs.appendFileSync(path.join(runDir, 'clicks.jsonl'), JSON.stringify({ t: Date.now(), win: name, ...hit }) + '\n')
  })

  app.whenReady().then(() => {
    // An Edit menu like real apps have: in Electron, cmd+A/C/V/X/Z in text fields are menu key equivalents.
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: app.getName(), submenu: [{ role: 'quit' }] },
                                                    { role: 'editMenu' }]))
    app.setAccessibilitySupportEnabled(true)
    open('main', {
      x: Number(flags.x ?? 200), y: Number(flags.y ?? 150), w: Number(flags.w ?? 800), h: Number(flags.h ?? 500),
      frameless: Boolean(flags.frameless),
    })
    setInterval(pollCommands, 100)
    process.stdout.write(`CALIBRATION ${role} ${statePath}\n`)
  })
  app.on('window-all-closed', () => app.quit())
}
