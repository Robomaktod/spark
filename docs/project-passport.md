# Spark — Project Passport

**Version:** 0.1 (design lock for MVP)
**Type:** 0-player game / programming game
**Status:** Specification complete for v1 implementation

---

## 1. Identity

Spark is a zero-player programming game. Two players each write a **bot** that controls a wizard, and author the **spells** that wizard can cast. Neither player touches the game during a match. All skill expression lives in the code.

The distinguishing idea: spells are not a fixed list of effects. A spell is a small declarative structure that describes *matter to manifest and what it does on impact*, and the engine prices it in mana according to physics. A fireball and an ice knife are the same two operations with different materials, shapes and velocities. The game rewards players who understand the cost model well enough to build something the designer never anticipated.

### Design pillars

1. **The engine is a physics referee, not a rulebook of spells.** No spell is special-cased. Cost, damage and terrain interaction all derive from mass, energy and velocity.
2. **Language-agnostic.** Bots communicate over JSON on stdin/stdout. Any language that can read a line and write a line can play.
3. **Deterministic.** Same seed plus same bot outputs equals the same match, bit for bit, on any machine.
4. **Readable failure.** When a bot loses, its author must be able to see why from the replay.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Cell** | Smallest unit of world space. 10 cm × 10 cm, 1 litre volume. Carries material, mass, temperature, binding, height. |
| **Block** | 5×5 group of cells. Engine-internal optimization unit for dirty-tracking. Never exposed to bots. |
| **Object** | Discrete moving matter — a projectile or settled debris. Has position, velocity, mass, temperature, material, shape. |
| **Wizard** | The avatar. Occupies a 5×5 cell footprint, has HP, a facing direction, MP and mana. |
| **Wand** | Attached to the wizard, positioned ahead of it along the facing vector. The origin of every cast. Cannot be targeted or lost. |
| **Mana** | The single resource. Spent to manifest matter, accelerate it, change cell properties, and sustain concentration. |
| **Spell** | A registered template: body + launch + impact operations, with named numeric parameters. |
| **Spellbook** | The fixed set of spell templates a bot registers before the match. Cannot change once the match starts. |
| **Concentration** | A persistent mana link to an object or region, sustained turn by turn, that holds properties against decay and allows re-commanding. |
| **AP** | Action slots. Each turn a wizard has one Move, one Cast, one React. |
| **MP** | Movement points, spent on stepping and turning. |

---

## 3. World model

### 3.1 Cells

The arena is a fixed grid. Each cell stores:

| Field | Type | Notes |
|---|---|---|
| `material` | enum | air, stone, water, ice, wood, plasma, rubble |
| `mass` | int (g) | Mutable. Density derives from it: 1 litre volume, so mass in grams = density in kg/m³. |
| `temperature` | int (m°C) | Mutable. |
| `binding` | int | Structural cohesion. 0 = loose. Mutable. |
| `height` | int (mm) | How tall the matter in this cell stands. Determines what blocks flight and movement. |

Density and phase are **derived**, never stored. Thermal energy = `mass × specificHeat × temperature`.

### 3.2 The 2.5D height model

The world is top-down with one scalar of vertical information per cell.

- Projectiles fly at a fixed **flight altitude** (starting value 1000 mm, chest height).
- A projectile collides with a cell only when `cell.height > flightAltitude`.
- A wizard is blocked from entering a cell when `cell.height > 1000 mm`.
- A lake has height 0 — projectiles pass over it, wizards wade through it at a movement penalty.
- Rubble at 400 mm blocks nothing in flight, slows movement.

This gives cover, chokepoints and terrain destruction for the price of one integer per cell. Flight altitude is a hidden constant in v1; exposing it as a spell parameter in v2 gives arcing shots with no engine change.

### 3.3 Materials

Starting values. All are tuning-table entries, not fixed truths.

