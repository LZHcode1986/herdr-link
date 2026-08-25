import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildMcpPrefixedCommunicationContract,
  buildMcpWrapperCommunicationContract,
  createRequestHandler,
  INVALID_PARAMS,
  INVALID_REQUEST,
  isHerdrEnvironment,
  mcpPresentedToolName,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  TOOLS_LIST_CHANGED,
  type JsonRpcResponse,
  type McpServerDeps,
} from "../src/mcp.ts";
import {
  COMMUNICATION_CONTRACT,
  HERDR_LINK_GATEWAY,
  HERDR_LINK_TOOLS,
  HerdrLinkError,
  type PeerDirectory,
} from "../src/protocol.ts";

type JsonRpcRequest = Record<string, unknown>;

function ok<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

const PEER_DIRECTORY_FIXTURE: PeerDirectory = {
  self: { name: "brain", state: "working" },
  peers: [{ name: "worker-a", state: "idle" }],
};

type RequestHandler = ReturnType<typeof createRequestHandler>;

interface HandlerWithNotifications extends RequestHandler {
  /** Captured server-to-host notifications (injected notification sink). */
  notifications: Array<Record<string, unknown>>;
}

function handlerWith(overrides: McpServerDeps = {}): HandlerWithNotifications {
  const notifications: Array<Record<string, unknown>> = [];
  const handler = createRequestHandler({
    environmentOk: () => true,
    listPeers: () => ok(PEER_DIRECTORY_FIXTURE),
    sendMessage: () => ok({ status: "sent" as const, id: "hl_unit_1", to: "worker-a" }),
    closeAgentPane: (agent: string) => ok({ status: "closed" as const, agent }),
    notify: (notification) => {
      notifications.push(notification);
    },
    ...overrides,
  });
  return Object.assign(handler, { notifications });
}

/** Asserts the captured stream contains exactly one well-formed list_changed notice. */
function assertSingleListChanged(notifications: Array<Record<string, unknown>>): void {
  assert.equal(notifications.length, 1);
  const [notification] = notifications;
  assert.deepEqual(notification, { jsonrpc: "2.0", method: TOOLS_LIST_CHANGED });
  assert.equal("id" in notification, false, "notifications must never carry an id");
}

async function listedToolNames(
  handler: RequestHandler,
  id: number,
): Promise<string[]> {
  const listed = await handler({ jsonrpc: "2.0", id, method: "tools/list" });
  return ((listed?.result as { tools: Array<{ name: string }> }).tools ?? []).map((tool) => tool.name);
}

function snapshotHerdrEnv(): Record<string, string | undefined> {
  return {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_BIN_PATH: process.env.HERDR_BIN_PATH,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  };
}

