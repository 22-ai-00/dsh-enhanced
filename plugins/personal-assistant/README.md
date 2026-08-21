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

patch 只挂载 `dsh-enhanced-personal-assistant` 这一行；该入口再通过 Cordis 子插件生命周期依次启动 Policy、Memory、Wiki 和 Automations。不要在同一 profile 同时启用本 meta-bundle 与四个独立子 bundle，否则会重复提供同名 service。

## 默认安全状态

- policy 的 `rules` / `budgets` 均为空，因此所有受控操作默认拒绝；安装能力不等于授予权限。
- automations scheduler 默认关闭；创建并审批 automation 后仍需由部署者显式启用 scheduler。
- Memory、Wiki、Policy、Automations 使用各自的 DSH home 私有路径和独立真源。
- meta 入口先等待 Policy 完成激活，再依次挂载 Memory、Wiki 与 Automations；真实 rc.8 启动不依赖同步构造或 YAML 行序碰巧成功。

按各子包 README 添加最小 policy rule，并先在测试 profile 使用 `--dump-config` 检查最终 patch。

## 权限与数据

meta-bundle 自身不增加文件系统、网络、子进程、凭据、浏览器或安装脚本权限。四个子包的实际权限和数据边界分别见其 README；安装本包会安装并激活这些 runtime dependencies。

## 兼容性

子包均以 DeepSeek Harness `0.1.0-rc.8`（提交 `141eb6fef83422698aef7a981029e843e8161534`）为验证基线。参见[兼容性文档](../../docs/compatibility.md)。
