# npm 制品读取与现有 Control Plane 激活

本段补齐 WP16 的生产 registry 读取入口：已批准 catalog 中的精确 npm 包经过元数据和独立下载校验后，复用现有 DSH staging、descriptor 缓存及后续 Host attestation。完整 WP16 仍需要受授权的 build/sign/publish、有限启用、监测和回滚证据。

## 契约与来源

- npm 官方 [Registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md) 定义 `GET /{package}/{version}` 和 `dist.tarball`。客户端使用精确版本端点，限制响应大小，并核对返回的 name/version；不请求移动中的 tag。
- npm 的 [unpublish policy](https://docs.npmjs.com/policies/unpublish/) 规定包名与版本不能重复使用，但制品仍可能被移除。这里的版本固定不等于永久可下载；404 或网络失败会阻止本次 staging。
- 当前完整性信任来自 owner 已批准的 catalog SHA-512，而不是本次 registry 元数据。元数据中的 SRI 和实际 tarball 的 SHA-512 都必须与它相等。npm 的 [provenance statements](https://docs.npmjs.com/generating-provenance-statements/) 属于另一个验证契约，本客户端没有验证这些声明。

## 配置与生命周期

在现有 trust schema v3/v4 的 `releaseRegistry` 设置 `protocol: "npm"`；详见 [插件 README](../plugins/plugin-control-plane/README.md#从-npm-下载已批准制品)。没有增加模型工具、审批权限或插件循环。

读取使用同一 owner 绑定 HTTPS origin/path。token 只发送给该范围内经过验证的地址，不跟随重定向，不读取隐式 npm 配置。元数据与制品共享绝对期限；失败和取消会关闭 HTTP 请求与响应。下载完成后继续使用现有 activation fence、catalog integrity、缓存 inode 与 DSH lockfile 校验。

## 可复现的真实只读探针

```sh
pnpm --filter @dsh-enhanced/plugin-control-plane build
DSH_NPM_REGISTRY_LIVE=1 node scripts/e2e/npm-registry-readback.mjs \
  --output /tmp/dsh-npm-readback.json
```

探针从当前 HEAD 中已经提交的 `scripts/e2e/fixtures/npm-release-0.1.32.json` 提取 Control Plane 和 personal-memory 的预期 SRI，随后用生产下载器匿名访问公开 npm registry。记录实际字节数、SHA-256、SHA-512、运行代码摘要及错误预期摘要被拒绝的结果。输出必须是新文件；不下载并执行包代码，不安装或启用插件。

CLI 集成测试使用真实 loopback HTTPS 和已有 executor/Host 夹具，验证元数据 → 下载 → 缓存描述符 → `awaiting-reload`，以及摘要替换在调用 executor 之前被拒绝。网络单元测试覆盖请求范围、TLS、期限、取消和有界响应。夹具中的 staging 不是生产 Host 激活证据。

## 本次真实读取结果

2026-09-19 证据记录了两个历史已发布包的只读验证：Control Plane 195,256 字节，personal-memory 96,602 字节；两者实际 SHA-512 与先前已提交的发布记录一致。错误的预期摘要被拒绝。运行未持有 registry token，也没有执行发布、安装或启用。

验证入口为 `scripts/e2e/npm-registry-readback.mjs` 与 Control Plane 的 registry/CLI 测试；最新全仓门禁统一见 [RSI 当前状态](rsi-status.md)。历史原始日志和逐次运行数据保留本地。

## 发布协议边界

当前本地 release adapter 在独立 `publication.json` 中保存 owner 的 artifact statement/signature 摘要。npm 的标准 `dist` 元数据不承诺返回这个自定义记录；npm Sigstore 声明也不是现有契约要求的原始 Ed25519 签名。现有 [npm verifier](npm-release-verifier.md) 分开绑定两类证据：独立 owner 签名 receipt，以及 npm 元数据和下载字节。未知发布结果的 reconciliation 不能把请求中预期的 owner 签名摘要写成 npm 观测值。

相邻的 [publish](npm-publish-adapter.md) 与 [catalog admission](npm-catalog-admission.md) 组件已实现协议接线；真实授权发布和完整有限 Host 启用仍待验收，WP16/WP18 尚未完成。
