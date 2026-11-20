// Chat + GIFs. Messages go out instantly as events, and a rolling log of the
// last 100 messages is kept on the relays so nothing is missed while offline.
import { GIPHY_KEY } from './config.js';

const $ = s => document.querySelector(s);
const MAX_LOG = 100;
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let H = null;            // hooks from app.js
let room = null;
let log = [];
let open = false;
let unread = 0;
let typingT = null, lastTypingSent = 0;
let gifLoaded = false, gifSearchT = null;

/* ---------- helpers ---------- */
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');

// Turn something pasted into a direct GIF/image URL, or null.
export function gifFromText(t) {
  t = (t || '').trim();
  if (!/^https:\/\/\S+$/i.test(t) || t.length > 600) return null;
  let u;
  try { u = new URL(t); } catch { return null; }
  const h = u.hostname.toLowerCase();
  if (/(^|\.)giphy\.com$/.test(h)) {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'gifs' || parts[0] === 'stickers' || parts[0] === 'embed') {
      const id = (parts[1] || '').split('-').pop();
      if (/^[A-Za-z0-9]{6,}$/.test(id)) return `https://media.giphy.com/media/${id}/giphy.gif`;
    }
    if (parts[0] === 'media' || /^media\d*$/.test(h.split('.')[0]) || h.startsWith('i.')) {
      if (/\.(gif|webp)$/i.test(u.pathname)) return u.href;
      if (parts[0] === 'media' && parts[1]) return `https://media.giphy.com/media/${parts[1]}/giphy.gif`;
    }
  }
  if (/\.(gif|webp|png|jpe?g)$/i.test(u.pathname)) return u.href;
  return null;
}

function validMsg(m) {
  return m && typeof m.id === 'string' && m.id.length <= 40 && typeof m.from === 'string' &&
    typeof m.ts === 'number' && ((typeof m.text === 'string' && m.text.length > 0) || (typeof m.gif === 'string' && /^https:\/\//.test(m.gif)));
}
function cleanMsg(m) {
  const o = { id: m.id, from: m.from, name: clip(m.name, 20), ts: m.ts };
  if (m.gif) o.gif = clip(m.gif, 600); else o.text = clip(m.text, 500);
  return o;
}

function merge(incoming) {
  const map = new Map(log.map(m => [m.id, m]));
  let added = 0;
  for (const m of incoming) if (validMsg(m) && !map.has(m.id)) { map.set(m.id, cleanMsg(m)); added++; }
  log = [...map.values()].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1)).slice(-MAX_LOG);
  return added;
}

function save() { if (room) LS.set('ttt.chat.' + room, log); }

/* ---------- public API ---------- */
export function initChat(hooks) {
  H = hooks;
  $('#chatBtn').addEventListener('click', openChat);
  $('#chatClose').addEventListener('click', closeChat);
  $('#composer').addEventListener('submit', e => { e.preventDefault(); sendFromInput(); });
  $('#msgInput').addEventListener('input', onTyping);
  $('#gifBtn').addEventListener('click', toggleGifs);
  $('#gifQuery').addEventListener('input', onGifQuery);
  $('#gifQuery').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); onGifEnter(); } });
  $('#gifQuery').addEventListener('paste', () => setTimeout(() => { if (!GIPHY_KEY) onGifEnter(); }, 0));
  addEventListener('keydown', e => { if (e.key === 'Escape' && open) closeChat(); });
  // keep the chat sitting right above the phone keyboard
  const vv = window.visualViewport;
  if (vv) {
    const fit = () => {
      document.documentElement.style.setProperty('--vvh', vv.height + 'px');
      document.documentElement.style.setProperty('--vvt', vv.offsetTop + 'px');
      if (open) { const box = $('#msgs'); box.scrollTop = box.scrollHeight; }
    };
    vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit();
  }
}

export function chatEnterRoom(code) {
  room = code;
  log = LS.get('ttt.chat.' + code, []);
  if (!Array.isArray(log)) log = [];
  unread = 0;
  $('#chatBtn').classList.toggle('hidden', !code);
  renderBadge();
  renderMsgs();
}

