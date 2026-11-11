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
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env.FIGMA_BRIDGE_PORT || 3847)
const HOST = process.env.FIGMA_BRIDGE_HOST || '127.0.0.1'
const POLL_TIMEOUT_MS = 25_000
const DEFAULT_RUN_TIMEOUT_MS = 120_000
const DISCONNECT_GRACE_MS = 5_000
const MAX_BODY_BYTES = 32 * 1024 * 1024

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
