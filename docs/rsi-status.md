# RSI 当前状态

更新：2026-10-19。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)，历史实施与证据查 Git。

## 目标与能力边界

普通使用驱动持续自迭代：认证任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。初始配置和授权后，主人不必逐次编排改进。

**完整普通使用闭环尚未验收。** 工程测试、安装与服务就绪不证明后续真实任务的质量、成本、延迟及回归收益。

- `0.1.53` 已发布到公开 npm，37 个包的精确版本和 `latest` 均已逐项核对。精确 Host 基线为 `0.2.0-rc.2`（预发布）。
- macOS 原生新工具创建与采用无需 Docker：私有固定 Node 与冻结依赖 → TypeScript 语义检查及 JS/声明生成 → Host 打包 → 独立留出核验 → v2 签名 → Cordis 动态采用及持久复用。
- 系统沙箱禁止联网和子进程，工作目录只读；持久账本限制次数和累计时长，Host 退出后由 supervisor 清理并保存关闭回执。缺失或不符的回执保持 unknown，占用容量，不自动重放。
- 候选与行为观察代码共享沙箱进程，预期答案和签名密钥留在 Host；没有内存、CPU、磁盘硬配额，不等同于 Linux 双进程隔离。任意 shell 的 `isolation_run` 仍是单独的 Docker 能力。
- 既有插件源码替换、发布与双 Host 交接仍限 Linux。Mac 普通插件升级只支持未冻结且全程停止的 Home；运行中、身份未知或冻结资源会被拒绝。冻结 cohort 迁移、跨版本私有 Host 更新和 Intel Mac 实机仍待支持或验收。

## 当前验证

- 精确源码 `3801baebdce1251f0755152514585d7a5aa91f02`：Mac、Linux 实机根目录 `pnpm check` 均退出 0，各完成 37 个包的 dry-run pack；源码前后指纹及原始日志经独立复核通过。Node `24.7.0`、pnpm `11.7.0`；条件跳过不算实机通过。
- 同一源码的 [dev CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/38819827778) 和 [main CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/38822617317) 均为 5/5 成功；[Release](https://github.com/22-ai-00/dsh-enhanced/actions/runs/38826666692) 再次全检、37 包发布及账本记录成功。不可变 `v0.1.53` 指向该源码，账本提交为 `0321c9f2`。
- 公开标签的六项安装资产摘要匹配；Mac 与 Linux 的私有临时 Home 均从公开 npm 安装 Host `0.2.0-rc.2`、personal-assistant / plugin-control-plane / traex-acp-provider `0.1.53`，安装和组合配置命令全部退出 0，独立复核通过。临时 Home 的安装与配置检查不替代真实身份配对、模型配置、预算授权及 supervised 服务启动。
- TraeX CLI `0.210.1` 的 ACP 身份为 `traecli-acp`，插件现精确接受它和旧 `traex-acp`，保留 ACP v1、Trae SSO 与未知身份拒绝。公开 npm 安装包经真实 Host 的依赖解析实测，`listModels` 返回 28 个具体模型及 1 个 `default`，与原生目录匹配；无 prompt，ACP 子进程及 Host 测试上下文均关闭，独立复核通过。
- 真实 Mac `web` 已按用户授权完成旧数据备份和官方完整重装，安装器退出 0：20 个 bundle、28 个包均为公开 npm `0.1.53`，私有 Host `0.2.0-rc.2`，source/runtime/plan 均绑定 `3801baeb`。原生 journal 为 `ready`，launchd 与认证 observer 的同一进程六组件全部 active，有限授权为 365 天 / 1000 次源码执行；独立实测通过。原机器人“柳神”已通过真实私聊绑定主人并连接，额外 208 项飞书业务用户权限按用户选择暂缓。
- 生产 Web 模型 API 返回 28 个具体 TraeX 模型及 default，零失败；真实页面 29 项名称与 API 一致，选择 GPT-6-Astra、刷新保留、恢复 default 再刷新均通过。已有助手工作区通过官方 `workspace/create` API 注册，未改冻结配置；本轮不提交模型 prompt。安装器结束摘要仍可能把省略显式 command、使用 schema 默认值的有效 route 误报为空；实际运行与 UI 验收通过，提示缺陷保留记录。
- 10 月 19 日网络复测恢复，原命令、原 240 秒时限的冷缓存 bootstrap 重跑退出 0，耗时 74.5 秒。10 月 16 日的两次超时失败保留在证据中；Mac、Linux 当前源码 `8031a04b` 的补充根目录全检仍在运行。
- 当前生产复测发现旧服务的飞书连接断开、TraeX 目录退回 default；官方受管重启退出 0 后，六组件 active、柳神连接及 29 项目录恢复，真实 Web 菜单再次核对。TraeX 登录有效；旧目录发现耗时约 10 秒，符合发现超时回退，但未捕获旧 ACP 错误，不能认定具体诱因。
- 新发现的 Lark SDK `1.73.0` 握手超时会因丢弃 socket 错误监听而终止 Host，已在无凭据的本地回环子进程中复现（退出 1）。官方 `1.76.0` 同一场景退出 0；生产仍为已发布的固定依赖，不能把重启恢复称为根因修复。

## 下一验收

完成当前双端全检和独立复核，再按固定发布与安装合同处理 SDK 修复。之后通过普通任务验证新工具复用、纠正、撤回、重启和后续收益，保持模型合同与有限授权，不自动续期或重放 unknown。真实 Mac 安装与模型选择器验收不代替这些长期收益；放弃旧数据后的完整重装也不代表冻结 cohort 原地迁移已经支持，仍不能用单包覆盖绕过保护。业务授权等待用户另行决定，不阻塞本机服务使用。

公开发行证据位于忽略目录 `docs/evidence/macos-native-20261015/release-v0153-acceptance.md`；真实 Mac 重装证据位于 `docs/evidence/macos-fresh-web-20261016/acceptance.md`，当前复测位于 `docs/evidence/macos-closeout-20261019/`。
