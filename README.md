# Spark

A zero-player programming game. Two players each write a **bot** that controls a
wizard, and author the **spells** that wizard can cast. Neither player touches
the game during a match — all skill expression lives in the code.

The distinguishing idea: spells are not a fixed list of effects. A spell is a
small declarative structure describing *matter to manifest and what it does on
impact*, and the engine prices it in mana according to physics. A fireball and an
ice knife are the same two operations with different materials, shapes and
velocities.

The full design is in [`docs/project-passport.md`](docs/project-passport.md).
Places where this implementation had to choose — because the passport left
something open or contradicted itself — are recorded in
[`docs/DECISIONS.md`](docs/DECISIONS.md).

## Try it

```bash
npm install
npm run build
npm test

# Run a match between the two example bots and record a replay
node apps/cli/dist/src/main.js run --seed spark --replay replays/demo.json

# Watch it
node apps/viewer-ascii/dist/src/main.js replays/demo.json

# Confirm the replay reproduces bit for bit
node apps/cli/dist/src/main.js verify replays/demo.json
```

`npm run demo` does the run-and-watch in one step.

## What a match looks like

```
SPARK  seed spark   round 1/4   turn 21/30   B acted (2 ms)   hash 7c1e0a4f38b2d509

                 b. : .<A
                 B.  ..
    ###         . ..
#######          ..
    ##       ..
~       ..           ~~~
~     ..         ###~~~~
                 ###
               :::::

A naive          HP [#-----------]   5  MANA [##--------]  25  MP 15  [195, 21] f4
B positional     HP [###---------]  29  MANA [#######---] 105  MP  9  [139, 24] f7

  B cast knife at [148,19] dir [48,1] speed 45 mass 7200g for 29.5 mana
  object 51 hit A at [189,20] for 15.7 HP (8/13 cells covered)
  A pushed 4 cells
```

## Writing a bot

A bot is any program that reads one JSON object per line on stdin and writes one
per line on stdout. The protocol is the contract; the SDK is convenience.

```ts
import { runBot, declaredTemperatureFor, shapeCellCount } from '@spark/sdk';

runBot({
  // Registered before the map is revealed, and locked for the whole match.
  spellbook: () => [{
    id: 'knife',
    body: { shape: 'line', length: 8, material: 'ice', mass: { param: 'm', min: 500, max: 8000 } },
    launch: { direction: { param: 'dir', type: 'vec2' }, speed: { param: 'v', min: 0, max: 60 } },
    onImpact: {
      shape: 'disc', radius: 2,
      ops: [{ op: 'transferKinetic' },
            { op: 'addTemperature', value: { param: 'chill', min: -8000, max: 0 } }],
    },
  }],

  turn(msg, ctx) {
    const dir = [msg.opponent.pos[0] - msg.you.pos[0], msg.opponent.pos[1] - msg.you.pos[1]];
    const args = { m: 7200, v: 40, chill: -5538, dir };
    // Know the price before you commit to it.
    const cost = ctx.cost('knife', args);
    if (!cost || cost.total > msg.you.manaMilli) return { type: 'actions' };
    return { type: 'actions', move1: { turnTo: 0 }, cast: { spellId: 'knife', args } };
  },
});
```

Two worked examples ship in `bots/`: `naive` throws a knife at the opponent every
turn and never moves; `positional` holds a working range, uses cover, leads the
target and keeps an interceptor armed. Positional beats naive 4–0.

Three things catch new bot authors:

- **Facing decides where your spell appears.** The wand sits ahead of the
  footprint along the facing vector, and every cast originates there. Firing
  backwards puts the projectile through your own wizard. Self-damage is enabled.
- **Move before you cast, not after.** The wand is five cells ahead; a turn buys
  up to fifteen MP of movement. Cast and then charge forward and you will walk
  into your own shot.
- **Range is paid as velocity, and velocity is quadratic.** Doubling the distance
  you can reach quadruples the mana. An underpowered cast falls short and drops
  as inert matter.

