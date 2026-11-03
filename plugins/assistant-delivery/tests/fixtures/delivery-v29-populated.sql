-- Genuine populated v29 schema/rows emitted by 1e48dccceaf48697604def4f0f7b7db3f09ab8aa DeliveryStore and sqlite.ts.
CREATE TABLE approval_dispatch_cursor (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    after_created_at INTEGER CHECK (after_created_at IS NULL OR after_created_at >= 0),
    after_proposal_id TEXT,
    version INTEGER NOT NULL CHECK (version >= 1),
    updated_at INTEGER NOT NULL,
    CHECK ((after_created_at IS NULL) = (after_proposal_id IS NULL))
  ) STRICT;
CREATE TABLE approval_outbox_routes (
    outbox_id TEXT PRIMARY KEY,
    route_version INTEGER NOT NULL CHECK (route_version = 2),
    source_id TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    binding_version INTEGER NOT NULL CHECK (binding_version >= 1),
    binding_generation INTEGER NOT NULL CHECK (binding_generation >= 1),
    workspace TEXT NOT NULL,
    principal TEXT NOT NULL,
    principal_record_id TEXT NOT NULL,
    principal_version INTEGER NOT NULL CHECK (principal_version >= 1),
    FOREIGN KEY (outbox_id) REFERENCES outbox_messages(id) ON DELETE CASCADE,
    FOREIGN KEY (binding_id) REFERENCES conversation_bindings(id),
    FOREIGN KEY (principal_record_id) REFERENCES delivery_principals(id)
  ) STRICT;
CREATE TABLE approval_settlements (
      operation_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
CREATE TABLE conversation_bindings (
      id TEXT PRIMARY KEY,
      conversation_hash TEXT NOT NULL,
      conversation_json TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      principal_json TEXT NOT NULL,
      workspace TEXT NOT NULL,
      agent_preset TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      policy_ref TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      UNIQUE (conversation_hash, generation),
      FOREIGN KEY (principal_id) REFERENCES delivery_principals(id)
    ) STRICT;
CREATE TABLE conversation_model_epochs (
    conversation_hash TEXT PRIMARY KEY,
    conversation_json TEXT NOT NULL,
    epoch INTEGER NOT NULL CHECK (epoch >= 1),
    updated_at INTEGER NOT NULL
  ) STRICT;
CREATE TABLE conversation_model_selections (
      conversation_hash TEXT PRIMARY KEY,
      conversation_json TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_effort TEXT,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1)
    ) STRICT;
CREATE TABLE dead_letter_resolutions (
    kind TEXT NOT NULL CHECK (kind IN ('inbox', 'outbox')),
    message_id TEXT NOT NULL,
    attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
    receipt_version INTEGER NOT NULL CHECK (receipt_version = 1),
    resolution TEXT NOT NULL CHECK (resolution IN ('cancel', 'retry')),
    original_status TEXT NOT NULL CHECK (
      (kind = 'inbox' AND original_status = 'dead_letter')
      OR (kind = 'outbox' AND original_status IN ('dead', 'unknown_after_send'))
    ),
    original_failure_code TEXT,
    operator_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (kind, message_id, attempt_count)
  ) STRICT;
CREATE TABLE delivery_attachments (
      id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL CHECK (owner_kind IN ('inbox', 'outbox')),
      owner_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      sha256 TEXT NOT NULL,
      spool_ref TEXT,
      resource_kind TEXT,
      provider_ref TEXT,
      file_name TEXT,
      status TEXT NOT NULL CHECK (status IN ('metadata', 'quarantined', 'ready', 'expired')),
      expires_at INTEGER,
      created_at INTEGER NOT NULL
    ) STRICT;
