// Unit tests for the pure logic of the context-manager plugin packages.
// Run:  .\test\run.ps1   (direct main-process run; `node --test` spawns child
// processes whose pipes are blocked in restricted shells, so run.ps1 avoids it)
//
// The service/agent modules import @deepseek-ai packages, so this test runs
// against the INSTALLED copies in %USERPROFILE%\.dsh\profiles\node_modules
// (same sources as the workspace, synced via install.ps1).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";

const profilesNodeModules = path.join(os.homedir(), ".dsh", "profiles", "node_modules");

const servicePath = path.join(profilesNodeModules, "dsh-context-manager-service-luxi", "lib", "index.js");
const agentPath = path.join(profilesNodeModules, "dsh-context-manager-agent-luxi", "lib", "index.js");

const serviceUrl = new URL(`file://${servicePath.replace(/\\/g, "/")}`);
const agentUrl = new URL(`file://${agentPath.replace(/\\/g, "/")}`);

const { pruneRecords, renderInjectionMessage, shrinkRange, truncate: serviceTruncate, messageText, isRealUserMessage, ContextManagerService } = await import(serviceUrl.href);
const { DEFAULT_CONFIG, renderInjectedRecords, truncate } = await import(agentUrl.href);

// ── truncate ────────────────────────────────────────────────────────────────

test("truncate keeps short text unchanged", () => {
  assert.equal(truncate("你好", 10), "你好");
});

test("truncate cuts long text with ellipsis", () => {
  const out = truncate("a".repeat(50), 10);
  assert.equal(out, "a".repeat(10) + "…");
});

test("truncate respects whole-character budget", () => {
  const out = truncate("中文中文中文", 4);
  assert.equal(out, "中文中文" + "…");
});

// ── messageText ─────────────────────────────────────────────────────────────

test("messageText joins text blocks only", () => {
  const message = {
    content: [
      { type: "text", text: "第一段" },
      { type: "image", url: "x" },
      { type: "text", text: "第二段" }
    ]
  };
  assert.equal(messageText(message), "第一段\n第二段");
});

test("messageText handles null and empty", () => {
  assert.equal(messageText(null), "");
  assert.equal(messageText({ content: [] }), "");
  assert.equal(messageText({}), "");
});

// ── isRealUserMessage ───────────────────────────────────────────────────────

test("real user messages pass", () => {
  assert.equal(isRealUserMessage({ source: { kind: "user" }, content: [] }), true);
});

test("plugin snapshots are rejected", () => {
  assert.equal(isRealUserMessage({ source: { kind: "plugin", plugin: "x" }, content: [] }), false);
  assert.equal(isRealUserMessage({ source: { kind: "tool" }, content: [] }), false);
  assert.equal(isRealUserMessage(null), false);
  assert.equal(isRealUserMessage({}), false);
});

// ── pruneRecords ────────────────────────────────────────────────────────────

function rec(id, createdAt, global) {
  return { id, summary: id, createdAt, ...(global === void 0 ? {} : { global }) };
}

test("pruneRecords keeps under-cap lists untouched", () => {
  const records = [rec("a", 1), rec("b", 2)];
  assert.deepEqual(pruneRecords(records, 10), records);
});

test("pruneRecords drops oldest non-global first", () => {
  const records = [rec("a", 1), rec("b", 2), rec("c", 3)];
  const out = pruneRecords(records, 2);
  assert.deepEqual(out.map((r) => r.id), ["b", "c"]);
});

test("pruneRecords never drops global records", () => {
  const records = [rec("g1", 1, true), rec("a", 2), rec("b", 3), rec("c", 4)];
  const out = pruneRecords(records, 2);
  assert.deepEqual(out.map((r) => r.id), ["g1", "c"]);
});

test("pruneRecords keeps global records even beyond cap", () => {
  const records = [rec("g1", 1, true), rec("g2", 2, true), rec("a", 3)];
  const out = pruneRecords(records, 1);
  assert.deepEqual(out.map((r) => r.id), ["g1", "g2"]);
});

// ── config defaults ─────────────────────────────────────────────────────────

test("agent default config exposes injection budgets", () => {
  assert.equal(typeof DEFAULT_CONFIG.maxInjected, "number");
  assert.equal(typeof DEFAULT_CONFIG.maxGlobalInjected, "number");
  assert.equal(typeof DEFAULT_CONFIG.maxCharsPerRecord, "number");
});

test("service config owns the summarize toggle", () => {
  const result = ContextManagerService.Config["~standard"].validate({});
  assert.equal(typeof result.value.summarize, "boolean");
  assert.equal(typeof result.value.maxSummaryChars, "number");
  assert.equal(typeof result.value.summarizeTimeoutMs, "number");
  assert.equal(result.issues, void 0);
});

