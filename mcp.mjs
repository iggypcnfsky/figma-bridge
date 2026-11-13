#!/usr/bin/env node
/**
 * MCP server (stdio) for Figma Bridge + img-forge.
 *
 * Why a wrapper and not a second implementation: `bin/figma` and `img-forge/img` already own the
 * logic — target selection (--file/--client), agent identity headers, error prettifying that sets
 * exit codes, cost estimation, caching. This server only translates MCP tool calls into those
 * commands, so an MCP client can never drift from what the CLI does.
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout. Nothing may be printed to stdout
 * except protocol messages — every log goes to stderr.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = HERE
const FIGMA_BIN = process.env.FIGMA_BIN || join(REPO, 'bin', 'figma')
const IMG_BIN = process.env.IMG_BIN || resolve(REPO, '..', 'img-forge', 'img')
const SERVER_INFO = { name: 'figma-bridge', version: '1.0.0' }
const PROTOCOL = '2024-11-05'

const INSTRUCTIONS = `Figma Bridge drives a live Figma file through a local plugin (no OAuth).
Before designing anything, call figma_rules — it carries this file's type floor, grid, frame size and
version naming. Call figma_status first if anything looks off; pluginConnected:false means the user
must run Plugins → Development → Figma Bridge in the window they want touched.
Rasters: img_generate (fal.ai, costs money per image, identical payloads are cached).
Vectors: run the figma svg CLI through a shell — see the figma-bridge skill.
Never rebuild work because of feedback — edit what exists.`

// ------------------------------------------------------------------ tool catalog

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const file = { type: 'string', description: 'Target Figma file name, when several windows are connected (same as --file)' }
const client = { type: 'string', description: 'Target plugin client id, when several windows are connected (same as --client)' }

const TOOLS = [
  {
    name: 'figma_status',
    description: 'Bridge health: server up/down, connected Figma windows (client, file, page), queue state, img-forge and Quiver keys.',
    inputSchema: obj({}),
    run: () => call(FIGMA_BIN, ['status']),
  },
  {
    name: 'figma_clients',
    description: 'List connected Figma windows (id, file, page, uptime). Use before picking --file/--client when several are open.',
    inputSchema: obj({}),
    run: () => call(FIGMA_BIN, ['clients']),
  },
  {
    name: 'figma_agents',
    description: 'Who has touched this canvas recently: agent name, busy/idle, run and op counts.',
    inputSchema: obj({}),
    run: () => call(FIGMA_BIN, ['agents']),
  },
  {
    name: 'figma_rules',
    description: "This Figma file's design constraints (type floor, grid, frame size, version naming). Read before designing. Empty {} means: ask the user, never import another project's style.",
    inputSchema: obj({ file }),
    run: (a) => call(FIGMA_BIN, [...target(a), 'rules']),
  },
  {
    name: 'figma_selection',
    description: 'What is selected in Figma right now, as a shallow node tree (id, type, name, size).',
    inputSchema: obj({ depth: num('Tree depth to read (default 2)'), file, client }),
    run: (a) => call(FIGMA_BIN, [...target(a), 'selection', String(a.depth ?? 2)]),
  },
  {
    name: 'figma_pages',
    description: 'List pages in the connected file.',
    inputSchema: obj({ file, client }),
    run: (a) => call(FIGMA_BIN, [...target(a), 'pages']),
  },
  {
    name: 'figma_variables',
    description: 'List local variables (collections, names, values) — use to bind tokens instead of hard-coded colors.',
    inputSchema: obj({ file, client }),
    run: (a) => call(FIGMA_BIN, [...target(a), 'variables']),
  },
  {
    name: 'figma_run',
    description:
      'Execute one or more bridge operations sequentially against the canvas. Returns per-op ok/value/error. ' +
      'Ops: status, selection, pages, variables, node, find, create, text, image (fill/generate), createFromSvg, ' +
      'style, resize, move, remove (structural nodes need confirm:true), bindVariable, export, ping. ' +
      'Full reference: docs/ops-reference.md in the figma-bridge repo.',
    inputSchema: obj(
      {
        ops: { type: 'array', items: { type: 'object' }, description: 'Operations, executed in order' },
        file,
        client,
        dryRun: { type: 'boolean', description: 'Validate without mutating the canvas' },
      },
      ['ops'],
    ),
    run: (a) => {
      const body = JSON.stringify(a.ops ?? [])
      return call(FIGMA_BIN, [...target(a), 'run', body, ...(a.dryRun ? ['--dry-run'] : [])])
    },
  },
  {
    name: 'figma_export',
    description: 'Export a node to a local file (PNG, JPG, SVG or PDF). Returns the written path and byte count.',
    inputSchema: obj(
      {
        nodeId: str('Node id to export'),
        path: str('Absolute output path, e.g. /tmp/frame.png'),
        format: { type: 'string', enum: ['PNG', 'JPG', 'SVG', 'PDF'], description: 'Default PNG' },
        scale: num('Raster scale factor, default 2'),
        file,
        client,
      },
      ['nodeId', 'path'],
    ),
    run: (a) =>
      call(FIGMA_BIN, [
        ...target(a),
        'export',
        a.nodeId,
        a.path,
        a.format || 'PNG',
        String(a.scale ?? 2),
      ]),
  },
  {
    name: 'figma_place_image',
    description: 'Fill a node with a local image file (FILL, FIT, TILE or CROP).',
    inputSchema: obj(
      {
        nodeId: str('Node to fill'),
        path: str('Local image path'),
        scaleMode: { type: 'string', enum: ['FILL', 'FIT', 'TILE', 'CROP'] },
        file,
        client,
      },
      ['nodeId', 'path'],
    ),
    run: (a) => call(FIGMA_BIN, [...target(a), 'image', a.nodeId, a.path, a.scaleMode || 'FILL']),
  },
  {
    name: 'figma_serve',
    description: 'Start the bridge server detached if it is down (survives the terminal). No-op when already running.',
    inputSchema: obj({}),
    run: () => call(FIGMA_BIN, ['serve']),
  },
  {
    name: 'img_models',
    description: 'List image models registered in img-forge (id, cost per image, default), or inspect one model\'s parameters.',
    inputSchema: obj({ inspect: str('Model id to describe') }),
    run: (a) => call(IMG_BIN, ['models', ...(a.inspect ? ['inspect', a.inspect] : [])]),
  },
  {
    name: 'img_generate',
    description:
      'Text → image with fal.ai. Costs money unless the identical payload is cached; run without yes at first to see the estimate, ' +
      'then again with yes:true. Returns the written file path.',
    inputSchema: obj(
      {
        prompt: str('What to draw'),
        model: str('fal model id (default from models.json)'),
        out: str('Output path (default out/gen/<slug>.<ext>)'),
        yes: { type: 'boolean', description: 'Confirm the estimated cost and generate' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra CLI flags, e.g. ["--aspect","16:9"]' },
      },
      ['prompt'],
    ),
    run: (a) => call(IMG_BIN, ['gen', '--prompt', a.prompt, ...flags(a)], 900_000),
  },
  {
    name: 'img_edit',
    description: 'Edit existing image(s) with fal.ai (prompt + reference files). Same cost/confirm rules as img_generate.',
    inputSchema: obj(
      {
        prompt: str('What to change'),
        refs: { type: 'array', items: { type: 'string' }, description: 'Local reference image paths (up to 14)' },
        model: str('fal model id'),
        out: str('Output path'),
        yes: { type: 'boolean', description: 'Confirm the estimated cost' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra CLI flags' },
      },
      ['prompt', 'refs'],
    ),
    run: (a) => call(IMG_BIN, ['edit', '--prompt', a.prompt, ...(a.refs || []).flatMap((r) => ['--ref', r]), ...flags(a)], 900_000),
  },
]

function target(a) {
  return [...(a.file ? ['--file', a.file] : []), ...(a.client ? ['--client', a.client] : [])]
}

function flags(a) {
  return [
    ...(a.model ? ['--model', a.model] : []),
    ...(a.out ? ['--out', a.out] : []),
    ...(a.yes ? ['--yes'] : []),
    ...(a.args || []),
  ]
}

// ------------------------------------------------------------------ process calls

function call(bin, args, timeout = 120_000) {
  if (!existsSync(bin)) {
    return Promise.resolve({ ok: false, text: `${bin} not found — set FIGMA_BIN/IMG_BIN or install the repo there` })
  }
  return new Promise((done) => {
    execFile(bin, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') {
        done({ ok: false, text: `${bin} is not executable` })
        return
      }
      const out = String(stdout || '').trim()
      const errOut = String(stderr || '').trim()
      const text = [out, errOut].filter(Boolean).join('\n') || '(no output)'
      done({ ok: !err, text })
    })
  })
}

// ------------------------------------------------------------------ protocol

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value })
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

async function dispatch(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion || PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      }
    case 'ping':
      return {}
    case 'tools/list':
      return {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      }
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name)
      if (!tool) throw Object.assign(new Error(`unknown tool: ${params?.name}`), { code: -32602 })
      const out = await tool.run(params.arguments || {})
      return { content: [{ type: 'text', text: out.text }], isError: !out.ok }
    }
    default:
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 })
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', async (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      process.stderr.write(`figma-bridge mcp: cannot parse line: ${line.slice(0, 200)}\n`)
      continue
    }
    if (message.id === undefined) continue // notification — no response by design
    try {
      result(message.id, await dispatch(message.method, message.params))
    } catch (error) {
      fail(message.id, error.code || -32603, error.message || String(error))
    }
  }
})
process.stdin.on('end', () => process.exit(0))
