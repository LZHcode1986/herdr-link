/** Herdr Link OpenCode 2 adapter. V1 adapter stays in src/opencode.ts. */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import type { Plugin as OpenCode2Plugin } from "@opencode/plugin/promise/plugin";

import {
  closeAgentPane,
  ensureSelfName,
  getSelfContext,
  listPeers,
  listWorkspacePanes,
  sendMessage,
  startAgent,
} from "./herdr.ts";
import {
  COMMUNICATION_CONTRACT,
  HERDR_LINK_GATEWAY,
  HerdrLinkError,
  START_TOOL_DESCRIPTION,
  formatAgentFacingError,
  type LinkErrorCode,
  type StartAgentInput,
} from "./protocol.ts";

const GATEWAY_PRESENTATION_APPENDIX = `In this runtime the active Herdr Link capabilities are dispatched through the single herdr_link gateway.
- Use herdr_link with action "start": ${START_TOOL_DESCRIPTION}
- Use herdr_link with action "peers" to list live same-workspace agents.
- Use herdr_link with action "send" with to and message to deliver an inter-agent message or ordinary reply.
- Use herdr_link with action "close" and an Agent Name to close the explicitly named pane. The caller owns the lifecycle decision; Herdr Link only performs the close. Invoke it as a standalone later tool step after any earlier Herdr Link operation has completed. Closing sends no message.`;
const GATEWAY_CONTRACT = `${COMMUNICATION_CONTRACT}\n\n${GATEWAY_PRESENTATION_APPENDIX}`;

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["start", "peers", "send", "close"], description: "Operation, omitted to activate this session." },
    to: { type: "string", description: "Target Agent Name for send." },
    message: { type: "string", description: "Message content for send." },
    agent: { type: "string", description: "Agent Name for close." },
    name: { type: "string", description: "New Agent Name for start." },
    with: { type: "string", description: "Existing Agent Name to co-locate with for start." },
    cwd: { type: "string", description: "Working directory for start in a new tab." },
    config_agent: { type: "string", description: "Configured Agent key for start." },
    kind: { type: "string", description: "Explicit Agent kind for start." },
    args: { type: "array", items: { type: "string" }, description: "Complete explicit Agent arguments for start." },
  },
  additionalProperties: false,
} as const;

type GatewayInput = {
  action?: "start" | "peers" | "send" | "close";
  to?: string;
  message?: string;
  agent?: string;
  name?: string;
  with?: string;
  cwd?: string;
  config_agent?: string;
  kind?: string;
  args?: string[];
};

function isHerdrEnvironment(): boolean {
  return process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_BIN_PATH) && Boolean(process.env.HERDR_PANE_ID);
}

function failWith(error: unknown, fallback: LinkErrorCode): never {
  throw new Error(formatAgentFacingError(error, fallback), { cause: error });
}

function jsonResult(value: object): { content: string } {
  return { content: JSON.stringify(value) };
}

