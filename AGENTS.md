# AGENTS.md

Instructions for AI coding agents working in this repository. Humans should
read it too — it is just the house rules, written down.

Spark is a zero-player programming game. Two bots each control a wizard and
author the spells it casts; the engine prices every spell in mana from physics.
The design lives in [`docs/project-passport.md`](docs/project-passport.md) and
[`docs/web-plan.md`](docs/web-plan.md). Read the relevant section before
changing behaviour those documents describe.

---

## Before you claim you are done

```bash
npm run verify
```

That runs, in order: invariants, typecheck, lint, unit tests, and a real
four-round match proving determinism. It takes about a minute. **A change is
not finished until it passes**, and "it typechecks" is not the same thing.

The browser half of the determinism claim is separate because it needs
Chromium:

```bash
npm run test:web
```

Run it whenever you touch `packages/engine`, `packages/replay`, or `apps/web`.

---

## The four invariants

These are not style preferences. Each one, if broken, breaks the game rather
than the code review, and `npm run invariants` enforces all four.

### 1. No floating point in the simulation

Passport §13: same seed plus same bot outputs equals the same match, bit for
bit, on any machine. Floats do not reproduce identically across engines, so
`packages/protocol`, `packages/engine` and `packages/replay` contain no
decimals, no `Math.sqrt`, no `Math.random`, no `Date.now`.

Fractions are carried by scaling. One unit is 1/1000 of a base unit:

| quantity         | unit          | 1.0 is |
| ---------------- | ------------- | ------ |
| length           | milli-cells   | 1000   |
| time             | milli-turns   | 1000   |
| temperature      | milli-Celsius | 1000   |
| mana, HP, energy | milli-units   | 1000   |
| coefficients     | ×1000         | 1000   |

Mass is grams and height is millimetres — already integers, not scaled again.

Where an intermediate product leaves the safe integer range — kinetic energy is
mass times velocity squared — go through `BigInt`. `packages/engine/src/fp.ts`
has `mulDiv`, `idiv`, `isqrt` and friends for exactly this. Use them rather
than writing the arithmetic inline.

### 2. The engine does no I/O and knows about no framework

Passport §17. `packages/engine` imports nothing from `node:`, touches no
`process`, logs to no `console`, and has never heard of Nest or React. This is
not tidiness: it is what let the same engine ship to the browser unchanged, and
what keeps the eventual Rust port a rewrite of one package.

`Round` and `Match` are synchronous state machines. You read the pending turn
packet, hand back an action packet, they advance. All I/O lives in `apps/`.

### 3. Packages depend only downward

```
protocol  ←  engine  ←  replay  ←  cli, viewer-ascii, web, server
                     ←  sdk-ts
```

`protocol` has no dependencies at all. Adding one to `engine` that is not
`@spark/protocol` will fail the check.

### 4. Every rule constant is published to the bots

Passport §19: nothing is hidden from a player willing to read. A new tuning
constant goes in `Rules` in `packages/protocol/src/rules.ts`, which the engine
ships to both bots in the `init` packet. Never hard-code a number in the engine
that a bot would need in order to predict what the engine will do.

### Waiving an invariant

On the offending line, or the one above it:

```ts
// invariant-ok(determinism): float seed only; the loops below correct it exactly
```

The reason is mandatory and a human will read it. There are three waivers in
the whole repository. If you are adding a fourth, say so in your summary.

---

## Where code goes

| If you are…                                         | it goes in          |
| --------------------------------------------------- | ------------------- |
| adding a wire type, message or tuning constant      | `packages/protocol` |
| changing physics, pricing, damage, or the turn loop | `packages/engine`   |
| changing the replay format, keyframes or playback   | `packages/replay`   |
| adding a bot helper                                 | `packages/sdk-ts`   |
| changing process handling, timeouts or the CLI      | `apps/cli`          |
| changing the terminal viewer                        | `apps/viewer-ascii` |
| changing the web viewer or workbench                | `apps/web`          |
| changing the relay, storage or live streaming       | `apps/server`       |

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) has the detail, including the
extension points for new spell ops, shapes, triggers and overlays.
[`docs/CODING-RULES.md`](docs/CODING-RULES.md) covers naming, integer
arithmetic, validation, the event log, comments and tests.

---

## How to work here

**Read the passport section before changing behaviour it specifies.** Almost
every constant and formula in the engine traces to a numbered section, and the
comments cite them. If your change contradicts one, that is a decision, not a
detail — see below.

**When a document is wrong or self-contradictory, record it.** The passport and
web plan contain several numbers that cannot all be true at once.
[`docs/DECISIONS.md`](docs/DECISIONS.md) has eighteen entries explaining what
was chosen and why. Add D19 rather than silently picking one and moving on. A
future reader needs to know a choice was made.

**Do not retune published constants on your own initiative.** Every number in
`DEFAULT_RULES` is a starting value with a stated test in passport §18. Two of
them currently fail their own tests (see DECISIONS D7 and D8). Changing one
reshapes the whole game and is the designer's call — report the finding instead.

**Test what the change actually claims.** The suite is in
`packages/engine/test/` and asserts against passport sections by name. A change
to pricing that does not move a pricing test has probably not been tested.

**Comments explain why, not what.** The code says what it does. The comments in
this repository say which passport section a formula comes from, or why the
obvious approach was rejected. Match that.

---

## Things that will bite you

- **Facing decides where a spell appears.** The wand sits ahead of the wizard's
  footprint along its facing, and every cast originates there. A bot that fires
  backwards shoots itself. This is intended.
- **Heat decay runs before the phase check** in the physics step, so a cell at
  −5 °C is already above freezing by the time the freeze check looks at it. Test
  temperatures need headroom.
- **Shapes are rasterised from a region, not by rotating rasterised cells.**
  Rotating cells collapses them — a diagonal 5-cell line lands three cells on
  one square. Pricing uses the canonical cell count so cost does not vary with
  angle.
- **The dirty-block set describes an increment.** A new round or a seek is not
  one, so the renderer repaints everything in those cases. Reusing the dirty set
  there leaves the terrain invisible.
- **Nest resolves dependencies from decorator metadata**, so `apps/server`
  cannot use `import type` for injected classes. The failure is a null
  injection at boot, not a compile error. That rule is off for that directory.

---

## Commits and pull requests

- Explain **why**, not what the diff already shows. Say what you measured.
- Report failures plainly. If a gate does not pass, say which and why — do not
  describe a partially working change as finished.
- Do not commit `replays/`, `dist/`, or screenshots.
- Never put a model name or version in a commit message, code comment, or any
  other file in the repository.
