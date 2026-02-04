-- supabase/migrations/20260128_push_tokens.sql
-- Push tokens + SOS queue + trigger that enqueues notifications on SOS
-- ✅ FIXED: no longer references NEW.display_name (tracking_sessions doesn't have it)
-- ✅ Instead: pulls display_name from public.devices

-- Enable UUID generator if not already enabled
create extension if not exists pgcrypto;

-- ============================================
-- SOS NOTIFICATION QUEUE TABLE (create first)
-- ============================================
create table if not exists public.sos_notification_queue (
  id uuid default gen_random_uuid() primary key,

  -- enforce referential integrity to groups
  group_id uuid not null references public.groups(id) on delete cascade,

  sender_device_id text not null,
  payload jsonb not null,

  status text default 'pending'
    check (status in ('pending','processing','sent','failed')),

  error_message text,
  created_at timestamptz default now(),
  processed_at timestamptz
);

create index if not exists idx_sos_queue_status
  on public.sos_notification_queue(status)
  where status = 'pending';

-- ============================================
-- PUSH TOKENS TABLE
-- ============================================
create table if not exists public.push_tokens (
  id uuid default gen_random_uuid() primary key,
  device_id text not null unique,

  group_id uuid references public.groups(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,

  push_token text not null,
  platform text not null check (platform in ('ios','android')),

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_push_tokens_group_id on public.push_tokens(group_id);
create index if not exists idx_push_tokens_device_id on public.push_tokens(device_id);

-- Updated-at trigger helper (shared utility)
create or replace function public.update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trigger_push_tokens_updated_at on public.push_tokens;
create trigger trigger_push_tokens_updated_at
before update on public.push_tokens
for each row execute function public.update_updated_at();

-- ============================================
-- RLS: push_tokens
-- ============================================
alter table public.push_tokens enable row level security;

drop policy if exists "Users can manage own push tokens" on public.push_tokens;
create policy "Users can manage own push tokens"
on public.push_tokens
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can read group push tokens" on public.push_tokens;
create policy "Users can read group push tokens"
on public.push_tokens
for select
using (
  group_id in (
    select gm.group_id
    from public.group_members gm
    where gm.user_id = auth.uid()
  )
);

-- ============================================
-- FUNCTION: notify_fleet_sos (guard TG_OP)
-- ✅ FIXED: get display_name from public.devices (not tracking_sessions)
-- ============================================
create or replace function public.notify_fleet_sos()
returns trigger as $$
declare
  payload jsonb;
  resolved_name text;
begin
  -- Resolve display name from devices table (single source of truth)
  select d.display_name
    into resolved_name
  from public.devices d
  where d.device_id = new.device_id
  limit 1;

  if tg_op = 'INSERT' then
    if new.status = 'SOS' then
      payload := jsonb_build_object(
        'device_id', new.device_id,
        'display_name', coalesce(resolved_name, 'Fleet Member'),
        'latitude', new.latitude,
        'longitude', new.longitude,
        'timestamp', new.last_updated,
        'group_id', new.group_id
      );

      insert into public.sos_notification_queue (group_id, sender_device_id, payload, status)
      values (new.group_id, new.device_id, payload, 'pending');
    end if;

  elsif tg_op = 'UPDATE' then
    if new.status = 'SOS' and old.status is distinct from 'SOS' then
      payload := jsonb_build_object(
        'device_id', new.device_id,
        'display_name', coalesce(resolved_name, 'Fleet Member'),
        'latitude', new.latitude,
        'longitude', new.longitude,
        'timestamp', new.last_updated,
        'group_id', new.group_id
      );

      insert into public.sos_notification_queue (group_id, sender_device_id, payload, status)
      values (new.group_id, new.device_id, payload, 'pending');
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trigger_notify_fleet_sos on public.tracking_sessions;
create trigger trigger_notify_fleet_sos
after insert or update on public.tracking_sessions
for each row execute function public.notify_fleet_sos();
