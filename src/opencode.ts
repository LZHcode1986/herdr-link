/**
 * Herdr Link OpenCode Runtime adapter v2 — single-gateway presentation.
 *
 * The model-facing surface is exactly one tiny `herdr_link` dispatcher tool,
 * in both dormant and active states. Calling it with no arguments (`{}`)
 * idempotently activates the channel for the CURRENT session and returns
 * `{ status: "active", capabilities: ["peers", "send", "close"] }`; while a
 * session is active the same gateway executes deterministic actions
 * (`action`: "peers" | "send" | "close") against the core control layer and
 * the compact Communication Contract is injected into that session's system
 * prompt. The three Tier 1 tools are never registered as always-resident
 * surfaces.
 *
 * API basis (public @opencode-ai/plugin 1.18.x only):
 * - `Hooks.tool` registers tools process-wide; there is no public per-session
 *   registration or dynamic unload, hence the single-gateway fallback instead
 *   of Pi-style `setActiveTools`.
 * - `ToolContext.sessionID` attributes each gateway execution to its session;
 *   the per-session ephemeral activation set lives in the plugin closure.
 * - `experimental.chat.system.transform` input carries `sessionID?`; it is
 *   OPTIONAL in the public types, so injection fails closed when it is absent
 *   (an unattributable system build is never treated as active).
 *
 * Known sessionID limitations (explicit):
 * - `Hooks.tool.definition` exposes only `toolID` (no sessionID), so mutating
 *   tool schemas per session cannot be done safely; the gateway schema is
 *   static and admits both `{}` (activate) and fully-formed actions.
 * - The activation set is in-memory per plugin instance: restarting the
 *   OpenCode server returns every session to dormant until it re-activates.
 */
import { tool, type Plugin } from "@opencode-ai/plugin";

import { closeAgentPane, listPeers, sendMessage } from "./herdr.ts";
import {
  COMMUNICATION_CONTRACT,
  HERDR_LINK_GATEWAY,
  HerdrLinkError,
  formatAgentFacingError,
  type LinkErrorCode,
} from "./protocol.ts";

/** Runtime-specific active presentation; the semantic Contract remains canonical. */
const GATEWAY_PRESENTATION_APPENDIX = `In this runtime the active Herdr Link capabilities are dispatched through the single herdr_link gateway.
- Use herdr_link with action "peers" to list live same-workspace agents.
- Use herdr_link with action "send", to, message, and reply_to when replying.
- Use herdr_link with action "close" and an Agent Name only after any final send returns status "sent", in a later tool step.`;

const GATEWAY_CONTRACT = `${COMMUNICATION_CONTRACT}\n\n${GATEWAY_PRESENTATION_APPENDIX}`;

function isHerdrEnvironment(): boolean {
  return (
    process.env.HERDR_ENV === "1" &&
    Boolean(process.env.HERDR_BIN_PATH) &&
    Boolean(process.env.HERDR_PANE_ID)
  );
}

function jsonResult(value: object): string {
  return JSON.stringify(value);
}

/** Throws the stable `${CODE}: ${detail}` Agent-facing message; causes stay internal. */
function failWith(error: unknown, fallbackCode: LinkErrorCode): never {
  throw new Error(formatAgentFacingError(error, fallbackCode), { cause: error });
}

/** Dispatcher-level usage guard for actions rejected by the schema anyway. */
function failInvalidAction(action: string): never {
  throw new Error(
    `INVALID_ACTION: herdr_link action "${action}" is not supported; use "peers", "send", "close", or omit action (call with {}) to activate.`,
  );
}

export const herdrLinkPlugin: Plugin = async () => {
  if (!isHerdrEnvironment()) {
    return {};
  }

  // Per-runtime-session activation set. Ephemeral by design: in-memory only,
  // scoped to this plugin instance, never persisted, never shared across
  // instances. Losing it (server restart) merely returns sessions to dormant.
  const activatedSessions = new Set<string>();

  return {
    tool: {
      [HERDR_LINK_GATEWAY]: tool({
        description:
          "Herdr Link cross-agent communication gateway (herdr-link/1). Activate only when the user explicitly asks to use Herdr or when handling an inbound Herdr Link message. " +
          'Call once with no arguments {} to activate Herdr Link for this session; the response lists capabilities. ' +
            'Then pass action "peers" to list live same-workspace agents, "send" with to + message (plus reply_to when replying) to deliver an inter-agent message, or "close" with agent to close a named agent\'s pane — ' +
            'only after any final send has returned status "sent", and in a later tool step.',
        args: {
          action: tool.schema
            .enum(["peers", "send", "close"])
            .optional()
            .describe(
              'Operation to run: "peers" | "send" | "close". Omit action entirely (call with {}) to activate Herdr Link for this session.',
            ),
          to: tool.schema
            .string()
            .optional()
            .describe('Target agent name; required for action "send".'),
          message: tool.schema
            .string()
            .optional()
            .describe('Message payload; required for action "send".'),
          reply_to: tool.schema
            .string()
            .optional()
            .describe('Message id being replied to; optional, only with action "send".'),
          agent: tool.schema
            .string()
            .optional()
            .describe('Target agent name; required for action "close".'),
        },
        async execute(args, context) {
          if (args.action === undefined) {
            activatedSessions.add(context.sessionID);
            return jsonResult({ status: "active", capabilities: ["peers", "send", "close"] });
          }
          // Gateway action dispatch is also an explicit activation path for
          // hosts that bypass the empty gateway call or do not refresh schemas.
          activatedSessions.add(context.sessionID);

          if (args.action === "peers") {
            try {
              return jsonResult(await listPeers());
            } catch (error) {
              failWith(error, "NOT_IN_HERDR");
            }
          }

          if (args.action === "send") {
            if (typeof args.to !== "string" || args.to === "") {
              failWith(new HerdrLinkError("SEND_FAILED", '"to" must be a non-empty string'), "SEND_FAILED");
            }
            if (typeof args.message !== "string" || args.message === "") {
              failWith(new HerdrLinkError("SEND_FAILED", '"message" must be a non-empty string'), "SEND_FAILED");
            }
            try {
              const envelope = await sendMessage(args.to, args.message, args.reply_to);
              return jsonResult({ status: "sent", id: envelope.id, to: envelope.to });
            } catch (error) {
              failWith(error, "SEND_FAILED");
            }
          }

          if (args.action === "close") {
            if (typeof args.agent !== "string" || args.agent === "") {
              failWith(new HerdrLinkError("CLOSE_FAILED", '"agent" must be a non-empty string'), "CLOSE_FAILED");
            }
            try {
              await closeAgentPane(args.agent);
              return jsonResult({ status: "closed", agent: args.agent });
            } catch (error) {
              failWith(error, "CLOSE_FAILED");
            }
          }

          failInvalidAction(String(args.action));
        },
      }),
    },
    "experimental.chat.system.transform": async (input, output) => {
      // Fail closed: an optional/absent sessionID cannot be attributed to an
      // activation, so the Contract is withheld rather than guessed.
      if (input.sessionID === undefined || !activatedSessions.has(input.sessionID)) {
        return;
      }
      if (!output.system.includes(GATEWAY_CONTRACT)) {
        output.system.push(GATEWAY_CONTRACT);
      }
    },
  };
};
