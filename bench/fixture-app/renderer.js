// DSHFixture renderer.
//
// One layout pass turns content.yaml into positioned "blocks" (sidebar rows,
// header, bubbles, buttons). Each block holds draw primitives in window-content
// points. Three renderers then turn the same primitives into pixels:
//   dom    — every text line is a real DOM text node (AX-visible)
//   canvas — everything is painted on one <canvas> (AX sees no text)
//   image  — each block is pre-rendered to a PNG <img> without alt (AX sees no text)
// Line wrapping is computed once with canvas measureText, so the ground truth
// (text + bbox of every visible line) is identical across modes.
'use strict'

const W = 960
const H = 680
const SIDEBAR_W = 250
const HEADER_H = 52
const INPUT_H = 128
const VIEWPORT = { x: SIDEBAR_W, y: HEADER_H, w: W - SIDEBAR_W, h: H - HEADER_H - INPUT_H }
const COMPOSER = [SIDEBAR_W + 16, H - INPUT_H + 38, W - SIDEBAR_W - 16 - 20 - 72 - 16, 78]
const SANS = '-apple-system, "PingFang SC", "Helvetica Neue", sans-serif'
const MONO = 'Menlo, "PingFang SC", monospace'
const DPR = window.devicePixelRatio || 1

const THEMES = {
  light: {
    bg: '#f5f5f5', sidebar: '#ebebeb', active: '#d4d4d4', border: '#dcdcdc',
    text: '#1a1a1a', sub: '#8a8a8a', faint: '#c4c4c4',
    other: '#ffffff', self: '#95ec69', selfText: '#111111',
    codeBg: '#f1f1f1', button: '#ffffff', buttonText: '#333333',
    send: '#07c160', sendText: '#ffffff', search: '#dedede',
  },
  dark: {
    bg: '#1e1e1e', sidebar: '#262626', active: '#383838', border: '#333333',
    text: '#e6e6e6', sub: '#8c8c8c', faint: '#4a4a4a',
    other: '#2c2c2c', self: '#3eb575', selfText: '#0c140c',
    codeBg: '#151515', button: '#2f2f2f', buttonText: '#d0d0d0',
    send: '#07c160', sendText: '#ffffff', search: '#303030',
  },
}

// Picture-message styling does not follow the app theme (it is a picture).
const CARD = { bg: '#fff8e1', border: '#e0c98f', title: '#5b4200', text: '#3d3d3d' }

const measureCtx = document.createElement('canvas').getContext('2d')

function font(size, weight = 400, family = SANS) {
  return `${weight} ${size}px ${family}`
}

function measure(text, f) {
  measureCtx.font = f
  return measureCtx.measureText(text).width
}

/** Split into wrap tokens: CJK/emoji chars stand alone, latin runs stay together. */
function tokenize(text) {
  return text.match(/[A-Za-z0-9_.:/#@%&+\-=~'"()[\]{}<>,;!?$¥*|\\^`]+|\s+|./gu) ?? []
}

const NO_LINE_START = new Set([...'。，、；：？！）》」』】,.;:!?)'])

/** Greedy line wrap using real glyph widths; over-long tokens are char-broken. */
function wrap(text, f, maxWidth) {
  const lines = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const token of tokenize(para)) {
      // Closing punctuation hangs at line end instead of starting a new line.
      if (measure(line + token, f) <= maxWidth || (NO_LINE_START.has(token) && line !== '')) { line += token; continue }
      if (line.trim() !== '') lines.push(line.replace(/\s+$/, ''))
      line = /^\s+$/.test(token) ? '' : token
      while (measure(line, f) > maxWidth) {
        let cut = line.length
        while (cut > 1 && measure(line.slice(0, cut), f) > maxWidth) cut--
        lines.push(line.slice(0, cut))
        line = line.slice(cut)
      }
    }
    lines.push(line)
  }
  return lines
}

function truncate(text, f, maxWidth) {
  const first = text.split('\n')[0]
  if (measure(first, f) <= maxWidth) return first
  let cut = first.length
  while (cut > 0 && measure(first.slice(0, cut) + '…', f) > maxWidth) cut--
  return first.slice(0, cut) + '…'
}

