# @dsh-enhanced/assistant-web-owner

将现有 DSH Web 聊天接到一个已配对的 Delivery owner，让原生用户文本回合能够使用 `assistant-goals` 等依赖可信人类回合的能力。沿用原生 `SessionController`、Typert、Goal UI 和 AgentLoop。

## 安装与配置

兼容 DSH `0.1.2-rc.1`。这是可选实验性 bundle，尚未正式发布。本地源码安装可使用现有安装器的显式 Web 场景；默认 `core` 不会自动启用它：

```sh
./scripts/install/install-local.sh --scenario web --workspace /absolute/workspace --yes --no-service
```

该入口安装 core、Delivery、Goals 和 Web owner；先通过本地 `dsh-web-owner-setup` 初始化 owner 与完整 profile 配置，再探测真实 Host 激活。它复用有效 Delivery 数据库路径，固定 principal 为 `web/<profile>/local/operator`。不配置飞书或常驻服务，不会自行更改全局模型/权限选择；模型设置和验证仍沿现有安装器选项。完整目标执行、独立验收和隔离配置并未因此自动完成。

单独使用 CLI 时先安装这些 bundle，停止目标 Host，再运行 `dsh-web-owner-setup --profile web --workspace /absolute/workspace`。它保留 YAML 标签、自定义配置和 Policy 规则；重复运行保留 owner ID/version、已有绑定和任务。修改过的受管规则或不同 owner/scope 会拒绝覆盖。新增精确 owner 的外部 ingest/capability 规则只提供能力可达性，现有 deny、原生 sandbox 和审批约束仍生效。

Web principal 必须是 `channel: web`，其 account、tenant、user 由可信本地安装者固定。安装器使用 `ensurePrincipalLocally()`：只在空库初始化，或原样保留完全匹配的 active owner，不替换其他 owner、不复活已撤权身份。已有 Lark 或不同 owner 使用同一数据库时会拒绝，可为独立部署选择另一个 `DSH_HOME`。高级离线交接 API `pairPrincipalLocally()` 仍保留其原本的显式交接语义；本安装器不调用它。当前不支持跨渠道 owner 别名或多用户 Web 身份映射。

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

运行时不创建监听端口、凭证或浏览器认证，复用已有的已认证单 owner Web 控制面。离线 setup CLI 调用本机 `dsh --dump-config` 读取配置，不执行任意 YAML JS；写入目标 profile patch、Delivery owner 数据库和所选工作区目录，使用安装锁与原子文件替换。配对与 YAML 不能跨库原子提交，写文件失败可能留下尚未启用的首次身份；同身份重试不会轮换权限。CLI 不读取凭证存储、不发模型请求，也无安装生命周期脚本。

运行时通过宿主服务驱动 Agent 已有的文件、网络、子进程、凭证和浏览器能力，仍受 Policy 与原生审批约束。

Delivery 保存 Web owner/binding、Inbox 文本、内容摘要、尝试与租约；原生 Session 保存实际对话。返回的固定 capability 只给受信 Host 配置使用，并非对同进程插件或同 UID 进程的 OS 隔离边界。

测试覆盖实际 AgentLoop、SessionController、Typert Gateway、ApiRemotes 的两个事件订阅端、SQLite 和业务 Goal 创建；模型为确定性 adapter。HTTP/WS 网络载体、浏览器认证、正式安装与真实模型收益不在这些测试证据内。
