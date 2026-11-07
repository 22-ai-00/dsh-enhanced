# @dsh-enhanced/personal-assistant

个人助手「文鳐」（Ray，小鳐）四核心的纯 meta-bundle，一次安装以下独立包：

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

`auto` 是 Harness 原生组件保留的当前会话档位，本项目不注册它。助手自身自动审批通过已鉴权的 Delivery `/permission auto` 选择，使用 `workspace-write + ask` 与项目专属 reviewer 事件。新会话默认仍为 `danger-full-access`，需要收紧时使用 `--permission workspace-write`；动态原生 Auto 不能配置为默认值。

- 原生 Permission selector 的 `workspace-write` / `danger-full-access` 和官方组件提供的 `auto` 由 Harness 管理。Policy 不动态添加原生 Auto；助手 `/permission auto` 使用独立的项目 reviewer 与工作区沙箱。无用户设置的新安装默认仍为 `danger-full-access`，已有兼容的静态默认与会话记录保留。
- policy 默认写入一条 `dsh-enhanced-foreground-capability-*`：本机 Web/direct 的 foreground Agent 可访问 profile 已挂载的全部技能、工具与插件动作，后续动态挂载也无需逐项补 allow；它不会安装尚未安装的插件，也不授权 background 或飞书 external 身份。显式 deny、紧急停止、身份/预算检查仍优先。`budgets` 默认留空。
- automations scheduler 默认关闭；创建并审批 automation 后仍需由部署者显式启用 scheduler。
- Memory、Wiki、Policy、Automations 使用各自的 DSH home 私有路径和独立真源。
- meta 入口先等待 Policy 完成激活，再依次挂载 Memory、Wiki 与 Automations；启动不依赖同步构造或 YAML 行序碰巧成功。

需要收紧时可添加显式 deny，或使用安装器的 `--agent-tools disable` 移除托管的 foreground grant；先在测试 profile 使用 `--dump-config` 检查最终 patch。

## 配置默认模型

日常添加 API 模型请使用 **Web → 设置 → 模型**；在 Web 聊天选择器或飞书 `/model` 中切换当前会话。完整步骤见[模型配置](../../docs/models.md)，无需改动插件代码或把 API Key 写入项目。

安装器会保留已有默认选择；发现已登录的 TraeX 且没有明确默认值时，为当前 profile 选择 `traex-agent`。TraeX 只在已启用其插件的 profile 中可用，见[TraeX 帮助](../traex-acp-provider/README.md)。

部署脚本可通过本包附带的 `dsh-model-setup` 设置默认值，参数和作用范围见[高级模型配置](../../scripts/install/maintenance.md#配置默认模型)。这与“添加一个可选模型”不同；手动调用应显式指定 `--profile`，避免生成旧版全局待导入设置。

插件的启用、停用、单项配置和 recommended 预设用本包附带的 `dsh-plugin-setup`（如 `profiles/<p>/node_modules/.bin/dsh-plugin-setup list`），用法、校验与拒绝项见 [assistant-policy](../assistant-policy/README.md#插件配置-clidsh-plugin-setup)。

## 权限与数据

meta-bundle 不引入一套独立于上游 Host 的 OS capability、网络 API、凭据、浏览器或安装脚本权限；四个子包的实际权限和数据边界分别见其 README。没有用户覆盖的新 session 从 `danger-full-access + never` 开始，reviewer 为 `none`。完全访问允许 Host sandbox 访问任意文件与网络且不逐次询问；请仅在信任的运行环境使用。已有兼容的用户设置和已记录的会话权限不会被升级或重启覆盖。用户可在原生 Web Permission selector 切换当前会话；飞书发送 `/permission` 打开交互卡片，或使用 `/permission ask`、`/permission auto`、`/permission full confirm`。安装时用 `--permission workspace-write` 设置更严格的后续会话默认值；原生 Auto 只在当前会话选择，助手 Auto 由上述已认证命令选择；显式覆盖既有默认为完全访问仍使用 `--permission danger-full-access --confirm-dangerous-full-access`。权限档位不绕过 Policy 显式拒绝、紧急停止、身份校验和预算硬门。

## 兼容性

宿主、Cordis 及同批组件的唯一兼容基线见[兼容性文档](../../docs/compatibility.md)；完整宿主安装须按该基线验证。本包仍只组合上述四个核心包，不额外启用其他业务 bundle。
