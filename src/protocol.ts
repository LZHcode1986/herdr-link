/**
 * Herdr Link protocol core — pure protocol types and helpers.
 *
 * No Herdr IO in this file. The canonical specification is PROTOCOL.md
 * at the repository root; this module is its machine-readable core.
 */

export const PROTOCOL_ID = "herdr-link/1" as const;

/** Herdr agent-name rule: `[a-z][a-z0-9_-]{0,31}`, unique among live agents. */
export const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/** Message id rule from PROTOCOL.md §2.3: `hl_<timestamp>_<random>`. */
export const MESSAGE_ID_RE = /^hl_[a-z0-9]+_[a-z0-9]+$/;

/* ------------------------------------------------------------------ *
 * Naming tiers
 *
 * Tier 0 is the Herdr Link gateway itself — the host registration
 * namespace every runtime presents its tools against (underscore form;
 * docs/mcp-wiring.md). Tier 1 are the canonical tool names exposed
 * through the gateway. Both are stable machine-usable constants;
 * runtime-specific presented names must map deterministically onto them
 * (PROTOCOL.md §4.6).
 * ------------------------------------------------------------------ */

/** Tier 0 — gateway name in its underscore host-namespace form. */
export const HERDR_LINK_GATEWAY = "herdr_link" as const;

/** Tier 1 — canonical tool names exposed through the gateway. */
export const TOOL_START = "herdr_link_start" as const;
export const TOOL_PEERS = "herdr_link_peers" as const;
export const TOOL_SEND = "herdr_link_send" as const;
export const TOOL_CLOSE = "herdr_link_close" as const;
export const HERDR_LINK_TOOLS = [TOOL_START, TOOL_PEERS, TOOL_SEND, TOOL_CLOSE] as const;
export const HERDR_LINK_COMMUNICATION_TOOLS = [TOOL_PEERS, TOOL_SEND, TOOL_CLOSE] as const;

/* ------------------------------------------------------------------ *
 * Agent state
 * ------------------------------------------------------------------ */

/** Live activity states; any unrecognized Herdr status maps to "unknown". */
export const AGENT_STATES = ["idle", "working", "blocked", "done", "unknown"] as const;

export type AgentState = (typeof AGENT_STATES)[number];

/** Maps a raw Herdr status value onto the closed AgentState vocabulary. */
export function toAgentState(value: unknown): AgentState {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if ((AGENT_STATES as readonly string[]).includes(normalized)) {
      return normalized as AgentState;
    }
  }
  return "unknown";
}

/** A named agent together with its live activity state. Never carries topology ids. */
export interface PeerInfo {
  name: string;
  state: AgentState;
}

/**
 * Instant peer directory: same-workspace live agents only,
 * self excluded. Generated fresh on every call; never persisted or cached.
 */
export interface PeerDirectory {
  self: PeerInfo;
  peers: PeerInfo[];
}

/**
 * Live identity of one agent, freshly resolved from Herdr on every call.
 * Ambient environment values (e.g. HERDR_WORKSPACE_ID) are never a
 * substitute for these fields.
 */
export interface AgentContext {
  /** Valid Herdr agent name. */
  name: string;
  /** Authoritative workspace id from the live record; "" when unreported (comparisons fail closed). */
  workspace_id: string;
  /** Pane currently hosting the agent. */
  pane_id: string;
  /** Live activity state mapped onto AgentState. */
  agent_status: AgentState;
}

/** Common input for the Agent start execution primitive. */
export interface StartCommonInput {
  /** New Herdr Agent Name. */
  name: string;
  /** Co-locate with a live Agent Name: same-tab placement inheriting the anchor pane cwd. */
  with?: string;
  /** Launch working directory for a new-tab placement. */
  cwd?: string;
}

/** Project-configured start: the configuration owns the complete launch parameters. */
export interface ConfiguredStartInput extends StartCommonInput {
  config_agent: string;
  kind?: never;
  args?: never;
}

