import { Client } from '@dvxch/yandex-music';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));

console.log(`╔══════════════════════════════════════╗`);
console.log(`║   🎵 YM-бот — настройка              ║`);
console.log(`╚══════════════════════════════════════╝\n`);

// Шаг 1: Device Auth
console.log(`[1/4] Авторизация в Яндексе\n`);
const CID = '23cabbbdc6cd418abb4b39c32c41195d';
const CSEC = '53bc75238f0c4d08a118e51fe9203300';
const client = new Client({ language: 'ru' });

const code = await client.requestDeviceCode(undefined, undefined, CID);
console.log(`  🔗 Открой ссылку: ${code.verificationUrl}`);
console.log(`  🔑 Введи код: ${code.userCode}`);
console.log(`  ⏱ Ожидание ${code.expiresIn || 300} секунд...\n`);

const deadline = Date.now() + ((code.expiresIn || 300) * 1000);
const interval = (code.interval || 5) * 1000;
let token = null;
let dots = 0;
while (Date.now() < deadline) {
  token = await client.pollDeviceToken(code.deviceCode, CID, CSEC);
  if (token) break;
  process.stdout.write('.');
  dots++;
  if (dots % 40 === 0) process.stdout.write(`\n  `);
  await new Promise(r => setTimeout(r, interval));
}
console.log(`\n`);

if (!token) {
  console.error('❌ Таймаут. Запусти заново: node setup.mjs');
  process.exit(1);
}

console.log(`  ✅ Токен получен!\n`);

// Шаг 2: Проверка токена
console.log(`[2/4] Проверка аккаунта\n`);
const ym = new Client({ token: token.accessToken, language: 'ru' });
await ym.init();
const login = ym.me?.account?.login || '?';
const hasPlus = ym.me?.plus?.hasPlus;
console.log(`  ✅ Логин: ${login}`);
console.log(`  ✅ Plus: ${hasPlus ? 'Да' : 'Нет'}`);

if (!hasPlus) {
  console.log(`  ⚠ Без Plus треки будут только preview (30 сек)`);
}
console.log();

// Шаг 3: Session_id (опционально)
console.log(`[3/4] Cookie Session_id (необязательно)\n`);
console.log(`  Session_id нужна только для скачивания полных треков без Plus.`);
console.log(`  Без неё треки будут 30-секундными preview.\n`);
console.log(`  Как получить:`);
console.log(`  1. Открой music.yandex.ru в браузере`);
console.log(`  2. F12 → Application → Cookies → Session_id`);
console.log(`  3. Скопируй значение\n`);
const sessionId = await ask(`  Вставь Session_id (или Enter чтобы пропустить): `);

// Шаг 4: Создание .env
console.log(`\n[4/4] Сохранение .env\n`);
const envPath = join(import.meta.dirname, '.env');
let env = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';

const setKey = (k, v) => {
  const line = `${k}=${v}`;
  if (env.includes(`${k}=`)) {
    env = env.replace(new RegExp(`${k}=.*`, 'm'), line);
  } else {
    env += (env.endsWith('\n') || !env ? '' : '\n') + line + '\n';
  }
};

// Токены бота (сохраняем старые, если есть)
const oldBotToken = env.match(/LOLKA_TOKEN_YM=(\S+)/)?.[1];
if (!oldBotToken) {
  const bt = await ask(`  Введи токен бота lolka.app (LOLKA_TOKEN_YM): `);
  setKey('LOLKA_TOKEN_YM', bt);
}

setKey('YM_TOKEN', token.accessToken);
if (token.refreshToken) setKey('YM_REFRESH_TOKEN', token.refreshToken);
setKey('YM_CLIENT_ID', CID);
setKey('YM_CLIENT_SECRET', CSEC);

if (sessionId.trim()) {
  setKey('YM_SESSION_ID', sessionId.trim());
}

// MUSIC_CHANNEL_ID (опционально)
const oldChan = env.match(/MUSIC_CHANNEL_ID=(\S+)?/)?.[1];
if (!oldChan) {
  const ch = await ask(`  ID голосового канала (Enter = без автоподключения): `);
  if (ch.trim()) setKey('MUSIC_CHANNEL_ID', ch.trim());
}

writeFileSync(envPath, env);
console.log(`\n  ✅ .env сохранён`);

// Финальная проверка
console.log(`\n[✓] Готово! Бот запустится автоматически.\n`);

rl.close();
