-- FreeTrain – Running support
-- Run this in the Supabase SQL Editor

-- ── Runs (imported from Strava, mirrors the rides table) ──────────
create table if not exists public.runs (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  name                 text default '',
  date                 text default '',
  elapsed              integer default 0,   -- moving time, seconds
  distance_m           real default 0,
  elevation_gain_m     real default 0,
  avg_pace_sec_per_km  real default 0,
  completed            boolean default true,
  source               text default 'strava',
  strava_id            bigint,
  created_at           timestamptz default now()
);

alter table public.runs enable row level security;

create policy "users_own_runs" on public.runs
  for all using (auth.uid() = user_id);

-- ── Run plan entries (structured mileage plan, calendar-scheduled) ─
create table if not exists public.run_plan_entries (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  date                 text not null,
  run_type             text not null,       -- recovery | easy | tempo | intervals | long
  target_distance_m    real default 0,
  target_duration_min  real default 0,
  description          text default '',
  created_at           timestamptz default now(),
  unique(user_id, date)
);

alter table public.run_plan_entries enable row level security;

create policy "users_own_run_plan" on public.run_plan_entries
  for all using (auth.uid() = user_id);
