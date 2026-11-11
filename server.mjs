#!/usr/bin/env node
/**
 * figma-bridge — lokalny mostek agent ↔ Figma.
 *
 * Architektura: plugin w Figmie trzyma otwarty long-poll do tego serwera.
 * The agent POSTs /run with a list of operations; the server hands them to the plugin,
 * which executes them through the Figma Plugin API and returns the results.
 *
 * No external dependencies. Node >= 20.
 */
import { createServer } from 'node:http'
import { randomUUID, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LIMITS as QUIVER_LIMITS,
  costUsd as quiverCostUsd,
  configured as quiverConfigured,
  doctor as quiverDoctor,
  generate as quiverGenerate,
  listModels as quiverListModels,
  modelsFor as quiverModelsFor,
  svgSize as quiverSvgSize,
  vectorize as quiverVectorize,
} from './lib/quiver.mjs'

const PORT = Number(process.env.FIGMA_BRIDGE_PORT || 3847)
const HOST = process.env.FIGMA_BRIDGE_HOST || '127.0.0.1'
const POLL_TIMEOUT_MS = 25_000
const DEFAULT_RUN_TIMEOUT_MS = 120_000
const DISCONNECT_GRACE_MS = 5_000
const MAX_BODY_BYTES = 32 * 1024 * 1024

// --- image generation (fal) ---------------------------------------------------
// The panel never talks to fal: it posts a job here, this process runs the img-forge
// CLI, so the API key stays on the machine and the Figma manifest stays localhost-only.
const HERE = dirname(fileURLToPath(import.meta.url))
const IMG_FORGE_BIN = process.env.IMG_FORGE_BIN || join(HERE, '..', 'img-forge', 'img')
const JOB_DIR = join(HERE, 'out', 'jobs')
const IMAGE_JOB_TTL_MS = 30 * 60 * 1000
const IMAGE_MAX_USD = Number(process.env.IMAGE_MAX_USD || 0.5)
const PRESETS_FILE = join(HERE, 'presets.json')

function readPresets() {
  if (!existsSync(PRESETS_FILE)) return []
  try {
    const parsed = JSON.parse(readFileSync(PRESETS_FILE, 'utf8'))
    return Array.isArray(parsed.presets) ? parsed.presets : []
  } catch {
    return []
  }
}

function writePresets(presets) {
  writeFileSync(PRESETS_FILE, JSON.stringify({ presets }, null, 2) + '\n')
  return presets
}

// Bez tokena (jest zbędny: FAL_KEY i tak leży na dysku, więc lokalny proces może go przeczytać).
// Zamiast tego twardo odrzucamy żądania z obcym Origin — to broni przed stroną WWW,
// która próbowałaby wydać Twoje pieniądze z przeglądarki.
function foreignOrigin(req) {
  const origin = req.headers.origin
  return Boolean(origin) && origin !== 'null'
}

const imageJobs = new Map()

/** Runs the img-forge CLI and resolves with its --json payload. */
function runImgForge(args, onLog) {
  return new Promise((resolve, reject) => {
    const child = spawn(IMG_FORGE_BIN, args, { cwd: dirname(IMG_FORGE_BIN) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) onLog?.(line.trim())
      }
    })
    child.on('error', (err) => reject(new Error(`cannot run img-forge: ${err.message}`)))
    child.on('close', (code) => {
      const trimmed = stdout.trim()
      if (code !== 0) return reject(new Error(stderr.trim() || trimmed || `img-forge exited with ${code}`))
      try {
        resolve(JSON.parse(trimmed))
      } catch {
        reject(new Error(`img-forge returned non-JSON: ${trimmed.slice(0, 300)}`))
      }
    })
  })
}

/** @type {Array<{id:string, ops:unknown[], dryRun:boolean, ts:number}>} */
const queue = []
/** @type {Map<string,{resolve:(v:any)=>void, reject:(e:Error)=>void, timer:NodeJS.Timeout}>} */
const pending = new Map()
/** @type {null | {res:import('node:http').ServerResponse, timer:NodeJS.Timeout}} */
/**
 * Plugin instances keyed by their own client id. Several Figma windows can run the plugin at once
 * (different files, or the same file twice); a single shared waiter made their requests race and
 * answered from whichever window happened to hold the poll.
 * @type {Map<string, {res: import('node:http').ServerResponse, timer: NodeJS.Timeout, info: {client: string, file: string|null, page: string|null, since: number}}>}
 */
const waiters = new Map()
/**
 * A plugin window executes one batch at a time (Figma's JS is single-threaded and the ops await),
 * but its iframe re-arms the long-poll the moment it receives a job. Without this map a second
 * agent's batch was handed to the same window mid-run and the two interleaved at every await.
 * client id → { job: id, since: ms }
 * @type {Map<string, {job: string, since: number}>}
 */
const busy = new Map()
/**
 * Last time each window was seen, independent of whether it currently holds a long-poll.
 * A window executing a long batch has no waiter left, and deriving "connected" from waiters
 * alone made a busy window look gone: 409 for a run targeting it, `busy` missing from the list.
 * client id → { file, page, since, lastSeen }
 */
