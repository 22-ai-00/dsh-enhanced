# @dsh-enhanced/plugin-control-plane

记录能力缺口与 ROI、匹配 owner 固定的 catalog，并在权威审批后执行可恢复的隔离激活。Agent 只能发现候选、记录缺口和创建计划；签名审批、profile 变更和 Host attestation CLI 都不会注册成模型工具。

## 安装

```sh
dsh plugin --profile web add @dsh-enhanced/plugin-control-plane
dsh --profile web --dump-config
```

插件服务读取配置中的 `catalogPath`、`statePath` 和 `trustPath`。owner CLI 固定从 `$DSH_HOME/plugin-control/trust.json` 读取信任配置；`--trust`、`--state`、`--dsh-home`、公钥、authority、key id、attestor path 等命令参数都会被拒绝。trust 文件必须是 canonical、owner-owned `0600` 普通文件，其目录必须是 owner-owned `0700`，不能经过符号链接。

推荐 trust schema v2：

```json
{
  "schemaVersion": 2,
  "installationId": "018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00",
  "dshHome": "/srv/dsh",
  "ledger": {
    "id": "018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01",
    "path": "/srv/dsh/plugin-control/plans/control.sqlite"
  },
  "executor": {
    "id": "dsh",
    "version": "0.1.0-rc.8",
    "path": "/usr/local/bin/dsh",
    "sha256": "64-hex",
    "environmentAllowlist": ["PATH"]
  },
  "hostPolicy": {
    "readinessMinimumChecks": 2,
    "effectBlockedMinimumDeliveryAttempts": 2,
    "effectBlockedMinimumToolExecutionAttempts": 2,
    "shadowMinimumSamples": 20,
    "shadowMaximumMismatches": 0,
    "canaryMinimumSamples": 5,
    "canaryMaximumFailures": 0,
    "soakMinimumWindowMs": 300000,
    "soakMinimumSamples": 50,
    "soakMaximumFailureRate": 0.01,
    "healthMinimumChecks": 3,
    "healthMaximumFailures": 0,
    "receiptTtlMs": 30000
  },
  "hostAttestor": {
    "id": "production-host-attestor",
    "version": "1.0.0",
    "path": "/usr/local/libexec/dsh-host-attestor",
    "sha256": "64-hex",
    "interpreter": null,
    "environmentAllowlist": [],
    "authority": "host-runtime",
    "keyId": "host-key-1",
    "timeoutMs": 60000
  },
  "approvalKeys": [
    { "authority": "owner-policy", "keyId": "owner-key-1", "publicKeyPem": "-----BEGIN PUBLIC KEY-----..." }
  ],
  "hostAttestationKeys": [
    { "authority": "host-runtime", "keyId": "host-key-1", "publicKeyPem": "-----BEGIN PUBLIC KEY-----..." }
  ]
}
```

`hostAttestor` 可以为 `null`。这种部署只能走人工 attestation，不会自签或自动越过任何 `awaiting-*` 状态。旧 trust schema v1 仍可读取，但被规范化成保守的默认 `hostPolicy` 且不配置可执行 attestor，因此也是 manual-only。

Control Plane 只保存 Ed25519 公钥，不读取、接收、生成或持有 Host attestation 私钥。

## 能力闭环

Agent 工具：

- `plugin_capability_gap`：用幂等键记录能力缺口、上下文、价值、频率、成本和风险。
- `plugin_gap_rankings`：读取按 ROI 排序的开放缺口。
- `plugin_discover`：只读匹配 owner-provided、完整性固定的 catalog。
- `plugin_activation_plan`：为一个精确 gap/candidate/profile 创建不可变、待审批计划，不安装任何内容。

计划、审批、phase operation、签名 receipt 和终态 receipt 都写入 owner-private SQLite。幂等键、revision CAS、activation id 和递增 fence 共同阻止旧 worker、ABA 和跨计划重放。

## 审批和 staging

审批系统针对 `show` 返回的精确 plan id/digest 生成 Ed25519 receipt，然后由 owner 应用：

```sh
dsh-plugin-control show --plan-id plugin-...
dsh-plugin-control approve --kind activation \
  --plan-id plugin-... --expected-revision 1 \
  --approval-receipt ./owner-receipt.json
dsh-plugin-control activate \
  --plan-id plugin-... --expected-revision 2
```

`activate` 只完成 staging：固定 DSH executable 的 canonical path、owner/root ownership、不可被 group/other 写入、inode 和 SHA-256；用无 shell 的 argv 安装 dossier 中精确 `package@version`；结构化核对 lockfile integrity；保留原 profile backup；最后停在 `awaiting-reload`。

## 固定 Host attestor 执行契约

配置 `hostAttestor` 后，每个 awaited phase 由 owner CLI 单步推进：

```sh
dsh-plugin-control probe \
  --plan-id plugin-... --expected-revision 4 --expected-fence 1
```

phase 不能从命令行指定，而是从 durable plan 状态推导。Control Plane 先提交唯一的 phase operation，再执行固定 executable：

