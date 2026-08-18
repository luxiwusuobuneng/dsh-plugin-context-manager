// dsh-context-manager-service — host-plane Remote service.
//
// Owns the durable per-session conversation records. The service lives on the
// HOST plane (like goals / messageFeedback) because the browser's Remote
// gateway resolves receiver Services from the host root; the per-session
// recording and prompt injection live in the agent preset row, which consumes
// this service through ctx.get('contextManager').
//
// The browser calls the Remote methods directly through the gateway's SRC
// path: connection.rpc.call('/api', 'contextManager/list', { args: {...} }).
// Parameter names below ARE the wire names — keep them simple identifiers.

import { randomUUID } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { deriveEventMessage } from "@deepseek-ai/dsh-session/surface";
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from "@deepseek-ai/dsh-compaction";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { z } from "zod";

// ── durable domain ──────────────────────────────────────────────────────────

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** One stored record: a summary, a brief description, and its creation time. */
const contextManagerRecordSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1),
  description: z.string().optional(),
  /** Cross-session pin: injected into every session's prompt, never auto-pruned. */
  global: z.boolean().optional(),
  /** The model-visible conversation range this record summarizes (surface seqs). */
  startSeq: z.number().int().nonnegative().optional(),
  endSeq: z.number().int().nonnegative().optional(),
  createdAt: nonNegativeSafeInteger
});

/** One whole-Session sidecar row, keyed by session id. */
const contextManagerRowSchema = z.object({
  session: z.object({
    createdAt: nonNegativeSafeInteger,
    cwd: z.string().optional()
  }),
  records: z.array(contextManagerRecordSchema),
  /** Custom text the user wants injected into every model step's real message stream. */
  injectionText: z.string().optional(),
  /** Durable queued fold (survives restart until executed at the next pre-step). */
  pendingFold: z.object({
    requestId: z.string().min(1),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative()
  }).optional(),
  /** Durable fold audit trail (survives restart). */
  foldHistory: z.array(z.object({
    at: nonNegativeSafeInteger,
    startSeq: z.number().int().nonnegative().optional(),
    endSeq: z.number().int().nonnegative().optional(),
    auto: z.boolean().optional()
  })).optional(),
  /** Durable latest fold status, including failure reasons (survives restart). */
  foldStatus: z.object({
    status: z.enum(["none", "queued", "running", "done", "failed"]),
    requestId: z.string().min(1).optional(),
    message: z.string().optional(),
    at: nonNegativeSafeInteger
  }).optional(),
  /** Runtime-tunable injection settings (overrides the static plugin config). */
  settings: z.object({
    maxInjected: z.number().int().min(0).max(100).optional(),
    maxGlobalInjected: z.number().int().min(0).max(100).optional(),
    maxInjectionChars: z.number().int().min(1).max(20000).optional(),
    maxCharsPerRecord: z.number().int().min(1).max(2000).optional(),
    maxRecordsPerSession: z.number().int().min(1).max(10000).optional(),
    injectIntoMessages: z.boolean().optional()
  }).optional()
});

/** Row key holding the runtime injection settings (not a real session id). */
const SETTINGS_KEY = "__settings";

const contextManagerDomainSpec = defineDomain({
  name: "context_manager",
  version: 0,
  tables: { sessions: domainTable(contextManagerRowSchema) }
});

// ── pure helpers (unit-testable) ────────────────────────────────────────────

/**
 * Prune a records array to `cap`: drop the oldest non-global records first.
 * Pinned (global) records always survive. Returns the pruned array.
 */
function pruneRecords(records, cap) {
  if (records.length <= cap) return records;
  const overflow = records.length - cap;
  const doomed = new Set(
    records.filter((candidate) => candidate.global !== true)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, overflow)
      .map((candidate) => candidate.id)
  );
  return records.filter((candidate) => !doomed.has(candidate.id));
}

/**
 * Shrink a record's conversation range onto the closest surviving surface
 * seqs after a fold removed part of it (#11). Returns null when no sensible
 * range remains (the whole span was folded away).
 */
function shrinkRange(surface, startSeq, endSeq) {
  if (surface.includes(startSeq) && surface.includes(endSeq)) return { startSeq, endSeq };
  const sorted = [...surface].sort((a, b) => a - b);
  let start = startSeq;
  let end = endSeq;
  if (!surface.includes(startSeq)) {
    const next = sorted.find((seq) => seq >= startSeq);
    if (next === void 0) return null;
    start = next;
  }
  if (!surface.includes(endSeq)) {
    const below = sorted.filter((seq) => seq <= endSeq);
    const last = below.length > 0 ? below[below.length - 1] : void 0;
    if (last === void 0 || last < start) return null;
    end = last;
  }
  if (start > end) return null;
  return { startSeq: start, endSeq: end };
}

/** Reject after `ms` milliseconds if `promise` does not settle first. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时(${Math.round(ms / 1000)}s)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Split an arbitrary user-selected [start, end] range into balanced segments
 * the compaction engine will accept: each segment starts on a
 * tool-pairing-balanced "before" cut and ends on a balanced "after" cut, so
 * tool-call/result pairs are never split and open steps are never touched.
 * Adjacent segments chain cleanly (an "after" cut equals the next node's
 * "before" cut). Each segment spans at most `maxNodesPerSegment` nodes so one
 * compaction never chews more than the engine can safely summarize; the
 * unbalanced tail is reported via `remaining`.
 */
function splitBalancedSegments(nodes, beforeBalanced, afterBalanced, startSeq, endSeq, maxSegments, maxNodesPerSegment) {
  const limit = Number.isInteger(maxNodesPerSegment) && maxNodesPerSegment > 0 ? maxNodesPerSegment : 20;
  const slice = nodes.filter((seq) => seq >= startSeq && seq <= endSeq);
  if (slice.length === 0) return { segments: [], remaining: 0, reason: "所选范围已不在真实对话中" };
  const segments = [];
  let cursor = 0;
  let covered = 0;
  while (cursor < slice.length && segments.length < maxSegments) {
    // Advance to the first node whose leading cut is balanced.
    while (cursor < slice.length && !beforeBalanced(slice[cursor])) cursor += 1;
    if (cursor >= slice.length) break;
    const windowEnd = Math.min(slice.length - 1, cursor + limit - 1);
    // Prefer the LAST balanced trailing cut inside the window (bigger spans,
    // fewer compactions), scanning backwards.
    let endIndex = -1;
    for (let index = windowEnd; index >= cursor; index -= 1) {
      if (afterBalanced(slice[index])) {
        endIndex = index;
        break;
      }
    }
    if (endIndex === -1) {
      // No cut inside the window can close a segment: drop the start node.
      cursor += 1;
      continue;
    }
    segments.push({ start: slice[cursor], end: slice[endIndex] });
    covered += endIndex - cursor + 1;
    cursor = endIndex + 1;
  }
  const remaining = slice.length - covered;
  return { segments, remaining: Math.max(0, remaining) };
}

/**
 * Read an optional service WITHOUT declaring it in `inject`. In this Cordis
 * fork `ctx.get()` reads the shared root store directly (inject only gates
 * activation timing), and the property accessor is the fallback that throws
 * when nothing is available. Either path resolving means the service exists
 * in this isolate chain; otherwise we degrade instead of blocking activation.
 */
function readService(ctx, name) {
  try {
    const value = ctx.get(name);
    if (value !== void 0) return value;
  } catch {
    // fall through to the property accessor
  }
  try {
    return ctx[name];
  } catch {
    return void 0;
  }
}

