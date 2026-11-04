#!/usr/bin/env python3
"""Project LAN — синхронизация Telegram → CRM.

Читает ваши личные чаты в Telegram (только чтение, ничего не отправляет),
находит в них лидов из CRM по @нику или телефону и отмечает в карточке:
  • вы написали лиду          → контакт «Мессенджер», этап «Связались»;
  • лид ответил               → этап «Есть ответ», текст ответа в заметках;
  • написали, а ответа нет 3+ дня → ответ «Нет ответа» и напоминание.

Запуск: python3 tg_sync.py          — одна проверка
        python3 tg_sync.py --login  — первый вход в Telegram (код из SMS/приложения)
        python3 tg_sync.py --dry    — показать, что изменилось бы, ничего не записывая
"""
import asyncio, datetime as dt, json, os, re, sys, time, warnings
warnings.filterwarnings("ignore")

import requests
from telethon import TelegramClient
from telethon.tl.types import User

DIR = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(DIR, "config.json"), encoding="utf-8"))
STATE_F = os.path.join(DIR, "state.json")
SB = CFG["supabase_url"].rstrip("/")
KEY = CFG["anon_key"]
NOANSWER_DAYS = int(CFG.get("noanswer_days", 3))
DRY = "--dry" in sys.argv

# Частая ошибка при настройке: api_id и api_hash вставлены в одно поле — разделяем и сохраняем исправленное
_parts = str(CFG.get("api_id", "")).replace(",", " ").split()
if len(_parts) == 2 and _parts[0].isdigit():
    CFG["api_id"], CFG["api_hash"] = _parts[0], _parts[1]
    json.dump(CFG, open(os.path.join(DIR, "config.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
if not str(CFG.get("api_id", "")).strip().isdigit():
    raise SystemExit("В config.json неверный api_id (должны быть только цифры). Удалите ~/ProjectLAN-TG/config.json и запустите установку заново.")

RANK = ["new", "scored", "approved", "sent", "replied", "qualified", "deal", "won"]
STAMP = {"approved": "approvedAt", "sent": "sentAt", "replied": "repliedAt",
         "qualified": "qualifiedAt", "deal": "dealAt", "won": "wonAt"}
SKIP_TG = {"joinchat", "share", "s", "c", "addstickers", "proxy"}


def log(*a):
    print(dt.datetime.now().strftime("%d.%m %H:%M:%S"), *a, flush=True)


def ms(d):
    return int(d.timestamp() * 1000)


def norm_phone(p):
    d = re.sub(r"\D", "", str(p or ""))
    if len(d) == 11 and d[0] == "8":
        d = "7" + d[1:]
    return d[-10:] if len(d) >= 10 else ""


def tg_user(l):
    for s in (l.get("tg"), l.get("url"), l.get("contact"), l.get("replyNote"), l.get("text")):
        m = re.search(r"t(?:elegram)?\.me/@?([A-Za-z][A-Za-z0-9_]{3,31})(?![A-Za-z0-9_/])", str(s or ""), re.I)
        if m and m.group(1).lower() not in SKIP_TG:
            return m.group(1).lower()
    m = re.match(r"^@?([A-Za-z][A-Za-z0-9_]{3,31})$", str(l.get("tg") or "").strip())
    return m.group(1).lower() if m else ""


# ---------- CRM (Supabase) ----------
class CRM:
    def __init__(self):
        r = requests.post(f"{SB}/auth/v1/token?grant_type=password",
                          headers={"apikey": KEY, "Content-Type": "application/json"},
                          json={"email": CFG["crm_email"], "password": CFG["crm_password"]}, timeout=30)
        if r.status_code != 200:
            raise SystemExit("Не удалось войти в CRM: проверьте email и пароль в config.json (" + r.text[:200] + ")")
        self.me = CFG["crm_email"]
        self.h = {"apikey": KEY, "Authorization": "Bearer " + r.json()["access_token"],
                  "Content-Type": "application/json"}

    def leads(self):
        out, off, step = [], 0, 200
        while True:
            for attempt in range(4):
                try:
                    r = requests.get(f"{SB}/rest/v1/leads", headers=self.h, timeout=40,
                                     params={"select": "id,data", "order": "id", "offset": off, "limit": step})
                    r.raise_for_status()
                    break
                except Exception as e:
                    if attempt == 3:
                        raise
                    time.sleep(3 * (attempt + 1))
            rows = r.json()
            out += [{"id": x["id"], **(x["data"] or {})} for x in rows if not (x["data"] or {}).get("archived")]
            if len(rows) < step:
                return out
            off += step

    def patch(self, lid, p):
        if DRY:
            return
        r = requests.post(f"{SB}/rest/v1/rpc/patch_lead", headers=self.h, timeout=30,
                          json={"p_id": lid, "p_patch": p})
        r.raise_for_status()


def stage(l, p, target, now):
    """Двигает лида вперёд по воронке (назад — никогда)."""
    cur = p.get("status", l.get("status") or "new")
    if cur not in RANK or RANK.index(cur) >= RANK.index(target):
        return
    p["status"] = target
    p["log"] = (p.get("log") or list(l.get("log") or [])) + [{"t": now, "s": target, "by": "telegram"}]
    for k in RANK[2:RANK.index(target) + 1]:
        if STAMP.get(k) and not l.get(STAMP[k]):
            p[STAMP[k]] = now


def add_work_days(n):
    d = dt.date.today()
    while n > 0:
        d += dt.timedelta(days=1)
        if d.weekday() < 5:
            n -= 1
    return d.isoformat()


# ---------- основная логика ----------
async def run():
    client = TelegramClient(os.path.join(DIR, "tg"), int(CFG["api_id"]), CFG["api_hash"])
    if "--login" in sys.argv:
        await client.start()
        me = await client.get_me()
        log(f"Вход выполнен: {me.first_name or ''} (@{me.username or '—'})")
        await client.disconnect()
        return
    await client.connect()
    if not await client.is_user_authorized():
        raise SystemExit("Telegram не авторизован. Запустите: python3 tg_sync.py --login")

    crm = CRM()
    leads = crm.leads()
    by_user, by_phone = {}, {}
    for l in leads:
        u = tg_user(l)
        if u:
            by_user.setdefault(u, []).append(l)
        for ph in re.split(r"[;,]", str(l.get("phone") or "")):
            n = norm_phone(ph)
            if n:
                by_phone.setdefault(n, []).append(l)
    log(f"В CRM {len(leads)} лидов: с Telegram-ником {len(by_user)}, с телефоном {len(by_phone)}")

    try:
        state = json.load(open(STATE_F))
    except Exception:
        state = {}

    now = int(time.time() * 1000)
    stats = {"matched": 0, "wrote": 0, "replied": 0, "noanswer": 0}
    async for d in client.iter_dialogs():
        e = d.entity
        if not isinstance(e, User) or e.bot or e.is_self or e.deleted:
            continue
        hit = []
        if e.username and e.username.lower() in by_user:
            hit = by_user[e.username.lower()]
        for un in getattr(e, "usernames", None) or []:
            if not hit and un.username and un.username.lower() in by_user:
                hit = by_user[un.username.lower()]
        if not hit and e.phone and norm_phone(e.phone) in by_phone:
            hit = by_phone[norm_phone(e.phone)]
        if not hit:
            continue
        key = str(e.id)
        top = d.message.id if d.message else 0
        st = state.get(key, {})
        # переписка не менялась, а проверять «нет ответа» уже не нужно — пропускаем
        ids = sorted(l["id"] for l in hit)
        if st.get("top") == top and st.get("done") and st.get("ids") == ids:
            continue
        stats["matched"] += 1
        msgs = await client.get_messages(e, limit=150)
        outs = [m for m in msgs if m.out]
        ins = [m for m in msgs if not m.out and (m.message or m.media)]
        first_out = min(outs, key=lambda m: m.date) if outs else None
        last_out = max(outs, key=lambda m: m.date) if outs else None
        last_in = max(ins, key=lambda m: m.date) if ins else None
        done = True
        for l in hit:
            p = {}
            # 1) мы написали лиду
            tg_touch = any(t.get("src") == "tg" for t in (l.get("touches") or []))
            if first_out and not tg_touch:
                p["touches"] = list(l.get("touches") or []) + [{
                    "t": ms(first_out.date), "by": crm.me, "ch": "messenger", "src": "tg",
                    "note": "Написали в Telegram (отмечено автоматически)"}]
                p["lastTouchAt"] = max(l.get("lastTouchAt") or 0, ms(last_out.date))
                stage(l, p, "sent", now)
                stats["wrote"] += 1
            # 2) лид ответил (или написал первым)
            if last_in and (not first_out or last_in.date > first_out.date) and ms(last_in.date) > (l.get("tgLastIn") or 0):
                new_in = [m for m in ins if ms(m.date) > (l.get("tgLastIn") or 0)]
                new_in.sort(key=lambda m: m.date)
                txt = " / ".join((m.message or "[вложение]").replace("\n", " ") for m in new_in[-3:])[:400]
                p["tgLastIn"] = ms(last_in.date)
                p["replyNote"] = ((l.get("replyNote") or "") + f"\n[Telegram {last_in.date.astimezone().strftime('%d.%m %H:%M')}] {txt}").strip()
                stage(l, p, "replied", now)
                if l.get("resp") == "noanswer":
                    p["resp"] = ""
                    if l.get("autoStep"):
                        p.update({"nextStep": "", "nextDate": "", "autoStep": False})
                if not l.get("nextDate") or l.get("autoStep"):
                    p.update({"nextStep": "Ответить лиду в Telegram и уточнить интерес", "nextDate": add_work_days(1), "autoStep": True})
                stats["replied"] += 1
            # 3) написали, ответа нет NOANSWER_DAYS дней
            no_reply = last_out and (not last_in or last_in.date < last_out.date)
            if no_reply and not l.get("resp") and (p.get("status") or l.get("status")) in ("new", "scored", "approved", "sent"):
                if (dt.datetime.now(dt.timezone.utc) - last_out.date).days >= NOANSWER_DAYS:
                    p["resp"] = "noanswer"
                    p["respAt"] = now
                    p["log"] = (p.get("log") or list(l.get("log") or [])) + [{"t": now, "r": "noanswer", "by": "telegram"}]
                    if not l.get("nextDate") or l.get("autoStep"):
                        p.update({"nextStep": "Повторный контакт: нет ответа в Telegram", "nextDate": add_work_days(2), "autoStep": True})
                    stats["noanswer"] += 1
                else:
                    done = False  # ещё рано — проверим в следующий раз
            if p:
                p["updatedAt"] = now
                p["updatedBy"] = crm.me
                crm.patch(l["id"], p)
                log(f"{'[проба] ' if DRY else ''}{l.get('company') or '—'} / {l.get('name') or e.first_name or ''}: "
                    + ", ".join(k for k in ("touches", "status", "resp", "replyNote") if k in p))
        state[key] = {"top": top, "done": done, "ids": ids}
        await asyncio.sleep(0.3)  # бережём лимиты Telegram

    if not DRY:
        json.dump(state, open(STATE_F, "w"))
    log(f"Готово. Найдено в чатах лидов: {stats['matched']}, отмечено «написали»: {stats['wrote']}, "
        f"«есть ответ»: {stats['replied']}, «нет ответа»: {stats['noanswer']}")
    await client.disconnect()


if __name__ == "__main__":
    asyncio.run(run())
