/**
 * Shared stdio MCP server for Runtimes without a native custom-tool surface
 * (Claude Code, Codex, AGY) — ADR-013/ADR-014.
 *
 * Hand-written, line-delimited JSON-RPC 2.0 over stdin/stdout (zero
 * dependencies, no @modelcontextprotocol/sdk). Tool execution reuses the
 * herdr.ts control layer. Tool gating and error semantics follow
 * PROTOCOL.md §7; tool-name presentation follows PROTOCOL.md §4.4.
 */
import { pathToFileURL } from "node:url";

import { closeAgentPane, listPeers, sendMessage } from "./herdr.ts";
import {
  COMMUNICATION_CONTRACT,
  HERDR_LINK_TOOLS,
  HerdrLinkError,
  type LinkErrorCode,
} from "./protocol.ts";

export const MCP_SERVER_NAME = "herdr-link";
/** Keep in sync with package.json "version" (serverInfo is informational). */
export const MCP_SERVER_VERSION = "0.1.0";
/** Fallback protocol version advertised when the client sends none. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * JSON-RPC reserved error codes — transport/protocol-level failures only.
 * The five Link error codes (PROTOCOL.md §7) are never mapped onto these;
 * they travel inside CallToolResult as isError:true + "CODE: detail" text.
 */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

type CanonicalToolName = (typeof HERDR_LINK_TOOLS)[number];

const TOOL_DESCRIPTIONS: Record<CanonicalToolName, string> = {
  herdr_link_peers:
    "Discover named peers available through the cross-agent communication channel.",
  herdr_link_send:
    "Send a message to another agent through the cross-agent communication channel.",
  herdr_link_close:
    "Close the Herdr pane currently hosting a named agent. If you need to send a final message before closing, complete herdr_link_send first and call herdr_link_close in a later tool step.",
};

const TOOL_INPUT_SCHEMAS: Record<CanonicalToolName, Record<string, unknown>> = {
  herdr_link_peers: { type: "object", properties: {} },
  herdr_link_send: {
    type: "object",
    properties: {
      to: { type: "string", description: "Target Herdr agent name" },
      message: { type: "string", description: "Message payload" },
      reply_to: { type: "string", description: "Message id being replied to" },
    },
    required: ["to", "message"],
  },
  herdr_link_close: {
    type: "object",
    properties: {
      agent: { type: "string", description: "Target Herdr agent name" },
    },
    required: ["agent"],
  },
};

/** Unexpected exceptions fall back to the operation's own failure code so the §7 vocabulary stays closed. */
const FALLBACK_ERROR_CODE: Record<CanonicalToolName, LinkErrorCode> = {
  herdr_link_peers: "NOT_IN_HERDR",
  herdr_link_send: "SEND_FAILED",
  herdr_link_close: "CLOSE_FAILED",
};

/** Same triple gate as the other adapters (PROTOCOL.md §7 NOT_IN_HERDR condition + pane identity). */
export function isHerdrEnvironment(): boolean {
  return (
    process.env.HERDR_ENV === "1" &&
    Boolean(process.env.HERDR_BIN_PATH) &&
    Boolean(process.env.HERDR_PANE_ID)
  );
}

function toolDefinitions(): Array<{
  name: CanonicalToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return HERDR_LINK_TOOLS.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: TOOL_INPUT_SCHEMAS[name],
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function requireStringArg(args: Record<string, unknown>, key: string, code: LinkErrorCode): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new HerdrLinkError(code, `"${key}" must be a string`);
  }
  return value;
}

function optionalStringArg(
  args: Record<string, unknown>,
  key: string,
  code: LinkErrorCode,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new HerdrLinkError(code, `"${key}" must be a string when present`);
  }
  return value;
}

export interface McpServerDeps {
  environmentOk?: typeof isHerdrEnvironment;
  listPeers?: typeof listPeers;
  sendMessage?: typeof sendMessage;
  closeAgentPane?: typeof closeAgentPane;
}

/**
 * Creates the JSON-RPC request handler. All Herdr IO goes through `deps`
 * (real control layer by default), keeping the handler unit-testable.
 */
