# RSI 当前状态

更新：2026-10-19。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)，历史实施与证据查 Git。

## 目标与能力边界

普通使用驱动持续自迭代：认证任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。初始配置和授权后，主人不必逐次编排改进。

**完整普通使用闭环尚未验收。** 工程测试、安装与服务就绪不证明后续真实任务的质量、成本、延迟及回归收益。

- macOS 原生新工具创建与采用无需 Docker：私有固定 Node 与冻结依赖 → 类型检查与构建 → 独立留出核验 → 签名 → Cordis 动态采用及持久复用。系统沙箱禁止联网和子进程，工作目录只读；次数和累计时长有上限，unknown 不自动重放。
- 候选与行为观察代码共享沙箱进程，预期答案与签名密钥留在 Host；没有内存、CPU、磁盘硬配额，不等同于 Linux 双进程隔离。任意 shell 的 isolation_run 仍是单独的 Docker 能力。
- 既有插件源码替换、发布与双 Host 交接仍限 Linux。Mac 普通升级仅支持未冻结且全程停止的 Home；冻结 cohort 原地迁移、跨版本私有 Host 更新和 Intel Mac 实机仍待支持或验收。备份后完整重装不等于原地迁移。

## 当前发布与实机状态

- `0.1.54` 已公开发布，37 包精确版本与 latest、不可变 tag 和六项安装资产逐项核对通过；Host 基线为 `0.2.0-rc.2`。包含 Lark SDK `1.76.0` 的握手超时清理修复，以及安装器从已安装 TraeX 纯 schema 读取默认 command 的修复。
- 精确源码 `46a3a23ca079125dbb34008dc428f76a64400546`：Mac 和 Linux 根目录 `pnpm check` 均退出 0；各有 38 组测试摘要和 37 包 dry-run pack，源码指纹和原始输出经独立复核。Mac 7792 通过 / 1064 跳过，Linux 8756 通过 / 100 跳过；跳过不算实机通过。Node `24.7.0`、pnpm `11.7.0`。
- 同源码 [dev CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39152555875)、[main CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39155698217) 均 5/5 成功；[Release](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39155718356) 再次全检、37 包发布及账本回写成功。账本提交 `0b87bacf`。
- **公开新装尚未通过**：Mac/Linux 临时 Home 安装 `0.1.54` 均因 pnpm 11.7 的 `ERR_PNPM_IGNORED_BUILDS: protobufjs@7.6.6` 退出 1。仓库已明确禁用此非必需脚本，但正式 npm 安装器未将该策略带入 profile。候选安装器现已在首次安装前明确拒绝此脚本，Mac/Linux 全新临时 Home 均通过正式入口安装公开 `0.1.54` 包，七个 bundle 实际启用、Host 自检与 SDK 导入均退出 0。安装器整组回归 185 通过 / 272 条件跳过；修复仍须随后续版本全检和发布，不修改既有标签。
- 真实 Mac `web` 仍运行公开 `0.1.53`：20 个 bundle、28 个包，私有 Host `0.2.0-rc.2`，source/runtime/plan 为 `3801baeb`。原生 journal ready，同一 launchd/observer 进程的六组件 active；有限授权 365 天 / 1000 次源码执行。原机器人“柳神”已通过真实私聊绑定，额外 208 项业务用户权限按用户选择暂缓。
- 原安装 TraeX CLI `0.210.1`、ACP `traecli-acp` 的真实目录为 28 个具体模型及 default。公开包 Host 加载、Web API、页面名称与选择 GPT-6-Astra 后刷新保留均已验收；旧服务目录曾退回 default，官方重启后恢复，未捕获旧 ACP 错误，具体诱因未确证。新版本仍须重新检查生产菜单与新飞书模型卡片。

## 当前交付与下一验收

正式 npm 新装已补齐 profile 级 `allowBuilds.protobufjs: false`，保留其他依赖审批与已有明确决策；双端全新临时 Home 的真实安装入口已验证。下一步对最终候选进行双端全检、跨平台 CI、发布和公开制品核验。随后按已授权的完整 Home 备份重装本机，沿用 `web` 和“柳神”，重新完成真实主人配对；业务权限继续跳过。

完成安装和原生服务、模型目录及新卡片回调后，再通过普通任务验证新工具复用、纠正、撤回、重启和后续收益，保持模型合同与有限授权，不自动续期或重放 unknown。

本轮原始记录：忽略目录 `docs/evidence/release-v0154-20261019/`；新装修复与复验：`docs/evidence/release-v0155-20261019/`。旧实机安装证据：`docs/evidence/macos-fresh-web-20261016/`。
