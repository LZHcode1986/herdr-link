import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertHerdrEnvironment,
  attachCliOutput,
  closeAgentPane,
  getSelf,
  listPeers,
  runHerdr,
  sendMessage,
  setHerdrRunnerForTests,
  type HerdrRunner,
} from "../src/herdr.ts";
import { HerdrLinkError, PROTOCOL_ID, type LinkErrorCode } from "../src/protocol.ts";

interface Call {
  file: string;
  args: string[];
}

type MockHandler = (file: string, args: string[]) => unknown | Promise<unknown>;

function matchesCode(code: LinkErrorCode): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof HerdrLinkError && error.code === code;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function withMock(handler: MockHandler, callback: (calls: Call[]) => Promise<void>): Promise<void> {
  const previous = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_BIN_PATH: process.env.HERDR_BIN_PATH,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  };
  const calls: Call[] = [];

  process.env.HERDR_ENV = "1";
  process.env.HERDR_BIN_PATH = "/mock/herdr";
  process.env.HERDR_PANE_ID = "self-pane";
  const runner: HerdrRunner = async (file, args) => {
    calls.push({ file, args: [...args] });
    const response = await handler(file, args);
    const stdout = typeof response === "string" ? response : JSON.stringify(response);
    if (stdout === undefined) throw new Error("mock response must be JSON serializable");
    return { stdout, stderr: "" };
  };
  setHerdrRunnerForTests(runner);

  try {
    await callback(calls);
  } finally {
    setHerdrRunnerForTests(undefined);
    restoreEnv("HERDR_ENV", previous.HERDR_ENV);
    restoreEnv("HERDR_BIN_PATH", previous.HERDR_BIN_PATH);
    restoreEnv("HERDR_PANE_ID", previous.HERDR_PANE_ID);
  }
}

