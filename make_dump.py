import os

# Имя итогового файла дампа
DUMP_FILE = "project_dump.txt"

# Список папок, файлы из которых мы хотим собрать
TARGET_FOLDERS = ["backend", "frontend"]

# Расширения файлов, которые нужно прочитать
VALID_EXTENSIONS = [".py", ".js", ".html", ".css", ".txt", ".json"]

# Файлы или папки, которые нужно проигнорировать (чтобы не собирать лишнее)
IGNORE_LIST = ["project_dump.txt", "make_dump.py", "__pycache__", ".env", "node_modules"]

def create_project_dump():
    root_dir = os.getcwd()
    print(f"=== Запуск сборки дампа проекта в папке: {root_dir} ===")
    
    with open(DUMP_FILE, "w", encoding="utf-8") as dump:
        dump.write(f"=== ПОЛНЫЙ ДАМП ПРОЕКТА: {os.path.basename(root_dir)} ===\n")
        dump.write(f"=== Автоматически сгенерировано скриптом ===\n\n")
        
        file_count = 0
        
        # Обходим дерево проекта
        for root, dirs, files in os.walk(root_dir):
            # Пропускаем игнорируемые папки
            dirs[:] = [d for d in dirs if d not in IGNORE_LIST]
            
            # Проверяем, находится ли текущая папка внутри целевых (backend/frontend)
            # или это сам корень проекта
            relative_path = os.path.relpath(root, root_dir)
            current_folder = relative_path.split(os.sep)[0]
            
            if current_folder != "." and current_folder not in TARGET_FOLDERS:
                continue
                
            for file in files:
                if file in IGNORE_LIST:
                    continue
                    
                file_path = os.path.join(root, file)
                file_ext = os.path.splitext(file)[1]
                
                # Собираем только текстовый код
                if file_ext in VALID_EXTENSIONS:
                    display_path = os.path.relpath(file_path, root_dir)
                    print(f"Добавление файла: {display_path}")
                    
                    dump.write(f"\n" + "="*80 + "\n")
                    dump.write(f"ФАЙЛ: {display_path}\n")
                    dump.write(f"================" + "="*len(display_path) + "\n\n")
                    
                    try:
                        with open(file_path, "r", encoding="utf-8") as f:
                            dump.write(f.read())
                    except Exception as e:
                        dump.write(f"[Ошибка чтения файла {display_path}: {e}]\n")
                        
                    dump.write("\n\n")
                    file_count += 1
                    
        dump.write("\n" + "="*80 + "\n")
        dump.write("=== КОНЕЦ ДАМПА ПРОЕКТА ===\n")
        
    print(f"\n✅ Готово! Успешно собрано файлов: {file_count}")
    print(f"📁 Результат сохранен в: {os.path.abspath(DUMP_FILE)}")

if __name__ == "__main__":
    create_project_dump()