const known = new Map()
/** job id → client it was handed to, so /result can free exactly that window. */
const dispatched = new Map()
/**
 * Agents, not windows. A window is one Figma plugin; an agent is the process that sends operations,
 * identified by `x-agent` (CLI: --agent / FIGMA_AGENT / the DSH session id). The panel shows them,
 * names them, and can mint an identity for a new one.
 * @type {Map<string, {id: string, name: string, firstSeen: number, lastSeen: number, runs: number, ops: number, client: string|null, busy: string|null}>}
 */
const agents = new Map()
/** job id → agent id, so a finished batch can clear exactly that agent's busy flag. */
const jobAgents = new Map()
let lastPollAt = 0
let connectedAt = null

const AGENT_TTL_MS = 12 * 60 * 60 * 1000
const AGENT_ID_RE = /^[a-z0-9][a-z0-9._:@-]{0,47}$/i
let agentCounter = 0

function agentLabel(id) {
  if (id.startsWith('dsh:')) {
    // dsh:session-<uuid> → "DSH <uuid6>": the session prefix says nothing, the id does
    const rest = id.slice(4).replace(/^session-/, '')
    return 'DSH ' + rest.slice(0, 6)
  }
  return id
}

function touchAgent(id, label) {
  if (!id) return null
  const key = String(id).slice(0, 48)
  let entry = agents.get(key)
  if (!entry) {
    agentCounter += 1
    entry = { id: key, name: agentLabel(key), firstSeen: Date.now(), lastSeen: Date.now(), runs: 0, ops: 0, client: null, busy: null, renamed: false }
    agents.set(key, entry)
    log(`agent ${key} joined`)
  }
  // A label from the agent (x-agent-label) names it, unless the user renamed it in the panel.
  if (label && !entry.renamed && entry.name !== label) entry.name = String(label).slice(0, 40)
  entry.lastSeen = Date.now()
  return entry
}

const agentsList = () =>
  [...agents.values()]
    .filter((agent) => agent.busy || Date.now() - agent.lastSeen < AGENT_TTL_MS)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      busy: agent.busy ? agent.busy.slice(0, 8) : null,
      client: agent.client,
      runs: agent.runs,
      ops: agent.ops,
      idleMs: Date.now() - agent.lastSeen,
    }))

const clientsList = () =>
  [...known.entries()]
    // an open long-poll IS the liveness signal: a plugin waiting for work does not re-poll
    .filter(([client, info]) => busy.has(client) || waiters.has(client) || Date.now() - info.lastSeen < DISCONNECT_GRACE_MS)
    .map(([client, info]) => ({
      client,
      file: info.file,
      page: info.page,
      connectedSeconds: Math.round((Date.now() - info.since) / 1000),
      waiting: waiters.has(client),
      busy: busy.has(client) ? busy.get(client).job.slice(0, 8) : null,
    }))

const now = () => new Date().toISOString().slice(11, 23)
const log = (...a) => console.log(`[bridge ${now()}]`, ...a)

function corsHeaders(res) {
  // * pozwalał dowolnej stronie WWW wywołać endpoint wydający pieniądze.
  // Iframe pluginu wysyła Origin: null, curl nie wysyła go wcale.
  const origin = res.dsOrigin
  const allow = origin === 'null' ? 'null' : origin ? null : '*'
  return allow ? { 'access-control-allow-origin': allow } : {}
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    ...corsHeaders(res),
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'access-control-allow-headers': 'content-type, x-bridge-token',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
  })
  res.end(text)
}

function empty(res, status = 204) {
  res.writeHead(status, {
    ...corsHeaders(res),
    'access-control-allow-headers': 'content-type, x-bridge-token',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
  })
  res.end()
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`body too large (> ${MAX_BODY_BYTES} bytes)`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        reject(new Error('invalid JSON body: ' + err.message))
      }
    })
    req.on('error', reject)
  })
}

/** Hands queued work to the waiting plugin (if it is polling and the queue is non-empty). */
function matches(entry, job) {
  if (job.client) return entry.info.client === job.client
  if (job.file) return entry.info.file === job.file
  return true
}

/** Frees a window after its batch finished, failed or timed out, then hands out the next job. */
function releaseJob(jobId) {
  const client = dispatched.get(jobId)
  if (!client) return
  dispatched.delete(jobId)
  const entry = busy.get(client)
  if (entry && entry.job === jobId) busy.delete(client)
  const agent = agents.get(jobAgents.get(jobId))
  jobAgents.delete(jobId)
  if (agent && agent.busy === jobId) agent.busy = null
  dispatch()
}

