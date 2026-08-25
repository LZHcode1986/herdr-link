import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import piExtension from "../src/pi.ts";
import {
  resetSelfBootstrapForTests,
  setHerdrRunnerForTests,
  type HerdrRunner,
} from "../src/herdr.ts";
import { COMMUNICATION_CONTRACT, HerdrLinkError } from "../src/protocol.ts";

const HERDR_ENV_KEYS = ["HERDR_ENV", "HERDR_BIN_PATH", "HERDR_PANE_ID"] as const;

type EnvSnapshot = Record<(typeof HERDR_ENV_KEYS)[number], string | undefined>;

function snapshotEnv(): EnvSnapshot {
  return Object.fromEntries(HERDR_ENV_KEYS.map((name) => [name, process.env[name]])) as EnvSnapshot;
}

function restoreEnv(previous: EnvSnapshot): void {
  for (const name of HERDR_ENV_KEYS) {
    const value = previous[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

/** Sets the full Herdr environment; caller restores via restoreEnv(). */
function useHerdrEnv(): void {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_BIN_PATH = "/mock/herdr";
  process.env.HERDR_PANE_ID = "self-pane";
}

type Handler = (event: unknown) => unknown;

/**
 * Minimal ExtensionAPI double implementing exactly the public surface the
 * adapter uses: on(), registerTool(), getActiveTools(), setActiveTools().
 * Mimics Pi's default of newly registered tools being active, which is what
 * makes the dormant presentation necessary in the first place.
 */
function fakePi(hostTools: string[] = ["read", "bash"]): {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  tools: ToolDefinition[];
  activeTools: () => string[];
  activeToolCalls: string[][];
  dispatch: (event: { type: string; [key: string]: unknown }) => unknown;
} {
  const handlers = new Map<string, Handler[]>();
  const tools: ToolDefinition[] = [];
  const active: string[] = [...hostTools];
  const activeToolCalls: string[][] = [];

  const pi = {
    on(event: string, handler: Handler): void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: ToolDefinition): void {
      tools.push(tool);
      active.push(tool.name);
    },
    getActiveTools(): string[] {
      return [...active];
    },
    setActiveTools(names: string[]): void {
      activeToolCalls.push([...names]);
      active.splice(0, active.length, ...names);
    },
  } as unknown as ExtensionAPI;

  function dispatch(event: { type: string; [key: string]: unknown }): unknown {
    const list = handlers.get(event.type) ?? [];
    let result: unknown;
    for (const handler of list) {
      result = handler(event);
    }
    return result;
  }

  return { pi, handlers, tools, activeTools: () => [...active], activeToolCalls, dispatch };
}

function findTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

const NO_CTX = {} as unknown as ExtensionContext;

function parsedText(result: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(result.content[0]?.text ?? "");
}

interface CliCall {
  args: string[];
}

/** Mocks Herdr CLI IO for the duration of callback; restores runner+env after. */
async function withHerdrMock(
  responder: (args: string[]) => unknown,
  callback: (calls: CliCall[]) => Promise<void>,
): Promise<void> {
  const previous = snapshotEnv();
  useHerdrEnv();
  const calls: CliCall[] = [];
  const runner: HerdrRunner = async (_file, args) => {
    calls.push({ args: [...args] });
    const response = await responder(args);
    return { stdout: JSON.stringify(response) ?? "", stderr: "" };
  };
  setHerdrRunnerForTests(runner);
  resetSelfBootstrapForTests(); // drop any stale flight born outside this mock
  try {
    await callback(calls);
  } finally {
    setHerdrRunnerForTests(undefined);
    restoreEnv(previous);
  }
}

test("Pi adapter v2 — Tier 0/Tier 1", async (t) => {
  const previous = snapshotEnv();
  t.after(() => restoreEnv(previous));

  await t.test("is a no-op outside a Herdr environment", () => {
    for (const name of HERDR_ENV_KEYS) delete process.env[name];
    const first = fakePi();
    piExtension(first.pi);
    assert.equal(first.tools.length, 0);
    assert.equal(first.handlers.size, 0);

    // Partial environment is equally insufficient.
    process.env.HERDR_ENV = "1";
    const second = fakePi();
    piExtension(second.pi);
    assert.equal(second.tools.length, 0);
    assert.equal(second.handlers.size, 0);
    delete process.env.HERDR_ENV;
  });

  await t.test("dormant: registers gateway plus inactive Tier 1 tools", () => {
    useHerdrEnv();
    const { pi, handlers, tools, activeTools, activeToolCalls, dispatch } = fakePi();

    piExtension(pi);

    // Pi's public API requires every tool to be registered before it can be
    // referenced by setActiveTools, so all four exist after load…
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["herdr_link", "herdr_link_close", "herdr_link_peers", "herdr_link_send"],
    );
    assert.deepEqual([...handlers.keys()].sort(), ["before_agent_start", "session_start"]);

    // …and session_start demotes Tier 1 out of the active set while keeping
    // host defaults and the gateway: the model sees only the tiny gateway.
    resetSelfBootstrapForTests();
    dispatch({ type: "session_start", reason: "startup" });
    assert.equal(activeToolCalls.length, 1);
    assert.deepEqual(activeToolCalls[0], ["read", "bash", "herdr_link"]);
    assert.deepEqual(activeTools(), ["read", "bash", "herdr_link"]);
  });

  await t.test("dormant: Tier 1 tools carry descriptions only, no prompt metadata", () => {
    useHerdrEnv();
    const { pi, tools } = fakePi();
    piExtension(pi);

    const gateway = findTool(tools, "herdr_link");
    assert.match(gateway.description, /\{\}/);
    assert.match(gateway.description, /only when the user explicitly asks to use Herdr/);
    assert.match(gateway.description, /handling an inbound Herdr Link message/);
    assert.ok(typeof gateway.promptSnippet === "string");

    for (const name of ["herdr_link_peers", "herdr_link_send", "herdr_link_close"]) {
      const tool = findTool(tools, name);
      assert.equal(tool.promptGuidelines, undefined, `${name} must not carry promptGuidelines`);
      assert.equal(tool.promptSnippet, undefined, `${name} must rely on its description`);
      assert.ok((tool.description ?? "").length > 0, `${name} description must stand alone`);
    }
    // close keeps sequential semantics with send-before-close guidance.
    const close = findTool(tools, "herdr_link_close");
    assert.equal(close.executionMode, "sequential");
    assert.match(close.description ?? "", /sent/);
    assert.match(close.description ?? "", /later tool step/);
  });

  await t.test("gateway activates idempotently via setActiveTools, never Herdr IO", async () => {
    useHerdrEnv();
    const { pi, tools, activeToolCalls, dispatch } = fakePi();
    piExtension(pi);
    resetSelfBootstrapForTests();
    dispatch({ type: "session_start", reason: "startup" });

    const cliCalls: CliCall[] = [];
    setHerdrRunnerForTests(async (file, args) => {
      cliCalls.push({ args: [file, ...args] });
      return { stdout: "{}", stderr: "" };
    });
    try {
      const gateway = findTool(tools, "herdr_link");
      const firstActivation = await gateway.execute("gw-1", {}, undefined, undefined, NO_CTX);
      assert.deepEqual(parsedText(firstActivation as never), {
        status: "active",
        capabilities: ["peers", "send", "close"],
      });

      // Activation merges additively into the current active set.
      assert.equal(activeToolCalls.length, 2);
      assert.deepEqual(activeToolCalls[1], [
        "read",
        "bash",
        "herdr_link",
        "herdr_link_peers",
        "herdr_link_send",
        "herdr_link_close",
      ]);

      // Second call: same answer, no additional setActiveTools, no Herdr IO.
      const secondActivation = await gateway.execute("gw-2", {}, undefined, undefined, NO_CTX);
      assert.deepEqual(parsedText(secondActivation as never), {
        status: "active",
        capabilities: ["peers", "send", "close"],
      });
      assert.equal(activeToolCalls.length, 2);
      assert.deepEqual(cliCalls, []);
    } finally {
      setHerdrRunnerForTests(undefined);
    }
  });

  await t.test("Contract injection: absent while dormant, compact once active", async () => {
    useHerdrEnv();
    const { pi, tools, handlers, dispatch } = fakePi();
    piExtension(pi);
    const baseSystemPrompt = "BASE SYSTEM PROMPT";
    const event = { type: "before_agent_start", prompt: "hi", systemPrompt: baseSystemPrompt };

    assert.equal(dispatch(event), undefined, "dormant sessions get no Contract injection");

    const gateway = findTool(tools, "herdr_link");
    await gateway.execute("gw-1", {}, undefined, undefined, NO_CTX);

    const result = dispatch(event) as { systemPrompt?: string } | undefined;
    assert.ok(result?.systemPrompt, "activated sessions inject the compact Contract");
    assert.ok(result.systemPrompt.startsWith(baseSystemPrompt));
    const injected = result.systemPrompt.slice(baseSystemPrompt.length);
    assert.ok(injected.includes("\n\n"));
    for (const marker of ["herdr-link/1", "reply_to", "herdr_link_peers", "herdr_link_send", "herdr_link_close", "later tool step"]) {
      assert.ok(injected.includes(marker), `compact Contract must mention ${marker}`);
    }
    // Pi injects the canonical Contract directly; tool descriptions carry the presentation details.
    assert.equal(injected.trim(), COMMUNICATION_CONTRACT);

    // New session returns to dormant: activation is session-scoped only.
    resetSelfBootstrapForTests();
    dispatch({ type: "session_start", reason: "new" });
    assert.equal(dispatch(event), undefined);
    assert.ok(handlers.has("before_agent_start"));
  });

  await t.test("Tier 1: peers discovery over mocked Herdr CLI", async () => {
    await withHerdrMock((args) => {
      if (args[0] === "agent" && args[1] === "get") {
        const name = args[2] === "worker-a" ? "worker-a" : "brain";
        const pane = name === "worker-a" ? "w1:p2" : "self-pane";
        return {
          result: {
            agent: { name, workspace_id: "ws-1", pane_id: pane, agent_status: name === "worker-a" ? "working" : "idle" },
          },
        };
      }
      if (args[0] === "agent" && args[1] === "list") {
        return {
          result: {
            agents: [
              { name: "brain", workspace_id: "ws-1", pane_id: "self-pane", agent_status: "idle" },
              { name: "worker-a", workspace_id: "ws-1", pane_id: "w1:p2", agent_status: "working" },
              { pane_id: "w1:p4" },
            ],
          },
        };
      }
      throw new Error(`unexpected CLI call: ${args.join(" ")}`);
    }, async (cliCalls) => {
      useHerdrEnv();
      const { pi, tools } = fakePi();
      piExtension(pi);
      const peers = findTool(tools, "herdr_link_peers");

      const result = (await peers.execute("p-1", {}, undefined, undefined, NO_CTX)) as {
        content: Array<{ text: string }>;
        details: unknown;
      };
      const expected = {
        self: { name: "brain", state: "idle" },
        peers: [{ name: "worker-a", state: "working" }],
      };
      assert.deepEqual(parsedText(result), expected);
      assert.deepEqual(result.details, expected);
      assert.deepEqual(cliCalls.map((call) => call.args), [
        ["agent", "get", "self-pane"],
        ["agent", "list"],
      ]);
    });
  });

  await t.test("Tier 1: send builds envelope with reply_to correlation", async () => {
    await withHerdrMock((args) => {
      if (args[0] === "agent" && args[1] === "get") {
        const name = args[2] === "worker-a" ? "worker-a" : "brain";
        return {
          result: {
            agent: {
              name,
              workspace_id: "ws-1",
              pane_id: name === "worker-a" ? "w1:p2" : "self-pane",
              agent_status: name === "worker-a" ? "working" : "idle",
            },
          },
        };
      }
      return { ok: true };
    }, async (cliCalls) => {
      useHerdrEnv();
      const { pi, tools } = fakePi();
      piExtension(pi);
      const send = findTool(tools, "herdr_link_send");

      const result = (await send.execute(
        "s-1",
        { to: "worker-a", message: "请检查设计。", reply_to: "hl_abc_defghijk" },
        undefined,
        undefined,
        NO_CTX,
      )) as { content: Array<{ text: string }>; details: unknown };

      const payload = parsedText(result) as { status: string; id: string; to: string };
      assert.equal(payload.status, "sent");
      assert.equal(payload.to, "worker-a");
      assert.match(payload.id, /^hl_[a-z0-9]+_[a-z0-9]+$/);
      assert.deepEqual(result.details, payload);

      const promptCall = cliCalls.find((call) => call.args[0] === "agent" && call.args[1] === "prompt");
      assert.ok(promptCall, "send must deliver via herdr agent prompt");
      assert.equal(promptCall.args[2], "worker-a");
      const prompt = promptCall.args[3] ?? "";
      assert.match(prompt, /\[herdr-link\/1\]/);
      const envelope = JSON.parse(prompt.split("\n").at(-1)!) as Record<string, unknown>;
      assert.equal(envelope.protocol, "herdr-link/1");
      assert.equal(envelope.from, "brain");
      assert.equal(envelope.to, "worker-a");
      assert.equal(envelope.message, "请检查设计。");
      assert.equal(envelope.reply_to, "hl_abc_defghijk");
    });
  });

  await t.test("Tier 1: stable agent-facing error codes", async () => {
    // SELF_UNNAMED: live occupant has no valid Agent Name.
    await withHerdrMock(() => ({ result: { agent: { name: "", pane_id: "self-pane" } } }), async () => {
      useHerdrEnv();
      const { pi, tools } = fakePi();
      piExtension(pi);
      const peers = findTool(tools, "herdr_link_peers");
      await assert.rejects(
        peers.execute("p-err", {}, undefined, undefined, NO_CTX),
        /SELF_UNNAMED: Herdr Link could not establish a stable Agent Name/,
      );
    });

    await withHerdrMock((args) => {
      if (args[0] === "agent" && args[1] === "get") {
        if (args[2] === "ghost") throw new HerdrLinkError("PEER_NOT_FOUND", "target agent is not a live peer");
        const name = args[2] === "worker-a" ? "worker-a" : "brain";
        return {
          result: {
            agent: {
              name,
              workspace_id: "ws-1",
              pane_id: name === "worker-a" ? "w1:p2" : "w1:p9",
              agent_status: "working",
            },
          },
        };
      }
      if (args[0] === "agent" && args[1] === "prompt") throw new Error("simulated CLI crash");
      if (args[0] === "pane") throw new Error("pane close exploded");
      return { ok: true };
    }, async () => {
      useHerdrEnv();
      const { pi, tools } = fakePi();
      piExtension(pi);
      const send = findTool(tools, "herdr_link_send");
      const close = findTool(tools, "herdr_link_close");

      // PEER_NOT_FOUND from model-supplied target validation.
      await assert.rejects(
        send.execute("s-bad", { to: "BAD_NAME!", message: "hi" }, undefined, undefined, NO_CTX),
        /PEER_NOT_FOUND: target agent is not a live peer/,
      );

      // Transport failure is an environment failure, not an operation failure.
      await assert.rejects(
        send.execute("s-fail", { to: "worker-a", message: "hi" }, undefined, undefined, NO_CTX),
        /NOT_IN_HERDR: Herdr environment is unavailable/,
      );

      // PEER_NOT_FOUND when close target cannot be resolved.
      await assert.rejects(
        close.execute("c-bad", { agent: "ghost" }, undefined, undefined, NO_CTX),
        /PEER_NOT_FOUND: target agent is not a live peer/,
      );

      // Pane transport failure likewise remains NOT_IN_HERDR.
      await assert.rejects(
        close.execute("c-fail", { agent: "brain" }, undefined, undefined, NO_CTX),
        /NOT_IN_HERDR: Herdr environment is unavailable/,
      );

    });
  });

  await t.test("Tier 1: close resolves authoritative pane sequentially", async () => {
    await withHerdrMock((args) => {
      if (args[0] === "agent" && args[1] === "get") {
        if (args[2] === "worker-a") {
          return {
            result: {
              agent: { name: "worker-a", workspace_id: "ws-1", pane_id: "w1:p2", agent_status: "working" },
            },
          };
        }
        return {
          result: {
            agent: { name: "brain", workspace_id: "ws-1", pane_id: "self-pane", agent_status: "idle" },
          },
        };
      }
      return { ok: true };
    }, async (cliCalls) => {
      useHerdrEnv();
      const { pi, tools } = fakePi();
      piExtension(pi);
      const close = findTool(tools, "herdr_link_close");
      assert.equal(close.executionMode, "sequential");

      const result = (await close.execute(
        "c-1",
        { agent: "worker-a" },
        undefined,
        undefined,
        NO_CTX,
      )) as { content: Array<{ text: string }> };

      assert.deepEqual(parsedText(result), { status: "closed", agent: "worker-a" });
      // Order proves agent get → pane close against the authoritative pane.
      assert.deepEqual(cliCalls.map((call) => call.args), [
        ["agent", "get", "self-pane"],
        ["agent", "get", "worker-a"],
        ["pane", "close", "w1:p2"],
      ]);
    });
  });
});
