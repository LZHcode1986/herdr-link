import { tool, type Plugin } from "@opencode-ai/plugin";

import { closeAgentPane, listPeers, sendMessage } from "./herdr.ts";
import { startIdentityHeal, withIdentityHeal } from "./opencode-identity.ts";
import { COMMUNICATION_CONTRACT, HerdrLinkError } from "./protocol.ts";

const HERDR_LINK_TOOL_DESCRIPTION = {
  peers: "Discover named peers available through the cross-agent communication channel.",
  send: "Send a message to another agent through the cross-agent communication channel.",
  close:
    "Close the Herdr pane currently hosting a named agent. If you need to send a final message before closing, complete herdr_link_send first and call herdr_link_close in a later tool step.",
} as const;

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

function rethrowToolError(error: unknown): never {
  if (error instanceof HerdrLinkError) {
    throw new Error(error.message, { cause: error });
  }
  if (error instanceof Error) {
    throw error;
  }
  throw new Error(String(error));
}

export const herdrLinkPlugin: Plugin = async () => {
  if (!isHerdrEnvironment()) {
    return {};
  }

  startIdentityHeal();

  return {
    tool: {
      herdr_link_peers: tool({
        description: HERDR_LINK_TOOL_DESCRIPTION.peers,
        args: {},
        async execute() {
          try {
            return jsonResult(await withIdentityHeal(() => listPeers()));
          } catch (error) {
            rethrowToolError(error);
          }
        },
      }),
      herdr_link_send: tool({
        description: HERDR_LINK_TOOL_DESCRIPTION.send,
        args: {
          to: tool.schema.string().describe("Target Herdr agent name"),
          message: tool.schema.string().describe("Message payload"),
          reply_to: tool.schema.string().optional().describe("Message id being replied to"),
        },
        async execute(args) {
          try {
            const envelope = await withIdentityHeal(() =>
              sendMessage(args.to, args.message, args.reply_to),
            );
            return jsonResult({ status: "sent", id: envelope.id, to: envelope.to });
          } catch (error) {
            rethrowToolError(error);
          }
        },
      }),
      herdr_link_close: tool({
        description: HERDR_LINK_TOOL_DESCRIPTION.close,
        args: {
          agent: tool.schema.string().describe("Target Herdr agent name"),
        },
        async execute(args) {
          try {
            await withIdentityHeal(() => closeAgentPane(args.agent));
            return jsonResult({ status: "closed", agent: args.agent });
          } catch (error) {
            rethrowToolError(error);
          }
        },
      }),
    },
    "experimental.chat.system.transform": async (_input, output) => {
      if (!output.system.includes(COMMUNICATION_CONTRACT)) {
        output.system.push(COMMUNICATION_CONTRACT);
      }
    },
  };
};
