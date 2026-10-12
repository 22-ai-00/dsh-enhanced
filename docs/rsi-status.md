# RSI 当前状态

更新：2026-10-12。本页是唯一进展入口；只加载本页及当前任务相关 README。验收条件见[合同](rsi-acceptance.md)，历史细节查 Git。

## 目标

实现普通使用驱动的持续自迭代：认证任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。初始配置和授权后，主人不必逐次编排改进。

**完整普通使用闭环尚未验收，npm 发布门未满足。**

## 能力边界

| 能力 | 当前边界 | 入口 |
| --- | --- | --- |
| 任务与记忆 | 已有认证反馈、原生调度与持久记忆学习；真实后续决策收益待验收。 | [Delivery](../plugins/assistant-delivery/README.md)、[Memory](../plugins/assistant-memory-learning/README.md) |
| 工程进化 | 已有源码发现、失败任务复盘、新工具独立验收、有限签名采用与动态加载，精确版本调用/反馈关联及独立签名源码保留。默认关闭的有限修订候选已具备独立父行为回归门：首作者请求前冻结专用授权，Verifier 私有父用例与候选写权限分离，父/候选新隔离观察，独立额度与签名结果，unknown 不重放。候选仍不执行或替换父版本，历史证据不延续执行权；稳定入口切换、回退与真实收益待验收。 | [Growth](../plugins/assistant-growth-driver/README.md)、[Control Plane](../plugins/plugin-control-plane/README.md) |
| 默认安装 | 开发版 Linux shell 与 CLI 默认进入完整学习配置；可信配对、模型与构建前提仍必需，路径和有限预算自动生成。保留显式轻量场景和不启用服务/渠道的退出选项；裸 bundle 不绕过配置验证，远程发布 tag 尚未更新。 | [安装器](../scripts/install/README.md) |
| 部署 | 本机 pre-owner 冻结维护已部署 `6a8dce4`，25 个包/18 个根 bundle，包含默认禁用的 Memory Learning；14 个身份摘要不变，原 Agent 恢复运行。owner 安装未就绪，学习调度尚未启用。 | [安装](../plugins/lark-channel/docs/rsi-setup.md)、[维护](../scripts/install/README.md#checkout-内的-pre-owner-冻结源码维护) |

## 当前阻塞与下一验收

当前交付：授权内减少重复审批、GitHub/飞书日历事件主动跟进，以及可直接安装的 npm 新版本。已补齐 supervised 的事件/主动性 bundle 安装、主人可用机会策略发现及 `proactive_status` 只读预授权；仍须显式配置来源、预算和等待权限，未提供聊天创建任意监控或任务之外自主发现。owner 配置器的基础包读取已改用经验证的 Host 安装目录，源码定向验证通过，尚未重新部署。

当前交付先完成官方 npm `latest` 的 **DSH `0.2.0-rc.2`** 适配；上游尚无无预发布后缀的正式稳定版。开发锁与 peers 成套迁移，包含 Session 4、动态 Auto、preset registry、原生 setup 解析和 profile 独立模型/权限设置；安装默认解析 latest 后冻结已验证精确版本。远程发布引导器仍固定旧制品，不能视为已更新。`0.1 → 0.2` 自动联合升级尚不支持，CLI 在替换旧插件前拒绝；新版本只在独立 Home 验证，不改变正在运行的旧安装。

本机目标为 `assistant`，原 Agent 与用量监控服务运行，学习仍禁用。用户已确认修复离线升级并开启学习 scheduler；升级后只读数据库核查三个旧 Heartbeat/Recovery 任务均为 paused、下一运行时间为空，满足本次 `--ack-existing-automations` 前提。

旧安装的离线维护已成功、身份未变；随后 owner 安装因协调器缺少 Host base 退出 1。读取 Host base 的修复已提交，尚未部署；新版本跨 ABI 迁移也必须先解决，不能以包安装成功代替调度就绪。

CI 保留 Linux/macOS 完整检查，平台夹具修复已提交；删除失败后重复全包测试，本次限制测试 worker 并取消同分支过时运行，降低争用与浪费。远端 macOS 结果仍待验证，不能以本地 Linux 通过替代。

下一验收先解决旧 Home 的联合 Host/插件迁移与回滚，再完成 owner 就绪与学习调度。独立父行为回归门是既有能力边界；现有配置没有父版本/slot 替换授权，不能扩大旧创建或采用额度的语义。当前任务身份按 Inbox 建立，不能推断跨 Inbox 的语义同一性。

启用后由新的真实普通任务验收创建 → 独立验证 → 动态采用 → 后续会话原生发现与复用；记录版本、实际调用、质量、成本、延迟和回归，检查纠正/撤回、重启及 unknown 不重放。之前组件诊断停在 unknown，无候选、采用或复用，不能作为闭环完成证据。两条普通使用通道通过可安装部署与[发布门](releasing.md)后再发布 npm。

## 最新验证

本轮最终 `VITEST_MAX_WORKERS=2 pnpm check` 退出 **0**：清单、零警告 lint、类型检查、**8376 项通过 / 61 项跳过**、构建与 **37 个包 dry-run pack** 全部完成；已核对新 profile 配置 helper 包含在 Policy 产物中。此前失败来自新版协议断言及 Host/YAML 依赖夹具，已修复并由本次完整检查覆盖；未降低生产安全断言。

真实 npm `0.2.0-rc.2` Host 的隔离 core 安装、ACP 初始化和双 profile 设置烟测通过：保留只读预设、其他 provider 与兄弟 profile，重复设置字节稳定。模型 route 的真实 headless 配置投影校验通过，未发真实模型请求。独立临时目录的 lifecycle helper 从 Host 声明依赖链加载结构化 YAML，真实 Host 正例及不执行危险表达式的负例通过；旧 Host 与环境污染拒绝由定向测试覆盖。

本轮证据在忽略目录 `docs/evidence/dsh-latest/`，完整命令为 `check-verified.log` / `.exit`。真实 Host/SQLite/Cordis 验证不等于真实普通任务闭环；尚未发布 npm、未启用生产学习，远端 CI 仍待验证。此前 WAL 活跃 writer 拒绝测试曾单次波动，本次 Automations 276 项全部通过；继续跟踪，不修改生产锁断言或把跳过的测试计作通过。

生产 DeepSeek 固定合同仍于 2026-10-08 过期；Super Relay 预算插件的固定合同于 2026-10-14 到期，但本机未安装该预算插件，不能据此判断当前会话路由是否可用。保留 owner 会话的 `super-relay/ark/seed-evolving` 选择，不把静态选择当作 live 调用证明；本轮不延长供应合同、不替换用户模型、不续期旧授权。