function restoreHerdrEnv(previous: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test("MCP server request handler", async (t) => {
  await t.test("initialize echoes the client protocol version, reports info, declares tools.listChanged", async () => {
    const handler = createRequestHandler();
    const answered = await handler({
      jsonrpc: "2.0",
      id: "i1",
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "host", version: "1" } },
    });
    assert.equal(answered?.id, "i1");
    const result = answered?.result as Record<string, unknown>;
    assert.equal(result.protocolVersion, "2024-11-05");
    // MCP 2025-06-18: the host must be told the tool set can change later.
    assert.deepEqual(result.capabilities, { tools: { listChanged: true } });
    assert.deepEqual(result.serverInfo, { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

    const fallback = await handler({ jsonrpc: "2.0", id: 2, method: "initialize" });
    assert.equal((fallback?.result as Record<string, unknown>).protocolVersion, MCP_PROTOCOL_VERSION);
  });

  await t.test("never answers notifications", async () => {
    const handler = createRequestHandler();
    assert.equal(await handler({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
    assert.equal(await handler({ jsonrpc: "2.0", method: "notifications/unknown" }), null);
    assert.equal(await handler({ jsonrpc: "9.9", method: "tools/list" }), null);
  });

  await t.test("rejects malformed requests with reserved codes", async () => {
    const handler = createRequestHandler();

    const notAnObject = await handler(null);
    assert.equal(notAnObject?.error?.code, INVALID_REQUEST);
    assert.equal(notAnObject?.id, null);

    const batch = await handler([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    assert.equal(batch?.error?.code, INVALID_REQUEST);

    const missingMethod = await handler({ jsonrpc: "2.0", id: 7 });
    assert.equal(missingMethod?.error?.code, INVALID_REQUEST);

    const wrongVersion = await handler({ jsonrpc: "1.0", id: 8, method: "tools/list" });
    assert.equal(wrongVersion?.error?.code, INVALID_REQUEST);

    const unknownMethod = await handler({ jsonrpc: "2.0", id: 9, method: "resources/list" });
    assert.equal(unknownMethod?.error?.code, METHOD_NOT_FOUND);
    assert.match(String(unknownMethod?.error?.message), /resources\/list/);

    const pong = await handler({ jsonrpc: "2.0", id: 10, method: "ping" });
    assert.deepEqual(pong?.result, {});
  });

  await t.test("preserves request id verbatim across responses", async () => {
    const handler = createRequestHandler();
    const numeric = await handler({ jsonrpc: "2.0", id: 42, method: "ping" });
    assert.equal(numeric?.id, 42);
    const textual = await handler({ jsonrpc: "2.0", id: "abc-def", method: "ping" });
    assert.equal(textual?.id, "abc-def");
  });

  await t.test("gates tools/list on the Herdr environment (smoke: empty gating)", async () => {
    const previous = snapshotHerdrEnv();
    t.after(() => restoreHerdrEnv(previous));

    delete process.env.HERDR_ENV;
    delete process.env.HERDR_BIN_PATH;
    delete process.env.HERDR_PANE_ID;
    assert.equal(isHerdrEnvironment(), false);
    const gated = await createRequestHandler()({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.deepEqual(gated?.result, { tools: [] });

    process.env.HERDR_ENV = "1";
    process.env.HERDR_BIN_PATH = "/mock/herdr";
    process.env.HERDR_PANE_ID = "self-pane";
    assert.equal(isHerdrEnvironment(), true);
  });

  await t.test("dormant Herdr session lists only the Tier 0 gateway", async () => {
    const handler = handlerWith();

    const listed = await handler({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (listed?.result as { tools: Array<Record<string, unknown>> }).tools;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [HERDR_LINK_GATEWAY],
    );
    assert.equal(typeof tools[0]!.description, "string");
    assert.match(tools[0]!.description as string, /activate/i);
    assert.match(tools[0]!.description as string, /only when the user explicitly asks to use Herdr/);
    assert.match(tools[0]!.description as string, /handling an inbound Herdr Link message/);
    assert.doesNotMatch(tools[0]!.description as string, /Use Herdr Link, not raw Herdr CLI/);
    assert.equal((tools[0]!.inputSchema as Record<string, unknown>).type, "object");

    // Listing is side-effect free: dormant stays dormant, no notifications.
    assert.equal(handler.notifications.length, 0);
    assert.deepEqual(await listedToolNames(handler, 2), [HERDR_LINK_GATEWAY]);
  });

  await t.test("gateway {} activates the session, notifies once, and is idempotent", async () => {
    const handler = handlerWith();

    const activated = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: HERDR_LINK_GATEWAY, arguments: {} },
    });
    const payload = JSON.parse(
      (activated?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as Record<string, unknown>;
    assert.equal(payload.status, "active");
    assert.deepEqual(payload.capabilities, ["peers", "send", "close"]);

    assertSingleListChanged(handler.notifications);

    // Idempotent: re-activation reports active without another notification.
    const again = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: HERDR_LINK_GATEWAY },
    });
    const repeatPayload = JSON.parse(
      (again?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as Record<string, unknown>;
    assert.equal(repeatPayload.status, "active");
    assert.equal(handler.notifications.length, 1);

    // Explicit activate action behaves identically.
    const explicit = await handler({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: HERDR_LINK_GATEWAY, arguments: { action: "activate" } },
    });
    assert.equal(
      (JSON.parse((explicit?.result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>).status,
      "active",
    );
    assert.equal(handler.notifications.length, 1);
  });

  await t.test("active session lists the gateway plus the canonical Tier 1 tools with schemas", async () => {
    const handler = handlerWith();
    await handler({
      jsonrpc: "2.0",
      id: 0,
      method: "tools/call",
      params: { name: HERDR_LINK_GATEWAY, arguments: {} },
    });

    const listed = await handler({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (listed?.result as { tools: Array<Record<string, unknown>> }).tools;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [HERDR_LINK_GATEWAY, ...HERDR_LINK_TOOLS],
    );
    for (const tool of tools) {
      assert.equal(typeof tool.description, "string");
      assert.equal((tool.inputSchema as Record<string, unknown>).type, "object");
    }
    const descriptionByName = new Map(tools.map((tool) => [tool.name, String(tool.description)]));
    assert.match(descriptionByName.get("herdr_link_peers") ?? "", /same Herdr workspace/);
    assert.match(descriptionByName.get("herdr_link_send") ?? "", /reply_to/);
    assert.match(descriptionByName.get("herdr_link_close") ?? "", /later tool step/);
    for (const name of [HERDR_LINK_GATEWAY, ...HERDR_LINK_TOOLS]) {
      assert.match(descriptionByName.get(name) ?? "", /Use Herdr Link, not raw Herdr CLI/);
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool.inputSchema as Record<string, unknown>]));
    assert.deepEqual(byName.get("herdr_link_send")?.required, ["to", "message"]);
    assert.deepEqual(byName.get("herdr_link_close")?.required, ["agent"]);
    const assertBasicString = (schema: unknown): void => {
      const value = schema as Record<string, unknown>;
      assert.equal(value.type, "string");
      assert.equal(value.pattern, undefined);
      assert.equal(value.minLength, undefined);
    };
    const sendProperties = byName.get("herdr_link_send")?.properties as Record<string, unknown>;
    const closeProperties = byName.get("herdr_link_close")?.properties as Record<string, unknown>;
    assertBasicString(sendProperties.to);
    assertBasicString(sendProperties.message);
    assertBasicString(sendProperties.reply_to);
    assertBasicString(closeProperties.agent);
  });

  await t.test("a direct Tier 1 call while dormant activates deterministically, then executes", async () => {
    const handler = handlerWith();

    const peers = await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "herdr_link_peers" } });
    assert.notEqual((peers?.result as { isError?: boolean }).isError, true);

    // One transition notice fired even though the host never called the gateway.
    assertSingleListChanged(handler.notifications);
    assert.deepEqual(await listedToolNames(handler, 2), [HERDR_LINK_GATEWAY, ...HERDR_LINK_TOOLS]);

    // Determinism: same call post-activation, same result, no extra notice.
    const repeat = await handler({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "herdr_link_peers" } });
    assert.deepEqual(repeat?.result, peers?.result);
    assert.equal(handler.notifications.length, 1);
  });

  await t.test("returns peer directory, sent receipt, and close receipt", async () => {
    const handler = handlerWith();

    const peers = await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "herdr_link_peers" } });
    const peersResult = peers?.result as { content: Array<{ text: string }>; isError?: boolean };
    assert.notEqual(peersResult.isError, true);
    assert.deepEqual(JSON.parse(peersResult.content[0]!.text), PEER_DIRECTORY_FIXTURE);

    const sent = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "herdr_link_send", arguments: { to: "worker-a", message: "hello", reply_to: "hl_prev_1" } },
    });
    const sentResult = sent?.result as { content: Array<{ text: string }> };
    assert.deepEqual(JSON.parse(sentResult.content[0]!.text), { status: "sent", id: "hl_unit_1", to: "worker-a" });

    const closed = await handler({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "herdr_link_close", arguments: { agent: "worker-a" } },
    });
    const closedResult = closed?.result as { content: Array<{ text: string }> };
    assert.deepEqual(JSON.parse(closedResult.content[0]!.text), { status: "closed", agent: "worker-a" });
  });

  await t.test("passes validated arguments through to the control layer", async () => {
    const captured: Array<unknown[]> = [];
    const handler = handlerWith({
      sendMessage: (to: string, message: string, reply_to?: string) => {
        captured.push([to, message, reply_to]);
        return ok({ status: "sent" as const, id: "hl_x_1", to });
      },
    });
    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "herdr_link_send", arguments: { to: "worker-b", message: "hi" } },
    });
    assert.deepEqual(captured, [["worker-b", "hi", undefined]]);
  });

  await t.test("gateway action-dispatch reaches the canonical executor (fallback for non-refreshing hosts)", async () => {
    const handler = handlerWith();

    const dispatchedPeers = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: HERDR_LINK_GATEWAY, arguments: { action: "peers" } },
    });
    assert.deepEqual(
      JSON.parse((dispatchedPeers?.result as { content: Array<{ text: string }> }).content[0]!.text),
      PEER_DIRECTORY_FIXTURE,
    );

    const dispatchedSend = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: HERDR_LINK_GATEWAY,
        arguments: {
          action: "send",
          arguments: { to: "worker-a", message: "via gateway", reply_to: "hl_prev_9" },
        },
      },
    });
    assert.deepEqual(
      JSON.parse((dispatchedSend?.result as { content: Array<{ text: string }> }).content[0]!.text),
      { status: "sent", id: "hl_unit_1", to: "worker-a" },
    );

    // Top-level shorthand is accepted deterministically when no nested
    // arguments object is supplied.
    const dispatchedClose = await handler({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: HERDR_LINK_GATEWAY, arguments: { action: "close", agent: "worker-a" } },
    });
    assert.deepEqual(
      JSON.parse((dispatchedClose?.result as { content: Array<{ text: string }> }).content[0]!.text),
      { status: "closed", agent: "worker-a" },
    );
  });

  await t.test("maps Link errors to isError:true CODE-prefixed text (smoke: isError passthrough)", async () => {
    const handler = handlerWith({
      listPeers: () => Promise.reject(new HerdrLinkError("SELF_UNNAMED", "agent target wH:p1 not found")),
      sendMessage: () =>
        Promise.reject(new HerdrLinkError("PEER_NOT_FOUND", 'target agent "ghost" is not a live peer')),
    });

    const peers = await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "herdr_link_peers" } });
    const peersResult = peers?.result as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(peersResult.isError, true);
    assert.equal(peersResult.content[0]!.text, "SELF_UNNAMED: Herdr Link could not establish a stable Agent Name");

    const sent = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "herdr_link_send", arguments: { to: "ghost", message: "hi" } },
    });
    const sentResult = sent?.result as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(sentResult.isError, true);
    assert.equal(sentResult.content[0]!.text, "PEER_NOT_FOUND: target agent is not a live peer");

    // Same semantics through gateway action-dispatch.
    const dispatched = await handler({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: HERDR_LINK_GATEWAY,
        arguments: { action: "send", arguments: { to: "ghost", message: "hi" } },
      },
    });
    const dispatchedResult = dispatched?.result as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(dispatchedResult.isError, true);
    assert.equal(dispatchedResult.content[0]!.text, "PEER_NOT_FOUND: target agent is not a live peer");
  });

  await t.test("wraps unexpected exceptions with the operation fallback code", async () => {
    const handler = handlerWith({
      listPeers: () => Promise.reject("oops"),
      sendMessage: () => Promise.reject(new Error("boom")),
      closeAgentPane: () => Promise.reject(new TypeError("bad type")),
    });

    const peers = await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "herdr_link_peers" } });
    assert.equal(
      (peers?.result as { content: Array<{ text: string }> }).content[0]!.text,
      "NOT_IN_HERDR: Herdr environment is unavailable",
    );
    const sent = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "herdr_link_send", arguments: { to: "a", message: "m" } },
    });
    assert.equal((sent?.result as { content: Array<{ text: string }> }).content[0]!.text, "SEND_FAILED: Herdr did not accept message delivery");
    const closed = await handler({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "herdr_link_close", arguments: { agent: "a" } },
    });
    assert.equal((closed?.result as { content: Array<{ text: string }> }).content[0]!.text, "CLOSE_FAILED: Herdr pane close failed");
  });

  await t.test("outside Herdr nothing executes: gateway and Tier 1 calls fail closed as NOT_IN_HERDR", async () => {
    const handler = createRequestHandler({ environmentOk: () => false });

    const gatewayCall = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: HERDR_LINK_GATEWAY, arguments: {} },
    });
    const gatewayResult = gatewayCall?.result as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(gatewayResult.isError, true);
    assert.ok(gatewayResult.content[0]!.text.startsWith("NOT_IN_HERDR:"));

    const tierCall = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "herdr_link_send", arguments: { to: "a", message: "m" } },
    });
    const tierResult = tierCall?.result as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(tierResult.isError, true);
    assert.ok(tierResult.content[0]!.text.startsWith("NOT_IN_HERDR:"));

    assert.deepEqual(await listedToolNames(handler, 3), []);
  });

  await t.test("treats unknown tools and malformed params as protocol-level errors", async () => {
    const handler = handlerWith();

    const unknownTool = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    assert.equal(unknownTool?.error?.code, INVALID_PARAMS);
    assert.equal(unknownTool?.error?.message, "Unknown tool: nope");

    const badParams = await handler({ jsonrpc: "2.0", id: 2, method: "tools/call", params: "nope" });
    assert.equal(badParams?.error?.code, INVALID_PARAMS);

    const unknownAction = await handler({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: HERDR_LINK_GATEWAY, arguments: { action: "fly" } },
    });
    assert.equal(unknownAction?.error?.code, INVALID_PARAMS);
    assert.equal(unknownAction?.error?.message, "Unknown gateway action: fly");

    const badArguments = await handler({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "herdr_link_send", arguments: { message: 3 } },
    });
    const result = badArguments?.result as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(result.isError, true);
    assert.equal(result.content[0]!.text, "PEER_NOT_FOUND: target agent is not a live peer");
  });

  await t.test("declares per-runtime presentation appendices (§4.4, lazy presentation)", () => {
    // Namespace is host-specific and must be passed explicitly (serverInfo.name
    // is a different concern); the Codex wiring uses the underscore form.
    for (const canonical of [...HERDR_LINK_TOOLS, HERDR_LINK_GATEWAY]) {
      const presented = mcpPresentedToolName(canonical, "herdr_link");
      assert.ok(presented.endsWith(canonical), `${presented} must end with ${canonical}`);
      assert.equal(presented, `mcp__herdr_link__${canonical}`);
    }

    const prefixed = buildMcpPrefixedCommunicationContract("herdr_link");
    assert.ok(prefixed.startsWith(COMMUNICATION_CONTRACT));
    assert.match(prefixed, /presented under MCP-prefixed names/);
    assert.match(prefixed, /starts dormant/);
    assert.ok(prefixed.includes(TOOLS_LIST_CHANGED));
    assert.ok(prefixed.includes('{"action":"send"'));
    for (const canonical of HERDR_LINK_TOOLS) {
      assert.ok(prefixed.includes(mcpPresentedToolName(canonical, "herdr_link")));
    }
    const customNs = buildMcpPrefixedCommunicationContract("custom-srv");
    assert.ok(customNs.includes("mcp__custom-srv__herdr_link_send"));

    // Wrapper hosts (AGY): one native call carrying ServerName/ToolName/Arguments.
    const wrapper = buildMcpWrapperCommunicationContract("call_mcp_tool", "herdr_link");
    assert.ok(wrapper.startsWith(COMMUNICATION_CONTRACT));
    assert.match(wrapper, /invoked through call_mcp_tool/);
    assert.match(wrapper, /starts dormant/);
    assert.ok(wrapper.includes('ServerName: "herdr_link"'));
    assert.ok(wrapper.includes(`"${HERDR_LINK_GATEWAY}"`));
    for (const canonical of HERDR_LINK_TOOLS) {
      assert.ok(wrapper.includes(`"${canonical}"`));
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: drive the real server over real stdio pipes (spawned like an
// MCP host would), including the three smoke checks from the codex research:
// empty gating, contract declaration, isError passthrough — plus the lazy
// presentation flow: dormant list -> gateway activation -> list_changed on
// stdout -> refreshed list -> gateway action-dispatch fallback.
// ---------------------------------------------------------------------------

const SERVER_ENTRY = fileURLToPath(new URL("../src/mcp.ts", import.meta.url));

let stripFlagsCache: Promise<string[]> | undefined;

/** Node >=22.6 strips types behind --experimental-strip-types; newer versions do it by default but still accept the flag. */
function typeStripFlags(): Promise<string[]> {
  stripFlagsCache ??= (async () => {
    const probe = spawn(process.execPath, ["--experimental-strip-types", "-e", "process.exit(0)"], { stdio: "ignore" });
    const supported = await new Promise<boolean>((resolve) => {
      probe.on("exit", (code) => resolve(code === 0));
      probe.on("error", () => resolve(false));
    });
    return supported ? ["--experimental-strip-types"] : [];
  })();
  return stripFlagsCache;
}

function herdrFreeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("HERDR_") && value !== undefined) env[key] = value;
  }
  return env;
}

function withTimeout<T>(promise: Promise<T>, label: string, ms = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout while waiting for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class McpServerProcess {
  readonly child: ChildProcess;
  /** Every stdout line ever seen, in arrival order (notifications included). */
  readonly all: Array<Record<string, unknown>> = [];
  private readonly pending: Array<Record<string, unknown>> = [];
  private readonly waiters: Array<(line: Record<string, unknown>) => void> = [];

  constructor(args: string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const reader = createInterface({ input: this.child.stdout! });
    reader.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      this.all.push(parsed);
      const waiter = this.waiters.shift();
      if (waiter) waiter(parsed);
      else this.pending.push(parsed);
    });
  }

  request(message: JsonRpcRequest): Promise<Record<string, unknown>> {
    this.child.stdin!.write(`${JSON.stringify(message)}\n`);
    return this.next(`response to id=${String(message.id)}`);
  }

  /** Awaits the next stdout line (responses arrive in request order). */
  next(label: string): Promise<Record<string, unknown>> {
    const queued = this.pending.shift();
    if (queued) return Promise.resolve(queued);
    return withTimeout(
      new Promise((resolve) => this.waiters.push(resolve)),
      label,
    );
  }

  fireAndForget(message: JsonRpcRequest): void {
    this.child.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  /** Sends a raw (possibly invalid) line; used to exercise Parse error handling. */
  raw(line: string): void {
    this.child.stdin!.write(`${line}\n`);
  }

  countListChanged(): number {
    return this.all.filter((line) => line.method === TOOLS_LIST_CHANGED).length;
  }

  endInput(): void {
    this.child.stdin!.end();
  }

  async waitForExit(): Promise<number | null> {
    if (this.child.exitCode !== null) return this.child.exitCode;
    return withTimeout(
      new Promise((resolve) => this.child.once("exit", (code) => resolve(code))),
      "server exit",
    );
  }

  destroy(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
    }
  }
}

