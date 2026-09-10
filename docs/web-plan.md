# Spark — Web plan

**Companion to:** `spark-project-passport.md` v0.1
**Version:** 0.1
**Scope:** desktop-only, friends-only, no accounts, live + replay

---

## 1. Purpose

The passport's 5-component evaluation named **Satisfaction** as the weakest link: the ASCII viewer is a single feedback channel, and a player whose concentration play won a round cannot see why from a terminal.

The site exists to fix that. Its primary job is not to look good — it is to make a match **legible to the person who wrote the losing bot**. Every feature below is judged against one question: does this shorten the distance between "I lost" and "I know which line of my code was wrong"?

Priority order:

1. Match viewer — live and replay
2. Spell workbench
3. Match list and library

There is no ranking, no matchmaking, no upload portal in v1.

---

## 2. Access model

Three of your answers interact and need one rule to reconcile them: friends-only, no accounts, everything private.

**Resolution:** privacy is enforced at the deployment boundary, not per user.

- The site is not publicly listed and not indexed.
- Access is a single shared secret in the URL, or the site runs on your LAN / a Tailscale network.
- With no accounts, everyone who reaches the site sees everything on it. That is acceptable because everyone who reaches it is a friend you gave the link to.
- **Bot source is never uploaded to the server at all** (§3), so "bot source is private" is guaranteed structurally rather than by permission checks.
- Spellbooks appear in replays. If a book must stay secret after a match, don't publish that replay — publication is a manual act.

> ASSUMPTION: nobody outside the friend group needs access.
> IMPACT: the entire auth layer, the upload sandbox and the job queue disappear.
> IF WRONG: adding accounts later means adding a real security boundary, not a login form.
> VALIDATE: if a stranger ever asks to play, that's the signal to design phase 2 properly.

---

## 3. Where matches run

**Decision (your J7): the CLI is the match runner. The server never executes bot code.**

```
your machine                          server                    browsers
┌──────────────┐   WS: turn events   ┌──────────┐   WS fan-out  ┌────────┐
│ spark-cli    │────────────────────▶│  relay   │──────────────▶│ viewer │
│ engine       │                     │  (Nest)  │               │ viewer │
│ bot A (proc) │   POST: replay file │  static  │               └────────┘
│ bot B (proc) │────────────────────▶│  files   │
└──────────────┘                     └──────────┘
```

Consequences, all good:

- The server has **zero untrusted-code exposure**. No containers, no job queue, no privilege dropping on a public box. The entire class of "someone uploaded a fork bomb" problems never exists.
- Bot source never leaves your machine.
- The server is a thin relay plus a static file host. It can be a single small VPS or a laptop.
- The CLI stays the source of truth. The web layer can be offline and matches still run.

If Spark ever goes public, this becomes the phase-2 problem it deserves to be: separate worker, container per bot, job queue. Not now.

---

## 4. Architectural decision: run the engine in the browser

`packages/engine` is pure TypeScript with zero framework dependencies and deterministic fixed-point math. **Ship it to the browser.**

The replay file is seed + action packets — a few KB. The browser downloads it, runs the same engine, and reconstructs every frame locally.

What this buys:

- **No state streaming.** The server never sends world state, only action packets.
- **Instant scrubbing.** Seeking is local computation, not a network round-trip.
- **The viewer cannot drift from the engine**, because it *is* the engine. A rendering bug is a rendering bug; it can never be a simulation mismatch.
- The spell workbench (§7) becomes nearly free — the cost model is already in the page.

**Seeking backwards** needs keyframes: snapshot full world state every 5 turns, re-simulate forward from the nearest one. Worst case is 4 turns of resimulation per seek — imperceptible.

This is the payoff for the passport's no-Nest-in-the-engine rule. It was worth enforcing.

### Live mode uses the same path

Live matches stream **action packets**, not state. The browser simulates each turn as its packet arrives. Live and replay differ only in where the packets come from, so there is one rendering path, not two.

A viewer joining mid-match receives the packets so far in one burst and fast-simulates to catch up. On a 200×200 grid this is milliseconds.

---

## 5. Match viewer

