#!/usr/bin/env node
// Talk to CUADaemon directly (no dsh, no model): one request per invocation.
//
//   node bench/tools/cua-rpc.mjs ping
//   node bench/tools/cua-rpc.mjs ComputerUseIPCListAppsRequest '{}'
//   node bench/tools/cua-rpc.mjs ComputerUseIPCAppGetSkyshotRequest '{"app":"Calculator","disableDiff":true}'
//
// Spawns the daemon from $DSH_COMPUTER_USE_DAEMON (default: the release
// build) on a private socket, so it never collides with a dsh-owned daemon.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LEGACY = process.env.DSH_CU_LEGACY ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../dsh-computer-use')
const { DaemonClient } = await import(pathToFileURL(join(LEGACY, 'packages/computer-use/dsh-computer-use/lib/daemon.js')).href)
const daemonCommand = process.env.DSH_COMPUTER_USE_DAEMON ?? join(LEGACY, 'native/.build/release/CUADaemon')
const socketPath = join(mkdtempSync(join(tmpdir(), 'cua-rpc-')), 'cua.sock')
const [requestType = 'ping', rawRequest = '{}'] = process.argv.slice(2)

const client = new DaemonClient({ socketPath, daemonCommand, daemonArgs: ['--socket', socketPath], toolCallTimeoutMs: 60_000 })
try {
  await client.start()
  const result = requestType === 'ping'
    ? await client.ping()
    : await client.request(requestType, JSON.parse(rawRequest))
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} catch (error) {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
} finally {
  client.stop()
}