// ---------------------------------------------------------------- layout

function layout(state, content) {
  const t = THEMES[state.theme]
  const blocks = []
  const add = (block) => { blocks.push(block); return block }
  const text = (s, x, y, size, color, opts = {}) => {
    const f = font(size, opts.weight ?? 400, opts.family ?? SANS)
    return { type: 'text', text: s, x, y, w: measure(s, f), h: opts.lh ?? Math.round(size * 1.5), font: f, size, color }
  }
  const rect = (x, y, w, h, fill, r = 0, stroke) => ({ type: 'rect', x, y, w, h, fill, r, stroke })

  // Background planes (not blocks: they carry no text and no hit target).
  const planes = [
    rect(0, 0, W, H, t.bg),
    rect(0, 0, SIDEBAR_W, H, t.sidebar),
    rect(SIDEBAR_W, HEADER_H - 1, W - SIDEBAR_W, 1, t.border),
    rect(SIDEBAR_W, H - INPUT_H, W - SIDEBAR_W, 1, t.border),
    rect(SIDEBAR_W - 1, 0, 1, H, t.border),
  ]

  // Sidebar header + search box.
  add({ id: 'sidebar-title', role: 'label', prims: [text('消息', 20, 14, 16, t.text, { weight: 600, lh: 24 })] })
  add({
    id: 'search', role: 'input',
    prims: [rect(16, 48, SIDEBAR_W - 32, 28, t.search, 6), text('搜索', 28, 53, 13, t.sub, { lh: 18 })],
  })

  // Conversation rows (in state.order when the harness reordered them).
  const ordered = (state.order ?? content.conversations.map((c) => c.id)).map((id) => content.conversations.find((c) => c.id === id))
  ordered.forEach((conv, i) => {
    const y = 88 + i * 66
    const last = conv.messages[conv.messages.length - 1]
    const previewSrc = last.kind === 'image' ? '[图片]' : last.text
    const preview = truncate(previewSrc, font(12), SIDEBAR_W - 40)
    const time = last.time.replace(/^昨天 .*/, '昨天')
    const active = conv.id === state.conv
    add({
      id: `conv:${conv.id}`, role: 'conv', label: conv.name, clickable: true,
      bbox: [0, y, SIDEBAR_W - 1, 64],
      prims: [
        ...(active ? [rect(0, y, SIDEBAR_W - 1, 64, t.active)] : []),
        text(conv.name, 20, y + 11, 14, t.text, { weight: 500, lh: 21 }),
        text(time, SIDEBAR_W - 20 - measure(time, font(11)), y + 13, 11, t.sub, { lh: 16 }),
        text(preview, 20, y + 35, 12, t.sub, { lh: 18 }),
      ],
    })
  })

  const conv = content.conversations.find((c) => c.id === state.conv) ?? content.conversations[0]

  // Header title + action buttons.
  add({ id: 'header-title', role: 'label', prims: [text(conv.name, SIDEBAR_W + 20, 15, 16, t.text, { weight: 600, lh: 24 })] })
  const headerButtons = ['转发', '收藏', '更多']
  headerButtons.forEach((label, i) => {
    const bw = 56
    const x = W - 20 - (headerButtons.length - i) * (bw + 8) + 8
    add(button(`btn:${label}`, label, x, 12, bw, 28, t.button, t.buttonText, 13))
  })

  // Input area: toolbar, placeholder, send button.
  ;['表情', '文件', '截图'].forEach((label, i) => {
    add(button(`btn:${label}`, label, SIDEBAR_W + 16 + i * 56, H - INPUT_H + 10, 48, 24, t.button, t.buttonText, 12))
  })
  // With --composer the real text box (created once, outside #root) carries the placeholder.
  add({ id: 'input', role: 'input', bbox: COMPOSER, prims: state.composer ? [] : [text('输入消息…', SIDEBAR_W + 20, H - INPUT_H + 46, 14, t.sub, { lh: 21 })] })
  add(button('btn:发送', '发送', W - 20 - 72, H - 16 - 30, 72, 30, t.send, t.sendText, 14))

  function button(id, label, x, y, w, h, bg, fg, size) {
    const tw = measure(label, font(size))
    return {
      id, role: 'button', label, clickable: true, bbox: [x, y, w, h],
      prims: [rect(x, y, w, h, bg, 6, bg === t.button ? t.border : undefined), text(label, x + (w - tw) / 2, y + (h - Math.round(size * 1.5)) / 2, size, fg)],
    }
  }

  // Messages, laid out in scroll-content space first.
  const msgBlocks = []
  let cy = 12
  const maxText = 400
  for (const m of conv.messages) {
    const self = m.from === 'self'
    const styles = new Set(m.style ?? [])
    const prims = []
    // Meta line: sender + time (self shows time only).
    const meta = self ? m.time : `${m.from}  ${m.time}`
    const metaW = measure(meta, font(12))
    const metaX = self ? VIEWPORT.x + VIEWPORT.w - 24 - metaW : VIEWPORT.x + 24
    prims.push({ ...text(meta, metaX, cy, 12, t.sub, { lh: 18 }), part: 'meta' })
    cy += 20

    let bubble
    if (m.kind === 'image') {
      const lines = m.text.split('\n')
      const bw = 300
      const lh = 22
      const bh = 14 * 2 + lines.length * lh
      const bx = self ? VIEWPORT.x + VIEWPORT.w - 24 - bw : VIEWPORT.x + 24
      bubble = { x: bx, y: cy, w: bw, h: bh, image: true }
      prims.push(rect(bx, cy, bw, bh, CARD.bg, 8, CARD.border))
      lines.forEach((line, i) => {
        const size = i === 0 ? 15 : 13
        prims.push({ ...text(line, bx + 14, cy + 14 + i * lh, size, i === 0 ? CARD.title : CARD.text, { weight: i === 0 ? 600 : 400, lh }), inImage: true, part: 'image' })
      })
    } else {
      const code = m.kind === 'code'
      const size = code ? 12 : styles.has('small') ? 11 : 14
      const lh = code ? 18 : Math.round(size * 1.5)
      const f = font(size, 400, code ? MONO : SANS)
      const lines = wrap(m.text, f, code ? 460 : maxText)
      const tw = Math.max(...lines.map((l) => measure(l, f)))
      const bw = Math.ceil(tw) + 24
      const bh = lines.length * lh + 16
      const bx = self ? VIEWPORT.x + VIEWPORT.w - 24 - bw : VIEWPORT.x + 24
      const fill = code ? t.codeBg : self ? t.self : t.other
      const color = styles.has('faint') ? t.faint : self ? t.selfText : t.text
      bubble = { x: bx, y: cy, w: bw, h: bh }
      prims.push(rect(bx, cy, bw, bh, fill, 8))
      lines.forEach((line, i) => {
        prims.push({ ...text(line, bx + 12, cy + 8 + i * lh, size, color, { lh, family: code ? MONO : SANS }), part: code ? 'code' : 'body' })
      })
    }
    cy += bubble.h + 16
    msgBlocks.push({
      id: `msg:${m.id}`, role: 'message', msgId: m.id, clickable: true, kind: m.kind ?? 'text', style: m.style ?? [],
      bbox: [bubble.x, bubble.y, bubble.w, bubble.h], prims, inViewport: true,
    })
  }

  // Scroll: 0 = pinned to bottom (latest message visible), like chat apps.
  const contentH = cy
  const maxOffset = Math.max(0, contentH - VIEWPORT.h)
  const offset = Math.max(0, Math.min(maxOffset, maxOffset - state.scroll))
  state.scroll = maxOffset - offset
  state.maxScroll = maxOffset
  const dy = VIEWPORT.y - offset
  for (const b of msgBlocks) {
    b.bbox = [b.bbox[0], b.bbox[1] + dy, b.bbox[2], b.bbox[3]]
    for (const p of b.prims) p.y += dy
    // Virtualize like real chat lists: blocks fully outside the viewport are not rendered.
    const top = Math.min(...b.prims.map((p) => p.y))
    const bottom = Math.max(...b.prims.map((p) => p.y + p.h))
    if (bottom <= VIEWPORT.y || top >= VIEWPORT.y + VIEWPORT.h) continue
    blocks.push(b)
  }
  return { planes, blocks, conv }
}

