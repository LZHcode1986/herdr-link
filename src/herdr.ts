import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  AGENT_ERROR_DETAILS,
  buildEnvelope,
  buildInboundWrapper,
  HerdrLinkError,
  isValidAgentName,
  toAgentState,
  type AgentContext,
  type HerdrLinkEnvelope,
  type LinkErrorCode,
  type PeerDirectory,
  type PeerInfo,
  type StartAgentInput,
  type StartAgentReceipt,
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

/** Structured Herdr CLI application rejection; operation adapters map it to their stable code. */
class HerdrCliError extends Error {
  readonly cliCode: string;

  constructor(cliCode: string, detail: string) {
    super(detail);
    this.name = "HerdrCliError";
    this.cliCode = cliCode;
  }
}

async function runFor(args: string[], failureCode: LinkErrorCode): Promise<unknown> {
  assertHerdrEnvironment();
  try {
    return await runHerdr(args);
  } catch (error) {
    if (error instanceof HerdrCliError) throw operationError(error, failureCode);
    // Already-classified Link errors, including NOT_IN_HERDR, pass through
    // without being re-labelled by the operation-specific fallback code.
    if (error instanceof HerdrLinkError) throw error;
    throw operationError(error, failureCode);
  }
}

interface ValidatedStartVariant {
  kind: string;
  args: string[];
}

interface ConfiguredStartAgent {
  strategy?: "round-robin";
  variants: ValidatedStartVariant[];
}

const startCursors = new Map<string, number>();
const startLocks = new Map<string, Promise<void>>();
const START_CONFIG_PATH_PARTS = [".agents", "agent_config.json"] as const;
const START_INPUT_KEYS = new Set(["name", "pane", "config_agent", "kind", "args"]);

/** @internal Test seam only: clears process-local configured-start state. */
export function resetStartStateForTests(): void {
  startCursors.clear();
  startLocks.clear();
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function startInputError(detail: string): HerdrLinkError {
  return new HerdrLinkError("START_INPUT_INVALID", detail);
}

function startConfigError(
  code: "START_CONFIG_NOT_FOUND" | "START_AGENT_NOT_FOUND" | "START_CONFIG_INVALID",
  detail: string,
): HerdrLinkError {
  return new HerdrLinkError(code, detail);
}

function validateStartInput(input: unknown):
  | { mode: "configured"; name: string; pane: string; configAgent: string }
  | { mode: "explicit"; name: string; pane: string; variant: ValidatedStartVariant } {
  const value = asRecord(input);
  if (!value) throw startInputError("start input must be an object");
  for (const key of Object.keys(value)) {
    if (!START_INPUT_KEYS.has(key)) throw startInputError(`unknown start field "${key}"`);
  }

  const name = value.name;
  if (typeof name !== "string" || !isValidAgentName(name)) {
    throw startInputError("\"name\" must be a valid Herdr Agent Name");
  }
  const pane = value.pane;
  if (typeof pane !== "string" || pane.trim() === "") {
    throw startInputError("\"pane\" must be a non-empty pane id");
  }

  const hasConfigAgent = hasOwn(value, "config_agent");
  const hasKind = hasOwn(value, "kind");
  const hasArgs = hasOwn(value, "args");
  if (hasConfigAgent && (hasKind || hasArgs)) {
    throw startInputError("config_agent cannot be combined with kind or args");
  }
  if (hasConfigAgent) {
    const configAgent = value.config_agent;
    if (typeof configAgent !== "string" || configAgent.trim() === "") {
      throw startInputError("\"config_agent\" must be a non-empty string");
    }
    return { mode: "configured", name, pane, configAgent };
  }

  if (!hasKind || !hasArgs) {
    throw startInputError("explicit start requires both kind and args");
  }
  const kind = value.kind;
  if (typeof kind !== "string" || kind.trim() === "") {
    throw startInputError("\"kind\" must be a non-empty string");
  }
  const args = value.args;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw startInputError("\"args\" must be an array of strings");
  }
  return { mode: "explicit", name, pane, variant: { kind, args: [...args] } };
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw startConfigError("START_CONFIG_INVALID", `${label} contains unknown field "${key}"`);
  }
}

