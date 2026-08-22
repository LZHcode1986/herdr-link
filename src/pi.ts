import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { closeAgentPane, listPeers, sendMessage } from "./herdr.ts";
import { COMMUNICATION_CONTRACT, HerdrLinkError } from "./protocol.ts";

const PEERS_PARAMETERS = Type.Object({});
const SEND_PARAMETERS = Type.Object({
  to: Type.String(),
  message: Type.String(),
  reply_to: Type.Optional(Type.String()),
});
const CLOSE_PARAMETERS = Type.Object({
  agent: Type.String(),
});

function toolResult(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
  };
}

function rethrowToolError(error: unknown): never {
  if (error instanceof HerdrLinkError) {
    // Pi marks errors thrown by execute() as tool errors. HerdrLinkError.message
    // already has the canonical `CODE: detail` form from protocol.ts.
    const toolError = new Error(error.message, { cause: error });
    throw toolError;
  }
  throw error;
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
    promptSnippet: "Use Herdr Link tools to communicate with other agents in this Herdr session.",
    promptGuidelines: [
      "herdr_link_peers discovers agent addresses in this Herdr session.",
      "herdr_link_peers does not use Herdr CLI, terminal input, pane reads, waits, or Skills for inter-agent messaging.",
      "herdr_link_peers does not choose, create, schedule, or recycle agents.",
    ],
    parameters: PEERS_PARAMETERS,
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      try {
        return toolResult(await listPeers());
      } catch (error) {
        rethrowToolError(error);
      }
    },
  });

  pi.registerTool({
    name: "herdr_link_send",
    label: "Herdr Link Send",
    description: "Send a message to another agent through the cross-agent communication channel.",
    promptSnippet: "Use Herdr Link tools to communicate with other agents in this Herdr session.",
    promptGuidelines: [
      "herdr_link_send communicates with other agents; put message content in the message field and set reply_to to the received message id when replying.",
      "herdr_link_send is the inter-agent messaging channel; do not use Herdr CLI, terminal input, pane reads, waits, or Skills instead.",
      "herdr_link_send does not choose, create, schedule, or recycle agents.",
    ],
    parameters: SEND_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const envelope = await sendMessage(params.to, params.message, params.reply_to);
        return toolResult({ status: "sent", id: envelope.id, to: envelope.to });
      } catch (error) {
        rethrowToolError(error);
      }
    },
  });

  pi.registerTool({
    name: "herdr_link_close",
    label: "Herdr Link Close",
    description: "Close the Herdr pane currently hosting a named agent.",
    promptSnippet: "Use Herdr Link tools to communicate with other agents in this Herdr session.",
    promptGuidelines: [
      "herdr_link_close closes a named agent's pane only when you have already decided to close it.",
      "herdr_link_close does not use Herdr CLI, terminal input, pane reads, waits, or Skills for inter-agent messaging.",
      "herdr_link_close does not choose, create, schedule, or recycle agents.",
    ],
    parameters: CLOSE_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        await closeAgentPane(params.agent);
        return toolResult({ status: "closed", agent: params.agent });
      } catch (error) {
        rethrowToolError(error);
      }
    },
  });
}
