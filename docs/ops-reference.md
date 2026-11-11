# Operations reference

Every operation is `{ "op": "name", ...parameters }`. All fields except `op` are optional unless
marked required. Values come back in `results[i].value`.

---

## ping

No parameters. Returns `{ pong: true, ts, bridge }`. Use it to check the plugin is alive.

## status

No parameters. Returns:

```json
{ "fileKey": null, "fileName": "Design System",
  "page": { "id": "0:1", "name": "Cover" },
  "pages": [ { "id": "0:1", "name": "Cover" } ],
  "editorType": "figma",
  "selection": [ { "id": "12:34", "name": "Card", "type": "FRAME" } ],
  "user": null }
```

`fileKey` is `null` for files opened locally (not from the cloud). `user` may be `null` when the
manifest lacks the `currentuser` permission.

## pages

No parameters. Returns an array of `{ id, name, type }` for every page.

## structure

Reads a frame the way a human does: children grouped into rows, sorted in reading order, with the gaps
between them. Use it to respect an existing arrangement instead of re-flowing it.

| parameter | default | meaning |
|---|---|---|
| `nodeId` | — (required) | frame, group or section |
| `tolerance` | `24` | vertical distance under which two items count as one row |

Returns `{ rows: [{ y, height, count, gaps, items: [{ id, name, type, x, y, width, height }] }],
readingOrder: [id…] }`.

```bash
./bin/figma op '{"op":"structure","nodeId":"12:34"}'
```

Reading it: `rows` are the author's bands, `gaps` reveal the spacing rhythm (it is rarely uniform — the
irregular one is usually intentional), and `readingOrder` is the sequence to preserve.

## inventory

One call instead of walking the tree: every frame on the current page (or inside `nodeId`) with its
geometry and typography statistics.

| parameter | default | meaning |
|---|---|---|
| `nodeId` | current page | container to scan |
| `limit` | `200` | max children examined |

Returns `{ page, count, frames: [{ id, name, type, x, y, width, height, children, textNodes, fonts,
minFontSize, maxFontSize, layoutGrids, fills }] }`.

```bash
./bin/figma op '{"op":"inventory"}'
```

Use it to answer "which frames have no grid", "where is text smaller than 20 px", or "what are frames
11–19" without a single `node` call.

## selection

| parameter | default | meaning |
|---|---|---|
| `depth` | `2` | how many levels of children to descend |
| `maxChildren` | `40` | children cap per node |

Returns `{ count, nodes: [summary…] }`.

`summary` for every node: `id, name, type, x, y, width, height, visible, fills` (hex or paint type),
`layoutMode`/`itemSpacing` when the node is auto-layout, and `children[]` up to `maxChildren`.

For `TEXT` nodes it adds: `characters` (first 160), `font {family, style}`, `fontFamily`, `fontSize`,
`lineHeight {value, unit}`, `letterSpacing {value, unit}`, `textAlignHorizontal`, `textAlignVertical`,
`textAutoResize`. Mixed values (a text node with several styles) are the string `"MIXED"` — never
assume a property exists on every node, and never index a field the reference does not list.

## node

| parameter | default | meaning |
|---|---|---|
| `nodeId` | — (required) | node id |
| `depth` | `2` | depth |
| `maxChildren` | `40` | children cap |

Returns a `summary` as above, including the `TEXT` typography fields.

## find

| parameter | default | meaning |
|---|---|---|
| `name` | — | substring of the name, case-insensitive |
| `type` | — | e.g. `FRAME`, `TEXT`, `COMPONENT` |
| `allPages` | `false` | search every page (calls `loadAllPagesAsync`) |
| `limit` | `50` | max hits |

Returns `{ count, hits: [{ id, name, type }] }`. `page` in hits is always `null` — resolve the page
with `node`/`goto`.

## createPage

| parameter | meaning |
|---|---|
| `name` | page name |

Returns `{ id, name }`. The page lands at the end of the list; the user's view does **not** change.

## goto

| parameter | meaning |
|---|---|
| `pageId` | page id (required) |

Switches the user's view. Returns `{ page: { id, name } }`.

## createFrame

