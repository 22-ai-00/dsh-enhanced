# npm source-release verifier

`plugins/plugin-control-plane/bin/dsh-npm-registry-adapter.js` implements the existing Control Plane `registry-verify` and `reconcile` adapter commands for anonymous npm HTTPS registries. It is shipped inside the independently installable Control Plane bundle. It adds no Agent tools or release state machine.

## Owner setup

Use Linux and the existing descriptor-pinned release adapter runner. Configure `releaseAdapters.registry-verify` with its own adapter path/hash, native Node interpreter path/hash, independent verifier authority/key, timeout, and the single environment allowlist entry `DSH_RELEASE_REGISTRY_VERIFY_CONFIG`. The adapter version is `dsh-npm-registry-adapter-1`; it declares the existing `inherited-fd-v1` artifact contract. The release trust registry must explicitly use `protocol: "npm"`.

The environment value points to an owner-private JSON file. The example below is a shape, not usable credentials or an authorization:

```json
{
  "schemaVersion": 1,
  "id": "npm-verifier",
  "phase": "registry-verify",
  "executablePath": "/owner/npm-verifier/adapter.js",
  "authority": "npm-verifier",
  "keyId": "npm-verifier-key",
  "privateKeyPath": "/owner/npm-verifier/verifier.key",
  "authorizationAuthority": {
    "authority": "release-owner",
    "keyId": "owner-key",
    "publicKeyPath": "/owner/npm-verifier/owner.pub"
  },
  "stateRoot": "/owner/npm-verifier/state",
  "registry": {
    "protocol": "npm",
    "id": "npm-public",
    "locator": "https://registry.npmjs.org/",
    "signer": {
      "authority": "artifact-signer",
      "keyId": "artifact-signer-key",
      "publicKeyPath": "/owner/npm-verifier/signer.pub"
    },
    "helper": {
      "path": "/owner/npm-verifier/registry-fetch.js",
      "sha256": "<sha256 of the shipped lib/registry-fetch.js bytes>"
    },
    "caPins": [],
    "timeoutMs": 30000
  }
}
```

Create private directories with mode `0700` and config/key files with mode `0600`. All paths must be canonical; files must be owner-controlled regular files without extra hard links. Copy the shipped `lib/registry-fetch.js` to the helper path and pin its digest. Its imports are Node builtins only. The adapter reads and hashes its open descriptor, imports those exact bytes in the verifier process, and rechecks the descriptor afterward. The helper shares the verifier's process authority; only owner-approved code may be pinned there.

The verifier key must differ from both the owner authorization key and the artifact signer key. Their public identities must also differ from the verifier identity. No artifact-signing private key is loaded. Registry id/locator and the precise tarball HTTPS reference must agree with the frozen owner release policy. Use a canonical locator including the trailing `/` for a registry root. Configuration/key/helper changes cannot reuse a cached operation under the old binding.

## Verification behavior

Normal `registry-verify` validates the owner release authorization, the owner artifact signature, and inherited tarball/SBOM/provenance descriptors before networking. It fetches exact npm package/version metadata and the referenced tarball, then compares downloaded length, SHA-256 and SHA-512 with the signed artifact. It signs the existing v1 release receipt and persists it under the existing operation identity.

`reconcile` accepts the existing v1 request and emits a **v2 reconciliation receipt**:

| Information | Evidence source |
| --- | --- |
| `expectedArtifactStatementDigest`, `expectedArtifactSignatureDigest` | Request-bound claims from the Control Plane's previously verified sign/publish chain |
| `metadataReference`, `metadataIntegrity` | Actual exact-version npm metadata |
| `registryReference`, `downloadedBytes`, `observedTarballSha256`, `observedTarballIntegrity` | Independently downloaded tarball |

The npm evidence kind is `npm-publish-reconciliation`; it has no `observedArtifactStatementDigest` or `observedArtifactSignatureDigest`. A complete coherent download yields `exists-match` or `digest-conflict`. A 404, transport/TLS failure, incomplete response or inconsistent metadata yields `unknown` with no claimed observation. A 404 cannot prove that an earlier in-flight publish has settled, so v2 deliberately cannot emit `absent` or authorize an automatic publish retry.

The existing Control Plane checks receipt signatures, request digest, owner binding, plan/revision/fence, publication ambiguity and TTL, then applies its existing state transitions. Old v1 receipts retain their local registry record semantics. Same-operation replay returns the same signed receipt; changed request/configuration is refused. Unknown receipts require a fresh existing reconciliation operation to observe again.

## Authority and lifetime

- Filesystem: reads owner-private configuration/keys, the pinned helper and inherited build descriptors; writes only private operation bindings, locks and receipts in `stateRoot`.
- Network: anonymous GETs to the configured HTTPS origin and path prefix. No redirects, cross-origin tarballs, `.npmrc`, ambient credentials, publish, install scripts or browser authority.
- Execution: the Host launches the pinned adapter and Node interpreter. The helper executes from verified bytes in that same process; there is no child helper to outlive Host termination.
- Bounds: metadata at most 2 MiB, tarball at most 256 MiB; one deadline across metadata and download, capped by configured timeout and remaining owner authorization. Host timeout closes the verifier's sockets. Persistent locks can be reclaimed only after their process is proven absent.

## Evidence and remaining work

Local tests exercise real TLS, both signed receipt protocols, altered authority/helper/configuration, receipt replay, lock failure/retry and Host timeout socket closure. Run `pnpm check` for the full repository gate.

The [engineering validation record](evidence/npm-release-verifier-engineering-2026-09-19.json) records the completed Linux repository gate, targeted checks and independent review separately from the live registry observations.

The [real npm readback record](evidence/npm-release-verifier-readback-2026-09-19.json) contains both signed receipt protocols for `@dsh-enhanced/plugin-control-plane@0.1.32`. Its 195,256 downloaded bytes match the SHA-512 in the earlier committed release record. The adapter independently fetched the real registry artifact for each verification; authorization, owner signature, auxiliary build files and ambiguous-publish history were explicit disposable fixtures. Public keys and full receipts are retained; private keys/state were removed.

Reproduce after building Control Plane:

```sh
DSH_NPM_VERIFIER_LIVE=1 node scripts/e2e/npm-release-verifier-readback.mjs --output /tmp/new-npm-verifier-evidence.json
```

This adapter supplies remote readback and signed verification. A production publish adapter, remote catalog admission, real owner key custody, finite Host enablement, monitoring and rollback remain separate WP16 work. This component does not establish a complete production release cycle or cross-task agent improvement.
