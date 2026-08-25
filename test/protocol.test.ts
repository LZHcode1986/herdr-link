/**
 * Tests for the protocol core (src/protocol.ts).
 * Run with: node --experimental-strip-types --test test/*.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PROTOCOL_ID,
  AGENT_STATES,
  HERDR_LINK_GATEWAY,
  HERDR_LINK_TOOLS,
  TOOL_CLOSE,
  TOOL_PEERS,
  TOOL_SEND,
  INBOUND_WRAPPER_MARKER,
  HerdrLinkError,
  formatAgentFacingError,
  buildEnvelope,
  buildInboundWrapper,
  extractInboundEnvelope,
  createMessageId,
  isHerdrLinkEnvelope,
  isValidAgentName,
  isValidMessageId,
  toAgentState,
  MESSAGE_ID_RE,
  COMMUNICATION_CONTRACT,
  type AgentContext,
  type HerdrLinkEnvelope,
  type PeerDirectory,
} from "../src/protocol.ts";

test("createMessageId produces unique ids with hl_ prefix", () => {
  const a = createMessageId();
  const b = createMessageId();
  assert.match(a, /^hl_[a-z0-9]+_[a-z0-9]+$/);
  assert.notEqual(a, b);
});

test("createMessageId keeps a non-empty random segment when Math.random returns zero", () => {
  const originalRandom = Math.random;
  try {
    Math.random = () => 0;
    const id = createMessageId();
    assert.ok(MESSAGE_ID_RE.test(id));
  } finally {
    Math.random = originalRandom;
  }
});

test("isValidAgentName enforces the [a-z][a-z0-9_-]{0,31} rule", () => {
  assert.ok(isValidAgentName("brain"));
  assert.ok(isValidAgentName("worker-a"));
  assert.ok(isValidAgentName("a"));
  assert.ok(!isValidAgentName("Brain"));
  assert.ok(!isValidAgentName(""));
  assert.ok(!isValidAgentName("a".repeat(33)));
  assert.ok(!isValidAgentName("1worker"));
});

test("isValidMessageId enforces the hl_<timestamp>_<random> rule", () => {
  assert.ok(isValidMessageId("hl_mep7abc_4f8k2n"));
  assert.ok(isValidMessageId("hl_0_a"));
  assert.ok(!isValidMessageId("hl_abc"));
  assert.ok(!isValidMessageId("hl_ABC_def"));
  assert.ok(!isValidMessageId("hl_abc_"));
  assert.ok(!isValidMessageId("message-id"));
});

test("buildEnvelope builds a valid envelope and assigns protocol/id/from by the adapter", () => {
  const envelope = buildEnvelope({
    from: "brain",
    to: "reviewer",
    message: "请检查这个设计。",
  });
  assert.equal(envelope.protocol, PROTOCOL_ID);
  assert.match(envelope.id, /^hl_/);
  assert.equal(envelope.from, "brain");
  assert.equal(envelope.to, "reviewer");
  assert.equal(envelope.message, "请检查这个设计。");
  assert.equal(envelope.reply_to, undefined);
  assert.ok(isHerdrLinkEnvelope(envelope));
});

test("buildEnvelope carries reply_to when provided", () => {
  const envelope = buildEnvelope({
    from: "reviewer",
    to: "brain",
    reply_to: "hl_abc_def",
    message: "检查完成。",
  });
  assert.equal(envelope.reply_to, "hl_abc_def");
});

test("buildEnvelope rejects an invalid self name with SELF_UNNAMED", () => {
  assert.throws(
    () => buildEnvelope({ from: "Not-A-Name", to: "reviewer", message: "x" }),
    (err: unknown) => err instanceof HerdrLinkError && err.code === "SELF_UNNAMED",
  );
});

test("buildEnvelope rejects an invalid target name with PEER_NOT_FOUND", () => {
  assert.throws(
    () => buildEnvelope({ from: "brain", to: "", message: "x" }),
    (err: unknown) => err instanceof HerdrLinkError && err.code === "PEER_NOT_FOUND",
  );
});

test("buildEnvelope rejects empty message with SEND_FAILED", () => {
  assert.throws(
    () => buildEnvelope({ from: "brain", to: "reviewer", message: "   " }),
    (err: unknown) => err instanceof HerdrLinkError && err.code === "SEND_FAILED",
  );
});

test("buildEnvelope rejects malformed reply_to with SEND_FAILED", () => {
  assert.throws(
    () => buildEnvelope({ from: "brain", to: "reviewer", reply_to: "hl_previous", message: "reply" }),
    (err: unknown) => err instanceof HerdrLinkError && err.code === "SEND_FAILED",
  );
});

test("isHerdrLinkEnvelope rejects non-envelopes", () => {
  assert.ok(!isHerdrLinkEnvelope(null));
  assert.ok(!isHerdrLinkEnvelope({ protocol: "other/1", id: "hl_a_b", from: "a", to: "b", message: "m" }));
  assert.ok(!isHerdrLinkEnvelope({ protocol: PROTOCOL_ID, id: "hl_bad", from: "a", to: "b", message: "m" }));
  assert.ok(!isHerdrLinkEnvelope({ protocol: PROTOCOL_ID, id: "hl_a_b", from: "Bad", to: "b", message: "m" }));
  assert.ok(!isHerdrLinkEnvelope({ protocol: PROTOCOL_ID, id: "hl_a_b", from: "a", to: "b", message: "   " }));
  assert.ok(!isHerdrLinkEnvelope({ protocol: PROTOCOL_ID, id: "hl_a_b", from: "a", to: "b", message: "m", reply_to: "hl_prev" }));
  assert.ok(!isHerdrLinkEnvelope({ protocol: PROTOCOL_ID, id: "hl_a_b", from: 3, to: "b", message: "m" }));
});

test("isHerdrLinkEnvelope accepts a valid reply envelope", () => {
  const reply: HerdrLinkEnvelope = {
    protocol: PROTOCOL_ID,
    id: "hl_2_x",
    from: "reviewer",
    to: "brain",
    reply_to: "hl_1_y",
    message: "done",
  };
  assert.ok(isHerdrLinkEnvelope(reply));
});

test("tiered naming constants expose gateway and canonical tool names", () => {
  // Tier 0 — the gateway itself.
  assert.equal(HERDR_LINK_GATEWAY, "herdr_link");
  // Tier 1 — canonical tools, each derived from the gateway namespace.
  assert.equal(TOOL_PEERS, "herdr_link_peers");
  assert.equal(TOOL_SEND, "herdr_link_send");
  assert.equal(TOOL_CLOSE, "herdr_link_close");
  assert.deepEqual([...HERDR_LINK_TOOLS], [TOOL_PEERS, TOOL_SEND, TOOL_CLOSE]);
  for (const tool of HERDR_LINK_TOOLS) {
    assert.ok(tool.startsWith(`${HERDR_LINK_GATEWAY}_`), `${tool} must live under the ${HERDR_LINK_GATEWAY} gateway`);
  }
});

test("AGENT_STATES is the closed state vocabulary and toAgentState maps onto it", () => {
  assert.deepEqual([...AGENT_STATES], ["idle", "working", "blocked", "done", "unknown"]);
  assert.equal(toAgentState("idle"), "idle");
  assert.equal(toAgentState("working"), "working");
  assert.equal(toAgentState("blocked"), "blocked");
  assert.equal(toAgentState("done"), "done");
  // Normalization and fail-closed mapping.
  assert.equal(toAgentState(" DONE "), "done");
  assert.equal(toAgentState("on_fire"), "unknown");
  assert.equal(toAgentState(42), "unknown");
  assert.equal(toAgentState(null), "unknown");
  assert.equal(toAgentState(undefined), "unknown");
});

test("PeerDirectory and AgentContext use the blueprint shapes without topology ids", () => {
  const directory: PeerDirectory = {
    self: { name: "brain", state: "idle" },
    peers: [
      { name: "worker-a", state: "working" },
      { name: "reviewer", state: "blocked" },
    ],
  };
  assert.deepEqual(directory, {
    self: { name: "brain", state: "idle" },
    peers: [
      { name: "worker-a", state: "working" },
      { name: "reviewer", state: "blocked" },
    ],
  });
  const context: AgentContext = {
    name: "brain",
    workspace_id: "ws-1",
    pane_id: "w1:p1",
    agent_status: "idle",
  };
  assert.equal(context.workspace_id, "ws-1");
  assert.equal(context.agent_status, "idle");
});

test("COMMUNICATION_CONTRACT names the gateway and all three canonical tools", () => {
  assert.ok(COMMUNICATION_CONTRACT.includes(HERDR_LINK_GATEWAY));
  for (const tool of HERDR_LINK_TOOLS) {
    assert.ok(COMMUNICATION_CONTRACT.includes(tool), `contract must mention ${tool}`);
  }
});

test("COMMUNICATION_CONTRACT states compact same-workspace send/reply/close semantics", () => {
  const lines = COMMUNICATION_CONTRACT.split("\n").filter((line) => line.trim() !== "");
  // Compact: one intro line plus the numbered rules, nothing else.
  const rules = lines.filter((line) => /^[0-9]+\. /.test(line));
  assert.equal(lines.length, rules.length + 1);
  assert.ok(rules.length >= 5 && rules.length <= 10, "contract must stay compact");

  // Same-workspace addressing…
  assert.match(COMMUNICATION_CONTRACT, /same Herdr workspace/);
  assert.match(COMMUNICATION_CONTRACT, /outside your workspace/);
  // …send/reply semantics…
  assert.match(COMMUNICATION_CONTRACT, /herdr-link\/1/);
  assert.match(COMMUNICATION_CONTRACT, /reply_to to the received "id"/);
  // …and close sequencing after a confirmed send.
  assert.match(COMMUNICATION_CONTRACT, /returns "sent"/);
  assert.match(COMMUNICATION_CONTRACT, /later tool step/);
});

test("PROTOCOL.md §3 and MCP wiring §1.1 exactly match the machine Contract source", () => {
  const protocol = readFileSync(new URL("../PROTOCOL.md", import.meta.url), "utf8");
  const docs = readFileSync(new URL("../docs/mcp-wiring.md", import.meta.url), "utf8");
  const protocolMatch = protocol.match(/## 3\. Agent Communication Contract[\s\S]*?```text\n([\s\S]*?)\n```/);
  const docsMatch = docs.match(/### 1\.1 canonical 文本[\s\S]*?```text\n([\s\S]*?)\n```/);
  assert.ok(protocolMatch?.[1], "PROTOCOL.md §3 must contain the canonical Contract block");
  assert.ok(docsMatch?.[1], "docs/mcp-wiring.md §1.1 must contain the canonical Contract block");
  assert.equal(protocolMatch[1], COMMUNICATION_CONTRACT);
  assert.equal(docsMatch[1], COMMUNICATION_CONTRACT);
});

test("buildInboundWrapper embeds the minimal envelope verbatim as the final line", () => {
  const envelope = buildEnvelope({
    from: "brain",
    to: "reviewer",
    reply_to: "hl_prev_000001",
    message: "请检查这个设计。",
  });

  const wrapper = buildInboundWrapper(envelope);

  // Self-describing header + sender + correlation guidance.
  assert.ok(wrapper.startsWith(INBOUND_WRAPPER_MARKER));
  assert.ok(wrapper.includes("From: brain"));
  assert.ok(wrapper.includes(`Message id: ${envelope.id}`));
  assert.ok(wrapper.includes(`Reply to: ${envelope.reply_to}`));
  assert.ok(wrapper.includes("active Herdr Link send capability"));
  assert.ok(wrapper.includes("envelope.from"));
  assert.ok(wrapper.includes("reply_to set to envelope.id"));
  assert.doesNotMatch(wrapper, /herdr_link_(?:peers|send|close)/);
  assert.ok(wrapper.includes("delivery metadata and is not part of the message"));

  // The outer wrapper never enters the envelope: the last line parses back
  // to exactly the minimal herdr-link/1 fields.
  const lines = wrapper.split("\n");
  const embedded = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
  assert.deepEqual(embedded, {
    protocol: PROTOCOL_ID,
    id: envelope.id,
    from: "brain",
    to: "reviewer",
    reply_to: "hl_prev_000001",
    message: "请检查这个设计。",
  });
  assert.ok(isHerdrLinkEnvelope(embedded));
});

test("buildInboundWrapper omits reply metadata for first-contact messages", () => {
  const envelope = buildEnvelope({ from: "brain", to: "reviewer", message: "hello" });
  const wrapper = buildInboundWrapper(envelope);
  assert.ok(!wrapper.includes("Reply to:"));
  assert.ok(wrapper.includes("active Herdr Link send capability"));
  assert.ok(wrapper.includes("envelope.from"));

  const lines = wrapper.split("\n");
  const embedded = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(embedded).sort(), ["from", "id", "message", "protocol", "to"]);
});

test("extractInboundEnvelope recovers the envelope from a delivery wrapper", () => {
  const envelope = buildEnvelope({
    from: "brain",
    to: "reviewer",
    reply_to: "hl_prev_000002",
    message: "hello",
  });
  assert.deepEqual(extractInboundEnvelope(buildInboundWrapper(envelope)), envelope);
});

test("extractInboundEnvelope rejects non-delivery text and picks the innermost valid envelope", () => {
  assert.equal(extractInboundEnvelope("plain prose, no delivery"), undefined);
  assert.equal(extractInboundEnvelope('{"protocol":"other/1","id":"hl_a_b","from":"a","to":"b","message":"m"}'), undefined);
  assert.equal(extractInboundEnvelope("{ not json at all }"), undefined);

  // Bottom-up scan: a later valid envelope wins over earlier noise.
  const noise = '{"protocol":"herdr-link/1","id":"hl_bad","from":"a","to":"b","message":"m"}';
  const valid = buildEnvelope({ from: "brain", to: "reviewer", message: "real" });
  const mixed = `noise\n${noise}\nsome log line\n${buildInboundWrapper(valid)}`;
  assert.deepEqual(extractInboundEnvelope(mixed), valid);
});

test("HerdrLinkError carries its code and a readable message", () => {
  const err = new HerdrLinkError("PEER_NOT_FOUND", "worker-x is not live");
  assert.equal(err.code, "PEER_NOT_FOUND");
  assert.equal(err.name, "HerdrLinkError");
  assert.ok(err.message.includes("PEER_NOT_FOUND"));
});

test("formatAgentFacingError redacts raw Herdr diagnostics", () => {
  const error = new HerdrLinkError("SELF_UNNAMED", "agent target wH:p1 not found");
  assert.equal(formatAgentFacingError(error, "SELF_UNNAMED"), "SELF_UNNAMED: Herdr Link could not establish a stable Agent Name");
  assert.equal(formatAgentFacingError(new Error("pane wH:p1 failed"), "CLOSE_FAILED"), "CLOSE_FAILED: Herdr pane close failed");
});
