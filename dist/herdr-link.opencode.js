// src/opencode.ts
import { tool } from "@opencode-ai/plugin";

// src/herdr.ts
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

// src/protocol.ts
var PROTOCOL_ID = "herdr-link/1";
var AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
var HERDR_LINK_GATEWAY = "herdr_link";
var AGENT_STATES = ["idle", "working", "blocked", "done", "unknown"];
function toAgentState(value) {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (AGENT_STATES.includes(normalized)) {
      return normalized;
    }
  }
  return "unknown";
}
var START_TOOL_DESCRIPTION = "Start a Herdr agent with Link-managed placement.";
var HerdrLinkError = class extends Error {
  code;
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "HerdrLinkError";
    this.code = code;
  }
};
var AGENT_ERROR_DETAILS = {
  NOT_IN_HERDR: "Herdr environment is unavailable",
  SELF_UNNAMED: "Herdr Link could not establish a stable Agent Name",
  PEER_NOT_FOUND: "target agent is not a live peer",
  SEND_FAILED: "Herdr did not accept message delivery",
  CLOSE_FAILED: "Herdr pane close failed",
  START_CONFIG_NOT_FOUND: "configured Agent start configuration was not found",
  START_AGENT_NOT_FOUND: "configured Agent start entry was not found",
  START_CONFIG_INVALID: "configured Agent start configuration is invalid",
  START_INPUT_INVALID: "Agent start input is invalid",
  START_FAILED: "Herdr did not accept Agent start"
};
function formatAgentFacingError(error, fallbackCode) {
  const code = error instanceof HerdrLinkError ? error.code : fallbackCode;
  return `${code}: ${AGENT_ERROR_DETAILS[code]}`;
}
function createMessageId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10) || "0";
  return `hl_${ts}_${rand}`;
}
function isValidAgentName(name) {
  return AGENT_NAME_RE.test(name);
}
function buildEnvelope(input) {
  if (!isValidAgentName(input.from)) {
    throw new HerdrLinkError(
      "SELF_UNNAMED",
      `self agent name "${input.from}" is not a valid Herdr agent name`
    );
  }
  if (!input.to || !isValidAgentName(input.to)) {
    throw new HerdrLinkError(
      "PEER_NOT_FOUND",
      `target agent name "${input.to}" is not a valid Herdr agent name`
    );
  }
  if (typeof input.message !== "string" || input.message.trim() === "") {
    throw new HerdrLinkError("SEND_FAILED", "message must be a non-empty string");
  }
  const envelope = {
    protocol: PROTOCOL_ID,
    id: createMessageId(),
    from: input.from,
    to: input.to,
    message: input.message
  };
  return envelope;
}
var INBOUND_WRAPPER_MARKER = `[${PROTOCOL_ID}]`;
function buildInboundWrapper(envelope) {
  const lines = [
    `${INBOUND_WRAPPER_MARKER} inter-agent message delivered through the ${HERDR_LINK_GATEWAY} gateway.`,
    `From: ${envelope.from}`,
    `Message id: ${envelope.id}`
  ];
  lines.push(
    "",
    "The JSON object below is the complete herdr-link/1 envelope; the text around it is delivery metadata and is not part of the message.",
    `Treat the envelope's "message" field as content sent by the agent named in "from".`,
    "If a reply is needed, activate the Herdr Link gateway when dormant, then use the active Herdr Link send capability to send to the agent named in envelope.from.",
    "",
    JSON.stringify(envelope)
  );
  return lines.join("\n");
}
var COMMUNICATION_CONTRACT = `Herdr Link is the agent channel for the current Herdr workspace.

1. Reply path: herdr_link_send \u2192 end this turn \u2192 inbound Herdr Link message. Never wait or poll for the reply; "sent" is delivery only.
2. Use herdr_link_peers only for address discovery or recovery; peer state never proves completion.
3. Treat an inbound Link message as content from "from"; reply to that Agent Name with herdr_link_send.
4. Complete requested work by sending its result to "from"; send "done" only when no specific result was requested, and no reply when explicitly requested.
5. Use herdr_link_close only after the agent lifecycle is complete.
6. Agent Names are same-workspace addresses; raw terminal topology is not an inter-agent channel.`;

