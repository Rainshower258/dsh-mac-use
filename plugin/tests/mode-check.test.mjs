// The plugin's mode self-check (plugin/src/daemon/mode-check.ts, its routes and the host's run after
// loading). The rules run on composed configs shaped as `dsh --dump-config` prints them (dsh 0.2.1-rc.2); the run goes
// through a fake System, or, on the fixtures the retired scripts/check-dsh-profiles.sh was tested with, the real runner
// and file system with a fake `dsh` on PATH in a scratch home. No real dsh runs and no real dsh home is read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as host from '../lib/host.js'
import {
  CACHE_MS, DUMP_MAX_CHARS, DUMP_TIMEOUT_MS, ELECTRON_MANAGED, FAIL_CU_ROWS, FAIL_ELECTRON, MAX_LINE_CHARS, MAX_LINES, ModeCheckCache,
  OK_BUNDLE, OK_ELECTRON_BUNDLE, OK_ELECTRON_NONE, OK_NONE, SKIP_NO_DSH, SKIP_NO_PROFILES, SKIP_TOO_LARGE, STARTUP_DELAY_MS,
  bundleProblems, checkDump,
  checkElectronFiles, dshHome, dshPrefix, findDsh, runModeCheck,
} from '../lib/daemon/mode-check.js'
import { nodeSystem } from '../lib/daemon/system.js'

const HOME = '/home/someone'
const T0 = Date.parse('2026-10-21T12:00:00Z')

// The bundle's rows as shipped, and with other row names (the fixtures of the retired check-dsh-profiles tests).
const BUNDLE_ROWS = ['# == cu-runtime', '- id: cu-runtime-host', '  name: cu-runtime', '- id: preset-cu-runtime',
  "  name: '@deepseek-ai/dsh-agent-preset'", '  config:', '    id: cu-runtime', '    name: 电脑操作', '    plugins:',
  '      - id: persona', "        name: '@deepseek-ai/dsh-persona'", '      - id: cu-runtime', '        name: cu-runtime/tools',
  '        config:', '          appApproval: dialog', '          autoStart: true', '          onlyCuTools: true']
const STANDARD = ['- id: preset-standard', "  name: '@deepseek-ai/dsh-agent-preset'", '  config:', '    id: standard',
  '    plugins:', '      - id: tool-bash', "        name: '@deepseek-ai/dsh-tool-bash'"]
const bundleRows = ({ host = 'cu-runtime', tools = 'cu-runtime/tools', onlyCuTools = true } = {}) => ['# == cu-runtime',
  '- id: cu-runtime-host', `  name: ${host}`, '- id: preset-cu-runtime', "  name: '@deepseek-ai/dsh-agent-preset'",
  '  config:', '    id: cu-runtime', '    name: 电脑操作', '    plugins:', '      - id: persona',
  "        name: '@deepseek-ai/dsh-persona'", '      - id: cu-runtime', `        name: ${tools}`, '        config:',
  '          appApproval: dialog', '          autoStart: true', ...(onlyCuTools ? ['          onlyCuTools: true'] : [])]

const dump = (lines) => `${lines.join('\n')}\n`
const verdict = (lines, profile = 'web') => checkDump(dump(lines), profile, 'dsh')
const failing = (...lines) => ({ status: 'fail', lines })
const TWO_ROWS = '2 rows load the cu_* tools, 1 of them inside preset-cu-runtime: exactly one, inside it, is allowed'
/** The update line of a bundle from before the plugin page, as the check writes it. */
const outdated = (profile, dsh = 'dsh') => 'the installed cu-runtime bundle is outdated (from before the plugin page: '
  + 'host row cu-runtime/host, tools row cu-runtime); update it by removing it and adding this version again: '
  + `'${dsh} plugin --profile ${profile} remove cu-runtime', then add this version's package on dsh's plugin page`
const extraLine = (rows) => `rows outside its mode load the cu_* tools too: ${rows}; they are not part of the bundle, `
  + 'so removing it leaves them: remove them from the profile as well'

// ------------------------------------------------------------------------------------------------ the rules

test('the bundle as shipped is ok; a profile without any computer-use plugin is ok', () => {
  assert.deepEqual(verdict([...STANDARD, ...BUNDLE_ROWS]), { status: 'ok', lines: [OK_BUNDLE] })
  assert.deepEqual(verdict(STANDARD), { status: 'ok', lines: [OK_NONE] })
  assert.deepEqual(verdict([]), { status: 'ok', lines: [OK_NONE] })
})

test('the tools row also at the top level, or also in preset-standard, fails', () => {
  assert.deepEqual(verdict(['- id: tools-top', '  name: cu-runtime/tools', ...STANDARD, ...BUNDLE_ROWS]), failing(TWO_ROWS))
  assert.deepEqual(verdict([...STANDARD, '      - id: cu-runtime-again', '        name: cu-runtime/tools', ...BUNDLE_ROWS]),
    failing(TWO_ROWS))
  // Quoted, or by the built file's path.
  assert.deepEqual(verdict([...STANDARD, '      - id: again', "        name: 'cu-runtime/tools'", ...BUNDLE_ROWS]), failing(TWO_ROWS))
  assert.deepEqual(verdict([...STANDARD, '      - id: again', '        name: /opt/x/plugin/lib/index.js', ...BUNDLE_ROWS]),
    failing(TWO_ROWS))
})