| Material | Density (g/L) | Specific heat | Default binding | Melt / boil (°C) | Manifest cost (mana/kg) |
|---|---|---|---|---|---|
| air | 1 | 0.2 | 0 | — | 0.5 |
| water | 1000 | 1.0 | 5 | 0 / 100 | 2 |
| ice | 900 | 0.5 | 30 | 0 | 2 |
| wood | 600 | 0.6 | 45 | burns >300 | 3 |
| stone | 2500 | 0.4 | 80 | 1200 | 6 |
| rubble | 1600 | 0.4 | 5 | 1200 | 5 |
| plasma | 300 | 0.2 | 0 | — | 4 |

Phase transitions in v1 are limited to: ice ↔ water at 0 °C, water → air (steam, mass removed) at 100 °C, stone → rubble when binding reaches 0. No other transitions.

### 3.4 Blocks and dirty tracking

The world is partitioned into 5×5 blocks purely for engine performance. A block enters the dirty set when any of its cells is written, or when an object's swept path intersects it. Only dirty blocks are stepped for decay and phase checks each turn. Bots never see blocks; the protocol speaks cells.

### 3.5 Arena

- **Size:** 200 × 200 cells = 40 × 40 blocks = 20 × 20 metres. *Starting value.*
- **Boundary:** hard walls. Objects that reach the edge stop and settle. Wizards cannot be pushed out; an impulse into the wall dumps its energy as damage.
- **Generation:** seeded, asymmetric. Spawn asymmetry is compensated by the swap rule in §5.2, not by mirrored terrain.

---

## 4. The wizard

| Property | Starting value |
|---|---|
| Footprint | 5 × 5 cells (50 × 50 cm) |
| HP | 100 |
| MP per turn | 15 (does not carry over) |
| Mana at round start | 100 |
| Mana regen | +20 per turn |
| Mana cap | 150 |
| Facing | 8 directions (45° increments) |

The wizard is an HP entity, not a body of cells. Damage arrives from physics (§8), never from a damage tag on a spell.

### Wand position

The wand sits **3 cells ahead of the footprint edge** along the facing vector. All manifested matter is centred there. Consequences:

- A spell can never be cast inside the opponent's body — every effect must travel.
- A spell can never spawn overlapping the caster.
- Facing becomes a real tactical variable, since turning costs MP.

**If the manifest area is blocked** (terrain occupies the spawn cells at flight altitude): the cast fails, mana is fully refunded, and the Cast slot is consumed. The bot is told in the next turn packet via `lastCastResult: "blocked"`.

> ASSUMPTION: 3 cells is enough clearance for typical body shapes.
> IMPACT: If a disc of radius 6 spawns 3 cells ahead, it overlaps the caster's own footprint.
> IF WRONG: Wizards self-damage on every large spell.
> VALIDATE: Rule — the manifest offset is `max(3, bodyRadius + 1)` cells, computed per cast from the body shape. Adopted as the actual rule.

---

## 5. Match structure

### 5.1 The turn

Each turn a wizard has three action slots, usable in any order:

1. **Move** — spend MP. Splittable: the bot may take a partial move, cast, then use the remaining MP. Implemented as two half-move sub-actions bracketing the Cast slot.
2. **Cast** — one spell per turn, or one channel command to a concentrated object.
3. **React** — declare one trigger + response for this turn. Re-declared each turn; may repeat the previous declaration.

Turn order alternates by round. Within a turn: bot receives state → returns action packet → engine applies actions → engine steps physics → reactions resolve → decay and upkeep charged.

### 5.2 The match

Four rounds, structured as two games of two rounds.

| | Spawns | Round 1 first | Round 2 first |
|---|---|---|---|
| Game 1 | as generated | Bot A | Bot B |
| Game 2 | swapped | Bot A | Bot B |

Each bot plays each spawn point twice and moves first twice. Terrain advantage cancels without forcing symmetric map generation.

### 5.3 Round end and scoring

