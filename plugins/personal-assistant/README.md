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

- 原生 Permission selector 固定显示 `workspace-write`（请求批准）、`auto`（帮我批准）和 `danger-full-access`（完全访问）三项；前两项共享 `workspace-write + ask` 执行 bundle，但保留不同选择意图。没有用户层设置的新安装默认 `workspace-write`。已有 `settings.yaml` 的 `permission.defaultPreset` 仍由 DSH Settings 用户层优先，不会被 bundle 强制覆盖。
- policy 默认写入一条 `dsh-enhanced-foreground-capability-*`：本机 Web/direct 的 foreground Agent 可访问 profile 已挂载的全部技能、工具与插件动作，后续动态挂载也无需逐项补 allow；它不会安装尚未安装的插件，也不授权 background 或飞书 external 身份。显式 deny、紧急停止、身份/预算检查仍优先。`budgets` 默认留空。
- automations scheduler 默认关闭；创建并审批 automation 后仍需由部署者显式启用 scheduler。
- Memory、Wiki、Policy、Automations 使用各自的 DSH home 私有路径和独立真源。
- meta 入口先等待 Policy 完成激活，再依次挂载 Memory、Wiki 与 Automations；真实 rc.8 启动不依赖同步构造或 YAML 行序碰巧成功。

需要收紧时可添加显式 deny，或使用安装器的 `--agent-tools disable` 移除托管的 foreground grant；先在测试 profile 使用 `--dump-config` 检查最终 patch。

## 配置默认模型

meta-bundle 附带 `dsh-model-setup`（同时以 `@dsh-enhanced/assistant-policy/model-setup` 导出），把部署默认模型写入 DSH `settings.yaml` 的 `agent-default-model`；自定义 OpenAI 兼容网关另写 `llm-pi-ai.providers.<route>`。它只写模型选择与 provider profile，不改权限、不动 channel。

```sh
# DeepSeek 官方（缺省模型 deepseek-v4-flash）
dsh-model-setup --provider deepseek-official --model deepseek-v4-flash

# 自定义网关（缺省协议 openai-completions）
dsh-model-setup --provider super-relay --model glm5.2 \
  --base-url https://super-relay.example/v1 --api openai-completions

# 本机 TraeX（agent route，无 API Key）：写默认选择并在指定 profile 启用 route
dsh-model-setup --provider traex-agent --enable-in-profile web
```

API Key 绝不作为参数传入：加 `--store-key` 时，值只从 `DSH_ENHANCED_MODEL_API_KEY` 或按 provider 派生的凭据引用（`deepseek-official` 为 `DEEPSEEK_API_KEY`，其余形如 `SUPER_RELAY_API_KEY`）读取，并原子写入 `$DSH_HOME/.credentials.yaml`（`0600`，目录 `0700`），密钥缺失时 fail-closed 且不改动 `settings.yaml`。不加 `--store-key` 则只写 route 选择，凭据仍按 DSH 运行时的环境/`.credentials.yaml` 解析。

`traex-agent` 是 **agent route**：不需要 API Key（也拒绝 `--store-key` 与网关传输字段），由本机已登录的 TraeX 通过 [`@dsh-enhanced/traex-acp-provider`](../traex-acp-provider/README.md) 提供。它把全局 `agent-default-model` 指向 `traex-agent`，并用 `--enable-in-profile <profile>` 在该 profile 的 `cordis.patch.yml` 里把 provider 行置为 `enabled: true`（保留其它行/注释/`!!js`，仅在缺失时补默认 `cwd`）。注意 `agent-default-model` 是全局唯一段、被所有 profile 共享，而该 route 的适配器只在启用了本 bundle 的 profile 里注册；因此只有已启用的 profile（如 `web`）能解析 `traex-agent`，`headless` 等未装该 bundle 的 profile 会 `NO_ADAPTER`。安装器的模型配置引导即调用此工具，详见[安装脚本文档](../../scripts/install/README.md#配置默认模型)。

## 权限与数据

meta-bundle 不引入一套独立于上游 Host 的 OS capability、网络 API、凭据、浏览器或安装脚本权限；四个子包的实际权限和数据边界分别见其 README。新 session 从 `workspace-write + ask` 开始；若确实需要 `danger-full-access + never`，必须在原生 selector 中明确选择，或使用安装器的 `--permission danger-full-access --confirm-dangerous-full-access`。完全访问会允许 Host sandbox 访问任意文件与网络且不逐次询问；已有兼容的用户设置始终优先。

## 兼容性

子包均以 DeepSeek Harness `0.1.0-rc.8`（提交 `141eb6fef83422698aef7a981029e843e8161534`）为验证基线。参见[兼容性文档](../../docs/compatibility.md)。
