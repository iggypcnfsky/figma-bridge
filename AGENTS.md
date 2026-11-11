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

1. The server is up: `curl -s localhost:3847/status` → `{"ok":true,...}`.
   If not: `cd figma-bridge && node server.mjs &` (or run it as a background job).
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

## Operations

Full parameters and return shapes: [`docs/ops-reference.md`](docs/ops-reference.md).

| Group | Operations |
|---|---|
| Diagnostics | `ping`, `status`, `pages`, `variables`, `styles` |
| Read | `selection`, `node`, `find` |
| Create | `createFrame`, `createRect`, `createEllipse`, `createText`, `createPage` |
| Modify | `update`, `clone`, `reparent`, `remove`, `goto` |
| Tokens | `varFill` |
| Assets | `export` (base64 → file), `imageFill` (base64 → fill) |
| Full API | `exec` — arbitrary JS with `figma` in scope |

## Rules

1. **Read before you write.** `status` → `selection`/`node`/`find` → only then mutating operations.
   Never guess a `nodeId` or the structure — the tree is in `selection`/`node`.
2. **Do not touch someone else's layers without consent.** `update`, `remove`, `reparent` on existing
   user content only on an explicit instruction. Create new things alongside, prefixed
   (`Bridge / …`), so they can be found and deleted.
3. **One batch = one thought.** An operation cannot use a previous operation's result (there is no
   templating), so when you need a new node's `id`, split into two calls.
4. **Verify with a render.** After building anything visual, `export` a PNG and look at the image.
   That is the only way to see what actually came out.
5. **`exec` is a last resort.** It works (the sandbox allows `new Function`), but it bypasses all
   parameter validation. Use it when an operation is missing; the result must be JSON-serializable.
6. **Do not guess pages.** `goto` changes the user's view — only on request.
7. **Leave no litter.** After testing, remove what you created.

## Pitfalls (verified in practice)

- **`localhost`, not `127.0.0.1`.** The plugin manifest allows only `http://localhost:3847`
  (`devAllowedDomains`); Figma rejects IPs. The server listens on `127.0.0.1` **and** `::1`, because
  on macOS `localhost` resolves to IPv6 first.
- **`figma.currentUser` needs `permissions: ["currentuser"]`.** The code has a fallback, so `status`
  never fails, but `user` may be `null` if the manifest was not re-imported with that permission.
- **No variables is not a bridge error.** `variables` may return `collections: []` — then `varFill`
  has nothing to bind. Check `variables` first.
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
  scripts/demo-build.sh / make-demo-gif.py ← reproduce the demo GIF
  out/                 ← exports (gitignored)
```
