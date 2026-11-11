// Figma Bridge — executes operations sent by the local bridge (127.0.0.1:3847).
// Every operation is a named, auditable step. No eval: nothing is generated on the fly
// except the optional `exec` (which only works if the sandbox allows it).

figma.showUI(__html__, { width: 232, height: 34, themeColors: true })

// Każde okno pluginu ma własną tożsamość, żeby serwer wiedział, do którego pliku kieruje zadanie.
const CLIENT_ID = 'c' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4)

function sendIdentity() {
  figma.ui.postMessage({
    type: 'identity',
    clientId: CLIENT_ID,
    file: figma.root.name,
    page: figma.currentPage.name,
  })
}

sendIdentity()
figma.on('currentpagechange', sendIdentity)

// -------------------------------------------------------------------- helpers

function fail(message) {
  throw new Error(message)
}

function round(n) {
  return Math.round(n * 100) / 100
}

function parseHex(hex) {
  if (typeof hex !== 'string') fail('colour must be a hex string, e.g. "#FF0044"')
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (h.length !== 6 && h.length !== 8) fail('invalid colour format: ' + hex)
  const num = (i) => parseInt(h.slice(i, i + 2), 16) / 255
  const out = { r: num(0), g: num(2), b: num(4) }
  if (h.length === 8) out.a = num(6)
  return out
}

function paint(hex) {
  const { r, g, b, a } = parseHex(hex)
  return a === undefined
    ? { type: 'SOLID', color: { r, g, b } }
    : { type: 'SOLID', color: { r, g, b }, opacity: a }
}

function hexOf(color) {
  const h = (v) => Math.round(v * 255).toString(16).padStart(2, '0')
  return '#' + h(color.r) + h(color.g) + h(color.b)
}