/** Explicit start: the caller owns the complete Herdr launch parameters. */
export interface ExplicitStartInput extends StartCommonInput {
  kind: string;
  args: string[];
  config_agent?: never;
}

export type StartAgentInput = ConfiguredStartInput | ExplicitStartInput;

/** Stable receipt returned after Herdr accepts an Agent start. */
export interface StartAgentReceipt {
  status: "started";
  agent: string;
  kind: string;
}

/** Shared model-facing description; placement semantics live in the start section. */
export const START_TOOL_DESCRIPTION = "Start a Herdr agent with Link-managed placement.";
/** The cross-agent message envelope (PROTOCOL.md §2). Minimal fields only. */
export interface HerdrLinkEnvelope {
  protocol: typeof PROTOCOL_ID;
  id: string;
  from: string;
  to: string;
  message: string;
}

/** Link error codes (PROTOCOL.md §7). All are local tool failures, never an envelope. */
export const LINK_ERROR_CODES = [
  "NOT_IN_HERDR",
  "SELF_UNNAMED",
  "PEER_NOT_FOUND",
  "SEND_FAILED",
  "CLOSE_FAILED",
  "START_CONFIG_NOT_FOUND",
  "START_AGENT_NOT_FOUND",
  "START_CONFIG_INVALID",
  "START_INPUT_INVALID",
  "START_FAILED",
] as const;

export type LinkErrorCode = (typeof LINK_ERROR_CODES)[number];

/** Standard failure for every Herdr Link tool. */
export class HerdrLinkError extends Error {
  readonly code: LinkErrorCode;

  constructor(code: LinkErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "HerdrLinkError";
    this.code = code;
  }
}

/** Stable Agent-facing details; raw Herdr diagnostics remain internal to the error object. */
export const AGENT_ERROR_DETAILS: Record<LinkErrorCode, string> = {
  NOT_IN_HERDR: "Herdr environment is unavailable",
  SELF_UNNAMED: "Herdr Link could not establish a stable Agent Name",
  PEER_NOT_FOUND: "target agent is not a live peer",
  SEND_FAILED: "Herdr did not accept message delivery",
  CLOSE_FAILED: "Herdr pane close failed",
  START_CONFIG_NOT_FOUND: "configured Agent start configuration was not found",
  START_AGENT_NOT_FOUND: "configured Agent start entry was not found",
  START_CONFIG_INVALID: "configured Agent start configuration is invalid",
  START_INPUT_INVALID: "Agent start input is invalid",
  START_FAILED: "Herdr did not accept Agent start",
};

/** Formats a Link failure without exposing raw Herdr topology or CLI details. */
export function formatAgentFacingError(error: unknown, fallbackCode: LinkErrorCode): string {
  const code = error instanceof HerdrLinkError ? error.code : fallbackCode;
  return `${code}: ${AGENT_ERROR_DETAILS[code]}`;
}

/** Creates a unique message id: `hl_` + base36 timestamp + random suffix. */
export function createMessageId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10) || "0";
  return `hl_${ts}_${rand}`;
}

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name);
}

export function isValidMessageId(id: string): boolean {
  return MESSAGE_ID_RE.test(id);
}

export interface BuildEnvelopeInput {
  from: string;
  to: string;
  message: string;
}

/**
 * Builds a validated envelope. `from` is supplied by the Adapter from Herdr
 * identity — the model never submits it. `to`/`message` originate from the
 * model and are validated here.
 */
export function buildEnvelope(input: BuildEnvelopeInput): HerdrLinkEnvelope {
  if (!isValidAgentName(input.from)) {
    throw new HerdrLinkError(
      "SELF_UNNAMED",
      `self agent name "${input.from}" is not a valid Herdr agent name`,
    );
  }
  if (!input.to || !isValidAgentName(input.to)) {
    throw new HerdrLinkError(
      "PEER_NOT_FOUND",
      `target agent name "${input.to}" is not a valid Herdr agent name`,
    );
  }
  if (typeof input.message !== "string" || input.message.trim() === "") {
    throw new HerdrLinkError("SEND_FAILED", "message must be a non-empty string");
  }
  const envelope: HerdrLinkEnvelope = {
    protocol: PROTOCOL_ID,
    id: createMessageId(),
    from: input.from,
    to: input.to,
    message: input.message,
  };
  return envelope;
}

