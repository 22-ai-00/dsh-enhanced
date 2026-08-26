# @dsh-enhanced/personal-assistant

个人助理四核心的纯 meta-bundle，一次安装以下独立包：

- `@dsh-enhanced/assistant-policy`
- `@dsh-enhanced/personal-memory`
- `@dsh-enhanced/personal-wiki`
- `@dsh-enhanced/assistant-automations`

它不包含消息、飞书、凭据、heartbeat、事件触发或浏览器，也不新增第五个业务 service 或数据库。自己的唯一 Cordis 行只负责按生命周期顺序挂载四个核心 service。

## 安装

```sh
dsh plugin --profile web add @dsh-enhanced/personal-assistant
dsh --profile web --dump-config
```

patch 会完整覆盖上游 `permission` 行，并挂载唯一的 `dsh-enhanced-personal-assistant` 业务行；后者再通过 Cordis 子插件生命周期依次启动 Policy、Memory、Wiki 和 Automations。不要在同一 profile 同时启用本 meta-bundle 与四个独立子 bundle，否则会重复提供同名 service。

## 默认安全状态

- 原生 Permission selector 固定显示 `workspace-write`（请求批准）、`auto`（帮我批准）和 `danger-full-access`（完全访问）三项；前两项共享 `workspace-write + ask` 执行 bundle，但保留不同选择意图。没有用户层设置的新安装默认 `danger-full-access`。已有 `settings.yaml` 的 `permission.defaultPreset` 仍由 DSH Settings 用户层优先，不会被 bundle 强制覆盖。
- policy 默认写入一条 `dsh-enhanced-foreground-capability-*`：本机 Web/direct 的 foreground Agent 可访问 profile 已挂载的全部技能、工具与插件动作，后续动态挂载也无需逐项补 allow；它不会安装尚未安装的插件，也不授权 background 或飞书 external 身份。显式 deny、紧急停止、身份/预算检查仍优先。`budgets` 默认留空。
- automations scheduler 默认关闭；创建并审批 automation 后仍需由部署者显式启用 scheduler。
- Memory、Wiki、Policy、Automations 使用各自的 DSH home 私有路径和独立真源。
- meta 入口先等待 Policy 完成激活，再依次挂载 Memory、Wiki 与 Automations；真实 rc.8 启动不依赖同步构造或 YAML 行序碰巧成功。

需要收紧时可添加显式 deny，或使用安装器的 `--agent-tools disable` 移除托管的 foreground grant；先在测试 profile 使用 `--dump-config` 检查最终 patch。

## 权限与数据

meta-bundle 不引入一套独立于上游 Host 的 OS capability、网络 API、凭据、浏览器或安装脚本权限；四个子包的实际权限和数据边界分别见其 README。需要特别注意：为了符合本地默认完全控制的安装目标，没有用户层设置的新 session 会选择 `danger-full-access + never`，因此 Host sandbox 可不受限制地访问文件与网络，且工具调用不再逐次询问。这是有意启用的高风险默认值，而不是“安装能力不等于授权”的延伸含义；不需要完全控制时，请在原生 selector 中改回 `workspace-write` 或 `auto`。已有兼容的用户设置始终优先，安装器不会强制覆盖。

## 兼容性

子包均以 DeepSeek Harness `0.1.0-rc.8`（提交 `141eb6fef83422698aef7a981029e843e8161534`）为验证基线。参见[兼容性文档](../../docs/compatibility.md)。
