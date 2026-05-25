# Халяль Маркет — Telegram Mini App

Проект для офлайн-магазина халяльных продуктов с доставкой: **backend** на Python ([pyTelegramBotAPI](https://pypi.org/project/pyTelegramBotAPI/) / telebot), **frontend** — веб-интерфейс магазина как Telegram Web App.

## Структура

- `backend/` — Telegram-бот, команда `/start` и кнопка открытия Mini App.
- `frontend/` — статическая страница (`index.html`, стили и скрипт для Telegram WebApp API).

После настройки укажите реальный HTTPS-URL приложения в `handlers/start.py` вместо тестового `google.com`.
