# npm artifact admission into an owner catalog

The existing local release adapter can admit an independently verified npm artifact into the owner catalog. This connects npm verification to the existing source-release candidate and activation paths. It adds no agent loop, model tool, publication or automatic activation.

## Owner configuration

Use `dsh-local-release-adapter.js` for the existing `catalog-admission` phase, installed at its own canonical executable path with its own id, state directory and Ed25519 receipt key. Keep the existing owner authorization and the independent `registryVerifier` public identity. The npm verifier remains `dsh-npm-registry-adapter-1`; catalog uses `dsh-local-release-adapter-1`.

For this phase only, replace the local registry configuration with:

```json
{
  "registry": {
    "protocol": "npm",
    "id": "npm-public",
    "locator": "https://registry.npmjs.org/",
    "signer": {
      "authority": "artifact-signer",
      "keyId": "artifact-key",
      "publicKeyPath": "/owner/catalog/signer.pub"
    }
  },
  "catalog": {
    "id": "owner-catalog",
    "path": "/owner/catalog/data/catalog.json",
    "helper": {
      "path": "/owner/catalog/code/catalog.js",
      "sha256": "<digest of shipped lib/catalog.js>"
    },
    "interpreterModule": {
      "path": "/owner/catalog/code/catalog-interpreter.js",
      "sha256": "<digest of shipped lib/catalog-interpreter.js>"
    }
  }
}
```

These are fragments of the existing phase-specific private configuration, supplied through the allowlisted `DSH_RELEASE_CATALOG_ADMISSION_CONFIG`. Use owner-private directories and keys/configuration (`0700`/`0600`), canonical paths and regular single-link files. Keep catalog/journal storage separate from immutable artifact/SBOM/provenance directories: the artifact runner also fences their parent directory metadata. No registry token, local registry root or download root is needed by catalog admission.

The catalog signing key must differ from the owner, artifact signer and npm verifier keys. The adapter revalidates the original owner authorization, artifact signature and inherited artifact descriptors, plus the verifier's signed request/receipt binding, revision, release fence, validity interval and exact artifact/reference. A reconciliation receipt cannot substitute for the normal v1 registry-verification receipt; the existing state machine prepares that verification first.

## Commit and activation

The source policy, published reference, verifier receipt and catalog entry share the same canonical HTTPS tarball URL. The URL must be under the authorized registry origin and base path. Admission preserves the existing request-bound before/after digest CAS, durable journals, exact replay and conflict handling.

Both shipped helper modules are opened and hashed, then loaded from those exact bytes in the adapter process. The sole relative dependency is bound to its separately pinned module bytes. The existing catalog helper still uses the fixed root-owned Python interpreter and bounded subprocess calls for kernel locks and atomic file exchange on Linux. A submitted catalog exchange can settle even if the caller loses its reply; use the existing operation and journal recovery, not a new admission identity or a claim that cancellation undid a write.

After release completion, the existing `activation-plan` and `activate` commands consume the admitted entry. Activation downloads exact-version npm metadata and bytes through the owner-bound trust configuration. For an exact HTTPS catalog reference, a different tarball URL is rejected even if the bytes have the same SHA-512. Accepted bytes continue through the existing descriptor cache, DSH staging and Host attestation gates. Historical HTTPS catalog entries whose reference is `package@version` retain their existing digest-based behavior; local file entries retain their existing path rules.

## Verification

The adapter integration tests join a real loopback TLS npm download, signed verification, catalog admission, independent receipt checking and replay. CLI tests verify exact-address staging and refusal of same-digest address substitution before executor invocation. Existing catalog crash/CAS tests remain the authority for the underlying journal mechanism.

The engineering validation record records the completed Linux repository gate, focused checks, package contents, independent review and preceding commit's cross-platform CI.

After building Control Plane, the following probe reads a historical published package from real npm and admits it into a disposable local catalog:

```sh
DSH_NPM_CATALOG_LIVE=1 node scripts/e2e/npm-catalog-admission-readback.mjs --output /tmp/npm-catalog-evidence.json
```

The probe retains public keys, requests, receipts, the observed catalog and runtime digests, then removes its private keys and temporary state. Its authorization, artifact statement and build auxiliaries are fixtures; it does not prove a real approved source build or publish. No production catalog, Host activation, monitoring or rollback is exercised. WP16 and WP18 still require their complete authorized external workflows.

The 2026-09-19 readback passed against the historical `@dsh-enhanced/plugin-control-plane@0.1.32` artifact (195,256 bytes). The npm receipt and catalog receipt were both checked by the production Ed25519 authorities, and the catalog's independently reread digest matched the authorized after-state. Replaying the same operation returned the same receipt. This is a real registry read followed by a disposable local catalog admission, with the fixture limits above.
