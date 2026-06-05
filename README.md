# swarm-loop-review

A multi-agent code-review skill for Claude Code (and Codex). It fans out a **swarm** of
reviewers over a PR, a local diff, or an implementation plan, **debates its own findings**
to convergence so it stops being noisy *and* stops silently dismissing the things that
matter, and then either discusses them with you (**collaborate**) or fixes them and posts a
single review to GitHub (**fix**; diffs only — plan review is collaborate-only).

It is generic: it carries **no** project-specific rules. Each repo supplies its own
`review-double-checks.md` (its codebase standards); everything else — correctness, security,
efficiency, code-reuse, quality, risks — is universal and lives in the skill.

## How it works

1. **Round 0 — swarm.** Seven Claude lenses (Correctness, Code Quality, Codebase Standards, Code Reuse, Security, Efficiency, Risks) + Codex as an independent bug-spotter, all in parallel.
2. **Kill ⇄ rescue debate.** A context-rich *kill* critic triages keep/dismiss; a fresh *rescue* critic argues back for wrongly-dropped findings. They loop until stable (max ~6 exchanges), producing three buckets: **Agreed**, **Contested** (your call), **Dismissed**.
3. **Output.** collaborate presents (and offers to post/fix); fix applies net-positive changes, re-reviews to convergence, and posts one GitHub review. Contested items are surfaced explicitly so dismissals are never silent.

See `design/one-pager.html` for the interface + agent-flow diagram, and `design/spec.md` for
the full specification.

## Prerequisite: `review-double-checks.md`

The Codebase Standards lens reads a `review-double-checks.md` at the **target repo's root**.
It holds the house rules an automated reviewer should enforce (type-safety, fail-fast,
naming, framework conventions, …); the reviewer **defaults to fixing** any violation of it. Copy `review-double-checks.template.md` into a repo and fill it in. If the file is missing, the
standards lens is skipped (with a warning) and the other lenses still run.

> The name avoids `REVIEW.md`, which Code Review already claims as a repo-root override.

## Install

Symlink the skill into your Claude skills directory:

```bash
ln -s "$PWD" ~/.claude/skills/swarm-loop-review
```

Then invoke with `/swarm-loop-review` (see `SKILL.md` for usage and flags).

## Usage

```
/swarm-loop-review [target] [mode] [flags]
```

- **target:** PR url/number, `plan [path]` for an implementation plan (collaborate-only), or omit to auto-detect (open PR → uncommitted diff → branch-vs-base).
- **mode:** `collaborate` (default, never edits) · `fix` (autonomous: fix, push, post).
- **flags:** `mini` (two reviewers, single round) · `local` (print, don't post) · `base <branch>` · `--diff` (force local diff even if a PR exists).

## Layout

```
SKILL.md                              the skill (self-contained)
review-double-checks.template.md      template for a consuming repo
design/spec.md                        full specification
design/one-pager.html                 interface + agent-flow diagram
```

## Status

Draft / pre-release. Built from the design in `design/`.

## License

MIT — see [LICENSE](LICENSE).
