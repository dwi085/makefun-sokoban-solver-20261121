// Sokoban solver for make.fun sokoban-solver-01-run-20261121.
// Strategy: the generator guarantees a 1-wide hallway with 1-4 rooms off it
// (slots of at most 6x6, 3-4 boxes each, one door per room). A box pushed out
// of its room can never return, so every room is independent: solve each room
// push-optimally from its door with A* over pushes, then stitch the rooms
// together with plain hallway walks. A level's push-optimal count P* is the
// sum of its rooms' optima, so per-room optimality is level optimality.
// Node 22, standard library only. Deterministic: fixed iteration order and
// node-count budgets only -- no clock, no environment reads, no randomness.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const DR = [-1, 1, 0, 0];
const DC = [0, 0, -1, 1];
const MV = ['u', 'd', 'l', 'r'];

interface Level {
  w: number;
  h: number;
  floor: boolean[];
  boxes: number[];
  goals: Set<number>;
  player: number;
}

function parseLevel(text: string): Level {
  const lines = text.split('\n').filter((l) => l.length > 0);
  const h = lines.length;
  const w = Math.max(...lines.map((l) => l.length));
  const floor: boolean[] = new Array(w * h).fill(false);
  const boxes: number[] = [];
  const goals = new Set<number>();
  let player = -1;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = c < lines[r].length ? lines[r][c] : '#';
      const i = r * w + c;
      if (ch === '#') continue;
      floor[i] = true;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '.' || ch === '*' || ch === '+') goals.add(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  return { w, h, floor, boxes, goals, player };
}

interface Room {
  cells: number[]; // global indices, sorted
  set: Set<number>;
  boxes: number[];
  goals: number[];
  door: number; // room cell adjacent to the hallway
  entry: number; // hallway cell adjacent to the door
}

// Split the level into rooms: connected floor components once the hallway
// row (the row the player starts on) is removed. Each component is one room.
function findRooms(lv: Level): Room[] {
  const hallRow = Math.floor(lv.player / lv.w);
  const seen = new Set<number>();
  const rooms: Room[] = [];
  for (let i = 0; i < lv.w * lv.h; i++) {
    if (!lv.floor[i] || Math.floor(i / lv.w) === hallRow || seen.has(i)) continue;
    const cells: number[] = [];
    const stack = [i];
    seen.add(i);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      cells.push(cur);
      const r = Math.floor(cur / lv.w);
      const c = cur % lv.w;
      for (let d = 0; d < 4; d++) {
        const nr = r + DR[d];
        const nc = c + DC[d];
        if (nr < 0 || nr >= lv.h || nc < 0 || nc >= lv.w) continue;
        const ni = nr * lv.w + nc;
        if (!lv.floor[ni] || nr === hallRow || seen.has(ni)) continue;
        seen.add(ni);
        stack.push(ni);
      }
    }
    cells.sort((a, b) => a - b);
    const set = new Set(cells);
    const boxes = lv.boxes.filter((b) => set.has(b));
    if (boxes.length === 0) continue;
    const goals = [...lv.goals].filter((g) => set.has(g)).sort((a, b) => a - b);
    let door = -1;
    let entry = -1;
    outer: for (const cell of cells) {
      const r = Math.floor(cell / lv.w);
      const c = cell % lv.w;
      for (let d = 0; d < 4; d++) {
        const nr = r + DR[d];
        const nc = c + DC[d];
        if (nr !== hallRow || nr < 0 || nr >= lv.h || nc < 0 || nc >= lv.w) continue;
        const ni = nr * lv.w + nc;
        if (lv.floor[ni]) {
          door = cell;
          entry = ni;
          break outer;
        }
      }
    }
    if (door < 0) continue;
    rooms.push({ cells, set, boxes, goals, door, entry });
  }
  return rooms;
}

interface RoomCtx {
  n: number; // room cells; local index n is the porch (entry hallway cell)
  neigh: number[][]; // neigh[local][dir] -> local index or -1
  dist: number[][]; // dist[cellLocal][goalIdx] via BFS over room cells
  dead: boolean[]; // dead[cellLocal]: box here can never reach a goal
  goalsLocal: number[];
  doorLocal: number;
  // 2x2 blocks: each entry is { local: room-cell index or -1, wall: true
  // when the global cell is not floor at all (a floor cell outside the room
  // is never solid, so such a block can never freeze).
  blocks: { local: number; wall: boolean }[][];
}

