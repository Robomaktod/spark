# Implementation decisions

Every entry here is a place where the project passport (`docs/project-passport.md`)
either left something unspecified or contradicted itself, and the implementation
had to pick. Each records what the passport says, what was chosen, and why.

The passport's own framing applies throughout: every number is a starting value
with a stated test, none are claimed correct. Nothing below is a claim that the
design is wrong — it is a record of what the code actually does, so that a
retune is a deliberate act rather than a discovery.

---

## D1 — A "turn" is a cycle, and each wizard gets one turn in it

**Passport:** §5.1 describes a turn as one wizard's three action slots. §5.3 sets
a turn cap of 30. §18 expects arena crossing in about 13 turns at 15 MP, and a
median time-to-kill of 8–15 turns. §12 runs the physics step "at the end of each
turn, after both the acting wizard's actions".

**Chosen:** `turn` counts cycles, 1 to 30. Each cycle gives every wizard one
turn, and the physics step runs after each of those — twice per cycle. So a
round is up to 30 turns *each*, and a projectile travels during the opponent's
turn as §12 requires.

**Why:** the alternative reading (30 wizard-turns, 15 each) cannot satisfy §18:
crossing the arena would consume the entire round. Measured TTK under this
reading is 12–15 turns between two copies of the positional bot, inside §18's
8–15 band, so `KE_TO_HP` is left at its published 0.35.

## D2 — Turn packets carry cell deltas, not the whole sparse world

**Passport:** §14.3 says the turn packet carries "only cells differing from their
material default", and estimates a few kB on a 200×200 map.

**Chosen:** `match_start` and `round_start` carry the full sparse terrain in
`arena.cells`. Each `turn` packet then carries only the cells that changed since
that bot's previous packet.

**Why:** a generated map has thousands of non-default cells — three to six stone
formations alone. Resending them every turn is over 100 kB per packet, not a few
kB. The delta keeps the per-turn packet at the size the passport intended. The
SDK's `WorldView` applies deltas for you, so a bot author never sees the seam.

## D3 — Impact ops are priced against a nominal cell

**Passport:** §7.4 says a large impact disc "heats more cells, so it costs more".
§7.5 requires every cast to be statically priceable, and §19 says every cost is
computable by the bot before acting. §9's cost table prices temperature as
`k_heat × mass_kg × specificHeat × ΔT`.

**Chosen:** impact ops are priced against `impactCells × nominalCellMassG`
(10 g per cell) at `nominalCellSpecificHeatMilli` (1.0), both published in the
rules. Cost scales with impact area, and is knowable before firing.

**Why:** the cells a shot will actually strike are not known at cast time, so
pricing against real terrain would break static priceability. A published
nominal cell satisfies both requirements. With these values the ice knife comes
out at 26.44 mana against the passport's ≈26, and the fireball at 61.34 against
≈61 — both inside the 10% the M2 gate asks for.

## D4 — `addTemperature` buys a packet of energy, and the body carries it

**Passport:** §7.3 lists `addTemperature` as "heat or cool cells in the impact
shape". §10's worked example has an ice knife *at* −200 °C, decaying 30% of its
differential per turn. §14.3's example turn packet shows an object at −200 °C.

**Chosen:** an `addTemperature` op buys thermal energy sized by the nominal cell
it was priced on (D3). That energy rides on the manifested body — so an ice
knife flies cold and a fireball flies hot — and the impact deposits the same
packet into the cells actually struck, each warming according to its own heat
capacity. Energy is conserved end to end: one purchase, one packet.

The declared value is therefore the temperature swing that packet would produce
in *nominal* matter, not the swing the body itself reaches. `declaredTemperatureFor()`
in the SDK converts between the two.

**Why:** three things had to hold at once, and this is the only arrangement that
holds all three.

1. **The passport's totals.** Ice knife 26.44 (≈26) and fireball 61.34 (≈61).
2. **§10's arithmetic.** Chilling a 7.2 kg ice knife to −200 °C costs 14.40 mana;
   holding it there costs 7.13 mana/turn — the passport's own ≈7.
3. **§10's design rule, "holding is cheaper than recasting, never free."**
   Upkeep works out at exactly 0.45× the cost of rebuying the same thermal
   state, for any body, any material and any temperature. That ratio falls out
   of `CONC_MULT × HEAT_DECAY = 1.5 × 0.3`.

The rejected alternative — declared ΔT applied directly to the body, priced on
the body's own mass — breaks (1) by pricing the ice knife at 40 mana. The other
alternative — declared ΔT applied to the body but priced on impact area — breaks
(3): buying −200 °C would cost 0.52 mana while holding it costs 7.13 a turn, so
holding would be fourteen times *more* expensive than recasting.