- Round ends when a wizard reaches 0 HP, or at the **turn cap of 30**.
- Both alive at cap, or both dead in the same turn → tie.
- Round win = 1 point. Tie = 0.5 each.
- At 2–2, the tiebreak is **total mana spent across all four rounds**; lower wins.
- If both spent zero mana, the match is a true draw with no winner.

Mana does not carry between rounds. Each round starts at 100.

---

## 6. Movement

- 15 MP per turn. *Starting value.*
- Stepping one cell costs 1 MP in any of the 8 directions (diagonals included).
- Turning costs **1 MP per 45°**. A full reversal costs 4 MP. Bots must budget for turning.
- The wizard's full 5×5 footprint must be legal to occupy — a passable gap must be at least 5 cells wide.
- Terrain multipliers on entering a cell (*starting values*): water ×2, rubble ×2, ice ×1 with 1 cell of forced slide continuation in the direction of travel.
- Cells above 60 °C are passable but apply burn damage (§8).
- Blocked when `cell.height > 1000 mm`.
- An impulse can push the wizard. Displacement is `min(impulseMagnitude / wizardMass, 20)` cells, applied along the impulse vector, halting on the first blocked cell.

**State machine — Move**

| Property | Definition |
|---|---|
| Entry | Turn start, or after Cast if MP remains |
| Exit | MP exhausted, or bot ends the sub-action |
| Interruptible | No — movement resolves atomically within a sub-action |
| Chains to | Cast, React, second half-move |
| Cost | 1 MP per cell, 1 MP per 45° of turn |
| Edge cases | Blocked mid-path → stops at last legal cell, remaining MP retained. Pushed into a wall → impact damage (§8). Slide on ice into a blocked cell → stops, no damage. |

---

## 7. The spell system

### 7.1 Template structure

A spell is registered before the match and cannot change during it. **Material and shape are fixed at registration; only numeric parameters vary at cast time.** This is what makes a spell a spell rather than a generic emitter.

```json
{
  "id": "ice_knife",
  "body": {
    "shape": "line",
    "length": 8,
    "material": "ice",
    "mass": { "param": "m", "min": 500, "max": 8000 }
  },
  "launch": {
    "direction": { "param": "dir", "type": "vec2" },
    "speed":     { "param": "v", "min": 0, "max": 60 }
  },
  "onImpact": {
    "shape": "disc",
    "radius": 2,
    "ops": [
      { "op": "transferKinetic" },
      { "op": "addTemperature", "value": { "param": "chill", "min": -400, "max": 0 } }
    ]
  }
}
```

A cast references it and supplies arguments:

```json
{ "spellId": "ice_knife", "args": { "m": 7200, "v": 40, "chill": -200, "dir": [3, -1] } }
```

### 7.2 Shape vocabulary (v1)

`cell`, `line`, `disc`, `cone`, `rect`. Shapes are authored in a local frame where **+X is the launch direction**, so a line is automatically along the flight path and a cone opens forward. The bot supplies direction as an integer vector; the engine normalizes it in fixed point.

### 7.3 Operation vocabulary (v1)

| Op | Effect | Cost basis |
|---|---|---|
| `manifest` | Create matter (implicit in `body`) | mass × materialCost |
| `impulse` | Give velocity (implicit in `launch`) | ½mv² |
| `transferKinetic` | Convert the object's KE into damage and heat at impact | free (energy already paid) |
| `addTemperature` | Heat or cool cells in the impact shape | Δ(m·c·T) |
| `setBinding` | Raise or lower structural cohesion | Δbinding × mass |

Spells **can modify existing terrain**, but only at the point of impact. There is no direct write to arbitrary coordinates. To melt a distant wall, a bot codes a spell whose body is cheap and fast and whose `onImpact` dumps heat into the struck cells.

### 7.4 Impact shape

