// Отправка письма клиенту с корпоративной почты (VK WorkSpace / biz.mail.ru) по SMTP.
// Секреты проекта: SMTP_USER (адрес ящика), SMTP_PASS (пароль для внешнего приложения),
// необязательно SMTP_FROM_NAME, SMTP_HOST (по умолчанию smtp.mail.ru), SMTP_PORT (465).
import nodemailer from "npm:nodemailer@6.9.14";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => {
  if (status >= 400) console.error("send-email error", status, JSON.stringify(b));
  else console.log("send-email ok");
  return new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
};
const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Метод не поддерживается" }, 405);

  // Действуем от имени вошедшего пользователя: доступ к лиду проверяет RLS (список members)
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await sb.auth.getUser();
  if (!user?.email) return json({ error: "Нужно войти в CRM" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Неверный запрос" }, 400); }
  // Пароль приложения хранится в закрытой таблице app_secrets (доступна только сервисному ключу);
  // если там пусто — берём из секретов функции.
  let smtpUser = Deno.env.get("SMTP_USER")?.trim(), smtpPass = Deno.env.get("SMTP_PASS")?.trim();
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: sec } = await admin.from("app_secrets").select("key,value").in("key", ["smtp_user", "smtp_pass"]);
    const m = Object.fromEntries((sec ?? []).map((r: any) => [r.key, String(r.value ?? "").trim()]));
    if (m.smtp_pass) { smtpPass = m.smtp_pass; if (m.smtp_user) smtpUser = m.smtp_user; }
  } catch (_) { /* остаёмся на секретах функции */ }
  const mkTransport = () => nodemailer.createTransport({
    host: Deno.env.get("SMTP_HOST") || "smtp.mail.ru",
    port: Number(Deno.env.get("SMTP_PORT") || 465),
    secure: true,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
    auth: { user: smtpUser!, pass: smtpPass! },
  });
  const authHint = (m: string) => /auth|535|invalid login|password/i.test(m)
    ? "почта не приняла логин/пароль — нужен пароль для внешнего приложения" : m;

  // Проверка подключения к почте без отправки письма
  if (body.check) {
    if (!smtpUser || !smtpPass) return json({ error: "Почта не настроена: нет SMTP_USER / SMTP_PASS в Supabase" }, 500);
    try { await mkTransport().verify(); }
    catch (e) { return json({ error: "Почтовый сервер отказал: " + authHint(String((e as Error)?.message ?? e)) }, 502); }
    return json({ ok: true, user: smtpUser });
  }

  const leadId = String(body.leadId ?? "");
  const campaign = String(body.campaign ?? "").slice(0, 120);
  const to = String(body.to ?? "").trim();
  const subject = String(body.subject ?? "").trim() || "Project LAN";
  const text = String(body.text ?? "").trim();
  if (!leadId || !text) return json({ error: "Пустое письмо" }, 400);
  if (!EMAIL.test(to)) return json({ error: "Неверный email получателя" }, 400);
  if (text.length > 20000 || subject.length > 300) return json({ error: "Слишком длинное письмо" }, 400);

  const { data: row, error: readErr } = await sb.from("leads").select("data").eq("id", leadId).maybeSingle();
  if (readErr || !row) return json({ error: "Нет доступа к этому лиду" }, 403);
  const lead = (row.data ?? {}) as Record<string, any>;
  // Письмо уходит только на адрес из карточки — функцию нельзя использовать для рассылки на произвольные адреса
  if (String(lead.email ?? "").trim().toLowerCase() !== to.toLowerCase())
    return json({ error: "Адрес не совпадает с email в карточке лида" }, 400);

  console.log("smtp config", { user: smtpUser ?? null, hasPass: !!smtpPass });
  if (!smtpUser || !smtpPass) return json({ error: "Почта не настроена: нет SMTP_USER / SMTP_PASS в Supabase" }, 500);
  const transport = mkTransport();
  try {
    await transport.sendMail({
      from: { name: Deno.env.get("SMTP_FROM_NAME") || "Project LAN", address: smtpUser },
      to, subject, text,
    });
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    console.error("smtp failure", m);
    return json({ error: "Почтовый сервер отказал: " + authHint(m) }, 502);
  }

  const now = Date.now();
  const patch: Record<string, unknown> = {
    messages: [...(lead.messages ?? []), { t: now, by: user.email, ch: "email", to, subject, text, ...(campaign ? { campaign } : {}) }],
    updatedAt: now, updatedBy: user.email,
  };
  if (["new", "scored", "approved"].includes(lead.status)) {
    patch.status = "sent";
    patch.log = [...(lead.log ?? []), { t: now, s: "sent", by: user.email }];
    patch.sentAt = lead.sentAt ?? now;
    patch.approvedAt = lead.approvedAt ?? now;
  }
  const { error: patchErr } = await sb.rpc("patch_lead", { p_id: leadId, p_patch: patch });
  return json({ ok: true, patch, logged: !patchErr });
});
