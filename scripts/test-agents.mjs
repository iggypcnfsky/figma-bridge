// Checks the agent registry: who is on the canvas, minting a new identity, renaming,
// forgetting, and the busy flag while a batch runs.
//
//   node scripts/test-agents.mjs
//
// Starts a private server plus the mock plugin, so a running bridge is untouched.

import { spawn } from 'node:child_process'

const PORT = 3960 + Math.floor(Math.random() * 30)
const BASE = `http://127.0.0.1:${PORT}`
const repo = new URL('..', import.meta.url).pathname

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: repo,
  env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.resume()
server.stderr.resume()

const mock = spawn(process.execPath, ['scripts/mock-plugin.mjs'], {
  cwd: repo,
  env: { ...process.env, FIGMA_BRIDGE_URL: BASE, MOCK_CLIENT: 'mock-agent-test' },
  stdio: ['ignore', 'ignore', 'ignore'],
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

async function status() {
  try {
    return await (await fetch(`${BASE}/status`)).json()
  } catch {
    return {} // server still booting
  }
}

async function runAs(agent, ops = [{ op: 'ping' }], label) {
  const headers = { 'content-type': 'application/json', 'x-agent': agent }
  if (label) headers['x-agent-label'] = encodeURIComponent(label)
  const res = await fetch(`${BASE}/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ops, timeoutMs: 8000 }),
  })
  return { status: res.status, body: await res.json() }
}

async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await fn()) return true
    await sleep(100)
  }
  return false
}

try {
  await waitFor(async () => (await status()).pluginConnected)
  check('mock plugin connected', (await status()).pluginConnected)

  const a = await runAs('claude')
  const b = await runAs('codex')
  check('both agents succeed', a.status === 200 && b.status === 200, `${a.status}/${b.status}`)

  let d = await status()
  check('two agents are listed', d.agentCount === 2 && d.agents.length === 2, d.agents)
  const claude = d.agents.find((x) => x.id === 'claude')
  const codex = d.agents.find((x) => x.id === 'codex')
  check('per-agent counters', claude?.runs === 1 && claude?.ops === 1 && codex?.runs === 1, d.agents)
  check('agents are idle after the batch', claude?.busy === null && codex?.busy === null, d.agents)

  // a label from the agent names it, and a manual rename wins over later labels
  await runAs('labelled', [{ op: 'ping' }], 'Figma bridge panel — resize')
  d = await status()
  check('x-agent-label names the agent', d.agents.find((x) => x.id === 'labelled')?.name === 'Figma bridge panel — resize', d.agents)
  await fetch(`${BASE}/agents/labelled`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed by hand' }),
  })
  await runAs('labelled', [{ op: 'ping' }], 'some other label')
  d = await status()
  check('a manual rename survives new labels', d.agents.find((x) => x.id === 'labelled')?.name === 'Renamed by hand', d.agents)

  // busy flag while a batch is running: ask for a slow batch and look immediately
  const slow = runAs('claude', [{ op: 'exec', code: 'await new Promise(r => setTimeout(r, 600)); return 1' }])
  const busySeen = await waitFor(async () => ((await status()).agents || []).find((x) => x.id === 'claude')?.busy, 2000)
  check('an agent shows as busy mid-batch', Boolean(busySeen))
  await slow
  await waitFor(async () => !((await status()).agents || []).find((x) => x.id === 'claude')?.busy, 2000)

  // mint, rename, forget
  const minted = await (await fetch(`${BASE}/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'third' }),
  })).json()
  check('panel can mint an agent', /^agent-\d+$/.test(minted.id) && minted.command.includes(minted.id), minted)

  const renamed = await (await fetch(`${BASE}/agents/${minted.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Claude 2' }),
  })).json()
  check('rename sticks', renamed.agent?.name === 'Claude 2', renamed)

  const removed = await (await fetch(`${BASE}/agents/${minted.id}`, { method: 'DELETE' })).json()
  check('forget removes it', removed.removed === minted.id && !removed.agents.some((x) => x.id === minted.id), removed.agents)

  // an operation from a foreign origin must not touch the registry
  const blocked = await fetch(`${BASE}/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ name: 'evil' }),
  })
  check('foreign origins cannot mint agents', blocked.status === 403, blocked.status)

  d = await status()
  console.log('\nagents:', d.agents.map((x) => `${x.name}(${x.id}) runs=${x.runs} ops=${x.ops}`).join(', '))
} finally {
  mock.kill('SIGKILL')
  server.kill('SIGKILL')
}

console.log(failures === 0 ? '\nagent registry contract holds' : '\n' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
