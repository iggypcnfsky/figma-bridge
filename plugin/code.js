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
// Panel trzyma „Use selection” wyłączone, dopóki nie wie o zaznaczeniu — a wiedziało tylko
// w momencie rozwinięcia. Teraz każde kliknięcie na płótnie odświeża ten przycisk.
figma.on('selectionchange', () => {
  uiSelectionInfo().catch(() => {})
})

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

function rgba(hex) {
  const { r, g, b, a } = parseHex(hex)
  return { r, g, b, a: a === undefined ? 1 : a }
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

/** Tekst bywa mieszany (figma.mixed) — zamiast wywalać się, zwracamy "MIXED". */
function textInfo(node) {
  const font = node.fontName === figma.mixed ? 'MIXED' : node.fontName
  const lineHeight = node.lineHeight === figma.mixed ? 'MIXED' : node.lineHeight
  const letterSpacing = node.letterSpacing === figma.mixed ? 'MIXED' : node.letterSpacing
  const fontSize = node.fontSize === figma.mixed ? 'MIXED' : node.fontSize
  return {
    font: font === 'MIXED' ? 'MIXED' : { family: font.family, style: font.style },
    fontFamily: font === 'MIXED' ? 'MIXED' : font.family,
    fontSize,
    lineHeight: lineHeight === 'MIXED' ? 'MIXED' : { value: lineHeight.value, unit: lineHeight.unit },
    letterSpacing: letterSpacing === 'MIXED' ? 'MIXED' : { value: letterSpacing.value, unit: letterSpacing.unit },
    textAlignHorizontal: node.textAlignHorizontal,
    textAlignVertical: node.textAlignVertical,
    textAutoResize: node.textAutoResize,
  }
}

function summary(node, depth, opts) {
  const maxChildren = (opts && opts.maxChildren) || 40
  const base = { id: node.id, name: node.name, type: node.type }
  if ('x' in node) base.x = round(node.x)
  if ('y' in node) base.y = round(node.y)
  if ('width' in node) base.width = round(node.width)
  if ('height' in node) base.height = round(node.height)
  if ('visible' in node) base.visible = node.visible
  if (node.type === 'TEXT') {
    base.characters = String(node.characters).slice(0, 160)
    Object.assign(base, textInfo(node))
  }
  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    base.layoutMode = node.layoutMode
    base.itemSpacing = node.itemSpacing
  }
  if ('constraints' in node) base.constraints = node.constraints
  if ('layoutSizingHorizontal' in node) {
    base.layoutSizing = { horizontal: node.layoutSizingHorizontal, vertical: node.layoutSizingVertical }
  }
  if ('layoutPositioning' in node && node.layoutPositioning !== 'AUTO') base.layoutPositioning = node.layoutPositioning
  if ('layoutAlign' in node && node.layoutAlign !== 'INHERIT') base.layoutAlign = node.layoutAlign
  for (const key of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight']) {
    if (key in node && node[key] !== null && node[key] !== undefined) base[key] = node[key]
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

// ------------------------------------------------------------------ styles

async function styleList(kind) {
  if (kind === 'text') return await textStyles()
  if (kind === 'paint') return await paintStyles()
  if (kind === 'effect') {
    if (typeof figma.getLocalEffectStylesAsync === 'function') return await figma.getLocalEffectStylesAsync()
    return figma.getLocalEffectStyles()
  }
  if (kind === 'grid') {
    if (typeof figma.getLocalGridStylesAsync === 'function') return await figma.getLocalGridStylesAsync()
    return figma.getLocalGridStyles()
  }
  fail('unknown style kind: ' + kind + ' (text | paint | effect | grid)')
}

/** Dokładna nazwa, potem sufiks po `/` — tak samo jak w `applyStyle`. */
async function styleByName(kind, name) {
  if (!name) fail('missing style name')
  const list = await styleList(kind)
  const needle = String(name)
  const found =
    list.find((style) => style.name === needle) ||
    list.find((style) => style.name.endsWith('/' + needle))
  if (!found) fail(kind + ' style not found: ' + needle + ' — `styles` lists what exists')
  return found
}

// `documentAccess: "dynamic-page"` blokuje synchroniczne settery stylów:
// `node.textStyleId = id` rzuca "Cannot call with documentAccess: dynamic-page".
// Zawsze idziemy więc przez wariant Async, z fallbackiem dla starszych API.
async function applyStyleId(node, kind, style) {
  const setters = {
    text: ['setTextStyleIdAsync', 'textStyleId'],
    paint: ['setFillStyleIdAsync', 'fillStyleId'],
    stroke: ['setStrokeStyleIdAsync', 'strokeStyleId'],
    effect: ['setEffectStyleIdAsync', 'effectStyleId'],
    grid: ['setGridStyleIdAsync', 'gridStyleId'],
  }
  const entry = setters[kind]
  if (!entry) fail('unknown style kind: ' + kind)
  const [asyncName, prop] = entry
  if (!(prop in node)) fail(node.type + ' cannot take a ' + kind + ' style')
  if (typeof node[asyncName] === 'function') await node[asyncName](style.id)
  else node[prop] = style.id
  return { id: style.id, name: style.name, kind }
}

// ------------------------------------------------------------------ typografia

function fontKey(font) {
  return font.family + ' / ' + font.style
}

/** Fragment tekstu można zmienić tylko po wczytaniu fontów, które w nim są. */
async function loadFontsInRange(node, start, end) {
  const fonts = new Map()
  const add = (font) => {
    if (font && font !== figma.mixed) fonts.set(fontKey(font), font)
  }
  if (typeof node.getRangeAllFontNames === 'function') {
    try {
      node.getRangeAllFontNames(start, end).forEach(add)
    } catch (err) {
      /* puste albo niejednolite zakresy potrafią rzucić — schodzimy do pętli */
    }
  }
  if (fonts.size === 0) {
    const cap = Math.min(end, start + 500)
    for (let i = start; i < cap; i += 1) add(node.getRangeFontName(i, i + 1))
  }
  add(node.fontName)
  await Promise.all([...fonts.values()].map((font) => figma.loadFontAsync(font)))
  return [...fonts.values()]
}

function lineHeightSpec(value) {
  if (value === null || value === undefined || value === 'AUTO') return { unit: 'AUTO' }
  if (typeof value === 'number') return { unit: 'PIXELS', value }
  const text = String(value).trim()
  if (text.endsWith('%')) return { unit: 'PERCENT', value: Number(text.slice(0, -1)) }
  if (text.toUpperCase() === 'AUTO') return { unit: 'AUTO' }
  const num = Number(text)
  if (Number.isNaN(num)) fail('lineHeight must be a number (px), "AUTO", or "120%": ' + value)
  return { unit: 'PIXELS', value: num }
}

function letterSpacingSpec(value) {
  if (typeof value === 'number') return { unit: 'PIXELS', value }
  const text = String(value).trim()
  if (text.endsWith('%')) return { unit: 'PERCENT', value: Number(text.slice(0, -1)) }
  const num = Number(text)
  if (Number.isNaN(num)) fail('letterSpacing must be a number (px) or "5%": ' + value)
  return { unit: 'PIXELS', value: num }
}

/**
 * Zmienia wygląd istniejącego tekstu: font (rodzina + odmiana), rozmiar, interlinia,
 * spacje, kolor, wyrównanie i styl nazwany — na całym węźle albo na zakresie znaków.
 */
async function applyText(node, spec = {}) {
  if (!node || node.type !== 'TEXT') fail('node ' + (node && node.id) + ' is not TEXT')
  const {
    characters,
    fontFamily,
    fontStyle,
    fontSize,
    lineHeight,
    letterSpacing,
    color,
    textStyle,
    textAlignHorizontal,
    textAlignVertical,
    textAutoResize,
    range,
  } = spec

  const whole = !range
  const length = String(node.characters).length
  const start = whole ? 0 : Math.max(0, Math.min(length, Number(range.start === undefined ? 0 : range.start)))
  const end = whole ? length : Math.max(start, Math.min(length, Number(range.end === undefined ? length : range.end)))
  const partial = !whole && (start > 0 || end < length)
  if (!whole && end <= start) fail('empty range ' + start + '–' + end)

  const changed = []

  if (textStyle) {
    if (!whole) fail('a text style applies to the whole node — drop `range`')
    const style = await styleByName('text', textStyle)
    await applyStyleId(node, 'text', style)
    changed.push('textStyle')
  }

  if (characters !== undefined) {
    if (!whole) fail('`characters` replaces the whole content — drop `range`')
    node.characters = String(characters)
    changed.push('characters')
  }

  const needsFonts = partial && (
    fontFamily !== undefined || fontStyle !== undefined ||
    fontSize !== undefined || lineHeight !== undefined || letterSpacing !== undefined || color !== undefined
  )
  if (needsFonts) await loadFontsInRange(node, start, end)

  if (fontFamily !== undefined || fontStyle !== undefined) {
    let base = node.fontName === figma.mixed ? null : node.fontName
    // mixed node + range: the range itself knows which family it uses
    if (!base && !whole) {
      const first = node.getRangeFontName(start, Math.min(start + 1, end))
      if (first && first !== figma.mixed) base = first
    }
    if (!base) fail('font is mixed here — pass fontFamily (and fontStyle) or a `range`')
    const family = fontFamily !== undefined ? fontFamily : base.family
    const styleName = fontStyle !== undefined ? fontStyle : base.style
    const font = await loadFont(family, styleName)
    if (whole) node.fontName = font
    else node.setRangeFontName(start, end, font)
    changed.push('font')
  }

  if (fontSize !== undefined) {
    if (whole) node.fontSize = Number(fontSize)
    else node.setRangeFontSize(start, end, Number(fontSize))
    changed.push('fontSize')
  }

  if (lineHeight !== undefined) {
    const value = lineHeightSpec(lineHeight)
    if (whole) node.lineHeight = value
    else node.setRangeLineHeight(start, end, value)
    changed.push('lineHeight')
  }

  if (letterSpacing !== undefined) {
    const value = letterSpacingSpec(letterSpacing)
    if (whole) node.letterSpacing = value
    else node.setRangeLetterSpacing(start, end, value)
    changed.push('letterSpacing')
  }

  if (color !== undefined) {
    if (whole) node.fills = color === null ? [] : [paint(color)]
    else node.setRangeFills(start, end, color === null ? [] : [paint(color)])
    changed.push('color')
  }

  if (textAlignHorizontal !== undefined) {
    node.textAlignHorizontal = textAlignHorizontal
    changed.push('textAlignHorizontal')
  }
  if (textAlignVertical !== undefined) {
    node.textAlignVertical = textAlignVertical
    changed.push('textAlignVertical')
  }
  if (textAutoResize !== undefined) {
    node.textAutoResize = textAutoResize
    changed.push('textAutoResize')
  }

  if (changed.length === 0) fail('nothing to change — pass fontFamily, fontStyle, fontSize, lineHeight, letterSpacing, color, textStyle, characters, align or autoResize')

  return {
    id: node.id,
    name: node.name,
    changed,
    range: whole ? 'whole' : { start, end },
    text: textInfo(node),
  }
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

  /**
   * Czyta układ rodzica „po ludzku": grupuje dzieci w rzędy, sortuje w czytaniu i mierzy odstępy.
   * Służy do zachowania istniejących grupień, nie do ich przerabiania.
   */
  async structure({ nodeId, tolerance = 24 } = {}) {
    const node = await getNode(nodeId)
    const kids = (node.children || [])
      .filter((child) => 'x' in child && 'y' in child)
      .map((child) => ({
        id: child.id,
        name: child.name,
        type: child.type,
        x: round(child.x),
        y: round(child.y),
        width: round(child.width),
        height: round(child.height),
        centerY: child.y + child.height / 2,
      }))
    if (kids.length === 0) return { id: node.id, name: node.name, rows: [] }

    const rows = []
    for (const kid of [...kids].sort((a, b) => a.centerY - b.centerY)) {
      const row = rows.find((candidate) => Math.abs(candidate.centerY - kid.centerY) <= Math.max(Number(tolerance), kid.height / 2))
      if (row) {
        row.items.push(kid)
        row.centerY = row.items.reduce((sum, item) => sum + item.centerY, 0) / row.items.length
      } else {
        rows.push({ centerY: kid.centerY, items: [kid] })
      }
    }

    const described = rows.map((row) => {
      const items = row.items.sort((a, b) => a.x - b.x)
      const gaps = items.slice(1).map((item, index) => round(item.x - (items[index].x + items[index].width)))
      return {
        y: round(Math.min(...items.map((item) => item.y))),
        height: round(Math.max(...items.map((item) => item.y + item.height)) - Math.min(...items.map((item) => item.y))),
        count: items.length,
        gaps,
        items: items.map((item) => ({ id: item.id, name: item.name, type: item.type, x: item.x, y: item.y, width: item.width, height: item.height })),
      }
    })

    return { id: node.id, name: node.name, rows: described, readingOrder: described.flatMap((row) => row.items.map((item) => item.id)) }
  },

  /** Przegląd klatek na stronie: geometria + statystyka typografii. Jedno wywołanie zamiast chodzenia po drzewie. */
  async inventory({ nodeId, limit = 200 } = {}) {
    const root = nodeId ? await getNode(nodeId) : figma.currentPage
    const children = (root.children || []).slice(0, Number(limit))
    const frames = []
    for (const frame of children) {
      if (!['FRAME', 'COMPONENT', 'COMPONENT_SET', 'SECTION'].includes(frame.type)) continue
      const texts = []
      walk(frame, (node) => {
        if (node.type === 'TEXT') texts.push(node)
        return true
      }, 20000)
      const sizes = texts.map((text) => text.fontSize).filter((size) => typeof size === 'number')
      const families = new Set()
      for (const text of texts) {
        if (text.fontName && text.fontName !== figma.mixed) families.add(text.fontName.family)
      }
      frames.push({
        id: frame.id,
        name: frame.name,
        type: frame.type,
        x: round(frame.x),
        y: round(frame.y),
        width: round(frame.width),
        height: round(frame.height),
        children: (frame.children || []).length,
        textNodes: texts.length,
        fonts: [...families],
        minFontSize: sizes.length ? Math.min(...sizes) : null,
        maxFontSize: sizes.length ? Math.max(...sizes) : null,
        layoutGrids: 'layoutGrids' in frame ? frame.layoutGrids.length : null,
        fills: 'fills' in frame && Array.isArray(frame.fills) ? frame.fills.map(paintLabel).slice(0, 2) : null,
      })
    }
    return { page: root.type === 'PAGE' ? root.name : null, count: frames.length, frames }
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
    const rest = Object.assign({}, props)
    const applied = []

    // Style properties are set by name, through the async setters (dynamic-page safe).
    const styleKinds = { textStyle: 'text', fillStyle: 'paint', strokeStyle: 'stroke', effectStyle: 'effect', gridStyle: 'grid' }
    for (const [key, kind] of Object.entries(styleKinds)) {
      if (!(key in rest)) continue
      const name = rest[key]
      delete rest[key]
      await applyStyleId(n, kind, await styleByName(kind, name))
      applied.push(key)
    }

    // Typography on an existing text node — the same code path as the `text` op.
    if (n.type === 'TEXT') {
      const spec = {}
      if ('characters' in rest) { spec.characters = rest.characters; delete rest.characters }
      const fontName = rest.fontName
      if (fontName && typeof fontName === 'object') {
        spec.fontFamily = fontName.family
        spec.fontStyle = fontName.style
        delete rest.fontName
      }
      if ('fontFamily' in rest) { spec.fontFamily = rest.fontFamily; delete rest.fontFamily }
      if ('fontStyle' in rest) { spec.fontStyle = rest.fontStyle; delete rest.fontStyle }
      if ('fontSize' in rest) { spec.fontSize = rest.fontSize; delete rest.fontSize }
      if ('lineHeight' in rest) { spec.lineHeight = rest.lineHeight; delete rest.lineHeight }
      if ('letterSpacing' in rest) { spec.letterSpacing = rest.letterSpacing; delete rest.letterSpacing }
      if ('range' in rest) { spec.range = rest.range; delete rest.range }
      if (Object.keys(spec).length > 0) {
        await applyText(n, spec)
        applied.push(...Object.keys(spec))
      }
    }

    const skipped = applyProps(n, rest)
    return {
      id: n.id,
      name: n.name,
      applied: applied.concat(Object.keys(rest).filter((k) => skipped.indexOf(k) === -1)),
      skipped,
    }
  },

  /** Zmiana wyglądu istniejącego tekstu: font, rozmiar, interlinia, styl nazwany, zakres znaków. */
  async text({
    nodeId,
    characters,
    fontFamily,
    fontStyle,
    fontSize,
    lineHeight,
    letterSpacing,
    color,
    textStyle,
    textAlignHorizontal,
    textAlignVertical,
    textAutoResize,
    range,
  } = {}) {
    const node = await getNode(nodeId)
    return await applyText(node, {
      characters,
      fontFamily,
      fontStyle,
      fontSize,
      lineHeight,
      letterSpacing,
      color,
      textStyle,
      textAlignHorizontal,
      textAlignVertical,
      textAutoResize,
      range,
    })
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

  async fonts({ allPages = false, limit = 20000 } = {}) {
    const families = new Map()
    let scanned = 0
    let truncated = false
    const visit = (node) => {
      scanned += 1
      if (scanned > limit) {
        truncated = true
        return false
      }
      if (node.type !== 'TEXT') return true
      const font = node.fontName === figma.mixed ? { family: 'MIXED', style: 'MIXED' } : node.fontName
      const key = font.family + ' / ' + font.style
      const entry = families.get(key) || { family: font.family, style: font.style, count: 0, sizes: new Set(), sampleIds: [] }
      entry.count += 1
      if (node.fontSize !== figma.mixed) entry.sizes.add(node.fontSize)
      if (entry.sampleIds.length < 3) entry.sampleIds.push(node.id)
      families.set(key, entry)
      return true
    }

    if (allPages) {
      await figma.loadAllPagesAsync()
      for (const page of figma.root.children) walk(page, visit, limit)
    } else {
      walk(figma.currentPage, visit, limit)
    }

    const list = [...families.values()]
      .map((entry) => ({
        family: entry.family,
        style: entry.style,
        count: entry.count,
        sizes: [...entry.sizes].sort((a, b) => a - b),
        sampleIds: entry.sampleIds,
      }))
      .sort((a, b) => b.count - a.count)

    return { families: list, textNodes: list.reduce((sum, entry) => sum + entry.count, 0), scanned, truncated }
  },

  async styles({ limit = 200 } = {}) {
    const [paints, texts] = await Promise.all([paintStyles(), textStyles()])
    return {
      paint: paints.slice(0, limit).map((s) => ({ id: s.id, name: s.name, type: s.type })),
      text: texts.slice(0, limit).map((s) => ({ id: s.id, name: s.name })),
      counts: { paint: paints.length, text: texts.length },
    }
  },

  async grids({ nodeId } = {}) {
    const node = await getNode(nodeId)
    if (!('layoutGrids' in node)) fail(node.type + ' has no layout grids')
    return { id: node.id, layoutGrids: node.layoutGrids }
  },

  async setGrids({ nodeId, columns, rows, grid, gridOpacity, visible = true, clear = false } = {}) {
    const node = await getNode(nodeId)
    if (!('layoutGrids' in node)) fail(node.type + ' has no layout grids')
    if (clear || (!columns && !rows && !grid)) {
      node.layoutGrids = []
      return { id: node.id, layoutGrids: [] }
    }
    const next = []
    if (columns) {
      next.push({
        pattern: 'COLUMNS',
        visible: visible !== false,
        color: rgba(columns.color || '#FF000014'),
        alignment: columns.alignment || 'STRETCH',
        count: Number(columns.count === undefined ? 12 : columns.count),
        gutterSize: Number(columns.gutter === undefined ? 24 : columns.gutter),
        offset: Number(columns.margin === undefined ? 0 : columns.margin),
        sectionSize: Number(columns.sectionSize === undefined ? 0 : columns.sectionSize),
      })
    }
    if (rows) {
      next.push({
        pattern: 'ROWS',
        visible: visible !== false,
        color: rgba(rows.color || '#FF000014'),
        alignment: rows.alignment || 'STRETCH',
        count: Number(rows.count === undefined ? 3 : rows.count),
        gutterSize: Number(rows.gutter === undefined ? 24 : rows.gutter),
        offset: Number(rows.margin === undefined ? 0 : rows.margin),
        sectionSize: Number(rows.sectionSize === undefined ? 0 : rows.sectionSize),
      })
    }
    if (grid) {
      // „grid" = siatka kwadratowa (GRID). Liczba => rozmiar oczka, obiekt => {size, opacity, color}.
      const spec = typeof grid === 'number' ? { size: grid } : grid === true ? {} : grid
      const opacity = Number(spec.opacity === undefined ? (gridOpacity === undefined ? 0.4 : gridOpacity) : spec.opacity)
      const shade = spec.color || '#000000'
      const withAlpha = rgba(shade)
      withAlpha.a = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 0.4
      next.push({
        pattern: 'GRID',
        visible: visible !== false,
        color: withAlpha,
        sectionSize: Number(spec.size === undefined ? 40 : spec.size),
      })
    }
    node.layoutGrids = next
    return { id: node.id, layoutGrids: node.layoutGrids }
  },

  /** Wyrównuje grupę węzłów do wspólnej krawędzi lub osi. */
  async align({ nodeIds, mode = 'LEFT' } = {}) {
    if (!Array.isArray(nodeIds) || nodeIds.length === 0) fail('nodeIds must be a non-empty array')
    const nodes = await Promise.all(nodeIds.map((id) => getNode(id)))
    const left = Math.min(...nodes.map((n) => n.x))
    const right = Math.max(...nodes.map((n) => n.x + n.width))
    const top = Math.min(...nodes.map((n) => n.y))
    const bottom = Math.max(...nodes.map((n) => n.y + n.height))
    for (const node of nodes) {
      if (mode === 'LEFT') node.x = left
      else if (mode === 'RIGHT') node.x = right - node.width
      else if (mode === 'HCENTER') node.x = left + (right - left - node.width) / 2
      else if (mode === 'TOP') node.y = top
      else if (mode === 'BOTTOM') node.y = bottom - node.height
      else if (mode === 'VCENTER') node.y = top + (bottom - top - node.height) / 2
      else fail('mode must be LEFT | RIGHT | HCENTER | TOP | BOTTOM | VCENTER')
    }
    return { aligned: nodes.map((n) => ({ id: n.id, x: round(n.x), y: round(n.y) })) }
  },

  /** Rozstawia węzły po osi: równe odstępy między skrajnymi albo stały `gap`. */
  async distribute({ nodeIds, axis = 'HORIZONTAL', gap } = {}) {
    if (!Array.isArray(nodeIds) || nodeIds.length < 2) fail('nodeIds needs at least two ids')
    const nodes = await Promise.all(nodeIds.map((id) => getNode(id)))
    const horizontal = axis !== 'VERTICAL'
    nodes.sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y))
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    const sizes = nodes.reduce((sum, n) => sum + (horizontal ? n.width : n.height), 0)
    const span = horizontal ? last.x + last.width - first.x : last.y + last.height - first.y
    const spacing = gap === undefined ? (span - sizes) / (nodes.length - 1) : Number(gap)
    let cursor = horizontal ? first.x + first.width : first.y + first.height
    for (const node of nodes.slice(1)) {
      cursor += spacing
      if (horizontal) node.x = round(cursor)
      else node.y = round(cursor)
      cursor += horizontal ? node.width : node.height
    }
    return { spacing: round(spacing), ordered: nodes.map((n) => n.id) }
  },

  async effects({ nodeId, effects, shadow, blur, clear = false } = {}) {
    const node = await getNode(nodeId)
    if (!('effects' in node)) fail(node.type + ' has no effects')
    if (clear) {
      node.effects = []
      return { id: node.id, effects: [] }
    }
    let next = effects
    if (!next && blur) {
      const type = String(blur.type || 'LAYER').toUpperCase() === 'BACKGROUND' ? 'BACKGROUND_BLUR' : 'LAYER_BLUR'
      next = [{ type, radius: Number(blur.radius === undefined ? 12 : blur.radius), visible: true }]
    }
    if (!next && shadow) {
      next = [
        {
          type: 'DROP_SHADOW',
          color: rgba(shadow.color || '#00000040'),
          offset: { x: Number(shadow.x === undefined ? 0 : shadow.x), y: Number(shadow.y === undefined ? 4 : shadow.y) },
          radius: Number(shadow.blur === undefined ? 12 : shadow.blur),
          spread: Number(shadow.spread === undefined ? 0 : shadow.spread),
          visible: true,
          blendMode: 'NORMAL',
        },
      ]
    }
    if (!Array.isArray(next)) fail('pass effects[] or shadow{} or blur{}')
    node.effects = next
    return { id: node.id, effects: node.effects }
  },

  async constraints({ nodeId, horizontal, vertical } = {}) {
    const node = await getNode(nodeId)
    if (!('constraints' in node)) fail(node.type + ' has no constraints')
    const allowed = ['MIN', 'CENTER', 'MAX', 'STRETCH', 'SCALE']
    if (!horizontal && !vertical) return { id: node.id, constraints: node.constraints }
    const next = { ...node.constraints }
    for (const [axis, value] of [['horizontal', horizontal], ['vertical', vertical]]) {
      if (!value) continue
      const normalized = String(value).toUpperCase()
      if (!allowed.includes(normalized)) fail(`${axis} must be one of ${allowed.join(' | ')}`)
      next[axis] = normalized
    }
    node.constraints = next
    return { id: node.id, constraints: node.constraints }
  },

  /** layoutSizing (HUG/FILL/FIXED), min/max, layoutAlign, layoutGrow, absolute positioning. */
  async sizing({
    nodeId,
    horizontal,
    vertical,
    minWidth,
    maxWidth,
    minHeight,
    maxHeight,
    grow,
    align,
    absolute,
  } = {}) {
    const node = await getNode(nodeId)
    const applied = []
    const skipped = []
    const attempt = (field, action) => {
      try {
        action()
        applied.push(field)
      } catch (err) {
        skipped.push({ field, reason: err.message })
      }
    }
    const sizing = (value) => {
      const normalized = String(value).toUpperCase()
      if (!['HUG', 'FILL', 'FIXED'].includes(normalized)) fail('layoutSizing must be HUG | FILL | FIXED')
      return normalized
    }

    if (horizontal) attempt('layoutSizingHorizontal', () => { node.layoutSizingHorizontal = sizing(horizontal) })
    if (vertical) attempt('layoutSizingVertical', () => { node.layoutSizingVertical = sizing(vertical) })
    if (grow !== undefined) attempt('layoutGrow', () => { node.layoutGrow = Number(grow) ? 1 : 0 })
    if (align) attempt('layoutAlign', () => { node.layoutAlign = String(align).toUpperCase() })
    if (absolute !== undefined) attempt('layoutPositioning', () => { node.layoutPositioning = absolute ? 'ABSOLUTE' : 'AUTO' })
    for (const [field, value] of [['minWidth', minWidth], ['maxWidth', maxWidth], ['minHeight', minHeight], ['maxHeight', maxHeight]]) {
      if (value === undefined) continue
      attempt(field, () => { node[field] = value === null ? null : Number(value) })
    }

    return {
      id: node.id,
      applied,
      skipped,
      read: {
        layoutSizing: 'layoutSizingHorizontal' in node ? { horizontal: node.layoutSizingHorizontal, vertical: node.layoutSizingVertical } : null,
        layoutAlign: 'layoutAlign' in node ? node.layoutAlign : null,
        layoutGrow: 'layoutGrow' in node ? node.layoutGrow : null,
        layoutPositioning: 'layoutPositioning' in node ? node.layoutPositioning : null,
      },
    }
  },

  async gradient({ nodeId, kind = 'linear', angle = 90, stops, opacity = 1, visible = true } = {}) {
    const node = await getNode(nodeId)
    if (!('fills' in node)) fail(node.type + ' has no fills')
    const types = {
      linear: 'GRADIENT_LINEAR',
      radial: 'GRADIENT_RADIAL',
      angular: 'GRADIENT_ANGULAR',
      diamond: 'GRADIENT_DIAMOND',
    }
    const type = types[String(kind).toLowerCase()]
    if (!type) fail('kind must be linear | radial | angular | diamond')

    const list = Array.isArray(stops) && stops.length >= 2 ? stops : [[0, '#FFFFFF'], [1, '#000000']]
    const parsed = list.map((entry) => {
      const [position, hex] = Array.isArray(entry) ? entry : [entry.position, entry.color]
      return { position: Number(position), color: rgba(hex) }
    })
    if (parsed.some((stop) => Number.isNaN(stop.position))) fail('stop positions must be numbers 0..1')

    // Obrót wokół środka: kolejność wierszy i znak kąta to konwencja Figmy (0° = od lewej do prawej).
    const rad = (Number(angle) * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const gradientTransform = [
      [cos, sin, 0.5 - 0.5 * cos - 0.5 * sin],
      [-sin, cos, 0.5 + 0.5 * sin - 0.5 * cos],
    ]

    node.fills = [
      {
        type,
        gradientTransform,
        gradientStops: parsed,
        opacity: Number(opacity),
        visible: visible !== false,
      },
    ]
    return { id: node.id, type, angle: Number(angle), stops: parsed.length }
  },

  async createInstance({ componentId, parentId, x, y } = {}) {
    const component = await getNode(componentId)
    if (component.type !== 'COMPONENT') fail('node is not a COMPONENT: ' + component.type)
    const instance = component.createInstance()
    if (x !== undefined) instance.x = Number(x)
    if (y !== undefined) instance.y = Number(y)
    await attach(instance, parentId)
    return { id: instance.id, name: instance.name, type: instance.type }
  },

  /** Odległości między dwoma węzłami (współrzędne absolutne, więc działa w różnych rodzicach). */
  async measure({ a, b } = {}) {
    if (!a || !b) fail('pass a and b node ids')
    const first = await getNode(a)
    const second = await getNode(b)
    const boxA = first.absoluteBoundingBox
    const boxB = second.absoluteBoundingBox
    if (!boxA || !boxB) fail('nodes need absolute bounds (an instance child may not have them)')
    const gap = {
      right: boxB.x - (boxA.x + boxA.width),
      left: boxA.x - (boxB.x + boxB.width),
      below: boxB.y - (boxA.y + boxA.height),
      above: boxA.y - (boxB.y + boxB.height),
    }
    return {
      a: { id: first.id, x: round(boxA.x), y: round(boxA.y), width: round(boxA.width), height: round(boxA.height) },
      b: { id: second.id, x: round(boxB.x), y: round(boxB.y), width: round(boxB.width), height: round(boxB.height) },
      gap: { right: round(gap.right), left: round(gap.left), below: round(gap.below), above: round(gap.above) },
      horizontal: Math.abs(boxB.x - boxA.x),
      vertical: Math.abs(boxB.y - boxA.y),
      centerDistance: round(Math.hypot(boxA.x + boxA.width / 2 - (boxB.x + boxB.width / 2), boxA.y + boxA.height / 2 - (boxB.y + boxB.height / 2))),
    }
  },

  /**
   * Proponuje (i opcjonalnie zajmuje) wolne miejsce obok węzła: sprawdza rodzeństwo i wybiera
   * pierwszą stronę bez kolizji. Dzięki temu „nowa wersja obok oryginału" nie jest zgadywaniem.
   */
  async placeNear({ nodeId, width, height, gap = 80, prefer, move = false, name } = {}) {
    const node = await getNode(nodeId)
    const parent = node.parent
    const targetWidth = Number(width || node.width)
    const targetHeight = Number(height || node.height)
    const siblings = parent && 'children' in parent ? parent.children.filter((child) => child.id !== node.id) : []
    const boxes = siblings
      .map((child) => {
        const box = child.absoluteBoundingBox
        return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null
      })
      .filter(Boolean)
    const anchor = node.absoluteBoundingBox || { x: node.x, y: node.y, width: node.width, height: node.height }
    const space = Number(gap)
    const sides = prefer || ['below', 'right', 'above', 'left']
    const candidate = (side) => {
      if (side === 'below') return { x: anchor.x, y: anchor.y + anchor.height + space, side }
      if (side === 'above') return { x: anchor.x, y: anchor.y - targetHeight - space, side }
      if (side === 'right') return { x: anchor.x + anchor.width + space, y: anchor.y, side }
      return { x: anchor.x - targetWidth - space, y: anchor.y, side }
    }
    const collides = (rect) =>
      boxes.some((box) => !(rect.x + targetWidth <= box.x || rect.x >= box.x + box.width || rect.y + targetHeight <= box.y || rect.y >= box.y + box.height))

    for (const side of sides) {
      const spot = candidate(side)
      if (collides(spot)) continue
      if (move) {
        node.x = spot.x
        node.y = spot.y
        if (name) node.name = String(name)
      }
      return { ...spot, width: targetWidth, height: targetHeight, free: true, moved: Boolean(move) }
    }
    const fallback = candidate(sides[0])
    if (move) {
      node.x = fallback.x
      node.y = fallback.y
      if (name) node.name = String(name)
    }
    return {
      ...fallback,
      width: targetWidth,
      height: targetHeight,
      free: false,
      moved: Boolean(move),
      note: 'no side was free — placed anyway, check the result or ask the user where it should go',
    }
  },

  /** Tworzy lub aktualizuje styl lokalny (text, paint, effect, grid) i zwraca jego id. */
  async saveStyle({ kind = 'paint', name, font, fontSize, lineHeight, letterSpacing, color, paints, effects, layoutGrids } = {}) {
    if (!name) fail('missing style name')
    const kinds = { text: textStyles, paint: paintStyles }
    const existing = await (kinds[kind] || (() => Promise.resolve([])))()
    const found = existing.find((style) => style.name === String(name))

    if (kind === 'text') {
      const style = found || figma.createTextStyle()
      style.name = String(name)
      if (font) {
        await figma.loadFontAsync(font)
        style.fontName = font
      }
      if (fontSize !== undefined) style.fontSize = Number(fontSize)
      if (lineHeight !== undefined) style.lineHeight = typeof lineHeight === 'number' ? { unit: 'PIXELS', value: lineHeight } : lineHeight
      if (letterSpacing !== undefined) style.letterSpacing = typeof letterSpacing === 'number' ? { unit: 'PIXELS', value: letterSpacing } : letterSpacing
      return { id: style.id, name: style.name, kind, created: !found }
    }

    if (kind === 'paint') {
      const style = found || figma.createPaintStyle()
      style.name = String(name)
      if (color) {
        const solid = parseHex(color)
        style.paints = [{ type: 'SOLID', color: { r: solid.r, g: solid.g, b: solid.b }, opacity: solid.a === undefined ? 1 : solid.a }]
      }
      else if (Array.isArray(paints)) style.paints = paints
      else fail('paint style needs color or paints[]')
      return { id: style.id, name: style.name, kind, created: !found }
    }

    if (kind === 'effect') {
      if (!Array.isArray(effects)) fail('effect style needs effects[]')
      const all = await (typeof figma.getLocalEffectStylesAsync === 'function' ? figma.getLocalEffectStylesAsync() : figma.getLocalEffectStyles())
      const match = all.find((style) => style.name === String(name))
      const style = match || figma.createEffectStyle()
      style.name = String(name)
      style.effects = effects
      return { id: style.id, name: style.name, kind, created: !match }
    }

    if (kind === 'grid') {
      if (!Array.isArray(layoutGrids)) fail('grid style needs layoutGrids[]')
      const all = await (typeof figma.getLocalGridStylesAsync === 'function' ? figma.getLocalGridStylesAsync() : figma.getLocalGridStyles())
      const match = all.find((style) => style.name === String(name))
      const style = match || figma.createGridStyle()
      style.name = String(name)
      style.layoutGrids = layoutGrids
      return { id: style.id, name: style.name, kind, created: !match }
    }

    fail('kind must be text | paint | effect | grid')
  },

  /** Tekst wewnątrz instancji: lista pól tekstowych i nadpisywanie ich treści (override). */
  async instanceText({ instanceId, overrides, list = false } = {}) {
    const instance = await getNode(instanceId)
    if (instance.type !== 'INSTANCE') fail('node is not an INSTANCE: ' + instance.type)

    const texts = []
    walk(instance, (node) => {
      if (node.type === 'TEXT') texts.push(node)
      return true
    }, 5000)

    const described = texts.map((node, index) => ({
      index,
      id: node.id,
      name: node.name,
      characters: String(node.characters).slice(0, 120),
    }))
    if (list || !Array.isArray(overrides) || overrides.length === 0) return { texts: described }

    const applied = []
    for (const override of overrides) {
      const target = override.nodeId
        ? texts.find((node) => node.id === override.nodeId)
        : override.name
          ? texts.find((node) => node.name === override.name) ||
            texts.find((node) => node.name.toLowerCase().includes(String(override.name).toLowerCase()))
          : texts[Number(override.index)]

      if (!target) {
        applied.push({ ok: false, match: override.name || override.nodeId || override.index, reason: 'text node not found in this instance' })
        continue
      }
      if (override.characters === undefined) {
        applied.push({ ok: false, id: target.id, reason: 'missing characters' })
        continue
      }
      try {
        if (target.fontName === figma.mixed) throw new Error('font is MIXED on this text node')
        await figma.loadFontAsync(target.fontName)
        target.characters = String(override.characters)
        applied.push({ ok: true, id: target.id, name: target.name, characters: target.characters })
      } catch (err) {
        applied.push({ ok: false, id: target.id, name: target.name, reason: err.message })
      }
    }
    return { applied }
  },

  /** Warianty i właściwości komponentu (component properties) na instancji. */
  async instanceProps({ instanceId, set } = {}) {
    const instance = await getNode(instanceId)
    if (instance.type !== 'INSTANCE') fail('node is not an INSTANCE: ' + instance.type)
    const read = () => {
      const properties = instance.componentProperties || {}
      return Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [key, value && typeof value === 'object' ? value.value : value]),
      )
    }
    if (!set) return { id: instance.id, properties: read() }
    try {
      instance.setProperties(set)
    } catch (err) {
      fail('setProperties failed: ' + err.message + ' — check the property names in `instanceProps`')
    }
    return { id: instance.id, applied: Object.keys(set), properties: read() }
  },

  /** Stosuje istniejący styl lokalny po nazwie (dokładnej albo po fragmencie). */
  async applyStyle({ nodeId, styleName, kind = 'text' } = {}) {
    if (!styleName) fail('missing styleName')
    if (['text', 'paint', 'effect', 'grid'].indexOf(kind) === -1) {
      fail('kind must be text | paint | effect | grid (got "' + kind + '")')
    }
    const node = await getNode(nodeId)
    const style = await styleByName(kind, styleName)
    const appliedTo = await applyStyleId(node, kind, style)
    return { id: node.id, style: { id: style.id, name: style.name, kind: appliedTo.kind } }
  },

  async group({ nodeIds, name } = {}) {
    if (!Array.isArray(nodeIds) || nodeIds.length < 2) fail('grouping needs at least two nodes')
    const nodes = await Promise.all(nodeIds.map((id) => getNode(id)))
    const parent = nodes[0].parent
    if (!parent) fail('cannot group nodes without a parent')
    const group = figma.group(nodes, parent)
    if (name) group.name = String(name)
    return { id: group.id, name: group.name }
  },

  async ungroup({ nodeId } = {}) {
    const node = await getNode(nodeId)
    if (typeof node.ungroup !== 'function') fail(node.type + ' cannot be ungrouped')
    const children = node.ungroup()
    return { ids: children.map((child) => child.id) }
  },

  async select({ nodeIds, zoom = false } = {}) {
    const nodes = await Promise.all((nodeIds || []).map((id) => getNode(id)))
    figma.currentPage.selection = nodes
    if (zoom) figma.viewport.scrollAndZoomIntoView(nodes)
    return { count: nodes.length, ids: nodes.map((n) => n.id) }
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
      fn = new Function('figma', '$', 'return (async () => { ' + code + ' })()')
    } catch (err) {
      fail('sandbox rejected new Function: ' + err.message)
    }
    const value = await fn(figma, EXEC_HELPERS)
    return { value: value === undefined ? null : value }
  },
}

