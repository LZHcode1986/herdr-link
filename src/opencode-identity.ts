import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getPaneAgentName, renamePaneAgent } from "./herdr.ts";
import { HerdrLinkError, isValidAgentName } from "./protocol.ts";

interface NameRecords {
  [paneId: string]: string;
}

const HEAL_INTERVAL_MS = 30_000;
const NAME_SUFFIXES = ["", "-2", "-3"] as const;

function stateFilePath(): string {
  const dir =
    process.env.HERDR_LINK_STATE_DIR ??
    path.join(os.homedir(), ".local", "state", "herdr-link");
  return path.join(dir, "opencode-agent-names.json");
}

async function readRecords(): Promise<NameRecords> {
  try {
    const parsed: unknown = JSON.parse(await readFile(stateFilePath(), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const records: NameRecords = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") records[key] = value;
    }
    return records;
  } catch {
    return {};
  }
}

async function writeRecord(paneId: string, name: string): Promise<void> {
  const records = await readRecords();
  records[paneId] = name;
  const file = stateFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

function currentPaneId(): string | undefined {
  return process.env.HERDR_PANE_ID || undefined;
}

function isSelfUnnamed(error: unknown): boolean {
  return error instanceof HerdrLinkError && error.code === "SELF_UNNAMED";
}

function isNameTakenError(error: unknown): boolean {
  return error instanceof HerdrLinkError && error.message.includes("agent_name_taken");
}

async function renameWithFallback(desired: string, pane: string): Promise<string> {
  let lastError: unknown = new HerdrLinkError(
    "SELF_UNNAMED",
    `no valid name candidate derived from "${desired}"`,
  );
  for (const suffix of NAME_SUFFIXES) {
    const candidate = `${desired}${suffix}`;
    if (!isValidAgentName(candidate)) continue;
    try {
      await renamePaneAgent(pane, candidate);
      return candidate;
    } catch (error) {
      lastError = error;
      if (!isNameTakenError(error)) break;
    }
  }
  throw lastError;
}

export async function ensureNamedSelf(): Promise<string> {
  const pane = currentPaneId();
  if (!pane) {
    throw new HerdrLinkError("SELF_UNNAMED", "HERDR_PANE_ID is missing");
  }

  const current = await getPaneAgentName(pane).catch(() => undefined);
  if (current) {
    const records = await readRecords();
    if (records[pane] !== current) {
      await writeRecord(pane, current);
    }
    return current;
  }

  const desired = (await readRecords())[pane];
  if (!desired) {
    throw new HerdrLinkError(
      "SELF_UNNAMED",
      `current Herdr agent has no valid name and no persisted expectation for pane ${pane}`,
    );
  }

  const restored = await renameWithFallback(desired, pane);
  await writeRecord(pane, restored);
  return restored;
}

let healChain: Promise<unknown> = Promise.resolve();

/** Serialized heal: overlapping timer ticks and tool retries must not race renames. */
export function scheduleEnsureNamedSelf(): Promise<string> {
  const next = healChain.then(() => ensureNamedSelf());
  healChain = next.catch(() => {});
  return next;
}

export async function withIdentityHeal<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isSelfUnnamed(error)) throw error;
    await scheduleEnsureNamedSelf();
    return await operation();
  }
}

let healStarted = false;

export function startIdentityHeal(intervalMs: number = HEAL_INTERVAL_MS): void {
  if (healStarted) return;
  healStarted = true;

  void scheduleEnsureNamedSelf().catch(() => {});
  const timer = setInterval(() => {
    void scheduleEnsureNamedSelf().catch(() => {});
  }, intervalMs);
  timer.unref?.();
}
