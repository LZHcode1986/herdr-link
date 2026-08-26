import { test } from "node:test";
import assert from "node:assert/strict";

import { herdrLinkPlugin } from "../src/opencode.ts";
import { setHerdrRunnerForTests, type HerdrRunner } from "../src/herdr.ts";
import { COMMUNICATION_CONTRACT, extractInboundEnvelope, HERDR_LINK_GATEWAY, TOOL_CLOSE, TOOL_PEERS, TOOL_SEND } from "../src/protocol.ts";

const HERDR_ENV_KEYS = ["HERDR_ENV", "HERDR_BIN_PATH", "HERDR_PANE_ID"] as const;
type HerdrEnv = Record<(typeof HERDR_ENV_KEYS)[number], string | undefined>;

function snapshotEnvironment(): HerdrEnv {
  return Object.fromEntries(HERDR_ENV_KEYS.map((name) => [name, process.env[name]])) as HerdrEnv;
}

function restoreEnvironment(previous: HerdrEnv): void {
  for (const name of HERDR_ENV_KEYS) {
    const value = previous[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function clearHerdrEnvironment(): void {
  for (const name of HERDR_ENV_KEYS) delete process.env[name];
}

function setHerdrEnvironment(): void {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_BIN_PATH = "/mock/herdr";
  process.env.HERDR_PANE_ID = "self";
}

type GatewayHooks = Awaited<ReturnType<typeof herdrLinkPlugin>>;
type GatewayTool = NonNullable<GatewayHooks["tool"]>[typeof HERDR_LINK_GATEWAY];

async function gatewayInHerdrEnvironment(): Promise<{ hooks: GatewayHooks; gateway: GatewayTool }> {
  setHerdrEnvironment();
  const hooks = await herdrLinkPlugin({} as never);
  const gateway = hooks.tool?.[HERDR_LINK_GATEWAY];
  assert.ok(gateway, "gateway tool must be registered");
  return { hooks, gateway };
}

/** Minimal ToolContext stand-in: the gateway only reads sessionID. */
function toolContext(sessionID: string): Parameters<GatewayTool["execute"]>[1] {
  return { sessionID } as Parameters<GatewayTool["execute"]>[1];
}

/** Live-record fixture matching the v2 core reader: name/workspace/pane/status. */
function liveAgent(name: string, workspaceId = "ws-1"): unknown {
  return { result: { name, workspace_id: workspaceId, pane_id: `pane-${name}`, agent_status: "working" } };
}

async function executeGateway(gateway: GatewayTool, args: unknown, sessionID: string): Promise<unknown> {
  const result = await gateway.execute(args as never, toolContext(sessionID));
  return JSON.parse(result as string);
}

/** Executes once and resolves with the thrown Agent-facing message verbatim. */
async function executeGatewayError(gateway: GatewayTool, args: unknown, sessionID: string): Promise<string> {
  let message = "";
  await assert.rejects(
    () => gateway.execute(args as never, toolContext(sessionID)),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      message = error.message;
      assert.match(message, /^[A-Z_]+: .+/, "agent-facing errors must carry a stable code prefix");
      return true;
    },
  );
  return message;
}

function systemOutput(...entries: string[]): { system: string[] } {
  return { system: [...entries] };
}

test("OpenCode adapter environment gating and gateway fallback", async (t) => {
  const previous = snapshotEnvironment();
  t.after(() => restoreEnvironment(previous));

  await t.test("is a no-op outside Herdr", async () => {
    clearHerdrEnvironment();

    const hooks = await herdrLinkPlugin({} as never);

    assert.deepEqual(hooks, {});
    assert.equal(hooks.tool, undefined);
    assert.equal(hooks["experimental.chat.system.transform"], undefined);
  });

  await t.test("registers only the single herdr_link gateway — no always-resident Tier 1 tools", async () => {
    const { hooks, gateway } = await gatewayInHerdrEnvironment();

    assert.deepEqual(Object.keys(hooks.tool ?? {}), [HERDR_LINK_GATEWAY]);
    assert.match(gateway.description, /only when the user explicitly asks to use Herdr/);
    assert.match(gateway.description, /handling an inbound Herdr Link message/);
    for (const tier1 of [TOOL_PEERS, TOOL_SEND, TOOL_CLOSE]) {
      assert.equal(hooks.tool?.[tier1], undefined);
    }
    assert.equal(typeof hooks["experimental.chat.system.transform"], "function");
  });

  await t.test("does not rely on unpublished tool.definition behavior", async () => {
    const { hooks, gateway } = await gatewayInHerdrEnvironment();

    // No per-session schema mutation hook is declared or needed.
    assert.equal("tool.definition" in hooks, false);

    // The static schema admits both the activation call ({}, all fields
    // optional) and fully-formed actions; unknown enum values are rejected by
    // the schema itself.
    const fieldAccepts = (field: string, value: unknown): boolean =>
      (gateway.args[field as keyof typeof gateway.args] as unknown as {
        safeParse(input: unknown): { success: boolean };
      }).safeParse(value).success;

    assert.deepEqual(Object.keys(gateway.args), ["action", "to", "message", "agent"]);
    assert.equal(fieldAccepts("action", undefined), true);
    assert.equal(fieldAccepts("action", "peers"), true);
    assert.equal(fieldAccepts("action", "send"), true);
    assert.equal(fieldAccepts("action", "close"), true);
    assert.equal(fieldAccepts("action", "activate"), false);
    for (const field of ["to", "message", "agent"]) {
      assert.equal(fieldAccepts(field, undefined), true);
      assert.equal(fieldAccepts(field, "x"), true);
    }
  });

  await t.test("gateway {} activation is idempotent and returns capabilities", async () => {
    const { hooks, gateway } = await gatewayInHerdrEnvironment();
    const transform = hooks["experimental.chat.system.transform"];
    assert.ok(transform);

    const first = await executeGateway(gateway, {}, "session-1");
    assert.deepEqual(first, { status: "active", capabilities: ["peers", "send", "close"] });

    const second = await executeGateway(gateway, {}, "session-1");
    assert.deepEqual(second, { status: "active", capabilities: ["peers", "send", "close"] });

    const output = systemOutput("base prompt");
    await transform({ sessionID: "session-1", model: {} as never }, output as never);
    await transform({ sessionID: "session-1", model: {} as never }, output as never);
    assert.equal(output.system.length, 2);
    assert.match(output.system[1] ?? "", /herdr-link\/1/);
  });

  await t.test("activation is isolated per sessionID and ephemeral per plugin instance", async () => {
    const { hooks, gateway } = await gatewayInHerdrEnvironment();
    const transform = hooks["experimental.chat.system.transform"];
    assert.ok(transform);

    // Session A activates; untouched session B stays dormant.
    await executeGateway(gateway, {}, "session-a");
    const dormantB = systemOutput("base prompt");
    await transform({ sessionID: "session-b", model: {} as never }, dormantB as never);
    assert.deepEqual(dormantB.system, ["base prompt"]);

    // Optional/absent sessionID fails closed.
    const unattributed = systemOutput("base prompt");
    await transform({ model: {} as never }, unattributed as never);
    assert.deepEqual(unattributed.system, ["base prompt"]);

    // Session B activates independently of A.
    await executeGateway(gateway, {}, "session-b");
    const activeB = systemOutput("base prompt");
    await transform({ sessionID: "session-b", model: {} as never }, activeB as never);
    assert.equal(activeB.system.length, 2);

    // A fresh plugin instance starts fully dormant — no module-global leakage.
    const fresh = await herdrLinkPlugin({} as never);
    const freshTransform = fresh["experimental.chat.system.transform"];
    assert.ok(freshTransform);
    const freshOutput = systemOutput("base prompt");
    await freshTransform({ sessionID: "session-a", model: {} as never }, freshOutput as never);
    assert.deepEqual(freshOutput.system, ["base prompt"]);
  });

  await t.test("dormant sessions get no Contract; active sessions get exactly one", async () => {
    const { hooks, gateway } = await gatewayInHerdrEnvironment();
    const transform = hooks["experimental.chat.system.transform"];
    assert.ok(transform);

    const dormant = systemOutput("base prompt");
    await transform({ sessionID: "never-activated", model: {} as never }, dormant as never);
    assert.deepEqual(dormant.system, ["base prompt"]);

    await executeGateway(gateway, {}, "active-session");
    const active = systemOutput("base prompt");
    await transform({ sessionID: "active-session", model: {} as never }, active as never);
    assert.equal(active.system.length, 2);
    assert.ok((active.system[1] ?? "").startsWith(COMMUNICATION_CONTRACT));
    assert.match(active.system[1] ?? "", /single herdr_link gateway/);
    assert.match(active.system[1] ?? "", /exactly "done"/);
    assert.match(active.system[1] ?? "", /failure or blocker/);
    assert.match(active.system[1] ?? "", /explicitly requested no reply/);
    assert.match(active.system[1] ?? "", /later tool step/);

    // Repeated transforms stay idempotent.
    await transform({ sessionID: "active-session", model: {} as never }, active as never);
    assert.equal(active.system.length, 2);
  });

  await t.test("dispatcher action=peers maps onto the core control layer", async () => {
    const { gateway } = await gatewayInHerdrEnvironment();
    const runner: HerdrRunner = async (_file, args) => {
      if (args[0] === "agent" && args[1] === "get") {
        return { stdout: JSON.stringify(liveAgent(String(args[2]))), stderr: "" };
      }
      if (args[0] === "agent" && args[1] === "list") {
        return {
          stdout: JSON.stringify({
            result: {
              agents: [
                { name: "alpha", workspace_id: "ws-1", pane_id: "p1", status: "idle" },
                { name: "beta", workspace_id: "ws-1", pane_id: "p2" },
                // Foreign-workspace and opted-out entries must not appear.
                { name: "gamma", workspace_id: "ws-2", pane_id: "p3" },
                { name: "delta", workspace_id: "ws-1", pane_id: "p4", live: false },
              ],
            },
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    };
    setHerdrRunnerForTests(runner);
    t.after(() => setHerdrRunnerForTests(undefined));

    const result = (await executeGateway(gateway, { action: "peers" }, "session-x")) as {
      self: { name: string; state: string };
      peers: { name: string; state: string }[];
    };
    assert.equal(result.self.name, "self");
    assert.deepEqual(result.peers.map((peer) => peer.name), ["alpha", "beta"]);
  });

  await t.test('dispatcher action="send" builds a minimal envelope', async () => {
    const { gateway } = await gatewayInHerdrEnvironment();
    const promptArgs: string[] = [];
    const runner: HerdrRunner = async (_file, args) => {
      if (args[0] === "agent" && args[1] === "get") {
        return { stdout: JSON.stringify(liveAgent(String(args[2]))), stderr: "" };
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        promptArgs.push(args[2], args[3]);
        return { stdout: "{}", stderr: "" };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    };
    setHerdrRunnerForTests(runner);
    t.after(() => setHerdrRunnerForTests(undefined));

    const result = (await executeGateway(
      gateway,
      { action: "send", to: "alpha", message: "hello" },
      "session-y",
    )) as { status: string; id: string; to: string };
    assert.deepEqual(result, { status: "sent", id: result.id, to: "alpha" });
    assert.match(result.id, /^hl_[a-z0-9]+_[a-z0-9]+$/);

    const [target, payload] = promptArgs;
    assert.equal(target, "alpha");
    // The core delivers the inbound wrapper; the embedded envelope is canonical.
    assert.match(payload ?? "", /\[herdr-link\/1\]/);
    const envelope = extractInboundEnvelope(payload as string);
    assert.ok(envelope);
    assert.equal(envelope.protocol, "herdr-link/1");
    assert.equal(envelope.from, "self");
    assert.equal(envelope.to, "alpha");
    assert.equal(envelope.message, "hello");
  });

  await t.test('dispatcher action="close" resolves the live pane via core layer', async () => {
    const { gateway } = await gatewayInHerdrEnvironment();
    const closedPanes: string[] = [];
    const runner: HerdrRunner = async (_file, args) => {
      if (args[0] === "agent" && args[1] === "get") {
        return { stdout: JSON.stringify(liveAgent(String(args[2]))), stderr: "" };
      }
      if (args[0] === "pane" && args[1] === "close") {
        closedPanes.push(args[2]);
        return { stdout: "{}", stderr: "" };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    };
    setHerdrRunnerForTests(runner);
    t.after(() => setHerdrRunnerForTests(undefined));

    const result = (await executeGateway(gateway, { action: "close", agent: "beta" }, "session-z")) as {
      status: string;
      agent: string;
    };
    assert.deepEqual(result, { status: "closed", agent: "beta" });
    assert.deepEqual(closedPanes, ["pane-beta"]);
  });

  await t.test("dispatcher errors are uniformly formatted with stable codes", async () => {
    const { gateway } = await gatewayInHerdrEnvironment();

    setHerdrRunnerForTests(async (_file, args) => {
      if (args[0] === "agent" && args[1] === "get") {
        return { stdout: JSON.stringify(liveAgent(String(args[2]))), stderr: "" };
      }
      return { stdout: "{}", stderr: "" };
    });
    t.after(() => setHerdrRunnerForTests(undefined));

    // Missing per-action parameters keep the §7 vocabulary with stable text.
    assert.equal(
      await executeGatewayError(gateway, { action: "send", message: "hi" }, "session-e"),
      "SEND_FAILED: Herdr did not accept message delivery",
    );
    assert.equal(
      await executeGatewayError(gateway, { action: "close" }, "session-e"),
      "CLOSE_FAILED: Herdr pane close failed",
    );

    // Transport failure stays NOT_IN_HERDR — the core never re-labels an
    // unusable environment as an operation failure.
    setHerdrRunnerForTests(async () => {
      throw new Error("cli exploded");
    });
    assert.equal(
      await executeGatewayError(gateway, { action: "peers" }, "session-e"),
      "NOT_IN_HERDR: Herdr environment is unavailable",
    );
  });

  await t.test("environment loss inside a session surfaces NOT_IN_HERDR through the gateway", async () => {
    const { gateway } = await gatewayInHerdrEnvironment();
    clearHerdrEnvironment();
    t.after(() => setHerdrEnvironment());

    assert.equal(
      await executeGatewayError(gateway, { action: "peers" }, "session-env"),
      "NOT_IN_HERDR: Herdr environment is unavailable",
    );
  });
});
