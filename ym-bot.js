import 'dotenv/config';
import { Client as LolkaClient, GatewayIntentBits, ActivityType, joinVoiceChannel, Embed, ButtonBuilder, ActionRowBuilder, ButtonStyle, MessageFlags } from 'lolka.js';
import { Client as YmClient } from '@dvxch/yandex-music';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const TOKEN = process.env.LOLKA_TOKEN_YM || '';
const MUSIC_CHANNEL_ID = process.env.MUSIC_CHANNEL_ID || '';
const PREFIX = '!';

const YM_TOKEN = process.env.YM_TOKEN || '';
const YM_SESSION_ID = process.env.YM_SESSION_ID || '';
const YM_SESSION_ID2 = process.env.YM_SESSION_ID2 || '';

const CACHE_DIR = join(import.meta.dirname, 'music', '_ym');
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

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
    });
  }
  return states.get(guildId);
}

function extForCodec(codec) {
  if (codec === 'mp3') return '.mp3';
  if (codec === 'aac') return '.m4a';
  if (codec === 'flac') return '.flac';
  if (codec === 'opus') return '.ogg';
  return '.mp3';
}

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
  if (state.currentTrackId) {
    const like = new ButtonBuilder().setCustomId('ym_like').setLabel('❤️').setStyle(ButtonStyle.Secondary);
    row.addComponents(like);
  }
  const row2 = new ActionRowBuilder();
  const shuffleBtn = new ButtonBuilder().setCustomId('ym_shuffle').setLabel(state.shuffle ? '🔀' : '➡️').setStyle(state.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary);
  const loop = new ButtonBuilder().setCustomId('ym_loop').setLabel(state.loop ? '🔁' : '➡️').setStyle(state.loop ? ButtonStyle.Success : ButtonStyle.Secondary);
  row2.addComponents(shuffleBtn, loop);
  return [row, row2];
}

