# Figma Bridge

![Agent building a card in Figma, step by step](docs/assets/demo.gif)

A local bridge between an AI agent and Figma. The agent sends named operations; a Figma plugin
executes them through the Figma Plugin API and returns the results. No dependencies, no OAuth,
no cloud.

On top of that, the same plugin window is an **image panel** backed by
`img-forge` (a sibling checkout, not yet published): generate or edit images with fal.ai models and
drop them straight onto the canvas.

**For agents:** [`AGENTS.md`](AGENTS.md) is written to be loaded as context.
**Drop-in prompt for another agent:** [`docs/handoff-prompt.md`](docs/handoff-prompt.md).
**Skills:** [`.agents/skills/figma-bridge/SKILL.md`](.agents/skills/figma-bridge/SKILL.md) and the
sibling `img-forge` skill.

## Why not the official Figma MCP

| | Figma Bridge | official remote MCP | official desktop MCP |
|---|---|---|---|
| Writes to the canvas | yes | yes | **no** |
| OAuth / tokens | none | yes | none |
| Client allowlist | not applicable | yes | no |
| Requirements | Node ≥ 20 + Figma desktop | paid plan | Dev/Full seat on a paid plan |
| Context cost in the agent | 1 tool (`run`) | ~30 tool definitions | ~10 |
| Coupled to Figma's decisions | no | high | medium |

What it cannot do by itself: create files in the cloud, capture live UI, FigJam diagrams, shaders,
Weave — those are server-side Figma features, not part of the Plugin API. Image generation is not a
Figma feature at all; that is what the `img-forge` pairing adds.

## How it works

```
agent ──HTTP──▶ server.mjs (localhost:3847) ◀──long-poll── plugin/ui.html
                        │                                        │
                        ├── {ops:[…]} ────────────────────────────┴─▶ plugin/code.js ─▶ figma.*
                        └── image jobs ──▶ img-forge CLI ──▶ fal.ai
```

- `server.mjs` — job queue plus long-poll, no WebSockets, no npm packages.
- `bin/figma` — CLI: `status`, `ping`, `selection`, `pages`, `variables`, `op`, `run`, `export`, `image`.
- `plugin/code.js` — around 20 operations: frames, text, shapes, `update`, `clone`, `reparent`,
  `remove`, `export`, `imageFill`, `variables`, `varFill`, `exec`.
- `plugin/ui.html` — the status bar and the image panel.

## Install

Requires Node ≥ 20 and the Figma desktop app.

```bash
# 1. server
cd figma-bridge
node server.mjs            # leave it running (port 3847)

# 2. plugin in Figma
#    Plugins → Development → Import plugin from manifest… → plugin/manifest.json
#    Plugins → Development → Figma Bridge   (in the file you want the agent to work on)

# 3. verify
./bin/figma status         # pluginConnected: true
./bin/figma selection
```

The plugin window must stay open — it *is* the connection. Closing it disconnects the bridge.
After editing plugin files, re-run the plugin; manifest changes require a re-import.

## Usage

```bash
./bin/figma selection 2
./bin/figma op '{"op":"createFrame","name":"Card","width":320,"height":200,"fill":"#0B0B0F","props":{"cornerRadius":16,"layoutMode":"VERTICAL","paddingTop":24,"itemSpacing":12}}'
./bin/figma run '[
  {"op":"createText","parentId":"12:34","characters":"Title","fontSize":24,"color":"#FFFFFF"},
  {"op":"createFrame","parentId":"12:34","name":"CTA","width":108,"height":36,"fill":"#6E56CF","props":{"cornerRadius":18,"layoutMode":"HORIZONTAL","primaryAxisAlignItems":"CENTER","counterAxisAlignItems":"CENTER"}}
]'
./bin/figma export 12:34 out/card.png PNG 2
./bin/figma image 12:34 out/cover.png FILL     # local image file → fill, no cloud upload
```

Full parameter reference: [`docs/ops-reference.md`](docs/ops-reference.md).

Every frame of the demo GIF above is a real export from Figma after one operation —
reproduce it with `scripts/demo-build.sh` and `scripts/make-demo-gif.py`.

## Image generation

The plugin window doubles as an image panel. It never sees the API key: it posts a job to the local
server, which runs the sibling `img-forge` CLI. That keeps one engine for the panel and for the agent,
and a 40-second generation never blocks Figma.

**Prerequisites**

- `img-forge/` checked out next to this repo (override with `IMG_FORGE_BIN`),
- `FAL_KEY` in `img-forge/.env` (or `~/.config/img-forge/key`),
- that is it — no extra npm packages, no SDK.

Without a key the panel still loads, and a job fails with a readable message in the log.

### The panel

Click `⌃` in the status bar. The window expands to `360×668` with two tabs.

