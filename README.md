# dsh-context-manager（上下文管理插件）

DeepSeek Harness 的自定义插件：自动记录每次对话交换，按优先级注入 agent 的 prompt，并提供浏览器管理窗口（搜索、编辑、跨会话置顶、拖拽排序、导出、清空）。同时**直接控制实际的对话上下文文本**：查看模型真正看到的每条消息、把选中的历史范围折叠成摘要、把置顶记录/自定义文本注入真实消息流。

## 架构

| 包 | 平面 | 职责 |
|---|---|---|
| `dsh-context-manager-service-luxi` | Host | 持久化存储（`context_manager` domain）+ **全局记录**（所有 preset 的根会话都自动记录，`summarize` 可选 LLM 提炼）+ Remote API：`list` / `count` / `record` / `remove` / `reorder` / `update` / `setGlobal` / `clear` / `listGlobal` / `compact` / `conversationList` / `foldRange` / `foldStatus` / `setInjectionText` / `getInjectionText` / `getSettings` / `setSettings`；根平面 `agent/pre-step` 监听器：执行排队的历史折叠、把记录/自定义文本注入真实消息流 |
| `dsh-context-manager-agent-luxi`（`lib/index.js`） | Agent preset 行 | 仅保留**回退注入**：当服务端消息注入关闭（`injectIntoMessages: false`）时，把记录注入 system-prompt 快照。记录逻辑已退役（2026-08-17 起由服务端全局接管） |
| `dsh-context-manager-ui-luxi` | **Web 层行**（不是 preset 行） | 浏览器 UI：输入框右下角「上下文」按钮 + 管理窗口（记录 / 真实对话 / 注入设置 三个标签页）。host 半是空操作，纯为把客户端 bundle 送进浏览器 |

> ⚠️ **为什么 UI 必须是 Web 层行而不是 preset 行**：浏览器客户端 bundle 由 `clientModules` 服务发现，它只扫描 **loader 条目**（web 组合的行）；agent preset 的组成树是直接插入的作用域子树，**明确不在 `ctx.loader.entries()` 里**（见 `dsh-agent-presets/lib/types/mount.js` 注释），所以 preset 行里挂 `dsh.client` 永远不会被扫描到、bundle 永远 404、页面清单 `window.__DSH_BOOT__` 里也没有它。`dsh-context-manager-ui-luxi` 作为 web patch 行挂载后，UI 在**所有会话**都可用。

> 💡 **记录范围**（2026-08-17 方案 B）：记录从 agent 行搬进 host 服务——**所有 preset 的根会话**都自动记录（子代理/工作流子会话不记录，避免污染与 token 浪费）。之前"只有 my-agent preset 会话才记录"的限制已消除。

## 「控制实际对话上下文」能力

- **真实对话查看**（`conversationList`）：列出模型实际看到的每条消息（角色 / 文本 / token 估算 / 总占用），含之前折叠留下的摘要节点。
- **手动折叠历史**（`foldRange` + `foldStatus`）：在「真实对话」里选一段消息范围，排队到**下一次对话开始时**由服务端在 `agent/pre-step` 内执行 `compaction.compactRegion()`，把旧文本真正折叠成一条摘要（追加式日志下唯一合法的移除方式）。折叠需在回合内执行，所以是「下一条消息后生效」。
- **注入真实消息流**（`setInjectionText` / `getInjectionText` + `injectIntoMessages`）：置顶（⭐）记录、本会话记录、以及「注入设置」里的自定义文本，会作为一条真实消息**前置注入每次模型请求**（pre-step 修改 `messages`），而不是只放在辅助提示块里。

## 安装 / 升级

```powershell
# 从本目录执行：把两个包同步到运行实例的 profiles\node_modules
.\install.ps1
```

> ⚠️ **重要**：Service 和 Agent 插件是 DSH **进程启动时**加载的，改代码后必须**重启 DSH** 才生效（浏览器端 UI 刷新页面即可）。`install.ps1` 结束时也会提醒你。