test('two tools rows inside the bundle\'s mode fail', () => {
  assert.deepEqual(verdict([...STANDARD, ...BUNDLE_ROWS, '      - id: cu-runtime-two', '        name: cu-runtime/tools']),
    failing('its mode holds other rows than persona and cu-runtime: cu-runtime cu-runtime-two persona',
      '2 rows load the cu_* tools, 2 of them inside preset-cu-runtime: exactly one, inside it, is allowed'))
})

test('an upstream computer-use row fails, at the top level by id or anywhere by package name', () => {
  assert.deepEqual(verdict([...STANDARD, '- id: computer-use', "  name: '@deepseek-ai/dsh-computer-use'", ...BUNDLE_ROWS]),
    failing(FAIL_CU_ROWS))
  assert.deepEqual(verdict([...STANDARD, '      - id: cu', '        name: dsh-computer-use']), failing(FAIL_CU_ROWS))
  assert.deepEqual(verdict(['- id: COMPUTER-USE', '  name: x']), failing(FAIL_CU_ROWS), 'case-insensitive')
})

test('onlyCuTools off, appApproval none, exclusive false each fail', () => {
  assert.deepEqual(verdict([...STANDARD, ...BUNDLE_ROWS.slice(0, -1)]), failing('onlyCuTools is not on in its mode'))
  assert.deepEqual(verdict([...STANDARD, ...BUNDLE_ROWS.slice(0, -1), '          onlyCuTools: false']),
    failing('onlyCuTools is not on in its mode'))
  assert.deepEqual(verdict([...STANDARD, ...BUNDLE_ROWS.map((l) => l.replace('appApproval: dialog', 'appApproval: none'))]),
    failing('appApproval is not dialog in its mode'))
  assert.deepEqual(verdict([...STANDARD, ...BUNDLE_ROWS, '          exclusive: false']),
    failing('exclusive is switched off in its mode'))
  assert.deepEqual(verdict([...STANDARD, ...BUNDLE_ROWS, '          exclusive: true']), { status: 'ok', lines: [OK_BUNDLE] })
})

test('the mode missing, a missing host row, a tools row not loading cu-runtime/tools fail', () => {
  assert.deepEqual(verdict(['# == cu-runtime', '- id: cu-runtime-host', '  name: cu-runtime']),
    failing('the cu-runtime bundle\'s mode (preset-cu-runtime) is missing'))
  assert.deepEqual(verdict(BUNDLE_ROWS.filter((l) => l !== '- id: cu-runtime-host' && l !== '  name: cu-runtime')),
    failing('the host row cu-runtime-host is missing or does not load the package root (cu-runtime)'))
  assert.deepEqual(verdict(bundleRows({ tools: '/opt/x/plugin/lib/index.js' })),
    failing('its cu-runtime row does not load cu-runtime/tools'))
})

test('the outdated layout gives the update line, and the stray rows outside its mode', () => {
  assert.deepEqual(verdict([...STANDARD, ...bundleRows({ host: 'cu-runtime/host', tools: 'cu-runtime' })], 'stage1'),
    failing(outdated('stage1')))
  assert.deepEqual(verdict([...STANDARD, ...bundleRows({ host: 'cu-runtime/host', tools: 'cu-runtime', onlyCuTools: false })],
    'noonly'), failing(outdated('noonly'), 'onlyCuTools is not on in its mode'))
  const extra = ['- id: preset-standard', "  name: '@deepseek-ai/dsh-agent-preset'", '  config:', '    plugins:',
    '      - id: cu-runtime', '        name: cu-runtime', ...bundleRows({ host: 'cu-runtime/host', tools: 'cu-runtime' }),
    '- id: tools-top', '  name: cu-runtime/tools', '- id: other-path', '  name: /opt/x/plugin/lib/index.js']
  assert.deepEqual(verdict(extra, 'extra'),
    failing(outdated('extra'), extraLine('cu-runtime (in preset-standard), tools-top, other-path')))
  // In another home the command carries DSH_HOME.
  assert.deepEqual(bundleProblems(dump(bundleRows({ host: 'cu-runtime/host' })), 'p', 'DSH_HOME=~/h dsh'),
    [outdated('p', 'DSH_HOME=~/h dsh')])
})

test('no bundle with a tools row fails', () => {
  assert.deepEqual(verdict([...STANDARD, '      - id: x', '        name: /opt/cu-runtime/plugin/lib/index.js']),
    failing('1 rows load the cu_* tools, without the bundle\'s mode'))
})

