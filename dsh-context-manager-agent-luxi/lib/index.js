// dsh-context-manager-agent — per-session half of the context manager.
//
// Mounted as one row in an agent preset. RECORDING moved to the host-plane
// service (dsh-context-manager-service-luxi) so EVERY session records; this
// row now only:
//   1. tracks the live session for the fallback prompt injection, and
//   2. registers a runtime-context contribution that injects the top
//      priority-ordered records — plus every cross-session pinned (global)
//      record — into this agent's prompt (position 0 = most important),
//      ACTING ONLY when the service's real-message injection channel is OFF
//      (service config `injectIntoMessages: false`), so records never appear
//      twice in the model input.
//
// The browser UI (dock entry + management window) ships in the separate
// dsh-context-manager-ui-luxi package, mounted as a web-profile row.

const DEFAULT_CONFIG = {
  maxInjected: 5,
  maxGlobalInjected: 3,
  maxCharsPerRecord: 200
};

/** Truncate to a whole-character budget. */
function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "…";
}

/**
 * Render the prompt-injection block from the service's read results: the
 * session's priority records (most important first) followed by every
 * cross-session pinned record, each truncated to the per-record budget.
 * Pure — the systemPrompt context text calls this inside its try/catch.
 */
function renderInjectedRecords(records, globalRecords, cfg) {
  const parts = [];
  if (records.length > 0) {
    const lines = records.slice(0, cfg.maxInjected).map((record, index) => {
      return `${index + 1}. ${truncate(record.summary, cfg.maxCharsPerRecord)}`;
    });
    parts.push(`Context-manager priority records (most important first — keep these in mind while replying):\n${lines.join("\n")}`);
  }
  if (globalRecords.length > 0) {
    const lines = globalRecords.slice(0, cfg.maxGlobalInjected).map((record, index) => {
      return `${index + 1}. ${truncate(record.summary, cfg.maxCharsPerRecord)}`;
    });
    parts.push(`Context-manager global records (pinned across sessions — always keep these in mind):\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * The agent-side plugin. `config` comes from the preset row:
 *   maxInjected / maxGlobalInjected / maxCharsPerRecord: budgets for the
 *   fallback system-prompt injection (used only when the service's
 *   real-message injection channel is disabled).
 */
function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const service = ctx.get("contextManager");
  const systemPrompt = ctx.get("systemPrompt");
  if (service === void 0) {
    ctx.logger.warn("context-manager: host service not available; recording disabled");
  }

  let currentSession = void 0;
  let promptWarned = false;

  // Scope-filtered: this agent's listener only receives its own session's
  // events. It only tracks the live session for the fallback injection —
  // recording itself lives in the host service now (every session records).
  ctx.on("session/event", (session) => {
    currentSession = session;
  });

  if (systemPrompt === void 0) return;

  // The host service injects the records into the REAL message stream
  // (pre-step channel, service config `injectIntoMessages`). When that
  // channel is active, skip the legacy system-prompt injection so the
  // records do not appear twice in the model input. When it is off (or the
  // service is down), this legacy channel keeps working as the fallback.
  let messageInjectionActive = false;
  try {
    messageInjectionActive = service?.messageInjectionActive?.() === true;
  } catch {
    messageInjectionActive = false;
  }
  if (messageInjectionActive) return;

  // Inject the priority-ordered records into the runtime-context snapshot.
  systemPrompt.context({
    name: "context-manager/records",
    order: 60,
    text: () => {
      if (currentSession === void 0) return "";
      const target = service ?? ctx.get("contextManager");
      if (target === void 0) return "";
      // Hard requirement: this text runs inside the system-prompt pipeline on
      // every step, and a throwing context text kills the whole turn (seen in
      // the hot-reload window where the host service's storage domain was
      // briefly closed). Any service hiccup must degrade to no injection, not
      // to a dead round — warn once per session, then render nothing.
      try {
        return renderInjectedRecords(
          target.peekRecords(currentSession.id),
          target.peekGlobalRecords(),
          cfg
        );
      } catch (error) {
        if (!promptWarned) {
          promptWarned = true;
          ctx.logger.warn(`context-manager: records injection unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
        return "";
      }
    }
  });
}

export default {
  name: "dsh-context-manager-agent",
  apply,
  // Declare every service apply() reads through ctx.get(). cordis only
  // populates a fiber's dependency store from its inject list — without
  // these names, ctx.get("contextManager") / ctx.get("systemPrompt")
  // resolve undefined and the plugin silently degrades.
  inject: ["contextManager", "systemPrompt"]
};

// Exported for unit tests only — the plugin body consumes the default export.
export { DEFAULT_CONFIG, renderInjectedRecords, truncate };
