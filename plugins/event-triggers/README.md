# @dsh-enhanced/event-triggers

把受限 file、HTTPS/JSON 和 HMAC webhook 边缘条件转换成 `assistant-automations` 的稳定 external occurrence。插件先在自己的 SQLite outbox 持久化 fire，再调用 Automations；下游失败或重启时重放相同 event id，不直接创建 Agent 或发送消息。失败项采用持久退避重试，已删除或禁用 trigger 的遗留事件进入 quarantine，不会阻塞后续事件。

## 安装与默认状态

```sh
dsh plugin --profile web add @dsh-enhanced/event-triggers
dsh --profile web --dump-config
```

默认 `triggers: []`、`pollerEnabled: false`。File/HTTP 需要给 `background:event-triggers:<id>` 的 filesystem/network `observe` 明确 Policy 规则；Webhook 还需要 `external:webhook:<id>` 的 automation `accept` 规则，Automations 本身会再次验证 external `ingest`。

HTTP 网络权限使用精确 HTTPS origin：

```yaml
allowedHttpOrigins:
  - https://api.example.com
  - https://metrics.example.com:8443
```

旧配置 `allowedHttpHosts: [api.example.com]` 继续兼容，但只迁移为 `https://api.example.com`（默认 443）；非默认端口必须显式写入 `allowedHttpOrigins`。Origin 条目不能包含凭据、路径、query 或 fragment。

每个轮询触发器支持 baseline、`changed`/`truthy` edge、debounce、cooldown、TTL 和 maxFires；`pollConcurrency`（默认 8，范围 1–32）限制并发观测数，轮询起点会轮换，单个慢或失败 trigger 不会阻塞后续 trigger。单个 trigger 失败会记录健康状态并继续轮询其余 trigger。Webhook 同样执行持久 cooldown/TTL/maxFires，并使用 `credentials-keychain` handle（purpose 为 `verify-webhook`）、毫秒 timestamp、nonce 和签名：

```text
sha256=HMAC_SHA256(secret, timestamp + "\n" + nonce + "\n" + rawBody)
```

签名 timestamp 只作为 occurrence 时间和防重放窗口输入；cooldown/TTL 使用服务端一次捕获的接收时间，调用方不能通过伪造窗口内 timestamp 绕过。宿主 adapter 可调用 `ctx.eventTriggers.ingestWebhook()`；本版本不自行暴露公网 listener。若需要 HTTP ingress，应由只监听 loopback、具备 body/rate limit 的部署网关转发，不能把该 service API 当 capability URL。

## 权限与数据

- 文件系统：私有 SQLite（WAL/FULL、目录 `0700`、文件 `0600`）；只读取 `allowedFileRoots` 内 regular non-symlink 文件，按 `maxBodyBytes` 限制。被 file trigger 使用的 root 必须在 service 初始化时已存在且为目录；此时一次性固定其配置路径与物理 realpath 的 dev/ino，后续每次读取都复核。文件使用 `O_NOFOLLOW | O_NONBLOCK` 打开，并在 descriptor 上复查 regular file、dev/ino 与固定 root，覆盖跨 poll 以及同一读取内的 leaf、祖先目录、root symlink/FIFO swap。`requestTimeoutMs` 也作为每个 file observation 的 service deadline；底层不可取消的文件系统调用超时后仅保留每 trigger 一个纯读取，结果会丢弃，后续轮询和销毁不会等待它或在关库后回写。
- 网络：HTTP sensor 仅允许精确 HTTPS origin。每次请求最多接受 16 个去重 DNS answer，只允许 global-unicast IPv4，并校验保留地址。IPv6 默认 `ipv6Mode: deny`，因为任意网络都可能使用无法仅从地址识别的自定义 NAT64/翻译前缀；只有运维方确认出口为纯原生 IPv6、不会把任何 IPv6 前缀翻译到 IPv4 时，才可显式设为 `native-only`。启用后仍会拒绝 mapped、6to4、ISATAP 等可识别的内嵌非公网 IPv4。生产 socket 固定到本次单次解析的已验证地址，同时保留原 hostname 做 TLS SNI/证书校验，并以 `agent: false` 禁止复用全局 keep-alive socket 绕过本次 pin。一个 deadline 覆盖 DNS、连接、响应和正文；禁止 redirect，拒绝响应会取消正文，正文受 `maxBodyBytes` 限制。若底层 resolver/fetch/body 不响应取消，service 会维持该 trigger 的 single-flight 记录直到真实底层 operation 结束，不会每轮重复累积资源。
- 凭据：只有 webhook 配置存在时才需要 `credentials-keychain`；secret 只在 HMAC callback 内短暂可见，不落库/日志/事件。
- 子进程、浏览器、任意 shell、安装脚本：无。
- 外部 body：验签后也不会成为 Agent prompt；只生成不含正文的 occurrence。

`health()` 会返回 pending/retrying/quarantined/delivered 数、失败 trigger 数以及最近的有界错误摘要。SQLite schema v2 会从 v1 原位迁移并保留已有 pending event；poller 即使关闭，独立 outbox flush 仍会运行。每轮 flush 分页处理并对失败项持久退避，因此 poison/stale 事件不会造成队头永久阻塞。

## 限制

单机 SQLite 语义，不承诺跨节点 exactly-once；下游调用是至少一次，但 stable event id 由 Automations 去重。单轮 flush 有有界工作量，超过上限的 due event 会在后续周期继续公平处理。首版没有 command sensor、redirect follow、任意 URL、payload-to-prompt 或公网监听器。

## 兼容性与参考

以 DSH `0.1.2-rc.1` 验证。设计借鉴 `dsh-sentinel@833a4e9` 的 baseline/edge/cooldown 与 fire-before-delivery watermark，但没有安装或复制其 JSONL、shell command、弱租约或 capability URL 设计。
