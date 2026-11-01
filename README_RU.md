# TG Guard — бот, инлайн-кнопки и Web App

## Что внутри

- `src/index.js` — Telegram webhook, команды, обработка инлайн-кнопок, защита и API Web App.
- `src/ui.js` — клавиатуры Telegram. Обычные кнопки «Мои каналы» и «База ботов» не зависят от настройки Web App.
- `webapp.html` — исходный HTML панели управления.
- `src/webapp.js` — HTML, встроенный в Worker без ошибок вложенных шаблонных строк.
- `scripts/build-webapp.mjs` — пересобирает `src/webapp.js` после изменения `webapp.html`.

## Развертывание через Wrangler

1. Установите Node.js и откройте терминал в этой папке.
2. Создайте KV-хранилище командой `npx wrangler kv namespace create STATE`.
3. Скопируйте выданный `id` в поле `id` файла `wrangler.toml` вместо `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.
4. Установите секрет токена: `npx wrangler secret put BOT_TOKEN` и вставьте токен вашего бота в приглашение терминала. Токен не записывайте в исходный код.
5. Выполните `npm run build:webapp`, затем `npm run check`.
6. Опубликуйте Worker: `npx wrangler deploy`. Скопируйте HTTPS-адрес Worker из вывода команды.

В Cloudflare Worker должны быть доступны binding KV с именем `STATE` и secret `BOT_TOKEN`. Если вы используете другой способ публикации, убедитесь, что все три файла из `src/` опубликованы вместе.

## Обязательная настройка webhook Telegram

`allowed_updates` должен включать `callback_query`, иначе кнопки могут отображаться, но нажатия не будут доходить до Worker. После публикации выполните команду, заменив `BOT_TOKEN` и адрес Worker своими значениями:

```bash
curl -X POST "https://api.telegram.org/botBOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://YOUR-WORKER.workers.dev/telegram/webhook","allowed_updates":["message","callback_query","my_chat_member","chat_member","chat_join_request"]}'
```

Проверка состояния webhook:

```bash
curl "https://api.telegram.org/botBOT_TOKEN/getWebhookInfo"
```

После обновления кода отправьте боту `/start` заново. Кнопки показываются в новом сообщении; старые сообщения Telegram автоматически не обновляет.

## Web App

Путь панели: `https://YOUR-WORKER.workers.dev/app`. Кнопка Web App строится автоматически из HTTPS-домена Worker, если не задан `WEBAPP_URL`. При использовании отдельного домена задайте `WEBAPP_URL` как HTTPS URL панели. В BotFather привяжите домен бота через `/setdomain`, если Telegram требует такую привязку для вашего домена.

Web App использует подписанный `initData`, перепроверяет права текущего пользователя администратора на сервере и позволяет просматривать только связанные с его каналами записи. Для изменения HTML отредактируйте `webapp.html`, выполните `npm run build:webapp` и повторно опубликуйте Worker.

## Важные ограничения Telegram

Telegram Bot API не предоставляет дату создания аккаунта. Фото профиля и отдельные поля доступны не для всех пользователей/ботов. Режим защиты может требовать, чтобы бот имел соответствующие административные права в канале.
