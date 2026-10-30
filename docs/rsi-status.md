# RSI 当前状态

更新：2026-10-30。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)，历史实施与证据查 Git。

## 当前交付

- 去除 Linux 安装与自迭代的 Docker 依赖，保留普通隔离执行、完整源码修复、工具创建/修订、独立验收、有限采用、发布与回退。不能关闭功能或改用受限创建路径；合同见[原生运行时](dockerless-runtime.md)。
- 原生执行、全仓 prepare、创建 v3 与保留采用、修订 v2/配对回归 v2，以及源码审批、发布、采用和物理回退已接线。保留原证书、owner/来源、已用额度、缓存及 unknown；历史 Docker/macOS 证据按原版本读取，不重解释或重派。当前实机范围为 Linux x64/cgroup v1，cgroup v2 明确拒绝，arm64 未实测。
- Linux 全新 `--install-owner` 已接入原双 Host 事务，默认生成完整原生源码修改、创建、修订/回归及发布采用配置。五个 runner 在发授权前固定账本身份；首次安装拒绝已有使用历史，重试只读原状态。旧 Docker 重试保留后端与授权，只查询镜像就绪。配置/事务测试通过，签发 owner 授权及启动双 Host 的实机新装仍待验收。

## 活跃阻碍与下一验收

- 完成无 Docker 的 owner 授权及双 Host 实机新装、原生更新候选激活、已有 owner 的保权迁移与进程内热加载；原 1800 秒限额内的完整源码 prepare 已有一次成功实测，见最新验证。迁移必须保留主人、会话、模型/凭据、权限范围/期限、已用额度、unknown 和回退点，不能靠重装重新签发旧额度。首次采用约 38 秒、冷恢复约 13 秒、简单工具调用约 25 秒，重复运行时校验仍有明显开销，尚不能称为无感。
- 公开版本 `0.1.65`；本机 owner 为 `0.1.64`，远端为 `0.1.65`，Host 均为 `0.2.1-rc.2`。两机目标与协调器运行中；本轮原生安装改动尚未发布部署。远端已补齐 uidmap/libsubid4 与四个 cgroup v1 资源根；两个映射 helper 为 root 所有的 `4755`，原 UID/GID 分配及服务启动时间不变。只读映射/资源根校验和 11 项实机隔离边界检查通过，88 个测试资源目录均已消失；证据位于忽略目录 `docs/evidence/remote-native-prerequisites/`。
- 远端 profile 虽名 `web`，当前仅一位有效 Lark DM owner，与旧 RSI manifest 的 principal/record 均不同。10:52 UTC 只读复核确认旧 owner 为 revoked/version 2（授权冻结 version 1），四份旧扫描定义仍 active；近 30 分钟 usage/task-observation 共 60 次 failed，live-qualification 30 次 unknown。现有安装重试及升级只支持同 owner，需先持久退休旧扫描（重启及身份切回不得复活），再通过显式新代次配置接入当前 Lark owner，保留旧授权、账本、资源路径和 unknown，不恢复撤销身份或转移旧 grant。证据见忽略目录 `docs/evidence/current-handoff-audit/takeover-current-20261030-105257.json`；无需为此次恢复新增 Web 接入。
- Wiki 合法内容下次读取刷新，无需重启；前台等待、取消和进度收尾有界。同码维护重启仅续办可证明无未知副作用的只读任务，保留原模型和剩余预算，每任务最多一次。任意硬崩溃续办、无句柄旧卡片回填、独立飞书连接及升级后真实复杂任务的最终回复尚未验收；同 UID 监督器不隔离恶意 Host 插件。旧 pending/unknown 与一次 lost-resource-ack 清理未确认记录继续保留。
- provider 迁移保留三个 API provider，三条自定义路线已验证，官方 DeepSeek 返回 401；旧私聊保留 TraeX 选择。完整 Hermes 历史及 75 项技能迁移、真实普通任务的长期学习收益未完成。

- `04e216a5` 的 GitHub CI 未通过：Linux 缺少原生隔离测试固定的 Node 22.23.2，macOS 测试错误期待 Linux 专用入口成功。独立工作区的环境及测试修复已通过专项和独立复核，尚未合入及验证真实跨平台 CI；工作区 Node 24.7.0 与生产隔离版本边界保持不变。普通成对 npm 升级目前会把四个扫描的预期退休视为非受管状态漂移，需增加精确迁移证明，不能跳过整体保留校验或用新代次重置累计预算。

## 最新验证

- 撤权扫描退休及原生 tick 启动恢复已通过独立代码、专项及冷全检复核。无既有 `lib/node_modules` 的副本完成 frozen 安装和根 `pnpm check`，退出 0：9917 项通过、300 项条件跳过、0 失败，清单/lint/typecheck/构建及 37 包 dry-run pack 全通过，三处新增扫描模块均入包；两工作区 1818 项源码内容及权限摘要前后一致。用时 1613.54 秒，日志 SHA-256 `67ae453fa84120030c512a29fb14706f15c93c7efd5c71ff0453d264587c1478`。真实远端数据副本的 v15→v16 迁移另保留 16 张原表共 64199 行及 unknown，仅退休四份精确定义。原始失败与通过记录位于忽略目录 `docs/evidence/retired-owner-scanners/`；检查后仅更新本页。此结论不替代跨平台 CI、生产升级或 owner 换代验收，尚未发布部署。
- 精确提交 `05625895` 在独立 Home、普通 UID、`umask 077` 且 Docker 命令/socket 不可用的环境中，完成 19 bundles 的 27 包安装、正式 `--prepare-build` 及已安装 `rsiInstallPorts.prepare`；repository v4、creation v3 和五份 runner 状态齐全，四个关键包的 226 个运行文件与冷全检一致。68011 字节回执重读与 observer 权限故障通过实机复验。重复准备 55.19 秒成功，六棵保留树的 85928 项内容及身份不变，仅排除瞬态锁父目录时间戳；独立复核 PASS。证据：忽略目录 `docs/evidence/native-install-live/attempt-2/`。
- 官方 Node `22.23.2` 下，账本保护 39 项、原生 manifest/实际 prepare 分支 25 项测试均通过。完整安装事务测试覆盖双 Host 启动顺序、原授权重试及缺失账本拒绝，但 systemd/DSH transport 使用替身；不能据此证明实机安装。
- 无 Docker 的完整原生源码 prepare 单次退出 0，用时 1649.50 秒（原限额 1800 秒，8 CPU、16 GiB、64 KiB 输出，未放宽）；包含离线 frozen 安装、全仓 `pnpm check`、包产物和输入复核，5 次附加断言的 25.14 秒也计入预算。95002 字节产物 SHA-256 `d850384365d31ba19a13590fd9255f58a47856c23b688251283d897ce5b174ec`，执行已 settled/quiescent，8 个资源目录和 namespace 均已消失，原源码/五账本快照相同；独立实测及文档复核 PASS。证据：忽略目录 `docs/evidence/native-full-source-prepare/attempt-1/`。本次不提供各测试计数，也未签发生产 owner 授权或启动双 Host；历史创建/有限采用仍使用脚本供应商和内存渠道，新修订与发布/回退全链及真实 provider/Lark 任务仍待验收。
