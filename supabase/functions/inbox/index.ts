// Проверка входящей почты (VK WorkSpace / biz.mail.ru) по IMAP.
// Берёт только письма от лидов из базы (совпадение адреса отправителя с email в карточке).
// Для такого письма: текст попадает в «Заметки» карточки, лид переходит в «Есть ответ»,
// ставится шаг «Ответить на письмо», в Telegram приходит уведомление. Остальная почта не сохраняется.
// Запуск: по расписанию (pg_cron, заголовок x-cron-secret) или из CRM участником команды.
import { ImapFlow } from "npm:imapflow@1.0.164";
import { simpleParser } from "npm:mailparser@3.7.1";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => {
  if (status >= 400) console.error("inbox error", status, JSON.stringify(b));
  return new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
};
const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function getSecret(key: string) {
  const { data } = await admin.from("app_secrets").select("value").eq("key", key).maybeSingle();
  return (data?.value as string | undefined)?.trim() || undefined;
}
async function setSecret(key: string, value: string) {
  await admin.from("app_secrets").upsert({ key, value });
}
// Уведомление в Telegram через базу (из функций api.telegram.org не открывается)
async function tg(text: string) {
  const token = await getSecret("tg_token"), chat = await getSecret("tg_chat");
  if (!token || !chat) return;
  await admin.rpc("tg_request", { p_token: token, p_method: "sendMessage", p_body: { chat_id: chat, text, disable_web_page_preview: true } });
}

