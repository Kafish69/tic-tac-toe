import { MODES, newGame, play, canPlay, fadingCell, validGame } from './engine.js';
import { Relay, DEFAULT_BROKERS } from './net.js';

/* ---------------- helpers ---------------- */
const $ = s => document.querySelector(s);
const other = p => (p === 'X' ? 'O' : 'X');
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const rand = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => (b % 36).toString(36)).join('');
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
const cleanCode = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

const X_SVG = '<svg class="m x" viewBox="0 0 100 100"><path d="M27 27 L73 73"/><path d="M73 27 L27 73"/></svg>';
const O_SVG = '<svg class="m o" viewBox="0 0 100 100"><circle cx="50" cy="50" r="24"/></svg>';
const markSvg = p => (p === 'X' ? X_SVG : p === 'O' ? O_SVG : '');
const REACTIONS = ['❤️', '😘', '🔥', '😂', '🥺', '😤', '👀', '👑'];

/* ---------------- app state ---------------- */
const myId = LS.get('ttt.id') || (() => { const id = 'u' + rand(12); LS.set('ttt.id', id); return id; })();
let myName = LS.get('ttt.name', '');
let S = null;              // the shared room state
let kind = null;           // 'online' | 'local'
let room = null;
let relay = null;
let peers = {};            // id -> last seen ms
let lastAnimV = -1;
let lastRepublish = 0;
let lastHiReply = 0;
let timers = [];
let muted = LS.get('ttt.muted', false);
const baseTitle = document.title;

const params = new URLSearchParams(location.search);
const brokers = params.get('broker') ? [params.get('broker')] : DEFAULT_BROKERS;

/* ---------------- state helpers ---------------- */
function freshState(mode = 'classic') {
  return {
    v: 1, ts: Date.now(), by: myId, mode, starter: 'X', round: 1,
    g: newGame(mode, 'X'),
    players: { X: { id: myId, name: myName || 'Player 1' }, O: null },
    scores: { X: 0, O: 0, D: 0 },
  };
}
function validState(m) {
  return !!(m && typeof m.v === 'number' && m.players && typeof m.players === 'object' &&
    m.scores && MODES[m.mode] && validGame(m.g) && m.g.mode === m.mode);
}
function isNewer(a, b) {
  if (!b) return true;
  if (a.v !== b.v) return a.v > b.v;
  if (a.by === b.by) return false;
  return String(a.by) > String(b.by);      // deterministic tie-break, both sides agree
}
const mySeat = () => !S ? null : S.players.X?.id === myId ? 'X' : S.players.O?.id === myId ? 'O' : null;
const bothSeated = () => !!(S && S.players.X && S.players.O);
function nameOf(p) {
  if (!S) return '';
  if (kind === 'local') return S.players[p]?.name || (p === 'X' ? 'Player 1' : 'Player 2');
  return S.players[p]?.name || '…';
}
function myTurn() {
  if (!S || S.g.winner) return false;
  if (kind === 'local') return true;
  return bothSeated() && S.players[S.g.turn]?.id === myId;
}

function save() {
  if (!S) return;
  if (kind === 'online') LS.set('ttt.room.' + room, S);
  else LS.set('ttt.local', S);
}

function commit(next) {
  const prev = S;
  next.v = (S ? S.v : 0) + 1;
  next.ts = Date.now();
  next.by = myId;
  S = next;
  save();
  if (kind === 'online' && relay) relay.publishState(S);
  effects(prev, S, true);
  render();
}

/* ---------------- actions ---------------- */
function doMove(idx) {
  if (!myTurn()) {
    if (kind === 'online' && S && !S.g.winner && bothSeated() && mySeat()) { buzz(); toast('Not your turn 😏'); }
    return;
  }
  const g = play(S.g, idx);
  if (!g) return;
  const next = { ...S, g, scores: { ...S.scores } };
  if (g.winner) {
    if (g.winner === 'draw') next.scores.D++;
    else next.scores[g.winner]++;
  }
  commit(next);
}

