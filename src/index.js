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
    if (!env.BOT_TOKEN || !env.STATE) {
      return json({ ok: false, error: "Worker configuration is incomplete" }, 500);
    }
    let update;
    try { update = await request.json(); }
    catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    ctx.waitUntil(handleUpdate(update, env));
    return json({ ok: true });
  },
};

async function handleUpdate(update, env) {
  try {
    if (update.my_chat_member) await handleBotMembership(update.my_chat_member, env);
    if (update.chat_join_request) await handleJoinRequest(update.chat_join_request, env);
    if (update.chat_member) await handleChatMember(update.chat_member, env);
    if (update.message) await handlePrivateMessage(update.message, env);
  } catch (e) {
    console.error("Update failed:", e?.stack || e);
  }
}

async function handleBotMembership(update, env) {
  const chat = update.chat;
  const oldStatus = update.old_chat_member?.status;
  const newStatus = update.new_chat_member?.status;
  const botIsAdmin = ["administrator", "creator"].includes(newStatus);
  if (chat?.type !== "channel") return;

  if (botIsAdmin) {
    const admins = await telegram(env, "getChatAdministrators", { chat_id: chat.id });
    const adminIds = Array.isArray(admins.result)
      ? admins.result.map(x => String(x.user.id))
      : [];
    await env.STATE.put(channelKey(chat.id), JSON.stringify({
      id: String(chat.id),
      title: chat.title || String(chat.id),
      username: chat.username || "",
      admins: adminIds,
      mode: DEFAULT_MODE,
      threshold: DEFAULT_THRESHOLD,
      enabled: true,
    }));
    await notifyUsers(env, adminIds,
      `🛡 Бот подключён к каналу <b>${escapeHtml(chat.title || String(chat.id))}</b>.\n` +
      `Защита работает в режиме уведомлений. Напишите боту в личку /channels, чтобы посмотреть каналы и настройки.`);
  } else if ( oldStatus === "administrator" || oldStatus === "creator" ) {
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
  if (cfg.mode === "protect" && user.is_bot === true) {
    await telegram(env, "declineChatJoinRequest", { chat_id: join.chat.id, user_id: user.id });
    await notifyUsers(env, cfg.admins,
      `🤖 Отклонена заявка аккаунта, который Telegram явно пометил как бота: ${userLabel(user)}.`);
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

  await notifyUsers(env, cfg.admins,
    `🤖 В канал ${escapeHtml(cfg.title)} вступил аккаунт, который Telegram помечает как бота: ${userLabel(user)}.`);
  if (cfg.mode === "protect") {
    await telegram(env, "banChatMember", {
      chat_id: update.chat.id, user_id: user.id, revoke_messages: true,
    });
  }
}

async function handlePrivateMessage(message, env) {
  if (!message.text || message.chat?.type !== "private") return;
  const userId = String(message.from?.id || "");
  const chatId = message.chat.id;
  const [command, ...args] = message.text.trim().split(/\s+/);

  if (command === "/start" || command === "/help") {
    await sendMessage(env, chatId,
      "🛡 <b>Защита от накрутки каналов</b>\n\n" +
      "Бот публичный: им может пользоваться любой владелец/администратор канала.\n\n" +
      "1. Добавьте бота администратором своего канала.\n" +
      "2. Разрешите ему управление заявками и блокировку участников.\n" +
      "3. Используйте пригласительные ссылки с заявками на вступление.\n" +
      "4. Откройте личный чат с ботом и отправьте /channels.\n\n" +
      "/channels — ваши подключённые каналы\n" +
      "/status ID — настройки канала\n" +
      "/mode alerts ID — только уведомления\n" +
      "/mode protect ID — осторожная авто-защита\n" +
      "/threshold 12 ID — порог заявок в минуту");
    return;
  }

  if (command === "/channels") {
    const channels = await listUserChannels(env, userId);
    if (!channels.length) {
      await sendMessage(env, chatId,
        "Пока нет подключённых каналов.\nДобавьте бота администратором канала, затем повторите /channels.");
      return;
    }
    const lines = channels.map(c =>
      `• <b>${escapeHtml(c.title)}</b> — <code>${escapeHtml(c.id)}</code>${c.username ? ` (@${escapeHtml(c.username)})` : ""}`
    );
    await sendMessage(env, chatId, "Ваши каналы:\n" + lines.join("\n"));
    return;
  }

  if (command === "/status") {
    const cfg = await authorizedConfig(env, args[0], userId);
    if (!cfg) return sendMessage(env, chatId, "Не найден канал или у вас нет прав администратора этого канала. Сначала добавьте бота администратором.");
    return sendMessage(env, chatId,
      `🛡 <b>${escapeHtml(cfg.title)}</b>\nРежим: <b>${cfg.mode}</b>\nПорог: <b>${cfg.threshold}</b> заявок/минуту`);
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

  await sendMessage(env, chatId, "Неизвестная команда. Напишите /help.");
}

async function authorizedConfig(env, channelId, userId) {
  if (!channelId) return null;
  const cfg = await getChannel(env, channelId);
  if (!cfg?.enabled) return null;
  // Re-check current Telegram admin rights, rather than trusting stale stored membership.
  const member = await telegram(env, "getChatMember", { chat_id: channelId, user_id: Number(userId) });
  if (!member.ok || !["administrator", "creator"].includes(member.result?.status)) return null;
  return cfg;
}

async function listUserChannels(env, userId) {
  const list = await env.STATE.list({ prefix: "channel:" });
  const result = [];
  for (const key of list.keys) {
    const cfg = await env.STATE.get(key.name, "json");
    if (cfg?.enabled && cfg.admins?.includes(String(userId))) result.push(cfg);
  }
  return result;
}

async function getChannel(env, id) {
  return env.STATE.get(channelKey(id), "json");
}
function channelKey(id) { return `channel:${String(id)}`; }

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
    chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
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
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || "Без имени";
  return `${escapeHtml(name)}${user.username ? ` (@${escapeHtml(user.username)})` : ""}`;
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}
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
    if (!env.BOT_TOKEN || !env.STATE) {
      return json({ ok: false, error: "Worker configuration is incomplete" }, 500);
    }
    let update;
    try { update = await request.json(); }
    catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    ctx.waitUntil(handleUpdate(update, env));
    return json({ ok: true });
  },
};

