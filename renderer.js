const { ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

// DOM
const webview = document.getElementById('webview');
const statusEl = document.getElementById('status');
const libraryList = document.getElementById('library-list');
const refreshBtn = document.getElementById('refresh-lib');
const openFolderBtn = document.getElementById('open-folder');
const searchInput = document.getElementById('search');

const audio = document.getElementById('audio');
const playBtn = document.getElementById('play');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const progress = document.getElementById('progress');
const bar = document.getElementById('bar');
const timeEl = document.getElementById('time');
const vol = document.getElementById('vol');
const volval = document.getElementById('volval');
const linkBtn = document.getElementById('yt-link');
const playerEl = document.querySelector('footer.player');

const winClose = document.getElementById('win-close');
const winMin = document.getElementById('win-min');
const winMax = document.getElementById('win-max');

const navBack = document.getElementById('nav-back');
const navFwd = document.getElementById('nav-fwd');
const navHome = document.getElementById('nav-home');
const navReload = document.getElementById('nav-reload');

const settingsDrawer = document.getElementById('settings');
const btnSettings = document.getElementById('btn-settings');
const closeSettings = document.getElementById('close-settings');

const setOpacity = document.getElementById('opacity');
const setBitrate = document.getElementById('bitrate');
const setVolSettings = document.getElementById('vol-settings');
const animToggle = document.getElementById('anim-toggle');

// AI settings
const aiToggle = document.getElementById('ai-toggle');
const aiKeyInput = document.getElementById('ai-key');
const aiSaveBtn = document.getElementById('ai-save');
const aiTestBtn = document.getElementById('ai-test');

const stFFmpeg = document.getElementById('st-ffmpeg');
const stMusicDir = document.getElementById('st-musicdir');
const stAI = document.getElementById('st-ai');

/* Tabs */
const tabBtns = Array.from(document.querySelectorAll('.tab-btn'));
const views = {
  'tab-library': document.getElementById('tab-library'),
  'tab-playlists': document.getElementById('tab-playlists'),
  'tab-queue': document.getElementById('tab-queue'),
  'tab-fav': document.getElementById('tab-fav')
};

const plCreateBtn = document.getElementById('pl-create');
const playlistList = document.getElementById('playlist-list');
const playlistTracks = document.getElementById('playlist-tracks');
const queueClearBtn = document.getElementById('queue-clear');
const queuePlayBtn = document.getElementById('queue-play');
const queueList = document.getElementById('queue-list');
const favList = document.getElementById('fav-list');

let playlist = [];
let queue = [];
let currentIndex = -1;
let currentTrack = null;
let settingsCache = null;
let lastAddedVideoId = null;
let selectedIndex = -1;
let activePlaylistId = null;

// загрузки
const pendingDownloads = new Map(); // videoId -> { title, author, url, pct, downloaded, total }
const inflight = new Map(); // videoId -> Promise

let favSet = new Set();

function bytesToMB(b) { return (b / (1024 * 1024)).toFixed(2); }
function bytesPerSecToMBps(bps) { return (bps / (1024 * 1024)).toFixed(2); }
function etaFmt(sec) {
  if (!Number.isFinite(sec)) return '—';
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2,'0')}`;
}
function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}
function showStatus(text, timeout = 1800) {
  statusEl.textContent = text;
  statusEl.classList.add('show');
  setTimeout(() => statusEl.classList.remove('show'), timeout);
}
function setRangeGradient(inputEl) {
  const min = Number(inputEl.min || 0);
  const max = Number(inputEl.max || 100);
  const val = Number(inputEl.value || 0);
  const pct = ((val - min) / (max - min)) * 100;
  inputEl.style.setProperty('--track-fill', `${pct}%`);
}

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.getAttribute('data-tab');
    if (views[id]?.classList.contains('active')) return;
    tabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    Object.entries(views).forEach(([vid, el]) => {
      if (vid === id) el.classList.add('active'); else el.classList.remove('active');
    });
    if (id === 'tab-playlists') refreshPlaylists().catch(console.error);
    if (id === 'tab-fav') refreshFavorites().catch(console.error);
    if (id === 'tab-queue') renderQueue();
  });
});

async function loadLibrary() {
  const list = await ipcRenderer.invoke('get-music-library');
  playlist = list;
  const favs = await ipcRenderer.invoke('favorites-list');
  favSet = new Set((favs || []).map(t => t.videoId));
  renderLibrary();
}

function makeFileUrl(fp) {
  try { return pathToFileURL(fp).toString(); } catch { return ''; }
}

function markToggleBtn(btn, active) {
  if (!btn) return;
  btn.classList.toggle('active', !!active);
  btn.classList.toggle('filled', !!active);
}

// Inline редактор для трека
function openInlineEditor(item, t, idx) {
  const existing = item.querySelector('.edit-wrap');
  if (existing) return;

  const editor = document.createElement('div');
  editor.className = 'edit-wrap';
  editor.innerHTML = `
    <div class="grid2">
      <input type="text" class="textlike edit-title" placeholder="Название" />
      <input type="text" class="textlike edit-author" placeholder="Автор" />
    </div>
    <div class="item-actions" style="margin-top:8px;">
      <button class="btn edit-save"><i class="fa-solid fa-floppy-disk"></i> Сохранить</button>
      <button class="btn edit-cancel"><i class="fa-solid fa-xmark"></i> Отмена</button>
    </div>
  `;

  const mainLine = item.querySelector('.main-line');
  if (mainLine) mainLine.insertAdjacentElement('afterend', editor);
  else item.appendChild(editor);

  const titleInput = editor.querySelector('.edit-title');
  const authorInput = editor.querySelector('.edit-author');
  titleInput.value = t.title;
  authorInput.value = t.author;

  const save = async () => {
    const newTitle = titleInput.value.trim() || t.title;
    const newAuthor = authorInput.value.trim() || t.author;
    const res = await ipcRenderer.invoke('update-track-meta', { videoId: t.videoId, title: newTitle, author: newAuthor });
    if (res?.ok) {
      playlist[idx] = res.track;
      renderLibrary();
      if (currentTrack?.videoId === res.track.videoId) {
        currentTrack = res.track;
        updateMetaUI();
      }
      showStatus('Сохранено');
    } else {
      showStatus('Ошибка: ' + (res?.error || 'неизвестно'));
    }
  };
  const cancel = () => editor.remove();

  editor.querySelector('.edit-save').addEventListener('click', save);
  editor.querySelector('.edit-cancel').addEventListener('click', cancel);

  const keyHandler = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };
  titleInput.addEventListener('keydown', keyHandler);
  authorInput.addEventListener('keydown', keyHandler);
  titleInput.focus();
}

function renderDownloadingItem(rec) {
  const pct = Math.max(0, Math.min(1, rec.pct || 0));
  const item = document.createElement('div');
  item.className = 'track-item downloading shader-animate';
  item.innerHTML = `
    <div class="main-line">
      <div class="track-title">${rec.title} — ${rec.author}</div>
      <div class="track-sub">Загрузка... ${(pct*100).toFixed(1)}%${(rec.total? ` • ${bytesToMB(rec.downloaded||0)} / ${bytesToMB(rec.total)} MB` : '')}</div>
    </div>
    <div class="progress-mini"><div class="bar-mini" style="width:${(pct*100).toFixed(1)}%"></div></div>
    <div class="actions-wrap">
      <div class="item-actions">
        <button class="btn round stream"><i class="fa-solid fa-play"></i></button>
      </div>
    </div>
  `;
  // expand on click
  item.addEventListener('click', (e) => {
    if (e.target.closest('.btn')) return;
    item.classList.toggle('expanded');
  });
  // stream play while downloading
  item.querySelector('.stream').addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const r = await ipcRenderer.invoke('get-stream-url', { url: rec.url, videoId: rec.videoId });
      if (r?.ok && r.src) {
        currentTrack = {
          videoId: rec.videoId,
          title: rec.title || 'Без названия',
          author: rec.author || 'Unknown',
          url: rec.url,
          duration: r.duration || 0,
          filePath: '' // пока поток
        };
        updateMetaUI();
        audio.src = r.src;
        audio.currentTime = 0;
        await audio.play();
        setPlayIcon(true);
        playerBeatActive(true);
        await ipcRenderer.invoke('update-track', {
          title: currentTrack.title, author: currentTrack.author, url: currentTrack.url,
          duration: currentTrack.duration, currentTime: 0
        });
      } else {
        showStatus('Не удалось получить потоковый URL');
      }
    } catch (err) {
      showStatus('Ошибка потока: ' + (err.message || err));
    }
  });
  return item;
}

function renderTrackItem(t, idx) {
  const hashShort = (t.hash || '').slice(0, 12);
  const item = document.createElement('div');
  item.className = 'track-item shader-animate';
  if (idx === currentIndex) item.classList.add('selected');
  if (t.videoId === lastAddedVideoId) item.classList.add('new');

  item.innerHTML = `
    <div class="main-line">
      <div class="track-title" title="Двойной клик — редактировать">${t.title}</div>
      <div class="track-sub">${t.author} • ${fmtTime(t.duration)} • ${hashShort}</div>
    </div>
    <div class="actions-wrap">
      <div class="item-actions">
        <button class="btn round play toggleable" data-tip="Играть"><i class="fa-solid fa-play"></i></button>
        <button class="btn round addq toggleable" data-tip="В очередь"><i class="fa-solid fa-plus"></i></button>
        <button class="btn round addpl toggleable" data-tip="В плейлист"><i class="fa-solid fa-list"></i></button>
        <button class="btn round del toggleable" data-tip="Удалить"><i class="fa-solid fa-trash"></i></button>
        <span class="spacer"></span>
        <button class="btn round fav toggleable" data-tip="Избранное"><i class="fa-solid fa-heart"></i></button>
      </div>
    </div>
  `;

  // избранное
  markToggleBtn(item.querySelector('.fav'), favSet.has(t.videoId));

  // inline-редактор по double click
  item.querySelector('.track-title').addEventListener('dblclick', async (e) => {
    e.stopPropagation();
    openInlineEditor(item, t, idx);
  });

  // Экспандер
  item.addEventListener('click', (e) => {
    if (e.target.closest('.btn')) return;
    const expanded = item.classList.toggle('expanded');
    if (expanded) {
      selectedIndex = idx;
      document.querySelectorAll('.track-item').forEach((el, i) => el.classList.toggle('selected', i === idx));
    }
  });

  item.querySelector('.play').addEventListener('click', async (e) => {
    e.stopPropagation();
    // если повторно жмём по текущему — toggle плей/пауза
    if (idx === currentIndex && currentTrack && currentTrack.videoId === playlist[idx].videoId) {
      if (audio.paused) { await audio.play(); setPlayIcon(true); playerBeatActive(true); }
      else { audio.pause(); setPlayIcon(false); playerBeatActive(false); await ipcRenderer.invoke('clear-presence'); }
      return;
    }
    selectedIndex = idx; playFromIndex(idx);
    document.querySelectorAll('.track-item').forEach((el, i) => el.classList.toggle('selected', i === idx));
  });
  item.querySelector('.addq').addEventListener('click', (e) => {
    e.stopPropagation(); queue.push(t); showStatus('Добавлено в очередь'); renderQueue();
    markToggleBtn(item.querySelector('.addq'), true); setTimeout(()=>markToggleBtn(item.querySelector('.addq'), false), 800);
  });
  item.querySelector('.fav').addEventListener('click', async (e) => {
    e.stopPropagation();
    await ipcRenderer.invoke('favorites-toggle', t.videoId);
    if (favSet.has(t.videoId)) favSet.delete(t.videoId); else favSet.add(t.videoId);
    markToggleBtn(item.querySelector('.fav'), favSet.has(t.videoId));
    showStatus('Избранное: ' + (favSet.has(t.videoId) ? 'добавлен' : 'убран'));
    if (views['tab-fav'].classList.contains('active')) refreshFavorites();
  });
  // Popover выбора плейлиста
  item.querySelector('.addpl').addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    const pls = await ipcRenderer.invoke('playlists-get');
    if (!pls.length) {
      if (confirm('Плейлистов нет. Создать новый?')) {
        const n = prompt('Название нового плейлиста:');
        if (n) await ipcRenderer.invoke('playlist-create', n);
      }
      return;
    }
    showPlaylistPopover(btn, pls, async (plId) => {
      await ipcRenderer.invoke('playlist-add', plId, t.videoId);
      markToggleBtn(item.querySelector('.addpl'), true);
      setTimeout(()=>markToggleBtn(item.querySelector('.addpl'), false), 900);
      showStatus('Добавлено в плейлист');
      if (views['tab-playlists'].classList.contains('active') && activePlaylistId) refreshPlaylistTracks(activePlaylistId);
    });
  });
  item.querySelector('.del').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Удалить трек из библиотеки и файл?')) return;
    dustExplode(item);
    try {
      await ipcRenderer.invoke('library-remove-track', t.videoId, true);
      await loadLibrary(); renderQueue(); refreshFavorites();
      if (activePlaylistId) refreshPlaylistTracks(activePlaylistId);
      showStatus('Удалено');
    } catch (err) { showStatus('Ошибка удаления: ' + (err.message || err)); }
  });

  return item;
}

function showPlaylistPopover(anchorBtn, playlists, onPick) {
  const rect = anchorBtn.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'pl-pop';
  pop.style.top = `${rect.bottom + 6}px`;
  pop.style.left = `${Math.max(10, rect.left - 6)}px`;
  pop.innerHTML = `
    <div class="pl-pop-head">Добавить в плейлист</div>
    <div class="pl-pop-body"></div>
  `;
  const body = pop.querySelector('.pl-pop-body');
  playlists.forEach(pl => {
    const it = document.createElement('div');
    it.className = 'pl-pop-item';
    it.textContent = `${pl.name} (${(pl.trackIds || []).length})`;
    it.addEventListener('click', () => {
      onPick(pl.id);
      document.body.removeChild(pop);
      window.removeEventListener('click', outside);
    });
    body.appendChild(it);
  });
  document.body.appendChild(pop);
  const outside = (ev) => {
    if (!pop.contains(ev.target)) {
      try { document.body.removeChild(pop); } catch {}
      window.removeEventListener('click', outside);
    }
  };
  setTimeout(()=> window.addEventListener('click', outside), 0);
}

function renderLibrary() {
  libraryList.innerHTML = '';

  // Активные загрузки (сверху)
  if (pendingDownloads.size) {
    const head = document.createElement('div'); head.className = 'pill'; head.textContent = `Загрузки (${pendingDownloads.size})`;
    libraryList.appendChild(head);
    [...pendingDownloads.values()].forEach(rec => {
      const item = renderDownloadingItem(rec);
      libraryList.appendChild(item);
    });
    const div = document.createElement('div'); div.className = 'divider'; libraryList.appendChild(div);
  }

  if (!playlist.length) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = 'Медиатека пуста. Откройте YouTube и кликните по видео — аудио загрузится и появится здесь.';
    libraryList.appendChild(div);
    return;
  }

  playlist.forEach((t, idx) => {
    const item = renderTrackItem(t, idx);
    if (idx === currentIndex) item.classList.add('shader-animate-strong');
    libraryList.appendChild(item);
  });
}

function dustExplode(container) {
  const d = document.createElement('div'); d.className = 'dust';
  const rect = container.getBoundingClientRect();
  for (let i = 0; i < 14; i++) {
    const s = document.createElement('span');
    const dx = (Math.random() * rect.width - rect.width / 2) + 'px';
    const dy = (-Math.random() * 60 - 20) + 'px';
    s.style.setProperty('--dx', dx);
    s.style.setProperty('--dy', dy);
    s.style.left = (rect.width / 2) + 'px';
    s.style.top = (rect.height / 2) + 'px';
    d.appendChild(s);
  }
  container.appendChild(d);
  setTimeout(() => d.remove(), 700);
}

function updateMetaUI() {
  if (!currentTrack) { linkBtn.textContent = 'Не воспроизводится'; linkBtn.onclick = null; return; }
  linkBtn.textContent = `${currentTrack.title} — ${currentTrack.author}`;
  linkBtn.title = currentTrack.url || '';
  linkBtn.onclick = () => { if (currentTrack.url) ipcRenderer.invoke('open-external', currentTrack.url); };
}
function setPlayIcon(isPlaying) {
  playBtn.setAttribute('data-state', isPlaying ? 'playing' : 'paused');
  const icon = playBtn.querySelector('i');
  if (icon) icon.className = isPlaying ? 'fa-solid fa-pause' : 'fa-solid fa-play';
  markToggleBtn(playBtn, isPlaying);
  progress.classList.toggle('playing', !!isPlaying);
}

async function playFromIndex(idx) {
  if (idx < 0 || idx >= playlist.length) return;
  // если клик по текущему — toggle
  if (idx === currentIndex && currentTrack && currentTrack.videoId === playlist[idx].videoId) {
    if (audio.paused) { await audio.play(); setPlayIcon(true); playerBeatActive(true); }
    else { audio.pause(); setPlayIcon(false); playerBeatActive(false); await ipcRenderer.invoke('clear-presence'); }
    return;
  }
  currentIndex = idx;
  const t = playlist[idx];
  currentTrack = t;
  updateMetaUI();
  audio.src = makeFileUrl(t.filePath);
  audio.currentTime = 0;
  try {
    await audio.play();
    setPlayIcon(true);
    playerBeatActive(true);
    await ipcRenderer.invoke('update-track', {
      title: t.title, author: t.author, url: t.url, videoId: t.videoId,
      duration: t.duration || (isFinite(audio.duration) ? Math.floor(audio.duration) : 0),
      currentTime: Math.floor(audio.currentTime)
    });
  } catch (e) {
    setPlayIcon(false);
    playerBeatActive(false);
    showStatus('Не удалось воспроизвести: ' + (e.message || e));
  }
}

function playNext() {
  if (queue.length > 0) {
    const t = queue.shift();
    currentTrack = t;
    audio.src = makeFileUrl(t.filePath);
    audio.currentTime = 0;
    audio.play().then(() => {
      setPlayIcon(true);
      playerBeatActive(true);
      updateMetaUI();
      renderQueue();
      ipcRenderer.invoke('update-track', {
        title: t.title, author: t.author, url: t.url,
        duration: t.duration || Math.floor(audio.duration || 0),
        currentTime: Math.floor(audio.currentTime || 0)
      });
    }).catch(err => showStatus('Ошибка: ' + (err.message || err)));
    return;
  }
  if (!playlist.length) return;
  const idx = currentIndex >= 0 ? (currentIndex + 1) % playlist.length : 0;
  playFromIndex(idx);
}
function playPrev() {
  if (!playlist.length) return;
  const idx = currentIndex > 0 ? (currentIndex - 1) : (playlist.length - 1);
  playFromIndex(idx);
}

function renderQueue() {
  queueList.innerHTML = '';
  if (!queue.length) {
    const div = document.createElement('div'); div.className = 'empty'; div.textContent = 'Очередь пуста';
    queueList.appendChild(div); return;
  }
  queue.forEach((t, i) => {
    const item = document.createElement('div');
    item.className = 'queue-item';
    item.innerHTML = `
      <div>
        <div class="track-title">${t.title}</div>
        <div class="track-sub">${t.author} • ${fmtTime(t.duration)} • ${(t.hash||'').slice(0,12)}</div>
      </div>
      <div class="item-actions">
        <button class="btn round rm" data-tip="Убрать"><i class="fa-solid fa-xmark"></i></button>
      </div>
    `;
    item.querySelector('.rm').addEventListener('click', () => { queue.splice(i, 1); renderQueue(); });
    queueList.appendChild(item);
  });
}

/* Player controls */
playBtn.addEventListener('click', async () => {
  if (!audio.src) { if (playlist.length) playFromIndex(0); return; }
  if (audio.paused) {
    await audio.play(); setPlayIcon(true); playerBeatActive(true);
    if (currentTrack) {
      ipcRenderer.invoke('update-track', {
        ...currentTrack,
        duration: currentTrack.duration || Math.floor(audio.duration || 0),
        currentTime: Math.floor(audio.currentTime || 0)
      });
    }
  } else {
    audio.pause(); setPlayIcon(false); playerBeatActive(false); ipcRenderer.invoke('clear-presence');
  }
});
nextBtn.addEventListener('click', playNext);
prevBtn.addEventListener('click', playPrev);

// Исправление: пробел не мешает вводу в инпутах
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
    const editable = e.target && (e.target.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(tag));
    if (editable) return; // позволяем ввод пробела
    e.preventDefault();
    playBtn.click();
  }
});

audio.addEventListener('timeupdate', () => {
  const dur = isFinite(audio.duration) ? audio.duration : (currentTrack?.duration || 0);
  const cur = audio.currentTime || 0;
  const pct = dur ? (cur / dur) * 100 : 0;
  bar.style.width = pct + '%';
  timeEl.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
  const now = Date.now();
  if (!audio._lastRpc || now - audio._lastRpc > 5000) {
    audio._lastRpc = now;
    if (!audio.paused && currentTrack) {
      ipcRenderer.invoke('update-track', {
        ...currentTrack,
        duration: Math.floor(dur || currentTrack.duration || 0),
        currentTime: Math.floor(cur || 0)
      });
    }
  }
  if (!audio._lastSave || now - audio._lastSave > 2000) {
    audio._lastSave = now;
    if (currentTrack && currentTrack.videoId) ipcRenderer.invoke('save-playback', { videoId: currentTrack.videoId, position: cur });
  }
});
audio.addEventListener('ended', () => { playerBeatActive(false); playNext(); });

progress.addEventListener('click', (e) => {
  const rect = progress.getBoundingClientRect();
  const pos = (e.clientX - rect.left) / rect.width;
  const dur = audio.duration || currentTrack?.duration || 0;
  if (dur) audio.currentTime = pos * dur;
});

/* Volume */
vol.addEventListener('input', async () => {
  const v = vol.value / 100;
  audio.volume = v;
  volval.textContent = vol.value + '%';
  setRangeGradient(vol);
  await ipcRenderer.invoke('set-volume', v);
});

/* WebView: скрываем видео и стопаем воспроизведение на YouTube */
function attachWebviewGuards() {
  webview.insertCSS(`video { display: none !important; }`);
  webview.executeJavaScript(`
    setInterval(() => {
      const vids = document.querySelectorAll('video');
      vids.forEach(v => { if (!v.paused) { v.pause(); v.currentTime = 0; } });
    }, 200);
  `);
  showStatus('YouTube готов');
  updateNavState();
}
webview.addEventListener('dom-ready', attachWebviewGuards);

function updateNavState() {
  try {
    navBack.disabled = !webview.canGoBack();
    navFwd.disabled = !webview.canGoForward();
  } catch {}
}
navBack.addEventListener('click', () => { try { if (webview.canGoBack()) webview.goBack(); } catch {} });
navFwd.addEventListener('click', () => { try { if (webview.canGoForward()) webview.goForward(); } catch {} });
navHome.addEventListener('click', () => { try { webview.loadURL('https://www.youtube.com'); } catch {} });
navReload.addEventListener('click', () => { try { webview.reload(); } catch {} });

// несколько параллельных загрузок, без блокировок и оверлеев
async function handleYouTubeNavigate(url) {
  updateNavState();
  const isWatch = /https?:\/\/(www\.)?youtube\.com\/watch\?/.test(url);
  if (!isWatch) return;

  try {
    const info = await webview.executeJavaScript(`
      (function() {
        const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1 yt-formatted-string');
        const authorEl = document.querySelector('ytd-channel-name a, #channel-name a');
        const title = titleEl ? titleEl.textContent.trim() : 'Без названия';
        const author = authorEl ? authorEl.textContent.trim() : 'Unknown';
        let duration = 0;
        const timeEl = document.querySelector('.ytp-time-duration');
        if (timeEl) {
          const parts = timeEl.textContent.split(':').map(Number);
          if (parts.length === 2) duration = parts[0] * 60 + parts[1];
          else if (parts.length === 3) duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
        return { title, author, duration };
      })();
    `);

    const videoIdMatch = url.match(/[?&]v=([^&]+)/);
    const videoId = videoIdMatch ? decodeURIComponent(videoIdMatch[1]) : null;
    if (!videoId) throw new Error('Не удалось получить videoId');

    // уже грузим/есть?
    if (pendingDownloads.has(videoId)) return;

    pendingDownloads.set(videoId, { videoId, title: info.title, author: info.author, url, pct: 0, downloaded: 0, total: 0 });
    renderLibrary();

    // запускаем загрузку асинхронно, не блокируя
    const p = ipcRenderer.invoke('download-video', { url, videoId, title: info.title, author: info.author, duration: info.duration });
    inflight.set(videoId, p);
    p.then(async (result) => {
      inflight.delete(videoId);
      if (result && result.success) {
        lastAddedVideoId = videoId;
        showStatus(result.fromCache ? '✓ Из кэша' : '✓ Загружено');
        pendingDownloads.delete(videoId);
        await loadLibrary();
      } else {
        showStatus('Ошибка загрузки: ' + (result?.error || 'unknown'));
        pendingDownloads.delete(videoId);
        renderLibrary();
      }
    }).catch((err) => {
      inflight.delete(videoId);
      pendingDownloads.delete(videoId);
      renderLibrary();
      showStatus('Ошибка загрузки: ' + (err?.message || err));
    });
  } catch (err) {
    console.error(err);
    showStatus('Ошибка: ' + (err.message || err));
  }
}

webview.addEventListener('did-navigate', (e) => handleYouTubeNavigate(e.url || ''));
webview.addEventListener('did-navigate-in-page', (e) => handleYouTubeNavigate(e.url || ''));
webview.addEventListener('will-navigate', (e) => handleYouTubeNavigate(e.url || ''));

// Прогресс загрузки
ipcRenderer.on('download-started', (_e, p) => {
  if (!p || !p.videoId) return;
  if (!pendingDownloads.has(p.videoId)) pendingDownloads.set(p.videoId, { ...p, pct:0, downloaded:0, total:0 });
  renderLibrary();
});
ipcRenderer.on('download-progress', (_e, p) => {
  if (!p || !p.videoId) return;
  const rec = pendingDownloads.get(p.videoId);
  if (!rec) return;
  rec.pct = (typeof p.pct === 'number') ? p.pct : rec.pct;
  rec.downloaded = (typeof p.downloaded === 'number') ? p.downloaded : rec.downloaded;
  rec.total = (typeof p.total === 'number') ? p.total : rec.total;
  renderLibrary();
});
ipcRenderer.on('download-complete', (_e, p) => {
  if (!p || !p.videoId) return;
  pendingDownloads.delete(p.videoId);
  loadLibrary();
});
ipcRenderer.on('download-error', (_e, p) => {
  if (!p || !p.videoId) return;
  pendingDownloads.delete(p.videoId);
  showStatus('Ошибка загрузки: ' + (p.error || 'unknown'));
  renderLibrary();
});

// Обновления от ИИ (название/автор)
ipcRenderer.on('ai-meta', (_e, data) => {
  if (!data || !data.videoId) return;
  const rec = pendingDownloads.get(data.videoId);
  if (rec) {
    rec.title = data.title || rec.title;
    rec.author = data.author || rec.author;
    renderLibrary();
  }
});

// Окно
winClose?.addEventListener('click', () => ipcRenderer.send('window-control', 'close'));
winMin?.addEventListener('click', () => ipcRenderer.send('window-control', 'minimize'));
winMax?.addEventListener('click', () => ipcRenderer.send('window-control', 'maximize'));

refreshBtn?.addEventListener('click', loadLibrary);
openFolderBtn?.addEventListener('click', () => ipcRenderer.invoke('open-music-dir'));

// Настройки
btnSettings?.addEventListener('click', async () => { await loadSettings(); settingsDrawer.classList.add('active'); });
closeSettings?.addEventListener('click', () => settingsDrawer.classList.remove('active'));

async function loadSettings() {
  const res = await ipcRenderer.invoke('get-settings');
  settingsCache = res.settings || {};

  setOpacity.value = Math.round((settingsCache.opacity || 1) * 100);
  setRangeGradient(setOpacity);

  const br = settingsCache.audioBitrateKbps || 192;
  Array.from(setBitrate.options).forEach(o => { o.selected = Number(o.value) === br; });

  const volSaved = Math.round((settingsCache.volume != null ? settingsCache.volume : 1) * 100);
  setVolSettings.value = volSaved;
  setRangeGradient(setVolSettings);

  animToggle.checked = !!settingsCache.animations;
  document.documentElement.classList.toggle('no-anim', !animToggle.checked);

  const ai = await ipcRenderer.invoke('ai-get');
  aiToggle.checked = !!ai.enabled;
  stAI.textContent = ai.enabled ? (ai.hasKey ? 'Включен (ключ найден)' : 'Включен (ключ не задан)') : 'Выключен';

  stFFmpeg.textContent = res.ffmpegPath || 'не найден';
  stMusicDir.textContent = settingsCache.musicDir || '—';

  // тема
  const t = await ipcRenderer.invoke('theme-get');
  applyTheme(t?.vars||{}, t?.elements||{});
  preloadThemePickers(t?.vars||{}, t?.elements||{});
}

function applyTheme(vars={}, elements={}) {
  // применяем CSS custom properties
  const root = document.documentElement;
  Object.entries(vars).forEach(([k,v]) => root.style.setProperty(k, v));
  Object.entries(elements).forEach(([k,v]) => root.style.setProperty(k, v));
}
function preloadThemePickers(vars={}, elements={}) {
  const get = (id) => document.getElementById(id);
  const pick = (id, val) => { const el = get(id); if (el && val) el.value = toColor(val); };
  // vars
  pick('th-bg', vars['--bg']);
  pick('th-bg2', vars['--bg2']);
  pick('th-panel', vars['--panel']);
  pick('th-text', vars['--text']);
  pick('th-muted', vars['--muted']);
  pick('th-accent', vars['--accent']);
  pick('th-accent2', vars['--accent-2']);
  pick('th-accent-dark', vars['--accent-dark']);
  pick('th-border', vars['--border']);
  pick('th-warn', vars['--warn']);
  pick('th-yellow', vars['--yellow']);
  // elements
  pick('th-el-titlebar', elements['--titlebar-bg-color']);
  pick('th-el-sidebar', elements['--sidebar-bg-color']);
  pick('th-el-player', elements['--player-bg-color']);
  pick('th-el-prog1', elements['--progress1']);
  pick('th-el-prog2', elements['--progress2']);
  pick('th-el-btn', elements['--btn-bg-color']);
}
function toColor(val) {
  // принимает rgba/hex — оставим как есть, если hex уже
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(val)) return val;
  // пробуем извлечь rgb(a)
  const m = String(val).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (m) {
    const r = (+m[1]).toString(16).padStart(2,'0');
    const g = (+m[2]).toString(16).padStart(2,'0');
    const b = (+m[3]).toString(16).padStart(2,'0');
    return `#${r}${g}${b}`;
  }
  return '#000000';
}

