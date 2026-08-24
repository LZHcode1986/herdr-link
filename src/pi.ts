import type { ExtensionAPI, ToolExecutionMode } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { closeAgentPane, listPeers, sendMessage } from "./herdr.ts";
import { AGENT_NAME_RE, COMMUNICATION_CONTRACT, formatAgentFacingError, MESSAGE_ID_RE } from "./protocol.ts";

const PEERS_PARAMETERS = Type.Object({});
const SEND_PARAMETERS = Type.Object({
  to: Type.String({ pattern: AGENT_NAME_RE.source }),
  message: Type.String({ minLength: 1 }),
  reply_to: Type.Optional(Type.String({ pattern: MESSAGE_ID_RE.source })),
});
const CLOSE_PARAMETERS = Type.Object({
  agent: Type.String({ pattern: AGENT_NAME_RE.source }),
});

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

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${COMMUNICATION_CONTRACT}`,
  }));

  pi.registerTool({
    name: "herdr_link_peers",
    label: "Herdr Link Peers",
    description: "Discover named peers available through the cross-agent communication channel.",
    promptSnippet: "Discover named agents available for Herdr Link communication.",
    promptGuidelines: [
      "Use herdr_link_peers when you need to discover agent addresses.",
    ],
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
    description: "Send a message to another agent through the cross-agent communication channel.",
    promptSnippet: "Send messages or replies to other Herdr Link agents.",
    promptGuidelines: [
      "Use herdr_link_send to send an inter-agent message.",
      "Use herdr_link_send with reply_to set to the received message id when replying.",
    ],
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
    description: "Close the Herdr pane currently hosting a named agent.",
    // Pi 默认并行执行同一 assistant response 的 sibling tool calls；close 与 send 同批时
    // 必须保证 send 先完成（"sent" 语义=Herdr 已接受投递），故 close 声明为 sequential，
    // 使含 close 的批次整体串行。peers/send 保持默认并行。
    executionMode: "sequential" as ToolExecutionMode,
    promptSnippet: "Close the Herdr pane currently hosting a named agent.",
    promptGuidelines: [
      "Use herdr_link_close only after deciding that the named agent's pane should be closed.",
    ],
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
}
