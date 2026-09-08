# Skill comparison profiles

`skill_compare` executes the current parent and a pending candidate using the same configured inputs, initial files, limits and artifact checks. It calls the native DSH read/write/edit tools in fresh private workspaces, then executes each produced artifact through `IsolatedVerifierRunner`. Expected output stays in the Host; candidate programs receive only their artifact and the current test input. The calling Agent's ordinary workspace is neither mounted into the container nor modified by replay.

Install `assistant-skills`, `assistant-evaluation` and `assistant-isolation` packages in the profile. Importing the latter two libraries does not require activating their services. The comparator owns a separate finite verifier runner; it does not borrow a model's general shell authority or start another AgentLoop. Native file-tool libraries travel with the Skills bundle and are registered only in the private replay Context.

Add an operator-authored entry to `assistant-skills.comparisons`. All fields below are required. Replace owner identifiers, paths, expiry and image with the actual deployment values. `stateRoot` must be private, owned, canonical and outside the owner's workspace; roots must not contain each other. The immutable image must already exist locally, have a working `/bin/sh` and `/bin/busybox`, contain the configured interpreter, and declare no Docker volumes. The runner never pulls an image.

```yaml
comparisons:
  - id: summary-quality
    version: 1
    scope:
      principalId: web/web/local/operator
      principalRecordId: ACTUAL_OWNER_RECORD_ID
      principalVersion: 1
      workspace: /home/operator/projects/orders
      preset: standard
    stateRoot: /home/operator/private/summary-comparison
    image: sha256:ACTUAL_INSTALLED_IMAGE_DIGEST
    dockerPath: /usr/bin/docker
    command: /bin/busybox cp /workspace/artifact /workspace/program.mjs && /usr/local/bin/node /workspace/program.mjs < /workspace/input
    artifactPath: summarize.mjs
    expiresAt: 1788998400000
    maxComparisons: 3
    repeats: 2
    cellDurationMs: 30000
    verificationDurationMs: 10000
    maxToolCalls: 8
    maxBytes: 65536
    maxOutputBytes: 16384
    minimumEvaluationGain: 0.1
    cases:
      - id: ordinary-order
        kind: replay
        inputs: {}
        files: []
        stdin: '[{"currency":"USD","amountCents":100}]'
        expectedStdout: "{\"USD\":100}\n"
        expectedExitCode: 0
      - id: negative-amount
        kind: evaluation
        inputs: {}
        files: []
        stdin: '[{"currency":"EUR","amountCents":-25}]'
        expectedStdout: "{\"EUR\":-25}\n"
        expectedExitCode: 0
      - id: empty-orders
        kind: regression
        inputs: {}
        files: []
        stdin: '[]'
        expectedStdout: "{}\n"
        expectedExitCode: 0
```

Use a future `expiresAt` appropriate for the finite experiment; the example is not a standing authorization. A profile supports 3–12 distinct cases covering replay, evaluation and regression, and 2–4 repeats. The benchmark alternates arm order and shares the same case seed. Replay makes zero model calls; its token and model-cost metrics are zero, not an estimate of model reasoning quality. Tool calls, wall time, input/workspace bytes and isolated execution/output limits remain bounded. Infrastructure, storage and developer costs are not included in the zero model-cost metric.

`inputs` contains only declared skill parameters; `files` provides bounded initial text snapshots as `{path, content}`. Both arms receive the same values. File paths must be relative without traversal, or inside the workflow's original source workspace; source paths are rebased into the private temporary workspace. The comparator supports fixed read/write/edit traces. Other tools, escalation arguments, external paths and oversized inputs are rejected; it does not silently reinterpret an arbitrary workflow as a file workflow. Initial snapshots are operator supplied; their historical provenance is not automatically attested.

Policy must explicitly permit `compare` on `{kind: evolution, id: verified-workflows}` for the authenticated owner/workspace/preset. The tool also requires the current owner human request. Ask for `skill_compare` with `candidate_id`, `profile_id` and a stable `invocation_id`. `skill_comparison_status` lists profile summaries, or reads an exact `comparison_id`; it excludes profile inputs, expected answers and raw verification output.

Attempts are reserved in the existing private Skills SQLite store. A profile's count spans sessions and profile digest changes within the same owner scope. Failures consume their reservation. Repeated invocation keys read back the same record; identity changes under a key fail. Interrupted comparisons recover as unknown and never replay automatically. Each scope has at most one running comparison. Owner, Policy, candidate expiry and parent version are rechecked throughout execution; cancellation waits for actual resource settlement before the Host closes its journal.

A `complete` comparison means observations are complete, not that the candidate is better. Quality fields separately report all candidate checks, evaluation success-rate difference and critical regressions. Paired observations and bootstrap statistics come from the existing Evaluation benchmark implementation; repeated deterministic trials are not independent tasks. The report always sets `promotionAuthorized: false` and `heldoutIndependence: unproven`. A Host-attested plan may add a binding digest to the receipt, but this repository has no production provider for it; that field is not evidence of OS sealing, historical independence, or model inaccessibility. Cases are kept out of replay workers and tool responses, but the calling Host Agent may have broader filesystem authority. Automatic promotion still requires an independently established boundary, independent held-out gains and a separately authorized deployment transition. Owner-requested activation after a fresh Goal trial remains a separate operation.
