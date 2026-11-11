// Proves the concurrency contract of the bridge without Figma:
//
//   node scripts/test-serialisation.mjs
//
// 1. one plugin window, two agents: the second batch must wait for the first /result —
//    otherwise both run in the same single-threaded plugin and interleave at every await;
// 2. two plugin windows: the batches must run in parallel (separate lanes).
//
// Starts a private server on a free port, so a running bridge is untouched.

import { spawn } from 'node:child_process'

const PORT = 3900 + Math.floor(Math.random() * 80)
const BASE = `http://127.0.0.1:${PORT}`
const repo = new URL('..', import.meta.url).pathname

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: repo,
  env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.resume()
server.stderr.resume()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const events = []
const mark = (text) => events.push({ t: Date.now() - t0, text })

let failures = 0
const check = (label, ok, detail) => {
  if (ok) console.log('ok   ' + label)
  else {
    failures += 1
    console.log('FAIL ' + label + (detail ? ' — ' + detail : ''))
  }
}

async function fakePlugin(client, ms = 400) {
  for (;;) {
    let job
    try {
      job = await (await fetch(`${BASE}/poll?client=${client}&file=Race&page=P1`)).json()
    } catch (err) {
      return // server gone
    }
    if (!job || !job.id) continue
    mark(`${client} received ${job.id.slice(0, 6)}`)
    await sleep(ms)
    mark(`${client} posted ${job.id.slice(0, 6)}`)
    await fetch(`${BASE}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: job.id, ok: true, results: [{ index: 0, op: 'ping', ok: true, value: {} }] }),
    }).catch(() => {})
  }
}

async function run(label, client) {
  const res = await fetch(`${BASE}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client, ops: [{ op: 'ping' }], timeoutMs: 8000 }),
  })
  mark(`${label} done ${res.status}`)
  return res.status
}

await sleep(400)

// --- 1. two agents, one window -------------------------------------------------
const solo = fakePlugin('solo', 500)
await sleep(150)
const a = run('A', 'solo')
await sleep(120)
const b = run('B', 'solo')
const [statusA, statusB] = await Promise.all([a, b])
await sleep(200)

const received = events.filter((e) => e.text.startsWith('solo received'))
const firstPosted = events.findIndex((e) => e.text.startsWith('solo posted'))
const secondReceived = received[1] ? events.indexOf(received[1]) : -1
check('two agents on one window both succeed', statusA === 200 && statusB === 200, `${statusA}/${statusB}`)
check(
  'the second batch waits for the first /result',
  secondReceived > firstPosted && firstPosted !== -1,
  `second=${secondReceived} first-result=${firstPosted}`,
)

// --- 2. two windows, one agent each --------------------------------------------
const before = events.length
fakePlugin('wA', 500)
fakePlugin('wB', 500)
await sleep(200)
const [statusC, statusD] = await Promise.all([run('C', 'wA'), run('D', 'wB')])
await sleep(200)
const pair = events.slice(before)
const firstDone = pair.findIndex((e) => e.text.includes('posted'))
const bothReceived = pair.filter((e) => e.text.includes('received')).length === 2
check('two windows run in parallel', bothReceived && firstDone >= 2 && statusC === 200 && statusD === 200, JSON.stringify(pair.map((e) => e.text)))

console.log(events.map((e) => String(e.t).padStart(5) + 'ms ' + e.text).join('\n'))
server.kill('SIGKILL')
console.log(failures === 0 ? '\nserialisation contract holds' : '\n' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
