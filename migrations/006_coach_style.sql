-- FreeTrain – coach: road/mountain and road/trail style
-- Run this in the Supabase SQL Editor

-- bike_style ∈ {'road','mountain'}, run_style ∈ {'road','trail'} — or null
-- if that discipline wasn't chosen during onboarding.
alter table public.athlete_profiles add column if not exists bike_style text;
alter table public.athlete_profiles add column if not exists run_style  text;
