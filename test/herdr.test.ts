import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertHerdrEnvironment,
  attachCliOutput,
  closeAgentPane,
  ensureSelfName,
  getAgentContext,
  resetSelfBootstrapForTests,
  getSelf,
  getSelfContext,
  listPeers,
  runHerdr,
  sendMessage,
  setHerdrRunnerForTests,
  type HerdrRunner,
} from "../src/herdr.ts";
import {
  INBOUND_WRAPPER_MARKER,
  formatAgentFacingError,
  HerdrLinkError,
  PROTOCOL_ID,
  type LinkErrorCode,
} from "../src/protocol.ts";

interface Call {
  file: string;
  args: string[];
}

type MockHandler = (file: string, args: string[]) => unknown | Promise<unknown>;

interface AgentRow {
  name?: string;
  workspace_id?: string;
  pane_id?: string;
  agent_status?: string;
  live?: boolean;
}

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
  resetSelfBootstrapForTests(); // drop any stale flight born outside this mock

  try {
    await callback(calls);
  } finally {
    setHerdrRunnerForTests(undefined);
    restoreEnv("HERDR_ENV", previous.HERDR_ENV);
    restoreEnv("HERDR_BIN_PATH", previous.HERDR_BIN_PATH);
    restoreEnv("HERDR_PANE_ID", previous.HERDR_PANE_ID);
  }
}

function cliError(code: string, message: string, channel: "stdout" | "stderr" = "stderr"): Error {
  const error = new Error(`Command failed: herdr ${code}`);
  const payload = JSON.stringify({ error: { code, message }, id: "cli:test" });
  if (channel === "stdout") attachCliOutput(error, payload, "");
  else attachCliOutput(error, "", payload);
  return error;
}

/** Fake Herdr CLI keyed by lookup ref (`agent get`) plus optional explicit list rows. */
function directoryHandler(
  directory: Record<string, AgentRow>,
  listRows?: AgentRow[],
): MockHandler {
  return (_file, args) => {
    if (args[0] === "agent" && args[1] === "get") {
      const row = directory[args[2]!];
      if (!row) throw cliError("agent_not_found", `agent target ${String(args[2])} not found`);
      return { result: { agent: row } };
    }
    if (args[0] === "agent" && args[1] === "list") {
      return { result: { agents: listRows ?? Object.values(directory) } };
    }
    if (args[0] === "agent" && args[1] === "prompt") return { result: { accepted: true } };
    if (args[0] === "pane" && args[1] === "close") return { result: { closed: true } };
    throw new Error(`unexpected mock args: ${args.join(" ")}`);
  };
}

function baseDirectory(): Record<string, AgentRow> {
  return {
    "self-pane": { name: "brain", workspace_id: "ws-1", pane_id: "w1:p1", agent_status: "idle" },
    "worker-a": { name: "worker-a", workspace_id: "ws-1", pane_id: "w1:p2", agent_status: "working" },
  };
}

