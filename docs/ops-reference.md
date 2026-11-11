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
layoutSizingHorizontal, layoutSizingVertical, textAlignHorizontal, textAlignVertical, textAutoResize,
characters, fontSize`.

`fills`/`strokes`: array of hex strings, or `null`. Returns `{ id, name, applied, skipped }` —
`skipped` lists properties the node type does not have.

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
| `kind` | `text` (default), `paint`, or `grid` (applies a saved `saveStyle` grid style) |

Uses `setTextStyleIdAsync` / `setFillStyleIdAsync`, so it works under `dynamic-page`.

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

## exec

| parameter | meaning |
|---|---|
| `code` | body of an async function; `figma` is in scope |

```json
{ "op": "exec", "code": "const n = await figma.getNodeByIdAsync('1:2'); return { name: n.name }" }
```

Returns `{ value }` — the result must be JSON-serializable. Figma's sandbox **does** allow
`new Function` (verified), so this is the full Plugin API. Use it sparingly: it bypasses parameter
validation and can do more to a file than you intended.
