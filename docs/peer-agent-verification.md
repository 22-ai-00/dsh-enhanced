# Peer agent 真实渠道验收与白名单配置

> 本页记录 2026-11-16 在 Linux 主机上完成的一次真实渠道验收：另一个飞书机器人（peer bot）在群里 @ 助手机器人，消息经 assistant-delivery 入站、在助手侧作为独立 peer principal 的会话中处理后，由助手应用把回复发回同一渠道。下面给出精确白名单的取得方法、配置项、校验步骤和已知限制。文中所有主机 IP、`app_id`、`chat_id`、`open_id` 与 `provider_message_id` 均以脱敏占位符表示；原始 ledger、部署标识与日志留在运行主机，仓库只保留可复现的字段与状态值。

## 结论摘要

- **peer bot 默认不可信**：入站消息带 `senderIsBot=true` 但不在 `peerAgents` 精确白名单中时，Delivery 直接判 `unauthorized-principal` 并进入 `dead_letter`。这是默认拒绝，不是配置错误。
- **白名单只解决「谁可以进来」**：命中白名单后还要通过 assistant-policy 的 `ingest` 授权；回复还要通过 `reply`/`send` 授权。两者是独立的两道门。
- **open_id 是应用作用域的**：对方 bot 在本应用下有自己的 open_id，与其他应用、其他租户或对方自己侧看到的 id 都不同；必须从本应用收到的 envelope 里取。
- **peer 是独立 Policy subject**：它被链接（`role=linked`）到当前 owner，但不继承 owner 的工具、记忆、WorkItem 反馈或续办通道，因此默认拿不到任何工具。
- 本次验收结果：inbox `processed`、attempt `processed` 且无 failure、outbox `accepted` 且 `provider_message_id` 可经飞书 API 读回，正文以 `B3_OK` 开头，助手应用还对该消息加了 `DONE` 表情回执。

## 环境与验收链路

| 项 | 值（部署标识已脱敏为占位符） |
| --- | --- |
| 主机 | 单台 Linux 验证主机（`<linux-host>`，不记录真实 IP 地址） |
| profile | `assistant`（组合 15 个插件） |
| 发起方 | peer bot（飞书 app `cli_<peer_app_id>`） |
| 群 | 验证群，`chat_id` `oc_<group_chat_id>` |
| 被 @ 的 bot | 助手机器人，bot open_id `ou_<assistant_bot_open_id>` |
| peer 身份（本应用作用域） | `{ channel: lark, account: primary, tenant: personal, user: ou_<peer_open_id> }` |

链路：peer bot 在群里 @ 助手机器人 → lark-channel 规范化并带 `senderIsBot=true` 交给 Delivery → Delivery 用 `peerAgents` 精确匹配 `envelope.principal` → Policy `ingest` 放行 → 助手在 peer 会话中处理 → Policy `reply` 放行 → outbox 经 lark-channel 发回群里。

首发失败时，inbox 记录为 `dead_letter`，`envelope_json.principal.user` 是上面那个 `ou_<peer_open_id>`；根因是 `peerAgents` 只登记了另一个 id，没有登记该 peer bot。注意 `ou_<peer_open_id>` 与 `ou_<assistant_bot_open_id>` 都是正确的：前者是对方 bot 在本应用作用域下的 open_id，后者是对方一侧 @ 本机器人时使用的 bot open_id；open_id 天然按应用隔离，两者不是同一作用域的值。

## 为什么 peer 需要精确白名单

1. **peer bot 不是 owner 的第二个身份。** 它由另一个 agent 持有，收到的是另一个系统的输出。Delivery 只有在完整元组 `(channel, account, tenant, user)` 逐字相等时才把该 bot 接纳为当前 owner 的 linked principal；没有 owner 时返回 `peer-owner-unavailable`，链接失败返回 `peer-principal-unavailable`。
2. **白名单是信任锚，`senderIsBot` 只是标签。** `senderIsBot` 由渠道适配器根据供应商事件填写，不能单独作为授权；真正的权威是配置里的精确元组。匹配对每条 bot 消息重新读取，因此在配置里删除条目后，对方的**下一条**消息立刻回到 `unauthorized-principal`，即使旧的 linked principal 行仍然存在。反过来，只要元组仍在白名单里，被撤销的 principal 会在下一条消息时按当前 owner 重新链接（reauthorize），不会被旧行永久卡住。
3. **peer 不继承 owner 能力。** 它保留独立 Policy subject（Agent subject 带 peer 的 canonical principal），owner 的工具、记忆、WorkItem 反馈与续办通道都不会因为「被链接」而自动获得；Policy 默认 `toolDefaultEffect: deny` 对它同样生效。
4. **精确元组不是正则。** 每个字段按字符串严格相等比较，不存在通配或前缀匹配；多个 peer 必须逐条列出，不能写 `user: '*'`。
5. **默认空。** `peerAgents` 未配置时没有任何 peer 被信任，这是安装后的预期安全状态。