The central screen. Layout is the wireframe in chat: overlay rail left, arena centre, ledger right, scrubber bottom.

### 5.1 Arena rendering

- **PixiJS**, tilemap for cells, sprite layer for objects and wizards.
- 200×200 = 40,000 tiles. Only dirty regions re-upload — the engine already tracks dirty blocks, so reuse that set directly rather than diffing in the renderer.
- Camera: free pan and zoom, plus a "follow the action" mode that keeps both wizards and all live projectiles in frame.
- Hover a cell → readout of material, mass, temperature, binding, height.

### 5.2 Overlays

Each is a toggle; several can be on at once.

| Overlay | Shows | Why it matters |
|---|---|---|
| Heat | temperature as colour ramp | burn zones are invisible otherwise |
| Height | what blocks flight vs movement | explains why a shot was stopped |
| Trails | swept paths, fading over 3 turns | shows leading and interception |
| Coverage | on impact, which of the 25 footprint cells were hit | this *is* the damage multiplier |
| Mana field | cost-to-reach at each position | makes the range economy visible |
| Grid | cell and block boundaries | debugging alignment |

Coverage is the highest-value overlay. The passport's damage formula scales by `overlapCells / impactShapeCells`, and without seeing it a player cannot tell a graze from a miss from bad luck.

### 5.3 Right panel — the ledger

Per turn, per wizard:

- **Mana ledger:** opening balance → upkeep charged per concentration → cast cost split into manifest / impulse / heat / binding → regen → closing balance. Every number matches a formula in passport §9, so a player can verify the engine's arithmetic against their own.
- **Damage attribution:** which object, KE at impact, coverage fraction, resulting HP.
- **Active concentrations:** object id, age in turns, upkeep, position in the priority list.
- **Bot stderr** for that turn.

### 5.4 Scrubber

Turn slider with HP and mana sparklines for both bots, and red markers on turns where damage occurred. A player jumps straight to the turn that went wrong rather than watching linearly.

### 5.5 Event log

Structured, human-readable, **generated by the engine and stored in the replay file** — not by the viewer. This matters: the ASCII viewer needs it too, and duplicating the logic in two places guarantees they disagree eventually.

```
t13  A refired knife #3 at cost 12 (Δv 40, 7.2 kg)
t14  knife #3 struck B — 58 J, coverage 9/25, −7 hp
t15  A released concentration on knife #3 (mana shortfall: 4)
```

Clicking a line seeks to that turn and enables the relevant overlay.

---

## 6. Smooth playback

Your J4 answer requires an engine change (§10).

Objects move along swept paths within a turn, with collisions at fractional times. For smooth animation the engine must export, per object per turn, the **path segments with collision times as fractions of the turn**:

```json
{ "objectId": 3, "segments": [
  { "from": [88,70], "to": [120,60], "t0": 0.0, "t1": 0.62 },
  { "from": [120,60], "to": [124,59], "t0": 0.62, "t1": 0.70, "end": "impact" }
] }
```

The viewer lerps within segments. Small payload, deterministic, and the ASCII viewer can ignore it entirely.

Playback controls: play / pause, speed 0.25×–4×, step one turn, step one segment. Segment stepping is the debugging mode — it lets a player watch a collision resolve.

---

## 7. Spell workbench

Because the engine and the cost model are already in the browser, this is a form plus a sandbox arena. It is probably the single feature that most improves bot quality, because it removes guesswork from the cost model.

- Edit a spell template in a structured form: shape, material, mass range, speed range, impact shape, impact ops.
- **Live mana cost breakdown** as you type, split by term, at min / typical / max parameter values.
- **Live page cost** against the 40-page book budget.
- Fire it into a sandbox arena at a static dummy target: see the flight path, where drag stops it, impact coverage, resulting damage.
- Compare two configurations side by side.
- Export the template as JSON for pasting into a bot.

**Playtest gate:** a new player should be able to build a working attack spell in the workbench without reading passport §9. If they can't, the cost breakdown isn't legible enough.

---

## 8. Pages

