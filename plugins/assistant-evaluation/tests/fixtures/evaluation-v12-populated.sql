-- Genuine Evaluation schema12, generated from 1e48dccceaf48697604def4f0f7b7db3f09ab8aa runtime.
-- Includes baseline terminal, owner initial/correction, projection feed and legacy unknown work-item settlement.
PRAGMA foreign_keys=OFF;
CREATE TABLE evaluation_outcomes (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          payload_hash TEXT NOT NULL,
          scope_key TEXT NOT NULL,
          workspace TEXT NOT NULL,
          preset TEXT NOT NULL,
          situation TEXT NOT NULL,
          execution_status TEXT NOT NULL
            CHECK (execution_status IN ('succeeded', 'failed', 'timed-out', 'cancelled', 'unknown')),
          objective_status TEXT NOT NULL
            CHECK (objective_status IN ('achieved', 'partial', 'not-achieved', 'unknown')),
          delivery_status TEXT NOT NULL
            CHECK (delivery_status IN ('delivered', 'failed', 'not-required', 'unknown')),
          source_kind TEXT NOT NULL
            CHECK (source_kind IN ('automation', 'foreground', 'delivery', 'user-feedback', 'system', 'evaluator', 'import')),
          source_id TEXT NOT NULL,
          trust TEXT NOT NULL CHECK (trust IN ('trusted', 'self-reported', 'external')),
          evidence_json TEXT NOT NULL,
          metrics_json TEXT NOT NULL,
          cost_usd_micros INTEGER,
          latency_ms INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          tool_calls INTEGER,
          occurred_at INTEGER NOT NULL,
          recorded_at INTEGER NOT NULL,
          evaluator_id TEXT NOT NULL,
          evaluator_version TEXT NOT NULL,
          task_subject_key TEXT,
          task_subject_kind TEXT,
          task_subject_ref TEXT
        ) STRICT;
CREATE TABLE evaluation_owner_commands (
          operation_id TEXT PRIMARY KEY,
          payload_hash TEXT NOT NULL,
          outcome_id TEXT REFERENCES evaluation_outcomes(id),
          failure_code TEXT
        ) STRICT;
CREATE TABLE evaluation_owner_revisions (
          outcome_id TEXT PRIMARY KEY REFERENCES evaluation_outcomes(id),
          subject_key TEXT NOT NULL,
          lineage TEXT NOT NULL,
          version INTEGER NOT NULL,
          previous_outcome_id TEXT,
          action TEXT NOT NULL,
          command_json TEXT NOT NULL,
          UNIQUE(subject_key, lineage, version)
        ) STRICT;
CREATE TABLE evaluation_projection_outbox (
    evaluation_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('pending', 'recorded')),
    attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
    next_attempt_at INTEGER NOT NULL,
    last_failure_at INTEGER,
    last_failure_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (evaluation_id) REFERENCES evaluation_outcomes(id) ON DELETE RESTRICT
  ) STRICT;
