#!/usr/bin/env node
/**
 * Test for mcp.mjs: a real stdio handshake, then one tool call per bridge.
 * Run: node scripts/test-mcp.mjs   (needs the bridge server up for figma_status; degrades to a
 * reported error string otherwise, which is still a valid tool result).
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..', 'mcp.mjs')

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] })
let buffer = ''
let stderr = ''
const messages = []
child.stdout.on('data', (d) => {
  buffer += d
  let newline
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) messages.push(JSON.parse(line))
  }
})
child.stderr.on('data', (d) => (stderr += d))

const send = (message) => child.stdin.write(JSON.stringify(message) + '\n')
const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`ok   ${label}`)
  else {
    failures++
    console.log(`FAIL ${label}${detail ? ' — ' + detail : ''}`)
  }
}

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })
await wait()
const init = messages.find((m) => m.id === 1)
check('initialize returns serverInfo', init?.result?.serverInfo?.name === 'figma-bridge', JSON.stringify(init))
check('initialize advertises tools', init?.result?.capabilities?.tools !== undefined)
check('initialize carries instructions', typeof init?.result?.instructions === 'string' && init.result.instructions.length > 40)

send({ jsonrpc: '2.0', method: 'notifications/initialized' })
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
await wait()
const list = messages.find((m) => m.id === 2)
const names = (list?.result?.tools || []).map((t) => t.name)
check('tools/list returns tools', names.length >= 10, JSON.stringify(names))
check('every tool has an input schema', (list?.result?.tools || []).every((t) => t.inputSchema?.type === 'object'))
check('figma_run exposed', names.includes('figma_run'))
check('img_generate exposed', names.includes('img_generate'))

send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'figma_status', arguments: {} } })
await wait(1200)
const status = messages.find((m) => m.id === 3)
check('figma_status returns text', typeof status?.result?.content?.[0]?.text === 'string', JSON.stringify(status).slice(0, 300))
check('figma_status reports bridge state', /pluginConnected|ok|cannot reach/.test(status?.result?.content?.[0]?.text || ''))

send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } })
await wait()
const bad = messages.find((m) => m.id === 4)
check('unknown tool is a JSON-RPC error', bad?.error?.code === -32602, JSON.stringify(bad))

send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'figma_rules', arguments: {} } })
await wait(600)
const rules = messages.find((m) => m.id === 5)
check('figma_rules returns JSON', /^\{/.test((rules?.result?.content?.[0]?.text || '').trim()), JSON.stringify(rules).slice(0, 200))

send({ jsonrpc: '2.0', id: 6, method: 'figma_rules' })
await wait()
const unknown = messages.find((m) => m.id === 6)
check('unknown method is a JSON-RPC error', unknown?.error?.code === -32601, JSON.stringify(unknown))

child.stdin.end()
await new Promise((r) => child.on('exit', r))

check('stdout carried no non-protocol noise', !stderr.split('\n').some((l) => l.includes('cannot parse')), stderr.slice(0, 300))
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
