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

-- 7. Запросы к Telegram через базу (pg_net): функции Supabase не достают до api.telegram.org.
--    Вызывать может только сервер (service_role). Используется функцией notify.
create extension if not exists pg_net;
create or replace function public.tg_request(p_token text, p_method text, p_body jsonb)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_token !~ '^\d+:[\w-]{20,}$' or p_method !~ '^[A-Za-z]+$' then
    raise exception 'bad telegram request';
  end if;
  return net.http_post(
    url := 'https://api.telegram.org/bot' || p_token || '/' || p_method,
    body := coalesce(p_body, '{}'::jsonb),
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 15000);
end $$;
create or replace function public.tg_response(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r record; b jsonb;
begin
  select status_code, timed_out, error_msg, content into r from net._http_response where id = p_id;
  if not found then return null; end if;
  begin b := r.content::jsonb; exception when others then b := null; end;
  return jsonb_build_object('status', r.status_code, 'timed_out', r.timed_out, 'error', r.error_msg, 'body', b);
end $$;
revoke all on function public.tg_request(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.tg_response(bigint) from public, anon, authenticated;
grant execute on function public.tg_request(text, text, jsonb) to service_role;
grant execute on function public.tg_response(bigint) to service_role;

-- 8. Еженедельный отчёт по воронке в Telegram: public.weekly_report(true), понедельник 9:00 МСК.
--    Полный текст функции — в миграции weekly_funnel_report (Supabase → Database → Migrations).
--    Расписание: select cron.schedule('lan-weekly-report', '0 6 * * 1', $$select public.weekly_report(true)$$);
--    Посмотреть отчёт без отправки: select public.weekly_report(false);

-- 9. Ответы клиентов из почты: функция supabase/functions/inbox, пароль приложения с доступом к IMAP
--    вводится в CRM («Настройки → Ответы клиентов из почты») и хранится в app_secrets (imap_pass).
--    Расписание: каждые 10 минут, 8:00–22:00 МСК — cron 'lan-inbox-sync' (миграция inbox_sync_schedule).

-- 10. Несколько получателей уведомлений: app_secrets.tg_chat_extra — chat_id через запятую.
--     public.tg_request дублирует им каждое сообщение, отправленное в основной чат (миграция telegram_extra_recipients).
--     Добавить человека: он пишет боту /start, затем
--     update public.app_secrets set value = value || ',<chat_id>' where key = 'tg_chat_extra';
