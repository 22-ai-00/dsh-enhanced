# owner-console

DeepSeek Harness 左侧栏的单一入口「控制台」。设计沿用
[dsh-superagent-prototype](https://github.com/22-ai-00/dsh-superagent-prototype) 的理念：
注意力是预算，只在被请求或书面规则允许时行动；只说需要人行动的话；一次一个问题；概念和设置尽量少；
面板只展示需要人处理的事。

当前切片是只读状态页，不会写配置、不发起模型调用、不创建 Bot、不改动其它插件。

## 安装

```sh
dsh plugin --profile web add @dsh-enhanced/owner-console
dsh --profile web --dump-config
```

安装后左侧栏出现「控制台」入口，主面板显示三张卡片：

| 卡片 | 内容 | 数据来源 |
| --- | --- | --- |
| 远程接入（飞书） | 接入方式（`lark-cli` 向导或直接填写）、连接是否加载、appId 是否配置 | 本插件配置 + 已安装的 `lark-channel` service |
| TraeX | 入口是否启用 | 本插件配置 |
| 依赖自检 | `assistant-policy`、`assistant-delivery`、`assistant-skills` 是否可用 | Cordis service 注册表（严格查找） |

所有读取经 `typert` 的只读 invocation 返回；面板不会缓存或上报任何内容。「已加载/可用」只表示提供该 service 的 fiber 当前处于活动状态，不等于飞书已完成认证或长连接在线。

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
- 只读 Host service 注册表与自身配置；不读取会话内容、报告或记忆。
- 上报路径只有只读状态读取；client bundle 只依赖宿主提供的 `react` 与 `remote`/`slots`。
- 不安装依赖、不修改其它插件；后续切片提供的动作必须逐项经过 Policy 审批并保持一次性。

## 限制

- 这是第一个可用切片：飞书一键配置、直接 appId 写入、TraeX 启停和本项目插件管理尚未实现。
- 面板显示的是 Host 侧真实注册状态，但「已加载」不等于飞书已通过认证或长连接在线。
- 不校验 app secret；secret 的写入通道留给 keychain 切片。
