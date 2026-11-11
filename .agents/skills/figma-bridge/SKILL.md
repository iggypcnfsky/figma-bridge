---
name: figma-bridge
description: Drive a Figma file through the local Figma Bridge — read the selection, build frames/text/shapes, bind variables, export PNG/SVG. Use when a task requires touching a Figma canvas (inspect a design, implement UI in Figma, swap colors to tokens, export an asset). Requires the bridge server on localhost:3847 and the Figma Bridge plugin running in the target file; if unavailable, do not improvise — ask the user to start them.
whenToUse: The user points at a Figma file, asks to build or edit something in Figma, or asks what is on the canvas. Not for reading Figma links without the plugin running.
---

# Figma Bridge

Figma has no public write API. This skill uses a local bridge: named operations over HTTP,
executed inside Figma by a plugin, through the Figma Plugin API. No OAuth, no tokens.

**Repo:** https://github.com/iggypcnfsky/figma-bridge — `AGENTS.md`, `docs/ops-reference.md`.

## Preconditions — check before anything else

```bash
cd <repo>/figma-bridge
./bin/figma status     # {"ok":true,"pluginConnected":true,...}
```

- `pluginConnected: false` → stop. Ask the user to run `Plugins → Development → Figma Bridge`
  in the window of the file they want touched. Retrying does not help.
- `503` from `/run` means the same thing. `504 PLUGIN_GONE` means they closed the plugin window.

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

Need artwork? Generate it with the sibling `img-forge` CLI, then place it:
`img-forge gen --prompt "…" --preset 16:9@2k --out out/cover.png` → `./bin/figma image <nodeId> out/cover.png FILL`.

Ops: `ping status pages variables styles` · `selection node find` · `createFrame createRect
createEllipse createText createPage` · `update clone reparent remove goto` · `varFill` ·
`export imageFill` · `exec`. Full parameters: `docs/ops-reference.md`.

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
- No local variables → `variables` returns `collections: []` and `varFill` fails. Check first.
- Text needs a font: `createText` loads it via `loadFontAsync`; if the family is missing, use `Inter`.
- `export` caps at 8 MB — lower `scale` instead of retrying.
- After editing plugin files (`code.js`, `ui.html`) the user must re-run the plugin; changes to
  `manifest.json` need a re-import.