async function handleUpdate(update, env) {
  try {
    if (update.my_chat_member) await handleBotMembership(update.my_chat_member, env);
    if (update.chat_join_request) await handleJoinRequest(update.chat_join_request, env);
    if (update.chat_member) await handleChatMember(update.chat_member, env);
    if (update.message) await handlePrivateMessage(update.message, env);
  } catch (e) {
    console.error("Update failed:", e?.stack || e);
  }
}

async function handleBotMembership(update, env) {
  const chat = update.chat;
  const oldStatus = update.old_chat_member?.status;
  const newStatus = update.new_chat_member?.status;
  const botIsAdmin = ["administrator", "creator"].includes(newStatus);
  if (chat?.type !== "channel") return;

  if (botIsAdmin) {
    const admins = await telegram(env, "getChatAdministrators", { chat_id: chat.id });
    const adminIds = Array.isArray(admins.result)
      ? admins.result.map(x => String(x.user.id))
      : [];
    await env.STATE.put(channelKey(chat.id), JSON.stringify({
      id: String(chat.id),
      title: chat.title || String(chat.id),
      username: chat.username || "",
      admins: adminIds,
      mode: DEFAULT_MODE,
      threshold: DEFAULT_THRESHOLD,
      enabled: true,
    }));
    await notifyUsers(env, adminIds,
      `🛡 Бот подключён к каналу <b>${escapeHtml(chat.title || String(chat.id))}</b>.\n` +
      `Защита работает в режиме уведомлений. Напишите боту в личку /channels, чтобы посмотреть каналы и настройки.`);
  } else if ( oldStatus === "administrator" || oldStatus === "creator" ) {
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
  if (cfg.mode === "protect" && user.is_bot === true) {
    await telegram(env, "declineChatJoinRequest", { chat_id: join.chat.id, user_id: user.id });
    await notifyUsers(env, cfg.admins,
      `🤖 Отклонена заявка аккаунта, который Telegram явно пометил как бота: ${userLabel(user)}.`);
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

  await notifyUsers(env, cfg.admins,
    `🤖 В канал ${escapeHtml(cfg.title)} вступил аккаунт, который Telegram помечает как бота: ${userLabel(user)}.`);
  if (cfg.mode === "protect") {
    await telegram(env, "banChatMember", {
      chat_id: update.chat.id, user_id: user.id, revoke_messages: true,
    });
  }
}

async function handlePrivateMessage(message, env) {
  if (!message.text || message.chat?.type !== "private") return;
  const userId = String(message.from?.id || "");
  const chatId = message.chat.id;
  const [command, ...args] = message.text.trim().split(/\s+/);

  if (command === "/start" || command === "/help") {
    await sendMessage(env, chatId,
      "🛡 <b>Защита от накрутки каналов</b>\n\n" +
      "Бот публичный: им может пользоваться любой владелец/администратор канала.\n\n" +
      "1. Добавьте бота администратором своего канала.\n" +
      "2. Разрешите ему управление заявками и блокировку участников.\n" +
      "3. Используйте пригласительные ссылки с заявками на вступление.\n" +
      "4. Откройте личный чат с ботом и отправьте /channels.\n\n" +
      "/channels — ваши подключённые каналы\n" +
      "/status ID — настройки канала\n" +
      "/mode alerts ID — только уведомления\n" +
      "/mode protect ID — осторожная авто-защита\n" +
      "/threshold 12 ID — порог заявок в минуту");
    return;
  }

  if (command === "/channels") {
    const channels = await listUserChannels(env, userId);
    if (!channels.length) {
      await sendMessage(env, chatId,
        "Пока нет подключённых каналов.\nДобавьте бота администратором канала, затем повторите /channels.");
      return;
    }
    const lines = channels.map(c =>
      `• <b>${escapeHtml(c.title)}</b> — <code>${escapeHtml(c.id)}</code>${c.username ? ` (@${escapeHtml(c.username)})` : ""}`
    );
    await sendMessage(env, chatId, "Ваши каналы:\n" + lines.join("\n"));
    return;
  }

  if (command === "/status") {
    const cfg = await authorizedConfig(env, args[0], userId);
    if (!cfg) return sendMessage(env, chatId, "Не найден канал или у вас нет прав администратора этого канала. Сначала добавьте бота администратором.");
    return sendMessage(env, chatId,
      `🛡 <b>${escapeHtml(cfg.title)}</b>\nРежим: <b>${cfg.mode}</b>\nПорог: <b>${cfg.threshold}</b> заявок/минуту`);
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

  await sendMessage(env, chatId, "Неизвестная команда. Напишите /help.");
}

async function authorizedConfig(env, channelId, userId) {
  if (!channelId) return null;
  const cfg = await getChannel(env, channelId);
  if (!cfg?.enabled) return null;
  // Re-check current Telegram admin rights, rather than trusting stale stored membership.
  const member = await telegram(env, "getChatMember", { chat_id: channelId, user_id: Number(userId) });
  if (!member.ok || !["administrator", "creator"].includes(member.result?.status)) return null;
  return cfg;
}

async function listUserChannels(env, userId) {
  const list = await env.STATE.list({ prefix: "channel:" });
  const result = [];
  for (const key of list.keys) {
    const cfg = await env.STATE.get(key.name, "json");
    if (cfg?.enabled && cfg.admins?.includes(String(userId))) result.push(cfg);
  }
  return result;
}

async function getChannel(env, id) {
  return env.STATE.get(channelKey(id), "json");
}
function channelKey(id) { return `channel:${String(id)}`; }

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
    chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
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
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || "Без имени";
  return `${escapeHtml(name)}${user.username ? ` (@${escapeHtml(user.username)})` : ""}`;
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
    status, headers: { "content-type": "application/json; charset=utf-8" },
  });
}
