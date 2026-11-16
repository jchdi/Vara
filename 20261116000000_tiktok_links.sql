-- TikTok profile identity links for authenticated VARA users.
create table if not exists public.tiktok_links (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  tiktok_open_id text not null unique,
  display_name text,
  avatar_url text,
  linked_at timestamptz not null default now()
);

alter table public.tiktok_links enable row level security;
revoke all on public.tiktok_links from anon, authenticated;
grant select on public.tiktok_links to authenticated;

drop policy if exists "Users can view their own TikTok link" on public.tiktok_links;
create policy "Users can view their own TikTok link"
  on public.tiktok_links for select
  to authenticated
  using ((select auth.uid()) = auth_user_id);

-- Inserts/updates are performed only by the Edge Function using the server-only service role key.
