-- FreeTrain – Swimming + strength training support
-- Run this in the Supabase SQL Editor.
--
-- Mirrors the running stack (004_running.sql) for two new disciplines.
-- Each discipline keeps its own activity table + plan-entry table, so a
-- single date can hold a ride, a run, a swim and a strength session
-- without colliding on the per-table unique(user_id, date).

-- ══════════════════════════════════════════════════════════════════
-- Swimming
-- ══════════════════════════════════════════════════════════════════

-- Completed swims (logged manually or imported from Strava).
create table if not exists public.swims (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users(id) on delete cascade,
  name                   text default '',
  date                   text default '',
  elapsed                integer default 0,   -- moving time, seconds
  distance_m             real default 0,
  avg_pace_sec_per_100m  real default 0,      -- the standard swim pace unit
  stroke                 text default 'free', -- free | back | breast | fly | mixed | im
  completed              boolean default true,
  source                 text default 'manual',
  strava_id              bigint,
  feedback               text,                -- too_easy | just_right | too_hard | null
  created_at             timestamptz default now()
);

alter table public.swims enable row level security;

create policy "users_own_swims" on public.swims
  for all using (auth.uid() = user_id);

-- Planned swims (structured distance plan, calendar-scheduled).
create table if not exists public.swim_plan_entries (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  date                 text not null,
  swim_type            text not null,       -- recovery | technique | easy | threshold | intervals | long
  target_distance_m    real default 0,
  target_duration_min  real default 0,
  description          text default '',
  created_at           timestamptz default now(),
  unique(user_id, date)
);

alter table public.swim_plan_entries enable row level security;

create policy "users_own_swim_plan" on public.swim_plan_entries
  for all using (auth.uid() = user_id);

-- ══════════════════════════════════════════════════════════════════
-- Strength training
-- ══════════════════════════════════════════════════════════════════

-- Completed strength sessions, recorded at session level (duration +
-- focus + perceived effort) rather than per-exercise sets/reps.
create table if not exists public.strength_sessions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  name              text default '',
  date              text default '',
  elapsed           integer default 0,   -- session duration, seconds
  focus             text default 'full', -- upper | lower | full | core
  perceived_effort  integer,             -- 1-10 RPE, optional
  notes             text default '',
  completed         boolean default true,
  source            text default 'manual',
  strava_id         bigint,
  feedback          text,                -- too_easy | just_right | too_hard | null
  created_at        timestamptz default now()
);

alter table public.strength_sessions enable row level security;

create policy "users_own_strength_sessions" on public.strength_sessions
  for all using (auth.uid() = user_id);

-- Planned strength sessions.
create table if not exists public.strength_plan_entries (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  date                 text not null,
  focus                text not null,       -- upper | lower | full | core
  target_duration_min  real default 0,
  description          text default '',
  created_at           timestamptz default now(),
  unique(user_id, date)
);

alter table public.strength_plan_entries enable row level security;

create policy "users_own_strength_plan" on public.strength_plan_entries
  for all using (auth.uid() = user_id);

-- ══════════════════════════════════════════════════════════════════
-- Athlete profile: per-discipline preferences (mirrors bike_*/run_*)
-- ══════════════════════════════════════════════════════════════════

alter table public.athlete_profiles add column if not exists swim_goal            text;
alter table public.athlete_profiles add column if not exists swim_level           text;
alter table public.athlete_profiles add column if not exists swim_days_per_week   integer;
alter table public.athlete_profiles add column if not exists swim_weekly_meters   real;

alter table public.athlete_profiles add column if not exists strength_goal          text;
alter table public.athlete_profiles add column if not exists strength_level         text;
alter table public.athlete_profiles add column if not exists strength_days_per_week integer;
alter table public.athlete_profiles add column if not exists strength_session_mins  real;