function paintLabel(p) {
  if (!p) return null
  if (p.type === 'SOLID') return hexOf(p.color) + (p.opacity !== undefined && p.opacity < 1 ? ' @' + round(p.opacity) : '')
  return p.type
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function toBase64(bytes) {
  let out = ''
  const len = bytes.length
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < len ? bytes[i + 1] : 0
    const b2 = i + 2 < len ? bytes[i + 2] : 0
    out += B64[b0 >> 2]
    out += B64[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < len ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < len ? B64[b2 & 63] : '='
  }
  return out
}

function bytesFromBase64(base64) {
  const binary = atob(String(base64))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function getNode(id) {
  if (!id) fail('missing nodeId')
  const n = await figma.getNodeByIdAsync(id)
  if (!n) fail('node not found: ' + id)
  return n
}

async function parentTarget(parentId) {
  if (!parentId) return null
  const p = await getNode(parentId)
  if (typeof p.appendChild !== 'function') fail(p.type + ' cannot have children')
  return p
}

async function attach(node, parentId, index) {
  if (parentId) {
    const parent = await parentTarget(parentId)
    parent.appendChild(node)
    if (typeof index === 'number' && node.parent && typeof node.parent.insertChild === 'function') {
      node.parent.insertChild(index, node)
    }
  }
  return node
}

function summary(node, depth, opts) {
  const maxChildren = (opts && opts.maxChildren) || 40
  const base = { id: node.id, name: node.name, type: node.type }
  if ('x' in node) base.x = round(node.x)
  if ('y' in node) base.y = round(node.y)
  if ('width' in node) base.width = round(node.width)
  if ('height' in node) base.height = round(node.height)
  if ('visible' in node) base.visible = node.visible
  if (node.type === 'TEXT') base.characters = String(node.characters).slice(0, 160)
  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    base.layoutMode = node.layoutMode
    base.itemSpacing = node.itemSpacing
  }
  if ('fills' in node && Array.isArray(node.fills)) base.fills = node.fills.map(paintLabel)
  if (depth > 0 && Array.isArray(node.children)) {
    base.children = node.children.slice(0, maxChildren).map((c) => summary(c, depth - 1, opts))
    if (node.children.length > maxChildren) base.childrenTruncated = node.children.length - maxChildren
  }
  return base
}

function walk(node, visit, limit) {
  let count = 0
  const stack = [node]
  while (stack.length > 0) {
    const current = stack.pop()
    if (visit(current) === false) return count
    count += 1
    if (count >= limit) return count
    if (Array.isArray(current.children)) {
      for (let i = current.children.length - 1; i >= 0; i -= 1) stack.push(current.children[i])
    }
  }
  return count
}

async function localVariables() {
  if (typeof figma.variables.getLocalVariablesAsync === 'function') {
    return await figma.variables.getLocalVariablesAsync()
  }
  return figma.variables.getLocalVariables()
}

async function localCollections() {
  if (typeof figma.variables.getLocalVariableCollectionsAsync === 'function') {
    return await figma.variables.getLocalVariableCollectionsAsync()
  }
  return figma.variables.getLocalVariableCollections()
}

async function paintStyles() {
  if (typeof figma.getLocalPaintStylesAsync === 'function') return await figma.getLocalPaintStylesAsync()
  return figma.getLocalPaintStyles()
}

async function textStyles() {
  if (typeof figma.getLocalTextStylesAsync === 'function') return await figma.getLocalTextStylesAsync()
  return figma.getLocalTextStyles()
}

async function loadFont(family, style) {
  const fontName = { family: family || 'Inter', style: style || 'Regular' }
  await figma.loadFontAsync(fontName)
  return fontName
}

// figma.currentUser requires the "currentuser" permission in the manifest — it throws without it.
// status must always work, so the degradation is silent.
function currentUserName() {
  try {
    return figma.currentUser ? figma.currentUser.name : null
  } catch (err) {
    return null
  }
}

function applyProps(node, props) {
  const skipped = []
  const set = (key, apply) => {
    if (!(key in props)) return
    if (!(key in node)) {
      skipped.push(key)
      return
    }
    apply(props[key])
  }

  set('name', (v) => { node.name = String(v) })
  set('x', (v) => { node.x = Number(v) })
  set('y', (v) => { node.y = Number(v) })
  set('width', (v) => { node.resize(Number(v), node.height) })
  set('height', (v) => { node.resize(node.width, Number(v)) })
  set('opacity', (v) => { node.opacity = Number(v) })
  set('visible', (v) => { node.visible = Boolean(v) })
  set('cornerRadius', (v) => { node.cornerRadius = Number(v) })
  set('clipsContent', (v) => { node.clipsContent = Boolean(v) })
  set('rotation', (v) => { node.rotation = Number(v) })
  set('fills', (v) => {
    node.fills = v === null ? [] : (Array.isArray(v) ? v : [v]).map((c) =>
      typeof c === 'string' ? paint(c) : c,
    )
  })
  set('strokes', (v) => {
    node.strokes = v === null ? [] : (Array.isArray(v) ? v : [v]).map((c) =>
      typeof c === 'string' ? paint(c) : c,
    )
  })
  set('strokeWeight', (v) => { node.strokeWeight = Number(v) })
  set('layoutMode', (v) => { node.layoutMode = v })
  set('primaryAxisSizingMode', (v) => { node.primaryAxisSizingMode = v })
  set('counterAxisSizingMode', (v) => { node.counterAxisSizingMode = v })
  set('itemSpacing', (v) => { node.itemSpacing = Number(v) })
  set('counterAxisSpacing', (v) => { node.counterAxisSpacing = Number(v) })
  set('paddingTop', (v) => { node.paddingTop = Number(v) })
  set('paddingRight', (v) => { node.paddingRight = Number(v) })
  set('paddingBottom', (v) => { node.paddingBottom = Number(v) })
  set('paddingLeft', (v) => { node.paddingLeft = Number(v) })
  set('primaryAxisAlignItems', (v) => { node.primaryAxisAlignItems = v })
  set('counterAxisAlignItems', (v) => { node.counterAxisAlignItems = v })
  set('layoutSizingHorizontal', (v) => { node.layoutSizingHorizontal = v })
  set('layoutSizingVertical', (v) => { node.layoutSizingVertical = v })
  set('textAlignHorizontal', (v) => { node.textAlignHorizontal = v })
  set('textAlignVertical', (v) => { node.textAlignVertical = v })
  set('textAutoResize', (v) => { node.textAutoResize = v })

  if ('characters' in props && node.type === 'TEXT') node.characters = String(props.characters)
  if ('fontSize' in props && 'fontSize' in node) node.fontSize = Number(props.fontSize)

  return skipped
}

// ---------------------------------------------------------------- operations

const OPS = {
  async ping() {
    return { pong: true, ts: Date.now(), bridge: 'figma-bridge/1' }
  },

  async status() {
    const sel = figma.currentPage.selection
    return {
      fileKey: figma.fileKey || null,
      fileName: figma.root.name,
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      pages: figma.root.children.map((p) => ({ id: p.id, name: p.name })),
      editorType: figma.editorType,
      selection: sel.map((n) => ({ id: n.id, name: n.name, type: n.type })),
      user: currentUserName(),
    }
  },

  async selection({ depth = 2, maxChildren = 40 } = {}) {
    const sel = figma.currentPage.selection
    return {
      count: sel.length,
      nodes: sel.map((n) => summary(n, depth, { maxChildren })),
    }
  },

  async node({ nodeId, depth = 2, maxChildren = 40 } = {}) {
    const n = await getNode(nodeId)
    return summary(n, depth, { maxChildren })
  },

  async find({ name, type, allPages = false, limit = 50 } = {}) {
    const needle = name ? String(name).toLowerCase() : null
    const hits = []
    const visit = (n) => {
      if (hits.length >= limit) return false
      const nameOk = needle === null || String(n.name).toLowerCase().indexOf(needle) !== -1
      const typeOk = !type || n.type === type
      if (nameOk && typeOk) hits.push({ id: n.id, name: n.name, type: n.type, page: null })
      return true
    }
    if (allPages) {
      await figma.loadAllPagesAsync()
      for (const page of figma.root.children) walk(page, visit, limit * 20)
    } else {
      walk(figma.currentPage, visit, limit * 20)
    }
    return { count: hits.length, hits }
  },

  async pages() {
    return figma.root.children.map((p) => ({ id: p.id, name: p.name, type: p.type }))
  },

  async createPage({ name } = {}) {
    const page = figma.createPage()
    if (name) page.name = String(name)
    return { id: page.id, name: page.name }
  },

  async goto({ pageId } = {}) {
    const page = await getNode(pageId)
    if (page.type !== 'PAGE') fail('node is not a page: ' + page.type)
    await figma.setCurrentPageAsync(page)
    return { page: { id: page.id, name: page.name } }
  },

  async createFrame({ name, x = 0, y = 0, width = 320, height = 200, parentId, index, fill, props } = {}) {
    const frame = figma.createFrame()
    frame.name = name || 'Frame'
    frame.resize(Number(width), Number(height))
    frame.x = Number(x)
    frame.y = Number(y)
    if (fill !== undefined) frame.fills = fill === null ? [] : [paint(fill)]
    if (props) applyProps(frame, props)
    await attach(frame, parentId, index)
    return { id: frame.id, name: frame.name, x: round(frame.x), y: round(frame.y) }
  },

  async createRect({ name, x = 0, y = 0, width = 100, height = 100, parentId, index, fill, cornerRadius, props } = {}) {
    const rect = figma.createRectangle()
    rect.name = name || 'Rectangle'
    rect.resize(Number(width), Number(height))
    rect.x = Number(x)
    rect.y = Number(y)
    if (fill !== undefined) rect.fills = fill === null ? [] : [paint(fill)]
    if (cornerRadius !== undefined) rect.cornerRadius = Number(cornerRadius)
    if (props) applyProps(rect, props)
    await attach(rect, parentId, index)
    return { id: rect.id, name: rect.name }
  },

  async createEllipse({ name, x = 0, y = 0, width = 100, height = 100, parentId, index, fill, props } = {}) {
    const el = figma.createEllipse()
    el.name = name || 'Ellipse'
    el.resize(Number(width), Number(height))
    el.x = Number(x)
    el.y = Number(y)
    if (fill !== undefined) el.fills = fill === null ? [] : [paint(fill)]
    if (props) applyProps(el, props)
    await attach(el, parentId, index)
    return { id: el.id, name: el.name }
  },

  async createText({
    name,
    characters = 'Text',
    x = 0,
    y = 0,
    fontFamily = 'Inter',
    fontStyle = 'Regular',
    fontSize = 16,
    color = '#111111',
    parentId,
    index,
    width,
    props,
  } = {}) {
    const text = figma.createText()
    const fontName = await loadFont(fontFamily, fontStyle)
    text.fontName = fontName
    text.characters = String(characters)
    text.fontSize = Number(fontSize)
    text.fills = [paint(color)]
    if (name) text.name = String(name)
    if (width !== undefined) {
      text.textAutoResize = 'HEIGHT'
      text.resize(Number(width), text.height)
    }
    text.x = Number(x)
    text.y = Number(y)
    if (props) applyProps(text, props)
    await attach(text, parentId, index)
    return { id: text.id, name: text.name, characters: text.characters }
  },

  async update({ nodeId, props = {} } = {}) {
    const n = await getNode(nodeId)
    if (n.type === 'TEXT' && ('characters' in props || 'fontSize' in props || 'fontName' in props)) {
      await figma.loadFontAsync(n.fontName)
    }
    const skipped = applyProps(n, props)
    return { id: n.id, name: n.name, applied: Object.keys(props).filter((k) => skipped.indexOf(k) === -1), skipped }
  },

  async clone({ nodeId, parentId, index, x, y } = {}) {
    const src = await getNode(nodeId)
    if (typeof src.clone !== 'function') fail('cannot clone a node of type ' + src.type)
    const copy = src.clone()
    if (x !== undefined) copy.x = Number(x)
    if (y !== undefined) copy.y = Number(y)
    await attach(copy, parentId, index)
    return { id: copy.id, name: copy.name, type: copy.type }
  },

  async reparent({ nodeId, parentId, index } = {}) {
    const n = await getNode(nodeId)
    const p = await parentTarget(parentId)
    p.appendChild(n)
    if (typeof index === 'number') p.insertChild(index, n)
    return { id: n.id, parent: p.id }
  },

  async remove({ nodeId } = {}) {
    const n = await getNode(nodeId)
    const id = n.id
    const name = n.name
    n.remove()
    return { removed: id, name }
  },

  async variables({ limit = 200, type } = {}) {
    const [vars, collections] = await Promise.all([localVariables(), localCollections()])
    const byId = new Map(collections.map((c) => [c.id, c.name]))
    const filtered = type ? vars.filter((v) => v.resolvedType === type) : vars
    return {
      collections: collections.map((c) => ({ id: c.id, name: c.name, modes: c.modes })),
      count: filtered.length,
      variables: filtered.slice(0, limit).map((v) => ({
        id: v.id,
        name: v.name,
        type: v.resolvedType,
        collection: byId.get(v.variableCollectionId) || null,
      })),
      truncated: filtered.length > limit,
    }
  },

  async varFill({ nodeId, variableName, field = 'fills', hex = '#000000' } = {}) {
    if (!variableName) fail('missing variableName')
    const vars = await localVariables()
    const exact = vars.find((v) => v.name === variableName)
    const variable = exact || vars.find((v) => v.name.endsWith('/' + variableName) || v.name.indexOf(variableName) !== -1)
    if (!variable) fail('variable "' + variableName + '" not found — run the variables op first')
    const n = await getNode(nodeId)

    if (field === 'fills' || field === 'strokes') {
      const base = field === 'fills' ? n.fills : n.strokes
      const first = Array.isArray(base) && base.length > 0 && base[0].type === 'SOLID' ? base[0] : paint(hex)
      const bound = figma.variables.setBoundVariableForPaint(
        { type: 'SOLID', color: first.color, opacity: first.opacity },
        'color',
        variable,
      )
      if (field === 'fills') n.fills = [bound]
      else n.strokes = [bound]
    } else if (field === 'textColor') {
      if (n.type !== 'TEXT') fail('textColor only works on TEXT nodes')
      const bound = figma.variables.setBoundVariableForPaint(paint(hex), 'color', variable)
      n.fills = [bound]
    } else {
      fail('field must be one of: fills | strokes | textColor')
    }
    return { id: n.id, variable: variable.name, variableId: variable.id, field }
  },

  async styles({ limit = 200 } = {}) {
    const [paints, texts] = await Promise.all([paintStyles(), textStyles()])
    return {
      paint: paints.slice(0, limit).map((s) => ({ id: s.id, name: s.name, type: s.type })),
      text: texts.slice(0, limit).map((s) => ({ id: s.id, name: s.name })),
      counts: { paint: paints.length, text: texts.length },
    }
  },

  async export({ nodeId, format = 'PNG', scale = 2 } = {}) {
    const n = await getNode(nodeId)
    const fmt = String(format).toUpperCase()
    if (['PNG', 'JPG', 'SVG', 'PDF'].indexOf(fmt) === -1) fail('format must be one of: PNG | JPG | SVG | PDF')
    const bytes = await n.exportAsync({
      format: fmt,
      constraint: { type: 'SCALE', value: Number(scale) },
    })
    if (bytes.length > 8 * 1024 * 1024) {
      fail('export is ' + bytes.length + ' bytes, over the 8 MB cap — lower scale')
    }
    return {
      nodeId: n.id,
      name: n.name,
      format: fmt,
      bytes: bytes.length,
      base64: toBase64(bytes),
    }
  },

  async imageFill({ nodeId, base64, scaleMode = 'FILL' } = {}) {
    if (!base64) fail('missing image base64')
    const n = await getNode(nodeId)
    const bytes = bytesFromBase64(base64)
    const image = figma.createImage(bytes)
    n.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode }]
    return { id: n.id, imageHash: image.hash, bytes: bytes.length }
  },

  async exec({ code } = {}) {
    if (!code) fail('missing code')
    let fn
    try {
      // eslint-disable-next-line no-new-func
      fn = new Function('figma', 'return (async () => { ' + code + ' })()')
    } catch (err) {
      fail('sandbox rejected new Function: ' + err.message)
    }
    const value = await fn(figma)
    return { value: value === undefined ? null : value }
  },
}