// ---------------------------------------------------------------- drawing

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

function drawPrim(ctx, p) {
  if (p.type === 'rect') {
    roundRectPath(ctx, p.x, p.y, p.w, p.h, p.r)
    ctx.fillStyle = p.fill
    ctx.fill()
    if (p.stroke) { ctx.strokeStyle = p.stroke; ctx.lineWidth = 1; ctx.stroke() }
  } else {
    ctx.font = p.font
    ctx.fillStyle = p.color
    ctx.textBaseline = 'middle'
    ctx.fillText(p.text, p.x, p.y + p.h / 2)
  }
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas')
  c.width = Math.ceil(w * DPR)
  c.height = Math.ceil(h * DPR)
  c.style.width = `${w}px`
  c.style.height = `${h}px`
  const ctx = c.getContext('2d')
  ctx.scale(DPR, DPR)
  return { c, ctx }
}

function renderCanvas(root, model) {
  const { c, ctx } = makeCanvas(W, H)
  c.className = 'abs'
  c.style.left = '0px'
  c.style.top = '0px'
  for (const p of model.planes) drawPrim(ctx, p)
  for (const b of model.blocks) {
    ctx.save()
    if (b.inViewport) { ctx.beginPath(); ctx.rect(VIEWPORT.x, VIEWPORT.y, VIEWPORT.w, VIEWPORT.h); ctx.clip() }
    for (const p of b.prims) drawPrim(ctx, p)
    ctx.restore()
  }
  root.appendChild(c)
}

