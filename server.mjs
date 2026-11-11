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
const TOKEN_FILE = join(HERE, '.bridge-token')
const JOB_DIR = join(HERE, 'out', 'jobs')
const IMAGE_JOB_TTL_MS = 30 * 60 * 1000

function loadToken() {
  if (existsSync(TOKEN_FILE)) {
    const existing = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (existing) return existing
  }
  mkdirSync(dirname(TOKEN_FILE), { recursive: true })
  const token = randomBytes(24).toString('hex')
  writeFileSync(TOKEN_FILE, token + '\n')
  chmodSync(TOKEN_FILE, 0o600)
  return token
}
const BRIDGE_TOKEN = loadToken()
const imageJobs = new Map()

function requireToken(req, res) {
  const given = String(req.headers['x-bridge-token'] || '')
  if (given.length === BRIDGE_TOKEN.length && given === BRIDGE_TOKEN) return true
  json(res, 401, { error: 'missing or invalid x-bridge-token (run: ./bin/figma token)' })
  return false
}

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
let waiter = null
let lastPollAt = 0
let connectedAt = null

const now = () => new Date().toISOString().slice(11, 23)
const log = (...a) => console.log(`[bridge ${now()}]`, ...a)

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
  })
  res.end(text)
}

function empty(res, status = 204) {
  res.writeHead(status, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
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
function dispatch() {
  if (!waiter || queue.length === 0) return
  const job = queue.shift()
  const { res, timer } = waiter
  waiter = null
  clearTimeout(timer)
  log(`→ job ${job.id.slice(0, 8)} (${job.ops.length} ops${job.dryRun ? ', dry-run' : ''})`)
  json(res, 200, job)
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
  if (body.maxUsd !== undefined) args.push('--max-usd', String(body.maxUsd))
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
  return waiter !== null || Date.now() - lastPollAt < DISCONNECT_GRACE_MS
}

// If the plugin disappears mid-run, do not wait for the timeout — fail fast.
setInterval(() => {
  if (pending.size === 0 || waiter !== null) return
  if (Date.now() - lastPollAt < DISCONNECT_GRACE_MS) return
  for (const [id, slot] of pending) {
    clearTimeout(slot.timer)
    pending.delete(id)
    log(`✕ job ${id.slice(0, 8)} — plugin gone`)
    slot.reject(Object.assign(new Error('plugin disconnected while the operation was running'), { code: 'PLUGIN_GONE' }))
  }
}, 1_000).unref()

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  const path = url.pathname

  if (req.method === 'OPTIONS') return empty(res, 204)

  // --- health / status ---------------------------------------------------
  if (req.method === 'GET' && (path === '/status' || path === '/health')) {
    return json(res, 200, {
      ok: true,
      port: PORT,
      pluginConnected: isConnected(),
      pollPending: waiter !== null,
      lastPollAt: lastPollAt || null,
      connectedSinceSeconds: connectedAt ? Math.round((Date.now() - connectedAt) / 1000) : null,
      queued: queue.length,
      inFlight: pending.size,
      waitingJobs: [...pending.keys()].map((k) => k.slice(0, 8)),
    })
  }

  // --- long-poll od pluginu ---------------------------------------------
  if (req.method === 'GET' && path === '/poll') {
    lastPollAt = Date.now()
    if (connectedAt === null) {
      connectedAt = Date.now()
      log('plugin connected')
    }
    if (waiter) {
      // a previous poll (e.g. a hung tab) — close it with an empty response
      clearTimeout(waiter.timer)
      try { json(waiter.res, 200, { idle: true }) } catch { /* already closed */ }
      waiter = null
    }
    const timer = setTimeout(() => {
      if (waiter && waiter.res === res) waiter = null
      try { json(res, 200, { idle: true }) } catch { /* already closed */ }
    }, POLL_TIMEOUT_MS)
    waiter = { res, timer }
    req.on('close', () => {
      if (waiter && waiter.res === res) {
        clearTimeout(timer)
        waiter = null
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
    log(`← job ${String(body.id).slice(0, 8)} ${body.ok ? 'ok' : 'FAIL'}`)
    slot.resolve(body)
    return json(res, 200, { ok: true })
  }

  // --- zlecenie od agenta ------------------------------------------------
  // --- obrazy (fal przez img-forge) ---------------------------------------
  if (req.method === 'GET' && path === '/image/models') {
    if (!requireToken(req, res)) return
    try {
      const registry = await runImgForge(['models', '--json'])
      return json(res, 200, { ok: true, ...registry })
    } catch (err) {
      return json(res, 500, { error: err.message })
    }
  }

  if (req.method === 'GET' && path === '/image/schema') {
    if (!requireToken(req, res)) return
    const model = url.searchParams.get('model')
    if (!model) return json(res, 400, { error: 'pass ?model=<endpoint-id>' })
    try {
      const schema = await runImgForge(['models', 'inspect', model, '--json'])
      return json(res, 200, { ok: true, ...schema })
    } catch (err) {
      return json(res, 500, { error: err.message })
    }
  }

  if (req.method === 'POST' && path === '/image/jobs') {
    if (!requireToken(req, res)) return
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
    if (!requireToken(req, res)) return
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
    const id = randomUUID()
    const job = { id, ops, dryRun: Boolean(body.dryRun), ts: Date.now() }
    const timeoutMs = Number(body.timeoutMs || DEFAULT_RUN_TIMEOUT_MS)

    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
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
