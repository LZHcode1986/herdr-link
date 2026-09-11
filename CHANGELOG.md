# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
## [Unreleased]

## [0.5.0] - 2026-09-11

### Added

- **Link-managed placement** for `herdr_link_start`: the start tool no longer accepts a raw pane id. `new_tab` placement creates a focus-free tab and resolves its exactly-one root pane; `with=<live Agent Name>` placement splits the anchor pane and inherits its live cwd.
- `with` and `cwd` input fields on the start tool: `with` co-locates with a live agent (same-tab), `cwd` sets the launch working directory of a new tab only.
- Failed-start allocation rollback: a tab/sibling pane created by a start that later fails is closed best-effort (exact created tab/pane), preserving the primary error and never retrying.
- Pi active-session blocking-wait guard: raw `herdr agent wait` and `herdr agent prompt ... --wait` are blocked before execution while the Link channel is active (`herdr agent wait` also terminates the turn; prompt-with-wait is blocked without terminating so the model can switch to `herdr_link_send`).

### Changed

- `herdr_link_start` model schema: removed the raw `pane` field; added optional `with` / `cwd`. Receipts stay `{ status, agent, kind }` with no topology ids.
- `.agents/agent_config.json`: root schema-generation fields removed (`agents` only); every configured entry now requires an explicit `placement` (`new_tab` with optional presentation-only label, or `with` without label).
- Config finder semantics split: the adapter context directory locates the config file; a model-supplied `cwd` only affects new-tab launch and never changes where `.agents/agent_config.json` is looked up.
- Communication Contract, tool descriptions, and docs pruned to current behavior; historical release notes stay in the changelog.

### Fixed

- Adapter start semantics are now consistent across Pi / OpenCode / MCP with the same canonical input, placement, receipt, and rollback behavior.


## [0.4.1] - 2026-09-07

### Fixed

- Fixed MCP `serverInfo.version` to report the package version.
- Added a package/MCP version consistency regression guard.

## [0.4.0] - 2026-09-06

### Added

- **`herdr_link_start`**: a shared configured/explicit Agent start primitive for Pi, OpenCode, and MCP. Configured mode selects a complete entry from `.agents/agent_config.json`; explicit mode forwards complete `kind` and `args` without partial overrides or merge semantics.
- Configured entries support one or more launch variants with opt-in `round-robin` selection, a process-local cursor isolated by project and config key, and no retry/fallback after a failed start.
- Official `examples/agent_config.example.json` template and README guidance for project configuration and AI Agent decisions between configured and explicit start.

### Changed

- Project start configuration uses the standard JSON format and built-in `JSON.parse()`, providing a simple native configuration path for target projects.
- Published the official configuration template through the npm package allowlist and added template/schema, package, and MCP working-directory coverage.

## [0.3.1] - 2026-09-01

### Changed

- Clarify passive-wait guidance in the Communication Contract: use `herdr_link_peers` only for agent-address discovery or explicit recovery; do not use activity state to wait for or infer task completion, and continue after a peer reply arrives as a new inbound `herdr-link/1` message.

## [0.3.0] - 2026-08-26

### Changed

- Reply completion now uses ordinary `herdr_link_send(to, message)`; `reply_to` is no longer part of the active Envelope, wrapper, tool schemas, or adapters. Replies target the inbound envelope's `from`.
- The Communication Contract now defines requested-result, exact `done`, failure/blocker, and explicit no-reply completion behavior. `done` is an ordinary message, not an acknowledgement or task state.
- README scope and non-goal documentation now describe the lazy gateway, three core operations, and the absence of ACK/wait/poll/retry/pending semantics.
- Docs: Pi installation now recommends the published npm package (`pi install npm:herdr-link`); git source is kept as the from-source alternative.
- Docs: Claude Code wiring status in `docs/mcp-wiring.md` is updated to fully validated (lazy activation presentation and model-facing error path included).

## [0.2.1] - 2026-08-25

### Changed

- Releases are now published from GitHub Actions with signed npm provenance (Sigstore attestation binding each tarball to this repo, commit, and workflow); local publish path retired in favour of the `NPM_TOKEN` automation credential.

## [0.2.0] - 2026-08-25

### Added

- **Self identity bootstrap** (PROTOCOL.md §6.3): when the current pane occupant is recognized by Herdr but has no valid Agent Name, adapters run `ensureSelfName()` — once at adapter startup and as a fallback inside every communication path — to assign a generated `hl-<hex>` name via `agent rename`, confirmed by re-reading the authoritative live record. Existing valid names are never rewritten; collisions (`agent_name_taken`) regenerate within a bounded 3-attempt budget; the initial probe carries an equally small detection-readiness retry for freshly launched occupants; concurrent bootstraps coalesce into one rename sequence; nothing is persisted (Herdr remains the lifecycle authority).

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
