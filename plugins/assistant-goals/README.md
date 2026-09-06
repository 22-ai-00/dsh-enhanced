# @dsh-enhanced/assistant-goals

为 DSH 原生目标保存有 owner 身份的业务上下文：原始目标、当前目标、下一步、阻塞、到期假设、证据引用和依赖。新会话可以找回同一 owner 的目标笔记。原生 `complete` 只显示为 `awaiting-verification`，不代表独立验收通过。

## 安装与启用

本包目前是开发中的独立 bundle，尚未加入标准助手安装场景。正式发布后可安装到已有 profile：

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-goals
dsh --profile web --dump-config
```

Host 须提供 `0.1.2-rc.1` 的 AgentRegistry、GoalService、SessionProjectionRegistry，以及本仓库当前版本的 `assistant-delivery` 和 `assistant-policy`。工具需要 ToolRuntime，动态上下文需要启用 runtime context 的 SystemPrompt。缺少必需服务时插件保持未就绪，不从模型参数推断身份。安装本包不会安装或启用原生 goal-round-driver，不会启动新的模型循环。

**仅有 Web 对话不构成 Delivery owner 证明。** 当前入口要求已有 Delivery 配对和实际 owner 会话；独立 Web owner 配对及一键自治安装尚在开发。使用全局旧版 DSH 或只复用 Web 模型线路，也不能代替 Host 兼容性验证。

可覆盖 bundle 配置：

```yaml
- id: dsh-enhanced-assistant-goals
  name: '@dsh-enhanced/assistant-goals'
  config:
    databasePath: !!js dshHomePath('assistant-goals.sqlite')
    maxContextChars: 12000
```

`databasePath` 默认 `~/.dsh/assistant-goals.sqlite`，必须是绝对路径（仅测试使用 `:memory:`）。`maxContextChars` 为每次自动上下文的字符上限，范围 1,024–65,536。数据超限时返回明确提示，不截断 JSON 或伪造完整证据。

将下面的精确范围规则合并到现有 Policy `rules`，替换 workspace 为实际绝对路径；不要覆盖原有规则。它授权目标创建和笔记操作，工具执行授权仍按 Host/Policy 现有规则处理：

```yaml
- id: primary-business-goal-context
  effect: allow
  subject:
    kind: agent
    id: primary
    workspace: /absolute/path/to/workspace
  actions: [create, edit, pause, resume, clear, observe, inspect, snapshot, focus, checkpoint]
  resource:
    kind: goal
    id: business-context
  context:
    initiators: [external]