CREATE TABLE evaluation_schema_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;
CREATE TABLE evaluation_scope_watermarks (
    scope_key TEXT PRIMARY KEY,
    watermark INTEGER NOT NULL CHECK (watermark >= 0),
    updated_at INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;
CREATE TABLE evaluation_self_assessments (
    id TEXT PRIMARY KEY,
    outcome_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload_hash TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    objective_status TEXT NOT NULL
      CHECK (objective_status IN ('achieved', 'partial', 'not-achieved', 'unknown')),
    evidence_json TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    evaluator_id TEXT NOT NULL,
    evaluator_version TEXT NOT NULL,
    FOREIGN KEY (outcome_id) REFERENCES evaluation_outcomes(id) ON DELETE RESTRICT
  ) STRICT;
CREATE TABLE evaluation_task_projection_feed_heads (
    subject_key TEXT PRIMARY KEY REFERENCES evaluation_task_projections(subject_key) ON DELETE RESTRICT,
    scope_key TEXT NOT NULL,
    watermark INTEGER NOT NULL CHECK (watermark >= 1)
  ) STRICT, WITHOUT ROWID;
CREATE TABLE evaluation_task_projections (
    subject_key TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('automation-run', 'foreground-turn', 'goal-step', 'goal-outcome', 'outcome')),
    subject_ref TEXT NOT NULL,
    primary_outcome_id TEXT,
    execution_outcome_id TEXT,
    objective_outcome_id TEXT,
    delivery_outcome_id TEXT,
    objective_conflicted INTEGER NOT NULL DEFAULT 0 CHECK (objective_conflicted IN (0, 1)),
    learning_version INTEGER NOT NULL DEFAULT 0 CHECK (learning_version >= 0),
    learning_digest TEXT CHECK (learning_digest IS NULL OR length(learning_digest) = 64),
    learning_disposition TEXT CHECK (learning_disposition IN ('upsert', 'retract')),
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (primary_outcome_id) REFERENCES evaluation_outcomes(id) ON DELETE RESTRICT,
    FOREIGN KEY (execution_outcome_id) REFERENCES evaluation_outcomes(id) ON DELETE RESTRICT,
    FOREIGN KEY (objective_outcome_id) REFERENCES evaluation_outcomes(id) ON DELETE RESTRICT,
    FOREIGN KEY (delivery_outcome_id) REFERENCES evaluation_outcomes(id) ON DELETE RESTRICT
  ) STRICT;
CREATE INDEX evaluation_outcomes_scope_situation_time
          ON evaluation_outcomes(scope_key, situation, occurred_at DESC, id DESC);
CREATE INDEX evaluation_outcomes_scope_time
          ON evaluation_outcomes(scope_key, occurred_at DESC, id DESC);
CREATE INDEX evaluation_outcomes_summary
          ON evaluation_outcomes(scope_key, occurred_at, situation, trust);
CREATE INDEX evaluation_outcomes_task_subject
    ON evaluation_outcomes(task_subject_key, recorded_at, id);
CREATE INDEX evaluation_projection_outbox_due
    ON evaluation_projection_outbox(status, next_attempt_at, created_at, evaluation_id);
CREATE INDEX evaluation_self_assessments_outcome_time
    ON evaluation_self_assessments(outcome_id, occurred_at DESC, id DESC);
CREATE INDEX evaluation_self_assessments_scope_time
    ON evaluation_self_assessments(scope_key, occurred_at DESC, id DESC);
CREATE UNIQUE INDEX evaluation_task_projection_feed_scope_watermark
    ON evaluation_task_projection_feed_heads(scope_key, watermark);
CREATE INDEX evaluation_task_projections_scope_time
    ON evaluation_task_projections(scope_key, updated_at DESC, subject_key);
CREATE VIEW evaluation_task_projection_view AS
  SELECT
    projection.subject_key AS task_subject_key,
    projection.subject_kind AS task_subject_kind,
    projection.subject_ref AS task_subject_ref,
    projection.objective_conflicted AS task_objective_conflicted,
    projection.primary_outcome_id AS task_primary_outcome_id,
    projection.execution_outcome_id AS task_execution_outcome_id,
    projection.objective_outcome_id AS task_objective_outcome_id,
    projection.delivery_outcome_id AS task_delivery_outcome_id,
    projection.learning_version AS task_learning_version,
    projection.learning_digest AS task_learning_digest,
    projection.learning_disposition AS task_learning_disposition,
    primary_outcome.id,
    primary_outcome.idempotency_key,
    primary_outcome.payload_hash,
    primary_outcome.scope_key,
    primary_outcome.workspace,
    primary_outcome.preset,
    primary_outcome.situation,
    COALESCE(execution_outcome.execution_status, 'unknown') AS execution_status,
    CASE
      WHEN projection.objective_conflicted = 1 THEN 'unknown'
      ELSE COALESCE(objective_outcome.objective_status, 'unknown')
    END AS objective_status,
    COALESCE(delivery_outcome.delivery_status, 'unknown') AS delivery_status,
    primary_outcome.source_kind,
    primary_outcome.source_id,
    primary_outcome.trust,
    primary_outcome.evidence_json,
    COALESCE(execution_outcome.metrics_json, '{}') AS metrics_json,
    execution_outcome.cost_usd_micros,
    execution_outcome.latency_ms,
    execution_outcome.input_tokens,
    execution_outcome.output_tokens,
    execution_outcome.tool_calls,
    COALESCE(execution_outcome.occurred_at, primary_outcome.occurred_at) AS occurred_at,
    projection.updated_at AS recorded_at,
    primary_outcome.evaluator_id,
    primary_outcome.evaluator_version
  FROM evaluation_task_projections projection
  JOIN evaluation_outcomes primary_outcome ON primary_outcome.id = projection.primary_outcome_id
  LEFT JOIN evaluation_outcomes execution_outcome ON execution_outcome.id = projection.execution_outcome_id
  LEFT JOIN evaluation_outcomes objective_outcome ON objective_outcome.id = projection.objective_outcome_id
  LEFT JOIN evaluation_outcomes delivery_outcome ON delivery_outcome.id = projection.delivery_outcome_id;
