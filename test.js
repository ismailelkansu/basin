// Basin logic tests — run with: node test.js
const B = require('./game.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

// --- 1. Fresh board: symmetric starting pools, no contact ---
{
  const g = B.newGame();
  check('board has 61 cells', g.cells.size === 61, g.cells.size);
  const c = B.counts(g);
  check('start pools symmetric', c[0] === c[1], JSON.stringify(c));
  check('start pools exist', c[0] > 0, c[0]);
  check('no contested cells at start', c[2] === 0, c[2]);
  // momentum 2 on flat ground => spring + dist1 + dist2
  const expected = [...g.cells.values()]
    .filter(c2 => B.hexDist(c2.q, c2.r, 0, B.R) <= B.MOMENTUM).length;
  check('start pool = cells within dist ' + B.MOMENTUM, c[0] === expected, c[0] + ' vs ' + expected);
  check('no winner at start', g.winner === null);
}

// --- 2. A raised ring seals a spring, choking its own water too ---
{
  const g = B.newGame();
  for (const [dq, dr] of B.DIRS) {
    const cell = g.cells.get(B.key(0 + dq, -B.R + dr));
    if (cell) cell.h = B.H_START + 1;
  }
  B.refreshFlows(g);
  check('sealed spring waters only itself', g.flows[1].size === 1, g.flows[1].size);
}

// --- 3. A dug channel carries water across the board ---
{
  const g = B.newGame();
  // depths along q=0 chosen so momentum never runs out:
  // 3 -> 2,2,2 (drop resets) -> 1,1,1 -> 0
  const depths = new Map([[3, 2], [2, 2], [1, 2], [0, 1], [-1, 1], [-2, 1], [-3, 0]]);
  for (const [r, h] of depths) g.cells.get(B.key(0, r)).h = h;
  B.refreshFlows(g);
  check('channel waters (0,-3)', g.flows[0].has(B.key(0, -3)));
  // (0,-3) is adjacent to the top spring, and springs are open wells:
  check('water pours into the enemy spring', g.flows[0].has(B.key(0, -B.R)));
}

// --- 4. Flood win through the public API ---
{
  const g = B.newGame();
  const depths = new Map([[3, 2], [2, 2], [1, 2], [0, 1], [-1, 1], [-2, 1], [-3, 1]]);
  for (const [r, h] of depths) g.cells.get(B.key(0, r)).h = h;
  B.refreshFlows(g);
  check('not flooded yet ((0,-3) dry: flat from m=0)', !g.flows[0].has(B.key(0, -B.R)));
  check('it is player 0 turn', g.turn === 0);
  const ok = B.applyMove(g, 0, -3, -1); // dig 1 -> 0: water drops in, reaches the well
  check('final dig accepted', ok);
  check('player 0 wins', g.winner === 0, g.winner);
  check('win by flood', g.winBy === 'flood', g.winBy);
  check('no more moves accepted after win', !B.applyMove(g, 2, 0, -1));
}

// --- 5. No 1-move flood from the start position (brute force) ---
{
  const g = B.newGame();
  const topSpringKey = B.key(0, -B.R);
  let reachable = false;
  for (const c of g.cells.values()) {
    if (B.isSpring(g, c.q, c.r)) continue;
    for (const d of [-1, 1]) {
      const h2 = c.h + d;
      if (h2 < B.H_MIN || h2 > B.H_MAX) continue;
      c.h = h2;
      if (B.computeFlow(g.cells, g.springs[0], g.springs).has(topSpringKey)) reachable = true;
      c.h -= d;
    }
  }
  check('no instant flood exists from a fresh board', !reachable);
}

// --- 6. Springs cannot be edited; height limits enforced ---
{
  const g = B.newGame();
  check('cannot dig a spring', !B.legalMove(g, 0, B.R, -1));
  check('cannot fill a spring', !B.legalMove(g, 0, -B.R, 1));
  g.cells.get(B.key(2, 0)).h = B.H_MAX;
  check('cannot fill past H_MAX', !B.legalMove(g, 2, 0, 1));
  g.cells.get(B.key(2, 0)).h = B.H_MIN;
  check('cannot dig below H_MIN', !B.legalMove(g, 2, 0, -1));
}

// --- 7. Move limit ends the game with a land winner ---
{
  const g = B.newGame();
  const spots = [...g.cells.values()].filter(c => !B.isSpring(g, c.q, c.r));
  let i = 0, guard = 0;
  while (g.winner === null && guard++ < 500) {
    const c = spots[i++ % spots.length];
    const d = B.legalMove(g, c.q, c.r, -1) ? -1 : (B.legalMove(g, c.q, c.r, 1) ? 1 : 0);
    if (d === 0) continue;
    B.applyMove(g, c.q, c.r, d);
  }
  check('game ends after move budgets', g.winner !== null, g.winner);
  check('budgets exhausted', g.movesLeft[0] === 0 && g.movesLeft[1] === 0,
    JSON.stringify(g.movesLeft));
}

// --- 8. AI returns a legal move and does not hurt itself ---
{
  const g = B.newGame();
  B.applyMove(g, 1, 2, -1); // human digs once
  check("after human move it is AI's turn", g.turn === 1);
  const before = B.counts(g);
  const mv = B.aiPickMove(g, 1);
  check('AI found a move', mv !== null, JSON.stringify(mv));
  check('AI move is legal', mv && B.legalMove(g, mv.q, mv.r, mv.delta));
  B.applyMove(g, mv.q, mv.r, mv.delta);
  const after = B.counts(g);
  check('AI did not lose territory', after[1] >= before[1], before[1] + ' -> ' + after[1]);
}

// --- 9. AI defends an imminent flood ---
{
  const g = B.newGame();
  // build player 0's channel almost reaching the TOP spring; one dig from winning
  const depths = new Map([[3, 2], [2, 2], [1, 2], [0, 1], [-1, 1], [-2, 1]]);
  for (const [r, h] of depths) g.cells.get(B.key(0, r)).h = h;
  B.refreshFlows(g);
  g.turn = 1;
  const mv = B.aiPickMove(g, 1);
  check('AI found a defensive move', mv !== null, JSON.stringify(mv));
  B.applyMove(g, mv.q, mv.r, mv.delta);
  // whatever it did, the human's winning dig must no longer win on the spot
  const dig = B.legalMove(g, 0, -3, -1);
  if (dig) {
    B.applyMove(g, 0, -3, -1);
    check('AI prevented the instant flood', g.winner !== 0, 'winner=' + g.winner + ' by ' + g.winBy);
  } else {
    check('AI blocked the digging square itself', true);
  }
}

// --- 10. AI vs AI full game finishes without errors ---
{
  const g = B.newGame();
  let guard = 0;
  while (g.winner === null && guard++ < 100) {
    const mv = B.aiPickMove(g, g.turn);
    if (!mv) break;
    B.applyMove(g, mv.q, mv.r, mv.delta);
  }
  check('AI vs AI game completes', g.winner !== null,
    'winner=' + g.winner + ' by=' + g.winBy + ' guard=' + guard);
  console.log('      (AI vs AI result: winner=' + g.winner + ' by=' + g.winBy +
    ' counts=' + JSON.stringify(B.counts(g)) + ')');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
