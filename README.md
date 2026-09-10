# Spark

A zero-player programming game. Two players each write a **bot** that controls a
wizard, and author the **spells** that wizard can cast. Neither player touches
the game during a match — all skill expression lives in the code.

The distinguishing idea: spells are not a fixed list of effects. A spell is a
small declarative structure describing _matter to manifest and what it does on
impact_, and the engine prices it in mana according to physics. A fireball and an
ice knife are the same two operations with different materials, shapes and
velocities.

The full design is in [`docs/project-passport.md`](docs/project-passport.md) and
[`docs/web-plan.md`](docs/web-plan.md). Places where this implementation had to
choose — because a document left something open or contradicted itself — are
recorded in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Try it

```bash
npm install
npm run build
npm run verify

# Run a match between the two example bots and record a replay
node apps/cli/dist/src/main.js run --seed spark --replay replays/demo.json

# Watch it in the terminal
node apps/viewer-ascii/dist/src/main.js replays/demo.json

# Confirm the replay reproduces bit for bit
node apps/cli/dist/src/main.js verify replays/demo.json
```

`npm run demo` does the run-and-watch in one step.

`npm run verify` is the gate: invariants, typecheck, lint, formatting, unit
tests, and a real four-round match proving determinism. `npm run test:web` adds
the browser half, which needs Chromium.

For the web viewer, start the relay and publish a match to it:

```bash
npm run serve                       # http://localhost:3000

# in another shell
node apps/cli/dist/src/main.js run --seed spark --publish http://localhost:3000
node apps/cli/dist/src/main.js run --seed spark --publish http://localhost:3000 --live
```

`npm run test:web` drives all of that under headless Chromium.

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
  spellbook: () => [
    {
      id: 'knife',
      body: {
        shape: 'line',
        length: 8,
        material: 'ice',
        mass: { param: 'm', min: 500, max: 8000 },
      },
      launch: { direction: { param: 'dir', type: 'vec2' }, speed: { param: 'v', min: 0, max: 60 } },
      onImpact: {
        shape: 'disc',
        radius: 2,
        ops: [
          { op: 'transferKinetic' },
          { op: 'addTemperature', value: { param: 'chill', min: -8000, max: 0 } },
        ],
      },
    },
  ],

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

## The web viewer

The site exists for one reason: the ASCII replay is a single feedback channel,
and a player whose concentration play won a round cannot see why from a
terminal. Every feature is judged against whether it shortens the distance
between "I lost" and "I know which line of my code was wrong".

- **Match viewer** — overlay rail, arena, ledger, scrubber. Six overlays: heat,
  height, trails, coverage, mana field, grid. Coverage is the one that matters
  most, because `overlapCells / impactShapeCells` _is_ the damage multiplier.
- **Ledger** — opening mana, upkeep per concentration, cast cost split into
  manifest / impulse / heat / binding, regen, closing. Every number matches a
  formula in passport §9, so a player can check the engine's arithmetic against
  their own.
- **Scrubber** — HP and mana sparklines with markers on the turns damage landed,
  so you jump to the turn that went wrong instead of watching linearly.
- **Event log** — generated by the engine and stored in the replay, so the ASCII
  and web viewers cannot describe the same match differently. Clicking a line
  seeks to that turn and switches on the overlay that explains it.
- **Workbench** — edit a template, see its cost split by term and its page cost
  against the 40-page budget, fire it at a dummy and watch where drag stops it.
- **Rules** — the tuning table, read out of the engine's actual constants rather
  than transcribed.

### The engine runs in the browser

`packages/engine` is pure TypeScript with deterministic integer maths and no
Node APIs, so it ships to the page. The browser downloads a few hundred kB of
action packets and reconstructs every frame locally. Nothing streams world
state; seeking is local computation; and the viewer cannot drift from the engine
because it **is** the engine — a rendering bug stays a rendering bug.

Live matches use the same path: the CLI streams action packets, the browser
simulates each turn as its packet lands. A viewer joining mid-match takes the
packets so far in one burst and fast-simulates to catch up.

### Where matches run

The CLI is the match runner. **The server never executes bot code.** It stores
finished replays, fans out live turn packets, and serves the page — so the whole
class of "someone uploaded a fork bomb" problems does not exist, and bot source
never leaves your machine. Privacy is enforced at the deployment boundary: set
`SPARK_KEY` and the secret rides in the URL, or run it on a LAN or Tailscale
network and let the network be the gate.

```
your machine                          server                    browsers
┌──────────────┐   WS: turn packets  ┌──────────┐   WS fan-out  ┌────────┐
│ spark-cli    │────────────────────▶│  relay   │──────────────▶│ viewer │
│ engine       │                     │  (Nest)  │               │ viewer │
│ bot A (proc) │   POST: replay file │  static  │               └────────┘
│ bot B (proc) │────────────────────▶│  files   │
└──────────────┘                     └──────────┘
```

## Working on it

[`AGENTS.md`](AGENTS.md) is the house rules — written for AI coding agents, but
it is the same rules a person needs. The short version:

