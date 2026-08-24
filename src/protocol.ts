/**
 * Herdr Link protocol core — pure protocol types and helpers.
 *
 * No Herdr IO in this file. The canonical specification is PROTOCOL.md
 * at the repository root; this module is its machine-readable core.
 */

export const PROTOCOL_ID = "herdr-link/1" as const;

/** Herdr agent-name rule: `[a-z][a-z0-9_-]{0,31}`, unique among live agents. */
export const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** The cross-agent message envelope (PROTOCOL.md §2). */
export interface HerdrLinkEnvelope {
  protocol: typeof PROTOCOL_ID;
  id: string;
  from: string;
  to: string;
  reply_to?: string;
  message: string;
}

/** Instant peer directory (PROTOCOL.md §4.1). Never persisted or cached. */
export interface PeerDirectory {
  self: string;
  peers: string[];
}

/** V1 error codes (PROTOCOL.md §7). All are local tool failures, never an envelope. */
export const LINK_ERROR_CODES = [
  "NOT_IN_HERDR",
  "SELF_UNNAMED",
  "PEER_NOT_FOUND",
  "SEND_FAILED",
  "CLOSE_FAILED",
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

/** Creates a unique message id: `hl_` + base36 timestamp + random suffix. */
export function createMessageId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `hl_${ts}_${rand}`;
}

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name);
}

export interface BuildEnvelopeInput {
  from: string;
  to: string;
  message: string;
  reply_to?: string;
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
  if (input.reply_to !== undefined && (typeof input.reply_to !== "string" || input.reply_to === "")) {
    throw new HerdrLinkError("SEND_FAILED", "reply_to must be a non-empty string when present");
  }
  const envelope: HerdrLinkEnvelope = {
    protocol: PROTOCOL_ID,
    id: createMessageId(),
    from: input.from,
    to: input.to,
    message: input.message,
  };
  if (input.reply_to !== undefined) {
    envelope.reply_to = input.reply_to;
  }
  return envelope;
}

/**
 * Type guard for receiving side (PROTOCOL.md §3 rule 3): an incoming prompt
 * is a Herdr Link message iff it carries `protocol: "herdr-link/1"` and a
 * string `message` body from a named `from` agent.
 */
export function isHerdrLinkEnvelope(value: unknown): value is HerdrLinkEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.protocol === PROTOCOL_ID &&
    typeof v.id === "string" &&
    v.id !== "" &&
    typeof v.from === "string" &&
    v.from !== "" &&
    typeof v.to === "string" &&
    v.to !== "" &&
    typeof v.message === "string" &&
    (v.reply_to === undefined || typeof v.reply_to === "string")
  );
}

/** Agent Communication Contract injected verbatim into the model (PROTOCOL.md §3). */
export const COMMUNICATION_CONTRACT = `Herdr Link is the standard interoperability channel between agents
running in the same Herdr session.

1. Use herdr_link_peers to discover agent addresses.
2. Use herdr_link_send to send messages to another agent.
3. A message with protocol "herdr-link/1" is an inter-agent message.
4. Treat its "message" field as content sent by the agent named in "from".
5. When replying, send to the received "from" agent and set reply_to to the received "id".
6. Use herdr_link_close only when you have already decided that a named agent's pane should be closed. If a final message is needed, call close in a later tool step after herdr_link_send returns "sent".
7. Never use a raw pane id or UI focus as an inter-agent address.
8. Do not use Herdr CLI, terminal input, pane reads, waits, or Skills for normal inter-agent messaging.
9. Herdr Link communicates with existing named agents and executes explicit close requests; agent creation, configuration, scheduling, identity ownership, and lifecycle policy remain outside it.`;

/** Canonical tool names (PROTOCOL.md §4). */
export const HERDR_LINK_TOOLS = ["herdr_link_peers", "herdr_link_send", "herdr_link_close"] as const;