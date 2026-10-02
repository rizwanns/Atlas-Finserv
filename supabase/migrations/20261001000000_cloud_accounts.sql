-- Atlas cloud accounts: owner-approved signups + cloud-only data.
-- Safe to run on the existing project: every statement is idempotent and the
-- existing atlas_state table/policies are kept; approval is enforced with a
-- RESTRICTIVE policy that is ANDed with whatever permissive policies exist.

-- ---------- per-user data (one JSON blob per account) ----------
create table if not exists public.atlas_state (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null,
  device     text,
  rev        bigint not null default 1,
  updated_at timestamptz not null default now()
);

-- the app relies on rev moving forward on every write (optimistic concurrency)
create or replace function public.atlas_state_bump() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.rev := old.rev + 1;
  new.updated_at := now();
  return new;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.atlas_state'::regclass and not t.tgisinternal
      and t.tgtype & 16 = 16                       -- fires on UPDATE
      and pg_get_functiondef(p.oid) ~* 'rev'
  ) then
    create trigger atlas_state_bump before update on public.atlas_state
      for each row execute function public.atlas_state_bump();
  end if;
end $$;

alter table public.atlas_state enable row level security;

-- ---------- profiles: approval status ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  status      text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);
alter table public.profiles enable row level security;

drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
-- no insert/update/delete policies: only the trigger and the service role change status
revoke insert, update, delete on public.profiles from anon, authenticated;

-- ---------- approval tokens (service role only — never readable by users) ----------
create table if not exists public.signup_tokens (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  token       uuid not null default gen_random_uuid(),
  notified_at timestamptz
);
alter table public.signup_tokens enable row level security;
revoke all on public.signup_tokens from anon, authenticated;

-- ---------- new signup → pending profile (owner auto-approved) ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, status, decided_at)
  values (
    new.id, lower(new.email),
    case when lower(new.email) = 'rizwanmoulavi@gmail.com' then 'approved' else 'pending' end,
    case when lower(new.email) = 'rizwanmoulavi@gmail.com' then now() end
  )
  on conflict (id) do nothing;
  insert into public.signup_tokens (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- existing accounts from the old Cloud Sync need approval too (owner excepted)
insert into public.profiles (id, email, status, decided_at)
select u.id, lower(u.email),
       case when lower(u.email) = 'rizwanmoulavi@gmail.com' then 'approved' else 'pending' end,
       case when lower(u.email) = 'rizwanmoulavi@gmail.com' then now() end
from auth.users u
on conflict (id) do nothing;
insert into public.signup_tokens (user_id) select id from auth.users on conflict (user_id) do nothing;

-- ---------- only approved accounts can touch their data ----------
create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and status = 'approved')
$$;
revoke execute on function public.is_approved() from anon;

drop policy if exists "atlas_state: own row" on public.atlas_state;
create policy "atlas_state: own row" on public.atlas_state
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "atlas_state: approved only" on public.atlas_state;
create policy "atlas_state: approved only" on public.atlas_state
  as restrictive for all to authenticated
  using ((select public.is_approved()))
  with check ((select public.is_approved()));

revoke all on public.atlas_state from anon;

-- the pre-existing atlas_snapshots history table (written by the atlas_state rev
-- trigger) is also only readable by approved accounts
do $$ begin
  if to_regclass('public.atlas_snapshots') is not null then
    execute 'drop policy if exists "atlas_snapshots: approved only" on public.atlas_snapshots';
    execute 'create policy "atlas_snapshots: approved only" on public.atlas_snapshots
               as restrictive for all to authenticated using ((select public.is_approved()))';
  end if;
end $$;

-- 2026-10-02: owner approval switched off. New accounts are approved on creation;
-- the owner can still put an account on hold by setting profiles.status.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, status, decided_at)
  values (new.id, lower(new.email), 'approved', now())
  on conflict (id) do nothing;
  insert into public.signup_tokens (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end $$;
update public.profiles set status = 'approved', decided_at = coalesce(decided_at, now()) where status = 'pending';