// --------------------------------------------------------------- exec helpers

// W `exec` agent ma ręcznie pisany JS, więc najczęstsze pułapki dostaje jako funkcje:
// `$` jest w zasięgu obok `figma`. Wszystko, co dotyka stylów, jest asynchroniczne —
// synchroniczny setter (`node.textStyleId = …`) rzuca pod `documentAccess: "dynamic-page"`.
const EXEC_HELPERS = Object.freeze({
  node: (id) => getNode(id),
  text: (node, spec) => applyText(node, spec),
  font: (node, family, style) => applyText(node, { fontFamily: family, fontStyle: style }),
  textStyle: (name) => styleByName('text', name),
  paintStyle: (name) => styleByName('paint', name),
  effectStyle: (name) => styleByName('effect', name),
  gridStyle: (name) => styleByName('grid', name),
  // setters accept either a style object or its name
  setTextStyle: async (node, style) => applyStyleId(node, 'text', await resolveStyle('text', style)),
  setFillStyle: async (node, style) => applyStyleId(node, 'paint', await resolveStyle('paint', style)),
  setStrokeStyle: async (node, style) => applyStyleId(node, 'stroke', await resolveStyle('paint', style)),
  setEffectStyle: async (node, style) => applyStyleId(node, 'effect', await resolveStyle('effect', style)),
  setGridStyle: async (node, style) => applyStyleId(node, 'grid', await resolveStyle('grid', style)),
})