The impact shape is **declared separately from the body**. A small dart can deliver a wide blast. This costs mana through the standard property-change formulas — a large impact disc heats more cells, so it costs more. No separate multiplier is needed.

### 7.5 Spells are blind

A spell template contains no logic, no conditionals and no world queries. The bot reads the world in its own code and passes concrete numbers. This is what makes every cast statically priceable and keeps the engine free of an interpreter.

### 7.6 Spellbook

- Registered during the handshake, **before the map is revealed**. A good bot must be prepared for terrain it has not seen.
- Budgeted in **pages**, capacity 40. *Starting value.*
- `pages = opCount + Σ(shapeVolumeInCells / 10) + Σ(paramRangeWidth / granularity)`

The range term matters: a spell allowed 0–8000 g of mass is more valuable than one fixed at 2000 g, and costs more book space. Six narrow spells or two flexible ones.

> Exact page weights live in the tuning table. Test: does a book of 3 well-designed spells beat a book of 8 rigid ones roughly half the time? If one strategy dominates, adjust the range-width divisor first.

---

## 8. Damage model

All damage derives from physics. No spell carries a damage number.

**Impact damage**

```
HP loss = KE_at_impact × 0.35 × (overlapCells / impactShapeCells)
```

Coverage scaling makes aiming a skill: a knife clipping 3 of the wizard's 25 cells does a fraction of a centre hit. `KE = ½ × mass × velocity²`, with 1 turn treated as 1 second and cells converted to metres.

**Burn damage**

A wizard standing in cells above 60 °C loses `(T − 60) / 20` HP per turn, computed from the hottest cell under its footprint.

**Wall impact**

A wizard pushed into a blocked cell takes impact damage from its own kinetic energy at the same 0.35 factor.

**Self-damage is enabled.** A wizard can walk into its own burn zone or be hit by its own slow-dropped wall. The wand-origin rule prevents the worst self-inflicted cases, but not carelessness.

> Starting value: 0.35 KE-to-HP.
> Test: median time-to-kill between two competent bots should land in 8–15 turns of a 30-turn round.
> If TTK < 8, lower to 0.25. If > 15 or rounds routinely hit the cap, raise to 0.5. **Tune this before any other number.**

---

## 9. Mana model

One currency, four cost terms, all in energy-derived units.

| Term | Formula | Coefficient |
|---|---|---|
| Manifest | `mass_kg × materialCost` | per-material, §3.3 |
| Impulse | `k_impulse × ½ × mass_kg × v_m/s²` | 0.2 |
| Temperature | `k_heat × mass_kg × specificHeat × ΔT` | 0.02 |
| Binding | `k_bind × Δbinding × mass_kg` | 0.5 |

Total cast cost is the sum over the body and all impact ops. The engine computes it; the player never declares a cost.

### Range is paid as velocity

There is no distance multiplier. A spell manifests at the wand and must be thrown. Because impulse is **quadratic in velocity**, doubling the range you can reach quadruples the mana. An underpowered cast falls short and drops as inert matter — the "calculated poorly" failure mode is a natural consequence, not a special rule.

### Worked examples

| Spell | Configuration | Mana | Effect |
|---|---|---|---|
| Ice knife | line 8 cells, ice, 7.2 kg, v40 (4 m/s) | ≈ 26 | ≈ 20 HP on a centre hit |
| Fireball | disc r6, plasma 5.6 kg, ΔT +1500 over impact disc r6, v30 | ≈ 61 | ≈ 12 HP impact + burn zone |
| Stone wall | rect 10×2, stone 50 kg, v0 | ≈ 300 | drops at the wand, height 1200 mm |
| Wall-melter | cell, plasma 0.3 kg, v50, impact ΔT +2000 over disc r2 | ≈ 30 | breaks stone binding over several casts |

At 100 starting mana and +20 per turn, that is roughly one knife per turn, a fireball every third turn, and a stone wall as a once-per-round investment.

---

## 10. Concentration