// ------------------------------------------------------------ dynamic-page retry

// W trybie `dynamic-page` Figma nie pozwala czytać dzieci stron, które nie zostały
// jawnie wczytane. Zamiast zmuszać agenta do pamiętania o `loadAllPagesAsync`,
// łapiemy dokładnie ten błąd, wczytujemy strony i powtarzamy operację raz.
const DYNAMIC_PAGE_ERROR = /has not been explicitly loaded|loadAllPagesAsync/i

async function withPageRetry(run) {
  try {
    return await run()
  } catch (err) {
    const message = String((err && err.message) || err)
    if (!DYNAMIC_PAGE_ERROR.test(message)) throw err
    await figma.loadAllPagesAsync()
    return await run()
  }
}

// ----------------------------------------------------------------- message loop

// --- panel obrazów ---------------------------------------------------------
async function uiSelectionInfo() {
  const selection = figma.currentPage.selection
  figma.ui.postMessage({
    type: 'selectionInfo',
    count: selection.length,
    name: selection[0] ? selection[0].name : null,
    nodeType: selection[0] ? selection[0].type : null,
  })
}

async function uiExportSelection() {
  const selection = figma.currentPage.selection
  if (selection.length === 0) {
    figma.notify('Select a frame or layer first', { error: true })
    figma.ui.postMessage({ type: 'selectionImage', error: 'nothing selected' })
    return
  }
  const node = selection[0]
  try {
    const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } })
    if (bytes.length > 12 * 1024 * 1024) throw new Error('selection is too large for a reference (12 MB cap)')
    figma.ui.postMessage({
      type: 'selectionImage',
      base64: toBase64(bytes),
      width: Math.round(node.width),
      height: Math.round(node.height),
      name: node.name,
    })
  } catch (err) {
    figma.notify('Export failed: ' + err.message, { error: true })
    figma.ui.postMessage({ type: 'selectionImage', error: err.message })
  }
}

