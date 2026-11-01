// AI-помощник CRM: оценка лидов, черновики писем, ответы на отказы, справки к звонку.
// Два провайдера, выбирается по ключу:
//   • Google Gemini (ключ AIza…) — бесплатный тариф, без поиска в интернете;
//   • Claude API (ключ sk-ant-…) — платный, умеет искать в интернете.
// Ключ хранится в закрытой таблице public.app_secrets (ai_key / anthropic_key) — доступ только у сервера.
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
const MODELS = {
  anthropic: { smart: "claude-sonnet-5-5", quick: "claude-haiku-5-5" },
  gemini: { smart: "gemini-3.8-flash", quick: "gemini-3.5-flash-lite" },
} as const;
type Provider = keyof typeof MODELS;
const providerOf = (key: string): Provider | null => /^sk-ant-[\w-]{20,}$/.test(key) ? "anthropic" : /^AIza[\w-]{30,}$/.test(key) ? "gemini" : null;
async function getKey() {
  const key = (await getSecret("ai_key")) || (await getSecret("anthropic_key"));
  const provider = key ? providerOf(key) : null;
  return key && provider ? { key, provider } : null;
}

async function getSecret(key: string) {
  const { data } = await admin.from("app_secrets").select("value").eq("key", key).maybeSingle();
  return (data?.value as string | undefined)?.trim() || undefined;
}
async function setSecret(key: string, value: string) {
  await admin.from("app_secrets").upsert({ key, value });
}

type Msg = { role: "user" | "assistant"; content: unknown };

// Один запрос к Claude. web=true — разрешаем поиск в интернете (server tool, выполняется на стороне Anthropic).
type Opts = { tier?: "smart" | "quick"; web?: boolean; maxSearch?: number; maxTokens?: number };
async function llm(k: { key: string; provider: Provider }, prompt: string, opts: Opts = {}) {
  return k.provider === "gemini" ? await gemini(k.key, prompt, opts) : await claude(k.key, prompt, opts);
}

// Google Gemini, бесплатный тариф. Поиска Google на бесплатном тарифе нет — web игнорируется.
async function gemini(key: string, prompt: string, opts: Opts = {}) {
  const model = (await getSecret(opts.tier === "quick" ? "ai_model_quick" : "ai_model")) || MODELS.gemini[opts.tier ?? "smart"];
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: Math.max(opts.maxTokens ?? 0, 8192), responseMimeType: "application/json", temperature: 0.7 },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = data?.error?.message || `HTTP ${r.status}`;
    throw new Error(r.status === 429 ? "Лимит бесплатных запросов Gemini — попробуйте через минуту или завтра"
      : r.status === 400 && /API key/i.test(m) ? "Gemini не принял ключ" : r.status === 403 ? "Gemini: нет доступа — " + m : m);
  }
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts ?? []).filter((p: any) => !p.thought).map((p: any) => p.text ?? "").join("");
  if (!text) throw new Error(cand?.finishReason === "SAFETY" ? "Gemini отказался отвечать на этот запрос" : "Gemini вернул пустой ответ — повторите");
  const u = data.usageMetadata ?? {};
  return { text, usage: { input_tokens: u.promptTokenCount ?? 0, output_tokens: u.candidatesTokenCount ?? 0 }, model };
}

async function claude(key: string, prompt: string, opts: Opts = {}) {
  const model = (await getSecret(opts.tier === "quick" ? "ai_model_quick" : "ai_model")) || MODELS.anthropic[opts.tier ?? "smart"];
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

function parseJson(text: string) {
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
    const k = await getKey();
    return json({ connected: !!k, provider: k?.provider ?? "", web: k?.provider === "anthropic", tail: k ? k.key.slice(-4) : "", by: await getSecret("ai_key_by") ?? "" });
  }

  if (body.type === "setup") {
    const key = String(body.key ?? "").trim();
    const provider = providerOf(key);
    if (!provider) return json({ error: "Это не похоже на ключ. Ключ Gemini начинается с AIza…, ключ Claude — с sk-ant-…" }, 400);
    try { await llm({ key, provider }, 'Верни JSON {"ok":true}', { tier: "quick", maxTokens: 20 }); }
    catch (e) { return json({ error: "Ключ не работает: " + (e as Error).message }, 400); }
    await admin.from("app_secrets").delete().in("key", ["anthropic_key", "anthropic_key_by"]);
    await setSecret("ai_key", key);
    await setSecret("ai_key_by", user.email);
    return json({ ok: true, provider, tail: key.slice(-4) });
  }

  if (body.type === "disconnect") {
    await admin.from("app_secrets").delete().in("key", ["ai_key", "ai_key_by", "anthropic_key", "anthropic_key_by"]);
    return json({ ok: true });
  }

  if (body.type === "json") {
    const k = await getKey();
    if (!k) return json({ error: "AI не подключён: добавьте ключ в «Настройки → AI-помощник»", code: "not_granted" }, 400);
    const prompt = String(body.prompt ?? "");
    if (!prompt || prompt.length > 60000) return json({ error: "Пустой или слишком длинный запрос" }, 400);
    try {
      const r = await llm(k, prompt, { tier: body.tier === "quick" ? "quick" : "smart", web: !!body.web, maxSearch: Math.min(6, Number(body.maxSearch) || 4) });
      console.log("ai ok", user.email, r.model, r.usage);
      return json({ result: parseJson(r.text), usage: r.usage });
    } catch (e) {
      const m = (e as Error).message;
      return json({ error: m, code: /Лимит/.test(m) ? "rate_limited" : "ai_error" }, 502);
    }
  }

  return json({ error: "Неизвестный запрос" }, 400);
});
