// Basin — core game logic. Pure JS, no DOM: used by index.html and by tests (node).
//
// The board is a hexagon of radius R (axial coordinates). Every cell has a height
// 0..6. Each player owns a fixed spring cell. Water spreads from each spring with a
// "momentum" budget: flowing downhill resets momentum, flowing flat costs 1, flowing
// uphill is impossible. A cell reached by exactly one player's water is that player's
// territory. Reaching the enemy spring wins instantly; otherwise most territory after
// the move budget wins.

const R = 4;
const H_MIN = 0;
const H_MAX = 6;
const H_START = 3;
const MOMENTUM = 2;
const MOVES_EACH = 20;

const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

function key(q, r) { return q + ',' + r; }

function hexDist(aq, ar, bq, br) {
  const dq = aq - bq, dr = ar - br;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

function makeBoard() {
  const cells = new Map();
  for (let q = -R; q <= R; q++) {
    for (let r = -R; r <= R; r++) {
      if (Math.abs(q + r) <= R) cells.set(key(q, r), { q, r, h: H_START });
    }
  }
  return cells;
}

// Label-correcting max-momentum search from a spring.
// Returns Map of cellKey -> best momentum on arrival (presence = watered).
// Springs are open wells: water in any adjacent cell pours in regardless of height
// (that is how a spring gets flooded), but water never flows OUT of a foreign spring.
function computeFlow(cells, spring, springs) {
  const best = new Map();
  const sk = key(spring.q, spring.r);
  const springKeys = new Set((springs || []).map(s => key(s.q, s.r)));
  best.set(sk, MOMENTUM);
  const queue = [sk];
  while (queue.length) {
    const k = queue.shift();
    if (springKeys.has(k) && k !== sk) continue; // pour into a foreign spring, stop there
    const m = best.get(k);
    const c = cells.get(k);
    for (const [dq, dr] of DIRS) {
      const nk = key(c.q + dq, c.r + dr);
      const n = cells.get(nk);
      if (!n) continue;
      let m2;
      if (springKeys.has(nk)) m2 = MOMENTUM;      // wells always accept water
      else if (n.h < c.h) m2 = MOMENTUM;
      else if (n.h === c.h) m2 = m - 1;
      else continue;
      if (m2 < 0) continue;
      if ((best.has(nk) ? best.get(nk) : -1) >= m2) continue;
      best.set(nk, m2);
      queue.push(nk);
    }
  }
  return best;
}

// BFS wave order over the watered set, for staggered animation.
// Returns Map of cellKey -> step (0 at the spring).
function flowSteps(cells, spring, watered) {
  const steps = new Map();
  const sk = key(spring.q, spring.r);
  if (!watered.has(sk)) return steps;
  steps.set(sk, 0);
  const queue = [sk];
  while (queue.length) {
    const k = queue.shift();
    const d = steps.get(k);
    const c = cells.get(k);
    for (const [dq, dr] of DIRS) {
      const nk = key(c.q + dq, c.r + dr);
      if (!watered.has(nk) || steps.has(nk)) continue;
      steps.set(nk, d + 1);
      queue.push(nk);
    }
  }
  return steps;
}

function newGame() {
  const g = {
    cells: makeBoard(),
    springs: [{ q: 0, r: R }, { q: 0, r: -R }], // player 0 bottom, player 1 top
    turn: 0,
    movesLeft: [MOVES_EACH, MOVES_EACH],
    winner: null, // 0 | 1 | -1 draw
    winBy: null,  // 'flood' | 'land'
    flows: null,
  };
  refreshFlows(g);
  return g;
}

function refreshFlows(g) {
  g.flows = [
    computeFlow(g.cells, g.springs[0], g.springs),
    computeFlow(g.cells, g.springs[1], g.springs),
  ];
}

// -1 none, 0/1 owned, 2 contested
function ownerOf(g, k) {
  const a = g.flows[0].has(k), b = g.flows[1].has(k);
  if (a && b) return 2;
  if (a) return 0;
  if (b) return 1;
  return -1;
}

function counts(g) {
  const c = [0, 0, 0];
  for (const k of g.cells.keys()) {
    const o = ownerOf(g, k);
    if (o >= 0) c[o]++;
  }
  return c; // [p0, p1, contested]
}

function isSpring(g, q, r) {
  return g.springs.some(s => s.q === q && s.r === r);
}

function legalMove(g, q, r, delta) {
  if (g.winner !== null) return false;
  if (g.movesLeft[g.turn] <= 0) return false;
  const c = g.cells.get(key(q, r));
  if (!c || isSpring(g, q, r)) return false;
  const h2 = c.h + delta;
  return h2 >= H_MIN && h2 <= H_MAX;
}

function applyMove(g, q, r, delta) {
  if (!legalMove(g, q, r, delta)) return false;
  const mover = g.turn;
  g.cells.get(key(q, r)).h += delta;
  g.movesLeft[mover]--;
  refreshFlows(g);

  const enemy = 1 - mover;
  const enemySpringKey = key(g.springs[enemy].q, g.springs[enemy].r);
  const mySpringKey = key(g.springs[mover].q, g.springs[mover].r);
  if (g.flows[mover].has(enemySpringKey)) {
    g.winner = mover; g.winBy = 'flood';
  } else if (g.flows[enemy].has(mySpringKey)) {
    g.winner = enemy; g.winBy = 'flood'; // mover flooded their own spring
  } else if (g.movesLeft[0] === 0 && g.movesLeft[1] === 0) {
    const c = counts(g);
    g.winner = c[0] > c[1] ? 0 : c[1] > c[0] ? 1 : -1;
    g.winBy = 'land';
  } else {
    g.turn = enemy;
  }
  return true;
}

// Greedy 1-ply AI for the given player (normally 1). Scores every legal move by
// simulated flow; prefers instant wins, avoids handing the opponent a flood,
// then maximises territory and pressure toward the enemy spring.
function aiPickMove(g, me) {
  const foe = 1 - me;
  const mySpring = g.springs[me], foeSpring = g.springs[foe];
  const mySpringKey = key(mySpring.q, mySpring.r);
  const foeSpringKey = key(foeSpring.q, foeSpring.r);

  let bestScore = -Infinity;
  let bestMoves = [];
  for (const c of g.cells.values()) {
    for (const delta of [-1, 1]) {
      if (!legalMove(g, c.q, c.r, delta)) continue;
      c.h += delta;
      const fMe = computeFlow(g.cells, g.springs[me], g.springs);
      const fFoe = computeFlow(g.cells, g.springs[foe], g.springs);
      let s = 0;
      if (fMe.has(foeSpringKey)) s = 1e6;
      else {
        if (fFoe.has(mySpringKey)) s -= 5e5;
        for (const k of g.cells.keys()) {
          const a = fMe.has(k), b = fFoe.has(k);
          if (a && !b) s += 10;
          else if (b && !a) s -= 10;
        }
        // pressure: closest watered cell to each spring
        let dAtk = Infinity, dDef = Infinity;
        for (const k of fMe.keys()) {
          const cc = g.cells.get(k);
          dAtk = Math.min(dAtk, hexDist(cc.q, cc.r, foeSpring.q, foeSpring.r));
        }
        for (const k of fFoe.keys()) {
          const cc = g.cells.get(k);
          dDef = Math.min(dDef, hexDist(cc.q, cc.r, mySpring.q, mySpring.r));
        }
        s += (2 * R - dAtk) * 6 - (2 * R - dDef) * 8;
      }
      c.h -= delta;
      if (s > bestScore) { bestScore = s; bestMoves = [{ q: c.q, r: c.r, delta }]; }
      else if (s === bestScore) bestMoves.push({ q: c.q, r: c.r, delta });
    }
  }
  if (!bestMoves.length) return null;
  return bestMoves[Math.floor(Math.random() * bestMoves.length)];
}

const Basin = {
  R, H_MIN, H_MAX, H_START, MOMENTUM, MOVES_EACH, DIRS,
  key, hexDist, makeBoard, computeFlow, flowSteps,
  newGame, refreshFlows, ownerOf, counts, isSpring, legalMove, applyMove, aiPickMove,
};

if (typeof module !== 'undefined' && module.exports) module.exports = Basin;
if (typeof window !== 'undefined') window.Basin = Basin;
