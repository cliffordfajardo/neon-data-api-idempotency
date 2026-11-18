# Idempotency-Key for the Neon Data API

**Ask:** honor an [`Idempotency-Key`](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) header on Data API writes (table `POST`/`PATCH`/`DELETE` and `/rpc`).

**Why:** if a write commits but the response is lost, the client can't safely retry it.
Upserts (`Prefer: resolution=merge-duplicates`) only cover rows with a natural key, not
appends, counters or RPCs with side effects. Offline-first clients hit this on every reconnect.

## Not a one-off: every offline write queue already has the key

| Library | Stable id per write | Delivery | Backend contract (from their docs) |
|---|---|---|---|
| [TanStack DB offline-transactions](https://github.com/TanStack/db/blob/main/docs/guides/offline-transactions.md) | `idempotencyKey` per transaction | at-least-once | "Make the server treat repeated keys as one logical mutation." |
| [PowerSync](https://github.com/powersync-ja/powersync-docs/blob/d4406522128162ac792f45d94874d57b2477295e/handling-writes/handling-update-conflicts.mdx#L12-L20) | `getClientId()` + `CrudEntry.clientId` (per-client incrementing op id) | at-least-once | "The operations must be idempotent … the backend may receive the same operation multiple times." |
| [Syncular](https://github.com/syncular/syncular/blob/c9065f5559c684f2cc8d73bd455621aa52e79139/apps/docs/src/content/concepts-commits.md#L63-L85) | `(clientId, clientCommitId)` | at-least-once | Its own server stores the outcome per commit id and replays it. That's this proposal, built into a sync server. |
| [Replicache](https://doc.replicache.dev/strategies/row-version#push) | `(clientID, mutation.id)` | retries until confirmed | Server tracks `lastMutationID` per client in the same transaction. |
| [supabase-js / postgrest-js](https://github.com/supabase/supabase-js/blob/f5013780c00ae1796922a103f659ded2e2503c00/packages/core/postgrest-js/src/fetchWithRetry.ts#L32-L76) | none | retries `GET`/`HEAD`/`OPTIONS` only | A failed write goes back to the app, which has to work out whether retrying is safe. |

The first two can point straight at the Data API ([`examples/`](examples)) if it dedupes on the key.
Syncular and Replicache show that sync engines with their own server already do it.

## Proposed behavior

```
key scope   = (role, jwt.sub)            fingerprint = hash(method, path, query, body)
first seen  -> run request; store key + fingerprint + response in the same transaction (TTL, e.g. 24h)
replay      -> return the stored response
in flight   -> 409            different fingerprint -> 422            5xx -> not stored
```

## Repro (`cd repro && ./run.sh`, needs Docker + Bun)

Postgres + PostgREST v12 as a stand-in for the Data API. Each write commits, then the response is dropped once and the client retries.

```
1) POST /notes (server id)                         -> 2 rows        DUPLICATE
2) POST /notes (client id + merge-duplicates)      -> 1 row         ok
3) POST /events_log (append-only)                  -> 2 events      DUPLICATE
4) POST /rpc/like_note (counter + log)             -> likes = 2     DUPLICATE
5) POST /rpc/like_note_once + Idempotency-Key      -> likes = 1     ok; reused key + other body -> 422
```

Case 5 is the workaround that works on stock PostgREST today. The RPC reads
`current_setting('request.headers')::json->>'idempotency-key'` and commits a receipt row
in the same transaction ([`schema.sql`](repro/schema.sql)). It works, but every write has to be
a hand-written RPC. The proposal makes it a header.

## Alternatives

| Option | Verdict |
|---|---|
| Natural-key upserts | Only "create or replace" (case 2). |
| `request_id unique` column per table | Inserts only. Needs a schema change per table, returns 409 instead of the original response. |
| Receipt-table RPC (case 5) | Works today, but means hand-written RPCs and TTL cleanup for every write. **Best interim option.** |
| Per-client counter (Replicache-style `last_mutation_id`) | Cheap, but needs ordered delivery and doesn't replay the response. Could be offered alongside the header. |
| `Prefer: idempotency-key=…` | Same server work, non-standard. Stock PostgREST ignores unknown prefs (rejects under `handling=strict`). |
| `If-None-Match: *` | Create-at-known-URI only. Can't identify an append or an RPC call. |

Related: PostgREST [#2998](https://github.com/PostgREST/postgrest/issues/2998) (open, same proposal; blocked on where to store keys across instances), [#1424](https://github.com/PostgREST/postgrest/issues/1424) (same mobile problem).

*Not verified against Neon itself: the repro uses upstream PostgREST, and whether the Data API forwards custom request headers to `request.headers` hasn't been checked.*
