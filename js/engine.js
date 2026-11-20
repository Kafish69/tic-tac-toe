// Pure game logic — no DOM, no network. Every function returns a NEW game object.

export const MODES = {
  classic:  { name: 'Classic',  tag: '3×3',   desc: 'The OG. Three in a row wins.' },
  vanish:   { name: 'Vanish',   tag: '3 max', desc: 'Only 3 marks each. Place a 4th and your oldest one disappears. No draws.' },
  misere:   { name: 'Misère',   tag: 'reverse', desc: 'Upside down: whoever makes three in a row LOSES.' },
  big:      { name: 'Big Board', tag: '5×5',  desc: 'Bigger board — get 4 in a row.' },
  ultimate: { name: 'Ultimate', tag: '9 in 1', desc: 'Nine boards in one. Where you play decides which board they must play next. Win 3 boards in a row.' },
};

const other = p => (p === 'X' ? 'O' : 'X');

const lineCache = {};
export function lines(n, k) {
  const key = n + ':' + k;
  if (lineCache[key]) return lineCache[key];
  const out = [];
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    for (const [dr, dc] of dirs) {
      const l = [];
      for (let i = 0; i < k; i++) {
        const rr = r + dr * i, cc = c + dc * i;
        if (rr < 0 || rr >= n || cc < 0 || cc >= n) break;
        l.push(rr * n + cc);
      }
      if (l.length === k) out.push(l);
    }
  }
  return (lineCache[key] = out);
}

function findLine(cells, n, k, p) {
  for (const l of lines(n, k)) if (l.every(i => cells[i] === p)) return l;
  return null;
}

export function newGame(mode, starter = 'X') {
  if (!MODES[mode]) mode = 'classic';
  const base = { mode, turn: starter, winner: null, line: null, moves: 0, last: -1 };
  if (mode === 'ultimate') {
    return { ...base, n: 3, k: 3, cells: Array(81).fill(null), boards: Array(9).fill(null), smallLines: Array(9).fill(null), active: -1 };
  }
  const n = mode === 'big' ? 5 : 3;
  const k = mode === 'big' ? 4 : 3;
  const g = { ...base, n, k, cells: Array(n * n).fill(null) };
  if (mode === 'vanish') g.queues = { X: [], O: [] };
  return g;
}

export function canPlay(g, idx) {
  if (!g || g.winner) return false;
  if (!Number.isInteger(idx) || idx < 0 || idx >= g.cells.length) return false;
  if (g.cells[idx] !== null) return false;
  if (g.mode === 'ultimate') {
    const b = Math.floor(idx / 9);
    if (g.boards[b] !== null) return false;
    if (g.active !== -1 && g.active !== b) return false;
  }
  return true;
}

// Which cell of the current player is about to vanish (Vanish mode), else -1
export function fadingCell(g) {
  if (g.mode !== 'vanish' || g.winner) return -1;
  const q = g.queues[g.turn];
  return q.length >= 3 ? q[0] : -1;
}

export function play(g0, idx) {
  if (!canPlay(g0, idx)) return null;
  const g = JSON.parse(JSON.stringify(g0));
  const p = g.turn;
  g.moves++;
  g.last = idx;

  if (g.mode === 'ultimate') {
    g.cells[idx] = p;
    const b = Math.floor(idx / 9), c = idx % 9;
    const sub = g.cells.slice(b * 9, b * 9 + 9);
    const sl = findLine(sub, 3, 3, p);
    if (sl) { g.boards[b] = p; g.smallLines[b] = sl.map(i => b * 9 + i); }
    else if (sub.every(x => x !== null)) g.boards[b] = 'D';
    const big = findLine(g.boards, 3, 3, p);
    if (big) { g.winner = p; g.line = big; g.active = -1; return g; }
    if (g.boards.every(x => x !== null)) { g.winner = 'draw'; g.active = -1; return g; }
    g.active = g.boards[c] === null ? c : -1;
    g.turn = other(p);
    return g;
  }

  if (g.mode === 'vanish') {
    const q = g.queues[p];
    if (q.length >= 3) { const old = q.shift(); g.cells[old] = null; }
    q.push(idx);
  }
  g.cells[idx] = p;

  const l = findLine(g.cells, g.n, g.k, p);
  if (l) {
    g.line = l;
    g.winner = g.mode === 'misere' ? other(p) : p;
    return g;
  }
  if (g.mode !== 'vanish' && g.cells.every(x => x !== null)) { g.winner = 'draw'; return g; }
  g.turn = other(p);
  return g;
}

// Basic sanity check for state arriving over the network
export function validGame(g) {
  try {
    if (!g || !MODES[g.mode] || !Array.isArray(g.cells)) return false;
    const len = g.mode === 'ultimate' ? 81 : g.mode === 'big' ? 25 : 9;
    if (g.cells.length !== len) return false;
    if (g.turn !== 'X' && g.turn !== 'O') return false;
    if (g.mode === 'ultimate' && (!Array.isArray(g.boards) || g.boards.length !== 9)) return false;
    if (g.mode === 'vanish' && (!g.queues || !Array.isArray(g.queues.X) || !Array.isArray(g.queues.O))) return false;
    return true;
  } catch { return false; }
}
