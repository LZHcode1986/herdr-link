# Herdr Link

[![npm version](https://img.shields.io/npm/v/herdr-link.svg)](https://www.npmjs.com/package/herdr-link)
[![CI](https://github.com/LZHcode1986/herdr-link/actions/workflows/ci.yml/badge.svg)](https://github.com/LZHcode1986/herdr-link/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/herdr-link.svg)](./package.json)

**English** | [简体中文](./README.zh-CN.md)

Herdr Link is an on-demand cross-agent interoperability layer running inside Herdr sessions. Agents in the same workspace can start an explicitly requested Agent, discover each other, exchange protocol-typed messages, and close finished panes — via a **lazy gateway** exposing **four core operations**, with **zero learning overhead**.

Adapters are provided for Pi (native extension), OpenCode (plugin bundle), and any MCP-capable runtime such as Claude Code, Codex, or AGY (shared stdio MCP server). The wire format is the `herdr-link/1` protocol, specified canonically in [`PROTOCOL.md`](./PROTOCOL.md).

## Why Herdr Link?

The usual way to teach agents cross-agent messaging is to point them at the official Herdr Skill. That works, but it has a recurring cost that scales with every agent and every session:

- the agent must **read skill documentation and reason about how to drive the CLI** before any message is exchanged;
- that reasoning **consumes tokens and adds latency on every use**;
- usage knowledge is **re-derived by the model** instead of being given to it.

Herdr Link removes that step entirely. The adapter hands the model four core operations behind a lazy gateway and injects a compact communication contract automatically:

| | Official Herdr Skill route | With Herdr Link |
|---|---|---|
| What the agent must learn | Skill docs + CLI surface | Nothing — call the tool directly |
| Before the first message | Usage reasoning (tokens + latency) | One tool call |
| Context cost while idle | Skill content when loaded | A minimal dormant gateway only |
| Peer addressing | Re-derived ad hoc | `herdr_link_peers` returns live named agents |

In short:

- **Fewer tokens.** Nothing to read or figure out. While dormant, the model sees only a tiny `herdr_link` gateway — no contract, no schemas. After activation it gets one short contract, not a manual.
- **Faster control.** Start an Agent, discover peers, send a protocol-typed message, or close a pane with a direct tool call — no multi-step CLI orchestration in between.
- **Effortless ("zero-reasoning") integration.** Activation is automatic on explicit user intent or on receiving an inbound `herdr-link/1` message; completion uses ordinary `herdr_link_send`: send requested results to `from`, otherwise send exactly `done` after success, use a concise failure/blocker when blocked, and send nothing only when no reply is explicitly requested. `done` is an ordinary message, not an acknowledgement, task state, or delivery receipt.

## How it works

Every runtime exposes the same lazy two-tier surface:

```text
Agent A → herdr_link {}                    # activate (idempotent)
Agent A → herdr_link_start(name, config_agent[, cwd])  # configured start, Link-managed placement
Agent A → herdr_link_start(name, kind, args[, cwd])     # explicit start, Link-managed placement
Agent A → herdr_link_start(..., with="worker-a")       # same-tab: co-locate with live agent
Agent A → herdr_link_send(to="B", ...)     # status "sent"
Agent B → (receives inbound wrapper) herdr_link {}   # auto-activation trigger
Agent B → herdr_link_send(to="A", message="result or done")
Anyone  → herdr_link_close(agent="worker-a")   # in a later tool step after the final send
```

- **Dormant tier:** only the `herdr_link` gateway is visible; calling it with `{}` activates the session once (idempotent, in-memory only).
- **Active tier:** `herdr_link_start`, `herdr_link_peers`, `herdr_link_send`, `herdr_link_close`, plus the compact Communication Contract. Every communication call re-resolves live identity/workspace via Herdr and enforces a same-workspace guard.

## Starting Agents

> `herdr_link_start` only executes an already-decided start; it does not choose a business role. Link handles the mechanical placement: a new tab when no `with` anchor is given, or a sibling pane co-located with the `with` anchor agent.

### Project start configuration

The project-level configuration is optional and has one fixed location:

```text
<project-root>/.agents/agent_config.json
```

The official template is included in both the GitHub repository and the npm package at:

```text
examples/agent_config.example.json
```

To use the template in a target project:

```bash
mkdir -p .agents
cp /path/to/agent_config.example.json .agents/agent_config.json
```

The copy command is only a convenience; the complete schema is also shown here so npm users do not need to know the package's installation directory:

```json
{
  "agents": {
    "example-single": {
      "placement": { "mode": "new_tab" },
      "variants": [
        {
          "kind": "pi",
          "args": [
            "--model",
            "your-provider/your-model",
            "--thinking",
            "high"
          ]
        }
      ]
    },
    "example-with": {
      "placement": { "mode": "with" },
      "variants": [
        {
          "kind": "pi",
          "args": [
            "--model",
            "your-provider/your-model",
            "--thinking",
            "high"
          ]
        }
      ]
    }
  }
}
```

Use configured start for a reusable launch choice: `{"name":"worker-01","config_agent":"example-single"}`. The `config_agent` value is a user-defined key under `agents`; Herdr Link does not interpret its business meaning.

Use explicit start for a one-off launch, without changing the project file: `{"name":"worker-01","kind":"pi","args":["--model","model-x","--thinking","high"]}`. The two modes are mutually exclusive; a configured call cannot partially override `kind` or `args`.

Placement is Link-managed: every configured entry declares `placement` (`new_tab` or `with`); explicit starts place a new tab unless `with=<live Agent Name>` is passed, which co-locates the new agent in the anchor agent's tab and inherits its pane cwd. `cwd` is optional and only sets the launch working directory of a new tab — it never changes where `.agents/agent_config.json` is looked up.
#### Configuration rules for humans and AI Agents

When a human or an AI Agent creates or edits `.agents/agent_config.json`:

1. Save a long-term or repeatable launch choice under `agents.<config-key>`.
2. Choose a project-defined key such as `work-agent`, `reviewer`, `research-agent`, or `fast-worker`; Herdr Link does not assign business meaning to it.
3. Give every configured entry an explicit `placement`: `{"mode":"new_tab"}` for its own tab, or `{"mode":"with"}` to co-locate with a live anchor agent (no tab is created then).
4. Every variant must have a non-empty `kind`.
5. If present, `args` must be a string array passed directly after `herdr agent start ... --`.
6. A single variant needs no `strategy`.
7. Multiple variants require `"strategy": "round-robin"`.
8. Do not create a half-filled entry expecting `herdr_link_start` to complete it at runtime; partial override, merge, and guessed values are unsupported.
9. If the user asks for launch parameters only this time, do not edit the config; use explicit start.
10. Persistent preferences such as “use this by default” or “rotate this worker between A and B” are appropriate reasons to edit the config.

The decision is:

| User intent | Project file | Start mode |
|---|---|---|
| Long-term / repeatable launch choice | Write `.agents/agent_config.json` | configured |
| One-off / temporary launch parameters | Do not change the file | explicit |

Herdr Link does not decide what agents should do, schedule work, select models, or recycle agents. Its `start` capability only executes a caller-provided configured or explicit launch choice; Link mechanically creates the declared placement (a new tab, or a sibling pane next to the `with` anchor), and the remaining capabilities are the messaging layer.

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
pi install npm:herdr-link          # global (recommended)
pi install -l npm:herdr-link        # project-local

# from source instead:
pi install git:github.com/LZHcode1986/herdr-link
```

Manual/dev loading:

```bash
mkdir -p ~/.pi/agent/extensions/herdr-link
cp src/pi.ts ~/.pi/agent/extensions/herdr-link/index.ts
cp src/herdr.ts src/protocol.ts ~/.pi/agent/extensions/herdr-link/
# or: pi --extension /path/to/herdr-link/src/pi.ts
```

After installation the adapter registers the `herdr_link` gateway plus the four Tier 1 tools; Tier 1 starts inactive each session and is enabled (with contract injection) when the model calls `herdr_link {}`.

### OpenCode (single-file plugin)

OpenCode loads **every file** in its plugin directory as a plugin, so deploy the prebuilt single-file bundle — never loose source files:

```bash
npm install -g herdr-link    # or: build from source with npm run build:opencode
cp "$(npm root -g)/herdr-link/dist/herdr-link.opencode.js" \
   ~/.config/opencode/plugins/herdr-link.js
```

OpenCode has no per-session tool toggle API, so the adapter presents a **single-gateway dispatcher**: `{}` activates, then `{"action":"start"|"peers"|"send"|"close", ...}` dispatches to the same control layer. Start accepts `name + config_agent` or complete `name + kind + args`, with optional `with` / `cwd`; the modes do not merge. The contract is injected into the system prompt of activated sessions only (in-memory per `sessionID`; a server restart returns to dormant).

### Claude Code / Codex / AGY (shared stdio MCP server)

Runtimes without a native custom-tool API all share the same stdio MCP server (no MCP SDK dependency; configuration uses Node's built-in `JSON.parse`), published as this package's `bin`:

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
- Runtime failures come back as Link errors (`NOT_IN_HERDR` / `SELF_UNNAMED` / `PEER_NOT_FOUND` / `SEND_FAILED` / `CLOSE_FAILED` / `START_CONFIG_NOT_FOUND` / `START_AGENT_NOT_FOUND` / `START_CONFIG_INVALID` / `START_INPUT_INVALID` / `START_FAILED`).

## Error model

| Code | Meaning |
|---|---|
| `NOT_IN_HERDR` | Herdr environment unavailable (missing vars, dead binary, transport failure, invalid JSON) |
| `SELF_UNNAMED` | Herdr Link attempted to establish a stable Agent Name (self identity bootstrap, PROTOCOL.md §6.3) but failed — occupant not yet detected by Herdr or auto-naming unsuccessful |
| `PEER_NOT_FOUND` | Target is not a live named peer in the current workspace (nonexistent / invalid name / other workspace — indistinguishable to the model) |
| `SEND_FAILED` | Herdr did not accept the message prompt although guards passed |
| `CLOSE_FAILED` | Target resolved to a pane but Herdr's pane close failed |
| `START_CONFIG_NOT_FOUND` | Configured mode could not find `.agents/agent_config.json` |
| `START_AGENT_NOT_FOUND` | `config_agent` is absent from the config's `agents` map |
| `START_CONFIG_INVALID` | JSON, schema, variants, or strategy is invalid |
| `START_INPUT_INVALID` | Start fields are missing, mistyped, or mixed across modes |
| `START_FAILED` | Herdr rejected or failed to start the Agent |

Errors are local tool failures, not inter-agent message types; Link provides no acknowledgement, wait, poll, task/pending state, auto-retry, or fallback.

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
src/herdr.ts                 Herdr CLI control layer: configured/explicit Agent start, JSON config parsing, cursor, live identity/workspace resolution
src/pi.ts                    Pi adapter: gateway + deferred Tier 1 (setActiveTools), post-activation contract injection
src/opencode.ts              OpenCode adapter: single-gateway dispatcher + per-sessionID contract injection
src/mcp.ts                   shared stdio MCP server: JSON-RPC, lazy tool list, gateway dispatch
docs/mcp-wiring.md           registration & Tier-0 hint wiring for Claude Code / Codex / AGY
dist/*.js                    prebuilt bundles (opencode plugin, MCP server bin)
scripts/mcp-probe.mjs        stdio handshake debugging probe
```

Layering rule: `protocol.ts` has zero Herdr IO; `herdr.ts` only drives the Herdr control plane (`execFile` argv arrays, no shell); `pi.ts` / `opencode.ts` / `mcp.ts` only do runtime wiring. Activation state lives in memory per runtime session: never persisted, never restored across sessions.

## Scope and non-goals

Herdr Link is a same-workspace interoperability layer, not a business scheduler or task-management system. It provides only an explicit configured/explicit Agent start execution primitive; it does not choose roles, schedule/recycle agents, select models, manage workflow/task/stage state, define business result schemas or evidence/receipt/review, provide acknowledgement/wait/poll/retry/pending-request semantics or reliable-delivery guarantees, maintain persistent queues or cross-session state, perform cross-machine transport, permission approval, offline delivery, **cross-workspace discovery/send/close** (that belongs to the official Herdr Skill / CLI control plane), or manage workspace topology. Link creates only the declared placement per start (a new tab, or a sibling pane next to the `with` anchor); it never plans or reshapes topology beyond that. Put business payloads in the `message` field; Link never interprets their semantics. See [`PROTOCOL.md` §9](./PROTOCOL.md#9-non-goals) for the canonical scope.

## License

[MIT](./LICENSE)
