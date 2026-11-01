import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = resolve(root, 'webapp.html');
const outputPath = resolve(root, 'src/webapp.js');
const html = await readFile(htmlPath, 'utf8');
const base64 = Buffer.from(html, 'utf8').toString('base64');
const source = [
  '// Generated from ../webapp.html by scripts/build-webapp.mjs. Do not edit manually.',
  `const HTML_BASE64 = "${base64}";`,
  'const HTML_BYTES = Uint8Array.from(atob(HTML_BASE64), c => c.charCodeAt(0));',
  'export const WEBAPP_HTML = new TextDecoder("utf-8").decode(HTML_BYTES);',
  '',
].join('\n');
await writeFile(outputPath, source, 'utf8');
console.log('Built src/webapp.js from webapp.html');
