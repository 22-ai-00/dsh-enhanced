# @dsh-enhanced/assistant-web-owner

将现有 DSH Web 聊天接到一个已配对的 Delivery owner，让原生用户文本回合能够使用 `assistant-goals` 等依赖可信人类回合的能力。沿用原生 `SessionController`、Typert、Goal UI 和 AgentLoop。

## 安装与配置

兼容 DSH `0.1.2-rc.1`。这是可选实验性 bundle，尚未正式发布；开发安装先在仓库运行 `pnpm build`，再把本目录作为本地插件安装到测试 profile。必须先配置 Delivery、Policy 和本地 Web owner，随后启用此 bundle；它不是默认自治安装器。

Web principal 必须是 `channel: web`，其 account、tenant、user 由可信本地安装者固定。Delivery 的 `pairPrincipalLocally({ databasePath, principal })` 是已有的离线 owner 交接入口：它会撤销此前 active owner，不能用它静默关联已有 Lark owner。当前不支持跨渠道 owner 别名或多用户 Web 身份映射。

本 bundle patch 先禁用上游 `session-controller` 行，再插入 `dsh-enhanced-assistant-web-owner`。在该 bundle 后追加完整配置 patch：

```yaml
- id: dsh-enhanced-assistant-web-owner
  name: '@dsh-enhanced/assistant-web-owner'
  config:
    principal: { account: local, tenant: local, user: operator }
    workspace: /absolute/workspace
    preset: standard
    maxExecutionMs: 300000
```

安装后用 `dsh --profile <测试配置> --dump-config` 检查：只有本 bundle 的 Controller 激活，owner 和作用域与本地配对一致。卸载 bundle 会移除本层禁用 patch，恢复原 Controller；Delivery 的持久 Session 归属保护仍生效。

`workspace` 必须是绝对路径，`preset` 必须与实际原生 preset 一致。`maxExecutionMs` 为每次 Agent 激活的最大时间，范围 1–300000 毫秒，默认 300000。原生 factory 的冷加载也使用这一取消期限。空闲 Agent 清理后释放 Session 给 Delivery/Automations；未证明完成清理的执行保持 unknown。

Policy 至少需要显式允许该 `web/account/tenant/user` 的 `ingest`，以及该 principal、workspace、preset 下需要的 Agent `reply`、工具执行和 Goals/Memory 操作。配对不会自动放宽 Policy。

## 当前行为与限制

- 新会话固定绑定该 owner 与作用域，不能通过客户端 cwd、preset、workspaceId 或已有 Session ID 接管其他会话。
- 文本先以确切 Inbox 原子领取，再通过原生 `source.kind=user`、requestId、内容和实际 inserted/claimed 消息对象建立一次性证明。只复制来源标签或重发相同文本不能获得第二次准入。
- Session 列表、搜索、历史、控制流、技能目录及 `api-session/*` 广播过滤非 owner 会话；原生 Goal RPC 的 Agent lookup 使用同一受限入口。
- 忙时拒绝新的输入，当前不支持输入图片、fork、子 Agent 历史地址或任意宿主路径打开。排队/steer 的完整交互、附件的一次性准入、浏览器端到端体验和长期跨日运行仍待完成。
- 中断的 native Inbox 不转成普通 Delivery 消息重放，包括尚未调用原生 prompt 的崩溃窗口。已有 Session/Goal/业务记录保留。

## 权限与数据

此包不创建监听端口、凭证、浏览器认证或安装脚本；复用已有的已认证单 owner Web 控制面。它通过宿主服务驱动 Agent 已有的文件、网络、子进程、凭证和浏览器能力，仍受 Policy 与原生审批约束。

Delivery 保存 Web owner/binding、Inbox 文本、内容摘要、尝试与租约；原生 Session 保存实际对话。返回的固定 capability 只给受信 Host 配置使用，并非对同进程插件或同 UID 进程的 OS 隔离边界。

测试覆盖实际 AgentLoop、SessionController、Typert Gateway、ApiRemotes 的两个事件订阅端、SQLite 和业务 Goal 创建；模型为确定性 adapter。HTTP/WS 网络载体、浏览器认证、正式安装与真实模型收益不在这些测试证据内。
