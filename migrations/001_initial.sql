-- WorkoutRunner – initial schema
-- Run this in the Supabase SQL Editor (supabase.com → your project → SQL Editor)

-- ── Workouts ──────────────────────────────────────────────────────
create table if not exists public.workouts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  name           text not null,
  description    text default '',
  intervals      jsonb not null default '[]',
  total_duration integer default 0,
  created_at     timestamptz default now()
);

alter table public.workouts enable row level security;

create policy "users_own_workouts" on public.workouts
  for all using (auth.uid() = user_id);

-- ── Rides ─────────────────────────────────────────────────────────
create table if not exists public.rides (
  id                uuid    primary key default gen_random_uuid(),
  user_id           uuid    not null references auth.users(id) on delete cascade,
  workout_name      text    default '',
  date              text    default '',
  elapsed           integer default 0,
  total_duration    integer default 0,
  avg_power         real    default 0,
  normalized_power  real    default 0,
  intensity_factor  real    default 0,
  tss               real    default 0,
  ftp               integer default 250,
  completed         boolean default false,
  power_samples     jsonb   default '[]',
  created_at        timestamptz default now()
);

alter table public.rides enable row level security;

create policy "users_own_rides" on public.rides
  for all using (auth.uid() = user_id);

-- ── Plans ─────────────────────────────────────────────────────────
create table if not exists public.plans (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  date        text not null,
  workout_id  uuid references public.workouts(id) on delete set null,
  created_at  timestamptz default now(),
  unique(user_id, date)
);

alter table public.plans enable row level security;

create policy "users_own_plans" on public.plans
  for all using (auth.uid() = user_id);
