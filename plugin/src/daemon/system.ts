/**
 * What the host service does to the Mac, behind one facade (System) so that tests run no command and touch no real
 * file: the command runner, the file system, signals, the clock. The node implementation (nodeSystem) is the only one
 * that reaches the real system.
 *
 * Every command is an absolute executable path with an argument list: no shell, and no PATH lookup for the command
 * itself. What a command runs in turn (build-app.sh's swift, codesign…) is looked up on the PATH of the environment
 * the caller passes, which the manager fixes to the system directories (manager.ts, childEnv). A command runs in a
 * process group of its own, so a timeout or a cancel ends it together with what it started (build-app.sh's swift
 * build, codesign), also once the command itself has exited and only what it started still holds its output.
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync }
  from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'

export interface RunOptions {
  cwd?: string
  /** The whole environment of the command (not merged with this process's). */
  env?: Record<string, string>
  /**
   * Ended after this long (default 60 s): SIGTERM to its process group, SIGKILL 5 s later, and 1 s after that its
   * output pipes are closed and the run resolves whatever still holds them. A run is over when the command has exited
   * and its output is closed, so this also ends a command that exited but left a process holding its output.
   */
  timeoutMs?: number
  /** Ends it the same way. */
  signal?: AbortSignal
  /** Each line of stdout and stderr as it arrives, without the line break. */
  onLine?: (line: string) => void
  /**
   * How much of each stream the result keeps: its last this many characters of the decoded text (default KEEP_CHARS,
   * 64 Ki). Nothing says that a stream lost its head: a stream that comes back this long may have been cut.
   */
  outputLimit?: number
}

export interface RunResult {
  /**
   * The exit status; null when the timeout or the signal ended the run (even if the command itself had exited, and
   * only what it left behind was ended) or it could not be started.
   */
  code: number | null
  /** The last RunOptions.outputLimit characters of each stream (default 64 Ki). */
  stdout: string
  stderr: string
  /**
   * True when the timeout ended the run (code is then null). nodeRun always sets it; a runner that leaves it out
   * (a test's fake) reports no timeout.
   */
  timedOut?: boolean
}

