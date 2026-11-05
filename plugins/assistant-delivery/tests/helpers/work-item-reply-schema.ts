import type { DatabaseSync } from 'node:sqlite'

/** Remove only empty v29-v31 journals when reconstructing a genuinely older fixture. */
export function removeEmptyWorkItemReplySchema(database: DatabaseSync): void {
  const names = ['delivery_attention_audit','delivery_work_item_feedback','delivery_work_item_replies','delivery_work_item_reply_streams','delivery_work_item_reports'].filter(name =>
    database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name))
  for (const name of names) {
    if (database.prepare(`SELECT count(*) AS n FROM "${name}"`).get()?.n !== 0) {
      throw new Error('cannot downgrade a fixture with WorkItems report/reply history')
    }
  }
  for (const name of names) database.exec(`DROP TABLE "${name}"`)
}
