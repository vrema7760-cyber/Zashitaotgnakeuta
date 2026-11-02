import worker from '../src/index.js';
import { WEBAPP_HTML } from '../src/webapp.js';
import { mainKeyboard } from '../src/ui.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const builtKeyboard = mainKeyboard({}, 'https://example.workers.dev');
assert(builtKeyboard.inline_keyboard[0].some(button => button.callback_data === 'channels'), 'channels button missing');
assert(builtKeyboard.inline_keyboard[0].some(button => button.callback_data === 'bots'), 'bots button missing');
assert(builtKeyboard.inline_keyboard[1][0].web_app.url === 'https://example.workers.dev/app', 'WebApp URL not derived from Worker origin');
const fallbackKeyboard = mainKeyboard({ WEBAPP_URL: 'http://not-https.example' }, '');
assert(fallbackKeyboard.inline_keyboard.length === 1, 'invalid WebApp URL should not suppress standard buttons');

const sent = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const method = String(url).split('/').pop();
  const payload = JSON.parse(init.body || '{}');
  sent.push({ method, payload });
  return new Response(JSON.stringify({ ok: true, result: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
const memory = new Map();
const kv = {
  async get(key, type) {
    const value = memory.get(key);
    if (value === undefined) return null;
    if (type === 'json') { try { return JSON.parse(value); } catch { return null; } }
    return value;
  },
  async put(key, value) { memory.set(key, String(value)); },
  async delete(key) { memory.delete(key); },
  async list({ prefix = '', limit = 1000 } = {}) {
    return { keys: [...memory.keys()].filter(key => key.startsWith(prefix)).slice(0, limit).map(name => ({ name })), list_complete: true };
  },
};
const env = { BOT_TOKEN: 'TEST_TOKEN', STATE: kv };
const ctx = { waitUntil(promise) { this.promise = promise; } };
try {
  const response = await worker.fetch(new Request('https://example.workers.dev/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      update_id: 1,
      message: {
        message_id: 4,
        chat: { id: 123, type: 'private' },
        from: { id: 123 },
        text: '/start',
      },
    }),
  }), env, ctx);
  assert(response.status === 200, 'webhook did not return HTTP 200');
  await ctx.promise;
  const outgoing = sent.find(item => item.method === 'sendMessage');
  assert(outgoing, 'sendMessage was not called for /start');
  const keyboard = outgoing.payload.reply_markup?.inline_keyboard;
  assert(Array.isArray(keyboard), 'reply_markup.inline_keyboard missing from /start');
  assert(keyboard[0].some(button => button.callback_data === 'channels'), 'channels button missing from /start payload');
  assert(keyboard[0].some(button => button.callback_data === 'bots'), 'bots button missing from /start payload');
  assert(keyboard[1]?.[0]?.web_app?.url === 'https://example.workers.dev/app', 'WebApp link missing from /start payload');

  const appResponse = await worker.fetch(new Request('https://example.workers.dev/app'), env, ctx);
  const app = await appResponse.text();
  assert(appResponse.status === 200, 'WebApp route did not return HTTP 200');
  for (const expected of ['telegram-web-app.js', '/api/bootstrap', '/api/settings', '/api/moderation/warn', 'id="antiProfanity"', 'id="antiRaid"', 'id="moderationView"', 'id="profanityMuteMinutes"', 'id="refresh"', 'data-tab="bots"']) {
    assert(app.includes(expected), `WebApp is missing expected feature: ${expected}`);
  }
  console.log('PASS: /start keyboard, WebApp link, and dashboard endpoints validated.');

  await kv.put('channel:-100500', JSON.stringify({ id: '-100500', title: 'Тестовая группа', chatType: 'supergroup',
    admins: ['123'], mode: 'alerts', threshold: 12, enabled: true,
    moderation: { antiSpam: false, antiProfanity: true, antiLinks: false, antiRaid: false,
      profanityMuteMinutes: 30, spamMuteMinutes: 5, raidThreshold: 12, profanityWords: ['пизд'] } }));
  const modResponse = await worker.fetch(new Request('https://example.workers.dev/telegram/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ update_id: 2,
      message: { message_id: 22, chat: { id: -100500, type: 'supergroup', title: 'Тестовая группа' },
        from: { id: 456, first_name: 'Тест', is_bot: false }, text: 'пиздец' } })
  }), env, ctx);
  assert(modResponse.status === 200, 'group moderation webhook did not return HTTP 200');
  await ctx.promise;
  assert(sent.some(item => item.method === 'deleteMessage' && item.payload.chat_id === -100500), 'profanity message was not deleted');
  assert(sent.some(item => item.method === 'restrictChatMember' && item.payload.chat_id === -100500), 'profanity mute was not applied');
  assert(memory.has('warning:-100500:456'), 'automatic warning was not persisted');
  assert([...memory.keys()].some(key => key.startsWith('modlog:-100500:')), 'moderation log was not persisted');

  // Expanded dictionary should catch common roots even when punctuation/spaces/digits are used.
  const obfuscatedCases = [
    { id: 23, text: 'х.у.й' },
    { id: 24, text: 'п и з д е ц' },
    { id: 25, text: 'е6ать' },
  ];
  for (const testCase of obfuscatedCases) {
    const before = sent.filter(item => item.method === 'deleteMessage').length;
    const result = await worker.fetch(new Request('https://example.workers.dev/telegram/webhook', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ update_id: testCase.id, message: {
        message_id: testCase.id, chat: { id: -100500, type: 'supergroup', title: 'Тестовая группа' },
        from: { id: 456, first_name: 'Тест', is_bot: false }, text: testCase.text,
      } }),
    }), env, ctx);
    assert(result.status === 200, `obfuscated profanity webhook failed for ${testCase.text}`);
    await ctx.promise;
    assert(sent.filter(item => item.method === 'deleteMessage').length === before + 1,
      `obfuscated profanity was not caught: ${testCase.text}`);
  }
  const safeBefore = sent.filter(item => item.method === 'deleteMessage').length;
  const safeResult = await worker.fetch(new Request('https://example.workers.dev/telegram/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ update_id: 26, message: {
      message_id: 26, chat: { id: -100500, type: 'supergroup', title: 'Тестовая группа' },
      from: { id: 456, first_name: 'Тест', is_bot: false }, text: 'Хороший день, спасибо за помощь!' },
    }),
  }), env, ctx);
  assert(safeResult.status === 200, 'normal message webhook failed');
  await ctx.promise;
  assert(sent.filter(item => item.method === 'deleteMessage').length === safeBefore,
    'normal text was incorrectly flagged as profanity');
  console.log('PASS: profanity moderation, obfuscated spellings, and safe-text false-positive check validated.');
} finally {
  globalThis.fetch = originalFetch;
}
