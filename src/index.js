const DEFAULT_THRESHOLD = 12;
const DEFAULT_MODE = "alerts";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return json({ ok: true, service: "tgguard", status: "running" });
    }
    if (request.method !== "POST" || url.pathname !== "/telegram/webhook") {
      return json({ ok: false, error: "Not found" }, 404);
    }
    if (!env.BOT_TOKEN || !env.STATE) {
      return json({ ok: false, error: "Worker configuration is incomplete" }, 500);
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }
    ctx.waitUntil(handleUpdate(update, env));
    return json({ ok: true });
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function handleUpdate(update, env) {
  try {
    if (update.my_chat_member) await handleBotMembership(update.my_chat_member, env);
    if (update.chat_join_request) await handleJoinRequest(update.chat_join_request, env);
    if (update.chat_member) await handleChatMember(update.chat_member, env);
    if (update.message) await handlePrivateMessage(update.message, env);
  } catch (error) {
    console.error("Update failed:", error?.stack || error);
  }
}

async function handleBotMembership(update, env) {
  const chat = update.chat;
  const oldStatus = update.old_chat_member?.status;
  const newStatus = update.new_chat_member?.status;
  if (chat?.type !== "channel") return;

  if (["administrator", "creator"].includes(newStatus)) {
    const adminsResponse = await telegram(env, "getChatAdministrators", { chat_id: chat.id });
    const adminIds = Array.isArray(adminsResponse.result)
      ? adminsResponse.result.map(item => String(item.user.id))
      : [];
    const previous = await getChannel(env, chat.id);
    const cfg = {
      id: String(chat.id),
      title: chat.title || String(chat.id),
      username: chat.username || "",
      admins: adminIds,
      mode: previous?.mode || DEFAULT_MODE,
      threshold: previous?.threshold || DEFAULT_THRESHOLD,
      enabled: true,
    };
    await env.STATE.put(channelKey(chat.id), JSON.stringify(cfg));
    await notifyUsers(env, adminIds,
      `🛡 Бот подключён к каналу <b>${escapeHtml(cfg.title)}</b>.\n` +
      `Настройки: /channels. Режим по умолчанию — уведомления.`);
  } else if (["administrator", "creator"].includes(oldStatus)) {
    await env.STATE.delete(channelKey(chat.id));
  }
}

async function handleJoinRequest(join, env) {
  const cfg = await getChannel(env, join.chat.id);
  if (!cfg?.enabled) return;

  const count = await countJoin(env, join.chat.id);
  if (count >= cfg.threshold) {
    await notifyUsers(env, cfg.admins,
      `⚠️ <b>Возможная накрутка</b>\nКанал: ${escapeHtml(cfg.title)}\nЗа минуту поступило ${count} заявок.`);
  }

  const user = join.from;
  if (user?.is_bot === true) {
    const action = cfg.mode === "protect" ? "заявка отклонена" : "обнаружен";
    await recordBot(env, user, cfg, action);
    if (cfg.mode === "protect") {
      await telegram(env, "declineChatJoinRequest", { chat_id: join.chat.id, user_id: user.id });
    }
    await notifyUsers(env, cfg.admins,
      `🤖 ${action === "заявка отклонена" ? "Отклонена заявка" : "Обнаружен аккаунт"} Telegram-бота в канале ` +
      `<b>${escapeHtml(cfg.title)}</b>: ${userLabel(user)}.\nID: <code>${user.id}</code>\n` +
      `База обнаруженных ботов: /bots`);
  } else if (count === 1 || count % 10 === 0) {
    await notifyUsers(env, cfg.admins,
      `📥 Канал: ${escapeHtml(cfg.title)}\nНовых заявок за минуту: ${count}.`);
  }
}