## 取得 peer bot 在自己应用作用域下的 open_id

open_id 由应用（app_id）决定作用域，因此**唯一可靠的办法**是让本应用先真正收到一条对方 bot 的消息，再从 Delivery 的 inbox envelope 里读出它。不要用其他应用、其他租户或外部文档里的 open_id 代替，也不要让对方在自己应用里查一个 id 给你。

1. **确认本应用的身份四元组。** 读取目标 profile 的 `cordis.patch.yml`，确认 lark-channel 行的 `account` 与 `tenant`（本次为 `primary` / `personal`）；`channel` 固定为 `lark`。
2. **让对方 bot 发一条消息。** 用**对方的应用身份**在群里 @ 助手机器人。普通用户账号代发不算 bot 消息，`senderIsBot` 不会为 true。首条消息即使被拒也没关系：`dead_letter` 行同样保存 envelope，本次正是在失败记录里取到 open_id 的。
3. **在 Delivery 账本里读最近的入站。** 默认数据库是 `$DSH_HOME/assistant-delivery/state.sqlite`；若 profile 覆盖了 `databasePath`，以运行中配置的实际值为准（`dsh --profile assistant --dump-config | grep -n databasePath`）。以同一 OS 用户执行只读查询：

   ```sh
   DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
   DB="$DSH_HOME/assistant-delivery/state.sqlite"
   sqlite3 -readonly "$DB" "
   SELECT id, status, failure_code, attempt_count,
          json_extract(envelope_json,'$.principal.channel') AS channel,
          json_extract(envelope_json,'$.principal.account') AS account,
          json_extract(envelope_json,'$.principal.tenant')  AS tenant,
          json_extract(envelope_json,'$.principal.user')    AS user,
          json_extract(envelope_json,'$.metadata.senderIsBot') AS sender_is_bot
   FROM inbox_messages
   ORDER BY received_at DESC LIMIT 10;"
   ```

   没有 `sqlite3` 时可用同一 DSH 运行时的 Node（`node:sqlite`，DSH 要求 Node 22.19+ 或 24+）；只执行 SELECT，不要用写连接做迁移：

   ```sh
   DB="$DB" node --input-type=module -e '
   import { DatabaseSync } from "node:sqlite";
   const db = new DatabaseSync(process.env.DB, { readOnly: true });
   for (const row of db.prepare(`SELECT id, status, failure_code,
       json_extract(envelope_json, "$.principal.account") AS account,
       json_extract(envelope_json, "$.principal.tenant")  AS tenant,
       json_extract(envelope_json, "$.principal.user")    AS user,
       json_extract(envelope_json, "$.metadata.senderIsBot") AS sender_is_bot
     FROM inbox_messages ORDER BY received_at DESC LIMIT 10`).all()) console.log(row);
   '
   ```

4. **取 `principal.user`，并核对其余三项。** 从首发 `dead_letter` 记录中读到本应用作用域的 `user: ou_<peer_open_id>`，`sender_is_bot=true`，`channel/account/tenant` 与配置一致。四项一起才是白名单元组；只抄 `user` 而写错 account/tenant 同样不匹配。
5. **重新取值的时机。** 对方换应用（app_id）、换租户，或本应用换 app_id/租户后，open_id 会变；必须重新触发一条消息并从 envelope 重新读取。升级或迁移后不要沿用旧 id。

## 需要改哪些配置项

所有改动都在目标 profile 的 `cordis.patch.yml`（默认 `$DSH_HOME/profiles/assistant/cordis.patch.yml`），不修改插件源码。改前先备份并确认承载配置的行 id：

```sh
PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/assistant/cordis.patch.yml"
cp -a "$PROFILE" "$PROFILE.bak-peer-agents"
grep -n "dsh-ray-assistant-delivery\|dsh-ray-assistant-policy\|dsh-ray-personal-assistant\|dsh-ray-lark-channel" "$PROFILE"
```

### 1) Delivery：登记精确 peer 元组

在 `dsh-ray-assistant-delivery` 行的 `config` 中增加 `peerAgents`（既有字段保持不变）：

