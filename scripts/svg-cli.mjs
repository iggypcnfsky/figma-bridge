#!/usr/bin/env node
// figma svg — vector generation through QuiverAI, from the terminal.
//
//   figma svg models [--json]
//   figma svg doctor
//   figma svg gen "minimal line-art fox, two colours" [--ref a.png]... [--model arrow-2]
//   figma svg trace logo.png [--model arrow-2] [--autocrop]
//   ... [--out out/fox.svg] [--insert] [--width 512 --height 512] [--name "Bridge / Fox"]
//
// `gen` designs something new (references guide it); `trace` converts a raster image
// into paths with no prompt. `--insert` places the result on the Figma canvas as real
// vector nodes through the bridge (`createFromSvg`).
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const flags = { repo: null, base: process.env.FIGMA_BRIDGE_URL || 'http://127.0.0.1:3847', agent: process.env.FIGMA_AGENT || 'cli', label: '', file: '', client: '' }
const rest = []
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  const take = () => {
    i += 1
    if (i >= argv.length) throw new Error(arg + ' needs a value')
    return argv[i]
  }
  if (arg === '--repo') flags.repo = take()
  else if (arg === '--base') flags.base = take()
  else if (arg === '--agent') flags.agent = take()
  else if (arg === '--label') flags.label = take()
  else if (arg === '--file') flags.file = take()
  else if (arg === '--client') flags.client = take()
  else rest.push(arg)
}

const command = rest.shift() || 'models'
const options = { model: null, out: null, insert: false, width: null, height: null, name: null, json: false, autoCrop: true }
const positional = []
const refFiles = []
for (let i = 0; i < rest.length; i += 1) {
  const arg = rest[i]
  const take = () => {
    i += 1
    if (i >= rest.length) throw new Error(arg + ' needs a value')
    return rest[i]
  }
  if (arg === '--model') options.model = take()
  else if (arg === '--out' || arg === '-o') options.out = take()
  else if (arg === '--insert') options.insert = true
  else if (arg === '--width') options.width = Number(take())
  else if (arg === '--height') options.height = Number(take())
  else if (arg === '--name') options.name = take()
  else if (arg === '--ref') refFiles.push(resolve(take()))
  else if (arg === '--json') options.json = true
  else if (arg === '--no-autocrop') options.autoCrop = false
  else if (arg.startsWith('-')) throw new Error('unknown option ' + arg)
  else positional.push(arg)
}

const base = String(flags.base).replace(/\/+$/, '')
const headers = { 'content-type': 'application/json', 'x-agent': flags.agent }
if (flags.label) headers['x-agent-label'] = encodeURIComponent(flags.label)

async function api(path, init = {}) {
  const response = await fetch(base + path, { ...init, headers: { ...headers, ...(init.headers || {}) } })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
  if (!response.ok) throw new Error((body && body.error) || text || 'HTTP ' + response.status)
  return body
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

async function main() {
  if (command === 'models') {
    const data = await api('/svg/models')
    if (options.json) return printJson(data)
    if (!data.configured) {
      console.log('QuiverAI key not set — create one at https://platform.quiver.ai/api-keys')
      console.log('then add QUIVERAI_API_KEY=... to figma-bridge/.env (or export it) and restart the bridge')
      return
    }
    if (data.error) console.log('QuiverAI: ' + data.error)
    for (const model of data.models || []) {
      const ops = (model.ops || []).join(',')
      console.log(model.id.padEnd(18) + (model.name && model.name !== model.id ? model.name : '').padEnd(14) + ops)
    }
    return
  }

  if (command === 'doctor') {
    const data = await api('/svg/doctor')
    if (options.json) return printJson(data)
    console.log('key:    ' + (data.key ? 'set' : 'missing'))
    console.log('models: ' + ((data.models || []).map((model) => model.id).join(', ') || 'none'))
    console.log('status: ' + (data.ok ? 'ok' : 'not ready') + (data.error ? ' — ' + data.error : '') + (data.hint ? '\n        ' + data.hint : ''))
    return
  }

  if (command !== 'gen' && command !== 'trace') {
    throw new Error('unknown subcommand "' + command + '" — use models, doctor, gen or trace')
  }

  const mode = command === 'trace' ? 'vectorize' : 'generate'
  const prompt = command === 'trace' ? '' : positional.join(' ').trim()
  if (command === 'gen' && !prompt) throw new Error('gen needs a prompt')
  const refs = refFiles.slice()
  if (command === 'trace') {
    const target = positional[0] ? resolve(positional[0]) : null
    if (target) refs.unshift(target)
    if (refs.length === 0) throw new Error('trace needs an image file')
  }

  // The bridge owns the key and the job queue; sending files base64 keeps this command
  // identical to what the panel does.
  const payload = {
    mode,
    model: options.model || undefined,
    prompt,
    refs: refs.map((path) => ({ filename: basename(path), base64: readFileSync(path).toString('base64') })),
  }
  const started = await api('/svg/jobs', { method: 'POST', body: JSON.stringify(payload) })
  let job = started
  const deadline = Date.now() + 5 * 60_000
  while ((job.status === 'queued' || job.status === 'running') && Date.now() < deadline) {
    await sleep(1500)
    job = await api('/svg/jobs/' + started.id)
    if (job.log && job.log.length && !options.json) console.error('· ' + job.log[job.log.length - 1])
  }
  if (job.status !== 'done') throw new Error(job.error || 'job did not finish (' + job.status + ')')

  const result = job.result || {}
  const out = options.out ? resolve(options.out) : join(flags.repo || '.', 'out', 'svg-' + started.id.slice(0, 8) + '.svg')
  writeFileSync(out, result.svg)
  const summary = {
    job: started.id,
    mode,
    model: result.model,
    file: out,
    width: result.width,
    height: result.height,
    bytes: result.bytes,
    cost: result.cost ?? null,
    usage: result.usage ?? null,
    inserted: false,
  }

  if (options.insert) {
    const op = { op: 'createFromSvg', svg: result.svg }
    if (options.width) op.width = options.width
    if (options.height) op.height = options.height
    op.name = options.name || 'Bridge / SVG — ' + (prompt || 'trace').replace(/\s+/g, ' ').slice(0, 40)
    const body = { ops: [op] }
    if (flags.file) body.file = flags.file
    if (flags.client) body.client = flags.client
    const response = await fetch(base + '/run', { method: 'POST', headers, body: JSON.stringify(body) })
    const answer = await response.json()
    if (!response.ok || !answer.ok) {
      const failure = answer.error || (answer.results && answer.results[0] && answer.results[0].error) || 'insert failed'
      throw new Error('generated ' + (result.bytes || 0) + ' bytes, but placing it failed: ' + failure + ' (file: ' + out + ')')
    }
    summary.inserted = true
    summary.node = answer.results && answer.results[0] && answer.results[0].value
  }

  if (options.json) return printJson(summary)
  console.log('svg:    ' + out + ' (' + result.width + '×' + result.height + ', ' + formatBytes(result.bytes) + ')')
  if (result.cost) console.log('cost:   $' + Number(result.cost).toFixed(4))
  if (summary.inserted) console.log('placed: ' + (summary.node && summary.node.id))
}

function formatBytes(bytes) {
  const value = Number(bytes || 0)
  return value > 1024 * 1024 ? (value / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(value / 1024)) + ' KB'
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2))
}

main().catch((err) => {
  console.error('figma svg: ' + (err && err.message ? err.message : err))
  process.exit(1)
})