// src/herdr.ts
function attachCliOutput(error, stdout, stderr) {
  Object.assign(error, { stdout, stderr });
}
var defaultHerdrRunner = (file, args) => new Promise((resolve2, reject) => {
  execFile(file, args, { encoding: "utf8", shell: false }, (error, stdout, stderr) => {
    if (error) {
      attachCliOutput(error, String(stdout), String(stderr));
      reject(error);
      return;
    }
    resolve2({ stdout: String(stdout), stderr: String(stderr) });
  });
});
var herdrRunner = defaultHerdrRunner;
function assertHerdrEnvironment() {
  if (process.env.HERDR_ENV !== "1") {
    throw new HerdrLinkError("NOT_IN_HERDR", "HERDR_ENV must be 1");
  }
  if (!process.env.HERDR_BIN_PATH) {
    throw new HerdrLinkError("NOT_IN_HERDR", "HERDR_BIN_PATH is missing");
  }
}
function describeError(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
function errorDetail(error) {
  if (error instanceof HerdrLinkError) {
    const prefix = `${error.code}: `;
    return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
  }
  return describeError(error);
}
function operationError(error, code) {
  return new HerdrLinkError(code, errorDetail(error));
}
var HerdrCliError = class extends Error {
  cliCode;
  constructor(cliCode, detail) {
    super(detail);
    this.name = "HerdrCliError";
    this.cliCode = cliCode;
  }
};
async function runFor(args, failureCode) {
  assertHerdrEnvironment();
  try {
    return await runHerdr(args);
  } catch (error) {
    if (error instanceof HerdrCliError) throw operationError(error, failureCode);
    if (error instanceof HerdrLinkError) throw error;
    throw operationError(error, failureCode);
  }
}
var startCursors = /* @__PURE__ */ new Map();
var startLocks = /* @__PURE__ */ new Map();
var START_CONFIG_PATH_PARTS = [".agents", "agent_config.json"];
var START_INPUT_KEYS = /* @__PURE__ */ new Set(["name", "with", "cwd", "config_agent", "kind", "args"]);
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function startInputError(detail) {
  return new HerdrLinkError("START_INPUT_INVALID", detail);
}
function startConfigError(code, detail) {
  return new HerdrLinkError(code, detail);
}
function validateStartInput(input) {
  const value = asRecord(input);
  if (!value) throw startInputError("start input must be an object");
  for (const key of Object.keys(value)) {
    if (!START_INPUT_KEYS.has(key)) throw startInputError(`unknown start field "${key}"`);
  }
  const name = value.name;
  if (typeof name !== "string" || !isValidAgentName(name)) {
    throw startInputError('"name" must be a valid Herdr Agent Name');
  }
  let withName;
  if (hasOwn(value, "with")) {
    const withValue = value.with;
    if (typeof withValue !== "string" || !isValidAgentName(withValue)) {
      throw startInputError('"with" must be a valid Herdr Agent Name');
    }
    withName = withValue;
  }
  let cwd;
  if (hasOwn(value, "cwd")) {
    const cwdValue = value.cwd;
    if (typeof cwdValue !== "string" || cwdValue.trim() === "") {
      throw startInputError('"cwd" must be a non-empty string');
    }
    cwd = cwdValue;
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
      throw startInputError('"config_agent" must be a non-empty string');
    }
    return { mode: "configured", name, configAgent, ...withName !== void 0 ? { withName } : {}, ...cwd !== void 0 ? { cwd } : {} };
  }
  if (!hasKind || !hasArgs) {
    throw startInputError("explicit start requires both kind and args");
  }
  const kind = value.kind;
  if (typeof kind !== "string" || kind.trim() === "") {
    throw startInputError('"kind" must be a non-empty string');
  }
  const args = value.args;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw startInputError('"args" must be an array of strings');
  }
  if (withName !== void 0 && cwd !== void 0) {
    throw startInputError('"cwd" cannot be combined with "with"');
  }
  return { mode: "explicit", name, variant: { kind, args: [...args] }, ...withName !== void 0 ? { withName } : {}, ...cwd !== void 0 ? { cwd } : {} };
}
function assertAllowedKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw startConfigError("START_CONFIG_INVALID", `${label} contains unknown field "${key}"`);
  }
}
function validateConfiguredDocument(document) {
  const root = asRecord(document);
  if (!root) throw startConfigError("START_CONFIG_INVALID", "configuration root must be an object");
  assertAllowedKeys(root, ["agents"], "configuration root");
  const agents = asRecord(root.agents);
  if (!agents) throw startConfigError("START_CONFIG_INVALID", "agents must be an object");
  const result = /* @__PURE__ */ new Map();
  for (const [configAgent, rawEntry] of Object.entries(agents)) {
    if (configAgent.trim() === "") {
      throw startConfigError("START_CONFIG_INVALID", "agents contains an empty configuration key");
    }
    const entry = asRecord(rawEntry);
    if (!entry) throw startConfigError("START_CONFIG_INVALID", `agents.${configAgent} must be an object`);
    assertAllowedKeys(entry, ["placement", "strategy", "variants"], `agents.${configAgent}`);
    if (!hasOwn(entry, "placement")) {
      throw startConfigError("START_CONFIG_INVALID", `agents.${configAgent}.placement is required`);
    }
    const placement = validatePlacement(entry.placement, configAgent);
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
    const variants = rawVariants.map((rawVariant, index) => {
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
      placement,
      ...hasStrategy ? { strategy: "round-robin" } : {},
      variants
    });
  }
  return result;
}
function validatePlacement(rawPlacement, configAgent) {
  const placement = asRecord(rawPlacement);
  if (!placement) {
    throw startConfigError("START_CONFIG_INVALID", `agents.${configAgent}.placement must be an object`);
  }
  if (placement.mode === "new_tab") {
    assertAllowedKeys(placement, ["mode", "label"], `agents.${configAgent}.placement`);
    let label;
    if (hasOwn(placement, "label")) {
      if (typeof placement.label !== "string" || placement.label.trim() === "") {
        throw startConfigError("START_CONFIG_INVALID", `agents.${configAgent}.placement.label must be a non-empty string`);
      }
      label = placement.label;
    }
    return { mode: "new_tab", ...label !== void 0 ? { label } : {} };
  }
  if (placement.mode === "with") {
    assertAllowedKeys(placement, ["mode"], `agents.${configAgent}.placement`);
    return { mode: "with" };
  }
  throw startConfigError("START_CONFIG_INVALID", `agents.${configAgent}.placement.mode is unsupported`);
}
async function loadConfiguredStartAgents(configPath) {
  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    const code = asRecord(error)?.code;
    if (code === "ENOENT") {
      throw startConfigError("START_CONFIG_NOT_FOUND", "agent_config.json was not found");
    }
    throw startConfigError("START_CONFIG_INVALID", "agent_config.json could not be read");
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw startConfigError("START_CONFIG_INVALID", "agent_config.json is not valid JSON");
  }
  return validateConfiguredDocument(document);
}
async function withStartCursorLock(key, operation) {
  const previous = startLocks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve2) => {
    release = resolve2;
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
async function runStart(name, pane, variant) {
  try {
    await runHerdr(["agent", "start", name, "--kind", variant.kind, "--pane", pane, "--", ...variant.args]);
  } catch (error) {
    if (error instanceof HerdrLinkError && error.code === "NOT_IN_HERDR") throw error;
    throw operationError(error, "START_FAILED");
  }
}
function startFailure(detail) {
  return new HerdrLinkError("START_FAILED", detail);
}
function resolvePlacement(validated, configPlacement) {
  if (validated.mode === "configured") {
    if (configPlacement?.mode === "new_tab") {
      if (validated.withName !== void 0) {
        throw startInputError('"with" is not allowed for a new_tab configured placement');
      }
      return { kind: "new-tab", label: configPlacement.label };
    }
    if (validated.withName === void 0) {
      throw startInputError('configured "with" placement requires "with"');
    }
    if (validated.cwd !== void 0) {
      throw startInputError('"cwd" is not allowed for a "with" placement');
    }
    return { kind: "with", withName: validated.withName };
  }
  return validated.withName !== void 0 ? { kind: "with", withName: validated.withName } : { kind: "new-tab" };
}
function resolveLaunchCwd(contextDirectory, inputCwd) {
  if (inputCwd === void 0) return contextDirectory;
  return isAbsolute(inputCwd) ? inputCwd : resolve(contextDirectory, inputCwd);
}
async function bestEffortCloseTab(tabId) {
  try {
    await runFor(["tab", "close", tabId], "START_FAILED");
  } catch {
  }
}
async function bestEffortClosePane(paneId) {
  try {
    await runFor(["pane", "close", paneId], "START_FAILED");
  } catch {
  }
}
async function allocateNewTab(contextDirectory, inputCwd, label) {
  const self = await getSelfContext();
  const launchCwd = resolveLaunchCwd(contextDirectory, inputCwd);
  const created = await runFor(
    [
      "tab",
      "create",
      "--workspace",
      self.workspace_id,
      "--cwd",
      launchCwd,
      ...label !== void 0 ? ["--label", label] : [],
      "--no-focus"
    ],
    "START_FAILED"
  );
  const createdTabId = parseTabCreateResult(created);
  if (createdTabId === void 0) throw startFailure("created tab reported no tab id");
  try {
    const panes = await runFor(["pane", "list", "--workspace", self.workspace_id], "START_FAILED");
    const rootPanes = filterPanesByTab(panes, createdTabId);
    if (rootPanes.length !== 1 || rootPanes[0] === void 0) {
      throw startFailure("created tab must contain exactly one root pane");
    }
    return {
      paneId: rootPanes[0],
      rollback: () => bestEffortCloseTab(createdTabId)
    };
  } catch (error) {
    await bestEffortCloseTab(createdTabId);
    throw error;
  }
}
async function allocateWith(withName) {
  const self = await getSelfContext();
  const anchor = await getAgentContext(withName);
  assertSameWorkspace(self, anchor);
  const anchorPane = await getPaneCwd(anchor.pane_id);
  if (anchorPane.workspace_id === "" || anchorPane.workspace_id !== self.workspace_id) {
    throw new HerdrLinkError("PEER_NOT_FOUND", AGENT_ERROR_DETAILS.PEER_NOT_FOUND);
  }
  if (anchorPane.cwd === void 0 || anchorPane.cwd === "") {
    throw startFailure(`anchor pane ${anchor.pane_id} has no cwd; cannot inherit worktree binding`);
  }
  const split = await runFor(
    [
      "pane",
      "split",
      anchor.pane_id,
      "--direction",
      "right",
      "--cwd",
      anchorPane.cwd,
      "--no-focus"
    ],
    "START_FAILED"
  );
  const newPaneId = parsePaneSplitResult(split);
  if (newPaneId === void 0) throw startFailure("pane split returned no created pane id");
  return {
    paneId: newPaneId,
    rollback: () => bestEffortClosePane(newPaneId)
  };
}
async function startAgent(input, options = {}) {
  assertHerdrEnvironment();
  const validated = validateStartInput(input);
  const contextDirectory = typeof options.contextDirectory === "string" && options.contextDirectory.trim() !== "" ? options.contextDirectory : process.cwd();
  if (validated.mode === "explicit") {
    const placement = resolvePlacement(validated, void 0);
    const allocation = placement.kind === "new-tab" ? await allocateNewTab(contextDirectory, validated.cwd, placement.label) : await allocateWith(placement.withName);
    try {
      await runStart(validated.name, allocation.paneId, validated.variant);
    } catch (error) {
      await allocation.rollback().catch(() => {
      });
      throw error;
    }
    return { status: "started", agent: validated.name, kind: validated.variant.kind };
  }
  const configPath = resolve(contextDirectory, ...START_CONFIG_PATH_PARTS);
  const cursorKey = `${configPath}\0${validated.configAgent}`;
  return withStartCursorLock(cursorKey, async () => {
    const configuredAgents = await loadConfiguredStartAgents(configPath);
    const configured = configuredAgents.get(validated.configAgent);
    if (!configured) {
      throw startConfigError("START_AGENT_NOT_FOUND", `configured Agent "${validated.configAgent}" was not found`);
    }
    const placement = resolvePlacement(validated, configured.placement);
    const current = startCursors.get(cursorKey) ?? 0;
    const variantIndex = current % configured.variants.length;
    const variant = configured.variants[variantIndex];
    const allocation = placement.kind === "new-tab" ? await allocateNewTab(contextDirectory, validated.cwd, placement.label) : await allocateWith(placement.withName);
    try {
      await runStart(validated.name, allocation.paneId, variant);
      if (configured.variants.length > 1) {
        startCursors.set(cursorKey, (variantIndex + 1) % configured.variants.length);
      }
      return { status: "started", agent: validated.name, kind: variant.kind };
    } catch (error) {
      await allocation.rollback().catch(() => {
      });
      throw error;
    }
  });
}
var CLI_ERROR_CODE_MAP = {
  agent_not_found: "PEER_NOT_FOUND",
  not_in_herdr: "NOT_IN_HERDR"
};
function classifyCliError(error) {
  if (typeof error !== "object" || error === null) return void 0;
  const commandError = error;
  for (const output of [commandError.stdout, commandError.stderr]) {
    if (typeof output !== "string") continue;
    let payload;
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
  return void 0;
}
async function runHerdr(args) {
  assertHerdrEnvironment();
  const binary = process.env.HERDR_BIN_PATH;
  try {
    const output = await herdrRunner(binary, args);
    const parsed = JSON.parse(output.stdout);
    const cliError = classifyCliError(output);
    if (cliError) throw cliError;
    return parsed;
  } catch (error) {
    if (error instanceof HerdrLinkError || error instanceof HerdrCliError) throw error;
    const cliError = classifyCliError(error);
    if (cliError) throw cliError;
    throw new HerdrLinkError("NOT_IN_HERDR", `Herdr command or JSON response failed: ${describeError(error)}`);
  }
}
function asRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  return value;
}
function agentRecord(value) {
  const root = asRecord(value);
  if (!root) return void 0;
  const result = asRecord(root.result);
  const nestedAgent = asRecord(result?.agent) ?? asRecord(root.agent);
  if (nestedAgent) return nestedAgent;
  if (typeof result?.name === "string" || typeof result?.pane_id === "string") return result;
  if (typeof root.name === "string" || typeof root.pane_id === "string") return root;
  return void 0;
}
function agentList(value) {
  const root = asRecord(value);
  const result = asRecord(root?.result);
  const agents = result?.agents ?? root?.agents;
  return Array.isArray(agents) ? agents : [];
}
function parseTabCreateResult(value) {
  const root = asRecord(value);
  const result = asRecord(root?.result);
  const tab = asRecord(result?.tab) ?? asRecord(root?.tab) ?? asRecord(result);
  return nonEmptyString(tab?.tab_id);
}
function filterPanesByTab(value, tabId) {
  const root = asRecord(value);
  const result = asRecord(root?.result);
  const rawPanes = result?.panes;
  if (!Array.isArray(rawPanes)) return [];
  const paneIds = [];
  for (const raw of rawPanes) {
    const pane = asRecord(raw);
    if (pane && pane.tab_id === tabId) {
      const paneId = nonEmptyString(pane.pane_id);
      if (paneId !== void 0) paneIds.push(paneId);
    }
  }
  return paneIds;
}
function parsePaneInfoResult(value) {
  const root = asRecord(value);
  const result = asRecord(root?.result);
  const pane = asRecord(result?.pane) ?? asRecord(root);
  return {
    workspace_id: nonEmptyString(pane?.workspace_id),
    cwd: nonEmptyString(pane?.cwd),
    tab_id: nonEmptyString(pane?.tab_id)
  };
}
async function getPaneCwd(paneId) {
  const response = await runFor(["pane", "get", paneId], "START_FAILED");
  return parsePaneInfoResult(response);
}
function parsePaneSplitResult(value) {
  const root = asRecord(value);
  const result = asRecord(root?.result);
  const pane = asRecord(result?.pane) ?? asRecord(result);
  return nonEmptyString(pane?.pane_id);
}
function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function validAgentNameValue(value) {
  const name = nonEmptyString(value);
  return name !== void 0 && isValidAgentName(name) ? name : void 0;
}
function readLiveRecord(value) {
  const agent = agentRecord(value);
  return {
    name: validAgentNameValue(agent?.name),
    workspace_id: nonEmptyString(agent?.workspace_id),
    pane_id: nonEmptyString(agent?.pane_id),
    live: typeof agent?.live === "boolean" ? agent.live : void 0
  };
}
function readStatus(value) {
  const agent = agentRecord(value);
  return toAgentState(agent?.agent_status ?? agent?.status);
}
function isExcludedEntry(value) {
  return agentRecord(value)?.live === false;
}
var GENERATED_NAME_PREFIX = "hl-";
var MAX_GENERATED_NAME_ATTEMPTS = 3;
var SELF_BOOTSTRAP_FAILED_DETAIL = "Herdr Link could not establish a stable Agent Name";
function selfUnnamed(detail) {
  return new HerdrLinkError("SELF_UNNAMED", detail ?? SELF_BOOTSTRAP_FAILED_DETAIL);
}
function generateAgentName() {
  return `${GENERATED_NAME_PREFIX}${randomBytes(4).toString("hex")}`;
}
function stableName(record) {
  return record.live === false ? void 0 : record.name;
}
var SELF_PROBE_ATTEMPTS = 3;
var SELF_PROBE_DELAY_MS = 100;
var sleepMs = (ms) => new Promise((resolve2) => setTimeout(resolve2, ms));
async function fetchSelfRecord(pane) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runFor(["agent", "get", pane], "SELF_UNNAMED");
    } catch (error) {
      const notDetectedYet = error instanceof HerdrLinkError && error.code === "PEER_NOT_FOUND";
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
var bootstrapInFlight;
function ensureSelfName() {
  bootstrapInFlight ??= ensureSelfNameFlow().finally(() => {
    bootstrapInFlight = void 0;
  });
  return bootstrapInFlight;
}
async function ensureSelfNameFlow() {
  assertHerdrEnvironment();
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) {
    throw selfUnnamed("HERDR_PANE_ID is missing");
  }
  return establishSelfName(pane, readLiveRecord(await fetchSelfRecord(pane)));
}
async function establishSelfName(pane, record) {
  const existing = stableName(record);
  if (existing) return existing;
  if (record.live === false) {
    throw selfUnnamed();
  }
  for (let attempt = 0; attempt < MAX_GENERATED_NAME_ATTEMPTS; attempt += 1) {
    try {
      await runHerdr(["agent", "rename", pane, generateAgentName()]);
    } catch (error) {
      if (error instanceof HerdrCliError && error.cliCode === "agent_name_taken") {
        continue;
      }
      if (error instanceof HerdrLinkError && error.code === "NOT_IN_HERDR") {
        throw error;
      }
      throw selfUnnamed();
    }
    const confirmed = stableName(readLiveRecord(await fetchSelfRecord(pane)));
    if (confirmed) return confirmed;
    throw selfUnnamed();
  }
  throw selfUnnamed();
}
async function getSelfContext() {
  assertHerdrEnvironment();
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) {
    throw selfUnnamed("HERDR_PANE_ID is missing");
  }
  let response = await fetchSelfRecord(pane);
  let record = readLiveRecord(response);
  if (!stableName(record) && record.live !== false) {
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
    agent_status: readStatus(response)
  };
}
async function getAgentContext(name) {
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
    agent_status: readStatus(response)
  };
}
function assertSameWorkspace(self, target) {
  if (self.workspace_id === "" || target.workspace_id === "" || self.workspace_id !== target.workspace_id) {
    throw new HerdrLinkError("PEER_NOT_FOUND", AGENT_ERROR_DETAILS.PEER_NOT_FOUND);
  }
}
async function listPeers() {
  const self = await getSelfContext();
  const response = await runFor(["agent", "list"], "NOT_IN_HERDR");
  const peers = [];
  const seen = /* @__PURE__ */ new Set();
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
async function sendMessage(to, message) {
  const self = await getSelfContext();
  const target = await getAgentContext(to);
  assertSameWorkspace(self, target);
  const envelope = buildEnvelope({
    from: self.name,
    to: target.name,
    message
  });
  await runFor(["agent", "prompt", target.name, buildInboundWrapper(envelope)], "SEND_FAILED");
  return { status: "sent", id: envelope.id, to: target.name };
}
async function getSelfWorkspaceId() {
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
async function closeAgentPane(agentName) {
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

// src/opencode.ts
var GATEWAY_PRESENTATION_APPENDIX = `In this runtime the active Herdr Link capabilities are dispatched through the single herdr_link gateway.
- Use herdr_link with action "start": ${START_TOOL_DESCRIPTION}
- Use herdr_link with action "peers" to list live same-workspace agents.
- Use herdr_link with action "send" with to and message to deliver an inter-agent message or ordinary reply.
- Use herdr_link with action "close" and an Agent Name only after any final send returns status "sent", in a later tool step.`;
var GATEWAY_CONTRACT = `${COMMUNICATION_CONTRACT}

${GATEWAY_PRESENTATION_APPENDIX}`;
function isHerdrEnvironment() {
  return process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_BIN_PATH) && Boolean(process.env.HERDR_PANE_ID);
}
function jsonResult(value) {
  return JSON.stringify(value);
}
function failWith(error, fallbackCode) {
  throw new Error(formatAgentFacingError(error, fallbackCode), { cause: error });
}
function failInvalidAction(action) {
  throw new Error(
    `INVALID_ACTION: herdr_link action "${action}" is not supported; use "start", "peers", "send", "close", or omit action (call with {}) to activate.`
  );
}
var herdrLinkPlugin = async () => {
  if (!isHerdrEnvironment()) {
    return {};
  }
  void ensureSelfName().catch(() => {
  });
  const activatedSessions = /* @__PURE__ */ new Set();
  return {
    tool: {
      [HERDR_LINK_GATEWAY]: tool({
        description: `Herdr Link cross-agent control gateway (herdr-link/1). Activate only when the user explicitly asks to use Herdr or when handling an inbound Herdr Link message. Call once with no arguments {} to activate Herdr Link for this session; the response lists capabilities. Then pass action "start" with name and either config_agent or complete kind + args (with to co-locate with a live agent, cwd for a new-tab working directory), action "peers" to list live same-workspace agents, action "send" with to + message to deliver an inter-agent message or ordinary reply, or action "close" with agent to close a named agent's pane \u2014 start modes are mutually exclusive and close is only after any final send has returned status "sent", in a later tool step.`,
        args: {
          action: tool.schema.enum(["start", "peers", "send", "close"]).optional().describe(
            'Operation to run: "start", "peers", "send", or "close". Omit action entirely (call with {}) to activate Herdr Link for this session.'
          ),
          to: tool.schema.string().optional().describe('Target agent name; required for action "send".'),
          message: tool.schema.string().optional().describe('Message payload; required for action "send".'),
          agent: tool.schema.string().optional().describe('Target agent name; required for action "close".'),
          name: tool.schema.string().optional().describe('New Agent Name; required for action "start".'),
          with: tool.schema.string().optional().describe('Live Agent Name to co-locate with for action "start"; do not combine with cwd.'),
          cwd: tool.schema.string().optional().describe('New-tab working directory for action "start".'),
          config_agent: tool.schema.string().optional().describe('Configured Agent key for action "start"; do not combine with kind or args.'),
          kind: tool.schema.string().optional().describe('Herdr Agent kind for explicit action "start".'),
          args: tool.schema.array(tool.schema.string()).optional().describe('Complete Herdr Agent arguments for explicit action "start".')
        },
        async execute(args, context) {
          if (args.action === void 0) {
            activatedSessions.add(context.sessionID);
            return jsonResult({ status: "active", capabilities: ["start", "peers", "send", "close"] });
          }
          activatedSessions.add(context.sessionID);
          if (args.action === "start") {
            const startInput = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "action"));
            try {
              return jsonResult(await startAgent(startInput, { contextDirectory: context.directory }));
            } catch (error) {
              failWith(error, "START_FAILED");
            }
          }
          if (args.action === "peers") {
            try {
              return jsonResult(await listPeers());
            } catch (error) {
              failWith(error, "NOT_IN_HERDR");
            }
          }
          if (args.action === "send") {
            if (typeof args.to !== "string" || args.to === "") {
              failWith(new HerdrLinkError("SEND_FAILED", '"to" must be a non-empty string'), "SEND_FAILED");
            }
            if (typeof args.message !== "string" || args.message === "") {
              failWith(new HerdrLinkError("SEND_FAILED", '"message" must be a non-empty string'), "SEND_FAILED");
            }
            try {
              const envelope = await sendMessage(args.to, args.message);
              return jsonResult({ status: "sent", id: envelope.id, to: envelope.to });
            } catch (error) {
              failWith(error, "SEND_FAILED");
            }
          }
          if (args.action === "close") {
            if (typeof args.agent !== "string" || args.agent === "") {
              failWith(new HerdrLinkError("CLOSE_FAILED", '"agent" must be a non-empty string'), "CLOSE_FAILED");
            }
            try {
              await closeAgentPane(args.agent);
              return jsonResult({ status: "closed", agent: args.agent });
            } catch (error) {
              failWith(error, "CLOSE_FAILED");
            }
          }
          failInvalidAction(String(args.action));
        }
      })
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (input.sessionID === void 0 || !activatedSessions.has(input.sessionID)) {
        return;
      }
      if (!output.system.includes(GATEWAY_CONTRACT)) {
        output.system.push(GATEWAY_CONTRACT);
      }
    }
  };
};
export {
  herdrLinkPlugin
};
