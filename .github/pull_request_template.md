## What changed

<!-- What this does, and why. The diff already says what; say why. -->

## Design documents

<!-- Which passport / web plan sections this touches, if any. If the change
     contradicts one, link the docs/DECISIONS.md entry that records the choice. -->

## Verification

<!-- Paste what you ran. "It typechecks" is not verification. -->

- [ ] `npm run verify` passes (invariants, types, lint, tests, determinism)
- [ ] `npm run test:web` passes, or the change touches none of
      `packages/engine`, `packages/replay`, `apps/web`
- [ ] Tests were added or changed to cover the claim this PR makes
- [ ] No tuning constant in `DEFAULT_RULES` was changed without saying so below

## Anything left undone

<!-- Known gaps, things deliberately out of scope, follow-ups. Say so here
     rather than letting a reviewer find them. -->
