/**
 * Shared stdio MCP server for Runtimes without a native custom-tool surface
 * (Claude Code, Codex, AGY) — ADR-013/ADR-014.
 *
 * Hand-written, line-delimited JSON-RPC 2.0 over stdin/stdout (zero
 * dependencies, no @modelcontextprotocol/sdk). Tool execution reuses the
 * herdr.ts control layer. Tool gating and error semantics follow
 * PROTOCOL.md §7; tool-name presentation follows PROTOCOL.md §4.4.
 *
 * Lazy presentation (blueprint v2): the tool surface is session-local and
 * dormant until activated. Outside Herdr, `tools/list` is empty. Inside
 * Herdr, a dormant session lists only the Tier 0 `herdr_link` gateway;
 * calling the gateway with `{}` activates THIS server session (per stdio
 * connection memory), emits `notifications/tools/list_changed`, and from
 * then on `tools/list` additionally offers the canonical Tier 1 tools.
 * Hosts that never refresh can keep dispatching through explicit gateway
 * actions (`{"action":"send","arguments":{...}}`). No daemon, no global
 * state: activation lives and dies with the connection.
 */
import { pathToFileURL } from "node:url";

import { closeAgentPane, listPeers, sendMessage } from "./herdr.ts";
import {
  COMMUNICATION_CONTRACT,
  HERDR_LINK_GATEWAY,
  HERDR_LINK_TOOLS,
  HerdrLinkError,
  TOOL_CLOSE,
  TOOL_PEERS,
  TOOL_SEND,
  formatAgentFacingError,
  type LinkErrorCode,
} from "./protocol.ts";

export const MCP_SERVER_NAME = "herdr-link";
/** Keep in sync with package.json "version" (serverInfo is informational). */
export const MCP_SERVER_VERSION = "0.1.0";
/** Fallback protocol version advertised when the client sends none. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * Emitted once when the gateway activates the session (MCP 2025-06-18
 * `tools.listChanged`): the host is expected to refetch `tools/list`.
 */
export const TOOLS_LIST_CHANGED = "notifications/tools/list_changed";

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

/**
 * Server-to-host notification outlet. Unit tests inject a capturing sink;
 * the default sink writes the notification as one more single-line JSON
 * record on stdout — notifications never produce a response and stdout
 * never carries diagnostics.
 */
export type NotificationSink = (notification: Record<string, unknown>) => void;

type CanonicalToolName = typeof TOOL_PEERS | typeof TOOL_SEND | typeof TOOL_CLOSE;

const TOOL_DESCRIPTIONS: Record<CanonicalToolName, string> = {
  [TOOL_PEERS]:
    "Discover named peers available through the cross-agent communication channel.",
  [TOOL_SEND]:
    "Send a message to another agent through the cross-agent communication channel.",
  [TOOL_CLOSE]:
    "Close the Herdr pane currently hosting a named agent. If you need to send a final message before closing, complete herdr_link_send first and call herdr_link_close in a later tool step.",
};

const TOOL_INPUT_SCHEMAS: Record<CanonicalToolName, Record<string, unknown>> = {
  [TOOL_PEERS]: { type: "object", properties: {} },
  [TOOL_SEND]: {
    type: "object",
    properties: {
      to: { type: "string", description: "Target Herdr agent name" },
      message: { type: "string", description: "Message payload" },
      reply_to: { type: "string", description: "Message id being replied to" },
    },
    required: ["to", "message"],
  },
  [TOOL_CLOSE]: {
    type: "object",
    properties: {
      agent: { type: "string", description: "Target Herdr agent name" },
    },
    required: ["agent"],
  },
};

/** Unexpected exceptions fall back to the operation's own failure code so the §7 vocabulary stays closed. */
const FALLBACK_ERROR_CODE: Record<CanonicalToolName, LinkErrorCode> = {
  [TOOL_PEERS]: "NOT_IN_HERDR",
  [TOOL_SEND]: "SEND_FAILED",
  [TOOL_CLOSE]: "CLOSE_FAILED",
};

/**
 * Tier 0 gateway tool (blueprint v2): the single always-present registration
 * surface while dormant, and the explicit action-dispatch fallback for hosts
 * that do not react to `notifications/tools/list_changed`.
 */