function validateConfiguredDocument(document: unknown): Map<string, ConfiguredStartAgent> {
  const root = asRecord(document);
  if (!root) throw startConfigError("START_CONFIG_INVALID", "configuration root must be an object");
  assertAllowedKeys(root, ["version", "agents"], "configuration root");
  if (root.version !== 1) throw startConfigError("START_CONFIG_INVALID", "configuration version must be 1");

  const agents = asRecord(root.agents);
  if (!agents) throw startConfigError("START_CONFIG_INVALID", "agents must be an object");

  const result = new Map<string, ConfiguredStartAgent>();
  for (const [configAgent, rawEntry] of Object.entries(agents)) {
    if (configAgent.trim() === "") {
      throw startConfigError("START_CONFIG_INVALID", "agents contains an empty configuration key");
    }
    const entry = asRecord(rawEntry);
    if (!entry) throw startConfigError("START_CONFIG_INVALID", `agents.${configAgent} must be an object`);
    assertAllowedKeys(entry, ["strategy", "variants"], `agents.${configAgent}`);

    const rawVariants = entry.variants;
    if (!Array.isArray(rawVariants) || rawVariants.length === 0) {
      throw startConfigError("START_CONFIG_INVALID", `agents.${configAgent}.variants must be non-empty`);
    }
    const hasStrategy = hasOwn(entry, "strategy");
    if (hasStrategy && entry.strategy !== "round-robin") {
      throw startConfigError("START_CONFIG_INVALID", `agents.${configAgent}.strategy is unsupported`);
    }
    if (rawVariants.length > 1 && entry.strategy !== "round-robin") {
      throw startConfigError("START_CONFIG_INVALID", `agents.${configAgent} requires strategy round-robin for multiple variants`);
    }

    const variants: ValidatedStartVariant[] = rawVariants.map((rawVariant, index) => {
      const variant = asRecord(rawVariant);
      if (!variant) throw startConfigError("START_CONFIG_INVALID", `agents.${configAgent}.variants[${index}] must be an object`);
      assertAllowedKeys(variant, ["kind", "args"], `agents.${configAgent}.variants[${index}]`);
      const kind = variant.kind;
      if (typeof kind !== "string" || kind.trim() === "") {
        throw startConfigError("START_CONFIG_INVALID", `agents.${configAgent}.variants[${index}].kind must be non-empty`);
      }
      const args = variant.args;
      if (hasOwn(variant, "args") && (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))) {
        throw startConfigError("START_CONFIG_INVALID", `agents.${configAgent}.variants[${index}].args must be an array of strings`);
      }
      return { kind, args: Array.isArray(args) ? [...args] : [] };
    });

    result.set(configAgent, {
      ...(hasStrategy ? { strategy: "round-robin" as const } : {}),
      variants,
    });
  }
  return result;
}

async function loadConfiguredStartAgents(configPath: string): Promise<Map<string, ConfiguredStartAgent>> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    const code = asRecord(error)?.code;
    if (code === "ENOENT") {
      throw startConfigError("START_CONFIG_NOT_FOUND", "agent_config.json was not found");
    }
    throw startConfigError("START_CONFIG_INVALID", "agent_config.json could not be read");
  }

  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch {
    throw startConfigError("START_CONFIG_INVALID", "agent_config.json is not valid JSON");
  }
  return validateConfiguredDocument(document);
}

async function withStartCursorLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = startLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  startLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (startLocks.get(key) === current) startLocks.delete(key);
  }
}

async function runStart(name: string, pane: string, variant: ValidatedStartVariant): Promise<void> {
  try {
    await runHerdr(["agent", "start", name, "--kind", variant.kind, "--pane", pane, "--", ...variant.args]);
  } catch (error) {
    // NOT_IN_HERDR is an environment/transport classification; all other
    // Herdr start rejections belong to the start operation. This also
    // prevents the shared agent_not_found mapping from becoming PEER_NOT_FOUND.
    if (error instanceof HerdrLinkError && error.code === "NOT_IN_HERDR") throw error;
    throw operationError(error, "START_FAILED");
  }
}

export interface StartAgentOptions {
  /** Runtime context directory used to locate the optional project config. */
  cwd?: string;
}

