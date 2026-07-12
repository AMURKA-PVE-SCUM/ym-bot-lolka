import { config } from 'dotenv';
import { Client as LolkaClient, GatewayIntentBits, ActivityType, joinVoiceChannel, EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle, MessageFlags } from 'lolka.js';
import { Client as YmClient } from '@dvxch/yandex-music';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
config({ path: join(import.meta.dirname, '.env') });

const TOKEN = process.env.LOLKA_TOKEN_YM || '';
const MUSIC_CHANNEL_ID = process.env.MUSIC_CHANNEL_ID || '';
const PREFIX = '!';

const YM_TOKEN = process.env.YM_TOKEN || '';
const YM_SESSION_ID = process.env.YM_SESSION_ID || '';
const YM_SESSION_ID2 = process.env.YM_SESSION_ID2 || '';

const CACHE_DIR = join(import.meta.dirname, 'music', '_ym');
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
const MAX_CACHED_FILES = 200;

const MAX_QUEUE = 500;

let ym = null;
let ymReady = false;

async function initYm() {
  if (!YM_TOKEN) {
    console.error('❌ YM: нет токена. Запусти: node setup.mjs');
    return;
  }
  try {
    const extraHeaders = {};
    if (YM_SESSION_ID) {
      extraHeaders['Cookie'] = `Session_id=${YM_SESSION_ID}${YM_SESSION_ID2 ? '; sessionid2=' + YM_SESSION_ID2 : ''}`;
    }
    ym = new YmClient({ token: YM_TOKEN, headers: extraHeaders, language: 'ru' });
    await ym.init();
    console.log('✅ YM:', ym.me?.account?.login || 'unknown', '| uid:', ym.accountUid || '?');
    ymReady = true;
  } catch (e) {
    console.error('❌ YM: ошибка инициализации:', e.message);
    ymReady = false;
  }
}

function ymTrackUrl(trackId) {
  return `https://music.yandex.ru/album/0/track/${trackId}`;
}

function formatDuration(ms) {
  if (!ms) return '?';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function formatArtist(artists) {
  if (!artists?.length) return 'неизв.';
  return artists.map(a => a.name).join(', ');
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

const lolka = new LolkaClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  presence: {
    status: 'online',
    activities: [{ name: 'Яндекс.Музыку', type: ActivityType.Playing }],
  },
  rest: { api: 'https://lolka.app/api/bot' },
});

const connections = new Map();
const states = new Map();

function getState(guildId) {
  if (!states.has(guildId)) {
    states.set(guildId, {
      tracks: [],
      index: 0,
      source: null,
      stationId: null,
      batchId: undefined,
      radioSessionId: null,
      searchResults: [],
      loop: false,
      channel: null,
      from: null,
      currentTrackId: null,
      npMsg: null,
      failCount: 0,
      totalFetchCount: 0,
      prevHistory: [],
      shuffle: false,
      queuePage: 0,
      queueMsg: null,
      trackStartTime: null,
      progressTimer: null,
    });
  }
  return states.get(guildId);
}

function clearProgressTimer(state) {
  if (state.progressTimer) {
    clearInterval(state.progressTimer);
    state.progressTimer = null;
  }
}

function cleanupState(state) {
  clearProgressTimer(state);
  state.npMsg?.delete().catch(() => {});
  state.npMsg = null;
  state.queueMsg?.delete().catch(() => {});
  state.queueMsg = null;
  state.tracks = [];
  state.index = 0;
  state.source = null;
  state.stationId = null;
  state.batchId = undefined;
  state.radioSessionId = null;
  state.currentTrackId = null;
  state.queuePage = 0;
  state.searchResults = [];
  state.prevHistory = [];
  state.shuffle = false;
  state.loop = false;
  state.from = null;
  state.totalFetchCount = 0;
  state.trackStartTime = null;
  state.failCount = 0;
}

function destroyConnection(guildId) {
  const conn = connections.get(guildId);
  if (!conn) return;
  conn.removeAllListeners('idle');
  conn.removeAllListeners('error');
  connections.delete(guildId);
  if (conn.state !== 'destroyed') conn.destroy();
  const s = states.get(guildId);
  if (s) { clearProgressTimer(s); s.npMsg = null; }
}

function extForCodec(codec) {
  if (codec === 'mp3') return '.mp3';
  if (codec === 'aac') return '.m4a';
  if (codec === 'flac') return '.flac';
  if (codec === 'opus') return '.ogg';
  return '.mp3';
}

function cleanupCache() {
  const files = readdirSync(CACHE_DIR);
  if (files.length <= MAX_CACHED_FILES) return;
  const used = new Set();
  for (const s of states.values()) {
    for (const t of s.tracks) {
      if (t.file) used.add(t.file);
    }
  }
  files
    .map(f => join(CACHE_DIR, f))
    .filter(fp => !used.has(fp))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
    .slice(0, files.length - MAX_CACHED_FILES)
    .forEach(f => { try { unlinkSync(f); } catch {} });
  console.log(`🧹 Кэш: ${files.length} → ${readdirSync(CACHE_DIR).length} файлов`);
}

