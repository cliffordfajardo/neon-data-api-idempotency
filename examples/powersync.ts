// PowerSync upload connector: the docs require idempotent backend operations and say the
// per-client incrementing op id (CrudEntry.clientId) can be used to dedupe.
async uploadData(db: AbstractPowerSyncDatabase) {
  const tx = await db.getNextCrudTransaction()
  if (!tx) return
  const clientDbId = await db.getClientId()
  for (const op of tx.crud) {
    const res = await fetch(`${DATA_API_URL}/${op.table}`, {
      method: op.op === 'PUT' ? 'POST' : op.op === 'PATCH' ? 'PATCH' : 'DELETE', // filters omitted
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json',
                 'Idempotency-Key': `${clientDbId}:${op.clientId}` }, // stable across retries
      body: JSON.stringify({ id: op.id, ...op.opData }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`) // PowerSync retries the whole transaction
  }
  await tx.complete()
}
