---
name: spark-engine
description: Use when changing anything in packages/engine, packages/protocol or packages/replay — physics, pricing, damage, the turn loop, map generation, the replay format, or the event log. Covers the determinism rules the simulation depends on and what a change has to prove before it ships.
---

# Changing the Spark simulation

The engine has one property everything else rests on: **the same seed and the
same bot outputs produce the same match, bit for bit, on any machine**
(passport §13). Replays, the tournament story, and the web viewer all assume it.
A change that breaks it will still pass most of the tests, because the tests
agree with each other.

## Before you write anything

Find the passport section. Almost every formula and constant in the engine
traces to one, and the comments cite them. If your change contradicts a section,
that is a decision to record in `docs/DECISIONS.md`, not a detail to smooth
over.

Check whether the number you are about to change is in `DEFAULT_RULES`. If it
is, it is a published tuning constant with a stated test in passport §18 — and
changing it reshapes the game. Report the finding rather than retuning.

## While you write

**Integers only.** No decimals, no `Math.sqrt`, no `Math.random`, no
`Date.now`. Fractions are scaled: one unit is 1/1000 of a base unit. Mass is
grams, height is millimetres.

**Use `fp.ts`.** `mulDiv` and `mulDivRound` go through BigInt, so a product that
leaves the safe integer range stays exact instead of exact-until-it-isn't.
`idiv` floors toward negative infinity for every sign. `isqrt` is exact.
Kinetic energy is mass times velocity squared — that is 2.9e13 before you have
done anything unusual.

**Rounding must be decided, not incidental.** `idivRound` rounds half away from
zero; `idiv` floors. Picking one by accident is how two implementations of the
same formula drift apart.

**Iterate in a fixed order.** Objects by ascending id, cells row-major,
collisions by time then id. A `Set` or `Map` iteration that happens to be stable
today is not a guarantee.

**Publish what a bot needs.** If your change means a bot cannot predict what the
engine will do without knowing a number, that number belongs in `Rules`.

**The event log is the record.** Passport §19 names it as the fix for the
weakest part of the design. A new effect that produces no event is invisible in
both viewers. `describeEvent` is an exhaustive switch, so the compiler will
catch a missing case — but only if you add the variant to the union.

## Before you say it is done

```bash
npm run verify
```

Invariants, typecheck, lint, unit tests, and a real four-round match proving
that every recorded hash reproduces, that keyframe seeks land where a straight
playthrough does, and that two runs of the same seed agree.

If you touched the engine, the replay format or the viewer, also:

```bash
npm run test:web
```

That runs a replay through the engine in Node and again in headless Chromium
and compares all 170 turns. It is the only thing that catches a change which is
deterministic in one runtime but not the other.

## Add the test that matches the claim

The suite in `packages/engine/test/` asserts against passport sections by name.

- Changed pricing → `pricing.test.ts`, asserting a hand-computed figure. The
  passport's four worked examples in §9 are the anchors; three of them hold to
  within 2% and the fourth is documented in DECISIONS D3.
- Changed physics → `physics.test.ts`, using `flatRound()` so one thing is
  being measured at a time.
- Changed the turn loop, reactions or concentration → `round.test.ts`.
- Changed anything that could affect reproducibility → `determinism.test.ts`
  already steps 1000 turns and compares; make sure your change is exercised by
  the scripted actions there.

A change to a formula that does not move a single test has probably not been
tested.

## Traps

- **Heat decay runs before the phase check.** A cell at −5 °C is above freezing
  by the time the freeze check sees it. Test temperatures need headroom.
- **Shapes rasterise from a region.** Rotating already-rasterised cells
  collapses them. Pricing and the damage denominator use the canonical cell
  count, so cost does not vary with the angle a spell was fired at — that is
  what makes a cast statically priceable.
- **The wand is ahead of the wizard along its facing.** A cast fired opposite to
  the facing passes back through the caster. Self-damage is enabled and this is
  intended behaviour, not a bug.
- **`Round.lastDirtyBlocks` describes an increment.** A new round or a restored
  keyframe is not one.
- **Restoring a keyframe must reproduce the hash exactly.** If you add mutable
  state to `Round`, add it to `snapshot()` and `restore()` too, or backward
  seeking will diverge in a way that only shows up when someone scrubs.
