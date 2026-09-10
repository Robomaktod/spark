# Architecture

Where code lives, what may depend on what, and where to add things.

## The dependency rule

```
                     ┌──────────────┐
                     │   protocol   │  wire types, tuning table, validators
                     │ (no deps)    │  zero dependencies, by rule
                     └──────┬───────┘
                            │
                     ┌──────▼───────┐
                     │    engine    │  the simulation. Integer maths, no I/O,
                     │              │  no framework. Runs in Node and browser.
                     └──────┬───────┘
                            │
            ┌───────────────┼───────────────┐
            │               │               │
     ┌──────▼─────┐  ┌──────▼─────┐  ┌──────▼──────┐
     │   replay   │  │   sdk-ts   │  │             │
     │  format,   │  │ bot helper │  │             │
     │  keyframes │  │            │  │             │
     └──────┬─────┘  └────────────┘  │             │
            │                        │             │
   ┌────────┼────────┬───────────────┘             │
   │        │        │                             │
┌──▼──┐ ┌───▼────┐ ┌─▼──────┐              ┌───────▼──────┐
│ cli │ │ viewer │ │  web   │              │    server    │
│     │ │ -ascii │ │        │              │  Nest relay  │
└─────┘ └────────┘ └────────┘              └──────────────┘
```

Nothing points upward. `scripts/check-invariants.mjs` enforces it from each
package's declared dependencies, so a wrong import fails `npm run verify`
rather than review.

The two boundaries that matter most:

- **`protocol` has no dependencies at all.** It is the contract, and a contract
  that drags a library along is not one.
- **`engine` depends only on `protocol`.** No Nest, no React, no `node:`
  anything. That is why the same package runs in the CLI and in the browser
  with no build variant, and why the viewer cannot drift from the engine — it
  _is_ the engine.

## Packages

### `packages/protocol`

Every type that crosses a boundary, plus `DEFAULT_RULES` — the complete tuning
table the engine publishes to both bots in the `init` packet. Also the
structural validators for everything a bot sends: a malformed packet costs a
bot its turn, never the match.

Nothing here computes anything. Pricing lives in the engine.

### `packages/engine`

The simulation. All integer maths.

| file           | what it owns                                                    |
| -------------- | --------------------------------------------------------------- |
| `fp.ts`        | integer arithmetic: `mulDiv`, `idiv`, `isqrt`, the cosine table |
| `world.ts`     | the cell grid, dirty blocks, sparse snapshots                   |
| `shapes.ts`    | shape regions and rasterisation, facings, unit vectors          |
| `pricing.ts`   | the mana model and the damage model                             |
| `spellbook.ts` | page budgeting and book validation                              |
| `cast.ts`      | resolving a cast into matter and its price                      |
| `objects.ts`   | projectiles and settled matter                                  |
| `movement.ts`  | stepping, turning, terrain cost, pushes                         |
| `physics.ts`   | the eight-step physics turn                                     |
| `paths.ts`     | swept-path recording for smooth playback                        |
| `round.ts`     | the turn loop, action slots, reactions, concentration           |
| `match.ts`     | four rounds, spawn swap, scoring, the mana tiebreak             |
| `mapgen.ts`    | seeded asymmetric terrain                                       |
| `events.ts`    | the structured event log and its English rendering              |
| `snapshot.ts`  | keyframe types for the viewer's backward seeking                |

### `packages/replay`

The replay file format, and `ReplayPlayer` — the thing that turns recorded
action packets back into frames. All three viewers use it, which is what stops
them describing the same match differently.

### `packages/sdk-ts`

Convenience for TypeScript bot authors: line framing, a local world view fed by
the sparse deltas, cost estimation, aiming helpers. The protocol is the
contract; this is not required to play.

## Apps

### `apps/cli`

The match runner and the only thing that knows what a process is. Spawns bots,
enforces the turn timeout, restarts a bot that hangs, writes replays, and
publishes to the relay.

### `apps/viewer-ascii`

Terminal replay player. Reconstructs through `ReplayPlayer`, so watching a
replay is also a determinism check.

### `apps/web`

Vite + React + Pixi. The engine runs in the page: the browser downloads action
packets and reconstructs every frame locally. Terrain and the pixel overlays are
200×200 canvases uploaded as nearest-neighbour textures — one cell, one pixel.

### `apps/server`

A Nest relay. Stores published replays, fans out live turn packets, serves the
built page. **It never executes bot code**, which is why there is no sandbox,
no queue and no upload portal.

---

## Extension points

### A new spell operation

1. `packages/protocol/src/spell.ts` — add the variant to `ImpactOp`.
2. `packages/protocol/src/validate.ts` — validate its shape.
3. `packages/engine/src/pricing.ts` — price it. It must be computable from the
   template and arguments alone, with no world lookup: passport §7.5 requires
   every cast to be statically priceable, and the workbench depends on it.
4. `packages/engine/src/cast.ts` — resolve its arguments.
5. `packages/engine/src/physics.ts` — apply it in `applyImpact`.
6. `packages/engine/src/events.ts` — the event must say what happened. The
   switch in `describeEvent` is exhaustive, so the compiler will make you.
7. `packages/engine/src/spellbook.ts` — give it a page weight.
8. A pricing test asserting the cost against a hand-computed figure.

### A new shape

`packages/engine/src/shapes.ts`, in `regionOf`. Define it as a continuous
region in the local frame where +X is the launch direction; the rasteriser does
the rest. Do not rotate rasterised cells — that collapses them.

### A new trigger predicate

`TriggerSpec` in the protocol, its validator, then `checkTrigger` in
`round.ts`. It must be answerable from state the engine already has.

### A new viewer overlay

`Overlays` in `apps/web/src/arena/ArenaRenderer.ts`, a painter beside the
others, and an entry in `OVERLAYS` in `panels/OverlayRail.tsx`. Pixel overlays
draw into a 200×200 buffer; vector overlays are Pixi `Graphics`. If it needs
information the event log does not carry, add it to the event rather than
recomputing it in the viewer.

### A new tuning constant

`Rules` in `packages/protocol/src/rules.ts` and `DEFAULT_RULES` beside it. It
is then published to both bots automatically. Give it a unit-suffixed name
(`...Milli`, `...MilliC`, `...Mm`, `...G`) so its scale is visible at the call
site, and add it to the rules page in `apps/web/src/pages/Rules.tsx` if a
player would want to see it.