function rematch() {
  if (!S || (kind === 'online' && !mySeat())) return;
  const starter = other(S.starter);
  commit({ ...S, starter, round: S.round + 1, g: newGame(S.mode, starter) });
}

function setMode(m) {
  if (!S || !MODES[m] || (kind === 'online' && !mySeat())) return;
  if (m === S.mode && !S.g.winner && S.g.moves === 0) return;
  if (S.g.moves > 0 && !S.g.winner && !confirm(`Switch to ${MODES[m].name}? The current round will be dropped.`)) return;
  commit({ ...S, mode: m, round: S.round + 1, g: newGame(m, S.starter) });
}

function ensureSeat() {
  if (!S || kind !== 'online') return;
  const seat = mySeat();
  if (seat) {
    if (myName && S.players[seat].name !== myName) {
      commit({ ...S, players: { ...S.players, [seat]: { id: myId, name: myName } } });
    }
    return;
  }
  for (const p of ['O', 'X']) {
    if (!S.players[p]) {
      commit({ ...S, players: { ...S.players, [p]: { id: myId, name: myName || 'Player 2' } } });
      toast(`You joined as ${p}`);
      return;
    }
  }
}

/* ---------------- network ---------------- */
function onRemoteState(m) {
  if (!validState(m) || !isNewer(m, S)) return;
  const prev = S;
  S = m;
  save();
  effects(prev, S, false);
  render();
  ensureSeat();
}

function onEvent(m) {
  if (!m.from || m.from === myId) return;
  if (m.type === 'hi') {
    const isNew = !peers[m.from] || Date.now() - peers[m.from] > 12000;
    peers[m.from] = Date.now();
    if (S && typeof m.v === 'number' && m.v < S.v && Date.now() - lastRepublish > 2500) {
      lastRepublish = Date.now();
      relay.publishState(S);
    }
    if (isNew && Date.now() - lastHiReply > 1500) { lastHiReply = Date.now(); sayHi(); }
    renderPlayers();
  } else if (m.type === 'bye') {
    delete peers[m.from];
    renderPlayers();
  } else if (m.type === 'emo' && REACTIONS.includes(m.e)) {
    floatEmoji(m.e);
    sfx('pop');
    if (document.hidden) flashTitle(m.e + ' ' + (m.name || ''));
  }
}

function sayHi() { if (relay) relay.send('hi', { name: myName, v: S ? S.v : 0 }); }

function netStatus(up, total) {
  const dot = $('#netDot');
  dot.className = 'net-dot ' + (up > 0 ? 'on' : 'off');
  dot.title = `${up}/${total} relays connected`;
  if (kind === 'online' && !S) {
    $('#connectingText').textContent = up > 0 ? 'finding your room…' : 'connecting…';
  }
}

/* ---------------- enter / leave ---------------- */
function enterOnline(code, create) {
  leave(true);
  kind = 'online';
  room = code;
  peers = {};
  lastAnimV = -1;
  const saved = LS.get('ttt.room.' + code, null);
  S = create ? freshState() : (validState(saved) ? saved : null);
  if (S) lastAnimV = S.v;
  history.replaceState(null, '', location.pathname + '?room=' + code + (params.get('broker') ? '&broker=' + encodeURIComponent(params.get('broker')) : ''));
  showGame();

  relay = new Relay(code, myId, {
    onState: onRemoteState,
    onEvent,
    onStatus: netStatus,
    onReady: () => {
      if (!S) { commit(freshState()); toast('New room created — share the code'); }
      else ensureSeat();
      sayHi();
    },
  });
  relay.getState = () => S;
  relay.connect(brokers);

  timers.push(setInterval(sayHi, 4000));
  timers.push(setInterval(renderPlayers, 3000));
  render();
}

function enterLocal() {
  leave(true);
  kind = 'local';
  room = null;
  const saved = LS.get('ttt.local', null);
  if (validState(saved)) S = saved;
  else {
    S = freshState();
    S.players.O = { id: 'local-O', name: 'Player 2' };
  }
  S.players.X = { id: 'local-X', name: myName || 'Player 1' };
  lastAnimV = S.v;
  history.replaceState(null, '', location.pathname);
  showGame();
  render();
}