/** Absolute, symlink-resolved, Windows-case-folded directory for identity comparison. */
function normalizeDirectory(directory: string): string {
  let normalized: string;
  try {
    normalized = realpathSync.native(resolve(directory));
  } catch {
    normalized = resolve(directory);
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** All live directory facts a pane exposes, normalized for comparison. */
function paneDirectories(pane: { cwd?: string; foreground_cwd?: string }): string[] {
  return [pane.cwd, pane.foreground_cwd]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(normalizeDirectory);
}

/** The public V2 API accepts an id/setup object without a runtime SDK import. */
export const herdrLinkV2Plugin: OpenCode2Plugin = {
  id: "herdr-link",
  async setup(ctx) {
    if (!isHerdrEnvironment()) return;

    // Identity initialization must not block plugin setup. Tool calls retry resolution.
    void ensureSelfName().catch(() => {});
    const activatedSessions = new Set<string>();

    /**
     * Session identity attribution (design contract §3.2). Resolves the calling
     * session's project directory and proves it identifies exactly one live
     * pane in the caller's workspace — the caller's own. Directory agreement is
     * necessary but not sufficient: when several panes share the same project
     * directory the attribution is ambiguous and the operation fails closed
     * instead of guessing. Never falls back to the plugin location or the
     * process working directory.
     */
    const resolveSessionDirectory = async (sessionID: string): Promise<string> => {
      let raw: unknown;
      try {
        const session = await ctx.session.get({ sessionID });
        raw = session?.location?.directory;
      } catch {
        throw new HerdrLinkError("SELF_UNNAMED", "session project directory could not be resolved");
      }
      if (typeof raw !== "string" || raw.length === 0) {
        throw new HerdrLinkError("SELF_UNNAMED", "session project directory could not be resolved");
      }
      const directory = normalizeDirectory(raw);

      const self = await getSelfContext();
      if (self.workspace_id === "") {
        throw new HerdrLinkError("SELF_UNNAMED", "caller workspace is unavailable");
      }
      const panes = await listWorkspacePanes(self.workspace_id);
      const matching = panes.filter((pane) => paneDirectories(pane).includes(directory));
      if (matching.length !== 1 || matching[0]!.pane_id !== self.pane_id) {
        throw new HerdrLinkError(
          "SELF_UNNAMED",
          "session project directory does not uniquely identify the calling pane",
        );
      }
      return directory;
    };

    await ctx.tool.transform((editor) => {
      editor.add({
        name: HERDR_LINK_GATEWAY,
        description:
          "Herdr Link cross-agent control gateway (herdr-link/1). Activate only when the user explicitly asks to use Herdr or when handling an inbound Herdr Link message. " +
          'Call once with no arguments {} to activate Herdr Link for this session; the response lists capabilities. ' +
          'Then pass action "start" with name and either config_agent or complete kind + args (with to co-locate with a live agent, cwd for a new-tab working directory), ' +
          'action "peers" to list live agents, action "send" with to + message, or action "close" with agent as a standalone later step. Closing never sends a message.',
        input: INPUT_SCHEMA,
        async execute(rawInput, context) {
          const input = rawInput as GatewayInput;
          activatedSessions.add(context.sessionID);

          if (input.action === undefined) {
            return jsonResult({ status: "active", capabilities: ["start", "peers", "send", "close"] });
          }
          if (input.action === "start") {
            const startInput = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "action"));
            try {
              const contextDirectory = await resolveSessionDirectory(context.sessionID);
              return jsonResult(await startAgent(startInput as unknown as StartAgentInput, { contextDirectory }));
            } catch (error) {
              failWith(error, "START_FAILED");
            }
          }
          if (input.action === "peers") {
            try {
              await resolveSessionDirectory(context.sessionID);
              return jsonResult(await listPeers());
            } catch (error) {
              failWith(error, "NOT_IN_HERDR");
            }
          }
          if (input.action === "send") {
            if (typeof input.to !== "string" || !input.to) {
              failWith(new HerdrLinkError("SEND_FAILED", '"to" must be a non-empty string'), "SEND_FAILED");
            }
            if (typeof input.message !== "string" || !input.message) {
              failWith(new HerdrLinkError("SEND_FAILED", '"message" must be a non-empty string'), "SEND_FAILED");
            }
            try {
              await resolveSessionDirectory(context.sessionID);
              const envelope = await sendMessage(input.to, input.message);
              return jsonResult({ status: "sent", id: envelope.id, to: envelope.to });
            } catch (error) {
              failWith(error, "SEND_FAILED");
            }
          }
          if (input.action === "close") {
            if (typeof input.agent !== "string" || !input.agent) {
              failWith(new HerdrLinkError("CLOSE_FAILED", '"agent" must be a non-empty string'), "CLOSE_FAILED");
            }
            try {
              await resolveSessionDirectory(context.sessionID);
              return jsonResult(await closeAgentPane(input.agent));
            } catch (error) {
              failWith(error, "CLOSE_FAILED");
            }
          }
          throw new Error(`INVALID_ACTION: unsupported action "${String(input.action)}"`);
        },
      });
    });

    await ctx.session.hook("context", (event) => {
      if (!activatedSessions.has(event.sessionID)) return;
      if (!event.system.some((item) => item.type === "text" && item.text === GATEWAY_CONTRACT)) {
        event.system.push({ type: "text", text: GATEWAY_CONTRACT });
      }
    });
  },
};

export default herdrLinkV2Plugin;