安装后的接线（首次安装才需要，升级不用动）：

1. **Host 行** —— `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`：

   ```yaml
   - insert:
       - id: compaction-passive
         name: '@deepseek-ai/dsh-compaction-basic'
         config:
           auto: false   # 根平面被动压缩引擎：无自动触发，仅供本服务的 compact/fold 调用
       - id: context-manager
         name: 'dsh-context-manager-service-luxi'
         config:
           maxRecordsPerSession: 200
           injectIntoMessages: true
           maxInjectionChars: 800
           maxInjected: 5
           maxGlobalInjected: 3
           maxCharsPerRecord: 200
   ```

   > ⚠️ **为什么必须有 `compaction-passive` 行**：浏览器按钮和服务端的折叠/压缩需要 `compaction` 在**根平面**可解析，而 `dsh-web-app` bundle 把根平面默认的 `compaction-basic` 禁用掉了（自动压缩移进了 agent preset 的隔离 realm）。这行挂一个 `auto: false` 的**第二实例**——只响应显式调用，绝不自动压缩，因此不会和 preset 里的自动实例打架。
   >
   > **服务端对 `compaction` 是可选依赖**（`ctx.get` 运行时读取，不在 inject 里）：万一这行被删，DSH 依然能正常启动、记录照常工作，只有压缩/折叠按钮报「compaction 服务不可用」。2026-08-16 那次 `dsh web` 启动失败（`pending (waiting for service: compaction)`）正是因为它曾是硬依赖且根平面没有实例——这个坑已经根除。

   还必须在同一文件里加 **UI 行**（让浏览器能加载管理窗口）：

   ```yaml
       - id: context-manager-ui
         name: 'dsh-context-manager-ui-luxi'
   ```

   三者合起来：

   ```yaml
   - insert:
       - id: compaction-passive
         name: '@deepseek-ai/dsh-compaction-basic'
         config:
           auto: false
       - id: context-manager
         name: 'dsh-context-manager-service-luxi'
         config:
           maxRecordsPerSession: 200
           injectIntoMessages: true
           maxInjectionChars: 800
           maxInjected: 5
           maxGlobalInjected: 3
           maxCharsPerRecord: 200
           summarize: true          # LLM 提炼每条交换的总结（false = 纯截断）
           maxSummaryChars: 400
           maxDescriptionChars: 200
           summarizeTimeoutMs: 20000
           summarizeMaxInputChars: 6000
           summarizeMaxOutputTokens: 300
       - id: context-manager-ui
         name: 'dsh-context-manager-ui-luxi'
   ```

2. **Agent 预设行** —— 可选。记录已由服务端全局接管，这行只负责**回退注入**（`injectIntoMessages: false` 时才生效），不挂也可以：

   ```yaml
   - id: context-manager-agent
     name: 'dsh-context-manager-agent-luxi'
     config:
       maxInjected: 5          # 回退注入的当前会话记录条数（服务端消息注入关闭时生效）
       maxGlobalInjected: 3    # 回退注入的跨会话置顶记录条数
       maxCharsPerRecord: 200  # 每条记录注入 prompt 时的字符预算
   ```

## 数据模型

每条记录：

```jsonc
{
  "id": "uuid",
  "summary": "对话总结（加粗，在上）",
  "description": "对话简要描述（在下）",
  "global": false,      // true = 跨会话置顶，注入所有会话，永不被自动清理
  "startSeq": 12,       // 该记录对应的真实对话消息范围（surface seq，自动记录）
  "endSeq": 18,         // 删记录时可选择同时折叠此范围（remove alsoFold）
  "createdAt": 1786817005199
}
```

- 记录按优先级存储：**index 0 = 最重要**，注入 prompt 时按此顺序取前 N 条。
- 自动清理：超过 `maxRecordsPerSession` 时删除 **createdAt 最旧的非置顶**记录（⭐ 置顶记录不受上限影响）。
- LLM 总结（`summarize: true`）：每条交换异步调用当前默认模型路由提炼两行（`总结:` / `描述:`），失败自动回退为截断。