CREATE TABLE delivery_duty_lease (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      owner_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
      lease_until INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
CREATE TABLE delivery_foreground_completion_clock (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    current_sequence INTEGER NOT NULL CHECK(current_sequence BETWEEN 0 AND 9007199254740991)
  ) STRICT;
CREATE TABLE delivery_foreground_executions (
    inbox_id TEXT PRIMARY KEY REFERENCES inbox_messages(id),
    workspace TEXT NOT NULL,
    preset TEXT NOT NULL,
    principal_record_id TEXT NOT NULL REFERENCES delivery_principals(id),
    principal_version INTEGER NOT NULL CHECK(principal_version >= 1),
    binding_id TEXT NOT NULL REFERENCES conversation_bindings(id),
    binding_version INTEGER NOT NULL CHECK(binding_version >= 1),
    binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
    dispatched_at INTEGER NOT NULL CHECK(dispatched_at >= 0),
    status TEXT NOT NULL CHECK(status IN ('pending', 'succeeded', 'failed', 'timed-out', 'cancelled', 'unknown')),
    quiescent INTEGER NOT NULL CHECK(quiescent IN (0, 1)),
    completed_at INTEGER,
    execution_ref TEXT,
    model_selection_state TEXT NOT NULL DEFAULT 'missing' CHECK(model_selection_state IN ('missing', 'frozen', 'inconsistent')),
    model_provider TEXT,
    model_id TEXT,
    model_reasoning_effort TEXT,
    completion_sequence INTEGER CHECK(completion_sequence BETWEEN 1 AND 9007199254740991),
    termination_json TEXT CHECK(termination_json IS NULL OR (json_valid(termination_json) AND length(CAST(termination_json AS BLOB)) <= 1024)),
    CHECK((status = 'pending' AND completed_at IS NULL AND execution_ref IS NULL)
      OR (status != 'pending' AND completed_at IS NOT NULL AND completed_at >= dispatched_at AND execution_ref IS NOT NULL AND execution_ref = inbox_id)),
    CHECK(quiescent = 0 OR status = 'succeeded'),
    CHECK((model_selection_state = 'missing' AND model_provider IS NULL AND model_id IS NULL AND model_reasoning_effort IS NULL)
      OR (model_selection_state = 'frozen' AND model_provider IS NOT NULL AND model_id IS NOT NULL)
      OR (model_selection_state = 'inconsistent' AND model_provider IS NULL AND model_id IS NULL AND model_reasoning_effort IS NULL))
  ) STRICT;
CREATE TABLE delivery_goal_outcome_targets (
    outbox_id TEXT PRIMARY KEY,
    locator_json TEXT NOT NULL CHECK (json_valid(locator_json) AND json_type(locator_json) = 'object'),
    proof_json TEXT NOT NULL CHECK (json_valid(proof_json) AND json_type(proof_json) = 'object'),
    proof_digest TEXT NOT NULL CHECK (
      length(proof_digest) = 64 AND proof_digest NOT GLOB '*[^0-9a-f]*'
    ),
    owner_route_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    principal_record_id TEXT NOT NULL,
    principal_version INTEGER NOT NULL CHECK (principal_version >= 1),
    workspace TEXT NOT NULL,
    preset TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    binding_version INTEGER NOT NULL CHECK (binding_version >= 1),
    binding_generation INTEGER NOT NULL CHECK (binding_generation >= 1),
    session_id TEXT NOT NULL,
    goal_id TEXT NOT NULL,
    assessment_id TEXT NOT NULL,
    FOREIGN KEY (outbox_id) REFERENCES outbox_messages(id) ON DELETE CASCADE,
    FOREIGN KEY (binding_id) REFERENCES conversation_bindings(id),
    FOREIGN KEY (principal_record_id) REFERENCES delivery_principals(id)
  ) STRICT;
CREATE TABLE delivery_inbox_admission_clock (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    current_sequence INTEGER NOT NULL CHECK (
      current_sequence BETWEEN 0 AND 9007199254740991
    )
  ) STRICT;
CREATE TABLE delivery_inbox_admissions (
    inbox_id TEXT PRIMARY KEY,
    epoch TEXT NOT NULL CHECK (
      length(epoch) = 32 AND epoch NOT GLOB '*[^0-9a-f]*'
    ),
    admission_sequence INTEGER NOT NULL UNIQUE CHECK (
      admission_sequence BETWEEN 1 AND 9007199254740991
    ),
    FOREIGN KEY (inbox_id) REFERENCES inbox_messages(id) ON DELETE CASCADE
  ) STRICT;
CREATE TABLE delivery_instance (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    instance_id TEXT NOT NULL UNIQUE CHECK (
      length(instance_id) = 32 AND instance_id NOT GLOB '*[^0-9a-f]*'
    )
  ) STRICT;
CREATE TABLE delivery_natural_objective_intents (
    inbox_id TEXT PRIMARY KEY REFERENCES inbox_messages(id),
    envelope_hash TEXT NOT NULL,
    source_inbox_id TEXT NOT NULL REFERENCES inbox_messages(id),
    source_outbox_id TEXT NOT NULL REFERENCES outbox_messages(id),
    binding_id TEXT NOT NULL REFERENCES conversation_bindings(id),
    binding_version INTEGER NOT NULL CHECK(binding_version >= 1),
    binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
    principal_record_id TEXT NOT NULL REFERENCES delivery_principals(id),
    principal_version INTEGER NOT NULL CHECK(principal_version >= 1),
    admission_epoch TEXT NOT NULL,
    admission_sequence INTEGER NOT NULL CHECK(admission_sequence >= 1),
    occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0),
    parser_version INTEGER NOT NULL CHECK(parser_version = 1),
    intent_status TEXT NOT NULL CHECK(intent_status IN ('awaiting-evaluation', 'frozen', 'projected', 'conflict')),
    selection TEXT NOT NULL CHECK(selection IN ('achieved', 'not-achieved', 'withdraw')),
    command_json TEXT CHECK(command_json IS NULL OR json_valid(command_json)),
    canonical_json TEXT CHECK(canonical_json IS NULL OR json_valid(canonical_json)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
CREATE TABLE delivery_owner_objective_commands (
    inbox_id TEXT PRIMARY KEY,
    source_outbox_id TEXT NOT NULL,
    principal_record_id TEXT NOT NULL,
    principal_version INTEGER NOT NULL,
    version INTEGER NOT NULL,
    objective_status TEXT NOT NULL,
    command_json TEXT NOT NULL,
    result_json TEXT NOT NULL
  ) STRICT;
CREATE TABLE delivery_preference_projection_outbox (
    batch_key TEXT PRIMARY KEY,
    payload_digest TEXT NOT NULL CHECK (
      length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'
    ),
    events_json TEXT NOT NULL CHECK (
      json_valid(events_json) AND json_type(events_json) = 'array'
      AND json_array_length(events_json) BETWEEN 1 AND 16
    ),
    status TEXT NOT NULL CHECK (status IN ('pending', 'retry_wait')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at INTEGER NOT NULL,
    failure_code TEXT,
    lane_kind TEXT NOT NULL DEFAULT 'unclassified' CHECK (
      lane_kind IN ('exact', 'legacy', 'unclassified')
    ),
    lane_epoch TEXT CHECK (
      lane_epoch IS NULL OR (
        length(lane_epoch) = 32 AND lane_epoch NOT GLOB '*[^0-9a-f]*'
      )
    ),
    lane_workspace TEXT,
    lane_preset TEXT,
    lane_principal_record_id TEXT,
    lane_principal_version INTEGER CHECK (
      lane_principal_version IS NULL OR lane_principal_version >= 1
    ),
    admission_sequence INTEGER CHECK (
      admission_sequence IS NULL OR admission_sequence BETWEEN 1 AND 9007199254740991
    ),
    terminal_at INTEGER CHECK (terminal_at IS NULL OR terminal_at >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
CREATE TABLE delivery_presentations (
    presentation_key TEXT PRIMARY KEY,
    original_outbox_idempotency_key TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('pending', 'attempting', 'presented', 'retry_wait', 'dead')
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    presented_revision INTEGER NOT NULL DEFAULT 0 CHECK (presented_revision >= 0),
    next_attempt_at INTEGER,
    claimed_by TEXT,
    fencing_token INTEGER,
    lease_until INTEGER,
    provider_message_id TEXT,
    failure_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
CREATE TABLE delivery_principals (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      principal_json TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'linked')),
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
      linked_to_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      FOREIGN KEY (linked_to_id) REFERENCES delivery_principals(id)
    ) STRICT;
CREATE TABLE delivery_progress (
    inbox_id TEXT PRIMARY KEY REFERENCES inbox_messages(id),
    binding_id TEXT NOT NULL REFERENCES conversation_bindings(id),
    binding_version INTEGER NOT NULL CHECK(binding_version >= 1),
    binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
    target_hash TEXT NOT NULL CHECK(length(target_hash) = 64),
    credential_hash TEXT NOT NULL CHECK(length(credential_hash) = 64),
    provider_handle TEXT CHECK(provider_handle IS NULL OR length(provider_handle) BETWEEN 2 AND 2048),
    sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 9007199254740991),
    step INTEGER NOT NULL DEFAULT 0 CHECK(step BETWEEN 0 AND 9007199254740991),
    show_details INTEGER NOT NULL CHECK(show_details IN (0, 1)),
    state TEXT NOT NULL CHECK(state IN ('creating', 'active', 'pending', 'delivered')),
    terminal_kind TEXT CHECK(terminal_kind IN ('completed', 'failed', 'paused')),
    terminal_code TEXT,
    retry_attempts INTEGER NOT NULL DEFAULT 0 CHECK(retry_attempts BETWEEN 0 AND 8),
    next_retry_at INTEGER NOT NULL DEFAULT 0 CHECK(next_retry_at >= 0),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
    CHECK((state = 'creating' AND provider_handle IS NULL)
      OR (state = 'active' AND provider_handle IS NOT NULL AND terminal_kind IS NULL)
      OR (state IN ('pending', 'delivered') AND provider_handle IS NOT NULL AND terminal_kind IS NOT NULL))
  ) STRICT;
CREATE TABLE delivery_receipts (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      account TEXT NOT NULL,
      provider_message_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'delivered', 'read')),
      receipt_hash TEXT NOT NULL UNIQUE,
      receipt_json TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (channel, account, provider_message_id, status)
    ) STRICT;
CREATE TABLE delivery_restart_fence (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    request_id TEXT NOT NULL,
    source_invocation_id TEXT NOT NULL
  ) STRICT;
CREATE TABLE delivery_session_leases (
    session_id TEXT PRIMARY KEY,
    holder_id TEXT NOT NULL,
    fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
    lease_until INTEGER NOT NULL CHECK (lease_until >= 0),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'dispatched', 'unknown', 'released')),
    target_json TEXT NOT NULL,
    principal_record_id TEXT NOT NULL,
    principal_version INTEGER NOT NULL CHECK (principal_version >= 1)
  ) STRICT;
