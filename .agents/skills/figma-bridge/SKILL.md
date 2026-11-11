---
name: figma-bridge
description: "Drive a Figma file through the local Figma Bridge — read the selection, build frames, text and shapes, bind variables, place images, export PNG/SVG. Use when a task requires touching a Figma canvas (inspect a design, implement UI in Figma, swap colors to tokens, export an asset, insert generated artwork). Requires the bridge server on localhost:3847 and the Figma Bridge plugin running in the target file; if unavailable, do not improvise — ask the user to start them."
whenToUse: "The user points at a Figma file, asks to build or edit something in Figma, asks what is on the canvas, or wants generated artwork placed there."
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
```

If the command is missing, use `node "$(figma where)/server.mjs"` only after asking; do not `find` the
repo, and do not guess paths.

- `pluginConnected: false` → stop. Ask the user to run `Plugins → Development → Figma Bridge`
  in the window of the file they want touched. Retrying does not help.
- `503` from `/run` means the same thing. `504 PLUGIN_GONE` means they closed the plugin window.
- `409` means several Figma windows are connected and none was chosen. Pick the file the user named
  (`--file <NAME>`) or a client id (`--client <ID>`); never retry blindly, or you may edit the wrong file.

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
```

Ops: `ping status pages variables styles fonts inventory` · `selection node find` · `createFrame createRect
createEllipse createText createPage createInstance` · `update clone reparent remove goto group ungroup
select` · `grids setGrids align distribute effects` · `applyStyle varFill` · `export imageFill` · `exec`.
Full parameters: `docs/ops-reference.md`.

Design-work shortcuts worth knowing:

- **grid**: `{"op":"setGrids","nodeId":"…","columns":{"count":12,"gutter":24,"margin":64}}` — do not
  fake a grid with rectangles.
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
- **styles**: `saveStyle` creates or updates a `text` / `paint` / `effect` / `grid` style by name, and
  `applyStyle` applies it. Create the token once, apply it everywhere.
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

## Rules

- **Read before write.** Two calls minimum: inspect, then mutate.
- **One batch = one thought.** An op cannot reference a previous op's result, so if you need the
  new node's `id`, split into two calls.
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