## Remote API（浏览器通过 `connection.rpc.call('/api', 'contextManager/<method>', { args })` 调用）

| 方法 | 参数 | 返回 |
|---|---|---|
| `list` | `sessionId` | `{ records }` |
| `count` | `sessionId` | `{ count }` |
| `record` | `sessionId, summary, description?` | `{ id }` |
| `remove` | `sessionId, id` | `{ removed }` |
| `reorder` | `sessionId, orderedIds[]` | `{ records }` |
| `update` | `sessionId, id, summary?, description?` | `{ updated }` |
| `setGlobal` | `sessionId, id, global` | `{ global }` |
| `clear` | `sessionId` | `{ cleared }` |
| `listGlobal` | — | `{ records }` |
| `compact` | `sessionId` | `{ compacted }`（自动选最旧可用范围折叠，需空闲） |
| `conversationList` | `sessionId` | `{ nodes: [{seq, role, text, hasBlocks, tokens}], totalTokens, surfaceTokens }` |
| `foldRange` | `sessionId, start, end` | `{ queued, requestId }`（下一条消息时执行） |
| `foldStatus` | `sessionId` | `{ status: none\|queued\|running\|done\|failed, message?, at? }` |
| `setInjectionText` | `sessionId, text` | `{ saved }` |
| `getInjectionText` | `sessionId` | `{ text }` |
| `getSettings` | — | `{ settings: { maxInjected, maxGlobalInjected, maxInjectionChars, maxCharsPerRecord, maxRecordsPerSession, injectIntoMessages } }`（含静态配置默认值） |
| `setSettings` | `patch` | `{ saved }`（运行时覆盖注入参数，持久化，重启不丢；未知键忽略） |
| `clearAll` | — | `{ cleared }`（清空所有会话记录，保留运行时设置） |
| `previewInjection` | `sessionId` | `{ text }`（当前注入块合成效果预览） |
| `foldHistory` | `sessionId` | `{ history: [{ at, startSeq, endSeq }] }`（最近的折叠审计，最新在前） |

## 运行时注入设置

「注入设置」标签页除了自定义文本，还能调注入量参数（默认值与 cordis 配置一致，保存后覆盖静态配置，**无需重启**）：

| 键 | 默认 | 含义 |
|---|---|---|
| `maxInjected` | 5 | 每轮注入的本会话记录条数 |
| `maxGlobalInjected` | 3 | 每轮注入的跨会话置顶记录条数 |
| `maxInjectionChars` | 800 | 注入块总字符预算（截断整块） |
| `maxCharsPerRecord` | 200 | 每条记录注入时的字符预算 |
| `maxRecordsPerSession` | 200 | 每会话记录上限（超出清理最旧非置顶记录） |
| `injectIntoMessages` | true | 是否在每轮模型请求前置注入块（临时省 token 可关） |

同页还有「预览注入块」按钮：直接看当前设置 + 记录合成出来的注入文本长什么样。

## 记录 ↔ 真实对话联动

- 每条自动记录会记住它对应的**真实对话消息范围**（`startSeq`/`endSeq`），记录卡片上显示「对话第 X–Y 条消息」（surface 1-based 位置），**点击标签直接跳到真实对话对应位置**（高亮 3 秒）。
- 删除记录时可以用 🗑️ 按钮**同时把该范围排队折叠成摘要**（`remove(alsoFold)`）：摘要删除 + 底层对话文本从模型上下文移除，下一条消息时执行。
- 折叠成功后（`afterFold`）自动**清理受影响记录的范围字段**——被折叠的消息 seq 已从 surface 消失，相关记录退化为「仅摘要」，避免旧范围再次折叠时报错；同时记入折叠审计（真实对话页底部显示最近折叠）。
- 旧记录没有范围字段，不显示联动按钮；折叠范围必须边界平衡，否则执行时报失败（状态显示在「真实对话」页，选起点/终点时也会即时提示建议角色）。

## 其他能力