CREATE TABLE delivery_task_acceptance_executions (
    inbox_id TEXT PRIMARY KEY REFERENCES inbox_messages(id),
    contract_id TEXT NOT NULL UNIQUE,
    contract_digest TEXT NOT NULL CHECK(length(contract_digest) = 64),
    workspace TEXT NOT NULL,
    preset TEXT NOT NULL,
    principal_record_id TEXT NOT NULL,
    principal_version INTEGER NOT NULL CHECK(principal_version >= 1),
    binding_id TEXT NOT NULL REFERENCES conversation_bindings(id),
    binding_version INTEGER NOT NULL CHECK(binding_version >= 1),
    binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
    dispatched_at INTEGER NOT NULL CHECK(dispatched_at >= 0),
    status TEXT NOT NULL CHECK(status IN ('pending', 'succeeded', 'failed', 'timed-out', 'cancelled', 'unknown')),
    quiescent INTEGER NOT NULL CHECK(quiescent IN (0, 1)),
    completed_at INTEGER,
    execution_ref TEXT,
    model_selection_state TEXT NOT NULL DEFAULT 'missing' CHECK(model_selection_state IN ('missing', 'frozen', 'inconsistent')),
    model_provider TEXT,
    model_id TEXT,
    model_reasoning_effort TEXT,
    CHECK((status = 'pending') = (completed_at IS NULL AND execution_ref IS NULL))
  ) STRICT;
CREATE TABLE delivery_work_item_replies (
    inbox_id TEXT PRIMARY KEY REFERENCES inbox_messages(id),
    stream_key TEXT NOT NULL REFERENCES delivery_work_item_reply_streams(stream_key),
    admission_sequence INTEGER NOT NULL UNIQUE CHECK(admission_sequence>=1),
    source_digest TEXT NOT NULL CHECK(length(source_digest)=64),
    source_json TEXT NOT NULL CHECK(json_valid(source_json)),
    execution_parent_item_id TEXT,
    child_item_id TEXT,
    child_plan_digest TEXT CHECK(child_plan_digest IS NULL OR length(child_plan_digest)=64),
    state TEXT NOT NULL CHECK(state IN ('pending','routed','cancelled')),
    CHECK((child_item_id IS NULL AND child_plan_digest IS NULL) OR
      (child_item_id IS NOT NULL AND child_plan_digest IS NOT NULL AND execution_parent_item_id IS NOT NULL)),
    CHECK(state != 'routed' OR child_item_id IS NOT NULL)
  ) STRICT;
CREATE TABLE delivery_work_item_reply_streams (
    stream_key TEXT PRIMARY KEY CHECK(length(stream_key)=64),
    head_item_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>=0)
  ) STRICT;
CREATE TABLE delivery_work_item_reports (
    outbox_id TEXT PRIMARY KEY REFERENCES outbox_messages(id),
    intent_hash TEXT NOT NULL CHECK(length(intent_hash)=64),
    target_json TEXT NOT NULL CHECK(json_valid(target_json)),
    binding_json TEXT NOT NULL CHECK(json_valid(binding_json))
  ) STRICT;
CREATE TABLE inbox_attempts (
      id TEXT PRIMARY KEY,
      inbox_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      owner_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('claimed', 'processed', 'retry_wait', 'dead_letter', 'lost')),
      failure_code TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      UNIQUE (inbox_id, attempt_number),
      FOREIGN KEY (inbox_id) REFERENCES inbox_messages(id)
    ) STRICT;
CREATE TABLE inbox_messages (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      account TEXT NOT NULL,
      event_id TEXT NOT NULL,
      envelope_hash TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('received', 'authorized', 'queued', 'claimed', 'processed', 'retry_wait', 'dead_letter')),
      binding_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at INTEGER,
      claimed_by TEXT,
      fencing_token INTEGER,
      lease_until INTEGER,
      failure_code TEXT,
      received_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (channel, account, event_id),
      FOREIGN KEY (binding_id) REFERENCES conversation_bindings(id)
    ) STRICT;
CREATE TABLE model_picker_states (
    operation_id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    reasoning_effort TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (binding_id) REFERENCES conversation_bindings(id)
  ) STRICT;
CREATE TABLE model_selection_settlements (
    operation_id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL,
    conversation_hash TEXT NOT NULL,
    command_epoch INTEGER NOT NULL CHECK (command_epoch >= 1),
    payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed')),
    result_json TEXT,
    outbox_id TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    claimed_by TEXT,
    lease_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (binding_id) REFERENCES conversation_bindings(id),
    FOREIGN KEY (conversation_hash) REFERENCES conversation_model_epochs(conversation_hash),
    FOREIGN KEY (outbox_id) REFERENCES outbox_messages(id)
  ) STRICT;
CREATE TABLE outbox_attempts (
      id TEXT PRIMARY KEY,
      outbox_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      owner_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('send', 'reconcile')),
      status TEXT NOT NULL CHECK (status IN ('attempting', 'accepted', 'retry_wait', 'dead', 'unknown_after_send', 'reconciled')),
      provider_message_id TEXT,
      failure_code TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      UNIQUE (outbox_id, attempt_number),
      FOREIGN KEY (outbox_id) REFERENCES outbox_messages(id)
    ) STRICT;
CREATE TABLE outbox_messages (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      binding_id TEXT NOT NULL,
      intent_hash TEXT NOT NULL,
      intent_json TEXT NOT NULL,
      channel TEXT NOT NULL,
      account TEXT NOT NULL,
      lane_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'attempting', 'accepted', 'delivered', 'read', 'retry_wait', 'dead', 'unknown_after_send')),
      provider_message_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at INTEGER,
      claimed_by TEXT,
      fencing_token INTEGER,
      lease_until INTEGER,
      failure_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (binding_id) REFERENCES conversation_bindings(id)
    ) STRICT;
CREATE TABLE pairing_challenges (
      id TEXT PRIMARY KEY,
      principal_hash TEXT NOT NULL,
      principal_json TEXT NOT NULL,
      code_salt TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'expired', 'locked')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
CREATE TABLE trusted_delivery_evaluation_outbox (
    idempotency_key TEXT PRIMARY KEY,
    payload_digest TEXT NOT NULL CHECK (
      length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'
    ),
    claims_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'retry_wait', 'delivered')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at INTEGER NOT NULL,
    failure_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
CREATE TABLE workflow_owner_anchored_templates (
    template_ref TEXT PRIMARY KEY,
    template_digest TEXT NOT NULL CHECK (
      length(template_digest) = 64 AND template_digest NOT GLOB '*[^0-9a-f]*'
    ),
    scope_key TEXT NOT NULL,
    workspace TEXT NOT NULL,
    preset TEXT NOT NULL,
    owner_binding_id TEXT NOT NULL,
    binding_version INTEGER NOT NULL CHECK (binding_version >= 1),
    binding_generation INTEGER NOT NULL CHECK (binding_generation >= 1),
    principal_id TEXT NOT NULL,
    content_json TEXT NOT NULL,
    privacy_kind TEXT NOT NULL CHECK (privacy_kind = 'owner-anchored'),
    privacy_attestation_id TEXT NOT NULL UNIQUE,
    privacy_attestation_digest TEXT NOT NULL CHECK (
      length(privacy_attestation_digest) = 64
      AND privacy_attestation_digest NOT GLOB '*[^0-9a-f]*'
    ),
    review_receipt_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    version INTEGER NOT NULL CHECK (version >= 1),
    task_ref TEXT NOT NULL UNIQUE CHECK (
      length(task_ref) = 64 AND task_ref NOT GLOB '*[^0-9a-f]*'
    ),
    owner_route_id TEXT NOT NULL,
    goal_id TEXT NOT NULL,
    native_goal_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    turn INTEGER NOT NULL CHECK (turn >= 0),
    acceptance_contract_id TEXT NOT NULL,
    acceptance_receipt_digest TEXT NOT NULL,
    owner_run_trace_digest TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (owner_binding_id) REFERENCES conversation_bindings(id)
  ) STRICT;