export function chatLeave() {
  closeChat();
  room = null; log = []; unread = 0;
  $('#chatBtn').classList.add('hidden');
}

export const getChatLog = () => log;

export function onChatEvent(m) {
  if (m.type === 'typing') { showTyping(m.name); return; }
  if (m.type !== 'chat' || !validMsg(m)) return;
  if (merge([m])) { save(); notify([m]); renderMsgs(); }
  hideTyping();
}

export function onChatLog(arr) {
  const before = new Set(log.map(m => m.id));
  const remoteIds = new Set(arr.map(m => m && m.id));
  const added = merge(arr);
  if (added) {
    save();
    notify(log.filter(m => !before.has(m.id)));
    renderMsgs();
  }
  // if the relay copy is missing anything we have, push the merged log back
  if (log.some(m => !remoteIds.has(m.id))) H.relay()?.publishChat(log);
}

/* ---------- sending ---------- */
function send(payload) {
  const relay = H.relay();
  if (!relay || !room) return;
  const m = { id: rid(), from: H.myId, name: H.name(), ts: Date.now(), ...payload };
  merge([m]); save(); renderMsgs(true);
  relay.send('chat', m, 1);
  relay.publishChat(log);
  H.sfx('pop');
}

function sendFromInput() {
  const i = $('#msgInput');
  const t = i.value.trim();
  if (!t) return;
  const g = gifFromText(t);
  send(g ? { gif: g } : { text: t.slice(0, 500) });
  i.value = '';
  lastTypingSent = 0;
}

function onTyping() {
  if (Date.now() - lastTypingSent > 2500 && $('#msgInput').value.trim()) {
    lastTypingSent = Date.now();
    H.relay()?.send('typing', { name: H.name() });
  }
}

function showTyping(name) {
  $('#typing').textContent = `${name || 'they'} typing…`;
  clearTimeout(typingT);
  typingT = setTimeout(hideTyping, 3500);
}
function hideTyping() { clearTimeout(typingT); $('#typing').textContent = ''; }

/* ---------- open / close / unread ---------- */
function openChat() {
  open = true;
  $('#chat').classList.remove('hidden');
  document.body.classList.add('chat-open');
  unread = 0; renderBadge();
  renderMsgs(true);
  if (matchMedia('(hover: hover)').matches) $('#msgInput').focus();
}
function closeChat() {
  open = false;
  $('#chat').classList.add('hidden');
  $('#gifPanel').classList.add('hidden');
  $('#gifBtn').classList.remove('on');
  document.body.classList.remove('chat-open');
}

function notify(msgs) {
  const theirs = msgs.filter(m => m.from !== H.myId);
  if (!theirs.length) return;
  const last = theirs[theirs.length - 1];
  const preview = last.gif ? 'sent a GIF' : last.text;
  if (!open || document.hidden) {
    unread += theirs.length; renderBadge();
    if (!open) H.toast(`${last.name || 'Them'}: ${preview}`);
  }
  H.sfx('pop'); H.vibrate(25);
  if (document.hidden) H.flashTitle(`${last.name || 'New message'}: ${preview}`);
}

function renderBadge() {
  const b = $('#chatBadge');
  b.textContent = unread > 9 ? '9+' : unread;
  b.classList.toggle('hidden', unread === 0);
}

