const DEFAULT_THRESHOLD = 12;
const DEFAULT_MODE = "alerts";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({
        ok: true,
        service: "Zashitaotgnakeuta",
        status: "running",
      }), { headers: JSON_HEADERS });
    }

    if (request.method !== "POST" || url.pathname !== "/telegram/webhook") {
      return new Response(JSON.stringify({ ok: false, error: "Not found" }), {
        status: 404,
        headers: JSON_HEADERS,
      });
    }

    if (!env?.BOT_TOKEN || !env?.STATE) {
      console.error("Worker configuration is incomplete: BOT_TOKEN or STATE is missing");
      return new Response(JSON.stringify({ ok: false, error: "Worker configuration is incomplete" }), {
        status: 500,
        headers: JSON_HEADERS,
      });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }

    // Telegram should receive a quick 200 response; process the update asynchronously.
    const task = handleUpdate(update, env);
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(task);
    } else {
      await task;
    }

    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
  },
};

async function handleUpdate(update, env) {
  try {
    if (update?.my_chat_member) await handleBotMembership(update.my_chat_member, env);
    if (update?.chat_join_request) await handleJoinRequest(update.chat_join_request, env);
    if (update?.chat_member) await handleChatMember(update.chat_member, env);
    if (update?.message) await handlePrivateMessage(update.message, env);
  } catch (error) {
    console.error("Update failed:", error?.stack || error);
  }
}

async function handleBotMembership(update, env) {
  const chat = update.chat;
  const oldStatus = update.old_chat_member?.status;
  const newStatus = update.new_chat_member?.status;
  const botIsAdmin = ["administrator", "creator"].includes(newStatus);
  if (chat?.type !== "channel") return;

  if (botIsAdmin) {
    const previous = await getChannel(env, chat.id);
    const adminsResponse = await telegram(env, "getChatAdministrators", { chat_id: chat.id });
    const adminIds = Array.isArray(adminsResponse.result)
      ? adminsResponse.result
          .filter(item => item?.user?.id != null)
          .map(item => String(item.user.id))
      : [];

    const cfg = {
      ...(previous || {}),
      id: String(chat.id),
      title: chat.title || String(chat.id),
      username: chat.username || "",
      admins: adminIds,
      mode: ["alerts", "protect"].includes(previous?.mode) ? previous.mode : DEFAULT_MODE,
      threshold: Number.isInteger(previous?.threshold) ? previous.threshold : DEFAULT_THRESHOLD,
      enabled: typeof previous?.enabled === "boolean" ? previous.enabled : true,
    };

    await env.STATE.put(channelKey(chat.id), JSON.stringify(cfg));
    await notifyUsers(
      env,
      adminIds,
      `🛡 Бот подключён к каналу <b>${escapeHtml(cfg.title)}</b>.\n` +
        `Режим защиты: <b>${cfg.mode}</b>. Отправьте /channels в личном чате, чтобы посмотреть настройки.`,
    );
  } else if (["administrator", "creator"].includes(oldStatus)) {
    await env.STATE.delete(channelKey(chat.id));
  }
}

async function handleJoinRequest(join, env) {
  const cfg = await getChannel(env, join.chat.id);
  if (!cfg?.enabled) return;

  const count = await countJoin(env, join.chat.id);
  if (count >= cfg.threshold) {
    // Avoid spamming every administrator for every request after the threshold.
    if (count === cfg.threshold || count % 10 === 0) {
      await notifyUsers(
        env,
        cfg.admins,
        `⚠️ <b>Возможный всплеск заявок</b>\nКанал: ${escapeHtml(cfg.title)}\nЗа текущую минуту поступило ${count} заявок.`,
      );
    }
  } else if (count === 1 || count % 10 === 0) {
    await notifyUsers(
      env,
      cfg.admins,
      `📥 Канал: ${escapeHtml(cfg.title)}\nНовых заявок за текущую минуту: ${count}.`,
    );
  }

  const user = join.from;
  if (cfg.mode === "protect" && user?.is_bot === true) {
    const result = await telegram(env, "declineChatJoinRequest", {
      chat_id: join.chat.id,
      user_id: user.id,
    });
    if (result.ok) {
      await notifyUsers(
        env,
        cfg.admins,
        `🤖 Отклонена заявка аккаунта, который Telegram явно пометил как бота: ${userLabel(user)}.`,
      );
    }
  }
}

