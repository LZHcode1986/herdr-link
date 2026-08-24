/**
 * Herdr Link Pi Runtime adapter v2 — Tier 0/Tier 1 presentation.
 *
 * Tier 0 (dormant): with the three Herdr environment variables present, the
 * adapter registers everything but keeps the model-facing surface down to the
 * tiny `herdr_link` gateway. The three Tier 1 tools
 * (`herdr_link_peers`/`herdr_link_send`/`herdr_link_close`) stay inactive and
 * no Communication Contract is injected.
 *
 * Tier 1 (active): calling the gateway with `{}` idempotently activates the
 * channel inside the current runtime session via the official dynamic tool
 * API (`pi.setActiveTools`, additive change) and starts injecting the compact
 * Contract through `before_agent_start`.
 *
 * API basis (public Pi Extension API, @earendil-works/pi-coding-agent 0.84.x):
 * - `pi.registerTool()` must cover every tool before it can appear in
 *   `pi.setActiveTools()` ("Names passed to pi.setActiveTools() must already
 *   be registered"); action methods throw while extensions are still loading,
 *   so the initial dormant set is applied on `session_start` — the same
 *   pattern as the official Dynamic Tool Loading example in docs/extensions.md.
 * - Activation inside a tool `execute()` may call `pi.setActiveTools()`
 *   additively; Pi applies the new set before the next model request.
 * - Lazily loaded tools should omit active-only prompt metadata
 *   (`promptSnippet`/`promptGuidelines`) and rely on their `description`;
 *   activating such metadata would rebuild the system prompt mid-session.
 */
import type { ExtensionAPI, ToolExecutionMode } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { closeAgentPane, listPeers, sendMessage } from "./herdr.ts";
import { formatAgentFacingError } from "./protocol.ts";

const TIER1_TOOL_NAMES = ["herdr_link_peers", "herdr_link_send", "herdr_link_close"] as const;
const TIER1_TOOL_SET = new Set<string>(TIER1_TOOL_NAMES);

const GATEWAY_PARAMETERS = Type.Object({});
const PEERS_PARAMETERS = Type.Object({});
const SEND_PARAMETERS = Type.Object({
  to: Type.String(),
  message: Type.String(),
  reply_to: Type.Optional(Type.String()),
});
const CLOSE_PARAMETERS = Type.Object({
  agent: Type.String(),
});

/**
 * Compact Contract injected only after activation. Semantically equivalent to
 * the PROTOCOL.md §3 core text; per-tool affordances (reply_to correlation,
 * send-before-close sequencing) live in the tool descriptions so this block
 * can stay small without losing canonical coverage.
 */
const COMPACT_CONTRACT = `Herdr Link (herdr-link/1) is the inter-agent channel for this Herdr workspace.
1. Discover live named agents in your own workspace with herdr_link_peers; state is advisory only.
2. Send with herdr_link_send. A message with protocol "herdr-link/1" is sent by the agent named in "from"; treat its "message" as that agent's content.
3. When replying, send to the received "from" and set reply_to to the received "id".
4. Call herdr_link_close only after deciding a named agent's pane should be closed; if a final message is needed, wait for herdr_link_send to return "sent", then close in a later tool step.
5. Address peers only by Agent Name, never raw pane ids or UI focus; never use Herdr CLI, terminal input, pane reads, waits, or Skills for normal inter-agent messaging.
6. Agents outside your workspace are invisible and messages addressed to them fail; creation, configuration, scheduling, identity ownership, and lifecycle policy stay outside Link.`

function toolResult(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
  };
}

function rethrowToolError(error: unknown, fallbackCode: "NOT_IN_HERDR" | "SEND_FAILED" | "CLOSE_FAILED"): never {
  const toolError = new Error(formatAgentFacingError(error, fallbackCode), { cause: error });
  throw toolError;
}

