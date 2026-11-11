# Handoff prompt

Paste the text below into another agent (Claude Code, Codex, Cursor, another DSH). The repo is
public, so the agent can simply follow the link and read `AGENTS.md` — or work on the same machine
where `figma-bridge/` lives.

---

You have access to Figma through a local bridge called **Figma Bridge**
(repo: `https://github.com/iggypcnfsky/figma-bridge`). Read `AGENTS.md` from that repo before you
do anything.

In short:

```bash
cd figma-bridge
./bin/figma status          # must show pluginConnected: true, otherwise STOP
./bin/figma selection 2     # what the user has selected
./bin/figma pages           # which page they are on
./bin/figma run '[{"op":"createFrame","name":"Bridge / Card","width":320,"height":200}]'
./bin/figma export <nodeId> out/render.png PNG 2
```

Rules you do not break:

1. Read before writing — `status`, `selection`, `node`, `find`. Never guess a `nodeId`.
2. Do not modify existing user layers without an explicit instruction; name new things with the
   `Bridge / ` prefix. A rework is a new frame beside the original (`Bridge / v2 — …`), never an
   in-place rewrite unless the user says to replace something on the original. When building on an
   existing draft, its grouping, order and spacing are intent — keep them and report what you moved.
3. Operation results are not available to the next operation in the same batch — if you need an
   `id`, split into two calls.
4. After building anything visual, `export` a PNG and look at the image before claiming it works.
5. `exec` is a last resort (it bypasses parameter validation).
6. Do not delete or move someone else's layers without consent. Clean up after your tests.

Operation format: `{"op":"name", ...parameters}`. HTTP contract, error codes and the full operation
list: `AGENTS.md` + `docs/ops-reference.md`.

If `./bin/figma status` returns `pluginConnected: false`, do not try to fix it yourself — ask the
user to run the `Plugins → Development → Figma Bridge` plugin in the window of the file they want
worked on.
