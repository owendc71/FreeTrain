-- FreeTrain – AI-free coach chat
-- Run this in the Supabase SQL Editor

-- ── Athlete profile (one row per user, both disciplines) ───────────
create table if not exists public.athlete_profiles (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  bike_goal             text,
  bike_level            text,
  bike_days_per_week    integer,
  bike_ftp              integer,
  bike_weekly_hours     real,
  run_goal              text,
  run_level             text,
  run_days_per_week     integer,
  run_weekly_miles      real,
  notes                 text default '',
  onboarded_at          timestamptz,
  updated_at            timestamptz default now(),
  unique(user_id)
);

alter table public.athlete_profiles enable row level security;

create policy "users_own_athlete_profile" on public.athlete_profiles
  for all using (auth.uid() = user_id);

-- ── Coach chat transcript ────────────────────────────────────────
create table if not exists public.coach_messages (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          text not null,                    -- 'coach' | 'user'
  text          text not null default '',
  message_type  text not null default 'plain',     -- 'plain' | 'quick_reply' | 'plan_summary'
  payload       jsonb default '{}',
  created_at    timestamptz default now()
);

alter table public.coach_messages enable row level security;

create policy "users_own_coach_messages" on public.coach_messages
  for all using (auth.uid() = user_id);

-- ── Subjective feedback (RPE-style) on completed activities ───────
-- feedback ∈ {'too_easy','just_right','too_hard'} or null (null = not yet asked)
alter table public.rides add column if not exists feedback text;
alter table public.runs  add column if not exists feedback text;