setOpacity?.addEventListener('input', async (e) => {
  const val = Math.max(60, Math.min(100, Number(e.target.value)));
  setRangeGradient(setOpacity);
  await ipcRenderer.invoke('set-opacity', val / 100);
});
setBitrate?.addEventListener('change', async (e) => {
  const br = Math.max(64, Math.min(320, Number(e.target.value)));
  await saveSettings({ audioBitrateKbps: br });
  showStatus('Битрейт MP3: ' + br + ' kbps', 1500);
});
setVolSettings?.addEventListener('input', async (e) => {
  const v = Math.max(0, Math.min(100, Number(e.target.value)));
  const nv = v / 100;
  await saveSettings({ volume: nv });
  vol.value = v;
  vol.dispatchEvent(new Event('input'));
  setRangeGradient(setVolSettings);
});
animToggle?.addEventListener('change', async (e) => {
  document.documentElement.classList.toggle('no-anim', !e.target.checked);
  await saveSettings({ animations: !!e.target.checked });
});

// ИИ
aiToggle?.addEventListener('change', async (e) => {
  await saveSettings({ aiEnabled: !!e.target.checked });
  const ai = await ipcRenderer.invoke('ai-get');
  stAI.textContent = ai.enabled ? (ai.hasKey ? 'Включен (ключ найден)' : 'Включен (ключ не задан)') : 'Выключен';
});
aiSaveBtn?.addEventListener('click', async () => {
  const key = (aiKeyInput.value || '').trim();
  const res = await ipcRenderer.invoke('ai-save', key);
  if (res?.ok) {
    aiKeyInput.value = '';
    const g = await ipcRenderer.invoke('ai-get');
    stAI.textContent = g.enabled ? (g.hasKey ? 'Включен (ключ найден)' : 'Включен (ключ не задан)') : 'Выключен';
    showStatus('Ключ сохранён');
  } else {
    showStatus('Ошибка сохранения ключа: ' + (res?.error || 'неизвестно'));
  }
});
aiTestBtn?.addEventListener('click', async () => {
  const g = await ipcRenderer.invoke('ai-get');
  showStatus(g.hasKey ? 'Ключ найден' : 'Ключ не найден', 1500);
});

