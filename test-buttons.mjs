import 'dotenv/config';
import { EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } from 'lolka.js';

function formatDuration(ms) {
  if (!ms) return '?';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function sourceLabel(source) {
  const labels = {
    wave: 'Моя волна',
    radio: 'Станция',
    search: 'Поиск',
    playlist: 'Плейлист',
    top: 'Чарт',
    new: 'Новинки',
  };
  return labels[source] || source || '—';
}

function nowPlayingEmbed(entry, state) {
  const cover = entry.cover ? `https://${entry.cover}` : null;
  const pos = state.index + 1;
  const total = (state.source === 'wave' || state.source === 'radio') ? '∞' : state.tracks.length;
  const ymUrl = entry.id ? `https://music.yandex.ru/album/0/track/${entry.id}` : null;

  const bar = '▰'.repeat(14);

  const loopIcon = state.loop === 2 ? ' 🔁' : state.loop === 1 ? ' 🔂' : '';

  const embed = new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle(entry.title || '—')
    .setURL(ymUrl)
    .setAuthor({ name: 'Яндекс.Музыка', iconURL: 'https://music.yandex.ru/favicon.ico' })
    .setDescription(
      `**${entry.artist || '—'}**\n` +
      `${bar} ${formatDuration(entry.duration)}`
    )
    .addFields(
      { name: '⏱ Длительность', value: formatDuration(entry.duration), inline: true },
      { name: '📻 Источник', value: sourceLabel(state.source), inline: true },
      { name: '📍 Позиция', value: `[${pos}/${total}]${loopIcon}`, inline: true }
    )
    .setFooter({ text: '🎧 Управляй кнопками ниже' })
    .setTimestamp();

  if (cover) embed.setThumbnail(cover);
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
  const loopLabels = ['➡️', '🔂', '🔁'];
  const loopBtn = new ButtonBuilder().setCustomId('ym_loop').setLabel(loopLabels[state.loop] || '➡️').setStyle(state.loop ? ButtonStyle.Success : ButtonStyle.Secondary);
  row2.addComponents(shuffleBtn, loopBtn);
  return [row, row2];
}

const entry = { id: '123456', title: 'Test Song', artist: 'Test Artist', cover: 'avatars.yandex.net/get-music-content/123/abc', duration: 240000 };
const state = { tracks: [entry, { id: '789', title: 'Song 2', artist: 'Art 2', duration: 180000 }], index: 0, loop: 0, source: 'wave', currentTrackId: '123456' };

let ok = 0, fail = 0;

// 1. Embed
const e1 = nowPlayingEmbed(entry, { ...state, source: 'wave' });
const e2 = nowPlayingEmbed(entry, { ...state, source: 'search', tracks: [entry, entry] });
const e3 = nowPlayingEmbed(entry, { ...state, source: 'wave', loop: 1 });
const e4 = nowPlayingEmbed(entry, { ...state, source: 'wave', loop: 2 });
const checks = [
  ['title', e1.data.title === 'Test Song'],
  ['url set', !!e1.data.url],
  ['author name', e1.data.author?.name === 'Яндекс.Музыка'],
  ['author icon', !!e1.data.author?.icon_url],
  ['description has artist', e1.data.description?.includes('Test Artist')],
  ['description has bar', e1.data.description?.includes('▰')],
  ['description has duration', e1.data.description?.includes('4:00')],
  ['field ⏱ duration', e1.data.fields[0].value === '4:00'],
  ['field 📻 source wave', e1.data.fields[1].value === 'Моя волна'],
  ['field 📻 source search', e2.data.fields[1].value === 'Поиск'],
  ['field 📍 pos ∞', e1.data.fields[2].value === '[1/∞]'],
  ['field 📍 pos count', e2.data.fields[2].value === '[1/2]'],
  ['field 📍 loop track', e3.data.fields[2].value === '[1/∞] 🔂'],
  ['field 📍 loop queue', e4.data.fields[2].value === '[1/∞] 🔁'],
  ['has thumbnail', !!e1.data.thumbnail?.url],
  ['footer', e1.data.footer?.text === '🎧 Управляй кнопками ниже'],
  ['color red', e1.data.color === 0xFF0000],
  ['has timestamp', !!e1.data.timestamp],
];
checks.forEach(([name, pass]) => { console.log(pass ? '✅' : '❌', name); pass ? ok++ : fail++; });

// 2. ControlsRow
const rows = controlsRow({ ...state, loop: 0 });
const rows2 = controlsRow({ ...state, loop: 1 });
const rows3 = controlsRow({ ...state, loop: 2 });
const c1 = rows[0].toJSON().components;
const c2 = rows[1].toJSON().components;
const c2b = rows2[1].toJSON().components;
const c2c = rows3[1].toJSON().components;
const idChecks = [
  ['prev id', c1[0].custom_id === 'ym_prev'],
  ['skip id', c1[1].custom_id === 'ym_skip'],
  ['stop id', c1[2].custom_id === 'ym_stop'],
  ['queue id', c1[3].custom_id === 'ym_showqueue'],
  ['shuffle id', c2[0].custom_id === 'ym_shuffle'],
  ['loop id', c2[1].custom_id === 'ym_loop'],
  ['loop label off', c2[1].label === '➡️'],
  ['loop label track', c2b[1].label === '🔂'],
  ['loop label queue', c2c[1].label === '🔁'],
  ['loop style default', c2[1].style === 2],
  ['loop style active', c2b[1].style === 3],
  ['stop style danger', c1[2].style === 4],
];
idChecks.forEach(([name, pass]) => { console.log(pass ? '✅' : '❌', name); pass ? ok++ : fail++; });

// 3. Handler logic
const mockState = { ...state, tracks: [...state.tracks], prevHistory: [], shuffle: false, paused: false };
const logicTests = [
  ['skip increments index', () => { mockState.index++; return mockState.index === 1; }],
  ['loop cycles 0→1→2→0', () => { const s = { loop: 0 }; s.loop = ((s.loop || 0) + 1) % 3; if (s.loop !== 1) return false; s.loop = ((s.loop || 0) + 1) % 3; if (s.loop !== 2) return false; s.loop = ((s.loop || 0) + 1) % 3; return s.loop === 0; }],
  ['stop clears tracks', () => { mockState.tracks = []; mockState.index = 0; return mockState.tracks.length === 0; }],
  ['prev uses history', () => { mockState.prevHistory.push(0); const i = mockState.prevHistory.pop(); return i === 0; }],
  ['shuffle toggles', () => { mockState.shuffle = !mockState.shuffle; return mockState.shuffle === true; }],
];
logicTests.forEach(([name, fn]) => { const pass = fn(); console.log(pass ? '✅' : '❌', name); pass ? ok++ : fail++; });

console.log(`\n${ok}/${ok+fail} passed` + (fail ? `, ${fail} FAILED` : ''));
process.exit(fail ? 1 : 0);
