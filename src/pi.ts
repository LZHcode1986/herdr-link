import { closeAgentPane, listPeers, sendMessage } from "./herdr.ts";
import { COMMUNICATION_CONTRACT, HerdrLinkError } from "./protocol.ts";

type TextContent = {
  type: "text";
  text: string;
};

type PiToolResult = {
  content: TextContent[];
  details?: unknown;
};

type StringSchema = Readonly<{
  type: "string";
  description?: string;
}>;

type ObjectSchema = Readonly<{
  type: "object";
  properties: Readonly<Record<string, StringSchema>>;
  required?: readonly string[];
}>;

type ToolDefinition<TParams> = {
  name: string;
  label: string;
  description: string;
  parameters: ObjectSchema;
  execute(
    toolCallId: string,
    params: TParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<PiToolResult>;
};

type BeforeAgentStartEvent = {
  systemPrompt: string;
};

type PiExtensionAPI = {
  on(
    event: "before_agent_start",
    handler: (event: BeforeAgentStartEvent) => BeforeAgentStartEventResult,
  ): void;
  registerTool<TParams>(definition: ToolDefinition<TParams>): void;
};

type BeforeAgentStartEventResult = {
  systemPrompt: string;
};

type SendParams = {
  to: string;
  message: string;
  reply_to?: string;
};

type CloseParams = {
  agent: string;
};

type NoParams = Record<string, never>;

const PEERS_PARAMETERS = {
  type: "object",
  properties: {},
} as const satisfies ObjectSchema;

const SEND_PARAMETERS = {
  type: "object",
  required: ["to", "message"],
  properties: {
    to: { type: "string", description: "Target agent name" },
    message: { type: "string", description: "Message content" },
    reply_to: { type: "string", description: "ID of the message being answered" },
  },
} as const satisfies ObjectSchema;

const CLOSE_PARAMETERS = {
  type: "object",
  required: ["agent"],
  properties: {
    agent: { type: "string", description: "Agent name to close" },
  },
} as const satisfies ObjectSchema;

function toolResult(value: object): PiToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
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

export default function (pi: PiExtensionAPI): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${COMMUNICATION_CONTRACT}`,
  }));

  pi.registerTool<NoParams>({
    name: "herdr_link_peers",
    label: "Herdr Link Peers",
    description: "Discover named peers available through the cross-agent communication channel.",
    parameters: PEERS_PARAMETERS,
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      try {
        return toolResult(await listPeers());
      } catch (error) {
        rethrowToolError(error);
      }
    },
  });

  pi.registerTool<SendParams>({
    name: "herdr_link_send",
    label: "Herdr Link Send",
    description: "Send a message to another agent through the cross-agent communication channel.",
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

  pi.registerTool<CloseParams>({
    name: "herdr_link_close",
    label: "Herdr Link Close",
    description: "Close a named agent through the cross-agent communication channel.",
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
