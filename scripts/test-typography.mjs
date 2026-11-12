// Runs the real plugin/code.js against a fake Figma API and checks the typography
// paths: the `text` op (whole node + range), `update` delegation, `applyStyle`,
// `exec` helpers, and the dynamic-page error translation.
//
//   node scripts/test-typography.mjs
//
// No Figma, no server — this is a unit test for the parts that used to need `exec`.

import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const code = readFileSync(new URL('../plugin/code.js', import.meta.url), 'utf8')
const mixed = Symbol('mixed')

function makeText(id, characters, font = { family: 'Poppins', style: 'Regular' }) {
  const node = {
    type: 'TEXT',
    id,
    name: 'Text ' + id,
    characters,
    fontName: font,
    fontSize: 16,
    lineHeight: { unit: 'AUTO' },
    letterSpacing: { unit: 'PIXELS', value: 0 },
    fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
    textAlignHorizontal: 'LEFT',
    textAlignVertical: 'TOP',
    textAutoResize: 'NONE',
    opacity: 1,
    fillStyleId: '',
    parent: null,
    calls: [],
  }
  const fontAt = () => (node.fontName === mixed ? { family: 'Poppins', style: 'Regular' } : node.fontName)
  node.getRangeFontName = (start, end) => {
    if (start < 0 || end > node.characters.length) throw new Error('range out of bounds')
    node.calls.push(['getRangeFontName', start, end])
    return fontAt()
  }
  node.getRangeAllFontNames = () => [fontAt()]
  node.setRangeFontName = (start, end, f) => { node.calls.push(['setRangeFontName', start, end, f]); node.fontName = f }
  node.setRangeFontSize = (start, end, v) => { node.calls.push(['setRangeFontSize', start, end, v]); node.fontSize = v }
  node.setRangeLineHeight = (start, end, v) => { node.calls.push(['setRangeLineHeight', start, end, v]); node.lineHeight = v }
  node.setRangeLetterSpacing = (start, end, v) => { node.calls.push(['setRangeLetterSpacing', start, end, v]); node.letterSpacing = v }
  node.setRangeFills = (start, end, v) => { node.calls.push(['setRangeFills', start, end, v]); node.fills = v }
  // dynamic-page: the synchronous setter always throws, exactly like Figma
  Object.defineProperty(node, 'textStyleId', {
    get: () => node._textStyle || '',
    set: () => { throw new Error('in set_textStyleId: Cannot call with documentAccess: dynamic-page. Use node.setTextStyleIdAsync instead.') },
  })
  node.setTextStyleIdAsync = async (id) => { node.calls.push(['setTextStyleIdAsync', id]); node._textStyle = id }
  node.setFillStyleIdAsync = async (id) => { node.calls.push(['setFillStyleIdAsync', id]); node.fillStyleId = id }
  return node
}

const title = makeText('1:10', 'The missing middle of the story')
const mixedText = makeText('1:11', 'Bold lead in body copy')
mixedText.fontName = mixed
// ramka z dziećmi — do testu blokady kasowania całej pracy
const frame = {
  id: '1:20',
  name: 'Slide 01',
  type: 'FRAME',
  children: [{ id: '1:21', type: 'TEXT', name: 'Title' }],
  removed: false,
  remove() { this.removed = true },
}
const nodes = new Map([[title.id, title], [mixedText.id, mixedText], [frame.id, frame]])

const page = { id: '0:1', name: 'Slides', type: 'PAGE', children: [], selection: [] }

const figma = {
  mixed,
  showUI() {},
  ui: { postMessage() {}, resize() {}, onmessage: null },
  on() {},
  notify() {},
  root: { name: 'Harness', children: [page] },
  currentPage: page,
  fileKey: 'harness',
  editorType: 'figma',
  getNodeByIdAsync: async (id) => nodes.get(id) || null,
  loadFontAsync: async (font) => font,
  loadAllPagesAsync: async () => {},
  commitUndo() {},
  getLocalTextStylesAsync: async () => [
    { id: 'S:text/h1', name: 'text/h1', type: 'TEXT' },
    { id: 'S:text/body/25', name: 'text/body/25', type: 'TEXT' },
  ],
  getLocalPaintStylesAsync: async () => [{ id: 'S:paint/ink', name: 'paint/ink', type: 'PAINT' }],
  getLocalEffectStylesAsync: async () => [],
  getLocalGridStylesAsync: async () => [],
  getLocalVariableCollections: () => [],
}