test('an Electron-managed profile is judged by its files', () => {
  const files = (o = {}) => ({ configs: [undefined, undefined], packageJson: undefined, modules: [], bundleInstalled: false, ...o })
  assert.deepEqual(checkElectronFiles(files()), { status: 'ok', lines: [OK_ELECTRON_NONE] })
  assert.deepEqual(checkElectronFiles(files({ packageJson: '{\n  "dependencies": {\n    "cu-runtime": "1.0.0"\n  }\n}',
    modules: ['cu-runtime', '@deepseek-ai', 'dsh-tool-bash'], bundleInstalled: true })), { status: 'ok', lines: [OK_ELECTRON_BUNDLE] })
  assert.deepEqual(checkElectronFiles(files({ configs: ['plugins:\n  - id: x\n    name: cu-runtime/tools', undefined] })),
    failing(FAIL_ELECTRON))
  assert.deepEqual(checkElectronFiles(files({ modules: ['dsh-computer-use'] })), failing(FAIL_ELECTRON))
  assert.deepEqual(checkElectronFiles(files({ packageJson: '{ "x": "cu-runtime-plugin" }' })), failing(FAIL_ELECTRON))
})

// ------------------------------------------------------------------------------------------------ the run

/**
 * A fake System: dumps[profile] is the composed config's lines, or a RunResult; `dirs` maps a directory to its
 * entries (a name ending in / is a directory); `files` maps a path to its text.
 */
function fake({ dumps = {}, dirs = {}, files = {}, env = { PATH: '/usr/bin:/bin' }, home = HOME } = {}) {
  const calls = []
  let clock = T0
  const system = {
    run: async (file, args, options) => {
      calls.push({ file, args: [...args], options })
      const profile = args[args.indexOf('--profile') + 1]
      const d = dumps[profile]
      if (d === undefined) return { code: 1, stdout: '', stderr: 'no such profile', timedOut: false }
      return Array.isArray(d) ? { code: 0, stdout: dump(d), stderr: '', timedOut: false } : d
    },
    fs: {
      exists: (p) => p in files || p in dirs,
      readText: (p) => files[p],
    },
    now: () => clock,
    env,
    home,
  }
  const listDir = (p) => dirs[p]?.map((n) => ({ name: n.replace(/\/$/, ''), directory: n.endsWith('/') }))
  return { system, calls, listDir, advance: (ms) => { clock += ms } }
}

const PROFILES = join(HOME, '.dsh/profiles')
const DSH_BIN = '/opt/node/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'

test('every profile directory of ~/.dsh is dumped by the dsh running this process: cwd /tmp, DSH_HOME set, 30 s, 8 MiB', async () => {
  const f = fake({
    dumps: { web: [...STANDARD, ...BUNDLE_ROWS], cli: STANDARD },
    dirs: { [PROFILES]: ['web/', 'cli/', 'node_modules/', '.hidden/', 'notes.txt'] },
    files: { [DSH_BIN]: '' },
    env: { PATH: '/usr/bin:/bin', LANG: 'zh_CN.UTF-8', GONE: undefined },
  })
  const r = await runModeCheck(f.system, { listDir: f.listDir, execPath: '/opt/node/bin/node', argv1: DSH_BIN })
  assert.deepEqual(r, { checked_at: new Date(T0).toISOString(), ok: true, profiles: [
    { profile: 'cli', status: 'ok', lines: [OK_NONE] }, { profile: 'web', status: 'ok', lines: [OK_BUNDLE] }] })
  assert.deepEqual(f.calls.map((c) => [c.file, c.args]), [
    ['/opt/node/bin/node', [DSH_BIN, '--profile', 'cli', '--dump-config']],
    ['/opt/node/bin/node', [DSH_BIN, '--profile', 'web', '--dump-config']]])
  for (const c of f.calls) {
    assert.deepEqual(c.options, { cwd: '/tmp', timeoutMs: DUMP_TIMEOUT_MS, outputLimit: DUMP_MAX_CHARS,
      env: { PATH: '/usr/bin:/bin', LANG: 'zh_CN.UTF-8', DSH_HOME: join(HOME, '.dsh') } })
  }
  assert.equal(DUMP_TIMEOUT_MS, 30_000)
  assert.equal(DUMP_MAX_CHARS, 8 * 1024 * 1024)
})

test('a home with no profile, or whose profiles directory cannot be listed, is not ok: one skipped entry, no dump run', async () => {
  for (const dirs of [{}, { [PROFILES]: [] }, { [PROFILES]: ['node_modules/', '.hidden/', 'notes.txt'] }]) {
    const f = fake({ dirs, files: { '/usr/bin/dsh': '' } })
    const r = await runModeCheck(f.system, { listDir: f.listDir, argv1: undefined })
    assert.deepEqual(r, { checked_at: new Date(T0).toISOString(), ok: false,
      profiles: [{ profile: '', status: 'skipped', lines: [SKIP_NO_PROFILES] }] })
    assert.deepEqual(f.calls, [])
  }
  assert.equal(SKIP_NO_PROFILES, 'not checked: no profiles under the dsh home')
})

