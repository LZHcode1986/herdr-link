import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertHerdrEnvironment,
  attachCliOutput,
  closeAgentPane,
  ensureSelfName,
  getAgentContext,
  getSelf,
  getSelfContext,
  listPeers,
  resetSelfBootstrapForTests,
  resetStartStateForTests,
  runHerdr,
  sendMessage,
  setHerdrRunnerForTests,
  startAgent,
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

interface MockPane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  cwd: string;
}

interface StartTopologyOptions {
  self?: AgentRow;
  anchors?: Record<string, AgentRow>;
  workspaceId?: string;
  initialPanes?: MockPane[];
  /** Injects this many failures at `agent start` before succeeding. */
  startFailures?: number;
  /** Replaces the pane list response used for root-pane resolution. */
  paneListOverride?: (panes: MockPane[]) => unknown;
  /** When set, `tab close` rejects (rollback failure). */
  failTabClose?: boolean;
}

/**
 * Stateful fake of the Herdr topology surface (tab/pane/agent) for start tests.
 * Mirrors the measured CLI shapes: tab create / pane list / pane get / pane
 * split / agent start / tab close / pane close, keyed by the same argv forms
 * herdr.ts emits.
 */
function startTopologyHandler(options: StartTopologyOptions = {}): { handler: MockHandler; state: { panes: MockPane[] } } {
  const workspaceId = options.workspaceId ?? "ws-1";
  const self = options.self ?? { name: "brain", workspace_id: workspaceId, pane_id: "self-pane", agent_status: "idle" };
  const anchors = options.anchors ?? {};
  const panes: MockPane[] = [...(options.initialPanes ?? [])];
  let tabSeq = 0;
  let paneSeq = 0;
  let startFailures = options.startFailures ?? 0;

  function paramAfter(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
  }

  const handler: MockHandler = (_file, args) => {
    if (args[0] === "agent" && args[1] === "get") {
      const key = args[2]!;
      if (key === self.pane_id) return { result: { agent: self } };
      const anchor = anchors[key];
      if (anchor) return { result: { agent: anchor } };
      throw cliError("agent_not_found", `agent target ${key} not found`);
    }
    if (args[0] === "tab" && args[1] === "create") {
      tabSeq += 1;
      paneSeq += 1;
      const tabId = `wS:t${tabSeq}`;
      const paneId = `wS:p${paneSeq}`;
      const rootPane: MockPane = {
        pane_id: paneId,
        tab_id: tabId,
        workspace_id: workspaceId,
        cwd: paramAfter(args, "--cwd") ?? "/launch",
      };
      panes.push(rootPane);
      return {
        result: {
          root_pane: { ...rootPane, focused: false },
          tab: { tab_id: tabId, workspace_id: workspaceId, label: paramAfter(args, "--label"), pane_count: 1 },
        },
        type: "tab_created",
      };
    }
    if (args[0] === "tab" && args[1] === "close") {
      if (options.failTabClose) throw cliError("tab_close_failed", "tab close rejected");
      const tabId = args[2]!;
      const remaining = panes.filter((p) => p.tab_id !== tabId);
      panes.splice(0, panes.length, ...remaining);
      return { result: { type: "ok" } };
    }
    if (args[0] === "pane" && args[1] === "list") {
      if (options.paneListOverride) return options.paneListOverride(panes);
      return { result: { panes: panes.filter((p) => p.workspace_id === workspaceId) } };
    }
    if (args[0] === "pane" && args[1] === "get") {
      const pane = panes.find((p) => p.pane_id === args[2]);
      if (!pane) throw cliError("pane_not_found", `pane ${String(args[2])} not found`);
      return { result: { pane: { ...pane, focused: false } }, type: "pane_info" };
    }
    if (args[0] === "pane" && args[1] === "split") {
      const anchorPane = panes.find((p) => p.pane_id === args[2]);
      if (!anchorPane) throw cliError("pane_not_found", `pane ${String(args[2])} not found`);
      paneSeq += 1;
      const newPane: MockPane = {
        pane_id: `wS:p${paneSeq}`,
        tab_id: anchorPane.tab_id,
        workspace_id: workspaceId,
        cwd: paramAfter(args, "--cwd") ?? anchorPane.cwd,
      };
      panes.push(newPane);
      return { result: { pane: { ...newPane, focused: false } }, type: "pane_info" };
    }
    if (args[0] === "pane" && args[1] === "close") {
      const paneId = args[2]!;
      const index = panes.findIndex((p) => p.pane_id === paneId);
      if (index >= 0) panes.splice(index, 1);
      return { result: { type: "ok" } };
    }
    if (args[0] === "agent" && args[1] === "start") {
      if (startFailures > 0) {
        startFailures -= 1;
        throw cliError("agent_not_ready", "pane is not ready");
      }
      return { result: { accepted: true } };
    }
    throw new Error(`unexpected mock args: ${args.join(" ")}`);
  };

  return { handler, state: { panes } };
}