/** Starts an Agent from a complete configured entry or a complete explicit launch specification. */
export async function startAgent(input: StartAgentInput, options: StartAgentOptions = {}): Promise<StartAgentReceipt> {
  assertHerdrEnvironment();
  const validated = validateStartInput(input);

  if (validated.mode === "explicit") {
    await runStart(validated.name, validated.pane, validated.variant);
    return { status: "started", agent: validated.name, kind: validated.variant.kind };
  }

  const projectRoot = typeof options.cwd === "string" && options.cwd.trim() !== "" ? options.cwd : process.cwd();
  const configPath = resolve(projectRoot, ...START_CONFIG_PATH_PARTS);
  const cursorKey = `${configPath}\u0000${validated.configAgent}`;
  return withStartCursorLock(cursorKey, async () => {
    const configuredAgents = await loadConfiguredStartAgents(configPath);
    const configured = configuredAgents.get(validated.configAgent);
    if (!configured) {
      throw startConfigError("START_AGENT_NOT_FOUND", `configured Agent "${validated.configAgent}" was not found`);
    }

    const current = startCursors.get(cursorKey) ?? 0;
    const variantIndex = current % configured.variants.length;
    const variant = configured.variants[variantIndex]!;
    await runStart(validated.name, validated.pane, variant);
    if (configured.variants.length > 1) {
      startCursors.set(cursorKey, (variantIndex + 1) % configured.variants.length);
    }
    return { status: "started", agent: validated.name, kind: variant.kind };
  });
}

const CLI_ERROR_CODE_MAP: Record<string, LinkErrorCode> = {
  agent_not_found: "PEER_NOT_FOUND",
  not_in_herdr: "NOT_IN_HERDR",
};

function classifyCliError(error: unknown): HerdrLinkError | HerdrCliError | undefined {
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
    const mappedCode = CLI_ERROR_CODE_MAP[cliCode];
    return mappedCode ? new HerdrLinkError(mappedCode, detail) : new HerdrCliError(cliCode, detail);
  }

  return undefined;
}

