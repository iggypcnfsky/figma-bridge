# AGENTS.md — Figma Bridge

Instructions for AI agents. If this file was handed to you as context: this is the operating manual
for the bridge into Figma. Read **Rules** before your first call.

## What this is

A local agent ↔ Figma bridge. The agent sends named operations, a plugin inside Figma executes them
through the Figma Plugin API and returns the results. No OAuth, no tokens, no cloud.

```
agent ──HTTP──▶ server.mjs (localhost:3847) ◀──long-poll── plugin/ui.html
                        │                                        │
                        └──────── {ops:[…]} ─────────────────────┴─▶ plugin/code.js ─▶ figma.*
```

## Preconditions (check before you start)

**Do not hunt for this repo.** `figma` is installed on `PATH` (symlink in `~/.local/bin`), so every
command works from any directory:

```bash
figma doctor     # repo path, server state, connected Figma windows, img-forge + FAL key, QuiverAI key
figma rules      # constraints for the connected Figma file: type floor, grid, frame size
```

`figma rules` is the difference between "make it look consistent" and actually matching the house
style. Read it before any design work. The output merges `default` with a per-file entry matched by the
connected window's name and reports it as `matchedFile`; if it returns `{}`, ask the user for the floor
values instead of inventing or borrowing them. Anything marked `"confirmed": false` is an assumption
you must verify.

If `figma` is missing, the absolute path is printed by the skill or recoverable with
`figma where`; as a last resort the repo lives next to this workspace checkout. Only then fall back to
starting the server yourself.

1. The server is up: `figma status` → `{"ok":true,...}`.
   If not: `figma serve` — starts it detached (the DSH plugin also spawns one, but stops that child
   when the plugin unloads, which is why the panel can say "No server" after a reload).
2. In Figma (desktop app), in the target file's window, the **Plugins → Development → Figma Bridge**
   plugin is running. The plugin window must stay open — it *is* the connection.
3. `pluginConnected: true` in `/status`. If it is `false`, do not send operations — you will get 503.

## CLI

```bash
./bin/figma status                       # bridge + plugin (JSON)
./bin/figma ping                         # is the plugin answering
./bin/figma selection [depth]            # what the user has selected
./bin/figma pages                        # page list
./bin/figma variables                    # local collections and variables
./bin/figma op '{"op":"status"}'         # a single operation
./bin/figma run '[{"op":"…"},{"op":"…"}]'  # a batch; exits 1 with the reason when an op fails
./bin/figma export <nodeId> <file> [PNG|JPG|SVG|PDF] [scale]
./bin/figma image <nodeId> <file> [FILL|FIT|TILE|CROP]   # image file → fill, no cloud upload
./bin/figma svg gen "prompt" [--ref f.png] [--out x.svg] [--insert]   # QuiverAI → real vectors
./bin/figma svg trace logo.png [--insert]                # raster → paths
```

`FIGMA_BRIDGE_URL` overrides the address (default `http://127.0.0.1:3847`).

### Other MCP clients (opencode, Claude Code, Codex)

`mcp.mjs` is a stdio MCP server that wraps this CLI — same `bin/figma`, same `rules.json`, same
agent identity, so an MCP client cannot behave differently from a shell agent. Register it under the
client's `mcp` config as `command: ["node", "<repo>/mcp.mjs"]`; set `FIGMA_AGENT` in its environment
so the panel shows who is on the canvas. Tools: `figma_status`, `figma_clients`, `figma_agents`,
`figma_rules`, `figma_selection`, `figma_pages`, `figma_variables`, `figma_run`, `figma_export`,
`figma_place_image`, `figma_serve`, `img_models`, `img_generate`, `img_edit`.

Vectors (`figma svg …`), job management and batch targeting stay CLI-only — the tool count is
deliberately small so a 20-tool context does not cost more than the work.


## HTTP contract

`POST /run`

```json
{ "ops": [ { "op": "createFrame", "name": "Card", "width": 320, "height": 200 } ],
  "dryRun": false,
  "timeoutMs": 120000 }
```

Response `200` (all good) or `500` (an operation failed):

```json
{ "id": "uuid", "ok": true,
  "results": [ { "index": 0, "op": "createFrame", "ok": true, "value": { "id": "12:34" } } ] }
```

