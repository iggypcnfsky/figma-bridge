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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
let lastPollAt = 0
let connectedAt = null

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

const imageQueue = []
let imageRunning = false

function pumpImageQueue() {
  if (imageRunning || imageQueue.length === 0) return
  const job = imageQueue.shift()
  imageRunning = true
  job.status = 'running'
  log(`image job ${job.id.slice(0, 8)} -> ${job.args[0]} ${job.body.model || '(default)'}`)
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
      job.status = 'done'
    })
    .catch((err) => {
      job.status = 'error'
      job.error = String(err.message || err)
    })
    .finally(() => {
      imageRunning = false
      log(`image job ${job.id.slice(0, 8)} ${job.status}`)
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

  const args = imageArgs(body, refPaths)
  const job = { id, dir, body, args, status: 'queued', log: [], createdAt: Date.now(), result: null, error: null }
  imageJobs.set(id, job)
  imageQueue.push(job)
  pumpImageQueue()
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
    const job = { id, ops, dryRun: Boolean(body.dryRun), ts: Date.now(), client: resolvedClient, file: targetFile }
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
