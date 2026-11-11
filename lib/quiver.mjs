/**
 * QuiverAI (quiver.ai) — SVG generation and vectorization.
 *
 * The panel and the CLI both go through this module, so the API key never leaves the
 * machine and every request is built in one place. No dependencies: Node >= 20 fetch.
 *
 * Endpoints (https://docs.quiver.ai/api-reference):
 *   GET  /v1/models                  — catalog, operations and token rates
 *   POST /v1/svgs/generations        — prompt (+ optional reference images) -> SVG
 *   POST /v1/svgs/vectorizations     — raster/SVG image -> SVG
 *
 * Billing is token-based: rates come back from /v1/models in "millicents per million
 * tokens", so USD = tokens × rate / 1e11.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DEFAULT_BASE = 'https://api.quiver.ai/v1'

// Documented limits for an input image (per reference): 12 MiB decoded, 4096 px per side,
// 16,777,216 total pixels. Reference count depends on the model; Arrow 2 allows 14.
export const LIMITS = {
  bytes: 12_582_912,
  side: 4096,
  pixels: 16_777_216,
  references: 14,
}

const catalog = { at: 0, models: [], error: null }

export class QuiverError extends Error {
  constructor(message, { code, status, requestId } = {}) {
    super(message)
    this.name = 'QuiverError'
    this.code = code || null
    this.status = status || null
    this.requestId = requestId || null
  }
}

/** Reads KEY=value lines from a .env file without touching existing environment values. */
export function loadEnvFile(file = join(ROOT, '.env')) {
  if (!existsSync(file)) return false
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const [, key, rest] = match
    let value = rest.trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
  return true
}

/** The key, from the environment or figma-bridge/.env. Never logged. */
export function apiKey() {
  loadEnvFile()
  return String(process.env.QUIVERAI_API_KEY || '').trim()
}

export function configured() {
  return Boolean(apiKey())
}

/** Override for tests and self-hosted proxies. */
export function baseUrl() {
  return String(process.env.QUIVER_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '')
}

function timeoutMs() {
  return Number(process.env.QUIVER_TIMEOUT_MS || 180_000)
}

async function call(path, { method = 'GET', body } = {}) {
  const key = apiKey()
  if (!key) {
    throw new QuiverError(
      'QUIVERAI_API_KEY is not set — create a key at https://platform.quiver.ai/api-keys, then add ' +
        'QUIVERAI_API_KEY=... to figma-bridge/.env (or export it) and restart the bridge',
      { code: 'missing_api_key' },
    )
  }
  let response
  try {
    response = await fetch(baseUrl() + path, {
      method,
      headers: {
        authorization: 'Bearer ' + key,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'figma-bridge/quiver',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs()),
    })
  } catch (err) {
    const message = err?.name === 'TimeoutError'
      ? 'QuiverAI did not answer within ' + Math.round(timeoutMs() / 1000) + ' s'
      : 'cannot reach api.quiver.ai: ' + (err?.message || err)
    throw new QuiverError(message, { code: 'network_error' })
  }
  const text = await response.text()
  let payload = null
  try { payload = text ? JSON.parse(text) : null } catch { /* non-JSON error page */ }
  if (!response.ok) {
    const detail = payload && typeof payload === 'object' ? payload : null
    const message = detail?.message || (text || '').slice(0, 240) || 'QuiverAI request failed'
    const suffix = detail?.request_id ? ' (request ' + detail.request_id + ')' : ''
    throw new QuiverError(message + suffix, {
      code: detail?.code || 'http_' + response.status,
      status: detail?.status || response.status,
      requestId: detail?.request_id,
    })
  }
  return payload ?? {}
}

/**
 * Catalog with the operations each model supports. Cached for five minutes; the panel
 * calls it on every open, and a key mistake should not spam the API.
 */
export async function listModels({ force = false } = {}) {
  if (!configured()) return { models: [], error: 'QUIVERAI_API_KEY is not set' }
  if (!force && catalog.models.length && Date.now() - catalog.at < 5 * 60_000) {
    return { models: catalog.models, error: null }
  }
  try {
    const payload = await call('/models')
    const models = (Array.isArray(payload?.data) ? payload.data : []).map(normalizeModel)
    catalog.models = models
    catalog.at = Date.now()
    catalog.error = null
    return { models, error: null }
  } catch (err) {
    catalog.error = err.message
    return { models: catalog.models, error: err.message }
  }
}

function normalizeModel(model) {
  const ops = Array.isArray(model?.supported_operations) ? model.supported_operations : []
  return {
    id: String(model?.id || ''),
    name: String(model?.name || model?.id || ''),
    description: model?.description ? String(model.description).slice(0, 200) : '',
    ops,
    sampling: Array.isArray(model?.supported_sampling_parameters) ? model.supported_sampling_parameters : [],
    billing: model?.billing || null,
    rates: model?.billing?.rates || null,
    credits: model?.pricing_credits || null,
  }
}

/** Models that can generate SVGs, or vectorize, per the catalog. */
export function modelsFor(operation, models) {
  const required = operation === 'vectorize' ? 'svg_vectorize' : 'svg_generate'
  const usable = models.filter((model) => model.ops.includes(required))
  return usable.length ? usable : models
}

