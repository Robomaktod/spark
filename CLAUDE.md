# CLAUDE.md

Read [`AGENTS.md`](AGENTS.md) — it holds the house rules for this repository and
they apply here unchanged.

The short version:

- `npm run verify` before claiming a change is done. `npm run test:web` as well
  if you touched `packages/engine`, `packages/replay` or `apps/web`.
- No floats in `protocol`, `engine` or `replay`. Fractions are scaled integers,
  one unit is 1/1000. `packages/engine/src/fp.ts` has the arithmetic.
- The engine does no I/O and imports no framework. That is what lets it run in
  a browser.
- Behaviour described in `docs/project-passport.md` or `docs/web-plan.md` is
  specified. Read the section before changing it, and record disagreements in
  `docs/DECISIONS.md` instead of resolving them silently.
- Do not retune constants in `DEFAULT_RULES` on your own initiative.

`.claude/skills/spark-engine/SKILL.md` covers changing the simulation safely —
the determinism checklist, and what a change to physics or pricing has to prove.
