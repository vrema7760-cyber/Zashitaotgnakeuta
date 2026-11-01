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
const kv = {
  async get() { return null; },
  async put() {},
  async delete() {},
  async list() { return { keys: [], list_complete: true }; },
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
  for (const expected of ['telegram-web-app.js', '/api/bootstrap', '/api/settings', 'id="refresh"', 'data-tab="bots"']) {
    assert(app.includes(expected), `WebApp is missing expected feature: ${expected}`);
  }
  console.log('PASS: /start keyboard, WebApp link, and dashboard endpoints validated.');
} finally {
  globalThis.fetch = originalFetch;
}