```yaml
- id: dsh-ray-assistant-delivery
  name: '@dsh-ray/assistant-delivery'
  inject:
    - assistantPolicy
  config:
    # …既有 databasePath/defaultWorkspace/defaultAgentPreset 等保持不变…
    peerAgents:
      - channel: lark
        account: primary        # lark-channel 配置的 account
        tenant: personal        # lark-channel 配置的 tenant
        user: ou_<peer_open_id>   # 从 inbox envelope 读到的 open_id
```

| 字段 | 来源 |
| --- | --- |
| `channel` | 渠道 id；飞书为 `lark` |
| `account` | lark-channel 配置的 `account`（本次 `primary`） |
| `tenant` | lark-channel 配置的 `tenant`（本次 `personal`） |
| `user` | 对方 bot 在本应用作用域下的 open_id（`envelope.principal.user`） |

### 2) Policy：两条 allow 规则

规则写在当前 profile 实际承载 Policy 配置的位置：若安装了独立的 `dsh-ray-assistant-policy` 行，写在它的 `config.rules`；若由 `dsh-ray-personal-assistant` meta-bundle 组合，写在它的 `config.assistantPolicy.rules`。不要两处同时维护同一组规则。

```yaml
rules:
  # 门 1：允许该 external principal 的入站消息进入 Inbox
  - id: lark-peer-agent-ingest-example
    effect: allow
    subject:
      kind: external
      id: "lark/primary/personal/ou_<peer_open_id>"
    actions: [ingest]
    resource: { kind: message, id: '*' }
    context: { initiators: [external] }

  # 门 2：允许该 peer 会话（preset + 绝对 workspace + 该 principal）回写渠道
  - id: lark-peer-agent-reply-example
    effect: allow
    subject:
      kind: agent
      id: standard                                   # 与 defaultAgentPreset 一致
      workspace: /absolute/path/to/assistant-workspace
      principal: "lark/primary/personal/ou_<peer_open_id>"
    actions: [reply, send]
    resource: { kind: message, id: '*' }
    context: { initiators: [external] }
```

| 规则 | 决定什么 | 缺少时的现象 |
| --- | --- | --- |
| `lark-peer-agent-ingest-example` | 已通过 `peerAgents` 并链接的 peer principal 能否把入站消息送入 Inbox（Policy `ingest` 门） | 消息仍进 `dead_letter`，`failure_code` 为 `policy-<reasonCode>` |
| `lark-peer-agent-reply-example` | 该 peer 会话的 Agent 能否在 external initiator 下把最终回复与出站发送写回渠道（`reply`/`send` 门） | 入站可能已处理，但回复在 Policy 层被拒、发不到渠道 |

三条硬对齐：`workspace` 必须是**绝对路径**且与 binding 的实际 workspace 完全一致（默认 `!!js dshHomePath('assistant-workspace')`，也可直接写展开后的绝对路径）；`id` 必须等于 `defaultAgentPreset`（默认 `standard`）；`principal` 必须是 `lark/<account>/<tenant>/<user>` 的 canonical 形式，与 `peerAgents` 及 envelope 完全一致。

## 校验与重启

1. **配置组合校验（不启动 Host，重启前后均可执行）**：

   ```sh
   dsh --profile assistant --dump-config > /tmp/assistant-config.yml; echo "rc=$?"
   grep -n "peerAgents\|lark-peer-agent-ingest-example\|lark-peer-agent-reply-example" /tmp/assistant-config.yml
   ```

   本次验收在重启后执行 `dsh --profile assistant --dump-config` 得到 **rc=0**，说明 profile 组合与字段校验通过。rc 非 0 时先按报错修 YAML，不要带错重启。

2. **重启 profile 服务**（同一 profile/Home 只能有一个 Host，避免前台与常驻服务并存抢 Web 端口和飞书长连接）：

   ```sh
   dsh-ray restart --profile assistant
   # 或等价的 systemd user 服务
   systemctl --user restart dsh-profile-assistant.service
   ```

3. **确认服务与连接**：`dsh-ray status` 查看 profile 与服务状态；`dsh-ray logs --profile assistant`（必要时 `--errors-only`）确认 lark-channel 重新连接、没有配置校验错误。本次验收在重启后 `dump-config` rc=0，lark-channel 重连成功。

4. **确认 peer 已被链接为独立 principal**（对方下一条消息到达后）：

   ```sh
   sqlite3 -readonly "$DB" "
   SELECT id, role, status, linked_to_id, principal_json
   FROM delivery_principals ORDER BY created_at DESC LIMIT 5;"
   ```

   应能看到该 peer 元组的 `role=linked`、`status=active`、`linked_to_id` 指向当前 owner 的 principal 行。若只有 `role=owner` 的行、没有该元组的 linked 行，说明白名单没有命中（回到四元组核对）。

