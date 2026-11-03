/** Delivery-owned authority and handoff journals. Input and report identity never change after admission. */
export const workItemRepliesSchema = `
  CREATE TABLE delivery_work_item_reports (
    outbox_id TEXT PRIMARY KEY REFERENCES outbox_messages(id),
    intent_hash TEXT NOT NULL CHECK(length(intent_hash)=64),
    target_json TEXT NOT NULL CHECK(json_valid(target_json)),
    binding_json TEXT NOT NULL CHECK(json_valid(binding_json))
  ) STRICT;
  CREATE TRIGGER delivery_work_item_reports_no_update BEFORE UPDATE ON delivery_work_item_reports
    BEGIN SELECT RAISE(ABORT, 'work item report target is immutable'); END;
  CREATE TRIGGER delivery_work_item_reports_no_delete BEFORE DELETE ON delivery_work_item_reports
    BEGIN SELECT RAISE(ABORT, 'work item report target is durable'); END;
  CREATE TABLE delivery_work_item_reply_streams (
    stream_key TEXT PRIMARY KEY CHECK(length(stream_key)=64),
    head_item_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>=0)
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
  CREATE INDEX delivery_work_item_replies_pending ON delivery_work_item_replies(state, admission_sequence);
  CREATE TRIGGER delivery_work_item_replies_source_immutable
    BEFORE UPDATE OF inbox_id,stream_key,admission_sequence,source_digest,source_json ON delivery_work_item_replies
    BEGIN SELECT RAISE(ABORT, 'work item reply source is immutable'); END;
  CREATE TRIGGER delivery_work_item_replies_selection_immutable BEFORE UPDATE ON delivery_work_item_replies
    WHEN (OLD.execution_parent_item_id IS NOT NULL AND NEW.execution_parent_item_id IS NOT OLD.execution_parent_item_id)
      OR (OLD.child_item_id IS NOT NULL AND (NEW.child_item_id IS NOT OLD.child_item_id OR NEW.child_plan_digest IS NOT OLD.child_plan_digest))
      OR (OLD.state = 'cancelled' AND NEW.state != 'cancelled')
      OR (OLD.state = 'routed' AND NEW.state = 'pending')
    BEGIN SELECT RAISE(ABORT, 'work item reply selection is immutable'); END;
  CREATE TRIGGER delivery_work_item_replies_no_delete BEFORE DELETE ON delivery_work_item_replies
    BEGIN SELECT RAISE(ABORT, 'work item reply source is durable'); END;
`
