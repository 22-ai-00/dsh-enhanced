# owner-console

DeepSeek Harness 左侧栏的单一入口「控制台」。设计沿用
[dsh-superagent-prototype](https://github.com/22-ai-00/dsh-superagent-prototype) 的理念：
注意力是预算，只在被请求或书面规则允许时行动；只说需要人行动的话；一次一个问题；概念和设置尽量少；
面板只展示需要人处理的事。

当前切片：只读状态 + 主人点击的一次性配置写入。写入只经 Host `settings` 服务合并到指定条目，
不发起模型调用、不创建 Bot、不接受明文 secret、不改动未列出的插件。

## 安装

```sh
dsh plugin --profile web add @dsh-enhanced/owner-console
dsh --profile web --dump-config
```

安装后左侧栏出现「控制台」入口，主面板显示三张卡片：

| 卡片 | 内容 | 数据来源 |
| --- | --- | --- |
| 远程接入（飞书） | 接入方式、`lark-channel` 条目、连接是否加载、appId 是否配置；两种对接：直接填写 appId + secret 引用，或从 Host 环境一键探测 appId | `settings.describe` + `larkChannel` service |
| TraeX | `traex-acp-provider` 条目、是否启用、命令 | `settings.describe` |
| 本项目插件管理 | 本 profile 中 `dsh-enhanced-*` 条目的启用状态，可对单个条目合并一段 JSON 配置 | `settings.describe` / `settings.update` |
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
写入通过 Host `settings.mutate` 的 set/unset 操作完成，以便安全地在两种引用之间切换。

只有声明了 `.volatile()` 的配置字段才能这样实时改写：`lark-channel` 暴露
enabled/account/tenant/appId/appSecretEnv/credentialHandle，`traex-acp-provider` 暴露
enabled/command。没有 live 字段的条目不会出现在面板里。

### TraeX 与本项目插件

- TraeX 卡片只切换 `traex-acp-provider` 条目的 `enabled`（可选覆盖 `command`），不启动进程。
- 插件管理只列出本项目里声明了 live 字段的 `dsh-enhanced-*` 条目；输入一段 JSON 对象后
  按键执行 set 操作一次性写入（≤16 KiB），不重置其它字段，也不提供安装/卸载。
- 面板收到 Host 的业务拒绝会原样显示原因（例如环境变量不存在、身份字段缺失），不静默失败。

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

- 无文件系统写入、无网络、无子进程、无凭据读取。
- 配置写入只经 Host `settings.update`，且限定到单个已安装条目；授权来源是主人自己在面板上的点击，
  不是模型工具调用，也不存在后台自动写配置。
- 不读取会话内容、报告或记忆；client bundle 只依赖宿主提供的 `react` 与 `remote`/`slots`。
- 不安装依赖、不卸载插件、不改动未列出的条目；secret 明文不接受、不存储、不回显。

## 限制

- 一键模式只做 Host 环境变量探测，不代为执行 lark-cli；终端向导由 owner 自己运行。
- 插件管理不提供安装/卸载/启用切换（启用状态由各插件自己的 schema 决定），只提供配置合并。
- 面板显示的是 Host 侧真实注册状态，但「已加载」不等于飞书已通过认证或长连接在线。
- 不校验 app secret；secret 的写入通道留给 keychain 切片。
