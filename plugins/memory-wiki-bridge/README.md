# @dsh-enhanced/memory-wiki-bridge

只提供两条显式、可审阅的知识晋升：

- `knowledge_promote`：选定 Memory ids+versions → derived Wiki proposal。
- `knowledge_pin`：一个 Wiki id+revision 与人工/模型草拟的 bounded summary → Memory proposal。

本包没有数据库、文件、timer、网络或 LLM 调用；只使用 `ctx.personalMemory` / `ctx.personalWiki` 公开 service。目标端仍执行自己的 Agent identity、Policy、proposal、diff、审批与 CAS，Bridge 无法 commit。

## 安装

```sh
dsh plugin --profile web add @dsh-enhanced/memory-wiki-bridge
dsh --profile web --dump-config
```

必须先安装 Memory 与 Wiki，并允许目标 Agent 对选定记录/page 的 `read` 与目标端 `propose`。所有幂等键由 Bridge 根据方向、source ids+versions/revision、target 和规范化内容计算，调用者不能用一个遗漏 provenance 的自选 key 覆盖它。

Memory→Wiki 会生成 `memory://<id>?version=<n>` source 与 content SHA-256，并把所选内容放在标记为 data-not-instructions 的 evidence 区。Wiki→Memory 生成 `wiki://<id>?revision=<revision>` provenance，默认 `external` trust、`private` sensitivity、0.8 confidence；最终是否接受由 owner 审批。

## 权限与限制

- 文件系统、网络、子进程、凭据、浏览器、安装脚本：无。
- 不自动同步、双写、级联删除、自动批准、页面总结页面，也不保存第三份正文。
- Wiki curated 页面仍以 Markdown 为真源；Memory 仍只保存短事实。删除 Bridge 不影响两端数据。

## 兼容性与参考

以 DSH rc.8 `141eb6fef83422698aef7a981029e843e8161534` 验证。思路参考 Memento proposal-only mutation、Hindsight evidence→observation→page 和 Wiki 的 save/pin 工作流；社区包未进入依赖，也没有复制其自动 retain/dreaming 行为。
