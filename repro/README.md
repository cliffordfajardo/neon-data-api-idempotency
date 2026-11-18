# Lost-response retry repro (PostgREST / Neon Data API)

Shows that retrying a write after a lost response creates duplicates, and that the
upsert workaround only covers rows with a natural key.

```sh
./run.sh        # needs Docker and Bun; uses 127.0.0.1:3098 and :3099
```

`run.sh` starts Postgres 17 and PostgREST v12.2.3 (a local stand-in for the
PostgREST-compatible Neon Data API), runs `repro.ts`, then removes the containers.

## What it does

- `schema.sql`: a `notes` table, an append-only `events_log`, and an RPC
  `like_note(note_id)` that increments `notes.likes` and appends a log row,
  and `like_note_once`, which does the same but dedupes on a receipt table.
  Requests use an HS256 JWT with `role: authenticated` and a `sub` claim,
  the same shape the Data API sees from Neon Auth.
- `repro.ts`: a small proxy forwards each request to PostgREST and waits for the
  reply, so the write has committed. On the first attempt it then withholds the
  reply. The client times out after 1 s and retries the identical request, as an
  offline write queue would.

Scenarios:

1. `POST /notes` with a server-generated id: duplicate row.
2. `POST /notes` with a client-generated id and `Prefer: resolution=merge-duplicates`: one row (the workaround works).
3. `POST /events_log` with the same header: duplicate event (no natural key to conflict on).
4. `POST /rpc/like_note`: counter is 2 and two log rows (upsert doesn't apply to RPCs).
5. `POST /rpc/like_note_once` with `Idempotency-Key`: one like. The RPC stores a receipt keyed on the header (via `request.headers`) in the same transaction and replays it. Reusing the key with a different body returns 422. This works today, but only as a hand-written RPC.

Captured output is in `output.txt`.
