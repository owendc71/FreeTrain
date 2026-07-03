-- FreeTrain – Strava integration
-- Run this in the Supabase SQL Editor (supabase.com → your project → SQL Editor)

-- ── Strava connections (one per user) ─────────────────────────────
create table if not exists public.strava_connections (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  athlete_id    bigint,
  athlete_name  text default '',
  access_token  text not null,
  refresh_token text not null,
  expires_at    bigint not null,          -- unix epoch seconds
  created_at    timestamptz default now()
);

alter table public.strava_connections enable row level security;

create policy "users_own_strava" on public.strava_connections
  for all using (auth.uid() = user_id);

-- ── Link rides to uploaded Strava activities ──────────────────────
alter table public.rides add column if not exists strava_id bigint;