// ── renderInjectedRecords ────────────────────────────────────────────────────

const renderCfg = { maxInjected: 5, maxGlobalInjected: 3, maxCharsPerRecord: 200 };

test("renderInjectedRecords renders nothing when both lists are empty", () => {
  assert.equal(renderInjectedRecords([], [], renderCfg), "");
});

test("renderInjectedRecords renders numbered priority records", () => {
  const out = renderInjectedRecords([{ summary: "甲" }, { summary: "乙" }], [], renderCfg);
  assert.ok(out.startsWith("Context-manager priority records"));
  assert.ok(out.includes("1. 甲"));
  assert.ok(out.includes("2. 乙"));
});

test("renderInjectedRecords puts global records after priority records", () => {
  const out = renderInjectedRecords([{ summary: "会话" }], [{ summary: "置顶" }], renderCfg);
  const priority = out.indexOf("priority records");
  const global = out.indexOf("global records");
  assert.ok(priority !== -1 && global !== -1);
  assert.ok(priority < global);
  assert.ok(out.includes("1. 置顶"));
});

test("renderInjectedRecords respects the per-record budget", () => {
  const out = renderInjectedRecords([{ summary: "长".repeat(300) }], [], { ...renderCfg, maxCharsPerRecord: 10 });
  assert.ok(out.includes("长".repeat(10) + "…"));
});

test("renderInjectedRecords caps injected counts", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ summary: `r${i}` }));
  const out = renderInjectedRecords(many, many, { ...renderCfg, maxInjected: 2, maxGlobalInjected: 1 });
  assert.ok(out.includes("1. r0"));
  assert.ok(out.includes("2. r1"));
  assert.ok(!out.includes("3. r2"));
  assert.ok(!out.includes("r9"));
});

// ── renderInjectionMessage (service: real-message injection block) ─────────

const injectCfg = { maxInjected: 5, maxGlobalInjected: 3, maxCharsPerRecord: 200, maxInjectionChars: 800 };

test("renderInjectionMessage returns null when there is nothing to inject", () => {
  assert.equal(renderInjectionMessage([], [], "", injectCfg), null);
  assert.equal(renderInjectionMessage([], [], "   ", injectCfg), null);
});

test("renderInjectionMessage includes session records, globals and custom text", () => {
  const out = renderInjectionMessage([{ summary: "会话甲" }], [{ summary: "置顶乙" }], "自定义规则", injectCfg);
  const text = out.content[0].text;
  assert.ok(text.includes("本会话记录"));
  assert.ok(text.includes("1. 会话甲"));
  assert.ok(text.includes("跨会话置顶"));
  assert.ok(text.includes("1. 置顶乙"));
  assert.ok(text.includes("自定义注入"));
  assert.ok(text.includes("自定义规则"));
  assert.ok(out.content.length === 1 && out.content[0].type === "text");
});

test("renderInjectionMessage respects the total budget", () => {
  const long = "长".repeat(200);
  const out = renderInjectionMessage([{ summary: long }], [], "", { ...injectCfg, maxInjectionChars: 50 });
  assert.ok(out.content[0].text.length <= 51);
  assert.ok(out.content[0].text.endsWith("…"));
});

test("renderInjectionMessage never squeezes out the custom injection (#1)", () => {
  const long = "长".repeat(200);
  const out = renderInjectionMessage([{ summary: long }, { summary: long }, { summary: long }], [], "人设规则", { ...injectCfg, maxInjectionChars: 400 });
  const text = out.content[0].text;
  assert.ok(text.includes("自定义注入"));
  assert.ok(text.includes("人设规则"));
  assert.ok(text.length <= 400 + 4);
});

// ── shrinkRange (#11) ────────────────────────────────────────────────────────

test("shrinkRange keeps intact ranges unchanged", () => {
  const surface = [10, 20, 30];
  assert.deepEqual(shrinkRange(surface, 20, 30), { startSeq: 20, endSeq: 30 });
});

test("shrinkRange snaps removed endpoints onto nearest survivors", () => {
  const surface = [10, 20, 30, 40];
  assert.deepEqual(shrinkRange(surface, 25, 35), { startSeq: 30, endSeq: 30 });
});

test("shrinkRange returns null when the whole span is gone", () => {
  const surface = [10, 20];
  assert.equal(shrinkRange(surface, 30, 40), null);
});

test("service truncate matches agent truncate semantics", () => {
  assert.equal(serviceTruncate("你好", 10), "你好");
  assert.equal(serviceTruncate("a".repeat(50), 10), "a".repeat(10) + "…");
});