test('a dump whose output reaches DUMP_MAX_CHARS is skipped, never checked on a part of it; one just under it is checked', async () => {
  const filler = (n) => `# ${'x'.repeat(n - 3)}\n`
  const at = filler(DUMP_MAX_CHARS)
  const f = fake({
    dumps: {
      // At the limit: what was read could be the tail of a longer dump, so even a passing text is not trusted.
      full: { code: 0, stdout: at, stderr: '', timedOut: false },
      noisy: { code: 0, stdout: dump(STANDARD), stderr: at, timedOut: false },
      under: { code: 0, stdout: `${dump(['- id: tools-top', '  name: cu-runtime/tools', ...STANDARD, ...BUNDLE_ROWS])}${
        filler(DUMP_MAX_CHARS - 1000)}`, stderr: '', timedOut: false },
    },
    dirs: { [PROFILES]: ['full/', 'noisy/', 'under/'] }, files: { '/usr/bin/dsh': '' },
  })
  assert.equal(at.length, DUMP_MAX_CHARS)
  const r = await runModeCheck(f.system, { listDir: f.listDir, argv1: undefined })
  assert.deepEqual(r.profiles, [
    { profile: 'full', status: 'skipped', lines: [SKIP_TOO_LARGE] },
    { profile: 'noisy', status: 'skipped', lines: [SKIP_TOO_LARGE] },
    { profile: 'under', status: 'fail', lines: [TWO_ROWS] },
  ])
  assert.equal(r.ok, false)
  assert.equal(SKIP_TOO_LARGE, 'not checked: dump-config output too large to check')
})

test('which dsh: this process\'s bin, else dsh on PATH, else every profile is skipped with the reason', async () => {
  const exists = (set) => (p) => set.includes(p)
  const env = { PATH: 'relative/bin:/opt/a:/opt/b' }
  assert.deepEqual(findDsh({ execPath: '/n/node', argv1: DSH_BIN, env, exists: exists([DSH_BIN, '/opt/b/dsh']) }),
    { file: '/n/node', args: [DSH_BIN] })
  assert.deepEqual(findDsh({ execPath: '/n/node', argv1: '/opt/bin/dsh', env, exists: exists(['/opt/bin/dsh']) }),
    { file: '/n/node', args: ['/opt/bin/dsh'] }, 'the dsh command, a link to the bin')
  // Another entry script (a test runner, Electron's app): the PATH's dsh, never a relative directory.
  assert.deepEqual(findDsh({ execPath: '/n/node', argv1: '/x/run-tests.js', env, exists: exists(['relative/bin/dsh', '/opt/b/dsh']) }),
    { file: '/opt/b/dsh', args: [] })
  assert.deepEqual(findDsh({ execPath: '/n/node', argv1: DSH_BIN, env, exists: exists(['/opt/a/dsh']) }),
    { file: '/opt/a/dsh', args: [] }, 'a bin that is not there')
  assert.equal(findDsh({ execPath: '/n/node', argv1: undefined, env: {}, exists: () => true }), null)

  const f = fake({ dumps: { web: STANDARD }, dirs: { [PROFILES]: ['web/', 'cli/'] }, env: { PATH: '/opt/none' } })
  const r = await runModeCheck(f.system, { listDir: f.listDir, execPath: '/n/node', argv1: '/x/run-tests.js' })
  assert.equal(r.ok, false)
  assert.deepEqual(r.profiles, [{ profile: 'cli', status: 'skipped', lines: [SKIP_NO_DSH] },
    { profile: 'web', status: 'skipped', lines: [SKIP_NO_DSH] }])
  assert.deepEqual(f.calls, [])
})

test('the home: DSH_HOME of this process (~ expanded), default ~/.dsh; the update command names it without the home path', () => {
  assert.equal(dshHome({ env: {}, home: HOME }), join(HOME, '.dsh'))
  assert.equal(dshHome({ env: { DSH_HOME: '' }, home: HOME }), join(HOME, '.dsh'))
  // Blank or only whitespace counts as unset, as dsh treats it (not a directory named ' ' under the working directory).
  assert.equal(dshHome({ env: { DSH_HOME: ' ' }, home: HOME }), join(HOME, '.dsh'))
  assert.equal(dshHome({ env: { DSH_HOME: ' \t\n ' }, home: HOME }), join(HOME, '.dsh'))
  assert.equal(dshHome({ env: { DSH_HOME: '~/.dsh-web' }, home: HOME }), join(HOME, '.dsh-web'))
  assert.equal(dshHome({ env: { DSH_HOME: '/srv/dsh' }, home: HOME }), '/srv/dsh')
  assert.equal(dshPrefix(join(HOME, '.dsh'), HOME), 'dsh')
  assert.equal(dshPrefix(join(HOME, '.dsh-web'), HOME), 'DSH_HOME=~/.dsh-web dsh')
  assert.equal(dshPrefix('/srv/dsh', HOME), 'DSH_HOME=/srv/dsh dsh')
})

