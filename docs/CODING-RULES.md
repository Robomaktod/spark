# Coding rules

[`AGENTS.md`](../AGENTS.md) is the short version and the one to read first.
This is the detail behind it.

## Naming carries units

Every number in this codebase is scaled. A name that does not say which scale
is a bug waiting for a reader to make an assumption.

```ts
massG; // grams
heightMm; // millimetres
temperatureMilliC;
manaMilli;
speedMilliCellsPerTurn;
keToHpMilli; // a coefficient, x1000
```

Bare `mass`, `temperature` or `cost` are not acceptable in the engine. At a
call site the suffix is what tells a reader whether `1000` means one or a
thousand.

## Integer arithmetic

Use `packages/engine/src/fp.ts` rather than writing the arithmetic inline:

| helper                    | when                                                         |
| ------------------------- | ------------------------------------------------------------ |
| `mulDiv(a, b, d)`         | `a * b / d` where the product may be large. Floors.          |
| `mulDivRound(a, b, d)`    | the same, rounded half away from zero                        |
| `idiv(a, b)`              | division that floors toward negative infinity for every sign |
| `idivRound(a, b)`         | division rounded half away from zero                         |
| `isqrt(n)`, `isqrtBig(n)` | exact integer square root                                    |
| `ilen(x, y)`              | vector length, safe for any input the protocol allows        |
| `cosMilli(deg)`           | cosine from a literal table, not `Math.cos`                  |

`mulDiv` and `ilen` go through BigInt. That is not caution: kinetic energy is
mass times velocity squared, which reaches 2.9e13 with ordinary inputs, and a
bot may legally send a direction vector of a billion.

**Decide the rounding.** `idiv` floors, `idivRound` rounds. Two implementations
of the same formula that disagree about which is how a replay stops reproducing.

## Determinism beyond floats

- **Iterate in a stated order.** Objects by ascending id, cells row-major,
  collisions by time then id. If you build a `Set` or `Map` and iterate it, sort
  first.
- **No wall-clock time and no randomness** after map generation. The map's RNG
  is seeded and lives in `rand.ts`.
- **New mutable state on `Round` must be in `snapshot()` and `restore()`.**
  Otherwise a keyframe restore diverges, and it will only show up when someone
  scrubs backwards in the viewer.

## Validation and failure

A bot is untrusted input. Passport §14.4: an invalid action is rejected
individually with a reason, and never forfeits the turn.

- Structural validation lives in `packages/protocol/src/validate.ts` and returns
  errors; it never throws.
- Semantic validation — page budgets, mana, path legality — lives in the engine.
- Reject out-of-range arguments rather than clamping them. Clamping hides the
  bot's bug, and passport §1 lists readable failure as a design pillar.
- Every rejection carries a reason that reaches the bot in the next packet.

## The event log

Passport §19 names it as the fix for the weakest part of the design: a player
who lost has to be able to see why. It is not debug output.

- Add an effect, add an event. `describeEvent` is an exhaustive switch, so the
  compiler enforces this once the variant exists.
- One line of plain English per event, naming the numbers that explain it.
- If a viewer needs a detail to render an effect, put it in the event rather
  than recomputing it in the viewer. Two implementations of the same shape
  rasteriser will disagree eventually; that is why `impact_wizard` carries the
  cells it landed.

## Comments

The code says what it does. Comments say:

- which passport or web plan section a formula comes from,
- why the obvious approach was rejected,
- what breaks if the line changes.

```ts
// cos and sin come from the normalised direction. Deriving them from the raw
// vector over a floored ilen would stretch every diagonal shape by root two.
```

Not:

```ts
// get the unit vector
```

Do not narrate the diff, restate the type signature, or leave a comment that
will be false after the next edit.

## Tests

- Assert against the design documents by name. The suite reads
  `describe('mana model — passport §9 worked examples')` because the passport is
  the specification, and a test that drifts from it should be visibly wrong.
- Test one thing at a time. `flatRound()` in `test/helpers.ts` gives an empty
  arena so a physics test is measuring physics.
- Prefer a hand-computed expected value to a snapshot. `assert.equal(mana(cost.manifest), 14.4)`
  says what the answer should be; a snapshot says only that it has not changed.
- When you find a real inconsistency in the design documents, write the test
  that records it — as `round.test.ts` does for the stone wall that cannot be
  afforded at the published mana cap.

## Web app

- The renderer is a mutable object with its own frame loop. React mounts it and
  feeds it frames; it does not re-render it. Keeping those apart is what stops a
  state change from rebuilding forty thousand pixels.
- Pixel overlays draw into a 200×200 buffer, one cell per pixel. Vector layers
  are Pixi `Graphics`.
- Playback state lives in the Zustand store; the simulation lives in
  `ReplayPlayer`. The store's job is to tell React something changed, not to own
  the match.
- An overlay that would need information the event log does not carry is a sign
  the event is incomplete.

## What not to do

- Do not retune a constant in `DEFAULT_RULES` on your own initiative. Every one
  is a starting value with a stated test in passport §18, and two currently fail
  their own tests on purpose — see DECISIONS D7 and D8.
- Do not add a dependency to `packages/protocol` or `packages/engine`. The
  invariant check will stop you; the reason is that the engine has to run in a
  browser and be portable to Rust.
- Do not compute something in a viewer that the engine already knows. Ask the
  engine to record it.
- Do not resolve a contradiction in the design documents silently. Add an entry
  to `docs/DECISIONS.md`.
