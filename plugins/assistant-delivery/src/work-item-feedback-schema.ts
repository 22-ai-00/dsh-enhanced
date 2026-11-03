export const workItemFeedbackSchema = `
  CREATE TABLE delivery_work_item_feedback (
    inbox_id TEXT PRIMARY KEY REFERENCES inbox_messages(id),
    operation_id TEXT NOT NULL UNIQUE,
    admission_sequence INTEGER NOT NULL UNIQUE CHECK(admission_sequence>=1),
    item_id TEXT NOT NULL,
    source_digest TEXT NOT NULL CHECK(length(source_digest)=64),
    source_json TEXT NOT NULL CHECK(json_valid(source_json)),
    state TEXT NOT NULL CHECK(state IN ('pending','frozen','recorded','conflict','cancelled')),
    command_json TEXT CHECK(command_json IS NULL OR json_valid(command_json)),
    proof_digest TEXT CHECK(proof_digest IS NULL OR length(proof_digest)=64),
    canonical_json TEXT CHECK(canonical_json IS NULL OR json_valid(canonical_json)),
    CHECK(state!='frozen' OR (command_json IS NOT NULL AND proof_digest IS NOT NULL)),
    CHECK(state!='recorded' OR canonical_json IS NOT NULL)
  ) STRICT;
  CREATE INDEX delivery_work_item_feedback_pending ON delivery_work_item_feedback(state,admission_sequence);
  CREATE TRIGGER delivery_work_item_feedback_source_immutable
    BEFORE UPDATE OF inbox_id,operation_id,admission_sequence,item_id,source_digest,source_json ON delivery_work_item_feedback
    BEGIN SELECT RAISE(ABORT,'work item feedback source is immutable'); END;
  CREATE TRIGGER delivery_work_item_feedback_selection_immutable BEFORE UPDATE ON delivery_work_item_feedback
    WHEN (OLD.command_json IS NOT NULL AND NEW.command_json IS NOT OLD.command_json)
      OR (OLD.proof_digest IS NOT NULL AND NEW.proof_digest IS NOT OLD.proof_digest)
      OR (OLD.canonical_json IS NOT NULL AND NEW.canonical_json IS NOT OLD.canonical_json)
      OR (OLD.state IN ('recorded','conflict','cancelled') AND NEW.state!=OLD.state)
    BEGIN SELECT RAISE(ABORT,'work item feedback selection is immutable'); END;
  CREATE TRIGGER delivery_work_item_feedback_no_delete BEFORE DELETE ON delivery_work_item_feedback
    BEGIN SELECT RAISE(ABORT,'work item feedback source is durable'); END;
`