test('a failing dump fails; a profile of the Electron app is read through its files', async () => {
  const dir = join(HOME, '.dsh-web/profiles')
  const electron = { code: 1, stdout: '', stderr: `Error: profile "desktop" is ${ELECTRON_MANAGED}.`, timedOut: false }
  const f = fake({
    env: { PATH: '/opt/b', DSH_HOME: '~/.dsh-web' },
    dumps: {
      broken: { code: 2, stdout: '', stderr: `token=SECRET ${HOME}/x`, timedOut: false },
      slow: { code: null, stdout: '', stderr: '', timedOut: true },
      gone: { code: null, stdout: '', stderr: 'spawn EACCES', timedOut: false },
      desktop: electron, desk2: electron, desk3: electron,
    },
    dirs: {
      [dir]: ['broken/', 'slow/', 'gone/', 'desktop/', 'desk2/', 'desk3/'],
      [join(dir, 'desktop/node_modules')]: ['cu-runtime/', '@deepseek-ai/', '.pnpm/'],
      [join(dir, 'desktop/node_modules/@deepseek-ai')]: ['dsh-tool-bash/'],
      [join(dir, 'desk2/node_modules')]: ['@other/'],
      [join(dir, 'desk2/node_modules/@other')]: ['dsh-computer-use/'],
      [join(dir, 'desktop/node_modules/cu-runtime')]: [],
    },
    files: {
      '/opt/b/dsh': '',
      [join(dir, 'desktop/package.json')]: '{\n  "dependencies": {\n    "cu-runtime": "0.2.0"\n  }\n}\n',
      [join(dir, 'desk3/cordis.patch.yml')]: 'plugins:\n  - id: mine\n    name: cu-runtime/tools\n',
    },
  })
  const r = await runModeCheck(f.system, { listDir: f.listDir, argv1: undefined })
  assert.deepEqual(r.profiles, [
    { profile: 'broken', status: 'fail', lines: ['dump-config failed (exit code 2)'] },
    { profile: 'desk2', status: 'fail', lines: [FAIL_ELECTRON] },
    { profile: 'desk3', status: 'fail', lines: [FAIL_ELECTRON] },
    { profile: 'desktop', status: 'ok', lines: [OK_ELECTRON_BUNDLE] },
    { profile: 'gone', status: 'fail', lines: ['dump-config failed (could not be run)'] },
    { profile: 'slow', status: 'fail', lines: ['dump-config failed (timed out after 30 s)'] },
  ])
  assert.equal(r.ok, false)
  assert.doesNotMatch(JSON.stringify(r), /SECRET|\/home\/someone/, 'no output, token or home path')
  assert.ok(f.calls.every((c) => c.options.env.DSH_HOME === join(HOME, '.dsh-web')))
})

test('lines are clipped: at most 20 per profile, 300 characters each; a profile whose check throws is skipped', async () => {
  // 25 stray rows next to the bundle from before the plugin page: one long line naming them all.
  const many = Array.from({ length: 25 }, (_, i) => [`- id: stray-row-number-${i}`, '  name: cu-runtime/tools']).flat()
  const f = fake({ dumps: { old: [...bundleRows({ host: 'cu-runtime/host' }), ...many] }, dirs: { [PROFILES]: ['old/', 'odd/'] },
    files: { '/usr/bin/dsh': '' } })
  f.system.run = ((run) => async (file, args, options) => {
    if (args.includes('odd')) throw new Error('the runner broke')
    return run(file, args, options)
  })(f.system.run)
  const r = await runModeCheck(f.system, { listDir: f.listDir, argv1: undefined })
  const old = r.profiles.find((p) => p.profile === 'old')
  assert.equal(old.status, 'fail')
  assert.equal(old.lines.length, 2)
  assert.equal(old.lines[1].length, MAX_LINE_CHARS)
  assert.ok(old.lines[1].endsWith('…'))
  assert.deepEqual(r.profiles.find((p) => p.profile === 'odd'), { profile: 'odd', status: 'skipped', lines: ['not checked: the runner broke'] })
  // The rules give at most six lines for a profile; the cap of 20 bounds what a later rule may add.
  assert.equal(MAX_LINES, 20)
  assert.equal(MAX_LINE_CHARS, 300)
})

// ------------------------------------------------------------------------------------------------ the cache

// (A cache that ran on every request would wait on a run this test never ends: the timeout makes that a failure.)
test('the cache: one run per 60 s, refresh forces one, concurrent requests share the run in flight', { timeout: 5000 }, async () => {
  let runs = 0
  let clock = T0
  const pending = []
  const cache = new ModeCheckCache(() => new Promise((resolve) => {
    runs++
    pending.push(() => resolve({ checked_at: String(runs), ok: true, profiles: [] }))
  }), () => clock)
  const a = cache.get()
  const b = cache.get()
  const c = cache.refresh()
  assert.equal(runs, 1, 'one run in flight, shared')
  pending.shift()()
  assert.deepEqual([(await a).checked_at, (await b).checked_at, (await c).checked_at], ['1', '1', '1'])
  clock += CACHE_MS - 1
  assert.equal((await cache.get()).checked_at, '1')
  assert.equal(runs, 1, 'served from the cache')
  const forced = cache.refresh()
  assert.equal(runs, 2, 'refresh runs again')
  const joined = cache.get()
  assert.equal(runs, 2)
  pending.shift()()
  assert.equal((await forced).checked_at, '2')
  assert.equal((await joined).checked_at, '1', 'a fresh cached result is served while a refresh runs')
  clock += CACHE_MS
  const stale = cache.get()
  assert.equal(runs, 3, 'older than 60 s: a new run')
  pending.shift()()
  assert.equal((await stale).checked_at, '3')
  assert.equal(CACHE_MS, 60_000)
})

