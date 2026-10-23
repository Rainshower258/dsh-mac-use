// The installable package (package.json, locale/, icon.svg and cordis.patch.yml at the repository root). Run after the
// plugin build: the manifest's entry points are the built plugin/lib files.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, OUTPUT, renderBundlePatch } from '../../scripts/gen-bundle-patch.mjs'
import { sourceHashFiles } from '../lib/daemon/source-hash.js'

const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const json = (p) => JSON.parse(read(p))
const pkg = json('package.json')

test('cordis.patch.yml is what scripts/gen-bundle-patch.mjs renders (run it after editing the template or the preset)', () => {
  assert.equal(read(OUTPUT), renderBundlePatch())
})

test('the bundle\'s mode carries the persona of the 电脑操作 preset and its cu-runtime row, nothing else', () => {
  const patch = read(OUTPUT)
  const preset = read('profiles/presets/cu-desktop/agent.cordis.yml')
  const firstRule = preset.split('\n').find((l) => l.includes('Start with cu_observe'))
  assert.ok(firstRule && patch.includes(firstRule.trim()), 'the persona text is the preset\'s')
  assert.deepEqual([...patch.matchAll(/^ {10}- id: (\S+)$/gm)].map((m) => m[1]), ['persona', 'cu-runtime'])
  assert.deepEqual([...patch.matchAll(/^ {4}- id: (\S+)$/gm)].map((m) => m[1]), ['cu-runtime-host', 'preset-cu-runtime'])
  assert.match(patch, /^ {6}disabled: !!js "ctx\.get\('profileContext'\) === undefined"$/m)
  assert.match(patch, /^ {8}name: '电脑操作'$/m)
})

test('the top-level row is the package (host service and plugin page); the tools row is cu-runtime/tools, in the mode only', () => {
  const patch = read(OUTPUT)
  // dsh mounts the package's page only on a top-level row named exactly as the package.
  assert.match(patch, /^ {4}- id: cu-runtime-host\n {6}name: 'cu-runtime'\n {4}- id: preset-cu-runtime$/m)
  assert.match(patch, /^ {10}- id: cu-runtime\n {12}name: 'cu-runtime\/tools'$/m)
  // Every row naming the package: one top-level (the host), one in the preset (the tools).
  const named = [...patch.matchAll(/^( *)name: '(cu-runtime[^']*)'$/gm)].map((m) => [m[1].length, m[2]])
  assert.deepEqual(named, [[6, 'cu-runtime'], [12, 'cu-runtime/tools']])
  assert.doesNotMatch(patch, /plugin\/lib\/index\.js/)
})

/** The scalar settings of the cu-runtime row whose `name:` line matches `nameLine`. */
function rowSettings(text, nameLine) {
  const lines = text.split('\n')
  const at = lines.findIndex((l) => l.trim() === nameLine)
  assert.ok(at >= 0, `no row named ${nameLine}`)
  assert.equal(lines[at + 1].trim(), 'config:')
  const indent = lines[at + 1].search(/\S/)
  const out = {}
  for (const line of lines.slice(at + 2)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (line.search(/\S/) <= indent) break
    const m = /^\s+(\w+): (.+)$/.exec(line)
    if (m) out[m[1]] = m[2]
  }
  return out
}

test('the mode\'s cu-runtime settings: no pre-granted apps, the daemon\'s dialog, autoStart and onlyCuTools on', () => {
  const bundle = rowSettings(read(OUTPUT), "name: 'cu-runtime/tools'")
  // Every scalar row value, exactly: apps come from the person at this Mac (the dialog), never from the patch.
  const { exclusive, ...rest } = bundle
  assert.deepEqual(rest, { apps: '[]', appApproval: 'dialog', electronAx: 'true', imePolicy: 'ask', imeApproval: 'call',
    restoreFocus: 'true', autoStart: 'true', onlyCuTools: 'true' })
  assert.ok(exclusive === undefined || exclusive === 'true', `exclusive is not switched off (${exclusive})`)
})

test('the manifest: an ESM bundle with the plugin\'s supported dsh range', () => {
  const plugin = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'cu-runtime')
  assert.equal(pkg.type, 'module', 'plugin/lib is ESM and plugin/package.json is not shipped')
  assert.deepEqual(pkg.engines, plugin.engines)
  assert.equal(pkg.dsh.bundle.patch, `./${OUTPUT}`)
  // The root is the host service; the tools plugin is ./tools; ./host stays for one release as an alias of the root.
  assert.equal(pkg.main, 'plugin/lib/host.js')
  assert.equal(pkg.exports['.'], './plugin/lib/host.js')
  assert.equal(pkg.exports['./host'], './plugin/lib/host.js')
  assert.equal(pkg.exports['./tools'], './plugin/lib/index.js')
})

