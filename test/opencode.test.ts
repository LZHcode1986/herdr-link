import { test } from "node:test";
import assert from "node:assert/strict";

import { herdrLinkPlugin } from "../src/opencode.ts";

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
  process.env.HERDR_PANE_ID = "self-pane";
}

test("OpenCode adapter environment gating and hooks", async (t) => {
  const previous = snapshotEnvironment();
  t.after(() => restoreEnvironment(previous));

  await t.test("is a no-op outside Herdr", async () => {
    clearHerdrEnvironment();

    const hooks = await herdrLinkPlugin({} as never);

    assert.deepEqual(hooks, {});
    assert.equal(hooks.tool, undefined);
    assert.equal(hooks["experimental.chat.system.transform"], undefined);
  });

  await t.test("registers the three tools and contract transform in Herdr", async () => {
    setHerdrEnvironment();

    const hooks = await herdrLinkPlugin({} as never);
    const tools = hooks.tool ?? {};

    assert.deepEqual(Object.keys(tools), [
      "herdr_link_peers",
      "herdr_link_send",
      "herdr_link_close",
    ]);
    assert.deepEqual(Object.keys(tools.herdr_link_peers.args), []);
    assert.deepEqual(Object.keys(tools.herdr_link_send.args), ["to", "message", "reply_to"]);
    assert.deepEqual(Object.keys(tools.herdr_link_close.args), ["agent"]);
    const hasSafeParse = (schema: unknown): boolean =>
      typeof (schema as { safeParse?: unknown }).safeParse === "function";
    assert.equal(hasSafeParse(tools.herdr_link_send.args.to), true);
    assert.equal(hasSafeParse(tools.herdr_link_send.args.message), true);
    assert.equal(hasSafeParse(tools.herdr_link_send.args.reply_to), true);
    assert.equal(hasSafeParse(tools.herdr_link_close.args.agent), true);
    const accepts = (schema: unknown, value: unknown): boolean =>
      (schema as { safeParse(input: unknown): { success: boolean } }).safeParse(value).success;
    assert.equal(accepts(tools.herdr_link_send.args.to, "Not-A-Name"), true);
    assert.equal(accepts(tools.herdr_link_send.args.message, ""), true);
    assert.equal(accepts(tools.herdr_link_send.args.reply_to, "hl_bad"), true);
    assert.equal(accepts(tools.herdr_link_close.args.agent, "Not-A-Name"), true);
    assert.equal(typeof hooks["experimental.chat.system.transform"], "function");
  });

  await t.test("transform injects the Communication Contract", async () => {
    setHerdrEnvironment();

    const hooks = await herdrLinkPlugin({} as never);
    const transform = hooks["experimental.chat.system.transform"];
    assert.ok(transform);

    const output = { system: ["base prompt"] } as unknown as Parameters<typeof transform>[1];
    await transform({ model: {} as never }, output);

    const system = output.system as unknown as string[];
    assert.equal(system.length, 2);
    assert.equal(system[0], "base prompt");
    assert.match(system[1] ?? "", /Herdr Link is the standard interoperability channel/);

    await transform({ model: {} as never }, output);
    assert.equal(system.length, 2);
  });
});