5. **复验必须用一条新消息。** 同一 `event_id` 重复投递会命中 Delivery 的幂等去重并返回原来的 `dead_letter` 记录，不会因为改了配置就重判；请让对方**重新发一条**消息。Host 侧另有受信的 dead-letter resolution 控制面 API（不是模型工具），但常规验证推荐直接发新消息。

6. **读回复并回读渠道**：

   ```sh
   sqlite3 -readonly "$DB" "
   SELECT id, status, provider_message_id, failure_code, created_at
   FROM outbox_messages ORDER BY created_at DESC LIMIT 5;"
   ```

   本次复验：inbox `processed`；`inbox_attempts.status=processed` 且 `failure_code` 为空；outbox `status=accepted`、`provider_message_id=om_<provider_message_id>`；用飞书 OpenAPI（`im/v1/messages/{message_id}` 读消息内容）可读回同一条消息，正文以 `B3_OK` 开头；助手应用另加 `DONE` 表情回执。

## 验收证据快照

本次为真实渠道验收，原始数据库、日志与截图留在运行主机（按仓库约定放在 ignored 的 `docs/evidence/` 或 CI artifacts，不入库）。仓库内只记录可核对的表名、字段名与脱敏状态值：

| 环节 | 账本 / 接口 | 字段 | 观测值 |
| --- | --- | --- | --- |
| 首发被拒 | `inbox_messages` | `status` / `failure_code` | `dead_letter` / `unauthorized-principal` |
| 首发 principal | `inbox_messages` | `envelope_json.principal` | `{channel: lark, account: primary, tenant: personal, user: ou_<peer_open_id>}` |
| 修复后入站 | `inbox_messages` | `status` | `processed` |
| 入站尝试 | `inbox_attempts` | `status` / `failure_code` | `processed` / 空（无失败） |
| 出站 | `outbox_messages` | `status` / `provider_message_id` | `accepted` / `om_<provider_message_id>` |
| 渠道读回 | 飞书 OpenAPI | 消息正文 | 可按 `provider_message_id` 读回，以 `B3_OK` 开头 |
| 渠道回执 | 飞书 reaction | `emoji_type` | `DONE`（由助手应用添加） |

关键状态值（来自 Delivery schema）：`inbox_messages.status ∈ received/authorized/queued/claimed/processed/retry_wait/dead_letter`；`inbox_attempts.status ∈ claimed/processed/retry_wait/dead_letter/lost`；`outbox_messages.status ∈ pending/attempting/accepted/delivered/read/retry_wait/dead/unknown_after_send`。`accepted` 表示供应商已接受该次发送；这是本次验收使用的成功判据。

## 已知限制与下一步

本次 peer 会话最初没有任何可用工具：`bash`、`read`、`glob`、`assistant_health`、`delivery_status`、`memory_search` 全部 default-deny；`delivery_reply` 工具也被拒绝。会话本身的最终回复仍然到达渠道，因为回复走 Delivery 的 `reply` 授权路径，不依赖 `delivery_reply` 工具。

这是「peer 不继承 owner 能力」的设计结果，不是回归：peer 的入站与回复各有一条窄规则，而工具执行默认没有任何规则。

### 已验证的最小只读授权（2026-11-16 完成）

按「一次只放开一个只读能力 + 真实复验」的方式追加了四条规则：

| 规则 id | actions | resource | 作用 |
| --- | --- | --- | --- |
| `lark-peer-agent-tool-assistant-health-example` | `execute` | `{ kind: tool, id: assistant_health }` | 工具层允许调用 |
| `lark-peer-agent-health-inspect-example` | `inspect` | `{ kind: tool, id: assistant-health }` | assistant-health 内层 `authorizeAgent(agent, 'inspect', …)` |
| `lark-peer-agent-tool-delivery-status-example` | `execute` | `{ kind: tool, id: delivery_status }` | 工具层允许调用 |
| `lark-peer-agent-delivery-history-example` | `history` | `{ kind: message, id: "*" }` | assistant-delivery 内层 `authorizeAgent(agent, 'history', …)` |

**关键点：工具可见 ≠ 可执行。** 只有工具层 `execute` 规则时，插件自己的内层策略仍会拒绝，表现为 `assistant-health policy denied report: default-deny` 或 `assistant-delivery policy denied operation: default-deny`；必须同时放开该插件使用的动作（health 用 `inspect`，delivery 用 `history`）。

