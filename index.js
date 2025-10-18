// index.js
// Запуск: npm i && npm start
// Рекомендуется иметь ffmpeg и yt-dlp в PATH или рядом с приложением.
// Директории: ./music, ./temp, library.json, settings.json

const { app, BrowserWindow, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const https = require('https');
const urlLib = require('url');
const ytdl = require('ytdl-core');
const RPC = require('discord-rpc');

const manager = require('./manager');

// -------------------- Папки/файлы --------------------
const BASE_DIR = __dirname;
const DATA_DIR = BASE_DIR;
const TEMP_DIR = path.join(DATA_DIR, 'temp');
const DEFAULT_MUSIC_DIR = path.join(DATA_DIR, 'music');
const LIBRARY_JSON = path.join(DATA_DIR, 'library.json');
const SETTINGS_JSON = path.join(DATA_DIR, 'settings.json');
const ICON_PATH = path.join(DATA_DIR, 'favicon.ico');
const OPENROUTER_KEY_PATH = path.join(BASE_DIR, 'openrouter.key');

// -------------------- Discord RPC (вшито) --------------------
const DISCORD = {
  clientId: '1427937078225797170',
  largeImageKey: 'app',
  smallImagePlay: 'app',
  smallImagePause: 'app',
  enabled: true,
  debug: false
};

// -------------------- OpenRouter (ИИ-метаданные) --------------------
function getOpenRouterKey() {
  if (process.env.OPENROUTER_API_KEY) return String(process.env.OPENROUTER_API_KEY).trim();
  try {
    if (fs.existsSync(OPENROUTER_KEY_PATH)) {
      return String(fs.readFileSync(OPENROUTER_KEY_PATH, 'utf-8')).trim();
    }
  } catch {}
  return null;
}

let mainWindow;

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function openRouterParseMeta({ title, author, url, videoId }, settings) {
  return new Promise((resolve) => {
    if (!settings?.aiEnabled) return resolve(null);
    const apiKey = getOpenRouterKey();
    if (!apiKey) return resolve(null);

    const payload = {
      model: 'deepseek/deepseek-chat-v3-0324:free',
      messages: [
        {
          role: 'user',
          content:
            `Извлеки корректные Автор и Название трека из информации:\n` +
            `title: "${title}"\n` +
            `author: "${author}"\n` +
            (url ? `url: ${url}\n` : '') +
            `Верни ЧИСТО JSON без лишнего текста в формате: {"author":"...", "title":"..."}. ` +
            `Если не уверенно — старайся очистить шум (feat., оф. видео, клип, prod. ...), но сохрани основную сущность.`,
        },
      ],
    };

    const req = https.request(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const content = json?.choices?.[0]?.message?.content || '';
            const match = content.match(/\{[\s\S]*\}/);
            if (!match) return resolve(null);
            const meta = JSON.parse(match[0]);
            if (!meta) return resolve(null);
            const cleaned = {
              author: String(meta.author || meta.artist || author || 'Unknown').trim(),
              title: String(meta.title || meta.name || title || 'Без названия').trim(),
              videoId
            };
            sendToRenderer('ai-meta', cleaned);
            resolve(cleaned);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.write(JSON.stringify(payload));
    req.end();
  });
}

// -------------------- Settings / Library --------------------
function defaultSettings() {
  return {
    opacity: 1.0,
    audioBitrateKbps: 192,
    musicDir: DEFAULT_MUSIC_DIR,
    ffmpegPath: "",
    animations: true,
    volume: 1.0,
    rpcDebug: false,
    lastPlayback: null,
    aiEnabled: true,
    theme: {
      vars: {},      // { '--bg': '#000000', ... }
      elements: {}   // { '--titlebar-bg-color': '#...', '--progress1': '#...' }
    }
  };
}
function ensureDirs(musicDir) {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  if (!fs.existsSync(musicDir)) fs.mkdirSync(musicDir, { recursive: true });
  if (!fs.existsSync(LIBRARY_JSON)) fs.writeFileSync(LIBRARY_JSON, JSON.stringify({ tracks: {}, playlists: {}, favorites: [] }, null, 2));
  if (!fs.existsSync(SETTINGS_JSON)) fs.writeFileSync(SETTINGS_JSON, JSON.stringify(defaultSettings(), null, 2));
}
function readSettings() {
  try { return { ...defaultSettings(), ...JSON.parse(fs.readFileSync(SETTINGS_JSON, 'utf-8')) }; }
  catch { return defaultSettings(); }
}
function writeSettings(s) { fs.writeFileSync(SETTINGS_JSON, JSON.stringify(s, null, 2)); }
function readLibrary() {
  try {
    const lib = JSON.parse(fs.readFileSync(LIBRARY_JSON, 'utf-8'));
    if (!lib.tracks) lib.tracks = {};
    if (!lib.playlists) lib.playlists = {};
    if (!lib.favorites) lib.favorites = [];
    return lib;
  } catch { return { tracks: {}, playlists: {}, favorites: [] }; }
}
function writeLibrary(lib) {
  if (!lib.tracks) lib.tracks = {};
  if (!lib.playlists) lib.playlists = {};
  if (!lib.favorites) lib.favorites = [];
  fs.writeFileSync(LIBRARY_JSON, JSON.stringify(lib, null, 2));
}
function sanitizeName(name) {
  return String(name).replace(/[:"/\\|?*\x00-\x1F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
}
function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', chunk => hash.update(chunk));
    s.on('end', () => resolve(hash.digest('hex')));
    s.on('error', reject);
  });
}
function findFFmpeg(settings) {
  if (settings.ffmpegPath && fs.existsSync(settings.ffmpegPath)) return settings.ffmpegPath;
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  const localWin = path.join(BASE_DIR, 'ffmpeg.exe');
  const localUnix = path.join(BASE_DIR, 'ffmpeg');
  const folderWin = path.join(BASE_DIR, 'ffmpeg', 'ffmpeg.exe');
  const folderUnix = path.join(BASE_DIR, 'ffmpeg', 'ffmpeg');
  if (fs.existsSync(localWin)) return localWin;
  if (fs.existsSync(localUnix)) return localUnix;
  if (fs.existsSync(folderWin)) return folderWin;
  if (fs.existsSync(folderUnix)) return folderUnix;
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}
function findYtDlp() {
  const names = process.platform === 'win32'
    ? ['yt-dlp.exe', path.join(BASE_DIR, 'yt-dlp.exe'), path.join(BASE_DIR, 'yt-dlp', 'yt-dlp.exe')]
    : ['yt-dlp', path.join(BASE_DIR, 'yt-dlp'), path.join(BASE_DIR, 'yt-dlp', 'yt-dlp')];
  for (const p of names) { try { if (fs.existsSync(p)) return p; } catch {} }
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}
function formatMp3Filename(title, author, videoId) {
  const safeTitle = sanitizeName(title || 'Без названия');
  const safeAuthor = sanitizeName(author || 'Unknown');
  return `${safeTitle} — ${safeAuthor} [${videoId}].mp3`;
}
function convertToMp3(inputPath, outputPath, meta, settings) {
  return new Promise((resolve, reject) => {
    const ffmpeg = findFFmpeg(settings);
    const bitrateArg = `${Number.isFinite(settings.audioBitrateKbps) ? settings.audioBitrateKbps : 192}k`;
    const args = [
      '-y','-i', inputPath, '-vn',
      '-codec:a','libmp3lame','-b:a', bitrateArg, '-map','a:0'
    ];
    if (meta?.title) args.push('-metadata', `title=${meta.title}`);
    if (meta?.author) args.push('-metadata', `artist=${meta.author}`);
    args.push(outputPath);
    const proc = spawn(ffmpeg, args, { stdio: 'ignore' });
    proc.on('error', reject);
    proc.on('exit', (code) => code === 0 ? resolve(true) : reject(new Error(`ffmpeg exited ${code}`)));
  });
}
function setMp3MetadataInPlace(filePath, meta, settings) {
  return new Promise((resolve, reject) => {
    try {
      const ffmpeg = findFFmpeg(settings);
      const tmpOut = filePath + '.tmpmeta.mp3';
      const args = ['-y','-i', filePath, '-codec','copy'];
      if (meta?.title) { args.push('-metadata', `title=${meta.title}`); }
      if (meta?.author) { args.push('-metadata', `artist=${meta.author}`); }
      args.push(tmpOut);
      const proc = spawn(ffmpeg, args, { stdio: 'ignore' });
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (code === 0) {
          try { fs.renameSync(tmpOut, filePath); } catch (e) { return reject(e); }
          resolve(true);
        } else reject(new Error(`ffmpeg(meta) exited ${code}`));
      });
    } catch (e) { reject(e); }
  });
}
function unitToBytes(val, unit) {
  const n = parseFloat(val); if (!isFinite(n)) return 0;
  const u = (unit || '').toUpperCase();
  if (u.startsWith('K')) return Math.round(n * 1024);
  if (u.startsWith('M')) return Math.round(n * 1024 * 1024);
  if (u.startsWith('G')) return Math.round(n * 1024 * 1024 * 1024);
  return Math.round(n);
}
function isExtractionError(err) {
  const msg = (err && (err.message || String(err))).toLowerCase();
  return /extract|function|signature|decipher|player/i.test(msg);
}