function leave(silent) {
  timers.forEach(clearInterval); timers = [];
  if (relay) { relay.close(); relay = null; }
  S = null; kind = null; room = null;
  document.title = baseTitle;
  if (!silent) {
    history.replaceState(null, '', location.pathname);
    $('#game').classList.add('hidden');
    $('#home').classList.remove('hidden');
    $('#codeInput').value = '';
  }
}

function showGame() {
  $('#home').classList.add('hidden');
  $('#game').classList.remove('hidden');
  $('#roomChip').classList.toggle('local', kind === 'local');
  $('#roomCode').textContent = kind === 'online' ? room : 'one phone';
  $('#inviteCode').textContent = room || '';
  window.scrollTo(0, 0);
}

/* ---------------- effects (sound, confetti, haptics) ---------------- */
function effects(prev, next, local) {
  if (!next || !prev) return;
  const g = next.g, pg = prev && prev.g;
  const sameRound = prev && prev.round === next.round && prev.mode === next.mode;
  const moved = sameRound && pg && g.moves > pg.moves;

  if (moved) {
    sfx(g.cells[g.last] === 'X' ? 'x' : 'o');
    if (!local) vibrate(18);
  } else if (prev && !sameRound) {
    sfx('new');
  }

  if (g.winner && !(sameRound && pg && pg.winner)) {
    const me = kind === 'local' ? g.winner : mySeat();
    if (g.winner === 'draw') { sfx('draw'); }
    else if (kind === 'local' || g.winner === me || !mySeat()) { sfx('win'); confetti(g.winner); vibrate([30, 40, 60]); }
    else { sfx('lose'); shake(); vibrate(120); }
  }

  if (!local && kind === 'online' && document.hidden) {
    if (g.winner) flashTitle(g.winner === 'draw' ? 'Draw' : (g.winner === mySeat() ? 'You won!' : 'Round over'));
    else if (myTurn()) flashTitle('Your move');
  }
}

/* ---------------- rendering ---------------- */
function render() {
  if (!S && kind === 'online') {
    $('#board').innerHTML = '';
    $('#board').className = 'board';
    $('#connecting').classList.remove('hidden');
    $('#invite').classList.add('hidden');
    $('#status').textContent = '';
    $('#rematchBtn').classList.add('hidden');
    renderPlayers(); renderModes();
    return;
  }
  $('#connecting').classList.add('hidden');
  renderPlayers();
  renderBoard();
  renderStatus();
  renderModes();
  const waiting = kind === 'online' && !S.players.O;
  $('#invite').classList.toggle('hidden', !waiting);
  $('#boardWrap').classList.toggle('dim', waiting);
  const canRematch = !!S.g.winner && (kind === 'local' || !!mySeat());
  $('#rematchBtn').classList.toggle('hidden', !canRematch);
}

function renderPlayers() {
  for (const p of ['X', 'O']) {
    const el = $('#p' + p);
    const pl = S && S.players[p];
    el.querySelector('.pname').textContent = !S ? '…' : pl ? nameOf(p) : 'waiting…';
    el.querySelector('.pscore').textContent = S ? S.scores[p] : 0;
    let st = '';
    if (kind === 'online' && pl) {
      if (pl.id === myId) st = '<i class="on"></i>you';
      else st = peers[pl.id] && Date.now() - peers[pl.id] < 12000 ? '<i class="on"></i>online' : '<i></i>away';
    }
    el.querySelector('.pstatus').innerHTML = st;
    el.classList.toggle('turn', !!(S && !S.g.winner && S.g.turn === p && (kind === 'local' || bothSeated())));
    el.classList.toggle('won', !!(S && S.g.winner === p));
  }
  $('#drawCount').textContent = S ? S.scores.D : 0;
}