// Тема: взаимодействие
function readColor(id) { const el = document.getElementById(id); return el && el.value ? el.value : null; }
document.getElementById('theme-save')?.addEventListener('click', async () => {
  const vars = {
    '--bg': readColor('th-bg'),
    '--bg2': readColor('th-bg2'),
    '--panel': readColor('th-panel'),
    '--text': readColor('th-text'),
    '--muted': readColor('th-muted'),
    '--accent': readColor('th-accent'),
    '--accent-2': readColor('th-accent2'),
    '--accent-dark': readColor('th-accent-dark'),
    '--border': readColor('th-border'),
    '--warn': readColor('th-warn'),
    '--yellow': readColor('th-yellow'),
  };
  const elements = {
    '--titlebar-bg-color': readColor('th-el-titlebar'),
    '--sidebar-bg-color': readColor('th-el-sidebar'),
    '--player-bg-color': readColor('th-el-player'),
    '--progress1': readColor('th-el-prog1'),
    '--progress2': readColor('th-el-prog2'),
    '--btn-bg-color': readColor('th-el-btn'),
  };
  await ipcRenderer.invoke('theme-save', { vars, elements });
  applyTheme(vars, elements);
  showStatus('Тема сохранена', 1200);
});
document.getElementById('theme-reset')?.addEventListener('click', async () => {
  await ipcRenderer.invoke('theme-reset');
  const t = await ipcRenderer.invoke('theme-get');
  applyTheme(t?.vars||{}, t?.elements||{});
  preloadThemePickers(t?.vars||{}, t?.elements||{});
  showStatus('Тема сброшена', 1200);
});
document.getElementById('theme-export')?.addEventListener('click', async () => {
  const t = await ipcRenderer.invoke('theme-get');
  const blob = new Blob([JSON.stringify(t, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'theme.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.getElementById('theme-import')?.addEventListener('click', async () => {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'application/json';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const text = await file.text();
    try {
      const t = JSON.parse(text);
      await ipcRenderer.invoke('theme-save', t);
      applyTheme(t?.vars||{}, t?.elements||{});
      preloadThemePickers(t?.vars||{}, t?.elements||{});
      showStatus('Тема импортирована', 1200);
    } catch (e) {
      showStatus('Ошибка импорта: ' + (e.message||e));
    }
  };
  input.click();
});

async function saveSettings(partial) {
  const next = Object.assign({}, settingsCache || {}, partial || {});
  const res = await ipcRenderer.invoke('save-settings', next);
  if (res && res.settings) settingsCache = res.settings;
}

function debounce(fn, t = 300) {
  let id;
  return (...args) => { clearTimeout(id); id = setTimeout(() => fn.apply(null, args), t); };
}

/* Поиск */
searchInput?.addEventListener('input', debounce(async () => {
  const q = (searchInput.value || '').trim();
  if (!q) { await loadLibrary(); return; }
  const res = await ipcRenderer.invoke('search-library', q);
  playlist = Array.isArray(res) ? res : [];
  renderLibrary();
}, 200));

/* Playlists UI */
async function refreshPlaylists() {
  const pls = await ipcRenderer.invoke('playlists-get');
  playlistList.innerHTML = '';
  if (!pls.length) {
    const div = document.createElement('div'); div.className = 'empty'; div.textContent = 'Плейлистов пока нет'; playlistList.appendChild(div);
  }
  pls.forEach(pl => {
    const item = document.createElement('div');
    item.className = 'pl-item';
    item.innerHTML = `
      <div>
        <div class="track-title">${pl.name}</div>
        <div class="track-sub">${(pl.trackIds || []).length} трек(ов) • ${pl.id}</div>
      </div>
      <div class="item-actions">
        <button class="btn round open" data-tip="Открыть"><i class="fa-solid fa-folder-open"></i></button>
        <button class="btn round ren" data-tip="Переименовать"><i class="fa-solid fa-pen-to-square"></i></button>
        <button class="btn round del" data-tip="Удалить"><i class="fa-solid fa-trash"></i></button>
      </div>
    `;
    item.querySelector('.open').addEventListener('click', () => { activePlaylistId = pl.id; refreshPlaylistTracks(pl.id); });
    item.querySelector('.ren').addEventListener('click', async () => {
      const name = prompt('Новое название плейлиста:', pl.name);
      if (!name) return;
      await ipcRenderer.invoke('playlist-rename', pl.id, name);
      refreshPlaylists();
    });
    item.querySelector('.del').addEventListener('click', async () => {
      if (!confirm('Удалить плейлист?')) return;
      await ipcRenderer.invoke('playlist-delete', pl.id);
      if (activePlaylistId === pl.id) { activePlaylistId = null; playlistTracks.innerHTML = ''; }
      refreshPlaylists();
    });
    playlistList.appendChild(item);
  });
  if (activePlaylistId) refreshPlaylistTracks(activePlaylistId);
}

async function refreshPlaylistTracks(id) {
  if (!id) { playlistTracks.innerHTML = ''; return; }
  const tracks = await ipcRenderer.invoke('playlist-tracks', id);
  playlistTracks.innerHTML = '';
  const head = document.createElement('div'); head.className = 'pill'; head.textContent = `Треки плейлиста (${tracks.length})`; playlistTracks.appendChild(head);

  if (!tracks.length) {
    const div = document.createElement('div'); div.className = 'empty'; div.textContent = 'Нет треков'; playlistTracks.appendChild(div);
    return;
  }
  tracks.forEach(t => {
    const item = document.createElement('div'); item.className = 'track-item shader-animate';
    item.innerHTML = `
      <div class="main-line">
        <div class="track-title">${t.title}</div>
        <div class="track-sub">${t.author} • ${fmtTime(t.duration)} • ${(t.hash||'').slice(0,12)}</div>
      </div>
      <div class="actions-wrap">
        <div class="item-actions">
          <button class="btn round play toggleable" data-tip="Играть"><i class="fa-solid fa-play"></i></button>
          <button class="btn round addq toggleable" data-tip="В очередь"><i class="fa-solid fa-plus"></i></button>
          <button class="btn round rm toggleable" data-tip="Убрать из плейлиста"><i class="fa-solid fa-xmark"></i></button>
        </div>
      </div>
    `;
    item.addEventListener('click', (e) => { if (!e.target.closest('.btn')) item.classList.toggle('expanded'); });
    item.querySelector('.play').addEventListener('click', () => {
      const idx = playlist.findIndex(x => x.videoId === t.videoId);
      if (idx >= 0) playFromIndex(idx);
    });
    item.querySelector('.addq').addEventListener('click', () => { queue.push(t); renderQueue(); markToggleBtn(item.querySelector('.addq'), true); setTimeout(()=>markToggleBtn(item.querySelector('.addq'), false), 800); });
    item.querySelector('.rm').addEventListener('click', async () => {
      await ipcRenderer.invoke('playlist-remove', id, t.videoId);
      refreshPlaylistTracks(id);
    });
    playlistTracks.appendChild(item);
  });
}

plCreateBtn?.addEventListener('click', async () => {
  const name = prompt('Название плейлиста:');
  if (!name) return;
  await ipcRenderer.invoke('playlist-create', name);
  refreshPlaylists();
});
queueClearBtn?.addEventListener('click', () => { queue = []; renderQueue(); });
queuePlayBtn?.addEventListener('click', () => {
  if (queue.length) {
    currentTrack = queue.shift();
    audio.src = makeFileUrl(currentTrack.filePath);
    audio.currentTime = 0;
    audio.play().then(() => { setPlayIcon(true); playerBeatActive(true); updateMetaUI(); renderQueue(); });
  }
});

async function refreshFavorites() {
  const favs = await ipcRenderer.invoke('favorites-list');
  favList.innerHTML = '';
  if (!favs.length) {
    const div = document.createElement('div'); div.className = 'empty'; div.textContent = 'Избранное пусто'; favList.appendChild(div);
    return;
  }
  favs.forEach(t => {
    const item = document.createElement('div'); item.className = 'fav-item shader-animate';
    item.innerHTML = `
      <div class="main-line">
        <div class="track-title">${t.title}</div>
        <div class="track-sub">${t.author} • ${fmtTime(t.duration)} • ${(t.hash||'').slice(0,12)}</div>
      </div>
      <div class="actions-wrap">
        <div class="item-actions">
          <button class="btn round play toggleable" data-tip="Играть"><i class="fa-solid fa-play"></i></button>
          <button class="btn round addq toggleable" data-tip="В очередь"><i class="fa-solid fa-plus"></i></button>
          <button class="btn round fav toggleable" data-tip="Убрать из избранного"><i class="fa-solid fa-heart"></i></button>
        </div>
      </div>
    `;
    item.addEventListener('click', (e) => { if (!e.target.closest('.btn')) item.classList.toggle('expanded'); });
    item.querySelector('.play').addEventListener('click', () => {
      const idx = playlist.findIndex(x => x.videoId === t.videoId);
      if (idx >= 0) playFromIndex(idx);
    });
    item.querySelector('.addq').addEventListener('click', () => { queue.push(t); renderQueue(); markToggleBtn(item.querySelector('.addq'), true); setTimeout(()=>markToggleBtn(item.querySelector('.addq'), false), 800); });
    item.querySelector('.fav').addEventListener('click', async () => { await ipcRenderer.invoke('favorites-toggle', t.videoId); refreshFavorites(); await loadLibrary(); });
    favList.appendChild(item);
  });
}

/* Beat visualization (Web Audio) */
let audioCtx, analyser, sourceNode, freqArray;
let beatVal = 0;
function ensureAnalyser() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (!analyser) {
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.85;
      freqArray = new Uint8Array(analyser.frequencyBinCount);
    }
    if (!sourceNode) {
      sourceNode = audioCtx.createMediaElementSource(audio);
      sourceNode.connect(analyser);
      analyser.connect(audioCtx.destination);
    }
  } catch (e) {
    console.warn('Audio analyser init error:', e);
  }
}
function playerBeatActive(active) {
  if (active) {
    playerEl.classList.add('beat-active');
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(()=>{});
  } else {
    playerEl.classList.remove('beat-active');
  }
}
function beatLoop() {
  if (analyser && !audio.paused && !audio.ended) {
    analyser.getByteFrequencyData(freqArray);
    let bins = 24;
    let sum = 0;
    for (let i = 0; i < bins; i++) sum += freqArray[i] || 0;
    let avg = sum / (bins * 255); // 0..1
    beatVal = beatVal * 0.85 + avg * 0.25;
  } else {
    beatVal = beatVal * 0.9;
  }
  const clamped = Math.max(0, Math.min(1, beatVal));
  playerEl.style.setProperty('--beat', clamped.toFixed(3));
  requestAnimationFrame(beatLoop);
}
requestAnimationFrame(beatLoop);