// ------------------------------------------------------------------------------------------------ the routes

/** The host row on a fake dsh context (profileContext, connection, a logger); its routes and warnings. */
function hostRow(f, modeCheck = {}) {
  const routes = []
  const warnings = []
  const effects = []
  const ctx = {
    get: (name) => (name === 'profileContext' ? { name: 'web' } : undefined),
    effect: (fn) => { effects.push(fn()) },
    inject: (_deps, callback) => callback({ connection: { fetch: { register: (r) => { routes.push(r); return async () => {} } } } }),
    logger: { warn: (m) => { warnings.push(m) } },
  }
  host.applyWith({ system: f.system, packageSourceHash: () => 'f'.repeat(64), sourceHash: () => 'f'.repeat(64), bootTime: () => 1000,
    modeCheck: { listDir: f.listDir, argv1: undefined, startupDelayMs: null, ...modeCheck } })(ctx)
  const call = async (op, init = {}) => {
    const route = routes.find((r) => r.path === `/api/cu-runtime.${op}`)
    const res = await route.fetch(new Request(`http://127.0.0.1:1/api/cu-runtime.${op}${init.query ?? ''}`,
      { method: 'POST', body: init.body }))
    return { res, body: await res.json() }
  }
  return { routes, call, warnings, effects }
}

const withBundle = () => fake({ dumps: { web: [...STANDARD, ...BUNDLE_ROWS], bad: [...STANDARD, ...BUNDLE_ROWS, '          exclusive: false'] },
  dirs: { [PROFILES]: ['web/', 'bad/'] }, files: { '/usr/bin/dsh': '' } })

test('routes modeCheck and modeCheckRefresh: POST, buffered, no-store, { ok: true, result }; cached for 60 s', async () => {
  const f = withBundle()
  const { routes, call } = hostRow(f)
  for (const op of ['modeCheck', 'modeCheckRefresh']) {
    const r = routes.find((x) => x.path === `/api/cu-runtime.${op}`)
    assert.deepEqual(r.methods, ['POST'])
    assert.equal(r.requestBody, 'buffered')
  }
  const { res, body } = await call('modeCheck')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.deepEqual(body, { ok: true, result: { checked_at: new Date(T0).toISOString(), ok: false, profiles: [
    { profile: 'bad', status: 'fail', lines: ['exclusive is switched off in its mode'] },
    { profile: 'web', status: 'ok', lines: [OK_BUNDLE] }] } })
  assert.equal(f.calls.length, 2)
  // A body or a query naming another dsh or home changes nothing; the cached result is served.
  const evil = JSON.stringify({ dsh: '/tmp/evil', home: '/etc', profile: 'x' })
  assert.deepEqual((await call('modeCheck', { body: evil, query: '?dsh=/tmp/evil&home=/etc' })).body, body)
  assert.equal(f.calls.length, 2, 'one run per 60 s')
  f.advance(CACHE_MS)
  await call('modeCheck')
  assert.equal(f.calls.length, 4, 'older than 60 s: run again')
  await call('modeCheckRefresh', { body: evil })
  assert.equal(f.calls.length, 6, 'refresh runs at once')
  assert.ok(f.calls.every((c) => c.file === '/usr/bin/dsh' && !c.args.some((a) => /evil|etc/.test(a))))
  // Concurrent requests share one run.
  await Promise.all([call('modeCheckRefresh'), call('modeCheckRefresh'), call('modeCheck')])
  assert.equal(f.calls.length, 8)
})

test('a route whose run throws answers HTTP 500 internal', async () => {
  const f = withBundle()
  const { call } = hostRow(f, { listDir: () => { throw new Error('listing broke') } })
  const { res, body } = await call('modeCheck')
  assert.equal(res.status, 500)
  assert.deepEqual(body, { ok: false, error: { code: 'internal', message: 'listing broke' } })
})

