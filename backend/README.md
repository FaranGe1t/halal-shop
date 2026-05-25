# Backend (Halol Market)

Flask API, статическая раздача `frontend/`, Telegram-бот. Деплой в облако — через **Gunicorn** и переменные окружения (Render и аналоги).

## Структура репозитория

```
halal_shop/
  backend/    ← вы здесь
  frontend/
```

## Настройка

1. Виртуальное окружение и зависимости:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r ..\requirements.txt
```

(Минимальный список зависимостей — в `requirements.txt` в **корне** репозитория.)

2. Переменные окружения (`.env` локально или панель Render):

| Переменная | Обязательно | Описание |
|------------|-------------|----------|
| `BOT_TOKEN` | да | токен бота от @BotFather |
| `ADMIN_ID` | желательно | Telegram user id админа |
| `PUBLIC_URL` | да (прод) | публичный HTTPS-URL сервиса, напр. `https://your-app.onrender.com` |
| `GOOGLE_MAPS_API_KEY` | для адреса/карты | ключ Google Cloud (Maps JavaScript API, Places, Geocoding) |
| `PORT` | на Render | порт задаёт платформа (Gunicorn `--bind 0.0.0.0:$PORT`) |

Туннель **ngrok** в коде не используется.

## Запуск

### Продакшен (Render / Gunicorn)

**Web-сервис** — только HTTP:

```bash
cd backend
gunicorn main:app --bind 0.0.0.0:${PORT:-8080} --workers 2 --threads 4
```

**Worker** — long polling бота (отдельный Background Worker на Render):

```bash
cd backend
python main.py
```

У worker те же `BOT_TOKEN`, `PUBLIC_URL`, `ADMIN_ID`.

### Локально

Терминал 1 (HTTP):

```bash
cd backend
set RUN_MODE=flask
set PUBLIC_URL=http://127.0.0.1:8080
python main.py
```

Терминал 2 (бот):

```bash
cd backend
python main.py
```

Либо один процесс Gunicorn + отдельно `python main.py` для бота.

## Полезные эндпоинты

- `GET /api/products` — каталог
- `POST /api/save_products` — сохранение каталога (ADMIN_ID)

## Render (кратко)

1. **Web Service**: Build `pip install -r requirements.txt gunicorn`, Start `gunicorn main:app --bind 0.0.0.0:$PORT`.
2. **Background Worker**: Start `python main.py`.
3. `PUBLIC_URL` = URL web-сервиса (без слэша в конце).