async function handleChatMember(update, env) {
  const cfg = await getChannel(env, update.chat.id);
  if (!cfg?.enabled) return;
  const member = update.new_chat_member;
  const user = member?.user;
  const joined = ["member", "administrator", "creator"].includes(member?.status);
  if (!user || !joined || user.is_bot !== true) return;

  let action = "обнаружен";
  if (cfg.mode === "protect") {
    const result = await telegram(env, "banChatMember", {
      chat_id: update.chat.id,
      user_id: user.id,
      revoke_messages: true,
    });
    action = result.ok ? "заблокирован" : "обнаружен (не удалось заблокировать)";
  }
  await recordBot(env, user, cfg, action);
  await notifyUsers(env, cfg.admins,
    `🤖 В канале <b>${escapeHtml(cfg.title)}</b> ${action} Telegram-бот: ${userLabel(user)}.\n` +
    `ID: <code>${user.id}</code>\nБаза обнаруженных ботов: /bots`);
}

async function recordBot(env, user, cfg, action) {
  const key = botKey(user.id);
  const existing = await env.STATE.get(key, "json") || {};
  let photoFileId = existing.photoFileId || null;
  let photoCount = existing.photoCount || 0;

  // Telegram may provide profile photos for a known user ID; availability is not guaranteed.
  if (!photoFileId) {
    const photos = await telegram(env, "getUserProfilePhotos", {
      user_id: user.id,
      limit: 1,
    });
    const first = photos.result?.photos?.[0];
    if (first?.length) {
      photoFileId = first[first.length - 1].file_id;
      photoCount = photos.result.total_count || 0;
    }
  }

  const channels = existing.channels || {};
  const oldChannel = channels[String(cfg.id)];
  channels[String(cfg.id)] = {
    title: cfg.title,
    username: cfg.username || "",
    firstSeenAt: oldChannel?.firstSeenAt || new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    action,
  };
  const record = {
    id: String(user.id),
    isBot: user.is_bot === true,
    firstName: user.first_name || existing.firstName || "",
    lastName: user.last_name || existing.lastName || "",
    username: user.username || existing.username || "",
    languageCode: user.language_code || existing.languageCode || "",
    photoFileId,
    photoCount,
    firstSeenAt: existing.firstSeenAt || new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    channels,
  };
  await env.STATE.put(key, JSON.stringify(record));
}