const GATEWAY_TOOL: { name: typeof HERDR_LINK_GATEWAY; description: string; inputSchema: Record<string, unknown> } = {
  name: HERDR_LINK_GATEWAY,
  description:
    "Herdr Link gateway. Cross-agent messaging starts dormant: call this tool once with no arguments " +
    "({}) to activate it for this session — the host is notified via notifications/tools/list_changed " +
    "and herdr_link_peers / herdr_link_send / herdr_link_close become available as regular tools. " +
    'If your host did not refresh its tool list, keep dispatching through the gateway: {"action":"peers"}, ' +
    '{"action":"send","arguments":{"to":...,"message":...,"reply_to":...}}, or ' +
    '{"action":"close","arguments":{"agent":...}}.',
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["activate", "peers", "send", "close"],
        description:
          'Omit or use "activate" to turn the session on; other values dispatch the corresponding peers, send, or close capability.',
      },
      arguments: {
        type: "object",
        description: "Canonical input object of the dispatched tool (ignored for activation).",
      },
    },
  },
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

/* ------------------------------------------------------------------ *
 * stdout plumbing
 *
 * Every stdout line — responses and notifications alike — goes through
 * one serialized writer, so interleaving stays FIFO regardless of
 * backpressure and stdout never carries anything but complete JSON lines.
 * ------------------------------------------------------------------ */

type LineWriter = (line: string) => Promise<void>;

function createSerializedLineWriter(stream: NodeJS.WriteStream): LineWriter {
  let tail: Promise<void> = Promise.resolve();
  return (line: string): Promise<void> => {
    const queued = new Promise<void>((done) => {
      tail = tail.then(() => {
        if (stream.write(`${line}\n`)) {
          done();
          return;
        }
        const flushed = (): void => {
          stream.off("drain", flushed);
          stream.off("error", flushed);
          done();
        };
        stream.on("drain", flushed);
        stream.on("error", flushed);
      });
    });
    return queued;
  };
}

const writeStdoutLine: LineWriter = createSerializedLineWriter(process.stdout);

/** Default notification sink: one more single-line JSON record on stdout. */
function stdoutNotificationSink(notification: Record<string, unknown>): void {
  void writeStdoutLine(JSON.stringify(notification));
}

export interface McpServerDeps {
  environmentOk?: typeof isHerdrEnvironment;
  listPeers?: typeof listPeers;
  sendMessage?: typeof sendMessage;
  closeAgentPane?: typeof closeAgentPane;
  /**
   * Receives server-to-host notifications (currently only
   * `notifications/tools/list_changed`). Defaults to stdout.
   */
  notify?: NotificationSink;
}

/**
 * Creates the JSON-RPC request handler. All Herdr IO goes through `deps`
 * (real control layer by default), keeping the handler unit-testable.
 * Activation state is held in this closure — one handler instance per stdio
 * connection, so sessions never leak across connections.
 */