A cast may carry a **concentration flag**, which opens a persistent mana link to the created object instead of firing and forgetting. Think of it as holding a connection open rather than sending a packet.

### Rules

- **Unlimited concurrent concentrations.** Nothing breaks concentration except running out of mana. Damage does not break it.
- **Upkeep is charged at turn start**, before regen is applied.
- Upkeep for a held property = `1.5 × (mana cost to undo one turn of natural decay on that property)`. Holding is cheaper than recasting, never free.
- Example: an ice knife at −200 °C in a 20 °C world decays 30% of its differential per turn, so upkeep is `1.5 × 0.02 × 7.2 × 0.5 × 66 ≈ 7 mana/turn`.
- **Channel commands:** the Cast slot may be spent issuing a command to an already-concentrated object instead of casting new. Available commands: `impulse` (re-fire it in a new direction, paying ½mΔv² again), `addTemperature`, `release`.
- **Priority list:** the bot supplies an ordered list of its concentrations each turn. The engine pays upkeep top-down; anything unfunded is released and decays normally.

This is the system's depth reservoir. A bot that keeps an ice knife alive, retrieves it, and re-fires it three times pays far less than three fresh casts — but spends its Cast slot each time and carries the upkeep in the background.

**State machine — Concentration**

| Property | Definition |
|---|---|
| Entry | Cast with `concentrate: true` |
| Exit | Bot issues `release`, mana shortfall, object destroyed, or round ends |
| Interruptible | No — damage does not break it |
| Chains to | Channel command via Cast slot |
| Cost | Cast cost on entry; upkeep every turn thereafter |
| Edge cases | Object leaves the arena → stops at wall, concentration persists. Object shattered by collision → concentration released, no refund. Two concentrations on the same object → rejected at declaration. |

---

## 11. Reactions

A reaction is declared each turn, before the turn resolves, and fires at most once during that turn.

- **Fires from the wand**, like any cast. The engine computes the aim vector as the direction from wand to trigger point.
- **Late-bound placeholders:** `$triggerPos`, `$triggerObject`, `$selfPos`. Everything else is fixed at declaration.
- **Mana is reserved at declaration** at the worst-case cost across the declared parameter ranges, and refunded at end of turn if the trigger did not fire. This is why parameter ranges are mandatory in templates.
- Consumes the React slot, not the Cast slot.

### Trigger predicates (v1)

| Predicate | Fires when |
|---|---|
| `objectEnteredRadius(r)` | Any hostile object comes within r cells of the wizard |
| `opponentCast` | The opponent cast a spell this turn |
| `selfHpBelow(x)` | Own HP crosses below x |
| `opponentWithinRadius(r)` | Opponent wizard comes within r cells |
| `cellPropertyCrossed(pos, prop, threshold, dir)` | A named cell's property crosses a threshold |

One predicate per declaration. No boolean composition in v1 — the bot re-declares every turn, so composition adds expressiveness the bot can already achieve in its own code.

---

## 12. Physics step

Runs once at the end of each turn, after both the acting wizard's actions and any triggered reaction.

```
1. Advance objects along swept paths, in ascending object id (deterministic order)
2. Resolve collisions in order of collision time:
     object vs object   -> both destroyed, combined KE released as heat at midpoint
     object vs cell     -> if KE > binding × cellMass:
                              binding -> 0, material -> rubble, height reduced,
                              object continues with remaining KE
                           else:
                              object stops, KE dumped as heat into struck cells
     object vs wizard   -> impact damage (§8), object destroyed
3. Apply drag: v -= (v × 0.10 + 1 cell). If v < 1 cell/turn, object settles as terrain.
4. Settled objects write their material, mass, temperature and height into cells.
5. Heat decay: every dirty cell moves 30% of the way toward ambient (20 °C).
6. Phase checks on dirty cells.
7. Concentration upkeep charged; unfunded links released.
8. Mana regen applied, capped at 150.
```

