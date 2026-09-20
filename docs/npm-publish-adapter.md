# Owner-configured npm publication

The Control Plane bundle's `bin/dsh-npm-registry-adapter.js` now implements
the existing `publish` phase as well as its independent verifier role. It
uploads the signed, already built artifact using one bounded HTTPS PUT.
It uses the existing release operations, signatures, fences and reconciliation
states. It does not register a model tool.

## Owner configuration

On Linux, configure `releaseAdapters.publish` with a separate canonical copy
of the adapter, its SHA-256, pinned Node interpreter, independent publication
receipt key, timeout, and only `DSH_RELEASE_PUBLISH_CONFIG` in its environment
allowlist. Version remains `dsh-npm-registry-adapter-1`; the artifact input
contract remains `inherited-fd-v1`. The verifier must have a separate executable
identity, key, private configuration and state directory, as enforced by the
existing release trust contract.

The environment variable contains the canonical path to this owner-private
JSON configuration. Placeholders below are not runnable credentials:

```json
{
  "schemaVersion": 1,
  "id": "npm-publisher",
  "phase": "publish",
  "executablePath": "/owner/npm-publisher/adapter.js",
  "authority": "npm-publisher",
  "keyId": "npm-publisher-key",
  "privateKeyPath": "/owner/npm-publisher/receipt.key",
  "authorizationAuthority": {
    "authority": "release-owner",
    "keyId": "owner-key",
    "publicKeyPath": "/owner/npm-publisher/owner.pub"
  },
  "stateRoot": "/owner/npm-publisher/state",
  "registry": {
    "protocol": "npm",
    "id": "npm-public",
    "locator": "https://registry.npmjs.org/",
    "signer": {
      "authority": "artifact-signer",
      "keyId": "artifact-signer-key",
      "publicKeyPath": "/owner/npm-publisher/signer.pub"
    },
    "helper": {
      "path": "/owner/npm-publisher/npm-publish.js",
      "sha256": "<sha256 of shipped lib/npm-publish.js>"
    },
    "tokenPath": "/owner/npm-publisher/npm.token",
    "tag": "next",
    "caPins": [],
    "timeoutMs": 30000
  }
}
```

Use `0700` directories and `0600` config, key and token files. Paths must be
canonical, owner-controlled and free of symlinks or extra file hard links.
Pin the shipped helper's exact bytes; it is imported from its verified open
descriptor in the adapter process, with Node builtin imports only. The helper
shares that process's authority. The receipt key must differ from both the
artifact signer and authorization keys.

`tokenPath` holds a conventional npm Bearer token with the owner-authorized
publication scope. It is read only after artifact and payload validation;
its contents do not enter requests to the model, receipts or operation state.
The configuration digest binds the token path, registry, helper and tag to
the operation. It does not persist token contents. Empty `caPins` uses system
CA trust; a nonempty list supplies explicit CA certificates. No `.npmrc`,
ambient token, proxy, interactive OTP or OIDC flow is used.

## Exact artifact and dispatch contract

Before dispatch, the adapter revalidates the signed release authorization,
artifact signature, and inherited tarball/SBOM/provenance descriptors. A
bounded gzip/tar parser reads the unique `package/package.json`, validates
its authorized name/version and public status, and constructs npm's metadata
and base64 attachment. It never extracts the archive to disk or executes
package lifecycle scripts. The owner configuration chooses the public access
and explicit tag; manifest publication settings cannot redirect the request
or choose its tag. SHA-512 integrity, SHA-1 compatibility checksum and the
owner-authorized HTTPS tarball reference are recorded in the payload.

The protocol follows [fixed npm source research](research-npm-publish-adapter-2026-09-19.md),
with the deliberate constraint that `dist.tarball` stays the exact approved
HTTPS address. Scoped PUT endpoints retain npm's `@scope%2fname` spelling.
The subsequent verifier checks the address and bytes actually exposed by the
registry; a registry that rewrites the address must have its final canonical
address approved in the release policy.

The adapter persists a dispatch marker **before** opening the network request,
binding the operation, request digest, reference and payload hash. It issues
one PUT, without redirects or retries. A complete HTTP 200/201 response,
including an empty body, produces the existing signed publish receipt.
`immutable: true` uses the configured npm package/version identity contract;
the receipt acknowledges transport acceptance and does not independently
prove persisted bytes.

All other post-marker outcomes use `publish-ambiguity`. Replay returns the
same receipt; a marker without a receipt returns ambiguity without another
PUT. A changed request or configuration under the same operation is refused.
After a Host timeout or crash, retrying the same durable operation recovers
this observation, including after a stale process lock is reclaimed. The
marker must remain durable: deleting it or changing operation identity is not
a supported recovery procedure. An ambiguity is resolved only by the
independent [npm verifier](npm-release-verifier.md); `unknown` never authorizes
an automatic repeat publication.

## Authority, bounds and evidence

- Filesystem: reads private config, receipt key, public verification keys,
  token, pinned helper and inherited artifacts; writes operation bindings,
  dispatch markers, locks and signed receipts in its private state root.
- Network: one authenticated PUT to the configured HTTPS registry package
  endpoint. The separate verifier performs anonymous readback before
  [catalog admission](npm-catalog-admission.md).
- Execution: pinned adapter/Node only; no npm CLI, pack command, lifecycle
  scripts or helper child process. Host termination closes the active socket.
- Bounds: compressed and expanded tar each at most 256 MiB, manifest 1 MiB,
  JSON upload 384 MiB, response 2 MiB. A single deadline covers DNS, TLS,
  upload and response; it is capped at 120 seconds and remaining authorization.

Local TLS integration covers scoped upload, independent signed readback,
lost ACK reconciliation, receipt-loss recovery, cancellation/socket cleanup,
request/config drift and pre-dispatch signature/helper/token rejection. These
tests use disposable credentials and a controlled registry. They do not prove
a production npm write, real owner key custody or production Host activation.
WP16's authorized production release/enable/monitor/rollback and WP18's
cross-task improvement acceptance remain open.

The read-only preparation probe
checks historical `plugin-control-plane` and `personal-memory`
0.1.32 tarballs against integrity values in the [committed release fixture](../scripts/e2e/fixtures/npm-release-0.1.32.json).
Both parse and round-trip through the prepared npm attachment; the sender is
never called. Runtime digests identify the exact helper and probe bytes.
After building Control Plane, reproduce with:

```sh
DSH_NPM_PUBLISH_PREPARATION_LIVE=1 node scripts/e2e/npm-publish-preparation-readback.mjs --output /tmp/npm-preparation.json
```

Current delivery status and verification limits are maintained in [RSI status](rsi-status.md).
Raw repository gate logs and registry observations stay local or in CI artifacts.
