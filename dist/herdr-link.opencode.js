// src/opencode.ts
import { tool } from "@opencode-ai/plugin";

// src/herdr.ts
import { execFile } from "node:child_process";

// src/protocol.ts
var PROTOCOL_ID = "herdr-link/1";
var AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
var MESSAGE_ID_RE = /^hl_[a-z0-9]+_[a-z0-9]+$/;
var HerdrLinkError = class extends Error {
  code;
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "HerdrLinkError";
    this.code = code;
  }
};
var AGENT_ERROR_DETAILS = {
  NOT_IN_HERDR: "Herdr environment is unavailable",
  SELF_UNNAMED: "current Agent has no stable live name",
  PEER_NOT_FOUND: "target agent is not a live peer",
  SEND_FAILED: "Herdr did not accept message delivery",
  CLOSE_FAILED: "Herdr pane close failed"
};
function formatAgentFacingError(error, fallbackCode) {
  const code = error instanceof HerdrLinkError ? error.code : fallbackCode;
  return `${code}: ${AGENT_ERROR_DETAILS[code]}`;
}
function createMessageId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `hl_${ts}_${rand}`;
}
function isValidAgentName(name) {
  return AGENT_NAME_RE.test(name);
}
function isValidMessageId(id) {
  return MESSAGE_ID_RE.test(id);
}
function buildEnvelope(input) {
  if (!isValidAgentName(input.from)) {
    throw new HerdrLinkError(
      "SELF_UNNAMED",
      `self agent name "${input.from}" is not a valid Herdr agent name`
    );
  }
  if (!input.to || !isValidAgentName(input.to)) {
    throw new HerdrLinkError(
      "PEER_NOT_FOUND",
      `target agent name "${input.to}" is not a valid Herdr agent name`
    );
  }
  if (typeof input.message !== "string" || input.message.trim() === "") {
    throw new HerdrLinkError("SEND_FAILED", "message must be a non-empty string");
  }
  if (input.reply_to !== void 0 && !isValidMessageId(input.reply_to)) {
    throw new HerdrLinkError(
      "SEND_FAILED",
      "reply_to must be a valid herdr-link/1 message id when present"
    );
  }
  const envelope = {
    protocol: PROTOCOL_ID,
    id: createMessageId(),
    from: input.from,
    to: input.to,
    message: input.message
  };
  if (input.reply_to !== void 0) {
    envelope.reply_to = input.reply_to;
  }
  return envelope;
}
var COMMUNICATION_CONTRACT = `Herdr Link is the standard interoperability channel between agents
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

// src/herdr.ts
function attachCliOutput(error, stdout, stderr) {
  Object.assign(error, { stdout, stderr });
}
var defaultHerdrRunner = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { encoding: "utf8", shell: false }, (error, stdout, stderr) => {
    if (error) {
      attachCliOutput(error, String(stdout), String(stderr));
      reject(error);
      return;
    }
    resolve({ stdout: String(stdout), stderr: String(stderr) });
  });
});
var herdrRunner = defaultHerdrRunner;
function assertHerdrEnvironment() {
  if (process.env.HERDR_ENV !== "1") {
    throw new HerdrLinkError("NOT_IN_HERDR", "HERDR_ENV must be 1");
  }
  if (!process.env.HERDR_BIN_PATH) {
    throw new HerdrLinkError("NOT_IN_HERDR", "HERDR_BIN_PATH is missing");
  }
}
function describeError(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
function errorDetail(error) {
  if (error instanceof HerdrLinkError) {
    const prefix = `${error.code}: `;
    return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
  }
  return describeError(error);
}
function operationError(error, code) {
  return new HerdrLinkError(code, errorDetail(error));
}
function isClassifiedHerdrError(error) {
  return error instanceof HerdrLinkError && error.code !== "NOT_IN_HERDR";
}
async function runFor(args, failureCode) {
  assertHerdrEnvironment();
  try {
    return await runHerdr(args);
  } catch (error) {
    if (isClassifiedHerdrError(error)) throw error;
    throw operationError(error, failureCode);
  }
}
var CLI_ERROR_CODE_MAP = {
  agent_not_found: "PEER_NOT_FOUND"
};
function classifyCliError(error) {
  if (typeof error !== "object" || error === null) return void 0;
  const commandError = error;
  for (const output of [commandError.stdout, commandError.stderr]) {
    if (typeof output !== "string") continue;
    let payload;
    try {
      payload = JSON.parse(output);
    } catch {
      continue;
    }
    const errorPayload = asRecord(asRecord(payload)?.error);
    if (!errorPayload) continue;
    const cliCode = errorPayload.code;
    if (typeof cliCode !== "string" || cliCode.length === 0) continue;
    const cliMessage = errorPayload.message;
    const detail = typeof cliMessage === "string" && cliMessage.length > 0 ? `${cliCode}: ${cliMessage}` : cliCode;
    return new HerdrLinkError(CLI_ERROR_CODE_MAP[cliCode] ?? "NOT_IN_HERDR", detail);
  }
  return void 0;
}
async function runHerdr(args) {
  assertHerdrEnvironment();
  const binary = process.env.HERDR_BIN_PATH;
  try {
    const output = await herdrRunner(binary, args);
    return JSON.parse(output.stdout);
  } catch (error) {
    if (error instanceof HerdrLinkError) throw error;
    const cliError = classifyCliError(error);
    if (cliError) throw cliError;
    throw new HerdrLinkError("NOT_IN_HERDR", `Herdr command or JSON response failed: ${describeError(error)}`);
  }
}
function asRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  return value;
}
function agentRecord(value) {
  const root = asRecord(value);
  if (!root) return void 0;
  const result = asRecord(root.result);
  const nestedAgent = asRecord(result?.agent) ?? asRecord(root.agent);
  if (nestedAgent) return nestedAgent;
  if (typeof result?.name === "string" || typeof result?.pane_id === "string") return result;
  if (typeof root.name === "string" || typeof root.pane_id === "string") return root;
  return void 0;
}
function agentName(value) {
  if (typeof value === "string") return value || void 0;
  const agent = agentRecord(value);
  const name = agent?.name;
  return typeof name === "string" && name.length > 0 ? name : void 0;
}
function agentList(value) {
  const root = asRecord(value);
  const result = asRecord(root?.result);
  const agents = result?.agents ?? root?.agents;
  return Array.isArray(agents) ? agents : [];
}
function paneId(value) {
  const agent = agentRecord(value);
  const id = agent?.pane_id;
  return typeof id === "string" && id.length > 0 ? id : void 0;
}
async function getSelf() {
  assertHerdrEnvironment();
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) {
    throw new HerdrLinkError("SELF_UNNAMED", "HERDR_PANE_ID is missing");
  }
  let response;
  try {
    response = await runFor(["agent", "get", pane], "SELF_UNNAMED");
  } catch (error) {
    if (error instanceof HerdrLinkError && error.code === "PEER_NOT_FOUND") {
      throw new HerdrLinkError("SELF_UNNAMED", errorDetail(error));
    }
    throw error;
  }
  const name = agentName(response);
  if (!name || !isValidAgentName(name)) {
    throw new HerdrLinkError("SELF_UNNAMED", "current Herdr agent has no valid name");
  }
  return name;
}
async function listPeers() {
  const self = await getSelf();
  const response = await runFor(["agent", "list"], "NOT_IN_HERDR");
  const peers = agentList(response).map(agentName).filter((name) => name !== void 0 && isValidAgentName(name) && name !== self);
  return { self, peers };
}
async function sendMessage(to, message, reply_to) {
  const from = await getSelf();
  const envelope = buildEnvelope({ from, to, message, reply_to });
  await runFor(["agent", "prompt", to, JSON.stringify(envelope)], "SEND_FAILED");
  return { status: "sent", id: envelope.id, to };
}
async function closeAgentPane(agentName2) {
  assertHerdrEnvironment();
  if (!isValidAgentName(agentName2)) {
    throw new HerdrLinkError("PEER_NOT_FOUND", `target agent name "${agentName2}" is invalid`);
  }
  const response = await runFor(["agent", "get", agentName2], "PEER_NOT_FOUND");
  const pane = paneId(response);
  if (!pane) {
    throw new HerdrLinkError("PEER_NOT_FOUND", `target agent "${agentName2}" has no current pane`);
  }
  await runFor(["pane", "close", pane], "CLOSE_FAILED");
  return { status: "closed", agent: agentName2 };
}

// src/opencode.ts
var HERDR_LINK_TOOL_DESCRIPTION = {
  peers: "Discover named peers available through the cross-agent communication channel.",
  send: "Send a message to another agent through the cross-agent communication channel.",
  close: "Close the Herdr pane currently hosting a named agent. If you need to send a final message before closing, complete herdr_link_send first and call herdr_link_close in a later tool step."
};
function isHerdrEnvironment() {
  return process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_BIN_PATH) && Boolean(process.env.HERDR_PANE_ID);
}
function jsonResult(value) {
  return JSON.stringify(value);
}
function rethrowToolError(error, fallbackCode) {
  throw new Error(formatAgentFacingError(error, fallbackCode), { cause: error });
}
var herdrLinkPlugin = async () => {
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
            rethrowToolError(error, "NOT_IN_HERDR");
          }
        }
      }),
      herdr_link_send: tool({
        description: HERDR_LINK_TOOL_DESCRIPTION.send,
        args: {
          to: tool.schema.string().regex(AGENT_NAME_RE).describe("Target Herdr agent name"),
          message: tool.schema.string().min(1).describe("Non-empty message payload"),
          reply_to: tool.schema.string().regex(MESSAGE_ID_RE).optional().describe("Valid Herdr Link message id being replied to")
        },
        async execute(args) {
          try {
            const envelope = await sendMessage(args.to, args.message, args.reply_to);
            return jsonResult({ status: "sent", id: envelope.id, to: envelope.to });
          } catch (error) {
            rethrowToolError(error, "SEND_FAILED");
          }
        }
      }),
      herdr_link_close: tool({
        description: HERDR_LINK_TOOL_DESCRIPTION.close,
        args: {
          agent: tool.schema.string().regex(AGENT_NAME_RE).describe("Target Herdr agent name")
        },
        async execute(args) {
          try {
            await closeAgentPane(args.agent);
            return jsonResult({ status: "closed", agent: args.agent });
          } catch (error) {
            rethrowToolError(error, "CLOSE_FAILED");
          }
        }
      })
    },
    "experimental.chat.system.transform": async (_input, output) => {
      if (!output.system.includes(COMMUNICATION_CONTRACT)) {
        output.system.push(COMMUNICATION_CONTRACT);
      }
    }
  };
};
export {
  herdrLinkPlugin
};
