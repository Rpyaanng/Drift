#!/usr/bin/env node
// Sketch & Guess's rules (sketch.js), in plain Node with a fake clock and a short word list: a second, no Electron.
//   node scripts/test-sketch-engine.js
const { createTable, inkOp, norm, near } = require('../sketch.js');

let fails = 0, passes = 0;
const ok = (name, cond, extra) => { if (cond) passes++; else { fails++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); } };

function table(opts = {}) {
  const clock = { t: 1000000 };
  const t = createTable({ now: () => clock.t, rand: () => 0, words: ['ice cream', 'giraffe', 'boat', 'castle', 'kite', 'robot', 'snail', 'lamp', 'tent', 'drum', 'cake', 'owl'], ...opts });
  t.clock = clock;
  t.wait = (ms) => { clock.t += ms; t.tick(); };
  t.v = (id) => t.view(id);
  t.drawerId = () => { const v = t.view('x'); return v.drawer >= 0 ? v.players[v.drawer].id : ''; };
  t.go = (id, m) => t.move(id, m);
  return t;
}
const begin = (t) => { t.tick(); t.wait(5000); };

// ---- words and drawing ops ----
ok('guesses are compared loosely', norm('  Ice-Cream! ') === 'ice cream');
ok('one letter off is close', near('giraffe', 'girafe') && near('giraffe', 'giraffes') && near('giraffe', 'giarffe') && !near('giraffe', 'gorilla'));
ok('a pen stroke', JSON.stringify(inkOp({ k: 'pen', c: 3, w: 1, s: 7, p: [10, 20, 30, 40], q: 1 })) === '{"k":"pen","c":3,"w":1,"s":7,"p":[10,20,30,40],"q":1}');
ok('off the sheet is clamped', inkOp({ k: 'rect', c: 0, w: 0, s: 1, f: 2, p: [-50, 20, 9999, 2000] }).p.join() === '0,20,1600,1000');
ok('a shape needs two corners', inkOp({ k: 'rect', p: [1, 2, 3] }) === null);
ok('no unknown kinds', inkOp({ k: 'text', p: [1, 2] }) === null && inkOp(null) === null);
ok('too long a stroke piece', inkOp({ k: 'pen', p: new Array(200).fill(5) }) === null);
ok('eraser', inkOp({ k: 'pen', e: true, p: [1, 1] }).e === 1);