function blockBounds(b) {
  const xs = b.prims.map((p) => p.x)
  const ys = b.prims.map((p) => p.y)
  const x = Math.floor(Math.min(...xs)) - 1
  const y = Math.floor(Math.min(...ys)) - 1
  const r = Math.ceil(Math.max(...b.prims.map((p) => p.x + p.w))) + 1
  const btm = Math.ceil(Math.max(...b.prims.map((p) => p.y + p.h))) + 1
  return { x, y, w: r - x, h: btm - y }
}

function renderImage(root, model, theme) {
  // Planes stay plain divs (no text); every text-bearing block becomes a PNG.
  for (const p of model.planes) root.appendChild(domRect(p))
  const viewport = clipDiv()
  root.appendChild(viewport)
  for (const b of model.blocks) {
    const bb = blockBounds(b)
    const { c, ctx } = makeCanvas(bb.w, bb.h)
    ctx.translate(-bb.x, -bb.y)
    // Paint the underlying plane colour so anti-aliasing matches canvas mode.
    ctx.fillStyle = b.inViewport ? theme.bg : b.id.startsWith('conv:') || b.id === 'search' || b.id === 'sidebar-title' ? theme.sidebar : theme.bg
    ctx.fillRect(bb.x, bb.y, bb.w, bb.h)
    for (const p of b.prims) drawPrim(ctx, p)
    const img = document.createElement('img')
    img.className = 'abs'
    img.src = c.toDataURL('image/png')
    img.alt = ''
    img.draggable = false
    place(img, b.inViewport ? bb.x - VIEWPORT.x : bb.x, b.inViewport ? bb.y - VIEWPORT.y : bb.y, bb.w, bb.h)
    ;(b.inViewport ? viewport : root).appendChild(img)
  }
}

