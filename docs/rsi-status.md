# RSI 当前状态

更新：2026-10-19。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)，历史实施与证据查 Git。

## 目标与能力边界

普通使用驱动持续自迭代：认证任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。初始配置和授权后，主人不必逐次编排改进。

**完整普通使用闭环尚未验收。** 工程测试、安装与服务就绪不证明后续真实任务的质量、成本、延迟及回归收益。

- macOS 原生新工具创建与采用无需 Docker：私有固定 Node 与冻结依赖 → 类型检查与构建 → 独立留出核验 → 签名 → Cordis 动态采用及持久复用。系统沙箱禁止联网和子进程，工作目录只读；次数和累计时长有上限，unknown 不自动重放。
- 候选与行为观察代码共享沙箱进程，预期答案与签名密钥留在 Host；没有内存、CPU、磁盘硬配额，不等同于 Linux 双进程隔离。任意 shell 的 isolation_run 仍是单独的 Docker 能力。
- 既有插件源码替换、发布与双 Host 交接仍限 Linux。Mac 普通升级仅支持未冻结且全程停止的 Home；冻结 cohort 原地迁移、跨版本私有 Host 更新和 Intel Mac 实机仍待支持或验收。备份后完整重装不等于原地迁移。

## 当前发布与实机状态

- `0.1.55` 已公开发布，37 包精确版本与 latest、不可变 tag 和六项安装资产逐项核对通过；Host 基线为 `0.2.0-rc.2`。正式安装器在首次 npm 添加前将 `allowBuilds.protobufjs: false` 写入 profile，修复 pnpm 11.7 新装中断，保留其他构建审批与已有明确决策；包含 Lark SDK `1.76.0` 握手清理和 TraeX 默认 command 发现修复。
- 精确源码 `3da0337f2cb337df244299cf64b06bcb85db477a`：Mac 和 Linux 根目录 `pnpm check` 均退出 0；各有 38 组测试摘要和 37 包 dry-run pack，源码指纹和原始输出经独立复核。Mac 7797 通过 / 1064 跳过，Linux 8761 通过 / 100 跳过；跳过不算实机通过。Node `24.7.0`、pnpm `11.7.0`。
- 同源码 [dev CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39160382184)、[main CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39163045263) 均 5/5 成功；[Release](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39163079875) 再次全检、37 包发布及账本回写成功。账本提交 `4bbfad31` 已同步回 `dev`。
- **公开新装通过**：Mac/Linux 的全新临时 Home 均使用公开 tag 安装器安装公开 `0.1.55`，各七条命令实际退出 0；七个增强 bundle 与 base 激活、Host 自检、配置加载和 SDK `1.76.0` 实际导入均通过。安装均使用 pnpm `11.7.0`，Mac 使用本机 Node `26.11.1`，Linux 使用 `24.7.0`。临时安装未进行主人配对或部署常驻服务。
- Mac 公开包经真实 Host 加载，TraeX CLI `0.210.1` / ACP `traecli-acp` 返回 28 个具体模型及 default，与原生目录一致；ACP 子进程全部关闭。生产 Web API 返回同一目录，Chrome 实际选择具体模型、刷新保持、恢复默认并刷新均通过。新飞书 `/model` 卡片确认完成，回执 accepted，选定模型在原生服务重启前后保持一致。本轮目录与持久化验收未发送模型 prompt。实际 Cordis 补丁版本与 peer 范围见[兼容性基线](compatibility.md)。
- **Mac arm64 原生完整重装就绪**：CLI、20 个增强 bundle 根依赖及 28 个增强运行包均为 `0.1.55`；旧 Home 的 0600 完整备份通过 gzip、tar 与版本内容校验，保留钥匙串凭据后重新完成真实 owner 配对。首次 supervised 配置因缺少真实 DM 会话退出 1；owner 发送 `/model` 并确认后，官方 Host-aware `--install-owner` 续跑退出 0，journal 为 ready。launchd 与 observer 的 PID 一致，六项原生服务全部 active，Lark 已连接，backend 为 `macos-seatbelt`；授权为有限 365 天、构建 1000 次，不自动续期。额外 208 项业务用户权限继续暂缓。

## 当前交付与下一验收

本轮升级与发布验收已完成：双端全检、跨平台 CI、公开发布、双端真实新装、Mac 原生常驻服务、飞书模型卡片与 Web 模型选择均已通过并独立复核；业务权限继续跳过。

下一验收是普通任务中的新工具复用、纠正、撤回、重启和后续收益，保持模型合同与有限授权，不自动续期或重放 unknown。服务就绪和模型选择不替代真实推理与长期收益证据。

本轮原始记录：忽略目录 `docs/evidence/release-v0155-20261019/`；Mac 全量检查日志位于 `docs/evidence/macos-native-20261015/`。旧实机安装证据：`docs/evidence/macos-fresh-web-20261016/`。