test('the package ships what the plugin page builds the daemon from, and none of the other scripts', () => {
  for (const f of ['/Package.swift', '/Sources', '/Tests', '/scripts/build-app.sh', '/scripts/make-signing-identity.sh',
    '/scripts/source-commit', '/scripts/source-hash.sh']) {
    assert.ok(pkg.files.includes(f), `${f} is not in files`)
  }
  assert.deepEqual(pkg.files.filter((f) => f.startsWith('/scripts')).sort(), ['/scripts/build-app.sh',
    '/scripts/make-signing-identity.sh', '/scripts/source-commit', '/scripts/source-hash.sh'])
})

test('every export and the icon exist and are shipped (files)', () => {
  const files = pkg.files.map((f) => f.replace(/^\//, ''))
  const shipped = (p) => files.some((f) => p === f || p.startsWith(`${f}/`))
  const targets = Object.values(pkg.exports).map((t) => t.replace(/^\.\//, ''))
  for (const t of targets) {
    if (t.includes('*')) {
      const dir = t.slice(0, t.lastIndexOf('/'))
      assert.ok(readdirSync(join(ROOT, dir)).some((f) => f.endsWith('.json')), `${t}: no files`)
      assert.ok(shipped(dir), `${t} is not in files`)
      continue
    }
    assert.ok(existsSync(join(ROOT, t)), `${t} is missing (built?)`)
    if (t !== 'package.json') assert.ok(shipped(t), `${t} is not in files`)
  }
  const icon = pkg.icon.replace(/^\.\//, '')
  assert.ok(shipped(icon))
  assert.ok(statSync(join(ROOT, icon)).size <= 256 * 1024, 'dsh shows icons up to 256 KiB')
  assert.match(read(icon), /^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.doesNotMatch(read(icon), /href=|<script|<image/i, 'self-contained')
})

test('the packed package (what a GitHub, tarball or registry install gets) holds the built plugin and nothing of plugin/ else', async () => {
  const { execFileSync } = await import('node:child_process')
  const out = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'] }))
  const packed = out[0].files.map((f) => f.path)
  for (const f of libFiles()) {
    assert.ok(packed.includes(`plugin/lib/${f}`), `plugin/lib/${f} is not packed (an ignore file drops it?)`)
  }
  assert.deepEqual(packed.filter((p) => p.startsWith('plugin/') && !p.startsWith('plugin/lib/')), [])
  for (const p of ['cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json', 'locale/host/en.json', 'package.json',
    'Package.swift', 'Sources/cu-runtime/main.swift', 'scripts/build-app.sh', 'scripts/make-signing-identity.sh',
    'scripts/source-commit']) {
    assert.ok(packed.includes(p), `${p} is not packed`)
  }
  // The build copy needs every source file (the source hash covers Package.swift, Sources/ and scripts/build-app.sh:
  // an installed package without one of them has no source hash to compare), nothing else of the repository.
  const { execFileSync: git } = await import('node:child_process')
  const tracked = git('git', ['ls-files', 'Sources', 'Tests'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  for (const p of tracked) assert.ok(packed.includes(p), `${p} is not packed`)
  const hashed = sourceHashFiles(ROOT)
  assert.ok(hashed.includes('scripts/build-app.sh'))
  for (const p of hashed) assert.ok(packed.includes(p), `${p} is hashed but not packed`)
  assert.deepEqual(packed.filter((p) => /^(bench|legacy|docs|profiles|vm)\//.test(p)), [])
  assert.deepEqual(packed.filter((p) => p.startsWith('scripts/')).sort(), ['scripts/build-app.sh',
    'scripts/make-signing-identity.sh', 'scripts/source-commit', 'scripts/source-hash.sh']
    .filter((p) => existsSync(join(ROOT, p))))
})

/** The built plugin's .js files, relative to plugin/lib, subdirectories included. */
function libFiles() {
  return readdirSync(join(ROOT, 'plugin/lib'), { recursive: true }).filter((n) => n.endsWith('.js'))
}

test('every package the built plugin imports at run time is a peer: the running dsh\'s copy, not a second one', () => {
  const lib = join(ROOT, 'plugin/lib')
  const imported = new Set()
  for (const f of libFiles()) {
    for (const m of readFileSync(join(lib, f), 'utf8').matchAll(/^import\s.*?from\s+['"]([^'"]+)['"]/gm)) {
      if (!m[1].startsWith('.') && !m[1].startsWith('node:')) imported.add(m[1])
    }
  }
  assert.deepEqual([...imported].sort(), Object.keys(pkg.peerDependencies).sort())
  assert.equal(pkg.dependencies, undefined)
})

test('plugin page text: a title and a description in English and Chinese, for the package and the host row', () => {
  for (const dir of ['locale', 'locale/host']) {
    for (const lang of ['en', 'zh']) {
      const { meta } = json(`${dir}/${lang}.json`)
      assert.ok(typeof meta.title === 'string' && meta.title.trim() !== '', `${dir}/${lang}.json title`)
      assert.ok(typeof meta.description === 'string' && meta.description.trim() !== '', `${dir}/${lang}.json description`)
    }
  }
  assert.doesNotMatch(read('locale/zh.json'), /你/, '书面语: no 你 in UI text')
})
