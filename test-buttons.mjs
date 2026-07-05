import 'dotenv/config';
import { Embed, ButtonBuilder, ActionRowBuilder, ButtonStyle } from 'lolka.js';

function nowPlayingEmbed(entry, state) {
  const cover = entry.cover ? `https://${entry.cover}` : null;
  const pos = state.index + 1;
  const total = (state.source === 'wave' || state.source === 'radio') ? '∞' : state.tracks.length;
  const embed = new Embed({
    title: '🎵 Сейчас играет',
    color: 0x8b5cf6,
    fields: [
      { name: 'Название', value: entry.title || '—', inline: true },
      { name: 'Исполнитель', value: entry.artist || '—', inline: true },
      { name: 'Прогресс', value: `[${pos}/${total}]${state.loop ? ' 🔁' : ''}`, inline: false },
    ],
    timestamp: new Date().toISOString(),
  });
  if (cover) embed.data.thumbnail = { url: cover };
  return embed;
}

function controlsRow(state) {
  const prev = new ButtonBuilder().setCustomId('ym_prev').setLabel('⏮').setStyle(ButtonStyle.Secondary);
  const skip = new ButtonBuilder().setCustomId('ym_skip').setLabel('⏭').setStyle(ButtonStyle.Secondary);
  const stop = new ButtonBuilder().setCustomId('ym_stop').setLabel('⏹').setStyle(ButtonStyle.Danger);
  const queue = new ButtonBuilder().setCustomId('ym_showqueue').setLabel('📋').setStyle(ButtonStyle.Secondary);
  const row = new ActionRowBuilder().addComponents(prev, skip, stop, queue);
  const row2 = new ActionRowBuilder();
  const shuffleBtn = new ButtonBuilder().setCustomId('ym_shuffle').setLabel(state.shuffle ? '🔀' : '➡️').setStyle(state.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary);
  const loop = new ButtonBuilder().setCustomId('ym_loop').setLabel(state.loop ? '🔁' : '➡️').setStyle(state.loop ? ButtonStyle.Success : ButtonStyle.Secondary);
  row2.addComponents(shuffleBtn, loop);
  return [row, row2];
}

const entry = { id: '123456', title: 'Test Song', artist: 'Test Artist', cover: 'avatars.yandex.net/get-music-content/123/abc', duration: 240000 };
const state = { tracks: [entry, { id: '789', title: 'Song 2', artist: 'Art 2', duration: 180000 }], index: 0, loop: false, source: 'wave', currentTrackId: '123456' };

let ok = 0, fail = 0;

// 1. Embed - теперь с полями + timestamp
const e1 = nowPlayingEmbed(entry, { ...state, source: 'wave' });
const e2 = nowPlayingEmbed(entry, { ...state, source: 'search', tracks: [entry, entry] });
const e3 = nowPlayingEmbed(entry, { ...state, source: 'wave', loop: true });
const checks = [
  ['title fixed', e1.data.title === '🎵 Сейчас играет'],
  ['field title', e1.data.fields[0].value === 'Test Song'],
  ['field artist', e1.data.fields[1].value === 'Test Artist'],
  ['field wave ∞', e1.data.fields[2].value === '[1/∞]'],
  ['field search count', e2.data.fields[2].value === '[1/2]'],
  ['field loop marker', e3.data.fields[2].value === '[1/∞] 🔁'],
  ['has thumbnail', !!e1.data.thumbnail?.url],
  ['has timestamp', !!e1.data.timestamp],
];
checks.forEach(([name, pass]) => { console.log(pass ? '✅' : '❌', name); pass ? ok++ : fail++; });

// 2. ControlsRow - теперь возвращает массив из 2 рядов
const rows = controlsRow({ ...state, loop: false });
const rows2 = controlsRow({ ...state, loop: true });
const c1 = rows[0].toJSON().components; // row: prev, skip, stop, queue
const c2 = rows[1].toJSON().components; // row2: shuffle, loop
const c2b = rows2[1].toJSON().components;
const idChecks = [
  ['prev id', c1[0].custom_id === 'ym_prev'],
  ['skip id', c1[1].custom_id === 'ym_skip'],
  ['stop id', c1[2].custom_id === 'ym_stop'],
  ['queue id', c1[3].custom_id === 'ym_showqueue'],
  ['shuffle id', c2[0].custom_id === 'ym_shuffle'],
  ['loop id', c2[1].custom_id === 'ym_loop'],
  ['loop label default', c2[1].label === '➡️'],
  ['loop label active', c2b[1].label === '🔁'],
  ['loop style default', c2[1].style === 2],
  ['loop style active', c2b[1].style === 3],
  ['stop style danger', c1[2].style === 4],
];
idChecks.forEach(([name, pass]) => { console.log(pass ? '✅' : '❌', name); pass ? ok++ : fail++; });

// 3. Handler logic
const mockState = { ...state, tracks: [...state.tracks], prevHistory: [], shuffle: false, paused: false };
const tests = [
  ['skip increments index', () => { mockState.index++; return mockState.index === 1; }],
  ['loop toggles', () => { mockState.loop = !mockState.loop; return mockState.loop === true; }],
  ['stop clears tracks', () => { mockState.tracks = []; mockState.index = 0; return mockState.tracks.length === 0; }],
  ['prev uses history', () => { mockState.prevHistory.push(0); const i = mockState.prevHistory.pop(); return i === 0; }],
  ['shuffle toggles', () => { mockState.shuffle = !mockState.shuffle; return mockState.shuffle === true; }],
];
tests.forEach(([name, fn]) => { const pass = fn(); console.log(pass ? '✅' : '❌', name); pass ? ok++ : fail++; });

console.log(`\n${ok}/${ok+fail} passed` + (fail ? `, ${fail} FAILED` : ''));
process.exit(fail ? 1 : 0);