/** Small config fixture with the placement mandatory in every entry. */
function placementConfig(agents: Record<string, unknown>): string {
  return JSON.stringify({ agents });
}

async function withTempProject(
  config: string | undefined,
  callback: (projectRoot: string) => Promise<void>,
 ): Promise<void> {
  const previousCwd = process.cwd();
  const projectRoot = mkdtempSync(join(tmpdir(), "herdr-link-start-test-"));
  try {
    if (config !== undefined) {
      mkdirSync(join(projectRoot, ".agents"));
      writeFileSync(join(projectRoot, ".agents", "agent_config.json"), config);
    }
    process.chdir(projectRoot);
    await callback(projectRoot);
  } finally {
    process.chdir(previousCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  }
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

      const sent = await sendMessage("worker-a", "hello");
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
      assert.doesNotMatch(wrapperText, /Reply to:/);
      const embedded = JSON.parse(wrapperText.split("\n").at(-1)!) as Record<string, unknown>;
      // Outer wrapper never enters the envelope: minimal herdr-link/1 fields only.
      assert.deepEqual(embedded, {
        protocol: PROTOCOL_ID,
        id: sent.id,
        from: "brain",
        to: "worker-a",
        message: "hello",
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
  await t.test("starts explicitly (no with) by allocating a new tab for the root pane", async () => {
    await withTempProject(undefined, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler();
      await withMock(handler, async (calls) => {
        const receipt = await startAgent({
          name: "worker-01",
          kind: "pi",
          args: ["--model", "model-x", "--thinking", "high"],
        });
        assert.deepEqual(receipt, { status: "started", agent: "worker-01", kind: "pi" });
        // Fresh self context → tab create (focus=false) → fresh pane list → resolved root pane → agent start.
        assert.deepEqual(calls.map((call) => call.args), [
          ["agent", "get", "self-pane"],
          ["tab", "create", "--workspace", "ws-1", "--cwd", process.cwd(), "--no-focus"],
          ["pane", "list", "--workspace", "ws-1"],
          ["agent", "start", "worker-01", "--kind", "pi", "--pane", "wS:p1", "--", "--model", "model-x", "--thinking", "high"],
        ]);
      });
    });
  });

  await t.test("explicit relative cwd resolves against the adapter context directory", async () => {
    await withTempProject(undefined, async (projectRoot) => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler();
      await withMock(handler, async (calls) => {
        const receipt = await startAgent({
          name: "worker-02",
          kind: "pi",
          args: [],
          cwd: "slices/w1",
        });
        assert.deepEqual(receipt, { status: "started", agent: "worker-02", kind: "pi" });
        assert.deepEqual(calls[1]!.args, [
          "tab", "create", "--workspace", "ws-1", "--cwd", `${projectRoot}/slices/w1`, "--no-focus",
        ]);
      });
    });
  });

  await t.test("new-tab launch cwd falls back to the adapter context directory and workspace comes from live self context", async () => {
    await withTempProject(undefined, async (projectRoot) => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler({ workspaceId: "ws-9" });
      await withMock(handler, async (calls) => {
        const receipt = await startAgent({ name: "worker-03", kind: "agy", args: [] });
        assert.deepEqual(receipt, { status: "started", agent: "worker-03", kind: "agy" });
        // Workspace id from the fresh live self record, cwd default = context directory.
        assert.deepEqual(calls[1]!.args, ["tab", "create", "--workspace", "ws-9", "--cwd", projectRoot, "--no-focus"]);
      });
    });
  });

  await t.test("configured new_tab: label is presentation-only, tab created focus-free, receipt has no topology ids", async () => {
    const config = placementConfig({
      "worker": {
        placement: { mode: "new_tab", label: "execute" },
        variants: [{ kind: "pi", args: ["--model", "configured/model"] }],
      },
    });
    await withTempProject(config, async (projectRoot) => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler();
      await withMock(handler, async (calls) => {
        const receipt = await startAgent({ name: "worker-01", config_agent: "worker" });
        assert.deepEqual(receipt, { status: "started", agent: "worker-01", kind: "pi" });
        assert.deepEqual(calls[0]!.args, ["agent", "get", "self-pane"]);
        assert.deepEqual(calls[1]!.args, [
          "tab", "create", "--workspace", "ws-1", "--cwd", projectRoot, "--label", "execute", "--no-focus",
        ]);
        assert.deepEqual(calls[2]!.args, ["pane", "list", "--workspace", "ws-1"]);
        assert.deepEqual(calls[3]!.args, [
          "agent", "start", "worker-01", "--kind", "pi", "--pane", "wS:p1", "--", "--model", "configured/model",
        ]);
      });
    });
  });

  await t.test("accepts the published JSON example through configured new_tab start", async () => {
    const template = readFileSync(new URL("../examples/agent_config.example.json", import.meta.url), "utf8");
    assert.doesNotThrow(() => JSON.parse(template));
    await withTempProject(template, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler();
      await withMock(handler, async (calls) => {
        const receipt = await startAgent({ name: "worker-template", config_agent: "example-single" });
        assert.deepEqual(receipt, { status: "started", agent: "worker-template", kind: "pi" });
        assert.deepEqual(calls.at(-1)!.args, [
          "agent", "start", "worker-template", "--kind", "pi", "--pane", "wS:p1", "--", "--model", "your-provider/your-model", "--thinking", "high",
        ]);
        assert.deepEqual(calls[1]!.args, ["tab", "create", "--workspace", "ws-1", "--cwd", process.cwd(), "--label", "example", "--no-focus"]);
      });
    });
  });

  await t.test("selects configured variants in round-robin order and rereads the JSON", async () => {
    const config = placementConfig({
      "work-agent": {
        placement: { mode: "new_tab" },
        strategy: "round-robin",
        variants: [
          { kind: "pi", args: ["--model", "provider-a/model-a", "--thinking", "high"] },
          { kind: "agy", args: ["--model", "provider-b/model-b", "--effort", "high"] },
        ],
      },
    });
    await withTempProject(config, async (projectRoot) => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler();
      await withMock(handler, async (calls) => {
        for (const name of ["worker-a", "worker-b", "worker-c"]) {
          await startAgent({ name, config_agent: "work-agent" });
        }
        const starts = calls.filter((call) => call.args[0] === "agent" && call.args[1] === "start");
        assert.deepEqual(starts.map((call) => [call.args[2], call.args[4]]), [
          ["worker-a", "pi"],
          ["worker-b", "agy"],
          ["worker-c", "pi"],
        ]);
        // Every configured start reads the current file; no stale JSON cache.
        writeFileSync(
          join(projectRoot, ".agents", "agent_config.json"),
          placementConfig({
            "work-agent": {
              placement: { mode: "new_tab" },
              variants: [{ kind: "codex", args: ["--model", "provider-c/model-c"] }],
            },
          }),
        );
        const receipt = await startAgent({ name: "worker-d", config_agent: "work-agent" });
        assert.deepEqual(receipt, { status: "started", agent: "worker-d", kind: "codex" });
      });
    });
  });

  await t.test("isolates round-robin cursors by config agent and project", async () => {
    const projectAConfig = placementConfig({
      "work-agent": {
        placement: { mode: "new_tab" },
        strategy: "round-robin",
        variants: [
          { kind: "pi", args: ["--model", "project-a/work-a"] },
          { kind: "agy", args: ["--model", "project-a/work-b"] },
        ],
      },
      "review-agent": {
        placement: { mode: "new_tab" },
        strategy: "round-robin",
        variants: [
          { kind: "codex", args: ["--model", "project-a/review-a"] },
          { kind: "pi", args: ["--model", "project-a/review-b"] },
        ],
      },
    });
    const projectBConfig = placementConfig({
      "work-agent": {
        placement: { mode: "new_tab" },
        strategy: "round-robin",
        variants: [
          { kind: "agy", args: ["--model", "project-b/work-a"] },
          { kind: "pi", args: ["--model", "project-b/work-b"] },
        ],
      },
    });
    await withTempProject(projectAConfig, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler();
      await withMock(handler, async (calls) => {
        await startAgent({ name: "a-work-1", config_agent: "work-agent" });
        await startAgent({ name: "a-review-1", config_agent: "review-agent" });
        await startAgent({ name: "a-work-2", config_agent: "work-agent" });
        await withTempProject(projectBConfig, async () => {
          await startAgent({ name: "b-work-1", config_agent: "work-agent" });
          await startAgent({ name: "b-work-2", config_agent: "work-agent" });
        });
        await startAgent({ name: "a-work-3", config_agent: "work-agent" });
        const starts = calls.filter((call) => call.args[0] === "agent" && call.args[1] === "start");
        assert.deepEqual(starts.map((call) => [call.args[2], call.args[4]]), [
          ["a-work-1", "pi"],
          ["a-review-1", "codex"],
          ["a-work-2", "agy"],
          ["b-work-1", "agy"],
          ["b-work-2", "pi"],
          ["a-work-3", "pi"],
        ]);
      });
    });
  });

  await t.test("keeps configured and explicit modes mutually exclusive and fails closed", async () => {
    await withTempProject(undefined, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler();
      await withMock(handler, async (calls) => {
        await assert.rejects(
          startAgent({
            name: "worker-01",
            config_agent: "work-agent",
            kind: "pi",
            args: [],
          } as never),
          matchesCode("START_INPUT_INVALID"),
        );
        await assert.rejects(
          startAgent({ name: "worker-01", kind: "pi" } as never),
          matchesCode("START_INPUT_INVALID"),
        );
        await assert.rejects(
          startAgent({ name: "worker-01", config_agent: "work-agent" }),
          matchesCode("START_CONFIG_NOT_FOUND"),
        );
        assert.equal(calls.length, 0);
      });
    });
  });

  await t.test("rejects unknown configured entries and malformed configuration schemas", async () => {
    const validConfig = placementConfig({
      "work-agent": {
        placement: { mode: "new_tab" },
        variants: [{ kind: "pi" }],
      },
    });
    await withTempProject(validConfig, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler();
      await withMock(handler, async (calls) => {
        await assert.rejects(
          startAgent({ name: "worker-01", config_agent: "missing-agent" }),
          matchesCode("START_AGENT_NOT_FOUND"),
        );
        assert.equal(calls.length, 0);
      });
    });

    const invalidJson = "{ this is not valid json";
    await withTempProject(invalidJson, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler();
      await withMock(handler, async (calls) => {
        await assert.rejects(
          startAgent({ name: "worker-01", config_agent: "work-agent" }),
          matchesCode("START_CONFIG_INVALID"),
        );
        assert.equal(calls.length, 0);
      });
    });
  });

  await t.test("config parser rejects legacy root schema-generation fields, missing/unknown placement", async () => {
    const legacyRoot = JSON.stringify({ version: 1, agents: {} });
    await withTempProject(legacyRoot, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler();
      await withMock(handler, async (calls) => {
        await assert.rejects(
          startAgent({ name: "worker-01", config_agent: "worker" }),
          (error: unknown) => error instanceof HerdrLinkError && error.code === "START_CONFIG_INVALID",
        );
        assert.equal(calls.length, 0);
      });
    });

    const missingPlacement = JSON.stringify({ agents: { "worker": { variants: [{ kind: "pi" }] } } });
    await withTempProject(missingPlacement, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler();
      await withMock(handler, async (calls) => {
        await assert.rejects(
          startAgent({ name: "worker-01", config_agent: "worker" }),
          matchesCode("START_CONFIG_INVALID"),
        );
        assert.equal(calls.length, 0);
      });
    });

    const badMode = JSON.stringify({ agents: { "worker": { placement: { mode: "stacked" }, variants: [{ kind: "pi" }] } } });
    await withTempProject(badMode, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler();
      await withMock(handler, async (calls) => {
        await assert.rejects(
          startAgent({ name: "worker-01", config_agent: "worker" }),
          matchesCode("START_CONFIG_INVALID"),
        );
        assert.equal(calls.length, 0);
      });
    });
  });

  await t.test("config parser rejects placement `with` + label and validates variants unchanged", async () => {
    const withLabel = JSON.stringify({ agents: { "worker": { placement: { mode: "with", label: "x" }, variants: [{ kind: "pi" }] } } });
    await withTempProject(withLabel, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler();
      await withMock(handler, async (calls) => {
        await assert.rejects(
          startAgent({ name: "worker-01", config_agent: "worker" }),
          matchesCode("START_CONFIG_INVALID"),
        );
        assert.equal(calls.length, 0);
      });
    });

    const multiNoStrategy = JSON.stringify({
      agents: { "worker": { placement: { mode: "new_tab" }, variants: [{ kind: "pi" }, { kind: "agy" }] } },
    });
    await withTempProject(multiNoStrategy, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler();
      await withMock(handler, async (calls) => {
        await assert.rejects(
          startAgent({ name: "worker-01", config_agent: "worker" }),
          matchesCode("START_CONFIG_INVALID"),
        );
        assert.equal(calls.length, 0);
      });
    });
  });

  await t.test("input validation enforces the placement matrix before any allocation", async () => {
    const newTabConfig = placementConfig({ "worker": { placement: { mode: "new_tab" }, variants: [{ kind: "pi" }] } });
    await withTempProject(newTabConfig, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler();
      await withMock(handler, async (calls) => {
        // configured new_tab + with → invalid before allocation
        await assert.rejects(
          startAgent({ name: "w", config_agent: "worker", with: "anchor" }),
          matchesCode("START_INPUT_INVALID"),
        );
        // configured new_tab + cwd → valid (optional)
        const ok = await startAgent({ name: "w", config_agent: "worker", cwd: "/abs/worktree" });
        assert.deepEqual(ok.kind, "pi");
        assert.equal(calls.length, 4, "only the valid path reached allocation");
      });
    });

    const withConfig = placementConfig({ "cv": { placement: { mode: "with" }, variants: [{ kind: "pi" }] } });
    await withTempProject(withConfig, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler();
      await withMock(handler, async (calls) => {
        // configured with + cwd → invalid before allocation
        await assert.rejects(
          startAgent({ name: "w", config_agent: "cv", with: "anchor", cwd: "/x" }),
          matchesCode("START_INPUT_INVALID"),
        );
        // configured with + missing with → invalid before allocation
        await assert.rejects(
          startAgent({ name: "w", config_agent: "cv" }),
          matchesCode("START_INPUT_INVALID"),
        );
        assert.equal(calls.length, 0);
      });
    });

    // explicit with + cwd → invalid before allocation
    await withTempProject(undefined, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler();
      await withMock(handler, async (calls) => {
        await assert.rejects(
          startAgent({ name: "w", kind: "pi", args: [], with: "anchor", cwd: "/x" }),
          matchesCode("START_INPUT_INVALID"),
        );
        assert.equal(calls.length, 0);
      });
    });
  });

  await t.test("rejects a raw pane field in start input", async () => {
    await withTempProject(undefined, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler();
      await withMock(handler, async (calls) => {
        await assert.rejects(
          startAgent({ name: "w", kind: "pi", args: [], pane: "wS:p1" } as never),
          matchesCode("START_INPUT_INVALID"),
        );
        assert.equal(calls.length, 0);
      });
    });
  });

  await t.test("with placement: configured `with` splits the anchor pane inheriting its live cwd", async () => {
    const config = placementConfig({ "code-verifier": { placement: { mode: "with" }, variants: [{ kind: "pi", args: ["--model", "cv/model"] }] } });
    await withTempProject(config, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler({
        anchors: { "worker-01": { name: "worker-01", workspace_id: "ws-1", pane_id: "w1:p2", agent_status: "working" } },
        initialPanes: [{ pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "ws-1", cwd: "/worktrees/slice-a" }],
      });
      await withMock(handler, async (calls) => {
        const receipt = await startAgent({ name: "cv-01", config_agent: "code-verifier", with: "worker-01" });
        assert.deepEqual(receipt, { status: "started", agent: "cv-01", kind: "pi" });
        assert.deepEqual(calls.map((call) => call.args), [
          ["agent", "get", "self-pane"],
          ["agent", "get", "worker-01"],
          ["pane", "get", "w1:p2"],
          ["pane", "split", "w1:p2", "--direction", "right", "--cwd", "/worktrees/slice-a", "--no-focus"],
          ["agent", "start", "cv-01", "--kind", "pi", "--pane", "wS:p1", "--", "--model", "cv/model"],
        ]);
      });
    });
  });

  await t.test("with placement: explicit with creates a sibling pane, not a new tab", async () => {
    await withTempProject(undefined, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler({
        anchors: { "worker-01": { name: "worker-01", workspace_id: "ws-1", pane_id: "w1:p2", agent_status: "working" } },
        initialPanes: [{ pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "ws-1", cwd: "/worktrees/slice-a" }],
      });
      await withMock(handler, async (calls) => {
        const receipt = await startAgent({ name: "cv-01", kind: "pi", args: [], with: "worker-01" });
        assert.deepEqual(receipt, { status: "started", agent: "cv-01", kind: "pi" });
        assert.equal(calls.some((call) => call.args[0] === "tab" && call.args[1] === "create"), false);
        assert.deepEqual(calls.at(-2)!.args, ["pane", "split", "w1:p2", "--direction", "right", "--cwd", "/worktrees/slice-a", "--no-focus"]);
      });
    });
  });

  await t.test("with placement: missing/invalid anchor fails before any split", async () => {
    const config = placementConfig({ "cv": { placement: { mode: "with" }, variants: [{ kind: "pi" }] } });
    await withTempProject(config, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler();
      await withMock(handler, async (calls) => {
        await assert.rejects(
          startAgent({ name: "cv-01", config_agent: "cv", with: "ghost" }),
          matchesCode("PEER_NOT_FOUND"),
        );
        assert.equal(calls.some((call) => call.args[0] === "pane" && call.args[1] === "split"), false);
      });
    });
  });

  await t.test("with placement: same-workspace is enforced on both agent and pane records", async () => {
    const config = placementConfig({ "cv": { placement: { mode: "with" }, variants: [{ kind: "pi" }] } });
    await withTempProject(config, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler({
        anchors: { "stranger": { name: "stranger", workspace_id: "ws-2", pane_id: "w2:p1", agent_status: "working" } },
        initialPanes: [{ pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "ws-2", cwd: "/other" }],
      });
      await withMock(handler, async (calls) => {
        // Cross-workspace anchor: agent-record guard rejects before any split.
        await assert.rejects(
          startAgent({ name: "cv-01", config_agent: "cv", with: "stranger" }),
          matchesCode("PEER_NOT_FOUND"),
        );
        assert.equal(calls.some((call) => call.args[0] === "pane" && call.args[1] === "split"), false);
      });
    });
  });

  await t.test("with placement: pane-record workspace mismatch fails closed before any split", async () => {
    const config = placementConfig({ "cv": { placement: { mode: "with" }, variants: [{ kind: "pi" }] } });
    await withTempProject(config, async () => {
      resetStartStateForTests();
      // Anchor agent record matches self workspace (first guard passes); the
      // anchor PANE record reports a different workspace, so the second
      // layer guard must reject before any split.
      const { handler } = startTopologyHandler({
        anchors: { "worker-01": { name: "worker-01", workspace_id: "ws-1", pane_id: "w1:p2", agent_status: "working" } },
        initialPanes: [{ pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "ws-2", cwd: "/other" }],
      });
      await withMock(handler, async (calls) => {
        await assert.rejects(
          startAgent({ name: "cv-01", config_agent: "cv", with: "worker-01" }),
          matchesCode("PEER_NOT_FOUND"),
        );
        assert.equal(calls.some((call) => call.args[0] === "pane" && call.args[1] === "split"), false);
        // The pane was read; the mismatch was detected after the read.
        assert.deepEqual(calls.at(-1)!.args, ["pane", "get", "w1:p2"]);
      });
    });
  });

  await t.test("rollback: new-tab root resolution failure closes the exact created tab", async () => {
    await withTempProject(undefined, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler({
        paneListOverride: (panes) => ({ result: { panes: [...panes, { ...panes[0]!, pane_id: "wS:p9" }] } }),
      });
      await withMock(handler, async (calls) => {
        await assert.rejects(
          startAgent({ name: "w", kind: "pi", args: [] }),
          matchesCode("START_FAILED"),
        );
        assert.deepEqual(calls.at(-1)!.args, ["tab", "close", "wS:t1"]);
      });
    });
  });

  await t.test("rollback: new-tab agent.start failure closes the exact created tab, no retry", async () => {
    await withTempProject(undefined, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler({ startFailures: 1 });
      await withMock(handler, async (calls) => {
        await assert.rejects(
          startAgent({ name: "w", kind: "pi", args: [] }),
          matchesCode("START_FAILED"),
        );
        assert.deepEqual(calls.at(-1)!.args, ["tab", "close", "wS:t1"]);
        assert.equal(calls.filter((call) => call.args[1] === "start").length, 1, "no retry after rollback");
      });
    });
  });

  await t.test("rollback: with-placement agent.start failure closes the exact created sibling pane", async () => {
    await withTempProject(undefined, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler({
        startFailures: 1,
        anchors: { "worker-01": { name: "worker-01", workspace_id: "ws-1", pane_id: "w1:p2", agent_status: "working" } },
        initialPanes: [{ pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "ws-1", cwd: "/worktrees/slice-a" }],
      });
      await withMock(handler, async (calls) => {
        await assert.rejects(
          startAgent({ name: "cv-01", kind: "pi", args: [], with: "worker-01" }),
          matchesCode("START_FAILED"),
        );
        assert.deepEqual(calls.at(-1)!.args, ["pane", "close", "wS:p1"]);
        assert.equal(calls.filter((call) => call.args[1] === "start").length, 1, "no retry after rollback");
      });
    });
  });

  await t.test("rollback failure never replaces the primary error", async () => {
    await withTempProject(undefined, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler({ startFailures: 1, failTabClose: true });
      await withMock(handler, async (calls) => {
        const primary = await startAgent({ name: "w", kind: "pi", args: [] }).then(
          () => null,
          (error: unknown) => error,
        );
        assert.ok(primary instanceof HerdrLinkError);
        assert.equal(primary.code, "START_FAILED");
        assert.equal(calls.filter((call) => call.args[0] === "tab" && call.args[1] === "close").length, 1, "rollback attempt must not be counted against primary");
      });
    });
  });

  await t.test("failed configured start does not advance the round-robin cursor", async () => {
    const config = placementConfig({
      "work-agent": {
        placement: { mode: "new_tab" },
        strategy: "round-robin",
        variants: [
          { kind: "pi", args: ["--model", "provider-a/model-a"] },
          { kind: "agy", args: ["--model", "provider-b/model-b"] },
        ],
      },
    });
    await withTempProject(config, async () => {
      resetStartStateForTests();
      const { handler } = startTopologyHandler({ startFailures: 1 });
      await withMock(handler, async (calls) => {
        await assert.rejects(
          startAgent({ name: "worker-a", config_agent: "work-agent" }),
          matchesCode("START_FAILED"),
        );
        await startAgent({ name: "worker-b", config_agent: "work-agent" });
        const starts = calls.filter((call) => call.args[0] === "agent" && call.args[1] === "start");
        assert.deepEqual(starts.map((call) => call.args[4]), ["pi", "pi"], "failure keeps the cursor on the selected variant");
      });
    });
  });
});