// Обрезаем цитату нашего письма и подпись-«хвост», чтобы в карточке остался только ответ клиента
function stripQuote(t: string) {
  const lines = t.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const ln of lines) {
    if (/^\s*>/.test(ln)) break;
    if (/^-{2,}\s*(Original Message|Исходное сообщение|Пересылаемое сообщение)/i.test(ln)) break;
    if (/^\s*(От|From):\s/.test(ln) && out.length) break;
    if (/(пишет|wrote):\s*$/i.test(ln) && out.length) break;
    out.push(ln);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
const ddmm = (d: Date) => new Date(d.getTime() + 3 * 3600e3).toISOString().slice(0, 16).replace(/^(\d+)-(\d+)-(\d+)T/, "$3.$2 ");
const mskToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

const imapClient = (user: string, pass: string) => new ImapFlow({
  host: Deno.env.get("IMAP_HOST") || "imap.mail.ru", port: 993, secure: true,
  auth: { user, pass }, logger: false, socketTimeout: 60000,
});

async function sync() {
  // Для чтения нужен отдельный пароль приложения с доступом к IMAP (imap_pass); пароль для отправки — запасной вариант
  const user = await getSecret("smtp_user"), pass = (await getSecret("imap_pass")) || (await getSecret("smtp_pass"));
  if (!user || !pass) return { ok: false, error: "Почта не настроена: нет логина/пароля приложения" };

  // Адреса лидов → карточки
  const byEmail = new Map<string, { id: string; data: Record<string, any> }[]>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("leads").select("id,data").range(from, from + 999);
    if (error) return { ok: false, error: error.message };
    for (const r of data ?? []) {
      const em = String((r.data as any)?.email ?? "").trim().toLowerCase();
      if (em.includes("@")) byEmail.set(em, [...(byEmail.get(em) ?? []), r as any]);
    }
    if (!data || data.length < 1000) break;
  }

  const client = imapClient(user, pass);
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  let found = 0, matched: string[] = [], lastUid = Number(await getSecret("imap_last_uid") ?? 0);
  try {
    const box = client.mailbox as any;
    const uidNext = Number(box?.uidNext ?? 0);
    // Первый запуск — смотрим последние 3 дня
    const range = lastUid > 0 ? `${lastUid + 1}:*` : null;
    const uids: number[] = range
      ? ((await client.search({ uid: range }, { uid: true })) || [])
      : ((await client.search({ since: new Date(Date.now() - 3 * 86400e3) }, { uid: true })) || []);
    for (const uid of uids.filter((u) => u > lastUid).sort((a, b) => a - b).slice(0, 200)) {
      const msg = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
      const fromAddr = String(msg?.envelope?.from?.[0]?.address ?? "").toLowerCase();
      lastUid = Math.max(lastUid, uid);
      found++;
      const leads = byEmail.get(fromAddr);
      if (!leads?.length) continue; // не лид — не читаем и не сохраняем
      const full = await client.fetchOne(String(uid), { source: true }, { uid: true });
      const parsed = await simpleParser(full.source);
      const subject = String(parsed.subject ?? "").slice(0, 300);
      const text = stripQuote(String(parsed.text ?? "")).slice(0, 3000);
      const date = parsed.date ?? new Date();
      const msgId = String(parsed.messageId ?? `uid-${uid}`);
      for (const l of leads) {
        const d = l.data, now = Date.now();
        if ((d.inbox ?? []).some((x: any) => x.id === msgId)) continue;
        const patch: Record<string, unknown> = {
          inbox: [...(d.inbox ?? []), { id: msgId, t: date.getTime(), subject, text }].slice(-20),
          replyNote: `${d.replyNote ? d.replyNote + "\n\n" : ""}📩 Письмо от клиента ${ddmm(date)}${subject ? " — " + subject : ""}\n${text}`.slice(-8000),
          lastInboxAt: date.getTime(), updatedAt: now, updatedBy: "почта",
          nextStep: "Ответить на письмо клиента", nextDate: mskToday(), autoStep: true,
        };
        if (["new", "scored", "approved", "sent"].includes(d.status)) {
          patch.status = "replied";
          patch.repliedAt = d.repliedAt ?? now;
          patch.sentAt = d.sentAt ?? now;
          patch.approvedAt = d.approvedAt ?? now;
          patch.log = [...(d.log ?? []), { t: now, s: "replied", by: "почта" }];
        }
        const { error } = await admin.rpc("patch_lead", { p_id: l.id, p_patch: patch });
        if (error) { console.error("patch_lead", l.id, error.message); continue; }
        d.inbox = patch.inbox; // повторное письмо в этом же запуске не задублируется
        matched.push(`${d.company || fromAddr}`);
        await tg(`📩 Ответ от лида: ${d.company || "Без названия"}${d.name ? " (" + d.name + ")" : ""}\n${subject ? "Тема: " + subject + "\n" : ""}\n${text.slice(0, 600)}${text.length > 600 ? "…" : ""}\n\nВ CRM: карточка → «Ответить клиенту» подготовит черновик.`);
      }
    }
    if (!lastUid && uidNext) lastUid = uidNext - 1;
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  if (lastUid) await setSecret("imap_last_uid", String(lastUid));
  return { ok: true, checked: found, matched };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Метод не поддерживается" }, 405);
  const cron = await getSecret("cron_secret");
  const byCron = !!cron && req.headers.get("x-cron-secret") === cron;
  if (!byCron) {
    const userClient = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user?.email) return json({ error: "Нужно войти в CRM" }, 401);
    const { data: mem } = await admin.from("members").select("email").ilike("email", user.email).maybeSingle();
    if (!mem) return json({ error: "Нет доступа" }, 403);
  }
  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* пусто — обычный запуск */ }

  if (!byCron && body.type === "status") {
    return json({ user: await getSecret("smtp_user") ?? "", configured: !!(await getSecret("imap_pass")), last: JSON.parse(await getSecret("inbox_last") ?? "null") });
  }
  if (!byCron && body.type === "setup") {
    const user = await getSecret("smtp_user"), pass = String(body.pass ?? "").replace(/\s+/g, "");
    if (!user) return json({ error: "Сначала нужна настроенная отправка писем (адрес ящика)" }, 400);
    if (pass.length < 8) return json({ error: "Вставьте пароль приложения целиком" }, 400);
    const c = imapClient(user, pass);
    try { await c.connect(); await c.logout(); }
    catch (e) {
      const x = e as any;
      return json({ error: x?.authenticationFailed ? "Почта не приняла пароль. Создайте пароль приложения с доступом «IMAP, POP3, SMTP» (полный доступ к почте)." : "Не удалось подключиться к почте: " + String(x?.message ?? e) }, 400);
    }
    await setSecret("imap_pass", pass);
    return json({ ok: true, user });
  }

  // По расписанию работаем только после того, как в CRM введён пароль с доступом к IMAP
  if (byCron && !(await getSecret("imap_pass"))) return json({ ok: true, skipped: "no imap_pass" });

  try {
    const r = await sync();
    console.log("inbox sync", JSON.stringify(r));
    await setSecret("inbox_last", JSON.stringify({ t: Date.now(), ok: r.ok, matched: (r as any).matched?.length ?? 0, error: (r as any).error ?? "" }));
    return json(r, r.ok ? 200 : 500);
  } catch (e) {
    const x = e as any, m = String(x?.message ?? e);
    const detail = [x?.responseText, x?.serverResponseCode, x?.executedCommand?.split(" ")?.[1]].filter(Boolean).join(" | ");
    console.error("inbox failure", m, detail, x?.authenticationFailed ? "AUTH_FAILED" : "");
    const auth = x?.authenticationFailed || /auth|login|credentials/i.test(m + detail);
    await setSecret("inbox_last", JSON.stringify({ t: Date.now(), ok: false, error: auth ? "нужен пароль приложения с доступом к IMAP" : m }));
    return json({ ok: false, error: auth ? "Почта не приняла пароль приложения для IMAP. Нужен пароль с доступом к IMAP." : m, detail }, 502);
  }
});
