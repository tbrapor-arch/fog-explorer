// Read-only Dropbox sync, done entirely in the browser (OAuth PKCE, no server, no secret).
// The token stays in this browser's localStorage. Scopes asked: files.metadata.read + files.content.read.
import { ls } from './store.js';
import { FogMap, tileIdFromName, inflate, fogFromSnapshot } from './fog.js';

const AUTH = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN = 'https://api.dropboxapi.com/oauth2/token';
const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
export const redirectUri = () => location.origin + location.pathname;

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const appKey = () => ls.get('dbx_key') || '';
export const setAppKey = k => ls.set('dbx_key', k.trim());
export const isConnected = () => !!ls.get('dbx_refresh');
export const folder = () => ls.get('dbx_folder') || '/Apps/Fog of World';
export const setFolder = f => ls.set('dbx_folder', f.trim() || '/Apps/Fog of World');

export async function connect() {
  const key = appKey();
  if (!key) throw new Error("Renseigne d'abord la clé de ton app Dropbox (App key).");
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem('dbx_verifier', verifier);
  sessionStorage.setItem('dbx_state', state);
  const p = new URLSearchParams({ client_id: key, response_type: 'code', code_challenge: challenge,
    code_challenge_method: 'S256', redirect_uri: redirectUri(), token_access_type: 'offline', state,
    scope: 'files.metadata.read files.content.read' });
  location.href = AUTH + '?' + p;
}

// Called at startup: finishes the OAuth redirect if there is a ?code= in the URL.
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return false;
  history.replaceState(null, '', redirectUri()); // remove the code from the address bar
  if (q.has('error')) throw new Error('Connexion Dropbox refusée.');
  if (q.get('state') !== sessionStorage.getItem('dbx_state')) throw new Error('Réponse Dropbox invalide (state).');
  const r = await fetch(TOKEN, { method: 'POST', body: new URLSearchParams({
    code: q.get('code'), grant_type: 'authorization_code', client_id: appKey(),
    redirect_uri: redirectUri(), code_verifier: sessionStorage.getItem('dbx_verifier') || '' }) });
  sessionStorage.removeItem('dbx_verifier'); sessionStorage.removeItem('dbx_state');
  if (!r.ok) throw new Error('Échec de la connexion Dropbox (' + r.status + ').');
  const j = await r.json();
  ls.set('dbx_refresh', j.refresh_token);
  return true;
}

let access = null, accessExp = 0;
async function token() {
  if (access && Date.now() < accessExp) return access;
  const r = await fetch(TOKEN, { method: 'POST', body: new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: ls.get('dbx_refresh') || '', client_id: appKey() }) });
  if (!r.ok) { if (r.status === 400 || r.status === 401) ls.del('dbx_refresh'); throw new Error('Session Dropbox expirée, reconnecte-toi.'); }
  const j = await r.json();
  access = j.access_token; accessExp = Date.now() + (j.expires_in - 120) * 1000;
  return access;
}

export async function disconnect() {
  try { await fetch(API + '/auth/token/revoke', { method: 'POST', headers: { Authorization: 'Bearer ' + await token() } }); } catch (e) {}
  ls.del('dbx_refresh'); access = null;
}

async function rpc(path, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    const t = await r.text();
    if (t.includes('not_found')) { const e = new Error(`Dossier introuvable dans ton Dropbox : « ${body.path || folder()} ».`); e.notFound = true; throw e; }
    throw new Error('Dropbox : ' + r.status + ' ' + t.slice(0, 120));
  }
  return r.json();
}
async function download(path) {
  const r = await fetch(CONTENT + '/files/download', { method: 'POST', headers: { Authorization: 'Bearer ' + await token(),
    'Dropbox-API-Arg': JSON.stringify({ path }).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) } });
  if (!r.ok) throw new Error('Téléchargement Dropbox impossible (' + r.status + ').');
  return new Uint8Array(await r.arrayBuffer());
}

async function listAll(path) {
  let j = await rpc('/files/list_folder', { path, recursive: true, limit: 2000 });
  const all = [...j.entries];
  while (j.has_more) { j = await rpc('/files/list_folder/continue', { cursor: j.cursor }); all.push(...j.entries); }
  return all.filter(e => e['.tag'] === 'file');
}