function renderStatus() {
  const g = S.g, el = $('#status');
  const seat = mySeat();
  let t = '', cls = 'status';
  if (kind === 'online' && !S.players.O) t = 'Waiting for player 2…';
  else if (g.winner === 'draw') { t = 'Draw'; cls += ' draw'; }
  else if (g.winner) {
    const w = g.winner;
    const misere = g.mode === 'misere' ? ` — ${nameOf(other(w))} made three` : '';
    if (kind === 'online' && seat) t = (w === seat ? 'You win' : `${nameOf(w)} wins`) + misere;
    else t = `${nameOf(w)} wins` + misere;
    cls += ' ' + w.toLowerCase();
  } else if (kind === 'online' && !seat) t = `Watching · ${nameOf(g.turn)}'s move`;
  else if (kind === 'online') t = myTurn() ? 'Your move' : `${nameOf(g.turn)}'s move…`;
  else t = `${nameOf(g.turn)}'s move`;
  if (!g.winner && g.mode === 'ultimate' && (kind === 'local' || myTurn())) {
    t += g.active === -1 ? ' · any board' : '';
  }
  el.className = cls + (!g.winner ? ' t' + g.turn.toLowerCase() : '');
  el.textContent = t;
}

function renderBoard() {
  const g = S.g, board = $('#board');
  const anim = S.v !== lastAnimV;
  lastAnimV = S.v;
  const live = myTurn();
  const fading = fadingCell(g);
  const win = new Set(g.line || []);
  board.className = `board mode-${g.mode} turn-${g.turn.toLowerCase()}` + (g.winner ? ' over' : '') + (live ? ' live' : '');

  const cell = idx => {
    const v = g.cells[idx];
    const c = document.createElement('button');
    c.className = 'cell';
    c.dataset.i = idx;
    c.setAttribute('aria-label', v ? v : 'empty');
    if (v) {
      c.innerHTML = markSvg(v);
      c.classList.add('f' + v.toLowerCase());
      if (idx === g.last && anim) c.classList.add('draw');
      if (idx === g.last) c.classList.add('last');
    } else if (live && canPlay(g, idx)) {
      c.classList.add('open');
    }
    if (idx === fading) c.classList.add('fading');
    return c;
  };

  const frag = document.createDocumentFragment();
  if (g.mode === 'ultimate') {
    const bigWin = new Set(g.line || []);
    for (let b = 0; b < 9; b++) {
      const mini = document.createElement('div');
      mini.className = 'mini';
      const st = g.boards[b];
      if (!g.winner && st === null && (g.active === -1 || g.active === b)) mini.classList.add('active');
      if (st === 'X' || st === 'O') { mini.classList.add('taken', 't' + st.toLowerCase()); }
      if (st === 'D') mini.classList.add('drawn');
      if (bigWin.has(b)) mini.classList.add('win');
      const sw = new Set(g.smallLines[b] || []);
      for (let i = 0; i < 9; i++) {
        const c = cell(b * 9 + i);
        if (sw.has(b * 9 + i)) c.classList.add('win');
        mini.appendChild(c);
      }
      if (st === 'X' || st === 'O') {
        const big = document.createElement('div');
        big.className = 'mini-mark';
        big.innerHTML = markSvg(st);
        mini.appendChild(big);
      }
      frag.appendChild(mini);
    }
  } else {
    board.style.setProperty('--n', g.n);
    for (let i = 0; i < g.cells.length; i++) {
      const c = cell(i);
      if (win.has(i)) c.classList.add('win', g.mode === 'misere' ? 'lose-line' : 'win-line');
      frag.appendChild(c);
    }
  }
  board.replaceChildren(frag);
}

function renderModes() {
  const wrap = $('#modes');
  if (!wrap.childElementCount) {
    for (const [k, m] of Object.entries(MODES)) {
      const b = document.createElement('button');
      b.className = 'mode';
      b.dataset.mode = k;
      b.innerHTML = `<span>${m.name}</span><small>${m.tag}</small>`;
      b.addEventListener('click', () => setMode(k));
      wrap.appendChild(b);
    }
  }
  const cur = S ? S.mode : 'classic';
  const canChange = !!S && (kind === 'local' || !!mySeat());
  wrap.querySelectorAll('.mode').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === cur);
    b.disabled = !canChange;
  });
  $('#modeDesc').textContent = MODES[cur].desc;
}