/**
 * Canned Herdr CLI used as HERDR_BIN_PATH so the real herdr.ts control layer
 * runs end-to-end. Records carry workspace_id so the same-workspace guard of
 * the live-record readers passes; `agent get <name>` echoes the requested
 * name so target resolution succeeds for any syntactically valid target.
 */
function writeFakeHerdrBinary(directory: string): string {
  const binaryPath = join(directory, "herdr-fake");
  writeFileSync(
    binaryPath,
    [
      "#!/bin/sh",
      'case "$1 $2" in',
      '  "agent get")',
      '    if [ "$3" = "self-pane" ]; then',
      '      printf \'{"result":{"agent":{"name":"brain","workspace_id":"ws-main","pane_id":"w9:p1"}}}\'',
      "    else",
      '      printf \'{"result":{"agent":{"name":"%s","workspace_id":"ws-main","pane_id":"tgt:1"}}}\' "$3"',
      "    fi ;;",
      '  "agent list") printf \'{"result":{"agents":[{"name":"brain","workspace_id":"ws-main"},{"name":"worker-mcp","workspace_id":"ws-main"}]}}\';;',
      '  "agent prompt")',
      '    if [ "$3" = "ghost" ]; then',
      '      printf \'{"error":{"code":"agent_not_found","message":"agent target ghost not found"}}\'',
      "      exit 1",
      "    else",
      '      printf \'{"result":{"accepted":true}}\'',
      "    fi ;;",
      '  "pane close") printf \'{"result":{"closed":true}}\';;',
      "  *) printf '{\"error\":{\"code\":\"agent_not_found\",\"message\":\"agent target not found\"}}'; exit 1;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}

test("spawned MCP server over real stdio", async (t) => {
  const flags = await typeStripFlags();
  const scratch = mkdtempSync(join(tmpdir(), "herdr-link-mcp-test-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakeBinary = writeFakeHerdrBinary(scratch);

  await t.test(
    "outside Herdr: handshake works, tools/list is empty, gateway and tool calls fail as NOT_IN_HERDR (smoke: empty gating)",
    async () => {
      const server = new McpServerProcess([...flags, SERVER_ENTRY], herdrFreeEnv());
      try {
        const initialized = await server.request({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        });
        const initResult = initialized.result as Record<string, unknown>;
        assert.equal(initResult.protocolVersion, "2025-06-18");
        assert.deepEqual(initResult.capabilities, { tools: { listChanged: true } });
        server.fireAndForget({ jsonrpc: "2.0", method: "notifications/initialized" });

        server.raw("this is not json");
        server.fireAndForget({ jsonrpc: "2.0", id: 2, method: "ping" });
        const parseErrorResponse = await server.next("parse error response");
        assert.equal(parseErrorResponse.id, null);
        assert.equal((parseErrorResponse.error as { code?: number } | undefined)?.code, PARSE_ERROR);
        const pong = await server.next("pong after parse error");
        assert.equal(pong.id, 2); // sanity: server still alive

        const listed = await server.request({ jsonrpc: "2.0", id: 3, method: "tools/list" });
        assert.deepEqual(listed.result, { tools: [] });

        const called = await server.request({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "herdr_link_peers" },
        });
        const callResult = called.result as { content: Array<{ text: string }>; isError?: boolean };
        assert.equal(callResult.isError, true);
        assert.ok(String(callResult.content[0]!.text).startsWith("NOT_IN_HERDR:"));

        const gatewayCalled = await server.request({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: HERDR_LINK_GATEWAY, arguments: {} },
        });
        const gatewayResult = gatewayCalled.result as { content: Array<{ text: string }>; isError?: boolean };
        assert.equal(gatewayResult.isError, true);
        assert.ok(String(gatewayResult.content[0]!.text).startsWith("NOT_IN_HERDR:"));
        assert.equal(server.countListChanged(), 0);

        server.endInput();
        assert.equal(await server.waitForExit(), 0);
      } finally {
        server.destroy();
      }
    },
  );

  await t.test(
    "inside Herdr: dormant gateway list, activation with list_changed on stdout, refreshed list, control-layer calls, gateway dispatch fallback",
    async () => {
      const server = new McpServerProcess([...flags, SERVER_ENTRY], {
        ...herdrFreeEnv(),
        HERDR_ENV: "1",
        HERDR_BIN_PATH: fakeBinary,
        HERDR_PANE_ID: "self-pane",
      });
      try {
        // Dormant: only the Tier 0 gateway is offered.
        const dormant = await server.request({ jsonrpc: "2.0", id: 1, method: "tools/list" });
        assert.deepEqual(
          (dormant.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name),
          [HERDR_LINK_GATEWAY],
        );

        // Activation: the list_changed notification hits stdout BEFORE the
        // call response (same serialized writer, FIFO), and carries no id.
        server.fireAndForget({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: HERDR_LINK_GATEWAY, arguments: {} },
        });
        const notification = await server.next("tools/list_changed notification");
        assert.deepEqual(notification, { jsonrpc: "2.0", method: TOOLS_LIST_CHANGED });
        assert.equal("id" in notification, false);
        const activated = await server.next("gateway activation response");
        assert.equal(activated.id, 2);
        const activationPayload = JSON.parse(
          (activated.result as { content: Array<{ text: string }> }).content[0]!.text,
        ) as Record<string, unknown>;
        assert.equal(activationPayload.status, "active");
        assert.deepEqual(activationPayload.capabilities, ["peers", "send", "close"]);

        // Active: gateway + canonical Tier 1 tools.
        const active = await server.request({ jsonrpc: "2.0", id: 3, method: "tools/list" });
        assert.deepEqual(
          (active.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name),
          [HERDR_LINK_GATEWAY, ...HERDR_LINK_TOOLS],
        );

        const peers = await server.request({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "herdr_link_peers" },
        });
        const peersResult = peers.result as { content: Array<{ text: string }>; isError?: boolean };
        assert.notEqual(peersResult.isError, true);
        assert.deepEqual(JSON.parse(peersResult.content[0]!.text), {
          self: { name: "brain", state: "unknown" },
          peers: [{ name: "worker-mcp", state: "unknown" }],
        });

        const sent = await server.request({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "herdr_link_send", arguments: { to: "worker-mcp", message: "hello from mcp smoke" } },
        });
        const sentPayload = JSON.parse(
          (sent.result as { content: Array<{ text: string }> }).content[0]!.text,
        ) as Record<string, unknown>;
        assert.equal(sentPayload.status, "sent");
        assert.equal(sentPayload.to, "worker-mcp");
        assert.ok(String(sentPayload.id).startsWith("hl_"));

        const rejected = await server.request({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: "herdr_link_send", arguments: { to: "ghost", message: "hi" } },
        });
        const rejectedResult = rejected.result as { content: Array<{ text: string }>; isError?: boolean };
        assert.equal(rejectedResult.isError, true);
        assert.ok(String(rejectedResult.content[0]!.text).startsWith("PEER_NOT_FOUND:"));

        // Host never refreshed its registry? Gateway dispatch still works.
        const dispatchedClose = await server.request({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: HERDR_LINK_GATEWAY,
            arguments: { action: "close", arguments: { agent: "worker-mcp" } },
          },
        });
        const dispatchedPayload = JSON.parse(
          (dispatchedClose.result as { content: Array<{ text: string }> }).content[0]!.text,
        ) as Record<string, unknown>;
        assert.deepEqual(dispatchedPayload, { status: "closed", agent: "worker-mcp" });

        // Exactly one list_changed for the whole session.
        assert.equal(server.countListChanged(), 1);

        server.endInput();
        assert.equal(await server.waitForExit(), 0);
      } finally {
        server.destroy();
      }
    },
  );
});