**Objects move on both players' turns.** A projectile fired by A travels during B's turn as well, so leading a moving target and intercepting an incoming projectile are both real tactics.

---

## 13. Determinism

- **All engine math in fixed point.** Scaled integers, 1 unit = 1/1000 base unit. No floats anywhere in the simulation.
- **The JSON protocol carries integers only.** No float ever crosses the bot boundary, so a Python bot and a TypeScript bot cannot diverge through rounding.
- Iteration order is explicit everywhere: objects by ascending id, cells in row-major order, collisions by collision time then object id.
- **Replay = map seed + the ordered log of bot action packets.** A match reruns bit-exact on any machine. This is what makes tournament disputes resolvable.

---

## 14. Bot protocol

### 14.1 Transport

Each bot runs as a separate OS process. The engine writes one JSON object per line to the bot's stdin; the bot writes one JSON object per line to stdout. stderr is captured as the bot's debug log and surfaced in the replay.

Any language works. Reference SDKs ship for TypeScript and Python, but the protocol is the contract.

### 14.2 Handshake

```
engine -> bot:  { "type": "init", "rules": { ...all tuning constants... } }
bot   -> engine: { "type": "spellbook", "spells": [ ...templates... ] }
engine -> bot:  { "type": "spellbook_result", "accepted": true, "pagesUsed": 37 }
engine -> bot:  { "type": "match_start", "arena": {...}, "youAre": "A" }
```

The map is revealed only at `match_start`, after the book is locked.

### 14.3 Turn packet (engine → bot)

Sparse state: only cells differing from their material default, plus all objects and both wizards. On a 200×200 map this is a few KB, not hundreds.

```json
{
  "type": "turn",
  "round": 1, "turn": 7,
  "you":      { "pos": [40,60], "facing": 2, "hp": 88, "mana": 104, "mp": 15 },
  "opponent": { "pos": [150,90], "facing": 6, "hp": 100 },
  "cells":    [ { "p": [12,7], "mat": "rubble", "m": 1600, "t": 20000, "b": 0, "h": 400 } ],
  "objects":  [ { "id": 3, "p": [88,70], "v": [40,-12], "m": 7200, "mat": "ice", "t": -200000 } ],
  "concentrations": [ { "objectId": 3, "upkeep": 7 } ],
  "lastCastResult": "ok"
}
```

### 14.4 Action packet (bot → engine)

```json
{
  "type": "actions",
  "move1":  { "path": [[1,0],[1,0],[1,1]], "turnTo": 2 },
  "cast":   { "spellId": "ice_knife", "args": {...}, "concentrate": false },
  "move2":  { "path": [[0,1]] },
  "react":  { "trigger": { "kind": "objectEnteredRadius", "r": 25 },
              "spellId": "shield", "args": { "dir": "$triggerPos" } },
  "concentrationPriority": [3, 7]
}
```

Any slot may be omitted. Invalid actions are rejected individually with a reason in the next packet; they do not forfeit the turn.

### 14.5 Sandbox and limits

| Limit | Starting value |
|---|---|
| Turn wall-clock | 200 ms |
| Startup budget | 2 s (process boot + spellbook registration) |
| Memory | 256 MB |
| Network | denied |
| Filesystem | read-only, no writes |
| Privileges | dropped; separate uid, no shared tmp |

**On timeout:** the turn is forfeited, the process is killed and restarted. The bot loses its persistent memory. Painful, not fatal.

**Process lifetime:** one process per match. Bot memory persists across all four rounds — a bot can and should learn from round 1.

---

## 15. Map generation

Seeded, asymmetric. Generator produces:

- Open ground as the base layer
- 3–6 stone formations (height 1200–2000 mm) placed to create sightline breaks
- 1–2 water bodies (height 0, movement ×2)
- 1–3 rubble fields (height 400, movement ×2)
- Two spawn points at least 120 cells apart, each with at least a 15-cell open radius

