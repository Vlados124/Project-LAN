// Уведомления команды в Telegram: события по лидам и ежедневная сводка дел.
// Токен бота и чат хранятся в public.app_secrets (доступ только у сервера).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SITE = "https://vlados124.github.io/Project-LAN/";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => {
  if (status >= 400) console.error("notify error", status, JSON.stringify(b));
  return new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
};
const h = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const short = (e: unknown) => String(e ?? "").split("@")[0];

const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function getSecret(key: string) {
  const { data } = await admin.from("app_secrets").select("value").eq("key", key).maybeSingle();
  return data?.value as string | undefined;
}
async function setSecret(key: string, value: string) {
  await admin.from("app_secrets").upsert({ key, value });
}
// Запросы к Telegram идут через базу (pg_net, функции public.tg_request / tg_response):
// из функций Supabase api.telegram.org не открывается, а из базы — работает.
async function tgApi(token: string, method: string, body?: unknown) {
  // Связь с Telegram бывает с перебоями — до 3 попыток
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: id, error } = await admin.rpc("tg_request", { p_token: token, p_method: method, p_body: body ?? {} });
    if (error || id == null) { console.error("tg_request failed", method, error?.message); break; }
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, i < 10 ? 300 : 500));
      const { data: res } = await admin.rpc("tg_response", { p_id: id });
      if (!res) continue;
      if (res.body) return res.body;
      console.error("telegram via db failed", method, attempt, res.status, res.timed_out, String(res.error ?? "").slice(0, 120));
      break;
    }
  }
  return { ok: false, network: true, description: "Не удалось связаться с Telegram" };
}
async function send(text: string) {
  const token = await getSecret("tg_token"), chat = await getSecret("tg_chat");
  if (!token || !chat) return { ok: false, skipped: true };
  return await tgApi(token, "sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true });
}
function mskToday() {
  return new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
}
const ACTIVE = ["approved", "sent", "replied", "called", "qualified", "deal"];
const EV_ICO: Record<string, string> = {
  call: "📞", write: "💬", meeting: "🤝", kp: "📄", remind: "🔔", other: "•",
};

async function digest() {
  const { data, error } = await admin.from("leads").select("id,data");
  if (error) return { ok: false, error: error.message };
  const { data: evRows } = await admin.from("config").select("id,data").like("id", "ev_%");
  const t = mskToday();
  const byId = new Map<string, Record<string, any>>();
  for (const r of data ?? []) if (r.data && !(r.data as any).archived) byId.set(r.id, r.data as Record<string, any>);
  type Item = { date: string; time: string; ico: string; head: string; body: string; owner: string };
  const items: Item[] = [];
  const leadsWithEv = new Set<string>();
  for (const r of evRows ?? []) {
    const e = (r.data ?? {}) as Record<string, any>;
    if (e.done || e.deleted || !e.date) continue;
    if (e.leadId) leadsWithEv.add(String(e.leadId));
    const l = e.leadId ? byId.get(String(e.leadId)) : undefined;
    items.push({
      date: String(e.date),
      time: String(e.time ?? ""),
      ico: EV_ICO[String(e.kind ?? "")] ?? "•",
      head: String(l?.company || e.leadName || ""),
      body: String(e.title || "Напоминание"),
      owner: String(e.owner ?? ""),
    });
  }
  for (const [lid, l] of byId.entries()) {
    if (!l.nextDate) continue;
    if (!(ACTIVE.includes(l.status) || l.status === "new" || l.status === "scored" || (l.status === "lost" && l.callTask))) continue;
    items.push({
      date: String(l.nextDate),
      time: String(l.nextTime ?? ""),
      ico: EV_ICO[String(l.nextKind ?? "")] ?? "•",
      head: String(l.company || "Без названия"),
      body: String(l.nextStep || "шаг не записан"),
      owner: String(l.owner ?? ""),
    });
    leadsWithEv.add(lid);
  }
  const cmp = (a: Item, b: Item) => a.date !== b.date ? (a.date < b.date ? -1 : 1) : (a.time || "99:99").localeCompare(b.time || "99:99");
  const late = items.filter((x) => x.date < t).sort(cmp);
  const now = items.filter((x) => x.date === t).sort(cmp);
  const noStep = [...byId.entries()].filter(([id, l]) => ACTIVE.includes(l.status) && !leadsWithEv.has(id)).length;
  if (!late.length && !now.length) return { ok: true, skipped: "no tasks" };
  const line = (x: Item) =>
    `${x.ico}${x.time ? ` <b>${h(x.time)}</b>` : ""} ${x.head ? `<b>${h(x.head)}</b> — ` : ""}${h(x.body)}${x.date < t ? ` <i>(с ${h(x.date.split("-").reverse().join("."))})</i>` : ""}${x.owner ? ` · ${h(short(x.owner))}` : ""}`;
  let msg = `☀️ <b>Расписание на сегодня</b>\n`;
  if (late.length) msg += `\n🔴 Просрочено: ${late.length}\n` + late.slice(0, 10).map(line).join("\n") + (late.length > 10 ? `\n…и ещё ${late.length - 10}` : "");
  if (now.length) msg += `\n\n🟡 Сегодня: ${now.length}\n` + now.slice(0, 12).map(line).join("\n") + (now.length > 12 ? `\n…и ещё ${now.length - 12}` : "");
  if (noStep) msg += `\n\n⚪ Без следующего шага: ${noStep}`;
  msg += `\n\n<a href="${SITE}">Открыть календарь CRM</a>`;
  return await send(msg);
}

const RESP: Record<string, [string, string]> = {
  agreed: ["🟢", "Согласие"], interest: ["🟡", "Интерес"], refused: ["🔴", "Отказ"], noanswer: ["⚪", "Нет ответа"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Метод не поддерживается" }, 405);
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: "Неверный запрос" }, 400); }

  // Вызов по расписанию
  if (body.type === "digest") {
    const cron = await getSecret("cron_secret");
    if (!cron || req.headers.get("x-cron-secret") !== cron) return json({ error: "forbidden" }, 403);
    return json(await digest());
  }

  // Остальное — только для вошедших участников команды
  const userClient = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user?.email) return json({ error: "Нужно войти в CRM" }, 401);
  const { data: mem } = await admin.from("members").select("email").ilike("email", user.email).maybeSingle();
  if (!mem) return json({ error: "Нет доступа" }, 403);

  if (body.type === "status") {
    const token = await getSecret("tg_token");
    return json({ connected: !!(token && await getSecret("tg_chat")), hasToken: !!token, chat: await getSecret("tg_chat_title") ?? "", bot: await getSecret("tg_bot") ?? "" });
  }

  if (body.type === "setup") {
    let token = String(body.token ?? "").trim();
    if (!token) token = (await getSecret("tg_token")) ?? "";
    if (!/^\d+:[\w-]{20,}$/.test(token)) return json({ error: "Это не похоже на токен бота. Он выглядит так: 123456789:AAH…" }, 400);
    // Если браузер уже проверил бота (у пользователя Telegram открывается, у сервера — не всегда), доверяем ему
    const v = body.verified && typeof body.verified.bot === "string" ? body.verified : null;
    if (v) {
      await setSecret("tg_token", token);
      await setSecret("tg_bot", v.bot);
      if (!v.chat?.id) return json({ ok: false, needChat: true, bot: v.bot });
      await setSecret("tg_chat", String(v.chat.id));
      await setSecret("tg_chat_title", String(v.chat.title ?? ""));
      // Проверочное сообщение отправляет браузер
      return json({ ok: true, chat: v.chat.title ?? "", bot: v.bot });
    }
    const me = await tgApi(token, "getMe");
    if (!me.ok) return json({ error: me.network
      ? "Сервер не смог связаться с Telegram. Попробуйте ещё раз через минуту."
      : me.error_code === 401
        ? "Telegram ответил, что такого токена нет. Если вы делали /revoke в @BotFather, вставьте новый токен из его последнего сообщения."
        : "Telegram не принял токен: " + (me.description ?? "неизвестная ошибка") }, 400);
    await setSecret("tg_token", token);
    await setSecret("tg_bot", me.result.username);
    const up = await tgApi(token, "getUpdates", { limit: 100, allowed_updates: ["message", "my_chat_member", "channel_post"] });
    const chats = (up.result ?? []).map((u: any) => u.my_chat_member?.chat ?? u.message?.chat ?? u.channel_post?.chat).filter(Boolean);
    const chat = chats.reverse().find((c: any) => c.type !== "private") ?? chats[0];
    if (!chat) return json({ ok: false, needChat: true, bot: me.result.username });
    await setSecret("tg_chat", String(chat.id));
    await setSecret("tg_chat_title", chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(" ") ?? "");
    const test = await send(`✅ Project LAN CRM подключена. Сюда будут приходить ответы лидов и сводка дел в 9:00.\nПодключил(а): ${h(short(user.email))}`);
    if (!test.ok) return json({ error: "Бот не может писать в чат: " + (test.description ?? "") }, 400);
    return json({ ok: true, chat: chat.title ?? chat.first_name ?? "", bot: me.result.username });
  }

  if (body.type === "disconnect") {
    await admin.from("app_secrets").delete().in("key", ["tg_token", "tg_chat", "tg_chat_title", "tg_bot"]);
    return json({ ok: true });
  }

  if (body.type === "digest_now") return json(await digest());

  if (body.type === "event") {
    const { data: row } = await userClient.from("leads").select("data").eq("id", String(body.leadId ?? "")).maybeSingle();
    if (!row) return json({ error: "Нет доступа к лиду" }, 403);
    const l = row.data as Record<string, any>;
    const who = h(short(user.email)), co = `<b>${h(l.company || "Без названия")}</b>${l.name ? ` (${h(l.name)})` : ""}`;
    let msg = "";
    if (body.kind === "resp" && RESP[l.resp]) {
      const [e, t] = RESP[l.resp];
      msg = `${e} ${t} — ${co}${l.resp === "refused" && l.lossReason ? `\nПричина: ${h(l.lossReason)}` : ""}\nОтметил(а): ${who}`;
    } else if (body.kind === "won") msg = `🏆 Сделка закрыта — ${co}${l.amount ? `\nСумма: ${Number(l.amount).toLocaleString("ru-RU")} ₽` : ""}\nОтметил(а): ${who}`;
    else if (body.kind === "new") msg = `➕ Новый лид — ${co}${l.source ? ` · ${h(l.source)}` : ""}\nДобавил(а): ${who}`;
    else if (body.kind === "assign" && l.owner) msg = `👤 ${co} → ответственный: ${h(short(l.owner))}\nНазначил(а): ${who}`;
    if (!msg) return json({ ok: true, skipped: true });
    return json(await send(msg));
  }

  return json({ error: "Неизвестный запрос" }, 400);
});