// -------------------- Загрузчики --------------------

function sendProgress(ch) {
  sendToRenderer('download-progress', ch);
}

function downloadAudioToTemp(url, videoId) {
  return new Promise((resolve, reject) => {
    const tempFile = path.join(TEMP_DIR, `${videoId}.${Date.now()}.audio`);
    const file = fs.createWriteStream(tempFile);
    let downloaded = 0, total = 0, lastReport = Date.now(), lastDownloaded = 0, ended = false;
    const stream = ytdl(url, { filter: 'audioonly', quality: 'highestaudio', dlChunkSize: 1<<20 });
    stream.on('response', (res) => { total = parseInt(res.headers['content-length'] || '0', 10) || 0; });
    stream.on('progress', (_len, downloadedBytes, totalBytes) => {
      downloaded = downloadedBytes; total = totalBytes || total;
      const now = Date.now(), dt = (now - lastReport)/1000;
      if (dt >= 0.2) {
        const delta = downloaded - lastDownloaded, speed = delta / dt;
        const pct = total > 0 ? downloaded / total : 0;
        sendProgress({ videoId, downloaded, total, pct, speed, eta: (speed>0 && total>0) ? (total-downloaded)/speed : Infinity });
        lastReport = now; lastDownloaded = downloaded;
      }
    });
    stream.on('error', (e) => { try{file.close();}catch{} try{fs.rmSync(tempFile,{force:true});}catch{} if(!ended){ended=true; reject(e);} });
    file.on('finish', () => file.close(() => {
      if (!ended) { ended = true; sendProgress({ videoId, complete: true }); resolve(tempFile); }
    }));
    file.on('error', (e)=>{ try{file.close();}catch{} try{fs.rmSync(tempFile,{force:true});}catch{} if(!ended){ended=true; reject(e);} });
    stream.pipe(file);
  });
}
function downloadWithYtDlp(url, videoId, settings) {
  return new Promise((resolve, reject) => {
    const outTmp = path.join(TEMP_DIR, `${videoId}.${Date.now()}.mp3`);
    const ytdlp = findYtDlp();
    const args = [
      url,
      '-f','bestaudio/best',
      '-x','--audio-format','mp3',
      '--audio-quality',`${settings.audioBitrateKbps||192}K`,
      '--no-playlist',
      '--newline',
      '-o', outTmp
    ];
    let resolved = false;
    const progressHandler = (line) => {
      const m = String(line).match(/\[download\]\s+([\d.]+)%\s+of\s+([\d.]+)\s([KMG]i?B)\s+at\s+([\d.]+)\s([KMG]i?B)\/s.*?ETA\s+([0-9:]+)/i);
      if (m) {
        const pct = Math.max(0, Math.min(100, parseFloat(m[1]||'0'))) / 100;
        const total = unitToBytes(m[2], m[3]), speed = unitToBytes(m[4], m[5]);
        const parts = (m[6]||'').split(':').map(x=>parseInt(x,10)||0);
        const eta = parts.length===3?parts[0]*3600+parts[1]*60+parts[2]: parts.length===2?parts[0]*60+parts[1]:Infinity;
        sendProgress({ videoId, downloaded: total&&pct?Math.round(total*pct):undefined, total, pct, speed, eta });
      }
    };
    try {
      const proc = spawn(ytdlp, args, { stdio: ['ignore','pipe','pipe'] });
      proc.stdout.on('data', (d)=> String(d).split(/\r?\n/).forEach(progressHandler));
      proc.stderr.on('data', (d)=> String(d).split(/\r?\n/).forEach(progressHandler));
      proc.on('error', (e)=>{ if(!resolved){resolved=true; reject(e);} });
      proc.on('exit', (code)=>{ if(code===0){ if(!resolved){resolved=true; resolve(outTmp);} } else { if(!resolved){resolved=true; reject(new Error(`yt-dlp exited ${code}`));} } });
    } catch (e) { reject(e); }
  });
}
function resolveViaPiped(videoId) {
  return new Promise((resolve, reject) => {
    const req = https.request(`https://piped.video/api/v1/streams/${encodeURIComponent(videoId)}`, {
      method: 'GET', headers: { 'user-agent': 'Mozilla/5.0 (Electron Player)','accept':'application/json' }
    }, (res) => {
      const redir = res.statusCode && res.statusCode >=300 && res.headers.location;
      if (redir) {
        https.get(res.headers.location, (r2) => {
          let d=''; r2.on('data', c=>d+=c);
          r2.on('end', ()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});
        }).on('error', reject);
        return;
      }
      let data=''; res.on('data', c=>data+=c); res.on('end', ()=>{ try{ resolve(JSON.parse(data)); }catch(e){ reject(e);} });
    });
    req.on('error', reject); req.end();
  });
}
function downloadUrlToTemp(fileUrl, videoId, hintedExt) {
  const parsed = urlLib.parse(fileUrl);
  const ext = hintedExt || (parsed.pathname && parsed.pathname.includes('.') ? parsed.pathname.split('.').pop() : 'audio');
  const tempFile = path.join(TEMP_DIR, `${videoId}.${Date.now()}.${ext}`);
  return new Promise((resolve, reject) => {
    const req = https.get(fileUrl, { headers: { 'user-agent': 'Mozilla/5.0 (Electron Player)' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.headers.location) {
        downloadUrlToTemp(res.headers.location, videoId, hintedExt).then(resolve).catch(reject); return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10) || 0; let downloaded = 0; let last = 0;
      const file = fs.createWriteStream(tempFile);
      res.on('data', (chunk)=> {
        downloaded += chunk.length;
        const now = Date.now();
        if (!res._last || now - res._last > 250) {
          const pct = total>0? downloaded/total : undefined;
          const speed = (downloaded - last) / ((now - (res._last||now))/1000 || 1);
          last = downloaded; res._last = now;
          sendProgress({ videoId, downloaded, total, pct, speed });
        }
      });
      res.on('end', ()=> { sendProgress({ videoId, complete: true }); file.close(()=> resolve(tempFile)); });
      res.on('error', (e)=>{ try{file.close();}catch{} try{fs.rmSync(tempFile,{force:true});}catch{} reject(e); });
      res.pipe(file);
    });
    req.on('error', reject);
  });
}
async function downloadAudioAnyMethod({ url, videoId }, settings) {
  try {
    const tempAudio = await downloadAudioToTemp(url, videoId);
    return { tempPath: tempAudio, isAlreadyMp3: false };
  } catch (e1) {
    if (isExtractionError(e1)) {
      try {
        const mp3Path = await downloadWithYtDlp(url, videoId, settings);
        return { tempPath: mp3Path, isAlreadyMp3: true };
      } catch (e2) {
        try {
          const vId = videoId || (ytdl.validateURL(url) ? await ytdl.getURLVideoID(url) : null) || ((url.match(/[?&]v=([^&]+)/)||[])[1]||'').trim();
          if (!vId) throw e2;
          const data = await resolveViaPiped(vId);
          const audio = (data?.audioStreams||[]).sort((a,b)=>(b.bitrate||0)-(a.bitrate||0))[0];
          if (!audio?.url) throw new Error('Piped: audio stream not found');
          const hintedExt = /audio\/mp4/i.test(audio.mimeType||'') ? 'm4a' : /webm/i.test(audio.mimeType||'') ? 'webm' : 'audio';
          const tempAudio = await downloadUrlToTemp(audio.url, vId, hintedExt);
          return { tempPath: tempAudio, isAlreadyMp3: false };
        } catch (e3) {
          throw e1;
        }
      }
    } else { throw e1; }
  }
}
async function getVideoDurationSafe(url) {
  try { const info = await ytdl.getBasicInfo(url); const len = parseInt(info?.videoDetails?.lengthSeconds||'0',10); return Number.isFinite(len)?len:0; }
  catch { return 0; }
}
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
    promise.then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } }).catch(() => { if (!done) { done = true; clearTimeout(t); resolve(null); }});
  });
}
async function getOrCreateFromCache(payload, settings) {
  ensureDirs(settings.musicDir);
  const lib = readLibrary();
  const { url, videoId } = payload;
  const cached = lib.tracks[videoId];
  if (cached && cached.filePath && fs.existsSync(cached.filePath)) {
    return { success: true, fromCache: true, filePath: cached.filePath, hash: cached.hash };
  }

  // Сообщаем UI о старте загрузки (для прогресс-элемента в медиатеке)
  sendToRenderer('download-started', { videoId, title: payload.title, author: payload.author, url });

  // ИИ-метаданные — параллельно (учитываем переключатель ИИ)
  const aiPromise = settings.aiEnabled ? openRouterParseMeta({
    title: payload.title || 'Без названия',
    author: payload.author || 'Unknown',
    url,
    videoId
  }, settings) : Promise.resolve(null);

  let tempPath;
  try {
    const dl = await downloadAudioAnyMethod({ url, videoId }, settings);
    tempPath = dl.tempPath;

    const aiMeta = await withTimeout(aiPromise, 8500);
    const metaFinal = {
      title: (aiMeta?.title || payload.title || 'Без названия'),
      author: (aiMeta?.author || payload.author || 'Unknown')
    };

    const duration = Number.isFinite(payload.duration) && payload.duration > 0 ? payload.duration : await getVideoDurationSafe(url);

    // Сборка MP3
    const outTmp = path.join(settings.musicDir, `${videoId}.${Date.now()}.work.mp3`);
    if (dl.isAlreadyMp3) fs.copyFileSync(tempPath, outTmp);
    else await convertToMp3(tempPath, outTmp, metaFinal, settings);

    const outName = formatMp3Filename(metaFinal.title, metaFinal.author, videoId);
    const outPath = path.join(settings.musicDir, outName);

    try { await setMp3MetadataInPlace(outTmp, metaFinal, settings); } catch {}

    fs.renameSync(outTmp, outPath);

    const hash = await computeFileHash(outPath);
    lib.tracks[videoId] = {
      videoId,
      title: metaFinal.title,
      author: metaFinal.author,
      duration: Number.isFinite(duration)?duration:0,
      filePath: outPath, url, hash, addedAt: Date.now()
    };
    writeLibrary(lib);
    try { fs.rmSync(tempPath, { force: true }); } catch {}

    // Сообщаем UI о завершении (убрать прогресс и обновить библиотеку)
    sendToRenderer('download-complete', { videoId });

    return { success: true, fromCache: false, filePath: outPath, hash };
  } catch (e) {
    if (tempPath) { try { fs.rmSync(tempPath, { force: true }); } catch {} }
    sendToRenderer('download-error', { videoId, error: e?.message || String(e) });
    return { success: false, error: e?.message || String(e) };
  }
}