| command                 | what it proves                                                          |
| ----------------------- | ----------------------------------------------------------------------- |
| `npm run verify`        | invariants, types, lint, format, tests, determinism                     |
| `npm run test:web`      | the browser engine matches the Node engine, turn for turn               |
| `npm run invariants`    | no floats in the simulation, no I/O in the engine, no upward dependency |
| `npm run verify:replay` | a real match reproduces, and keyframe seeks agree with it               |

`scripts/check-invariants.mjs` enforces the four rules that break the _game_
rather than the code review, because none of them are expressible in the type
system:

- **no floating point** in `protocol`, `engine` or `replay` — fractions are
  scaled integers, one unit is 1/1000
- **no I/O and no framework** in the engine, which is what lets it ship to the
  browser unchanged
- **packages depend only downward**, checked from their declared dependencies
- **`protocol` has no dependencies at all**

A rule can be waived on its line with `// invariant-ok(<rule>): <reason>`. There
are three waivers in the repository and each one says why.

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) has the dependency map and the
extension points — how to add a spell op, a shape, a trigger predicate, an
overlay, or a tuning constant.

## Layout

```
packages/
  protocol/       Wire types, the tuning table, validators. Zero dependencies.
  engine/         Simulation core. Pure TypeScript, integer maths, no I/O.
  replay/         Replay format, keyframes, playback. Shared by all three viewers.
  sdk-ts/         Bot helper library
apps/
  cli/            Match runner: bot processes, timeouts, replay writing, publishing
  viewer-ascii/   Terminal replay player
  web/            Vite + React + Pixi viewer and workbench
  server/         NestJS relay: replay storage, live fan-out, static hosting
bots/
  naive/          Fires every turn, never moves
  positional/     Uses cover, leads the target, intercepts
scripts/
  check-invariants.mjs   The four rules that break the game if broken
  verify-replay.mjs      Runs a real match and proves it reproduces
```

The engine has no framework dependency and does no I/O, per passport §17. `Round`
and `Match` are synchronous state machines: you read the pending turn packet,
hand back an action packet, and they advance. The CLI is the only thing that
knows what a process is; Nest is confined to the relay, where a web framework
belongs. That boundary is what let the engine ship to the browser unchanged, and
what keeps the eventual Rust port a rewrite of one package rather than the whole
project.

## Determinism

All engine maths is integer, scaled: no float anywhere in the simulation, and no
float ever crosses the bot boundary. Where an intermediate leaves the safe
integer range — kinetic energy is mass times velocity squared — the arithmetic
goes through BigInt so the result is exact rather than exact-until-it-isn't. The
cosine table for cone shapes is written out as literals rather than computed from
`Math.cos`, which is not specified to give the same bits on every engine.

A replay is the map seed, a rules snapshot, the locked spellbooks and the ordered
log of action packets, plus the per-turn event log, swept paths and keyframes the
web viewer needs. `spark verify` re-runs it, checks every recorded hash, and
confirms that seeking through keyframes lands where a straight playthrough does.

The test suite asserts identical state hashes across 1000 stepped turns, and
`npm run test:web` runs a real replay through the engine in Node **and** in
headless Chromium and compares all 170 turns. Same package, same fixed-point
code — but that is a claim, and this is the check.

## Status against the passport's milestones

| Milestone                          | Gate                                                               | State                                                      |
| ---------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| **M1** protocol + engine core      | Deterministic: same input → identical state hash across 1000 turns | Done, asserted in `determinism.test.ts`                    |
| **M2** spells, pricing, casting    | Ice knife and fireball cost within 10% of §9                       | Done — 26.44 vs ≈26, 61.34 vs ≈61                          |
| **M3** CLI, sandboxing, replays    | Two dummy bots complete a four-round match                         | Runner and replays done; **sandboxing partial**, see below |
| **M4** SDKs, ASCII viewer          | Someone else writes a working bot                                  | `sdk-ts` and the viewer ship; `sdk-py` not written         |
| **M5** balance pass                | Playtest scenarios 1–5 pass                                        | Scenario 3 passes; 1, 2, 4, 5 not run                      |
| **M6** map generator, tournaments  | Round-robin of 6 bots completes unattended                         | Map generator done; no tournament runner                   |
| **W1** browser engine + `replay`   | Browser reconstructs a replay to identical hashes                  | Done — 170/170 turns match in Chromium                     |
| **W2** static viewer               | A replay is watchable end to end                                   | Done                                                       |
| **W3** overlays, ledger, event log | Readability test passes                                            | Built; the readability test itself needs a person          |
| **W4** smooth playback             | A collision is legible frame by frame                              | Done — segment stepping in the scrubber                    |
| **W5** relay + live mode           | A live match watchable with under 1 s lag                          | Done; catch-up measured at ~9 ms per turn                  |
| **W6** workbench                   | New player builds an attack spell without reading §9               | Built; the new-player test needs a person                  |

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
- The tournament runner.
- Concurrent-concentration playtesting (passport §20 asks whether five
  simultaneous links are sustainable — untested).
- The two gates that need a human rather than a test runner: W3's readability
  test (can an observer state the cause of death?) and W6's new-player test
  (can someone build a working attack spell in the workbench without reading
  passport §9?). Both are built and both are unverified.
- The web plan's own open questions: an in-browser bot sandbox, per-replay
  spellbook hiding, and a mobile layout. The match list survives a narrow
  window; the viewer is desktop-only by design.
