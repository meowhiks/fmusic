// manager.js
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const BASE_DIR = __dirname;
const LIBRARY_JSON = path.join(BASE_DIR, 'library.json');

function r() {
  try {
    const lib = JSON.parse(fs.readFileSync(LIBRARY_JSON, 'utf-8'));
    if (!lib.tracks) lib.tracks = {};
    if (!lib.playlists) lib.playlists = {};
    if (!lib.favorites) lib.favorites = [];
    return lib;
  } catch { return { tracks: {}, playlists: {}, favorites: [] }; }
}
function w(lib) {
  if (!lib.tracks) lib.tracks = {};
  if (!lib.playlists) lib.playlists = {};
  if (!lib.favorites) lib.favorites = [];
  fs.writeFileSync(LIBRARY_JSON, JSON.stringify(lib, null, 2));
}
const uid = () => `${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;

function createPlaylist(name) {
  const lib = r(); const id = uid();
  lib.playlists[id] = { id, name: String(name || 'Новый плейлист').trim(), trackIds: [], createdAt: Date.now() };
  w(lib); return lib.playlists[id];
}
function renamePlaylist(id, name) { const lib = r(); if (!lib.playlists[id]) throw 'Плейлист не найден'; lib.playlists[id].name = String(name||'').trim() || lib.playlists[id].name; w(lib); return lib.playlists[id]; }
function deletePlaylist(id) { const lib = r(); if (lib.playlists[id]) delete lib.playlists[id]; w(lib); return true; }
function addTrackToPlaylist(id, videoId) { const lib = r(); if (!lib.playlists[id]) throw 'Плейлист не найден'; if (!lib.tracks[videoId]) throw 'Трек не найден'; const arr=lib.playlists[id].trackIds||[]; if(!arr.includes(videoId)) arr.push(videoId); lib.playlists[id].trackIds=arr; w(lib); return lib.playlists[id]; }
function removeTrackFromPlaylist(id, videoId) { const lib=r(); if(!lib.playlists[id]) throw 'Плейлист не найден'; lib.playlists[id].trackIds=(lib.playlists[id].trackIds||[]).filter(v=>v!==videoId); w(lib); return lib.playlists[id]; }
function listPlaylists(){ const lib=r(); return Object.values(lib.playlists||{}).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)); }
function getPlaylistTracks(id){ const lib=r(); const pl=lib.playlists[id]; if(!pl) throw 'Плейлист не найден'; return (pl.trackIds||[]).map(vId=>lib.tracks[vId]).filter(Boolean); }
function toggleFavorite(videoId){ const lib=r(); const favs=new Set(lib.favorites||[]); if(favs.has(videoId)) favs.delete(videoId); else favs.add(videoId); lib.favorites=Array.from(favs); w(lib); return lib.favorites; }
function listFavorites(){ const lib=r(); return (lib.favorites||[]).map(vId=>lib.tracks[vId]).filter(Boolean); }
function searchLibrary(libOrQuery, maybeQuery){
  let lib, query;
  if (typeof libOrQuery === 'string') { lib = r(); query = libOrQuery; }
  else { lib = libOrQuery || r(); query = maybeQuery || ''; }
  const q=(query||'').toLowerCase().trim(); if(!q) return Object.values(lib.tracks||{}).sort((a,b)=>(b.addedAt||0)-(a.addedAt||0));
  return Object.values(lib.tracks||{}).filter(t=>(`${t.title||''} ${t.author||''} ${t.videoId||''}`).toLowerCase().includes(q)).sort((a,b)=>(b.addedAt||0)-(a.addedAt||0));
}
function removeTrack(videoId, _opts={removeFile:true}){ const lib=r(); const t=lib.tracks[videoId]; if(!t) return false;
  Object.values(lib.playlists||{}).forEach(pl=>{pl.trackIds=(pl.trackIds||[]).filter(v=>v!==videoId);});
  lib.favorites=(lib.favorites||[]).filter(v=>v!==videoId);
  delete lib.tracks[videoId]; w(lib); return t;
}

module.exports = {
  createPlaylist, renamePlaylist, deletePlaylist, addTrackToPlaylist, removeTrackFromPlaylist,
  listPlaylists, getPlaylistTracks, toggleFavorite, listFavorites, searchLibrary, removeTrack
};