audio.addEventListener('play', async () => {
  ensureAnalyser();
  if (audioCtx && audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch {} }
  playerBeatActive(true);
});
audio.addEventListener('pause', () => playerBeatActive(false));

/* Старт */
(async function init() {
  updateNavState();
  const s = await ipcRenderer.invoke('get-settings'); settingsCache = s.settings || {};
  document.documentElement.classList.toggle('no-anim', !settingsCache.animations);

  // тема
  const t = await ipcRenderer.invoke('theme-get');
  applyTheme(t?.vars||{}, t?.elements||{});
  preloadThemePickers(t?.vars||{}, t?.elements||{});

  await loadLibrary();

  // громкость
  const savedVol = settingsCache.volume != null ? settingsCache.volume : 1;
  audio.volume = Math.min(1, Math.max(0, savedVol));
  const volPct = Math.round(savedVol * 100);
  vol.value = volPct;
  setVolSettings.value = volPct;
  volval.textContent = volPct + '%';
  [vol, setVolSettings, setOpacity].forEach(el => el && setRangeGradient(el));

  // восстановление позиции
  if (settingsCache.lastPlayback?.videoId) {
    const t = playlist.find(x => x.videoId === settingsCache.lastPlayback.videoId);
    if (t) {
      currentTrack = t;
      audio.src = makeFileUrl(t.filePath);
      audio.currentTime = Math.max(0, Math.min(t.duration || 0, settingsCache.lastPlayback.position || 0));
      updateMetaUI();
      setPlayIcon(false);
      playerBeatActive(false);
      timeEl.textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(t.duration || 0)}`;
      const idx = playlist.findIndex(x => x.videoId === t.videoId);
      if (idx >= 0) { currentIndex = idx; }
      showStatus('Позиция восстановлена');
    }
  }
})();
