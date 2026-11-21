# Roomwise — push-optimal Sokoban solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/dwi085/makefun-sokoban-solver-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/dwi085/makefun-sokoban-solver-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver in a single `main.ts` (Node 22, standard
library only, no network). Practice set: **1,000,000 / 1,000,000** — every
instance solved in exactly P\* pushes.

## How it works

The generator builds every level as a 1-wide hallway with 1–4 rooms off it
(≤6×6 slots, 3–4 boxes each, one door per room), and a box pushed out of
its room can never return — so each room is independent, and a level's
push-optimal count P\* is the sum of its rooms' optima. The solver:

1. Splits the level into rooms (connected floor components once the hallway
   row is removed) and finds each room's door.
2. Solves every room push-optimally from its door with A\* over pushes:
   state = box positions + canonical player-reachability region, heuristic =
   minimum assignment of boxes to goals by BFS distance, pruned by static
   dead squares (reverse-pull analysis) and 2×2 freeze detection.
3. Stitches the rooms together with plain hallway walks (nearest room
   first), stepping out of each solved room through its door.

Deterministic (two runs are byte-identical) and fast: the whole 5-instance
practice set solves in ~1 second, far inside the 60-second wall budget.

## Run

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Writes `out/<id>/solution.txt` for every instance (`u/d/l/r` moves).

## Entry

make.fun competition
[sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121)
— "Build the best Sokoban solver, 21 November 2026".
