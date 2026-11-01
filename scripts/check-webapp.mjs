import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(resolve(root, 'webapp.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1].trim()).filter(Boolean);
if (!scripts.length) throw new Error('No inline WebApp JavaScript found');
for (const script of scripts) new vm.Script(script, { filename: 'webapp-inline.js' });
for (const expected of ['telegram-web-app.js', '/api/bootstrap', '/api/settings', 'id="refresh"']) {
  if (!html.includes(expected)) throw new Error(`WebApp HTML is missing ${expected}`);
}
console.log('WebApp HTML and inline JavaScript syntax OK');