async function handleChatMember(update, env) {
  const cfg = await getChannel(env, update.chat.id);
  if (!cfg?.enabled) return;

  const member = update.new_chat_member;
  const user = member?.user;
  // Do not try to ban channel administrators or the creator.
  if (!user || user.is_bot !== true || member.status !== "member") return;

  await notifyUsers(
    env,
    cfg.admins,
    `🤖 В канал ${escapeHtml(cfg.title)} вступил аккаунт, который Telegram помечает как бота: ${userLabel(user)}.`,
  );

  if (cfg.mode === "protect") {
    await telegram(env, "banChatMember", {
      chat_id: update.chat.id,
      user_id: user.id,
      revoke_messages: true,
    });
  }
}

async function handlePrivateMessage(message, env) {
  if (!message.text || message.chat?.type !== "private" || !message.from?.id) return;

  const userId = String(message.from.id);
  const chatId = message.chat.id;
  const [rawCommand, ...args] = message.text.trim().split(/\s+/);
  // Also accept Telegram command mentions such as /help@MyBot.
  const command = (rawCommand || "").split("@")[0].toLowerCase();

  if (command === "/start" || command === "/help") {
    await sendMessage(
      env,
      chatId,
      "🛡 <b>Защита от накрутки каналов</b>\n\n" +
        "1. Добавьте бота администратором своего канала.\n" +
        "2. Разрешите управление заявками на вступление и блокировку участников.\n" +
        "3. Для предварительной модерации используйте ссылки с заявками на вступление.\n" +
        "4. Отправьте /channels, чтобы увидеть подключённые каналы.\n\n" +
        "/channels — ваши каналы\n" +
        "/status ID — настройки канала\n" +
        "/mode alerts ID — только уведомления\n" +
        "/mode protect ID — автоматические действия только против аккаунтов, которые Telegram помечает как ботов\n" +
        "/threshold 12 ID — порог заявок в минуту\n\n" +
        "ID канала можно скопировать из команды /channels.",
    );
    return;
  }

  if (command === "/channels") {
    const channels = await listUserChannels(env, userId);
    if (!channels.length) {
      await sendMessage(
        env,
        chatId,
        "Пока нет подключённых каналов, где вы являетесь администратором. Добавьте бота администратором канала и повторите /channels.",
      );
      return;
    }

    const lines = channels.map(channel =>
      `• <b>${escapeHtml(channel.title)}</b> — <code>${escapeHtml(channel.id)}</code>` +
      (channel.username ? ` (@${escapeHtml(channel.username)})` : ""),
    );
    await sendMessage(env, chatId, "Ваши каналы:\n" + lines.join("\n"));
    return;
  }

  if (command === "/status") {
    const cfg = await authorizedConfig(env, args[0], userId);
    if (!cfg) {
      await sendMessage(env, chatId, "Канал не найден или Telegram не подтверждает ваши права администратора. Проверьте ID в /channels.");
      return;
    }
    await sendMessage(
      env,
      chatId,
      `🛡 <b>${escapeHtml(cfg.title)}</b>\nСтатус: <b>${cfg.enabled ? "включена" : "выключена"}</b>\nРежим: <b>${cfg.mode}</b>\nПорог: <b>${cfg.threshold}</b> заявок/минуту`,
    );
    return;
  }

  if (command === "/mode") {
    const mode = args[0]?.toLowerCase();
    const channelId = args[1];
    if (!["alerts", "protect"].includes(mode) || !channelId) {
      await sendMessage(env, chatId, "Использование:\n/mode alerts ID_КАНАЛА\n/mode protect ID_КАНАЛА");
      return;
    }

    const cfg = await authorizedConfig(env, channelId, userId);
    if (!cfg) {
      await sendMessage(env, chatId, "Канал не найден или у вас нет прав администратора.");
      return;
    }
    cfg.mode = mode;
    await env.STATE.put(channelKey(channelId), JSON.stringify(cfg));
    await sendMessage(env, chatId, `Для канала <b>${escapeHtml(cfg.title)}</b> установлен режим <b>${mode}</b>.`);
    return;
  }

  if (command === "/threshold") {
    const threshold = Number(args[0]);
    const channelId = args[1];
    if (!Number.isInteger(threshold) || threshold < 2 || threshold > 1000 || !channelId) {
      await sendMessage(env, chatId, "Использование: /threshold 12 ID_КАНАЛА (целое число от 2 до 1000)");
      return;
    }

    const cfg = await authorizedConfig(env, channelId, userId);
    if (!cfg) {
      await sendMessage(env, chatId, "Канал не найден или у вас нет прав администратора.");
      return;
    }
    cfg.threshold = threshold;
    await env.STATE.put(channelKey(channelId), JSON.stringify(cfg));
    await sendMessage(env, chatId, `Порог для <b>${escapeHtml(cfg.title)}</b>: ${threshold} заявок/минуту.`);
    return;
  }

  await sendMessage(env, chatId, "Неизвестная команда. Напишите /help.");
}

