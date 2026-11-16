# RSI 当前状态

更新：2026-11-16（快照 `dev` `f753d294` + DSH `0.2.2-rc.3` 升级）。完整成功条件见[验收合同](rsi-acceptance.md)，发行门见[发布协议](releasing.md)，工具链与 Host 范围见[兼容说明](compatibility.md)。原始日志留在 ignored `docs/evidence/` 或 CI artifacts，历史查 Git。

## 目标

通过认证任务与反馈、原生 Agent、持久学习、独立验证、有界采用和回退，减少主人的协调与返工；收益以后续真实任务的质量、成本与人工介入衡量。

## 能力边界

- 发布基线：npm 39 包含 `assistant-dreaming`，统一版本 `0.1.73`（[release-manifest](../release-manifest.json)，releasedAt 2026-11-16T12:15Z，`origin/main` = `f7020a7a`）；当前 `dev` 上源码已升级至 DSH `0.2.2-rc.3` 基线（pending release）。
- Host 基线：DSH `0.2.2-rc.3`（catalog 与测试依赖，`.node-version` `24.9.0`），peer 接受 `>=0.2.2-rc.3 <0.3.0`，下一待发布 pinned Host `0.2.2-rc.3`；Cordis/Loader/Include/Group 锁定 `4.1.0`/`1.1.0`/`1.1.0`/`1.1.0`（Linux bwrap 行为验证隔离运行时保持 `/usr/bin/node` `v22.23.2`）。
- 已有实现：原生 Goals、WorkItems、Automations、Delivery、Verifier、Evaluation、Memory/Wiki、Skills、Growth Driver、Control Plane 与 Isolation 各自持久账本；默认关闭的可选能力（WorkItems 诊断与学习、intake 账本、event-triggers poller、dreaming 等）见[插件目录](../plugins/README.md)。
- 学习与自演化受 owner 授权、有限预算、独立验收与精确版本回退约束；模型自评、工具成功退出与部署关联都不构成验收。
- 平台边界：Linux 原生执行仅支持 cgroup v1（拒绝 v2），arm64 与活 Home 迁移未验收；Docker 执行后端已移除，旧收据仅作只读迁移证据。Mac 可开发，Linux `/data00` 独立副本验证。
- 已有 Docker 原安装的程序升级要求创建/修订审查与采用业务记录为空；非空创建历史迁移未实现，完整 live Docker→native 切换未验收。
- 完整门在本机需要三条环境前提（原生 `@pnpm/exe`、已填充的 pnpm store、短 `TMPDIR`）；解析方法见 [Linux 验证环境](linux-validation.md)。

## 活跃阻塞

- 真实渠道/外部执行验收未完成：B3 真实模型与渠道、E3b 真实飞书联调、D3a-1/D5 真实外部执行链与第二事件源。
- Linux 线上 Home 为冻结本地 cohort 登记，标准升级需先按发布流程换到新版本；是否已随 0.1.70–0.1.72 完成，仓库内无证据，需人工确认。
- 长期收益未验收：缺少 C/D/E 真实后续任务的同供应商同预算 parent/candidate 对比（F）。

## 下一步验收

1. F：用真实后续任务做 parent/candidate 长期收益对比（同供应商、同预算，报告质量、成本、延迟与回归）。
2. B3：真实模型/渠道端到端验收，含 owner 更正/撤回、跨会话与重复消息的投递事实。
3. E3b 与 D3a-1/D5：真实飞书联调、真实外部执行链与第二事件源；受上面 Linux Home 前置条件约束。

## 最近验证

- B3 真实渠道：2026-11-16 在 Linux 主机 `assistant` profile（柳七月，15 个插件）完成 Hermes bot → 柳七月 → 飞书渠道的端到端验收（inbox `processed`、outbox `accepted` 且 `provider_message_id` 可经飞书 API 读回）；peer 白名单配置与证据字段见 [peer agent 真实渠道验收](peer-agent-verification.md)。
- 发布：`v0.1.72` 已记录（`879f751e` 发布 supersede、`7a2bc5bf` 记录发布），`release:status` 无 pending 发布。
- 提交 `40f20217`（v0.1.71 前）：提交信息记录 Linux 冷 `pnpm check` EXIT 0 / 2160s、零失败、39 packs、独立只读复核 PASS。
- `origin/main` 之后的 7 个提交只做了定向验证（安装器用例 18/18、干净 Linux 主机 npm 路径安装 exit 0）；未在本机复跑标准完整门，本文不声称完整门通过。
