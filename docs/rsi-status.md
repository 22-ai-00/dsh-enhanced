# RSI 当前状态

更新：2026-10-30。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)，历史实施与证据查 Git。

## 当前交付

- 去除 Linux 安装与自迭代的 Docker 依赖，保留普通隔离执行、完整源码修复、工具创建/修订、独立验收、有限采用、发布与回退。不能关闭功能或改用受限创建路径；合同见[原生运行时](dockerless-runtime.md)。
- 原生执行、全仓 prepare、创建 v3 与保留采用、修订 v2/配对回归 v2，以及源码审批、发布、采用和物理回退已接线。保留原证书、owner/来源、已用额度、缓存及 unknown；历史 Docker/macOS 证据按原版本读取，不重解释或重派。当前实机范围为 Linux x64/cgroup v1，cgroup v2 明确拒绝，arm64 未实测。
- Linux 全新 `--install-owner` 已接入原双 Host 事务，默认生成完整原生源码修改、创建、修订/回归及发布采用配置。五个 runner 在发授权前固定账本身份；首次安装拒绝已有使用历史，重试只读原状态。旧 Docker 重试保留后端与授权，只查询镜像就绪。配置/事务测试通过，实机新装仍待验收。

## 活跃阻碍与下一验收

- 完成无 Docker 实机新装、原生更新候选激活、已有 owner 的保权迁移与进程内热加载；验证完整 prepare 在原 1800 秒授权内完成。迁移必须保留主人、会话、模型/凭据、权限范围/期限、已用额度、unknown 和回退点，不能靠重装重新签发旧额度。首次采用约 38 秒、冷恢复约 13 秒、简单工具调用约 25 秒，重复运行时校验仍有明显开销，尚不能称为无感。
- 公开版本 `0.1.65`；本机 owner 为 `0.1.64`，远端为 `0.1.65`，Host 均为 `0.2.1-rc.2`。两机目标与协调器运行中；本轮原生安装改动尚未发布部署。远端有 bwrap 和 subordinate UID/GID 分配，但缺少 `newuidmap/newgidmap`。
- 远端重新配对后，RSI 后台仍引用已撤销的旧 conversation/principal；增长和任务观察每分钟失败，资格扫描每分钟进入 unknown。现有配对事务不迁移冻结授权，需停止旧扫描并通过显式重配接入当前有效 owner；不得恢复撤销授权或将旧 grant 转给新身份。只读审计记录位于忽略目录 `docs/evidence/native-install-integration/production-audit-20261030.json`。
- Wiki 合法内容下次读取刷新，无需重启；前台等待、取消和进度收尾有界。同码维护重启仅续办可证明无未知副作用的只读任务，保留原模型和剩余预算，每任务最多一次。任意硬崩溃续办、无句柄旧卡片回填、独立飞书连接及升级后真实复杂任务的最终回复尚未验收；同 UID 监督器不隔离恶意 Host 插件。旧 pending/unknown 与一次 lost-resource-ack 清理未确认记录继续保留。
- provider 迁移保留三个 API provider，三条自定义路线已验证，官方 DeepSeek 返回 401；旧私聊保留 TraeX 选择。完整 Hermes 历史及 75 项技能迁移、真实普通任务的长期学习收益未完成。

## 最新验证

- 无既有 `lib/node_modules` 的源码副本完成 `pnpm install --frozen-lockfile` 后，根 `VITEST_MAX_WORKERS=4 pnpm_config_workspace_concurrency=4 pnpm check` 退出 0：9852 项测试通过、298 项条件跳过、0 失败，清单/lint/typecheck/构建及 37 包 dry-run pack 全通过。检查期间两工作区的 1812 个源码文件摘要均未变；日志 SHA-256 `150c3e265d216e6d330539d1aba2a29fc9ccece4f835747a002ea2d9c3e229b1`。证据位于忽略目录 `docs/evidence/native-install-integration/clean-attempt-1/`；独立代码复核 PASS，检查后仅收敛本状态文档。
- 官方 Node `22.23.2` 下，账本保护 39 项、原生 manifest/实际 prepare 分支 25 项测试均通过。完整安装事务测试覆盖双 Host 启动顺序、原授权重试及缺失账本拒绝，但 systemd/DSH transport 使用替身；不能据此证明实机安装。
- 本次宿主机全检耗时 1651.27 秒（27 分 31 秒）。完整原生 prepare 还有安装、产物步骤及隔离环境开销，尚未证明能在原 1800 秒授权内稳定完成。历史创建/有限采用实机证据使用脚本供应商和内存渠道；新修订与发布/回退全链及真实 provider/Lark 任务仍待验收，已终止或 unknown 的旧试验不自动重跑。