async function handlePrivateMessage(message, env) {
  if (!message.text || message.chat?.type !== "private") return;
  const userId = String(message.from?.id || "");
  const chatId = message.chat.id;
  const [rawCommand, ...args] = message.text.trim().split(/\s+/);
  const command = (rawCommand || "").split("@")[0].toLowerCase();

  if (command === "/start" || command === "/help") {
    return sendMessage(env, chatId,
      "🛡 <b>Защита от накрутки каналов</b>\n\n" +
      "Добавьте бота администратором своего канала. Список ниже показывает только каналы, где вы сейчас администратор.\n\n" +
      "/channels — ваши каналы\n" +
      "/status ID — настройки канала\n" +
      "/mode alerts ID — уведомления без авто-защиты\n" +
      "/mode protect ID — автоматическая защита\n" +
      "/threshold 12 ID — порог заявок в минуту\n" +
      "/bots — база Telegram-ботов, обнаруженных в ваших каналах\n" +
      "/bot ID — сведения об обнаруженном боте\n\n" +
      "Важно: Telegram Bot API не сообщает дату создания аккаунта. Фото профиля может быть недоступно.");
  }

  if (command === "/channels") {
    const channels = await listUserChannels(env, userId);
    if (!channels.length) {
      return sendMessage(env, chatId,
        "У вас пока нет подключённых каналов, где бот является администратором и вы сами остаетесь администратором.");
    }
    const lines = channels.map(channel =>
      `• <b>${escapeHtml(channel.title)}</b> — <code>${escapeHtml(channel.id)}</code>` +
      (channel.username ? ` (@${escapeHtml(channel.username)})` : "") +
      `\n  Режим: <b>${escapeHtml(channel.mode)}</b>, порог: ${channel.threshold}`
    );
    return sendMessage(env, chatId, "📺 <b>Ваши каналы:</b>\n\n" + lines.join("\n\n"));
  }

  if (command === "/bots") {
    const channels = await listUserChannels(env, userId);
    const channelIds = new Set(channels.map(channel => String(channel.id)));
    if (!channelIds.size) {
      return sendMessage(env, chatId, "Сначала подключите свой канал: добавьте бота администратором и отправьте /channels.");
    }
    const records = await listBotRecords(env);
    const visible = records.filter(record =>
      Object.keys(record.channels || {}).some(id => channelIds.has(id))
    ).sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));

    if (!visible.length) {
      return sendMessage(env, chatId, "В базе пока нет Telegram-ботов, обнаруженных в ваших каналах.");
    }
    const lines = visible.slice(0, 30).map(record => {
      const name = userLabel(record);
      const channelNames = Object.entries(record.channels || {})
        .filter(([id]) => channelIds.has(id))
        .map(([, info]) => info.title)
        .filter(Boolean);
      return `• ${name}\n  ID: <code>${record.id}</code>\n  Канал: ${escapeHtml([...new Set(channelNames)].join(", "))}\n  Последнее обнаружение: ${escapeHtml(formatDate(record.lastSeenAt))}`;
    });
    return sendMessage(env, chatId,
      `🤖 <b>База ботов в ваших каналах</b>\nНайдено: ${visible.length}${visible.length > 30 ? " (показаны первые 30)" : ""}\n\n` +
      lines.join("\n\n") + "\n\nПодробности: /bot ID");
  }

  if (command === "/bot") {
    const targetId = args[0];
    if (!targetId || !/^\d+$/.test(targetId)) {
      return sendMessage(env, chatId, "Использование: /bot ID\nID можно скопировать из команды /bots.");
    }
    const channels = await listUserChannels(env, userId);
    const allowedChannelIds = new Set(channels.map(channel => String(channel.id)));
    const record = await env.STATE.get(botKey(targetId), "json");
    if (!record || !Object.keys(record.channels || {}).some(id => allowedChannelIds.has(id))) {
      return sendMessage(env, chatId, "Запись не найдена или у вас нет доступа к каналу, где этот аккаунт обнаружили.");
    }
    const sightings = Object.entries(record.channels || {})
      .filter(([id]) => allowedChannelIds.has(id))
      .map(([, info]) =>
        `• <b>${escapeHtml(info.title)}</b>\n  Первое обнаружение: ${escapeHtml(formatDate(info.firstSeenAt))}\n  Последнее обнаружение: ${escapeHtml(formatDate(info.lastSeenAt))}\n  Действие: ${escapeHtml(info.action || "обнаружен")}`
      );
    const username = record.username ? `@${escapeHtml(record.username)}` : "не указан";
    const name = [record.firstName, record.lastName].filter(Boolean).join(" ") || "не указано";
    const text =
      `🤖 <b>Карточка обнаруженного бота</b>\n\n` +
      `Имя: ${escapeHtml(name)}\nНикнейм: ${username}\nID: <code>${escapeHtml(record.id)}</code>\n` +
      `Язык: ${escapeHtml(record.languageCode || "неизвестен")}\n` +
      `Фото профиля: ${record.photoFileId ? `доступно (сохранено фото, всего в момент проверки: ${record.photoCount})` : "недоступно"}\n` +
      `Дата создания аккаунта: <b>Telegram API не предоставляет эти данные</b>\n\n` +
      `<b>Обнаружения в ваших каналах:</b>\n${sightings.join("\n\n")}`;
    if (record.photoFileId) {
      await sendPhoto(env, chatId, record.photoFileId, text);
      return;
    }
    return sendMessage(env, chatId, text);
  }

  if (command === "/status") {
    const cfg = await authorizedConfig(env, args[0], userId);
    if (!cfg) return sendMessage(env, chatId, "Канал не найден или у вас нет прав администратора.");
    return sendMessage(env, chatId,
      `🛡 <b>${escapeHtml(cfg.title)}</b>\nРежим: <b>${escapeHtml(cfg.mode)}</b>\nПорог: <b>${cfg.threshold}</b> заявок/минуту`);
  }

  if (command === "/mode") {
    const mode = args[0];
    const channelId = args[1];
    if (!["alerts", "protect"].includes(mode) || !channelId) {
      return sendMessage(env, chatId, "Использование:\n/mode alerts ID_КАНАЛА\n/mode protect ID_КАНАЛА");
    }
    const cfg = await authorizedConfig(env, channelId, userId);
    if (!cfg) return sendMessage(env, chatId, "Канал не найден или у вас нет прав администратора.");
    cfg.mode = mode;
    await env.STATE.put(channelKey(channelId), JSON.stringify(cfg));
    return sendMessage(env, chatId, `Для канала <b>${escapeHtml(cfg.title)}</b> установлен режим <b>${mode}</b>.`);
  }

  if (command === "/threshold") {
    const threshold = Number(args[0]);
    const channelId = args[1];
    if (!Number.isInteger(threshold) || threshold < 2 || threshold > 1000 || !channelId) {
      return sendMessage(env, chatId, "Использование: /threshold 12 ID_КАНАЛА (число от 2 до 1000)");
    }
    const cfg = await authorizedConfig(env, channelId, userId);
    if (!cfg) return sendMessage(env, chatId, "Канал не найден или у вас нет прав администратора.");
    cfg.threshold = threshold;
    await env.STATE.put(channelKey(channelId), JSON.stringify(cfg));
    return sendMessage(env, chatId, `Порог для <b>${escapeHtml(cfg.title)}</b>: ${threshold} заявок/минуту.`);
  }

  return sendMessage(env, chatId, "Неизвестная команда. Напишите /help.");
}