## Layout

```
packages/
  protocol/       Wire types, the tuning table, validators. Zero dependencies.
  engine/         Simulation core. Pure TypeScript, integer maths, no I/O.
  sdk-ts/         Bot helper library
apps/
  cli/            Match runner: bot processes, timeouts, replay writing
  viewer-ascii/   Terminal replay player
bots/
  naive/          Fires every turn, never moves
  positional/     Uses cover, leads the target, intercepts
```

The engine has no framework dependency and does no I/O, per passport §17. `Round`
and `Match` are synchronous state machines: you read the pending turn packet,
hand back an action packet, and they advance. The CLI is the only thing that
knows what a process is. That boundary is what keeps the eventual Rust port a
rewrite of one package rather than the whole project.

## Determinism

All engine maths is integer, scaled: no float anywhere in the simulation, and no
float ever crosses the bot boundary. Where an intermediate leaves the safe
integer range — kinetic energy is mass times velocity squared — the arithmetic
goes through BigInt so the result is exact rather than exact-until-it-isn't. The
cosine table for cone shapes is written out as literals rather than computed from
`Math.cos`, which is not specified to give the same bits on every engine.

A replay is the map seed, a rules snapshot, the locked spellbooks and the ordered
log of action packets. `spark verify` re-runs it and compares. The test suite
asserts identical state hashes across 1000 stepped turns.

## Status against the passport's milestones

| Milestone | Gate | State |
|---|---|---|
| **M1** protocol + engine core | Deterministic: same input → identical state hash across 1000 turns | Done, asserted in `determinism.test.ts` |
| **M2** spells, pricing, casting | Ice knife and fireball cost within 10% of §9 | Done — 26.44 vs ≈26, 61.34 vs ≈61 |
| **M3** CLI, sandboxing, replays | Two dummy bots complete a four-round match | Runner and replays done; **sandboxing partial**, see below |
| **M4** SDKs, ASCII viewer | Someone else writes a working bot | `sdk-ts` and the viewer ship; `sdk-py` not written |
| **M5** balance pass | Playtest scenarios 1–5 pass | Scenario 3 passes; 1, 2, 4, 5 not run |
| **M6** map generator, tournaments | Round-robin of 6 bots completes unattended | Map generator done; no tournament runner |

Measured so far, against §18's tests:

- **`KE_TO_HP` 0.35 holds.** Median time-to-kill between two copies of the
  positional bot is 15 turns over 32 rounds across eight seeds, at the top of
  the 8–15 target but inside it. No retune needed yet.
- **`TURN_CAP` 30 is inside its target, but only just.** 4 rounds of 32 (12.5%)
  reached the cap, against §18's "under 15%". All four were the same seed, where
  a stone formation sits between the spawns and the positional bot — which walks
  straight lines and has no pathfinding — never closes. That is a bot
  limitation, not an engine one, and it needs a wider bot pool to mean anything.
- **`MANA_CAP` 150 fails its own test.** The passport's 300-mana stone wall can
  never be cast. See DECISIONS D7.
- **Burn damage is the balance risk.** See DECISIONS D8 — this is the number to
  playtest first, ahead of anything else.

## Sandboxing is not finished

The runner enforces the per-turn timeout with kill-and-restart, a stripped
environment, and a memory ceiling for Node bots. It does **not** drop privileges
to a separate uid, deny network access, or mount the filesystem read-only —
those need OS-level support, not a Node parent process.

**Do not run untrusted bots.** Passport §20 requires this reviewed before any
public play, and that review has not happened.

## Not built yet

- `sdk-py` — the protocol is language-agnostic and a Python bot will work today,
  but there is no helper library for it.
- The tournament runner and the phase-2 NestJS server and web viewer.
- Concurrent-concentration playtesting (passport §20 asks whether five
  simultaneous links are sustainable — untested).