No symmetry guarantee. Fairness comes from the spawn swap in §5.2.

---

## 16. Replay and observability

- **Replay file:** seed + rules snapshot + ordered action packets + per-turn bot stderr.
- **ASCII viewer** ships in v1. Materials as characters, wizards as `A`/`B` with a facing arrow, objects as digits, a side panel with HP, mana, MP and active concentrations.
- Colour by temperature where the terminal supports it.
- A web viewer is phase 2. ASCII first, because it makes engine bugs visible during development instead of after.

**Readability test:** an observer watching the ASCII replay should be able to say why a wizard died without reading the JSON.

---

## 17. Architecture

```
packages/
  protocol/      JSON schemas, TS types, validators. Zero dependencies.
  engine/        Pure TypeScript simulation core. No Nest, no HTTP, no I/O.
  sdk-ts/        Bot helper library
  sdk-py/        Bot helper library
apps/
  cli/           Match runner, process sandboxing, replay writer
  viewer-ascii/  Terminal replay player
  server/        (phase 2) NestJS — upload, queue, tournaments, web viewer
```

**The engine must have zero framework dependencies.** Nest is a web framework; if the simulation lives inside it, the CLI drags an HTTP server along and the eventual Rust port means untangling two concerns. Nest wraps the same core in phase 2.

The fixed-point discipline and the pure-core boundary are what make the Rust port a rewrite of one package rather than the whole project.

---

## 18. Tuning table

Every number here is a **starting value** with a stated test. None are claimed as correct.

| Constant | Value | Test | Adjust if |
|---|---|---|---|
| `KE_TO_HP` | 0.35 | Median TTK 8–15 turns | ↓ to 0.25 if TTK < 8; ↑ to 0.5 if rounds hit cap |
| `MANA_START` | 100 | Bot can act meaningfully on turn 1 | ↑ if turn 1 is always idle |
| `MANA_REGEN` | 20 | ~1 knife/turn sustainable | ↓ if spam dominates positioning |
| `MANA_CAP` | 150 | Discourages hoarding past 3 turns | ↑ if stone-wall openings never happen |
| `MP_PER_TURN` | 15 | Arena crossing ≈ 13 turns | ↑ if approach play never occurs |
| `TURN_COST_45` | 1 MP | Flanking is meaningful | ↑ to 2 if facing is ignored |
| `K_IMPULSE` | 0.2 | Long shots cost 3–4× short ones | ↑ if range is free |
| `K_HEAT` | 0.02 | Fireball ≈ 60 mana | tune with fireball as the anchor |
| `K_BIND` | 0.5 | Wall-breaking takes 3–4 casts | ↓ if terrain is indestructible in practice |
| `CONC_MULT` | 1.5 | Holding beats recasting | ↑ if concentration is always correct |
| `DRAG` | 10% + 1 cell | Slow casts visibly fall short | ↓ if all casts reach |
| `HEAT_DECAY` | 30%/turn | Burn zones last 3–4 turns | ↓ if zones never matter |
| `TURN_CAP` | 30 | Under 15% of rounds hit it | ↑ if stalling wins |
| `BOOK_PAGES` | 40 | 3 flexible ≈ 8 rigid in winrate | adjust range-width divisor first |
| `FLIGHT_ALT` | 1000 mm | Cover matters, isn't absolute | — |

---

## 19. 5-component evaluation

| Component | Status | Note |
|---|---|---|
| **Clarity** | Strong | Every cost is computable by the bot before acting; the engine publishes all constants in the `init` packet. Nothing is hidden from a player willing to read. |
| **Response** | Strong | Every input maps to a deterministic outcome. No randomness after map generation. |
| **Motivation** | Strong | Four-round match with carried mana tiebreak means efficiency matters even in a won round. |
| **Satisfaction** | **Weak in v1** | The ASCII viewer is one feedback channel. A player whose clever concentration play won a round may not see *why* from the terminal. Mitigation: structured event log in the replay ("A held knife #3 for 4 turns, refired at cost 8, killed B"). Second channel arrives with the web viewer. |
| **Fit** | Strong | Physics-derived costs match the "hard magic system" identity. Nothing is special-cased. |