export async function runHerdr(args: string[]): Promise<unknown> {
  assertHerdrEnvironment();
  const binary = process.env.HERDR_BIN_PATH;

  try {
    const output = await herdrRunner(binary as string, args);
    const parsed = JSON.parse(output.stdout);
    const cliError = classifyCliError(output);
    if (cliError) throw cliError;
    return parsed;
  } catch (error) {
    if (error instanceof HerdrLinkError || error instanceof HerdrCliError) throw error;
    const cliError = classifyCliError(error);
    if (cliError) throw cliError;
    // Stale/deleted binary, transport failure, or invalid JSON all mean the
    // Herdr environment itself is unusable (NOT_IN_HERDR), not an operation
    // failure of the calling tool.
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

function agentList(value: unknown): unknown[] {
  const root = asRecord(value);
  const result = asRecord(root?.result);
  const agents = result?.agents ?? root?.agents;
  return Array.isArray(agents) ? agents : [];
}

/* ------------------------------------------------------------------ *
 * Live record readers (blueprint v2)
 *
 * Every communication call resolves fresh records from Herdr. Ambient
 * environment values such as HERDR_WORKSPACE_ID are never consulted:
 * workspace identity comes only from the live CLI response.
 * ------------------------------------------------------------------ */

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validAgentNameValue(value: unknown): string | undefined {
  const name = nonEmptyString(value);
  return name !== undefined && isValidAgentName(name) ? name : undefined;
}

interface LiveRecordFields {
  name?: string;
  workspace_id?: string;
  pane_id?: string;
  live?: boolean;
}

function readLiveRecord(value: unknown): LiveRecordFields {
  const agent = agentRecord(value);
  return {
    name: validAgentNameValue(agent?.name),
    workspace_id: nonEmptyString(agent?.workspace_id),
    pane_id: nonEmptyString(agent?.pane_id),
    live: typeof agent?.live === "boolean" ? agent.live : undefined,
  };
}

function readStatus(value: unknown): ReturnType<typeof toAgentState> {
  const agent = agentRecord(value);
  return toAgentState(agent?.agent_status ?? agent?.status);
}

/** Entries may opt out explicitly; presence in `agent list` is otherwise live. */
function isExcludedEntry(value: unknown): boolean {
  return agentRecord(value)?.live === false;
}

/* ------------------------------------------------------------------ *
 * Self identity bootstrap (PROTOCOL.md §6.3)
 * ------------------------------------------------------------------ */

const GENERATED_NAME_PREFIX = "hl-";

/** Total rename attempts per bootstrap; collisions regenerate within it. */
const MAX_GENERATED_NAME_ATTEMPTS = 3;

/** Fixed sanitized detail; raw pane ids and CLI diagnostics stay internal. */
const SELF_BOOTSTRAP_FAILED_DETAIL =
  "Herdr Link could not establish a stable Agent Name";

function selfUnnamed(detail?: string): HerdrLinkError {
  return new HerdrLinkError("SELF_UNNAMED", detail ?? SELF_BOOTSTRAP_FAILED_DETAIL);
}

/** Generated Link-owned Agent Name (`hl-` + hex), valid per `[a-z][a-z0-9_-]{0,31}`. */
function generateAgentName(): string {
  return `${GENERATED_NAME_PREFIX}${randomBytes(4).toString("hex")}`;
}

/** The occupant's stable Agent Name, or undefined when absent or not live. */
function stableName(record: LiveRecordFields): string | undefined {
  return record.live === false ? undefined : record.name;
}

/** Bounded detection-readiness budget: Herdr may not yet have noticed a
 * freshly launched pane occupant when the adapter boots (PROTOCOL.md §6.3). */
const SELF_PROBE_ATTEMPTS = 3;
const SELF_PROBE_DELAY_MS = 100;

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchSelfRecord(pane: string): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runFor(["agent", "get", pane], "SELF_UNNAMED");
    } catch (error) {
      // The caller pane is not (yet) a named agent target; keep self-resolution
      // failures in the SELF_UNNAMED vocabulary. The short bounded readiness
      // retry is a best-effort bridge over transient launch races — not a
      // correctness guarantee and never a substitute for the authoritative
      // getSelfContext() fallback. Transport and other classified failures are
      // never retried.
      const notDetectedYet =
        error instanceof HerdrLinkError && error.code === "PEER_NOT_FOUND";
      if (notDetectedYet && attempt < SELF_PROBE_ATTEMPTS) {
        await sleepMs(SELF_PROBE_DELAY_MS);
        continue;
      }
      if (notDetectedYet) {
        throw selfUnnamed(errorDetail(error));
      }
      throw error;
    }
  }
}

/**
 * Self identity bootstrap (PROTOCOL.md §6.3): guarantees the current pane
 * occupant has a stable Agent Name and returns it.
 *
 * - A validly-named occupant is returned unchanged; user-assigned names are
 *   never rewritten.
 * - A live-but-unnamed occupant receives one generated `hl-*` name via
 *   `agent rename`, confirmed by re-reading the authoritative live record.
 * - Undetected occupants get a tiny bounded readiness retry inside the initial
 *   probe; `agent_name_taken` regenerates within a bounded collision budget —
 *   these two budgets are the only internal retries. Any other failure
 *   collapses to SELF_UNNAMED with a fixed sanitized detail, except
 *   NOT_IN_HERDR which keeps its own code.
 * - Concurrent callers share one in-flight sequence, so a startup bootstrap
 *   can never race a communication-path fallback into double-renaming. The
 *   guard clears on settle: nothing is cached or persisted between calls,
 *   and Herdr remains the lifecycle authority.
 */
let bootstrapInFlight: Promise<string> | undefined;

export function ensureSelfName(): Promise<string> {
  bootstrapInFlight ??= ensureSelfNameFlow().finally(() => {
    bootstrapInFlight = undefined;
  });
  return bootstrapInFlight;
}

/** @internal Test seam only: clears the in-flight bootstrap guard so
 * sequential subtests start from a clean slate. Production never needs this —
 * the guard clears itself on settle. */
export function resetSelfBootstrapForTests(): void {
  bootstrapInFlight = undefined;
}