function dispatch() {
  let progressed = true
  while (progressed && queue.length > 0 && waiters.size > 0) {
    progressed = false
    for (const [index, job] of queue.entries()) {
      // skip windows that are still executing: a batch must not start inside another batch
      const chosen = [...waiters.entries()].find(([client, entry]) => matches(entry, job) && !busy.has(client))
      if (!chosen) continue
      const [client, entry] = chosen
      queue.splice(index, 1)
      waiters.delete(client)
      busy.set(client, { job: job.id, since: Date.now() })
      dispatched.set(job.id, client)
      if (job.agent) {
        jobAgents.set(job.id, job.agent)
        const agent = agents.get(job.agent)
        if (agent) {
          agent.busy = job.id
          agent.client = client
          agent.lastSeen = Date.now()
        }
      }
      clearTimeout(entry.timer)
      log(
        `→ job ${job.id.slice(0, 8)} (${job.ops.length} ops${job.dryRun ? ', dry-run' : ''}) to ${client}` +
          (entry.info.file ? ` [${entry.info.file}]` : ''),
      )
      json(entry.res, 200, job)
      progressed = true
      break
    }
  }
}

/** Builds CLI arguments for one image job. */
function imageArgs(body, refPaths) {
  const args = [body.mode === 'edit' ? 'edit' : 'gen', '--prompt', String(body.prompt || ''), '--json']
  if (body.model) args.push('--model', String(body.model))
  if (body.preset) args.push('--preset', String(body.preset))
  if (body.reasoning) args.push('--reasoning', String(body.reasoning))
  if (body.quality) args.push('--quality', String(body.quality))
  if (body.background) args.push('--background', String(body.background))
  if (body.format) args.push('--format', String(body.format))
  if (body.n !== undefined) args.push('--n', String(body.n))
  if (body.seed !== undefined) args.push('--seed', String(body.seed))
  if (body.name) args.push('--name', String(body.name))
  if (body.size) args.push('--size', String(body.size))
  if (body.out) args.push('--out', String(body.out))
  for (const [key, value] of Object.entries(body.set || {})) args.push('--set', `${key}=${value}`)
  for (const ref of refPaths) args.push('--ref', ref)
  if (body.mask) args.push('--mask', String(body.mask))
  if (body.dryRun) args.push('--dry-run')
  if (body.confirmCost) args.push('--yes')
  args.push('--max-usd', String(body.maxUsd !== undefined ? body.maxUsd : IMAGE_MAX_USD))
  return args
}

/** PNG header size, or null for anything that is not a PNG. */
function pngSize(buffer) {
  if (!buffer || buffer.length < 24) return null
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/**
 * Czy PNG naprawdę zawiera przezroczyste piksele (a nie tylko kanał alfa)?
 * Obsługujemy to, co daje fal: 8-bit RGBA, bez przeplotu. Gdy format jest inny — null,
 * żeby nie straszyć użytkownika fałszywym ostrzeżeniem.
 */
function pngHasTransparency(buffer) {
  if (!buffer || buffer.length < 33 || buffer.toString('latin1', 12, 16) !== 'IHDR') return null
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  const depth = buffer[24]
  const colorType = buffer[25]
  const interlace = buffer[28]
  if (depth !== 8 || colorType !== 6 || interlace !== 0) return null

  const chunks = []
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    if (type === 'IDAT') chunks.push(buffer.subarray(offset + 8, offset + 8 + size))
    if (type === 'IEND') break
    offset += 12 + size
  }
  if (chunks.length === 0) return null

  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * 4
  if (raw.length < (stride + 1) * height) return null
  const pixels = Buffer.alloc(stride * height)
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = pixels.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= 4 ? row[x - 4] : 0
      const b = previous[x]
      const c = x >= 4 ? previous[x - 4] : 0
      let value = line[x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      row[x] = value & 0xff
    }
    previous = row
  }
  let transparent = 0
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 250) transparent += 1
  return transparent > width * height * 0.002
}

const imageQueue = []
let imageRunning = 0
// Kilka generacji naraz: każde zlecenie to osobny proces img-forge, więc nie muszą czekać
// na siebie. Limit jest po to, żeby nie odpalić dwudziestu płatnych requestów przez pomyłkę.
const IMAGE_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.IMAGE_CONCURRENCY || 3)))

function pumpImageQueue() {
  while (imageRunning < IMAGE_CONCURRENCY && imageQueue.length > 0) {
    startImageJob(imageQueue.shift())
  }
}

