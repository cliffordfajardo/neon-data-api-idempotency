-- Roles mirror the Data API setup: requests arrive with a JWT whose `role` claim is `authenticated`.
create role authenticator login password 'authpass' noinherit;
create role anon nologin;
create role authenticated nologin;
grant anon, authenticated to authenticator;

create function jwt_sub() returns text language sql stable
as $$ select current_setting('request.jwt.claims', true)::json ->> 'sub' $$;

-- A plain table. `id` can be server-generated or client-generated.
create table notes (
  id      uuid primary key default gen_random_uuid(),
  user_id text not null default jwt_sub(),
  body    text not null,
  likes   int  not null default 0
);

-- An append-only log. Two identical rows can be legitimate, so there is no natural key.
create table events_log (
  id      bigserial primary key,
  user_id text not null default jwt_sub(),
  note_id uuid not null,
  kind    text not null
);

-- An RPC with side effects: bumps a counter and appends to the log.
create function like_note(note_id uuid) returns int language sql volatile as $$
  insert into events_log (note_id, kind) values (like_note.note_id, 'liked');
  update notes set likes = likes + 1 where id = like_note.note_id returning likes;
$$;

grant usage on schema public to authenticated;
grant select, insert, update on notes, events_log to authenticated;
grant usage on sequence events_log_id_seq to authenticated;
grant execute on function like_note(uuid), jwt_sub() to authenticated;

-- Workaround available today: a hand-written RPC that dedupes on the Idempotency-Key header.
-- PostgREST exposes request headers to SQL as `request.headers`. The receipt and the write
-- commit in one transaction. A concurrent duplicate blocks on the receipt's unique key.
create table idempotency_receipts (
  user_id     text not null default jwt_sub(),
  key         text not null,
  fingerprint text not null,
  response    jsonb,
  primary key (user_id, key)
);

create function like_note_once(note_id uuid) returns jsonb language plpgsql volatile as $$
declare
  k  text := current_setting('request.headers', true)::json ->> 'idempotency-key';
  fp text := md5('like_note_once:' || note_id);
  r  idempotency_receipts;
  result jsonb;
begin
  if k is null then
    raise sqlstate 'PT400' using message = 'Idempotency-Key header required';
  end if;
  insert into idempotency_receipts (key, fingerprint) values (k, fp)
    on conflict do nothing returning * into r;
  if not found then
    select * into r from idempotency_receipts where user_id = jwt_sub() and key = k;
    if r.fingerprint <> fp then
      raise sqlstate 'PT422' using message = 'Idempotency-Key reused with a different request';
    end if;
    return r.response;  -- replay the stored result
  end if;
  result := jsonb_build_object('likes', like_note(note_id));
  update idempotency_receipts set response = result where user_id = jwt_sub() and key = k;
  return result;
end $$;

grant select, insert, update on idempotency_receipts to authenticated;
grant execute on function like_note_once(uuid) to authenticated;
