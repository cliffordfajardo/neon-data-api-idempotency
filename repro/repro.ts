// Shows what happens when a write commits on the server but the client never sees the response,
// and the client (an offline write queue) retries the same request.
import { createHmac, randomUUID } from "node:crypto";

const API = "http://127.0.0.1:3099";
const PROXY_PORT = 3098;
const SECRET = "repro-secret-repro-secret-repro-secret-32b";

// --- HS256 JWT, shaped like a Neon Auth token as seen by the Data API (role + sub). ---
const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");
function jwt(claims: object) {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 }));
  const sig = createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
const TOKEN = jwt({ role: "authenticated", sub: "user-123" });

// --- A "flaky network" proxy. It forwards every request to PostgREST and waits for the
// response, so the write has committed. When asked to, it then never answers the client. ---
Bun.serve({
  port: PROXY_PORT,
  async fetch(req) {
    const drop = req.headers.get("x-drop-response") === "1";
    const headers = new Headers(req.headers);
    headers.delete("x-drop-response");
    const url = new URL(req.url);
    const upstream = await fetch(API + url.pathname + url.search, {
      method: req.method,
      headers,
      body: await req.arrayBuffer(),
    });
    const text = await upstream.text(); // the server has committed and replied
    if (drop) return new Promise<Response>(() => {}); // the reply is lost on the way back
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });
  },
});

// --- The client: POST, time out, retry once with the exact same request. ---
async function send(path: string, body: unknown, extra: Record<string, string>, dropResponse: boolean) {
  return fetch(`http://127.0.0.1:${PROXY_PORT}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...extra,
      ...(dropResponse ? { "x-drop-response": "1" } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1000),
  });
}

async function sendWithRetry(path: string, body: unknown, extra: Record<string, string> = {}) {
  try {
    await send(path, body, extra, true);
  } catch (e) {
    console.log(`  attempt 1: server committed, response lost -> client sees ${(e as Error).name}`);
  }
  const res = await send(path, body, extra, false);
  console.log(`  attempt 2 (retry): HTTP ${res.status} ${await res.text()}`);
}

async function get(path: string) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return res.json() as Promise<any[]>;
}

const verdict = (ok: boolean) => (ok ? "OK, one logical write" : "DUPLICATE");
let failures = 0;
function report(label: string, count: number, expected: number) {
  const ok = count === expected;
  if (!ok) failures++;
  console.log(`  result: ${label} = ${count} (expected ${expected}) -> ${verdict(ok)}\n`);
}

// 1. Plain insert with a server-generated id.
console.log("1) POST /notes, server-generated id");
const body1 = `plain insert ${randomUUID()}`;
await sendWithRetry("/notes", { body: body1 });
report("rows with this body", (await get(`/notes?body=eq.${encodeURIComponent(body1)}`)).length, 1);

// 2. Workaround: client-generated id + upsert. Works, because the row has a natural key.
console.log("2) POST /notes, client-generated id + Prefer: resolution=merge-duplicates (workaround)");
const noteId = randomUUID();
await sendWithRetry("/notes", { id: noteId, body: "upserted note" }, { Prefer: "resolution=merge-duplicates" });
report("rows with this id", (await get(`/notes?id=eq.${noteId}`)).length, 1);

// 3. Append-only log. No natural key, so the upsert header has nothing to conflict on.
console.log("3) POST /events_log, append-only, same upsert header");
await sendWithRetry("/events_log", { note_id: noteId, kind: "shared" }, { Prefer: "resolution=merge-duplicates" });
report("'shared' events", (await get(`/events_log?note_id=eq.${noteId}&kind=eq.shared`)).length, 1);

// 4. RPC with side effects (counter + log). Upsert semantics do not apply to RPCs.
console.log("4) POST /rpc/like_note, RPC that increments a counter and appends a log row");
await sendWithRetry("/rpc/like_note", { note_id: noteId });
const [note] = await get(`/notes?id=eq.${noteId}&select=likes`);
report("notes.likes", note.likes, 1);
report("'liked' events", (await get(`/events_log?note_id=eq.${noteId}&kind=eq.liked`)).length, 1);

// 5. Workaround today: an RPC that stores a receipt keyed on Idempotency-Key in the same transaction.
console.log("5) POST /rpc/like_note_once + Idempotency-Key, hand-written receipt table (workaround)");
const note2 = randomUUID();
await send("/notes", { id: note2, body: "second note" }, {}, false);
const key = randomUUID();
await sendWithRetry("/rpc/like_note_once", { note_id: note2 }, { "Idempotency-Key": key });
const [n2] = await get(`/notes?id=eq.${note2}&select=likes`);
report("notes.likes", n2.likes, 1);
const reuse = await send("/rpc/like_note_once", { note_id: noteId }, { "Idempotency-Key": key }, false);
console.log(`  same key, different body: HTTP ${reuse.status} ${await reuse.text()}\n`);

console.log(`${failures} of 6 checks produced duplicates after a single retry (cases 1, 3, 4).`);
process.exit(0);
