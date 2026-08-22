import { tool, type Plugin, type ToolResult } from "@opencode-ai/plugin";

import { closeAgentPane, listPeers, sendMessage } from "./herdr.ts";
import { COMMUNICATION_CONTRACT, HerdrLinkError } from "./protocol.ts";

const HERDR_LINK_TOOL_DESCRIPTION = {
  peers: "Discover named peers available through the cross-agent communication channel.",
  send: "Send a message to another agent through the cross-agent communication channel.",
  close: "Close the Herdr pane currently hosting a named agent.",
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

function toolError(error: unknown): ToolResult {
  if (error instanceof HerdrLinkError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function hasCommunicationContract(
  messages: readonly { info: unknown; parts: readonly unknown[] }[],
): boolean {
  return messages.some(({ info, parts }) => {
    const role =
      typeof info === "object" && info !== null
        ? (info as { role?: unknown }).role
        : undefined;
    if (role !== "system") return false;

    return parts.some((part) => {
      if (typeof part !== "object" || part === null) return false;
      const candidate = part as { type?: unknown; text?: unknown };
      return (
        candidate.type === "text" &&
        typeof candidate.text === "string" &&
        candidate.text.includes(COMMUNICATION_CONTRACT)
      );
    });
  });
}

export const herdrLinkPlugin: Plugin = async () => {
  if (!isHerdrEnvironment()) {
    return {};
  }

  return {
    tool: {
      herdr_link_peers: tool({
        description: HERDR_LINK_TOOL_DESCRIPTION.peers,
        args: {},
        async execute() {
          try {
            return jsonResult(await listPeers());
          } catch (error) {
            return toolError(error);
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
            const envelope = await sendMessage(args.to, args.message, args.reply_to);
            return jsonResult({ status: "sent", id: envelope.id, to: envelope.to });
          } catch (error) {
            return toolError(error);
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
            await closeAgentPane(args.agent);
            return jsonResult({ status: "closed", agent: args.agent });
          } catch (error) {
            return toolError(error);
          }
        },
      }),
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      if (hasCommunicationContract(output.messages)) return;

      // OpenCode's transform message list is an internal representation. The
      // SDK's public Message union omits the system role, but the hook accepts
      // system messages and forwards their text parts to the model.
      output.messages.unshift({
        info: { role: "system" },
        parts: [{ type: "text", text: COMMUNICATION_CONTRACT }],
      } as never);
    },
  };
};