test('once after the row loads: one warning per failing line and per skipped reason, never thrown, none once the row is gone', async () => {
  assert.equal(STARTUP_DELAY_MS, 10_000)
  const f = withBundle()
  const row = hostRow(f, { startupDelayMs: 5 })
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(row.warnings, ['cu-runtime: mode check: profile bad: exclusive is switched off in its mode'])
  assert.equal(f.calls.length, 2)
  // The page's first read finds that run's result.
  await row.call('modeCheck')
  assert.equal(f.calls.length, 2)

  // A run that throws is one warning; a context without a logger is no error either.
  const broken = hostRow(withBundle(), { startupDelayMs: 5, listDir: () => { throw new Error('listing broke') } })
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(broken.warnings, ['cu-runtime: the mode check could not run: listing broke'])
  // A skipped profile is one warning per reason too; a home with no profile is one warning without a profile name.
  const noDsh = fake({ dumps: { web: STANDARD }, dirs: { [PROFILES]: ['web/', 'cli/'] }, env: { PATH: '/opt/none' } })
  const unchecked = hostRow(noDsh, { startupDelayMs: 5 })
  const empty = hostRow(fake({ files: { '/usr/bin/dsh': '' } }), { startupDelayMs: 5 })
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(unchecked.warnings, [`cu-runtime: mode check: profile cli: ${SKIP_NO_DSH}`,
    `cu-runtime: mode check: profile web: ${SKIP_NO_DSH}`])
  assert.deepEqual(empty.warnings, ['cu-runtime: mode check: not checked: no profiles under the dsh home'])
  const quiet = withBundle()
  host.applyWith({ system: quiet.system, modeCheck: { listDir: quiet.listDir, argv1: undefined, startupDelayMs: 5 } })({
    get: () => ({ name: 'web' }), effect: (fn) => { fn() }, inject: () => {} })
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(quiet.calls.length, 2, 'headless (no connection) runs it too')

  // Disposed before it fires: no run.
  const gone = withBundle()
  const early = hostRow(gone, { startupDelayMs: 20 })
  for (const dispose of early.effects) await dispose?.()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(gone.calls.length, 0)
})

// ------------------------------------------------------------------------------------------------ on a scratch home

/**
 * The port on a scratch home, through the real runner and file system: a fake `dsh` on PATH prints <profile>.yml, or
 * for a profile with <profile>.electron says it is managed by the Electron app (exit 1), or with <profile>.fail exits 3.
 * Returns each profile's [status, lines].
 */