// BFS distances from one room cell over room cells only.
function bfsDist(start: number, neigh: number[][], n: number): number[] {
  const dist = new Array<number>(n).fill(Infinity);
  dist[start] = 0;
  const q = [start];
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    for (let d = 0; d < 4; d++) {
      const nb = neigh[cur][d];
      if (nb < 0 || nb >= n || dist[nb] !== Infinity) continue;
      dist[nb] = dist[cur] + 1;
      q.push(nb);
    }
  }
  return dist;
}

// Static dead squares by reverse pulls: a cell is live when a box there can
// still be pushed toward a goal. Start from the goals; a cell s becomes live
// when some neighbour s+d is live and the player could stand at s-d.
function computeDead(goalsLocal: number[], neigh: number[][], n: number): boolean[] {
  const live = new Array<boolean>(n).fill(false);
  for (const g of goalsLocal) live[g] = true;
  let changed = true;
  while (changed) {
    changed = false;
    for (let s = 0; s < n; s++) {
      if (live[s]) continue;
      for (let d = 0; d < 4; d++) {
        const fwd = neigh[s][d];
        const back = neigh[s][d ^ 1];
        if (fwd >= 0 && fwd < n && live[fwd] && back >= 0) {
          live[s] = true;
          changed = true;
          break;
        }
      }
    }
  }
  return live.map((v) => !v);
}

function buildRoomCtx(room: Room, lv: Level): RoomCtx {
  const n = room.cells.length;
  const porch = n;
  const localOf = new Map<number, number>();
  room.cells.forEach((g, i) => localOf.set(g, i));
  const neigh: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const g = i < n ? room.cells[i] : room.entry;
    const r = Math.floor(g / lv.w);
    const c = g % lv.w;
    const row: number[] = [];
    for (let d = 0; d < 4; d++) {
      const nr = r + DR[d];
      const nc = c + DC[d];
      let nb = -1;
      if (nr >= 0 && nr < lv.h && nc >= 0 && nc < lv.w) {
        const ni = nr * lv.w + nc;
        if (localOf.has(ni)) nb = localOf.get(ni)!;
        else if (ni === room.entry) nb = porch;
      }
      row.push(nb);
    }
    neigh.push(row);
  }
  const goalsLocal = room.goals.map((g) => localOf.get(g)!).sort((a, b) => a - b);
  const doorLocal = localOf.get(room.door)!;
  const dist = goalsLocal.map((g) => bfsDist(g, neigh, n));
  // dist[cell][goal] = transpose of per-goal BFS results
  const cellDist: number[][] = [];
  for (let c = 0; c < n; c++) {
    cellDist.push(goalsLocal.map((_, gi) => dist[gi][c]));
  }
  const dead = computeDead(goalsLocal, neigh, n);
  const blocks: { local: number; wall: boolean }[][] = [];
  for (let r = 0; r + 1 < lv.h; r++) {
    for (let c = 0; c + 1 < lv.w; c++) {
      const quad: { local: number; wall: boolean }[] = [];
      let touches = false;
      for (const [rr, cc] of [[r, c], [r, c + 1], [r + 1, c], [r + 1, c + 1]]) {
        const gi = rr * lv.w + cc;
        if (localOf.has(gi)) {
          quad.push({ local: localOf.get(gi)!, wall: false });
          touches = true;
        } else {
          quad.push({ local: -1, wall: !lv.floor[gi] });
        }
      }
      if (touches) blocks.push(quad);
    }
  }
  return { n, neigh, dist: cellDist, dead, goalsLocal, doorLocal, blocks };
}

// Cells the player can reach from `start` with `boxes` (local) as obstacles.
function reachableFrom(start: number, boxes: Set<number>, neigh: number[][]): Set<number> {
  const seen = new Set<number>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (let d = 0; d < 4; d++) {
      const nb = neigh[cur][d];
      if (nb < 0 || seen.has(nb) || boxes.has(nb)) continue;
      seen.add(nb);
      stack.push(nb);
    }
  }
  return seen;
}

// Canonical player position for a state: the smallest local index of the
// player's reachable region. Two player spots in one region are equivalent.
function canonPlayer(start: number, boxes: Set<number>, neigh: number[][]): number {
  let best = start;
  for (const cell of reachableFrom(start, boxes, neigh)) {
    if (cell < best) best = cell;
  }
  return best;
}

