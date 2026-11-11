#!/usr/bin/env node
/**
 * Mock pluginu — symuluje Figmę, żeby przetestować protokół mostka bez GUI.
 * Użycie: node scripts/mock-plugin.mjs [--ops]
 */
const BASE = process.env.FIGMA_BRIDGE_URL || 'http://127.0.0.1:3847'
const CLIENT = process.env.MOCK_CLIENT || 'mock1'
const FILE = process.env.MOCK_FILE || 'Mock File'
const POLL = `${BASE}/poll?client=${encodeURIComponent(CLIENT)}&file=${encodeURIComponent(FILE)}&page=Page%201`

async function execute(op) {
  switch (op.op) {
    case 'ping':
      return { pong: true, ts: Date.now(), bridge: 'mock-plugin/1' }
    case 'status':
      return {
        fileKey: 'MOCKFILE',
        fileName: 'Mock File',
        page: { id: '0:1', name: 'Page 1' },
        pages: [{ id: '0:1', name: 'Page 1' }],
        editorType: 'figma',
        selection: [{ id: '1:2', name: 'Mock Frame', type: 'FRAME' }],
        user: 'mock',
      }
    case 'selection':
      return {
        count: 1,
        nodes: [
          {
            id: '1:2',
            name: 'Mock Frame',
            type: 'FRAME',
            x: 0, y: 0, width: 1440, height: 900,
            fills: ['#FFFFFF'],
            children: [{ id: '1:3', name: 'Title', type: 'TEXT', characters: 'Hello from mock' }],
          },
        ],
      }
    case 'export':
      return { nodeId: op.nodeId, name: 'Mock', format: 'PNG', bytes: 8, base64: 'iVBORw0KGgo=' }
    default:
      return { mocked: true, op: op.op }
  }
}

async function main() {
  let n = 0
  for (;;) {
    let job
    try {
      const res = await fetch(POLL, { cache: 'no-store' })
      job = await res.json()
    } catch (err) {
      console.error('[mock] brak serwera:', err.message)
      await new Promise((r) => setTimeout(r, 1500))
      continue
    }
    if (!job || !job.id) continue
    n += 1
    const results = []
    let ok = true
    let error
    for (let i = 0; i < job.ops.length; i += 1) {
      try {
        results.push({ index: i, op: job.ops[i].op, ok: true, value: await execute(job.ops[i]) })
      } catch (err) {
        ok = false
        error = `op #${i}: ${err.message}`
        results.push({ index: i, op: job.ops[i].op, ok: false, error: err.message })
        break
      }
    }
    await fetch(`${BASE}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: job.id, ok, results, error }),
    })
    console.error(`[mock:${FILE}] obsłużono job #${n} (${job.ops.map((o) => o.op).join(', ')})`)
    if (process.env.MOCK_ONCE === '1' && n >= 1) process.exit(0)
  }
}

main()