function renderDom(root, model) {
  for (const p of model.planes) root.appendChild(domRect(p))
  const viewport = clipDiv()
  root.appendChild(viewport)
  for (const b of model.blocks) {
    const parent = b.inViewport ? viewport : root
    const ox = b.inViewport ? VIEWPORT.x : 0
    const oy = b.inViewport ? VIEWPORT.y : 0
    if (b.role === 'button') {
      const [bgRect, label] = b.prims
      const el = document.createElement('button')
      el.className = 'abs'
      el.textContent = label.text
      place(el, bgRect.x, bgRect.y, bgRect.w, bgRect.h)
      el.style.background = bgRect.fill
      el.style.color = label.color
      el.style.font = label.font
      el.style.borderRadius = `${bgRect.r}px`
      if (bgRect.stroke) el.style.boxShadow = `inset 0 0 0 1px ${bgRect.stroke}`
      el.style.lineHeight = `${bgRect.h}px`
      root.appendChild(el)
      continue
    }
    const group = document.createElement('div')
    group.className = 'abs'
    group.style.left = '0px'
    group.style.top = '0px'
    // Text baked into a picture message stays a picture even in dom mode.
    const card = b.kind === 'image' ? b.prims.find((p) => p.type === 'rect' && p.stroke === CARD.border) : undefined
    for (const p of b.prims) {
      if (p.inImage || p === card) continue
      const el = p.type === 'rect' ? domRect(p) : domText(p)
      el.style.left = `${p.x - ox}px`
      el.style.top = `${p.y - oy}px`
      group.appendChild(el)
    }
    if (card !== undefined) {
      const bb = blockBounds({ prims: [card] })
      const { c, ctx } = makeCanvas(bb.w, bb.h)
      ctx.translate(-bb.x, -bb.y)
      ctx.fillStyle = THEMES[document.body.dataset.theme ?? 'light'].bg
      ctx.fillRect(bb.x, bb.y, bb.w, bb.h)
      for (const p of b.prims) if (p === card || p.inImage) drawPrim(ctx, p)
      const img = document.createElement('img')
      img.className = 'abs'
      img.src = c.toDataURL('image/png')
      img.alt = ''
      place(img, bb.x - ox, bb.y - oy, bb.w, bb.h)
      group.appendChild(img)
    }
    parent.appendChild(group)
  }
}

function place(el, x, y, w, h) {
  el.style.left = `${x}px`
  el.style.top = `${y}px`
  el.style.width = `${w}px`
  el.style.height = `${h}px`
}

function clipDiv() {
  const d = document.createElement('div')
  d.className = 'clip'
  place(d, VIEWPORT.x, VIEWPORT.y, VIEWPORT.w, VIEWPORT.h)
  return d
}

function domRect(p) {
  const d = document.createElement('div')
  d.className = 'abs'
  place(d, p.x, p.y, p.w, p.h)
  d.style.background = p.fill
  d.style.borderRadius = `${p.r}px`
  if (p.stroke) d.style.boxShadow = `inset 0 0 0 1px ${p.stroke}`
  return d
}

function domText(p) {
  const d = document.createElement('div')
  d.className = 'line'
  d.textContent = p.text
  d.style.font = p.font
  d.style.color = p.color
  d.style.lineHeight = `${p.h}px`
  d.style.height = `${p.h}px`
  return d
}

// ---------------------------------------------------------------- ground truth

function snapshot(state, model) {
  const lines = []
  const regions = []
  const vpBottom = VIEWPORT.y + VIEWPORT.h
  for (const b of model.blocks) {
    for (const p of b.prims) {
      if (p.type !== 'text' || p.text.trim() === '') continue
      const clipped = b.inViewport && (p.y < VIEWPORT.y || p.y + p.h > vpBottom)
      const hidden = b.inViewport && (p.y + p.h <= VIEWPORT.y || p.y >= vpBottom)
      if (hidden) continue
      lines.push({
        text: p.text,
        bbox: [round(p.x), round(p.y), round(p.w), round(p.h)],
        block: b.id,
        role: b.role,
        ...(b.msgId ? { msgId: b.msgId } : {}),
        fontPx: p.size,
        inImage: Boolean(p.inImage),
        part: p.part ?? b.role,
        faint: Boolean(b.style?.includes('faint')) && p.part === 'body',
        clipped,
      })
    }
    if (b.clickable) {
      const [x, y, w, h] = b.bbox
      const top = Math.max(y, b.inViewport ? VIEWPORT.y : y)
      const bottom = Math.min(y + h, b.inViewport ? vpBottom : y + h)
      if (bottom > top) regions.push({ id: b.id, role: b.role, label: b.label ?? b.msgId, bbox: [round(x), round(top), round(w), round(bottom - top)] })
    }
  }
  // Reading order: top-to-bottom, then left-to-right.
  lines.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])
  return {
    state: { conv: state.conv, scroll: state.scroll, maxScroll: state.maxScroll },
    viewport: [VIEWPORT.x, VIEWPORT.y, VIEWPORT.w, VIEWPORT.h],
    coordSpace: 'window-content points (CSS px at zoom 1)',
    lines,
    regions,
  }
}

