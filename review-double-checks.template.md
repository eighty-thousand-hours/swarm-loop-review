# review-double-checks

> Place this file at your **repository root** as `review-double-checks.md`. The
> `swarm-loop-review` skill reads it for the **Codebase Standards** lens. It holds the
> codebase-specific rules an automated reviewer should enforce — the things you'd "double
> check" beyond a generic review. Keep it to *review-time* conventions (not a full style
> guide). Every entry should be checkable against a diff.

## How to write entries

- One bullet per rule. Be specific and checkable; give the bad pattern where it helps.
- The reviewer **defaults to fixing** any violation of this file when triaging — a rebuttable
  default, not absolute. So keep entries to conventions you genuinely want enforced at review time.
- Note exceptions inline (e.g. "except at server/client API boundaries").

## Type safety

- *(e.g.)* No `as` casts that narrow a broader type to a narrower one — use a type guard.- *(your rules…)*

## Error handling / fail-fast

- *(e.g.)* No `foo?.bar ?? ""` that hides missing data; no `catch` without rethrow or logging.- *(your rules…)*

## Refactoring hygiene

- *(e.g.)* No half-migrations (`NEW = x; OLD = NEW; // back-compat`) — update consumers.
## Framework / UI conventions

- *(your rules…)*

## Tests

- *(your rules…)*

## Dependencies & security

- *(your rules…)*

## Static checks

- *(e.g.)* The repo's single-shot check command passes (name it here).

## PR hygiene

- *(your rules…)*