export type Runner = (file: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>

/** The files the host reads and writes; paths are absolute. */
export interface HostFs {
  exists(path: string): boolean
  /** The text, or undefined when it cannot be read. */
  readText(path: string): string | undefined
  /** The modification time, or undefined when there is no such file. */
  mtimeMs(path: string): number | undefined
  /** Creates or replaces it, mode 0600. */
  writeText(path: string, text: string): void
  appendText(path: string, text: string): void
  /**
   * Creates it with this text, mode 0600, only if nothing is there: false when something is. The file appears with its
   * whole text at once: no reader ever finds it there and empty (or partly written).
   */
  createExclusive(path: string, text: string): boolean
  /** Creates it and its parents, mode 0700; nothing if it is there. */
  mkdir(path: string): void
  /** Removes it and everything under it; nothing if it is not there. */
  rm(path: string): void
  rename(from: string, to: string): void
}

export interface System {
  run: Runner
  fs: HostFs
  /** Sends a signal to one process; false if there is no such process (or it is not this user's). */
  kill(pid: number, signal: NodeJS.Signals): boolean
  /**
   * Whether a process with this id exists and this process may signal it. A process this user may not signal (EPERM:
   * another user's, launchd) counts as none: it cannot be a dsh process of this user. An id that is not a positive
   * integer names no process (0 and negative ids name process groups).
   */
  alive(pid: number): boolean
  /** Whether the Unix socket at this path accepts a connection within timeoutMs; the connection is closed at once. */
  connects(socketPath: string, timeoutMs: number): Promise<boolean>
  sleep(ms: number): Promise<void>
  now(): number
  /** This process's environment (SSH_CONNECTION, SSH_TTY, PATH…). */
  env: Readonly<Record<string, string | undefined>>
  home: string
  pid: number
}

/** How much of each stream a run keeps by default (RunOptions.outputLimit). */
const KEEP_CHARS = 64 * 1024
const KILL_GRACE_MS = 5000
/** After the SIGKILL: how long a process outside the group (it left it) may keep the output open before it is closed. */
const ABANDON_MS = 1000

/** Runs one command; never rejects (a command that cannot be started gives code null and the error on stderr). */
export const nodeRun: Runner = (file, args, options = {}) => new Promise((resolve) => {
  const out = { stdout: '', stderr: '' }
  const keep = options.outputLimit ?? KEEP_CHARS
  const partial = { stdout: '', stderr: '' }
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(file, [...args], { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    resolve({ code: null, stdout: '', stderr: String(e), timedOut: false })
    return
  }
  let settled = false
  /** The timeout or the signal ended the run. */
  let ended = false
  /** The timeout did (it fired before the signal). */
  let timedOut = false
  let killTimer: NodeJS.Timeout | undefined
  let abandonTimer: NodeJS.Timeout | undefined
  // The group, not the leader: the leader may have exited while what it started (in its group: the group's id is not
  // reused while any member lives) still holds the output, and the run is not over until that is gone too.
  const signalGroup = (signal: NodeJS.Signals) => {
    try { process.kill(-child.pid!, signal) } catch { /* the group is gone */ }
  }
  const end = () => {
    if (settled || child.pid === undefined) return
    ended = true
    signalGroup('SIGTERM')
    killTimer ??= setTimeout(() => {
      signalGroup('SIGKILL')
      abandonTimer = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(null)
      }, ABANDON_MS)
    }, KILL_GRACE_MS)
  }
  const timer = setTimeout(() => {
    if (!ended) timedOut = true
    end()
  }, options.timeoutMs ?? 60_000)
  const onAbort = () => end()
  if (options.signal?.aborted) end()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  for (const stream of ['stdout', 'stderr'] as const) {
    child[stream]!.setEncoding('utf8')
    child[stream]!.on('data', (chunk: string) => {
      out[stream] += chunk
      if (out[stream].length > keep) out[stream] = out[stream].slice(-keep)
      if (options.onLine === undefined) return
      const lines = (partial[stream] + chunk).split('\n')
      partial[stream] = lines.pop() ?? ''
      for (const line of lines) options.onLine(line.replace(/\r$/, ''))
    })
  }
  const finish = (code: number | null, error?: Error) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (killTimer !== undefined) clearTimeout(killTimer)
    if (abandonTimer !== undefined) clearTimeout(abandonTimer)
    options.signal?.removeEventListener('abort', onAbort)
    for (const stream of ['stdout', 'stderr'] as const) {
      if (partial[stream] !== '' && options.onLine !== undefined) options.onLine(partial[stream])
      partial[stream] = ''
    }
    resolve({ code: ended ? null : code, stdout: out.stdout,
      stderr: error === undefined ? out.stderr : `${out.stderr}${String(error)}`, timedOut })
  }
  child.on('error', (e) => finish(null, e))
  child.on('close', (code) => finish(code))
})

export const nodeFs: HostFs = {
  exists: (path) => existsSync(path),
  readText(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  },
  mtimeMs(path) {
    try {
      return statSync(path).mtimeMs
    } catch {
      return undefined
    }
  },
  writeText: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
  appendText: (path, text) => appendFileSync(path, text, { mode: 0o600 }),
  createExclusive(path, text) {
    // Written under a name of its own beside it (this pid and 64 random bits), then hard-linked into place (the cache
    // is on the home volume, APFS): link(2) fails with EEXIST when something is there, and otherwise the file appears
    // with its whole text. The temporary name goes either way.
    const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    try {
      writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' })
      try {
        linkSync(temporary, path)
        return true
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw e
      }
    } finally {
      rmSync(temporary, { force: true })
    }
  },
  mkdir: (path) => { mkdirSync(path, { recursive: true, mode: 0o700 }) },
  rm: (path) => rmSync(path, { recursive: true, force: true }),
  rename: (from, to) => renameSync(from, to),
}

export function nodeSystem(): System {
  return {
    run: nodeRun,
    fs: nodeFs,
    kill(pid, signal) {
      try {
        process.kill(pid, signal)
        return true
      } catch {
        return false
      }
    },
    alive(pid) {
      // kill(0, 0) and kill(-n, 0) would ask about process groups (kill(-1, 0): every process this user may signal).
      if (!Number.isSafeInteger(pid) || pid <= 0) return false
      try {
        process.kill(pid, 0)
        return true
      } catch {
        // ESRCH: gone. EPERM: there, but not this user's to signal (pid 1 among them): not a dsh process of this user.
        return false
      }
    },
    connects: (socketPath, timeoutMs) => new Promise((resolve) => {
      const socket = createConnection(socketPath)
      const done = (ok: boolean) => {
        clearTimeout(timer)
        socket.destroy()
        resolve(ok)
      }
      const timer = setTimeout(() => done(false), timeoutMs)
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
    }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    env: process.env,
    home: homedir(),
    pid: process.pid,
  }
}
