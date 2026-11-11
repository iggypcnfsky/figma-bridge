// Checks the image-job plumbing that the panel relies on: several references and a mask
// end up in the payload `img edit` builds, and the mask is written next to the refs.
//
//   node scripts/test-image-job.mjs
//
// Runs a dry-run job, so nothing is sent to fal and nothing is paid for.

import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'

const PORT = 3990 + Math.floor(Math.random() * 8)
const BASE = `http://127.0.0.1:${PORT}`
const repo = new URL('..', import.meta.url).pathname

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

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: repo,
  env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.resume()
server.stderr.resume()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (label, ok, detail) => {
  if (ok) console.log('ok   ' + label)
  else {
    failures += 1
    console.log('FAIL ' + label + (detail === undefined ? '' : ' — ' + JSON.stringify(detail)))
  }
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

  const body = {
    mode: 'edit',
    prompt: 'swap the wall only',
    model: 'openai/gpt-image-2.6/sunburst/edit',
    size: '512x512',
    refs: [
      { filename: 'a.png', base64: png(8, 8, [200, 120, 60]).toString('base64') },
      { filename: 'b.png', base64: png(8, 8, [60, 120, 200]).toString('base64') },
    ],
    mask: { filename: 'mask.png', base64: png(8, 8, [255, 255, 255]).toString('base64') },
    dryRun: true,
    confirmCost: true,
  }
  const started = await (await fetch(`${BASE}/image/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).json()
  check('job accepted', Boolean(started.id), started)

  let job = started
  const deadline = Date.now() + 20000
  while (job.status !== 'done' && job.status !== 'failed' && Date.now() < deadline) {
    await sleep(300)
    job = await (await fetch(`${BASE}/image/jobs/${started.id}`)).json()
  }
  check('dry-run job finished', job.status === 'done', job.status + (job.error ? ' — ' + job.error : ''))

  const payload = (job.result && job.result.payload) || {}
  check('both references reach the payload', (payload.image_urls || []).length === 2, payload.image_urls)
  check('the mask reaches the payload', /<upload mask\.png>/.test(payload.mask_url || ''), payload.mask_url)
  check('nothing was charged', Boolean(job.result && job.result.dryRun), job.result && job.result.cost)

  // a mask that does not match the first reference must be rejected before fal sees it
  const mismatch = await fetch(`${BASE}/image/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'edit',
      prompt: 'swap',
      model: 'openai/gpt-image-2.6/sunburst/edit',
      refs: [{ filename: 'a.png', base64: png(16, 16, [10, 20, 30]).toString('base64') }],
      mask: { filename: 'mask.png', base64: png(8, 8, [255, 255, 255]).toString('base64') },
      dryRun: true,
      confirmCost: true,
    }),
  })
  const mismatchBody = await mismatch.json()
  check('mask/reference size mismatch is rejected', mismatch.status === 400 && /identical dimensions/.test(mismatchBody.error || ''), mismatchBody)

  const dir = join(repo, 'out', 'jobs', started.id)
  check('mask is on disk next to the refs', existsSync(join(dir, 'mask.png')) && existsSync(join(dir, 'ref-0.png')) && existsSync(join(dir, 'ref-1.png')))
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
} finally {
  server.kill('SIGKILL')
}

console.log(failures === 0 ? '\nimage job contract holds' : '\n' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
