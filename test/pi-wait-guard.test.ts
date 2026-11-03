import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piWaitGuard from "../src/pi-wait-guard.ts";

const HERDR_ENV_KEYS = ["HERDR_ENV", "HERDR_BIN_PATH", "HERDR_PANE_ID"] as const;

type EnvSnapshot = Record<(typeof HERDR_ENV_KEYS)[number], string | undefined>;

function snapshotEnv(): EnvSnapshot {
  return Object.fromEntries(HERDR_ENV_KEYS.map((name) => [name, process.env[name]])) as EnvSnapshot;
}

function restoreEnv(previous: EnvSnapshot): void {
  for (const name of HERDR_ENV_KEYS) {
    const value = previous[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function useHerdrEnv(): void {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_BIN_PATH = "/mock/herdr";
  process.env.HERDR_PANE_ID = "self-pane";
}

type Handler = (event: unknown) => unknown;

function fakePi(): { pi: ExtensionAPI; dispatch: (event: unknown) => unknown } {
  const handlers = new Map<string, Handler>();
  const pi = {
    on(event: string, handler: Handler): void {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    dispatch(event: unknown): unknown {
      return handlers.get("tool_call")?.(event);
    },
  };
}

function bashCall(command: string): unknown {
  return { type: "tool_call", toolName: "bash", input: { command } };
}

test("Pi wait guard", async (t) => {
  const previous = snapshotEnv();
  t.after(() => restoreEnv(previous));

  await t.test("is a no-op outside a Herdr environment", () => {
    for (const name of HERDR_ENV_KEYS) delete process.env[name];
    const first = fakePi();
    piWaitGuard(first.pi);
    assert.equal(first.dispatch(bashCall("herdr agent wait peer")), undefined);

    process.env.HERDR_ENV = "1";
    const second = fakePi();
    piWaitGuard(second.pi);
    assert.equal(second.dispatch(bashCall("herdr agent wait peer")), undefined);
  });

  await t.test("blocks herdr agent wait and terminates the turn", () => {
    useHerdrEnv();
    const { pi, dispatch } = fakePi();
    piWaitGuard(pi);

    assert.deepEqual(dispatch(bashCall("herdr agent wait worker-a")), {
      block: true,
      reason: "Wait disabled by Herdr Link. End this turn; resume on the inbound Link message.",
      terminate: true,
    });
  });

  await t.test("blocks herdr agent prompt with --wait without terminating", () => {
    useHerdrEnv();
    const { pi, dispatch } = fakePi();
    piWaitGuard(pi);

    assert.deepEqual(dispatch(bashCall("herdr agent prompt worker-a hello --wait")), {
      block: true,
      reason: "Use herdr_link_send for agent messages.",
    });
  });

  await t.test("leaves ordinary Bash and non-Bash tools untouched", () => {
    useHerdrEnv();
    const { pi, dispatch } = fakePi();
    piWaitGuard(pi);

    assert.equal(dispatch(bashCall("herdr agent list")), undefined);
    assert.equal(dispatch(bashCall("herdr agent prompt worker-a hello")), undefined);
    assert.equal(dispatch(bashCall("echo herdr-agent-wait")), undefined);
    assert.equal(dispatch({ type: "tool_call", toolName: "read", input: { path: "x" } }), undefined);
  });
});
