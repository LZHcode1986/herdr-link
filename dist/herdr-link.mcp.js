// src/mcp.ts
import { pathToFileURL } from "node:url";

// src/herdr.ts
import { execFile } from "node:child_process";

// src/protocol.ts
var PROTOCOL_ID = "herdr-link/1";
var AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
var HerdrLinkError = class extends Error {
  code;
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "HerdrLinkError";
    this.code = code;
  }
};
function createMessageId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `hl_${ts}_${rand}`;
}
function isValidAgentName(name) {
  return AGENT_NAME_RE.test(name);
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
  if (input.reply_to !== void 0 && (typeof input.reply_to !== "string" || input.reply_to === "")) {
    throw new HerdrLinkError("SEND_FAILED", "reply_to must be a non-empty string when present");
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
6. Use herdr_link_close only when you have already decided that a named agent's pane should be closed.
7. Never use a raw pane id or UI focus as an inter-agent address.
8. Do not use Herdr CLI, terminal input, pane reads, waits, or Skills for normal inter-agent messaging.
9. Herdr Link does not choose, create, configure, schedule, or recycle agents.`;
var HERDR_LINK_TOOLS = ["herdr_link_peers", "herdr_link_send", "herdr_link_close"];

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

// src/mcp.ts
var MCP_SERVER_NAME = "herdr-link";
var MCP_SERVER_VERSION = "0.1.0";
var MCP_PROTOCOL_VERSION = "2025-06-18";
var PARSE_ERROR = -32700;
var INVALID_REQUEST = -32600;
var METHOD_NOT_FOUND = -32601;
var INVALID_PARAMS = -32602;
var TOOL_DESCRIPTIONS = {
  herdr_link_peers: "Discover named peers available through the cross-agent communication channel.",
  herdr_link_send: "Send a message to another agent through the cross-agent communication channel.",
  herdr_link_close: "Close the Herdr pane currently hosting a named agent. If you need to send a final message before closing, complete herdr_link_send first and call herdr_link_close in a later tool step."
};
var TOOL_INPUT_SCHEMAS = {
  herdr_link_peers: { type: "object", properties: {} },
  herdr_link_send: {
    type: "object",
    properties: {
      to: { type: "string", description: "Target Herdr agent name" },
      message: { type: "string", description: "Message payload" },
      reply_to: { type: "string", description: "Message id being replied to" }
    },
    required: ["to", "message"]
  },
  herdr_link_close: {
    type: "object",
    properties: {
      agent: { type: "string", description: "Target Herdr agent name" }
    },
    required: ["agent"]
  }
};
var FALLBACK_ERROR_CODE = {
  herdr_link_peers: "NOT_IN_HERDR",
  herdr_link_send: "SEND_FAILED",
  herdr_link_close: "CLOSE_FAILED"
};
function isHerdrEnvironment() {
  return process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_BIN_PATH) && Boolean(process.env.HERDR_PANE_ID);
}
function toolDefinitions() {
  return HERDR_LINK_TOOLS.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: TOOL_INPUT_SCHEMAS[name]
  }));
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function describeError2(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
function requireStringArg(args, key, code) {
  const value = args[key];
  if (typeof value !== "string") {
    throw new HerdrLinkError(code, `"${key}" must be a string`);
  }
  return value;
}
function optionalStringArg(args, key, code) {
  const value = args[key];
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string") {
    throw new HerdrLinkError(code, `"${key}" must be a string when present`);
  }
  return value;
}
function createRequestHandler(deps = {}) {
  const environmentOk = deps.environmentOk ?? isHerdrEnvironment;
  const runPeers = deps.listPeers ?? listPeers;
  const runSend = deps.sendMessage ?? sendMessage;
  const runClose = deps.closeAgentPane ?? closeAgentPane;
  function respond(id, result) {
    return { jsonrpc: "2.0", id, result };
  }
  function fail(id, code, message) {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }
  async function callTool(id, params) {
    const name = params.name;
    if (typeof name !== "string" || !HERDR_LINK_TOOLS.includes(name)) {
      return fail(id, INVALID_PARAMS, `Unknown tool: ${String(name ?? "")}`);
    }
    const canonicalName = name;
    const rawArguments = params.arguments;
    const args = isRecord(rawArguments) ? rawArguments : {};
    try {
      let value;
      switch (canonicalName) {
        case "herdr_link_peers":
          value = await runPeers();
          break;
        case "herdr_link_send": {
          const to = requireStringArg(args, "to", "PEER_NOT_FOUND");
          const message = requireStringArg(args, "message", "SEND_FAILED");
          const reply_to = optionalStringArg(args, "reply_to", "SEND_FAILED");
          const sent = await runSend(to, message, reply_to);
          value = { status: sent.status, id: sent.id, to: sent.to };
          break;
        }
        case "herdr_link_close": {
          const agent = requireStringArg(args, "agent", "PEER_NOT_FOUND");
          value = await runClose(agent);
          break;
        }
      }
      return respond(id, { content: [{ type: "text", text: JSON.stringify(value) }] });
    } catch (error) {
      const linkError = error instanceof HerdrLinkError ? error : new HerdrLinkError(FALLBACK_ERROR_CODE[canonicalName], describeError2(error));
      return respond(id, {
        content: [{ type: "text", text: linkError.message }],
        isError: true
      });
    }
  }
  return async (message) => {
    if (!isRecord(message)) {
      return fail(null, INVALID_REQUEST, "Invalid Request");
    }
    const hasId = "id" in message && message.id !== void 0;
    const id = hasId ? message.id : null;
    const method = message.method;
    if (!hasId) return null;
    if (message.jsonrpc !== "2.0" || typeof method !== "string") {
      return fail(id, INVALID_REQUEST, "Invalid Request");
    }
    switch (method) {
      case "initialize": {
        const params = isRecord(message.params) ? message.params : {};
        const requested = params.protocolVersion;
        return respond(id, {
          // Echoing the client's version maximizes compatibility; clients that
          // do not support our default would disconnect on a mismatch anyway.
          protocolVersion: typeof requested === "string" ? requested : MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }
        });
      }
      case "ping":
        return respond(id, {});
      case "tools/list":
        return respond(id, { tools: environmentOk() ? toolDefinitions() : [] });
      case "tools/call": {
        const params = message.params;
        if (!isRecord(params)) {
          return fail(id, INVALID_PARAMS, "tools/call requires an object params");
        }
        return await callTool(id, params);
      }
      default:
        return fail(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  };
}
async function runStdioServer(handler) {
  const stdout = process.stdout;
  let buffer = "";
  const writeLine = (line) => new Promise((resolve) => {
    if (stdout.write(`${line}
`)) {
      resolve();
      return;
    }
    stdout.once("drain", () => resolve());
    stdout.once("error", () => resolve());
  });
  try {
    for await (const chunk of process.stdin) {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (line === "") continue;
        let response;
        try {
          response = await handler(JSON.parse(line));
        } catch {
          response = failParse();
        }
        if (response) await writeLine(JSON.stringify(response));
      }
    }
  } catch {
  }
  function failParse() {
    return { jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } };
  }
}
function mcpPresentedToolName(canonicalName, serverName) {
  return `mcp__${serverName}__${canonicalName}`;
}
function contractWithAppendix(appendix) {
  return `${COMMUNICATION_CONTRACT}

${appendix}`;
}
function buildMcpPrefixedCommunicationContract(namespace) {
  const [peers, send, close] = HERDR_LINK_TOOLS.map(
    (name) => mcpPresentedToolName(name, namespace)
  );
  return contractWithAppendix(
    `In this runtime these tools are presented under MCP-prefixed names:
- herdr_link_peers -> ${peers}
- herdr_link_send -> ${send}
- herdr_link_close -> ${close}`
  );
}
function buildMcpWrapperCommunicationContract(wrapperName, serverName) {
  return contractWithAppendix(
    `In this runtime Herdr Link MCP tools are invoked through ${wrapperName}.

Use:
- ServerName: "${serverName}"
- ToolName: "herdr_link_peers", "herdr_link_send", or "herdr_link_close"
- Arguments: the canonical input object for that Herdr Link tool`
  );
}
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  await runStdioServer(createRequestHandler());
}
export {
  INVALID_PARAMS,
  INVALID_REQUEST,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  buildMcpPrefixedCommunicationContract,
  buildMcpWrapperCommunicationContract,
  createRequestHandler,
  isHerdrEnvironment,
  mcpPresentedToolName,
  runStdioServer
};
