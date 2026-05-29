#!/usr/bin/env python3
"""
Telegram бот для Halal Shop (запускается как отдельный worker на Render)
Обрабатывает кнопки, геолокацию курьеров, трекинг и т.д.
"""

import os
import sys

# Добавляем корневую папку в путь
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import telebot
from telebot import types

from backend.config import config
from backend.main import (
    COURIER_POOL_ORDER_STATUSES,
    ORDER_COURIER_MESSAGES,
    assign_courier_to_order,
    build_courier_go_button_url,
    build_courier_go_inline_keyboard,
    delete_courier_pool_telegram_messages,
    get_courier_name,
    get_courier_poekhali_pending_order,
    get_order_assignment,
    get_order_from_db,
    is_courier_user,
    save_order_courier_coordinates,
    update_courier_position,
    update_order_in_db,
)


def get_public_url() -> str:
    """Получает PUBLIC_URL из переменных окружения."""
    return os.getenv("PUBLIC_URL", "").rstrip("/")


def main() -> None:
    """Запуск бота в режиме long polling."""
    token = config.BOT_TOKEN
    if not token:
        print("❌ Ошибка: BOT_TOKEN не задан в переменных окружения", file=sys.stderr)
        sys.exit(1)

    public_url = get_public_url()
    if not public_url:
        print("⚠️ Предупреждение: PUBLIC_URL не задан, кнопки курьера могут не работать")

    print(f"🤖 Бот запускается с PUBLIC_URL: {public_url}")
    print(f"📱 BOT_TOKEN: {token[:10]}...")

    bot = telebot.TeleBot(token)

    @bot.callback_query_handler(
        func=lambda call: call.data and call.data.startswith("accept_order_")
    )
    def handle_accept_order(call):
        """Курьер принимает заказ."""
        order_id = call.data.replace("accept_order_", "")
        accepter_id = str(call.from_user.id)
        accepter_name = get_courier_name(accepter_id)

        if not is_courier_user(call.from_user.id):
            bot.answer_callback_query(
                call.id, "❌ Вы не зарегистрированы как курьер.", show_alert=True
            )
            return

        existing_courier, order_status = get_order_assignment(order_id)
        if order_status == "completed":
            bot.answer_callback_query(
                call.id, "❌ Этот заказ уже выполнен.", show_alert=True
            )
            return

        if order_status in ("pending_weight_verification", "awaiting_payment"):
            bot.answer_callback_query(
                call.id, "❌ Заказ ещё не оплачен.", show_alert=True
            )
            return

        pool_statuses = {s.lower() for s in COURIER_POOL_ORDER_STATUSES}
        if (
            order_status
            and order_status.lower() not in pool_statuses
            and order_status != "active"
            and not existing_courier
        ):
            bot.answer_callback_query(
                call.id,
                f"❌ Заказ недоступен (статус: {order_status}).",
                show_alert=True,
            )
            return

        if existing_courier and existing_courier != accepter_id:
            bot.answer_callback_query(
                call.id, "❌ Этот заказ уже принял другой курьер!", show_alert=True
            )
            return

        assign_courier_to_order(order_id, accepter_id, status="active")
        bot.answer_callback_query(
            call.id, f"✅ Заказ №{order_id} закреплён за вами!"
        )

        order_record = get_order_from_db(order_id)
        address = order_record.get("address", "") if order_record else ""

        reply_markup = build_courier_go_inline_keyboard(order_id, public_url)

        courier_message = (
            f"✅ Заказ №{order_id} ваш!\n\n"
            f"📍 Адрес клиента: {address if address else '—'}\n\n"
            "🚀 Нажмите «ПОЕХАЛИ!» — разрешите GPS: координаты сразу "
            "уйдут клиенту и откроется Google Maps с маршрутом до адреса."
        )

        try:
            bot.send_message(
                call.message.chat.id,
                courier_message,
                reply_markup=reply_markup,
                disable_web_page_preview=True,
            )
        except Exception as send_err:
            print(f"❌ Не удалось отправить курьеру: {send_err}")

        taken_text = f"Заказ №{order_id} взят курьером {accepter_name}"
        messages_map = ORDER_COURIER_MESSAGES.get(order_id, {})

        for courier_id, msg_id in messages_map.items():
            chat_id = int(courier_id)
            try:
                if courier_id == accepter_id:
                    bot.edit_message_text(
                        f"✅ {taken_text}\n\nВы везёте этот заказ.",
                        chat_id,
                        msg_id,
                        reply_markup=None,
                    )
                else:
                    bot.edit_message_text(
                        taken_text, chat_id, msg_id, reply_markup=None
                    )
            except Exception as edit_err:
                print(
                    f"⚠️ Не удалось обновить сообщение курьеру {courier_id}: {edit_err}"
                )

    @bot.callback_query_handler(
        func=lambda call: call.data and call.data.startswith("complete_order_")
    )
    def handle_complete_order(call):
        """Курьер отмечает заказ как выполненный."""
        order_id = call.data.replace("complete_order_", "")
        courier_id = str(call.from_user.id)

        assigned_courier, order_status = get_order_assignment(order_id)
        if not assigned_courier or order_status == "completed":
            bot.answer_callback_query(
                call.id, "❌ Заказ не найден или уже завершён.", show_alert=True
            )
            return

        if assigned_courier != courier_id:
            bot.answer_callback_query(
                call.id, "❌ Вы не можете завершить этот заказ", show_alert=True
            )
            return

        update_order_in_db(order_id, status="completed")
        bot.answer_callback_query(call.id, "✅ Заказ отмечен как выполнен!")

        try:
            delete_courier_pool_telegram_messages(
                bot, order_id, chat_id=call.message.chat.id
            )
        except Exception as purge_err:
            print(f"⚠️ complete_order: очистка чата курьеров: {purge_err}")

        try:
            bot.edit_message_text(
                f"Заказ №{order_id}\n\n🏁 СТАТУС: Выполнен",
                call.message.chat.id,
                call.message.message_id,
                reply_markup=None,
            )
        except Exception:
            pass

    @bot.callback_query_handler(
        func=lambda call: call.data and call.data.startswith("courier_go_")
    )
    def handle_courier_go(call):
        """Legacy callback «Поехали» → страница авто-GPS."""
        order_id = call.data.replace("courier_go_", "")
        courier_id = str(call.from_user.id)

        if not is_courier_user(call.from_user.id):
            bot.answer_callback_query(
                call.id, "❌ Вы не зарегистрированы как курьер.", show_alert=True
            )
            return

        order = get_order_from_db(order_id)
        if not order:
            bot.answer_callback_query(
                call.id, "❌ Заказ не найден.", show_alert=True
            )
            return

        if str(order.get("status") or "").lower() == "completed":
            bot.answer_callback_query(
                call.id, "❌ Заказ уже выполнен.", show_alert=True
            )
            return

        assigned = str(order.get("courier_id") or "").strip()
        if assigned and assigned != courier_id:
            bot.answer_callback_query(
                call.id,
                "❌ Этот заказ закреплён за другим курьером.",
                show_alert=True,
            )
            return

        open_url = build_courier_go_button_url(order_id, public_url)
        if not open_url:
            bot.answer_callback_query(
                call.id, "❌ Не настроен PUBLIC_URL.", show_alert=True
            )
            return

        try:
            bot.answer_callback_query(call.id, url=open_url)
        except Exception:
            bot.answer_callback_query(
                call.id, "🚀 Нажмите «ПОЕХАЛИ!» в сообщении выше."
            )

    @bot.message_handler(content_types=["location"])
    def handle_courier_location_trigger(message):
        """Геопозиция по Reply-кнопке «Поехали» — старт доставки."""
        try:
            if (
                not message.location
                or not message.from_user
                or not is_courier_user(message.from_user.id)
            ):
                return

            courier_id = str(message.from_user.id)
            lat = float(message.location.latitude)
            lon = float(message.location.longitude)

            order = get_courier_poekhali_pending_order(courier_id)
            if not order:
                return

            order_id = str(order.get("id") or "")
            if not order_id:
                return

            assign_courier_to_order(order_id, courier_id, status="delivering")
            coords_saved = save_order_courier_coordinates(order_id, lat, lon)
            update_courier_position(int(courier_id), lat, lon)

            print(
                f"📍 Курьер {courier_id} начал доставку заказа {order_id} "
                f"(coords_saved={coords_saved})"
            )

            inline_markup = types.InlineKeyboardMarkup()
            inline_markup.add(
                types.InlineKeyboardButton(
                    text="📦 Выполнено",
                    callback_data=f"complete_order_{order_id}",
                )
            )

            bot.send_message(
                message.chat.id,
                "✅ Сессия доставки запущена!\nКлиент уже видит вас на карте.",
                reply_markup=inline_markup,
            )
        except Exception as loc_err:
            print(f"❌ Ошибка handle_courier_location_trigger: {loc_err}")

    @bot.message_handler(content_types=["web_app_data"])
    def handle_web_app_data(message):
        """Обработка заказа из Mini App (резервный канал)."""
        try:
            order_text = message.web_app_data.data
            username = message.from_user.username if message.from_user else None

            admin_id = config.ADMIN_ID
            if admin_id:
                bot.send_message(
                    int(admin_id),
                    f"🔔 {order_text}\n🔗 Аккаунт: @{username}\n🆔 ID: {message.chat.id}",
                )
                bot.send_message(
                    message.chat.id, "✅ Заказ оформлен! Спасибо за покупку!"
                )
            else:
                print("⚠️ ADMIN_ID не настроен", file=sys.stderr)
        except Exception as e:
            print(f"❌ Ошибка обработки заказа: {e}")

    if public_url:
        web_app_url = f"{public_url}?admin={config.ADMIN_ID}"
        try:
            bot.set_chat_menu_button(
                menu_button=types.MenuButtonWebApp(
                    type="web_app",
                    text="🛍️ Магазин",
                    web_app=types.WebAppInfo(url=web_app_url),
                ),
            )
            print("✅ Кнопка меню обновлена")
        except Exception as e:
            print(f"⚠️ Не удалось обновить кнопку меню: {e}")
    else:
        print("⚠️ PUBLIC_URL не задан, кнопка меню не обновлена")

    print("🤖 Бот запущен и слушает сообщения...")
    print("🔄 Режим: long polling (infinity_polling)")

    bot.infinity_polling(
        timeout=60, long_polling_timeout=60, skip_pending=True
    )


if __name__ == "__main__":
    main()