function startImageJob(job) {
  imageRunning += 1
  job.status = 'running'
  log(`image job ${job.id.slice(0, 8)} -> ${job.args[0]} ${job.body.model || '(default)'} (${imageRunning}/${IMAGE_CONCURRENCY} running)`)
  runImgForge(job.args, (line) => {
    job.log.push(line)
    if (job.log.length > 200) job.log.shift()
  })
    .then((payload) => {
      if (payload.dryRun) {
        job.status = 'done'
        job.result = { dryRun: true, payload: payload.payload ?? null, model: payload.model, cost: payload.cost ?? null }
        return
      }
      const file = payload.file
      const bytes = file && existsSync(file) ? readFileSync(file) : null
      job.result = {
        file,
        cached: Boolean(payload.cached),
        model: payload.model,
        width: payload.width ?? null,
        height: payload.height ?? null,
        cost: payload.costEstimateUsd ?? null,
        base64: bytes ? bytes.toString('base64') : null,
        bytes: bytes ? bytes.length : 0,
      }
      // Kanał alfa bywa obecny w każdym PNG (colorType 6), więc patrzymy na PIKSELE:
      // ostrzeżenie ma sens tylko wtedy, gdy coś naprawdę jest przezroczyste.
      const transparent = bytes ? pngHasTransparency(bytes) : null
      if (transparent === true) {
        job.result.hasTransparency = true
        job.log.push('result has transparent pixels — they render black on a dark canvas')
      }
      job.status = 'done'
    })
    .catch((err) => {
      job.status = 'error'
      job.error = String(err.message || err)
    })
    .finally(() => {
      imageRunning = Math.max(0, imageRunning - 1)
      log(`image job ${job.id.slice(0, 8)} ${job.status} (${imageRunning}/${IMAGE_CONCURRENCY} running)`)
      pumpImageQueue()
      const timer = setTimeout(() => {
        imageJobs.delete(job.id)
        if (job.dir) rmSync(job.dir, { recursive: true, force: true })
      }, IMAGE_JOB_TTL_MS)
      timer.unref?.()
    })
}

/** Validates a job request, stores reference images on disk and queues the CLI run. */
function enqueueImageJob(body) {
  const mode = body.mode === 'edit' ? 'edit' : 'gen'
  if (!body.prompt || String(body.prompt).trim() === '') throw new Error('prompt is required')
  const refs = Array.isArray(body.refs) ? body.refs : []
  if (mode === 'edit' && refs.length === 0) throw new Error('edit needs at least one reference image')

  const id = randomUUID()
  const dir = join(JOB_DIR, id)
  mkdirSync(dir, { recursive: true })
  const refPaths = []
  for (const [index, ref] of refs.entries()) {
    if (!ref || !ref.base64) throw new Error('every reference needs {filename, base64}')
    const ext = String(ref.filename || 'png').split('.').pop().replace(/[^a-z0-9]/gi, '') || 'png'
    const file = join(dir, `ref-${index}.${ext}`)
    writeFileSync(file, Buffer.from(String(ref.base64), 'base64'))
    refPaths.push(file)
  }

  // fal compares the mask with the FIRST image and rejects a mismatch; catching it here
  // turns a paid 422 into a clear message.
  let maskPath = typeof body.mask === 'string' ? body.mask : null
  if (body.mask && typeof body.mask === 'object') {
    if (!body.mask.base64) throw new Error('mask needs {filename, base64}')
    maskPath = join(dir, 'mask.png')
    writeFileSync(maskPath, Buffer.from(String(body.mask.base64), 'base64'))
  }

  if (maskPath && refPaths.length > 0) {
    const mask = pngSize(readFileSync(maskPath))
    const first = pngSize(readFileSync(refPaths[0]))
    if (mask && first && (mask.width !== first.width || mask.height !== first.height)) {
      throw new Error(
        'mask is ' + mask.width + '×' + mask.height + ' but the first reference is ' + first.width + '×' + first.height +
          ' — fal requires identical dimensions',
      )
    }
  }

  const args = imageArgs(Object.assign({}, body, maskPath ? { mask: maskPath } : {}), refPaths)
  const job = { id, dir, body, args, status: 'queued', log: [], createdAt: Date.now(), result: null, error: null }
  imageJobs.set(id, job)
  imageQueue.push(job)
  pumpImageQueue()
  return job
}

// --- wektory (QuiverAI) --------------------------------------------------------
// Panel i CLI wysyłają zlecenie tutaj; ten proces woła api.quiver.ai, więc klucz zostaje
// na dysku i manifest Figmy dalej zna wyłącznie localhost. Billing jest tokenowy —
// kwotę liczymy z `usage` i stawek zwróconych przez /v1/models.
const svgJobs = new Map()
const svgQueue = []
let svgRunning = 0
const SVG_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.SVG_CONCURRENCY || 2)))
const SVG_JOB_TTL_MS = 60 * 60 * 1000

function pumpSvgQueue() {
  while (svgRunning < SVG_CONCURRENCY && svgQueue.length > 0) {
    startSvgJob(svgQueue.shift())
  }
}

function svgLog(job, line) {
  job.log.push(line)
  if (job.log.length > 200) job.log.shift()
}