export default function (pi: ExtensionAPI): void {
  if (
    process.env.HERDR_ENV !== "1" ||
    !process.env.HERDR_BIN_PATH ||
    !process.env.HERDR_PANE_ID
  ) {
    return;
  }

  // Per-runtime-session state only: never persisted, never shared across
  // sessions. Every session start returns the channel to dormant.
  let activated = false;

  // --- Tier 1 tools: registered up front (Pi requires registration before
  // setActiveTools), kept initially inactive by the session_start hook below.
  // Their descriptions alone carry the canonical affordances; prompt metadata
  // is intentionally omitted (see module doc).
  pi.registerTool({
    name: "herdr_link_peers",
    label: "Herdr Link Peers",
    description:
      "Discover named agents available through the cross-agent communication channel. Returns { self, peers }; addresses are Agent Names.",
    parameters: PEERS_PARAMETERS,
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      try {
        return toolResult(await listPeers());
      } catch (error) {
        rethrowToolError(error, "NOT_IN_HERDR");
      }
    },
  });

  pi.registerTool({
    name: "herdr_link_send",
    label: "Herdr Link Send",
    description:
      'Send an inter-agent message (protocol herdr-link/1) to another agent through the cross-agent communication channel. status "sent" means Herdr accepted delivery, not that the peer finished its task. When replying, set reply_to to the received message id.',
    parameters: SEND_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const envelope = await sendMessage(params.to, params.message, params.reply_to);
        return toolResult({ status: "sent", id: envelope.id, to: envelope.to });
      } catch (error) {
        rethrowToolError(error, "SEND_FAILED");
      }
    },
  });

  pi.registerTool({
    name: "herdr_link_close",
    label: "Herdr Link Close",
    // Pi 默认并行执行同一 assistant response 的 sibling tool calls；close 与 send 同批时
    // 必须保证 send 先完成（"sent" 语义=Herdr 已接受投递），故 close 声明为 sequential，
    // 使含 close 的批次整体串行。peers/send 保持默认并行。
    executionMode: "sequential" as ToolExecutionMode,
    description:
      'Close the Herdr pane currently hosting a named agent. Sequential: if a final message is needed, send it first and call close in a later tool step after herdr_link_send returns status "sent".',
    parameters: CLOSE_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        await closeAgentPane(params.agent);
        return toolResult({ status: "closed", agent: params.agent });
      } catch (error) {
        rethrowToolError(error, "CLOSE_FAILED");
      }
    },
  });

  // --- Tier 0 gateway: the only model-visible Herdr surface while dormant.
  // It performs activation only; it never executes peers/send/close work.
  pi.registerTool({
    name: "herdr_link",
    label: "Herdr Link",
    description:
      "Activate the Herdr Link cross-agent communication channel (protocol herdr-link/1) for this session. Call once with empty arguments {} before using Herdr Link; this enables herdr_link_peers, herdr_link_send, and herdr_link_close.",
    promptSnippet: "Activate the Herdr Link cross-agent channel (peers/send/close).",
    parameters: GATEWAY_PARAMETERS,
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      activateChannel();
      return toolResult({ status: "active", capabilities: ["peers", "send", "close"] });
    },
  });

  // Additive-only change (official requirement): keep every currently active
  // tool — built-ins and other extensions' tools included — and enable Tier 1.
  function activateChannel(): void {
    if (activated) return;
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...TIER1_TOOL_NAMES])]);
    activated = true;
  }

  pi.on("session_start", () => {
    // Dormant presentation for this runtime session: drop any Tier 1 tools
    // from the active set (registration makes tools active by default) while
    // preserving built-ins, other extensions' tools, and the gateway itself.
    // Resetting `activated` keeps activation scoped to the current session.
    activated = false;
    pi.setActiveTools(pi.getActiveTools().filter((name) => !TIER1_TOOL_SET.has(name)));
  });

  pi.on("before_agent_start", (event) => {
    if (!activated) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${COMPACT_CONTRACT}` };
  });
}
