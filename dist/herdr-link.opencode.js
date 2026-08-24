// src/opencode.ts
import { tool } from "@opencode-ai/plugin";

// src/herdr.ts
import { execFile } from "node:child_process";

// src/protocol.ts
var PROTOCOL_ID = "herdr-link/1";
var AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
var MESSAGE_ID_RE = /^hl_[a-z0-9]+_[a-z0-9]+$/;
var HERDR_LINK_GATEWAY = "herdr_link";
var AGENT_STATES = ["idle", "working", "blocked", "done", "unknown"];
function toAgentState(value) {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (AGENT_STATES.includes(normalized)) {
      return normalized;
    }
  }
  return "unknown";
}
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
  const rand = Math.random().toString(36).slice(2, 10) || "0";
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
var INBOUND_WRAPPER_MARKER = `[${PROTOCOL_ID}]`;
function buildInboundWrapper(envelope) {
  const lines = [
    `${INBOUND_WRAPPER_MARKER} inter-agent message delivered through the ${HERDR_LINK_GATEWAY} gateway.`,
    `From: ${envelope.from}`,
    `Message id: ${envelope.id}`
  ];
  if (envelope.reply_to !== void 0) {
    lines.push(`Reply to: ${envelope.reply_to}`);
  }
  lines.push(
    "",
    "The JSON object below is the complete herdr-link/1 envelope; the text around it is delivery metadata and is not part of the message.",
    `Treat the envelope's "message" field as content sent by the agent named in "from".`,
    "If a reply is needed, activate the Herdr Link gateway when dormant, then use the active Herdr Link send capability to send to envelope.from with reply_to set to envelope.id.",
    "",
    JSON.stringify(envelope)
  );
  return lines.join("\n");
}
var COMMUNICATION_CONTRACT = `Herdr Link is the standard interoperability channel between agents running in the same Herdr workspace.

1. Use herdr_link_peers to discover agent addresses; it lists only live agents in your own workspace, each with an advisory activity state.
2. Use herdr_link_send to send messages to another agent.
3. A message with protocol "herdr-link/1" is an inter-agent message.
4. Treat its "message" field as content sent by the agent named in "from".
5. When replying, send to the received "from" agent and set reply_to to the received "id".
6. Use herdr_link_close only when you have already decided that a named agent's pane should be closed. If a final message is needed, call close in a later tool step after herdr_link_send returns "sent".
7. Never use a raw pane id, UI focus, terminal input, or the Herdr CLI as an inter-agent channel; agent names are the only addresses.
8. Agents outside your workspace are invisible: they never appear in peers and messages addressed to them fail.`;

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
var HerdrCliError = class extends Error {
  cliCode;
  constructor(cliCode, detail) {
    super(detail);
    this.name = "HerdrCliError";
    this.cliCode = cliCode;
  }
};
async function runFor(args, failureCode) {
  assertHerdrEnvironment();
  try {
    return await runHerdr(args);
  } catch (error) {
    if (error instanceof HerdrCliError) throw operationError(error, failureCode);
    if (error instanceof HerdrLinkError) throw error;
    throw operationError(error, failureCode);
  }
}
var CLI_ERROR_CODE_MAP = {
  agent_not_found: "PEER_NOT_FOUND",
  not_in_herdr: "NOT_IN_HERDR"
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
    const mappedCode = CLI_ERROR_CODE_MAP[cliCode];
    return mappedCode ? new HerdrLinkError(mappedCode, detail) : new HerdrCliError(cliCode, detail);
  }
  return void 0;
}
async function runHerdr(args) {
  assertHerdrEnvironment();
  const binary = process.env.HERDR_BIN_PATH;
  try {
    const output = await herdrRunner(binary, args);
    const parsed = JSON.parse(output.stdout);
    const cliError = classifyCliError(output);
    if (cliError) throw cliError;
    return parsed;
  } catch (error) {
    if (error instanceof HerdrLinkError || error instanceof HerdrCliError) throw error;
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
function agentList(value) {
  const root = asRecord(value);
  const result = asRecord(root?.result);
  const agents = result?.agents ?? root?.agents;
  return Array.isArray(agents) ? agents : [];
}
function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function validAgentNameValue(value) {
  const name = nonEmptyString(value);
  return name !== void 0 && isValidAgentName(name) ? name : void 0;
}
function readLiveRecord(value) {
  const agent = agentRecord(value);
  return {
    name: validAgentNameValue(agent?.name),
    workspace_id: nonEmptyString(agent?.workspace_id),
    pane_id: nonEmptyString(agent?.pane_id),
    live: typeof agent?.live === "boolean" ? agent.live : void 0
  };
}
function readStatus(value) {
  const agent = agentRecord(value);
  return toAgentState(agent?.agent_status ?? agent?.status);
}
function isExcludedEntry(value) {
  return agentRecord(value)?.live === false;
}
async function getSelfContext() {
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
  const record = readLiveRecord(response);
  if (record.live === false || !record.name) {
    throw new HerdrLinkError("SELF_UNNAMED", "current Herdr agent has no valid name");
  }
  return {
    name: record.name,
    workspace_id: record.workspace_id ?? "",
    pane_id: record.pane_id ?? pane,
    agent_status: readStatus(response)
  };
}
async function getAgentContext(name) {
  assertHerdrEnvironment();
  if (!isValidAgentName(name)) {
    throw new HerdrLinkError("PEER_NOT_FOUND", `target agent name "${name}" is invalid`);
  }
  const response = await runFor(["agent", "get", name], "PEER_NOT_FOUND");
  const record = readLiveRecord(response);
  if (record.live === false || !record.name || record.name !== name) {
    throw new HerdrLinkError("PEER_NOT_FOUND", `target agent "${name}" has no valid live record`);
  }
  return {
    name: record.name,
    workspace_id: record.workspace_id ?? "",
    pane_id: record.pane_id ?? "",
    agent_status: readStatus(response)
  };
}
function assertSameWorkspace(self, target) {
  if (self.workspace_id === "" || target.workspace_id === "" || self.workspace_id !== target.workspace_id) {
    throw new HerdrLinkError("PEER_NOT_FOUND", AGENT_ERROR_DETAILS.PEER_NOT_FOUND);
  }
}
async function listPeers() {
  const self = await getSelfContext();
  const response = await runFor(["agent", "list"], "NOT_IN_HERDR");
  const peers = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of agentList(response)) {
    const record = readLiveRecord(entry);
    if (!record.name || seen.has(record.name)) continue;
    seen.add(record.name);
    if (record.name === self.name) continue;
    if (self.workspace_id === "" || record.workspace_id !== self.workspace_id) continue;
    if (isExcludedEntry(entry)) continue;
    peers.push({ name: record.name, state: readStatus(entry) });
  }
  return { self: { name: self.name, state: self.agent_status }, peers };
}
async function sendMessage(to, message, reply_to) {
  const self = await getSelfContext();
  const target = await getAgentContext(to);
  assertSameWorkspace(self, target);
  const envelope = buildEnvelope({
    from: self.name,
    to: target.name,
    message,
    reply_to
  });
  await runFor(["agent", "prompt", target.name, buildInboundWrapper(envelope)], "SEND_FAILED");
  return { status: "sent", id: envelope.id, to: target.name };
}
async function getSelfWorkspaceId() {
  assertHerdrEnvironment();
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) {
    throw new HerdrLinkError("PEER_NOT_FOUND", AGENT_ERROR_DETAILS.PEER_NOT_FOUND);
  }
  const response = await runFor(["agent", "get", pane], "NOT_IN_HERDR");
  const record = readLiveRecord(response);
  if (record.live === false || !record.workspace_id) {
    throw new HerdrLinkError("PEER_NOT_FOUND", AGENT_ERROR_DETAILS.PEER_NOT_FOUND);
  }
  return record.workspace_id;
}
async function closeAgentPane(agentName) {
  assertHerdrEnvironment();
  if (!isValidAgentName(agentName)) {
    throw new HerdrLinkError("PEER_NOT_FOUND", `target agent name "${agentName}" is invalid`);
  }
  const selfWorkspaceId = await getSelfWorkspaceId();
  const target = await getAgentContext(agentName);
  if (target.workspace_id === "" || target.workspace_id !== selfWorkspaceId) {
    throw new HerdrLinkError("PEER_NOT_FOUND", AGENT_ERROR_DETAILS.PEER_NOT_FOUND);
  }
  if (!target.pane_id) {
    throw new HerdrLinkError("PEER_NOT_FOUND", `target agent "${agentName}" has no current pane`);
  }
  await runFor(["pane", "close", target.pane_id], "CLOSE_FAILED");
  return { status: "closed", agent: target.name };
}

