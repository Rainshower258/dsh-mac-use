#!/usr/bin/env node
// Builds the plugin page's browser half (PLAN-阶段2「浏览器端页面」) into plugin/lib/web-client.js, the file the
// package's `./client` export names. tsc compiles plugin/src/client/*.ts to CommonJS (plugin/tsconfig.client.json,
// into a temporary directory), and this script joins those modules into the one classic script dsh's client module
// loader takes:
//
//   window.__ModuleLoader__.load({ id: "cu-runtime", factory: (require) => { ...; return module.exports; } });
//
// The local modules are inlined in a module table with a require of their own; only the packages the dsh web client
// provides (EXTERNALS) go through the loader's require, and any other require fails the build. The output is not
// lib/client.js: the host build writes that from src/client.ts (the daemon's RPC client). tsconfig.build.json
// excludes src/client, so the host build is unchanged. Needs plugin/node_modules (plugin/scripts/link-deps.sh).
//
//   node scripts/build-client.mjs                 write plugin/lib/web-client.js
//   node scripts/build-client.mjs --out <file>    write it there instead
//   node scripts/build-client.mjs --cjs <dir>     also keep tsc's CommonJS modules in <dir> (the tests load view.js)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const PLUGIN = join(ROOT, 'plugin')
export const OUTPUT = 'plugin/lib/web-client.js'

/** The loader registration id: the package name, which dsh serves the bundle under. */
export const MODULE_ID = 'cu-runtime'

/** The compiled entry module (src/client/index.ts). */
export const ENTRY = 'index.js'

/** What the dsh web client's loader require gives a third-party bundle (dsh 0.2.1-rc.2); nothing else is shared. */
export const EXTERNALS = Object.freeze([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', 'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/**
 * Compile plugin/src/client with plugin/tsconfig.client.json. The config itself has noEmit (so `tsc -p` on it only
 * type-checks and never writes into plugin/lib, which the package ships); emitting is turned on here, into outDir.
 * @param {string} outDir - where tsc writes the CommonJS modules.
 * @throws {Error} with tsc's output when it reports errors.
 */
export function compileClient(outDir) {
  try {
    execFileSync(join(PLUGIN, 'node_modules/.bin/tsc'),
      ['-p', 'tsconfig.client.json', '--noEmit', 'false', '--outDir', outDir],
      { cwd: PLUGIN, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    throw new Error(`tsc -p plugin/tsconfig.client.json failed:\n${e.stdout ?? ''}${e.stderr ?? e.message}`)
  }
}

/**
 * @param {string} dir - tsc's output directory.
 * @returns {Map<string, string>} every .js file under it, keyed by its posix path relative to dir.
 */
export function readModules(dir) {
  const modules = new Map()
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    const path = join(entry.parentPath, entry.name)
    modules.set(relative(dir, path).split(sep).join('/'), readFileSync(path, 'utf8'))
  }
  return modules
}

const REQUIRE_CALL = /\brequire\s*\(/g
const REQUIRE_LITERAL = /^require\("([^"\\]*)"\)/

/**
 * Join compiled CommonJS modules into the loader's classic script.
 * @param {Map<string, string>} modules - module path (posix, relative) → source.
 * @param {string} [entry] - the module whose exports are the bundle's.
 * @returns {string} the script.
 * @throws {Error} naming every require that is not a string literal, a relative path to one of the modules, or one
 * of EXTERNALS.
 */
export function bundleModules(modules, entry = ENTRY) {
  if (!modules.has(entry)) throw new Error(`no entry module ${entry}`)
  const problems = []
  const links = {}
  for (const [id, source] of [...modules].sort(([a], [b]) => a.localeCompare(b))) {
    links[id] = {}
    for (const call of source.matchAll(REQUIRE_CALL)) {
      const literal = REQUIRE_LITERAL.exec(source.slice(call.index))
      if (literal === null) {
        problems.push(`${id}: a require that is not require("<literal>")`)
        continue
      }
      const spec = literal[1]
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const target = posix.normalize(posix.join(posix.dirname(id), spec))
        if (modules.has(target)) links[id][spec] = target
        else problems.push(`${id}: require("${spec}") names no compiled module`)
      } else if (!EXTERNALS.includes(spec)) {
        problems.push(`${id}: require("${spec}") is not a package the dsh web client provides; bundle it under src/client or drop it`)
      }
    }
  }
  if (problems.length > 0) throw new Error(`client bundle refused:\n  ${problems.join('\n  ')}`)

  const out = [
    'window.__ModuleLoader__.load({',
    `\tid: ${JSON.stringify(MODULE_ID)},`,
    '\tfactory: (require) => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    '\t\tvar __modules = {',
  ]
  for (const id of Object.keys(links)) {
    out.push(`\t\t\t${JSON.stringify(id)}: function (module, exports, require) {`, modules.get(id).trimEnd(), '\t\t\t},')
  }
  out.push(
    '\t\t};',
    `\t\tvar __links = ${JSON.stringify(links)};`,
    '\t\tvar __loaded = {};',
    '\t\tfunction __load(id, mod) {',
    '\t\t\tif (__loaded[id]) return __loaded[id].exports;',
    '\t\t\t__loaded[id] = mod;',
    '\t\t\tvar links = __links[id];',
    '\t\t\t__modules[id].call(mod.exports, mod, mod.exports, function (spec) {',
    '\t\t\t\treturn Object.prototype.hasOwnProperty.call(links, spec) ? __load(links[spec], { exports: {} }) : require(spec);',
    '\t\t\t});',
    '\t\t\treturn mod.exports;',
    '\t\t}',
    `\t\t__load(${JSON.stringify(entry)}, module);`,
    '\t\treturn module.exports;',
    '\t}',
    '});',
    '',
  )
  return out.join('\n')
}

/**
 * Compile and bundle.
 * @param {{ out?: string, cjs?: string }} [options] - out: the script's path (default OUTPUT under ROOT);
 * cjs: keep the CommonJS modules there, a directory that is empty or does not exist yet, so no stale module is
 * bundled (default: a temporary directory, removed).
 * @returns {string} the script's path.
 */
export function buildClient({ out = join(ROOT, OUTPUT), cjs } = {}) {
  const dir = cjs === undefined ? mkdtempSync(join(tmpdir(), 'cu-runtime-client-')) : resolve(cjs)
  try {
    if (cjs !== undefined && existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`--cjs ${dir} is not empty`)
    compileClient(dir)
    const script = bundleModules(readModules(dir))
    mkdirSync(dirname(out), { recursive: true })
    // Written beside and renamed: a reader never sees half a script.
    writeFileSync(`${out}.tmp`, script)
    renameSync(`${out}.tmp`, out)
    return out
  } finally {
    if (cjs === undefined) rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const option = (flag) => {
    const at = args.indexOf(flag)
    if (at < 0) return undefined
    if (at + 1 >= args.length) throw new Error(`${flag} needs a path`)
    return resolve(args[at + 1])
  }
  try {
    const out = buildClient({ out: option('--out'), cjs: option('--cjs') })
    console.log(`wrote ${out}`)
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