async function ensureSelfNameFlow(): Promise<string> {
  assertHerdrEnvironment();
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) {
    throw selfUnnamed("HERDR_PANE_ID is missing");
  }
  return establishSelfName(pane, readLiveRecord(await fetchSelfRecord(pane)));
}

/** Core §6.3 sequence for an already-fetched live record of `pane`. */
async function establishSelfName(pane: string, record: LiveRecordFields): Promise<string> {
  const existing = stableName(record);
  if (existing) return existing;
  if (record.live === false) {
    // Occupant not recognized as live: there is nothing to rename.
    throw selfUnnamed();
  }

  for (let attempt = 0; attempt < MAX_GENERATED_NAME_ATTEMPTS; attempt += 1) {
    try {
      await runHerdr(["agent", "rename", pane, generateAgentName()]);
    } catch (error) {
      if (error instanceof HerdrCliError && error.cliCode === "agent_name_taken") {
        continue; // collision: regenerate within the bounded budget
      }
      if (error instanceof HerdrLinkError && error.code === "NOT_IN_HERDR") {
        throw error; // environment/transport failures keep their classified code
      }
      throw selfUnnamed();
    }
    // Confirm against a fresh authoritative read; never trust the rename echo.
    const confirmed = stableName(readLiveRecord(await fetchSelfRecord(pane)));
    if (confirmed) return confirmed;
    throw selfUnnamed();
  }
  // Collision budget exhausted without a confirmed name.
  throw selfUnnamed();
}

/**
 * Resolves the caller's own live context via `HERDR_PANE_ID -> agent get`.
 * Fresh on every call: name/workspace_id/pane_id/agent_status come from the
 * current live record, never from cache or ambient environment. A live but
 * unnamed occupant triggers the §6.3 self-bootstrap fallback, providing a
 * fresh resolution when the adapter's init-time bootstrap did not establish
 * identity; context is then rebuilt from a fresh authoritative read.
 */
export async function getSelfContext(): Promise<AgentContext> {
  assertHerdrEnvironment();
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) {
    throw selfUnnamed("HERDR_PANE_ID is missing");
  }

  let response = await fetchSelfRecord(pane);
  let record = readLiveRecord(response);
  if (!stableName(record) && record.live !== false) {
    // Route through the guarded entry: a concurrent startup bootstrap is
    // awaited, never duplicated (single rename per moment); state is then
    // re-read fresh below after it settles.
    await ensureSelfName();
    response = await fetchSelfRecord(pane);
    record = readLiveRecord(response);
  }

  const name = stableName(record);
  if (!name) {
    throw selfUnnamed("current Herdr agent has no valid name");
  }
  return {
    name,
    workspace_id: record.workspace_id ?? "",
    pane_id: record.pane_id ?? pane,
    agent_status: readStatus(response),
  };
}

/** Compat wrapper returning only the live self name; new callers should use {@link getSelfContext}. */
export async function getSelf(): Promise<string> {
  return (await getSelfContext()).name;
}

/**
 * Resolves a target agent's live context by name, fresh on every call.
 * Invalid, nonexistent, or unnamed targets are PEER_NOT_FOUND.
 */
export async function getAgentContext(name: string): Promise<AgentContext> {
  assertHerdrEnvironment();
  if (!isValidAgentName(name)) {
    throw new HerdrLinkError("PEER_NOT_FOUND", `target agent name "${name}" is invalid`);
  }

  const response = await runFor(["agent", "get", name], "PEER_NOT_FOUND");
  const record = readLiveRecord(response);
  if (record.live === false || !record.name || record.name !== name) {
    throw new HerdrLinkError("PEER_NOT_FOUND", `target agent "${name}" has no valid live record`);
  }
  return {
    name: record.name,
    workspace_id: record.workspace_id ?? "",
    pane_id: record.pane_id ?? "",
    agent_status: readStatus(response),
  };
}

/**
 * Same-workspace guard. Workspace ids must be present on both live records
 * and identical; anything else (cross-workspace, unreported workspace) fails
 * closed with the privacy-preserving peer-not-found wording so callers
 * cannot distinguish foreign agents from nonexistent ones.
 */
