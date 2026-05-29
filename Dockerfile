FROM python:3.11-slim

WORKDIR /app

# Устанавливаем системные зависимости
RUN apt-get update && apt-get install -y \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Копируем requirements и устанавливаем зависимости
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn

# Копируем весь проект
COPY . .

# Создаем папку для uploads (если нет)
RUN mkdir -p frontend/uploads

# Открываем порт
EXPOSE 8080

# Запускаем приложение
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "run:app"]