function round(v) { return Math.round(v * 10) / 10 }

// ---------------------------------------------------------------- app

async function main() {
  const { config, content } = await window.fixture.init()
  const state = { conv: config.conv, scroll: config.scroll, theme: config.theme, composer: config.composer, order: null }
  document.body.dataset.theme = config.theme
  const root = document.getElementById('root')
  let model

  function render() {
    model = layout(state, content)
    root.replaceChildren()
    if (config.mode === 'canvas') renderCanvas(root, model)
    else if (config.mode === 'image') renderImage(root, model, THEMES[state.theme])
    else renderDom(root, model)
    requestAnimationFrame(() => requestAnimationFrame(() => window.fixture.rendered(snapshot(state, model))))
  }

  root.addEventListener('mousedown', (event) => {
    const x = event.clientX
    const y = event.clientY
    const hit = [...model.blocks].reverse().find((b) => {
      if (!b.clickable) return false
      const [bx, by, bw, bh] = b.bbox
      const inside = x >= bx && x <= bx + bw && y >= by && y <= by + bh
      const visible = !b.inViewport || (y >= VIEWPORT.y && y <= VIEWPORT.y + VIEWPORT.h)
      return inside && visible
    })
    window.fixture.click({ x, y, button: event.button, target: hit?.id ?? null, role: hit?.role ?? null, label: hit?.label ?? hit?.msgId ?? null, conv: state.conv })
    if (hit?.id === 'btn:发送') send()
    if (hit?.role === 'conv') {
      state.conv = hit.id.slice('conv:'.length)
      state.scroll = 0
      window.fixture.event({ type: 'conv', conv: state.conv })
      render()
    }
  })

  root.addEventListener('wheel', (event) => {
    if (event.clientX < VIEWPORT.x || event.clientY < VIEWPORT.y || event.clientY > VIEWPORT.y + VIEWPORT.h) return
    const before = state.scroll
    state.scroll = Math.max(0, Math.min(state.maxScroll ?? 0, state.scroll - event.deltaY))
    if (state.scroll !== before) {
      window.fixture.event({ type: 'scroll', conv: state.conv, scroll: state.scroll })
      render()
    }
  }, { passive: true })

  // Composer (T10): a real text box; Enter (not while an input method composes) or the send button sends. The exact
  // text is logged, then appended to the conversation as the local user's message.
  let composer
  let sentN = 0
  function send() {
    if (composer === undefined) return
    const text = composer.value
    if (text.trim() === '') return
    window.fixture.event({ type: 'sent', conv: state.conv, text })
    const conv = content.conversations.find((c) => c.id === state.conv)
    const now = new Date()
    conv.messages.push({ id: `${conv.id}s${++sentN}`, from: 'self', time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`, text })
    composer.value = ''
    state.scroll = 0
    render()
  }
  if (config.composer) {
    composer = document.createElement('textarea')
    composer.id = 'composer'
    composer.placeholder = '输入消息…'
    composer.setAttribute('aria-label', '输入消息')
    const [cx, cy, cw, ch] = COMPOSER
    composer.style.cssText = `position:absolute; left:${cx}px; top:${cy}px; width:${cw}px; height:${ch}px; z-index:5; resize:none; border:0; outline:none; background:transparent; font:14px -apple-system, "PingFang SC", sans-serif; color:${THEMES[state.theme].text}; user-select:text;`
    composer.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send() }
    })
    document.body.appendChild(composer)
  }
  window.fixture.onCommand((cmd) => {
    if (cmd.op === 'reorder') {
      const ids = state.order ?? content.conversations.map((c) => c.id)
      state.order = [ids[ids.length - 1], ...ids.slice(0, -1)]
      window.fixture.event({ type: 'reorder', order: state.order })
      render()
    }
  })

  await document.fonts.ready
  render()
}

main()
