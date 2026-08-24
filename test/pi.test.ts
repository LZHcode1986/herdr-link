import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piExtension from "../src/pi.ts";

type RegisteredTool = {
  name: string;
  executionMode?: string;
  parameters?: { properties?: Record<string, unknown> };
};

const HERDR_ENV_KEYS = ["HERDR_ENV", "HERDR_BIN_PATH", "HERDR_PANE_ID"] as const;

function restoreEnv(previous: Record<(typeof HERDR_ENV_KEYS)[number], string | undefined>): void {
  for (const name of HERDR_ENV_KEYS) {
    const value = previous[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function fakePi(): {
  pi: ExtensionAPI;
  events: string[];
  tools: RegisteredTool[];
} {
  const events: string[] = [];
  const tools: RegisteredTool[] = [];
  const pi = {
    on(event: string, _handler: unknown): void {
      events.push(event);
    },
    registerTool(tool: RegisteredTool): void {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  return { pi, events, tools };
}

test("Pi adapter environment gating and registration", async (t) => {
  const previous = Object.fromEntries(
    HERDR_ENV_KEYS.map((name) => [name, process.env[name]]),
  ) as Record<(typeof HERDR_ENV_KEYS)[number], string | undefined>;
  t.after(() => restoreEnv(previous));

  await t.test("is a no-op when the Herdr environment is missing", () => {
    for (const name of HERDR_ENV_KEYS) delete process.env[name];
    const { pi, events, tools } = fakePi();

    piExtension(pi);

    assert.deepEqual(events, []);
    assert.deepEqual(tools, []);
  });

  await t.test("registers the three tools and the prompt hook in Herdr", () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_BIN_PATH = "/mock/herdr";
    process.env.HERDR_PANE_ID = "self-pane";
    const { pi, events, tools } = fakePi();

    piExtension(pi);

    assert.deepEqual(tools.map((tool) => tool.name), [
      "herdr_link_peers",
      "herdr_link_send",
      "herdr_link_close",
    ]);
    assert.deepEqual(events, ["before_agent_start"]);
    // close 声明 sequential：含 close 的 sibling batch 整体串行，保证 send 先于 close 完成；
    // peers/send 保持默认（parallel）。
    const closeTool = tools.find((tool) => tool.name === "herdr_link_close");
    assert.equal(closeTool?.executionMode, "sequential");
    for (const tool of tools) {
      if (tool.name !== "herdr_link_close") assert.equal(tool.executionMode, undefined);
    }
    const sendTool = tools.find((tool) => tool.name === "herdr_link_send");
    const sendProperties = sendTool?.parameters?.properties ?? {};
    const closeProperties = closeTool?.parameters?.properties ?? {};
    const assertBasicString = (schema: unknown): void => {
      const value = schema as Record<string, unknown>;
      assert.equal(value.type, "string");
      assert.equal(value.pattern, undefined);
      assert.equal(value.minLength, undefined);
    };
    assertBasicString(sendProperties.to);
    assertBasicString(sendProperties.message);
    assertBasicString(sendProperties.reply_to);
    assertBasicString(closeProperties.agent);
  });
});