/** Join the text blocks of a message. */
function messageText(message) {
  if (message === null || message === void 0) return "";
  const blocks = message.content ?? [];
  let text = "";
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") text += block.text + "\n";
  }
  return text.trim();
}

/** Truncate to a whole-character budget. */
function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "…";
}

/**
 * Only real user input is recorded: the runtime also emits synthetic
 * user/message events (the system-prompt snapshot that carries the injected
 * context-manager records, sandbox and approval policy). Those are identified
 * by `source.kind !== "user"` and must not pollute the records.
 */
function isRealUserMessage(message) {
  return message !== null && typeof message === "object" &&
    message.source !== null && typeof message.source === "object" &&
    message.source.kind === "user";
}

/**
 * Resolve the LLM route the exchange should be summarized with: the agent's
 * default model selection when available, otherwise undefined (caller falls
 * back to truncation).
 */
function resolveSummarizeRoute(ctx) {
  try {
    const defaultModel = readService(ctx, "agentDefaultModel");
    const selection = defaultModel?.currentSelection?.();
    if (selection !== void 0 && typeof selection.provider === "string" && typeof selection.model === "string") {
      return { provider: selection.provider, model: selection.model };
    }
  } catch {
    // no route service on this plane — truncation fallback
  }
  return void 0;
}

/**
 * Condense one exchange through the LLM route. Resolves to
 * { summary, description } or rejects; the caller falls back to truncation.
 *
 * Hard timeout: the LLM stream must settle within summarizeTimeoutMs or the
 * whole attempt rejects. Without this race a hung stream would leave the
 * caller's promise pending forever and the exchange would never be recorded.
 */
async function summarizeExchange(ctx, userText, assistantText, cfg) {
  const route = resolveSummarizeRoute(ctx);
  if (route === void 0) throw new Error("context-manager: no LLM route available for summarization");
  const input = [
    `用户: ${userText}`,
    `助手: ${assistantText}`
  ].join("\n").slice(0, cfg.summarizeMaxInputChars);
  const system = [
    "You condense one AI-assistant conversation exchange into exactly two plain-text fields.",
    "输出两行：",
    "第一行【总结】: 对话的核心结论/做了什么（中文，2-3 句话，不加引号）。",
    "第二行【描述】: 这次对话的简要描述（中文，一句话，不加引号）。",
    "只输出这两行，不要任何前缀、编号、Markdown 或解释。"
  ].join("\n");
  const message = createUserMessage({
    content: [{ type: "text", text: `请总结下面这段对话：\n${input}` }],
    source: { kind: "plugin", plugin: "dsh-context-manager-service" }
  });
  const llm = readService(ctx, "llm");
  if (llm === void 0) throw new Error("context-manager: llm service unavailable");
  const signal = AbortSignal.timeout(cfg.summarizeTimeoutMs);
  const options = {
    provider: route.provider,
    model: route.model,
    messages: [message],
    system,
    maxTokens: cfg.summarizeMaxOutputTokens,
    signal
  };
  const assemble = async () => {
    const assembler = new BlockAssembler();
    for await (const chunk of llm.stream(options)) {
      assembler.push(chunk);
    }
    return assembler;
  };
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`context-manager: summarize timed out after ${cfg.summarizeTimeoutMs}ms`)), cfg.summarizeTimeoutMs);
  });
  const assembler = await Promise.race([assemble(), timeout]).finally(() => clearTimeout(timer));
  const finish = assembler.finish;
  if (finish.kind !== "stop") {
    throw new Error(`context-manager: summarize stream ended with ${finish.kind}${finish.kind === "error" || finish.kind === "aborted" ? `: ${finish.failure.message}` : ""}`);
  }
  const text = assembler.blocks()
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const summaryLine = lines.find((line) => line.startsWith("总结")) ?? lines[0] ?? "";
  const descriptionLine = lines.find((line) => line.startsWith("描述")) ?? lines[1] ?? "";
  const summary = (summaryLine.includes(":") ? summaryLine.slice(summaryLine.indexOf(":") + 1) : summaryLine).trim();
  const description = (descriptionLine.includes(":") ? descriptionLine.slice(descriptionLine.indexOf(":") + 1) : descriptionLine).trim();
  if (summary.length === 0) throw new Error("context-manager: summarize produced no summary");
  return { summary: truncate(summary, cfg.maxSummaryChars), description: truncate(description, cfg.maxDescriptionChars) };
}

/**
 * Render the real-message injection block from the service's own reads: the
 * session's priority records, the cross-session pins, and the custom
 * injection text. Pure — the pre-step executor calls this inside its
 * try/catch and skips the step entirely when it returns null.
 */
function renderInjectionMessage(records, globalRecords, injectionText, cfg) {
  // Budget allocation (#1): the custom injection text must never be squeezed
  // out by long record lists. Reserve at least maxCharsPerRecord — and up to
  // half the total budget — for it FIRST; the records + pins share the rest.
  const customText = typeof injectionText === "string" ? injectionText.trim() : "";
  const customBudget = Math.max(cfg.maxCharsPerRecord, Math.floor(cfg.maxInjectionChars / 2));
  const customPart = customText.length > 0
    ? `【上下文管理·自定义注入】\n${truncate(customText, customBudget)}`
    : "";
  const remaining = Math.max(0, cfg.maxInjectionChars - customPart.length);
  const parts = [];
  const sessionLines = (records ?? []).slice(0, cfg.maxInjected).map((record, index) => {
    return `${index + 1}. ${truncate(record.summary, cfg.maxCharsPerRecord)}`;
  });
  const globalLines = (globalRecords ?? []).slice(0, cfg.maxGlobalInjected).map((record, index) => {
    return `${index + 1}. ${truncate(record.summary, cfg.maxCharsPerRecord)}`;
  });
  if (sessionLines.length > 0) {
    parts.push(`【上下文管理·本会话记录】\n${sessionLines.join("\n")}`);
  }
  if (globalLines.length > 0) {
    parts.push(`【上下文管理·跨会话置顶】\n${globalLines.join("\n")}`);
  }
  let head = parts.join("\n\n");
  if (head.length > remaining) {
    head = truncate(head, remaining);
  }
  const joined = [head.length > 0 ? head : null, customPart.length > 0 ? customPart : null]
    .filter((part) => part !== null)
    .join("\n\n");
  if (joined.length === 0) return null;
  return createUserMessage({
    content: [{ type: "text", text: joined }],
    source: { kind: "plugin", plugin: "dsh-context-manager-service" }
  });
}

// ── TS decorator emit helpers (plain-JS replication, see dsh-message-feedback) ──

var __runInitializers = function (thisArg, initializers, value) {
  var useValue = arguments.length > 2;
  for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
  return useValue ? value : void 0;
};

var __esDecorate = function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
  function accept(f) {
    if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
    return f;
  }
  var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
  var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
  var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
  var _, done = false;
  for (var i = decorators.length - 1; i >= 0; i--) {
    var context = {};
    for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
    for (var p in contextIn.access) context.access[p] = contextIn.access[p];
    context.addInitializer = function (f) {
      if (done) throw new TypeError("Cannot add initializers after decoration has completed");
      extraInitializers.push(accept(f || null));
    };
    var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
    if (kind === "accessor") {
      if (result === void 0) continue;
      if (result === null || typeof result !== "object") throw new TypeError("Object expected");
      if (_ = accept(result.get)) descriptor.get = _;
      if (_ = accept(result.set)) descriptor.set = _;
      if (_ = accept(result.init)) initializers.unshift(_);
    } else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
    else descriptor[key] = _;
  }
  if (target) Object.defineProperty(target, contextIn.name, descriptor);
  done = true;
};