export function createRequestHandler(
  deps: McpServerDeps = {},
): (message: unknown) => Promise<JsonRpcResponse | null> {
  const environmentOk = deps.environmentOk ?? isHerdrEnvironment;
  const runPeers = deps.listPeers ?? listPeers;
  const runSend = deps.sendMessage ?? sendMessage;
  const runClose = deps.closeAgentPane ?? closeAgentPane;
  const notify = deps.notify ?? stdoutNotificationSink;

  /** Session-local lazy activation (blueprint v2). True ⇒ Tier 1 tools are listed. */
  let activated = false;

  /**
   * Idempotent activation. Emits `notifications/tools/list_changed` exactly
   * once, on the dormant → active transition.
   */
  function activateSession(): void {
    if (activated) return;
    activated = true;
    notify({ jsonrpc: "2.0", method: TOOLS_LIST_CHANGED });
  }

  function respond(id: unknown, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
  }

  function fail(id: unknown, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }

  function callSuccess(id: unknown, value: object): JsonRpcResponse {
    return respond(id, { content: [{ type: "text", text: JSON.stringify(value) }] });
  }

  // PROTOCOL.md §7: every Link failure is a local tool failure returned as
  // isError:true with "CODE: detail" text — never a crash, never an envelope.
  function callFailure(id: unknown, error: unknown, fallbackCode: LinkErrorCode): JsonRpcResponse {
    const linkError =
      error instanceof HerdrLinkError
        ? error
        : new HerdrLinkError(fallbackCode, describeError(error));
    return respond(id, {
      content: [{ type: "text", text: formatAgentFacingError(linkError, linkError.code) }],
      isError: true,
    });
  }

  async function executeCanonical(
    canonicalName: CanonicalToolName,
    args: Record<string, unknown>,
  ): Promise<object> {
    switch (canonicalName) {
      case TOOL_PEERS:
        return await runPeers();
      case TOOL_SEND: {
        const to = requireStringArg(args, "to", "PEER_NOT_FOUND");
        const message = requireStringArg(args, "message", "SEND_FAILED");
        const reply_to = optionalStringArg(args, "reply_to", "SEND_FAILED");
        const sent = await runSend(to, message, reply_to);
        return { status: sent.status, id: sent.id, to: sent.to };
      }
      case TOOL_CLOSE: {
        const agent = requireStringArg(args, "agent", "PEER_NOT_FOUND");
        return await runClose(agent);
      }
    }
  }

  /** Runs one canonical Tier 1 tool and renders its CallToolResult. */
  async function callCanonicalTool(
    id: unknown,
    canonicalName: CanonicalToolName,
    args: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    try {
      return callSuccess(id, await executeCanonical(canonicalName, args));
    } catch (error) {
      return callFailure(id, error, FALLBACK_ERROR_CODE[canonicalName]);
    }
  }

  /**
   * Tier 0 gateway. Activation (`{}` / `{"action":"activate"}`) is idempotent
   * and reports the canonical surface; explicit actions dispatch onto the
   * canonical executor so hosts that never refetch `tools/list` keep full
   * functionality through this single tool.
   */
  async function callGateway(id: unknown, args: Record<string, unknown>): Promise<JsonRpcResponse> {
    if (!environmentOk()) {
      return callFailure(id, new HerdrLinkError("NOT_IN_HERDR"), "NOT_IN_HERDR");
    }
    const action = args.action;
    if (action === undefined || action === "activate") {
      activateSession();
      return callSuccess(id, {
        status: "active",
        capabilities: ["peers", "send", "close"],
      });
    }
    if (
      typeof action !== "string" ||
      !(["peers", "send", "close"] as readonly string[]).includes(action)
    ) {
      return fail(id, INVALID_PARAMS, `Unknown gateway action: ${String(action)}`);
    }
    const canonicalName = (
      action === "peers" ? TOOL_PEERS : action === "send" ? TOOL_SEND : TOOL_CLOSE
    ) as CanonicalToolName;
    activateSession();
    // Prefer the nested canonical arguments object; otherwise accept the
    // remaining top-level fields directly (deterministic either way).
    const dispatchArgs = isRecord(args.arguments) ? args.arguments : args;
    return await callCanonicalTool(id, canonicalName, dispatchArgs);
  }

  async function callTool(
    id: unknown,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const name = params.name;
    if (typeof name !== "string") {
      return fail(id, INVALID_PARAMS, `Unknown tool: ${String(name ?? "")}`);
    }
    const rawArguments = params.arguments;
    const args = isRecord(rawArguments) ? rawArguments : {};

    if (name === HERDR_LINK_GATEWAY) {
      return await callGateway(id, args);
    }
    if (!(HERDR_LINK_TOOLS as readonly string[]).includes(name)) {
      return fail(id, INVALID_PARAMS, `Unknown tool: ${name}`);
    }

    // PROTOCOL.md §6.1: outside Herdr nothing executes, regardless of what a
    // stale host-side tool registry still thinks exists.
    if (!environmentOk()) {
      return callFailure(id, new HerdrLinkError("NOT_IN_HERDR"), "NOT_IN_HERDR");
    }
    // A direct Tier 1 call implies the caller already knows the canonical
    // surface; activation keeps list/notification state consistent.
    activateSession();
    return await callCanonicalTool(id, name as CanonicalToolName, args);
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
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        });
      }
      case "ping":
        return respond(id, {});
      case "tools/list": {
        // Zero side-effect gate (ADR-013) + lazy presentation (blueprint v2):
        // outside Herdr nothing; dormant only the Tier 0 gateway; active the
        // gateway plus the canonical Tier 1 tools.
        if (!environmentOk()) return respond(id, { tools: [] });
        return respond(id, {
          tools: activated ? [GATEWAY_TOOL, ...toolDefinitions()] : [GATEWAY_TOOL],
        });
      }
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
 * to stdout as single-line JSON (JSON.stringify escapes embedded newlines);
 * notifications emitted through the default sink interleave in FIFO order on
 * the same serialized writer. Nothing else ever touches stdout.
 */