**Weakest link is Satisfaction.** The event log is not optional — without it the ASCII replay under-serves exactly the players the game is for.

---

## 20. Risks and abuse cases

| Risk | Mitigation |
|---|---|
| **Stall meta** — both bots turtle to the cap and win on the mana tiebreak | Mana tiebreak rewards *low* spend, which actively encourages this. Watch closely in playtest. Fix if seen: tiebreak on damage dealt first, mana second. |
| **Zero-mass exploit** — manifest 1 g bodies at huge velocity for cheap KE | KE is quadratic in v, so cost scales correctly. But verify the minimum mass floor (suggest 100 g) prevents integer-rounding abuse. |
| **Concentration snowball** — unlimited concurrent links let a rich bot dominate | Upkeep is per-object per-turn, and regen is capped at 20. Self-limiting, but confirm in playtest that 5+ simultaneous links are not sustainable. |
| **Spellbook degeneracy** — one optimal book everyone copies | Books are locked before the map is seen (§7.6), so terrain variety punishes over-specialization. |
| **Timeout farming** — a bot deliberately times out to reset opponent state | Timeouts only reset the *offending* bot. No cross-effect. |
| **Sandbox escape** | Process isolation, dropped privileges, no network, read-only FS. Reviewed before any public play. |

---

## 21. Playtest scenarios

1. **New player test:** hand someone the `init` packet and the SDK. Can they build a working attack spell without further explanation?
2. **Stress test:** a bot that casts the most expensive legal spell every turn. Does the engine stay deterministic and within frame budget?
3. **Skill test:** a naive bot (fire at opponent every turn) vs a positional bot (use cover, lead the target). The positional bot should win ≥ 70%.
4. **Abuse test:** deliberately try the exploits in §20 with purpose-built bots.
5. **Readability test:** watch an ASCII replay of a close round. Can an observer state the cause of death?

---

## 22. Milestones

| Phase | Deliverable | Gate |
|---|---|---|
| **M1** | `protocol` + `engine` core: cells, objects, physics step, fixed point. No spells. | Deterministic: same input → identical state hash across 1000 turns |
| **M2** | Spell templates, mana pricing, casting from the wand | Ice knife and fireball both work and cost within 10% of §9 |
| **M3** | `cli` with process sandboxing, timeouts, replay writing | Two dummy bots complete a 4-round match |
| **M4** | `sdk-ts` + `sdk-py`, ASCII viewer | Someone other than you writes a working bot |
| **M5** | Balance pass against §18 tuning table | Playtest scenarios 1–5 pass |
| **M6** | Map generator, tournament runner | Round-robin of 6 bots completes unattended |
| *Phase 2* | NestJS server, web viewer, upload | — |

---

## 23. Open questions

Deferred deliberately. None block M1–M4.

- **Spellbook page weights** — formula shape is set, exact divisors need playtest data.
- **Autonomous physics** — heat diffusion between cells, water flow, gravity. Explicitly out of v1. The 2.5D height model is designed so it can be added without a rewrite.
- **Arcing shots** — exposing flight altitude as a spell parameter. Engine already supports it; deferred to keep v1 tactics legible.
- **Boolean composition in triggers** — deferred; bots can approximate it by re-declaring each turn.
- **Mana tiebreak direction** — currently rewards low spend, which may incentivize stalling. Revisit after scenario 1 playtests.
- **Wizard mass** — needed for push displacement. Suggest 70 kg; not yet tested.
- **Multi-material bodies** — a spell whose body is stone core plus ice shell. Interesting, out of v1 scope.