/* ---------- rendering ---------- */
const fmt = ts => { const d = new Date(ts); return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0'); };

function renderMsgs(forceBottom) {
  const box = $('#msgs');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const opp = H.opponentName();
  $('#chatTitle').textContent = opp ? opp : 'Chat';
  if (!log.length) { box.innerHTML = '<p class="empty">Say something nice.</p>'; return; }
  const frag = document.createDocumentFragment();
  let prev = null;
  for (const m of log) {
    const mine = m.from === H.myId;
    if (!prev || m.ts - prev.ts > 10 * 60 * 1000) {
      const t = document.createElement('div');
      t.className = 'msg-time';
      t.textContent = new Date(m.ts).toDateString() === new Date().toDateString() ? fmt(m.ts) : new Date(m.ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + fmt(m.ts);
      frag.appendChild(t);
    }
    const row = document.createElement('div');
    row.className = 'msg ' + (mine ? 'mine' : 'theirs') + (prev && prev.from === m.from && m.ts - prev.ts < 120000 ? ' cont' : '');
    row.title = fmt(m.ts);
    if (m.gif) {
      const img = document.createElement('img');
      img.className = 'msg-gif';
      img.alt = 'GIF';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.src = m.gif;
      img.addEventListener('load', () => { if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight; });
      img.addEventListener('error', () => { img.replaceWith(Object.assign(document.createElement('span'), { className: 'msg-bubble', textContent: 'GIF unavailable' })); });
      row.appendChild(img);
    } else {
      const b = document.createElement('span');
      b.className = 'msg-bubble';
      b.textContent = m.text;
      row.appendChild(b);
    }
    frag.appendChild(row);
    prev = m;
  }
  box.replaceChildren(frag);
  if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
}

/* ---------- GIF picker ---------- */
function toggleGifs() {
  const p = $('#gifPanel');
  const show = p.classList.contains('hidden');
  p.classList.toggle('hidden', !show);
  $('#gifBtn').classList.toggle('on', show);
  if (!show) return;
  const q = $('#gifQuery');
  if (GIPHY_KEY) {
    q.placeholder = 'Search GIFs';
    $('#gifNote').textContent = 'Powered by GIPHY';
    if (!gifLoaded) loadGifs('');
  } else {
    q.placeholder = 'Paste a GIF link';
    $('#gifNote').textContent = 'Copy a GIF link (GIPHY works best) and paste it here.';
    $('#gifGrid').innerHTML = '';
  }
  if (matchMedia('(hover: hover)').matches) q.focus();
}

function onGifQuery() {
  if (!GIPHY_KEY) return;
  clearTimeout(gifSearchT);
  gifSearchT = setTimeout(() => loadGifs($('#gifQuery').value.trim()), 400);
}

function onGifEnter() {
  const v = $('#gifQuery').value.trim();
  const g = gifFromText(v);
  if (g) { send({ gif: g }); $('#gifQuery').value = ''; closeGifs(); return; }
  if (!GIPHY_KEY && v) H.toast("That link isn't a GIF — try a GIPHY link");
  else if (GIPHY_KEY) loadGifs(v);
}

function closeGifs() { $('#gifPanel').classList.add('hidden'); $('#gifBtn').classList.remove('on'); }

let gifReq = 0;
async function loadGifs(q) {
  const my = ++gifReq;
  const grid = $('#gifGrid');
  grid.innerHTML = '<div class="gif-loading"><div class="spinner"></div></div>';
  const ep = q ? 'search' : 'trending';
  const url = `https://api.giphy.com/v1/gifs/${ep}?api_key=${encodeURIComponent(GIPHY_KEY)}&limit=24&rating=pg-13${q ? '&q=' + encodeURIComponent(q) : ''}`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    if (my !== gifReq) return;
    const items = (j.data || []).map(d => ({ prev: d.images?.fixed_width_small?.url || d.images?.fixed_width?.url, send: d.images?.fixed_width?.url, title: d.title })).filter(x => x.prev && x.send);
    grid.innerHTML = '';
    if (!items.length) { grid.innerHTML = '<p class="gif-empty">No GIFs found</p>'; return; }
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'gif-item';
      b.setAttribute('aria-label', it.title || 'GIF');
      const img = document.createElement('img');
      img.src = it.prev; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
      b.appendChild(img);
      b.addEventListener('click', () => { send({ gif: it.send }); closeGifs(); });
      grid.appendChild(b);
    }
    gifLoaded = true;
  } catch {
    if (my === gifReq) grid.innerHTML = '<p class="gif-empty">Couldn’t load GIFs</p>';
  }
}