// ---- a game ----
{
  const t = table(); t.sit('a', 'Ann');
  ok('one person waits', t.phase === 'waiting');
  t.tick(); t.wait(10000);
  ok('...and keeps waiting (it needs people)', t.phase === 'waiting');
  t.sit('b', 'Bo'); t.sit('c', 'Cy');
  begin(t);
  ok('a game starts: the first to come draws first', t.phase === 'choosing' && t.drawerId() === 'a');
  ok('the drawer gets three words', t.v('a').choices.length === 3);
  ok('nobody else sees them', t.v('b').choices.length === 0 && t.v('b').word === '');
  ok('only the drawer picks', !!t.go('b', { do: 'pick', key: 0 }).error);
  ok('pick', !t.go('a', { do: 'pick', key: 1 }).error && t.phase === 'drawing');
  const word = t._word();
  ok('the drawer sees the word', t.v('a').word === word);
  ok('guessers see blanks', t.v('b').hint.every((c) => c === null) && t.v('b').hint.length === word.length && t.v('b').word === '');
  ok('drawing', !t.go('a', { do: 'ink', op: { k: 'pen', c: 0, w: 1, s: 1, p: [100, 100, 200, 200] } }).error && t.inkLen === 1);
  ok('only the drawer draws', !!t.go('b', { do: 'ink', op: { k: 'pen', p: [1, 1] } }).error && t.inkLen === 1);
  ok('the drawing comes as it grows', t.ink(0).length === 1 && t.ink(1).length === 0);
  ok('the drawer can\'t type clues', !!t.go('a', { do: 'guess', text: 'it is a ' + word }).error);
  t.go('b', { do: 'guess', text: 'horse' });
  ok('a wrong guess shows for everyone', t.v('c').feed.some((e) => e.kind === 'guess' && e.text === 'horse' && e.who === 'Bo'));
  t.go('b', { do: 'guess', text: word.slice(0, -1) });
  ok('a close guess: told only to the guesser', t.v('b').feed.some((e) => e.kind === 'close') && !t.v('c').feed.some((e) => e.kind === 'close'));
  t.wait(10000);
  ok('right!', t.go('b', { do: 'guess', text: word.toUpperCase() }).right);
  const vb = t.v('b'), vc = t.v('c');
  ok('the guesser now sees the word', vb.word === word);
  ok('the others don\'t, and never see the guess itself', vc.word === '' && !vc.feed.some((e) => norm(e.text) === norm(word)) && vc.feed.some((e) => e.kind === 'right' && e.who === 'Bo'));
  ok('points: sooner is more, and the first gets a bonus', vb.players[1].score === 50 + Math.round(50 * 70 / 80) + 10, vb.players[1]);
  ok('the drawer scores for each guess', vb.players[0].score === 25);
  t.go('b', { do: 'guess', text: 'ha nice drawing' });
  ok('once you know it, your messages are for those who know', t.v('a').feed.some((e) => e.text === 'ha nice drawing') && !t.v('c').feed.some((e) => e.text === 'ha nice drawing'));
  t.wait(30000);
  ok('a letter is shown at half time', t.v('c').hint.filter((c, i) => c !== null && word[i] !== ' ').length === 1, t.v('c').hint);
  t.go('c', { do: 'guess', text: word });
  ok('everyone guessed: the turn ends', t.phase === 'reveal' && t.v('c').feed.some((e) => e.kind === 'reveal'));
  ok('later guessers score less', t.v('c').players[2].score < t.v('c').players[1].score);
  t.wait(6000);
  ok('next drawer, a new sheet', t.drawerId() === 'b' && t.phase === 'choosing' && t.inkLen === 0);
  t.wait(15000);
  ok('out of time picking: one is picked for them', t.phase === 'drawing');
  t.wait(80000);
  ok('out of time drawing: the word is shown', t.phase === 'reveal' && t.v('a').word !== '');
  t.wait(6000);
  ok('third drawer', t.drawerId() === 'c');
  t.leave('c');
  ok('the drawer leaving ends the turn', t.phase === 'reveal');
  t.wait(6000);
  ok('round two', t.v('a').round === 2 && t.drawerId() === 'a');
  // play out the rest quickly: every turn times out
  for (let i = 0; i < 40 && t.phase !== 'over'; i++) t.wait(20000);
  ok('three rounds, then the final scores', t.phase === 'over' && t.v('a').standings.length === 2);
  t.wait(12000);
  ok('then a new game waits to start', t.phase === 'waiting');
  begin(t);
  ok('...and starts, scores back to 0', t.phase === 'choosing' && t.v('a').players.every((p) => p.score === 0));
}
{ // settle and records; someone coming partway through
  const got = [];
  const t = table({ onSettle: (l) => got.push(...l), rules: { rounds: 1 } });
  t.sit('a', 'Ann'); t.sit('b', 'Bo'); begin(t);
  t.go('a', { do: 'pick', key: 0 });
  t.sit('c', 'Cy');
  ok('someone arriving partway joins in', t.v('c').you === 2 && t.v('c').players.length === 3);
  t.go('b', { do: 'guess', text: t._word() });
  t.go('c', { do: 'guess', text: t._word() });
  ok('...and can guess', t.v('c').players[2].score > 0);
  for (let i = 0; i < 20 && t.phase !== 'over'; i++) t.wait(20000);
  ok('they don\'t draw in a round they came into partway', t.phase === 'over');
  ok('settle reports every score', got.length === 3 && got.find((x) => x.id === 'b').score > 0, got);
}
{ // leaving
  const t = table(); t.sit('a', 'Ann'); t.sit('b', 'Bo'); begin(t);
  t.leave('b');
  ok('one left: the game stops', t.phase === 'waiting');
  t.leave('a');
  ok('nobody: idle', t.phase === 'idle');
  const u = table();
  for (let i = 0; i < 12; i++) u.sit('p' + i, 'P' + i);
  ok('a thirteenth waits', u.sit('x', 'X').watching && u.v('x').watching === 0);
  u.leave('p0');
  ok('...and comes in', u.v('x').you >= 0);
}
{ // the drawing's limit
  const t = table(); t.sit('a', 'Ann'); t.sit('b', 'Bo'); begin(t); t.go('a', { do: 'pick', key: 0 });
  let err = '';
  for (let i = 0; i < 6100 && !err; i++) err = t.go('a', { do: 'ink', op: { k: 'pen', s: i, p: [1, 1] } }).error || '';
  ok('a drawing can\'t grow forever', /full/.test(err) && t.inkLen === 6000);
}

console.log(fails ? `${fails} failed, ${passes} passed` : `all ${passes} passed`);
process.exit(fails ? 1 : 0);