test("Herdr control layer", async (t) => {
  await t.test("resolves live self context fresh on every call and ignores HERDR_WORKSPACE_ID", async () => {
    await withMock(directoryHandler(baseDirectory()), async (calls) => {
      process.env.HERDR_WORKSPACE_ID = "stale-ws";
      try {
        assert.deepEqual(await getSelfContext(), {
          name: "brain",
          workspace_id: "ws-1",
          pane_id: "w1:p1",
          agent_status: "idle",
        });
        assert.equal(await getSelf(), "brain");

        // Every call goes through agent get <HERDR_PANE_ID>; nothing cached.
        const selfGets = calls.filter(
          (call) => call.args[0] === "agent" && call.args[1] === "get" && call.args[2] === "self-pane",
        );
        assert.deepEqual(selfGets.map((call) => call.args.slice(0, 3)), [
          ["agent", "get", "self-pane"],
          ["agent", "get", "self-pane"],
        ]);
      } finally {
        delete process.env.HERDR_WORKSPACE_ID;
      }
    });
  });

  await t.test("lists same-workspace peers with state mapping, delivers the inbound wrapper, closes live panes", async () => {
    const listRows: AgentRow[] = [
      { name: "brain", workspace_id: "ws-1", pane_id: "w1:p1", agent_status: "idle" }, // self -> excluded
      { name: "worker-a", workspace_id: "ws-1", pane_id: "w1:p2", agent_status: "working" },
      { name: "worker_b", workspace_id: "ws-1", pane_id: "w1:p3", agent_status: "blocked" },
      { name: "reviewer", workspace_id: "ws-1", pane_id: "w1:p4", agent_status: "done" },
      { pane_id: "w1:p5" }, // unnamed
      { name: "", workspace_id: "ws-1" }, // empty name
      { name: "Brain", workspace_id: "ws-1", pane_id: "w1:p6" }, // invalid name
      { name: "stranger", workspace_id: "ws-2", pane_id: "w1:p7", agent_status: "blocked" }, // other workspace
      { name: "worker-nows", pane_id: "w1:p8", agent_status: "idle" }, // no workspace reported
      { name: "retired", workspace_id: "ws-1", pane_id: "w1:p9", live: false }, // explicitly not live
      { name: "mystery", workspace_id: "ws-1", pane_id: "w1:p10", agent_status: "on_fire" }, // unmapped status
    ];
    const directory = baseDirectory();
    directory["worker-b-key"] = { name: "worker_b", workspace_id: "ws-1", pane_id: "w1:p3", agent_status: "blocked" };

    await withMock(directoryHandler(directory, listRows), async (calls) => {
      assert.deepEqual(await listPeers(), {
        self: { name: "brain", state: "idle" },
        peers: [
          { name: "worker-a", state: "working" },
          { name: "worker_b", state: "blocked" },
          { name: "reviewer", state: "done" },
          { name: "mystery", state: "unknown" },
        ],
      });

      const sent = await sendMessage("worker-a", "hello", "hl_previous_1");
      assert.equal(sent.status, "sent");
      assert.equal(sent.to, "worker-a");

      const promptCall = calls.find((call) => call.args[0] === "agent" && call.args[1] === "prompt")!;
      assert.deepEqual(promptCall.args.slice(0, 3), ["agent", "prompt", "worker-a"]);
      assert.equal(promptCall.args.length, 4);
      assert.equal(promptCall.args.includes("--wait"), false);

      const wrapperText = promptCall.args[3]!;
      assert.ok(wrapperText.startsWith(INBOUND_WRAPPER_MARKER));
      assert.ok(wrapperText.includes("From: brain"));
      assert.ok(wrapperText.includes(`Message id: ${sent.id}`));
      assert.ok(wrapperText.includes("active Herdr Link send capability"));
      assert.ok(wrapperText.includes("envelope.from"));
      assert.ok(wrapperText.includes("reply_to set to envelope.id"));
      const embedded = JSON.parse(wrapperText.split("\n").at(-1)!) as Record<string, unknown>;
      // Outer wrapper never enters the envelope: minimal herdr-link/1 fields only.
      assert.deepEqual(embedded, {
        protocol: PROTOCOL_ID,
        id: sent.id,
        from: "brain",
        to: "worker-a",
        message: "hello",
        reply_to: "hl_previous_1",
      });

      assert.deepEqual(await closeAgentPane("worker-a"), { status: "closed", agent: "worker-a" });
      assert.deepEqual(calls.map((call) => call.file), Array(8).fill("/mock/herdr"));
      assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
        ["agent", "get", "self-pane"], // peers: resolve self
        ["agent", "list"],
        ["agent", "get", "self-pane"], // send: resolve self
        ["agent", "get", "worker-a"], // send: resolve target
        ["agent", "prompt", "worker-a"],
        ["agent", "get", "self-pane"], // close: resolve self
        ["agent", "get", "worker-a"], // close: resolve target
        ["pane", "close", "w1:p2"], // freshly-read authoritative pane
      ]);
    });
  });

  await t.test("keeps cross-workspace targets invisible with the privacy-preserving peer-not-found wording", async () => {
    const directory = baseDirectory();
    directory["stranger"] = { name: "stranger", workspace_id: "ws-2", pane_id: "w1:p7", agent_status: "blocked" };
    directory["worker-nows"] = { name: "worker-nows", pane_id: "w1:p8", agent_status: "idle" };

    await withMock(directoryHandler(directory), async (calls) => {
      const sendError = await sendMessage("stranger", "hi").then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(sendError instanceof HerdrLinkError);
      assert.equal(sendError.code, "PEER_NOT_FOUND");
      assert.equal(sendError.message, "PEER_NOT_FOUND: target agent is not a live peer");
      assert.equal(formatAgentFacingError(sendError, "SEND_FAILED"), "PEER_NOT_FOUND: target agent is not a live peer");

      await assert.rejects(closeAgentPane("stranger"), matchesCode("PEER_NOT_FOUND"));

      // Unreported workspace fails closed with the same wording.
      const nowsError = await sendMessage("worker-nows", "hi").then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(nowsError instanceof HerdrLinkError && nowsError.code === "PEER_NOT_FOUND");
      assert.equal(nowsError.message, "PEER_NOT_FOUND: target agent is not a live peer");

      // Nothing was delivered and no pane was touched.
      assert.equal(calls.some((call) => call.args[1] === "prompt"), false);
      assert.equal(calls.some((call) => call.args[0] === "pane"), false);
      assert.deepEqual(calls.filter((call) => call.args[2] === "stranger").map((call) => call.args.slice(0, 3)), [
        ["agent", "get", "stranger"],
        ["agent", "get", "stranger"],
      ]);
    });
  });

  await t.test("re-resolves live self workspace after a pane move between workspaces", async () => {
    const directory = baseDirectory();
    directory["stranger"] = { name: "stranger", workspace_id: "ws-2", pane_id: "w1:p7", agent_status: "blocked" };
    const listRows: AgentRow[] = [
      { name: "worker-a", workspace_id: "ws-1", pane_id: "w1:p2", agent_status: "working" },
      { name: "stranger", workspace_id: "ws-2", pane_id: "w1:p7", agent_status: "blocked" },
    ];

    await withMock(directoryHandler(directory, listRows), async () => {
      assert.deepEqual(await listPeers(), {
        self: { name: "brain", state: "idle" },
        peers: [{ name: "worker-a", state: "working" }],
      });

      // The caller pane moves to ws-2; ambient env stays stale and must lose.
      directory["self-pane"]!.workspace_id = "ws-2";
      assert.deepEqual(await getSelfContext(), {
        name: "brain",
        workspace_id: "ws-2",
        pane_id: "w1:p1",
        agent_status: "idle",
      });
      assert.deepEqual(await listPeers(), {
        self: { name: "brain", state: "idle" },
        peers: [{ name: "stranger", state: "blocked" }],
      });
      await assert.rejects(sendMessage("worker-a", "hi"), matchesCode("PEER_NOT_FOUND"));
      assert.equal((await sendMessage("stranger", "hello")).status, "sent");

      // HERDR_WORKSPACE_ID is never authority: live record wins.
      process.env.HERDR_WORKSPACE_ID = "ws-1";
      try {
        assert.equal((await getSelfContext()).workspace_id, "ws-2");
        await assert.rejects(sendMessage("worker-a", "hi"), matchesCode("PEER_NOT_FOUND"));
      } finally {
        delete process.env.HERDR_WORKSPACE_ID;
      }

      // Moving back flips visibility again — proves no caching anywhere.
      directory["self-pane"]!.workspace_id = "ws-1";
      assert.deepEqual((await listPeers()).peers, [{ name: "worker-a", state: "working" }]);
      assert.equal((await sendMessage("worker-a", "back")).status, "sent");
    });
  });

  await t.test("surfaces a stale/deleted Herdr binary as NOT_IN_HERDR instead of SEND_FAILED/CLOSE_FAILED", async () => {
    const previous = {
      env: process.env.HERDR_ENV,
      bin: process.env.HERDR_BIN_PATH,
      pane: process.env.HERDR_PANE_ID,
    };
    process.env.HERDR_ENV = "1";
    process.env.HERDR_BIN_PATH = "/nonexistent-herdr-test-path/no-such-binary";
    process.env.HERDR_PANE_ID = "self-pane";
    setHerdrRunnerForTests(undefined); // exercise real execFile IO
    try {
      await assert.rejects(listPeers(), matchesCode("NOT_IN_HERDR"));
      await assert.rejects(sendMessage("worker-a", "hello"), matchesCode("NOT_IN_HERDR"));
      await assert.rejects(closeAgentPane("worker-a"), matchesCode("NOT_IN_HERDR"));
    } finally {
      setHerdrRunnerForTests(undefined);
      restoreEnv("HERDR_ENV", previous.env);
      restoreEnv("HERDR_BIN_PATH", previous.bin);
      restoreEnv("HERDR_PANE_ID", previous.pane);
    }
  });

  await t.test("passes invalid CLI JSON and transport failures through as NOT_IN_HERDR", async () => {
    await withMock(async (_file, args) => {
      if (args[0] === "agent" && args[1] === "get" && args[2] === "self-pane") {
        return { result: { agent: { name: "brain", workspace_id: "ws-1", pane_id: "w1:p1", agent_status: "idle" } } };
      }
      if (args[0] === "agent" && args[1] === "get" && args[2] === "worker-a") {
        return { result: { agent: { name: "worker-a", workspace_id: "ws-1", pane_id: "w1:p2", agent_status: "working" } } };
      }
      // Invalid CLI JSON at the delivery step: environment-level failure, not SEND_FAILED.
      return "{{{ this is not json";
    }, async () => {
      await assert.rejects(sendMessage("worker-a", "hello"), matchesCode("NOT_IN_HERDR"));
    });

    await withMock(async (_file, args) => {
      if (args[0] === "agent" && args[1] === "get") {
        return args[2] === "self-pane"
          ? { result: { agent: { name: "brain", workspace_id: "ws-1", pane_id: "w1:p1", agent_status: "idle" } } }
          : { result: { agent: { name: "worker-a", workspace_id: "ws-1", pane_id: "w1:p2", agent_status: "working" } } };
      }
      throw new Error("socket hang up"); // transport failure at prompt / pane-close steps
    }, async () => {
      await assert.rejects(sendMessage("worker-a", "hello"), matchesCode("NOT_IN_HERDR"));
      await assert.rejects(closeAgentPane("worker-a"), matchesCode("NOT_IN_HERDR"));
    });
  });

  await t.test("maps Herdr application errors to operation-specific Link codes", async () => {
    for (const code of ["agent_blocked", "agent_not_ready", "agent_prompt_failed"] as const) {
      await withMock(async (_file, args) => {
        if (args[0] === "agent" && args[1] === "get" && args[2] === "self-pane") {
          return { result: { agent: { name: "brain", workspace_id: "ws-1", pane_id: "w1:p1", agent_status: "idle" } } };
        }
        if (args[0] === "agent" && args[1] === "get" && args[2] === "worker-a") {
          return { result: { agent: { name: "worker-a", workspace_id: "ws-1", pane_id: "w1:p2", agent_status: "working" } } };
        }
        if (args[0] === "agent" && args[1] === "prompt") {
          throw cliError(code, `${code}: prompt rejected`);
        }
        return { result: { closed: true } };
      }, async () => {
        await assert.rejects(sendMessage("worker-a", "hello"), matchesCode("SEND_FAILED"));
      });
    }

    await withMock(async (_file, args) => {
      if (args[0] === "agent" && args[1] === "get" && args[2] === "self-pane") {
        return { result: { agent: { name: "brain", workspace_id: "ws-1", pane_id: "w1:p1", agent_status: "idle" } } };
      }
      if (args[0] === "agent" && args[1] === "get" && args[2] === "worker-a") {
        return { result: { agent: { name: "worker-a", workspace_id: "ws-1", pane_id: "w1:p2", agent_status: "working" } } };
      }
      if (args[0] === "pane" && args[1] === "close") {
        throw cliError("pane_close_failed", "pane close rejected");
      }
      return { result: {} };
    }, async () => {
      await assert.rejects(closeAgentPane("worker-a"), matchesCode("CLOSE_FAILED"));
    });
  });

  await t.test("returns NOT_IN_HERDR when the environment is unavailable", async () => {
    await withMock(async () => ({ ok: true }), async (calls) => {
      delete process.env.HERDR_ENV;
      assert.throws(assertHerdrEnvironment, matchesCode("NOT_IN_HERDR"));
      await assert.rejects(runHerdr(["agent", "list"]), matchesCode("NOT_IN_HERDR"));

      process.env.HERDR_ENV = "1";
      delete process.env.HERDR_BIN_PATH;
      await assert.rejects(getSelfContext(), matchesCode("NOT_IN_HERDR"));
      assert.equal(calls.length, 0);
    });
  });

  await t.test("returns SELF_UNNAMED when bootstrap cannot establish a name", async () => {
    await withMock(async (_file, args) => {
      if (args[0] === "agent" && args[1] === "get" && args[2] === "blank-name") {
        return { result: { agent: { workspace_id: "ws-1", pane_id: "w1:pX" } } };
      }
      return { result: { agent: { name: "", workspace_id: "ws-1" } } };
    }, async (calls) => {
      delete process.env.HERDR_PANE_ID;
      await assert.rejects(getSelfContext(), matchesCode("SELF_UNNAMED"));
      assert.equal(calls.length, 0);

      // Live-but-unnamed occupant: the §6.3 bootstrap runs (rename + confirm)
      // and still finds no valid name afterwards → fails closed SELF_UNNAMED.
      // Sequence via the guarded entry: outer probe, flight probe, rename,
      // confirm get (the fallback coalesces onto one rename sequence).
      process.env.HERDR_PANE_ID = "self-pane";
      await assert.rejects(getSelfContext(), matchesCode("SELF_UNNAMED"));
      assert.equal(calls.length, 4);
      assert.deepEqual(calls[2].args.slice(0, 3), ["agent", "rename", "self-pane"]);
      assert.match(String(calls[2].args[3]), /^hl-[0-9a-f]{8}$/);

      // A named-agent lookup against the caller pane keeps SELF_UNNAMED semantics.
      process.env.HERDR_PANE_ID = "blank-name";
      await assert.rejects(getSelfContext(), matchesCode("SELF_UNNAMED"));
      assert.equal(calls.length, 8);
    });
  });

  await t.test("ensureSelfName keeps an existing valid Agent Name untouched", async () => {
    await withMock((_file, args) => {
      if (args[0] === "agent" && args[1] === "get") {
        return { result: { agent: { name: "alice", workspace_id: "ws-1", pane_id: "self-pane", agent_status: "idle" } } };
      }
      return { ok: true };
    }, async (calls) => {
      assert.equal(await ensureSelfName(), "alice");
      // Exactly one probe; no rename is ever issued for a named occupant.
      assert.deepEqual(calls.map((call) => call.args), [["agent", "get", "self-pane"]]);
    });
  });

  await t.test("ensureSelfName names a live-but-unnamed occupant and confirms by re-reading", async () => {
    let liveName = "";
    await withMock(async (_file, args) => {
      if (args[0] === "agent" && args[1] === "rename") {
        liveName = String(args[3]);
        return { ok: true };
      }
      if (args[0] === "agent" && args[1] === "get") {
        return { result: { agent: { name: liveName, workspace_id: "ws-1", pane_id: "self-pane", agent_status: "idle" } } };
      }
      throw new Error(`unexpected CLI call: ${args.join(" ")}`);
    }, async (calls) => {
      const name = await ensureSelfName();
      assert.match(name, /^hl-[0-9a-f]{8}$/);
      assert.equal(name, liveName);
      // Sequence: probe get → rename → confirm get.
      assert.deepEqual(calls.map((call) => call.args[1]), ["get", "rename", "get"]);
      assert.equal(calls[1].args[2], "self-pane");
    });
  });

  await t.test("agent_name_taken regenerates a new name within the bounded budget", async () => {
    let liveName = "";
    let renames = 0;
    await withMock(async (_file, args) => {
      if (args[0] === "agent" && args[1] === "rename") {
        renames += 1;
        if (renames === 1) throw cliError("agent_name_taken", `name ${String(args[3])} already taken`);
        liveName = String(args[3]);
        return { ok: true };
      }
      if (args[0] === "agent" && args[1] === "get") {
        return { result: { agent: { name: liveName, workspace_id: "ws-1", pane_id: "self-pane" } } };
      }
      throw new Error(`unexpected CLI call: ${args.join(" ")}`);
    }, async () => {
      const name = await ensureSelfName();
      assert.equal(renames, 2);
      assert.equal(name, liveName);
      assert.match(name, /^hl-[0-9a-f]{8}$/);
    });
  });

  await t.test("exhausting the collision budget fails closed as SELF_UNNAMED", async () => {
    await withMock((_file, args) => {
      if (args[0] === "agent" && args[1] === "rename") {
        throw cliError("agent_name_taken", `name ${String(args[3])} already taken`);
      }
      return { result: { agent: { name: "", workspace_id: "ws-1", pane_id: "self-pane" } } };
    }, async (calls) => {
      await assert.rejects(ensureSelfName(), matchesCode("SELF_UNNAMED"));
      assert.equal(calls.filter((call) => call.args[1] === "rename").length, 3);
    });
  });

  await t.test("NOT_IN_HERDR keeps its classified code during bootstrap", async () => {
    // Transport failure on the initial probe stays NOT_IN_HERDR (no rename
    // yet) and is never retried: exactly one CLI call, immediate failure.
    await withMock(() => {
      throw new Error("transport down");
    }, async (calls) => {
      await assert.rejects(ensureSelfName(), matchesCode("NOT_IN_HERDR"));
      assert.equal(calls.length, 1);
    });

    // Transport failure on rename likewise passes through un-relabelled.
    let probed = false;
    await withMock((_file, args) => {
      if (!probed && args[1] === "get") {
        probed = true;
        return { result: { agent: { name: "", workspace_id: "ws-1", pane_id: "self-pane" } } };
      }
      throw new Error("binary vanished mid-bootstrap");
    }, async () => {
      await assert.rejects(ensureSelfName(), matchesCode("NOT_IN_HERDR"));
    });
  });

  await t.test("bootstrap failures stay sanitized: no pane ids or CLI diagnostics", async () => {
    await withMock(async (_file, args) => {
      if (args[0] === "agent" && args[1] === "rename") {
        throw cliError("pane_not_found", "no such pane wH:pZ9");
      }
      if (args[0] === "agent" && args[1] === "get") {
        return { result: { agent: { name: "", workspace_id: "ws-1", pane_id: "wH:pZ9" } } };
      }
      throw new Error(`unexpected CLI call: ${args.join(" ")}`);
    }, async () => {
      try {
        await ensureSelfName();
        assert.fail("expected SELF_UNNAMED");
      } catch (error) {
        assert.ok(error instanceof HerdrLinkError);
        assert.equal(error.code, "SELF_UNNAMED");
        assert.equal(error.message, "SELF_UNNAMED: Herdr Link could not establish a stable Agent Name");
        assert.doesNotMatch(error.message, /wH:p|pane_not_found/);
        assert.equal(formatAgentFacingError(error, "SELF_UNNAMED"), error.message);
      }
    });
  });

  await t.test("getSelfContext falls back to bootstrap when the occupant is still unnamed", async () => {
    let liveName = "";
    await withMock(async (_file, args) => {
      if (args[0] === "agent" && args[1] === "rename") {
        liveName = String(args[3]);
        return { ok: true };
      }
      if (args[0] === "agent" && args[1] === "get") {
        return { result: { agent: { name: liveName, workspace_id: "ws-1", pane_id: "self-pane", agent_status: "idle" } } };
      }
      throw new Error(`unexpected CLI call: ${args.join(" ")}`);
    }, async () => {
      // Covers the timing window where adapter-init bootstrap raced Herdr's
      // detection: the first communication call establishes identity itself.
      const context = await getSelfContext();
      assert.match(context.name, /^hl-[0-9a-f]{8}$/);
      assert.equal(context.workspace_id, "ws-1");
    });
  });

  await t.test("readiness retry names the occupant once Herdr detection completes", async () => {
    let liveName = "";
    let probes = 0;
    let renames = 0;
    await withMock(async (_file, args) => {
      if (args[0] === "agent" && args[1] === "rename") {
        renames += 1;
        liveName = String(args[3]);
        return { ok: true };
      }
      if (args[0] === "agent" && args[1] === "get") {
        probes += 1;
        // Detection completes on the third probe: attempts 1-2 are the launch
        // race window (agent_not_found), then Herdr reports the occupant as
        // live-but-unnamed, so the bootstrap sequence can proceed.
        if (probes <= 2) {
          throw cliError("agent_not_found", "agent target self-pane not found");
        }
        return { result: { agent: { name: liveName, workspace_id: "ws-1", pane_id: "self-pane" } } };
      }
      throw new Error(`unexpected CLI call: ${args.join(" ")}`);
    }, async () => {
      const name = await ensureSelfName();
      assert.match(name, /^hl-[0-9a-f]{8}$/);
      assert.equal(name, liveName);
      assert.equal(renames, 1);
      // 2 undetected probes + 1 successful probe + 1 post-rename confirmation.
      assert.equal(probes, 4);
    });
  });

  await t.test("exhausted readiness retry leaves no poisoned state behind", async () => {
    let detected = false;
    let liveName = "";
    let renames = 0;
    await withMock(async (_file, args) => {
      if (args[0] === "agent" && args[1] === "rename") {
        renames += 1;
        liveName = String(args[3]);
        return { ok: true };
      }
      if (args[0] === "agent" && args[1] === "get") {
        if (!detected) throw cliError("agent_not_found", "agent target self-pane not found");
        return { result: { agent: { name: liveName, workspace_id: "ws-1", pane_id: "self-pane", agent_status: "idle" } } };
      }
      throw new Error(`unexpected CLI call: ${args.join(" ")}`);
    }, async () => {
      // Budget exhausted while Herdr still has not detected the occupant.
      await assert.rejects(ensureSelfName(), matchesCode("SELF_UNNAMED"));

      // Detection completes afterwards. The very next communication call must
      // bootstrap cleanly — no failed-flight caching, no poisoned guard state,
      // and no reliance on the earlier startup attempt having succeeded.
      detected = true;
      const context = await getSelfContext();
      assert.match(context.name, /^hl-[0-9a-f]{8}$/);
      assert.equal(context.name, liveName);
      assert.equal(renames, 1);
    });
  });

  await t.test("concurrent ensureSelfName calls coalesce into one rename", async () => {
    let liveName = "";
    let renames = 0;
    await withMock(async (_file, args) => {
      if (args[0] === "agent" && args[1] === "rename") {
        renames += 1;
        liveName = String(args[3]);
        await new Promise((resolve) => setTimeout(resolve, 20)); // overlap window
        return { ok: true };
      }
      if (args[0] === "agent" && args[1] === "get") {
        return { result: { agent: { name: liveName, workspace_id: "ws-1", pane_id: "self-pane" } } };
      }
      throw new Error(`unexpected CLI call: ${args.join(" ")}`);
    }, async () => {
      const [a, b] = await Promise.all([ensureSelfName(), ensureSelfName()]);
      assert.equal(a, b);
      assert.equal(renames, 1);
      assert.match(a, /^hl-[0-9a-f]{8}$/);
    });
  });

  await t.test("startup bootstrap racing a communication fallback renames exactly once", async () => {
    let liveName = "";
    let renames = 0;
    await withMock(async (_file, args) => {
      if (args[0] === "agent" && args[1] === "rename") {
        renames += 1;
        liveName = String(args[3]);
        await new Promise((resolve) => setTimeout(resolve, 20)); // overlap window
        return { ok: true };
      }
      if (args[0] === "agent" && args[1] === "get") {
        return { result: { agent: { name: liveName, workspace_id: "ws-1", pane_id: "self-pane", agent_status: "idle" } } };
      }
      throw new Error(`unexpected CLI call: ${args.join(" ")}`);
    }, async () => {
      const [name, context] = await Promise.all([ensureSelfName(), getSelfContext()]);
      assert.equal(context.name, name);
      assert.equal(renames, 1);
    });
  });

  await t.test("bootstrapped agent becomes discoverable through another agent's peers", async () => {
    let selfPaneName = "";
    await withMock(async (_file, args) => {
      if (args[0] === "agent" && args[1] === "rename") {
        selfPaneName = String(args[3]);
        return { ok: true };
      }
      if (args[0] === "agent" && args[1] === "get") {
        const name = args[2] === "peer-pane" ? "alice" : selfPaneName;
        return {
          result: { agent: { name, workspace_id: "ws-1", pane_id: String(args[2]), agent_status: "idle" } },
        };
      }
      if (args[0] === "agent" && args[1] === "list") {
        return {
          result: {
            agents: [
              { name: "alice", workspace_id: "ws-1", pane_id: "peer-pane", agent_status: "idle" },
              ...(selfPaneName
                ? [{ name: selfPaneName, workspace_id: "ws-1", pane_id: "self-pane", agent_status: "working" }]
                : []),
            ],
          },
        };
      }
      throw new Error(`unexpected CLI call: ${args.join(" ")}`);
    }, async () => {
      // Phase 1: manually launched unnamed agent bootstraps itself.
      process.env.HERDR_PANE_ID = "self-pane";
      const generated = await ensureSelfName();

      // Phase 2: another named agent in the same workspace discovers it.
      process.env.HERDR_PANE_ID = "peer-pane";
      const directory = await listPeers();
      assert.ok(
        directory.peers.some((peer) => peer.name === generated),
        "the generated name must be discoverable by peers",
      );
    });
  });

  await t.test("maps agent_not_found CLI errors on the self pane to SELF_UNNAMED", async () => {
    await withMock(async () => {
      throw cliError("agent_not_found", "agent target self-pane not found");
    }, async (calls) => {
      await assert.rejects(getSelfContext(), matchesCode("SELF_UNNAMED"));
      assert.deepEqual(calls[0]!.args, ["agent", "get", "self-pane"]);
    });
  });

  await t.test("getAgentContext resolves the full live target context", async () => {
    await withMock(directoryHandler(baseDirectory()), async (calls) => {
      assert.deepEqual(await getAgentContext("worker-a"), {
        name: "worker-a",
        workspace_id: "ws-1",
        pane_id: "w1:p2",
        agent_status: "working",
      });
      assert.deepEqual(calls.at(-1)!.args.slice(0, 3), ["agent", "get", "worker-a"]);

      await assert.rejects(getAgentContext("ghost"), matchesCode("PEER_NOT_FOUND"));
    });

    await withMock(directoryHandler(baseDirectory()), async (calls) => {
      // Invalid names short-circuit without touching Herdr.
      await assert.rejects(getAgentContext("Brain"), matchesCode("PEER_NOT_FOUND"));
      assert.equal(calls.length, 0);
    });
  });

  await t.test("classifies model-input validation failures as SEND_FAILED without delivering", async () => {
    await withMock(directoryHandler(baseDirectory()), async (calls) => {
      await assert.rejects(sendMessage("worker-a", "   "), matchesCode("SEND_FAILED"));
      await assert.rejects(sendMessage("worker-a", "hello", "hl_bad"), matchesCode("SEND_FAILED"));
      assert.equal(calls.some((call) => call.args[1] === "prompt"), false);
    });
  });

  await t.test("maps agent_not_found target lookups to PEER_NOT_FOUND for send and close", async () => {
    await withMock(directoryHandler(baseDirectory()), async (calls) => {
      const matchesCliNotFound = (error: unknown): boolean =>
        error instanceof HerdrLinkError &&
        error.code === "PEER_NOT_FOUND" &&
        error.message.includes("agent target ghost not found");
      await assert.rejects(sendMessage("ghost", "hello"), matchesCliNotFound);
      await assert.rejects(closeAgentPane("ghost"), matchesCliNotFound);
      assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
        ["agent", "get", "self-pane"],
        ["agent", "get", "ghost"],
        ["agent", "get", "self-pane"],
        ["agent", "get", "ghost"],
      ]);
      assert.equal(calls.some((call) => call.args[1] === "prompt" || call.args[0] === "pane"), false);
    });

    await withMock(async (_file, args) => {
      if (args[0] === "agent" && args[1] === "get" && args[2] === "self-pane") {
        return { result: { agent: { name: "brain", workspace_id: "ws-1", pane_id: "w1:p1", agent_status: "idle" } } };
      }
      throw cliError("agent_not_found", "agent target ghost not found", "stdout");
    }, async () => {
      await assert.rejects(sendMessage("ghost", "hello"), matchesCode("PEER_NOT_FOUND"));
      await assert.rejects(closeAgentPane("ghost"), matchesCode("PEER_NOT_FOUND"));
    });
  });

  await t.test("closes whatever pane id the live record currently reports", async () => {
    const directory = baseDirectory();
    await withMock(directoryHandler(directory), async (calls) => {
      assert.deepEqual(await closeAgentPane("worker-a"), { status: "closed", agent: "worker-a" });
      directory["worker-a"]!.pane_id = "w9:p9"; // pane moved between calls
      assert.deepEqual(await closeAgentPane("worker-a"), { status: "closed", agent: "worker-a" });

      const closeCalls = calls.filter((call) => call.args[0] === "pane");
      assert.deepEqual(closeCalls.map((call) => call.args), [
        ["pane", "close", "w1:p2"],
        ["pane", "close", "w9:p9"],
      ]);
    });
  });
  await t.test("close only needs the caller workspace, not a caller Agent Name", async () => {
    const directory = baseDirectory();
    delete directory["self-pane"]!.name;
    await withMock(directoryHandler(directory), async (calls) => {
      assert.deepEqual(await closeAgentPane("worker-a"), { status: "closed", agent: "worker-a" });
      assert.deepEqual(calls.map((call) => call.args), [
        ["agent", "get", "self-pane"],
        ["agent", "get", "worker-a"],
        ["pane", "close", "w1:p2"],
      ]);
    });
  });
});