function nowPlayingEmbed(entry, state, elapsedMs) {
  const cover = entry.cover ? `https://${entry.cover}` : null;
  const pos = state.index + 1;
  const total = (state.source === 'wave' || state.source === 'radio') ? '∞' : state.tracks.length;
  const ymUrl = entry.id ? `https://music.yandex.ru/album/0/track/${entry.id}` : null;

  const dur = entry.duration || 1;
  const pct = Math.min(1, Math.max(0, (elapsedMs || 0) / dur));
  const barLen = 14;
  const filled = Math.round(pct * barLen);
  const bar = '▰'.repeat(filled) + '▱'.repeat(Math.max(0, barLen - filled));

  const loopVal = Number(state.loop) || 0;
  const loopIcon = loopVal === 2 ? ' 🔁' : loopVal === 1 ? ' 🔂' : '';

  const elapsedStr = elapsedMs ? formatDuration(elapsedMs) : formatDuration(entry.duration);
  const totalStr = formatDuration(entry.duration);
  const timeStr = elapsedMs ? `${elapsedStr}/${totalStr}` : totalStr;

  const embed = new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle(entry.title || '—')
    .setURL(ymUrl)
    .setAuthor({ name: 'Яндекс.Музыка', iconURL: 'https://music.yandex.ru/favicon.ico' })
    .setDescription(
      `**${entry.artist || '—'}**\n` +
      `${bar} ${timeStr}`
    )
    .addFields(
      { name: '⏱ Прогресс', value: timeStr, inline: true },
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
  const loopLabels = ['🔁', '🔂', '🔁'];
  const shuffleBtn = new ButtonBuilder().setCustomId('ym_shuffle').setLabel('🔀').setStyle(state.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary);
  const row = new ActionRowBuilder().addComponents(prev, skip, stop, queue, shuffleBtn);
  const loop = new ButtonBuilder().setCustomId('ym_loop').setLabel(loopLabels[state.loop] || '🔁').setStyle(state.loop ? ButtonStyle.Success : ButtonStyle.Secondary);
  const row2 = new ActionRowBuilder().addComponents(loop);
  return [row, row2];
}

const PAGE_SIZE = 10;

function queueEmbed(state) {
  if (!state.tracks.length) return null;
  const totalPages = Math.ceil(state.tracks.length / PAGE_SIZE);
  const page = Math.min(Math.max(1, state.queuePage || 1), totalPages);
  const from = (page - 1) * PAGE_SIZE;
  const items = state.tracks.slice(from, from + PAGE_SIZE);

  const desc = items.map((t, i) => {
    const idx = from + i + 1;
    const now = idx - 1 === state.index ? '🎵' : `\`${idx}.\``;
    return `${now} **${t.title}** — ${t.artist} (${formatDuration(t.duration)})`;
  }).join('\n');

  return new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle(`📋 Очередь (${state.tracks.length} треков)`)
    .setDescription(desc)
    .setFooter({ text: `Страница ${page}/${totalPages}${state.source ? ` • ${sourceLabel(state.source)}` : ''}` })
    .setTimestamp();
}

function queueRows(totalPages, page) {
  const prev = new ButtonBuilder().setCustomId('ym_queue_prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1);
  const refresh = new ButtonBuilder().setCustomId('ym_showqueue').setLabel('📋').setStyle(ButtonStyle.Secondary);
  const next = new ButtonBuilder().setCustomId('ym_queue_next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages);
  return [new ActionRowBuilder().addComponents(prev, refresh, next)];
}

async function sendNowPlaying(guildId) {
  const state = getState(guildId);
  if (!state.channel || !state.tracks[state.index]) return;
  const entry = state.tracks[state.index];
  const elapsedMs = state.trackStartTime ? Date.now() - state.trackStartTime : null;
  const embed = nowPlayingEmbed(entry, state, elapsedMs);
  const rows = controlsRow(state);
  const payload = { embeds: [embed], components: rows };
  try {
    if (state.npMsg) {
      await state.npMsg.edit(payload);
    } else {
      state.npMsg = await state.channel.send(payload);
    }
  } catch {
    if (state.npMsg) state.npMsg.delete().catch(() => {});
    state.npMsg = null;
  }
}

async function reconnectVoice(guildId, channelId) {
  const old = connections.get(guildId);
  if (old) { old.removeAllListeners(); if (old.state !== 'destroyed') old.destroy(); }
  const guild = lolka.guilds.cache.get(guildId);
  if (!guild) return { conn: null, error: '❌ Гильдия не найдена' };
  const targetId = channelId || MUSIC_CHANNEL_ID;
  const vc = guild.channels.cache.get(targetId);
  if (!vc?.isVoiceBased()) return { conn: null, error: '❌ Нет голосового канала' };
  const conn = joinVoiceChannel({
    channelId: vc.id, guildId, adapterCreator: guild.voiceAdapterCreator,
  });
  conn.once('destroyed', () => {
    if (connections.get(guildId) === conn) {
      connections.delete(guildId);
      const s = states.get(guildId);
      if (s) { clearProgressTimer(s); s.npMsg = null; }
    }
  });
  connections.set(guildId, conn);
  try { await conn.awaitReady(30000); return { conn, error: null }; }
  catch (e) {
    connections.delete(guildId);
    if (conn.state !== 'destroyed') conn.destroy();
    return { conn: null, error: `❌ Не удалось подключиться: ${e.message}` };
  }
}

async function ensureConnection(guildId, voiceChannel) {
  let conn = connections.get(guildId);
  if (conn && conn.state === 'ready') return { conn, error: null };
  return reconnectVoice(guildId, voiceChannel?.id);
}

async function ymDownloadBytes(trackId) {
  let infos;
  try {
    infos = await ym.tracksDownloadInfo(trackId, false);
  } catch {
    infos = await ym.tracksDownloadInfo(trackId, true);
  }
  if (!infos?.length) throw new Error('Нет download-info');
  infos.sort((a, b) => (b.bitrateInKbps || 0) - (a.bitrateInKbps || 0));
  const best = infos[0];
  const ext = extForCodec(best.codec);
  const fp = join(CACHE_DIR, `${trackId}${ext}`);
  if (existsSync(fp)) return fp;
  await best.download(fp);
  cleanupCache();
  return fp;
}

async function queueTrack(guildId, track, source, stationId, batchId) {
  const state = getState(guildId);
  try {
    const fp = await ymDownloadBytes(track.id);
    state.tracks.push({
      id: track.id,
      title: track.title,
      artist: formatArtist(track.artists),
      duration: track.durationMs,
      cover: track.coverUri?.replace('%%', '200x200'),
      file: fp,
      source,
      stationId,
      batchId,
    });
    // Trim old tracks when exceeding MAX_QUEUE
    while (state.tracks.length > MAX_QUEUE) {
      state.tracks.shift();
      if (state.index > 0) state.index--;
    }
    return true;
  } catch (e) {
    console.error(`queueTrack error for ${track.id}: ${e.message}`);
    return false;
  }
}

async function refillWave(guildId, retried) {
  const state = getState(guildId);
  if (!state.stationId) return false;
  try {
    const queue = state.totalFetchCount || undefined;
    const result = await ym.rotorStationTracks(state.stationId, true, queue);
    if (!result?.sequence?.length) return false;
    state.batchId = result.batchId;
    state.radioSessionId = result.radioSessionId;
    state.totalFetchCount = (state.totalFetchCount || 0) + result.sequence.length;
    let added = 0;
    for (const seq of result.sequence) {
      if (!seq.track) continue;
      const ok = await queueTrack(guildId, seq.track, state.source, state.stationId, result.batchId);
      if (ok) added++;
    }
    if (added > 0 && !state.from) {
      state.from = `station:${state.stationId}`;
    }
    if (added > 0) {
      await ym.rotorStationFeedbackRadioStarted(state.stationId, state.from, state.batchId).catch(() => {});
    }
    return added > 0;
  } catch (e) {
    console.error('refillWave error:', e.message);
    return false;
  }
}

async function sendTrackFeedback(guildId, type, trackId, playedSeconds) {
  const state = getState(guildId);
  if (!state.stationId) return;
  const entry = state.tracks.find(t => t.id === trackId);
  const batchId = entry?.batchId || state.batchId;
  if (!batchId) return;
  try {
    const opts = { trackId, batchId };
    if (playedSeconds !== undefined) opts.totalPlayedSeconds = playedSeconds;
    await ym.rotorStationFeedback(state.stationId, type, opts);
  } catch {}
}

async function playTrack(guildId, startIndex) {
  const state = getState(guildId);
  const log = (msg) => state.channel?.send(msg).catch(() => {});

  if (startIndex !== undefined) state.index = startIndex;

  if (state.tracks.length === 0) {
    destroyConnection(guildId);
    state.npMsg?.delete().catch(() => {});
    state.npMsg = null;
    await log('📭 Очередь пуста. Используй `!ym` для поиска');
    return;
  }

  if (state.index >= state.tracks.length) {
    if (state.source === 'wave' || state.source === 'radio') {
      const ok = await refillWave(guildId);
      if (ok) {
        const removed = state.tracks.splice(0, Math.max(0, state.index));
        // Invalidate prevHistory entries for removed tracks
        if (removed.length > 0) {
          const removedIds = new Set(removed.map(t => t.id));
          state.prevHistory = state.prevHistory.filter(id => !removedIds.has(id));
        }
        state.index = 0;
      } else {
        destroyConnection(guildId);
        state.npMsg?.delete().catch(() => {});
        state.npMsg = null;
        await log('⏹ Поток закончился');
        return;
      }
    } else if (state.loop === 2) {
      state.index = 0;
    } else if (state.loop === 1) {
      state.index = Math.max(0, state.index - 1);
    } else {
      destroyConnection(guildId);
      state.npMsg?.delete().catch(() => {});
      state.npMsg = null;
      await log('⏹ Очередь закончилась');
      return;
    }
  }

  const entry = state.tracks[state.index];
  if (!entry) {
    state.tracks.splice(state.index, 1);
    return playTrack(guildId);
  }

  try {
    let conn = connections.get(guildId);
    if (!conn || conn.state !== 'ready') {
      const result = await reconnectVoice(guildId);
      if (!result.conn) throw new Error(result.error);
      conn = result.conn;
    }

    if (!existsSync(entry.file)) {
      state.tracks.splice(state.index, 1);
      throw new Error('Файл не найден');
    }

    // Save previous track for back button (store trackId, not index)
    if (state.index > 0 && state.tracks[state.index - 1]) {
      state.prevHistory.push(state.tracks[state.index - 1].id);
      if (state.prevHistory.length > 50) state.prevHistory.shift();
    }

    conn.removeAllListeners('idle');
    conn.removeAllListeners('error');
    conn.play(entry.file);
    state.failCount = 0;
    clearProgressTimer(state);
    state.trackStartTime = Date.now();
    state.progressTimer = setInterval(() => sendNowPlaying(guildId), 5000);

    state.currentTrackId = entry.id;
    await sendNowPlaying(guildId);

    if (state.source === 'wave' || state.source === 'radio') {
      await sendTrackFeedback(guildId, 'trackStarted', entry.id, 0);
    }

    const cleanup = () => {
      conn?.removeListener('idle', onIdle);
      conn?.removeListener('error', onError);
    };
    const onIdle = async () => {
      cleanup();
      if (state.source === 'wave' || state.source === 'radio') {
        await sendTrackFeedback(guildId, 'trackFinished', entry.id, Math.floor((entry.duration || 0) / 1000));
      }
      clearProgressTimer(state);
      if (state.loop === 1) {
        // track loop — replay same
      } else if (state.shuffle && state.tracks.length > 1) {
        state.index = Math.floor(Math.random() * state.tracks.length);
      } else {
        state.index++;
      }
      // Clean up old played tracks periodically
      if (state.source === 'wave' || state.source === 'radio') {
        if (state.index > 50) {
          const removed = state.tracks.splice(0, state.index);
          const removedIds = new Set(removed.map(t => t.id));
          state.prevHistory = state.prevHistory.filter(id => !removedIds.has(id));
          state.index = 0;
        }
        if (state.index >= state.tracks.length - 10) {
          await refillWave(guildId);
        }
      }
      playTrack(guildId);
    };
    const onError = (e) => {
      cleanup();
      clearProgressTimer(state);
      state.failCount = (state.failCount || 0) + 1;
      if (state.failCount >= 3) {
        log(`❌ Слишком много ошибок — остановлено: ${e.message}`);
        destroyConnection(guildId);
        cleanupState(state);
        return;
      }
      if (state.loop === 1) {
        // track loop — replay same
      } else if (state.shuffle && state.tracks.length > 1) {
        state.index = Math.floor(Math.random() * state.tracks.length);
      } else {
        state.index++;
      }
      log(`❌ ${entry.title}: ${e.message}`);
      setTimeout(() => playTrack(guildId), 1000);
    };
    conn.on('idle', onIdle);
    conn.on('error', onError);
  } catch (e) {
    console.error('Play error:', e.message);
    state.failCount = (state.failCount || 0) + 1;
    clearProgressTimer(state);
    if (state.failCount >= 3) {
      await log(`❌ Слишком много ошибок — остановлено: ${e.message}`);
      destroyConnection(guildId);
      cleanupState(state);
      return;
    }
    if (state.loop === 1) {
      // track loop — replay same
    } else if (state.shuffle && state.tracks.length > 1) {
      state.index = Math.floor(Math.random() * state.tracks.length);
    } else {
      state.index++;
    }
    await log(`❌ ${entry.title}: ${e.message}`);
    setTimeout(() => playTrack(guildId), 1000);
  }
}

async function showSearchResults(message, results, state) {
  if (!results.length) {
    return message.channel.send('❌ Ничего не найдено');
  }
  state.searchResults = results.slice(0, 5);
  let msg = `**🔍 Результаты поиска:**\n\n`;
  state.searchResults.forEach((t, i) => {
    const dur = formatDuration(t.durationMs);
    msg += `**${i + 1}.** ${t.title} — ${formatArtist(t.artists)} (${dur})\n`;
  });
  msg += `\nВведи \`!ym ${state.searchResults.length > 1 ? `1-${state.searchResults.length}` : '1'}\` чтобы выбрать`;
  await message.channel.send(msg);
}

const STATION_ALIASES = {
  wave: 'user:onyourwave',
  mywave: 'user:onyourwave',
  мояволна: 'user:onyourwave',
  personal: 'user:onyourwave',
};

let stationNameMap = null;
const STATION_COMMANDS = {
  '__chart__': 'chart',
  '__new__': 'newreleases',
};

async function buildStationNameMap() {
  const map = new Map();

  const add = (key, id, name) => map.set(key.toLowerCase(), { id: id.toLowerCase(), name });

  add('моя волна', 'user:onyourwave', 'Моя волна');
  add('мояволна', 'user:onyourwave', 'Моя волна');
  add('my wave', 'user:onyourwave', 'Моя волна');
  add('mywave', 'user:onyourwave', 'Моя волна');
  add('волна', 'user:onyourwave', 'Моя волна');
  add('wave', 'user:onyourwave', 'Моя волна');
  add('личное', 'user:onyourwave', 'Моя волна');
  add('персональное', 'user:onyourwave', 'Моя волна');
  add('чарт', '__chart__', 'Чарт');
  add('chart', '__chart__', 'Чарт');
  add('топ', '__chart__', 'Чарт');
  add('top', '__chart__', 'Чарт');
  add('новинки', '__new__', 'Новинки');
  add('new', '__new__', 'Новинки');

  try {
    const genres = await ym.genres();
    const walk = (g) => {
      if (!g.id) return;
      const ru = g.titles?.ru?.title || g.title;
      add(g.id, `genre:${g.id}`, ru || g.id);
      if (ru) add(ru, `genre:${g.id}`, ru);
      if (g.subGenres) g.subGenres.forEach(walk);
    };
    genres.forEach(walk);
  } catch (e) { console.error('genres error:', e.message); }

  try {
    const dash = await ym.rotorStationsDashboard();
    dash?.stations?.forEach(s => {
      if (!s.station?.id || !s.station.name) return;
      const id = `${s.station.id.type}:${s.station.id.tag}`;
      add(s.station.name, id, s.station.name);
      if (s.station.id.tag) add(s.station.id.tag, id, s.station.name);
    });
  } catch (e) { console.error('dashboard error:', e.message); }

  console.log(`🗺 Карта станций: ${map.size} записей`);
  return map;
}

async function playStation(guildId, vc, tc, stationId, displayName, source, icon) {
  const state = getState(guildId);
  const { conn, error } = await ensureConnection(guildId, vc);
  if (error) return tc.send(error);

  state.channel = tc;
  state.source = source || 'radio';
  state.stationId = stationId;
  state.batchId = undefined;
  state.radioSessionId = null;
  state.tracks = [];
  state.index = 0;
  state.from = null;
  state.totalFetchCount = 0;

  await tc.send(`${icon || '📻'} Загружаю **${displayName}**...`);
  let refills = 0;
  while (refills < 4) {
    const ok = await refillWave(guildId);
    if (!ok) break;
    refills++;
  }
  if (state.tracks.length === 0) return tc.send('❌ Не удалось получить треки');
  await tc.send(`${icon || '📻'} **${displayName}** (∞ поток, кэш ${state.tracks.length} треков)`);
  playTrack(guildId);
}

async function playSearchFirst(guildId, vc, tc, query) {
  const result = await ym.search(query, false, 'track', 0, false);
  const tracks = result?.tracks?.results || [];
  if (!tracks.length) return null;
  const track = tracks[0];
  const state = getState(guildId);
  const { conn, error } = await ensureConnection(guildId, vc);
  if (error) return tc.send(error);
  state.channel = tc;
  state.source = 'search';
  state.stationId = null;
  state.tracks = [];
  state.index = 0;
  await tc.send(`⏳ Скачиваю **${track.title}**...`);
  const ok = await queueTrack(guildId, track, 'search', null);
  if (!ok) return tc.send('❌ Не удалось скачать трек');
  await tc.send(`✅ **${track.title}** — ${formatArtist(track.artists)}`);
  playTrack(guildId);
  return true;
}

const PLAY_VERBS = ['включи', 'поставь', 'запусти', 'вруби', 'играй', 'play'];

lolka.on('messageCreate', async (message) => {
  if (message.author?.bot) return;
  const guildId = message.guild?.id;
  const tc = message.channel;
  const vc = message.member?.voice?.channel;

  // ── Natural language commands (без !) ──
  if (!message.content.startsWith(PREFIX) && ymReady && stationNameMap) {
    const lower = message.content.toLowerCase().trim();
    let query = null;
    for (const verb of PLAY_VERBS) {
      if (lower.startsWith(verb + ' ') || lower === verb) {
        query = lower.slice(verb.length).trim();
        break;
      }
    }
    if (query) {
      try {
        const match = stationNameMap.get(query);
        if (match) {
          const cmdName = STATION_COMMANDS[match.id];
          if (cmdName === 'chart') {
            const chart = await ym.chart();
            if (!chart?.chart?.tracks?.length) return tc.send('❌ Чарт не доступен');
            const tracks = chart.chart.tracks.map(t => t.track).filter(Boolean);
            const state = getState(guildId);
            const { conn, error } = await ensureConnection(guildId, vc);
            if (error) return tc.send(error);
            state.channel = tc; state.source = 'top'; state.stationId = null;
            state.tracks = []; state.index = 0;
            await tc.send(`⏳ Загружаю **Чарт**...`);
            let added = 0;
            for (const t of tracks.slice(0, 20)) { const ok = await queueTrack(guildId, t, 'top', null); if (ok) added++; }
            if (!added) return tc.send('❌ Не удалось скачать треки');
            await tc.send(`🏆 **Чарт** (${added} треков)`);
            return playTrack(guildId);
          }
          if (cmdName === 'newreleases') {
            const releases = await ym.newReleases();
            if (!releases?.tracks?.length) return tc.send('❌ Новинки не доступны');
            const tracks = releases.tracks;
            const state = getState(guildId);
            const { conn, error } = await ensureConnection(guildId, vc);
            if (error) return tc.send(error);
            state.channel = tc; state.source = 'new'; state.stationId = null;
            state.tracks = []; state.index = 0;
            await tc.send(`⏳ Загружаю **Новинки**...`);
            let added = 0;
            for (const t of tracks.slice(0, 20)) { const ok = await queueTrack(guildId, t, 'new', null); if (ok) added++; }
            if (!added) return tc.send('❌ Не удалось скачать треки');
            await tc.send(`🆕 **Новинки** (${added} треков)`);
            return playTrack(guildId);
          }
          return playStation(guildId, vc, tc, match.id, match.name);
        }
        const played = await playSearchFirst(guildId, vc, tc, query);
        if (played !== null) return;
        return tc.send(`❌ Не нашёл \`${query}\`. Доступно: рок, поп, моя волна, электроника...`);
      } catch (e) {
        return tc.send(`❌ ${e.message}`);
      }
    }
    return;
  }

  if (!message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();
  if (!cmd) return;

  if (!ymReady) {
    if (cmd === 'ym' && args[0] === 'retry') {
      await tc.send('🔄 Повторная инициализация YM...');
      await initYm();
      if (ymReady) await tc.send('✅ YM подключён');
      else await tc.send('❌ YM не доступен');
      return;
    }

    if (cmd === 'ym' && args[0] === 'auth') {
      const cid = process.env.YM_CLIENT_ID || '23cabbbdc6cd418abb4b39c32c41195d';
      const csec = process.env.YM_CLIENT_SECRET || '53bc75238f0c4d08a118e51fe9203300';
      (async () => {
        try {
          const authClient = new YmClient({ language: 'ru' });
          const deviceCode = await authClient.requestDeviceCode(undefined, undefined, cid);
          await tc.send(
            `🔑 **Авторизация в Яндексе**\n\n` +
            `1. Открой ссылку: ${deviceCode.verificationUrl}\n` +
            `2. Введи код: **${deviceCode.userCode}**\n` +
            `3. Подтверди доступ\n\n` +
            `⏱ Код действителен ${deviceCode.expiresIn || 300} секунд`
          );
          const deadline = Date.now() + ((deviceCode.expiresIn || 300) * 1000);
          const interval = (deviceCode.interval || 5) * 1000;
          let token = null;
          while (Date.now() < deadline) {
            token = await authClient.pollDeviceToken(deviceCode.deviceCode, cid, csec);
            if (token) break;
            await new Promise(r => setTimeout(r, interval));
          }
          if (!token) return tc.send('❌ Таймаут. Попробуй `!ym auth` заново');
          const test = new YmClient({ token: token.accessToken, language: 'ru' });
          await test.init();
          const login = test.me?.account?.login || '?';
          await tc.send(`✅ Токен получен! Аккаунт: **${login}**\n⚠ Живёт до перезапуска бота. Для сохранения: \`node setup.mjs\``);
          process.env.YM_TOKEN = token.accessToken;
          if (token.refreshToken) process.env.YM_REFRESH_TOKEN = token.refreshToken;
          if (test.close) test.close();
          authClient.close?.();
          await initYm();
        } catch (e) {
          tc.send(`❌ Ошибка: ${e.message}`).catch(() => {});
        }
      })();
      return;
    }
  }

  try {
    if (cmd === 'ym') {
      if (!ymReady) return tc.send('❌ Яндекс.Музыка не инициализирована. Попробуй `!ym retry`');

      const sub = args.shift()?.toLowerCase();
      const state = getState(guildId);

      if (!sub || sub === 'search') {
        const query = args.join(' ');
        if (!query) return tc.send('❌ Укажи запрос: `!ym <текст>` или `!ym search <текст>`');
        const result = await ym.search(query, false, 'track', 0, false);
        const tracks = result?.tracks?.results || [];
        return showSearchResults(message, tracks, state);
      }

      if (/^[1-5]$/.test(sub)) {
        const idx = parseInt(sub) - 1;
        if (!state.searchResults?.[idx]) return tc.send('❌ Результат не найден');
        const track = state.searchResults[idx];
        const { conn, error } = await ensureConnection(guildId, vc, message);
        if (error) return tc.send(error);

        state.channel = tc;
        state.source = 'search';
        state.stationId = null;
        state.batchId = undefined;
        state.radioSessionId = null;
        state.tracks = [];
        state.index = 0;

        await tc.send(`⏳ Скачиваю **${track.title}**...`);
        const ok = await queueTrack(guildId, track, 'search', null);
        if (!ok) return tc.send('❌ Не удалось скачать трек');
        await tc.send(`✅ ${track.title} — ${formatArtist(track.artists)}`);
        playTrack(guildId);
        return;
      }

      if (sub === 'wave' || sub === 'mywave' || sub === 'мояволна') {
        await playStation(guildId, vc, tc, 'user:onyourwave', 'Моя волна', 'wave', '🌊');
        return;
      }

      if (sub === 'radio') {
        const arg2 = args.shift();

        if (!arg2) {
          const stations = await ym.rotorStationsDashboard();
          if (!stations?.stations?.length) return tc.send('❌ Нет станций');
          let msg = `**📻 Станции:**\n\n`;
          stations.stations.forEach((s, i) => {
            if (!s.station?.id) return;
            const tag = `${s.station.id.type}:${s.station.id.tag}`;
            msg += `**${i + 1}.** ${s.station.name || tag} (\`${tag}\`)\n`;
          });
          msg += `\nВведи \`!ym radio <номер>\` или \`!ym radio <type:tag>\``;
          return tc.send(msg);
        }

        let stationId = STATION_ALIASES[arg2];
        if (!stationId) {
          if (arg2.includes(':')) {
            stationId = arg2;
          } else {
            const idx = parseInt(arg2) - 1;
            const stations = await ym.rotorStationsDashboard();
            const s = stations?.stations?.[idx];
            if (!s?.station?.id) return tc.send('❌ Станция не найдена');
            stationId = `${s.station.id.type}:${s.station.id.tag}`;
          }
        }

        const stName = stationId.includes(':') ? stationId.split(':').pop() : stationId;
        await playStation(guildId, vc, tc, stationId, stName, 'radio', '📻');
        return;
      }

      if (sub === 'pl' || sub === 'playlist') {
        const arg2 = args.shift();

        if (!arg2 || arg2 === 'list') {
          const plists = await ym.usersPlaylistsList();
          if (!plists?.length) return tc.send('❌ Нет плейлистов');
          let msg = `**📋 Плейлисты:**\n\n`;
          plists.forEach((p, i) => {
            const count = p.trackCount;
            msg += `**${i + 1}.** ${p.title} (${count} треков)\n`;
          });
          msg += `\nВведи \`!ym pl <номер>\` чтобы играть`;
          return tc.send(msg);
        }

        const idx = parseInt(arg2) - 1;
        const plists = await ym.usersPlaylistsList();
        const pl = plists?.[idx];
        if (!pl) return tc.send('❌ Плейлист не найден');

        const full = await ym.usersPlaylists(pl.kind);
        if (!full) return tc.send('❌ Не удалось загрузить плейлист');

        const { conn, error } = await ensureConnection(guildId, vc, message);
        if (error) return tc.send(error);

        state.channel = tc;
        state.source = 'playlist';
        state.stationId = null;
        state.batchId = undefined;
        state.tracks = [];
        state.index = 0;

        await tc.send(`⏳ Загружаю плейлист **${pl.title}**...`);
        let added = 0;
        for (const entry2 of full.tracks || []) {
          if (!entry2) continue;
          const ok = await queueTrack(guildId, entry2, 'playlist', null);
          if (ok) added++;
        }
        if (!added) return tc.send('❌ Ничего не удалось скачать');
        await tc.send(`✅ **${pl.title}** (${added} треков)`);
        playTrack(guildId);
        return;
      }

      if (sub === 'top' || sub === 'chart') {
        const chart = await ym.chart();
        if (!chart?.chart?.tracks?.length) return tc.send('❌ Чарт не доступен');
        const tracks = chart.chart.tracks.map(t => t.track).filter(Boolean);

        const { conn, error } = await ensureConnection(guildId, vc, message);
        if (error) return tc.send(error);

        state.channel = tc;
        state.source = 'top';
        state.stationId = null;
        state.batchId = undefined;
        state.tracks = [];
        state.index = 0;

        await tc.send(`⏳ Загружаю **Чарт** (${tracks.length} треков)...`);
        let added = 0;
        for (const t of tracks.slice(0, 20)) {
          const ok = await queueTrack(guildId, t, 'top', null);
          if (ok) added++;
        }
        if (!added) return tc.send('❌ Не удалось скачать треки');
        await tc.send(`🏆 **Чарт** (${added} треков)`);
        playTrack(guildId);
        return;
      }

      if (sub === 'new' || sub === 'newreleases') {
        const releases = await ym.newReleases();
        if (!releases?.tracks?.length) return tc.send('❌ Новинки не доступны');
        const tracks = releases.tracks;

        const { conn, error } = await ensureConnection(guildId, vc, message);
        if (error) return tc.send(error);

        state.channel = tc;
        state.source = 'new';
        state.stationId = null;
        state.batchId = undefined;
        state.tracks = [];
        state.index = 0;

        await tc.send(`⏳ Загружаю **Новинки** (${tracks.length} треков)...`);
        let added = 0;
        for (const t of tracks.slice(0, 20)) {
          const ok = await queueTrack(guildId, t, 'new', null);
          if (ok) added++;
        }
        if (!added) return tc.send('❌ Не удалось скачать треки');
        await tc.send(`🆕 **Новинки** (${added} треков)`);
        playTrack(guildId);
        return;
      }

      if (sub === 'dislike') {
        const s = getState(guildId);
        if (!s.currentTrackId) return tc.send('❌ Сейчас ничего не играет');
        try {
          await ym.usersDislikesTracksAdd(s.currentTrackId);
          await tc.send(`💔 Дизлайк`);
        } catch (e) {
          await tc.send(`❌ Ошибка: ${e.message}`);
        }
        const conn2 = connections.get(guildId);
        if (conn2) conn2.stop().catch(() => {});
        return;
      }

      if (sub === 'retry') {
        return tc.send('✅ YM уже инициализирован');
      }

      return tc.send(
        '❓ Неизвестная команда. Используй:\n' +
        '`!ym <текст>` — поиск\n' +
        '`!ym wave` — Моя волна\n' +
        '`!ym radio` — станции\n' +
        '`!ym pl` — плейлисты\n' +
        '`!ym top` — чарт\n' +
        '`!ym new` — новинки\n' +
        '`!ym dislike`\n' +
        '`!ym retry` — переподключить YM\n' +
        '`!ym auth` — авторизация в Яндексе (прямо в чате)\n\n' +
        '💬 Можно просто написать:\n' +
        '`включи рок` · `включи поп` · `включи моя волна`\n' +
        '`поставь чарт` · `запусти новинки` · `включи <название>`'
      );
    }

    if (cmd === 'skip' || cmd === 's') {
      const state = getState(guildId);
      const conn = connections.get(guildId);
      if (!conn) return tc.send('❌ Бот не в голосовом канале');
      if (state.currentTrackId && (state.source === 'wave' || state.source === 'radio')) {
        const entry = state.tracks[state.index];
        const played = entry?.duration ? Math.floor(entry.duration / 1000) : 0;
        await sendTrackFeedback(guildId, 'skip', state.currentTrackId, played);
      }
      conn.removeAllListeners('idle');
      conn.removeAllListeners('error');
      clearProgressTimer(state);
      if (state.shuffle && state.tracks.length > 1) {
        state.index = Math.floor(Math.random() * state.tracks.length);
      } else {
        state.index++;
      }
      tc.send('⏭ Пропущено');
      playTrack(guildId);
      return;
    }

    if (cmd === 'stop' || cmd === 'leave') {
      const conn = connections.get(guildId);
      if (!conn) return tc.send('❌ Бот не в голосовом канале');
      const state = getState(guildId);
      destroyConnection(guildId);
      cleanupState(state);
      await tc.send('⏹ Остановлено');
      return;
    }

    if (cmd === 'loop') {
      const state = getState(guildId);
      state.loop = ((state.loop || 0) + 1) % 3;
      const labels = ['ВЫКЛ', 'ТРЕК', 'ОЧЕРЕДЬ'];
      await tc.send(`🔁 Повтор: **${labels[state.loop]}**`);
      return;
    }

    if (cmd === 'shuffle') {
      const state = getState(guildId);
      state.shuffle = !state.shuffle;
      await tc.send(`🔀 Перемешивание: **${state.shuffle ? 'ВКЛ' : 'ВЫКЛ'}**`);
      return;
    }

    if (cmd === 'prev' || cmd === 'back') {
      const state = getState(guildId);
      if (state.prevHistory.length === 0) return tc.send('❌ Нет предыдущих треков');
      const conn = connections.get(guildId);
      if (conn) { conn.removeAllListeners('idle'); conn.removeAllListeners('error'); }
      clearProgressTimer(state);
      const prevId = state.prevHistory.pop();
      const prevIdx = state.tracks.findIndex(t => t.id === prevId);
      if (prevIdx >= 0) state.index = prevIdx;
      tc.send('⏮ Назад');
      playTrack(guildId);
      return;
    }

    if (cmd === 'np' || cmd === 'nowplaying') {
      const state = getState(guildId);
      if (!state.tracks.length || state.index >= state.tracks.length)
        return tc.send('📭 Сейчас ничего не играет');
      const t = state.tracks[state.index];
      const elapsedMs = state.trackStartTime ? Date.now() - state.trackStartTime : null;
      const embed = nowPlayingEmbed(t, state, elapsedMs);
      return tc.send({ embeds: [embed] });
    }

    if (cmd === 'queue' || cmd === 'q') {
      const state = getState(guildId);
      if (!state.tracks.length) return tc.send('📭 Очередь пуста');
      const totalPages = Math.ceil(state.tracks.length / PAGE_SIZE);
      state.queuePage = 1;
      const embed = queueEmbed(state);
      if (!embed) return tc.send('📭 Очередь пуста');
      const rows = queueRows(totalPages, 1);
      state.queueMsg = await tc.send({ embeds: [embed], components: rows }).catch(() => null);
      return;
    }

    if (cmd === 'help') {
      return tc.send(
        `**🎵 Яндекс.Музыка бот**\n\n` +
        `**💬 Голосовые команды (без !):**\n` +
        `\`включи рок\` \`поставь поп\` \`включи моя волна\`\n` +
        `\`запусти чарт\` \`включи <название трека>\`\n\n` +
        `**Поиск и воспроизведение:**\n` +
        `\`${PREFIX}ym <текст>\` — поиск треков\n` +
        `\`${PREFIX}ym 1-5\` — выбрать из результатов\n` +
        `\`${PREFIX}ym wave\` — **Моя волна**\n` +
        `\`${PREFIX}ym radio\` — список станций\n` +
        `\`${PREFIX}ym radio <N>\` — играть станцию\n` +
        `\`${PREFIX}ym pl\` — список плейлистов\n` +
        `\`${PREFIX}ym pl <N>\` — играть плейлист\n` +
        `\`${PREFIX}ym top\` — чарт\n` +
        `\`${PREFIX}ym new\` — новинки\n\n` +
        `**Управление:**\n` +
        `\`${PREFIX}skip\` / кнопка ⏭ — пропустить\n` +
        `\`${PREFIX}prev\` / кнопка ⏮ — предыдущий\n` +
        `\`${PREFIX}stop\` / кнопка ⏹ — остановить\n` +
        `\`${PREFIX}queue\` / кнопка 📋 — очередь\n` +
        `\`${PREFIX}shuffle\` / кнопка 🔀 — перемешать\n` +
        `\`${PREFIX}loop\` / кнопка 🔁 — повтор: выкл/трек/очередь\n` +
        `\`${PREFIX}ym dislike\` — дизлайк\n` +
        `\`${PREFIX}np\` — что играет\n` +
        `\`${PREFIX}help\` — помощь`
      );
    }
  } catch (e) {
    console.error('Command error:', e.message);
    tc.send(`❌ ${e.message}`).catch(() => {});
  }
});

lolka.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const guildId = interaction.guild?.id;
  const state = getState(guildId);
  const tc = interaction.channel;

  try {
    if (interaction.customId === 'ym_skip') {
      const conn = connections.get(guildId);
      if (!conn) return interaction.reply({ content: '❌ Бот не в голосовом канале', flags: MessageFlags.Ephemeral });
      conn.removeAllListeners('idle');
      conn.removeAllListeners('error');
      clearProgressTimer(state);
      if (state.shuffle && state.tracks.length > 1) {
        state.index = Math.floor(Math.random() * state.tracks.length);
      } else {
        state.index++;
      }
      interaction.deferUpdate();
      playTrack(guildId);
    } else if (interaction.customId === 'ym_loop') {
      state.loop = ((state.loop || 0) + 1) % 3;
      if (state.npMsg) await sendNowPlaying(guildId);
      interaction.deferUpdate();
    } else if (interaction.customId === 'ym_stop') {
      const conn = connections.get(guildId);
      if (!conn) return interaction.reply({ content: '❌ Бот не в голосовом канале', flags: MessageFlags.Ephemeral });
      destroyConnection(guildId);
      cleanupState(state);
      interaction.deferUpdate();
      tc.send('⏹ Остановлено').catch(() => {});
    } else if (interaction.customId === 'ym_prev') {
      if (state.prevHistory.length > 0) {
        const prevId = state.prevHistory.pop();
        const prevIdx = state.tracks.findIndex(t => t.id === prevId);
        if (prevIdx >= 0) state.index = prevIdx;
      }
      clearProgressTimer(state);
      interaction.deferUpdate();
      playTrack(guildId);
    } else if (interaction.customId === 'ym_showqueue') {
      interaction.deferUpdate();
      if (!state.tracks.length) return tc.send('📭 Очередь пуста').catch(() => {});
      const totalPages = Math.ceil(state.tracks.length / PAGE_SIZE);
      state.queuePage = Math.min(Math.max(1, state.queuePage || 1), totalPages);
      const embed = queueEmbed(state);
      if (!embed) return tc.send('📭 Очередь пуста').catch(() => {});
      const rows = queueRows(totalPages, state.queuePage);
      if (state.queueMsg) {
        state.queueMsg.edit({ embeds: [embed], components: rows }).catch(() => { state.queueMsg = null; });
      }
      if (!state.queueMsg) {
        state.queueMsg = await tc.send({ embeds: [embed], components: rows }).catch(() => null);
      }
    } else if (interaction.customId === 'ym_queue_prev') {
      interaction.deferUpdate();
      state.queuePage = Math.max(1, (state.queuePage || 1) - 1);
      const totalPages = Math.ceil(state.tracks.length / PAGE_SIZE);
      const embed = queueEmbed(state);
      const rows = queueRows(totalPages, state.queuePage);
      if (state.queueMsg) {
        state.queueMsg.edit({ embeds: [embed], components: rows }).catch(() => { state.queueMsg = null; });
      }
    } else if (interaction.customId === 'ym_queue_next') {
      interaction.deferUpdate();
      const totalPages = Math.ceil(state.tracks.length / PAGE_SIZE);
      state.queuePage = Math.min(totalPages, (state.queuePage || 1) + 1);
      const embed = queueEmbed(state);
      const rows = queueRows(totalPages, state.queuePage);
      if (state.queueMsg) {
        state.queueMsg.edit({ embeds: [embed], components: rows }).catch(() => { state.queueMsg = null; });
      }
    } else if (interaction.customId === 'ym_shuffle') {
      state.shuffle = !state.shuffle;
      if (state.npMsg) await sendNowPlaying(guildId);
      interaction.deferUpdate();
    }
  } catch (e) {
    console.error('Interaction error:', e.message);
  }
});

lolka.once('clientReady', async (c) => {
  console.log(`🎵 YM-бот запущен: ${c.user.tag}`);
  console.log(`📁 Кэш: ${CACHE_DIR}`);
  await initYm();
  if (ymReady) stationNameMap = await buildStationNameMap();

  if (MUSIC_CHANNEL_ID) {
    try {
      const guild = c.guilds.cache.first();
      if (guild) {
        const vc = guild.channels.cache.get(MUSIC_CHANNEL_ID);
        if (vc?.isVoiceBased()) {
          const conn = joinVoiceChannel({
            channelId: vc.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator,
          });
          conn.once('destroyed', () => {
            if (connections.get(guild.id) === conn) {
              connections.delete(guild.id);
            }
          });
          connections.set(guild.id, conn);
          console.log(`🔊 Подключаюсь к ${vc.name}...`);
          try { await conn.awaitReady(30000); console.log('✅ Голос готов'); }
          catch (e) {
            console.error('❌ Голос не готов:', e.message);
            connections.delete(guild.id);
            if (conn.state !== 'destroyed') conn.destroy();
          }
        }
      }
    } catch (e) { console.error('Auto-join error:', e.message); }
  }
});

process.on('uncaughtException', (e) => { console.error('💥 Uncaught:', e); });
process.on('unhandledRejection', (e) => { console.error('💥 Unhandled rejection:', e); });

lolka.login(TOKEN);

lolka.on('guildDelete', (g) => { states.delete(g.id); });