| Control | What it does |
|---|---|
| **Model** | populated from `GET /image/models` (a small registry in `img-forge/models.json`) |
| **reasoning / quality** | populated from that model's **OpenAPI schema**, so the dropdowns can only offer values the endpoint accepts; a model without the field hides it |
| **Prompt** | text; for Edit this describes the change |
| **Size chips** | `1:1 @1024`, `16:9 @2k`, `9:16 @1080`, saved presets, and — in Edit — a chip with the reference's exact dimensions |
| **W × H + Use** | any size between 64 and 8192 px; the active chip becomes those pixels |
| **+** | saves `W × H` as a preset in `presets.json` (server-side, so it survives plugin reloads and is visible to the CLI) |
| **≈ $0.0123 · 1024×1024 · high** | token-based estimate before you spend anything |
| **Generate / Edit image** | posts the job, polls it, streams the log |
| **Insert on canvas** | a plain rectangle with an image fill at the viewport centre — a picture on the canvas, not a frame child. Runs **automatically** when a job finishes; the `auto-insert` checkbox turns that off |
| **Fill selection** | replaces the fill of the selected node |
| **Copy** | puts the whole log on the clipboard — for reporting a failure |

**Edit** uses the current selection as the reference: the panel exports it (`exportAsync`, 2×), the
server uploads it to the fal CDN, and `img edit` runs. The reference's dimensions become the active
size, so an edit keeps its proportions instead of being re-cropped to a fixed aspect.

### Cost and limits

Estimates come from token pricing in `img-forge/models.json` (`$30/1M` output image tokens, `$8/1M`
cached, `$5/1M` text input) — the same numbers fal publishes — plus `baseImageTokens` per quality
level and a linear area scale from 1024×1024. They are estimates, not invoices.

Every job passes `--max-usd` (default `$0.5`, override with `IMAGE_MAX_USD`) and `img-forge` refuses
**before any network call** when the estimate is above it:

```
1:1 @1024  low   $0.0082
1:1 @1024  high  $0.1249
16:9 @2k   high  $0.2809
16:9 @2k   max   $0.8425   → refused
```

### HTTP API

All image endpoints reject requests carrying a foreign `Origin` (403), so a web page you visit
cannot spend credits. There is no token: the key sits on disk anyway.

| Endpoint | Purpose |
|---|---|
| `GET /image/models` | registry with labels, size modes and pricing |
| `GET /image/schema?model=…` | that endpoint's input schema, flattened |
| `GET /image/presets` | saved `{label,width,height}` presets |
| `POST /image/presets` | add one (64–8192 px, deduplicated) |
| `POST /image/jobs` | `{mode, model, prompt, size, quality, refs?, dryRun?}` → `{id}` |
| `GET /image/jobs/:id` | `{status, log, result:{file, base64, width, height, cost}}` |

Jobs run one at a time and expire after 30 minutes.

### Not in the panel (use the CLI)

`--mask` / `--markup` for inpainting, `num_images > 1`, raw `--set` for model-specific knobs,
`--dry-run` payload inspection, and the spend log (`img-forge spend`). The panel is a convenience
layer; the CLI is the full surface.

## Agent skill

The repo ships a ready skill in `.agents/skills/figma-bridge/SKILL.md`. Install it globally so
every agent session can pick it up:

```bash
cp -R .agents/skills/figma-bridge ~/.agents/skills/
```

The pairing skill for image generation lives in `img-forge/.agents/skills/img-forge/`. DSH discovers
skills from `<repo>/.agents/skills` (project), `~/.dsh/skills` and `~/.agents/skills` (global) and
watches those directories, so a new skill appears without a restart. Verify with
`skill figma-bridge`.

## Testing without Figma

```bash
node server.mjs &
node scripts/mock-plugin.mjs &      # simulates the plugin
./bin/figma ping                    # → mock-plugin/1
```

Image jobs can be exercised without spending a cent: `POST /image/jobs` with `"dryRun": true` returns
the payload the CLI would send, including the cost estimate.

## Security

- The server binds only to `127.0.0.1` and `::1` — no LAN exposure.
- The plugin talks to exactly one origin, `http://localhost:3847`, declared in the manifest's
  `networkAccess`; the panel needs no fal.ai domain because only the server talks to fal.
- No tokens or OAuth in Figma: the API key never leaves the machine and never enters plugin code.
- CORS is **not** `*`: only the plugin iframe (`Origin: null`) and local tools without an Origin get
  an allow header, and `/image/*` additionally answers 403 to any foreign `Origin`.
- Image spending is capped per job (`--max-usd`) and every result is recorded in a manifest.
- `exec` runs arbitrary JS inside the plugin sandbox. That is deliberate — it is what makes the
  bridge a full Plugin API — but an agent that is careless can do more to a file than intended.
  Figma's own undo (⌘Z) is the safety net.

## License

MIT — see [`LICENSE`](LICENSE).