// -------------------- Stream URL (для потокового проигрывания) --------------------
ipcMain.handle('get-stream-url', async (_e, payload) => {
  try {
    const { url, videoId } = payload || {};
    const id = videoId || (ytdl.validateURL(url) ? await ytdl.getURLVideoID(url) : null) || ((url||'').match(/[?&]v=([^&]+)/)||[])[1];
    if (!id) throw new Error('videoId not resolvable');
    try {
      const info = await ytdl.getInfo(id);
      const fmt = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
      if (fmt?.url) {
        const dur = parseInt(info.videoDetails?.lengthSeconds||'0', 10) || 0;
        return { ok: true, src: fmt.url, mime: fmt.mimeType || 'audio/mp4', duration: dur };
      }
    } catch (e) {
      // запасной вариант через Piped
      const data = await resolveViaPiped(id);
      const audio = (data?.audioStreams||[]).sort((a,b)=>(b.bitrate||0)-(a.bitrate||0))[0];
      if (audio?.url) {
        return { ok: true, src: audio.url, mime: audio.mimeType || 'audio/webm', duration: parseInt(data.duration||'0',10) || 0 };
      }
      throw e;
    }
    return { ok: false, error: 'Не удалось получить stream URL' };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// -------------------- Discord RPC --------------------
let rpc, rpcReady = false;
async function setupDiscordRPC() {
  if (!DISCORD.enabled || !DISCORD.clientId) { try { rpc?.destroy?.(); } catch {}; rpc=undefined; rpcReady=false; return; }
  try {
    RPC.register(DISCORD.clientId);
    rpc = new RPC.Client({ transport: 'ipc' });
    rpc.on('ready', () => { rpcReady = true; if (DISCORD.debug) console.log('[RPC] ready'); });
    rpc.on('disconnected', () => { rpcReady = false; if (DISCORD.debug) console.log('[RPC] disconnected'); });
    await rpc.login({ clientId: DISCORD.clientId });
  } catch (e) { console.warn('Discord RPC: не удалось подключиться:', e.message||e); rpcReady = false; }
}
function updatePresence({ title, author, url, duration, currentTime, playing = true }) {
  if (!DISCORD.enabled || !rpcReady || !rpc) return;
  const now = Date.now();
  const dur = Number.isFinite(duration) ? duration : 0;
  const cur = Number.isFinite(currentTime) ? currentTime : 0;
  const start = Math.floor((now - cur * 1000) / 1000);
  const end = dur ? Math.floor((now + (dur - cur) * 1000) / 1000) : undefined;
  const activity = {
    details: playing ? 'Слушает' : 'Пауза',
    state: `${title || 'Без названия'} — ${author || 'Unknown'}`,
    largeImageKey: (DISCORD.largeImageKey || undefined),
    largeImageText: 'YouTube Music Player'
  };
  if (url) activity.buttons = [{ label: (title || 'Трек'), url }];
  if (playing) {
    if (DISCORD.smallImagePlay) { activity.smallImageKey = DISCORD.smallImagePlay; activity.smallImageText = 'Playing'; }
    if (dur) { activity.startTimestamp = start; activity.endTimestamp = end; } else { activity.startTimestamp = start; }
  } else {
    if (DISCORD.smallImagePause) { activity.smallImageKey = DISCORD.smallImagePause; activity.smallImageText = 'Paused'; }
  }
  rpc.setActivity(activity).catch(() => {});
}

// -------------------- IPC --------------------
ipcMain.handle('download-video', async (_e, payload) => {
  const settings = readSettings();
  try { const result = await getOrCreateFromCache(payload, settings); return result; }
  catch (error) { return { success: false, error: error.message || String(error) }; }
});
ipcMain.handle('get-music-library', async () => {
  const settings = readSettings();
  ensureDirs(settings.musicDir);
  const lib = readLibrary();
  const list = Object.values(lib.tracks).filter(t => t && t.filePath && fs.existsSync(t.filePath)).sort((a,b)=>(b.addedAt||0)-(a.addedAt||0));
  return list;
});
ipcMain.handle('update-track', async (_e, track) => {
  updatePresence({
    title: track.title, author: track.author, url: track.url,
    duration: track.duration, currentTime: track.currentTime, playing: true
  });
  return true;
});
ipcMain.handle('clear-presence', async () => {
  if (DISCORD.enabled && rpcReady) {
    rpc.clearActivity().catch(() => {});
  }
  return true;
});
ipcMain.handle('open-external', async (_e, url) => { if (url) await shell.openExternal(url); return true; });
ipcMain.on('window-control', (_e, cmd) => {
  if (!mainWindow) return;
  if (cmd === 'close') mainWindow.close();
  else if (cmd === 'minimize') mainWindow.minimize();
  else if (cmd === 'maximize') mainWindow.isMaximized()? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.handle('ffmpeg-check', async () => {
  const settings = readSettings();
  const p = findFFmpeg(settings);
  return { path: p };
});
ipcMain.handle('get-settings', async () => {
  const s = readSettings();
  const ff = findFFmpeg(s);
  return { settings: s, ffmpegPath: ff };
});
ipcMain.handle('save-settings', async (_e, next) => {
  const prev = readSettings();
  const merged = { ...prev, ...next };
  writeSettings(merged);
  if (mainWindow && typeof merged.opacity === 'number') {
    mainWindow.setOpacity(Math.min(1, Math.max(0.6, merged.opacity)));
  }
  return { ok: true, settings: merged };
});
ipcMain.handle('set-opacity', async (_e, value) => {
  if (mainWindow) mainWindow.setOpacity(Math.min(1, Math.max(0.6, value)));
  const s = readSettings(); s.opacity = Math.min(1, Math.max(0.6, value)); writeSettings(s); return true;
});
ipcMain.handle('set-volume', async (_e, value) => { const s = readSettings(); s.volume = Math.min(1, Math.max(0, value)); writeSettings(s); return true; });
ipcMain.handle('open-music-dir', async () => { const s = readSettings(); if (s.musicDir) await shell.openPath(s.musicDir); return true; });

// ИИ: чтение/сохранение/статус
ipcMain.handle('ai-get', async () => {
  const s = readSettings();
  const hasKey = !!getOpenRouterKey();
  return { enabled: !!s.aiEnabled, hasKey };
});
ipcMain.handle('ai-save', async (_e, keyText) => {
  try {
    const val = String(keyText || '').trim();
    if (val) {
      fs.writeFileSync(OPENROUTER_KEY_PATH, val, 'utf-8');
    } else {
      try { fs.rmSync(OPENROUTER_KEY_PATH); } catch {}
    }
    return { ok: true, hasKey: !!getOpenRouterKey() };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// Тема: get/save/reset
ipcMain.handle('theme-get', async () => {
  const s = readSettings();
  return { vars: s.theme?.vars || {}, elements: s.theme?.elements || {} };
});
ipcMain.handle('theme-save', async (_e, payload) => {
  const s = readSettings();
  s.theme = {
    vars: payload?.vars || {},
    elements: payload?.elements || {}
  };
  writeSettings(s);
  // Сообщим фронту применить (на всякий случай)
  sendToRenderer('theme-updated', s.theme);
  return { ok: true };
});
ipcMain.handle('theme-reset', async () => {
  const s = readSettings();
  s.theme = { vars: {}, elements: {} };
  writeSettings(s);
  sendToRenderer('theme-updated', s.theme);
  return { ok: true };
});

// Playlists/Favorites/Search
ipcMain.handle('playlists-get', async () => manager.listPlaylists());
ipcMain.handle('playlist-create', async (_e, name) => manager.createPlaylist(name));
ipcMain.handle('playlist-rename', async (_e, id, name) => manager.renamePlaylist(id, name));
ipcMain.handle('playlist-delete', async (_e, id) => manager.deletePlaylist(id));
ipcMain.handle('playlist-add', async (_e, id, videoId) => manager.addTrackToPlaylist(id, videoId));
ipcMain.handle('playlist-remove', async (_e, id, videoId) => manager.removeTrackFromPlaylist(id, videoId));
ipcMain.handle('playlist-tracks', async (_e, id) => manager.getPlaylistTracks(id));
ipcMain.handle('favorites-toggle', async (_e, videoId) => manager.toggleFavorite(videoId));
ipcMain.handle('favorites-list', async () => manager.listFavorites());
ipcMain.handle('search-library', async (_e, query) => {
  const lib = readLibrary();
  return manager.searchLibrary(lib, query || '');
});
ipcMain.handle('library-remove-track', async (_e, videoId, removeFile) => {
  const removed = manager.removeTrack(videoId, { removeFile: !!removeFile });
  if (removed && removeFile && removed.filePath && fs.existsSync(removed.filePath)) {
    try {
      if (shell.trashItem) await shell.trashItem(removed.filePath);
      else fs.rmSync(removed.filePath, { force: true });
    } catch {}
  }
  return true;
});
ipcMain.handle('save-playback', async (_e, payload) => {
  const s = readSettings();
  s.lastPlayback = { videoId: payload.videoId, position: Math.max(0, Math.floor(payload.position || 0)), updatedAt: Date.now() };
  writeSettings(s); return true;
});

// Обновление метаданных трека (редактирование inline)
ipcMain.handle('update-track-meta', async (_e, payload) => {
  const { videoId, title, author } = payload || {};
  if (!videoId) return { ok: false, error: 'videoId required' };
  const settings = readSettings();
  const lib = readLibrary();
  const t = lib.tracks[videoId];
  if (!t || !t.filePath || !fs.existsSync(t.filePath)) return { ok: false, error: 'Трек не найден' };

  const nextTitle = sanitizeName(title || t.title || 'Без названия');
  const nextAuthor = sanitizeName(author || t.author || 'Unknown');
  const nextName = formatMp3Filename(nextTitle, nextAuthor, videoId);
  const nextPath = path.join(settings.musicDir, nextName);

  try { await setMp3MetadataInPlace(t.filePath, { title: nextTitle, author: nextAuthor }, settings); } catch {}
  try { fs.renameSync(t.filePath, nextPath); } catch (e) { return { ok: false, error: 'Переименование не удалось: ' + (e.message||e) }; }

  t.title = nextTitle; t.author = nextAuthor; t.filePath = nextPath;
  writeLibrary(lib);
  return { ok: true, track: t };
});

// -------------------- Окно --------------------
function createWindow() {
  const settings = readSettings();
  ensureDirs(settings.musicDir);
  const icon = fs.existsSync(ICON_PATH) ? nativeImage.createFromPath(ICON_PATH) : undefined;

  mainWindow = new BrowserWindow({
    width: 1280, height: 860,
    backgroundColor: '#000000',
    autoHideMenuBar: true, frame: false, icon,
    opacity: Math.min(1, Math.max(0.6, settings.opacity)),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webviewTag: true,
      devTools: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  const s = readSettings(); ensureDirs(s.musicDir);
  await setupDiscordRPC();
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });

module.exports = {};