// Shortest walk from `start` to `target` (local indices), boxes as obstacles.
function walkPath(start: number, target: number, boxes: Set<number>, neigh: number[][]): string | null {
  if (start === target) return '';
  const prev = new Map<number, [number, string]>();
  const q = [start];
  prev.set(start, [-1, '']);
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    for (let d = 0; d < 4; d++) {
      const nb = neigh[cur][d];
      if (nb < 0 || prev.has(nb) || boxes.has(nb)) continue;
      prev.set(nb, [cur, MV[d]]);
      if (nb === target) {
        let s = '';
        let node = nb;
        while (node !== start) {
          const [p, m] = prev.get(node)!;
          s = m + s;
          node = p;
        }
        return s;
      }
      q.push(nb);
    }
  }
  return null;
}

// Minimum assignment cost of boxes to goals (brute-force permutations;
// at most 4 boxes). Infinity when some box cannot reach any goal.
function heuristic(boxes: number[], dist: number[][], goalCount: number): number {
  let best = Infinity;
  const used = new Array<boolean>(goalCount).fill(false);
  const rec = (bi: number, sum: number): void => {
    if (sum >= best) return;
    if (bi === boxes.length) {
      best = sum;
      return;
    }
    for (let g = 0; g < goalCount; g++) {
      if (used[g]) continue;
      const d = dist[boxes[bi]][g];
      if (d === Infinity) continue;
      used[g] = true;
      rec(bi + 1, sum + d);
      used[g] = false;
    }
  };
  rec(0, 0);
  return best;
}

interface NodeRec {
  boxes: number[];
  player: number; // actual local position
  g: number;
  parent: string | null;
  step: string; // moves from parent state to this state
}

const MAX_EXPANSIONS = 2000000; // per room, deterministic work budget

// Push-optimal A* for one room. The player starts on the porch (the hallway
// cell outside the door). Returns the full move string (walks + pushes +
// exit walk to the door), or null when unsolved within the budget.
function solveRoom(room: Room, lv: Level): string | null {
  const ctx = buildRoomCtx(room, lv);
  const { n, neigh, dist, dead, goalsLocal, doorLocal, blocks } = ctx;
  const porch = n;
  const goalSet = new Set(goalsLocal);
  const startBoxes = room.boxes
    .map((g) => room.cells.indexOf(g))
    .sort((a, b) => a - b);
  const keyOf = (boxes: number[], canon: number): string =>
    boxes.join(',') + '|' + canon;

  const frozen = (boxSet: Set<number>): boolean => {
    for (const quad of blocks) {
      let allSolid = true;
      let badBox = false;
      for (const e of quad) {
        if (e.local >= 0) {
          if (!boxSet.has(e.local)) {
            allSolid = false;
            break;
          }
          if (!goalSet.has(e.local)) badBox = true;
        } else if (!e.wall) {
          allSolid = false;
          break;
        }
      }
      if (allSolid && badBox) return true;
    }
    return false;
  };

  // Binary heap of [f, seq, key]; seq breaks ties deterministically.
  const heap: [number, number, string][] = [];
  let seq = 0;
  const heapPush = (item: [number, number, string]): void => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] < heap[i][0] || (heap[p][0] === heap[i][0] && heap[p][1] < heap[i][1])) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const heapPop = (): [number, number, string] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && (heap[l][0] < heap[m][0] || (heap[l][0] === heap[m][0] && heap[l][1] < heap[m][1]))) m = l;
        if (r < heap.length && (heap[r][0] < heap[m][0] || (heap[r][0] === heap[m][0] && heap[r][1] < heap[m][1]))) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };

  const nodes = new Map<string, NodeRec>();
  const best = new Map<string, number>();
  const startBoxSet = new Set(startBoxes);
  const startCanon = canonPlayer(porch, startBoxSet, neigh);
  const startKey = keyOf(startBoxes, startCanon);
  nodes.set(startKey, { boxes: startBoxes, player: porch, g: 0, parent: null, step: '' });
  best.set(startKey, 0);
  heapPush([heuristic(startBoxes, dist, goalsLocal.length), seq++, startKey]);

  let expansions = 0;
  while (heap.length > 0) {
    const [, , key] = heapPop();
    const node = nodes.get(key)!;
    if (node.g !== best.get(key)) continue; // stale heap entry
    const boxSet = new Set(node.boxes);
    // Solved: every box on a goal and the player can still walk to the door.
    if (node.boxes.every((b) => goalSet.has(b))) {
      const exit = walkPath(node.player, doorLocal, boxSet, neigh);
      if (exit !== null) {
        const parts: string[] = [];
        let cur: NodeRec | undefined = node;
        let curKey: string | null = key;
        while (cur && curKey !== null) {
          parts.push(cur.step);
          curKey = cur.parent;
          cur = curKey !== null ? nodes.get(curKey) : undefined;
        }
        parts.reverse();
        return parts.join('') + exit;
      }
    }
    if (++expansions > MAX_EXPANSIONS) return null;
    const reach = reachableFrom(node.player, boxSet, neigh);
    for (const b of node.boxes) {
      for (let d = 0; d < 4; d++) {
        const stand = neigh[b][d ^ 1];
        if (stand < 0 || !reach.has(stand)) continue;
        const target = neigh[b][d];
        if (target < 0 || target >= n || boxSet.has(target)) continue;
        if (dead[target]) continue;
        const newBoxes = node.boxes.slice();
        newBoxes[newBoxes.indexOf(b)] = target;
        newBoxes.sort((x, y) => x - y);
        const newBoxSet = new Set(newBoxes);
        if (frozen(newBoxSet)) continue;
        const h = heuristic(newBoxes, dist, goalsLocal.length);
        if (h === Infinity) continue;
        const newPlayer = b;
        const newCanon = canonPlayer(newPlayer, newBoxSet, neigh);
        const newKey = keyOf(newBoxes, newCanon);
        const newG = node.g + 1;
        if ((best.get(newKey) ?? Infinity) <= newG) continue;
        const walk = walkPath(node.player, stand, boxSet, neigh);
        if (walk === null) continue;
        best.set(newKey, newG);
        nodes.set(newKey, {
          boxes: newBoxes,
          player: newPlayer,
          g: newG,
          parent: key,
          step: walk + MV[d],
        });
        heapPush([newG + h, seq++, newKey]);
      }
    }
  }
  return null;
}

