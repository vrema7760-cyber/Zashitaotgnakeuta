# Zashitaotgnakeuta — Telegram anti-nakрутка bot

Cloudflare Worker + Telegram Bot API. The bot monitors channel join requests and member events, alerts administrators about unusual join bursts, and can automatically reject/ban **only accounts Telegram explicitly marks as bots**.

## Important limitations

- Telegram does not provide a reliable account-creation date or a universal “fake subscriber” signal.
- The bot does not label ordinary users as bots because they lack a photo/username or arrive in a burst.
- For best screening, enable **join requests** on channel invite links and add the bot as an administrator with permission to invite/manage users.
- The automatic `protect` mode is intentionally conservative. Review alerts and manually assess suspicious waves of human-looking accounts.

## 1. Create a Telegram bot

1. Create a bot through [@BotFather](https://t.me/BotFather) and copy its token.
2. Find your Telegram numeric user ID and put it in `ADMIN_IDS`.
3. Add the bot as an administrator of your channel. Give it the permissions needed to manage join requests and restrict/ban members.
4. For join-request screening, use an invite link configured to require administrator approval.

## 2. Create Cloudflare resources

1. Create a Cloudflare Worker named `zashitaotgnakeuta`.
2. Create a Workers KV namespace, for example `ZASHITA_STATE`.
3. In Worker **Settings → Bindings**, add a KV namespace binding:
   - Variable name: `STATE`
   - Namespace: the namespace you created.
4. In Worker **Settings → Variables and Secrets**, add:
   - `BOT_TOKEN` — Telegram bot token (**Secret**)
   - `WEBHOOK_SECRET` — random secret, 32–64 characters using letters, digits, `_` or `-` (**Secret**)
   - `ADMIN_IDS` — comma-separated numeric Telegram user IDs, e.g. `123456789,987654321`
   - `CHANNEL_ID` — channel ID, usually `-100...`; optional if the bot should monitor every chat where it receives updates.

Do not commit real tokens or secrets to GitHub.

## 3. Deploy

Install Wrangler and deploy:

```bash
npm install -g wrangler
wrangler login
wrangler deploy
```

If using this repository with Wrangler, replace the placeholder KV namespace ID in `wrangler.toml` with your actual namespace ID. Alternatively, create the KV binding in the Cloudflare dashboard.

Your Worker URL will look like:

```text
https://zashitaotgnakeuta.<your-subdomain>.workers.dev
```

Webhook endpoint:

```text
https://zashitaotgnakeuta.<your-subdomain>.workers.dev/telegram/webhook
```

## 4. Register the Telegram webhook

Replace the placeholders and open this URL (or run the equivalent request):

```text
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<WORKER_HOST>/telegram/webhook&secret_token=<WEBHOOK_SECRET>&allowed_updates=%5B%22message%22%2C%22chat_join_request%22%2C%22chat_member%22%5D
```

Telegram should return `{"ok":true,"result":true,...}`.

Check webhook status:

```text
https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo
```

Keep the bot token private; do not paste the full webhook URL into public chats because it contains the token.

## 5. Commands

Send these commands to the bot in a private chat from an ID listed in `ADMIN_IDS`:

- `/start` or `/help` — help
- `/status` — current mode and threshold
- `/mode alerts` — notifications only (default)
- `/mode protect` — reject join requests from accounts Telegram explicitly marks as bots; also remove such bot accounts if they join directly and Telegram reports them as bots
- `/threshold 12` — alert when 12 or more join requests are observed in one minute

## How detection works

- Counts incoming join requests in one-minute windows using KV.
- Alerts admins when the configured threshold is reached.
- Reports explicit Telegram bot accounts.
- Does not use unreliable heuristics such as missing avatar, missing username, display name, or guessed account age.

## Troubleshooting

- **Bot does not receive requests:** check `getWebhookInfo`, `allowed_updates`, Worker logs, and that the bot is an administrator.
- **Join requests are not detected:** ensure invite links require approval and that `chat_join_request` is included in webhook `allowed_updates`.
- **Member joins are not detected:** include `chat_member` in `allowed_updates`; the bot must be an administrator.
- **No admin alerts:** check that `ADMIN_IDS` contains your numeric Telegram user ID and that you have opened a private chat with the bot and pressed Start.
- **401 from Worker:** make sure the webhook `secret_token` exactly matches the `WEBHOOK_SECRET` Worker secret.

## Project structure

```text
.
├── src/
│   └── index.js
├── wrangler.toml
├── README.md
└── .gitignore
```
