# npm publish adapter: protocol evidence and bounded integration

**Scope.** This note supports an owner-configured npm publish adapter for the
existing `plugin-control-plane` release flow.  It is not a release procedure
and no registry write was sent. Sources were checked on 2026-09-19 at this
repository commit `55079d2c5f7b42a1b378982fc288dc18a1f4c9ab`.

Implementation status: the publish adapter, independent registry readback,
release verifier, and catalog admission are now implemented. Use the current
[adapter guide](npm-publish-adapter.md), [readback protocol](npm-registry-readback.md),
[release verifier](npm-release-verifier.md), and [catalog admission](npm-catalog-admission.md).
The recommendation below records the original design; it is not an outstanding
implementation checklist or evidence of a real registry publication.

## Observed facts

### Publish wire operation

* npm CLI's `libnpmpublish` resolves `name@version`, chooses the registry by
  scope/configuration, and sends `PUT` to `spec.escapedName` with the complete
  metadata object as its JSON body.  It sets `ignoreBody: true` for this normal
  publish path.  See [publish.js, lines 31--75](https://github.com/npm/cli/blob/6400533ab3d830716964bcf0def42b6c47f3fd70/workspaces/libnpmpublish/lib/publish.js#L31-L75).
* Therefore the endpoint is `registryBase + spec.escapedName`.  The npm CLI
  source's selected `npm-package-arg` range is `^13.0.0`; the fixed published
  `npm-package-arg@13.0.0` implementation sets
  `escapedName = name.replace('/', '%2f')`.  Hence `@scope/name` is exactly
  `@scope%2fname`: the leading `@` remains literal and the slash uses lower
  case `%2f`.  Do not use `encodeURIComponent(fullName)`, path joining, or a
  decode/re-encode operation.  [npm-package-arg source, lines 186--191](https://unpkg.com/npm-package-arg@13.0.0/lib/npa.js).
* The same source builds a document containing `_id`, `name`, `description`,
  `access`, `versions[version]`, `dist-tags[tag] = version`, and
  `_attachments[tarballName]`.  The tarball attachment has
  `content_type: application/octet-stream`, base64 `data`, and byte `length`.
  In the version manifest it sets `_id: name@version`, `dist.integrity` to
  SHA-512 SRI, `dist.shasum` to SHA-1 hex, and `dist.tarball` from the registry
  base.  Precisely, the source computes `tarballName` by concatenating the
  complete manifest name, `-`, version, and `.tgz`; it computes `tarballURI`
  by concatenating the complete manifest name, `/-/`, and `tarballName`.  It
  does **not** strip a scope.  Thus the source literally uses scoped key
  `@scope/name-1.2.3.tgz` and URI
  `@scope/name/-/@scope/name-1.2.3.tgz`.  It then deliberately changes the
  generated `https:` URL string to `http:` in `manifest.dist.tarball` (source
  lines 124--125).  [Metadata construction, lines 103--143](https://github.com/npm/cli/blob/6400533ab3d830716964bcf0def42b6c47f3fd70/workspaces/libnpmpublish/lib/publish.js#L103-L143).
* npm's v11 command documentation independently says publication sends both a
  SHA-1 checksum and SHA-512 integrity, and that a pre-existing `(name,
  version)` fails; that pair cannot ever be reused, including after unpublish.
  [npm publish documentation, lines 55--62](https://github.com/npm/cli/blob/c029cb2e5e8b6b61d1a7fd8c454da51a52cd650c/docs/lib/content/commands/npm-publish.md#L55-L62).

### Existing release contract

* `SourceReleaseRequest` already has a `publish` phase bound to the signed
  tarball, SHA-256, SHA-512 integrity, package name/version, and authorization;
  successful evidence requires `immutable: true`.  See
  [`types.ts`](../plugins/plugin-control-plane/src/types.ts) (`SourceReleaseRequest`
  and `SourceReleaseSuccessEvidence`).
* It already separates an ambiguous result (`publish-ambiguity`) from failure
  and has a signed, independent reconciliation request/receipt.  Its npm
  reconciliation type requires a version metadata reference, metadata
  integrity, and independently downloaded tarball evidence.  See
  [`types.ts`](../plugins/plugin-control-plane/src/types.ts)
  (`SourceNpmPublishReconciliationEvidence`) and
  [`release.ts`](../plugins/plugin-control-plane/src/release.ts)
  (`Ed25519SourcePublishReconciliationAuthority`).
* The local adapter establishes the intended invariant: a pre-existing version
  is accepted only when the immutable publication record and artifact digest
  match; otherwise it errors; a deliberately lost acknowledgement is converted
  to `PublishAmbiguity`.  See
  [`dsh-local-release-adapter.js`](../plugins/plugin-control-plane/bin/dsh-local-release-adapter.js)
  (`publishPhase`, approximately lines 1109--1146).  This is local-registry
  behavior, not evidence about npm's remote implementation.

### Authentication, retries, redirects, and scripts

* `npm-registry-fetch@19.1.0` is published by npm with registry integrity
  `sha512-xyZLfs7TxPu/WKjHUs0jZOPinzBAI32kEUel6za0vH+JUTnFZ5zbHI1ZoGZRDm6oMjADtrli6FxtMlk/5ABPNw==`.
  Its [published source](https://unpkg.com/npm-registry-fetch@19.1.0/lib/index.js)
  obtains auth for the target URI before the request, passes retry policy to
  `make-fetch-happen`, and can retry an OTP response only when the caller
  supplies `otpPrompt`.  Its [auth source](https://unpkg.com/npm-registry-fetch@19.1.0/lib/auth.js)
  selects credentials by longest matching registry URI; its request headers
  use Bearer/Basic auth and optional `npm-otp`.
* The fetch wrapper delegates redirect behavior to `make-fetch-happen`; this
  note did not validate redirect forwarding semantics for a specific pinned
  transitive version.  An adapter that promises **no redirects and no retries**
  must implement and test that policy itself, and reject any 3xx before another
  request is made.  It must never infer that a timeout, reset, or connection
  close means the remote version is absent.
* The adapter should upload the already authorized, already built tarball by
  API.  It must not invoke `npm publish`, `pnpm publish`, `npm pack`, or any
  lifecycle script.  The existing build evidence explicitly records
  `npmConfigIgnoreScripts: true`, but that is build evidence rather than a
  remote-publish guarantee.
* npm's official OIDC trusted-publishing documentation requires npm CLI
  11.5.1+ and Node 22.14+, supports GitHub-hosted Actions, GitLab.com shared
  runners, and CircleCI Cloud, and does not support self-hosted runners.  It
  says OIDC applies to `npm publish`/`npm stage publish`, while other commands
  need conventional authentication.  [Trusted publishing with OIDC](https://docs.npmjs.com/trusted-publishers).
  The same document says direct publish can be disabled per trusted publisher.
  Thus a standalone custom HTTPS adapter cannot claim OIDC support merely by
  receiving an arbitrary environment token; require an explicitly configured,
  supported provider path and the official CLI exchange, or reject it.
* npm's 2FA documentation states that write actions can require a second
  factor and recognizes a granular token with bypass-2FA.  [About 2FA](https://docs.npmjs.com/about-two-factor-authentication).
  A non-interactive owner adapter must not solicit, persist, or synthesize OTP;
  a 401/OTP challenge is an owner-action-required error unless an approved
  owner credential mode is configured.

## Minimal implementation recommendation

Add an independent, owner-configured npm adapter only for the current
`publish` phase.  The request must be accepted only when its signed artifact
and owner authorization exactly bind the configured HTTPS registry base,
package name, version, and adapter identity. The owner-private configuration
fixes the dist-tag and token-file authentication; its digest is frozen with
the operation. Read the tarball bytes from the inherited, verified descriptors, recompute
SHA-256/SHA-512/SHA-1 before serializing the documented PUT JSON, then make one
bounded HTTPS PUT to the escaped package endpoint.

This is a constrained npm PUT adapter, not a byte-for-byte npm CLI clone.  Its
policy must use the owner-authorized HTTPS `expectedRegistryReference` as
`dist.tarball`, under the configured base, rather than copying npm CLI's HTTP
downgrade.  It must also use the owner-authorized dist-tag, rather than allowing
`manifest.tag` to override it.  The independent verifier must subsequently
read back the public registry's actual metadata URL and tarball URL/bytes;
the PUT acknowledgement does not prove either persisted reference or content.

Persist a dispatch marker before the socket is opened, keyed to the existing
operation id and request digest.  Do not send a second PUT for that operation.
A definitive HTTP success is only a transport acknowledgement; record the
existing successful publish evidence only when the adapter's configured
success contract is met.  Any missing ACK, timeout, TLS/socket error, 3xx,
409/version conflict, or response that cannot prove the preexisting version is
the same authorized artifact becomes the existing `publish-ambiguity` path.
Only the separate configured verifier may read package-version metadata,
download the tarball independently, and issue the existing reconciliation
receipt.  This uses the current state machine rather than adding another one.

The verifier should GET `registryBase + encodedPackageName + "/" + version`
using the exact URL convention already enforced by `release.ts`, validate that
metadata's `dist.integrity` equals the authorized SRI and that its tarball URL
remains under the owner-configured registry, then download the tarball with
redirects disabled, bounded size/time, and recompute both recorded digests.
It must return `exists-match`, `digest-conflict`, or `unknown`; it must not
return `absent` as permission to retry a dispatched remote publish.

## Must reject or report unknown

Reject: non-HTTPS registry; URL userinfo, query, fragment, or a base/metadata/
tarball URL outside the owner-configured base; noncanonical package or version;
missing/mismatched artifact bytes or digests; unsupported auth mode; private
manifest; unapproved tag; a scoped restricted-access mismatch; redirect; and
any request whose authorization/operation marker differs from the first send.

Report publish ambiguity (then independently reconcile): timeout, disconnect,
incomplete HTTP response, or any status other than 200/201. A complete empty
200/201 body is a valid transport ACK, matching npm's `ignoreBody` contract.
The verifier returns `unknown` for unparseable remote metadata, metadata/tarball retrieval
failure, metadata pointing outside the base, and any uncertain version-conflict
response. Report `digest-conflict` when independently observed tarball or
integrity differs. The publisher's `immutable: true` uses the configured npm
version-identity contract; the ACK does not prove persisted bytes. Independent
readback is still required before catalog admission.

## Verification boundary

The research used fixed npm CLI source/docs and published dependency source.
Protocol source review does not establish real registry publication; current
implementation checks and limits are recorded in the [adapter guide](npm-publish-adapter.md).
The original command transcript remains in Git history.