// Shortest walk between two global cells over hallway floor (floor cells
// that belong to no room), returned as a move string, or null if unreachable.
function hallWalk(
  start: number,
  target: number,
  lv: Level,
  roomCells: Set<number>,
): string | null {
  if (start === target) return '';
  const prev = new Map<number, [number, string]>();
  const q = [start];
  prev.set(start, [-1, '']);
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    const r = Math.floor(cur / lv.w);
    const c = cur % lv.w;
    for (let d = 0; d < 4; d++) {
      const nr = r + DR[d];
      const nc = c + DC[d];
      if (nr < 0 || nr >= lv.h || nc < 0 || nc >= lv.w) continue;
      const ni = nr * lv.w + nc;
      if (!lv.floor[ni] || roomCells.has(ni) || prev.has(ni)) continue;
      prev.set(ni, [cur, MV[d]]);
      if (ni === target) {
        let s = '';
        let node = ni;
        while (node !== start) {
          const [p, m] = prev.get(node)!;
          s = m + s;
          node = p;
        }
        return s;
      }
      q.push(ni);
    }
  }
  return null;
}

function stepChar(from: number, to: number, w: number): string {
  const d = to - from;
  if (d === -w) return 'u';
  if (d === w) return 'd';
  if (d === -1) return 'l';
  return 'r';
}

// Solve one whole level: visit rooms nearest-first from the player's spot,
// walk the hallway to each door, solve the room, step back out.
function solveLevel(lv: Level): string {
  const rooms = findRooms(lv);
  const roomCells = new Set<number>();
  for (const room of rooms) for (const cell of room.cells) roomCells.add(cell);
  let cur = lv.player;
  let moves = '';
  const remaining = rooms.slice();
  while (remaining.length > 0) {
    let bestIdx = -1;
    let bestPath: string | null = null;
    for (let i = 0; i < remaining.length; i++) {
      const p = hallWalk(cur, remaining[i].entry, lv, roomCells);
      if (p !== null && (bestPath === null || p.length < bestPath.length)) {
        bestIdx = i;
        bestPath = p;
      }
    }
    if (bestIdx < 0) break; // no reachable room left; nothing more to gain
    const room = remaining.splice(bestIdx, 1)[0];
    moves += bestPath!;
    const sol = solveRoom(room, lv);
    if (sol === null) break; // room unsolved: the instance is lost anyway
    moves += sol;
    moves += stepChar(room.door, room.entry, lv.w);
    cur = room.entry;
  }
  return moves;
}

for (const id of readdirSync(IN_DIR).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8')));
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