export function defaultModel(operation, models) {
  const usable = modelsFor(operation, models)
  const arrow = usable.find((model) => model.id === 'arrow-2')
  return (arrow || usable[0] || { id: 'arrow-2' }).id
}

/**
 * Prompt (+ optional reference images) -> SVG.
 * `references` entries may be `{ base64 }`, `{ url }` or a URL string.
 */
export async function generate({ model = 'arrow-2', prompt, instructions, references = [], n = 1 } = {}) {
  if (!prompt || !String(prompt).trim()) throw new QuiverError('prompt is required', { code: 'invalid_request' })
  if (references.length > LIMITS.references) {
    throw new QuiverError('at most ' + LIMITS.references + ' references are supported', { code: 'invalid_request' })
  }
  const body = { model, prompt: String(prompt), n: Math.max(1, Math.min(16, Number(n) || 1)) }
  if (instructions && String(instructions).trim()) body.instructions = String(instructions)
  if (references.length) body.references = references.map(normalizeReference)
  const payload = await call('/svgs/generations', { method: 'POST', body })
  return normalizeResult(payload, model)
}

/** Raster (or SVG) image -> SVG. This is a trace: it does not take a prompt. */
export async function vectorize({ model = 'arrow-2', image, autoCrop = true, targetSize } = {}) {
  if (!image) throw new QuiverError('image is required', { code: 'invalid_request' })
  const body = { model, image: normalizeReference(image), auto_crop: Boolean(autoCrop) }
  if (targetSize) body.target_size = Math.max(128, Math.min(4096, Math.round(targetSize)))
  const payload = await call('/svgs/vectorizations', { method: 'POST', body })
  return normalizeResult(payload, model)
}

function normalizeReference(ref) {
  if (typeof ref === 'string') return { url: ref }
  if (!ref || typeof ref !== 'object') throw new QuiverError('bad reference image', { code: 'invalid_request' })
  if (ref.base64) return { base64: String(ref.base64) }
  if (ref.url) return { url: String(ref.url) }
  throw new QuiverError('a reference needs { base64 } or { url }', { code: 'invalid_request' })
}

function normalizeResult(payload, model) {
  const documents = Array.isArray(payload?.data) ? payload.data : []
  const svgs = documents
    .map((doc) => ({ svg: String(doc?.svg || ''), mime: doc?.mime_type || 'image/svg+xml' }))
    .filter((doc) => doc.svg.trim())
  if (svgs.length === 0) {
    throw new QuiverError('QuiverAI returned no SVG', { code: 'empty_result' })
  }
  const first = svgs[0]
  const size = svgSize(first.svg)
  return {
    svgs,
    svg: first.svg,
    model,
    usage: payload?.usage || null,
    width: size.width,
    height: size.height,
    id: payload?.id || null,
  }
}

/** Intrinsic size from width/height or viewBox; 1024 square when the file does not say. */
export function svgSize(svg) {
  const text = String(svg || '')
  const dimensions = /<svg\b[^>]*?\swidth\s*=\s*["']?\s*([\d.]+)\s*(px|%)?\s*["']?[^>]*?\sheight\s*=\s*["']?\s*([\d.]+)\s*(px|%)?/i.exec(text)
  if (dimensions && dimensions[2] !== '%' && dimensions[4] !== '%') {
    const width = Math.round(Number(dimensions[1]))
    const height = Math.round(Number(dimensions[3]))
    if (width > 0 && height > 0) return { width, height }
  }
  const viewBox = /<svg\b[^>]*?\sviewBox\s*=\s*["']\s*[-.\d]+\s+[-.\d]+\s+([\d.]+)\s+([\d.]+)\s*["']/i.exec(text)
  if (viewBox) {
    const width = Math.round(Number(viewBox[1]))
    const height = Math.round(Number(viewBox[2]))
    if (width > 0 && height > 0) return { width, height }
  }
  return { width: 1024, height: 1024 }
}

/** USD for a token-usage response, using the model's advertised rates. */
export function costUsd(usage, modelEntry) {
  const rates = modelEntry && modelEntry.rates
  if (!usage || !rates) return null
  const input = Number(usage.input_tokens || usage.prompt_tokens || 0)
  const output = Number(usage.output_tokens || usage.completion_tokens || 0)
  const rate = modelEntry.billing?.kind === 'token_usage' ? rates : null
  if (!rate) return null
  const usd = (input * Number(rate.input || 0) + output * Number(rate.output || 0)) / 1e11
  if (!Number.isFinite(usd) || usd <= 0) return null
  return Math.round(usd * 1e4) / 1e4
}

/** The checks `/svg/doctor` and the CLI report: key, catalog, usable models. */
export async function doctor() {
  if (!configured()) {
    return {
      ok: false,
      key: false,
      models: [],
      hint: 'create a key at https://platform.quiver.ai/api-keys and put QUIVERAI_API_KEY=... in figma-bridge/.env',
    }
  }
  const { models, error } = await listModels({ force: true })
  return {
    ok: Boolean(models.length) && !error,
    key: true,
    models: models.map((model) => ({ id: model.id, ops: model.ops, rates: model.rates })),
    error: error || null,
  }
}
