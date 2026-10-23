/**
 * Starting the daemon on first use (B, cu-std: `autoStart`). The app is started through LaunchServices
 * (`open -g`), never as a child of node, so it runs as CURuntime.app with its own Accessibility and Screen Recording
 * permissions; -g keeps the focus where the user is typing.
 *
 * The one-step stop (docs/desktop.md §0: `pkill -x cu-runtime`) must stay a stop: a mark is left next to the socket
 * and nothing starts the daemon again until the user starts the app themselves (the next connection clears the mark).
 * The daemon leaves it itself when it is stopped on purpose (SIGTERM/SIGINT, its settings window's stop buttons:
 * Sources/CURuntimeCore/StopMark.swift, the same format); the plugin leaves it too when a daemon this session was
 * connected to goes away (killed, quit, or crashed: it cannot tell them apart, so it takes the safe reading), which is
 * the only record of a force quit. The mark holds the boot time: after a restart it is stale, so the first use after
 * a reboot starts the daemon again.
 *
 * Only an app the host verified is opened: before `open -g`, the app is checked with the host's own
 * rules (daemon/manager.ts verifyApp: installed, one signing identity of the name, a release build satisfying its
 * designated requirement, hardened runtime). An app that fails them, an old or bench build among them, is not opened:
 * what it would serve is not what the plugin page installed.
 *
 * @module
 */

import { execFile } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { join } from 'node:path'

/** The mark's file name, in the daemon's state dir. */
export const STOP_MARK = 'autostart-stopped.json'
/**
 * Boot times closer than this are the same boot (they are computed from the uptime, so they jitter). The host's lock
 * (daemon/manager.ts) uses the same margin: a lock written more than this before this boot's start is from an earlier boot.
 */
export const SAME_BOOT_S = 120
/**
 * After a start that did not bring the daemon up, or a refusal, calls in the next this-many ms fail at once instead of
 * waiting (or checking the app again: codesign takes a while).
 */
export const RETRY_AFTER_MS = 30_000

/** Why an app is not opened: the host's TaskError (daemon/manager.ts), its code and message. */
export interface StartRefusal {
  code: string
  message: string
}

export interface AutoStartOptions {
  stateDir: string
  /** The installed app (docs/desktop.md §2.4): the one checked, and the one opened. */
  appPath: string
  /**
   * Checks the app before it is opened: null when it may be (index.ts: daemon/manager.ts installedAppVerifier, the
   * host's rules); else why not. One that throws counts as a refusal (code internal).
   */
  verify: (appPath: string) => Promise<StartRefusal | null>
  /** Start the app; the default is `/usr/bin/open -g <appPath>`. */
  launch?: (appPath: string) => Promise<void>
  /** This boot's start, in seconds since the epoch. */
  bootTime?: () => number
  now?: () => number
}

/** The app was not opened: verify refused it (or threw); the reason is its TaskError. */
export interface Refused {
  result: 'refused'
  reason: StartRefusal
}

/**
 * launched: verified and opened; stopped-by-user: the user's stop mark stands; cooling-down: a start in the last
 * RETRY_AFTER_MS did not bring the daemon up; refused: nothing was opened, because the app was refused now or, within
 * RETRY_AFTER_MS of that refusal, then (the same reason, not checked again).
 */
export type StartResult = 'launched' | 'stopped-by-user' | 'cooling-down' | Refused

/** The mark's content: this boot's start (seconds since the epoch) and when it was left. */
export function stopMarkText(bootTime: number, now: number): string {
  return `${JSON.stringify({ boot: bootTime, at: new Date(now).toISOString() })}\n`
}

/** This boot's start in seconds since the epoch, from the uptime (so it jitters: compare within SAME_BOOT_S). */
export function currentBootTime(): number {
  return Date.now() / 1000 - uptime()
}

/**
 * Whether a mark's text (undefined: no readable file) is a stop left in this boot, which keeps the daemon from being
 * started. A mark from another boot, and text that is not a mark, count as no mark.
 */
export function stopMarkOfThisBoot(text: string | undefined, bootTime: number): boolean {
  if (text === undefined) return false
  let boot: unknown
  try {
    boot = (JSON.parse(text) as { boot?: unknown } | null)?.boot
  } catch {
    return false
  }
  return typeof boot === 'number' && Math.abs(boot - bootTime) < SAME_BOOT_S
}

export class AutoStart {
  private readonly mark: string
  private readonly launch: (appPath: string) => Promise<void>
  private readonly bootTime: () => number
  private readonly now: () => number
  /** When the last start was tried (verified or not), until a connection: the cool-down runs from it. */
  private failedAt?: number
  /** That start's refusal, given again during its cool-down. */
  private refused?: Refused

  constructor(private readonly options: AutoStartOptions) {
    this.mark = join(options.stateDir, STOP_MARK)
    this.launch = options.launch ?? openApp
    this.bootTime = options.bootTime ?? currentBootTime
    this.now = options.now ?? Date.now
  }

  /** Whether the user stopped the daemon in this boot (a stale or unreadable mark does not count). */
  stoppedByUser(): boolean {
    let text: string
    try {
      text = readFileSync(this.mark, 'utf8')
    } catch {
      return false
    }
    return stopMarkOfThisBoot(text, this.bootTime())
  }

  /** The connected daemon went away: leave the mark. */
  markStopped(): void {
    try {
      writeFileSync(this.mark, stopMarkText(this.bootTime(), this.now()), { mode: 0o600 })
    } catch { /* no state dir: the daemon was never installed here, nothing will start it either */ }
  }

  /** Connected (whoever started it): the user's stop is over. */
  connected(): void {
    this.failedAt = undefined
    this.refused = undefined
    rmSync(this.mark, { force: true })
  }

  /**
   * Start the app unless the user stopped it, or a start was just tried (failed or refused), and only once verify
   * accepted it: a refused app is never opened.
   */
  async start(): Promise<StartResult> {
    if (this.stoppedByUser()) return 'stopped-by-user'
    if (this.failedAt !== undefined && this.now() - this.failedAt < RETRY_AFTER_MS) return this.refused ?? 'cooling-down'
    this.failedAt = this.now()   // cleared by connected()
    this.refused = undefined
    const app = this.options.appPath
    let reason: StartRefusal | null
    try {
      reason = await this.options.verify(app)
    } catch (e) {
      reason = { code: 'internal', message: `checking ${app} failed: ${String(e)}` }
    }
    if (reason !== null) {
      this.refused = { result: 'refused', reason: { code: reason.code, message: reason.message } }
      return this.refused
    }
    await this.launch(app)
    return 'launched'
  }
}

function openApp(appPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', ['-g', appPath], { timeout: 10_000 }, (e) => (e === null ? resolve() : reject(e)))
  })
}