| parameter | default | meaning |
|---|---|---|
| `name` | `"Frame"` | layer name |
| `x`, `y` | `0` | position in the parent's space |
| `width`, `height` | `320`, `200` | size |
| `parentId` | current page | frame, group or page |
| `index` | — | position among siblings |
| `fill` | — | hex, e.g. `"#0B0B0F"`; `null` = no fill |
| `props` | — | extra properties: `cornerRadius`, `layoutMode`, `paddingTop/Right/Bottom/Left`, `itemSpacing`, `primaryAxisSizingMode`, `counterAxisSizingMode`, `clipsContent`, … |

Returns `{ id, name, x, y }`.

## createRect / createEllipse

Like `createFrame`, but default `100×100`, plus `cornerRadius` (works on `createRect`).
Returns `{ id, name }`.

## createText

| parameter | default | meaning |
|---|---|---|
| `characters` | `"Tekst"` | content |
| `fontFamily`, `fontStyle` | `Inter`, `Regular` | font (loaded via `loadFontAsync`) |
| `fontSize` | `16` | size |
| `color` | `"#111111"` | text fill |
| `x`, `y` | `0` | position |
| `width` | — | sets `textAutoResize: HEIGHT` and wraps the text |
| `parentId`, `index` | — | as above |
| `props` | — | `textAlignHorizontal`, `textAlignVertical`, … |

Returns `{ id, name, characters }`.

## update

| parameter | meaning |
|---|---|
| `nodeId` | node (required) |
| `props` | map of properties to set |

Supported `props`: `name, x, y, width, height, opacity, visible, cornerRadius, clipsContent, rotation,
fills, strokes, strokeWeight, layoutMode, primaryAxisSizingMode, counterAxisSizingMode, itemSpacing,
counterAxisSpacing, paddingTop/Right/Bottom/Left, primaryAxisAlignItems, counterAxisAlignItems,
layoutSizingHorizontal, layoutSizingVertical, textAlignHorizontal, textAlignVertical, textAutoResize`.