复验证据（同日、由新消息触发）：

- 两次工具调用都成功，无授权拒绝。
- 健康摘要：`ready: true`、`severity: degraded`（7 项降级，含 automations 熔断与失败运行、delivery 死信、wiki lint、goals 执行禁用）；缺失组件 `eventTriggers`、`pluginControlPlane`、`assistantVerifier`。
- 渠道状态：`larkChannel` `ready` / `connected` / `gapGeneration: 0`。

**仍未放开**：`bash`、`read`、`glob`、`grep` 等文件系统与执行工具，`memory_search` 等跨主体记忆工具，以及 `delivery_reply` 这类额外出站能力。需要时按同样的「一次一个工具、单独验收」方式追加，不要给 `*` 或复用 owner 的通用前台规则。

## 安全边界

- **peer 是独立 Policy subject，不是 owner。** linked 只表示它被当前 owner 接纳到自己的会话通道，不会让它成为第二个 owner，也不会继承 owner 的工具、记忆、WorkItem 反馈或续办通道。
- **两道门都不可省。** `peerAgents` 白名单决定「谁可以进来」，Policy `ingest`/`reply` 决定「进来后能做什么」；只配一处会分别表现为 `unauthorized-principal` 或 `policy-<reasonCode>`。deny 始终优先于 allow。
- **白名单是精确四元组。** `(channel, account, tenant, user)` 逐字段严格相等，不是正则、不是前缀，也不接受通配；需要多个 peer 时逐条列出。删除条目在下一条消息即生效；只要元组仍在白名单里，被撤销的 principal 会在下一条消息时按当前 owner 重新链接（reauthorize）。
- **open_id 是应用作用域的。** 不要用别的应用查到的 id 代替；换 app_id/租户后必须重新从 envelope 取值。`envelope.principal.user` 才是本应用视角下的权威 id。
- **peer 入站是外部输入。** 即使已白名单，peer 的正文仍可能包含 prompt injection，不能当作 owner 指令；本次只授予 `ingest` 与 `reply/send`，工具默认全部 deny 是正确的起点。
- **不要在仓库里写部署私密值。** `peerAgents` 的 open_id 与 chat_id 属于部署标识，不是密钥，但同样只存在于运行主机的 profile；凭据与 App Secret 按既有约定走 Keychain/受保护文件，不进入 profile 或文档。

## 排障速查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `dead_letter` + `unauthorized-principal` | 四元组未命中：account/tenant 写错、用了别的应用作用域的 open_id、`senderIsBot` 不是 true、配置未重启生效 | 用本页 SQL 重读 envelope 四字段，逐字比对；发一条新消息复验 |
| `dead_letter` + `peer-owner-unavailable` | 当前 Home 尚无 active owner | 先完成 owner 配对，再让 peer 发消息 |
| `dead_letter` + `peer-principal-unavailable` | linked principal 准入失败（如旧行被撤销/不一致） | 核对 `delivery_principals`；保留白名单并让新消息触发重新链接，或按 Host 控制面显式重新授权 |
| `dead_letter` + `policy-<reasonCode>` | 缺 `ingest` 规则，或 external subject id / initiator 不匹配 | 检查 `lark-peer-agent-ingest-example` 的 subject 与 `context.initiators: [external]` |
| inbox `processed` 但渠道没回复 | 缺 `reply`/`send` 授权，或 agent subject 的 preset/绝对 workspace/principal 与 binding 不一致 | 核对 `lark-peer-agent-reply-example` 三个字段；看 Policy 拒绝原因 |
| outbox `accepted` 但人没看到 | 消息已由供应商接受，可能是群权限/可见性问题 | 用 `provider_message_id` 经飞书 API 读回确认正文与目标会话 |
| 重投同一事件仍是被拒 | 同一 `event_id` 幂等返回旧记录，不会重判 | 让对方重新发一条新消息复验 |

## 相关文档

- [assistant-delivery](../plugins/assistant-delivery/README.md)：`peerAgents` 配置、Inbox/Outbox 语义与 Policy 最小示例。
- [assistant-policy](../plugins/assistant-policy/README.md)：规则字段、allow/deny 优先级与三档审批。
- [飞书接入](../plugins/lark-channel/docs/setup.md)：lark-channel 的 account/tenant、凭据与常驻服务。
- [RSI 当前状态](rsi-status.md)、[验收合同](rsi-acceptance.md)、[兼容性基线](compatibility.md)。
