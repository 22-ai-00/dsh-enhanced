# 兼容性基线

仓库初始化时对齐以下上游源码状态：

- DeepSeek Harness 运行时与 npm 测试依赖：`0.1.0-rc.8`（上游源码提交 `141eb6fef83422698aef7a981029e843e8161534`）
- 官方 ACP 行为复查基线：`@deepseek-ai/dsh-acp@0.1.0-rc.5`（上游源码提交 `47f943859bef60e4160492346772ded9b24f765a`）
- `@deepseek-ai/cordis`：`4.0.1`
- Node.js：`^22.19.0 || >=24.0.0`
- pnpm：`11.7.0`
- Codex CLI `0.147.0`：App Server 的 `initialize` + `model/list` 用于 `coding-subscription-provider` 的无 prompt 模型目录发现；生成走 JSONL。工作目录诊断仅在进程以 code `1` 退出、没有 stdout 协议输出，且 stderr 含完整行 `Not inside a trusted directory and --skip-git-repo-check was not specified.`（可伴随 stdin 提示）时专门映射，其他退出保持通用分类。
- Claude Agent SDK 控制协议：Claude Code `2.1.218`（`initialize.models` 与逐模型 `supportedEffortLevels`）
- Grok 协议：Grok Build `1.0.5`（目录使用 `initialize._meta.modelState`；headless 生成使用 `--verbatim`、显式空工具集过滤，以及原生 `streaming-json` 的 `text.data` / `end` / `error` 事件）
- Cursor CLI 模型目录：官方 `--list-models` 接口（本机未安装，以有界 fixture 验证；未宣称支持 headless effort）
- 飞书官方 Node SDK `@larksuiteoapi/node-sdk@1.73.0`：该版本原生 `WSClient` 只分发 `type=event`，会丢弃飞书长连接送达的 `type=card` callback；插件安装了一个有边界测试的兼容桥，将完整分片交给同一 `EventDispatcher` 并按官方帧格式 ACK。schema 2.0 整卡更新包装为 `{ card: { type: 'raw', data: card } }`。`normalizeCardAction()` 提供 `action.option`，provider→model→effort 级联的三个 `select_static` 均使用独立 callback，并在每次回调后原位重绘；不能把这些即时 callback 控件嵌进 CardKit `form` 再用 `form_submit`，也不依赖 raw `action.form_value`。v3 HMAC token 绑定 operation、binding、chat、expiry、动作、revision 与 provider/model/effort；Delivery 以 schema v5 CAS 拒绝旧 revision，并原子提交确认结算、选择与 Outbox 回复。确认 handler 在持久领取 operation 后立即响应，带租约和 fencing token 的 worker 可在重启后恢复实时模型解析，并在提交前重新核对 principal 与 Policy。卡片固定使用 `config.update_multi: true`。这些约束和回调返回链路均有边界测试；升级 SDK 或本协议后必须新发 `/model` 做真实飞书卡片冒烟，旧 v1/v2 卡片不可复用。

DSH 尚处于预发布阶段，插件机制可能发生破坏性变化。`pnpm-workspace.yaml` 的 catalog 和各插件 `peerDependencies` 是实际依赖范围的源；本页记录人工验证过的 DSH 基线。

升级基线时：

1. 阅读上游插件打包、profile、Cordis 生命周期和相关 subsystem 文档。
2. 更新 catalog 与所有受影响的 peer 范围。
3. 运行 `pnpm check`。
4. 用目标 DSH 的 `--dump-config` 验证每个 bundle，再做真实 profile 冒烟。
5. 在本页记录新的已验证版本，并在插件 README 中说明任何功能差异。
