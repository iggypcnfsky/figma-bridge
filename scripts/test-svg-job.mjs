// Sprawdza kontrakt zleceń wektorowych: referencje i prompt trafiają do QuiverAI, trace
// wysyła obraz do vectorizations, a wynik (SVG + rozmiar + koszt) wraca do panelu/CLI.
//
//   node scripts/test-svg-job.mjs
//
// QuiverAI jest podstawiony lokalnym stubem (QUIVER_BASE_URL), więc nic nie leci do internetu
// i nic nie kosztuje.

import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'

const QUIVER_PORT = 3998 + Math.floor(Math.random() * 6)
const BRIDGE_PORT = 4004 + Math.floor(Math.random() * 6)
const QUIVER = `http://127.0.0.1:${QUIVER_PORT}/v1`
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`
const repo = new URL('..', import.meta.url).pathname
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#f00"/></svg>'

function png(width, height, rgb) {
  const raw = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => rgb[i % 3])])))
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- stub QuiverAI -----------------------------------------------------------
const seen = []
const stub = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      return send(200, {
        object: 'list',
        data: [{
          id: 'arrow-2',
          object: 'model',
          name: 'Arrow 2',
          owned_by: 'quiver',
          supported_operations: ['svg_generate', 'svg_vectorize'],
          supported_sampling_parameters: ['temperature'],
          billing: { kind: 'token_usage', currency: 'USD', pricing_model: 'token_usage_v1', rates: { input: 400000, cached_input: 40000, cache_write: 500000, output: 2000000, unit: 'millicents_per_million_tokens' } },
        }],
      })
    }
    if (req.method === 'POST' && req.url === '/v1/svgs/generations') {
      seen.push({ path: 'generations', body: JSON.parse(body || '{}'), auth: req.headers.authorization })
      return send(200, { id: 'resp_1', data: [{ mime_type: 'image/svg+xml', svg: SVG }], usage: { input_tokens: 1000, output_tokens: 2000, total_tokens: 3000 } })
    }
    if (req.method === 'POST' && req.url === '/v1/svgs/vectorizations') {
      seen.push({ path: 'vectorizations', body: JSON.parse(body || '{}'), auth: req.headers.authorization })
      return send(200, { id: 'resp_2', data: [{ mime_type: 'image/svg+xml', svg: SVG }], usage: { input_tokens: 500, output_tokens: 1500, total_tokens: 2000 } })
    }
    if (req.method === 'POST' && req.url === '/v1/svgs/generations?fail=1') {
      return send(402, { status: 402, code: 'insufficient_credits', message: 'not enough credits', request_id: 'req_402' })
    }
    send(404, { status: 404, code: 'model_not_found', message: 'no such route' })
  })
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (label, ok, detail) => {
  if (ok) console.log('ok   ' + label)
  else {
    failures += 1
    console.log('FAIL ' + label + (detail === undefined ? '' : ' — ' + JSON.stringify(detail)))
  }
}

await new Promise((resolve) => stub.listen(QUIVER_PORT, '127.0.0.1', resolve))

const bridge = spawn(process.execPath, ['server.mjs'], {
  cwd: repo,
  env: {
    ...process.env,
    FIGMA_BRIDGE_PORT: String(BRIDGE_PORT),
    QUIVER_BASE_URL: QUIVER,
    QUIVERAI_API_KEY: 'sk_test_bridge',
    SVG_CONCURRENCY: '2',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
bridge.stdout.resume()
bridge.stderr.resume()

async function wait(jobId, kind = 'svg') {
  const deadline = Date.now() + 15000
  let job = null
  while (Date.now() < deadline) {
    job = await (await fetch(`${BASE}/${kind}/jobs/${jobId}`)).json()
    if (job.status === 'done' || job.status === 'error') return job
    await sleep(200)
  }
  return job
}

try {
  const until = Date.now() + 5000
  while (Date.now() < until) {
    try {
      if ((await fetch(`${BASE}/status`)).ok) break
    } catch {
      await sleep(100)
    }
  }

  const models = await (await fetch(`${BASE}/svg/models`)).json()
  check('catalog lists arrow-2 for both operations',
    models.configured === true && models.models.some((m) => m.id === 'arrow-2') &&
    models.usable.generate.includes('arrow-2') && models.usable.vectorize.includes('arrow-2'), models)

  // generate: prompt + reference images
  const started = await (await fetch(`${BASE}/svg/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'generate',
      model: 'arrow-2',
      prompt: 'minimal fox mark',
      refs: [{ filename: 'a.png', base64: png(8, 8, [200, 120, 60]).toString('base64') }],
    }),
  })).json()
  check('generate job accepted', Boolean(started.id), started)

  let job = await wait(started.id)
  check('generate finished', job.status === 'done', job.status + (job.error ? ' — ' + job.error : ''))
  const result = job.result || {}
  check('svg comes back with its intrinsic size', /<svg/.test(result.svg || '') && result.width === 120 && result.height === 80, { width: result.width, height: result.height })
  check('cost follows token rates', result.cost === 0.044, result.cost)
  check('usage is reported', result.usage && result.usage.output_tokens === 2000, result.usage)

  const generation = seen.find((entry) => entry.path === 'generations')
  check('prompt and model reach QuiverAI', generation && generation.body.prompt === 'minimal fox mark' && generation.body.model === 'arrow-2', generation && generation.body)
  check('reference is sent as base64', Boolean(generation && generation.body.references && generation.body.references[0].base64), generation && generation.body.references)
  check('key travels as a bearer token', generation && generation.auth === 'Bearer sk_test_bridge', generation && generation.auth)

  // generate bez referencji: sam prompt jest poprawnym wejściem
  const promptOnly = await (await fetch(`${BASE}/svg/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'generate', model: 'arrow-2', prompt: 'a plain prompt, no references' }),
  })).json()
  check('prompt-only generate is accepted', Boolean(promptOnly.id), promptOnly)
  if (promptOnly.id) {
    const done = await wait(promptOnly.id)
    check('prompt-only generate finishes', done.status === 'done', done.error)
    const sent = seen.filter((entry) => entry.path === 'generations').pop()
    check('no references key is sent when there are none', sent && sent.body.references === undefined, sent && sent.body)
    const dir2 = join(repo, 'out', 'jobs', promptOnly.id)
    if (existsSync(dir2)) rmSync(dir2, { recursive: true, force: true })
  }

  // trace: one image -> vectorizations, no prompt
  const traced = await (await fetch(`${BASE}/svg/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'vectorize',
      model: 'arrow-2',
      refs: [{ filename: 'logo.png', base64: png(8, 8, [10, 20, 30]).toString('base64') }],
    }),
  })).json()
  check('trace job accepted', Boolean(traced.id), traced)
  job = await wait(traced.id)
  check('trace finished', job.status === 'done', job.status + (job.error ? ' — ' + job.error : ''))
  const vectorization = seen.find((entry) => entry.path === 'vectorizations')
  check('trace sends the image, not a prompt',
    Boolean(vectorization && vectorization.body.image && vectorization.body.image.base64) && vectorization.body.prompt === undefined,
    vectorization && vectorization.body)
  check('trace asks for auto_crop', Boolean(vectorization && vectorization.body.auto_crop === true))

  // validation
  const noPrompt = await fetch(`${BASE}/svg/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'generate', model: 'arrow-2', prompt: '   ' }),
  })
  check('empty prompt is rejected', noPrompt.status === 400)

  const noImage = await fetch(`${BASE}/svg/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'vectorize', model: 'arrow-2', refs: [] }),
  })
  check('trace without a reference is rejected', noImage.status === 400)

  const tooBig = await fetch(`${BASE}/svg/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'generate',
      model: 'arrow-2',
      prompt: 'huge',
      refs: [{ filename: 'huge.png', base64: Buffer.alloc(13 * 1024 * 1024, 7).toString('base64') }],
    }),
  })
  const tooBigBody = await tooBig.json()
  check('a reference over 12 MB is rejected before billing',
    tooBig.status === 400 && /12 MB/.test(tooBigBody.error || ''), tooBigBody)

  const status = await (await fetch(`${BASE}/status`)).json()
  check('status reports the svg lane', status.svg && status.svg.concurrency >= 1 && status.svg.configured === true, status.svg)

  const unknown = await fetch(`${BASE}/svg/jobs/does-not-exist`)
  check('unknown job is 404', unknown.status === 404)

  const dir = join(repo, 'out', 'jobs', started.id)
  check('result and references stay in the job dir', existsSync(join(dir, 'result.svg')) && existsSync(join(dir, 'ref-0.png')))
  for (const id of [started.id, traced.id]) {
    const path = join(repo, 'out', 'jobs', id)
    if (existsSync(path)) rmSync(path, { recursive: true, force: true })
  }
} finally {
  bridge.kill('SIGKILL')
  stub.close()
}

console.log(failures === 0 ? '\nsvg job contract holds' : '\n' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
