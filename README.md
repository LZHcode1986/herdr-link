# Herdr Link

[![npm version](https://img.shields.io/npm/v/herdr-link.svg)](https://www.npmjs.com/package/herdr-link)
[![CI](https://github.com/LZHcode1986/herdr-link/actions/workflows/ci.yml/badge.svg)](https://github.com/LZHcode1986/herdr-link/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/herdr-link.svg)](./package.json)

**English** | [简体中文](./README.zh-CN.md)

Herdr Link is an on-demand cross-agent interoperability layer running inside Herdr sessions. Agents in the same workspace can discover each other, exchange protocol-typed messages, and close finished panes — through **three tools**, with **zero learning overhead**.

Adapters are provided for Pi (native extension), OpenCode (plugin bundle), and any MCP-capable runtime such as Claude Code, Codex, or AGY (shared stdio MCP server). The wire format is the `herdr-link/1` protocol, specified canonically in [`PROTOCOL.md`](./PROTOCOL.md).

## Why Herdr Link?

The usual way to teach agents cross-agent messaging is to point them at the official Herdr Skill. That works, but it has a recurring cost that scales with every agent and every session:

- the agent must **read skill documentation and reason about how to drive the CLI** before any message is exchanged;
- that reasoning **consumes tokens and adds latency on every use**;
- usage knowledge is **re-derived by the model** instead of being given to it.

Herdr Link removes that step entirely. The adapter hands the model three self-describing tools and injects a compact communication contract automatically:

| | Official Herdr Skill route | With Herdr Link |
|---|---|---|
| What the agent must learn | Skill docs + CLI surface | Nothing — call the tool directly |
| Before the first message | Usage reasoning (tokens + latency) | One tool call |
| Context cost while idle | Skill content when loaded | A minimal dormant gateway only |
| Peer addressing | Re-derived ad hoc | `herdr_link_peers` returns live named agents |

In short:

- **Fewer tokens.** Nothing to read or figure out. While dormant, the model sees only a tiny `herdr_link` gateway — no contract, no schemas. After activation it gets one short contract, not a manual.
- **Faster communication.** Discover peers, send a protocol-typed message, or close a pane is a single direct tool call — no multi-step CLI orchestration in between.
- **Effortless ("zero-reasoning") integration.** Activation is automatic on explicit user intent or on receiving an inbound `herdr-link/1` message; reply correlation (`reply_to`) means the agent never has to invent bookkeeping.

## How it works

Every runtime exposes the same lazy two-tier surface:

```text
Agent A → herdr_link {}                    # activate (idempotent)
Agent A → herdr_link_send(to="B", ...)     # status "sent"
Agent B → (receives inbound wrapper) herdr_link {}   # auto-activation trigger
Agent B → herdr_link_send(to="A", reply_to=<received id>, ...)
Anyone  → herdr_link_close(agent="worker-a")   # in a later tool step after the final send
```

- **Dormant tier:** only the `herdr_link` gateway is visible; calling it with `{}` activates the session once (idempotent, in-memory only).
- **Active tier:** `herdr_link_peers`, `herdr_link_send`, `herdr_link_close`, plus the compact Communication Contract. Every call re-resolves live identity/workspace via Herdr and enforces a same-workspace guard.

Herdr Link does not decide what agents should do, and it does not create, schedule, model-select, or recycle agents. It is purely the messaging layer.

## Installation

### Herdr plugin (operator tooling)

herdr-link is listed on the official [Herdr plugin marketplace](https://herdr.dev/plugins/). Installing it as a Herdr plugin gives you an operator-facing `doctor` action for troubleshooting Link setups in any pane:

```bash
herdr plugin install LZHcode1986/herdr-link
herdr plugin action invoke herdr-link.doctor   # env, self identity, same-workspace peers
```

The plugin action is read-only diagnostics; the Agent-facing protocol surface ships separately per runtime below.


### Pi (native extension)

```bash
pi install git:github.com/LZHcode1986/herdr-link          # global
pi install -l git:github.com/LZHcode1986/herdr-link       # project-local
```

Manual/dev loading:

```bash
mkdir -p ~/.pi/agent/extensions/herdr-link
cp src/pi.ts ~/.pi/agent/extensions/herdr-link/index.ts
cp src/herdr.ts src/protocol.ts ~/.pi/agent/extensions/herdr-link/
# or: pi --extension /path/to/herdr-link/src/pi.ts
```

After installation the adapter registers the `herdr_link` gateway plus the three Tier 1 tools; Tier 1 starts inactive each session and is enabled (with contract injection) when the model calls `herdr_link {}`.

### OpenCode (single-file plugin)

OpenCode loads **every file** in its plugin directory as a plugin, so deploy the prebuilt single-file bundle — never loose source files:

```bash
npm install -g herdr-link    # or: build from source with npm run build:opencode
cp "$(npm root -g)/herdr-link/dist/herdr-link.opencode.js" \
   ~/.config/opencode/plugins/herdr-link.js
```

OpenCode has no per-session tool toggle API, so the adapter presents a **single-gateway dispatcher**: `{}` activates, then `{"action":"peers"|"send"|"close", ...}` dispatches to the same control layer. The contract is injected into the system prompt of activated sessions only (in-memory per `sessionID`; a server restart returns to dormant).

### Claude Code / Codex / AGY (shared stdio MCP server)

Runtimes without a native custom-tool API all share the same zero-dependency stdio MCP server, published as this package's `bin`:

```bash
npx -y herdr-link           # starts the MCP server on stdio
```

Register it under the namespace `herdr_link` (underscore). Presentation differs by host: Claude Code / Codex expose prefixed tools (`mcp__herdr_link__<tool>`), AGY calls through its native `call_mcp_tool` wrapper — inputs, outputs, and error semantics are identical everywhere. Host-specific registration configs and Tier-0 hint wiring (launcher flags / SessionStart hook / PreInvocation hook) are documented in [`docs/mcp-wiring.md`](./docs/mcp-wiring.md).

MCP presentation is lazy too: outside Herdr, `tools/list` returns an empty set; in a Herdr-managed pane, dormant lists only the gateway; activation emits `notifications/tools/list_changed` (hosts that never refresh keep full functionality through gateway action dispatch).

## Requirements

The runtime process must be started by Herdr in a managed pane:

| Variable | Purpose |
|---|---|
| `HERDR_ENV=1` | Confirms a Herdr environment |
| `HERDR_BIN_PATH` | Current Herdr binary path; invalid → `NOT_IN_HERDR` |
| `HERDR_PANE_ID` | Caller pane, used to resolve self identity and authoritative workspace |

- Outside a Herdr pane every adapter is a complete no-op: Pi/OpenCode register nothing, MCP returns an empty tool list.
- In a Herdr pane while dormant, only the `herdr_link` gateway is visible to the model.
- **Self identity bootstrap** (PROTOCOL.md §6.3): a manually started agent that is recognized by Herdr but has no valid Agent Name is named automatically with a generated `hl-*` name (`ensureSelfName()` at adapter startup plus a fallback inside every communication path). Existing names are never rewritten, nothing is persisted; if the bootstrap fails the Link errors with `SELF_UNNAMED`.
- Runtime failures come back as Link errors (`NOT_IN_HERDR` / `SELF_UNNAMED` / `PEER_NOT_FOUND` / `SEND_FAILED` / `CLOSE_FAILED`).

## Error model

| Code | Meaning |
|---|---|
| `NOT_IN_HERDR` | Herdr environment unavailable (missing vars, dead binary, transport failure, invalid JSON) |
| `SELF_UNNAMED` | Herdr Link attempted to establish a stable Agent Name (self identity bootstrap, PROTOCOL.md §6.3) but failed — occupant not yet detected by Herdr or auto-naming unsuccessful |
| `PEER_NOT_FOUND` | Target is not a live named peer in the current workspace (nonexistent / invalid name / other workspace — indistinguishable to the model) |
| `SEND_FAILED` | Herdr did not accept the message prompt although guards passed |
| `CLOSE_FAILED` | Target resolved to a pane but Herdr's pane close failed |

Errors are local tool failures, not inter-agent message types; no auto-retry, no fallback, no pending state.

## Development

The repository ships everything needed to audit and extend the project (`test/`, `tsconfig.json`, build scripts). The npm package is governed by the `files` allowlist in `package.json`.

```bash
npm install
npm run typecheck
npm test                    # node --experimental-strip-types --test test/*.test.ts
npm run build:opencode      # dist/herdr-link.opencode.js
npm run build:mcp           # dist/herdr-link.mcp.js
```

Layout:

```text
PROTOCOL.md                  canonical protocol spec (envelope, tiers, contract, semantics, errors)
src/protocol.ts              protocol core: types, envelope/wrapper builders, errors, COMMUNICATION_CONTRACT
src/herdr.ts                 Herdr CLI control layer: live identity/workspace resolution, same-workspace guard
src/pi.ts                    Pi adapter: gateway + deferred Tier 1 (setActiveTools), post-activation contract injection
src/opencode.ts              OpenCode adapter: single-gateway dispatcher + per-sessionID contract injection
src/mcp.ts                   shared stdio MCP server: JSON-RPC, lazy tool list, gateway dispatch
docs/mcp-wiring.md           registration & Tier-0 hint wiring for Claude Code / Codex / AGY
dist/*.js                    prebuilt bundles (opencode plugin, MCP server bin)
scripts/mcp-probe.mjs        stdio handshake debugging probe
```

Layering rule: `protocol.ts` has zero Herdr IO; `herdr.ts` only drives the Herdr control plane (`execFile` argv arrays, no shell); `pi.ts` / `opencode.ts` / `mcp.ts` only do runtime wiring. Activation state lives in memory per runtime session: never persisted, never restored across sessions.

## Non-goals (V1)

No agent creation/scheduling/recycling, model selection, workflow/task/stage state, business result schemas, evidence/receipt/review, persistent queues, cross-machine transport, permission approval, offline delivery, reliable-delivery acknowledgements, cross-session persistence, or **cross-workspace discovery/send/close** (that belongs to the official Herdr Skill / CLI control plane), and no workspace/topology management. Put business payloads in the `message` field; Link never interprets their semantics.

## License

[MIT](./LICENSE)