- **全局置顶管理**：「全局置顶」标签页列出所有跨会话 ⭐ 记录（含所属会话），可一键取消置顶。
- **手动新建记录**：「记录」页有「＋ 手动新建记录」，输入总结/描述直接入库。
- **记录去重**：自动记录时若总结与已有记录完全相同，只刷新时间戳不重复入库。
- **清空全部**：标题栏「清空全部」双确认后清空所有会话的记录（设置保留）。
- **token 估算降级**：`tokenMeter` 不可用时按字符数/4 估算，不再显示全 0。

## 开发

```powershell
# 语法检查
node --check .\dsh-context-manager-service-luxi\lib\index.js
node --check .\dsh-context-manager-agent-luxi\lib\index.js
node --check .\dsh-context-manager-agent-luxi\lib\client.js

# 单元测试（node:test，纯逻辑部分；测试 import 已安装副本，改源码后先跑 .\install.ps1 同步）
.\test\run.ps1

# 等价的直接命令（普通终端可用；受限/沙箱 shell 下 node --test 的子进程管道会被拦截，改用上面脚本）
node --test .\test\
```

## 已知边界

- **记录范围**：服务端只记录**根会话**（主对话）；子代理/工作流子会话的交换不生成记录（避免污染与 LLM 总结开销）。所有 preset 的根会话都会记录（方案 B，2026-08-17 起）。
- **记录粒度**：**一个用户回合 = 一条记录**（`turn/end` 时落库；若回合无回复则下一条用户消息或会话关闭时落库）。回合内多次助手文本输出（工具调用步骤）合并为一条。所以记录条数 ≈ 对话轮数，而不是消息条数——「真实对话」页的消息数（含工具调用/结果）会明显多于记录数，这是预期的。记录卡片上的「对话第 X–Y 条消息」是 surface 中的 1-based 位置，与「真实对话」页序号一致；tooltip 里保留原始事件 seq。
- Service 记录上限、清理策略以服务配置为准；置顶（global）记录永不自动清理。
- LLM 总结走 agent 当前默认模型路由（`agentDefaultModel`），不可用时自动回退截断。
- 记录注入是纯文本（无 markdown），prompt 中显示为编号列表。
- 注入容错：prompt 注入段的读取包在 try/catch 里——host service 短暂不可用（如热重载窗口）时该步只跳过注入并告警一次，不会让回合启动失败；恢复后自动继续注入。
- **折叠是「下一条消息后生效」**：`compactRegion` 只能在回合内（open turn）执行，所以 `foldRange` 先排队、由根平面 pre-step 监听器在下次对话开始时执行；期间不产生新对话则一直排队。折叠范围必须边界平衡（不能切开工具调用/结果对），否则会报失败。排队前会预检所选 seq 是否还在 surface（已折叠过的范围立即报错而不是排队后失败）。
- **折叠状态持久化**：排队中的折叠任务和折叠审计都写入存储，**重启不丢**——重启后下一条消息仍会执行排队折叠，审计列表保留。
- **折叠联动清理**：任何一次折叠（🗑️ 联动、手动范围折叠、标题栏「压缩对话」）成功后，都会把受影响记录的「对话范围」收缩到最近幸存消息（`shrinkRange`）或整体移除，避免旧范围再次折叠时报错；同时记入审计（「压缩对话」显示为「自动压缩」）。
- **注入预算保护**：自定义注入文本优先保留至少一半总预算（最少 `maxCharsPerRecord` 字符），记录再多也不会把自定义注入挤出注入块。
- **消息注入只作用于模型请求**：pre-step 修改的是每步进入模型的消息数组，不改写追加式事件日志；注入消息带 `source.kind: "plugin"` 标记，不会被误记为真实用户输入。
- 注入是「前置一条」：注入消息放在每步 `messages` 的最前面，真实用户输入保持在最后。
- 记录不自动去重（每轮对话一条，手动新建可重复）；`setGlobal(false)` 取消置顶时直接删除字段而非存 `false`；导出 MD/JSON 包含对话范围信息。
