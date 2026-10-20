-- Project LAN CRM — схема базы для Supabase.
-- Выполнить один раз: Supabase → SQL Editor → New query → вставить всё → Run.

-- 1. Кто имеет доступ к CRM (только эти email смогут видеть и менять лидов)
create table if not exists public.members (
  email text primary key
);
alter table public.members enable row level security;  -- через сайт таблицу не видно и не изменить

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.members
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- 2. Лиды: каждая запись — JSON с полями лида (компания, статус, контакты, оценка…)
create table if not exists public.leads (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.leads enable row level security;
drop policy if exists "members manage leads" on public.leads;
create policy "members manage leads" on public.leads
  for all to authenticated
  using (public.is_member()) with check (public.is_member());

-- 3. Общие настройки (описание Project LAN)
create table if not exists public.config (
  id text primary key,
  data jsonb not null default '{}'::jsonb
);
alter table public.config enable row level security;
drop policy if exists "members manage config" on public.config;
create policy "members manage config" on public.config
  for all to authenticated
  using (public.is_member()) with check (public.is_member());

-- 4. Точечное изменение полей лида: два человека правят разные поля одной карточки — ничего не теряется
create or replace function public.patch_lead(p_id text, p_patch jsonb) returns void
language sql security invoker set search_path = public as $$
  update public.leads set data = data || p_patch, updated_at = now() where id = p_id;
$$;
grant execute on function public.patch_lead(text, jsonb) to authenticated;

-- 5. Изменения в реальном времени
alter table public.leads replica identity full;
do $$ begin
  begin alter publication supabase_realtime add table public.leads;  exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.config; exception when duplicate_object then null; end;
end $$;

-- 6. Доступ команды — впишите реальные адреса (можно добавлять позже этой же командой)
insert into public.members (email) values
  ('jekmakeev@gmail.com')
  -- , ('kollega@example.ru')
  -- , ('nachalnik@example.ru')
on conflict do nothing;
