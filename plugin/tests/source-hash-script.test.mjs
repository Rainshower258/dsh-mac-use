import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// scripts/source-hash.sh against its contract with the host (CUSourceHash, the version the host compares):
// Package.swift, every regular file under Sources/ except .DS_Store, and scripts/build-app.sh, "<path>\t<sha256>\n"
// per file in byte order, sha256 of the lines. The reference below is written from that contract alone; only temp
// dirs this test creates are touched.

const SCRIPT = fileURLToPath(new URL('../../scripts/source-hash.sh', import.meta.url))
const REPO = fileURLToPath(new URL('../..', import.meta.url))
const darwin = { skip: process.platform !== 'darwin' && 'the script uses /usr/bin/shasum and zsh', timeout: 20_000 }
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

function reference(root) {
  const files = ['Package.swift', 'scripts/build-app.sh']
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = lstatSync(p)
      if (st.isDirectory()) walk(p)
      else if (st.isFile() && name !== '.DS_Store') files.push(relative(root, p).split(sep).join('/'))
    }
  }
  walk(join(root, 'Sources'))
  files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  return sha256(files.map((f) => `${f}\t${sha256(readFileSync(join(root, f)))}\n`).join(''))
}

function run(root) {
  const r = spawnSync(SCRIPT, [root], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'cu-source-hash-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  return root
}

test('a known answer: three files', darwin, () => {
  const root = tree({ 'Package.swift': 'let p = 1\n', 'Sources/a.swift': 'a\n', 'scripts/build-app.sh': '#!/bin/zsh\n' })
  assert.deepEqual(run(root), { code: 0, out: '4d3184533e34fe7506a45bd995f64639affface123addb553eb09e156c1c14cf\n', err: '' })
})

test('the edge cases agree with the contract', darwin, () => {
  const root = tree({
    'Package.swift': 'let p = 1\n',
    // Byte order over whole paths, not per directory: "a-c" (0x2d) sorts before "a/" (0x2f).
    'Sources/a/b/x.swift': 'one\n', 'Sources/a-c.swift': 'two\n', 'Sources/a.swift': 'three\n', 'Sources/Upper.swift': 'U\n',
    'Sources/.hidden/h.swift': 'hidden directories count\n', 'Sources/b dir/sp ace.swift': 'spaces\n',
    'Sources/中文.swift': 'UTF-8 path\n', 'Sources/back\\slash.swift': 'escaped by shasum\n', 'Sources/empty': '',
    'Sources/.DS_Store': 'left out', 'Sources/a/.DS_Store': 'left out', 'Sources/a/x.DS_Store': 'only the exact name is left out',
    'outside/l.swift': 'not under Sources', 'README.md': 'not hashed',
    'scripts/build-app.sh': '#!/bin/zsh\n', 'scripts/source-hash.sh': 'not hashed', 'scripts/sub/build-app.sh': 'not hashed',
  })
  symlinkSync('../outside/l.swift', join(root, 'Sources/link.swift'))
  symlinkSync('../outside', join(root, 'Sources/linkdir'))
  const before = run(root)
  assert.equal(before.code, 0, before.err)
  assert.match(before.out, /^[0-9a-f]{64}\n$/)
  assert.equal(before.out, `${reference(root)}\n`)
  // Left out: .DS_Store, files outside Sources/ (but scripts/build-app.sh), symlinks (to files or directories).
  for (const p of ['Sources/.DS_Store', 'README.md', 'outside/l.swift', 'scripts/source-hash.sh', 'scripts/sub/build-app.sh']) {
    writeFileSync(join(root, p), 'changed')
    assert.equal(run(root).out, before.out, p)
  }
  // Counted: Package.swift, scripts/build-app.sh and any regular file under Sources/, hidden directories included.
  for (const p of ['Package.swift', 'scripts/build-app.sh', 'Sources/.hidden/h.swift', 'Sources/empty']) {
    const saved = readFileSync(join(root, p))
    writeFileSync(join(root, p), 'changed')
    assert.notEqual(run(root).out, before.out, p)
    writeFileSync(join(root, p), saved)
  }
  assert.equal(run(root).out, before.out)
})

test('this repository agrees with the contract', darwin, () => {
  assert.equal(run(REPO).out, `${reference(REPO)}\n`)
})

test('no package, no hash', darwin, () => {
  const r = run(tree({ 'Sources/a.swift': 'a\n', 'scripts/build-app.sh': '#!/bin/zsh\n' }))
  assert.notEqual(r.code, 0)
  assert.equal(r.out, '')
  assert.match(r.err, /no Package\.swift/)
})

test('no build script, no hash', darwin, () => {
  const r = run(tree({ 'Package.swift': 'let p = 1\n', 'Sources/a.swift': 'a\n' }))
  assert.notEqual(r.code, 0)
  assert.equal(r.out, '')
  assert.notEqual(r.err, '')
})