async function resolveStyle(kind, style) {
  return typeof style === 'string' ? await styleByName(kind, style) : style
}

// ------------------------------------------------------------- error translator

// Figma mówi "Use node.setTextStyleIdAsync instead", ale nie mówi, którą operację mostka
// wybrać. Dopisujemy naszą drogę, żeby agent nie powtarzał tego samego błędu.
const DYNAMIC_PAGE_STYLE = /Cannot call with documentAccess|documentAccess: dynamic-page/i

function explainError(message) {
  if (!DYNAMIC_PAGE_STYLE.test(message)) return message
  return (
    message +
    ' — in dynamic-page mode style ids are asynchronous: use the `text` op with `textStyle`,'
    + ' `applyStyle` with `kind`, or inside exec `await $.setTextStyle(node, await $.textStyle("Name"))`.'
  )
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
    page: figma.currentPage.name,
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

// Jeden batch naraz. Iframe wznawia long-poll od razu po odebraniu zlecenia, więc bez tej
// kolejki dwa agenty (albo dwa okna) mogłyby przeplatać swoje operacje w awaitach.
let batchChain = Promise.resolve()

figma.ui.onmessage = async (msg) => {
  if (!msg || typeof msg.type !== 'string') return

  if (msg.type === 'resize') {
    // Figma sam ogranicza okno do 1080 px, ale egzekwujemy to po naszej stronie,
    // bo panel przeciąga rozmiar z localStorage.
    const width = Math.min(1080, Math.max(200, Math.round(Number(msg.width) || 232)))
    const height = Math.min(1080, Math.max(120, Math.round(Number(msg.height) || 34)))
    figma.ui.resize(width, height)
    return
  }
  if (msg.type === 'selectionInfo') return uiSelectionInfo()
  if (msg.type === 'exportSelection') return uiExportSelection()
  if (msg.type === 'insertImage') return uiInsertImage(msg)
  if (msg.type === 'fillSelection') return uiFillSelection(msg)

  if (msg.type !== 'run') return
  batchChain = batchChain.then(() => runBatch(msg)).catch(() => {})
}

async function runBatch(msg) {
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
      const message = explainError(err && err.message ? err.message : String(err))
      error = 'op #' + i + ' (' + String(op.op) + '): ' + message
      results.push({ index: i, op: op.op, ok: false, error: message })
      break
    }
  }

  // Cała seria to jeden krok undo — inaczej ⌘Z cofa pojedynczą operację z dwudziestu.
  if (ok && results.length > 1) {
    try {
      figma.commitUndo()
    } catch (err) {
      /* starsze API bez commitUndo — nie blokujemy wyniku */
    }
  }

  figma.ui.postMessage({ type: 'result', id: msg.id, ok, results, error })
  // Pełny błąd i tak wraca do agenta; w Figmie pokazujemy skrót, żeby toast nie zasłaniał płótna.
  if (!ok) figma.notify('Figma Bridge: ' + String(error).slice(0, 120), { error: true })
}

figma.notify('Figma Bridge ready')
