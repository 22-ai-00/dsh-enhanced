# @dsh-enhanced/event-triggers

把受限 file、HTTPS/JSON、Lark Calendar 和 HMAC webhook 边缘条件转换成 `assistant-automations` 的稳定 external occurrence。插件先在自己的 SQLite outbox 持久化 fire，再调用 Automations；下游失败或重启时重放相同 event id，不直接创建 Agent 或发送消息。失败项采用持久退避重试，已删除或禁用 trigger 的遗留事件进入 quarantine，不会阻塞后续事件。

每个新 outbox 行同时保存不可变 `dsh-external-event/v1` provenance envelope 和摘要：它绑定 trigger 配置摘要、冻结的 automation target、稳定 event id、观测摘要/edge revision 和信任方式，但不包含 file 内容、HTTP 响应、webhook body 或凭据值。重放时会复核摘要与当前 trigger 配置；任何 retarget 或配置变化都会 quarantine 旧行，不会将它投递给新目标。schema v1/v2 的旧 outbox 行没有 provenance，会 quarantine 并要求操作员核对历史目标；它们不会自动重放，也不能被解释为具有新来源证明。

## 安装与默认状态

```sh
dsh plugin --profile web add @dsh-enhanced/event-triggers
dsh --profile web --dump-config
```

默认 `triggers: []`、`pollerEnabled: false`。File/HTTP 需要给 `background:event-triggers:<id>` 的 filesystem/network `observe` 明确 Policy 规则；Webhook 还需要 `external:webhook:<id>` 的 automation `accept` 规则，Automations 本身会再次验证 external `ingest`。

`github-repository` 来源以结构化状态摘要产生变化事件，响应内容不进入模型上下文。嵌入式配置绑定 `repository`、`branch`、`baseBranch` 和 `credentialHandle`，只读固定 `api.github.com` 的分支 check-runs、目标 PR 和 reviews。Keychain handle 须允许 consumer `dsh-enhanced-event-triggers`、purpose `github.observe`；每次请求受租约、固定 HTTPS 出口、正文上限和共同 deadline 约束，截断或不一致的提交状态拒绝生成事件。外部 `external-unix-v1` 配置以 `externalGrant: { id, revision, digest }` 替代 `credentialHandle`，两者必须恰有一个；它要求 `observerLifetime: goal` 和 observer。Event Triggers 不取得 GitHub 凭据或网络 transport，而是通过已注入的 `assistantActions.readRepositoryEventObservation` 获取仅含 `sha256:` 指纹和 `truthy: true` 的已验证观测。

该来源必须配置 `observer`：准确 workspace/preset、principalId/principalRecordId/principalVersion、ownerRouteId、绝对 expiresAt 和 budgetId。它复用 Automations 的有限 Host 执行器，不调用模型；另需 Delivery 验证 owner route，Policy 授权观测、凭据、来源执行和下游 ingest。Web Owner 的 `repositoryDelivery.events` 可生成这些配置及有限轮询/执行预算。原有未配置 observer 的来源保持既有行为。

`lark-calendar` 是独立安装后可选的只读来源，需要同时安装并启用 `@dsh-enhanced/lark-channel`。配置必须提供一个精确 `calendarId` 和有限的 Unix-second `startTime`/`endTime` 窗口，以及 `observer`。它不会调用 Calendar list，也不会枚举或探测其他日历。Lark Channel 的 `allowedCalendarIds` 默认空；该 exact ID 必须同时在其中，且 Event Triggers 必须有 exact `network:lark-calendar:<calendarId>` 的 background `observe` Policy 规则。两个门都通过后，连接器才以其受限 SDK/token 生命周期读取 `GET /open-apis/calendar/v4/calendars/{calendar_id}/events` 的固定窗口分页。app secret、tenant token、page token 和日历正文都不进入 Event Triggers 的配置摘要、SQLite outbox、envelope 或健康日志。

```yaml
triggers:
  - id: owner-calendar
    kind: lark-calendar
    automationId: owner-calendar-change
    calendarId: cal_exact_owner_selected
    startTime: 1760000000
    endTime: 1760604800
    pageSize: 100
    maxPages: 10
    maxEvents: 1000
    fireWhen: changed
    cooldownMs: 60000
    maxFires: 20
    observer:
      workspace: /absolute/owner-workspace
      preset: primary
      principalId: owner:exact
      principalRecordId: owner-record
      principalVersion: 1
      ownerRouteId: owner-route
      expiresAt: 1760604800000
      budgetId: calendar-observations
```

