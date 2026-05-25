import sys
import os

# Добавляем текущую папку в путь
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Простой импорт без относительных путей
from backend import main

app = main.app

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