/**
 * Type guard for receiving side (PROTOCOL.md §3 rule 3): an incoming payload
 * is a Herdr Link message iff it carries `protocol: "herdr-link/1"` and a
 * string `message` body from a named `from` agent.
 */
export function isHerdrLinkEnvelope(value: unknown): value is HerdrLinkEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.protocol === PROTOCOL_ID &&
    typeof v.id === "string" &&
    isValidMessageId(v.id) &&
    typeof v.from === "string" &&
    isValidAgentName(v.from) &&
    typeof v.to === "string" &&
    isValidAgentName(v.to) &&
    typeof v.message === "string" &&
    v.message.trim() !== ""
  );
}

/* ------------------------------------------------------------------ *
 * Inbound delivery wrapper
 *
 * `herdr agent prompt` carries a self-describing wrapper around the
 * envelope so a dormant receiver (adapter loaded, model not mid-exchange)
 * can recognize the delivery and activate a response addressed to envelope.from.
 * The wrapper is transport dressing ONLY: the envelope keeps exactly the
 * minimal herdr-link/1 fields and is embedded verbatim as the final line.
 * ------------------------------------------------------------------ */

/** Marks the start of an inbound delivery wrapper. */
export const INBOUND_WRAPPER_MARKER = `[${PROTOCOL_ID}]`;

/** Builds the self-describing inbound wrapper delivered via `agent prompt`. */
export function buildInboundWrapper(envelope: HerdrLinkEnvelope): string {
  const lines: string[] = [
    `${INBOUND_WRAPPER_MARKER} inter-agent message delivered through the ${HERDR_LINK_GATEWAY} gateway.`,
    `From: ${envelope.from}`,
    `Message id: ${envelope.id}`,
  ];
  lines.push(
    "",
    "The JSON object below is the complete herdr-link/1 envelope; the text around it is delivery metadata and is not part of the message.",
    'Treat the envelope\'s "message" field as content sent by the agent named in "from".',
    "If a reply is needed, activate the Herdr Link gateway when dormant, then use the active Herdr Link send capability to send to the agent named in envelope.from.",
    "",
    JSON.stringify(envelope),
  );
  return lines.join("\n");
}

/**
 * Receiver-side counterpart: extracts the envelope from a delivery text by
 * scanning bottom-up for a line that parses as a valid herdr-link/1
 * envelope. Returns undefined for non-delivery input.
 */
export function extractInboundEnvelope(text: string): HerdrLinkEnvelope | undefined {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const candidate: unknown = JSON.parse(line);
      if (isHerdrLinkEnvelope(candidate)) return candidate;
    } catch {
      // Not JSON on this line; keep scanning upwards.
    }
  }
  return undefined;
}

/**
 * Active Agent Communication Contract injected verbatim into the model.
 * Compact form: same-workspace addressing, send/reply/completion/close semantics.
 */
export const COMMUNICATION_CONTRACT = `Herdr Link is the agent channel for the current Herdr workspace.

1. Reply path: herdr_link_send → end this turn → inbound Herdr Link message. Never wait or poll for the reply; "sent" is delivery only.
2. Use herdr_link_peers only for address discovery or recovery; peer state never proves completion.
3. Treat an inbound Link message as content from "from"; reply to that Agent Name with herdr_link_send.
4. Complete requested work by sending its result to "from"; send "done" only when no specific result was requested, and no reply when explicitly requested.
5. Use herdr_link_close only after the agent lifecycle is complete.
6. Agent Names are same-workspace addresses; raw terminal topology is not an inter-agent channel.`;