- The first error **aborts** the chain; `results` contains everything up to the failure.
- `503` = plugin not connected (retrying without human action is pointless).
- `504` with `code: "PLUGIN_TIMEOUT"` = the plugin did not answer within `timeoutMs`.
- `504` with `code: "PLUGIN_GONE"` = the plugin vanished mid-run (window closed / crash).

`GET /status` → `{ ok, pluginConnected, pollPending, lastPollAt, queued, inFlight }`.

Image generation (optional; needs a `FAL_KEY` and the sibling CLI,
<https://github.com/iggypcnfsky/img-forge>):

- `GET /image/models`, `GET /image/schema?model=…`, `POST /image/jobs`, `GET /image/jobs/:id`
- `POST /image/jobs` with `mode: "edit"` takes `refs: [{filename, base64}, …]` — any number; the server
  writes each to the job dir and passes one `--ref` per image. In the panel: **Edit → Use selection**
  (exports the selected frame at 2×) or **Add image…** (files from disk, several at once)
- optional `mask: {filename, base64}` — a PNG **exactly the size of the first reference** where
  **white = change, black = keep** (a mismatch is rejected with 400 before any call; CLI flag
  `--mask`, plus `--markup`). The panel paints it over the first reference (**Paint mask…**,
  brush/erase, clear) and sends it at reference size.
- one request carries one mask, so with several masks the panel combines them: the masks are OR-ed
  into one white `mask_url`, and a colour map of the reference (each area tinted with its mask colour)
  is appended as the **last reference** with a legend in the prompt. One call, one price.
  Instructions may reference references as `#image1`, `#image2` … (the panel expands them to
  "reference image N (filename)" — the model needs words, the API only keeps order).
  Colours are a message to the model, never part of the mask: fal reads only white (change) and
  black (keep).
- no token; requests carrying a foreign `Origin` get 403, and each job is capped by `--max-usd`
- a job spawns `img-forge` and returns `{status, log, result:{file, base64, width, height}}`
- image jobs run in parallel: `IMAGE_CONCURRENCY` (default 3, max 8) `img-forge` processes; `/status`
  reports `image: {running, queued, concurrency}`
- the panel snapshots each run's references, masks, size and model before submitting, so reopening a
  job reproduces its inputs (last 15 runs kept; the payload itself lives on the server for 30 min)
- if you can run the CLI directly, do that instead — the endpoint exists for the Figma panel,
  which humans use from the plugin window (Generate / Edit tabs, insert-as-rectangle or fill)

Vector generation (optional; needs a QuiverAI key — <https://platform.quiver.ai/api-keys>) puts real
SVG paths on the canvas instead of pixels. `QUIVERAI_API_KEY` goes in `figma-bridge/.env` (gitignored;
`.env.example` shows the shape) or the environment — never in the manifest, which still only knows
`localhost`. `figma doctor` reports whether the key is present.

- `GET /svg/models` — catalog, each model's `supported_operations` (`svg_generate`, `svg_vectorize`)
  and token rates; `usable.generate` / `usable.vectorize` list what this key can call
- `POST /svg/jobs` `{mode: "generate"|"vectorize", model, prompt, refs: [{filename, base64}], …}` and
  `GET /svg/jobs/:id` → `{status, log, result:{svg, width, height, usage, cost, model}}`
- `generate` designs something new; up to 14 references guide it (no `#imageN` placeholders — Quiver
  takes images, not names, so say what each reference is in the prompt). `vectorize` ("trace" in the
  panel) takes the **first** reference and converts it to paths; it ignores the prompt
- one run returns one SVG string, which `createFromSvg` turns into editable Figma vectors
- input limits, checked before the request: ≤ 12 MB decoded, ≤ 4096 px per side, ≤ 16.7 M pixels per
  reference. The panel downscales big references itself; the server rejects what is still too large
- billing is per token, not per image: `usage` comes back with the result and the server multiplies it
  by the rates from `/svg/models` → `result.cost` in USD. A run typically costs a few cents
- `/status` adds `svg: {running, queued, concurrency, configured}`, `SVG_CONCURRENCY` defaults to 2
- CLI: `figma svg models|doctor|gen|trace`, e.g.
  `figma svg gen "minimal line-art fox" --out out/fox.svg --insert` or
  `figma svg trace logo.png --insert`. `--insert` places it as real vectors, `--out` keeps the SVG
- prefer the CLI over the HTTP endpoints; the endpoints exist for the panel

## Several Figma windows at once

Each plugin window reports an id, file and page on every poll, so the server can route precisely
instead of guessing.

```bash
./bin/figma clients                       # id, file, page, uptime
./bin/figma --file "Deck" ping            # target by file name
./bin/figma --client c1a2b3 ping          # target by client id
FIGMA_BRIDGE_FILE="Deck" ./bin/figma run '[…]'
```

- one connected window → it is used automatically;
- more than one and no target → `409` listing the clients. **Do not retry blindly**: ask which file the
  user means, or read the file name from their prompt, then pass `--file`;
- `409` also when the named file is not connected or two windows are open on it (then use `--client`).

## Several agents on one canvas

Yes, and the bridge now keeps it honest. Two agents (or three) can post operations against the same
Figma file; what they cannot do is run **inside each other's batch**.

- A plugin window executes one batch at a time. The server hands it a job, marks the window busy and
  dispatches the next one only when `/result` comes back; the plugin also queues `run` messages, so
  even a direct double send cannot interleave two batches.
- Different windows still run in parallel — they are separate lanes, which is why `--file`/`--client`
  matter.
- Image generation (`img gen` / the panel) does not occupy the canvas lane at all; only `/run` does.

What is still yours to handle — the bridge cannot see intent:

1. **Reads go stale between batches.** Another agent's batch may have changed the tree after your
   `selection`/`node`. Re-read the node right before a write that depends on it, or verify by
   re-reading after (the operations return ids, not state).
2. **Same node, two agents = last write wins.** Partition by frame subtree, not by "I'll be quick".
3. **⌘Z is per batch, not per agent.** The user's undo history interleaves your batches; long
   sequences are harder to take back. Keep batches small.
4. **A long batch blocks the other agents** on that window: the queue waits, and the CLI gives up
   after `timeoutMs` (default 120 s). Do not run a `for` loop over 200 nodes inside one `exec`.

```bash
figma clients     # busy: <job id> while a window is executing a batch
figma status      # "busy": [{client, job}], "agents": [{id, name, runs, ops}]
figma agents      # who is on this canvas, with a live/idle state per agent
```

### Identities

An agent identifies itself so the user (and the other agents) can tell who did what:

- CLI: `--agent <name>` or `FIGMA_AGENT=<name>`; the value travels as the `x-agent` header.
- A readable name next to that id: `--label "…"` / `FIGMA_AGENT_LABEL` → `x-agent-label`
  (percent-encoded, so Polish characters and emoji survive). A name set in the panel beats it.
- Under DSH the session id is used automatically (`dsh:<session>`), so two sessions are already two
  agents without configuration. A plain shell without either falls back to `cli`.
- The panel's **Agents** tab lists them, renames them, forgets them, and mints a new id with the exact
  command to run (`FIGMA_AGENT=agent-3 figma status`). Names live in server memory — a restart resets
  them to their ids, and agents idle for 12 h drop off the list.
- DSH chat titles are **not** readable from the bridge (a session persists a header, the title lives in
  the GUI), so pass the label: `FIGMA_AGENT_LABEL="Figma bridge panel — resize" figma …`.

If you need true isolation for a big build, ask the user to open the plugin in a second Figma window
of the same file and target it with `--client`; the two lanes then work independently.

## Operations

Full parameters and return shapes: [`docs/ops-reference.md`](docs/ops-reference.md).

| Group | Operations |
|---|---|
| Diagnostics | `ping`, `status`, `pages`, `variables`, `styles`, `fonts`, `inventory` |
| Read | `selection`, `node`, `find`, `inventory` |
| Create | `createFrame`, `createRect`, `createEllipse`, `createText`, `createPage`, `createInstance` |
| Components | `instanceText`, `instanceProps` |
| Modify | `update`, `text`, `clone`, `reparent`, `remove`, `goto`, `group`, `ungroup`, `select` |
| Layout | `grids`, `setGrids`, `align`, `distribute`, `constraints`, `sizing`, `effects`, `gradient` |
| Measure/place | `measure`, `placeNear` |
| Styles | `styles`, `saveStyle`, `applyStyle`, `varFill` |
| Assets | `export` (base64 → file), `imageFill` (base64 → fill), `createFromSvg` (SVG → vector nodes) |
| Full API | `exec` — arbitrary JS with `figma` in scope |

## Rules

1. **Read before you write.** `status` → `selection`/`node`/`find` → only then mutating operations.
   Never guess a `nodeId` or the structure — the tree is in `selection`/`node`.
2. **Do not touch someone else's layers without consent.** `update`, `remove`, `reparent` on existing
   user content only on an explicit instruction. Create new things alongside, prefixed
   (`Bridge / …`), so they can be found and deleted.
3. **Feedback is an edit, not a rebuild.** "This is wrong", "move X", "too small", "change the copy"
   asks you to fix the smallest thing that is wrong, **in place**: re-read the node, change that
   property (`update`, `text`, `align`, `sizing`), render, and leave every other layer, slide and id
   alone. Do not delete and recreate the slide, do not re-flow the deck, and do not "start clean"
   because a batch failed.
   A **new version** is a different request: only when the user asks for one ("v2", "another option",
   "redo the whole thing"), clone the original, place the copy immediately beside it with `placeNear`,
   name it `Bridge / v2 — <name>`, and leave the original untouched.
   Deleting frames, sections, pages, groups or components needs an explicit "delete/remove"
   instruction — the `remove` op refuses structural nodes without `confirm:true`. If a batch failed
   halfway, read what already exists and continue; never "clean up" by deleting partial work.
4. **The draft's arrangement is intent, not noise.** When building on existing work, read how it is
   already grouped, ordered and placed — sibling order, proximity, alignment, group and frame names,
   what sits next to what — and keep that structure. A rough draft is still a decision trail. Move only
   what the request requires, and state which parts you moved and why. If the current structure
   conflicts with the goal, propose the change instead of re-flowing everything "to make it
   consistent".
5. **One batch = one thought.** An operation cannot use a previous operation's result (there is no
   templating), so when you need a new node's `id`, split into two calls.
6. **Verify with a render.** After building anything visual, `export` a PNG and look at the image.
   That is the only way to see what actually came out.
7. **`exec` is a last resort.** It works (the sandbox allows `new Function`), but it bypasses all
   parameter validation. Use it when an operation is missing; the result must be JSON-serializable.
8. **Do not guess pages.** `goto` changes the user's view — only on request.
9. **Leave no litter.** After testing, remove what you created.
10. **Keep tracked files project-agnostic.** Skills, README, AGENTS and examples are shared: no
   client, project or file names in them ("the deck", "the target file", not a real name). This
   project's constraints live in `rules.json`, which is gitignored: `default` is the house style
   used for every Figma file, `files` holds optional per-file overrides matched by the connected
   window's name. `figma rules` merges them and adds `matchedFile`. `{}` means ask the user for the
   floor values — never borrow another file's rules or invent them.

## Pitfalls (verified in practice)

- **`localhost`, not `127.0.0.1`.** The plugin manifest allows only `http://localhost:3847`
  (`devAllowedDomains`); Figma rejects IPs. The server listens on `127.0.0.1` **and** `::1`, because
  on macOS `localhost` resolves to IPv6 first.
- **`figma.currentUser` needs `permissions: ["currentuser"]`.** The code has a fallback, so `status`
  never fails, but `user` may be `null` if the manifest was not re-imported with that permission.
- **No variables is not a bridge error.** `variables` may return `collections: []` — then `varFill`
  has nothing to bind. Check `variables` first.
- **Style ids are asynchronous.** The manifest runs with `documentAccess: "dynamic-page"`, so
  `node.textStyleId = style.id` (and `fillStyleId`, `effectStyleId`, `gridStyleId`) throws
  `Cannot call with documentAccess: dynamic-page`. Use the `text` op, `applyStyle`, or inside `exec`
  the `$` helpers (`$.setTextStyle(node, name)`). The bridge translates that error into this advice.
- **Changing type on an existing node is `text`, not `update`.** `update` still accepts `fontName`,
  `fontSize`, `lineHeight` and `characters` (it delegates), but `text` also handles `range`,
  `textStyle` and per-property `changed`/after-state reporting.
- **Text needs a font.** `createText` calls `loadFontAsync` itself; if the family is neither in the
  file nor installed locally, the operation fails on the font — use `Inter` as a safe default.
- **`figma.mixed` is a symbol, not an array.** On a TEXT node `fills`, `strokes`, `fontSize` and
  `fontName` can be `figma.mixed` when ranges differ; `node.fills.map(...)` then dies with
  `not a function`. Guard with `Array.isArray(...)`, use `$.paints(node)` in `exec`, or read
  `node.getRangeFills(...)` for the ranges.
- **`figma.getNodeById` is synchronous and throws under `dynamic-page`.** Use
  `await figma.getNodeByIdAsync(id)` or `$.node(id)` in `exec`. The bridge's own `node`/`selection`/`find`
  already use the async variant, so only hand-written `exec` scripts hit this.
- **A failed op has no `value`.** `results[i]` is `{ ok: false, error }` — indexing `.value` gives
  `KeyError`/`undefined` and hides the real message. Check `ok` first. `figma op` and `figma run` now
  exit **1** and print the error on stderr, which stops a shell pipeline before that happens.
- **`undefined` disappears from JSON.** `exec` results are serialized, so `{ chars: undefined }` has
  no `chars` key at all. Emit explicit `null`s and read with `.get()` in Python.
- **Read the documented fields, do not assume them.** A script that indexes `result['lh']` or any
  field the reference does not list fails with `KeyError` — that is the script's bug, not the bridge's.
  `node`/`selection` expose `font`, `fontSize`, `lineHeight`, `letterSpacing` for TEXT nodes; anything
  else (effects, constraints, component properties) needs `exec` with the real Plugin API name.
- **Positions are relative to the parent.** A node without `parentId` lands on the **current page**,
  and `x`/`y` are in the parent's coordinate space.
- **`export` caps at 8 MB** — lower `scale` instead of retrying.
- **`figma.currentPage` is the page open in the Figma window**, not a "last used" pointer.
- **`documentAccess: "dynamic-page"`** — reading children of a page other than the current one
  requires that page to be loaded. The bridge catches exactly that error, calls
  `loadAllPagesAsync()` and retries the operation once, so you normally do not need to think about
  it. For bulk lookups prefer `find` with `allPages: true` anyway.
  Caveat: the retry is per operation — an `exec` that already changed something before throwing may
  repeat part of its work.

## Repo layout

```
figma-bridge/
  AGENTS.md            ← this file
  README.md            ← human-facing version
  server.mjs           ← queue + long-poll (no dependencies, Node ≥ 20)
  mcp.mjs              ← the same bridge as MCP tools (stdio), for opencode/Claude Code
  bin/figma            ← CLI
  plugin/manifest.json ← Figma manifest
  plugin/code.js       ← operations on the Figma Plugin API
  plugin/ui.html       ← long-poll client + status bar
  docs/ops-reference.md ← full parameter reference
  docs/handoff-prompt.md ← ready-to-paste prompt for another agent
  docs/assets/         ← demo GIF and screenshots
  .agents/skills/figma-bridge/SKILL.md ← skill (auto-loaded by DSH)
  scripts/mock-plugin.mjs ← protocol test without Figma
  scripts/test-typography.mjs ← unit test: text/update/applyStyle against a fake Figma API
  scripts/test-serialisation.mjs ← one batch per window, parallel windows
  scripts/test-agents.mjs ← agent registry: two agents, busy, mint, rename, forget
  scripts/test-image-job.mjs ← dry-run edit job: two refs + mask reach the payload
  scripts/test-svg-job.mjs ← QuiverAI stub: refs, trace, validation, cost
  scripts/svg-cli.mjs  ← `figma svg …` (generate, trace, insert)
  lib/quiver.mjs       ← QuiverAI client: key, catalog, generate, vectorize, token cost
  scripts/demo-build.sh / make-demo-gif.py ← reproduce the demo GIF
  out/                 ← exports (gitignored)
```
