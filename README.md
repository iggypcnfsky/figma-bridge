# Figma Bridge

![Agent building a card in Figma, step by step](docs/assets/demo.gif)

A local bridge between an AI agent and Figma. The agent sends named operations; a Figma plugin
executes them through the Figma Plugin API and returns the results. No dependencies, no OAuth,
no tokens, nothing leaves your machine.

**For agents:** [`AGENTS.md`](AGENTS.md) is written to be loaded as context.
**Drop-in prompt for another agent:** [`docs/handoff-prompt.md`](docs/handoff-prompt.md).
**Skill:** [`.agents/skills/figma-bridge/SKILL.md`](.agents/skills/figma-bridge/SKILL.md).

## Why not the official Figma MCP

| | Figma Bridge | official remote MCP | official desktop MCP |
|---|---|---|---|
| Writes to the canvas | yes | yes | **no** |
| OAuth / tokens | none | yes | none |
| Client allowlist | not applicable | yes | no |
| Requirements | Node ≥ 20 + Figma desktop | paid plan | Dev/Full seat on a paid plan |
| Context cost in the agent | 1 tool (`run`) | ~30 tool definitions | ~10 |
| Coupled to Figma's decisions | no | high | medium |

What it cannot do: create files in the cloud, capture live UI, generate AI images, FigJam diagrams,
shaders, Weave — those are server-side Figma features, not part of the Plugin API.

## How it works

```
agent ──HTTP──▶ server.mjs (localhost:3847) ◀──long-poll── plugin/ui.html
                        │                                        │
                        └──────── {ops:[…]} ─────────────────────┴─▶ plugin/code.js ─▶ figma.*
```

- `server.mjs` — job queue plus long-poll. No WebSockets, no npm packages.
- `bin/figma` — CLI: `status`, `ping`, `selection`, `pages`, `variables`, `op`, `run`, `export`.
- `plugin/code.js` — around 20 operations: frames, text, shapes, `update`, `clone`, `reparent`,
  `remove`, `export`, `imageFill`, `variables`, `varFill`, `exec`.

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
./bin/figma image 12:34 out/cover.png FILL     # obraz z dysku jako fill — bez uploadu do chmury
```

Generated artwork pairs with [img-forge](../img-forge) (a sibling CLI over fal.ai):
`img-forge gen … --out out/cover.png` then `./bin/figma image <nodeId> out/cover.png FILL`.

Full parameter reference: [`docs/ops-reference.md`](docs/ops-reference.md).

Every frame of the demo GIF above is a real export from Figma after one operation —
reproduce it with `scripts/demo-build.sh` and `scripts/make-demo-gif.py`.

## Agent skill

The repo ships a ready skill in `.agents/skills/figma-bridge/SKILL.md`. Install it globally so
every agent session can pick it up:

```bash
cp -R .agents/skills/figma-bridge ~/.agents/skills/
```

DSH discovers skills from `<repo>/.agents/skills` (project), `~/.dsh/skills` and `~/.agents/skills`
(global) and watches those directories, so a new skill appears without a restart. Verify with
`skill figma-bridge`.

## Testing without Figma

```bash
node server.mjs &
node scripts/mock-plugin.mjs &      # simulates the plugin
./bin/figma ping                    # → mock-plugin/1
```

## Security

- The server binds only to `127.0.0.1` and `::1` — no LAN exposure.
- The plugin talks to exactly one origin, `http://localhost:3847`, declared in the manifest's
  `networkAccess`.
- No tokens or OAuth: there is nothing in a config file worth stealing, and permissions are
  whatever that editing session already has.
- `exec` runs arbitrary JS inside the plugin sandbox. That is deliberate — it is what makes the
  bridge a full Plugin API — but an agent that is careless can do more to a file than intended.
  Figma's own undo (⌘Z) is the safety net.

## License

MIT — see [`LICENSE`](LICENSE).