const sandbox = { figma, __html__: '', console, Promise, setTimeout, JSON, Math, Date, Number, String, Object, Array, RegExp, Set, Map, Error }
vm.createContext(sandbox)
vm.runInContext(code, sandbox)

// The plugin queues batches (one at a time), so the result arrives after the handler
// resolves — wait for the postMessage instead of reading a variable right after it.
async function run(ops) {
  return await new Promise((resolve) => {
    figma.ui.postMessage = (msg) => { if (msg.type === 'result') resolve(msg) }
    figma.ui.onmessage({ type: 'run', id: 'test', ops })
  })
}

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log('ok   ' + label)
  } else {
    failures += 1
    console.log('FAIL ' + label + (detail === undefined ? '' : ' — ' + JSON.stringify(detail)))
  }
}

// 1. whole-node typography
let r = await run([{ op: 'text', nodeId: '1:10', fontFamily: 'Poppins', fontStyle: 'SemiBold', fontSize: 40, lineHeight: 48 }])
const v1 = r.results[0].value
check('text: font + size + lineHeight', r.ok && v1.text.fontSize === 40 && v1.text.lineHeight.value === 48 && v1.text.fontFamily === 'Poppins', r.error)

// 2. line height units and letter spacing
r = await run([{ op: 'text', nodeId: '1:10', lineHeight: '140%', letterSpacing: '5%' }])
const v2 = r.results[0].value
check('text: percent lineHeight/letterSpacing', r.ok && v2.text.lineHeight.unit === 'PERCENT' && v2.text.lineHeight.value === 140 && v2.text.letterSpacing.unit === 'PERCENT', r.error)

// 3. range on a mixed node
r = await run([{ op: 'text', nodeId: '1:11', fontStyle: 'Bold', range: { start: 0, end: 4 } }])
const rangeCalls = mixedText.calls.filter((c) => c[0] === 'setRangeFontName')
check('text: range keeps the rest of the node', r.ok && rangeCalls.length === 1 && rangeCalls[0][1] === 0 && rangeCalls[0][2] === 4 && rangeCalls[0][3].style === 'Bold', r.error)

// 4. named text style by suffix
r = await run([{ op: 'text', nodeId: '1:10', textStyle: 'h1' }])
check('text: textStyle by suffix', r.ok && title._textStyle === 'S:text/h1' && r.results[0].value.changed.includes('textStyle'), r.error)

// 5. update delegates typography but keeps geometry props
r = await run([{ op: 'update', nodeId: '1:10', props: { fontName: { family: 'Poppins', style: 'Regular' }, fontSize: 25, opacity: 0.9 } }])
const v5 = r.results[0].value
check('update: fontName + fontSize + opacity', r.ok && v5.applied.includes('fontFamily') && v5.applied.includes('opacity') && v5.skipped.length === 0, v5)

// 6. update applies a style by name
r = await run([{ op: 'update', nodeId: '1:10', props: { fillStyle: 'ink' } }])
check('update: fillStyle by name', r.ok && title.fillStyleId === 'S:paint/ink', r.error)

// 7. applyStyle, async setters
r = await run([{ op: 'applyStyle', nodeId: '1:10', styleName: 'body/25', kind: 'text' }])
check('applyStyle: text style', r.ok && title._textStyle === 'S:text/body/25', r.error)

// 8. exec helpers
r = await run([{ op: 'exec', code: "const n = await $.node('1:10'); await $.setTextStyle(n, 'h1'); return n._textStyle" }])
check('exec: $.setTextStyle with a name', r.ok && r.results[0].value.value === 'S:text/h1', r.error)

// 9. the old synchronous setter is explained, not just thrown
r = await run([{ op: 'exec', code: "const n = await $.node('1:10'); n.textStyleId = 'S:x'; return true" }])
check('exec: dynamic-page error gets bridge advice', !r.ok && /use the `text` op with `textStyle`/.test(r.error), r.error)

// 10. a missing style fails with the list hint
r = await run([{ op: 'text', nodeId: '1:10', textStyle: 'nope' }])
check('text: unknown style names the fix', !r.ok && /style not found: nope/.test(r.error), r.error)

// 11. deleting a frame needs confirm — feedback is an edit, not a rebuild
r = await run([{ op: 'remove', nodeId: '1:20' }])
check('remove: frame without confirm is refused', !r.ok && /without confirm:true/.test(r.error) && !frame.removed, r.error)

r = await run([{ op: 'remove', nodeId: '1:20', confirm: true }])
check('remove: frame with confirm is removed', r.ok && frame.removed, r.error)

console.log(failures === 0 ? '\nall typography checks passed' : '\n' + failures + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