function startSvgJob(job) {
  svgRunning += 1
  job.status = 'running'
  log(`svg job ${job.id.slice(0, 8)} -> ${job.mode} ${job.model} (${svgRunning}/${SVG_CONCURRENCY} running)`)
  ;(async () => {
    const catalog = await quiverListModels()
    const entry = catalog.models.find((model) => model.id === job.model) || null
    svgLog(job, 'quiver · ' + job.mode + ' · ' + job.model + (job.refs.length ? ' · ' + job.refs.length + ' reference(s)' : ''))
    const payload = job.mode === 'vectorize'
      ? await quiverVectorize({ model: job.model, image: { base64: job.refs[0].base64 }, autoCrop: true })
      : await quiverGenerate({ model: job.model, prompt: job.prompt, references: job.refs.map((ref) => ({ base64: ref.base64 })) })
    const usage = payload.usage || null
    const cost = quiverCostUsd(usage, entry)
    const svg = payload.svg
    writeFileSync(join(job.dir, 'result.svg'), svg)
    job.result = {
      svg,
      width: payload.width,
      height: payload.height,
      model: payload.model,
      usage,
      cost,
      bytes: Buffer.byteLength(svg),
      mode: job.mode,
      // `svgs` jest tu zawsze jednoelementowe: panel wstawia jeden wektor na raz
      svgCount: payload.svgs.length,
    }
    if (usage) {
      const input = Number(usage.input_tokens || 0)
      const output = Number(usage.output_tokens || 0)
      svgLog(job, 'usage ' + (input / 1000).toFixed(1) + 'k in / ' + (output / 1000).toFixed(1) + 'k out' +
        (cost ? ' · $' + cost.toFixed(4) : ''))
    }
    job.status = 'done'
  })()
    .catch((err) => {
      job.status = 'error'
      job.error = String(err.message || err)
      svgLog(job, 'failed: ' + job.error)
    })
    .finally(() => {
      svgRunning = Math.max(0, svgRunning - 1)
      log(`svg job ${job.id.slice(0, 8)} ${job.status} (${svgRunning}/${SVG_CONCURRENCY} running)`)
      pumpSvgQueue()
      const timer = setTimeout(() => {
        svgJobs.delete(job.id)
        if (job.dir) rmSync(job.dir, { recursive: true, force: true })
      }, SVG_JOB_TTL_MS)
      timer.unref?.()
    })
}

/** Validates a vector job, writes the references to disk and queues it. */
async function enqueueSvgJob(body) {
  if (!quiverConfigured()) {
    throw new Error('QUIVERAI_API_KEY is not set — create a key at https://platform.quiver.ai/api-keys, ' +
      'add QUIVERAI_API_KEY=... to figma-bridge/.env (or export it) and restart the bridge')
  }
  const mode = body.mode === 'vectorize' ? 'vectorize' : 'generate'
  const prompt = String(body.prompt || '').trim()
  const refsIn = Array.isArray(body.refs) ? body.refs : []
  if (mode === 'generate' && !prompt) throw new Error('prompt is required')
  if (mode === 'vectorize' && refsIn.length === 0) throw new Error('vectorize needs one reference image (the one to trace)')
  if (refsIn.length > QUIVER_LIMITS.references) {
    throw new Error('at most ' + QUIVER_LIMITS.references + ' references — this request has ' + refsIn.length)
  }

  const catalog = await quiverListModels()
  const usable = catalog.models.length ? quiverModelsFor(mode, catalog.models) : []
  const model = String(body.model || (usable[0] && usable[0].id) || 'arrow-2')
  if (usable.length && !usable.some((entry) => entry.id === model)) {
    throw new Error('model ' + model + ' cannot ' + (mode === 'vectorize' ? 'vectorize' : 'generate') +
      ' — use ' + usable.map((entry) => entry.id).join(', '))
  }

  const id = randomUUID()
  const dir = join(JOB_DIR, id)
  mkdirSync(dir, { recursive: true })
  const refs = []
  for (const [index, ref] of refsIn.entries()) {
    if (!ref || !ref.base64) throw new Error('every reference needs {filename, base64}')
    const buffer = Buffer.from(String(ref.base64), 'base64')
    if (buffer.length === 0) throw new Error('reference ' + (index + 1) + ' is empty')
    if (buffer.length > QUIVER_LIMITS.bytes) {
      throw new Error('reference ' + (index + 1) + ' is ' + (buffer.length / 1048576).toFixed(1) +
        ' MB — QuiverAI accepts up to 12 MB per image; export it smaller or crop it')
    }
    const size = pngSize(buffer)
    if (size) {
      if (size.width > QUIVER_LIMITS.side || size.height > QUIVER_LIMITS.side) {
        throw new Error('reference ' + (index + 1) + ' is ' + size.width + '×' + size.height +
          ' — QuiverAI accepts up to ' + QUIVER_LIMITS.side + ' px per side; export it at 1× or crop it')
      }
      if (size.width * size.height > QUIVER_LIMITS.pixels) {
        throw new Error('reference ' + (index + 1) + ' is ' + size.width + '×' + size.height +
          ' — QuiverAI accepts up to 16.7 M pixels')
      }
    }
    const file = join(dir, 'ref-' + index + '.png')
    writeFileSync(file, buffer)
    refs.push({ filename: String(ref.filename || 'ref-' + index + '.png'), base64: String(ref.base64), file, size })
  }

  const job = { id, dir, mode, model, prompt, refs, status: 'queued', log: [], createdAt: Date.now(), result: null, error: null }
  svgJobs.set(id, job)
  svgQueue.push(job)
  pumpSvgQueue()
  return job
}

function isConnected() {
  return clientsList().length > 0
}