// src/opencode.ts
var GATEWAY_PRESENTATION_APPENDIX = `In this runtime the active Herdr Link capabilities are dispatched through the single herdr_link gateway.
- Use herdr_link with action "peers" to list live same-workspace agents.
- Use herdr_link with action "send", to, message, and reply_to when replying.
- Use herdr_link with action "close" and an Agent Name only after any final send returns status "sent", in a later tool step.`;
var GATEWAY_CONTRACT = `${COMMUNICATION_CONTRACT}

${GATEWAY_PRESENTATION_APPENDIX}`;
function isHerdrEnvironment() {
  return process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_BIN_PATH) && Boolean(process.env.HERDR_PANE_ID);
}
function jsonResult(value) {
  return JSON.stringify(value);
}
function failWith(error, fallbackCode) {
  throw new Error(formatAgentFacingError(error, fallbackCode), { cause: error });
}
function failInvalidAction(action) {
  throw new Error(
    `INVALID_ACTION: herdr_link action "${action}" is not supported; use "peers", "send", "close", or omit action (call with {}) to activate.`
  );
}
var herdrLinkPlugin = async () => {
  if (!isHerdrEnvironment()) {
    return {};
  }
  const activatedSessions = /* @__PURE__ */ new Set();
  return {
    tool: {
      [HERDR_LINK_GATEWAY]: tool({
        description: `Herdr Link cross-agent communication gateway (herdr-link/1). Activate only when the user explicitly asks to use Herdr or when handling an inbound Herdr Link message. Call once with no arguments {} to activate Herdr Link for this session; the response lists capabilities. Then pass action "peers" to list live same-workspace agents, "send" with to + message (plus reply_to when replying) to deliver an inter-agent message, or "close" with agent to close a named agent's pane \u2014 only after any final send has returned status "sent", and in a later tool step.`,
        args: {
          action: tool.schema.enum(["peers", "send", "close"]).optional().describe(
            'Operation to run: "peers" | "send" | "close". Omit action entirely (call with {}) to activate Herdr Link for this session.'
          ),
          to: tool.schema.string().optional().describe('Target agent name; required for action "send".'),
          message: tool.schema.string().optional().describe('Message payload; required for action "send".'),
          reply_to: tool.schema.string().optional().describe('Message id being replied to; optional, only with action "send".'),
          agent: tool.schema.string().optional().describe('Target agent name; required for action "close".')
        },
        async execute(args, context) {
          if (args.action === void 0) {
            activatedSessions.add(context.sessionID);
            return jsonResult({ status: "active", capabilities: ["peers", "send", "close"] });
          }
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
        }
      })
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (input.sessionID === void 0 || !activatedSessions.has(input.sessionID)) {
        return;
      }
      if (!output.system.includes(GATEWAY_CONTRACT)) {
        output.system.push(GATEWAY_CONTRACT);
      }
    }
  };
};
export {
  herdrLinkPlugin
};
