import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { herdrLinkV2Plugin } from "../src/opencode-v2.ts";
import { setHerdrRunnerForTests } from "../src/herdr.ts";
import { COMMUNICATION_CONTRACT } from "../src/protocol.ts";

const envKeys = ["HERDR_ENV", "HERDR_BIN_PATH", "HERDR_PANE_ID"] as const;
const original = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

const SESSION_DIRECTORY = "/tmp/herdr-session-project";

type Tool = {
  name: string;
  description: string;
  input: { properties: Record<string, unknown>; additionalProperties: boolean };
  execute(input: unknown, ctx: { sessionID: string }): Promise<{ content?: string }>;
};
type ContextEvent = { sessionID: string; system: Array<{ type: string; text: string }> };
type Pane = { pane_id: string; cwd?: string; foreground_cwd?: string };

function harness(
  options: {
    sessionDirectory?: string;
    sessionError?: boolean;
    panes?: Pane[];
    pluginDirectory?: string;
  } = {},
) {
  const sessionDirectory = options.sessionDirectory ?? SESSION_DIRECTORY;
  const tools: Tool[] = [];
  const hooks: Record<string, (event: ContextEvent) => Promise<void> | void> = {};
  const ctx = {
    location: { directory: options.pluginDirectory ?? "/tmp/herdr-plugin-location" },
    tool: {
      async transform(callback: (editor: { add: (value: Tool) => void }) => void) {
        callback({ add: (tool) => tools.push(tool) });
      },
    },
    session: {
      async get(_input: { sessionID: string }) {
        if (options.sessionError) throw new Error("session lookup failed");
        return { id: "session", location: { directory: sessionDirectory } };
      },
      async hook(name: string, callback: (event: ContextEvent) => Promise<void> | void) {
        hooks[name] = callback;
      },
    },
  };
  const panes = options.panes ?? [{ pane_id: "self", cwd: sessionDirectory }];
  return { ctx, tools, hooks, panes, sessionDirectory };
}

const closedPanes: string[] = [];

function activateEnv(panes: Pane[]) {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_BIN_PATH = "/mock/herdr";
  process.env.HERDR_PANE_ID = "self";
  setHerdrRunnerForTests(async (_file, args) => {
    if (args[0] === "agent" && args[1] === "get") {
      const requested = String(args[2]);
      return {
        stdout: JSON.stringify({
          result: {
            name: requested,
            workspace_id: "ws-1",
            pane_id: requested === "self" ? "self" : `pane-${requested}`,
            agent_status: "working",
          },
        }),
        stderr: "",
      };
    }
    if (args[0] === "agent" && args[1] === "list") {
      return { stdout: JSON.stringify({ result: { agents: [{ name: "peer", workspace_id: "ws-1", pane_id: "peer-1" }] } }), stderr: "" };
    }
    if (args[0] === "pane" && args[1] === "list") {
      return { stdout: JSON.stringify({ result: { panes: panes.map((pane) => ({ workspace_id: "ws-1", ...pane })) } }), stderr: "" };
    }
    if (args[0] === "pane" && args[1] === "close") {
      closedPanes.push(String(args[2]));
      return { stdout: JSON.stringify({ result: { closed: true } }), stderr: "" };
    }
    throw new Error("unexpected mocked Herdr command " + args.join(" "));
  });
}

