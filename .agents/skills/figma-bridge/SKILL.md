---
name: figma-bridge
description: "Drive a Figma file through the local Figma Bridge — read the selection, build frames, text and shapes, bind variables, place images, generate real SVG vectors with QuiverAI, generate or edit raster images with fal, export PNG/SVG. Use when a task requires touching a Figma canvas (inspect a design, implement UI in Figma, swap colors to tokens, export an asset, insert generated artwork, make an icon, logo or illustration as editable vector paths). Requires the bridge server on localhost:3847 and the Figma Bridge plugin running in the target file; if unavailable, do not improvise — ask the user to start them."
whenToUse: "The user points at a Figma file, asks to build or edit something in Figma, asks what is on the canvas, wants an icon, logo or vector artwork (SVG, QuiverAI), or wants generated or edited artwork placed there."
---

# Figma Bridge

Figma has no public write API. This skill uses a local bridge: named operations over HTTP,
executed inside Figma by a plugin, through the Figma Plugin API. No OAuth, no tokens.

**Repo:** https://github.com/iggypcnfsky/figma-bridge — `AGENTS.md`, `docs/ops-reference.md`.

## Preconditions — check before anything else

`figma` is on `PATH`, so **never search the filesystem for the repo**:

```bash
figma doctor        # repo, server, connected windows, img-forge + FAL key in one shot
figma clients       # id, file, page of every connected Figma window
figma agents        # who is working on this canvas right now (names, runs, busy/idle)
figma rules         # project constraints: type floor, grid, frame size, version naming
```

**Read `figma rules` before designing.** It carries the non-obvious limits — e.g. "Poppins 20/25 is the
floor" — that no amount of reading the canvas will tell you. Treat `"confirmed": false` as an
assumption to verify with the user, and `{}` as "ask, do not invent".

If the server is down, start it with `figma serve` (detached, survives the terminal). Only if `figma`
itself is missing, fall back to `node "$(figma where)/server.mjs"` — do not `find` the repo, and do not
guess paths.

- `pluginConnected: false` → stop. Ask the user to run `Plugins → Development → Figma Bridge`
  in the window of the file they want touched. Retrying does not help.
- `503` from `/run` means the same thing. `504 PLUGIN_GONE` means they closed the plugin window.
- `409` means several Figma windows are connected and none was chosen. Pick the file the user named
  (`--file <NAME>`) or a client id (`--client <ID>`); never retry blindly, or you may edit the wrong file.
- Set `--agent <name>` (or `FIGMA_AGENT`) so the user sees you in the panel's Agents tab and in
  `figma agents`; under DSH your session id is used automatically. `--label "…"` (or
  `FIGMA_AGENT_LABEL`) gives it a readable name — DSH chat titles are not visible to the bridge.
- Another agent may be working in the same file. Batches are serialised per window, so you will not
  run inside each other — but your reads go stale between them, and the last write to a node wins.
  Re-read before a write that depends on state, stay inside your own frame subtree, keep batches
  short, and check `figma clients` (`busy: <job>`) before blaming your own operation for a change.

## The loop

1. **Orient.** `./bin/figma status` → file name, current page, selection, all pages.
2. **Read.** `selection 2`, `node <id> 2`, `find {"name":"Header","allPages":true}`.
   Never guess a `nodeId` — Figma ids look like `4022:2` and are not derivable.
3. **Plan.** Decide parent, size, order. New nodes go to the current page unless `parentId` is given.
4. **Write.** `./bin/figma run '[{...},{...}]'`.
5. **Verify.** `./bin/figma export <id> out/check.png PNG 2` and actually look at the image.

## Commands

