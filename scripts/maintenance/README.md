# 旧 Delivery 会话迁移

`migrate-delivery-session.mjs` 修复一种已复现的兼容问题：旧格式会话包含本项目的 `delivery` 消息来源，新版 DSH 的 v2→v3 迁移器拒绝它，导致飞书无法恢复原会话。

这是一项离线维护操作。目前支持审查过的 `@deepseek-ai/dsh-session-format-v2-to-v3@0.1.5-rc.2` 实现，使用源码 SHA-256 校验。维护子进程只扩展 `delivery` 的分类，严格要求 `kind/channel/account/eventId/trust` 五个字段、非空标识及 `trust: 'untrusted'`。其余未知数据仍被拒绝；不会改写为普通用户来源，不修改已安装的 DSH 包。

## 预览与应用

传入 CLI 实际 `lib/bin.js` 与旧会话文件的绝对、规范路径（可先用 `realpath` 获取）。默认仅复制单会话到私有临时目录，由官方 JSONL 后端迁移副本，然后在不带兼容处理的新进程中冷读验证：

```sh
node scripts/maintenance/migrate-delivery-session.mjs \
  --host-cli /absolute/path/to/@deepseek-ai/dsh/lib/bin.js \
  --session-file /absolute/path/to/sessions/WORKSPACE/DELIVERY_ID/session.jsonl.zstd
```

预览通过后，停止所有使用该 `DSH_HOME` 的 Host，确认没有旧会话写入者，再为同一命令添加 `--apply --confirm-host-stopped`。该确认由操作者负责；脚本不停止或启动任何服务。

应用前会复查原文件身份与摘要，创建权限为 `0700` 的单会话备份，并输出 `backup-created`。官方后端会先独立验证暂存的新记录、复查旧文件，再原子发布 v3。脚本随后比较完整逻辑记录与来源摘要，并确认旧 v0 文件的内容、inode、大小和修改时间未变。成功时输出 `applied`。

若输出 `apply-incomplete`，保持 Host 停止，使用报告中的备份路径、`legacyUnchanged` 和 `currentGeneration` 状态排查。已发布的记录会保留，脚本不会自动删除或回滚它们。只有维护成功并完成运行时检查后才恢复服务。

脚本拒绝符号链接、非普通文件、不支持的会话目录内容、超过 128 MiB 的副本，以及已有 v3 的会话；不会覆盖已有新版记录。它只备份选定会话，Host 升级涉及的其他数据库应另行备份。输出包含计数与摘要，不包含对话、账号或事件标识。

## 验证

```sh
node --test scripts/maintenance/migrate-delivery-session.test.mjs
DSH_SESSION_MIGRATION_TEST_CLI=/absolute/path/to/@deepseek-ai/dsh/lib/bin.js \
  node --test scripts/maintenance/migrate-delivery-session.test.mjs
```

完整迁移测试使用合成会话，需显式提供上述受支持 Host 的 CLI。没有该环境变量时，真实后端测试会明确跳过，不计作迁移验证。
