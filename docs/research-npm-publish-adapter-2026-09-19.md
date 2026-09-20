# npm publish adapter: protocol evidence and bounded integration

**Scope.** This note supports an owner-configured npm publish adapter for the
existing `plugin-control-plane` release flow.  It is not a release procedure
and no registry write was sent. Sources were checked on 2026-09-19 at this
repository commit `55079d2c5f7b42a1b378982fc288dc18a1f4c9ab`.

Implementation status: the publish adapter, independent registry readback,
release verifier, and catalog admission are now implemented. Use the current
[adapter guide](npm-publish-adapter.md), [readback protocol](npm-registry-readback.md),
[release verifier](npm-release-verifier.md), and [catalog admission](npm-catalog-admission.md).
This note retains protocol sources and design rationale; it is not an
outstanding implementation checklist or evidence of a real registry publication.

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

## Implemented contract

The original implementation plan and rejection checklist have been superseded
by the maintained [publication contract](npm-publish-adapter.md#exact-artifact-and-dispatch-contract)
and [independent verification guide](npm-release-verifier.md). They define
artifact validation, the single dispatch marker, ambiguous outcomes, and
registry readback. Use those guides when changing or deploying the adapter;
Git history retains the original proposal.

## Verification boundary

The research used fixed npm CLI source/docs and published dependency source.
Protocol source review does not establish real registry publication; current
implementation checks and limits are recorded in the [adapter guide](npm-publish-adapter.md).
The original command transcript remains in Git history.
