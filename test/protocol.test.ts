/**
 * Tests for the protocol core (src/protocol.ts).
 * Run with: node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_ID,
  HerdrLinkError,
  buildEnvelope,
  createMessageId,
  isHerdrLinkEnvelope,
  isValidAgentName,
  COMMUNICATION_CONTRACT,
  HERDR_LINK_TOOLS,
  type HerdrLinkEnvelope,
} from "../src/protocol.ts";

test("createMessageId produces unique ids with hl_ prefix", () => {
  const a = createMessageId();
  const b = createMessageId();
  assert.match(a, /^hl_[a-z0-9_]+$/);
  assert.notEqual(a, b);
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
    reply_to: "hl_abc",
    message: "检查完成。",
  });
  assert.equal(envelope.reply_to, "hl_abc");
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

test("isHerdrLinkEnvelope rejects non-envelopes", () => {
  assert.ok(!isHerdrLinkEnvelope(null));
  assert.ok(!isHerdrLinkEnvelope({ protocol: "other/1", id: "x", from: "a", to: "b", message: "m" }));
  assert.ok(!isHerdrLinkEnvelope({ protocol: PROTOCOL_ID, id: "", from: "a", to: "b", message: "m" }));
  assert.ok(!isHerdrLinkEnvelope({ protocol: PROTOCOL_ID, id: "x", from: "a", to: "b" }));
  assert.ok(!isHerdrLinkEnvelope({ protocol: PROTOCOL_ID, id: "x", from: 3, to: "b", message: "m" }));
});

test("isHerdrLinkEnvelope accepts a valid reply envelope", () => {
  const reply: HerdrLinkEnvelope = {
    protocol: PROTOCOL_ID,
    id: "hl_2",
    from: "reviewer",
    to: "brain",
    reply_to: "hl_1",
    message: "done",
  };
  assert.ok(isHerdrLinkEnvelope(reply));
});

test("COMMUNICATION_CONTRACT contains all nine rules", () => {
  for (let i = 1; i <= 9; i++) {
    assert.ok(
      COMMUNICATION_CONTRACT.includes(`${i}. `),
      `contract rule ${i} missing`,
    );
  }
  assert.ok(COMMUNICATION_CONTRACT.includes("herdr_link_peers"));
  assert.ok(COMMUNICATION_CONTRACT.includes("herdr_link_send"));
  assert.ok(COMMUNICATION_CONTRACT.includes("herdr_link_close"));
});

test("HERDR_LINK_TOOLS lists the three canonical tools", () => {
  assert.deepEqual([...HERDR_LINK_TOOLS], ["herdr_link_peers", "herdr_link_send", "herdr_link_close"]);
});

test("HerdrLinkError carries its code and a readable message", () => {
  const err = new HerdrLinkError("PEER_NOT_FOUND", "worker-x is not live");
  assert.equal(err.code, "PEER_NOT_FOUND");
  assert.equal(err.name, "HerdrLinkError");
  assert.ok(err.message.includes("PEER_NOT_FOUND"));
});