async function portVerdicts(dumps, { electron = {}, fails = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cu-mode-check-'))
  try {
    const home = join(dir, 'home')
    for (const [profile, lines] of Object.entries(dumps)) {
      mkdirSync(join(home, 'profiles', profile), { recursive: true })
      writeFileSync(join(dir, `${profile}.yml`), dump(lines))
    }
    for (const [profile, files] of Object.entries(electron)) {
      mkdirSync(join(home, 'profiles', profile), { recursive: true })
      writeFileSync(join(dir, `${profile}.electron`), '')
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(home, 'profiles', profile, path, '..'), { recursive: true })
        if (text === null) mkdirSync(join(home, 'profiles', profile, path), { recursive: true })
        else writeFileSync(join(home, 'profiles', profile, path), text)
      }
    }
    for (const profile of fails) {
      mkdirSync(join(home, 'profiles', profile), { recursive: true })
      writeFileSync(join(dir, `${profile}.fail`), '')
    }
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'bin/dsh'), `#!/bin/zsh\n[[ $1 == --profile && $3 == --dump-config ]] || exit 2\n`
      + `[[ -e '${dir}'/$2.electron ]] && { print -u2 "profile $2 is ${ELECTRON_MANAGED}"; exit 1; }\n`
      + `[[ -e '${dir}'/$2.fail ]] && exit 3\ncat '${dir}'/$2.yml\n`, { mode: 0o755 })
    const env = { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, HOME: dir, DSH_HOME: home }
    // dsh is found on the PATH; the lines name the home relative to HOME (~/home).
    const result = await runModeCheck({ ...nodeSystem(), env, home: dir }, { argv1: undefined })
    return Object.fromEntries(result.profiles.map((p) => [p.profile, [p.status, p.lines]]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('on the fixtures of the retired check-dsh-profiles tests, the port gives the verdicts that script gave', async () => {
  const nested = (name) => [...STANDARD, '      - id: cu-runtime-again', `        name: ${name}`]
  const extraRows = ({ quote = '' } = {}) => [
    '- id: preset-standard', "  name: '@deepseek-ai/dsh-agent-preset'", '  config:', '    id: standard', '    plugins:',
    '      - id: tool-bash', "        name: '@deepseek-ai/dsh-tool-bash'",
    '      - id: cu-runtime', `        name: ${quote}cu-runtime${quote}`,
    ...bundleRows({ host: 'cu-runtime/host', tools: 'cu-runtime' }),
    '- id: tools-top', `  name: ${quote}cu-runtime/tools${quote}`,
    '- id: other-path', '  name: /opt/x/plugin/lib/index.js',
  ]
  const port = await portVerdicts({
    // the bundle's mode, and other rows loading the tools
    web: [...STANDARD, ...BUNDLE_ROWS],
    plain: STANDARD,
    byname: [...nested('cu-runtime/tools'), ...BUNDLE_ROWS],
    quotedname: [...nested("'cu-runtime/tools'"), ...BUNDLE_ROWS],
    bypath: [...nested('/opt/cu-runtime/plugin/lib/index.js'), ...BUNDLE_ROWS],
    top: ['- id: tools-top', '  name: cu-runtime/tools', ...STANDARD, ...BUNDLE_ROWS],
    plainpath: nested('/opt/cu-runtime/plugin/lib/index.js'),
    // the bundle from before the plugin page
    stage1: [...STANDARD, ...bundleRows({ host: 'cu-runtime/host', tools: 'cu-runtime' })],
    quoted: [...STANDARD, ...bundleRows({ host: "'cu-runtime/host'", tools: "'cu-runtime'" })],
    hostonly: [...STANDARD, ...bundleRows({ host: 'cu-runtime/host' })],
    toolsonly: [...STANDARD, ...bundleRows({ tools: '"cu-runtime"' })],
    noonly: [...STANDARD, ...bundleRows({ host: 'cu-runtime/host', tools: 'cu-runtime', onlyCuTools: false })],
    current: [...STANDARD, ...bundleRows()],
    extra: extraRows(),
    quotedextra: extraRows({ quote: "'" }),
    mixed: [...STANDARD, ...bundleRows({ tools: 'cu-runtime' }), '- id: tools-top', '  name: cu-runtime/tools'],
    alone: [...STANDARD, ...bundleRows({ host: 'cu-runtime/host', tools: 'cu-runtime' })],
    // this file's
    upstream: [...STANDARD, '- id: computer-use', "  name: '@deepseek-ai/dsh-computer-use'"],
    twotools: [...STANDARD, ...BUNDLE_ROWS, '      - id: cu-runtime-two', '        name: cu-runtime/tools'],
    noexclusive: [...STANDARD, ...BUNDLE_ROWS, '          exclusive: false'],
    noapproval: [...STANDARD, ...BUNDLE_ROWS.map((l) => l.replace('appApproval: dialog', 'appApproval: none'))],
    nomode: ['# == cu-runtime', '- id: cu-runtime-host', '  name: cu-runtime'],
  }, {
    electron: {
      eplain: {},
      ebundle: { 'package.json': '{\n  "dependencies": {\n    "cu-runtime": "0.2.0"\n  }\n}\n', 'node_modules/cu-runtime': null,
        'node_modules/@deepseek-ai/dsh-tool-bash': null },
      epatch: { 'cordis.patch.yml': 'plugins:\n  - id: mine\n    name: cu-runtime/tools\n' },
      escoped: { 'node_modules/@other/dsh-computer-use': null },
    },
    fails: ['broken'],
  })
  const ok = (...lines) => ['ok', lines]
  const fail = (...lines) => ['fail', lines]
  const shipped = 'the cu-runtime bundle, cu_* tools in its own mode only (onlyCuTools, dialog, exclusive)'
  const old = (profile) => outdated(profile, 'DSH_HOME=~/home dsh')
  // A line over MAX_LINE_CHARS is clipped; the script printed it whole (its update command named the checkout).
  const clipped = (line) => `${line.slice(0, 299)}…`
  const allExtra = extraLine('cu-runtime (in preset-standard), tools-top, other-path')
  assert.deepEqual(port, {
    web: ok(shipped),
    plain: ok('no computer-use plugin'),
    byname: fail(TWO_ROWS),
    quotedname: fail(TWO_ROWS),
    bypath: fail(TWO_ROWS),
    top: fail(TWO_ROWS),
    plainpath: fail('1 rows load the cu_* tools, without the bundle\'s mode'),
    stage1: fail(old('stage1')),
    quoted: fail(old('quoted')),
    hostonly: fail(old('hostonly')),
    toolsonly: fail(old('toolsonly')),
    noonly: fail(old('noonly'), 'onlyCuTools is not on in its mode'),
    current: ok(shipped),
    extra: fail(old('extra'), allExtra),
    quotedextra: fail(clipped(old('quotedextra')), allExtra),
    mixed: fail(old('mixed'), extraLine('tools-top')),
    alone: fail(old('alone')),
    upstream: fail('loads a computer-use plugin'),
    twotools: fail('its mode holds other rows than persona and cu-runtime: cu-runtime cu-runtime-two persona',
      '2 rows load the cu_* tools, 2 of them inside preset-cu-runtime: exactly one, inside it, is allowed'),
    noexclusive: fail('exclusive is switched off in its mode'),
    noapproval: fail('appApproval is not dialog in its mode'),
    nomode: fail('the cu-runtime bundle\'s mode (preset-cu-runtime) is missing'),
    eplain: ok('no computer-use plugin (Electron-managed: its files checked)'),
    ebundle: ok('the cu-runtime bundle only (Electron-managed: its files checked; its composed config cannot be dumped here)'),
    epatch: fail('loads a computer-use plugin (Electron-managed: its files)'),
    escoped: fail('loads a computer-use plugin (Electron-managed: its files)'),
    broken: fail('dump-config failed (exit code 3)'),
  })
  assert.equal(clipped(old('quotedextra')).length, MAX_LINE_CHARS)

  // A dump over the runner's default 64 Ki characters is read whole: a stray tools row near its start (here in
  // preset-standard, followed by a long prompt) still fails the profile, as the script did on its $(…) capture.
  const prompt = ['    prompt: |', ...Array.from({ length: 2000 }, (_, i) => `      line ${i} of a long custom prompt`)]
  const big = [...STANDARD, '      - id: cu-runtime-again', '        name: cu-runtime/tools', ...prompt, ...BUNDLE_ROWS]
  assert.ok(dump(big).length > 64 * 1024 + 10_000)
  assert.deepEqual(await portVerdicts({ big }), { big: fail(TWO_ROWS) })
})
