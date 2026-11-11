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

```bash
cd <repo>/figma-bridge
./bin/figma status     # {"ok":true,"pluginConnected":true,"clients":[...]}
./bin/figma clients    # id, file, page of every connected Figma window
```

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

Ops: `ping status pages variables styles` · `selection node find` · `createFrame createRect
createEllipse createText createPage` · `update clone reparent remove goto` · `varFill` ·
`export imageFill` · `exec`. Full parameters: `docs/ops-reference.md`.

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
