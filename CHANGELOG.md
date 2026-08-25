# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Self identity bootstrap** (PROTOCOL.md §6.3): when the current pane occupant is recognized by Herdr but has no valid Agent Name, adapters run `ensureSelfName()` — once at adapter startup and as a fallback inside every communication path — to assign a generated `hl-<hex>` name via `agent rename`, confirmed by re-reading the authoritative live record. Existing valid names are never rewritten; collisions (`agent_name_taken`) regenerate within a bounded 3-attempt budget; nothing is persisted (Herdr remains the lifecycle authority).

### Changed

- PROTOCOL.md §6.2/§7/§8/§9: identity readiness now permits the scoped internal bootstrap; `SELF_UNNAMED` narrowed to "Link attempted but failed to establish a stable Agent Name"; `agent rename` moved from the blanket command forbidden list to a §6.3-only scoped exception (never model-facing); Non-goals exclude general Agent Name management while allowing the one-shot self bootstrap.

## [0.1.0] - 2026-08-25

First public release of Herdr Link: an on-demand cross-agent interoperability layer running inside Herdr sessions.

### Added

- **`herdr-link/1` protocol** (`PROTOCOL.md`, canonical spec): self-describing envelope format with reply correlation, two-tier capability surface (dormant `herdr_link` gateway + Tier 1 tools), compact Communication Contract injection, and a local error model (`NOT_IN_HERDR` / `SELF_UNNAMED` / `PEER_NOT_FOUND` / `SEND_FAILED` / `CLOSE_FAILED`).
- **Lazy capability activation**: runtimes present only a minimal gateway until an explicit Herdr intent or an inbound self-describing Link message activates peers/send/close for the current runtime session; activation state is in-memory only.
- **Pi adapter** (`src/pi.ts`): native extension using deferred Tier-1 tools via `setActiveTools`; contract injected on activation only.
- **OpenCode adapter** (`src/opencode.ts`): single-file plugin bundle presenting one `herdr_link` dispatcher tool (`peers`/`send`/`close` actions); per-session contract injection via system-prompt transform.
- **Shared stdio MCP server** (`src/mcp.ts`, zero-dependency JSON-RPC) for Claude Code, Codex, and AGY: empty `tools/list` outside Herdr, dormant/active gating with `notifications/tools/list_changed`, gateway action fallback for non-refreshing hosts.
- **Same-workspace guard**: live identity/workspace resolution via `agent get` on every call; cross-workspace discovery/send/close are out of scope by design.
- Wiring guides for all MCP hosts in `docs/mcp-wiring.md`; stdio probe script `scripts/mcp-probe.mjs`.
