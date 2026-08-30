const [moduleUrl, databasePath] = process.argv.slice(2)

function send(message) {
  return new Promise((resolve, reject) => {
    if (process.send === undefined) {
      reject(new Error('SQLite race worker requires an IPC channel'))
      return
    }
    process.send(message, error => error === null ? resolve() : reject(error))
  })
}

const { openPreferenceDatabase } = await import(moduleUrl)

process.once('message', async message => {
  if (message !== 'open') return
  try {
    const database = openPreferenceDatabase(databasePath)
    const result = {
      schemaVersion: database.prepare('PRAGMA user_version').get().user_version,
      schemaTables: database.prepare(`
        SELECT count(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'preference_%'
      `).get().count,
      journalMode: database.prepare('PRAGMA journal_mode').get().journal_mode,
      secureDelete: database.prepare('PRAGMA secure_delete').get().secure_delete,
    }
    database.close()
    await send({ type: 'result', result })
  } catch (error) {
    await send({
      type: 'result',
      error: {
        name: error?.name ?? 'Error',
        code: error?.code,
        message: String(error?.message ?? error),
      },
    })
  } finally {
    process.disconnect()
  }
})

await send({ type: 'ready' })