// ── the service ─────────────────────────────────────────────────────────────

let ContextManagerService = (() => {
  let _classSuper = TypertRemoteService;
  let _instanceExtraInitializers = [];
  let _list_decorators;
  let _remove_decorators;
  let _reorder_decorators;
  let _record_decorators;
  let _count_decorators;
  let _update_decorators;
  let _setGlobal_decorators;
  let _clear_decorators;
  let _listGlobal_decorators;
  let _compact_decorators;
  let _conversationList_decorators;
  let _foldRange_decorators;
  let _foldStatus_decorators;
  let _setInjectionText_decorators;
  let _getInjectionText_decorators;
  let _getSettings_decorators;
  let _setSettings_decorators;
  let _clearAll_decorators;
  let _previewInjection_decorators;
  let _foldHistory_decorators;
  return class ContextManagerService extends _classSuper {
    static {
      const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
      _list_decorators = [Remote("list")];
      _remove_decorators = [Remote("remove")];
      _reorder_decorators = [Remote("reorder")];
      _record_decorators = [Remote("record")];
      _count_decorators = [Remote("count")];
      _update_decorators = [Remote("update")];
      _setGlobal_decorators = [Remote("setGlobal")];
      _clear_decorators = [Remote("clear")];
      _listGlobal_decorators = [Remote("listGlobal")];
      _compact_decorators = [Remote("compact")];
      _conversationList_decorators = [Remote("conversationList")];
      _foldRange_decorators = [Remote("foldRange")];
      _foldStatus_decorators = [Remote("foldStatus")];
      _setInjectionText_decorators = [Remote("setInjectionText")];
      _getInjectionText_decorators = [Remote("getInjectionText")];
      _getSettings_decorators = [Remote("getSettings")];
      _setSettings_decorators = [Remote("setSettings")];
      _clearAll_decorators = [Remote("clearAll")];
      _previewInjection_decorators = [Remote("previewInjection")];
      _foldHistory_decorators = [Remote("foldHistory")];
      __esDecorate(this, null, _list_decorators, {
        kind: "method", name: "list", static: false, private: false,
        access: { has: (obj) => "list" in obj, get: (obj) => obj.list },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _remove_decorators, {
        kind: "method", name: "remove", static: false, private: false,
        access: { has: (obj) => "remove" in obj, get: (obj) => obj.remove },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _reorder_decorators, {
        kind: "method", name: "reorder", static: false, private: false,
        access: { has: (obj) => "reorder" in obj, get: (obj) => obj.reorder },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _record_decorators, {
        kind: "method", name: "record", static: false, private: false,
        access: { has: (obj) => "record" in obj, get: (obj) => obj.record },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _count_decorators, {
        kind: "method", name: "count", static: false, private: false,
        access: { has: (obj) => "count" in obj, get: (obj) => obj.count },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _update_decorators, {
        kind: "method", name: "update", static: false, private: false,
        access: { has: (obj) => "update" in obj, get: (obj) => obj.update },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _setGlobal_decorators, {
        kind: "method", name: "setGlobal", static: false, private: false,
        access: { has: (obj) => "setGlobal" in obj, get: (obj) => obj.setGlobal },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _clear_decorators, {
        kind: "method", name: "clear", static: false, private: false,
        access: { has: (obj) => "clear" in obj, get: (obj) => obj.clear },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _listGlobal_decorators, {
        kind: "method", name: "listGlobal", static: false, private: false,
        access: { has: (obj) => "listGlobal" in obj, get: (obj) => obj.listGlobal },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _compact_decorators, {
        kind: "method", name: "compact", static: false, private: false,
        access: { has: (obj) => "compact" in obj, get: (obj) => obj.compact },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _conversationList_decorators, {
        kind: "method", name: "conversationList", static: false, private: false,
        access: { has: (obj) => "conversationList" in obj, get: (obj) => obj.conversationList },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _foldRange_decorators, {
        kind: "method", name: "foldRange", static: false, private: false,
        access: { has: (obj) => "foldRange" in obj, get: (obj) => obj.foldRange },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _foldStatus_decorators, {
        kind: "method", name: "foldStatus", static: false, private: false,
        access: { has: (obj) => "foldStatus" in obj, get: (obj) => obj.foldStatus },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _setInjectionText_decorators, {
        kind: "method", name: "setInjectionText", static: false, private: false,
        access: { has: (obj) => "setInjectionText" in obj, get: (obj) => obj.setInjectionText },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _getInjectionText_decorators, {
        kind: "method", name: "getInjectionText", static: false, private: false,
        access: { has: (obj) => "getInjectionText" in obj, get: (obj) => obj.getInjectionText },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _getSettings_decorators, {
        kind: "method", name: "getSettings", static: false, private: false,
        access: { has: (obj) => "getSettings" in obj, get: (obj) => obj.getSettings },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _setSettings_decorators, {
        kind: "method", name: "setSettings", static: false, private: false,
        access: { has: (obj) => "setSettings" in obj, get: (obj) => obj.setSettings },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _clearAll_decorators, {
        kind: "method", name: "clearAll", static: false, private: false,
        access: { has: (obj) => "clearAll" in obj, get: (obj) => obj.clearAll },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _previewInjection_decorators, {
        kind: "method", name: "previewInjection", static: false, private: false,
        access: { has: (obj) => "previewInjection" in obj, get: (obj) => obj.previewInjection },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _foldHistory_decorators, {
        kind: "method", name: "foldHistory", static: false, private: false,
        access: { has: (obj) => "foldHistory" in obj, get: (obj) => obj.foldHistory },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      if (_metadata) Object.defineProperty(this, Symbol.metadata, {
        enumerable: true, configurable: true, writable: true, value: _metadata
      });
    }
    // `compaction` is deliberately NOT injected: it is an OPTIONAL host
    // capability (the trigger-free `compaction-passive` root row). Keeping it
    // out of inject means the service activates and records even when the row
    // is absent — the boot-time `pending (waiting for service: compaction)`
    // lockout cannot recur. Callers read it through readService() at call
    // time and degrade the compact/fold endpoints with a clear error.
    static inject = ["storageDomain", "sessions", "agents"];

    static Config = s.object({
      /** Per-session record cap; the oldest non-global records are pruned past it. */
      maxRecordsPerSession: s.number().step(1).min(1).default(200),
      /** Inject pinned records + custom text into the REAL message stream of every model step (pre-step). */
      injectIntoMessages: s.boolean().default(true),
      /** Total character budget for the injected real-message block. */
      maxInjectionChars: s.number().step(1).min(1).default(800),
      /** Records rendered into the injected block: session / global / per-record budgets. */
      maxInjected: s.number().step(1).min(0).default(5),
      maxGlobalInjected: s.number().step(1).min(0).default(3),
      maxCharsPerRecord: s.number().step(1).min(1).default(200),
      /** Condense each exchange through the LLM route (true) or truncate (false). */
      summarize: s.boolean().default(false),
      maxSummaryChars: s.number().step(1).min(1).default(400),
      maxDescriptionChars: s.number().step(1).min(1).default(200),
      summarizeTimeoutMs: s.number().step(1).min(1).default(20000),
      summarizeMaxInputChars: s.number().step(1).min(1).default(6000),
      summarizeMaxOutputTokens: s.number().step(1).min(1).default(300)
    });

    table;
    /** Validated plugin config, supplied as the class-plugin constructor's second argument. */
    config;
    /** Queued user-selected range folds per session, executed at the next pre-step. */
    pendingFolds = new Map();
    /** Latest fold outcome per session, surfaced to the browser. */
    foldStatuses = new Map();
    /** One in-flight user turn per session: user text + accumulated assistant text. */
    pendingExchanges = new Map();
    /** Recent fold audit trail per session (time + folded seq range). */
    foldHistorys = new Map();

    constructor(ctx, config) {
      super(ctx, "contextManager");
      this.config = config ?? {};
      __runInitializers(this, _instanceExtraInitializers);
    }

    /** Open and own the one context-manager sidecar domain. */
    async [Service.init]() {
      const domain = await this.ctx.storageDomain.open(contextManagerDomainSpec);
      this.ctx.effect(() => async () => {
        await domain.close();
      }, "context-manager.domainClose");
      this.table = domain.table("sessions");
      // Serialized put chain: concurrent status/history/records writes never
      // interleave; each write snapshots the latest row.
      this.putChain = Promise.resolve();

      // Restore durable fold state (#4): queued folds and the audit trail
      // survive restarts. pendingFolds/foldStatuses/foldHistorys are memory
      // maps seeded from the stored rows.
      try {
        for (const [sessionId, row] of this.table.entries()) {
          if (sessionId === SETTINGS_KEY) continue;
          if (row.pendingFold !== void 0 && typeof row.pendingFold.requestId === "string") {
            this.pendingFolds.set(sessionId, { requestId: row.pendingFold.requestId, start: row.pendingFold.start, end: row.pendingFold.end });
            this.foldStatuses.set(sessionId, { status: "queued", requestId: row.pendingFold.requestId, at: Date.now() });
          } else if (row.foldStatus !== void 0 && row.foldStatus.status !== "none") {
            // Persisted done/failed status survives the restart (diagnosis).
            this.foldStatuses.set(sessionId, { ...row.foldStatus });
          }
          if (Array.isArray(row.foldHistory) && row.foldHistory.length > 0) {
            this.foldHistorys.set(sessionId, row.foldHistory.slice(-20));
          }
        }
      } catch (error) {
        this.ctx.logger.warn(`context-manager: fold state restore failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      // One root-plane pre-step listener for the "control the actual
      // conversation text" features:
      //   1. executes any queued user-selected range fold through the host
      //      compaction engine (compactRegion requires an open turn, so the
      //      next conversation is when it runs);
      //   2. injects the pinned records + custom text into the REAL message
      //      stream of every model step (prepended before the user input).
      // Runs for every agent step of every session; must never break a turn.
      this.ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
        const sessionId = agent?.session?.id;
        if (typeof sessionId === "string") {
          try {
            const pending = this.takePendingFold(sessionId);
            if (pending !== void 0) {
              const compaction = readService(this.ctx, "compaction");
              if (compaction === void 0) {
                this.reportFoldResult(sessionId, pending.requestId, new Error("compaction 服务不可用(根平面未挂载被动压缩实例)"));
              } else {
                // Mark running (persisted) and execute in the BACKGROUND: a
                // slow/failed compaction must never stall the conversation
                // turn. Status + failure reasons are persisted either way.
                this.foldStatuses.set(sessionId, { status: "running", requestId: pending.requestId, at: Date.now() });
                void this.persistFoldStatus(sessionId);
                void this.executeFoldSegments(sessionId, pending, compaction, agent, signal)
                  .catch((error) => this.reportFoldResult(sessionId, pending.requestId, error));
              }
            }
          } catch (error) {
            this.ctx.logger.warn(`context-manager: pre-step fold failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const decision = await next();
        if (this.effectiveConfig().injectIntoMessages && decision?.kind !== "reject" && typeof sessionId === "string") {
          try {
            const injected = this.buildInjectionMessage(sessionId);
            if (injected !== null && Array.isArray(decision.messages)) {
              return { ...decision, messages: [injected, ...decision.messages] };
            }
          } catch (error) {
            this.ctx.logger.warn(`context-manager: message injection skipped: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return decision;
      });

      // GLOBAL recording: every ROOT session's TURN is recorded as ONE record
      // here (the old agent-preset row recorded only its own session; the
      // service covers every preset). Subagent/workflow children keep their
      // logs but produce no context records. `summarize: true` condenses each
      // turn through the LLM route; any failure falls back to truncation.
      //
      // Granularity: one record per user turn, NOT per assistant message. A
      // turn with tool calls emits many assistant/message events (each step's
      // text); they are accumulated into one pending exchange and flushed at
      // turn/end (or at the next user message / disposal).
      this.ctx.on("session/event", (session, event) => {
        try {
          if (event.type === "user/message") {
            const message = deriveEventMessage(event);
            if (!isRealUserMessage(message)) return;
            const text = messageText(message);
            if (text.length === 0) return;
            this.flushExchange(session.id);
            this.pendingExchanges.set(session.id, {
              userText: text,
              userSeq: typeof event.seq === "number" ? event.seq : void 0,
              assistantTexts: [],
              endSeq: void 0
            });
            return;
          }
          if (event.type === "turn/end") {
            this.flushExchange(session.id);
            return;
          }
          if (event.type !== "assistant/message") return;
          if (!this.isRootSession(session.id)) return;
          const message = deriveEventMessage(event);
          const assistantText = messageText(message);
          if (assistantText.length === 0) return;
          const pending = this.pendingExchanges.get(session.id);
          if (pending === void 0) return;
          pending.assistantTexts.push(assistantText);
          if (typeof event.seq === "number") pending.endSeq = event.seq;
        } catch (error) {
          this.ctx.logger.warn(`context-manager: recording listener failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      this.ctx.on("session/disposed", (session) => {
        this.flushExchange(session.id);
        this.pendingExchanges.delete(session.id);
      });
    }

    /**
     * Flush one session's pending exchange (one user turn) into a record, if
     * it accumulated any assistant text. Called on turn/end, on the next user
     * message, and on disposal. Always safe to call; never throws.
     */
    flushExchange(sessionId) {
      const pending = this.pendingExchanges.get(sessionId);
      if (pending === void 0) return;
      this.pendingExchanges.delete(sessionId);
      const assistantText = pending.assistantTexts.join("\n").trim();
      if (assistantText.length === 0) return;
      const startSeq = pending.userSeq;
      const endSeq = pending.endSeq;
      const recordFallback = (error) => {
        this.ctx.logger.warn(`context-manager: failed to record exchange: ${error instanceof Error ? error.message : String(error)}`);
      };
      if (this.config.summarize) {
        summarizeExchange(this.ctx, pending.userText, assistantText, this.config)
          .then(({ summary, description }) => this.record(sessionId, summary, description, startSeq, endSeq))
          .then(() => {
            this.ctx.logger.info("context-manager: recorded LLM-summarized turn");
          })
          .catch((error) => {
            const summary = truncate(assistantText, this.config.maxSummaryChars);
            const description = truncate(pending.userText, this.config.maxDescriptionChars);
            return this.record(sessionId, summary, description, startSeq, endSeq).catch(recordFallback);
          });
      } else {
        const summary = truncate(assistantText, this.config.maxSummaryChars);
        const description = truncate(pending.userText, this.config.maxDescriptionChars);
        this.record(sessionId, summary, description, startSeq, endSeq).catch(recordFallback);
      }
    }

    // ── internal (non-Remote) synchronous reads for prompt injection ─────────

    /**
     * Synchronous peek of one session's records in stored priority order
     * (index 0 = most important). The agent preset row calls this from the
     * systemPrompt context text function, which must return synchronously.
     */
    peekRecords(sessionId) {
      if (this.table === void 0) return [];
      const row = this.table.get(sessionId);
      if (row === void 0) return [];
      return row.records.map((record) => {
        const out = {
          id: record.id,
          summary: record.summary,
          description: record.description ?? "",
          global: record.global === true,
          createdAt: record.createdAt
        };
        // Only attach the conversation range when it exists: the gateway's
        // JSON boundary rejects keys whose value is undefined.
        if (typeof record.startSeq === "number") out.startSeq = record.startSeq;
        if (typeof record.endSeq === "number") out.endSeq = record.endSeq;
        return out;
      });
    }

    /**
     * Synchronous peek of every cross-session pinned record, newest first.
     * Used by the prompt injection to keep global context in front of every
     * session without any per-session ownership.
     */
    peekGlobalRecords() {
      if (this.table === void 0) return [];
      const out = [];
      for (const [sessionId, row] of this.table.entries()) {
        for (const record of row.records) {
          if (record.global !== true) continue;
          out.push({ sessionId, id: record.id, summary: record.summary, description: record.description ?? "", createdAt: record.createdAt });
        }
      }
      return out.sort((a, b) => b.createdAt - a.createdAt);
    }

    // ── Remote methods (wire names = parameter names) ───────────────────────

    /** List one session's records, stored order = priority. */
    async list(sessionId) {
      const records = this.peekRecords(sessionId);
      // Map each record's event seqs to 1-based surface positions so the UI
      // can show "对话第 X–Y 条消息" instead of raw (huge) event seqs.
      const session = this.ctx.sessions.get(sessionId);
      const surface = session?.surface?.nodes ?? [];
      for (const record of records) {
        if (typeof record.startSeq === "number" && typeof record.endSeq === "number") {
          const startIndex = surface.indexOf(record.startSeq);
          const endIndex = surface.indexOf(record.endSeq);
          if (startIndex >= 0 && endIndex >= 0) {
            record.startIndex = startIndex + 1;
            record.endIndex = endIndex + 1;
          }
        }
      }
      return { records };
    }

    /** Lightweight count for dock badges and polling. */
    async count(sessionId) {
      const records = this.peekRecords(sessionId);
      return { count: records.length };
    }

    /**
     * Delete one record by id. When `alsoFold` is true and the record knows
     * its conversation range, the same range is ALSO queued for folding at the
     * next conversation start — so removing the summary removes the underlying
     * model-visible text too (fold queued, not executed here).
     */
    async remove(sessionId, id, alsoFold) {
      this.requireString(id, "id");
      const row = this.requireRow(sessionId);
      const target = row.records.find((record) => record.id === id);
      const next = row.records.filter((record) => record.id !== id);
      const removed = next.length !== row.records.length;
      if (removed) await this.table.put(sessionId, { ...row, records: next });
      let foldQueued = false;
      let requestId = void 0;
      let foldError = void 0;
      if (removed && alsoFold === true && target !== void 0 &&
          typeof target.startSeq === "number" && typeof target.endSeq === "number") {
        try {
          if (this.ctx.agents.get(sessionId) === void 0) {
            throw new Error(`context-manager: no live agent for session ${sessionId}`);
          }
          if (this.pendingFolds.has(sessionId)) {
            throw new Error("context-manager: 已有排队中的折叠任务,等下一次对话执行后再试");
          }
          requestId = randomUUID();
          this.pendingFolds.set(sessionId, { requestId, start: target.startSeq, end: target.endSeq });
          this.foldStatuses.set(sessionId, { status: "queued", requestId, at: Date.now() });
          foldQueued = true;
        } catch (error) {
          foldError = error instanceof Error ? error.message : String(error);
        }
      }
      const result = { removed, foldQueued };
      if (foldQueued && requestId !== void 0) result.requestId = requestId;
      if (foldError !== void 0) result.foldError = foldError;
      return result;
    }

    /**
     * Replace the whole priority order. Unknown ids are dropped; records not
     * mentioned keep their relative order at the end (least important).
     */
    async reorder(sessionId, orderedIds) {
      if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== "string" || id.length === 0)) {
        throw new TypeError("context-manager: orderedIds must be an array of non-empty strings");
      }
      const row = this.requireRow(sessionId);
      const byId = new Map(row.records.map((record) => [record.id, record]));
      const ordered = [];
      for (const id of orderedIds) {
        const record = byId.get(id);
        if (record === void 0) continue;
        byId.delete(id);
        ordered.push(record);
      }
      for (const record of row.records) {
        if (byId.has(record.id)) ordered.push(record);
      }
      if (ordered.length !== row.records.length) throw new Error("context-manager: reorder dropped a record unexpectedly");
      await this.table.put(sessionId, { ...row, records: ordered });
      return { records: ordered.map((record) => {
        const out = {
          id: record.id,
          summary: record.summary,
          description: record.description ?? "",
          global: record.global === true,
          createdAt: record.createdAt
        };
        // The gateway's JSON boundary rejects undefined-valued keys.
        if (typeof record.startSeq === "number") out.startSeq = record.startSeq;
        if (typeof record.endSeq === "number") out.endSeq = record.endSeq;
        return out;
      }) };
    }

    /** Append one exchange summary at the END (least important). */
    async record(sessionId, summary, description, startSeq, endSeq) {
      if (typeof summary !== "string" || summary.trim().length === 0) {
        throw new TypeError("context-manager: summary must be a non-empty string");
      }
      if (description !== void 0 && typeof description !== "string") {
        throw new TypeError("context-manager: description must be a string");
      }
      const identity = this.sessionIdentity(sessionId);
      const row = this.table?.get(sessionId) ?? { session: identity, records: [] };
      const record = {
        id: randomUUID(),
        summary: summary.slice(0, 4000),
        description: description === void 0 ? "" : description.slice(0, 2000),
        createdAt: Date.now()
      };
      if (typeof startSeq === "number" && typeof endSeq === "number" &&
          Number.isSafeInteger(startSeq) && Number.isSafeInteger(endSeq) && startSeq <= endSeq) {
        record.startSeq = startSeq;
        record.endSeq = endSeq;
      }
      // No dedupe here (#5/#10): merging identical summaries would drop the
      // new turn's conversation range (auto records) and block the user from
      // intentionally saving duplicate manual notes. Every record is kept.
      let next = [...row.records, record];
      const cap = this.effectiveConfig().maxRecordsPerSession;
      if (next.length > cap) {
        next = pruneRecords(next, cap);
      }
      // Spread the whole row: never drop injectionText / settings alongside records.
      // Serialized through putChain; re-reads the latest row so concurrent
      // fold-status/history writes are never clobbered.
      const appended = { session: identity, records: next };
      this.putChain = this.putChain.then(async () => {
        const fresh = this.table?.get(sessionId);
        if (fresh !== void 0) await this.table.put(sessionId, { ...fresh, ...appended });
      }).catch((error) => {
        this.ctx.logger.warn(`context-manager: record persist failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return { id: record.id };
    }

    /** Edit one record's summary and/or description (undefined = keep). */
    async update(sessionId, id, summary, description) {
      this.requireString(id, "id");
      if (summary !== void 0 && (typeof summary !== "string" || summary.trim().length === 0)) {
        throw new TypeError("context-manager: summary must be a non-empty string");
      }
      if (description !== void 0 && typeof description !== "string") {
        throw new TypeError("context-manager: description must be a string");
      }
      const row = this.requireRow(sessionId);
      let updated = false;
      const next = row.records.map((record) => {
        if (record.id !== id) return record;
        updated = true;
        return {
          ...record,
          ...summary === void 0 ? {} : { summary: summary.slice(0, 4000) },
          ...description === void 0 ? {} : { description: description.slice(0, 2000) }
        };
      });
      if (!updated) throw new Error(`context-manager: no record with id ${id}`);
      await this.table.put(sessionId, { ...row, records: next });
      return { updated: true };
    }

    /** Pin or unpin one record across sessions. */
    async setGlobal(sessionId, id, global) {
      this.requireString(id, "id");
      const row = this.requireRow(sessionId);
      let updated = false;
      const next = row.records.map((record) => {
        if (record.id !== id) return record;
        updated = true;
        if (global === true) return { ...record, global: true };
        // Unpin: drop the key instead of storing `global: false`.
        const { global: _dropped, ...rest } = record;
        return rest;
      });
      if (!updated) throw new Error(`context-manager: no record with id ${id}`);
      await this.table.put(sessionId, { ...row, records: next });
      return { global: global === true };
    }

    /** Drop every record of one session (global pins included). */
    async clear(sessionId) {
      const row = this.table?.get(sessionId);
      if (row === void 0) return { cleared: 0 };
      const cleared = row.records.length;
      await this.table.put(sessionId, { ...row, records: [] });
      return { cleared };
    }

    /** Drop every record across ALL sessions (runtime settings row kept). */
    async clearAll() {
      if (this.table === void 0) return { cleared: 0 };
      let cleared = 0;
      const keys = [];
      for (const [key] of this.table.entries()) {
        if (key === SETTINGS_KEY) continue;
        keys.push(key);
      }
      for (const key of keys) {
        const row = this.table.get(key);
        if (row === void 0) continue;
        cleared += Array.isArray(row.records) ? row.records.length : 0;
        await this.table.put(key, { ...row, records: [] });
      }
      return { cleared };
    }

    /**
     * Render what the real-message injection block would look like right now,
     * split into its labeled parts (本会话记录 / 跨会话置顶 / 自定义注入) so
     * the UI can show each source separately with its own character count.
     */
    async previewInjection(sessionId) {
      this.requireString(sessionId, "sessionId");
      const enabled = this.effectiveConfig().injectIntoMessages === true;
      const injected = this.buildInjectionMessage(sessionId);
      if (injected === null) return { text: "", parts: [], enabled };
      const text = messageText(injected);
      const parts = [];
      const pattern = /【上下文管理·([^】]+)】/g;
      const sections = [];
      let match;
      while ((match = pattern.exec(text)) !== null) {
        sections.push({ label: match[1], start: match.index, end: pattern.lastIndex });
      }
      for (let index = 0; index < sections.length; index += 1) {
        const section = sections[index];
        const partStart = section.end;
        const partEnd = index + 1 < sections.length ? sections[index + 1].start : text.length;
        const partText = text.slice(partStart, partEnd).trim();
        if (partText.length === 0) continue;
        parts.push({ label: section.label, text: partText, chars: partText.length });
      }
      return { text, parts, enabled };
    }

    /** List every cross-session pinned record, newest first. */
    async listGlobal() {
      const records = this.peekGlobalRecords();
      return { records };
    }

    // ── real-conversation control (Remote) ──────────────────────────────

    /**
     * Read the ACTUAL model-visible conversation: every surface message with
     * its text and token estimate, plus the total context pressure. This is
     * what the "真实对话" tab renders — the real context text the model sees,
     * including summary nodes left by previous folds.
     */
    async conversationList(sessionId) {
      this.requireString(sessionId, "sessionId");
      const session = this.ctx.sessions.get(sessionId);
      if (session === void 0) throw new Error(`context-manager: session ${sessionId} is not live`);
      const events = session.events ?? [];
      const surface = session.surface?.nodes ?? [];
      const meter = readService(this.ctx, "tokenMeter");
      let measurement = void 0;
      if (meter !== void 0) {
        try {
          measurement = meter.measure(session);
        } catch {
          // measurement is optional — degrade to unpriced nodes
        }
      }
      const priced = new Map();
      for (const node of measurement?.nodes ?? []) {
        if (node !== null && typeof node === "object" && typeof node.seq === "number") {
          priced.set(node.seq, typeof node.tokens === "number" ? node.tokens : 0);
        }
      }
      // #11: without a token meter, degrade to a rough estimate (chars / 4)
      // instead of reporting zero for every node.
      const estimateTokens = (text) => meter !== void 0 ? 0 : Math.ceil(text.length / 4);
      const nodes = [];
      for (const seq of surface) {
        const event = events[seq];
        if (event === void 0) continue;
        let message = null;
        try {
          message = deriveEventMessage(event);
        } catch {
          // unprojectable event — keep the node with empty text
        }
        const text = messageText(message);
        const hasBlocks = message !== null && Array.isArray(message?.content) &&
          message.content.some((block) => block !== null && typeof block === "object" && block.type !== "text");
        const tokens = priced.get(seq) ?? estimateTokens(text);
        nodes.push({
          seq,
          role: event.type === "user/message" ? "user" : event.type === "assistant/message" ? "assistant" : event.type === "tool/result" ? "tool" : "other",
          text: text.slice(0, 20000),
          hasBlocks,
          tokens
        });
      }
      const fallbackTotal = nodes.reduce((sum, node) => sum + node.tokens, 0);
      return {
        nodes,
        totalTokens: measurement?.totalTokens ?? fallbackTotal,
        surfaceTokens: measurement?.surfaceTokens ?? fallbackTotal
      };
    }

    /**
     * Queue a user-selected surface range for folding into ONE summary node.
     * compactRegion needs an open turn, so the fold runs at the start of the
     * NEXT conversation (pre-step); the browser polls foldStatus() for the
     * outcome. The durable log is append-only — this is the sanctioned way to
     * actually remove text from the model-visible conversation.
     */
    async foldRange(sessionId, start, end) {
      this.requireString(sessionId, "sessionId");
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < 0) {
        throw new TypeError("context-manager: start/end must be non-negative integers");
      }
      if (start > end) throw new TypeError("context-manager: start must not exceed end");
      if (this.ctx.agents.get(sessionId) === void 0) {
        throw new Error(`context-manager: no live agent for session ${sessionId}`);
      }
      if (this.pendingFolds.has(sessionId)) {
        throw new Error("context-manager: 已有排队中的折叠任务,等下一次对话执行后再试");
      }
      // #8: fail fast when the range no longer exists on the surface, instead
      // of queueing a fold that can only fail at execution time.
      const session = this.ctx.sessions.get(sessionId);
      const surface = session?.surface?.nodes ?? [];
      if (session !== void 0 && (!surface.includes(start) || !surface.includes(end))) {
        throw new Error("context-manager: 所选范围已不在真实对话中(可能已被折叠或消息序号变化),请刷新后重选");
      }
      const requestId = randomUUID();
      this.pendingFolds.set(sessionId, { requestId, start, end });
      this.foldStatuses.set(sessionId, { status: "queued", requestId, at: Date.now() });
      // #4: persist the queued fold so it survives restarts (serialized).
      const queued = { requestId, start, end };
      this.putChain = this.putChain.then(async () => {
        try {
          const row = this.table?.get(sessionId);
          if (row !== void 0) await this.table.put(sessionId, { ...row, pendingFold: queued });
        } catch (error) {
          this.ctx.logger.warn(`context-manager: pending fold persist failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }).catch(() => {});
      return { queued: true, requestId };
    }

    /** Latest fold outcome for one session: none / queued / running / done / failed. */
    async foldStatus(sessionId) {
      this.requireString(sessionId, "sessionId");
      const live = this.foldStatuses.get(sessionId);
      if (live !== void 0 && live.status !== "none") return live;
      // Fall back to the persisted status so failure reasons survive restarts.
      const row = this.table?.get(sessionId);
      if (row?.foldStatus !== void 0 && row.foldStatus.status !== "none") return row.foldStatus;
      return { status: "none" };
    }

    /** Set the per-session custom text injected into every model step's real message stream. */
    async setInjectionText(sessionId, text) {
      this.requireString(sessionId, "sessionId");
      if (typeof text !== "string") throw new TypeError("context-manager: text must be a string");
      const identity = this.sessionIdentity(sessionId);
      const row = this.table?.get(sessionId) ?? { session: identity, records: [] };
      await this.table.put(sessionId, { ...row, injectionText: text.slice(0, 4000) });
      return { saved: true };
    }

    /** Read the per-session custom injection text. */
    async getInjectionText(sessionId) {
      this.requireString(sessionId, "sessionId");
      const row = this.table?.get(sessionId);
      return { text: typeof row?.injectionText === "string" ? row.injectionText : "" };
    }

    /**
     * Effective injection configuration = static plugin config overridden by
     * the runtime settings row (if any). Synchronous: called from the pre-step
     * injection path.
     */
    effectiveConfig() {
      const row = this.table?.get(SETTINGS_KEY);
      const s = row?.settings ?? {};
      return {
        ...this.config,
        ...(typeof s.maxInjected === "number" ? { maxInjected: s.maxInjected } : {}),
        ...(typeof s.maxGlobalInjected === "number" ? { maxGlobalInjected: s.maxGlobalInjected } : {}),
        ...(typeof s.maxInjectionChars === "number" ? { maxInjectionChars: s.maxInjectionChars } : {}),
        ...(typeof s.maxCharsPerRecord === "number" ? { maxCharsPerRecord: s.maxCharsPerRecord } : {}),
        ...(typeof s.maxRecordsPerSession === "number" ? { maxRecordsPerSession: s.maxRecordsPerSession } : {}),
        ...(typeof s.injectIntoMessages === "boolean" ? { injectIntoMessages: s.injectIntoMessages } : {})
      };
    }

    /** Read the runtime injection settings (with static config defaults). */
    async getSettings() {
      const cfg = this.effectiveConfig();
      return {
        settings: {
          maxInjected: cfg.maxInjected,
          maxGlobalInjected: cfg.maxGlobalInjected,
          maxInjectionChars: cfg.maxInjectionChars,
          maxCharsPerRecord: cfg.maxCharsPerRecord,
          maxRecordsPerSession: cfg.maxRecordsPerSession,
          injectIntoMessages: cfg.injectIntoMessages === true
        }
      };
    }

    /** Override runtime injection settings; unknown keys are ignored. */
    async setSettings(patch) {
      if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
        throw new TypeError("context-manager: patch must be an object");
      }
      const clampInt = (value, min, max, name) => {
        if (value === void 0 || value === null) return void 0;
        const n = Math.round(Number(value));
        if (!Number.isFinite(n)) throw new TypeError(`context-manager: ${name} must be a number`);
        return Math.min(max, Math.max(min, n));
      };
      const next = {};
      const set = (key, min, max) => {
        const value = clampInt(patch[key], min, max, key);
        if (value !== void 0) next[key] = value;
      };
      set("maxInjected", 0, 100);
      set("maxGlobalInjected", 0, 100);
      set("maxInjectionChars", 1, 20000);
      set("maxCharsPerRecord", 1, 2000);
      set("maxRecordsPerSession", 1, 10000);
      if (typeof patch.injectIntoMessages === "boolean") next.injectIntoMessages = patch.injectIntoMessages;
      const row = this.table?.get(SETTINGS_KEY) ?? { session: { createdAt: Date.now() }, records: [] };
      await this.table.put(SETTINGS_KEY, { ...row, records: row.records ?? [], settings: { ...(row.settings ?? {}), ...next } });
      return { saved: true };
    }

    // ── internal (non-Remote) helpers for the pre-step executor ─────────

    /** Whether the real-message injection channel is active (consulted by the agent row). */
    messageInjectionActive() {
      return this.config.injectIntoMessages === true;
    }

    /** Synchronous peek of the custom injection text for the pre-step path. */
    peekInjectionText(sessionId) {
      const row = this.table?.get(sessionId);
      return typeof row?.injectionText === "string" ? row.injectionText : "";
    }

    /** Build the real-message injection block for one session, or null when empty. */
    buildInjectionMessage(sessionId) {
      if (this.table === void 0) return null;
      return renderInjectionMessage(
        this.peekRecords(sessionId),
        this.peekGlobalRecords(),
        this.peekInjectionText(sessionId),
        this.effectiveConfig()
      );
    }

    /** Atomically claim the next queued fold for a session, if any. */
    takePendingFold(sessionId) {
      const pending = this.pendingFolds.get(sessionId);
      if (pending === void 0) return void 0;
      this.pendingFolds.delete(sessionId);
      const current = this.foldStatuses.get(sessionId);
      if (current !== void 0 && current.status === "queued") {
        this.foldStatuses.set(sessionId, { ...current, status: "running" });
      }
      // Clear the durable queue entry (serialized); execution outcome lands
      // via reportFoldResult/afterFold.
      this.putChain = this.putChain.then(async () => {
        try {
          const row = this.table?.get(sessionId);
          if (row !== void 0 && row.pendingFold !== void 0) {
            const { pendingFold: _dropped, ...rest } = row;
            await this.table.put(sessionId, rest);
          }
        } catch (error) {
          this.ctx.logger.warn(`context-manager: pending fold clear failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }).catch(() => {});
      return pending;
    }

    /**
     * Execute a queued fold. The user-selected range may span ANY number of
     * messages: it is split into balanced segments (tool-call pairs never
     * split, open steps never touched) and each segment is compacted in turn.
     * Partial progress and the failure reason are reported and persisted.
     */
    async executeFoldSegments(sessionId, pending, compaction, agent, signal) {
      const session = agent?.session;
      const surface = session?.surface?.nodes ?? [];
      if (session === void 0) {
        this.reportFoldResult(sessionId, pending.requestId, new Error("会话不可用"));
        return;
      }
      const beforeBalanced = (seq) => {
        try {
          return toolPairingBalancedBefore(session, seq);
        } catch {
          return false;
        }
      };
      const afterBalanced = (seq) => {
        try {
          return toolPairingBalancedAfter(session, seq);
        } catch {
          return false;
        }
      };
      const { segments, remaining } = splitBalancedSegments(surface, beforeBalanced, afterBalanced, pending.start, pending.end, 20, 20);
      if (segments.length === 0) {
        this.reportFoldResult(sessionId, pending.requestId,
          new Error("所选范围无法切出平衡边界(范围已不在对话中,或全是未闭合的工具调用)"));
        return;
      }
      let folded = 0;
      try {
        for (const segment of segments) {
          await withTimeout(compaction.compactRegion(segment.start, segment.end, agent, signal), 90000, "折叠单段");
          folded += 1;
        }
        const extra = remaining > 0
          ? `已折叠 ${folded} 段;还有 ${remaining} 条消息超出单次上限,可再选一次继续折`
          : `已折叠 ${folded} 段`;
        this.reportFoldResult(sessionId, pending.requestId, void 0, extra);
        this.afterFold(sessionId, pending);
      } catch (error) {
        const progress = folded > 0 ? `已折叠 ${folded} 段后失败: ` : "";
        this.reportFoldResult(sessionId, pending.requestId,
          new Error(progress + (error instanceof Error ? error.message : String(error))));
        if (folded > 0) this.afterFold(sessionId, pending);
      }
    }

    /** Record the outcome of one fold for the browser status (persisted). */
    reportFoldResult(sessionId, requestId, error, extra) {
      const status = error === void 0
        ? { status: "done", requestId, at: Date.now(), message: typeof extra === "string" ? extra : void 0 }
        : { status: "failed", requestId, at: Date.now(), message: error instanceof Error ? error.message : String(error) };
      this.foldStatuses.set(sessionId, status);
      // Persist (serialized) so failure reasons survive restarts.
      void this.persistFoldStatus(sessionId);
      if (error !== void 0) {
        this.ctx.logger.warn(`context-manager: fold ${requestId} failed: ${status.message}`);
      } else {
        this.ctx.logger.info(`context-manager: fold ${requestId} completed for ${sessionId}${typeof extra === "string" ? ` (${extra})` : ""}`);
      }
    }

    /**
     * Serialized persistence of one session's latest fold status. Writes go
     * through a per-service promise chain so concurrent puts (status +
     * history + records) never interleave and every payload builds on the
     * latest row snapshot.
     */
    persistFoldStatus(sessionId) {
      const status = this.foldStatuses.get(sessionId);
      if (status === void 0) return Promise.resolve();
      const clean = { status: status.status, requestId: status.requestId, at: status.at };
      if (status.message !== void 0) clean.message = status.message;
      this.putChain = this.putChain.then(async () => {
        try {
          const row = this.table?.get(sessionId);
          if (row !== void 0) await this.table.put(sessionId, { ...row, foldStatus: clean });
        } catch (persistError) {
          this.ctx.logger.warn(`context-manager: fold status persist failed: ${persistError instanceof Error ? persistError.message : String(persistError)}`);
        }
      }).catch(() => {});
      return this.putChain;
    }

    /**
     * Post-fold housekeeping, called right after a successful compactRegion:
     *   #12 audit trail — remember what was folded and when;
     *   #1 stale ranges — clear the conversation range from every record whose
     *      seqs no longer exist on the surface (their messages were folded),
     *      so a later 🗑️ on that record degrades to "delete summary only"
     *      instead of failing the fold with a dead range.
     */
    afterFold(sessionId, pending) {
      // #12/#2: audit trail — remember what was folded and when. `pending` is
      // undefined for the auto "压缩对话" button, which folds a self-chosen
      // range and reports no seqs to us.
      const entry = pending !== void 0
        ? { at: Date.now(), startSeq: pending.start, endSeq: pending.end }
        : { at: Date.now(), auto: true };
      try {
        const history = this.foldHistorys.get(sessionId) ?? [];
        history.push(entry);
        if (history.length > 20) history.shift();
        this.foldHistorys.set(sessionId, history);
        // #4: persist the audit trail so it survives restarts (serialized).
        const snapshot = history.slice();
        this.putChain = this.putChain.then(async () => {
          try {
            const row = this.table?.get(sessionId);
            if (row !== void 0) await this.table.put(sessionId, { ...row, foldHistory: snapshot });
          } catch (error) {
            this.ctx.logger.warn(`context-manager: fold audit persist failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }).catch(() => {});
      } catch (error) {
        this.ctx.logger.warn(`context-manager: fold audit failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const session = this.ctx.sessions.get(sessionId);
        const surface = session?.surface?.nodes ?? [];
        const row = this.table?.get(sessionId);
        if (row === void 0) return;
        let changed = false;
        const records = row.records.map((record) => {
          if (typeof record.startSeq !== "number" || typeof record.endSeq !== "number") return record;
          if (surface.includes(record.startSeq) && surface.includes(record.endSeq)) return record;
          // #11: try to shrink onto the closest surviving seqs; drop the range
          // only when the whole span was folded away.
          const shrunk = shrinkRange(surface, record.startSeq, record.endSeq);
          changed = true;
          if (shrunk === null) {
            const { startSeq: _start, endSeq: _end, ...rest } = record;
            return rest;
          }
          return { ...record, startSeq: shrunk.startSeq, endSeq: shrunk.endSeq };
        });
        if (changed) {
          // Serialized: re-read the latest row so queued writes are kept.
          const cleaned = records;
          this.putChain = this.putChain.then(async () => {
            const fresh = this.table?.get(sessionId);
            if (fresh !== void 0) await this.table.put(sessionId, { ...fresh, records: cleaned });
          }).catch(() => {});
        }
      } catch (error) {
        this.ctx.logger.warn(`context-manager: fold range cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    /** Recent fold audit trail for one session (newest first). */
    async foldHistory(sessionId) {
      this.requireString(sessionId, "sessionId");
      const history = this.foldHistorys.get(sessionId) ?? [];
      return { history: [...history].reverse() };
    }

    /**
     * Whether the session belongs to a ROOT agent — the recording scope.
     * Subagent/workflow children are excluded so their transient exchanges
     * never pollute the records (or burn summarization tokens).
     */
    isRootSession(sessionId) {
      try {
        const roots = this.ctx.agents.roots();
        return roots.some((agent) => agent.session?.id === sessionId);
      } catch {
        // registry hiccup — record rather than drop
        return true;
      }
    }

    /**
     * Compact this session's conversation history through the host compaction
     * engine — the only sanctioned way to shrink the conversation itself:
     * the event log is append-only, so old history is folded into a summary
     * node and the token budget it occupied is released.
     * @param sessionId - the live session whose history is compacted.
     * @returns `{ compacted: true }` when a range was folded, `false` when no
     *   safe useful range exists yet.
     * @throws when no live agent owns the session, or when the agent is busy
     *   (an exchange is in flight) — compaction needs an idle agent.
     */
    async compact(sessionId) {
      this.requireString(sessionId, "sessionId");
      const agent = this.ctx.agents.get(sessionId);
      if (agent === void 0) {
        throw new Error(`context-manager: no live agent for session ${sessionId}`);
      }
      const compaction = readService(this.ctx, "compaction");
      if (compaction === void 0) {
        throw new Error("context-manager: compaction 服务不可用(根平面未挂载被动压缩实例)");
      }
      const signal = AbortSignal.timeout(120000);
      const result = await compaction.compactNow(agent, signal, "context-manager");
      const compacted = result !== null;
      // #2: keep record ranges + fold audit in sync with this fold too.
      if (compacted) this.afterFold(sessionId, void 0);
      return { compacted };
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    requireString(value, name) {
      if (typeof value !== "string" || value.length === 0) throw new TypeError(`context-manager: ${name} must be a non-empty string`);
    }

    requireRow(sessionId) {
      this.requireString(sessionId, "sessionId");
      const row = this.table?.get(sessionId);
      if (row === void 0) throw new Error(`context-manager: no records for session ${sessionId}`);
      return row;
    }

    /** Fence a row to the live Session lifecycle; fall back to a fresh identity. */
    sessionIdentity(sessionId) {
      const live = this.ctx.sessions.get(sessionId);
      if (live !== void 0) {
        return {
          createdAt: live.header.createdAt,
          ...live.header.cwd === void 0 ? {} : { cwd: live.header.cwd }
        };
      }
      return { createdAt: Date.now() };
    }
  };
})();

export { ContextManagerService, ContextManagerService as default, contextManagerDomainSpec, contextManagerRecordSchema, contextManagerRowSchema, pruneRecords, renderInjectionMessage, shrinkRange, splitBalancedSegments, truncate, messageText, isRealUserMessage };