// „Obrazek na canvasie" w Figmie to prostokąt z image-fillem — nie ramka, nie klatka.
async function uiInsertImage(msg) {
  const bytes = bytesFromBase64(msg.base64)
  const image = figma.createImage(bytes)
  const width = Number(msg.width) || 1024
  const height = Number(msg.height) || 1024
  const rect = figma.createRectangle()
  rect.resize(width, height)
  rect.name = 'img · ' + new Date().toISOString().slice(11, 19)
  rect.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }]
  const center = figma.viewport.center
  rect.x = Math.round(center.x - width / 2)
  rect.y = Math.round(center.y - height / 2)
  figma.currentPage.selection = [rect]
  figma.viewport.scrollAndZoomIntoView([rect])
  figma.notify('Image placed on the canvas')
}

async function uiFillSelection(msg) {
  const selection = figma.currentPage.selection
  if (selection.length === 0) {
    figma.notify('Select a layer to fill', { error: true })
    return
  }
  const node = selection[0]
  if (!('fills' in node)) {
    figma.notify(node.type + ' cannot hold an image fill', { error: true })
    return
  }
  const image = figma.createImage(bytesFromBase64(msg.base64))
  node.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }]
  figma.notify('Fill replaced')
}

figma.ui.onmessage = async (msg) => {
  if (!msg || typeof msg.type !== 'string') return

  if (msg.type === 'resize') {
    figma.ui.resize(Math.round(Number(msg.width) || 232), Math.round(Number(msg.height) || 34))
    return
  }
  if (msg.type === 'selectionInfo') return uiSelectionInfo()
  if (msg.type === 'exportSelection') return uiExportSelection()
  if (msg.type === 'insertImage') return uiInsertImage(msg)
  if (msg.type === 'fillSelection') return uiFillSelection(msg)

  if (msg.type !== 'run') return
  const ops = Array.isArray(msg.ops) ? msg.ops : []
  const results = []
  let ok = true
  let error

  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i] || {}
    const handler = OPS[op.op]
    try {
      if (!handler) fail('unknown op "' + String(op.op) + '" — available: ' + Object.keys(OPS).join(', '))
      const value = await withPageRetry(() => handler(op))
      results.push({ index: i, op: op.op, ok: true, value })
    } catch (err) {
      ok = false
      error = 'op #' + i + ' (' + String(op.op) + '): ' + (err && err.message ? err.message : String(err))
      results.push({ index: i, op: op.op, ok: false, error: err && err.message ? err.message : String(err) })
      break
    }
  }

  figma.ui.postMessage({ type: 'result', id: msg.id, ok, results, error })
  // Pełny błąd i tak wraca do agenta; w Figmie pokazujemy skrót, żeby toast nie zasłaniał płótna.
  if (!ok) figma.notify('Figma Bridge: ' + String(error).slice(0, 120), { error: true })
}

figma.notify('Figma Bridge ready')
