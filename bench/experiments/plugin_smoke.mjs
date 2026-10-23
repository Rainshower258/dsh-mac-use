// R4 smoke test without a model: the plugin's tools (compiled lib) against the real daemon and the fixture.
// Run by plugin_smoke.py inside a VM clone. Prints one JSON object with every tool's text output.
import { CURuntimeClient } from '../../plugin/lib/client.js'
import { defineCuTools, Tasks } from '../../plugin/lib/tools.js'

const FIXTURE = 'dev.dsh.bench.fixture'
const client = new CURuntimeClient()
const tasks = new Tasks({ apps: [FIXTURE], electronAx: false, grantTtlS: 600 })
const ctx = { get: () => undefined }   // no approval service (headless), no attachments
const tools = Object.fromEntries(defineCuTools({ ctx, client, tasks }).map((t) => [t.name, t]))
const exec = { agent: { session: { id: 'smoke', requestHeader: () => undefined }, options: {} }, name: 'smoke', callId: 'c',
               signal: new AbortController().signal }

const out = {}
async function run(label, name, args) {
  try {
    out[label] = { ok: true, text: (await tools[name].execute(args, exec)).text }
  } catch (e) {
    out[label] = { ok: false, text: String(e.message ?? e) }
  }
}
const idFor = (text, label) => (text.split('\n').find((l) => l.includes(`"${label}`)) ?? '').split(' ')[0]

await run('list', 'cu_list_apps', {})
await run('observe1', 'cu_observe', { image: false })
const marker = idFor(out.observe1.text, 'marker 4')
const field = idFor(out.observe1.text, 'field one') || (out.observe1.text.split('\n').find((l) => l.includes('AXTextField')) ?? '').split(' ')[0]
out.ids = { marker, field }
await run('click', 'cu_click', { element_id: marker })
await run('observe2', 'cu_observe', { image: false })
await run('type', 'cu_type', { element_id: field, text: '插件冒烟 plugin smoke 测试文本，超过二十个字符' })
await run('request_app', 'cu_request_app', { bundle_id: 'com.apple.TextEdit', reason: 'smoke' })
// Positive control for the bench's out-of-bounds counter: a hard-denied app (the A0 incident's terminal).
await run('request_terminal', 'cu_request_app', { bundle_id: 'com.apple.Terminal', reason: 'smoke: must be refused' })
// Named the way the screen shows it: the daemon resolves it among the granted apps only.
await run('by_name', 'cu_key', { app: 'DSHFixture', chord: 'tab' })
await run('chord', 'cu_key', { chord: 'cmd+tab' })
await run('stale_id', 'cu_click', { element_id: 'e0000000' })
await run('no_space', 'cu_click', { x: 10, y: 10 })
client.close()
console.log(JSON.stringify(out))
