// dsh-context-manager-agent-luxi — browser half.
//
// Delivered to the page through the dsh.client declaration in package.json:
// the host scan serves this file at /plugins/dsh-context-manager-agent-luxi/client.js
// and the kernel adopts it as a client plugin entry.
//
// UI:
//   - a dock entry next to the shipped stats line in `conversation.composer.dock`
//     (bottom-right of the composer, where the context usage readout lives); the
//     badge polls the lightweight `count` Remote method so it stays live;
//   - a management window in `shell.overlay` opened by clicking the dock entry:
//     every recorded exchange is listed as a card with 总结 (bold, top) and
//     描述 (below); the user can search, edit, delete, drag-reorder, pin a
//     record across sessions (global), export, or clear everything.
//
// Client -> Host: the browser cannot mount new Remote namespaces (they are
// compiled into dsh-api-remotes), but the Host gateway resolves ANY live
// Service's Remote methods at runtime (SRC path), so we call the
// `contextManager` service directly through connection.rpc.

window.__ModuleLoader__.load({
  id: "dsh-context-manager-agent-luxi",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

    // ── styles (package-owned, injected once) ───────────────────────────────

    const css = `
.cm-dock-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(74,125,255,.45);background:linear-gradient(135deg, rgba(74,125,255,.20), rgba(74,125,255,.08));color:var(--dsw-alias-label-primary,#eee);border-radius:999px;height:26px;padding:0 10px;font-size:12px;font-weight:500;cursor:pointer;line-height:1;transition:background .15s,border-color .15s,box-shadow .15s}
.cm-dock-btn:hover{background:rgba(74,125,255,.30);border-color:var(--dsw-alias-state-business-primary,#4a7dff);box-shadow:0 0 0 3px rgba(74,125,255,.15)}
.cm-dock-icon{display:inline-flex;color:var(--dsw-alias-state-business-primary,#4a7dff);flex:none}
.cm-dock-count{background:var(--dsw-alias-state-business-primary,#4a7dff);color:#fff;border-radius:999px;font-size:11px;font-weight:700;min-width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;padding:0 5px}
.cm-backdrop{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;pointer-events:auto}
.cm-window{width:min(680px,94vw);max-height:82vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#1e1e1e);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.45);overflow:hidden}
.cm-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#eee)}
.cm-head-actions{display:flex;align-items:center;gap:6px}
.cm-tool{background:none;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));color:var(--dsw-alias-label-tertiary,#999);border-radius:8px;height:24px;padding:0 8px;font-size:12px;cursor:pointer;line-height:1}
.cm-tool:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12));color:var(--dsw-alias-label-secondary,#ccc)}
.cm-tool.cm-danger:hover{color:var(--dsw-alias-state-error-primary,#ff6b6b);border-color:rgba(255,107,107,.4)}
.cm-close{background:none;border:none;color:var(--dsw-alias-label-tertiary,#999);font-size:16px;cursor:pointer;line-height:1;padding:4px}
.cm-close:hover{color:var(--dsw-alias-label-primary,#eee)}
.cm-search{padding:10px 16px 0}
.cm-search input{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-elevated,rgba(128,128,128,.08));border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));border-radius:8px;color:var(--dsw-alias-label-primary,#eee);font-size:13px;padding:7px 10px;outline:none}
.cm-search input:focus{border-color:var(--dsw-alias-state-business-primary,#4a7dff)}
.cm-list{overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;flex:1}
.cm-empty{color:var(--dsw-alias-label-caption,#888);font-size:13px;text-align:center;padding:28px 8px}
.cm-item{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));background:var(--dsw-alias-bg-elevated,rgba(128,128,128,.06));border-radius:10px;padding:8px 10px;cursor:grab;user-select:none}
.cm-item.cm-over{border-color:var(--dsw-alias-state-business-primary,#4a7dff);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary,#4a7dff)}
.cm-item.cm-global{border-color:rgba(255,196,0,.45)}
.cm-rank{flex:none;width:22px;height:22px;border-radius:999px;background:var(--dsw-alias-state-business-primary,#4a7dff);color:#fff;font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;margin-top:2px}
.cm-body{flex:1;min-width:0}
.cm-summary{color:var(--dsw-alias-label-primary,#eee);font-size:13px;font-weight:700;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.cm-desc{color:var(--dsw-alias-label-secondary,#bbb);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;margin-top:4px}
.cm-meta{color:var(--dsw-alias-label-caption,#888);font-size:11px;margin-top:4px;display:flex;align-items:center;gap:8px}
.cm-global-badge{color:#ffc400;font-size:11px}
.cm-edit-area{display:flex;flex-direction:column;gap:6px}
.cm-edit-area textarea{background:var(--dsw-alias-bg-base,#1e1e1e);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));border-radius:8px;color:var(--dsw-alias-label-primary,#eee);font-size:12px;line-height:1.5;padding:6px 8px;resize:vertical;font-family:inherit;outline:none}
.cm-edit-area textarea:focus{border-color:var(--dsw-alias-state-business-primary,#4a7dff)}
.cm-edit-actions{display:flex;gap:6px}
.cm-ops{flex:none;display:flex;flex-direction:column;gap:4px;align-items:center}
.cm-op{background:none;border:none;color:var(--dsw-alias-label-tertiary,#999);cursor:pointer;font-size:14px;padding:2px 4px;line-height:1}
.cm-op:hover{color:var(--dsw-alias-label-primary,#eee)}
.cm-op.cm-global-on{color:#ffc400}
.cm-op.cm-del:hover{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.cm-foot{padding:8px 16px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));color:var(--dsw-alias-label-caption,#888);font-size:12px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.cm-err{color:var(--dsw-alias-state-error-primary,#ff6b6b);font-size:12px}
.cm-tabs{display:flex;gap:4px;padding:8px 16px 0}
.cm-tab{background:none;border:1px solid transparent;color:var(--dsw-alias-label-tertiary,#999);border-radius:8px;height:26px;padding:0 12px;font-size:12px;cursor:pointer;line-height:1}
.cm-tab:hover{color:var(--dsw-alias-label-secondary,#ccc);background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08))}
.cm-tab.cm-tab-active{color:var(--dsw-alias-state-business-primary,#4a7dff);border-color:rgba(74,125,255,.45);background:rgba(74,125,255,.10);font-weight:600}
.cm-conv-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 16px 0}
.cm-conv-total{color:var(--dsw-alias-label-caption,#888);font-size:12px}
.cm-conv-list{overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:6px;flex:1}
.cm-conv-node{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));background:var(--dsw-alias-bg-elevated,rgba(128,128,128,.05));border-radius:10px;padding:7px 10px}
.cm-conv-node.cm-in-range{border-color:rgba(255,196,0,.55);box-shadow:0 0 0 1px rgba(255,196,0,.35)}
.cm-conv-seq{flex:none;min-width:34px;text-align:center;color:var(--dsw-alias-label-caption,#888);font-size:11px;padding-top:3px;font-variant-numeric:tabular-nums}
.cm-conv-body{flex:1;min-width:0}
.cm-conv-role{display:inline-block;border-radius:6px;font-size:11px;font-weight:600;padding:1px 7px;margin-bottom:3px}
.cm-role-user{background:rgba(74,125,255,.18);color:var(--dsw-alias-state-business-primary,#4a7dff)}
.cm-role-assistant{background:rgba(52,199,123,.16);color:#34c77b}
.cm-role-tool{background:rgba(255,196,0,.15);color:#ffc400}
.cm-role-other{background:rgba(128,128,128,.18);color:var(--dsw-alias-label-secondary,#bbb)}
.cm-conv-text{color:var(--dsw-alias-label-primary,#eee);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.cm-conv-text.cm-clamped{max-height:96px;overflow:hidden;position:relative}
.cm-conv-text.cm-clamped::after{content:"…";position:absolute;right:2px;bottom:0}
.cm-conv-meta{color:var(--dsw-alias-label-caption,#888);font-size:11px;margin-top:3px;display:flex;align-items:center;gap:8px}
.cm-conv-ops{flex:none;display:flex;flex-direction:column;gap:4px;align-items:center}
.cm-range-btn{background:none;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));color:var(--dsw-alias-label-tertiary,#999);border-radius:6px;font-size:11px;padding:1px 6px;cursor:pointer;line-height:1.4}
.cm-range-btn:hover{color:var(--dsw-alias-label-primary,#eee);border-color:var(--dsw-alias-state-business-primary,#4a7dff)}
.cm-range-btn.cm-on{background:rgba(255,196,0,.18);border-color:rgba(255,196,0,.55);color:#ffc400}
.cm-foldbar{padding:8px 16px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px}
.cm-inject{padding:12px 16px;display:flex;flex-direction:column;gap:8px;flex:1;overflow-y:auto}
.cm-inject textarea.cm-inject-text{width:100%;box-sizing:border-box;flex:none;min-height:100px;max-height:160px;background:var(--dsw-alias-bg-base,#1e1e1e);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));border-radius:8px;color:var(--dsw-alias-label-primary,#eee);font-size:13px;line-height:1.6;padding:8px 10px;resize:vertical;font-family:inherit;outline:none}
.cm-inject textarea.cm-inject-text:focus{border-color:var(--dsw-alias-state-business-primary,#4a7dff)}
.cm-inject-hint{color:var(--dsw-alias-label-caption,#888);font-size:12px;line-height:1.6;flex:none}
.cm-inject-row{display:flex;align-items:center;gap:8px;flex:none}
.cm-inject-settings{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));background:var(--dsw-alias-bg-elevated,rgba(128,128,128,.04));border-radius:10px;display:flex;flex-direction:column;gap:4px;flex:none;overflow:hidden}
.cm-settings-toggle{display:flex;align-items:center;gap:8px;background:none;border:none;color:var(--dsw-alias-label-secondary,#bbb);font-size:12px;padding:8px 10px;cursor:pointer;text-align:left;line-height:1.4}
.cm-settings-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}
.cm-settings-summary{color:var(--dsw-alias-label-caption,#888);font-size:11px}
.cm-settings-caret{color:var(--dsw-alias-label-caption,#888)}
.cm-inject-settings > label{padding:0 10px}
.cm-inject-settings > .cm-inject-row{padding:0 10px 10px}
.cm-inject-field{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#bbb)}
.cm-inject-field input{width:90px;box-sizing:border-box;background:var(--dsw-alias-bg-base,#1e1e1e);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));border-radius:6px;color:var(--dsw-alias-label-primary,#eee);font-size:12px;padding:4px 8px;outline:none;text-align:right}
.cm-inject-field input:focus{border-color:var(--dsw-alias-state-business-primary,#4a7dff)}
.cm-preview-parts{flex:1;min-height:180px;display:flex;flex-direction:column;gap:8px;overflow-y:auto}
.cm-preview-note{flex:none;border:1px solid rgba(255,196,0,.45);background:rgba(255,196,0,.10);color:#ffc400;border-radius:8px;font-size:12px;padding:6px 10px}
.cm-preview-note-off{color:var(--dsw-alias-label-secondary,#bbb);border-color:var(--dsw-alias-border-l1,rgba(128,128,128,.35));background:var(--dsw-alias-bg-elevated,rgba(128,128,128,.08))}
.cm-preview-part{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));border-radius:8px;background:var(--dsw-alias-bg-base,#1e1e1e);overflow:hidden;flex:none}
.cm-preview-part-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;background:var(--dsw-alias-bg-elevated,rgba(128,128,128,.08));border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}
.cm-preview-part-label{font-size:12px;font-weight:700;color:var(--dsw-alias-label-secondary,#bbb)}
.cm-preview-part-label.cm-part-session{color:var(--dsw-alias-state-business-primary,#4a7dff)}
.cm-preview-part-label.cm-part-global{color:#ffc400}
.cm-preview-part-label.cm-part-custom{color:#34c77b}
.cm-preview-part-chars{font-size:11px;color:var(--dsw-alias-label-caption,#888);flex:none}
.cm-preview-text{background:transparent;border:none;color:var(--dsw-alias-label-secondary,#bbb);font-size:12px;line-height:1.6;padding:8px 10px;white-space:pre-wrap;word-break:break-word;margin:0;max-height:200px;overflow-y:auto}
.cm-preview-empty{flex:1;min-height:180px;display:flex;align-items:center;justify-content:center;border:1px dashed var(--dsw-alias-border-l1,rgba(128,128,128,.25));border-radius:8px;color:var(--dsw-alias-label-caption,#888);font-size:12px;text-align:center;padding:12px}
.cm-global-list{overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;flex:1}
.cm-global-row{display:flex;gap:10px;align-items:flex-start;border:1px solid rgba(255,196,0,.35);background:var(--dsw-alias-bg-elevated,rgba(128,128,128,.06));border-radius:10px;padding:8px 10px}
.cm-new-row{display:flex;flex-direction:column;gap:6px;padding-top:8px}
.cm-new-input{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base,#1e1e1e);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));border-radius:8px;color:var(--dsw-alias-label-primary,#eee);font-size:12px;line-height:1.5;padding:6px 8px;resize:vertical;font-family:inherit;outline:none}
.cm-new-input:focus{border-color:var(--dsw-alias-state-business-primary,#4a7dff)}
.cm-range-jump{background:none;border:none;cursor:pointer;font-size:11px;padding:0;line-height:1.4}
.cm-range-jump:hover{color:var(--dsw-alias-state-business-primary,#4a7dff);text-decoration:underline}
.cm-node-highlight{border-color:var(--dsw-alias-state-business-primary,#4a7dff);box-shadow:0 0 0 2px rgba(74,125,255,.35);background:rgba(74,125,255,.12)}
.cm-fold-history{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 16px 8px;font-size:11px;color:var(--dsw-alias-label-caption,#888)}
.cm-fold-history-label{color:var(--dsw-alias-label-caption,#888)}
.cm-fold-history-item{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));border-radius:999px;padding:1px 8px}
.cm-ok{color:#34c77b;font-size:12px}
`;
    const cssTag = "dsh-context-manager-agent-luxi";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + cssTag + "\"]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-context-manager-agent-luxi";
      tag.dataset.pluginCss = cssTag;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ── shared open state between the dock entry and the overlay ────────────

    const store = {
      open: false,
      sessionId: null,
      version: 0,
      listeners: new Set(),
      set(open, sessionId) {
        this.open = open;
        if (sessionId !== void 0) this.sessionId = sessionId;
        this.version += 1;
        for (const listener of [...this.listeners]) listener();
      },
      subscribe(listener) {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
      snapshot() {
        return this.version;
      }
    };

    // ── Client -> Host RPC through the gateway's SRC path ───────────────────

    let getConnection = () => void 0;

    async function rpc(method, args) {
      const connection = getConnection();
      if (connection === void 0) {
        return { ok: false, error: { code: "no-connection", message: "connection service unavailable" } };
      }
      try {
        return await connection.rpc.call("/api", "contextManager/" + method, { args });
      } catch (error) {
        return { ok: false, error: { code: "call-failed", message: error instanceof Error ? error.message : String(error) } };
      }
    }

    // ── dock entry: the bottom-right button beside the stats line ───────────

    function DockButton(props) {
      const [count, setCount] = react.useState(null);
      react.useEffect(() => {
        let alive = true;
        const refresh = () => {
          rpc("count", { sessionId: props.sessionId }).then((res) => {
            if (!alive) return;
            if (res.ok) setCount(res.value.count);
            else setCount(0);
          }).catch(() => {
            if (alive) setCount(0);
          });
        };
        refresh();
        // Lightweight polling keeps the badge live as exchanges get recorded.
        const timer = setInterval(refresh, 15000);
        const off = store.subscribe(() => {
          if (!store.open) refresh();
        });
        return () => {
          alive = false;
          clearInterval(timer);
          off();
        };
      }, [props.sessionId]);
      return react.createElement(
        "button",
        { className: "cm-dock-btn", title: "管理上下文记录（搜索/编辑/置顶/导出，拖拽排序，越靠上越重要）", onClick: () => store.set(true, props.sessionId) },
        react.createElement("span", {
          className: "cm-dock-icon",
          dangerouslySetInnerHTML: { __html: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.5h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"/></svg>' }
        }),
        react.createElement("span", null, "上下文"),
        count !== null ? react.createElement("span", { className: "cm-dock-count" }, String(count)) : null
      );
    }

    // ── overlay: the management window ──────────────────────────────────────

    function ManagerWindow() {
      // React invokes these as bare functions, so bind the store methods to
      // keep `this` (an unbound reference would throw in subscribe and the
      // slot error boundary would abdicate this entry permanently).
      react.useSyncExternalStore(
        (listener) => store.subscribe(listener),
        () => store.snapshot()
      );
      if (!store.open || store.sessionId === null) return null;
      return react.createElement(ManagerPanel, { sessionId: store.sessionId, onClose: () => store.set(false) });
    }

    function formatTime(createdAt) {
      try {
        return new Date(createdAt).toLocaleString();
      } catch {
        return "";
      }
    }

    function exportMarkdown(records) {
      const lines = ["# 上下文记录", ""];
      records.forEach((record, index) => {
        lines.push(`## ${index + 1}. ${record.summary.replace(/\n/g, " ")}`);
        if (record.description !== void 0 && record.description.length > 0) lines.push("");
        if (record.description !== void 0 && record.description.length > 0) lines.push(record.description);
        if (record.global === true) lines.push("> 🌐 全局（跨会话）");
        if (typeof record.startIndex === "number" && typeof record.endIndex === "number") {
          lines.push(`> 对话范围: 第 ${record.startIndex}–${record.endIndex} 条消息 (seq #${record.startSeq}–#${record.endSeq})`);
        }
        lines.push(`> ${formatTime(record.createdAt)}`);
        lines.push("");
      });
      return lines.join("\n");
    }

    function exportJson(records) {
      return JSON.stringify(records.map((record) => ({
        summary: record.summary,
        description: record.description ?? "",
        global: record.global === true,
        startSeq: typeof record.startSeq === "number" ? record.startSeq : void 0,
        endSeq: typeof record.endSeq === "number" ? record.endSeq : void 0,
        createdAt: record.createdAt
      })), null, 2);
    }

    function downloadFile(name, content, mime) {
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    }

    function ManagerPanel(props) {
      const [records, setRecords] = react.useState(null);
      const [error, setError] = react.useState("");
      const [dragIndex, setDragIndex] = react.useState(null);
      const [overIndex, setOverIndex] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [query, setQuery] = react.useState("");
      const [editingId, setEditingId] = react.useState(null);
      const [editSummary, setEditSummary] = react.useState("");
      const [editDescription, setEditDescription] = react.useState("");
      const [tab, setTab] = react.useState("records");
      const [newOpen, setNewOpen] = react.useState(false);
      const [newSummary, setNewSummary] = react.useState("");
      const [newDescription, setNewDescription] = react.useState("");
      const [jumpTo, setJumpTo] = react.useState(null);

      const load = react.useCallback(() => {
        rpc("list", { sessionId: props.sessionId }).then((res) => {
          if (res.ok) {
            setRecords(res.value.records);
            setError("");
          } else {
            setError(res.error?.message ?? "读取失败");
          }
        }).catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
      }, [props.sessionId]);

      react.useEffect(() => {
        load();
      }, [load]);

      const remove = (id) => {
        if (busy) return;
        if (!window.confirm("删除这条记录？\n(只删摘要,对话原文保留;如需同时折叠对话请用 🗑️ 按钮)")) return;
        setBusy(true);
        rpc("remove", { sessionId: props.sessionId, id }).then((res) => {
          if (res.ok) load();
          else setError(res.error?.message ?? "删除失败");
        }).catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        }).finally(() => setBusy(false));
      };

      const removeWithFold = (record) => {
        if (busy) return;
        const rangeLabel = typeof record.startIndex === "number" && typeof record.endIndex === "number"
          ? `第 ${record.startIndex}–${record.endIndex} 条消息`
          : `#${record.startSeq}–#${record.endSeq}`;
        if (!window.confirm(`删除此记录,并同时把对话中对应的${rangeLabel}折叠成摘要?\n折叠会在你发送下一条消息时执行(旧文本从模型上下文移除)。`)) return;
        setBusy(true);
        setError("");
        rpc("remove", { sessionId: props.sessionId, id: record.id, alsoFold: true }).then((res) => {
          if (res.ok) {
            load();
            if (res.value.foldQueued === true) {
              setError("记录已删除;对话对应范围已排队折叠,发送下一条消息时执行");
            } else if (res.value.foldError) {
              setError(`记录已删除;但对话折叠未排队:${res.value.foldError}`);
            } else {
              setError("记录已删除(此记录没有可关联的对话范围)");
            }
          } else setError(res.error?.message ?? "删除失败");
        }).catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        }).finally(() => setBusy(false));
      };

      const toggleGlobal = (record) => {
        if (busy) return;
        setBusy(true);
        rpc("setGlobal", { sessionId: props.sessionId, id: record.id, global: !(record.global === true) }).then((res) => {
          if (res.ok) load();
          else setError(res.error?.message ?? "置顶失败");
        }).catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        }).finally(() => setBusy(false));
      };

      const startEdit = (record) => {
        setEditingId(record.id);
        setEditSummary(record.summary);
        setEditDescription(record.description ?? "");
      };

      const cancelEdit = () => {
        setEditingId(null);
      };

      const saveEdit = (id) => {
        if (busy) return;
        setBusy(true);
        const args = { sessionId: props.sessionId, id };
        if (editSummary.trim().length > 0) args.summary = editSummary;
        args.description = editDescription;
        rpc("update", args).then((res) => {
          if (res.ok) {
            setEditingId(null);
            load();
          } else setError(res.error?.message ?? "保存失败");
        }).catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        }).finally(() => setBusy(false));
      };

      const clearAll = () => {
        if (busy) return;
        if (!window.confirm("确定清空当前会话的全部上下文记录？此操作不可撤销。")) return;
        setBusy(true);
        rpc("clear", { sessionId: props.sessionId }).then((res) => {
          if (res.ok) load();
          else setError(res.error?.message ?? "清空失败");
        }).catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        }).finally(() => setBusy(false));
      };

      const compactConversation = () => {
        if (busy) return;
        if (!window.confirm("压缩这段对话？早期消息会被折叠成摘要节点，释放上下文空间（已用百分比下降）。对话需处于空闲状态。")) return;
        setBusy(true);
        setError("");
        rpc("compact", { sessionId: props.sessionId }).then((res) => {
          if (res.ok) {
            window.alert(res.value.compacted ? "压缩完成：对话历史已折叠为摘要。" : "暂无可以压缩的历史（会话太短或无可压缩范围）。");
          } else {
            setError(res.error?.message ?? "压缩失败");
          }
        }).catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        }).finally(() => setBusy(false));
      };

      const commitOrder = (nextRecords) => {
        setRecords(nextRecords);
        setBusy(true);
        rpc("reorder", {
          sessionId: props.sessionId,
          orderedIds: nextRecords.map((record) => record.id)
        }).then((res) => {
          if (res.ok && res.value.records) setRecords(res.value.records);
          else setError(res.error?.message ?? "排序保存失败");
        }).catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        }).finally(() => setBusy(false));
      };

      const onDrop = (targetIndex) => {
        if (dragIndex === null || dragIndex === targetIndex || records === null) {
          setDragIndex(null);
          setOverIndex(null);
          return;
        }
        const next = [...records];
        const [moved] = next.splice(dragIndex, 1);
        next.splice(targetIndex, 0, moved);
        setDragIndex(null);
        setOverIndex(null);
        commitOrder(next);
      };

      const all = records === null ? [] : records;
      const needle = query.trim().toLowerCase();
      const items = needle.length === 0
        ? all
        : all.filter((record) =>
            record.summary.toLowerCase().includes(needle) ||
            (record.description ?? "").toLowerCase().includes(needle)
          );

      const recordOps = (record, index) => react.createElement(
        "div",
        { className: "cm-ops" },
        react.createElement("button", {
          className: "cm-op" + (record.global === true ? " cm-global-on" : ""),
          title: record.global === true ? "取消跨会话置顶" : "跨会话置顶（所有会话都会记住）",
          onClick: () => toggleGlobal(record)
        }, record.global === true ? "\u2B50" : "\u2606"),
        react.createElement("button", {
          className: "cm-op",
          title: "编辑",
          onClick: () => startEdit(record)
        }, "\u270E"),
        typeof record.startSeq === "number" && typeof record.endSeq === "number"
          ? react.createElement("button", {
              className: "cm-op",
              title: `删除记录并折叠对话中对应的${typeof record.startIndex === "number" && typeof record.endIndex === "number" ? `第 ${record.startIndex}–${record.endIndex} 条消息` : `消息 #${record.startSeq}–#${record.endSeq}`}(发送下一条消息时执行)`,
              onClick: () => removeWithFold(record)
            }, "\uD83D\uDDD1\uFE0F")
          : null,
        react.createElement("button", {
          className: "cm-op cm-del",
          title: "删除此记录",
          onClick: () => remove(record.id)
        }, "\u2715")
      );

      return react.createElement(
        "div",
        { className: "cm-backdrop", onClick: props.onClose },
        react.createElement(
          "div",
          { className: "cm-window", onClick: (event) => event.stopPropagation() },
          react.createElement(
            "div",
            { className: "cm-head" },
            react.createElement("span", null, "上下文管理"),
            react.createElement(
              "div",
              { className: "cm-head-actions" },
              react.createElement("button", {
                className: "cm-tool",
                title: "导出为 Markdown",
                onClick: () => downloadFile("context-records.md", exportMarkdown(all), "text/markdown")
              }, "导出 MD"),
              react.createElement("button", {
                className: "cm-tool",
                title: "导出为 JSON",
                onClick: () => downloadFile("context-records.json", exportJson(all), "application/json")
              }, "导出 JSON"),
              react.createElement("button", {
                className: "cm-tool",
                title: "压缩对话历史：把早期消息折叠成摘要，降低上下文占用（已用百分比）",
                onClick: compactConversation
              }, "压缩对话"),
              react.createElement("button", {
                className: "cm-tool cm-danger",
                title: "清空当前会话全部记录",
                onClick: clearAll
              }, "清空"),
              react.createElement("button", {
                className: "cm-tool cm-danger",
                title: "清空所有会话的全部记录(全局置顶也会清掉)",
                onClick: () => {
                  if (busy) return;
                  if (!window.confirm("确定清空所有会话的全部上下文记录？包括跨会话置顶。此操作不可撤销！")) return;
                  if (!window.confirm("再次确认：真的要清空所有会话的记录吗？")) return;
                  setBusy(true);
                  setError("");
                  rpc("clearAll", {}).then((res) => {
                    if (res.ok) {
                      load();
                      setError(`已清空 ${res.value.cleared ?? 0} 条记录`);
                    } else setError(res.error?.message ?? "清空失败");
                  }).catch((cause) => {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  }).finally(() => setBusy(false));
                }
              }, "清空全部"),
              react.createElement("button", { className: "cm-close", onClick: props.onClose, title: "关闭" }, "\u2715")
            )
          ),
          react.createElement(
            "div",
            { className: "cm-tabs" },
            react.createElement("button", { className: "cm-tab" + (tab === "records" ? " cm-tab-active" : ""), onClick: () => setTab("records") }, "记录"),
            react.createElement("button", { className: "cm-tab" + (tab === "global" ? " cm-tab-active" : ""), onClick: () => setTab("global") }, "全局置顶"),
            react.createElement("button", { className: "cm-tab" + (tab === "conversation" ? " cm-tab-active" : ""), onClick: () => setTab("conversation") }, "真实对话"),
            react.createElement("button", { className: "cm-tab" + (tab === "injection" ? " cm-tab-active" : ""), onClick: () => setTab("injection") }, "注入设置")
          ),
          tab === "records" ? react.createElement(
            react.Fragment,
            null,
            react.createElement(
              "div",
              { className: "cm-search" },
              react.createElement("input", {
                type: "text",
                placeholder: "搜索总结或描述…",
                value: query,
                onChange: (event) => setQuery(event.target.value)
              }),
              react.createElement(
                "div",
                { className: "cm-new-row" },
                react.createElement("button", {
                  className: "cm-tool",
                  onClick: () => setNewOpen((open) => !open)
                }, newOpen ? "收起新建" : "＋ 手动新建记录"),
                newOpen
                  ? react.createElement(
                      react.Fragment,
                      null,
                      react.createElement("textarea", {
                        className: "cm-new-input",
                        rows: 2,
                        placeholder: "总结(必填)",
                        value: newSummary,
                        onChange: (event) => setNewSummary(event.target.value)
                      }),
                      react.createElement("textarea", {
                        className: "cm-new-input",
                        rows: 1,
                        placeholder: "描述(可选)",
                        value: newDescription,
                        onChange: (event) => setNewDescription(event.target.value)
                      }),
                      react.createElement("button", {
                        className: "cm-tool",
                        disabled: busy || newSummary.trim().length === 0,
                        onClick: () => {
                          if (busy) return;
                          setBusy(true);
                          setError("");
                          rpc("record", {
                            sessionId: props.sessionId,
                            summary: newSummary,
                            description: newDescription
                          }).then((res) => {
                            if (res.ok) {
                              setNewSummary("");
                              setNewDescription("");
                              setNewOpen(false);
                              load();
                            } else setError(res.error?.message ?? "新建失败");
                          }).catch((cause) => {
                            setError(cause instanceof Error ? cause.message : String(cause));
                          }).finally(() => setBusy(false));
                        }
                      }, "保存新记录")
                    )
                  : null
              )
            ),
          react.createElement(
            "div",
            { className: "cm-list" },
            records === null
              ? react.createElement("div", { className: "cm-empty" }, "加载中…")
              : items.length === 0
                ? react.createElement("div", { className: "cm-empty" }, needle.length > 0 ? "没有匹配的记录" : "还没有记录——对话后会自动生成。")
                : items.map((record, index) => {
                    const isEditing = editingId === record.id;
                    return react.createElement(
                      "div",
                      {
                        key: record.id,
                        className: "cm-item" +
                          (overIndex === index && dragIndex !== null ? " cm-over" : "") +
                          (record.global === true ? " cm-global" : ""),
                        draggable: !isEditing,
                        onDragStart: () => setDragIndex(index),
                        onDragOver: (event) => {
                          event.preventDefault();
                          setOverIndex(index);
                        },
                        onDragLeave: () => setOverIndex((current) => (current === index ? null : current)),
                        onDrop: (event) => {
                          event.preventDefault();
                          onDrop(index);
                        },
                        onDragEnd: () => {
                          setDragIndex(null);
                          setOverIndex(null);
                        }
                      },
                      react.createElement("span", { className: "cm-rank" }, String(index + 1)),
                      react.createElement(
                        "div",
                        { className: "cm-body" },
                        isEditing
                          ? react.createElement(
                              "div",
                              { className: "cm-edit-area" },
                              react.createElement("textarea", {
                                rows: 3,
                                value: editSummary,
                                placeholder: "总结",
                                onChange: (event) => setEditSummary(event.target.value)
                              }),
                              react.createElement("textarea", {
                                rows: 2,
                                value: editDescription,
                                placeholder: "简要描述",
                                onChange: (event) => setEditDescription(event.target.value)
                              }),
                              react.createElement(
                                "div",
                                { className: "cm-edit-actions" },
                                react.createElement("button", { className: "cm-tool", onClick: () => saveEdit(record.id) }, "保存"),
                                react.createElement("button", { className: "cm-tool", onClick: cancelEdit }, "取消")
                              )
                            )
                          : react.createElement(
                              react.Fragment,
                              null,
                              react.createElement("div", { className: "cm-summary" }, record.summary),
                              record.description !== void 0 && record.description.length > 0
                                ? react.createElement("div", { className: "cm-desc" }, record.description)
                                : null
                            ),
                        react.createElement(
                          "div",
                          { className: "cm-meta" },
                          formatTime(record.createdAt),
                          typeof record.startSeq === "number" && typeof record.endSeq === "number"
                            ? react.createElement("button", {
                                className: "cm-global-badge cm-range-jump",
                                title: "跳到真实对话中的对应位置",
                                onClick: (event) => {
                                  event.stopPropagation();
                                  setJumpTo({ startSeq: record.startSeq, endSeq: record.endSeq });
                                  setTab("conversation");
                                }
                              },
                                typeof record.startIndex === "number" && typeof record.endIndex === "number"
                                  ? `对话第 ${record.startIndex}–${record.endIndex} 条消息 ↗`
                                  : `对话 #${record.startSeq}–#${record.endSeq} ↗`)
                            : null,
                          record.global === true ? react.createElement("span", { className: "cm-global-badge" }, "🌐 全局") : null
                        )
                      ),
                      recordOps(record, index)
                    );
                  })
            )
          ) : tab === "global"
            ? react.createElement(GlobalPanel, { sessionId: props.sessionId, onRecordsChanged: () => load() })
            : tab === "conversation"
              ? react.createElement(ConversationPanel, { sessionId: props.sessionId, jumpTo: jumpTo, onJumpConsumed: () => setJumpTo(null) })
              : react.createElement(InjectionPanel, { sessionId: props.sessionId }),
          react.createElement(
            "div",
            { className: "cm-foot" },
            react.createElement("span", null, all.length + " 条记录 · 拖拽排序：越靠上越重要 · ⭐ 跨会话置顶"),
            error.length > 0 ? react.createElement("span", { className: "cm-err" }, error) : null
          )
        )
      );
    }

    // ── 全局置顶 tab: every cross-session pinned record ────────────────────

    function GlobalPanel(props) {
      const [globals, setGlobals] = react.useState(null);
      const [error, setError] = react.useState("");
      const [busy, setBusy] = react.useState(false);

      const load = react.useCallback(() => {
        rpc("listGlobal", {}).then((res) => {
          if (res.ok) {
            setGlobals(res.value.records ?? []);
            setError("");
          } else {
            setError(res.error?.message ?? "读取失败");
          }
        }).catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
      }, []);

      react.useEffect(() => {
        load();
      }, [load]);

      const unpin = (record) => {
        if (busy) return;
        setBusy(true);
        rpc("setGlobal", { sessionId: record.sessionId, id: record.id, global: false }).then((res) => {
          if (res.ok) {
            load();
            props.onRecordsChanged?.();
          } else setError(res.error?.message ?? "取消置顶失败");
        }).catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        }).finally(() => setBusy(false));
      };

      const rows = globals === null ? [] : globals;
      return react.createElement(
        react.Fragment,
        null,
        react.createElement(
          "div",
          { className: "cm-conv-head" },
          react.createElement("span", { className: "cm-conv-total" },
            globals === null ? "加载中…" : `${rows.length} 条跨会话置顶 · 注入所有会话,永不自动清理`
          ),
          react.createElement("button", { className: "cm-tool", onClick: load }, "刷新")
        ),
        error.length > 0 ? react.createElement("div", { className: "cm-search" }, react.createElement("span", { className: "cm-err" }, error)) : null,
        react.createElement(
          "div",
          { className: "cm-global-list" },
          globals === null
            ? react.createElement("div", { className: "cm-empty" }, "加载中…")
            : rows.length === 0
              ? react.createElement("div", { className: "cm-empty" }, "还没有跨会话置顶——在「记录」页点 ⭐ 置顶一条。")
              : rows.map((record) =>
                  react.createElement(
                    "div",
                    { key: record.sessionId + ":" + record.id, className: "cm-global-row" },
                    react.createElement("span", { className: "cm-rank" }, "\u2B50"),
                    react.createElement(
                      "div",
                      { className: "cm-body" },
                      react.createElement("div", { className: "cm-summary" }, record.summary),
                      react.createElement("div", { className: "cm-meta" }, `来自会话 ${record.sessionId.slice(0, 18)}… · ${formatTime(record.createdAt)}`)
                    ),
                    react.createElement(
                      "div",
                      { className: "cm-ops" },
                      react.createElement("button", {
                        className: "cm-op cm-del",
                        title: "取消跨会话置顶",
                        onClick: () => unpin(record)
                      }, "\u2715")
                    )
                  )
                )
        )
      );
    }

    // ── 真实对话 tab: the ACTUAL model-visible conversation ─────────────

    const ROLE_LABELS = { user: "用户", assistant: "助手", tool: "工具", other: "其他" };

    function foldStatusText(info) {
      if (info === null) return "";
      switch (info.status) {
        case "queued": return "已排队:发送下一条消息时执行…";
        case "running": return "正在折叠…";
        case "done": return "✓ " + (info.message ?? "已折叠为摘要");
        case "failed": return "✗ " + (info.message ?? "折叠失败");
        default: return "";
      }
    }

    function ConversationPanel(props) {
      const [state, setState] = react.useState(null);
      const [error, setError] = react.useState("");
      const [rangeStart, setRangeStart] = react.useState(null);
      const [rangeEnd, setRangeEnd] = react.useState(null);
      const [expanded, setExpanded] = react.useState({});
      const [busy, setBusy] = react.useState(false);
      const [foldInfo, setFoldInfo] = react.useState(null);
      const [highlightSeq, setHighlightSeq] = react.useState(null);
      const [foldHistory, setFoldHistory] = react.useState(null);
      const aliveRef = react.useRef(true);
      react.useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
        };
      }, []);

      const load = react.useCallback(() => {
        rpc("conversationList", { sessionId: props.sessionId }).then((res) => {
          if (!aliveRef.current) return;
          if (res.ok) {
            setState(res.value);
            setError("");
          } else {
            setError(res.error?.message ?? "读取失败");
          }
        }).catch((cause) => {
          if (aliveRef.current) setError(cause instanceof Error ? cause.message : String(cause));
        });
        rpc("foldHistory", { sessionId: props.sessionId }).then((res) => {
          if (!aliveRef.current) return;
          if (res.ok) setFoldHistory(res.value.history ?? []);
        }).catch(() => {});
      }, [props.sessionId]);

      react.useEffect(() => {
        load();
      }, [load]);

      // #3: jump from a record card — scroll the matching node into view and
      // highlight it once the conversation has loaded.
      react.useEffect(() => {
        if (props.jumpTo === null || props.jumpTo === void 0 || state === null) return;
        const { startSeq } = props.jumpTo;
        const found = state.nodes.find((node) => node.seq === startSeq) ?? state.nodes[0];
        if (found === void 0) {
          props.onJumpConsumed?.();
          return;
        }
        setHighlightSeq(found.seq);
        window.setTimeout(() => {
          const el = document.getElementById("cm-node-" + found.seq);
          if (el !== null && el !== void 0) el.scrollIntoView({ block: "center", behavior: "smooth" });
        }, 80);
        window.setTimeout(() => setHighlightSeq(null), 3000);
        props.onJumpConsumed?.();
      }, [props.jumpTo, state]);

      // #5: while picking a fold range, validate boundary roles live so the
      // user knows before committing whether the fold will be balanced.
      const pickStart = (node) => {
        setRangeStart(node.seq);
        if (node.role !== "user") {
          setError("提示:折叠起点建议选「用户」消息(边界平衡,否则执行时可能失败)");
        } else {
          setError("");
        }
      };
      const pickEnd = (node) => {
        setRangeEnd(node.seq);
        if (node.role !== "assistant") {
          setError("提示:折叠终点建议选「助手」消息(边界平衡,否则执行时可能失败)");
        } else {
          setError("");
        }
      };

      const fold = () => {
        if (busy) return;
        if (rangeStart === null || rangeEnd === null || rangeStart === rangeEnd) {
          setError("请先选择起点和终点(两条不同的消息)");
          return;
        }
        const lo = Math.min(rangeStart, rangeEnd);
        const hi = Math.max(rangeStart, rangeEnd);
        if (!window.confirm(`将第 ${lo}–${hi} 条消息折叠为摘要?\n任意条数都可以(自动切成平衡段逐段折叠);这些消息会从模型上下文中移除(追加式日志,不可撤销),并在你发送下一条消息时执行。`)) return;
        setBusy(true);
        setFoldInfo({ status: "queued" });
        setError("");
        rpc("foldRange", { sessionId: props.sessionId, start: lo, end: hi }).then((res) => {
          if (!res.ok) {
            if (aliveRef.current) {
              setFoldInfo(null);
              setError(res.error?.message ?? "排队失败");
              setBusy(false);
            }
            return;
          }
          let tries = 0;
          const timer = setInterval(() => {
            tries += 1;
            rpc("foldStatus", { sessionId: props.sessionId }).then((st) => {
              if (!aliveRef.current) {
                clearInterval(timer);
                return;
              }
              if (!st.ok) return;
              const status = st.value.status;
              if (status === "done" || status === "failed" || tries >= 30) {
                clearInterval(timer);
                setFoldInfo(st.value);
                setBusy(false);
                load();
              } else {
                setFoldInfo(st.value);
              }
            }).catch(() => {
              clearInterval(timer);
              if (aliveRef.current) setBusy(false);
            });
          }, 2000);
        }).catch((cause) => {
          if (aliveRef.current) {
            setFoldInfo(null);
            setError(cause instanceof Error ? cause.message : String(cause));
            setBusy(false);
          }
        });
      };

      const nodes = state === null ? [] : state.nodes;
      const inRange = (seq) => {
        if (rangeStart === null || rangeEnd === null) return false;
        const lo = Math.min(rangeStart, rangeEnd);
        const hi = Math.max(rangeStart, rangeEnd);
        return seq >= lo && seq <= hi;
      };

      return react.createElement(
        react.Fragment,
        null,
        react.createElement(
          "div",
          { className: "cm-conv-head" },
          react.createElement("span", { className: "cm-conv-total" },
            state === null ? "加载中…" : `${nodes.length} 条消息 · 上下文估计 ${state.totalTokens} tokens`
          ),
          react.createElement("button", { className: "cm-tool", title: "刷新真实对话", onClick: load, disabled: busy }, "刷新")
        ),
        error.length > 0 ? react.createElement("div", { className: "cm-search" }, react.createElement("span", { className: "cm-err" }, error)) : null,
        react.createElement(
          "div",
          { className: "cm-conv-list" },
          state === null
            ? react.createElement("div", { className: "cm-empty" }, "加载中…")
            : nodes.length === 0
              ? react.createElement("div", { className: "cm-empty" }, "还没有对话消息。")
              : nodes.map((node) => {
                  const isStart = node.seq === rangeStart;
                  const isEnd = node.seq === rangeEnd;
                  const isHighlight = node.seq === highlightSeq;
                  const text = node.text.length > 0 ? node.text : (node.hasBlocks === true ? "[包含非文本块(工具调用/图片等)]" : "(空消息)");
                  const clamped = text.length > 300 && expanded[node.seq] !== true;
                  return react.createElement(
                    "div",
                    { key: node.seq, id: "cm-node-" + node.seq, className: "cm-conv-node" + (inRange(node.seq) ? " cm-in-range" : "") + (isHighlight ? " cm-node-highlight" : "") },
                    react.createElement("span", { className: "cm-conv-seq" }, String(node.seq)),
                    react.createElement(
                      "div",
                      { className: "cm-conv-body" },
                      react.createElement("span", { className: "cm-conv-role cm-role-" + node.role }, ROLE_LABELS[node.role] ?? "其他"),
                      react.createElement("div", { className: "cm-conv-text" + (clamped ? " cm-clamped" : "") }, text),
                      react.createElement(
                        "div",
                        { className: "cm-conv-meta" },
                        react.createElement("span", null, "≈" + node.tokens + " tokens"),
                        text.length > 300
                          ? react.createElement("button", {
                              className: "cm-range-btn",
                              onClick: () => setExpanded((cur) => ({ ...cur, [node.seq]: !(cur[node.seq] === true) }))
                            }, expanded[node.seq] === true ? "收起" : "展开")
                          : null
                      )
                    ),
                    react.createElement(
                      "div",
                      { className: "cm-conv-ops" },
                      react.createElement("button", {
                        className: "cm-range-btn" + (isStart ? " cm-on" : ""),
                        title: "设为折叠起点(建议用户消息)",
                        onClick: () => pickStart(node)
                      }, isStart ? "起点✓" : "起点"),
                      react.createElement("button", {
                        className: "cm-range-btn" + (isEnd ? " cm-on" : ""),
                        title: "设为折叠终点(建议助手消息)",
                        onClick: () => pickEnd(node)
                      }, isEnd ? "终点✓" : "终点")
                    )
                  );
                })
        ),
        react.createElement(
          "div",
          { className: "cm-foldbar" },
          react.createElement("span", null,
            rangeStart === null || rangeEnd === null
              ? "选任意范围(几条到几十条都行,自动切平衡段),折叠成摘要(旧文本从上下文移除)"
              : `已选 ${Math.min(rangeStart, rangeEnd)} – ${Math.max(rangeStart, rangeEnd)}` + (foldInfo !== null ? " · " + foldStatusText(foldInfo) : "")
          ),
          react.createElement("button", {
            className: "cm-tool",
            title: "排队到下一次对话开始时执行",
            disabled: busy || rangeStart === null || rangeEnd === null,
            onClick: fold
          }, busy ? "处理中…" : "折叠选中范围")
        ),
        foldHistory !== null && foldHistory.length > 0
          ? react.createElement(
              "div",
              { className: "cm-fold-history", title: "最近的折叠审计" },
              react.createElement("span", { className: "cm-fold-history-label" }, "最近折叠:"),
              foldHistory.slice(0, 3).map((entry) =>
                react.createElement("span", { key: (entry.at ?? 0) + "-" + (entry.startSeq ?? "auto"), className: "cm-fold-history-item" },
                  entry.auto === true
                    ? "自动压缩 " + formatTime(entry.at).slice(0, 19)
                    : `#${entry.startSeq}–#${entry.endSeq} ${formatTime(entry.at).slice(0, 19)}`
                )
              )
            )
          : null
      );
    }

    // ── 注入设置 tab: custom text + tunable injection parameters ──────────

    const INJECTION_SETTING_FIELDS = [
      { key: "maxInjected", label: "本会话记录注入条数", min: 0, max: 100 },
      { key: "maxGlobalInjected", label: "跨会话置顶注入条数", min: 0, max: 100 },
      { key: "maxInjectionChars", label: "注入块总字符预算", min: 1, max: 20000 },
      { key: "maxCharsPerRecord", label: "每条记录字符预算", min: 1, max: 2000 },
      { key: "maxRecordsPerSession", label: "每会话记录上限", min: 1, max: 10000 }
    ];

    function InjectionPanel(props) {
      const [text, setText] = react.useState("");
      const [loaded, setLoaded] = react.useState(false);
      const [busy, setBusy] = react.useState(false);
      const [message, setMessage] = react.useState("");
      const [settings, setSettingsState] = react.useState(null);
      const [settingsBusy, setSettingsBusy] = react.useState(false);
      const [settingsMessage, setSettingsMessage] = react.useState("");
      const [preview, setPreview] = react.useState(null);
      const [previewBusy, setPreviewBusy] = react.useState(false);
      const [settingsOpen, setSettingsOpen] = react.useState(false);

      react.useEffect(() => {
        let alive = true;
        rpc("getInjectionText", { sessionId: props.sessionId }).then((res) => {
          if (!alive) return;
          if (res.ok) {
            setText(res.value.text ?? "");
            setLoaded(true);
          }
        }).catch(() => {});
        rpc("getSettings", {}).then((res) => {
          if (!alive) return;
          if (res.ok) setSettingsState(res.value.settings ?? null);
        }).catch(() => {});
        return () => {
          alive = false;
        };
      }, [props.sessionId]);

      const save = () => {
        if (busy) return;
        setBusy(true);
        setMessage("");
        rpc("setInjectionText", { sessionId: props.sessionId, text }).then((res) => {
          setMessage(res.ok ? "已保存,下一轮对话开始生效" : (res.error?.message ?? "保存失败"));
        }).catch((cause) => {
          setMessage(cause instanceof Error ? cause.message : String(cause));
        }).finally(() => setBusy(false));
      };

      const setSetting = (key, raw) => {
        const n = Number(raw);
        setSettingsState((cur) => cur === null ? cur : { ...cur, [key]: Number.isFinite(n) ? Math.round(n) : cur[key] });
      };

      const setToggle = (key, value) => {
        setSettingsState((cur) => cur === null ? cur : { ...cur, [key]: value });
      };

      const saveSettings = () => {
        if (settingsBusy || settings === null) return;
        setSettingsBusy(true);
        setSettingsMessage("");
        rpc("setSettings", {
          patch: {
            maxInjected: settings.maxInjected,
            maxGlobalInjected: settings.maxGlobalInjected,
            maxInjectionChars: settings.maxInjectionChars,
            maxCharsPerRecord: settings.maxCharsPerRecord,
            maxRecordsPerSession: settings.maxRecordsPerSession,
            injectIntoMessages: settings.injectIntoMessages === true
          }
        }).then((res) => {
          setSettingsMessage(res.ok ? "已保存,下一轮对话开始生效" : (res.error?.message ?? "保存失败"));
        }).catch((cause) => {
          setSettingsMessage(cause instanceof Error ? cause.message : String(cause));
        }).finally(() => setSettingsBusy(false));
      };

      const loadPreview = () => {
        if (previewBusy) return;
        setPreviewBusy(true);
        setPreview(null);
        rpc("previewInjection", { sessionId: props.sessionId }).then((res) => {
          if (res.ok) {
            setPreview(res.value ?? { text: "", parts: [] });
          } else {
            setPreview({ text: "", parts: [], error: res.error?.message ?? "未知错误" });
          }
        }).catch((cause) => {
          setPreview({ text: "", parts: [], error: cause instanceof Error ? cause.message : String(cause) });
        }).finally(() => setPreviewBusy(false));
      };

      const partClass = (label) => {
        if (label.includes("本会话记录")) return " cm-part-session";
        if (label.includes("跨会话置顶")) return " cm-part-global";
        if (label.includes("自定义注入")) return " cm-part-custom";
        return "";
      };

      return react.createElement(
        "div",
        { className: "cm-inject" },
        react.createElement("div", { className: "cm-inject-hint" },
          "③ 自定义注入:这里写的文本会作为真实消息注入每次模型请求的开头(与 ① 本会话记录、② 跨会话置顶 一起)。适合固定规则、项目约定、风格要求——让模型每轮都看到。保存 = 整体替换。"
        ),
        react.createElement("textarea", {
          className: "cm-inject-text",
          placeholder: "输入要注入到对话上下文中的文本…",
          value: text,
          disabled: !loaded,
          onChange: (event) => setText(event.target.value)
        }),
        react.createElement(
          "div",
          { className: "cm-inject-row" },
          react.createElement("button", { className: "cm-tool", onClick: save, disabled: busy || !loaded }, busy ? "保存中…" : "保存注入文本"),
          react.createElement("button", { className: "cm-tool", onClick: loadPreview, disabled: previewBusy }, previewBusy ? "生成中…" : "预览注入块(分块显示)"),
          message.length > 0 ? react.createElement("span", { className: message.startsWith("已") ? "cm-ok" : "cm-err" }, message) : null
        ),
        preview === null
          ? react.createElement("div", { className: "cm-preview-empty" }, "点「预览注入块」查看三部分(① 记录 ② 置顶 ③ 自定义)合成出来的注入内容")
          : typeof preview.error === "string"
            ? react.createElement("div", { className: "cm-preview-empty" }, "预览失败:" + preview.error)
            : react.createElement(
                "div",
                { className: "cm-preview-parts" },
                preview.enabled === false
                  ? react.createElement("div", { className: "cm-preview-note cm-preview-note-off" }, "⚠ 消息注入当前已关闭(设置里关了开关),此预览内容不会真正注入")
                  : null,
                (() => {
                  const customPart = (preview.parts ?? []).find((part) => part.label.includes("自定义注入"));
                  const unsaved = customPart !== void 0 && text.trim() !== customPart.text;
                  return unsaved
                    ? react.createElement("div", { className: "cm-preview-note" }, "⚠ 文本框有未保存的修改——预览显示的是已保存的内容")
                    : null;
                })(),
                preview.parts.length === 0
                  ? react.createElement("div", { className: "cm-preview-empty" }, "(当前没有可注入的内容:记录为空且无自定义文本)")
                  : preview.parts.map((part) =>
                      react.createElement(
                        "div",
                        { key: part.label, className: "cm-preview-part" },
                        react.createElement(
                          "div",
                          { className: "cm-preview-part-head" },
                          react.createElement("span", { className: "cm-preview-part-label" + partClass(part.label) }, "【" + part.label + "】"),
                          react.createElement("span", { className: "cm-preview-part-chars" }, part.chars + " 字符")
                        ),
                        react.createElement("pre", { className: "cm-preview-text" }, part.text)
                      )
                    )
              ),
        react.createElement("div", { className: "cm-inject-settings" },
          react.createElement(
            "button",
            {
              className: "cm-settings-toggle",
              onClick: () => setSettingsOpen((open) => !open)
            },
            react.createElement("span", null, "⚙ 注入量设置"),
            settings !== null
              ? react.createElement("span", { className: "cm-settings-summary" },
                  `本会话 ${settings.maxInjected} 条 · 置顶 ${settings.maxGlobalInjected} 条 · 上限 ${settings.maxRecordsPerSession} 条` + (settings.injectIntoMessages === true ? "" : " · 注入已关"))
              : null,
            react.createElement("span", { className: "cm-settings-caret" }, settingsOpen ? "▾" : "▸")
          ),
          settingsOpen
            ? (settings === null
                ? react.createElement("div", { className: "cm-empty" }, "加载中…")
                : react.createElement(
                    react.Fragment,
                    null,
                    INJECTION_SETTING_FIELDS.map((field) =>
                      react.createElement(
                        "label",
                        { key: field.key, className: "cm-inject-field" },
                        react.createElement("span", null, field.label),
                        react.createElement("input", {
                          type: "number",
                          min: field.min,
                          max: field.max,
                          value: settings[field.key] ?? 0,
                          onChange: (event) => setSetting(field.key, event.target.value)
                        })
                      )
                    ),
                    react.createElement(
                      "label",
                      { className: "cm-inject-field" },
                      react.createElement("span", null, "启用消息注入(关闭则模型请求不再前置注入块)"),
                      react.createElement("input", {
                        type: "checkbox",
                        checked: settings.injectIntoMessages === true,
                        onChange: (event) => setToggle("injectIntoMessages", event.target.checked)
                      })
                    ),
                    react.createElement(
                      "div",
                      { className: "cm-inject-row" },
                      react.createElement("button", { className: "cm-tool", onClick: saveSettings, disabled: settingsBusy }, settingsBusy ? "保存中…" : "保存注入设置"),
                      settingsMessage.length > 0 ? react.createElement("span", { className: settingsMessage.startsWith("已") ? "cm-ok" : "cm-err" }, settingsMessage) : null
                    )
                  ))
            : null
        )
      );
    }

    // ── plugin body ─────────────────────────────────────────────────────────

    const inject = ["slots", "connection"];

    function apply(ctx) {
      getConnection = () => ctx.connection;
      ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
        name: "conversation.composer.dock",
        id: "context-manager",
        order: 1
      }, DockButton));
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay",
        id: "context-manager-window"
      }, ManagerWindow));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