// If the plugin disappears mid-run, do not wait for the timeout — fail fast.
setInterval(() => {
  if (pending.size === 0 || waiters.size > 0 || busy.size > 0) return
  if (Date.now() - lastPollAt < DISCONNECT_GRACE_MS) return
  busy.clear()
  dispatched.clear()
  for (const [id, slot] of pending) {
    clearTimeout(slot.timer)
    pending.delete(id)
    log(`✕ job ${id.slice(0, 8)} — plugin gone`)
    slot.reject(Object.assign(new Error('plugin disconnected while the operation was running'), { code: 'PLUGIN_GONE' }))
  }
}, 1_000).unref()

async function handle(req, res) {
  res.dsOrigin = req.headers.origin || null
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  const path = url.pathname

  if (req.method === 'OPTIONS') return empty(res, 204)

  // --- health / status ---------------------------------------------------
  if (req.method === 'GET' && (path === '/status' || path === '/health')) {
    return json(res, 200, {
      ok: true,
      port: PORT,
      pluginConnected: isConnected(),
      pollPending: waiters.size > 0,
      clients: clientsList(),
      lastPollAt: lastPollAt || null,
      connectedSinceSeconds: connectedAt ? Math.round((Date.now() - connectedAt) / 1000) : null,
      queued: queue.length,
      inFlight: pending.size,
      busy: [...busy.entries()].map(([client, entry]) => ({ client, job: entry.job.slice(0, 8), ms: Date.now() - entry.since })),
      image: { running: imageRunning, queued: imageQueue.length, concurrency: IMAGE_CONCURRENCY },
      svg: { running: svgRunning, queued: svgQueue.length, concurrency: SVG_CONCURRENCY, configured: quiverConfigured() },
      agents: agentsList(),
      agentCount: agents.size,
      waitingJobs: [...pending.keys()].map((k) => k.slice(0, 8)),
    })
  }

  // --- long-poll od pluginu ---------------------------------------------
  if (req.method === 'GET' && path === '/poll') {
    const client = String(url.searchParams.get('client') || 'anonymous')
    const file = url.searchParams.get('file')
    const page = url.searchParams.get('page')
    lastPollAt = Date.now()
    const seen = known.get(client)
    known.set(client, {
      file: file || (seen && seen.file) || null,
      page: page || (seen && seen.page) || null,
      since: seen ? seen.since : Date.now(),
      lastSeen: Date.now(),
    })
    if (connectedAt === null) {
      connectedAt = Date.now()
      log('plugin connected')
    }

    const previous = waiters.get(client)
    if (previous) {
      // ten sam klient polluje ponownie (np. odświeżony iframe) — zamykamy stary poll
      clearTimeout(previous.timer)
      try { json(previous.res, 200, { idle: true }) } catch { /* already closed */ }
      waiters.delete(client)
    }

    const timer = setTimeout(() => {
      const current = waiters.get(client)
      if (current && current.res === res) waiters.delete(client)
      try { json(res, 200, { idle: true }) } catch { /* already closed */ }
    }, POLL_TIMEOUT_MS)

    waiters.set(client, { res, timer, info: { client, file, page, since: Date.now() } })
    if (file) log(`client ${client} → ${file}${page ? ' / ' + page : ''}`)
    req.on('close', () => {
      const current = waiters.get(client)
      if (current && current.res === res) {
        clearTimeout(timer)
        waiters.delete(client)
        lastPollAt = Date.now()
      }
    })
    dispatch()
    return
  }

  // --- wynik od pluginu --------------------------------------------------
  if (req.method === 'POST' && path === '/result') {
    let body
    try { body = await readBody(req) } catch (err) { return json(res, 400, { error: err.message }) }
    const slot = body?.id ? pending.get(body.id) : undefined
    if (!slot) return json(res, 404, { error: 'unknown or expired job id' })
    clearTimeout(slot.timer)
    pending.delete(body.id)
    releaseJob(body.id)
    log(`← job ${String(body.id).slice(0, 8)} ${body.ok ? 'ok' : 'FAIL'}`)
    slot.resolve(body)
    return json(res, 200, { ok: true })
  }

  // --- zlecenie od agenta ------------------------------------------------
  // --- obrazy (fal przez img-forge) ---------------------------------------
  if (path.startsWith('/image/')) {
    if (foreignOrigin(req)) {
      log(`image ${req.method} ${path} BLOCKED origin=${req.headers.origin}`)
      return json(res, 403, { error: 'this endpoint only accepts the Figma plugin (Origin: null)' })
    }
    log(`image ${req.method} ${path}`)
  }
  if (req.method === 'GET' && path === '/image/models') {
    try {
      const registry = await runImgForge(['models', '--json'])
      return json(res, 200, { ok: true, ...registry })
    } catch (err) {
      return json(res, 500, { error: err.message })
    }
  }

  if (req.method === 'GET' && path === '/image/schema') {
    const model = url.searchParams.get('model')
    if (!model) return json(res, 400, { error: 'pass ?model=<endpoint-id>' })
    try {
      const schema = await runImgForge(['models', 'inspect', model, '--json'])
      return json(res, 200, { ok: true, ...schema })
    } catch (err) {
      return json(res, 500, { error: err.message })
    }
  }

  if (req.method === 'GET' && path === '/image/presets') {
    if (foreignOrigin(req)) return json(res, 403, { error: 'only the Figma plugin may call this' })
    return json(res, 200, { ok: true, presets: readPresets() })
  }

  if (req.method === 'POST' && path === '/image/presets') {
    if (foreignOrigin(req)) return json(res, 403, { error: 'only the Figma plugin may call this' })
    let body
    try {
      body = await readBody(req)
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
    const width = Math.round(Number(body.width))
    const height = Math.round(Number(body.height))
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 64 || height < 64 || width > 8192 || height > 8192) {
      return json(res, 400, { error: 'width/height must be integers between 64 and 8192' })
    }
    const label = String(body.label || `${width}×${height}`).slice(0, 40)
    const presets = readPresets()
    if (presets.some((preset) => preset.width === width && preset.height === height)) {
      return json(res, 200, { ok: true, presets, duplicate: true })
    }
    presets.push({ label, width, height })
    writePresets(presets)
    log(`preset added: ${label} (${width}×${height})`)
    return json(res, 201, { ok: true, presets })
  }

  if (req.method === 'POST' && path === '/image/jobs') {
    let body
    try {
      body = await readBody(req)
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
    try {
      const job = enqueueImageJob(body)
      return json(res, 202, { ok: true, id: job.id, status: job.status })
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
  }

  if (req.method === 'GET' && path.startsWith('/image/jobs/')) {
    const id = path.slice('/image/jobs/'.length)
    const job = imageJobs.get(id)
    if (!job) return json(res, 404, { error: 'unknown or expired job' })
    return json(res, 200, {
      ok: job.status !== 'error',
      id: job.id,
      status: job.status,
      log: job.log.slice(-40),
      result: job.result,
      error: job.error,
    })
  }

  // --- wektory (QuiverAI) -------------------------------------------------
  if (path.startsWith('/svg/')) {
    if (foreignOrigin(req)) {
      log(`svg ${req.method} ${path} BLOCKED origin=${req.headers.origin}`)
      return json(res, 403, { error: 'this endpoint only accepts the Figma plugin (Origin: null)' })
    }
    log(`svg ${req.method} ${path}`)
  }

  if (req.method === 'GET' && path === '/svg/models') {
    const { models, error } = await quiverListModels()
    return json(res, 200, {
      ok: !error,
      configured: quiverConfigured(),
      models,
      usable: {
        generate: quiverModelsFor('generate', models).map((model) => model.id),
        vectorize: quiverModelsFor('vectorize', models).map((model) => model.id),
      },
      default: {
        generate: (quiverModelsFor('generate', models)[0] || { id: 'arrow-2' }).id,
        vectorize: (quiverModelsFor('vectorize', models)[0] || { id: 'arrow-2' }).id,
      },
      limits: QUIVER_LIMITS,
      error,
    })
  }

  if (req.method === 'GET' && path === '/svg/doctor') {
    const report = await quiverDoctor()
    return json(res, 200, { ok: report.ok, ...report })
  }

  if (req.method === 'POST' && path === '/svg/jobs') {
    let body
    try {
      body = await readBody(req)
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
    try {
      const job = await enqueueSvgJob(body)
      return json(res, 202, { ok: true, id: job.id, status: job.status, model: job.model, mode: job.mode })
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
  }

  if (req.method === 'GET' && path.startsWith('/svg/jobs/')) {
    const id = path.slice('/svg/jobs/'.length)
    const job = svgJobs.get(id)
    if (!job) return json(res, 404, { error: 'unknown or expired job' })
    return json(res, 200, {
      ok: job.status !== 'error',
      id: job.id,
      status: job.status,
      mode: job.mode,
      model: job.model,
      log: job.log.slice(-40),
      result: job.result,
      error: job.error,
    })
  }

  // --- agenci ------------------------------------------------------------
  // „Kto jest na tym canvasie”: panel mianuje i nazywa agentów, agent sam się zgłasza przez x-agent.
  if (path === '/agents' || path.startsWith('/agents/')) {
    if (foreignOrigin(req)) {
      return json(res, 403, { error: 'agent registry accepts the plugin panel only (Origin: null)' })
    }
    if (req.method === 'POST' && path === '/agents') {
      let body
      try { body = await readBody(req) } catch (err) { return json(res, 400, { error: err.message }) }
      let id
      do {
        agentCounter += 1
        id = 'agent-' + agentCounter
      } while (agents.has(id))
      const entry = touchAgent(id)
      if (body?.name) entry.name = String(body.name).slice(0, 40)
      log(`agent ${id} minted by the panel`)
      return json(res, 200, {
        id,
        name: entry.name,
        command: 'FIGMA_AGENT=' + id + ' figma status',
        agents: agentsList(),
      })
    }
    const id = decodeURIComponent(path.slice('/agents/'.length))
    const entry = agents.get(id)
    if (!entry) return json(res, 404, { error: 'unknown agent: ' + id, agents: agentsList() })
    if (req.method === 'POST') {
      let body
      try { body = await readBody(req) } catch (err) { return json(res, 400, { error: err.message }) }
      if (body?.name !== undefined) {
        entry.name = String(body.name).slice(0, 40) || agentLabel(id)
        entry.renamed = true
      }
      entry.lastSeen = Date.now()
      return json(res, 200, { agent: agentsList().find((a) => a.id === id), agents: agentsList() })
    }
    if (req.method === 'DELETE') {
      agents.delete(id)
      log(`agent ${id} removed`)
      return json(res, 200, { removed: id, agents: agentsList() })
    }
    return json(res, 405, { error: 'use POST to rename or DELETE to remove' })
  }

  if (req.method === 'POST' && path === '/run') {
    let body
    try { body = await readBody(req) } catch (err) { return json(res, 400, { error: err.message }) }
    const ops = body?.ops ?? (body?.op ? [body] : undefined)
    if (!Array.isArray(ops) || ops.length === 0) {
      return json(res, 400, { error: 'body.ops must be a non-empty array of operations' })
    }
    if (!isConnected()) {
      return json(res, 503, {
        error: 'plugin is not connected — open Figma and run the Figma Bridge plugin',
        hint: 'Figma → Plugins → Development → Figma Bridge',
        pluginConnected: false,
      })
    }

    // Kilka okien Figmy może mieć plugin otwarty. Bez wskazania celu nie zgadujemy —
    // odpowiedź z niewłaściwego pliku jest gorsza niż błąd.
    const targetClient = body?.client ? String(body.client) : null
    const targetFile = body?.file ? String(body.file) : null
    const candidates = clientsList()
    let resolvedClient = null
    if (targetClient) {
      if (!candidates.some((c) => c.client === targetClient)) {
        return json(res, 409, {
          error: `no connected client with id "${targetClient}"`,
          clients: candidates,
        })
      }
      resolvedClient = targetClient
    } else if (targetFile) {
      const matching = candidates.filter((c) => (c.file || '').toLowerCase() === targetFile.toLowerCase())
      if (matching.length === 0) {
        return json(res, 409, {
          error: `no connected client for file "${targetFile}"`,
          hint: 'open the Figma Bridge plugin in that file, or check `./bin/figma clients`',
          clients: candidates,
        })
      }
      if (matching.length > 1) {
        return json(res, 409, {
          error: `more than one plugin window is open for "${targetFile}" — target a client id instead`,
          clients: matching,
        })
      }
      resolvedClient = matching[0].client
    } else if (candidates.length > 1) {
      return json(res, 409, {
        error: 'more than one Figma window is connected — say which one',
        hint: 'pass --file <FILE_NAME> or --client <CLIENT_ID> (see ./bin/figma clients)',
        clients: candidates,
      })
    } else if (candidates.length === 1) {
      resolvedClient = candidates[0].client
    }

    const id = randomUUID()
    const claimed = String(req.headers['x-agent'] || body?.agent || 'cli')
    const agentId = AGENT_ID_RE.test(claimed) ? claimed : 'cli'
    let label = null
    try {
      label = req.headers['x-agent-label'] ? decodeURIComponent(String(req.headers['x-agent-label'])) : null
    } catch {
      label = String(req.headers['x-agent-label'])
    }
    const agent = touchAgent(agentId, label)
    agent.runs += 1
    agent.ops += ops.length
    const job = { id, ops, dryRun: Boolean(body.dryRun), ts: Date.now(), client: resolvedClient, file: targetFile, agent: agentId }
    const timeoutMs = Number(body.timeoutMs || DEFAULT_RUN_TIMEOUT_MS)

    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        releaseJob(id)
        reject(
          Object.assign(new Error(`plugin did not respond within ${timeoutMs} ms`), {
            code: 'PLUGIN_TIMEOUT',
          }),
        )
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
    })

    queue.push(job)
    dispatch()

    try {
      const out = await result
      return json(res, out.ok ? 200 : 500, out)
    } catch (err) {
      const idx = queue.findIndex((j) => j.id === id)
      if (idx !== -1) queue.splice(idx, 1)
      releaseJob(id)
      return json(res, 504, { error: err.message, code: err.code ?? 'ERROR', id })
    }
  }

  return json(res, 404, { error: `unknown path ${req.method} ${path}` })
}

// The plugin connects to http://localhost:3847, which on macOS resolves to ::1 first,
// so we bind both address families — still loopback only.
const servers = []
function bind(host) {
  const instance = createServer(handle)
  instance.on('error', (err) => {
    log(`error ${host}:${PORT} — ${err.message}`)
  })
  servers.push(instance)
  instance.listen(PORT, host, () => log(`listening on http://${host}:${PORT}`))
  return instance
}

bind(HOST)
bind('::1')

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('zamykam')
    for (const instance of servers) instance.close()
    setTimeout(() => process.exit(0), 300)
  })
}

log('waiting for the plugin in Figma — Plugins → Development → Figma Bridge')