| Route | Content |
|---|---|
| `/` | Match list: live matches at top, recent replays below. Bot names, result, duration. |
| `/match/:id` | The viewer. Same component for live and replay; a flag switches the packet source. |
| `/workbench` | Spell workbench. |
| `/rules` | The passport rendered as a page, with the tuning table pulled from the engine's actual constants rather than copy-pasted. |

Four routes. No settings page, no profile, no upload form.

---

## 9. Stack

| Layer | Choice | Reason |
|---|---|---|
| Frontend | **Vite + React SPA** | Everything is client-side simulation. SSR gives nothing here, and Next would add a server that has no work to do. |
| Rendering | **PixiJS** | Tilemap performance at 40k cells; you've shipped Pixi before. |
| State | **Zustand** | Playback state is small and mostly imperative. |
| Server | **NestJS** — WS gateway + static files | Thin relay only. Nest earns its place here, not in the engine. |
| Transport | **WebSocket** for live, plain HTTP for replay files | |
| Styling | your call | |

### Repo additions

```
apps/
  web/       Vite + React + Pixi viewer and workbench
  server/    NestJS relay + static replay hosting
packages/
  replay/    Replay file format, keyframe indexing, event log types
             (shared by cli, viewer-ascii and web)
```

`packages/engine` gains a browser build target. No source changes beyond the swept-path export in §10.

---

## 10. Required passport amendments

The web plan forces three changes to the v0.1 spec. All are additive.

1. **§12 physics step** must record swept path segments with fractional collision times per object per turn, and emit them into the replay. Needed for smooth playback (§6).
2. **§16 replay file** gains an `events` array — the structured event log — generated by the engine. Referenced in passport §19 as the fix for the Satisfaction weakness; it is now a hard requirement, not a nice-to-have.
3. **§16 replay file** gains `keyframes`: full world-state snapshots every 5 turns, for backward seeking (§4). These can be computed at write time by the CLI or lazily by the browser; writing them at match time is simpler and the file stays small.

None of these change simulation behaviour, so determinism and existing replays are unaffected.

---

## 11. Milestones

Slots after the passport's M4 (SDKs + ASCII viewer), since the browser engine build depends on a stable protocol.

| Phase | Deliverable | Gate |
|---|---|---|
| **W1** | Engine browser build + `packages/replay` | Browser reconstructs a CLI-produced replay to an identical state hash |
| **W2** | Static viewer: arena render, turn stepping, scrubber | A replay is watchable end to end |
| **W3** | Overlays + ledger + event log | Readability test passes: an observer states the cause of death correctly |
| **W4** | Smooth playback, segment stepping | A collision is legible frame by frame |
| **W5** | Nest relay + live mode | A match running on the CLI is watchable live with under 1 s lag |
| **W6** | Spell workbench | New-player test: working attack spell built without reading §9 |

W1 → W3 is the part that fixes Satisfaction. W5 and W6 are additive.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| **Browser engine diverges from CLI engine** | Same package, same fixed-point code. CI test: run every stored replay in Node and in headless Chrome, compare state hashes per turn. |
| **40k-tile render is slow at 4× speed** | Reuse the engine's dirty-block set for partial redraws. If still slow, cap redraw to 30 fps and interpolate positions only. |
| **Overlay overload** | Overlays are additive and a player can enable all six. Test readability with two on; consider making some mutually exclusive if it becomes soup. |
| **Live viewer joins mid-match and lags** | Catch-up is a burst of packets plus fast simulation — measure it at turn 29 with a full arena before assuming it's instant. |
| **Event log written by hand per feature** | Generate it from the same code path that applies effects, so a new op cannot ship without a log line. |

---

## 13. Open questions

- Does the workbench need a **bot sandbox** too — paste bot code, run it against a dummy opponent in-browser? Attractive, but running arbitrary player code in the page is a different security posture than running the engine. Deferred.
- **Replay sharing**: a URL per replay is enough, or does a friend need to download the file? URL is simpler; decide when the relay exists.
- **Book visibility toggle** per replay, if publishing a match but hiding spellbooks turns out to matter.
- **Mobile viewer** — explicitly out of scope, but the match list at least should not be broken on a phone.