async function sendNowPlaying(guildId) {
  const state = getState(guildId);
  if (!state.channel || !state.tracks[state.index]) return;
  const entry = state.tracks[state.index];
  const embed = nowPlayingEmbed(entry, state);
  const rows = controlsRow(state);
  const payload = { embeds: [embed], components: rows };
  try {
    if (state.npMsg) {
      await state.npMsg.edit(payload);
    } else {
      state.npMsg = await state.channel.send(payload);
    }
  } catch {
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
  conn.once('destroyed', () => { if (connections.get(guildId) === conn) connections.delete(guildId); });
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

async function ymDownload(trackId, destPath) {
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
  const fp = destPath + ext;
  if (existsSync(fp)) return fp;
  await best.download(fp);
  return fp;
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
      ymTrack: track,
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
    const conn = connections.get(guildId);
    if (conn) { conn.removeAllListeners(); conn.destroy(); connections.delete(guildId); }
    if (state.npMsg) { state.npMsg.delete().catch(() => {}); state.npMsg = null; }
    await log('📭 Очередь пуста. Используй `!ym` для поиска');
    return;
  }

  if (state.index >= state.tracks.length) {
    if (state.source === 'wave' || state.source === 'radio') {
      const ok = await refillWave(guildId);
      if (ok) {
        state.tracks.splice(0, Math.max(0, state.index));
        state.index = 0;
      } else {
        const conn = connections.get(guildId);
        if (conn) { conn.removeAllListeners(); conn.destroy(); connections.delete(guildId); }
        if (state.npMsg) { state.npMsg.delete().catch(() => {}); state.npMsg = null; }
        await log('⏹ Поток закончился');
        return;
      }
    } else if (state.loop) {
      state.index = 0;
    } else {
      const conn = connections.get(guildId);
      if (conn) { conn.removeAllListeners(); conn.destroy(); connections.delete(guildId); }
      if (state.npMsg) { state.npMsg.delete().catch(() => {}); state.npMsg = null; }
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

    // Save previous track for back button
    if (state.index > 0) {
      state.prevHistory.push(state.index - 1);
      if (state.prevHistory.length > 50) state.prevHistory.shift();
    }

    conn.removeAllListeners('idle');
    conn.removeAllListeners('error');
    conn.play(entry.file);
    state.failCount = 0;

    state.currentTrackId = entry.id;
    sendNowPlaying(guildId);

    if (state.source === 'wave' || state.source === 'radio') {
      sendTrackFeedback(state.guildId || guildId, 'trackStarted', entry.id, 0);
    }

    const cleanup = () => {
      conn?.removeListener('idle', onIdle);
      conn?.removeListener('error', onError);
    };
    const onIdle = async () => {
      cleanup();
      if (state.source === 'wave' || state.source === 'radio') {
        sendTrackFeedback(guildId, 'trackFinished', entry.id, Math.floor((entry.duration || 0) / 1000));
      }
      if (state.shuffle && state.tracks.length > 1) {
        state.index = Math.floor(Math.random() * state.tracks.length);
      } else {
        state.index++;
      }
      // Clean up old played tracks periodically
      if (state.source === 'wave' || state.source === 'radio') {
        if (state.index > 50) {
          state.tracks.splice(0, state.index);
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
      if (state.shuffle && state.tracks.length > 1) {
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
    if (state.failCount >= 3) {
      await log(`❌ Слишком много ошибок — остановлено: ${e.message}`);
      const c = connections.get(guildId);
      if (c) { c.removeAllListeners(); c.destroy(); connections.delete(guildId); }
      if (state.npMsg) { state.npMsg.delete().catch(() => {}); state.npMsg = null; }
      state.tracks = [];
      state.index = 0;
      state.failCount = 0;
      return;
    }
    if (state.shuffle && state.tracks.length > 1) {
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

lolka.on('messageCreate', async (message) => {
  if (message.author?.bot) return;
  const guildId = message.guild?.id;
  const tc = message.channel;
  const vc = message.member?.voice?.channel;

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
        const { conn, error } = await ensureConnection(guildId, vc, message);
        if (error) return tc.send(error);

        state.channel = tc;
        state.source = 'wave';
        state.stationId = 'user:onyourwave';
        state.batchId = undefined;
        state.radioSessionId = null;
        state.tracks = [];
        state.index = 0;
        state.from = null;
        state.totalFetchCount = 0;

        await tc.send('🌊 Загружаю **Мою волну**...');
        let refills = 0;
        while (refills < 4) {
          const ok = await refillWave(guildId);
          if (!ok) break;
          refills++;
        }
        if (state.tracks.length === 0) return tc.send('❌ Не удалось получить треки');
        await tc.send(`🌊 **Моя волна** (∞ поток, кэш ${state.tracks.length} треков)`);
        playTrack(guildId);
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

        const { conn, error } = await ensureConnection(guildId, vc, message);
        if (error) return tc.send(error);

        state.channel = tc;
        state.source = 'radio';
        state.stationId = stationId;
        state.batchId = undefined;
        state.radioSessionId = null;
        state.tracks = [];
        state.index = 0;
        state.from = null;
        state.totalFetchCount = 0;

        await tc.send(`📻 Загружаю **${stationId}**...`);
        let refills = 0;
        while (refills < 4) {
          const ok = await refillWave(guildId);
          if (!ok) break;
          refills++;
        }
        if (state.tracks.length === 0) return tc.send('❌ Не удалось получить треки');
        await tc.send(`📻 **${stationId}** (∞ поток, кэш ${state.tracks.length} треков)`);
        playTrack(guildId);
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

      if (sub === 'like') {
        const s = getState(guildId);
        if (!s.currentTrackId) return tc.send('❌ Сейчас ничего не играет');
        try {
          await ym.usersLikesTracksAdd(s.currentTrackId);
          await tc.send(`❤️ Лайк!`);
        } catch (e) {
          await tc.send(`❌ Ошибка: ${e.message}`);
        }
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
        if (conn2) conn2.stop();
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
        '`!ym like` / `!ym dislike`\n' +
        '`!ym retry` — переподключить YM\n' +
        '`!ym auth` — авторизация в Яндексе (прямо в чате)'
      );
    }

    if (cmd === 'skip' || cmd === 's') {
      const state = getState(guildId);
      const conn = connections.get(guildId);
      if (!conn) return tc.send('❌ Бот не в голосовом канале');
      if (state.currentTrackId && (state.source === 'wave' || state.source === 'radio')) {
        const entry = state.tracks[state.index];
        const played = entry?.duration ? Math.floor(entry.duration / 1000) : 0;
        sendTrackFeedback(guildId, 'skip', state.currentTrackId, played);
      }
      conn.removeAllListeners('idle');
      conn.removeAllListeners('error');
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
      connections.delete(guildId);
      conn.destroy();
      const state = getState(guildId);
      state.tracks = [];
      state.index = 0;
      state.source = null;
      state.stationId = null;
      state.batchId = undefined;
      state.radioSessionId = null;
      state.currentTrackId = null;
      await tc.send('⏹ Остановлено');
      return;
    }

    if (cmd === 'loop') {
      const state = getState(guildId);
      state.loop = !state.loop;
      await tc.send(`🔁 Повтор: **${state.loop ? 'ВКЛ' : 'ВЫКЛ'}**`);
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
      state.index = state.prevHistory.pop();
      tc.send('⏮ Назад');
      playTrack(guildId);
      return;
    }

    if (cmd === 'np' || cmd === 'nowplaying') {
      const state = getState(guildId);
      if (!state.tracks.length || state.index >= state.tracks.length)
        return tc.send('📭 Сейчас ничего не играет');
      const t = state.tracks[state.index];
      const embed = nowPlayingEmbed(t, state);
      return tc.send({ embeds: [embed] });
    }

    if (cmd === 'queue' || cmd === 'q') {
      const state = getState(guildId);
      if (!state.tracks.length) return tc.send('📭 Очередь пуста');
      const from = state.index;
      const show = state.tracks.slice(from, from + 20);
      let msg = `**📋 Очередь (${state.tracks.length}):**\n`;
      msg += show.map((t, i) => `${i === 0 ? '🎵' : `${from + i + 1}.`} **${t.title}** — ${t.artist}`).join('\n');
      if (state.tracks.length > from + 20) msg += `\n...и ещё ${state.tracks.length - from - 20}`;
      return tc.send(msg);
    }

    if (cmd === 'help') {
      return tc.send(
        `**🎵 Яндекс.Музыка бот**\n\n` +
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
        `\`${PREFIX}loop\` / кнопка 🔁 — повтор\n` +
        `\`${PREFIX}ym like\` — лайкнуть трек\n` +
        `\`${PREFIX}ym dislike\` — дизлайк\n` +
        `\`${PREFIX}queue\` — очередь\n` +
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
  if (!interaction.isButton || !interaction.isButton()) return;
  const guildId = interaction.guild?.id;
  const state = getState(guildId);
  const tc = interaction.channel;

  try {
    if (interaction.customId === 'ym_skip') {
      const conn = connections.get(guildId);
      if (!conn) return interaction.reply({ content: '❌ Бот не в голосовом канале', flags: MessageFlags.Ephemeral });
      conn.removeAllListeners('idle');
      conn.removeAllListeners('error');
      state.index++;
      interaction.deferUpdate();
      playTrack(guildId);
    } else if (interaction.customId === 'ym_loop') {
      state.loop = !state.loop;
      if (state.npMsg) sendNowPlaying(guildId);
      interaction.deferUpdate();
    } else if (interaction.customId === 'ym_stop') {
      const conn = connections.get(guildId);
      if (!conn) return interaction.reply({ content: '❌ Бот не в голосовом канале', flags: MessageFlags.Ephemeral });
      connections.delete(guildId);
      conn.destroy();
      state.tracks = [];
      state.index = 0;
      state.source = null;
      state.stationId = null;
      state.batchId = undefined;
      state.radioSessionId = null;
      state.currentTrackId = null;
      if (state.npMsg) { state.npMsg.delete().catch(() => {}); state.npMsg = null; }
      interaction.deferUpdate();
      tc.send('⏹ Остановлено').catch(() => {});
    } else if (interaction.customId === 'ym_like') {
      interaction.deferUpdate();
      if (state.currentTrackId) {
        try { await ym.usersLikesTracksAdd(state.currentTrackId); } catch {}
      }
    } else if (interaction.customId === 'ym_prev') {
      if (state.prevHistory.length > 0) {
        const prevIndex = state.prevHistory.pop();
        state.index = prevIndex;
      }
      interaction.deferUpdate();
      playTrack(guildId);
    } else if (interaction.customId === 'ym_showqueue') {
      interaction.deferUpdate();
      if (!state.tracks.length) return tc.send('📭 Очередь пуста').catch(() => {});
      const from = state.index;
      const show = state.tracks.slice(from, from + 10);
      let msg = `**📋 Очередь [${from + 1}/${state.tracks.length}]:**\n`;
      show.forEach((t, i) => {
        msg += `\`${from + i + 1}.\` ${t.title} — ${t.artist}\n`;
      });
      if (state.tracks.length > from + 10) msg += `...и ещё ${state.tracks.length - from - 10} треков`;
      tc.send(msg).catch(() => {});
    } else if (interaction.customId === 'ym_shuffle') {
      state.shuffle = !state.shuffle;
      if (state.npMsg) sendNowPlaying(guildId);
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

  if (MUSIC_CHANNEL_ID) {
    try {
      const guild = c.guilds.cache.first();
      if (guild) {
        const vc = guild.channels.cache.get(MUSIC_CHANNEL_ID);
        if (vc?.isVoiceBased()) {
          const conn = joinVoiceChannel({
            channelId: vc.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator,
          });
          conn.once('destroyed', () => { if (connections.get(guild.id) === conn) connections.delete(guild.id); });
          connections.set(guild.id, conn);
          console.log(`🔊 Подключаюсь к ${vc.name}...`);
          try { await conn.awaitReady(30000); console.log('✅ Голос готов'); }
          catch (e) {
            console.error('❌ Голос не готов:', e.message);
            if (connections.get(guild.id) === conn) connections.delete(guild.id);
          }
        }
      }
    } catch (e) { console.error('Auto-join error:', e.message); }
  }
});

process.on('uncaughtException', (e) => { console.error('💥', e.message); });
process.on('unhandledRejection', (e) => { console.error('💥', e.message); });

lolka.login(TOKEN);
