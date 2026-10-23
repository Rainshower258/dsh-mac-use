/**
 * Client for the cu-runtime daemon (PLAN-v2 §5.4, R4). It never spawns the daemon: a daemon spawned by node would
 * get node's TCC permissions, not the app's. With an AutoStart (config autoStart: cu-std, the bundle's 电脑操作 mode)
 * it asks LaunchServices to start the app when the daemon cannot be reached (autostart.ts); otherwise it only
 * connects. JSON-RPC 2.0 over the Unix socket, each frame a 4-byte little-endian length and the JSON body; the first
 * frame is session.hello with the token the daemon wrote next to its socket.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AutoStart } from './autostart.ts'

/** Frames above this are refused by the daemon too (256 KiB requests; responses carry images, so larger). */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024

export const DEFAULT_STATE_DIR = join(homedir(), 'Library/Application Support/cu-runtime')

/** How to start the daemon, shown whenever it cannot be reached. */
export const START_HINT =
  'Start it as the app itself so it keeps its own Accessibility and Screen Recording permissions: '
  + '`open -a CURuntime --args serve` (or install its LaunchAgent). The plugin never spawns it: with autoStart on, it '
  + 'only asks macOS to open the installed app, and only a release build it verified.'

/** Why it was not started again (autostart.ts): the user's stop stands until they start it. */
export const STOPPED_HINT =
  'It was stopped (pkill, force quit, or it exited) after this session had used it, so it is not started again '
  + 'automatically. Do not start it yourself: tell the user, who can start it again with `open ~/Applications/CURuntime.app`.'

/**
 * Why autoStart opened nothing (autostart.ts `refused`): the app is not one the host verified (the reason's TaskError
 * code: not_installed, identity_missing, identity_ambiguous, not_release_build, signature_mismatch; internal when the
 * check itself failed).
 */
export function refusedDetail(code: string): string {
  return `the installed CURuntime.app is not a release build the plugin verified: ${code}`
}

/** What the model is told then: the daemon is not started, and the user installs or updates the app on the page. */
export const REFUSED_HINT =
  'The daemon is not started. Do not start it yourself: tell the user, who can install or update CURuntime.app on the '
  + 'plugin page\'s 守护进程 tab.'

/** The daemon could not be reached: nothing was executed. */
export class DaemonUnavailable extends Error {
  constructor(detail: string, hint = START_HINT) {
    super(`cu-runtime daemon is not reachable (${detail}). ${hint}`)
    this.name = 'DaemonUnavailable'
  }
}

/** A JSON-RPC error from the daemon; refusals carry data.reason / data.retry / data.executed. */
export class RpcError extends Error {
  readonly code: number
  readonly data: Record<string, unknown>
  constructor(code: number, message: string, data: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {}
  }

  get reason(): string | undefined { return typeof this.data.reason === 'string' ? this.data.reason : undefined }
  get retry(): string | undefined { return typeof this.data.retry === 'string' ? this.data.retry : undefined }
}