test("Herdr control layer", async (t) => {
  await t.test("successful identity, peer discovery, send, and close paths", async () => {
    await withMock(async (_file, args) => {
      if (args[0] === "agent" && args[1] === "get" && args[2] === "self-pane") {
        return { result: { agent: { name: "brain", pane_id: "w1:p1" } } };
      }
      if (args[0] === "agent" && args[1] === "list") {
        return {
          result: {
            agents: [
              { name: "brain", pane_id: "w1:p1" },
              { name: "worker-a", pane_id: "w1:p2" },
              { name: "worker_b", pane_id: "w1:p3" },
              { name: "" },
              { pane_id: "w1:p4" },
            ],
          },
        };
      }
      if (args[0] === "agent" && args[1] === "prompt") return { result: { accepted: true } };
      if (args[0] === "agent" && args[1] === "get" && args[2] === "worker-a") {
        return { result: { agent: { name: "worker-a", pane_id: "w1:p2" } } };
      }
      if (args[0] === "pane" && args[1] === "close") return { result: { closed: true } };
      throw new Error(`unexpected mock args: ${args.join(" ")}`);
    }, async (calls) => {
      assert.equal(await getSelf(), "brain");
      assert.deepEqual(await listPeers(), { self: "brain", peers: ["worker-a", "worker_b"] });

      const sent = await sendMessage("worker-a", "hello", "hl_previous");
      assert.equal(sent.status, "sent");
      assert.equal(sent.to, "worker-a");

      const envelope = JSON.parse(calls[4]!.args[3]!) as Record<string, unknown>;
      assert.equal(envelope.protocol, PROTOCOL_ID);
      assert.equal(envelope.from, "brain");
      assert.equal(envelope.to, "worker-a");
      assert.equal(envelope.message, "hello");
      assert.equal(envelope.reply_to, "hl_previous");
      assert.equal(sent.id, envelope.id);
      assert.deepEqual(calls[4]!.args.slice(0, 3), ["agent", "prompt", "worker-a"]);
      assert.equal(calls[4]!.args.length, 4);

      assert.deepEqual(await closeAgentPane("worker-a"), { status: "closed", agent: "worker-a" });
      assert.deepEqual(calls.map((call) => call.file), Array(7).fill("/mock/herdr"));
      assert.deepEqual(calls[6]!.args, ["pane", "close", "w1:p2"]);
    });
  });

  await t.test("returns NOT_IN_HERDR when the environment is unavailable", async () => {
    await withMock(async () => ({ ok: true }), async (calls) => {
      delete process.env.HERDR_ENV;
      assert.throws(assertHerdrEnvironment, matchesCode("NOT_IN_HERDR"));
      await assert.rejects(runHerdr(["agent", "list"]), matchesCode("NOT_IN_HERDR"));

      process.env.HERDR_ENV = "1";
      delete process.env.HERDR_BIN_PATH;
      await assert.rejects(getSelf(), matchesCode("NOT_IN_HERDR"));
      assert.equal(calls.length, 0);
    });
  });

  await t.test("returns SELF_UNNAMED when self identity cannot be resolved", async () => {
    await withMock(async () => ({ result: { agent: { name: "" } } }), async (calls) => {
      delete process.env.HERDR_PANE_ID;
      await assert.rejects(getSelf(), matchesCode("SELF_UNNAMED"));

      process.env.HERDR_PANE_ID = "self-pane";
      await assert.rejects(getSelf(), matchesCode("SELF_UNNAMED"));
      assert.equal(calls.length, 1);
    });
  });

  await t.test("maps self agent_not_found CLI errors to SELF_UNNAMED", async () => {
    await withMock(async () => {
      const error = new Error("Command failed: herdr target not found");
      attachCliOutput(
        error,
        "",
        JSON.stringify({
          error: { code: "agent_not_found", message: "agent target self-pane not found" },
          id: "cli:agent:get",
        }),
      );
      throw error;
    }, async (calls) => {
      const matchesSelfUnnamed = (error: unknown): boolean =>
        error instanceof HerdrLinkError &&
        error.code === "SELF_UNNAMED" &&
        error.message.includes("agent target self-pane not found");
      await assert.rejects(getSelf(), matchesSelfUnnamed);
      assert.deepEqual(calls[0]!.args, ["agent", "get", "self-pane"]);
    });
  });

  await t.test("returns PEER_NOT_FOUND when the target cannot be resolved", async () => {
    await withMock(async () => {
      throw new Error("agent not found");
    }, async (calls) => {
      await assert.rejects(closeAgentPane("worker-a"), matchesCode("PEER_NOT_FOUND"));
      assert.deepEqual(calls[0]!.args, ["agent", "get", "worker-a"]);
      assert.equal(calls.length, 1);
    });
  });

  await t.test("returns SEND_FAILED when prompt delivery fails", async () => {
    await withMock(async (_file, args) => {
      if (args[0] === "agent" && args[1] === "get") {
        return { result: { agent: { name: "brain", pane_id: "w1:p1" } } };
      }
      throw new Error("prompt rejected");
    }, async (calls) => {
      await assert.rejects(sendMessage("worker-a", "hello"), matchesCode("SEND_FAILED"));
      assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
        ["agent", "get", "self-pane"],
        ["agent", "prompt", "worker-a"],
      ]);
      assert.equal(calls[1]!.args.includes("--wait"), false);
    });
  });

  await t.test("returns CLOSE_FAILED when pane close fails", async () => {
    await withMock(async (_file, args) => {
      if (args[0] === "agent" && args[1] === "get") {
        return { result: { agent: { name: "worker-a", pane_id: "w1:p2" } } };
      }
      throw new Error("pane close rejected");
    }, async (calls) => {
      await assert.rejects(closeAgentPane("worker-a"), matchesCode("CLOSE_FAILED"));
      assert.deepEqual(calls.map((call) => call.args), [
        ["agent", "get", "worker-a"],
        ["pane", "close", "w1:p2"],
      ]);
    });
  });
  await t.test("maps agent_not_found CLI errors to PEER_NOT_FOUND", async () => {
    await withMock(async (_file, args) => {
      if (args[0] === "agent" && args[1] === "get" && args[2] === "self-pane") {
        return { result: { agent: { name: "brain", pane_id: "w1:p1" } } };
      }
      const error = new Error("Command failed: herdr target not found");
      attachCliOutput(
        error,
        JSON.stringify({
          error: { code: "agent_not_found", message: "agent target nonexistent-agent not found" },
          id: "cli:agent:prompt",
        }),
        "",
      );
      throw error;
    }, async (calls) => {
      await assert.rejects(sendMessage("nonexistent-agent", "hello"), matchesCode("PEER_NOT_FOUND"));
      await assert.rejects(closeAgentPane("nonexistent-agent"), matchesCode("PEER_NOT_FOUND"));
      assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
        ["agent", "get", "self-pane"],
        ["agent", "prompt", "nonexistent-agent"],
        ["agent", "get", "nonexistent-agent"],
      ]);
    });
  });
  await t.test("maps agent_not_found stderr JSON to PEER_NOT_FOUND with CLI detail", async () => {
    await withMock(async (_file, args) => {
      if (args[0] === "agent" && args[1] === "get" && args[2] === "self-pane") {
        return { result: { agent: { name: "brain", pane_id: "w1:p1" } } };
      }
      const error = new Error("Command failed: herdr target not found");
      attachCliOutput(
        error,
        "",
        JSON.stringify({
          error: { code: "agent_not_found", message: "agent target nonexistent-agent-xyz not found" },
          id: "cli:agent:prompt",
        }),
      );
      throw error;
    }, async (calls) => {
      const matchesCliAgentNotFound = (error: unknown): boolean =>
        error instanceof HerdrLinkError &&
        error.code === "PEER_NOT_FOUND" &&
        error.message.includes("agent target nonexistent-agent-xyz not found");
      await assert.rejects(sendMessage("nonexistent-agent-xyz", "hello"), matchesCliAgentNotFound);
      await assert.rejects(closeAgentPane("nonexistent-agent-xyz"), matchesCliAgentNotFound);
      assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
        ["agent", "get", "self-pane"],
        ["agent", "prompt", "nonexistent-agent-xyz"],
        ["agent", "get", "nonexistent-agent-xyz"],
      ]);
    });
  });
});