```

## 使用

在已认证 owner 的当前人类回合中，用 `goal_create {"objective":"完成九月交付报告","max_goal_rounds":2}` 创建目标。DSH 原生 `create_goal` 只接受 `source.kind: user`；Delivery 保留真实 `delivery` 来源，由本插件核验 owner 当前 turn 后调用原生 GoalService，不伪造直接用户消息。工具执行权限还须按现有 Host/Policy 授权 `goal_create`、`goal_context`、`goal_checkpoint` 和 `goal_control`。

插件在 `goal/changed` 时建立业务记录。安装前已有或身份不明时创建的目标不会被追认，以免归属转移泄漏历史。创建不覆盖尚未完成的原生目标；原生状态为 complete 后可按 DSH 规则创建新的 GoalId，旧业务记录仍保留为待验收；如果目标已经创建而业务索引失败，会明确报告部分完成，先检查原生目标再重试。已有 Host goal-round-driver 若已启用，会按其原生规则继续执行新目标；本插件自身不启用该 driver。

1. `goal_context {}` 列出最近的目标摘要及版本；最多读取 50 条，输出受字符预算约束，`truncated` 明确标记省略。
2. `goal_context {"goal_id":"返回的业务记录 ID"}` 查看原始目标和笔记；业务 ID 与原生 GoalId 不同。
3. 使用返回的 `version` 保存下一步：

```json
{
  "goal_id": "返回的业务记录 ID",
  "expected_version": 1,
  "next_step": "读取当前测试结果，再检查失败原因",
  "blockers": [],
  "assumptions": [{ "statement": "上次测试仍代表当前代码", "expires_at": 0 }],
  "evidence_refs": ["run:example"],
  "dependencies": []
}
```

这是 `goal_checkpoint` 的参数；`expires_at` 是 Unix 毫秒时间，示例 0 表示已到期。版本变化会拒绝旧写入，应重新读取再决定是否更新。依赖只能指向相同 owner record/version、workspace 和 preset 的业务目标，不允许重复、自依赖或环。

新会话使用 `goal_context {"goal_id":"已保存的业务记录 ID","focus":true}` 后，后续模型步骤会收到该目标上下文。focus 只保存引用，不创建、转移、恢复或完成原生目标；开始新的原生目标会切换到新记录。跨会话 focus 和笔记在插件重启后保留。过期假设标记为 `stale`，当前没有自动重查执行器。

## 修改、暂停和恢复

在原目标所属的当前 owner 会话中调用 `goal_control`，`expected_revision` 使用 `goal_context` 返回的 **native.revision**，与保存笔记的 `expected_version` 不同：

```json
{
  "goal_id": "返回的业务记录 ID",
  "expected_revision": 1,
  "operation": "pause"
}
```

操作支持 `edit`、`pause`、`resume`、`clear`。edit 至少提供 `objective` 或 `max_goal_rounds`；其他操作不接受这两个字段。每次操作读取当前原生目标，由 DSH 以调用方的 `expected_revision` 做 CAS，旧值会被拒绝。修改保留 `originalObjective` 和检查点；clear 清除当前原生目标但保留业务记录及历史，不删除数据。

这些操作要求实时 owner 当前回合，并分别获得同名 Policy action 的授权。跨会话 focus 不能据此控制原会话目标；恢复必须在原 Session 完成。原生进程重启后 activation 为 disarmed，存储的 focus 和笔记不会自动重新授权执行。resume 使用原生机制重新激活；它不重置已使用的目标轮次。暂停停止后续原生续跑，不宣称已经终止正在执行的工具、子进程或外部动作。

若原生操作已提交，而随后 owner 被撤销、服务退出或业务读回失败，工具明确报告部分完成。先检查原生现状再决定后续操作，不用旧 revision 盲目重放。这里没有两套数据库的原子事务承诺。

## 诊断与边界

可信 Host 可读取 `ctx.assistantGoals.health()` 的 `ready`、`goals`、`awaitingVerification`、`observationFailures`。`ready: false` 时先检查必需服务；空目录时检查 Delivery 配对、当前人类 turn、workspace/preset 和上述 Policy 授权。观察失败会计数，原生 goal 自身不会因此被改写。计数仅供 Host 诊断，不向模型提供跨 owner 目录。

- 原始目标保持不变；原生 edit 更新当前目标投影。笔记和证据引用都是未验证的数据，不获得权限，也不构成 achieved 回执。
- 每次新上下文/工具访问重查 live Agent、owner record/version 和 Policy。SystemPrompt 已经写入 Session 的历史快照不会被此插件擦除；不能把撤销新读取权限等同于历史清除或跨 owner 复用旧 Session 的隔离保证。
- Delivery 桥接覆盖创建、业务笔记和 owner 的 edit/pause/resume/clear；没有给模型增加独立验收成功写入入口，native complete 仍由受支持的原生入口或可信 Host 管理。
- 本包尚未提供成功条件验收绑定、期限/费用预算、授权 lease、自动唤醒、原生 Session 执行恢复或多步骤调度。它们属于完整目标编排的后续工作。

## 权限与数据

- **文件系统**：保存目标原文、owner scope、笔记、focus 和追加历史到独立 SQLite；使用 WAL 与 FULL 同步。新建数据库权限为 `0600`，启动前后检查数据库及已有 WAL/SHM 的私有权限、所有权和链接。目录创建为 `0700`，直接父目录须属于当前用户且不可被组或其他用户写入，不修改既有父目录权限；这不是对同 UID 恶意进程或路径替换的 OS 隔离保证。数据库不加密，应置于可信私有目录。启动时重建并核对历史与当前状态，拒绝损坏/截断记录及无效 focus；这不是密码学防篡改日志。当前没有历史自动清理。
- **网络**：本插件不直接联网；注入的上下文及工具结果会随宿主请求发送给所选模型提供商。
- **子进程、凭据、浏览器、安装脚本**：无。
- **卸载**：移除 bundle 后注册和数据库连接随 Cordis 生命周期释放，数据保留；停用所有使用该库的 Host 后可手工删除数据库及其 WAL/SHM。插件不写自定义 Session event，原生目标仍由 DSH 管理。

## 兼容性

见 [仓库基线](../../docs/compatibility.md) 和 [完整落地账本](../../docs/agent-autonomy-implementation.md)。测试使用确定性模型和 transport，不代表真实 Web 部署或智能收益已验收。
