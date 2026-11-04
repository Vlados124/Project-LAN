#!/bin/bash
# Установка синхронизации Telegram → CRM Project LAN на macOS.
# Запуск: curl -fsSL https://vlados124.github.io/Project-LAN/tools/tg-sync/install.sh | bash
set -e
BASE="https://vlados124.github.io/Project-LAN/tools/tg-sync"
DIR="$HOME/ProjectLAN-TG"
PLIST="$HOME/Library/LaunchAgents/ru.projectlan.tgsync.plist"
TTY=/dev/tty

echo ""
echo "=== Project LAN: Telegram → CRM ==="
echo ""

if ! command -v python3 >/dev/null 2>&1 || ! python3 -c "import venv" 2>/dev/null; then
  echo "Нужен Python 3. Сейчас macOS предложит установить «Инструменты командной строки» — нажмите «Установить»,"
  echo "дождитесь окончания и запустите эту команду ещё раз."
  xcode-select --install 2>/dev/null || true
  exit 1
fi

mkdir -p "$DIR"
cd "$DIR"
echo "1/5  Скачиваю программу в $DIR"
curl -fsSL "$BASE/tg_sync.py?$(date +%s)" -o tg_sync.py

echo "2/5  Устанавливаю библиотеку Telegram (1–2 минуты)…"
[ -d venv ] || python3 -m venv venv
./venv/bin/pip install -q --upgrade pip >/dev/null 2>&1 || true
./venv/bin/pip install -q "telethon>=1.34,<2" "requests>=2.28" "urllib3<2"

if [ ! -f config.json ]; then
  echo ""
  echo "3/5  Настройка. Данные сохраняются только на этом Mac (файл $DIR/config.json)."
  echo "     api_id и api_hash — со страницы my.telegram.org → API development tools."
  read -r -p "     api_id (только цифры): " API_ID < $TTY
  read -r -p "     api_hash (длинная строка из букв и цифр): " API_HASH < $TTY
  read -r -p "     Email для входа в CRM: " CRM_EMAIL < $TTY
  read -r -s -p "     Пароль от CRM (не отображается): " CRM_PASS < $TTY; echo ""
  API_ID="$API_ID" API_HASH="$API_HASH" CRM_EMAIL="$CRM_EMAIL" CRM_PASS="$CRM_PASS" ./venv/bin/python - <<'PY'
import json, os
json.dump({
  "api_id": os.environ["API_ID"].strip(), "api_hash": os.environ["API_HASH"].strip(),
  "crm_email": os.environ["CRM_EMAIL"].strip(), "crm_password": os.environ["CRM_PASS"],
  "supabase_url": "https://zdhfzwinofszrqpxvmai.supabase.co",
  "anon_key": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpkaGZ6d2lub2ZzenJxcHh2bWFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1MDkyNjQsImV4cCI6MjEwODA4NTI2NH0.N3STGKe9e2Jz9K5J1yY81FoG2dT_z-MSXqQK5rhNs0A",
  "noanswer_days": 3
}, open("config.json", "w"), ensure_ascii=False, indent=1)
PY
  chmod 600 config.json
else
  echo "3/5  Настройки уже есть (config.json) — оставляю."
fi

if [ ! -f tg.session ]; then
  echo ""
  echo "4/5  Вход в Telegram. Введите номер телефона в формате +79991234567,"
  echo "     затем код, который придёт в Telegram (и облачный пароль, если он включён)."
  ./venv/bin/python tg_sync.py --login < $TTY
else
  echo "4/5  Вход в Telegram уже выполнен."
fi
chmod 600 tg.session 2>/dev/null || true

echo "5/5  Включаю автозапуск каждый час"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ru.projectlan.tgsync</string>
  <key>ProgramArguments</key><array><string>$DIR/venv/bin/python</string><string>$DIR/tg_sync.py</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DIR/log.txt</string>
  <key>StandardErrorPath</key><string>$DIR/log.txt</string>
</dict></plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

echo ""
echo "Первая проверка чатов (может занять пару минут)…"
./venv/bin/python tg_sync.py || true
echo ""
echo "Готово. Дальше проверка идёт сама каждый час, пока Mac включён."
echo "Журнал: $DIR/log.txt"
echo "Отключить: launchctl unload -w $PLIST"