function cleanup() {
  setHerdrRunnerForTests(undefined);
  closedPanes.length = 0;
  for (const key of envKeys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
}

test("OpenCode 2 plugin is inert outside a Herdr-managed pane", async (t) => {
  t.after(cleanup);
  for (const key of envKeys) delete process.env[key];
  const fixture = harness();
  await herdrLinkV2Plugin.setup(fixture.ctx as never);
  assert.equal(herdrLinkV2Plugin.id, "herdr-link");
  assert.deepEqual(fixture.tools, []);
  assert.deepEqual(fixture.hooks, {});
});

test("OpenCode 2 registers one gateway and injects context only for activated sessions", async (t) => {
  t.after(cleanup);
  const fixture = harness();
  activateEnv(fixture.panes);
  await herdrLinkV2Plugin.setup(fixture.ctx as never);
  assert.equal(fixture.tools.length, 1);
  const gateway = fixture.tools[0]!;
  assert.equal(gateway.name, "herdr_link");
  assert.match(gateway.description, /only when the user explicitly asks/);
  assert.deepEqual(Object.keys(gateway.input.properties), ["action", "to", "message", "agent", "name", "with", "cwd", "config_agent", "kind", "args"]);
  assert.equal(gateway.input.additionalProperties, false);
  assert.equal(typeof fixture.hooks.context, "function");

  const dormant: ContextEvent = { sessionID: "session-b", system: [{ type: "text", text: "base" }] };
  await fixture.hooks.context!(dormant);
  assert.equal(dormant.system.length, 1);

  const first = await gateway.execute({}, { sessionID: "session-a" });
  assert.deepEqual(JSON.parse(first.content ?? ""), { status: "active", capabilities: ["start", "peers", "send", "close"] });
  const active: ContextEvent = { sessionID: "session-a", system: [{ type: "text", text: "base" }] };
  await fixture.hooks.context!(active);
  await fixture.hooks.context!(active);
  assert.equal(active.system.length, 2);
  assert.ok(active.system[1]!.text.startsWith(COMMUNICATION_CONTRACT));
  assert.match(active.system[1]!.text, /single herdr_link gateway/);
  await fixture.hooks.context!(dormant);
  assert.equal(dormant.system.length, 1);

  const peers = await gateway.execute({ action: "peers" }, { sessionID: "session-a" });
  const data = JSON.parse(peers.content ?? "{}");
  assert.equal(data.self.name, "self");
  assert.deepEqual(data.peers.map((p: { name: string }) => p.name), ["peer"]);
  await assert.rejects(() => gateway.execute({ action: "send", to: "peer" }, { sessionID: "session-a" }), /SEND_FAILED:.*message/);
});

test("OpenCode 2 close returns the canonical receipt and closes the resolved pane", async (t) => {
  t.after(cleanup);
  const fixture = harness();
  activateEnv(fixture.panes);
  await herdrLinkV2Plugin.setup(fixture.ctx as never);
  const gateway = fixture.tools[0]!;
  const closed = await gateway.execute({ action: "close", agent: "peer" }, { sessionID: "session-a" });
  assert.deepEqual(JSON.parse(closed.content ?? ""), { status: "closed", agent: "peer" });
  assert.deepEqual(closedPanes, ["pane-peer"]);
});

test("OpenCode 2 fails closed when the session cannot be attributed to a unique pane", async (t) => {
  t.after(cleanup);

  // The session directory matches no pane in the caller's workspace.
  const unmatched = harness({ panes: [{ pane_id: "self", cwd: "/tmp/herdr-other-project" }] });
  activateEnv(unmatched.panes);
  await herdrLinkV2Plugin.setup(unmatched.ctx as never);
  await assert.rejects(() => unmatched.tools[0]!.execute({ action: "peers" }, { sessionID: "session-a" }), /SELF_UNNAMED/);

  // Two panes share the same project directory: attribution is ambiguous.
  cleanup();
  const ambiguous = harness({
    panes: [
      { pane_id: "self", cwd: SESSION_DIRECTORY },
      { pane_id: "other", cwd: SESSION_DIRECTORY },
    ],
  });
  activateEnv(ambiguous.panes);
  await herdrLinkV2Plugin.setup(ambiguous.ctx as never);
  await assert.rejects(() => ambiguous.tools[0]!.execute({ action: "peers" }, { sessionID: "session-a" }), /SELF_UNNAMED/);

  // The session API itself fails: no fallback to the plugin location.
  cleanup();
  const unavailable = harness({ sessionError: true });
  activateEnv(unavailable.panes);
  await herdrLinkV2Plugin.setup(unavailable.ctx as never);
  await assert.rejects(() => unavailable.tools[0]!.execute({ action: "start", name: "worker", kind: "pi", args: [] }, { sessionID: "session-a" }), /SELF_UNNAMED/);
});

test("OpenCode 2 resolves configured start from the session directory, not the plugin location", async (t) => {
  t.after(cleanup);
  const pluginDirectory = mkdtempSync(join(tmpdir(), "herdr-plugin-location-"));
  const sessionDirectory = mkdtempSync(join(tmpdir(), "herdr-session-project-"));
  t.after(() => rmSync(pluginDirectory, { recursive: true, force: true }));
  t.after(() => rmSync(sessionDirectory, { recursive: true, force: true }));

  // A valid configuration exists only under the plugin location; the session
  // directory stays empty. START_CONFIG_NOT_FOUND therefore proves the lookup
  // used the session directory.
  const pluginConfigDirectory = join(pluginDirectory, ".agents");
  mkdirSync(pluginConfigDirectory, { recursive: true });
  writeFileSync(
    join(pluginConfigDirectory, "agent_config.json"),
    JSON.stringify({ agents: { helper: { placement: { mode: "new_tab" }, variants: [{ kind: "pi", args: [] }] } } }),
  );

  const fixture = harness({ sessionDirectory, pluginDirectory, panes: [{ pane_id: "self", cwd: sessionDirectory }] });
  activateEnv(fixture.panes);
  await herdrLinkV2Plugin.setup(fixture.ctx as never);
  await assert.rejects(
    () => fixture.tools[0]!.execute({ action: "start", name: "worker", config_agent: "helper" }, { sessionID: "session-a" }),
    /START_CONFIG_NOT_FOUND/,
  );
});