async function authorizedConfig(env, channelId, userId) {
  if (!channelId) return null;
  const cfg = await getChannel(env, channelId);
  if (!cfg?.enabled) return null;

  // Check live Telegram permissions; do not trust the stored admin list alone.
  const member = await telegram(env, "getChatMember", {
    chat_id: channelId,
    user_id: Number(userId),
  });
  if (!member.ok || !["administrator", "creator"].includes(member.result?.status)) return null;
  return cfg;
}

async function listUserChannels(env, userId) {
  const list = await env.STATE.list({ prefix: "channel:" });
  const result = [];

  for (const key of list.keys || []) {
    const cfg = await env.STATE.get(key.name, "json");
    if (!cfg?.enabled || !cfg.admins?.includes(String(userId))) continue;

    // Filter out channels where this user no longer has administrator rights.
    const member = await telegram(env, "getChatMember", {
      chat_id: cfg.id,
      user_id: Number(userId),
    });
    if (member.ok && ["administrator", "creator"].includes(member.result?.status)) {
      result.push(cfg);
    }
  }
  return result;
}

async function getChannel(env, id) {
  return env.STATE.get(channelKey(id), "json");
}

function channelKey(id) {
  return `channel:${String(id)}`;
}

async function countJoin(env, channelId) {
  const minute = Math.floor(Date.now() / 60000);
  const key = `joins:${channelId}:${minute}`;
  const count = Number(await env.STATE.get(key)) + 1 || 1;
  await env.STATE.put(key, String(count), { expirationTtl: 180 });
  return count;
}

async function notifyUsers(env, ids, text) {
  const uniqueIds = [...new Set((ids || []).map(id => String(id)))];
  const results = await Promise.allSettled(uniqueIds.map(id => sendMessage(env, id, text)));
  for (const result of results) {
    if (result.status === "rejected") console.error("Administrator notification failed:", result.reason);
  }
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
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error(`Telegram ${method} network error:`, error?.stack || error);
    return { ok: false, description: "Network error" };
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) console.error(`Telegram ${method} failed:`, data);
  return data;
}

function userLabel(user) {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ") || "Без имени";
  return `${escapeHtml(name)}${user?.username ? ` (@${escapeHtml(user.username)})` : ""}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}