// Sync strategy:
//  1. if the folder holds the app's live "Sync" tiles, read them all (always the freshest data);
//  2. otherwise take the most recent .fwss snapshot.
// cache: { [path]: { hash, tile:Uint8Array, id } } so unchanged files are not downloaded again.
// Finds the Fog of World folder wherever it is (Dropbox names "Apps" "Applications" in French, etc.)
async function discover() {
  const found = new Set();
  const r = await rpc('/files/search_v2', { query: 'Fog of World', options: { filename_only: true, max_results: 50 } });
  for (const m of r.matches || []) {
    const md = m.metadata?.metadata;
    if (md?.['.tag'] === 'folder' && /fog of world$/i.test(md.name)) found.add(md.path_display);
  }
  if (!found.size) {
    const r2 = await rpc('/files/search_v2', { query: 'Snapshot', options: { filename_only: true, max_results: 50, file_extensions: ['fwss'] } });
    for (const m of r2.matches || []) { const md = m.metadata?.metadata; if (md?.path_display) found.add(md.path_display.replace(/\/[^/]+$/, '')); }
  }
  // shortest path = the app's root folder
  return [...found].sort((a, b) => a.length - b.length)[0] || null;
}

export async function sync(cache = {}, onProgress = () => {}) {
  let files;
  try { files = await listAll(folder()); }
  catch (e) {
    if (!e.notFound) throw e;
    onProgress('Recherche du dossier Fog of World…');
    const f = await discover();
    if (!f) throw new Error("Je ne trouve pas de dossier Fog of World dans ton Dropbox. Dans Fog of World, active la synchro Dropbox (onglet nuage) ou envoie un snapshot sur Dropbox, puis réessaie.");
    setFolder(f);
    files = await listAll(f);
  }
  const tiles = files.filter(f => tileIdFromName(f.name) !== null && !/\.fwss$/i.test(f.name) && /\/sync\//i.test(f.path_lower));
  const dirs = [...new Set(files.map(f => f.path_display.split('/').slice(0, -1).join('/')))].slice(0, 8);
  if (tiles.length) {
    // nothing changed since last time: skip downloading and decoding
    if (cache.__kind === 'sync' && tiles.length === Object.keys(cache).filter(k => !k.startsWith('__')).length && tiles.every(f => cache[f.path_lower]?.hash === f.content_hash))
      return { unchanged: true, cache, kind: 'sync', date: latest(tiles), folder: folder() };
    const fog = new FogMap(), next = { __kind: 'sync' };
    let i = 0;
    for (const f of tiles) {
      onProgress(`Synchro : ${++i}/${tiles.length} tuiles`);
      let c = cache[f.path_lower];
      if (!c || c.hash !== f.content_hash) c = { hash: f.content_hash, raw: await download(f.path_lower) };
      next[f.path_lower] = c;
      try { fog.addTile(tileIdFromName(f.name), await inflate(c.raw)); } catch (e) {}
    }
    if (fog.size) return { fog, cache: next, kind: 'sync', source: `synchro auto (${tiles.length} tuiles)`, date: latest(tiles), folder: folder(), nFiles: files.length };
  }
  const snaps = files.filter(f => /\.fwss$/i.test(f.name)).sort((a, b) => b.server_modified.localeCompare(a.server_modified));
  if (!snaps.length) throw new Error(`Rien trouvé dans « ${folder()} » : ni dossier Sync, ni snapshot .fwss. Active la synchro Dropbox dans Fog of World, ou envoie un snapshot sur Dropbox.`);
  if (cache.__kind === 'snapshot' && cache.__rev === snaps[0].rev) return { unchanged: true, cache, kind: 'snapshot', date: snaps[0].server_modified, folder: folder(), dirs };
  onProgress('Téléchargement du snapshot ' + snaps[0].name);
  const fog = await fogFromSnapshot((await download(snaps[0].path_lower)).buffer);
  return { fog, cache: { __kind: 'snapshot', __rev: snaps[0].rev }, kind: 'snapshot', source: 'snapshot ' + snaps[0].name, date: snaps[0].server_modified, folder: folder(), nFiles: files.length, dirs };
}
const latest = fs => fs.map(f => f.server_modified).sort().pop();