CREATE TABLE workflow_template_registry (
    template_ref TEXT PRIMARY KEY,
    template_digest TEXT NOT NULL CHECK (
      length(template_digest) = 64 AND template_digest NOT GLOB '*[^0-9a-f]*'
    ),
    scope_key TEXT NOT NULL,
    workspace TEXT NOT NULL,
    preset TEXT NOT NULL,
    owner_binding_id TEXT NOT NULL,
    content_json TEXT NOT NULL,
    privacy_kind TEXT NOT NULL CHECK (
      privacy_kind IN ('deterministic-deidentification', 'owner-explicit')
    ),
    privacy_attestation_id TEXT NOT NULL UNIQUE,
    privacy_attestation_digest TEXT NOT NULL CHECK (
      length(privacy_attestation_digest) = 64
      AND privacy_attestation_digest NOT GLOB '*[^0-9a-f]*'
    ),
    review_receipt_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    review_inbox_id TEXT NOT NULL,
    source_inbox_id TEXT NOT NULL,
    source_outbox_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    FOREIGN KEY (owner_binding_id) REFERENCES conversation_bindings(id),
    FOREIGN KEY (review_inbox_id) REFERENCES inbox_messages(id),
    FOREIGN KEY (source_inbox_id) REFERENCES inbox_messages(id),
    FOREIGN KEY (source_outbox_id) REFERENCES outbox_messages(id)
  ) STRICT;
CREATE TABLE workflow_trace_commands (
    operation_id TEXT PRIMARY KEY,
    payload_digest TEXT NOT NULL CHECK (
      length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'
    ),
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
CREATE TABLE workflow_trace_current (
    subject_ref TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version >= 1),
    digest TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('upsert', 'retract')),
    payload_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (subject_ref, version) REFERENCES workflow_trace_revisions(subject_ref, version)
  ) STRICT;
CREATE TABLE workflow_trace_outbox (
    subject_ref TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'retry_wait')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at INTEGER NOT NULL,
    failure_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (subject_ref, version),
    FOREIGN KEY (subject_ref, version) REFERENCES workflow_trace_revisions(subject_ref, version)
  ) STRICT;
CREATE TABLE workflow_trace_revisions (
    subject_ref TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    source_generation INTEGER NOT NULL CHECK (source_generation >= 1),
    source_authority_digest TEXT NOT NULL CHECK (
      length(source_authority_digest) = 64
      AND source_authority_digest NOT GLOB '*[^0-9a-f]*'
    ),
    scope_key TEXT NOT NULL,
    workspace TEXT NOT NULL,
    preset TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('upsert', 'retract')),
    digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (subject_ref, version)
  ) STRICT;
