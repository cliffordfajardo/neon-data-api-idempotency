// TanStack DB offline-transactions: each queued transaction has a stable idempotencyKey,
// and the docs say the server must dedupe on it (a crash can replay an applied request).
startOfflineExecutor({
  collections: { events },
  mutationFns: {
    logEvent: async ({ transaction, idempotencyKey }) => {
      const res = await fetch(`${DATA_API_URL}/events_log`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json',
                   'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(transaction.mutations[0].modified),
      })
      if (res.status === 422) throw new NonRetriableError('key reused with a different body')
      if (!res.ok) throw new Error(`HTTP ${res.status}`) // retried later with the same key
    },
  },
})