export function createRequestHandler(
  deps: McpServerDeps = {},
): (message: unknown) => Promise<JsonRpcResponse | null> {
  const environmentOk = deps.environmentOk ?? isHerdrEnvironment;
  const runPeers = deps.listPeers ?? listPeers;
  const runSend = deps.sendMessage ?? sendMessage;
  const runClose = deps.closeAgentPane ?? closeAgentPane;

  function respond(id: unknown, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
  }

  function fail(id: unknown, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }

  async function callTool(
    id: unknown,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const name = params.name;
    if (typeof name !== "string" || !HERDR_LINK_TOOLS.includes(name as CanonicalToolName)) {
      return fail(id, INVALID_PARAMS, `Unknown tool: ${String(name ?? "")}`);
    }
    const canonicalName = name as CanonicalToolName;
    const rawArguments = params.arguments;
    const args = isRecord(rawArguments) ? rawArguments : {};

    try {
      let value: object;
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
      const linkError =
        error instanceof HerdrLinkError
          ? error
          : new HerdrLinkError(FALLBACK_ERROR_CODE[canonicalName], describeError(error));
      // PROTOCOL.md §7: every Link failure is a local tool failure returned as
      // isError:true with "CODE: detail" text — never a crash, never an envelope.
      return respond(id, {
        content: [{ type: "text", text: linkError.message }],
        isError: true,
      });
    }
  }

  return async (message: unknown): Promise<JsonRpcResponse | null> => {
    if (!isRecord(message)) {
      return fail(null, INVALID_REQUEST, "Invalid Request");
    }

    const hasId = "id" in message && message.id !== undefined;
    const id = hasId ? message.id : null;
    const method = message.method;

    // Notifications never get a response, whatever they carry.
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
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        });
      }
      case "ping":
        return respond(id, {});
      case "tools/list":
        // Zero side-effect gate (ADR-013): outside Herdr the model sees no tools.
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

/**
 * Serves one JSON-RPC exchange per stdin line until EOF. Responses are written
 * to stdout as single-line JSON (JSON.stringify escapes embedded newlines).
 * Nothing else ever touches stdout.
 */
export async function runStdioServer(
  handler: (message: unknown) => Promise<JsonRpcResponse | null>,
): Promise<void> {
  const stdout = process.stdout;
  let buffer = "";

  const writeLine = (line: string): Promise<void> =>
    new Promise<void>((resolve) => {
      if (stdout.write(`${line}\n`)) {
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

        let response: JsonRpcResponse | null;
        try {
          response = await handler(JSON.parse(line));
        } catch {
          response = failParse();
        }
        if (response) await writeLine(JSON.stringify(response));
      }
    }
  } catch {
    // stdin ended unexpectedly or stdout failed — exit quietly, hosts treat a
    // dead connection as their own transport error.
  }

  function failParse(): JsonRpcResponse {
    return { jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } };
  }
}

/**
 * Host-facing presented name for a canonical tool (PROTOCOL.md §4.4): the full
 * canonical name is always the suffix. The namespace is host-specific (e.g.
 * "herdr_link" for the Codex/AGY wirings) and is deliberately NOT defaulted —
 * serverInfo.name and the host tool namespace are different concerns, so callers
 * must state explicitly which namespace a contract declares.
 */
export function mcpPresentedToolName(
  canonicalName: CanonicalToolName,
  serverName: string,
): string {
  return `mcp__${serverName}__${canonicalName}`;
}

/**
 * Contract text for MCP-hosted runtimes: the canonical Communication Contract
 * plus the §4.4 appendix declaring this runtime's actual presented names, so
 * the model never has to guess which spelling to call. `serverName` is the
 * host tool namespace (see mcpPresentedToolName) and must be explicit.
 */
export function buildMcpCommunicationContract(serverName: string): string {
  const [peers, send, close] = HERDR_LINK_TOOLS.map((name) =>
    mcpPresentedToolName(name, serverName),
  );
  return `${COMMUNICATION_CONTRACT}

In this runtime these tools are presented under MCP-prefixed names:
- herdr_link_peers -> ${peers}
- herdr_link_send -> ${send}
- herdr_link_close -> ${close}`;
}

/** True when this file is the process entry point (spawned by an MCP host), false when imported (tests). */
function invokedDirectly(): boolean {
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