1. 校验 canonical path、权限、owner/root ownership、单链接、inode 和 SHA-256。脚本还必须使用无参数的 canonical shebang，并在 trust 中固定 interpreter path/digest；native executable 的 `interpreter` 必须为 `null`。
2. 以严格 allowlist 环境、`shell: false` 调用 `--version`，结果必须等于 trust 中固定版本。
3. 以同样边界调用 `attest`，在 stdin 传入一个精确 JSON request；stdout 只能返回一个有界 JSON receipt，stderr 不回显。
4. 再次校验 executable inode 和 digest。
5. 使用 trust 中预注册的 Ed25519 公钥验证 receipt，并以 plan revision/fence CAS 应用。

request 固定：installation id、ledger id/path、plan id/digest、activation id/fence、profile name/path、attestor identity/path/digest/key、phase、phase requirements、receipt TTL，以及一个 durable operation id。外部 attestor 必须永久把 operation id 当幂等键：相同 id + 相同 request 重放同一 receipt；相同 id + 不同 request 必须拒绝。

phase operation 在子进程启动前持久化。子进程执行期间持有 SQLite 跨进程 writer mutex；成功 receipt 在释放 mutex 前持久化。因此并发 worker 不会创建第二个 canary exposure。若进程在 receipt 提交前崩溃，恢复 worker 使用相同 operation id 重试，依赖上述外部幂等契约取回同一结果。

## Phase proof，而不是命令标签

退出码、命令名称和 `--dump-config` 都不构成 phase 成功证据。v2 receipt 对完整的结构化 evidence 签名，并绑定 request digest：

- `reload`：前一代和新一代 Host generation、新 profile 的 reload 证明。
- `readiness`：实际检查数和失败数。
- `effect-blocked-replay`：delivery 尝试/拦截数、tool-execution 尝试/拦截数以及外部 effect 数；通过必须同时证明两类 effect 全部被拦截且 external effects 为零。
- `shadow`：样本数、mismatch 数和 external effects。
- `canary`：唯一 exposure id、严格一次 exposure、样本数和失败数。
- `soak`：明确的窗口起止、样本、失败数和 owner policy 的失败率阈值。
- `health`：实际健康检查数和失败数。

每类 evidence 还带有探针/回放/trace digest。Control Plane 验证签名、结构、请求绑定、TTL 和 policy 阈值；它不会假装自己能独立观察部署。真正的 reload、流量、effect interception 和健康观测由 owner/deployment-controlled attestor 实现，并由其私钥为声明负责。测试目录中的 fixture attestor 只用于真实子进程集成测试，不进入发布包，也不是生产探针。

任一有效签名 receipt 返回 `outcome: failed` 时，计划进入 fenced `rollback-pending` 并自动恢复原 profile；只有七个 phase 全部通过，backup 清理和终态 CAS 完成后才是 `activated`。格式错误、错误 key/digest/phase/evidence、过期 receipt 或未配置 attestor 都保持当前 awaiting 状态。

## 人工 Host attestation

未配置可执行 attestor，或部署需要人工控制时，先生成同一个 durable request：

```sh
dsh-plugin-control host-request \
  --plan-id plugin-... --expected-revision 4 --expected-fence 1 \
  > host-request.json
```

owner-controlled 外部系统执行 request、产生相同 v2 structured evidence 并签名。receipt 文件必须是私有普通文件，然后应用：

```sh
dsh-plugin-control attest \
  --plan-id plugin-... --expected-revision 4 --expected-fence 1 \
  --receipt ./host-receipt.json
```

人工路径使用相同 operation、evidence validator、Ed25519 verifier 和 CAS，不是弱化旁路。旧的 schema-v1 `evidenceDigest`-only Host receipt 会被拒绝，因为它不能证明 phase 语义。

## 源码能力 lane 和边界

`source-plan` / `scaffold` 只在 owner 审批的 linked、clean worktree 和固定 generator digest 上生成插件并运行 `pnpm check`，终态最多为 `ready-for-human-review`。

本包仍没有 Stage 4 的 PR 创建/合并 adapter、独立 signer、registry publish/verification adapter，也没有把产物转换成已发布 catalog candidate 的 builder/orchestrator。因此源码 lane 不会声称“已建 PR、已签名、已发布、已进入 registry 或已激活”；这些仍需外部系统和后续独立 activation plan。

## 权限

- 插件 Host service：读取 catalog/trust，写 owner-private SQLite/WAL；不使用网络、浏览器或子进程。
- owner CLI `activate`：读取/复制/rename/恢复 DSH profile，并执行固定 DSH executable。
- owner CLI `probe`：执行固定 Host attestor，只有严格 allowlist 环境；不读取 attestation 私钥，不使用 shell或网络客户端。
- owner CLI `scaffold`：仅在审批绑定的 linked worktree 中运行固定边界内的 `git` / `pnpm`。
- 本包没有 registry 搜索、包下载器、PR、签名或发布 adapter。

兼容性见仓库 [compatibility baseline](../../docs/compatibility.md)。Node.js 要求 `^22.19.0 || >=24.0.0`（使用 `node:sqlite`）。
