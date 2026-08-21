# @dsh-enhanced/personal-memory

面向个人助理的短期上下文之外长期记忆：保存简短且稳定的事实、偏好、约定和经验，按 user/agent 与 user-global/workspace 双维隔离，通过 `assistant-policy` 的持久审批提案写入。研究资料、文档和项目知识不属于这里，应交给 `personal-wiki`。

## 安装

本插件要求 `@dsh-enhanced/assistant-policy` 已经挂载并提供 `ctx.assistantPolicy`：

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-policy
dsh plugin --profile web add @dsh-enhanced/personal-memory
dsh --profile web --dump-config
```

默认数据库位于 `$DSH_HOME/personal-memory/memory.sqlite`。单独安装后的 policy 默认没有 allow 规则，所以记忆搜索、快照和提案都会 fail closed；需要在 profile 中按实际 preset 与绝对 workspace 放行：

```yaml
- id: dsh-enhanced-assistant-policy
  name: '@dsh-enhanced/assistant-policy'
  config:
    databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')
    rules:
      - id: allow-primary-memory-service
        effect: allow
        subject: { kind: agent, id: primary, workspace: /absolute/workspace }
        actions: [export, propose, search, snapshot]
        resource: { kind: memory, id: "*" }
        context: { initiators: [foreground] }
      - id: allow-primary-memory-tools
        effect: allow
        subject: { kind: agent, id: primary, workspace: /absolute/workspace }
        actions: [execute]
        resource: { kind: tool, id: memory_* }
        context: { initiators: [foreground] }
    budgets: []
```

## 行为与工具

- `memory_search`：显式检索当前 agent 可见的四个域；ASCII 与中文 unigram/bigram 均可召回，排序和 tie-break 确定，读取不更新任何计数。
- `memory_manage`：只创建 add/replace/remove 提案，返回完整 diff、proposal id、TTL 和版本；它没有直接提交路径。
- `ctx.personalMemory.decideProposal(...)`：供绑定 owner 的可信通道/UI 决定提案。principal、版本、决定内容和理由均受幂等/CAS 约束。
- `ctx.personalMemory.exportJson(agent)`：导出版本化 JSON，不包含哈希、状态、时间戳、token 表或审计表。
- `ctx.personalMemory.proposeImport(...)`：先验证整个有界文档，再为每条记录创建审批提案；未批准前不会写入 memory record。

每次 `agent/session-start` 最多注入一次冻结快照。快照合并 user-global、当前 workspace、当前 agent-global 和当前 agent-workspace，受 top-K、字节和粗略 token 三重预算约束；`sensitive` 记录不会进入环境快照。内容被包在 `<memory_source>` 中并明确标为“不可信数据而非指令”，所有 XML 元字符在预算计算前转义，记录无法闭合数据边界。`memory_search` 与 `memory_manage` 的模型可见结果也分别使用有界、转义的 `<memory_search_results>` / `<memory_proposal_results>` framing。缺少绝对 cwd 或 agent preset 时不搜索、不提案、不注入，也不会退化到共享域。

## 数据与一致性

SQLite 使用 WAL、`busy_timeout`、外键、FULL synchronous 和前向 schema 版本；目录为 `0700`，数据库为 `0600`。记录包含 stable id、内容哈希、provenance、trust、confidence、sensitivity、TTL、supersedes 和 version。replace/remove 在批准后重新读取 target version 并以 CAS 提交；审批与内存位于两个数据库，若进程恰好在 policy 批准后退出，可用原决定安全重放。并发变化会把提案标为 `conflicted`，不会覆盖新值。

JSON 导入是一组独立、可重放的提案，不承诺跨所有记录的一次性批准或全批原子提交。SQLite 仅承诺单机多连接语义，不用于多主机共享文件系统。

## 配置上限

| 字段 | 默认值 | 作用 |
|---|---:|---|
| `maxContentBytes` | 4096 | 单条内容最大 UTF-8 字节数 |
| `maxRecordsPerIdentity` | 1000 | 每个完整身份域的活动记录上限 |
| `searchLimit` | 20 | 未显式指定时的搜索上限 |
| `snapshotLimit` | 20 | 会话快照候选上限 |
| `snapshotMaxBytes` | 8192 | 快照最大 UTF-8 字节数 |
| `snapshotMaxTokens` | 2048 | 快照粗略 token 上限 |
| `defaultProposalTtlMs` | 900000 | 默认提案有效期（15 分钟） |
| `maxImportRecords` | 100 | 单次导入最大记录数 |

## 权限与非目标

- 文件系统：只读写配置的 SQLite 数据库及其 WAL/SHM 辅助文件。
- 网络、子进程、凭据、浏览器、安装脚本：无。
- 数据敏感性：`sensitive` 只表示禁止环境快照；显式、已授权的搜索仍可能把内容发送给当前模型。真正的密码/API key 应放在后续 `credentials-keychain`，不要写入 memory。
- 非目标：向量数据库、自动无审批写入、自动遗忘/dreaming、知识图谱、Wiki 长文、跨设备同步和多用户 ACL。

## 兼容性

已针对 DeepSeek Harness `0.1.0-rc.8`（源码提交 `141eb6fef83422698aef7a981029e843e8161534`）验证。详见仓库[兼容性基线](../../docs/compatibility.md)。