export async function runStdioServer(
  handler: (message: unknown) => Promise<JsonRpcResponse | null>,
): Promise<void> {
  let buffer = "";

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
        if (response) await writeStdoutLine(JSON.stringify(response));
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
 * Host-facing presented name for a canonical tool on prefix-style hosts (PROTOCOL.md
 * §4.4): the full canonical name is always the suffix. The namespace is
 * host-specific ("herdr_link" for the Codex wiring) and deliberately NOT
 * defaulted — serverInfo.name and the host tool namespace are different
 * concerns, so callers must state explicitly which namespace a contract declares.
 */
export function mcpPresentedToolName(
  canonicalName: CanonicalToolName | typeof HERDR_LINK_GATEWAY,
  serverName: string,
): string {
  return `mcp__${serverName}__${canonicalName}`;
}

/** Shared canonical part of every Communication Contract variant (§3). */
function contractWithAppendix(appendix: string): string {
  return `${COMMUNICATION_CONTRACT}\n\n${appendix}`;
}

/**
 * Contract text for prefix-style MCP hosts (e.g. Codex): tools are exposed as
 * independent `mcp__<namespace>__<canonical>` functions. `namespace` is the
 * host tool namespace and must be explicit. Presentation is lazy: only the
 * gateway is listed until the model activates it (blueprint v2).
 */
export function buildMcpPrefixedCommunicationContract(namespace: string): string {
  const [peers, send, close] = HERDR_LINK_TOOLS.map((name) =>
    mcpPresentedToolName(name, namespace),
  );
  const gateway = mcpPresentedToolName(HERDR_LINK_GATEWAY, namespace);
  return contractWithAppendix(
    `In this runtime Herdr Link starts dormant: only the ${gateway} gateway tool is listed until it is activated.\n` +
      `- Call ${gateway} once with no arguments ({}); the host then receives notifications/tools/list_changed and the cross-agent tools become available.\n` +
      `- If the host did not refresh its tool list, keep dispatching through the gateway: {"action":"peers"}, {"action":"send","arguments":{...}}, {"action":"close","arguments":{...}}.\n` +
      `The tools are presented under MCP-prefixed names (the canonical name is always the suffix):\n` +
      `- herdr_link_peers -> ${peers}\n` +
      `- herdr_link_send -> ${send}\n` +
      `- herdr_link_close -> ${close}`,
  );
}

/**
 * Contract text for wrapper-style MCP hosts (e.g. AGY's call_mcp_tool): the
 * model invokes one native wrapper carrying ServerName/ToolName/Arguments
 * instead of per-tool functions (PROTOCOL.md §4.4 wrapper form). Both values
 * must be explicit. Presentation is lazy (blueprint v2): activate the gateway
 * first, then address the canonical tools through the same wrapper.
 */
export function buildMcpWrapperCommunicationContract(
  wrapperName: string,
  serverName: string,
): string {
  return contractWithAppendix(
    `In this runtime Herdr Link starts dormant: only the Tier 0 gateway (${HERDR_LINK_GATEWAY}) is listed until it is activated.\n` +
      `- Invoke the gateway once with empty Arguments {} (ToolName "${HERDR_LINK_GATEWAY}"); the host then receives notifications/tools/list_changed and the cross-agent tools become available.\n` +
      `- If the host did not refresh its tool list, keep dispatching through the gateway with ToolName "${HERDR_LINK_GATEWAY}" and an Arguments object carrying {"action":"peers"|"send"|"close", ...}.\n\n` +
      `After activation, Herdr Link MCP tools are invoked through ${wrapperName}.\n\n` +
      `Use:\n` +
      `- ServerName: "${serverName}"\n` +
      `- ToolName: "herdr_link_peers", "herdr_link_send", or "herdr_link_close"\n` +
      `- Arguments: the canonical input object for that Herdr Link tool`,
  );
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