function renderReactions() {
  const wrap = $('#reactions');
  REACTIONS.forEach(e => {
    const b = document.createElement('button');
    b.className = 'react';
    b.textContent = e;
    b.addEventListener('click', () => {
      floatEmoji(e, true);
      sfx('pop');
      if (kind === 'online' && relay) relay.send('emo', { e, name: myName });
    });
    wrap.appendChild(b);
  });
}

/* ---------------- fx ---------------- */
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2200);
}

function floatEmoji(e, mine) {
  const s = document.createElement('span');
  s.className = 'floater' + (mine ? ' mine' : '');
  s.textContent = e;
  s.style.left = (mine ? 55 + Math.random() * 35 : 10 + Math.random() * 35) + 'vw';
  s.style.setProperty('--drift', (Math.random() * 60 - 30) + 'px');
  $('#floaters').appendChild(s);
  setTimeout(() => s.remove(), 2600);
}

function shake() {
  const b = $('#boardWrap');
  b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake');
}
function buzz() { vibrate(40); shake(); }
function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch {} }

let titleT;
function flashTitle(msg) {
  clearInterval(titleT);
  let on = false;
  titleT = setInterval(() => {
    if (!document.hidden) { clearInterval(titleT); document.title = baseTitle; return; }
    on = !on; document.title = on ? '● ' + msg : baseTitle;
  }, 1000);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { clearInterval(titleT); document.title = baseTitle; sayHi(); }
});

// confetti
const fx = $('#fx'), ctx = fx.getContext('2d');
let parts = [], fxRun = false;
function sizeFx() { fx.width = innerWidth * devicePixelRatio; fx.height = innerHeight * devicePixelRatio; }
addEventListener('resize', sizeFx); sizeFx();
function confetti(p) {
  const css = getComputedStyle(document.documentElement);
  const cols = [css.getPropertyValue(p === 'X' ? '--x' : '--o').trim() || '#888', css.getPropertyValue('--mute').trim() || '#999'];
  const W = fx.width, H = fx.height;
  for (let i = 0; i < 70; i++) {
    parts.push({
      x: W / 2 + (Math.random() - .5) * W * .3, y: H * .45,
      vx: (Math.random() - .5) * 26 * devicePixelRatio, vy: (-Math.random() * 22 - 6) * devicePixelRatio,
      r: (Math.random() * 5 + 3) * devicePixelRatio, c: cols[i % cols.length], a: Math.random() * 6, va: (Math.random() - .5) * .4,
      heart: false, life: 1,
    });
  }
  if (!fxRun) { fxRun = true; requestAnimationFrame(tick); }
}
function heart(x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x, y + s * .3);
  ctx.bezierCurveTo(x, y, x - s, y, x - s, y + s * .35);
  ctx.bezierCurveTo(x - s, y + s * .8, x, y + s * 1.05, x, y + s * 1.3);
  ctx.bezierCurveTo(x, y + s * 1.05, x + s, y + s * .8, x + s, y + s * .35);
  ctx.bezierCurveTo(x + s, y, x, y, x, y + s * .3);
  ctx.fill();
}
function tick() {
  ctx.clearRect(0, 0, fx.width, fx.height);
  parts = parts.filter(p => p.life > 0 && p.y < fx.height + 40);
  for (const p of parts) {
    p.vy += .55 * devicePixelRatio; p.vx *= .985; p.x += p.vx; p.y += p.vy; p.a += p.va; p.life -= .006;
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.5));
    ctx.fillStyle = p.c;
    if (p.heart) heart(p.x, p.y, p.r * 1.2);
    else { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillRect(-p.r, -p.r / 2.5, p.r * 2, p.r / 1.25); ctx.restore(); }
  }
  ctx.globalAlpha = 1;
  if (parts.length) requestAnimationFrame(tick); else { fxRun = false; ctx.clearRect(0, 0, fx.width, fx.height); }
}

// sound
let ac = null;
function audio() {
  if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}
