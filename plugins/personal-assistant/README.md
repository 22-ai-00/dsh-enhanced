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

`auto` 是上游保留的动态档位：`assistant-policy` 激活后通过 `permissionPresets.registerAuto()` 注册，卸载或权限服务换代时撤销。patch 不再配置静态 `auto`。

- 原生 Permission selector 有 `workspace-write`（请求批准）和 `danger-full-access`（完全访问）；Policy 就绪时动态加入 `auto`（帮我批准）。上游 Auto 固定为 `danger-full-access + ask`，低风险且满足 Policy 检查的可逆动作由隔离 reviewer 自动批准，其余仍交人工。没有用户层设置的新安装默认 `danger-full-access`（Full access）：可访问任意文件与网络，不逐次请求批准。已有 `settings.yaml` 的 `permission.defaultPreset` 仍由 DSH Settings 用户层优先，不会被 bundle 强制覆盖。
- policy 默认写入一条 `dsh-enhanced-foreground-capability-*`：本机 Web/direct 的 foreground Agent 可访问 profile 已挂载的全部技能、工具与插件动作，后续动态挂载也无需逐项补 allow；它不会安装尚未安装的插件，也不授权 background 或飞书 external 身份。显式 deny、紧急停止、身份/预算检查仍优先。`budgets` 默认留空。
- automations scheduler 默认关闭；创建并审批 automation 后仍需由部署者显式启用 scheduler。
- Memory、Wiki、Policy、Automations 使用各自的 DSH home 私有路径和独立真源。
- meta 入口先等待 Policy 完成激活，再依次挂载 Memory、Wiki 与 Automations；启动不依赖同步构造或 YAML 行序碰巧成功。

需要收紧时可添加显式 deny，或使用安装器的 `--agent-tools disable` 移除托管的 foreground grant；先在测试 profile 使用 `--dump-config` 检查最终 patch。

## 配置默认模型

日常添加 API 模型请使用 **Web → 设置 → 模型**；在 Web 聊天选择器或飞书 `/model` 中切换当前会话。完整步骤见[模型配置](../../docs/models.md)，无需改动插件代码或把 API Key 写入项目。

安装器会保留已有默认选择；发现已登录的 TraeX 且没有明确默认值时，为当前 profile 选择 `traex-agent`。TraeX 只在已启用其插件的 profile 中可用，见[TraeX 帮助](../traex-acp-provider/README.md)。

部署脚本可通过本包附带的 `dsh-model-setup` 设置默认值，参数和作用范围见[高级模型配置](../../scripts/install/maintenance.md#配置默认模型)。这与“添加一个可选模型”不同；手动调用应显式指定 `--profile`，避免生成旧版全局待导入设置。

## 权限与数据

meta-bundle 不引入一套独立于上游 Host 的 OS capability、网络 API、凭据、浏览器或安装脚本权限；四个子包的实际权限和数据边界分别见其 README。没有用户覆盖的新 session 从 `danger-full-access + never` 开始，reviewer 为 `none`。完全访问允许 Host sandbox 访问任意文件与网络且不逐次询问；请仅在信任的运行环境使用。已有兼容的用户设置和已记录的会话权限不会被升级或重启覆盖。用户可在原生 Web Permission selector 切换当前会话；飞书发送 `/permission` 打开交互卡片，或使用 `/permission ask`、`/permission auto`、`/permission full confirm`。安装时用 `--permission workspace-write` 或 `--permission auto` 设置更严格的后续会话默认值；显式覆盖既有默认为完全访问仍使用 `--permission danger-full-access --confirm-dangerous-full-access`。权限档位不绕过 Policy 显式拒绝、紧急停止、身份校验和预算硬门。

## 兼容性

当前适配 DeepSeek Harness `0.2.0-rc.2`；完整宿主安装需按[兼容性文档](../../docs/compatibility.md)验证。
