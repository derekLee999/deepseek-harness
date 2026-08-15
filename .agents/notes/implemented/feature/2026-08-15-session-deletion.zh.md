# Agent Note: 会话删除

Status: implemented

[English](2026-08-15-session-deletion.md) | 中文

## 问题

归档会话只是隐藏了行：日志与 workspace 记账槽位仍在本地保留，产品里没有任何入口能真正移除一段会话的存储记录。从「从我的列表里藏起来」升级到「这段对话不该继续存在于这台机器上」的用户没有路可走，GUI 的归档动作也没有破坏性对等项。

该空白的施工规范已在 [domain-KV/workspace 设计 Note](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) 中定案：`SessionPersistence.delete` 原语、位于存储提交点的 `session-persistence/deleted` 事件，以及一套编排规则（无运行中目标、默认仅叶子可删、自底向上递归、幂等重跑）。本 Note 记录该规范的落地方式。

## 决策

`workspace.deleteSession({ sessionId })` 永久删除一个会话的存储日志，并剪除其所有本地投影：

1. **活跃性检查。** 轮次正在运行的活动会话（`agent.status === 'running'`）以 `session-running` 失败——删除绝不杀死任务；调用方先等轮次结束或取消它。由 subagent 激活拥有的活动会话（`origin: 'subagent'` 或已注册到激活）以 `session-busy` 失败——网关对激活拥有的生命周期没有拆除权。空闲且由网关自己创建或恢复的活动会话则被拆除：网关通过按会话 id 保留的 `AgentHandle` 组合 cancel+dispose，而不是让存储去停循环。保留覆盖了让会话变为活动的每一条路径——网关自己的 `ensureSession` 与 fork 路径存储其句柄，共享的远程 Agent 解析器（`dsh-api-remotes` 的 `createApiRemoteAgentResolver`）则经其 `onHandle` 汇报告每次冷恢复的句柄（它原本丢弃句柄，导致经通用入口如 `session.prompt` 恢复的会话无法被删除）。句柄存储是模块级、以 root 上下文为键的（沿用 `dsh-mcp-client` 的 root 键控预留模式）：网关插件热重载时，其 Agent——生命周期效应挂在 root fiber 上——仍在运行，因此把存储放在单个网关代际的闭包里，会让重载前打开的每个会话都变成不可删除。
2. **后代检查。** 任何活动会话（`ctx.sessions`）或持久化 header 的 `parentSession` 指向目标——fork 血统与 subagent 血统一视同仁——都会以 `session-has-descendants` 失败并携带子会话 id。仅叶子可删；按既定规范，递归删除仍属未来工作。
3. **存储删除。** `ctx.sessionPersistence.delete(id)` 在 per-id 写链上执行（与在途 append 串行化，并先等待活动会话的销毁排水）。未知 id 拒绝；未物化的 create 意图被取消并正常返回；JSONL 后端 unlink 两种物理编码并移除清空后的会话目录，SQLite 后端在一个事务中删除 `events` + `sessions` 行。严格在持久删除完成后，协调器发出 `'session-persistence/deleted'(id)`——派生存储与主机流所使用的已通知提交点。
4. **注册表剪除。** `ctx.workspaceRegistry.deleteSession(id)` 把该 id 从每个 workspace 记录的会话账上移除（经实体写剪除：盖章 `updatedAt`、发出变更）、从注册表级归档集合移除、并从 header/path 索引移除，全部串行在注册表操作链上。未知 id 是幂等 no-op，因此崩溃后重跑必然收敛。

错误码 `session-busy`、`session-running` 与 `session-has-descendants` 加入 `RpcErrorDetailsMap`（以及线路判别联合）；成功返回 `{ deleted: true }` 且不带任何投影——已提交的移除都走主机帧。

## 帧投递

活动删除的 `session/disposed` 本来就会推 `host/session-removed`；冷会话——已持久化但在本次主机运行中从未附加——没有可供成帧的销毁边。因此主机流额外订阅 `session-persistence/deleted` 并推送 `host/session-removed`，让一个提交点同时覆盖两种删除形态（活动删除会额外推一条无害的重复移除帧；客户端移除处理是幂等的）。workspace 记账与归档集合更新沿用既有的 `host/workspace-changed` 与 `host/archived-sessions-changed` 帧（由 `domain/changed` 驱动），与归档、attach 完全一致。

## 客户端收敛

`WorkspaceRuntime.deleteSession` 是 UI 背后的 workspaces-service 动词：它调用 RPC，并在被删 id 恰为当前选中项时把它清空进 New Session 视图状态——释放居留的 scope，而不是把它挡在已删行掩罩后面。其余全部通过帧收敛：会话列表镜像在 `host/session-removed` 时摘除该行，workspace manager 则在任何在途 `workspace.list` 基线上重放记账与归档集合帧。删除确认框会一直保持打开，直到被删行已从实时 `useSessions` 投影中渲染消失（帧即提交通知），与 Workspace 删除对话框一致。