function tone(f, t0, dur, type = 'sine', vol = .12) {
  const a = audio(); if (!a) return;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.value = f;
  g.gain.setValueAtTime(0, a.currentTime + t0);
  g.gain.linearRampToValueAtTime(vol, a.currentTime + t0 + .01);
  g.gain.exponentialRampToValueAtTime(.0001, a.currentTime + t0 + dur);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + t0); o.stop(a.currentTime + t0 + dur + .05);
}
function sfx(k) {
  if (muted) return;
  if (k === 'x') { tone(660, 0, .12, 'triangle'); tone(990, .03, .1, 'sine', .05); }
  if (k === 'o') { tone(440, 0, .14, 'triangle'); tone(660, .03, .12, 'sine', .05); }
  if (k === 'pop') tone(880, 0, .08, 'sine', .07);
  if (k === 'new') { tone(392, 0, .1); tone(523, .08, .14); }
  if (k === 'win') [523, 659, 784, 1047].forEach((f, i) => tone(f, i * .09, .3, 'triangle', .1));
  if (k === 'lose') { tone(330, 0, .25, 'sawtooth', .05); tone(247, .18, .4, 'sawtooth', .05); }
  if (k === 'draw') { tone(440, 0, .18); tone(440, .2, .18); }
}
function renderSound() {
  $('#soundBtn').innerHTML = muted
    ? '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9l4 6M21 9l-4 6"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12"/></svg>';
}

/* ---------------- share ---------------- */
function roomLink() { return location.origin + location.pathname + '?room=' + room; }
async function share() {
  if (kind !== 'online' || !room) return;
  const url = roomLink();
  const text = `Play tic tac toe with me. Code: ${room}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'tic · tac · toe', text, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Invite link copied'); }
  catch {
    const ta = document.createElement('textarea'); ta.value = `${text}\n${url}`; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Invite link copied'); } catch { toast(url); }
    ta.remove();
  }
}

/* ---------------- wiring ---------------- */
function needName() {
  const v = $('#nameInput').value.trim().slice(0, 16);
  if (!v) {
    const i = $('#nameInput'); i.classList.remove('nope'); void i.offsetWidth; i.classList.add('nope'); i.focus();
    toast('Name first 😉');
    return false;
  }
  myName = v; LS.set('ttt.name', v);
  return true;
}

$('#nameInput').value = myName;
$('#nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
$('#codeInput').addEventListener('input', e => { e.target.value = cleanCode(e.target.value); });
$('#codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#joinBtn').click(); });
$('#createBtn').addEventListener('click', () => { audio(); if (needName()) enterOnline(newCode(), true); });
$('#joinBtn').addEventListener('click', () => {
  audio();
  const code = cleanCode($('#codeInput').value);
  if (code.length !== 6) { toast('Codes are 6 characters'); $('#codeInput').focus(); return; }
  if (needName()) enterOnline(code, false);
});
$('#localBtn').addEventListener('click', () => { audio(); const v = $('#nameInput').value.trim(); if (v) { myName = v.slice(0, 16); LS.set('ttt.name', myName); } enterLocal(); });
$('#backBtn').addEventListener('click', () => leave(false));
$('#roomChip').addEventListener('click', share);
$('#inviteShare').addEventListener('click', share);
$('#rematchBtn').addEventListener('click', rematch);
$('#soundBtn').addEventListener('click', () => { muted = !muted; LS.set('ttt.muted', muted); renderSound(); if (!muted) sfx('pop'); });
$('#board').addEventListener('click', e => {
  const c = e.target.closest('.cell');
  if (!c) return;
  audio();
  doMove(+c.dataset.i);
});
addEventListener('pagehide', () => { if (relay) relay.send('bye'); });

renderSound();
renderReactions();
renderModes();

// deep link: ?room=CODE
const linkCode = cleanCode(params.get('room'));
if (linkCode.length === 6) {
  $('#codeInput').value = linkCode;
  if (myName) enterOnline(linkCode, false);
  else { $('#joinBtn').classList.add('primary'); $('#createBtn').classList.remove('primary'); setTimeout(() => $('#nameInput').focus(), 300); toast("You're invited — add your name & tap Join"); }
}

// debugging hook (harmless)
window.__ttt = { get state() { return S; }, get kind() { return kind; }, myId };
