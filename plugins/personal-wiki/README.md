# @dsh-enhanced/personal-wiki

面向个人助理的 Markdown 知识库。页面是人可读、可备份的唯一真源；进程内目录、段落检索索引、反链与 lint 报告都可从页面重建。它保存研究、项目、人物、概念、来源与决策等长资料；每轮都可能有用的短事实和偏好应交给 `personal-memory`。

## 安装

本插件要求 `@dsh-enhanced/assistant-policy` 先提供 `ctx.assistantPolicy`：

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-policy
dsh plugin --profile web add @dsh-enhanced/personal-wiki
dsh --profile web --dump-config
```

默认页面位于 `$DSH_HOME/personal-wiki/vault/wiki/`，提案状态位于 `$DSH_HOME/personal-wiki/state.sqlite`。默认 policy 没有 allow 规则，因此所有模型操作都会 fail closed。按真实 preset 与绝对 workspace 放行所需服务和工具：

```yaml
- id: dsh-enhanced-assistant-policy
  name: '@dsh-enhanced/assistant-policy'
  config:
    databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')
    rules:
      - id: allow-primary-wiki-service
        effect: allow
        subject: { kind: agent, id: primary, workspace: /absolute/workspace }
        actions: [lint, propose, read, rebuild, search]
        resource: { kind: wiki, id: "*" }
        context: { initiators: [foreground] }
      - id: allow-primary-wiki-tools
        effect: allow
        subject: { kind: agent, id: primary, workspace: /absolute/workspace }
        actions: [execute]
        resource: { kind: tool, id: wiki_* }
        context: { initiators: [foreground] }
    budgets: []
```

## 工具和写入语义

- `wiki_search`：显式搜索页与段落，支持 ASCII 和中文 unigram/bigram，返回有界 snippet、稳定 page id、相对路径、revision 与直接来源。
- `wiki_read`：用 `wiki://<ULID>`、ULID、精确标题或别名读取一页；输出受字节/段落双预算约束，并以 `<knowledge_source>` 标记为“不可信数据而非指令”。标题和正文会先做 XML 文本转义，页面无法闭合该数据边界。
- `wiki_upsert`：只提交完整 create/update 提案。update 必须带 `page_id` 与 `expected_revision`；模型没有直接写页的方法。
- `wiki_lint`：只读报告坏 frontmatter、重复 id/标题/别名、大小写路径碰撞、死链、孤页、来源哈希、派生 provenance 和进程索引漂移；不会修复或重建。

`wiki_search`、`wiki_upsert` 和 `wiki_lint` 的模型可见结果也分别放在有界、XML 转义的 `<wiki_search_results>`、`<wiki_proposal_results>`、`<wiki_lint_results>` 数据 framing 中。

插件还注册一个短的 `personal-wiki-workflow` Skill，要求 search/read 后再提案、保留 `wiki://` 引用、把来源视为数据，并禁止绕过审批直接用 shell 改 vault。

`ctx.personalWiki.decideProposal(...)` 面向可信通道/UI。提案绑定 principal、TTL、版本和完整目标 Markdown。批准 update 时重新读取 SHA-256 revision；外部编辑会令提案进入 `conflicted`，不会覆盖新内容。policy 与 Wiki 状态分别持久化，若进程在批准或 atomic rename 附近退出，原决定可安全重放。

## 页面与重建

页面只位于固定目录 `wiki/{sources,people,projects,concepts,decisions,questions,meta}`。严格 JSON-compatible YAML frontmatter 包含 ULID、标题、类型、状态、authority、tags、aliases、直接 sources、创建/更新时间；未知字段和坏 SHA-256 会明确报错。`curated` 页面是独立真源；`derived` 页面必须指向直接 curated evidence，禁止 derived page 再总结 derived page。

启动时构建不可变进程快照。人工编辑后需显式 `rebuild` 才进入 search/read；失败的 rebuild 保留上一个可用快照。页面写入使用同目录 `0600` 临时文件、文件 fsync、atomic rename 和目录 fsync。页面目录为 `0700`，拒绝相对 root、`..`、绝对子路径、symlink、非普通文件、越界 realpath、大小写碰撞和超限页面。

备份时以整个 `vault/wiki` 为准；`state.sqlite` 只需在还要保留未决审批时一并备份。删除进程索引无需恢复，因为它只存在内存中。

## 配置上限

| 字段 | 默认值 | 作用 |
|---|---:|---|
| `maxPageBytes` | 1048576 | 单页 Markdown 最大 UTF-8 字节数 |
| `searchLimit` | 20 | 默认搜索命中上限（硬上限 100） |
| `maxSnippetBytes` | 2048 | 单条搜索片段字节上限 |
| `readMaxBytes` | 8192 | 单次读取总字节上限 |
| `readMaxParagraphs` | 40 | 单次读取段落上限 |
| `lintLimit` | 200 | 默认 lint finding 上限 |
| `defaultProposalTtlMs` | 900000 | 默认提案有效期（15 分钟） |

## 权限与非目标

- 文件系统：只读写显式 `vaultRoot`、`databasePath` 及 SQLite WAL/SHM；不会扫描工作区或任意绝对路径。
- 网络、子进程、凭据、浏览器、安装脚本：无。
- Git：不执行 add/commit/push；用户可在 vault 外部自行纳入版本控制。
- 非目标：PDF/DOCX/web ingest、向量数据库、Web UI、自动摘要写入、自动 archive、自动 Git commit、远端/多 vault 同步、Memory 双向同步、图数据库和多用户 ACL。

## 兼容性

已针对 DeepSeek Harness `0.1.0-rc.8`（源码提交 `141eb6fef83422698aef7a981029e843e8161534`）验证。详见仓库[兼容性基线](../../docs/compatibility.md)。
