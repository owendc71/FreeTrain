-- FreeTrain – Strava activity import
-- Run this in the Supabase SQL Editor

-- Where a ride came from: 'freetrain' (recorded in-app) or 'strava' (imported)
alter table public.rides add column if not exists source text default 'freetrain';
