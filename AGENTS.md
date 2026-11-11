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
figma doctor     # repo path, server state, connected Figma windows, img-forge + FAL key
figma rules      # this project's constraints: type floor, grid, frame size, version naming
```

`figma rules` is the difference between "make it look consistent" and actually matching the house
style. Read it before any design work; if it returns `{}`, ask the user for the floor values instead of
inventing them. Anything marked `"confirmed": false` is an assumption you must verify.

If `figma` is missing, the absolute path is printed by the skill or recoverable with
`figma where`; as a last resort the repo lives next to this workspace checkout. Only then fall back to
starting the server yourself.

1. The server is up: `figma status` → `{"ok":true,...}`.
   If not: `node "$(figma where)/server.mjs" &` (a DSH plugin normally keeps it running).
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
./bin/figma run '[{"op":"…"},{"op":"…"}]'  # a batch of operations
./bin/figma export <nodeId> <file> [PNG|JPG|SVG|PDF] [scale]
./bin/figma image <nodeId> <file> [FILL|FIT|TILE|CROP]   # image file → fill, no cloud upload
```

`FIGMA_BRIDGE_URL` overrides the address (default `http://127.0.0.1:3847`).

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
- optional `mask: {filename, base64}` — a PNG the size of the reference where **white = change, black =
  keep** (fal's `mask_url` semantics; the CLI flag is `--mask`, plus `--markup`). The panel paints it
  over the first reference (**Paint mask…**, brush/erase, clear) and sends it at reference size.
- no token; requests carrying a foreign `Origin` get 403, and each job is capped by `--max-usd`
- a job spawns `img-forge` and returns `{status, log, result:{file, base64, width, height}}`
- if you can run the CLI directly, do that instead — the endpoint exists for the Figma panel,
  which humans use from the plugin window (Generate / Edit tabs, insert-as-rectangle or fill)

## Several Figma windows at once

Each plugin window reports an id, file and page on every poll, so the server can route precisely
instead of guessing.

```bash
./bin/figma clients                       # id, file, page, uptime
./bin/figma --file ITHAKA ping            # target by file name
./bin/figma --client c1a2b3 ping          # target by client id
FIGMA_BRIDGE_FILE=ITHAKA ./bin/figma run '[…]'
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
- Under DSH the session id is used automatically (`dsh:<session>`), so two sessions are already two
  agents without configuration. A plain shell without either falls back to `cli`.
- The panel's **Agents** tab lists them, renames them, forgets them, and mints a new id with the exact
  command to run (`FIGMA_AGENT=agent-3 figma status`). Names live in server memory — a restart resets
  them to their ids, and agents idle for 12 h drop off the list.

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
| Assets | `export` (base64 → file), `imageFill` (base64 → fill) |
| Full API | `exec` — arbitrary JS with `figma` in scope |

## Rules

1. **Read before you write.** `status` → `selection`/`node`/`find` → only then mutating operations.
   Never guess a `nodeId` or the structure — the tree is in `selection`/`node`.
2. **Do not touch someone else's layers without consent.** `update`, `remove`, `reparent` on existing
   user content only on an explicit instruction. Create new things alongside, prefixed
   (`Bridge / …`), so they can be found and deleted.
3. **A rework is a new artefact, close to the original.** When asked to redo a slide, screen or
   section, duplicate the original, place the result **immediately beside it** — as close as the free
   space allows, never overlapping it — and name it `Bridge / v2 — <original name>`. Get the spot from
   `placeNear` (it scans the siblings and returns the first free side) instead of guessing
   coordinates; when no side is free, ask the user. Edit the original in place **only** when the user
   says to replace something on it.
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
  scripts/demo-build.sh / make-demo-gif.py ← reproduce the demo GIF
  out/                 ← exports (gitignored)
```
