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

## selection

| parameter | default | meaning |
|---|---|---|
| `depth` | `2` | how many levels of children to descend |
| `maxChildren` | `40` | children cap per node |

Returns `{ count, nodes: [summary…] }`. `summary` = `id, name, type, x, y, width, height, visible,
characters (TEXT only), layoutMode/itemSpacing, fills (hex or paint type), children[]`.

## node

| parameter | default | meaning |
|---|---|---|
| `nodeId` | — (required) | node id |
| `depth` | `2` | depth |
| `maxChildren` | `40` | children cap |

Returns a `summary` as above.

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