export interface ClientOptions {
  /** The daemon's state dir (socket + token). */
  stateDir?: string
  /** Per-request timeout; the daemon's own watchdog is 30 s. */
  timeoutMs?: number
  /** Start the daemon when it cannot be reached (cu-std); absent, the client only connects. */
  autoStart?: AutoStart
  /** How long a started daemon gets to accept connections. */
  startWaitMs?: number
  /**
   * After the daemon closed this client's connection: how long to wait before checking whether it still listens
   * (an exiting daemon takes a moment to close its socket). Only with autoStart.
   */
  closeProbeDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** Whether something accepts connections on the socket now (nothing is sent; the probe is closed at once). */
export function stillListening(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(path)
    const done = (alive: boolean) => {
      clearTimeout(timer)
      s.destroy()
      resolve(alive)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  timer: NodeJS.Timeout
}

export class CURuntimeClient {
  readonly stateDir: string
  private readonly timeoutMs: number
  private socket?: Socket
  private connecting?: Promise<void>
  private connectingMayStart = false
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  private readonly autoStart?: AutoStart
  private readonly startWaitMs: number
  private readonly closeProbeDelayMs: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: ClientOptions = {}) {
    this.stateDir = options.stateDir ?? DEFAULT_STATE_DIR
    this.timeoutMs = options.timeoutMs ?? 40_000
    this.autoStart = options.autoStart
    this.startWaitMs = options.startWaitMs ?? 15_000
    this.closeProbeDelayMs = options.closeProbeDelayMs ?? 300
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * Send one request (connecting and saying hello first if needed). `start: false` only connects: the turn markers
   * use it, so a turn that never uses the screen does not start the daemon (VM 2026-10-11); a cu_* call may.
   */
  async request(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal,
                options: { start?: boolean } = {}): Promise<unknown> {
    await this.connect(options.start ?? true)
    return this.send(method, params, signal)
  }

  close(): void {
    this.socket?.destroy()
    this.socket = undefined
    this.connecting = undefined
    this.failAll(new DaemonUnavailable('connection closed'))
  }

  private connect(start: boolean): Promise<void> {
    if (this.socket !== undefined && !this.socket.destroyed) return Promise.resolve()
    // A connect that may not start the daemon is in flight: a caller that may start it tries again after it fails.
    if (this.connecting !== undefined && start && !this.connectingMayStart) {
      return this.connecting.catch(() => this.connect(start))
    }
    if (this.connecting === undefined) {
      this.connectingMayStart = start
      this.connecting = this.open(start).catch((e) => {
        this.connecting = undefined
        throw e
      })
    }
    return this.connecting
  }

  private async open(start: boolean): Promise<void> {
    try {
      return await this.openOnce()
    } catch (e) {
      if (!(e instanceof DaemonUnavailable) || this.autoStart === undefined || !start) throw e
      let started
      try {
        started = await this.autoStart.start()
      } catch (err) {
        throw new DaemonUnavailable(`starting it failed: ${String(err)}`)
      }
      if (started === 'stopped-by-user') throw new DaemonUnavailable('stopped', STOPPED_HINT)
      if (started === 'cooling-down') throw e
      if (typeof started === 'object') throw new DaemonUnavailable(refusedDetail(started.reason.code), REFUSED_HINT)
      const deadline = Date.now() + this.startWaitMs
      for (;;) {
        await this.sleep(250)
        try {
          return await this.openOnce()
        } catch (again) {
          if (!(again instanceof DaemonUnavailable)) throw again
          if (Date.now() >= deadline) {
            throw new DaemonUnavailable(`started, but not reachable after ${this.startWaitMs / 1000} s`)
          }
        }
      }
    }
  }

  private async openOnce(): Promise<void> {
    let token: string
    try {
      token = readFileSync(join(this.stateDir, 'token'), 'utf8').trim()
    } catch {
      throw new DaemonUnavailable(`no token in ${this.stateDir}`)
    }
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(join(this.stateDir, 'daemon.sock'))
      s.once('connect', () => resolve(s))
      s.once('error', (e) => reject(new DaemonUnavailable(String((e as NodeJS.ErrnoException).code ?? e))))
    })
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => this.onData(chunk))
    let greeted = false
    socket.on('close', () => {
      // Gone while this client still held it (close() lets go first): the daemon was stopped, or exited, unless it
      // only closed an idle connection (5 minutes without a request, idle_timeout) and still listens: that is no stop
      // (2026-10-14, the maintainer's Mac: an idle close had left the mark while the daemon ran on).
      if (this.socket === socket && greeted && this.autoStart !== undefined) {
        const auto = this.autoStart
        const sock = join(this.stateDir, 'daemon.sock')
        setTimeout(() => {
          void stillListening(sock).then((alive) => { if (!alive) auto.markStopped() })
        }, this.closeProbeDelayMs).unref()
      }
      if (this.socket === socket) this.socket = undefined
      this.connecting = undefined
      this.failAll(new DaemonUnavailable('connection closed'))
    })
    socket.on('error', () => { /* 'close' follows and fails pending requests */ })
    await this.send('session.hello', { token })
    greeted = true
    this.autoStart?.connected()
  }

  private send(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const socket = this.socket
    if (socket === undefined) return Promise.reject(new DaemonUnavailable('not connected'))
    const id = this.nextId++
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32LE(body.length, 0)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`cu-runtime: ${method} got no answer within ${this.timeoutMs} ms; its outcome is unknown`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      signal?.addEventListener('abort', () => {
        const p = this.pending.get(id)
        if (p === undefined) return
        clearTimeout(p.timer)
        this.pending.delete(id)
        reject(signal.reason ?? new Error('aborted'))
      }, { once: true })
      socket.write(Buffer.concat([header, body]))
    })
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32LE(0)
      if (len > MAX_RESPONSE_BYTES) {
        this.close()
        return
      }
      if (this.buffer.length < 4 + len) return
      const body = this.buffer.subarray(4, 4 + len)
      this.buffer = this.buffer.subarray(4 + len)
      let msg: { id?: number, result?: unknown, error?: { code: number, message: string, data?: unknown } }
      try {
        msg = JSON.parse(body.toString('utf8'))
      } catch {
        continue
      }
      const p = msg.id === undefined ? undefined : this.pending.get(msg.id)
      if (p === undefined) {
        // A reply without id (e.g. too_many_connections before any request): fail everything waiting.
        if (msg.error !== undefined) this.failAll(new RpcError(msg.error.code, msg.error.message, msg.error.data))
        continue
      }
      clearTimeout(p.timer)
      this.pending.delete(msg.id!)
      if (msg.error !== undefined) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data))
      else p.resolve(msg.result)
    }
  }

  private failAll(e: unknown): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(e)
      this.pending.delete(id)
    }
  }
}