A consequence worth knowing: heat delivered into heavy matter barely moves it. A
knife that dumps 57 J into a 2.5 kg stone cell warms it about 40 °C. Melting
stone with heat alone takes many casts, which is what makes `setBinding` the
practical wall-breaking tool.

## D5 — Melting destroys cohesion

**Passport:** §3.3 limits v1 phase changes to ice↔water, water→air, and
"stone → rubble when binding reaches 0". §9 describes a wall-melter that "breaks
stone binding over several casts" using heat, with no `setBinding` op.

**Chosen:** a cell at or above its material's melting point has its binding
driven to 0, which then feeds the published stone→rubble rule.

**Why:** without it the wall-melter in §9 cannot work at all — nothing in the
listed transitions connects temperature to binding. This adds no new material
property; it uses the melting points §3.3 already publishes.

## D6 — A reaction stays armed until the declarer's next turn

**Passport:** §11 says a reaction "is declared each turn, before the turn
resolves, and fires at most once during that turn", and lists
`objectEnteredRadius` and `opponentCast` as triggers.

**Chosen:** a declared reaction is armed from declaration until the start of the
declarer's next turn, and is evaluated after every action phase and every physics
step in that window. It fires at most once. The reservation is released at
expiry, and any part of it the cast did not spend is returned immediately.

**Why:** both `objectEnteredRadius` and `opponentCast` describe things that
happen on the *opponent's* turn. Under the narrow reading — armed only during
the declarer's own turn — neither trigger could ever fire, and the React slot
would do nothing.

## D7 — Two published numbers cannot both hold: the stone wall and the mana cap

**Passport:** §9 prices a 50 kg stone wall at 300 mana and calls it "a
once-per-round investment". §4 caps mana at 150.

**Chosen:** both constants are implemented as published. The wall is simply
uncastable at 50 kg, and a test records that (`round.test.ts`).

**Why:** §18 anticipates exactly this — `MANA_CAP`'s stated test is "↑ if
stone-wall openings never happen", and its trigger condition is met on day one.
Raising the cap changes the whole economy, so it is the designer's call, not a
silent fix. Note also that a wall's height scales with density: stone must be
2.5 kg per cell to stand at 1200 mm, so the cheapest slab that both covers a 5×5
wizard and blocks flight is 1×5 cells at 12.5 kg, or 75 mana. That one is
castable, and it is what the positional bot uses.

## D8 — Burn damage is steep enough to be the first thing to playtest

**Passport:** §8 sets burn at `(T − 60) / 20` HP per turn. §9's fireball creates
a +1500 °C zone and is summarised as "≈ 12 HP impact + burn zone".

**Chosen:** the formula is implemented exactly as published.

**Why, and the caveat:** at 1500 °C that formula is 72 HP per turn, which is not
"a burn zone" beside a 12 HP impact — it is the whole spell. Thermal energy also
costs 50 J per mana while kinetic energy costs 5 J per mana, so heat is ten
times cheaper per joule before the burn multiplier is even applied. §8 and §9
appear to have been written against different temperature scales. This is the
most likely source of degenerate play and is exactly what passport §21 scenario
4 exists to find. `burnDivisorMilliC` is a published rules constant, so a retune
is a one-line change; the implementation does not pre-empt it.

## D9 — Shapes are rasterised from their region, and priced from the canonical count

**Passport:** §7.2 defines the shape vocabulary in a local frame where +X is the
launch direction.

**Chosen:** a shape is defined as a continuous region in its local frame, and
rasterised by rotating each candidate world cell back into that frame. Cost and
the damage coverage denominator use the shape's cell count in its *canonical*
orientation, not the rasterised one.

**Why:** rotating an already-rasterised shape collapses it — a diagonal 5-cell
line lands three of its cells on the same square and silently becomes a 3-cell
line. Rasterising the region instead keeps shapes intact at any angle. Pricing
from the canonical count keeps a cast's cost and damage independent of the
direction it was fired in, which §7.5 requires; the rasterised cells are used
only to decide which cells the effect actually lands on.

## D10 — Sandboxing is enforced only as far as a portable runner can

**Passport:** §14.5 requires a 200 ms turn budget, a 256 MB memory ceiling, no
network, a read-only filesystem, dropped privileges and a separate uid.

**Chosen and implemented:** one process per match, a hard per-turn timeout with
kill-and-restart on expiry, a stripped environment (no inherited variables
beyond `PATH` and `HOME`), and `--max-old-space-size` for Node bots.

**Not implemented:** uid separation, network denial, and a read-only mount. These
need OS-level support — a container, a seccomp profile or a jail — and are not
something a Node parent process can impose on an arbitrary child. Until they
exist, **do not run untrusted bots.** This is called out in the README as well.