## 确认交互

会话行菜单在归档行下方新增 `删除会话` / `Delete session` 条目，采用与 Workspace 删除行相同的 `IconTrashOutline16` + `danger` 处理。它打开浏览器自有的确认 `Modal`（「将永久删除…本地会话记录与日志，此操作无法撤销」），在请求进行中阻止重复提交，失败时在原位显示错误，Cancel/Escape/Close 绝不发起 RPC。

## 对既定规范的偏离

- **端点命名空间。** 规范写的是 `session.delete` 端点，成文于 `workspace.*` RPC 表面出现之前。删除与 `workspace.archiveSession` 一样修改注册表状态（记账 + 归档集合），因此以 `workspace.deleteSession` 落地，保持与对等项的对称；编排规则原样沿用规范。
- **派生存储走 reconcile 而非订阅。** 规范要求派生数据订阅 `session-persistence/deleted`。`dsh-session-query-sqlite` 已经在每次搜索时对照 `listSnapshots()` 做 reconcile，并删除会话已消失的索引行（generation 进位正确）；再在订阅侧加一次删除会复制这套机制及其游标 generation 记账。沿用既有 reconcile 是刻意选择的实现。
- **暂无递归开关。** 已定案的自底向上递归只以拒绝方向（`session-has-descendants`）落地；当前没有任何调用方需要递归删除，`recursive: true` 仍属未来工作。

## 备选方案

**持久层内自动 cancel。** 拒绝（与规范一致）：cancel/dispose 属于调用方，网关通过其保留的句柄组合它们；持久原语改为拒绝活动身份。

**一元回声携带被删行。** 拒绝：`{ deleted: true }` 加上既有帧词汇，与 Workspace 删除使用同一种收敛方式；再造一个 session-list 回声会给客户端增加一条与帧排序竞争的移除路径。

**为冷删除另设移除帧名。** 拒绝：`host/session-removed` 已经承载「该行从所有客户端列表离开」的语义，持久提交事件恰好为两种形态提供同一个来源。

**先剪注册表、后删存储工件。** 拒绝：破坏性步骤先行，使中途崩溃朝「存储已删、注册表幂等剪除幽灵账」收敛，而不是留下指向复活日志的行。

**对运行中的活动会话直接销毁而非拒绝。** 拒绝：运行中的轮次是用户的工作，删除绝不能在任务中途杀死它。拒绝码（`session-running`）保留了已交付的 cancel 路径作为停止任务的唯一方式。

## 验证

持久协调器测试钉住 deleted 事件（及抛错监听者的隔离）、活动/保留拒绝、串行化与幂等二次删除；共享后端契约在 memory、JSONL（两种编码）与 SQLite 上钉住永久移除、未知重跑、id 可重建与意图取消。注册表测试钉住记账 + 归档剪除、未知 no-op 与删除后拒绝再归档。apiproxy 测试钉住冷删除的移除帧、经保留句柄的活动拆除及记账/归档帧、经远程解析器恢复的会话（通用 `session.prompt` 路径）的拆除保留、运行中拒绝与转空闲后的删除恢复、root 键控存储跨网关代际的按应用身份、`session-has-descendants`（活动与持久化后代）、`session-busy`（激活拥有与无句柄活动）、`session-not-found` 重跑；carrier 测试钉住请求/值 schema、handler 行与新错误分支解析。客户端运行时测试钉住 RPC 调用、当前选中清空与错误传播；组件测试钉住 danger 样式菜单行、确认文案、行移除后才关闭，以及失败/重试/取消路径。无密钥浏览器场景播种一条冷会话，经行菜单确认删除，并观察该行、JSONL 工件、归档集合与所有 workspace 账在重载后保持消失；第二个场景先打开会话（主机附加其 Agent），再经同一路径删除这条已活动的会话，验证打开状态下的拆除 + 删除流程。

## 后果

删除是破坏性且局部的：会话 header、其日志、workspace 槽位与归档成员资格不可恢复地消失，没有还原路径（与产品文案一致）。删除当前会话会清空进 New Session 视图。运行中的轮次会以 `session-running` 拒绝删除，直到它结束或被取消，因此删除绝不可能摧毁进行中的工作。fork 子会话或 subagent 子会话会阻止其父会话的删除，直到子会话先删——这在偏向上保住了血统完整，递归删除是未来工作的扩展点。网关为它创建或恢复的每个会话在 root 键控存储中保留一个 `AgentHandle`；任何新的网关创建路径都必须把句柄放进去，且该存储按设计可跨网关热重载存活。