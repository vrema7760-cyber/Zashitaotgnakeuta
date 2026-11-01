export function mainKeyboard(env = {}, origin = "") {
  const rows = [
    [
      { text: "📺 Мои каналы", callback_data: "channels" },
      { text: "🤖 База ботов", callback_data: "bots" },
    ],
  ];
  // Prefer an explicit HTTPS URL; otherwise derive it from the incoming Worker request.
  const candidate = String(env.WEBAPP_URL || (origin.startsWith("https://") ? `${origin}/app` : "")).trim();
  if (/^https:\/\//i.test(candidate)) {
    rows.push([{ text: "🌐 Открыть панель управления", web_app: { url: candidate } }]);
  }
  return { inline_keyboard: rows };
}
export function channelsKeyboard(channels = []) {
  const rows = channels.slice(0, 30).map(c => [{ text: `⚙️ ${String(c.title || c.id).slice(0, 48)}`, callback_data: `channel:${c.id}` }]);
  rows.push([{ text: "🤖 База ботов", callback_data: "bots" }, { text: "⬅️ Меню", callback_data: "menu" }]);
  return { inline_keyboard: rows };
}
export function channelActionsKeyboard(cfg) {
  return { inline_keyboard: [
    [{ text: cfg.mode === "alerts" ? "🔔 Уведомления ✓" : "🔔 Включить уведомления", callback_data: `mode_alerts:${cfg.id}` }],
    [{ text: cfg.mode === "protect" ? "🛡 Защита включена ✓" : "🛡 Включить защиту", callback_data: `mode_protect:${cfg.id}` }],
    [{ text: "➖", callback_data: `threshold_down:${cfg.id}` }, { text: `📊 Порог: ${cfg.threshold}/мин`, callback_data: `channel:${cfg.id}` }, { text: "➕", callback_data: `threshold_up:${cfg.id}` }],
    [{ text: "⬅️ К каналам", callback_data: "channels" }, { text: "🏠 Меню", callback_data: "menu" }]
  ] };
}
