# owner-console

DeepSeek Harness 左侧栏的单一入口「控制台」。设计沿用
[dsh-superagent-prototype](https://github.com/22-ai-00/dsh-superagent-prototype) 的理念：
注意力是预算，只在被请求或书面规则允许时行动；只说需要人行动的话；一次一个问题；概念和设置尽量少；
面板只展示需要人处理的事。

当前切片：只读状态 + 主人点击的一次性配置与管理动作。配置写入只经 Host `settings` 服务合并到
指定条目；bundle/条目管理与安装只经 Host `pluginManager`。两类动作都由主人点击触发，
不发起模型调用、不创建 Bot、不接受明文 secret、不改动未列出的插件。安装会把 pnpm 子进程和
registry 网络调用委托给 DSH 自身的 plugin manager，不在本插件里实现网络或进程逻辑。

## 安装

```sh
dsh plugin --profile web add @dsh-enhanced/owner-console
dsh --profile web --dump-config
```

安装由 DSH 的 pnpm 路径完成，本包声明的运行依赖（`@deepseek-ai/schemastery`、`zod`）随包安装；
Host 侧的 `typert` 与 Web 侧的 `react` 由 DSH 提供。安装后左侧栏出现「控制台」入口，面板包含：

| 卡片 | 内容 | 数据来源 |
| --- | --- | --- |
| 远程接入（飞书） | 接入方式、`lark-channel` 条目、连接是否加载、appId 是否配置；两种对接：直接填写 appId + secret 引用，或从 Host 环境一键探测 appId | `settings.describe` + `larkChannel` service |
| TraeX | `traex-acp-provider` 条目、是否启用、命令 | `settings.describe` |
| 本项目插件管理 | 本项目的 bundle 层（启用/停用）、已加载条目（启用/禁用/阶段）、安装 `@dsh-enhanced/*`（含依赖），以及对 live 字段的合并配置 | `pluginManager` + `settings.describe` / `settings.mutate` |
| 依赖自检 | `assistant-policy`、`assistant-delivery`、`assistant-skills` 是否可用 | Cordis service 注册表（严格查找） |

读取与写入都经 `typert` 的严格 invocation 返回；面板不缓存或上报任何内容。
「已加载/可用」只表示提供该 service 的 fiber 当前处于活动状态，不等于飞书已完成认证或长连接在线。

### 飞书两种对接方式

1. **直接配置**：填写 `appId`（`cli_` + 16 位十六进制）和一个 secret 引用（环境变量名或
   keychain handle）、可选 account/tenant，点「应用配置」。面板只写 `lark-channel` 条目，
   secret 明文永不进入配置、日志或本插件。
2. **一键配置**：Host 进程环境里已有 `LARK_APP_ID` 或 `FEISHU_APP_ID` 时，点「一键配置」即用
   探测到的 appId 写入同一份配置；否则回退为「复制向导命令」，在终端执行
   `dsh-lark-setup --profile <profile>` 完成官方向导后再回来启用。

写入要求 secret 引用二选一；同时给两个或都不给会被拒绝。写入前会检查那个环境变量在该
Host 进程中确实存在，keychain handle 模式要求 `credentials-keychain` 已加载。
account/tenant 留空时沿用条目里当前值（不会用默认值覆盖身份）；两者都为空才拒绝。
写入通过 Host `settings.mutate` 的 set/unset 操作完成，并显式写 `secretSource`（`env` 或
`handle`）：bundle 层默认带 `credentialHandle`，单靠 unset 无法清掉继承值，因此两种方式互切
由这个选择器裁决，另一个引用会被屏蔽。写入后对目标条目执行一次带新配置的重启
（`fiber.update(rawConfig, true)`），让插件按新的纯配置重建连接/provider；不能解析条目或重载
失败时如实提示「已保存，但需要重启 profile 后生效」。

只有声明了 `.volatile()` 的配置字段才能被 settings 服务读取/改写（改完由本插件重启条目）：`lark-channel` 暴露
enabled/account/tenant/appId/appSecretEnv/credentialHandle，`traex-acp-provider` 暴露
enabled/command。没有 live 字段的条目不会出现在面板里。

### TraeX 与本项目插件

- TraeX 卡片只切换 `traex-acp-provider` 条目的 `enabled`（可选覆盖 `command`），不启动进程。
- **Bundle 层**：列出本 profile 里 `@dsh-enhanced/*` bundle 的版本、是否安装、是否启用、是否可移除，
  一键启用/停用；停用只摘除该 bundle 的 patch 层，已安装依赖保留。
- **已加载条目**：列出模块属于 `@dsh-enhanced/*` 的 Loader 条目（entryId、模块名、fiber 阶段），
  可单独启用/禁用；按模块归属而不是 bundle row 归属判断，第三方模块行不在此面板管理。
- **安装**：只接受 `@dsh-enhanced/<name>` 形式的包名，走 DSH 自身的 `pluginManager.installBundle`
  （与 `dsh plugin` 相同的 pnpm 路径），会一并安装该包声明的依赖并默认激活；本地路径和 git 地址
  不在此面板处理，避免面板变成任意代码源入口。安装/启用后如返回 `restart-required`，按提示重启 profile。
- **高级**：对声明了 live 字段的条目仍可合并一段 JSON 配置（≤16 KiB），不重置其它字段。
- 面板收到 Host 的业务拒绝会原样显示原因（例如环境变量不存在、身份字段缺失、需要重启），不静默失败。
- 「方式」按条目里实际存在的 secret 引用显示（环境变量 = lark-cli 向导；keychain = 直接配置），
  不再只反映本插件自己的偏好字段。

## 配置

在 profile 的 `cordis.patch.yml` 覆盖本行配置：

```yaml
- id: dsh-enhanced-owner-console
  name: '@dsh-enhanced/owner-console'
  config:
    feishuMode: lark-cli   # lark-cli | app
    feishuAppId: ''        # 直接模式的 app id；app secret 不进入配置
    enableTraex: false
```

配置为同步 Standard-Schema 校验，非法值在加载时被拒绝。

## 权限与数据边界

- 本插件自身不直接读写文件、不直接联网、不直接起子进程、不读取凭据；需要落盘的动作都委托给
  Host 的 `settings`（配置）与 `pluginManager`（bundle/条目管理与 pnpm 安装），由后者执行。
- 安装动作因此会经由 Host 启动 pnpm 并访问 registry（与 `dsh plugin` 相同）；只在主人点击时发生。
- 配置写入只经 Host `settings.mutate`，且限定到单个已安装条目；bundle/entry 管理只经 Host
  `pluginManager` 且限定 `@dsh-enhanced/*`；授权来源是主人自己在面板上的点击，不是模型工具调用，
  也不存在后台自动写配置。
- 不读取会话内容、报告或记忆；client bundle 只依赖宿主提供的 `react` 与 `remote`/`slots`。
- 安装仅由主人点击触发，走 DSH 官方安装路径；不提供卸载，不改动未列出的条目；
  secret 明文不接受、不存储、不回显。

## 限制

- 一键模式只做 Host 环境变量探测，不代为执行 lark-cli；终端向导由 owner 自己运行。
- 插件管理不提供卸载；安装只接受 `@dsh-enhanced/*` 包名（不支持任意本地/git 源）。
- 面板会列出 `owner-console` 自己的 bundle/entry：禁用它会隐藏这个入口，需用 `dsh plugin` 或 CLI
  重新启用（与 DSH 原生插件页语义一致）。
- 停用 bundle 只摘除 patch 层，依赖与包文件保留；彻底移除仍用 `dsh plugin remove`。
- 面板显示的是 Host 侧真实注册状态，但「已加载」不等于飞书已通过认证或长连接在线。
- 不校验 app secret；secret 的写入通道留给 keychain 切片。