```bash
./bin/figma op '{"op":"status"}'
./bin/figma run '[{"op":"createFrame","name":"Card","width":320,"height":200,"fill":"#0B0B0F",
                   "props":{"cornerRadius":16,"layoutMode":"VERTICAL","paddingTop":24,"paddingLeft":24,"itemSpacing":12}}]'
./bin/figma run '[{"op":"createText","parentId":"12:34","characters":"Title","fontSize":24,"color":"#FFFFFF"}]'
./bin/figma op '{"op":"varFill","nodeId":"12:34","variableName":"color/bg/surface"}'
./bin/figma export 12:34 out/card.png PNG 2
./bin/figma image 12:34 out/cover.png FILL      # local image file → fill (no cloud upload)
./bin/figma svg gen "minimal line-art fox" --out out/fox.svg --insert   # QuiverAI → vectors
./bin/figma svg trace logo.png --insert          # raster → editable paths
```

Ops: `ping status pages variables styles fonts inventory` · `selection node find` · `createFrame createRect
createEllipse createText createPage createInstance` · `update text clone reparent remove goto group
ungroup select` · `grids setGrids align distribute effects` · `applyStyle varFill` · `export imageFill createFromSvg` ·
`exec`.
Full parameters: `docs/ops-reference.md`.

Design-work shortcuts worth knowing:

- **grid means GRID**: when the user says "set a grid", they want the square layout grid, not columns:
  `{"op":"setGrids","nodeId":"…","grid":true}` (40 px cells, 40% by default) or `"grid":40`.
  Use `columns`/`rows` only when they say columns, a 12-col grid, or give gutter/margin values.
  Never fake a grid with rectangles; `applyStyle` with `kind:"grid"` applies a saved grid style.
- **rows of items**: build them, then `{"op":"align","nodeIds":[…],"mode":"TOP"}` and
  `{"op":"distribute","nodeIds":[…],"axis":"HORIZONTAL","gap":24}`.
- **depth**: `{"op":"effects","nodeId":"…","shadow":{"y":8,"blur":24,"color":"#00000033"}}` or
  `{"op":"effects","nodeId":"…","blur":{"type":"BACKGROUND","radius":20}}`.
- **gradients**: `{"op":"gradient","nodeId":"…","kind":"linear","angle":135,"stops":[[0,"#8B76FF"],[1,"#0E0E12"]]}`
  — angle 0 is left → right, 90 is top → bottom. Never fake a gradient with stacked rectangles.
- **design system**: `createInstance` with a `COMPONENT` id, then `instanceProps` for variants (read
  the names first) and `instanceText` to change copy without detaching; `applyStyle` for styles. Do not
  redraw what the library already ships, and do not detach an instance to "fix" its text.
- **spacing checks**: `{"op":"measure","a":"1:2","b":"1:3"}` returns gaps per side and centre distance;
  use it instead of exporting a screenshot to judge alignment.
- **image references for editing**: the panel's Edit tab takes **Use selection** (exports the selected
  frame at 2×) or **Add image…** (any number of files; 100 px thumbnails with the file name under
  each one, ✕ to drop one). Over HTTP that is
  `{"mode":"edit","refs":[{"filename","base64"}…],"prompt":…}` on `/image/jobs`, and from a terminal
  `img edit --ref a.png --ref b.png` (repeatable, plus `--ref-url`, `--mask`, `--markup`).
- **masks**: `mask: {filename, base64}` next to `refs`, or `--mask file` in the CLI. fal expects
  **white = the area to change, black = keep**, at the reference's size; the panel paints it
  (**Paint mask…**, brush/erase, `+` for another). Several masks = several
  passes, each on the previous result and with its own instruction; N masks cost N calls.
  References are numbered (`#image1`, `#image2` — badges on the thumbnails, file names under them) and the panel expands
  those into "reference image N (filename)" before sending.
- **several masks = one call**: masks are OR-ed into one white `mask_url`, and a colour-tinted copy of
  the reference is appended as the last image together with a legend naming each colour and its
  instruction. Colours never enter `mask_url` (fal reads only white/black); they are how the prompt
  points at regions. References are numbered (`#image1`, `#image2` — badges and file names on the
  thumbnails) and the
  panel expands those into "reference image N (filename)".
- **styles**: `saveStyle` creates or updates a `text` / `paint` / `effect` / `grid` style by name, and
  `applyStyle` applies it. Create the token once, apply it everywhere.
