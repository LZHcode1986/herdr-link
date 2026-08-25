#!/usr/bin/env node
/**
 * Herdr plugin action runner for the herdr-link plugin manifest.
 *
 * Zero-dependency Node script. Actions are operator-facing diagnostics only;
 * they never touch the Agent-facing Link protocol surface and only call
 * read-only Herdr CLI verbs (agent get / agent list) through argv arrays.
 */
import { execFile } from "node:child_process";

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";

function run(args) {
  return new Promise((resolve) => {
    execFile(herdr, args, { encoding: "utf8", shell: false }, (error, stdout, stderr) => {
      if (error && !stdout) {
        resolve({ ok: false, detail: String(stderr || error.message).trim() });
        return;
      }
      try {
        resolve({ ok: true, data: JSON.parse(stdout) });
      } catch {
        resolve({ ok: false, detail: "non-JSON CLI response" });
      }
    });
  });
}

function record(name, ok, detail) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function doctor() {
  console.log("herdr-link doctor");
  console.log("=================");
  let allOk = true;

  allOk &= record(
    "HERDR environment",
    process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_BIN_PATH),
    process.env.HERDR_ENV === "1" ? `bin=${process.env.HERDR_BIN_PATH ?? "(missing)"}` : "HERDR_ENV!=1 or HERDR_BIN_PATH missing",
  );

  const pane = process.env.HERDR_PANE_ID;
  allOk &= record("Caller pane (HERDR_PANE_ID)", Boolean(pane), pane ?? "missing");

  if (!pane) {
    console.log("\nRun inside a Herdr-managed pane to inspect identity and peers.");
    process.exit(allOk ? 0 : 1);
  }

  const self = await run(["agent", "get", pane]);
  if (self.ok) {
    const agent = self.data?.result?.agent ?? {};
    const named = typeof agent.name === "string" && agent.name.length > 0;
    allOk &= record(
      "Self live identity",
      Boolean(agent.workspace_id),
      named
        ? `name=${agent.name} workspace=${agent.workspace_id} status=${agent.agent_status ?? "?"}`
        : `unnamed occupant on ${pane} (Link will bootstrap it on first communication call)`,
    );

    if (named && agent.workspace_id) {
      const list = await run(["agent", "list"]);
      if (list.ok) {
        const peers = (list.data?.result?.agents ?? []).filter(
          (a) => a.name && a.name !== agent.name && a.workspace_id === agent.workspace_id,
        );
        allOk &= record(
          "Same-workspace named peers",
          true,
          peers.length === 0 ? "none yet" : peers.map((p) => `${p.name}(${p.pane_id})`).join(", "),
        );
        allOk &= record(
          "Link readiness",
          true,
          `addressable as "${agent.name}" from every peer's herdr_link_peers`,
        );
      } else {
        allOk &= record("Same-workspace named peers", false, list.detail);
      }
    }
  } else {
    allOk &= record("Self live identity", false, `${self.detail} — occupant not detected yet or not a Herdr pane`);
  }

  console.log(`\nResult: ${allOk ? "OK" : "PROBLEMS FOUND"}`);
  process.exit(allOk ? 0 : 1);
}

const action = process.argv[2] ?? "";
if (action === "doctor") {
  doctor();
} else {
  console.error(`unknown action "${action}"; expected: doctor`);
  process.exit(2);
}