Text properties are delegated to the [`text`](#text) logic, so they also work here: `characters,
fontName ({family, style}), fontFamily, fontStyle, fontSize, lineHeight, letterSpacing, range`.

Styles can be applied by name: `textStyle`, `fillStyle`, `strokeStyle`, `effectStyle`, `gridStyle`.
They go through the async setters, so they work under `dynamic-page`.

`fills`/`strokes`: array of hex strings, or `null`. Returns `{ id, name, applied, skipped }` —
`skipped` lists properties the node type does not have.

## text

Changes the appearance of an **existing** text node — the operation that used to require `exec`.

| parameter | meaning |
|---|---|
| `nodeId` | text node (required) |
| `characters` | replace the whole content (whole node only) |
| `fontFamily`, `fontStyle` | e.g. `"Poppins"`, `"SemiBold"` — loaded via `loadFontAsync`; either one alone reuses the current value of the other |
| `fontSize` | number, px |
| `lineHeight` | number (px), `"AUTO"`, or `"140%"` |
| `letterSpacing` | number (px) or `"5%"` |
| `color` | hex fill, or `null` to clear |
| `textStyle` | name of a local text style — applies to the whole node |
| `textAlignHorizontal`, `textAlignVertical`, `textAutoResize` | as in the Plugin API |
| `range` | `{start, end}` — restrict font/size/lineHeight/letterSpacing/color to a character range |

Returns `{ id, name, changed, range, text }` where `text` is the same typography block that `node`
returns (`font`, `fontSize`, `lineHeight`, `letterSpacing`, …) after the change.

```bash
# a whole title: family + weight + size + line height
./bin/figma op '{"op":"text","nodeId":"12:34","fontFamily":"Poppins","fontStyle":"SemiBold","fontSize":40,"lineHeight":48}'
# one word inside a body paragraph, keeping everything else
./bin/figma op '{"op":"text","nodeId":"12:34","fontStyle":"Bold","range":{"start":0,"end":12}}'
# a named style instead of loose values
./bin/figma op '{"op":"text","nodeId":"12:34","textStyle":"body/25"}'
```

Mixed fonts: when the node uses several fonts, `fontFamily`/`fontStyle` need a `range` (or both
values) — the operation fails rather than guessing. Mutating part of a text node loads every font in
that range first, because Figma refuses writes to unloaded fonts.

## clone

| parameter | meaning |
|---|---|
| `nodeId` | source (required) |
| `parentId`, `index` | destination |
| `x`, `y` | new position |

Returns `{ id, name, type }` of the copy.

## reparent

| parameter | meaning |
|---|---|
| `nodeId` | node to move |
| `parentId` | new parent (frame/group/page) |
| `index` | position among siblings |

Returns `{ id, parent }`.

## remove

| parameter | meaning |
|---|---|
| `nodeId` | node to delete |

Returns `{ removed: id, name }`. Irreversible outside Figma's own undo (⌘Z).

## variables

| parameter | default | meaning |
|---|---|---|
| `limit` | `200` | max variables |
| `type` | — | e.g. `COLOR`, `FLOAT`, `STRING`, `BOOLEAN` |

Returns `{ collections: [{id,name,modes}], count, variables: [{id,name,type,collection}], truncated }`.
Empty `collections` = the file has no local variables (no design system) → `varFill` cannot work.

## varFill

| parameter | default | meaning |
|---|---|---|
| `nodeId` | — (required) | node |
| `variableName` | — (required) | variable name; exact match first, then substring |
| `field` | `"fills"` | `fills` \| `strokes` \| `textColor` |
| `hex` | `"#000000"` | base colour when the node has no fill yet |

Binds the variable through `setBoundVariableForPaint`. Returns `{ id, variable, variableId, field }`.

## styles

| parameter | default | meaning |
|---|---|---|
| `limit` | `200` | cap per group |

Returns `{ paint: [{id,name,type}], text: [{id,name}], counts: {paint,text} }`.

## grids

| parameter | meaning |
|---|---|
| `nodeId` | node with layout grids (frame, page, component) |

Returns `{ id, layoutGrids }` exactly as Figma stores them.

## setGrids

| parameter | default | meaning |
|---|---|---|
| `nodeId` | — (required) | node |
| `columns` | — | `{ count: 12, gutter: 24, margin: 0, alignment: 'STRETCH', color, sectionSize }` |
| `rows` | — | same shape, default `count: 3` |
| `grid` | — | **square GRID**: a number is the cell size (`40`), or `{ size, opacity, color }`. Defaults: `40 px`, `40%` |
| `visible` | `true` | show the grid immediately |
| `clear` | `false` | `true` removes every grid on the node |

```bash
./bin/figma op '{"op":"setGrids","nodeId":"12:34","grid":true}'                 # 40 px cells, 40% — the default
./bin/figma op '{"op":"setGrids","nodeId":"12:34","grid":{"size":40,"opacity":0.4}}'
./bin/figma op '{"op":"setGrids","nodeId":"12:34","columns":{"count":12,"gutter":24,"margin":64}}'

`grid` and `columns`/`rows` are different patterns: when a brief says "put a grid on it", it means the
square GRID. Columns and rows are a deliberate choice, so pass them explicitly.
```

Returns the applied `layoutGrids`. Sizes are snapped to Figma's own grid limits; an unsupported node
type fails with its type name.

## align

| parameter | default | meaning |
|---|---|---|
| `nodeIds` | — (required) | two or more siblings |
| `mode` | `LEFT` | `LEFT` `RIGHT` `HCENTER` `TOP` `BOTTOM` `VCENTER` |

Aligns to the bounding box of the given nodes and returns their new `x`/`y`.

## distribute

| parameter | default | meaning |
|---|---|---|
| `nodeIds` | — (required) | at least two |
| `axis` | `HORIZONTAL` | `HORIZONTAL` or `VERTICAL` |
| `gap` | — | fixed gap; omit for equal spacing between the extremes |

Returns `{ spacing, ordered }` with the nodes already moved. `gap` is the space **between edges**.

## effects

| parameter | meaning |
|---|---|
| `nodeId` | node |
| `effects` | raw Figma effects array (`DROP_SHADOW`, `INNER_SHADOW`, `LAYER_BLUR`, `BACKGROUND_BLUR`) |
| `shadow` | shortcut: `{ x: 0, y: 4, blur: 12, spread: 0, color: "#00000040" }` |
| `blur` | shortcut: `{ type: "LAYER" \| "BACKGROUND", radius: 12 }` |
| `clear` | `true` removes every effect |

## constraints

| parameter | meaning |
|---|---|
| `nodeId` | node |
| `horizontal` | `MIN` `CENTER` `MAX` `STRETCH` `SCALE` |
| `vertical` | same values |

Call with no axis to read the current constraints. Only meaningful for children of a frame that is
**not** auto-layout — an auto-layout child is governed by `sizing` instead.

## sizing

Responsive behaviour in one call; every write is attempted independently and reported.

| parameter | values |
|---|---|
| `horizontal`, `vertical` | `HUG` (fit content), `FILL` (stretch in the parent), `FIXED` |
| `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | numbers, or `null` to clear |
| `grow` | `0` / `1` — legacy fill of the remaining space |
| `align` | `INHERIT` / `STRETCH` |
| `absolute` | `true` positions the node absolutely inside auto-layout |

Returns `{ applied, skipped, read }` — `skipped` carries Figma's reason for a property that does not
apply to that node type or context, so a partial success is never silent.

```bash
./bin/figma op '{"op":"sizing","nodeId":"12:34","horizontal":"FILL","vertical":"HUG"}'
./bin/figma run '[{"op":"constraints","nodeId":"12:34","horizontal":"STRETCH","vertical":"MAX"}]'
```

## gradient

| parameter | default | meaning |
|---|---|---|
| `nodeId` | — (required) | node with fills |
| `kind` | `linear` | `linear` `radial` `angular` `diamond` |
| `angle` | `90` | degrees, clockwise; **0 = left → right**, 90 = top → bottom |
| `stops` | white → black | `[[0, "#8B76FF"], [1, "#0E0E12"]]`, or `[{ position, color }]` |
| `opacity` | `1` | paint opacity |
| `visible` | `true` | |

```bash
./bin/figma op '{"op":"gradient","nodeId":"12:34","kind":"linear","angle":135,
                 "stops":[[0,"#8B76FF"],[0.55,"#3B2E8C"],[1,"#0E0E12"]]}'
```

Replaces the node's fills with that gradient (one paint). To keep a fill underneath, add it afterwards
with `update` — `fills` accepts raw paint objects as well as hex strings.

## createInstance

| parameter | meaning |
|---|---|
| `componentId` | a node of type `COMPONENT` (find it with `find` + `type: "COMPONENT"`) |
| `parentId`, `x`, `y` | where to place it |

Returns `{ id, name, type }` of the instance — the correct way to build with an existing design system
instead of drawing look-alikes.

## instanceText

Change copy inside a component instance without detaching it.

| parameter | meaning |
|---|---|
| `instanceId` | node of type `INSTANCE` |
| `list` | `true` returns the text nodes only (index, id, name, characters) |
| `overrides` | `[{ name?, index?, nodeId?, characters }]` — match by name (exact, then partial), by index, or by id |

```bash
./bin/figma op '{"op":"instanceText","instanceId":"12:34","list":true}'
./bin/figma op '{"op":"instanceText","instanceId":"12:34","overrides":[{"name":"Title","characters":"Q3 plan"}]}'
```

Returns `{ applied: [{ok, id, name, characters?, reason?}] }` — a failed override carries Figma's reason
(missing text node, `MIXED` font), and the rest still apply.

## instanceProps

| parameter | meaning |
|---|---|
| `instanceId` | instance |
| `set` | `{ "Size": "Large", "State": "Hover" }` — component property / variant values |

Call without `set` to read the current properties first; names must match exactly, so read, then write.
Returns `{ id, applied, properties }`.

## saveStyle

Creates or updates a local style by name — the write half of the style system.

| parameter | kind | meaning |
|---|---|---|
| `kind` | `text` | `font {family, style}`, `fontSize`, `lineHeight`, `letterSpacing` |
| | `paint` | `color` (hex) or `paints[]` |
| | `effect` | `effects[]` |
| | `grid` | `layoutGrids[]` |
| `name` | any | style name; an existing style with that name is updated in place |

Returns `{ id, name, kind, created }`. Fonts are loaded before assignment, so a missing family fails
with Figma's message instead of half-applying.

```bash
./bin/figma op '{"op":"saveStyle","kind":"text","name":"heading/xl",
                 "font":{"family":"Inter","style":"Semi Bold"},"fontSize":32,"lineHeight":40}'
./bin/figma op '{"op":"applyStyle","nodeId":"12:34","styleName":"heading/xl"}'
```

## applyStyle

| parameter | meaning |
|---|---|
| `nodeId` | node |
| `styleName` | exact name, or a suffix after `/` (`text/heading/xl` matches `heading/xl`) |
| `kind` | `text` (default), `paint`, `effect`, or `grid` (applies a saved `saveStyle` grid style) |

Uses `setTextStyleIdAsync` / `setFillStyleIdAsync` / `setGridStyleIdAsync`, so it works under
`dynamic-page`. For a text style on a text node, the [`text`](#text) op with `textStyle` does the same
and returns the resulting typography.

## group / ungroup / select

- `group { nodeIds, name? }` — groups siblings, returns the new node.
- `ungroup { nodeId }` — dissolves a group or frame-group, returns the children ids.
- `select { nodeIds, zoom? }` — sets the user's selection, optionally scrolls it into view.

## fonts

Typography audit in one call — what agents otherwise rebuild as a fragile script.

| parameter | default | meaning |
|---|---|---|
| `allPages` | `false` | scan every page (calls `loadAllPagesAsync`) |
| `limit` | `20000` | safety cap on visited nodes; `truncated: true` when hit |

Returns `{ families: [{ family, style, count, sizes, sampleIds }], textNodes, scanned, truncated }`,
sorted by usage. Mixed styles report family/style `"MIXED"`.

```bash
./bin/figma op '{"op":"fonts"}'
./bin/figma op '{"op":"fonts","allPages":true}'
```

## export

| parameter | default | meaning |
|---|---|---|
| `nodeId` | — (required) | node |
| `format` | `"PNG"` | `PNG` \| `JPG` \| `SVG` \| `PDF` |
| `scale` | `2` | export scale |

Returns `{ nodeId, name, format, bytes, base64 }`. The cap is 8 MB — above that it fails, so lower
`scale`. CLI: `./bin/figma export 1:2 out.png PNG 2` writes the file and prints its size.

## imageFill

| parameter | default | meaning |
|---|---|---|
| `nodeId` | — (required) | node |
| `base64` | — (required) | image bytes (PNG/JPG/GIF/WebP) |
| `scaleMode` | `"FILL"` | `FILL` \| `FIT` \| `TILE` \| `CROP` |

Creates the image locally with `figma.createImage` — nothing is uploaded to Figma's cloud.
Returns `{ id, imageHash, bytes }`.

## createFromSvg

| parameter | default | meaning |
|---|---|---|
| `svg` | — (required) | SVG markup (`<svg …>`) |
| `x`, `y` | viewport centre | top-left of the new frame |
| `width`, `height` | SVG's own size | resize to both, or scale proportionally with one |
| `name` | `SVG · HH:MM:SS` | layer name |
| `select` | `true` | select the node and scroll to it |

Places **real vectors**, not an image: `figma.createNodeFromSvg` builds a frame whose children are the
paths, so fills and strokes stay editable. Returns `{ id, name, type, width, height, scaled }`.

```bash
figma op '{"op":"createFromSvg","svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"10\"/></svg>","width":48,"height":48}'
```

The panel's **Vector** mode and `figma svg gen|trace --insert` use this operation; it also accepts any
SVG you already have, which makes it the way to bring an exported logo back onto the canvas.

## exec

| parameter | meaning |
|---|---|
| `code` | body of an async function; `figma` and `$` are in scope |

```json
{ "op": "exec", "code": "const n = await figma.getNodeByIdAsync('1:2'); return { name: n.name }" }
```

Returns `{ value }` — the result must be JSON-serializable. Figma's sandbox **does** allow
`new Function` (verified), so this is the full Plugin API. Use it sparingly: it bypasses parameter
validation and can do more to a file than you intended.

`$` carries the parts that are easy to get wrong — every style setter is asynchronous, because the
manifest runs with `documentAccess: "dynamic-page"`. `node.textStyleId = style.id` throws
`Cannot call with documentAccess: dynamic-page`; `$` never does.

| helper | returns |
|---|---|
| `$.node(id)` | the node (async) |
| `$.text(node, spec)` | same spec as the [`text`](#text) op |
| `$.font(node, family, style)` | sets the font, loading it first |
| `$.textStyle(name)`, `$.paintStyle(name)`, `$.effectStyle(name)`, `$.gridStyle(name)` | the style object |
| `$.setTextStyle(node, styleOrName)`, `$.setFillStyle`, `$.setStrokeStyle`, `$.setEffectStyle`, `$.setGridStyle` | applies it, returns `{id, name, kind}` |

```json
{ "op": "exec", "code": "const n = await $.node('1:2'); await $.setTextStyle(n, 'body/25'); return n.textStyleId" }
```

If a style error does come back, the message now names the bridge path to use instead — it is not a
dead end, it is a hint.
