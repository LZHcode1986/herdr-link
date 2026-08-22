import { execFile } from "node:child_process";
import {
  buildEnvelope,
  HerdrLinkError,
  isValidAgentName,
  type HerdrLinkEnvelope,
  type LinkErrorCode,
  type PeerDirectory,
} from "./protocol.ts";

export interface HerdrCommandOutput {
  stdout: string;
  stderr: string;
}

export type HerdrRunner = (file: string, args: string[]) => Promise<HerdrCommandOutput>;

export function attachCliOutput(error: Error, stdout: string, stderr: string): void {
  Object.assign(error, { stdout, stderr });
}
const defaultHerdrRunner: HerdrRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", shell: false }, (error, stdout, stderr) => {
      if (error) {
        attachCliOutput(error, String(stdout), String(stderr));
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

let herdrRunner: HerdrRunner = defaultHerdrRunner;

/** Replace the process runner in tests; passing undefined restores real execFile IO. */
export function setHerdrRunnerForTests(runner: HerdrRunner | undefined): void {
  herdrRunner = runner ?? defaultHerdrRunner;
}

export function assertHerdrEnvironment(): void {
  if (process.env.HERDR_ENV !== "1") {
    throw new HerdrLinkError("NOT_IN_HERDR", "HERDR_ENV must be 1");
  }
  if (!process.env.HERDR_BIN_PATH) {
    throw new HerdrLinkError("NOT_IN_HERDR", "HERDR_BIN_PATH is missing");
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function errorDetail(error: unknown): string {
  if (error instanceof HerdrLinkError) {
    const prefix = `${error.code}: `;
    return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
  }
  return describeError(error);
}

function operationError(error: unknown, code: LinkErrorCode): HerdrLinkError {
  return new HerdrLinkError(code, errorDetail(error));
}

function isClassifiedHerdrError(error: unknown): error is HerdrLinkError {
  return error instanceof HerdrLinkError && error.code !== "NOT_IN_HERDR";
}

async function runFor(args: string[], failureCode: LinkErrorCode): Promise<unknown> {
  // Keep environment failures as NOT_IN_HERDR instead of translating them into
  // the operation-specific failure code.
  assertHerdrEnvironment();
  try {
    return await runHerdr(args);
  } catch (error) {
    if (isClassifiedHerdrError(error)) throw error;
    throw operationError(error, failureCode);
  }
}

const CLI_ERROR_CODE_MAP: Record<string, LinkErrorCode> = {
  agent_not_found: "PEER_NOT_FOUND",
};

function classifyCliError(error: unknown): HerdrLinkError | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const commandError = error as { stdout?: unknown; stderr?: unknown };

  for (const output of [commandError.stdout, commandError.stderr]) {
    if (typeof output !== "string") continue;

    let payload: unknown;
    try {
      payload = JSON.parse(output);
    } catch {
      continue;
    }

    const errorPayload = asRecord(asRecord(payload)?.error);
    if (!errorPayload) continue;
    const cliCode = errorPayload.code;
    if (typeof cliCode !== "string" || cliCode.length === 0) continue;

    const cliMessage = errorPayload.message;
    const detail = typeof cliMessage === "string" && cliMessage.length > 0 ? `${cliCode}: ${cliMessage}` : cliCode;
    return new HerdrLinkError(CLI_ERROR_CODE_MAP[cliCode] ?? "NOT_IN_HERDR", detail);
  }

  return undefined;
}

export async function runHerdr(args: string[]): Promise<unknown> {
  assertHerdrEnvironment();
  const binary = process.env.HERDR_BIN_PATH;

  try {
    const output = await herdrRunner(binary as string, args);
    return JSON.parse(output.stdout);
  } catch (error) {
    if (error instanceof HerdrLinkError) throw error;
    const cliError = classifyCliError(error);
    if (cliError) throw cliError;
    throw new HerdrLinkError("NOT_IN_HERDR", `Herdr command or JSON response failed: ${describeError(error)}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function agentRecord(value: unknown): Record<string, unknown> | undefined {
  const root = asRecord(value);
  if (!root) return undefined;

  const result = asRecord(root.result);
  const nestedAgent = asRecord(result?.agent) ?? asRecord(root.agent);
  if (nestedAgent) return nestedAgent;

  if (typeof result?.name === "string" || typeof result?.pane_id === "string") return result;
  if (typeof root.name === "string" || typeof root.pane_id === "string") return root;
  return undefined;
}

function agentName(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  const agent = agentRecord(value);
  const name = agent?.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function agentList(value: unknown): unknown[] {
  const root = asRecord(value);
  const result = asRecord(root?.result);
  const agents = result?.agents ?? root?.agents;
  return Array.isArray(agents) ? agents : [];
}

function paneId(value: unknown): string | undefined {
  const agent = agentRecord(value);
  const id = agent?.pane_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export async function getSelf(): Promise<string> {
  assertHerdrEnvironment();
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) {
    throw new HerdrLinkError("SELF_UNNAMED", "HERDR_PANE_ID is missing");
  }

  let response: unknown;
  try {
    response = await runFor(["agent", "get", pane], "SELF_UNNAMED");
  } catch (error) {
    if (error instanceof HerdrLinkError && error.code === "PEER_NOT_FOUND") {
      throw new HerdrLinkError("SELF_UNNAMED", errorDetail(error));
    }
    throw error;
  }
  const name = agentName(response);
  if (!name || !isValidAgentName(name)) {
    throw new HerdrLinkError("SELF_UNNAMED", "current Herdr agent has no valid name");
  }
  return name;
}

export async function listPeers(): Promise<PeerDirectory> {
  const self = await getSelf();
  const response = await runFor(["agent", "list"], "NOT_IN_HERDR");
  const peers = agentList(response)
    .map(agentName)
    .filter((name): name is string => name !== undefined && isValidAgentName(name) && name !== self);

  return { self, peers };
}

export async function sendMessage(
  to: string,
  message: string,
  reply_to?: string,
): Promise<{ status: "sent"; id: string; to: string }> {
  const from = await getSelf();
  const envelope: HerdrLinkEnvelope = buildEnvelope({ from, to, message, reply_to });

  await runFor(["agent", "prompt", to, JSON.stringify(envelope)], "SEND_FAILED");
  return { status: "sent", id: envelope.id, to };
}

export async function closeAgentPane(agentName: string): Promise<{ status: "closed"; agent: string }> {
  assertHerdrEnvironment();
  if (!isValidAgentName(agentName)) {
    throw new HerdrLinkError("PEER_NOT_FOUND", `target agent name "${agentName}" is invalid`);
  }

  const response = await runFor(["agent", "get", agentName], "PEER_NOT_FOUND");
  const pane = paneId(response);
  if (!pane) {
    throw new HerdrLinkError("PEER_NOT_FOUND", `target agent "${agentName}" has no current pane`);
  }

  await runFor(["pane", "close", pane], "CLOSE_FAILED");
  return { status: "closed", agent: agentName };
}
