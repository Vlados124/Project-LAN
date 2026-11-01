// AI-помощник CRM на Claude API: оценка лидов, черновики писем, ответы на отказы,
// сведения о компании из интернета, справки к звонку.
// Ключ Claude API хранится в закрытой таблице public.app_secrets (anthropic_key) — доступ только у сервера.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => {
  if (status >= 400) console.error("ai error", status, JSON.stringify(b));
  return new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
};

const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const MODELS = { smart: "claude-sonnet-5-5", quick: "claude-haiku-5-5" } as const;

async function getSecret(key: string) {
  const { data } = await admin.from("app_secrets").select("value").eq("key", key).maybeSingle();
  return (data?.value as string | undefined)?.trim() || undefined;
}
async function setSecret(key: string, value: string) {
  await admin.from("app_secrets").upsert({ key, value });
}

type Msg = { role: "user" | "assistant"; content: unknown };

// Один запрос к Claude. web=true — разрешаем поиск в интернете (server tool, выполняется на стороне Anthropic).
export async function claude(key: string, prompt: string, opts: { tier?: "smart" | "quick"; web?: boolean; maxSearch?: number; maxTokens?: number } = {}) {
  const model = (await getSecret(opts.tier === "quick" ? "ai_model_quick" : "ai_model")) || MODELS[opts.tier ?? "smart"];
  const messages: Msg[] = [{ role: "user", content: prompt }];
  const tools = opts.web
    ? [{ type: "web_search_20250305", name: "web_search", max_uses: opts.maxSearch ?? 4, user_location: { type: "approximate", country: "RU", timezone: "Europe/Moscow" } }]
    : undefined;
  let text = "", usage = { input_tokens: 0, output_tokens: 0 };
  for (let turn = 0; turn < 4; turn++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: opts.maxTokens ?? 3000, messages, ...(tools ? { tools } : {}) }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const m = data?.error?.message || `HTTP ${r.status}`;
      throw new Error(r.status === 401 ? "Claude API не принял ключ" : r.status === 429 ? "Лимит запросов к Claude API — попробуйте через минуту" : r.status === 400 && /credit|balance/i.test(m) ? "На счёте Claude API закончились деньги" : m);
    }
    usage.input_tokens += data.usage?.input_tokens ?? 0;
    usage.output_tokens += data.usage?.output_tokens ?? 0;
    const blocks = (data.content ?? []) as any[];
    // Текст после последнего результата поиска — это итоговый ответ
    const lastTool = blocks.map((b) => b.type).lastIndexOf("web_search_tool_result");
    text = blocks.slice(lastTool + 1).filter((b) => b.type === "text").map((b) => b.text).join("");
    if (data.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: blocks });
  }
  return { text, usage, model };
}

export function parseJson(text: string) {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("AI вернул ответ не в том формате — повторите");
  try { return JSON.parse(text.slice(s, e + 1)); }
  catch { throw new Error("AI вернул ответ не в том формате — повторите"); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Метод не поддерживается" }, 405);
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: "Неверный запрос" }, 400); }

  // Только участники команды из списка members
  const userClient = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user?.email) return json({ error: "Нужно войти в CRM" }, 401);
  const { data: mem } = await admin.from("members").select("email").ilike("email", user.email).maybeSingle();
  if (!mem) return json({ error: "Нет доступа" }, 403);

  if (body.type === "status") {
    const key = await getSecret("anthropic_key");
    return json({ connected: !!key, tail: key ? key.slice(-4) : "", by: await getSecret("anthropic_key_by") ?? "" });
  }

  if (body.type === "setup") {
    const key = String(body.key ?? "").trim();
    if (!/^sk-ant-[\w-]{20,}$/.test(key)) return json({ error: "Это не похоже на ключ Claude API. Он начинается с sk-ant-…" }, 400);
    try { await claude(key, "Ответь одним словом: ок", { tier: "quick", maxTokens: 10 }); }
    catch (e) { return json({ error: "Ключ не работает: " + (e as Error).message }, 400); }
    await setSecret("anthropic_key", key);
    await setSecret("anthropic_key_by", user.email);
    return json({ ok: true, tail: key.slice(-4) });
  }

  if (body.type === "disconnect") {
    await admin.from("app_secrets").delete().in("key", ["anthropic_key", "anthropic_key_by"]);
    return json({ ok: true });
  }

  if (body.type === "json") {
    const key = await getSecret("anthropic_key");
    if (!key) return json({ error: "AI не подключён: добавьте ключ Claude API в «Настройки → AI-помощник»", code: "not_granted" }, 400);
    const prompt = String(body.prompt ?? "");
    if (!prompt || prompt.length > 60000) return json({ error: "Пустой или слишком длинный запрос" }, 400);
    try {
      const r = await claude(key, prompt, { tier: body.tier === "quick" ? "quick" : "smart", web: !!body.web, maxSearch: Math.min(6, Number(body.maxSearch) || 4) });
      console.log("ai ok", user.email, r.model, r.usage);
      return json({ result: parseJson(r.text), usage: r.usage });
    } catch (e) {
      const m = (e as Error).message;
      return json({ error: m, code: /Лимит/.test(m) ? "rate_limited" : "ai_error" }, 502);
    }
  }

  return json({ error: "Неизвестный запрос" }, 400);
});
