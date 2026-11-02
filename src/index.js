import { mainKeyboard, channelsKeyboard, channelActionsKeyboard } from "./ui.js";
import { WEBAPP_HTML } from "./webapp.js";

const DEFAULT_THRESHOLD = 12;
const DEFAULT_MODE = "alerts";
const DEFAULT_MODERATION = Object.freeze({
  antiSpam: false,
  antiProfanity: false,
  antiLinks: false,
  antiRaid: false,
  profanityMuteMinutes: 30,
  spamMuteMinutes: 5,
  raidThreshold: DEFAULT_THRESHOLD,
  profanityWords: ["бля", "бляд", "сука", "хуй", "хуе", "хуё", "пизд", "еба", "ебл", "ёб", "мудак", "гандон", "шлюх", "залуп"],
});
const MAX_LOG_ITEMS = 100;

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(refreshAllSubscriberSnapshots(env).catch(error => {
      console.error("Scheduled subscriber snapshot failed:", error?.stack || error);
    }));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return json({ ok: true, service: "tgguard", status: "running", app: "/app" });
    if (request.method === "GET" && url.pathname === "/app") return new Response(WEBAPP_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
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
    ctx.waitUntil(handleUpdate(update, env, url.origin));
    return json({ ok: true });
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function handleUpdate(update, env, publicOrigin = "") {
  try {
    if (update.my_chat_member) await handleBotMembership(update.my_chat_member, env);
    if (update.chat_join_request) await handleJoinRequest(update.chat_join_request, env);
    if (update.chat_member) await handleChatMember(update.chat_member, env);
    if (update.message) {
      if (update.message.chat?.type === "private") await handlePrivateMessage(update.message, env, publicOrigin);
      else if (["group", "supergroup"].includes(update.message.chat?.type)) {
        await handleModerationMessage(update.message, env);
      }
    }
    if (update.channel_post) await handleChannelPostModeration(update.channel_post, env);
    if (update.callback_query) await handleCallbackQuery(update.callback_query, env, publicOrigin);
  } catch (error) {
    console.error("Update failed:", error?.stack || error);
  }
}

async function handleBotMembership(update, env) {
  const chat = update.chat;
  const oldStatus = update.old_chat_member?.status;
  const newStatus = update.new_chat_member?.status;
  if (!["channel", "group", "supergroup"].includes(chat?.type)) return;

  if (["administrator", "creator"].includes(newStatus)) {
    const adminsResponse = await telegram(env, "getChatAdministrators", { chat_id: chat.id });
    const adminIds = Array.isArray(adminsResponse.result)
      ? adminsResponse.result.filter(item => item.user?.is_bot !== true).map(item => String(item.user.id))
      : [];
    const previous = await getChannel(env, chat.id);
    const cfg = {
      id: String(chat.id),
      title: chat.title || String(chat.id),
      username: chat.username || "",
      chatType: chat.type,
      admins: adminIds,
      mode: previous?.mode || DEFAULT_MODE,
      threshold: previous?.threshold || DEFAULT_THRESHOLD,
      moderation: normalizeModeration(previous?.moderation),
      enabled: true,
    };
    await env.STATE.put(channelKey(chat.id), JSON.stringify(cfg));
    await refreshChannelSubscriberSnapshot(env, cfg).catch(error => {
      console.error("Initial subscriber snapshot failed:", error?.stack || error);
    });
    await notifyUsers(env, adminIds,
      `🛡 TG Guard подключён к ${chat.type === "channel" ? "каналу" : "группе"} <b>${escapeHtml(cfg.title)}</b>.\n` +
      `Настройки: /channels. Модерация сообщений выключена до настройки в Web App.`);
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
      `⚠️ <b>Возможная подозрительная активность</b>\nКанал: ${escapeHtml(cfg.title)}\nЗа минуту поступило ${count} заявок на вступление.`);
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

  const oldMember = update.old_chat_member;
  const member = update.new_chat_member;
  const user = member?.user || oldMember?.user;
  if (!user) return;

  const wasMember = isChatMemberPresent(oldMember);
  const isMember = isChatMemberPresent(member);
  const joined = !wasMember && isMember;
  const left = wasMember && !isMember;

  if (joined || left) {
    if (joined && ["group", "supergroup"].includes(update.chat?.type)) {
      await env.STATE.put(joinedAtKey(update.chat.id, user.id), String(Date.now()), { expirationTtl: 60 * 60 * 24 });
    } else if (left) {
      await env.STATE.delete(joinedAtKey(update.chat.id, user.id));
    }
    await recordSubscriberTransition(env, cfg, user, joined ? "join" : "leave");
  }

  // Only treat a bot as a newly detected bot when it actually joins, not when its
  // existing membership role changes from member to administrator, for example.
  if (!joined || user.is_bot !== true) return;

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

function isChatMemberPresent(member) {
  if (!member) return false;
  if (["creator", "administrator", "member"].includes(member.status)) return true;
  return member.status === "restricted" && member.is_member === true;
}

async function recordSubscriberTransition(env, cfg, user, type) {
  const now = Date.now();
  const channelId = String(cfg.id);
  const hourStart = Math.floor(now / 3600000) * 3600000;
  const minuteStart = Math.floor(now / 60000) * 60000;
  const isBot = user?.is_bot === true;

  const hourKey = `analytics:hour:${channelId}:${timestampKey(hourStart)}`;
  const hourRecord = await env.STATE.get(hourKey, "json") || {
    channelId, timestamp: hourStart, joins: 0, leaves: 0, botJoins: 0, botLeaves: 0,
  };
  if (type === "join") {
    hourRecord.joins = Number(hourRecord.joins || 0) + 1;
    if (isBot) hourRecord.botJoins = Number(hourRecord.botJoins || 0) + 1;
  } else {
    hourRecord.leaves = Number(hourRecord.leaves || 0) + 1;
    if (isBot) hourRecord.botLeaves = Number(hourRecord.botLeaves || 0) + 1;
  }
  await env.STATE.put(hourKey, JSON.stringify(hourRecord), { expirationTtl: 60 * 60 * 24 * 60 });

  // Fine-grained counters are retained for 48 hours and used only for spike detection.
  const minuteKey = `analytics:minute:${channelId}:${timestampKey(minuteStart)}`;
  const minuteRecord = await env.STATE.get(minuteKey, "json") || {
    channelId, timestamp: minuteStart, joins: 0, leaves: 0, botJoins: 0, botLeaves: 0,
  };
  if (type === "join") {
    minuteRecord.joins = Number(minuteRecord.joins || 0) + 1;
    if (isBot) minuteRecord.botJoins = Number(minuteRecord.botJoins || 0) + 1;
  } else {
    minuteRecord.leaves = Number(minuteRecord.leaves || 0) + 1;
    if (isBot) minuteRecord.botLeaves = Number(minuteRecord.botLeaves || 0) + 1;
  }
  await env.STATE.put(minuteKey, JSON.stringify(minuteRecord), { expirationTtl: 60 * 60 * 48 });

  // Without a configured cron trigger, active channels still get one count snapshot
  // per hour as member events arrive. The dashboard can also force a fresh count.
  const snapshotKey = `analytics:snapshot:${channelId}:${timestampKey(hourStart)}`;
  if (!(await env.STATE.get(snapshotKey))) {
    const snapshot = await refreshChannelSubscriberSnapshot(env, cfg).catch(error => {
      console.error(`Subscriber snapshot failed for ${channelId}:`, error?.message || error);
      return null;
    });
    if (snapshot) {
      // This may be the first-ever sample and is taken after the current event.
      // Reverse the transitions seen in this hour to store the real hour baseline.
      const startCount = Math.max(0, Number(snapshot.count) - Number(hourRecord.joins || 0) + Number(hourRecord.leaves || 0));
      await env.STATE.put(snapshotKey, JSON.stringify({
        ...snapshot, count: startCount, timestamp: hourStart, bucketStart: hourStart,
      }), { expirationTtl: 60 * 60 * 24 * 60 });
    }
  }

  const moderationSettings = normalizeModeration(cfg.moderation);
  const standardThreshold = Math.max(2, Number(cfg.threshold) || DEFAULT_THRESHOLD);
  const threshold = moderationSettings.antiRaid && ["group", "supergroup"].includes(cfg.chatType)
    ? Math.min(standardThreshold, Math.max(2, moderationSettings.raidThreshold)) : standardThreshold;
  if (type !== "join" || Number(minuteRecord.joins) < threshold) return;
  const moderation = normalizeModeration(cfg.moderation);
  const shouldActivateRaid = moderation.antiRaid && ["group", "supergroup"].includes(cfg.chatType) &&
    Number(minuteRecord.joins) >= Math.max(2, moderation.raidThreshold);
  if (shouldActivateRaid) {
    const activeUntil = Number(await env.STATE.get(raidKey(channelId)) || 0);
    if (activeUntil <= now) {
      const raidUntil = now + 5 * 60 * 1000;
      await env.STATE.put(raidKey(channelId), String(raidUntil), { expirationTtl: 5 * 60 });
      await writeModerationLog(env, cfg.id, { type: "anti_raid", userId: "", userName: "",
        reason: `Всплеск вступлений: ${minuteRecord.joins} за минуту`, action: "raid_mode", timestamp: now, durationMinutes: 5 });
      await notifyUsers(env, cfg.admins, `🛡 <b>Анти-рейд включён</b> в чате <b>${escapeHtml(cfg.title)}</b> на 5 минут.\nВступлений за минуту: ${minuteRecord.joins}. Сообщения недавно вступивших участников будут удаляться. Капчи нет.`);
    }
  }
  const alertKey = `analytics:alert:${channelId}:${timestampKey(minuteStart)}`;
  const existingAlert = await env.STATE.get(alertKey, "json");
  if (existingAlert) {
    if (Number(minuteRecord.joins) > Number(existingAlert.joins || 0)) {
      existingAlert.joins = Number(minuteRecord.joins);
      existingAlert.botJoins = Number(minuteRecord.botJoins || 0);
      existingAlert.updatedAt = now;
      await env.STATE.put(alertKey, JSON.stringify(existingAlert), { expirationTtl: 60 * 60 * 24 * 60 });
    }
    return;
  }

  const alert = {
    channelId,
    title: cfg.title || channelId,
    timestamp: now,
    bucketStart: minuteStart,
    type: "subscriber_spike",
    joins: Number(minuteRecord.joins),
    threshold,
    botJoins: Number(minuteRecord.botJoins || 0),
  };
  await env.STATE.put(alertKey, JSON.stringify(alert), { expirationTtl: 60 * 60 * 24 * 60 });
  await notifyUsers(env, cfg.admins,
    `⚠️ <b>Подозрительный всплеск вступлений</b>\n` +
    `Чат: <b>${escapeHtml(cfg.title)}</b>\n` +
    `За одну минуту зафиксировано не менее ${alert.joins} новых участников (порог: ${threshold}).\n` +
    `Это сигнал для проверки, а не автоматическое доказательство накрутки.`);
}

function timestampKey(value) {
  return String(Math.trunc(Number(value))).padStart(13, "0");
}

async function saveSubscriberSnapshot(env, channelId, count, timestamp = Date.now()) {
  const id = String(channelId);
  const bucketStart = Math.floor(timestamp / 3600000) * 3600000;
  const record = { channelId: id, count: Number(count), timestamp, bucketStart };
  const bucketKey = `analytics:snapshot:${id}:${timestampKey(bucketStart)}`;
  const ttl = { expirationTtl: 60 * 60 * 24 * 60 };

  // Keep the first count seen in each hour as the baseline. Overwriting this
  // value on every dashboard refresh erased the before/after change and made
  // a chart impossible to draw during the first hour after setup.
  if (!(await env.STATE.get(bucketKey))) {
    await env.STATE.put(bucketKey, JSON.stringify(record), ttl);
  }
  // The latest sample is separate from the hourly baseline and is returned
  // to the API for a live chart endpoint.
  await env.STATE.put(`analytics:current:${id}`, JSON.stringify(record), ttl);
  return record;
}

async function refreshChannelSubscriberSnapshot(env, cfg) {
  const result = await telegram(env, "getChatMemberCount", { chat_id: cfg.id });
  if (!result.ok || !Number.isFinite(Number(result.result))) return null;
  return saveSubscriberSnapshot(env, cfg.id, Number(result.result));
}

async function refreshAllSubscriberSnapshots(env) {
  if (!env.BOT_TOKEN || !env.STATE) return;
  let cursor;
  do {
    const page = await env.STATE.list({ prefix: "channel:", cursor, limit: 1000 });
    const configs = [];
    for (const key of page.keys) {
      const cfg = await env.STATE.get(key.name, "json");
      if (cfg?.enabled && cfg.id) configs.push(cfg);
    }
    // Keep concurrency bounded to avoid bursting Telegram's API rate limits.
    for (let i = 0; i < configs.length; i += 10) {
      await Promise.all(configs.slice(i, i + 10).map(cfg =>
        refreshChannelSubscriberSnapshot(env, cfg).catch(error => {
          console.error(`Subscriber snapshot failed for ${cfg.id}:`, error?.message || error);
          return null;
        })
      ));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

async function readJsonPrefix(env, prefix) {
  const records = [];
  let cursor;
  do {
    const page = await env.STATE.list({ prefix, cursor, limit: 1000 });
    const values = await Promise.all(page.keys.map(key => env.STATE.get(key.name, "json")));
    for (const value of values) if (value) records.push(value);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return records;
}

async function getChannelAnalytics(env, channel, refreshCurrent = true) {
  const now = Date.now();
  let freshSnapshot = null;
  if (refreshCurrent) {
    try { freshSnapshot = await refreshChannelSubscriberSnapshot(env, channel); }
    catch (error) { console.error(`Could not refresh current count for ${channel.id}:`, error?.message || error); }
  }
  const id = String(channel.id);
  const [snapshotsRaw, hourlyRaw, alertsRaw] = await Promise.all([
    readJsonPrefix(env, `analytics:snapshot:${id}:`),
    readJsonPrefix(env, `analytics:hour:${id}:`),
    readJsonPrefix(env, `analytics:alert:${id}:`),
  ]);
  const cutoff30d = now - 30 * 24 * 60 * 60 * 1000;
  const snapshotByBucket = new Map();
  for (const item of snapshotsRaw) {
    if (!Number.isFinite(Number(item.bucketStart)) || Number(item.bucketStart) < cutoff30d) continue;
    snapshotByBucket.set(String(item.bucketStart), item);
  }
  const history = [...snapshotByBucket.values()]
    .filter(item => Number.isFinite(Number(item.count)))
    .sort((a, b) => Number(a.bucketStart || a.timestamp) - Number(b.bucketStart || b.timestamp))
    .map(item => ({ timestamp: Number(item.bucketStart || Math.floor(Number(item.timestamp) / 3600000) * 3600000), count: Number(item.count) }));
  const hourly = hourlyRaw
    .filter(item => Number(item.timestamp) >= cutoff30d)
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp)
    ).map(item => ({
      timestamp: Number(item.timestamp), joins: Number(item.joins || 0), leaves: Number(item.leaves || 0),
      botJoins: Number(item.botJoins || 0), botLeaves: Number(item.botLeaves || 0),
    }));
  const alerts = alertsRaw
    .filter(item => Number(item.timestamp) >= cutoff30d)
    .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
    .slice(0, 30)
    .map(item => ({
      timestamp: Number(item.timestamp), type: item.type || "subscriber_spike",
      joins: Number(item.joins || 0), threshold: Number(item.threshold || channel.threshold || DEFAULT_THRESHOLD),
      botJoins: Number(item.botJoins || 0), title: item.title || channel.title,
    }));

  const sumSince = (field, days) => hourly.reduce((sum, item) =>
    sum + (item.timestamp >= now - days * 24 * 60 * 60 * 1000 ? Number(item[field] || 0) : 0), 0);
  const currentCount = freshSnapshot?.count ?? history.at(-1)?.count ?? null;
  if (freshSnapshot && currentCount !== null) {
    const currentBucket = Math.floor(Number(freshSnapshot.timestamp) / 3600000) * 3600000;
    const currentHour = hourly.find(item => item.timestamp === currentBucket);
    const baselineIndex = history.findIndex(item => item.timestamp === currentBucket);
    // If the first snapshot was taken only after the first member event, infer
    // the start-of-hour count from the exact join/leave counters.
    if (currentHour && (currentHour.joins || currentHour.leaves)) {
      const inferredStart = Math.max(0, Number(currentCount) - currentHour.joins + currentHour.leaves);
      if (baselineIndex >= 0) history[baselineIndex].count = inferredStart;
      else history.push({ timestamp: currentBucket, count: inferredStart });
    }
    // Add a live point, not just the hourly bucket. This lets a newly enabled
    // monitor show a visible change immediately instead of waiting one hour.
    history.push({ timestamp: Math.max(Number(freshSnapshot.timestamp), currentBucket + 1), count: Number(currentCount) });
    history.sort((a, b) => a.timestamp - b.timestamp);
  }
  const baseline = history.filter(item => item.timestamp <= now - 24 * 60 * 60 * 1000).at(-1);
  return {
    channelId: id,
    title: channel.title || id,
    username: channel.username || "",
    currentCount,
    countUpdatedAt: freshSnapshot?.timestamp ?? history.at(-1)?.timestamp ?? null,
    history,
    hourly,
    alerts,
    stats: {
      joins24h: sumSince("joins", 1), leaves24h: sumSince("leaves", 1),
      joins7d: sumSince("joins", 7), leaves7d: sumSince("leaves", 7),
      joins30d: sumSince("joins", 30), leaves30d: sumSince("leaves", 30),
      growth24h: currentCount !== null && baseline ? Number(currentCount) - Number(baseline.count) : null,
      alerts30d: alertsRaw.filter(item => Number(item.timestamp) >= cutoff30d).length,
    },
  };
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

function normalizeModeration(value) {
  const source = value && typeof value === "object" ? value : {};
  const defaults = DEFAULT_MODERATION;
  const words = Array.isArray(source.profanityWords) ? source.profanityWords : defaults.profanityWords;
  return {
    antiSpam: source.antiSpam === true,
    antiProfanity: source.antiProfanity === true,
    antiLinks: source.antiLinks === true,
    antiRaid: source.antiRaid === true,
    profanityMuteMinutes: clampInteger(source.profanityMuteMinutes, 30, 1, 10080),
    spamMuteMinutes: clampInteger(source.spamMuteMinutes, 5, 1, 1440),
    raidThreshold: clampInteger(source.raidThreshold, DEFAULT_THRESHOLD, 2, 1000),
    profanityWords: [...new Set(words.map(word => String(word).trim().slice(0, 50)).filter(Boolean))].slice(0, 200),
  };
}
function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
function joinedAtKey(chatId, userId) { return `member-joined:${String(chatId)}:${String(userId)}`; }
function raidKey(chatId) { return `raid:${String(chatId)}`; }
function modLogPrefix(chatId) { return `modlog:${String(chatId)}:`; }
function warningPrefix(chatId) { return `warning:${String(chatId)}:`; }
function warningKey(chatId, userId) { return `${warningPrefix(chatId)}${String(userId)}`; }
async function writeModerationLog(env, chatId, event) {
  const timestamp = Number(event.timestamp || Date.now());
  const suffix = `${String(timestamp).padStart(13, "0")}:${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
  const record = { chatId: String(chatId), timestamp, ...event };
  await env.STATE.put(`${modLogPrefix(chatId)}${suffix}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 90 });
}
async function addWarning(env, chatId, userId, reason, byUserId = "system", type = "warning") {
  const key = warningKey(chatId, userId);
  const existing = await env.STATE.get(key, "json") || { chatId: String(chatId), userId: String(userId), count: 0, history: [] };
  const item = { reason: String(reason).slice(0, 300), byUserId: String(byUserId), timestamp: Date.now(), type };
  existing.count = Math.max(0, Number(existing.count) || 0) + 1;
  existing.updatedAt = item.timestamp;
  existing.history = [...(Array.isArray(existing.history) ? existing.history : []), item].slice(-20);
  await env.STATE.put(key, JSON.stringify(existing), { expirationTtl: 60 * 60 * 24 * 180 });
  return existing;
}
async function isChatAdmin(env, chatId, userId, cfg) {
  if ((cfg.admins || []).includes(String(userId))) return true;
  const key = `admin-cache:${chatId}:${userId}`;
  const cached = await env.STATE.get(key);
  if (cached === "yes") return true;
  if (cached === "no") return false;
  const result = await telegram(env, "getChatMember", { chat_id: chatId, user_id: userId });
  const admin = result.ok && ["administrator", "creator"].includes(result.result?.status);
  await env.STATE.put(key, admin ? "yes" : "no", { expirationTtl: 60 });
  return admin;
}
function normalizeForFilter(value) {
  return String(value || "").toLocaleLowerCase("ru-RU")
    .normalize("NFKC")
    .replace(/[ё]/g, "е")
    .replace(/[aа@]/g, "а").replace(/[eе3]/g, "е")
    .replace(/[oо0]/g, "о").replace(/[pр]/g, "р").replace(/[cс]/g, "с")
    .replace(/[xх]/g, "х").replace(/[yу]/g, "у").replace(/[kк]/g, "к")
    .replace(/[mм]/g, "м").replace(/[tт]/g, "т").replace(/[bв]/g, "в")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, " ")
    .replace(/\s+/g, " ").trim();
}
function containsProfanity(text, configuredWords) {
  const normalized = normalizeForFilter(text);
  if (!normalized) return false;
  const tokens = normalized.split(/\s+/).map(token => token.replace(/\d/g, ch => ({ "0":"о", "1":"и", "3":"з", "4":"ч", "5":"с", "6":"б", "7":"т", "8":"в" }[ch] || ch)));
  const compact = tokens.join(" ");
  for (const raw of configuredWords || []) {
    const word = normalizeForFilter(raw).replace(/\s+/g, "");
    if (word.length < 3) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}[\\p{L}]*?(?=$|[^\\p{L}\\p{N}])`, "u");
    if (pattern.test(compact)) return true;
    if (tokens.some(token => token.includes(word) && token.length <= word.length + 6)) return true;
  }
  return false;
}
function hasLink(text, entities = []) {
  return /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|(?:^|\s)@[a-z0-9_]{5,})/i.test(String(text || "")) ||
    (Array.isArray(entities) && entities.some(entity => ["url", "text_link"].includes(entity.type)));
}
async function handleChannelPostModeration(message, env) {
  // Channel posts can be removed for prohibited content/links, but muting subscribers is not available in channels.
  const cfg = await getChannel(env, message.chat?.id);
  if (!cfg?.enabled || message.chat?.type !== "channel") return;
  const moderation = normalizeModeration(cfg.moderation);
  const text = message.text || message.caption || "";
  if (!text) return;
  let reason = "";
  if (moderation.antiProfanity && containsProfanity(text, moderation.profanityWords)) reason = "Ненормативная лексика в публикации";
  else if (moderation.antiLinks && hasLink(text, message.entities || message.caption_entities)) reason = "Ссылка запрещена настройками";
  if (!reason) return;
  const deleted = await telegram(env, "deleteMessage", { chat_id: message.chat.id, message_id: message.message_id });
  await writeModerationLog(env, cfg.id, { type: reason.includes("лексика") ? "profanity" : "link", userId: "", userName: "Публикация канала", reason,
    action: deleted.ok ? "deleted" : "delete_failed", timestamp: Date.now(), messageId: message.message_id });
  if (!deleted.ok) await notifyUsers(env, cfg.admins, `⚠️ TG Guard не смог удалить публикацию в <b>${escapeHtml(cfg.title)}</b>: ${escapeHtml(reason)}. Проверьте права бота.`);
}
async function registerGroupFromCommand(message, env) {
  const chat = message.chat;
  const adminCheck = await telegram(env, "getChatMember", { chat_id: chat.id, user_id: message.from.id });
  if (!adminCheck.ok || !["administrator", "creator"].includes(adminCheck.result?.status)) {
    return sendMessage(env, chat.id, "⛔ Команду /setup может выполнить только администратор группы.");
  }
  const botId = Number(String(env.BOT_TOKEN || "").split(":")[0]);
  if (!Number.isSafeInteger(botId) || botId <= 0) return sendMessage(env, chat.id, "Не удалось определить ID бота из конфигурации.");
  const botCheck = await telegram(env, "getChatMember", { chat_id: chat.id, user_id: botId });
  if (!botCheck.ok || !["administrator", "creator"].includes(botCheck.result?.status)) {
    return sendMessage(env, chat.id, "Сначала назначьте TG Guard администратором группы. Для автомута ему нужно право ограничивать участников, для очистки — удалять сообщения.");
  }
  const adminsResponse = await telegram(env, "getChatAdministrators", { chat_id: chat.id });
  const admins = Array.isArray(adminsResponse.result)
    ? adminsResponse.result.filter(item => item.user?.is_bot !== true).map(item => String(item.user.id))
    : [String(message.from.id)];
  if (!admins.includes(String(message.from.id))) admins.push(String(message.from.id));
  const previous = await getChannel(env, chat.id);
  const cfg = {
    id: String(chat.id), title: chat.title || String(chat.id), username: chat.username || "",
    chatType: chat.type, admins, mode: previous?.mode || DEFAULT_MODE,
    threshold: previous?.threshold || DEFAULT_THRESHOLD, moderation: normalizeModeration(previous?.moderation), enabled: true,
  };
  await env.STATE.put(channelKey(chat.id), JSON.stringify(cfg));
  await sendMessage(env, chat.id, `🛡 <b>TG Guard подключён к группе «${escapeHtml(cfg.title)}».</b>\nНастройте антиспам, антимат и анти-рейд в Web App. Все фильтры выключены до включения администратором; капчи нет.`);
  await notifyUsers(env, admins, `✅ Группа <b>${escapeHtml(cfg.title)}</b> подключена к TG Guard. Откройте личный чат с ботом и панель управления для настройки модерации.`);
}

async function handleModerationMessage(message, env) {
  const chat = message.chat;
  if (!chat?.id || !["group", "supergroup"].includes(chat.type) || !message.from || message.from.is_bot) return;
  const text = message.text || message.caption || "";
  if (!text) return;
  if (/^\/setup(?:@\w+)?(?:\s|$)/i.test(text.trim())) {
    await registerGroupFromCommand(message, env);
    return;
  }
  const cfg = await getChannel(env, chat.id);
  if (!cfg?.enabled || text.startsWith("/")) return;
  const moderation = normalizeModeration(cfg.moderation);
  if (!moderation.antiSpam && !moderation.antiProfanity && !moderation.antiLinks && !moderation.antiRaid) return;
  if (await isChatAdmin(env, chat.id, message.from.id, cfg)) return;

  const now = Date.now();
  const activeRaidUntil = Number(await env.STATE.get(raidKey(chat.id)) || 0);
  const joinedAt = Number(await env.STATE.get(joinedAtKey(chat.id, message.from.id)) || 0);
  if (moderation.antiRaid && activeRaidUntil > now && joinedAt && now - joinedAt < 10 * 60 * 1000) {
    const deleted = await telegram(env, "deleteMessage", { chat_id: chat.id, message_id: message.message_id });
    await writeModerationLog(env, chat.id, { type: "anti_raid", userId: String(message.from.id), userName: userLabel(message.from),
      reason: "Сообщение новичка во время режима анти-рейда", action: deleted.ok ? "deleted" : "delete_failed", timestamp: now,
      messageId: message.message_id, durationMinutes: Math.max(1, Math.ceil((activeRaidUntil - now) / 60000)) });
    return;
  }

  let violation = "", type = "", muteMinutes = 0;
  if (moderation.antiProfanity && containsProfanity(text, moderation.profanityWords)) {
    violation = "Ненормативная лексика"; type = "profanity"; muteMinutes = moderation.profanityMuteMinutes;
  } else if (moderation.antiLinks && hasLink(text, message.entities || message.caption_entities)) {
    violation = "Запрещённые ссылки"; type = "link"; muteMinutes = moderation.spamMuteMinutes;
  }

  const spamKey = `spam:${chat.id}:${message.from.id}`;
  if (!violation && moderation.antiSpam) {
    const normalizedText = normalizeForFilter(text).slice(0, 500);
    const history = await env.STATE.get(spamKey, "json") || { windowStart: now, count: 0, lastText: "", repeats: 0 };
    if (now - Number(history.windowStart || now) > 10_000) {
      history.windowStart = now; history.count = 0; history.repeats = 0;
    }
    history.count = Number(history.count || 0) + 1;
    history.repeats = normalizedText && normalizedText === history.lastText ? Number(history.repeats || 0) + 1 : 0;
    history.lastText = normalizedText;
    await env.STATE.put(spamKey, JSON.stringify(history), { expirationTtl: 60 });
    if (history.count >= 8 || history.repeats >= 2) {
      violation = history.repeats >= 2 ? "Повторяющиеся сообщения" : "Флуд"; type = "spam"; muteMinutes = moderation.spamMuteMinutes;
    }
  }
  if (!violation) return;

  const warning = await addWarning(env, chat.id, message.from.id, violation, "system", type);
  const escalatedMinutes = Math.min(10080, muteMinutes * Math.min(4, Math.max(1, Number(warning.count) || 1)));
  const deleted = await telegram(env, "deleteMessage", { chat_id: chat.id, message_id: message.message_id });
  let muted = false, muteError = "";
  if (escalatedMinutes > 0) {
    const until = Math.floor(now / 1000) + escalatedMinutes * 60;
    const result = await telegram(env, "restrictChatMember", {
      chat_id: chat.id, user_id: message.from.id, until_date: until,
      permissions: { can_send_messages: false, can_send_audios: false, can_send_documents: false,
        can_send_photos: false, can_send_videos: false, can_send_video_notes: false,
        can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false,
        can_add_web_page_previews: false, can_react_to_messages: false },
      use_independent_chat_permissions: true,
    });
    muted = result.ok === true;
    if (!muted) muteError = String(result.description || "Не удалось применить мут");
  }
  const action = `${deleted.ok ? "сообщение удалено" : "ошибка удаления"}; ${muted ? `мут ${escalatedMinutes} мин.` : `мут не применён (${muteError || "не настроен"})`}`;
  await writeModerationLog(env, chat.id, { type, userId: String(message.from.id), userName: userLabel(message.from), reason: violation,
    action, timestamp: now, messageId: message.message_id, warningCount: warning.count, durationMinutes: muted ? escalatedMinutes : 0,
    deleteSucceeded: deleted.ok, muteSucceeded: muted });
  if (!deleted.ok || !muted) {
    await notifyUsers(env, cfg.admins, `⚠️ TG Guard: ${escapeHtml(violation.toLowerCase())} в <b>${escapeHtml(cfg.title)}</b> от ${userLabel(message.from)}.\\n${escapeHtml(action)}. Проверьте права администратора бота.`);
  }
}

async function handlePrivateMessage(message, env, publicOrigin = "") {
  if (!message.text || message.chat?.type !== "private") return;
  const userId = String(message.from?.id || "");
  const chatId = message.chat.id;
  const [rawCommand, ...args] = message.text.trim().split(/\s+/);
  const command = (rawCommand || "").split("@")[0].toLowerCase();

  if (command === "/start" || command === "/help") {
    return sendMessage(env, chatId,
      "🛡 <b>Защита от накрутки</b>\n\nУправляйте каналами кнопками ниже. Вы видите только каналы, где вы администратор.\n\nℹ️ Telegram Bot API не сообщает дату создания аккаунта.",
      { reply_markup: mainKeyboard(env, publicOrigin) });
  }

  if (command === "/channels") {
    const channels = await listUserChannels(env, userId);
    if (!channels.length) {
      return sendMessage(env, chatId,
        "У вас пока нет подключённых каналов, где бот является администратором и вы сами остаетесь администратором.\n\nДобавьте бота администратором канала, затем нажмите «Мои каналы».",
        { reply_markup: mainKeyboard(env, publicOrigin) });
    }
    const lines = channels.map(channel =>
      `• <b>${escapeHtml(channel.title)}</b> — <code>${escapeHtml(channel.id)}</code>` +
      (channel.username ? ` (@${escapeHtml(channel.username)})` : "") +
      `\n  Режим: <b>${escapeHtml(channel.mode)}</b>, порог: ${channel.threshold}`
    );
    return sendMessage(env, chatId, "📺 <b>Ваши каналы:</b>\n\n" + lines.join("\n\n"),
      { reply_markup: channelsKeyboard(channels) });
  }

  if (command === "/bots") {
    const channels = await listUserChannels(env, userId);
    const channelIds = new Set(channels.map(channel => String(channel.id)));
    if (!channelIds.size) {
      return sendMessage(env, chatId, "Сначала подключите свой канал: добавьте бота администратором и откройте «Мои каналы».",
        { reply_markup: mainKeyboard(env, publicOrigin) });
    }
    const records = await listBotRecords(env);
    const visible = records.filter(record =>
      Object.keys(record.channels || {}).some(id => channelIds.has(id))
    ).sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));

    if (!visible.length) {
      return sendMessage(env, chatId, "В базе пока нет Telegram-ботов, обнаруженных в ваших каналах.",
        { reply_markup: mainKeyboard(env, publicOrigin) });
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
      `🛡 <b>${escapeHtml(cfg.title)}</b>\nРежим: <b>${escapeHtml(cfg.mode)}</b>\nПорог активности: <b>${cfg.threshold}</b> событий/минуту`);
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
      return sendMessage(env, chatId, "Использование: /threshold 12 ID_КАНАЛА (порог событий/мин, от 2 до 1000)");
    }
    const cfg = await authorizedConfig(env, channelId, userId);
    if (!cfg) return sendMessage(env, chatId, "Канал не найден или у вас нет прав администратора.");
    cfg.threshold = threshold;
    await env.STATE.put(channelKey(channelId), JSON.stringify(cfg));
    return sendMessage(env, chatId, `Порог активности для <b>${escapeHtml(cfg.title)}</b>: ${threshold} событий/минуту.`);
  }

  return sendMessage(env, chatId, "Неизвестная команда. Напишите /help.");
}


async function handleCallbackQuery(query, env, publicOrigin = "") {
  const data = String(query.data || ""), userId = String(query.from?.id || "");
  const chatId = query.message?.chat?.id, messageId = query.message?.message_id;
  await telegram(env, "answerCallbackQuery", { callback_query_id: query.id });
  if (!chatId || !messageId) return;
  if (data === "menu") return telegram(env, "editMessageText", {
    chat_id: chatId, message_id: messageId, text: "🛡 <b>Главное меню</b>\nВыберите раздел:",
    parse_mode: "HTML", reply_markup: mainKeyboard(env, publicOrigin)
  });
  if (data === "channels") {
    const channels = await listUserChannels(env, userId);
    const text = channels.length ? "📺 <b>Ваши каналы</b>\n\n" + channels.map(c =>
      `• <b>${escapeHtml(c.title)}</b>\nID: <code>${escapeHtml(c.id)}</code>\nРежим: ${escapeHtml(c.mode)} · порог: ${c.threshold}/мин`
    ).join("\n\n") : "Каналы не найдены. Добавьте бота администратором канала.";
    return telegram(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", reply_markup: channelsKeyboard(channels) });
  }
  if (data === "bots") {
    const channels = await listUserChannels(env, userId), ids = new Set(channels.map(c => String(c.id)));
    const records = (await listBotRecords(env)).filter(r => Object.keys(r.channels || {}).some(id => ids.has(id)))
      .sort((a,b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt))).slice(0, 20);
    const text = records.length ? "🤖 <b>База обнаруженных ботов</b>\n\n" + records.map(r =>
      `• ${userLabel(r)}\nID: <code>${escapeHtml(r.id)}</code>\nПоследнее обнаружение: ${escapeHtml(formatDate(r.lastSeenAt))}`
    ).join("\n\n") : "В ваших каналах пока нет записей о ботах.";
    return telegram(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "↻ Обновить", callback_data: "bots" }, { text: "⬅️ Меню", callback_data: "menu" }]] } });
  }
  const channelMatch = data.match(/^channel:(-?\d+)$/);
  const actionMatch = data.match(/^(mode_alerts|mode_protect|threshold_up|threshold_down):(-?\d+)$/);
  const channelId = channelMatch?.[1] || actionMatch?.[2];
  if (!channelId) return;
  const cfg = await authorizedConfig(env, channelId, userId);
  if (!cfg) return telegram(env, "editMessageText", { chat_id: chatId, message_id: messageId,
    text: "⛔ Нет доступа к каналу. Проверьте права администратора.",
    reply_markup: { inline_keyboard: [[{ text: "⬅️ Меню", callback_data: "menu" }]] } });
  if (actionMatch) {
    const action = actionMatch[1];
    if (action === "mode_alerts") cfg.mode = "alerts";
    if (action === "mode_protect") cfg.mode = "protect";
    if (action === "threshold_up") cfg.threshold = Math.min(1000, cfg.threshold + 1);
    if (action === "threshold_down") cfg.threshold = Math.max(2, cfg.threshold - 1);
    await env.STATE.put(channelKey(channelId), JSON.stringify(cfg));
  }
  return telegram(env, "editMessageText", { chat_id: chatId, message_id: messageId,
    text: `⚙️ <b>${escapeHtml(cfg.title)}</b>\n\nРежим: <b>${escapeHtml(cfg.mode)}</b>\nПорог заявок: <b>${cfg.threshold}/мин</b>\n\nProtect автоматически отклоняет заявки от аккаунтов, помеченных Telegram как боты.`,
    parse_mode: "HTML", reply_markup: channelActionsKeyboard(cfg) });
}

async function handleApi(request, env, url) {
  const user = await validateTelegramInitData(request.headers.get("X-Telegram-Init-Data") || "", env.BOT_TOKEN);
  if (!user) return json({ error: "Unauthorized Telegram WebApp session" }, 401);
  const userId = String(user.id);
  if (request.method === "GET" && url.pathname === "/api/moderation") {
    const channelId = String(url.searchParams.get("channelId") || "");
    const cfg = await authorizedConfig(env, channelId, userId);
    if (!cfg) return json({ error: "Forbidden" }, 403);
    const [events, warnings] = await Promise.all([
      readJsonPrefix(env, modLogPrefix(channelId)),
      readJsonPrefix(env, warningPrefix(channelId)),
    ]);
    events.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
    warnings.sort((a, b) => Number(b.count || 0) - Number(a.count || 0));
    return json({ channelId, title: cfg.title, moderation: normalizeModeration(cfg.moderation),
      events: events.slice(0, MAX_LOG_ITEMS), warnings: warnings.slice(0, 100) });
  }
  if (request.method === "POST" && url.pathname === "/api/moderation/warn") {
    let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
    const cfg = await authorizedConfig(env, String(body.channelId || ""), userId);
    if (!cfg) return json({ error: "Forbidden" }, 403);
    const targetId = String(body.userId || "").trim();
    const reason = String(body.reason || "Нарушение правил").trim().slice(0, 300);
    if (!/^\d{1,20}$/.test(targetId)) return json({ error: "Укажите числовой Telegram ID пользователя" }, 400);
    const warning = await addWarning(env, cfg.id, targetId, reason, userId, "manual_warning");
    await writeModerationLog(env, cfg.id, { type: "warning", userId: targetId, userName: "", reason,
      action: "warning", timestamp: Date.now(), byUserId: userId, warningCount: warning.count });
    await notifyUsers(env, cfg.admins, `⚠️ Выдано предупреждение участнику <code>${escapeHtml(targetId)}</code> в чате <b>${escapeHtml(cfg.title)}</b>.\nПричина: ${escapeHtml(reason)}\nВсего предупреждений: ${warning.count}`);
    if (["group", "supergroup"].includes(cfg.chatType)) {
      await sendMessage(env, cfg.id, `⚠️ <b>Предупреждение участнику</b> <code>${escapeHtml(targetId)}</code>\nПричина: ${escapeHtml(reason)}\nВсего предупреждений: ${warning.count}`);
    }
    return json({ ok: true, warning });
  }
  if (request.method === "GET" && url.pathname === "/api/analytics") {
    const channels = await listUserChannels(env, userId);
    const [analytics, monitoring] = await Promise.all([
      Promise.all(channels.map(channel => getChannelAnalytics(env, channel, true))),
      getWebhookDiagnostics(env),
    ]);
    return json({ analytics, monitoring, generatedAt: new Date().toISOString() });
  }
  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    const channels = await listUserChannels(env, userId), ids = new Set(channels.map(c => String(c.id)));
    const bots = (await listBotRecords(env)).filter(r => Object.keys(r.channels || {}).some(id => ids.has(id))).map(r => ({
      id: r.id, firstName: r.firstName || "", lastName: r.lastName || "", username: r.username || "",
      languageCode: r.languageCode || "", firstSeenAt: r.firstSeenAt || null, lastSeenAt: r.lastSeenAt || null,
      channels: Object.entries(r.channels || {}).filter(([id]) => ids.has(id)).map(([,v]) => v)
    }));
    return json({ user: { id: user.id, first_name: user.first_name, username: user.username },
      channels: channels.map(cfg => ({ ...cfg, chatType: cfg.chatType || "channel", moderation: normalizeModeration(cfg.moderation) })), bots });
  }
  if (request.method === "POST" && url.pathname === "/api/settings") {
    let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
    const cfg = await authorizedConfig(env, String(body.channelId || ""), userId);
    if (!cfg) return json({ error: "Forbidden" }, 403);
    if (body.mode !== undefined) {
      if (!["alerts", "protect"].includes(body.mode)) return json({ error: "Invalid mode" }, 400);
      cfg.mode = body.mode;
    }
    if (body.threshold !== undefined) {
      const n = Number(body.threshold);
      if (!Number.isInteger(n) || n < 2 || n > 1000) return json({ error: "Порог должен быть от 2 до 1000" }, 400);
      cfg.threshold = n;
    }
    const moderation = normalizeModeration(cfg.moderation);
    for (const key of ["antiSpam", "antiProfanity", "antiLinks", "antiRaid"]) {
      if (body[key] !== undefined) {
        if (typeof body[key] !== "boolean") return json({ error: `Параметр ${key} должен быть логическим` }, 400);
        moderation[key] = body[key];
      }
    }
    for (const [key, min, max, label] of [
      ["profanityMuteMinutes", 1, 10080, "Длительность мута за мат"],
      ["spamMuteMinutes", 1, 1440, "Длительность мута за спам"],
      ["raidThreshold", 2, 1000, "Порог анти-рейда"],
    ]) {
      if (body[key] !== undefined) {
        const value = Number(body[key]);
        if (!Number.isInteger(value) || value < min || value > max) return json({ error: `${label}: допустимо от ${min} до ${max}` }, 400);
        moderation[key] = value;
      }
    }
    if (body.profanityWords !== undefined) {
      if (!Array.isArray(body.profanityWords) || body.profanityWords.length > 200) return json({ error: "Список запрещённых слов должен быть массивом до 200 элементов" }, 400);
      moderation.profanityWords = [...new Set(body.profanityWords.map(value => String(value).trim().slice(0, 50)).filter(Boolean))].slice(0, 200);
    }
    cfg.moderation = moderation;
    await env.STATE.put(channelKey(cfg.id), JSON.stringify(cfg));
    return json({ ok: true, channel: cfg });
  }
  return json({ error: "Not found" }, 404);
}

async function getWebhookDiagnostics(env) {
  try {
    const response = await telegram(env, "getWebhookInfo", {});
    if (!response.ok || !response.result) {
      return { ok: false, chatMemberEnabled: null, message: "Не удалось проверить настройки webhook Telegram." };
    }
    const info = response.result;
    const allowed = Array.isArray(info.allowed_updates) ? info.allowed_updates : [];
    return {
      ok: true,
      webhookConfigured: Boolean(info.url),
      chatMemberEnabled: allowed.includes("chat_member"),
      allowedUpdates: allowed,
      pendingUpdateCount: Number(info.pending_update_count || 0),
      lastErrorMessage: info.last_error_message || null,
      lastErrorDate: info.last_error_date ? Number(info.last_error_date) * 1000 : null,
    };
  } catch (error) {
    console.error("Webhook diagnostics failed:", error?.message || error);
    return { ok: false, chatMemberEnabled: null, message: "Не удалось проверить настройки webhook Telegram." };
  }
}

async function validateTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData), hash = params.get("hash"), authDate = Number(params.get("auth_date"));
    if (!hash || !authDate || Math.abs(Date.now()/1000 - authDate) > 86400) return null;
    params.delete("hash");
    const check = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join("\n");
    const enc = new TextEncoder();
    const key1 = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
    const secret = await crypto.subtle.sign("HMAC", key1, enc.encode(botToken));
    const key2 = await crypto.subtle.importKey("raw", secret, { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key2, enc.encode(check));
    const computed = [...new Uint8Array(sig)].map(b=>b.toString(16).padStart(2,"0")).join("");
    if (computed.length !== hash.length) return null;
    let diff = 0; for (let i=0;i<computed.length;i++) diff |= computed.charCodeAt(i) ^ hash.charCodeAt(i);
    if (diff !== 0) return null;
    const rawUser = params.get("user"); return rawUser ? JSON.parse(rawUser) : null;
  } catch { return null; }
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
async function sendMessage(env, chatId, text, extra = {}) {
  return telegram(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
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