- **changing type on existing text** is the `text` op — not `exec`, and not loose assignments:
  `{"op":"text","nodeId":"…","fontFamily":"Poppins","fontStyle":"SemiBold","fontSize":40,"lineHeight":48}`.
  A single word keeps the rest intact with `"range":{"start":0,"end":12}`; `"textStyle":"body/25"`
  applies a named style. Style ids are async under `dynamic-page`
  (`node.textStyleId = …` throws) — inside `exec` use `await $.setTextStyle(node, name)`.
- **responsive**: `sizing` sets `HUG`/`FILL`/`FIXED` per axis plus min/max; `constraints` covers
  non-auto-layout children (`STRETCH`/`MIN`/`MAX`/`CENTER`/`SCALE`). Read both from `node` before
  changing them — `sizing` returns `skipped` with Figma's reason when a property does not apply.

## Images

Need artwork? Generate it with the sibling `img-forge` CLI
(https://github.com/iggypcnfsky/img-forge), then place it — generation stays outside
Figma so the API key never enters plugin code and a slow render cannot block the canvas:

```bash
cd ../img-forge
./img gen --prompt "abstract gradient cover, purple to black" --preset 16:9@2k --out out/cover.png
./img edit --prompt "make it night with neon accents" --ref out/cover.png   # or edit an existing asset
cd ../figma-bridge
./bin/figma image 12:34 ../img-forge/out/cover.png FILL
```

`FILL` crops to the node, `FIT` letterboxes, `TILE` repeats, `CROP` respects the existing crop.
To edit what the user selected, export it first (`./bin/figma export <nodeId> out/sel.png PNG 2`) and
pass that file as `--ref`.

The plugin window also has a **Generate / Edit panel** for humans (model, size presets, cost, insert).
Do not drive the panel programmatically — use the CLI; it exposes more (mask, variants, dry run).
Presets saved in that panel live in `figma-bridge/presets.json`.

## Vectors (QuiverAI)

Raster is not always the answer: for icons, logos, diagrams and anything that must survive scaling,
generate **real vectors**. `Generate → Vector` in the panel, or the CLI, calls QuiverAI and lands the
SVG through `createFromSvg` — an editable frame of paths, not a picture in a rectangle.

```bash
./bin/figma svg doctor                     # key set? catalog reachable?
./bin/figma svg models                     # what this key can call (arrow-2 by default)
./bin/figma svg gen "heraldic fox crest, flat two-colour, centred" --out out/fox.svg
./bin/figma svg gen "logo mark for a coffee brand" --ref mood.png --insert
./bin/figma svg trace logo.png --insert    # vectorize: no prompt, trace as-is
./bin/figma svg gen "…" --width 512 --height 512 --insert
```

- Needs `QUIVERAI_API_KEY` in `figma-bridge/.env` (or the environment) — if `figma svg doctor` says it
  is missing, ask the user for a key rather than improvising; the API bills per token.
- Prompt the way you would brief a designer: subject, style, palette (hex), composition, and the exact
  text if lettering matters. References help; name each one's role in the prompt ("palette from the
  second image") because Quiver gets pictures, not `#imageN` placeholders.
- **trace** (vectorization) takes the first reference and ignores the prompt. Crop tightly first —
  cropping beats `auto_crop` and gives cleaner paths.
- Limits: 12 MB, 4096 px per side, 16.7 M pixels per reference; 14 references. The server rejects
  over-limit input before any charge.
- The result is one `<svg>` string. Check it visually (`open out/fox.svg`, or the panel preview) before
  claiming success; the panel shows the token usage and the exact cost after the run.
- You can place any SVG you already have with
  `{"op":"createFromSvg","svg":"<svg …>","width":48,"height":48}`.

## Building on an existing draft

A draft that "isn't finished" still encodes decisions: what sits beside what, what is grouped, the order
of elements, the spacing rhythm. Read it before designing, then keep it.

1. `{"op":"inventory"}` — the frames, their sizes and typography stats.
2. `{"op":"structure","nodeId":"<frame>"}` — children grouped into rows with gaps and a `readingOrder`;
   that is the grouping the author chose. `{"op":"node",…,"depth":2}` gives the same tree with more depth.
3. Note the pattern (a left margin that repeats, a title that always sits above three columns) and keep
   it. Change what the request needs, leave the rest where it is.
4. Report the deviations you did make — "moved the footer up by 40", not just "improved the layout".

Never normalise a draft silently. If consistency would require moving things the user placed, say so and
ask; a tidy-looking slide that lost their groupings is a regression, not an improvement.

## Rules

- **Read before write.** Two calls minimum: inspect, then mutate.
- **One batch = one thought.** An op cannot reference a previous op's result, so if you need the
  new node's `id`, split into two calls.
- **Respect the arrangement you inherit**: sibling order, proximity and grouping are intent. Do not
  re-flow a draft to look tidier unless asked; ask first when consistency would move their elements.
- **Never touch existing user layers** (`update`, `remove`, `reparent`) without explicit instruction.
  Prefix your own creations: `Bridge / …`.
- **A rework goes right beside the original, as close as possible.** Asked to redo a
  slide/screen/section: duplicate it, call
  `{"op":"placeNear","nodeId":"<new id>","move":true,"gap":80,"name":"Bridge / v2 — <name>"}` so the
  copy lands on the first free side instead of a guessed coordinate, and leave the original untouched.
  If the tool reports `free: false`, ask where it should go. Replace elements in place only when the
  user explicitly asks for that.
- **`goto` changes the user's view** — only on request.
- **`exec` is a last resort.** It works (Figma's sandbox allows `new Function`) and bypasses all
  parameter validation. Return JSON-serializable values only.
- **Clean up** test artifacts, or ask whether to keep them.

## Pitfalls

- Use `localhost`, never `127.0.0.1`: the plugin manifest allowlists only `http://localhost:3847`
  (`devAllowedDomains`); Figma rejects IPs. Server listens on both `127.0.0.1` and `::1`.
- `figma.currentPage` is the page open in that Figma window — not a saved pointer. Switching tabs
  changes what you see on the next call.
- Positions are relative to the parent, and an omitted `parentId` means the **current page**.
- Typography questions (which fonts, sizes, counts) are one call: `{"op":"fonts"}`; add
  `"allPages":true` for the whole file. Do not walk frames with your own script.
- A slide deck overview is one call too: `{"op":"inventory"}` returns every frame with geometry,
  `minFontSize`, fonts, grid count and fills — enough to pick "frames 11–19" or find text below a
  minimum size.
- `figma.mixed` is a symbol: on TEXT, `fills`/`strokes`/`fontSize` can be mixed values, so
  `node.fills.map(...)` throws `not a function`. Guard with `Array.isArray()` or `$.paints(node)`;
  use `node.getRangeFills(0, 1)` when you need per-range detail.
- `figma run` / `figma op` exit 1 and print the failure on stderr. A failed op has no `value` in its
  result — check `ok` before `results[0].value`, and never assume a key exists: `undefined` is dropped
  from JSON, so Python needs `.get()` and scripts should emit explicit `null`s.
- Never index a field the reference does not list. `summary` carries `font`, `fontSize`, `lineHeight`
  and `letterSpacing` for TEXT; everything else comes from `exec` with the real API name. Mixed styles
  are the string `"MIXED"`, so guard with `.get()` and fallbacks.
- A rectangle cannot have children; use a frame when text or icons must sit inside a shape.
- No local variables → `variables` returns `collections: []` and `varFill` fails. Check first.
- Text needs a font: `createText` loads it via `loadFontAsync`; if the family is missing, use `Inter`.
- `export` caps at 8 MB — lower `scale` instead of retrying.
- Reading children of a non-current page needs `loadAllPagesAsync`; the bridge retries once
  automatically, but prefer `find` with `allPages: true`.
- After editing plugin files (`code.js`, `ui.html`) the user must re-run the plugin; changes to
  `manifest.json` need a re-import.
