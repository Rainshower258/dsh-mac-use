// Build dist/DSHFixture.app: a renamed copy of the Electron runtime whose
// Resources/app symlinks back to this source directory. A unique app name and
// bundle id let CUADaemon resolve "DSHFixture" unambiguously; the symlink
// means source edits apply without re-bundling.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(here, 'node_modules/electron/dist/Electron.app')
const app = join(here, 'dist/DSHFixture.app')
if (!existsSync(src)) {
  console.error('Electron runtime missing: ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js')
  process.exit(1)
}
rmSync(app, { recursive: true, force: true })
cpSync(src, app, { recursive: true, verbatimSymlinks: true })
const plist = join(app, 'Contents/Info.plist')
const set = (key, value) => execFileSync('plutil', ['-replace', key, '-string', value, plist])
set('CFBundleName', 'DSHFixture')
set('CFBundleDisplayName', 'DSHFixture')
set('CFBundleIdentifier', 'dev.dsh.bench.fixture')
// Relative so the bundle still resolves after rsync into the VM guest.
symlinkSync('../../../..', join(app, 'Contents/Resources/app'))
execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
console.log(`OK ${app}`)