CREATE TABLE workflow_trace_source (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    contract_version INTEGER NOT NULL CHECK (contract_version = 1),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    authority_digest TEXT NOT NULL CHECK (
      length(authority_digest) = 64 AND authority_digest NOT GLOB '*[^0-9a-f]*'
    ),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
CREATE TABLE workflow_verified_task_feedback (
    source_outbox_id TEXT PRIMARY KEY,
    source_inbox_id TEXT NOT NULL UNIQUE,
    feedback_inbox_id TEXT NOT NULL UNIQUE,
    binding_id TEXT NOT NULL,
    binding_version INTEGER NOT NULL CHECK (binding_version >= 1),
    binding_generation INTEGER NOT NULL CHECK (binding_generation >= 1),
    principal_record_id TEXT NOT NULL,
    objective_status TEXT NOT NULL CHECK (
      objective_status IN ('achieved', 'partial', 'not-achieved')
    ),
    task_ref TEXT NOT NULL CHECK (
      length(task_ref) = 64 AND task_ref NOT GLOB '*[^0-9a-f]*'
    ),
    task_evidence_digest TEXT NOT NULL CHECK (
      length(task_evidence_digest) = 64
      AND task_evidence_digest NOT GLOB '*[^0-9a-f]*'
    ),
    trace_subject_ref TEXT CHECK (
      trace_subject_ref IS NULL
      OR (length(trace_subject_ref) = 64 AND trace_subject_ref NOT GLOB '*[^0-9a-f]*')
    ),
    trace_version INTEGER CHECK (trace_version IS NULL OR trace_version >= 1),
    trace_digest TEXT CHECK (
      trace_digest IS NULL
      OR (length(trace_digest) = 64 AND trace_digest NOT GLOB '*[^0-9a-f]*')
    ),
    template_ref TEXT,
    created_at INTEGER NOT NULL,
    CHECK (
      (trace_subject_ref IS NOT NULL AND trace_version IS NOT NULL
        AND trace_digest IS NOT NULL AND template_ref IS NOT NULL)
      OR
      (trace_subject_ref IS NULL AND trace_version IS NULL
        AND trace_digest IS NULL AND template_ref IS NULL)
    ),
    FOREIGN KEY (source_outbox_id) REFERENCES outbox_messages(id),
    FOREIGN KEY (source_inbox_id) REFERENCES inbox_messages(id),
    FOREIGN KEY (feedback_inbox_id) REFERENCES inbox_messages(id),
    FOREIGN KEY (binding_id) REFERENCES conversation_bindings(id),
    FOREIGN KEY (principal_record_id) REFERENCES delivery_principals(id),
    FOREIGN KEY (template_ref) REFERENCES workflow_template_registry(template_ref),
    FOREIGN KEY (trace_subject_ref, trace_version)
      REFERENCES workflow_trace_revisions(subject_ref, version)
  ) STRICT;
INSERT INTO "delivery_instance" ("singleton","instance_id") VALUES (1.0,'9f173882f1b11f9ffd12800e813ead0a');
INSERT INTO "delivery_principals" ("id","key_hash","principal_json","role","status","linked_to_id","created_at","updated_at","version") VALUES ('principal_a37432b5-daa1-40f8-b8f7-7657e94d1112','84db40de33f0b7faaf9bb251a5f818741747d8542ce2e0d4530899bb1082ca8e','{"channel":"lark","account":"legacy","tenant":"legacy","user":"owner"}','owner','active',NULL,1000.0,1000.0,1.0);
INSERT INTO "pairing_challenges" ("id","principal_hash","principal_json","code_salt","code_hash","status","attempts","max_attempts","expires_at","created_at","updated_at") VALUES ('pair_bd1cb9ec-c892-4c38-a0e6-d27a7df04267','84db40de33f0b7faaf9bb251a5f818741747d8542ce2e0d4530899bb1082ca8e','{"channel":"lark","account":"legacy","tenant":"legacy","user":"owner"}','e51568ffe40d0472dc3c89c7e7979254','bf94bccb9605ec133c31d6ec3f019f29d7c820270ef91ddca6e0a8a90df4db46','consumed',0.0,3.0,6000.0,1000.0,1000.0);
INSERT INTO "conversation_bindings" ("id","conversation_hash","conversation_json","principal_id","principal_json","workspace","agent_preset","session_id","generation","policy_ref","status","created_at","updated_at","version") VALUES ('binding_b37306e5-7121-4d35-8418-865cfda4743f','28ee1635178a302d5dfe2d533725cab5521372d3d47022a4648f25c97618f38c','{"channel":"lark","account":"legacy","tenant":"legacy","kind":"dm","chat":"owner"}','principal_a37432b5-daa1-40f8-b8f7-7657e94d1112','{"channel":"lark","account":"legacy","tenant":"legacy","user":"owner"}','/work/legacy','primary','legacy-session',1.0,'owner','active',1000.0,1000.0,1.0);
INSERT INTO "inbox_messages" ("id","channel","account","event_id","envelope_hash","envelope_json","status","binding_id","attempt_count","next_attempt_at","claimed_by","fencing_token","lease_until","failure_code","received_at","updated_at") VALUES ('inbox_72de7241-b556-43fd-8d47-a003959e1a74','lark','legacy','legacy-reply','855f3196c34076ecfcc682ee2f53ce7f2d76f8382a3f2ceefedb6f1e28226a09','{"channel":"lark","account":"legacy","eventId":"legacy-reply","occurredAt":1000,"principal":{"channel":"lark","account":"legacy","tenant":"legacy","user":"owner"},"conversation":{"channel":"lark","account":"legacy","tenant":"legacy","kind":"dm","chat":"owner"},"kind":"text","text":"Original legacy reply 🧪","metadata":{"replyToProviderMessageId":"legacy-provider-message"}}','processed','binding_b37306e5-7121-4d35-8418-865cfda4743f',0.0,NULL,NULL,NULL,NULL,NULL,1000.0,1000.0);
INSERT INTO "outbox_messages" ("id","idempotency_key","binding_id","intent_hash","intent_json","channel","account","lane_hash","status","provider_message_id","attempt_count","next_attempt_at","claimed_by","fencing_token","lease_until","failure_code","created_at","updated_at") VALUES ('outbox_d42b2e5b-f444-44ab-8eb7-72e22e8c7798','legacy-report','binding_b37306e5-7121-4d35-8418-865cfda4743f','921637d01c1a7263eb188837dfea124a061c2d6cbd44e3f027c04ffc8e9a52c9','{"idempotencyKey":"legacy-report","bindingId":"binding_b37306e5-7121-4d35-8418-865cfda4743f","target":{"conversation":{"channel":"lark","account":"legacy","tenant":"legacy","kind":"dm","chat":"owner"},"principal":{"channel":"lark","account":"legacy","tenant":"legacy","user":"owner"}},"text":"Legacy real report","format":"plain"}','lark','legacy','28ee1635178a302d5dfe2d533725cab5521372d3d47022a4648f25c97618f38c','accepted','legacy-provider-message',1.0,NULL,NULL,NULL,NULL,NULL,1000.0,1000.0);
INSERT INTO "outbox_attempts" ("id","outbox_id","attempt_number","owner_id","fencing_token","operation","status","provider_message_id","failure_code","created_at","finished_at") VALUES ('outbox_attempt_09b8a324-d021-44bd-9d90-2f7af03c2d0f','outbox_d42b2e5b-f444-44ab-8eb7-72e22e8c7798',1.0,'legacy-sender',1.0,'send','accepted','legacy-provider-message',NULL,1000.0,1000.0);
INSERT INTO "workflow_trace_source" ("singleton","contract_version","generation","authority_digest","created_at","updated_at") VALUES (1.0,1.0,1.0,'e66c59735a76c715931b4c7f773188b7bc3777ba904a24f5874ec2804736da6e',1000.0,1000.0);
INSERT INTO "delivery_inbox_admission_clock" ("singleton","current_sequence") VALUES (1.0,1.0);
INSERT INTO "delivery_inbox_admissions" ("inbox_id","epoch","admission_sequence") VALUES ('inbox_72de7241-b556-43fd-8d47-a003959e1a74','9f173882f1b11f9ffd12800e813ead0a',1.0);
INSERT INTO "delivery_foreground_completion_clock" ("singleton","current_sequence") VALUES (1.0,0.0);
INSERT INTO "delivery_work_item_reports" ("outbox_id","intent_hash","target_json","binding_json") VALUES ('outbox_d42b2e5b-f444-44ab-8eb7-72e22e8c7798','921637d01c1a7263eb188837dfea124a061c2d6cbd44e3f027c04ffc8e9a52c9','{"itemId":"legacy-P","owner":{"principalRecordId":"principal_a37432b5-daa1-40f8-b8f7-7657e94d1112","principalVersion":1},"protocol":"assistant-delivery/work-item-report/v1","reportDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reportRevision":1,"scope":{"preset":"primary","workspace":"/work/legacy"},"sourceId":"legacy-source","streamId":"legacy-P"}','{"generation":1,"id":"binding_b37306e5-7121-4d35-8418-865cfda4743f","version":1}');
INSERT INTO "delivery_work_item_reply_streams" ("stream_key","head_item_id","revision") VALUES ('c93ce475fc9a0bcbf032913f0e858a14a82fd68996925a882961b0a1e7121c8e','legacy-C1',1.0);
INSERT INTO "delivery_work_item_replies" ("inbox_id","stream_key","admission_sequence","source_digest","source_json","execution_parent_item_id","child_item_id","child_plan_digest","state") VALUES ('inbox_72de7241-b556-43fd-8d47-a003959e1a74','c93ce475fc9a0bcbf032913f0e858a14a82fd68996925a882961b0a1e7121c8e',1.0,'98e8d565166d47a1f204d235729154137db47c4bd2f4095266615f2d8c5ad9ca','{"admissionCursor":{"epoch":"9f173882f1b11f9ffd12800e813ead0a","sequence":1},"binding":{"generation":1,"id":"binding_b37306e5-7121-4d35-8418-865cfda4743f","version":1},"id":"inbox_72de7241-b556-43fd-8d47-a003959e1a74","inputBytes":26,"inputSha256":"14620402f17c18f61f6360462deb72a880176cc9fa5565f0a526efaa0b99b79c","inputText":"Original legacy reply 🧪","owner":{"principalRecordId":"principal_a37432b5-daa1-40f8-b8f7-7657e94d1112","principalVersion":1},"principalId":"lark/legacy/legacy/owner","protocol":"assistant-delivery/work-item-reply/v1","scope":{"preset":"primary","workspace":"/work/legacy"},"target":{"itemId":"legacy-P","outboxId":"outbox_d42b2e5b-f444-44ab-8eb7-72e22e8c7798","providerMessageId":"legacy-provider-message","reportDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reportRevision":1,"streamId":"legacy-P"}}','legacy-P','legacy-C1','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','routed');
CREATE INDEX approval_outbox_route_binding
    ON approval_outbox_routes(binding_id, binding_version, binding_generation);
CREATE UNIQUE INDEX binding_one_active ON conversation_bindings(conversation_hash) WHERE status = 'active';
CREATE INDEX dead_letter_resolution_projection
    ON dead_letter_resolutions(kind, resolution, message_id, attempt_count);
CREATE UNIQUE INDEX delivery_attachment_owner_ordinal
      ON delivery_attachments(owner_kind, owner_id, ordinal);
CREATE UNIQUE INDEX delivery_foreground_completion_order
    ON delivery_foreground_executions(completion_sequence) WHERE completion_sequence IS NOT NULL;
CREATE INDEX delivery_foreground_execution_owner
    ON delivery_foreground_executions(principal_record_id, principal_version, workspace, preset, binding_id);
CREATE INDEX delivery_foreground_owner_completion_order
    ON delivery_foreground_executions(principal_record_id, principal_version, workspace, preset, completion_sequence)
    WHERE status != 'pending';
CREATE INDEX delivery_goal_outcome_target_binding
    ON delivery_goal_outcome_targets(binding_id, binding_version, binding_generation);
CREATE INDEX delivery_goal_outcome_target_owner
    ON delivery_goal_outcome_targets(principal_record_id, principal_version, workspace, preset);
CREATE INDEX delivery_natural_objective_pending
    ON delivery_natural_objective_intents(intent_status, admission_sequence);
CREATE INDEX delivery_natural_objective_target_order
    ON delivery_natural_objective_intents(source_outbox_id, admission_sequence);
CREATE INDEX delivery_owner_objective_current ON delivery_owner_objective_commands(source_outbox_id, version);
CREATE INDEX delivery_preference_projection_due
    ON delivery_preference_projection_outbox(
      terminal_at, lane_kind, status, next_attempt_at, updated_at, batch_key
    );
CREATE INDEX delivery_preference_projection_lane
    ON delivery_preference_projection_outbox(
      terminal_at, lane_epoch, lane_workspace, lane_preset,
      lane_principal_record_id, lane_principal_version, admission_sequence,
      created_at, batch_key
    );
CREATE INDEX delivery_presentation_claim
    ON delivery_presentations(status, next_attempt_at, lease_until, created_at, presentation_key);
CREATE INDEX delivery_progress_recovery
    ON delivery_progress(state, next_retry_at, created_at);
CREATE INDEX delivery_work_item_replies_pending ON delivery_work_item_replies(state, admission_sequence);
CREATE INDEX inbox_claim ON inbox_messages(status, next_attempt_at, received_at, id);
CREATE INDEX model_selection_claim
    ON model_selection_settlements(status, lease_until, created_at, operation_id);
CREATE INDEX outbox_claim ON outbox_messages(status, next_attempt_at, created_at, id);
CREATE INDEX outbox_lane ON outbox_messages(lane_hash, created_at, id);
CREATE UNIQUE INDEX outbox_provider_message ON outbox_messages(channel, account, provider_message_id)
      WHERE provider_message_id IS NOT NULL;
CREATE INDEX pairing_active ON pairing_challenges(principal_hash, status, expires_at);
CREATE INDEX trusted_delivery_evaluation_due
    ON trusted_delivery_evaluation_outbox(status, next_attempt_at, updated_at, idempotency_key);
CREATE INDEX workflow_owner_anchored_scope
    ON workflow_owner_anchored_templates(scope_key, status, updated_at, template_ref);
CREATE INDEX workflow_template_scope
    ON workflow_template_registry(scope_key, status, updated_at, template_ref);
CREATE INDEX workflow_trace_outbox_due
    ON workflow_trace_outbox(status, next_attempt_at, updated_at, subject_ref, version);
CREATE INDEX workflow_verified_task_feedback_binding
    ON workflow_verified_task_feedback(binding_id, created_at, source_outbox_id);
CREATE TRIGGER dead_letter_inbox_resolution_fence
  BEFORE UPDATE ON inbox_messages
  WHEN OLD.status = 'dead_letter' AND NEW.attempt_count = OLD.attempt_count AND (
    NEW.status = 'queued'
    OR (NEW.status = 'dead_letter' AND NEW.failure_code = 'operator-cancelled')
  ) AND NOT EXISTS (
    SELECT 1 FROM dead_letter_resolutions AS resolution
    WHERE resolution.kind = 'inbox' AND resolution.message_id = OLD.id
      AND resolution.attempt_count = OLD.attempt_count
      AND resolution.resolution = CASE WHEN NEW.status = 'queued' THEN 'retry' ELSE 'cancel' END
      AND resolution.original_status = OLD.status
      AND resolution.original_failure_code IS OLD.failure_code
  )
  BEGIN
    SELECT RAISE(ABORT, 'inbox resolution requires an exact v9 receipt');
  END;
CREATE TRIGGER dead_letter_outbox_cancelled_unknown_fence
  BEFORE UPDATE ON outbox_messages
  WHEN OLD.status = 'unknown_after_send' AND EXISTS (
    SELECT 1 FROM dead_letter_resolutions AS resolution
    WHERE resolution.kind = 'outbox' AND resolution.message_id = OLD.id
      AND resolution.attempt_count = OLD.attempt_count AND resolution.resolution = 'cancel'
      AND resolution.original_status = 'unknown_after_send'
  ) AND NOT (
    NEW.attempt_count = OLD.attempt_count AND (
      (NEW.status = 'unknown_after_send' AND NEW.failure_code = 'operator-cancelled-unknown')
      OR (
        NEW.status IN ('accepted', 'delivered', 'read') AND EXISTS (
          SELECT 1 FROM delivery_receipts AS receipt
          WHERE receipt.channel = OLD.channel AND receipt.account = OLD.account
            AND receipt.provider_message_id = OLD.provider_message_id
            AND receipt.status = NEW.status
        )
      )
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'cancelled unknown outbox attempt cannot be reclaimed');
  END;
CREATE TRIGGER dead_letter_outbox_resolution_fence
  BEFORE UPDATE ON outbox_messages
  WHEN OLD.status IN ('dead', 'unknown_after_send')
    AND NEW.attempt_count = OLD.attempt_count AND (
      NEW.status = 'pending'
      OR (NEW.status = 'dead' AND NEW.failure_code = 'operator-cancelled')
      OR (NEW.status = 'unknown_after_send' AND NEW.failure_code = 'operator-cancelled-unknown')
    ) AND NOT EXISTS (
    SELECT 1 FROM dead_letter_resolutions AS resolution
    WHERE resolution.kind = 'outbox' AND resolution.message_id = OLD.id
      AND resolution.attempt_count = OLD.attempt_count
      AND resolution.resolution = CASE WHEN NEW.status = 'pending' THEN 'retry' ELSE 'cancel' END
      AND resolution.original_status = OLD.status
      AND resolution.original_failure_code IS OLD.failure_code
  )
  BEGIN
    SELECT RAISE(ABORT, 'outbox resolution requires an exact v9 receipt');
  END;
CREATE TRIGGER delivery_foreground_completion_after_insert
  AFTER INSERT ON delivery_foreground_executions WHEN NEW.status != 'pending'
  BEGIN
    UPDATE delivery_foreground_completion_clock SET current_sequence = current_sequence + 1 WHERE singleton = 1;
    UPDATE delivery_foreground_executions SET completion_sequence =
      (SELECT current_sequence FROM delivery_foreground_completion_clock WHERE singleton = 1)
      WHERE inbox_id = NEW.inbox_id;
  END;
CREATE TRIGGER delivery_foreground_completion_after_update
  AFTER UPDATE OF status ON delivery_foreground_executions
  WHEN OLD.status = 'pending' AND NEW.status != 'pending'
  BEGIN
    UPDATE delivery_foreground_completion_clock SET current_sequence = current_sequence + 1 WHERE singleton = 1;
    UPDATE delivery_foreground_executions SET completion_sequence =
      (SELECT current_sequence FROM delivery_foreground_completion_clock WHERE singleton = 1)
      WHERE inbox_id = NEW.inbox_id;
  END;
CREATE TRIGGER delivery_foreground_identity_immutable
  BEFORE UPDATE ON delivery_foreground_executions
  WHEN NEW.inbox_id IS NOT OLD.inbox_id OR NEW.workspace IS NOT OLD.workspace
    OR NEW.preset IS NOT OLD.preset OR NEW.principal_record_id IS NOT OLD.principal_record_id
    OR NEW.principal_version IS NOT OLD.principal_version OR NEW.binding_id IS NOT OLD.binding_id
    OR NEW.binding_version IS NOT OLD.binding_version OR NEW.binding_generation IS NOT OLD.binding_generation
    OR NEW.dispatched_at IS NOT OLD.dispatched_at
  BEGIN SELECT RAISE(ABORT, 'foreground execution identity is immutable'); END;
CREATE TRIGGER delivery_foreground_terminal_delete_immutable
  BEFORE DELETE ON delivery_foreground_executions WHEN OLD.status != 'pending'
  BEGIN SELECT RAISE(ABORT, 'foreground execution completion is immutable'); END;
CREATE TRIGGER delivery_foreground_terminal_immutable
  BEFORE UPDATE ON delivery_foreground_executions
  WHEN (OLD.status != 'pending' AND (
    NEW.status IS NOT OLD.status OR NEW.quiescent IS NOT OLD.quiescent
    OR NEW.completed_at IS NOT OLD.completed_at OR NEW.execution_ref IS NOT OLD.execution_ref
    OR NEW.model_selection_state IS NOT OLD.model_selection_state OR NEW.model_provider IS NOT OLD.model_provider
    OR NEW.model_id IS NOT OLD.model_id OR NEW.model_reasoning_effort IS NOT OLD.model_reasoning_effort))
    OR (OLD.completion_sequence IS NOT NULL AND NEW.completion_sequence IS NOT OLD.completion_sequence)
    OR (OLD.completion_sequence IS NULL AND NEW.completion_sequence IS NOT NULL AND
      (OLD.status = 'pending' OR NEW.completion_sequence IS NOT
        (SELECT current_sequence FROM delivery_foreground_completion_clock WHERE singleton = 1)))
  BEGIN SELECT RAISE(ABORT, 'foreground execution completion is immutable'); END;
CREATE TRIGGER delivery_foreground_termination_immutable BEFORE UPDATE ON delivery_foreground_executions
   WHEN OLD.status != 'pending' AND NEW.termination_json IS NOT OLD.termination_json
   BEGIN SELECT RAISE(ABORT, 'foreground termination is immutable'); END;
CREATE TRIGGER delivery_foreground_termination_insert BEFORE INSERT ON delivery_foreground_executions
   WHEN COALESCE((NEW.termination_json IS NULL OR (
  NEW.status != 'pending' AND json_valid(NEW.termination_json)
  AND length(CAST(NEW.termination_json AS BLOB)) <= 1024
  AND instr(CAST(NEW.termination_json AS BLOB), X'00') = 0
  AND (SELECT COUNT(*) FROM json_each(NEW.termination_json)) = 7
  AND NOT EXISTS (SELECT 1 FROM json_each(NEW.termination_json) WHERE key NOT IN ('protocol','producer','kind','causeCode','handleDisposed','effects','replay'))
  AND json_extract(NEW.termination_json,'$.protocol') = 'assistant-delivery/foreground-termination/v1'
  AND json_extract(NEW.termination_json,'$.producer') IN ('delivery-agent','native-web')
  AND json_type(NEW.termination_json,'$.handleDisposed') IN ('true','false')
  AND json_extract(NEW.termination_json,'$.effects') = 'unknown'
  AND json_extract(NEW.termination_json,'$.replay') = 'forbidden'
  AND ((json_extract(NEW.termination_json,'$.causeCode') = 'turn-completed' AND json_extract(NEW.termination_json,'$.kind') = 'completed') OR (json_extract(NEW.termination_json,'$.causeCode') = 'turn-error' AND json_extract(NEW.termination_json,'$.kind') = 'error') OR (json_extract(NEW.termination_json,'$.causeCode') = 'turn-max-tokens' AND json_extract(NEW.termination_json,'$.kind') = 'error') OR (json_extract(NEW.termination_json,'$.causeCode') = 'runtime-error' AND json_extract(NEW.termination_json,'$.kind') = 'error') OR (json_extract(NEW.termination_json,'$.causeCode') = 'execution-timeout' AND json_extract(NEW.termination_json,'$.kind') = 'timeout') OR (json_extract(NEW.termination_json,'$.causeCode') = 'turn-user-aborted' AND json_extract(NEW.termination_json,'$.kind') = 'owner-cancelled') OR (json_extract(NEW.termination_json,'$.causeCode') = 'owner-stop' AND json_extract(NEW.termination_json,'$.kind') = 'owner-cancelled') OR (json_extract(NEW.termination_json,'$.causeCode') = 'owner-new-session' AND json_extract(NEW.termination_json,'$.kind') = 'owner-cancelled') OR (json_extract(NEW.termination_json,'$.causeCode') = 'turn-aborted' AND json_extract(NEW.termination_json,'$.kind') = 'interrupted') OR (json_extract(NEW.termination_json,'$.causeCode') = 'lease-or-authority-lost' AND json_extract(NEW.termination_json,'$.kind') = 'interrupted') OR (json_extract(NEW.termination_json,'$.causeCode') = 'host-disposed' AND json_extract(NEW.termination_json,'$.kind') = 'interrupted') OR (json_extract(NEW.termination_json,'$.causeCode') = 'execution-aborted' AND json_extract(NEW.termination_json,'$.kind') = 'interrupted') OR (json_extract(NEW.termination_json,'$.causeCode') = 'turn-missing' AND json_extract(NEW.termination_json,'$.kind') = 'unknown') OR (json_extract(NEW.termination_json,'$.causeCode') = 'teardown-unconfirmed' AND json_extract(NEW.termination_json,'$.kind') = 'unknown') OR (json_extract(NEW.termination_json,'$.causeCode') = 'completion-unconfirmed' AND json_extract(NEW.termination_json,'$.kind') = 'unknown') OR (json_extract(NEW.termination_json,'$.causeCode') = 'turn-unclassified' AND json_extract(NEW.termination_json,'$.kind') = 'unknown'))
  AND ((json_extract(NEW.termination_json,'$.kind') = 'completed' AND NEW.status = 'succeeded' AND NEW.quiescent = 1 AND json_type(NEW.termination_json,'$.handleDisposed') = 'true')
    OR (json_extract(NEW.termination_json,'$.kind') != 'completed' AND NEW.status != 'succeeded'))
)), 0) = 0 BEGIN SELECT RAISE(ABORT, 'foreground termination is invalid'); END;
CREATE TRIGGER delivery_foreground_termination_update BEFORE UPDATE OF termination_json,status,quiescent ON delivery_foreground_executions
   WHEN COALESCE((NEW.termination_json IS NULL OR (
  NEW.status != 'pending' AND json_valid(NEW.termination_json)
  AND length(CAST(NEW.termination_json AS BLOB)) <= 1024
  AND instr(CAST(NEW.termination_json AS BLOB), X'00') = 0
  AND (SELECT COUNT(*) FROM json_each(NEW.termination_json)) = 7
  AND NOT EXISTS (SELECT 1 FROM json_each(NEW.termination_json) WHERE key NOT IN ('protocol','producer','kind','causeCode','handleDisposed','effects','replay'))
  AND json_extract(NEW.termination_json,'$.protocol') = 'assistant-delivery/foreground-termination/v1'
  AND json_extract(NEW.termination_json,'$.producer') IN ('delivery-agent','native-web')
  AND json_type(NEW.termination_json,'$.handleDisposed') IN ('true','false')
  AND json_extract(NEW.termination_json,'$.effects') = 'unknown'
  AND json_extract(NEW.termination_json,'$.replay') = 'forbidden'
  AND ((json_extract(NEW.termination_json,'$.causeCode') = 'turn-completed' AND json_extract(NEW.termination_json,'$.kind') = 'completed') OR (json_extract(NEW.termination_json,'$.causeCode') = 'turn-error' AND json_extract(NEW.termination_json,'$.kind') = 'error') OR (json_extract(NEW.termination_json,'$.causeCode') = 'turn-max-tokens' AND json_extract(NEW.termination_json,'$.kind') = 'error') OR (json_extract(NEW.termination_json,'$.causeCode') = 'runtime-error' AND json_extract(NEW.termination_json,'$.kind') = 'error') OR (json_extract(NEW.termination_json,'$.causeCode') = 'execution-timeout' AND json_extract(NEW.termination_json,'$.kind') = 'timeout') OR (json_extract(NEW.termination_json,'$.causeCode') = 'turn-user-aborted' AND json_extract(NEW.termination_json,'$.kind') = 'owner-cancelled') OR (json_extract(NEW.termination_json,'$.causeCode') = 'owner-stop' AND json_extract(NEW.termination_json,'$.kind') = 'owner-cancelled') OR (json_extract(NEW.termination_json,'$.causeCode') = 'owner-new-session' AND json_extract(NEW.termination_json,'$.kind') = 'owner-cancelled') OR (json_extract(NEW.termination_json,'$.causeCode') = 'turn-aborted' AND json_extract(NEW.termination_json,'$.kind') = 'interrupted') OR (json_extract(NEW.termination_json,'$.causeCode') = 'lease-or-authority-lost' AND json_extract(NEW.termination_json,'$.kind') = 'interrupted') OR (json_extract(NEW.termination_json,'$.causeCode') = 'host-disposed' AND json_extract(NEW.termination_json,'$.kind') = 'interrupted') OR (json_extract(NEW.termination_json,'$.causeCode') = 'execution-aborted' AND json_extract(NEW.termination_json,'$.kind') = 'interrupted') OR (json_extract(NEW.termination_json,'$.causeCode') = 'turn-missing' AND json_extract(NEW.termination_json,'$.kind') = 'unknown') OR (json_extract(NEW.termination_json,'$.causeCode') = 'teardown-unconfirmed' AND json_extract(NEW.termination_json,'$.kind') = 'unknown') OR (json_extract(NEW.termination_json,'$.causeCode') = 'completion-unconfirmed' AND json_extract(NEW.termination_json,'$.kind') = 'unknown') OR (json_extract(NEW.termination_json,'$.causeCode') = 'turn-unclassified' AND json_extract(NEW.termination_json,'$.kind') = 'unknown'))
  AND ((json_extract(NEW.termination_json,'$.kind') = 'completed' AND NEW.status = 'succeeded' AND NEW.quiescent = 1 AND json_type(NEW.termination_json,'$.handleDisposed') = 'true')
    OR (json_extract(NEW.termination_json,'$.kind') != 'completed' AND NEW.status != 'succeeded'))
)), 0) = 0 BEGIN SELECT RAISE(ABORT, 'foreground termination is invalid'); END;
CREATE TRIGGER delivery_inbox_admission_after_insert
  AFTER INSERT ON inbox_messages
  BEGIN
    UPDATE delivery_inbox_admission_clock
    SET current_sequence = current_sequence + 1
    WHERE singleton = 1;
    INSERT INTO delivery_inbox_admissions(inbox_id, epoch, admission_sequence)
    SELECT NEW.id, instance.instance_id, clock.current_sequence
    FROM delivery_instance AS instance
    CROSS JOIN delivery_inbox_admission_clock AS clock
    WHERE instance.singleton = 1 AND clock.singleton = 1;
  END;
CREATE TRIGGER delivery_restart_inbox_claim_fence
    BEFORE UPDATE OF status ON inbox_messages
    WHEN NEW.status = 'claimed' AND OLD.status != 'claimed'
      AND EXISTS(SELECT 1 FROM delivery_restart_fence WHERE singleton = 1)
    BEGIN SELECT RAISE(ABORT, 'planned restart blocks new inbox claims'); END;
CREATE TRIGGER delivery_restart_outbox_claim_fence
    BEFORE UPDATE OF status ON outbox_messages
    WHEN NEW.status = 'attempting' AND OLD.status != 'attempting'
      AND NOT (NEW.idempotency_key GLOB 'inbound:*:maintenance'
        AND COALESCE(json_extract(NEW.intent_json, '$.format') = 'plain', 0)
        AND json_type(NEW.intent_json, '$.metadata') IS NULL
        AND json_type(NEW.intent_json, '$.approval') IS NULL
        AND json_type(NEW.intent_json, '$.modelPicker') IS NULL
        AND json_type(NEW.intent_json, '$.permissionPicker') IS NULL)
      AND EXISTS(SELECT 1 FROM delivery_restart_fence WHERE singleton = 1)
    BEGIN SELECT RAISE(ABORT, 'planned restart blocks new outbound sends'); END;
CREATE TRIGGER delivery_work_item_replies_no_delete BEFORE DELETE ON delivery_work_item_replies
    BEGIN SELECT RAISE(ABORT, 'work item reply source is durable'); END;
CREATE TRIGGER delivery_work_item_replies_selection_immutable BEFORE UPDATE ON delivery_work_item_replies
    WHEN (OLD.execution_parent_item_id IS NOT NULL AND NEW.execution_parent_item_id IS NOT OLD.execution_parent_item_id)
      OR (OLD.child_item_id IS NOT NULL AND (NEW.child_item_id IS NOT OLD.child_item_id OR NEW.child_plan_digest IS NOT OLD.child_plan_digest))
      OR (OLD.state = 'cancelled' AND NEW.state != 'cancelled')
      OR (OLD.state = 'routed' AND NEW.state = 'pending')
    BEGIN SELECT RAISE(ABORT, 'work item reply selection is immutable'); END;
CREATE TRIGGER delivery_work_item_replies_source_immutable
    BEFORE UPDATE OF inbox_id,stream_key,admission_sequence,source_digest,source_json ON delivery_work_item_replies
    BEGIN SELECT RAISE(ABORT, 'work item reply source is immutable'); END;
CREATE TRIGGER delivery_work_item_reports_no_delete BEFORE DELETE ON delivery_work_item_reports
    BEGIN SELECT RAISE(ABORT, 'work item report target is durable'); END;
CREATE TRIGGER delivery_work_item_reports_no_update BEFORE UPDATE ON delivery_work_item_reports
    BEGIN SELECT RAISE(ABORT, 'work item report target is immutable'); END;
PRAGMA user_version = 29;