每次读取会在 `maxPages`/`maxEvents` 内消费所有后续页；循环 token、截断、超过上限、非法项目或异常响应均为 unknown，不生成快照或事件。完整集合的规范化摘要会检测添加、修改和窗口中的删除，但分页读取不是远端原子事务：它仅是一个不可信 change nudge。唤醒的目标必须在授权范围内重新读取并独立验收真实日程，不能把此事件当作日历状态证明。首次使用前，操作员应以 `dsh-lark-setup --create-app --calendar-readonly` 为当前应用增量申请只读 Calendar scope，发布/管理员批准后，将实际允许的 Calendar ID 写入 Lark Channel 配置；没有真实应用、scope、日历共享权限和测试日程时，此来源不能视为已验收。

来源摘要和序号先持久化，独立于下游 observer 执行回执，Goals 可以用它们等待变化；事件本身不证明 CI/评审成功，最终必须重新核验实际提交。重启复用来源与授权，不延长期限；来源暂停、授权过期、route 或已协调定义变化后，停止观测并拒绝来源查询/投递。默认 `observerLifetime: shared` 保持既有共享来源行为与配置摘要。显式 `observerLifetime: goal` 将来源限定为一个目标：首次合法 `goal_wait_event` 持久绑定准确 owner/scope、业务目标定义、Session 和原生 Goal；同一目标的后续等待可增加 revision，其他目标不能接管。Goals 的可信只读快照确认该目标 complete 后，来源在等待协调或下一次观测/投递检查时持久退役并暂停对应 observer，重启不再启用；晚到的观测结果不能新增事件。已派发的合法 wake 仍可正常结算并反馈结果。共享来源不会因为某个目标完成而停止。

Web Owner 的新 `repositoryDelivery.events` 配置使用 `observerLifetime: goal`，不要求用户预先填写尚未创建的 Goal ID。退役的来源不转移给新目标；新目标需要新的有限来源配置和授权。缺失可信 Goals 状态、定义变化、owner 或来源配置变化都拒绝继续观察，外部事件正文不能自行声明目标完成。

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
- 凭据：webhook 配置需要 `credentials-keychain`；secret 只在 HMAC callback 内短暂可见，不落库/日志/事件。Lark Calendar 不向本插件授予或暴露 app secret/token；它只能调用已启用 Lark Channel 的 exact-ID 只读桥，桥本身仍受 channel credential lifecycle 与 `allowedCalendarIds` 限制。
- 子进程、浏览器、任意 shell、安装脚本：无。
- 外部 body：验签后也不会成为 Agent prompt；只生成不含正文的 occurrence。

`health()` 会返回 pending/retrying/quarantined/delivered 数、失败 trigger 数以及最近的有界错误摘要。SQLite 当前 schema v4 沿既有版本链迁移；没有 provenance 的历史 pending event 按上述规则隔离。poller 即使关闭，独立 outbox flush 仍会运行。每轮 flush 分页处理并对失败项持久退避，因此 poison/stale 事件不会造成队头永久阻塞。

## Host 事件读取

可信 Host 可调用 `sourceSnapshot(triggerId)` 冻结来源标识、配置摘要、automation target 和 `highWaterSequence`，再以 `firstEventAfter(snapshot, sequence, deadlineAt)` 读取快照后的首个匹配事件。返回值包含持久序号及不含正文的 envelope；来源禁用或配置改变会拒绝旧快照。`subscribeSourceChanges(listener)` 返回 disposer，通知只提示重新扫描，不携带执行权限。可选的 [assistant-goals](../assistant-goals/README.md) 使用此接口等待事件后恢复 owner 授权的原目标。

SQLite schema v4 为 outbox 增加持久单调序号，从 v3 原位迁移并保留已投递的 provenance 日志。序号高水位不因删除最高事件或 VACUUM 回退；没有来源证明的旧行不参与匹配。读取事件不消费、重定向或禁用已有 automation 投递。进程重启后的消费者从已保存快照扫描，不能仅依靠内存通知。

## 限制

单机 SQLite 语义，不承诺跨节点 exactly-once；下游调用是至少一次，但 stable event id 由 Automations 去重。单轮 flush 有有界工作量，超过上限的 due event 会在后续周期继续公平处理。首版没有 command sensor、redirect follow、任意 URL、payload-to-prompt 或公网监听器。

## 兼容性与参考

以 DSH `0.1.2-rc.1` 验证。设计借鉴 `dsh-sentinel@833a4e9` 的 baseline/edge/cooldown 与 fire-before-delivery watermark，但没有安装或复制其 JSONL、shell command、弱租约或 capability URL 设计。

`github-repository` 来源可显式设置 `deliveryMode: commit`，保留 `baseBranch` 作为授权范围元数据。此时只读取目标分支及其提交的 check-runs，不要求 PR 或 reviewer；拒绝 PR 编号与评审字段。省略 deliveryMode 保留原行为与旧配置摘要。重启后沿用持久序号，重复 CI 状态不重复产生事件。事件是唤醒信号，最终完成状态仍由绑定真实交付收据的独立验收决定。
