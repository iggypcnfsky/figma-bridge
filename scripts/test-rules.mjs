// Sprawdza dopasowanie reguł do pliku Figmy: default + nadpisania per plik, brak dopasowania,
// stary płaski format i brak pliku. Nie potrzebuje działającego serwera (--file podaje nazwę).
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = new URL('..', import.meta.url).pathname
const bin = join(repo, 'bin', 'figma')
const dir = mkdtempSync(join(tmpdir(), 'figma-rules-'))
const rules = join(dir, 'rules.json')

writeFileSync(rules, JSON.stringify({
  default: { typography: { family: 'Inter' }, grid: { module: 40, confirmed: true } },
  files: { Deck: { grid: { module: 60 }, note: 'per-file override' } },
}))

let failures = 0
const check = (label, ok, detail) => {
  if (ok) console.log('ok   ' + label)
  else {
    failures += 1
    console.log('FAIL ' + label + (detail === undefined ? '' : ' — ' + JSON.stringify(detail)))
  }
}

function run(file) {
  return new Promise((resolve) => {
    execFile(bin, ['--file', file, 'rules'], { env: { ...process.env, FIGMA_RULES_FILE: rules } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr })
    })
  })
}

try {
  const matched = await run('Deck')
  const merged = JSON.parse(matched.stdout)
  check('matching file merges default with its overrides',
    merged.matchedFile === 'Deck' && merged.typography.family === 'Inter' && merged.grid.module === 60 && merged.grid.confirmed === true,
    merged)

  const other = await run('Another File')
  const fallback = JSON.parse(other.stdout)
  check('another file gets the default house style',
    fallback.matchedFile === null && fallback.grid.module === 40 && fallback.note === undefined, fallback)
  check('fallback does not fail the command', other.code === 0, other)

  const noFiles = join(dir, 'no-files.json')
  writeFileSync(noFiles, JSON.stringify({ files: { Deck: { grid: { module: 60 } } } }))
  const emptyResult = await new Promise((resolve) => {
    execFile(bin, ['--file', 'Another File', 'rules'], { env: { ...process.env, FIGMA_RULES_FILE: noFiles } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr })
    })
  })
  check('no default and no match returns {} and asks', emptyResult.stdout.trim() === '{}' && /ask the user/.test(emptyResult.stderr), emptyResult)

  const missing = await new Promise((resolve) => {
    execFile(bin, ['--file', 'Deck', 'rules'], { env: { ...process.env, FIGMA_RULES_FILE: join(dir, 'nope.json') } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr })
    })
  })
  check('missing rules file prints {} and exits 0', missing.stdout.trim() === '{}' && missing.code === 0, missing)

  const legacy = join(dir, 'legacy.json')
  writeFileSync(legacy, JSON.stringify({ typography: { family: 'Inter' } }))
  const legacyResult = await new Promise((resolve) => {
    execFile(bin, ['--file', 'Deck', 'rules'], { env: { ...process.env, FIGMA_RULES_FILE: legacy } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr })
    })
  })
  check('flat legacy rules pass through', JSON.parse(legacyResult.stdout).typography.family === 'Inter', legacyResult)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nrules contract holds' : '\n' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