async function authorizedConfig(env, channelId, userId) {
  if (!channelId) return null;
  const cfg = await getChannel(env, channelId);
  if (!cfg?.enabled || !cfg.admins?.includes(String(userId))) return null;
  const member = await telegram(env, "getChatMember", {
    chat_id: channelId,
    user_id: Number(userId),
  });
  if (!member.ok || !["administrator", "creator"].includes(member.result?.status)) return null;
  return cfg;
}

async function listUserChannels(env, userId) {
  const result = [];
  const list = await env.STATE.list({ prefix: "channel:" });
  for (const key of list.keys) {
    const cfg = await env.STATE.get(key.name, "json");
    if (!cfg?.enabled || !cfg.admins?.includes(String(userId))) continue;
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

async function listBotRecords(env) {
  const records = [];
  let cursor;
  do {
    const page = await env.STATE.list({ prefix: "bot:", cursor, limit: 1000 });
    for (const key of page.keys) {
      const record = await env.STATE.get(key.name, "json");
      if (record) records.push(record);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return records;
}

async function getChannel(env, id) {
  return env.STATE.get(channelKey(id), "json");
}
function channelKey(id) { return `channel:${String(id)}`; }
function botKey(id) { return `bot:${String(id)}`; }

async function countJoin(env, channelId) {
  const minute = Math.floor(Date.now() / 60000);
  const key = `joins:${channelId}:${minute}`;
  const count = Number(await env.STATE.get(key) || 0) + 1;
  await env.STATE.put(key, String(count), { expirationTtl: 180 });
  return count;
}

async function notifyUsers(env, ids, text) {
  await Promise.all((ids || []).map(id => sendMessage(env, id, text)));
}
async function sendMessage(env, chatId, text) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}
async function sendPhoto(env, chatId, photo, caption) {
  return telegram(env, "sendPhoto", {
    chat_id: chatId,
    photo,
    caption: caption.slice(0, 1024),
    parse_mode: "HTML",
  });
}
async function telegram(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) console.error(`Telegram ${method} failed:`, data);
  return data;
}
function userLabel(user) {
  const name = [user.firstName || user.first_name, user.lastName || user.last_name]
    .filter(Boolean).join(" ") || "Без имени";
  const username = user.username ? ` (@${user.username})` : "";
  return `${escapeHtml(name)}${escapeHtml(username)}`;
}
function formatDate(value) {
  if (!value) return "неизвестно";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "неизвестно" : date.toLocaleString("ru-RU", { timeZone: "UTC" }) + " UTC";
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}
