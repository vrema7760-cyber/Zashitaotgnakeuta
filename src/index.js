const DEFAULT_THRESHOLD = 12;
const DEFAULT_MODE = "alerts";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({ ok: true, service: "Zashitaotgnakeuta", status: "running" });
    }

    if (request.method !== "POST" || url.pathname !== "/telegram/webhook") {
      return json({ ok: false, error: "Not found" }, 404);
    }

    if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET || !env.STATE) {
      return json({ ok: false, error: "Worker configuration is incomplete" }, 500);
    }

    const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!constantTimeEqual(suppliedSecret || "", env.WEBHOOK_SECRET)) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }

    // Telegram expects a quick response. Process the update in the background.
    ctx.waitUntil(handleUpdate(update, env));
    return json({ ok: true });
  },
};

async function handleUpdate(update, env) {
  try {
    if (update.message) {
      await handleMessage(update.message, env);
      return;
    }

    if (update.chat_join_request) {
      await handleJoinRequest(update.chat_join_request, env);
      return;
    }

    if (update.chat_member) {
      await handleChatMember(update.chat_member, env);
    }
  } catch (error) {
    console.error("Update handler failed:", error?.stack || error);
  }
}

async function handleMessage(message, env) {
  if (!message.text || message.chat?.type !== "private") return;

  const userId = String(message.from?.id || "");
  if (!isAdmin(userId, env)) return;

  const text = message.text.trim();
  const [command, ...args] = text.split(/\s+/);
  const chatId = message.chat.id;

  if (command === "/start" || command === "/help") {
    await sendMessage(env, chatId,
      "🛡 <b>Защита от накрутки</b>\n\n" +
      "/status — состояние защиты\n" +
      "/mode alerts — только уведомления\n" +
      "/mode protect — отклонять заявки явно отмеченных Telegram ботов\n" +
      "/threshold 12 — порог вступлений за минуту\n\n" +
      "Добавьте бота администратором канала и настройте webhook по инструкции в README.");
    return;
  }

  if (command === "/status") {
    const settings = await getSettings(env);
    await sendMessage(env, chatId,
      `🛡 <b>Статус защиты</b>\nРежим: <b>${settings.mode}</b>\nПорог: <b>${settings.threshold}</b> вступлений/минуту\nКанал: <code>${escapeHtml(env.CHANNEL_ID || "не задан")}</code>`);
    return;
  }

  if (command === "/mode") {
    const mode = args[0];
    if (!["alerts", "protect"].includes(mode)) {
      await sendMessage(env, chatId, "Использование: /mode alerts или /mode protect");
      return;
    }
    const settings = await getSettings(env);
    settings.mode = mode;
    await env.STATE.put("settings", JSON.stringify(settings));
    await sendMessage(env, chatId, `Режим изменён: <b>${mode}</b>.`);
    return;
  }

  if (command === "/threshold") {
    const threshold = Number(args[0]);
    if (!Number.isInteger(threshold) || threshold < 2 || threshold > 1000) {
      await sendMessage(env, chatId, "Укажите целое число от 2 до 1000. Например: /threshold 12");
      return;
    }
    const settings = await getSettings(env);
    settings.threshold = threshold;
    await env.STATE.put("settings", JSON.stringify(settings));
    await sendMessage(env, chatId, `Порог установлен: <b>${threshold}</b> вступлений/минуту.`);
    return;
  }

  await sendMessage(env, chatId, "Неизвестная команда. Напишите /help.");
}

async function handleJoinRequest(join, env) {
  if (!isTargetChat(join.chat, env)) return;

  const user = join.from;
  const count = await countJoin(env);
  const settings = await getSettings(env);

  if (count >= settings.threshold) {
    await notifyAdmins(env,
      `⚠️ <b>Возможная накрутка</b>\nЗа последнюю минуту поступило ${count} заявок.\nКандидат: ${userLabel(user)} (<code>${user.id}</code>).`);
  }

  // Telegram's is_bot flag is explicit platform metadata. Do not guess based on profile,
  // username, account age, or join speed.
  if (settings.mode === "protect" && user.is_bot === true) {
    await telegram(env, "declineChatJoinRequest", {
      chat_id: join.chat.id,
      user_id: user.id,
    });
    await notifyAdmins(env, `🤖 Отклонена заявка аккаунта, который Telegram пометил как бота: ${userLabel(user)}.`);
    return;
  }

  if (count === 1 || count % 10 === 0) {
    await notifyAdmins(env, `📥 Новая заявка: ${userLabel(user)}. Заявок за минуту: ${count}.`);
  }
}

async function handleChatMember(update, env) {
  if (!isTargetChat(update.chat, env)) return;

  const member = update.new_chat_member;
  const user = member?.user;
  const joined = ["member", "administrator", "creator"].includes(member?.status);
  if (!user || !joined || user.is_bot !== true) return;

  const settings = await getSettings(env);
  await notifyAdmins(env, `🤖 В канал вступил аккаунт, который Telegram пометил как бота: ${userLabel(user)}.`);

  // This is limited to accounts explicitly identified as bots by Telegram.
  if (settings.mode === "protect" && env.CHANNEL_ID) {
    await telegram(env, "banChatMember", {
      chat_id: update.chat.id,
      user_id: user.id,
      revoke_messages: true,
    });
  }
}

async function countJoin(env) {
  const minute = Math.floor(Date.now() / 60000);
  const key = `joins:${minute}`;
  const current = Number(await env.STATE.get(key) || 0) + 1;
  await env.STATE.put(key, String(current), { expirationTtl: 180 });
  return current;
}

async function getSettings(env) {
  try {
    const saved = await env.STATE.get("settings", "json");
    return {
      mode: saved?.mode === "protect" ? "protect" : DEFAULT_MODE,
      threshold: Number.isInteger(saved?.threshold) ? saved.threshold : DEFAULT_THRESHOLD,
    };
  } catch {
    return { mode: DEFAULT_MODE, threshold: DEFAULT_THRESHOLD };
  }
}

function isTargetChat(chat, env) {
  if (!env.CHANNEL_ID) return true;
  return String(chat?.id) === String(env.CHANNEL_ID);
}

function isAdmin(userId, env) {
  const ids = (env.ADMIN_IDS || "").split(",").map(v => v.trim()).filter(Boolean);
  return ids.includes(String(userId));
}

async function notifyAdmins(env, message) {
  const ids = (env.ADMIN_IDS || "").split(",").map(v => v.trim()).filter(Boolean);
  await Promise.all(ids.map(id => sendMessage(env, id, message)));
}

async function sendMessage(env, chatId, text) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

async function telegram(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    console.error(`Telegram ${method} failed:`, data);
  }
  return data;
}

function userLabel(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || "Без имени";
  const username = user.username ? ` (@${user.username})` : "";
  return `${escapeHtml(name)}${escapeHtml(username)}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
