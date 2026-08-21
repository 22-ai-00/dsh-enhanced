# @dsh-enhanced/event-triggers

把受限 file、HTTPS/JSON 和 HMAC webhook 边缘条件转换成 `assistant-automations` 的稳定 external occurrence。插件先在自己的 SQLite outbox 持久化 fire，再调用 Automations；下游失败或重启时重放相同 event id，不直接创建 Agent 或发送消息。

## 安装与默认状态

```sh
dsh plugin --profile web add @dsh-enhanced/event-triggers
dsh --profile web --dump-config
```

默认 `triggers: []`、`pollerEnabled: false`。File/HTTP 需要给 `background:event-triggers:<id>` 的 filesystem/network `observe` 明确 Policy 规则；Webhook 还需要 `external:webhook:<id>` 的 automation `accept` 规则，Automations 本身会再次验证 external `ingest`。

每个轮询触发器支持 baseline、`changed`/`truthy` edge、debounce、cooldown、TTL 和 maxFires。Webhook 使用 `credentials-keychain` handle（purpose 为 `verify-webhook`）、毫秒 timestamp、nonce 和签名：

```text
sha256=HMAC_SHA256(secret, timestamp + "\n" + nonce + "\n" + rawBody)
```

宿主 adapter 可调用 `ctx.eventTriggers.ingestWebhook()`；本版本不自行暴露公网 listener。若需要 HTTP ingress，应由只监听 loopback、具备 body/rate limit 的部署网关转发，不能把该 service API 当 capability URL。

## 权限与数据

- 文件系统：私有 SQLite（WAL/FULL、目录 `0700`、文件 `0600`）；只读取 `allowedFileRoots` 内 regular non-symlink 文件，按 `maxBodyBytes` 限制。读取时使用 `O_NOFOLLOW` 打开并在 descriptor 上复查 regular file，覆盖校验后发生 symlink swap 的窗口。
- 网络：HTTP sensor 仅允许 HTTPS 和精确 hostname allowlist；每次请求解析并拒绝 private/link-local/loopback，生产 fetch 的 socket lookup 固定到本次已验证地址，同时保留原 hostname 做 TLS SNI/证书校验，防止验证后 DNS rebinding；禁止 redirect，并限制 timeout/body。
- 凭据：只有 webhook 配置存在时才需要 `credentials-keychain`；secret 只在 HMAC callback 内短暂可见，不落库/日志/事件。
- 子进程、浏览器、任意 shell、安装脚本：无。
- 外部 body：验签后也不会成为 Agent prompt；只生成不含正文的 occurrence。

## 限制

单机 SQLite 语义，不承诺跨节点 exactly-once；下游调用是至少一次，但 stable event id 由 Automations 去重。首版没有 command sensor、redirect follow、任意 URL、payload-to-prompt 或公网监听器。

## 兼容性与参考

以 DSH rc.8 `141eb6fef83422698aef7a981029e843e8161534` 验证。设计借鉴 `dsh-sentinel@833a4e9` 的 baseline/edge/cooldown 与 fire-before-delivery watermark，但没有安装或复制其 JSONL、shell command、弱租约或 capability URL 设计。