function assertSameWorkspace(self: AgentContext, target: AgentContext): void {
  if (
    self.workspace_id === "" ||
    target.workspace_id === "" ||
    self.workspace_id !== target.workspace_id
  ) {
    throw new HerdrLinkError("PEER_NOT_FOUND", AGENT_ERROR_DETAILS.PEER_NOT_FOUND);
  }
}

/**
 * Instant same-workspace peer directory: `{ self: { name, state }, peers:
 * [{ name, state }] }`. Only validly-named, live agents whose authoritative
 * workspace equals the caller's live workspace are listed; self excluded;
 * no topology ids exposed. Generated fresh on every call.
 */
export async function listPeers(): Promise<PeerDirectory> {
  const self = await getSelfContext();
  const response = await runFor(["agent", "list"], "NOT_IN_HERDR");

  const peers: PeerInfo[] = [];
  const seen = new Set<string>();
  for (const entry of agentList(response)) {
    const record = readLiveRecord(entry);
    if (!record.name || seen.has(record.name)) continue;
    seen.add(record.name);
    if (record.name === self.name) continue;
    if (self.workspace_id === "" || record.workspace_id !== self.workspace_id) continue;
    if (isExcludedEntry(entry)) continue;
    peers.push({ name: record.name, state: readStatus(entry) });
  }

  return { self: { name: self.name, state: self.agent_status }, peers };
}

/**
 * Sends a validated herdr-link/1 envelope to a same-workspace live peer.
 * Self and target are resolved live on every call; no state checks, no
 * requirement to consult peers first, no retry. The payload delivered to
 * `agent prompt` is the self-describing inbound wrapper; the outer wrapper
 * never enters the envelope.
 */
export async function sendMessage(
  to: string,
  message: string,
): Promise<{ status: "sent"; id: string; to: string }> {
  const self = await getSelfContext();
  const target = await getAgentContext(to);
  assertSameWorkspace(self, target);

  const envelope: HerdrLinkEnvelope = buildEnvelope({
    from: self.name,
    to: target.name,
    message,
  });

  await runFor(["agent", "prompt", target.name, buildInboundWrapper(envelope)], "SEND_FAILED");
  return { status: "sent", id: envelope.id, to: target.name };
}

/**
 * Resolves only the caller's authoritative workspace for close. Close is an
 * explicit target-name operation and, per PROTOCOL.md §6.2, does not require
 * the caller occupant itself to have a stable Agent Name; it still needs a
 * live workspace record so the same-workspace guard can fail closed.
 */
async function getSelfWorkspaceId(): Promise<string> {
  assertHerdrEnvironment();
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) {
    throw new HerdrLinkError("PEER_NOT_FOUND", AGENT_ERROR_DETAILS.PEER_NOT_FOUND);
  }
  const response = await runFor(["agent", "get", pane], "NOT_IN_HERDR");
  const record = readLiveRecord(response);
  if (record.live === false || !record.workspace_id) {
    throw new HerdrLinkError("PEER_NOT_FOUND", AGENT_ERROR_DETAILS.PEER_NOT_FOUND);
  }
  return record.workspace_id;
}

/**
 * Closes the pane currently hosting a named same-workspace live agent.
 * The target is resolved fresh on every call; the caller only contributes its
 * authoritative workspace and need not itself be named. No caching, focused-
 * pane fallback, state checks, or retry is allowed.
 */
export async function closeAgentPane(agentName: string): Promise<{ status: "closed"; agent: string }> {
  assertHerdrEnvironment();
  if (!isValidAgentName(agentName)) {
    throw new HerdrLinkError("PEER_NOT_FOUND", `target agent name "${agentName}" is invalid`);
  }

  const selfWorkspaceId = await getSelfWorkspaceId();
  const target = await getAgentContext(agentName);
  if (target.workspace_id === "" || target.workspace_id !== selfWorkspaceId) {
    throw new HerdrLinkError("PEER_NOT_FOUND", AGENT_ERROR_DETAILS.PEER_NOT_FOUND);
  }

  if (!target.pane_id) {
    throw new HerdrLinkError("PEER_NOT_FOUND", `target agent "${agentName}" has no current pane`);
  }

  await runFor(["pane", "close", target.pane_id], "CLOSE_FAILED");
  return { status: "closed", agent: target.name };
}