INSERT INTO evaluation_outcomes(id,idempotency_key,payload_hash,scope_key,workspace,preset,situation,execution_status,objective_status,delivery_status,source_kind,source_id,trust,evidence_json,metrics_json,cost_usd_micros,latency_ms,input_tokens,output_tokens,tool_calls,occurred_at,recorded_at,evaluator_id,evaluator_version,task_subject_key,task_subject_kind,task_subject_ref) VALUES ('outcome-26058860-698f-414d-aca7-c63a96cf5e32','retained-terminal','a4805a0a2ef7e6f0da1228cb5e15548d3f6f51ee5a2cd1e87b8c5bf638041e65','["/work/owner","primary"]','/work/owner','primary','automation:retained','succeeded','unknown','unknown','automation','assistant-automations','trusted','[{"kind":"automation-run","ref":"retained-run"}]','{"toolCalls":2}',NULL,NULL,NULL,NULL,2.0,2000.0,3000.0,'assistant-automations','terminal-v1','["[\"/work/owner\",\"primary\"]","automation-run","retained-run"]','automation-run','retained-run');
INSERT INTO evaluation_outcomes(id,idempotency_key,payload_hash,scope_key,workspace,preset,situation,execution_status,objective_status,delivery_status,source_kind,source_id,trust,evidence_json,metrics_json,cost_usd_micros,latency_ms,input_tokens,output_tokens,tool_calls,occurred_at,recorded_at,evaluator_id,evaluator_version,task_subject_key,task_subject_kind,task_subject_ref) VALUES ('outcome-1bf9fe7f-8190-45a1-b601-b54a7f24e7a7','retained-owner','b620226b792d3c7f04baddbb9fe6abfd3cc787e9c83a13a28c73faa5e418f900','["/work/owner","primary"]','/work/owner','primary','automation:retained','succeeded','achieved','delivered','user-feedback','assistant-delivery/typed-owner-feedback','trusted','[{"kind":"automation-run","ref":"retained-run"},{"kind":"delivery-outbox","ref":"retained-outbox"}]','{}',NULL,NULL,NULL,NULL,NULL,2100.0,3000.0,'assistant-delivery-owner-feedback','2','["[\"/work/owner\",\"primary\"]","automation-run","retained-run"]','automation-run','retained-run');
INSERT INTO evaluation_outcomes(id,idempotency_key,payload_hash,scope_key,workspace,preset,situation,execution_status,objective_status,delivery_status,source_kind,source_id,trust,evidence_json,metrics_json,cost_usd_micros,latency_ms,input_tokens,output_tokens,tool_calls,occurred_at,recorded_at,evaluator_id,evaluator_version,task_subject_key,task_subject_kind,task_subject_ref) VALUES ('outcome-5ae75f89-3f1d-42d0-8cc7-0b89588a21db','retained-corrected','d7916d098773f87a812fac12a3e18d6fdf65f0ae01636bf49bfcb1828282cd6c','["/work/owner","primary"]','/work/owner','primary','automation:retained','succeeded','not-achieved','delivered','user-feedback','assistant-delivery/typed-owner-feedback','trusted','[{"kind":"automation-run","ref":"retained-run"},{"kind":"delivery-outbox","ref":"retained-outbox"}]','{}',NULL,NULL,NULL,NULL,NULL,2200.0,3000.0,'assistant-delivery-owner-feedback','2','["[\"/work/owner\",\"primary\"]","automation-run","retained-run"]','automation-run','retained-run');
INSERT INTO evaluation_outcomes(id,idempotency_key,payload_hash,scope_key,workspace,preset,situation,execution_status,objective_status,delivery_status,source_kind,source_id,trust,evidence_json,metrics_json,cost_usd_micros,latency_ms,input_tokens,output_tokens,tool_calls,occurred_at,recorded_at,evaluator_id,evaluator_version,task_subject_key,task_subject_kind,task_subject_ref) VALUES ('outcome-c5e22f56-36b5-463d-87ea-ba951b2f0ac7','legacy-work-item-settlement','07f86cc04c7ea084e3920b0b269504996b09db48941ed8265806f2c6fb1ce508','["/work/owner","primary"]','/work/owner','primary','work-item:owner-continuation','succeeded','unknown','unknown','system','assistant-work-items','trusted','[{"kind":"work-item","ref":"legacy-work-item"},{"kind":"work-item-outcome","ref":"legacy-work-item#1","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]','{"toolCalls":2}',NULL,NULL,NULL,NULL,2.0,2000.0,3000.0,'assistant-work-items','unverified-v1','["[\"/work/owner\",\"primary\"]","outcome","outcome-c5e22f56-36b5-463d-87ea-ba951b2f0ac7"]','outcome','outcome-c5e22f56-36b5-463d-87ea-ba951b2f0ac7');
INSERT INTO evaluation_owner_commands(operation_id,payload_hash,outcome_id,failure_code) VALUES ('retained-initial','42c46cc0c8b46bb44b5ebd672604adcf460c3e1455b8aaf5429725b537989a9f','outcome-1bf9fe7f-8190-45a1-b601-b54a7f24e7a7',NULL);
INSERT INTO evaluation_owner_commands(operation_id,payload_hash,outcome_id,failure_code) VALUES ('retained-correction','eb29d0ca602c159844978fbf330e9b7f53f9a988195417a32b1111663fd30128','outcome-5ae75f89-3f1d-42d0-8cc7-0b89588a21db',NULL);
INSERT INTO evaluation_owner_revisions(outcome_id,subject_key,lineage,version,previous_outcome_id,action,command_json) VALUES ('outcome-1bf9fe7f-8190-45a1-b601-b54a7f24e7a7','["[\"/work/owner\",\"primary\"]","automation-run","retained-run"]','["owner-record",1]',1.0,NULL,'initial','{"operationId":"retained-initial","principalRecordId":"owner-record","principalVersion":1,"action":"initial"}');
INSERT INTO evaluation_owner_revisions(outcome_id,subject_key,lineage,version,previous_outcome_id,action,command_json) VALUES ('outcome-5ae75f89-3f1d-42d0-8cc7-0b89588a21db','["[\"/work/owner\",\"primary\"]","automation-run","retained-run"]','["owner-record",1]',2.0,'outcome-1bf9fe7f-8190-45a1-b601-b54a7f24e7a7','correct','{"operationId":"retained-correction","principalRecordId":"owner-record","principalVersion":1,"action":"correct","expectedVersion":1,"previousStatus":"achieved"}');
INSERT INTO evaluation_projection_outbox(evaluation_id,status,attempt_count,next_attempt_at,last_failure_at,last_failure_code,created_at,updated_at) VALUES ('outcome-26058860-698f-414d-aca7-c63a96cf5e32','pending',0.0,3000.0,NULL,NULL,3000.0,3000.0);
INSERT INTO evaluation_projection_outbox(evaluation_id,status,attempt_count,next_attempt_at,last_failure_at,last_failure_code,created_at,updated_at) VALUES ('outcome-1bf9fe7f-8190-45a1-b601-b54a7f24e7a7','pending',0.0,3000.0,NULL,NULL,3000.0,3000.0);
INSERT INTO evaluation_projection_outbox(evaluation_id,status,attempt_count,next_attempt_at,last_failure_at,last_failure_code,created_at,updated_at) VALUES ('outcome-5ae75f89-3f1d-42d0-8cc7-0b89588a21db','pending',0.0,3000.0,NULL,NULL,3000.0,3000.0);
INSERT INTO evaluation_projection_outbox(evaluation_id,status,attempt_count,next_attempt_at,last_failure_at,last_failure_code,created_at,updated_at) VALUES ('outcome-c5e22f56-36b5-463d-87ea-ba951b2f0ac7','pending',0.0,3000.0,NULL,NULL,3000.0,3000.0);
INSERT INTO evaluation_schema_meta(key,value) VALUES ('schema-version','12');
INSERT INTO evaluation_scope_watermarks(scope_key,watermark,updated_at) VALUES ('["/work/owner","primary"]',4.0,3000.0);
INSERT INTO evaluation_task_projection_feed_heads(subject_key,scope_key,watermark) VALUES ('["[\"/work/owner\",\"primary\"]","automation-run","retained-run"]','["/work/owner","primary"]',3.0);
INSERT INTO evaluation_task_projection_feed_heads(subject_key,scope_key,watermark) VALUES ('["[\"/work/owner\",\"primary\"]","outcome","outcome-c5e22f56-36b5-463d-87ea-ba951b2f0ac7"]','["/work/owner","primary"]',4.0);
INSERT INTO evaluation_task_projections(subject_key,scope_key,subject_kind,subject_ref,primary_outcome_id,execution_outcome_id,objective_outcome_id,delivery_outcome_id,objective_conflicted,learning_version,learning_digest,learning_disposition,updated_at) VALUES ('["[\"/work/owner\",\"primary\"]","automation-run","retained-run"]','["/work/owner","primary"]','automation-run','retained-run','outcome-26058860-698f-414d-aca7-c63a96cf5e32','outcome-26058860-698f-414d-aca7-c63a96cf5e32','outcome-5ae75f89-3f1d-42d0-8cc7-0b89588a21db','outcome-5ae75f89-3f1d-42d0-8cc7-0b89588a21db',0.0,3.0,'f4651075c93ac4acbf6a5fcc2b355f531899ff86ba1db77fb2e6de1e054a387d','upsert',3000.0);
INSERT INTO evaluation_task_projections(subject_key,scope_key,subject_kind,subject_ref,primary_outcome_id,execution_outcome_id,objective_outcome_id,delivery_outcome_id,objective_conflicted,learning_version,learning_digest,learning_disposition,updated_at) VALUES ('["[\"/work/owner\",\"primary\"]","outcome","outcome-c5e22f56-36b5-463d-87ea-ba951b2f0ac7"]','["/work/owner","primary"]','outcome','outcome-c5e22f56-36b5-463d-87ea-ba951b2f0ac7','outcome-c5e22f56-36b5-463d-87ea-ba951b2f0ac7','outcome-c5e22f56-36b5-463d-87ea-ba951b2f0ac7','outcome-c5e22f56-36b5-463d-87ea-ba951b2f0ac7','outcome-c5e22f56-36b5-463d-87ea-ba951b2f0ac7',0.0,1.0,'b542efd6f6325fe00076cf78da067e33d74322343b77a9995c297ba6c6a80106','retract',3000.0);
PRAGMA user_version=12;
PRAGMA foreign_keys=ON;
