---
name: swarm-loop-review
description: Multi-agent swarm review of a PR, local diff, or implementation plan — fan out 7 reviewer lenses + Codex, debate the findings to convergence, then either discuss them (collaborate) or fix-and-post a single GitHub review (fix). Plan review is collaborate-only. Requires a review-double-checks.md at the target repo root for the codebase-standards lens.
allowed-tools:
  - Workflow
  - Task
  - Agent
  - Read
  - Edit
  - Bash
  - Grep
  - Glob
---

# swarm-loop-review

Run a multi-agent review of a PR, a local diff, or an implementation plan: fan out parallel
reviewers, debate the findings down to convergence, and either present them
(**collaborate**) or fix them and post a single GitHub review (**fix**; diffs only — plan
review is collaborate-only). Most disagreements are resolved internally; only genuine
judgment calls are surfaced to the human.

> **Prerequisite:** the target repo should contain a `review-double-checks.md` at its root —
> the codebase's review standards (type-safety, fail-fast, naming, etc.). This skill carries
> **no** project-specific rules of its own. If the file is absent, the Codebase Standards
> lens is skipped with a loud warning; every other lens still runs. See
> `review-double-checks.template.md` for the format.

## Usage

`/swarm-loop-review [target] [mode] [flags]`

- **target** — a PR url/number; `plan [path]` for an implementation plan; or omit to auto-detect (Step 1).
- **mode** — `collaborate` (default) or `fix`.
- **flags** — `mini`, `local`, `base <branch>`, `--diff`.

Combine freely: `/swarm-loop-review fix mini`, `/swarm-loop-review 1234 base develop local`,
`/swarm-loop-review plan docs/migration-plan.md mini`.

**Parse arguments** from `$ARGUMENTS` (Claude) or the user's prompt after
`$swarm-loop-review` (Codex).

## Step 1 — Determine the target

Resolve in order; stop at the first match:

1. `plan` keyword in args → **plan mode**. The plan = the given path — if that file doesn't exist, say so and stop (never fall back) — else the most recent plan presented in the conversation (e.g. one just shown for approval); if more than one candidate is plausible, ask which rather than guess. No path and no conversation plan → tell the user there's no plan to review and stop. A plan is never auto-detected — the keyword is required.
2. Explicit PR url/number in args → **PR mode** on that PR.
3. (unless `--diff`) `gh pr view --json number,baseRefName,url` succeeds → **PR mode** on the current branch's PR.
4. `git status --porcelain` non-empty (uncommitted changes) → **local-diff mode**, diff = `git diff HEAD`.
5. Branch is ahead of base with no PR → **local-diff mode**, diff = `git diff <base>...HEAD`.
6. Otherwise (clean tree, no PR, not ahead) → tell the user there's nothing to review and stop.

Base branch = the `base <branch>` flag, else the PR base, else `main`.
Output destination follows **mode + flags, not the target**: PR mode posts to GitHub by
default; local-diff mode is conversation-only (implies `local`). **Plan mode** is
conversation-only and collaborate-only: `fix` → warn and run collaborate; `base`/`--diff`
are ignored.

## Step 2 — Gather context (once)

Write a context bundle to `.swarm-loop-review/<id>/` (gitignored; `<id>` per Step 7) so every
agent reads from disk instead of re-fetching:

- `diff.patch` — the diff text (per Step 1). Plan mode: use the plan's own file path if it has
  one, else write the plan text to `plan.md` here.
- `pr.md` — PR title + body (`gh pr view --json title,body`). PR mode only.
- Locate the repo's `review-double-checks.md` (root). **If absent, pass `null` and the
  Standards lens is skipped** — the rest still run.

## Step 3 — Run the swarm (Workflow tool)

The fan-out, dedupe, and debate all run as one deterministic Workflow script —
**`review-workflow.js`** in this skill's directory. The script is the **single source of
truth** for the lens prompts (diff- and plan-mode variants), the schemas, the disposition
policy, and the convergence loop; read it there rather than expecting them here. In brief:
seven review-only lenses — Correctness, Code Quality, Codebase Standards, Code Reuse,
Security, Efficiency, Risks-for-human-judgment — plus a Codex bug pass, every finding
cited `file:line`.

Invoke it with `scriptPath` = `<skill dir>/review-workflow.js` (resolve the skill dir's
real path) and `args`:

```jsonc
{
  "repoRoot": "<abs path>",
  "targetPath": "<abs path to diff.patch, or the plan file>",   // from Step 2
  "planMode": false,
  "mini": false,
  "doubleChecksPath": "<abs path>" /* or null → Standards lens skipped */,
  "prContextPath": "<abs path to pr.md>" /* or null */,
  "codexInvocation": "<shell command, see below>" /* or null → Claude-only */,
  "dismissed": [],            // Step 5 carries this forward between iterations
  "maxRescuePasses": 6        // 1 in mini mode
}
```

**Composing `codexInvocation`** (the script's Codex agent resolves the real binary itself —
filtering out the hangs-prone `/.superconductor/` wrapper — and degrades to Claude-only with
a note when none is found; one pass only, never `resume`):

- Diff mode: `"$CODEX_BIN" review --base <base>` (or `--uncommitted` for a dirty-tree local
  diff).
- Plan mode: `codex review` only reads diffs — instead one pass of `"$CODEX_BIN" exec` with
  the critique prompt + plan text piped via stdin (heredoc or temp file; **never**
  interpolated into the argv, which breaks on quotes/backticks and ARG_MAX), asking for
  wrong assumptions, missing pieces, and bugs-in-waiting.

**Fallback — no Workflow tool in the runtime (e.g. Codex):** run the same pipeline by hand.
Fan out the lenses defined in `review-workflow.js` as concurrent review-only subagents (use
Codex's native review for the bug pass), then run Step 4's debate yourself: you are the kill
critic; a **fresh** subagent per rescue pass argues to restore your dismissals and ends with
`OBJECTIONS: <ids>` or `OBJECTIONS: none`; terminate on `OBJECTIONS: none` or after
`maxRescuePasses`. Apply the script's disposition policy verbatim.

## Step 4 — Dedupe + kill ⇄ rescue debate (inside the workflow)

Step 3's workflow already does this — findings are deduped across sources (corroboration
noted; agreement raises confidence), then a kill-critic agent triages keep/dismiss and fresh
rescuer agents argue restorations until a rescue pass raises no objections or the pass cap
is hit. **Do not re-litigate the debate from outside;** the disposition policy lives in the
script. Anything still disputed when the cap is hit comes back **Contested**, not silently
dismissed.

**Result — three buckets** (the workflow's return value): **Agreed** (keep / fix),
**Contested** (still disputed → human), **Dismissed** (dropped, with reasons — remember it
so re-reviews don't resurface them). Plus `notes` (coverage caveats — skipped lenses,
failed reviewers, missing Codex) which must surface in the output summary.

## Step 5 — Fix loop (fix mode only)

1. Apply Agreed findings as code changes; commit per repo convention (`Co-Authored-By: Claude <model>`).
2. Re-run Step 3's workflow on the changed code (a fresh invocation — regenerate `diff.patch`), carrying the accumulated dismissed-set forward via `args.dismissed` so dropped findings are suppressed (semantic match, not string match).
3. **Oscillation guard:** if every remaining actionable finding is already in the dismissed-set, stop.
4. Loop until no actionable Agreed findings remain, or `max-iterations` (default 5).

Risks (lens 7) and Contested items are never auto-fixed; they pass through to output.
Plan mode never enters the fix loop.

## Step 6 — Output

**Format**

- One section per dimension (Correctness, Code Quality, Standards, Code Reuse, Security, Efficiency, Risks), in that order; never merged.
- Each finding: a section-letter ID numbered within the section (`C1`, `Q1`, `S1`, `E1`, `R1`…); exactly one severity — **issue / suggestion / nit**; and a `file:line` citation (**mandatory, every finding**). Sort within a section issues → suggestions → nits. Bulleted, not numbered (auto-renumbering breaks the IDs).
- Actionable only — no praise, no "verified X" filler. A clean section is the prose line **"No issues found."** + one factual sentence on what was checked (it signals the section was actually reviewed; keep it visually distinct from bullets).
- **Contested block:** each item flagged `⚖️ reviewer flagged → author dismissed — your call`, showing both the finding and the dismissal reasoning.
- **Risks** are phrased as "document this in the PR description so a human can judge," not as code fixes.
- **Plan mode** appends one extra section — **❓ Questions** (`?1`, `?2`…): blockers the plan's author can answer in a line (distinct from Risks, which need organizational judgment). Citations point at the plan, with `file:line` evidence where applicable.

**Destination**

- **collaborate:** present the review in the conversation; do not post or fix. End by offering — "post this as a GitHub review? / fix any of these?" Posting is outward-facing, so always confirm in collaborate.
- **fix:** after the fix loop, push commits and post the final review automatically (PR mode, unless `local`).
- **GitHub post** (when posting): one review via `gh pr review --comment` (never `--request-changes` / `--approve`), led by an attribution header noting it is automated and posted under the account owner's token but not authored by them. Include a hidden marker (`<!-- swarm-loop-review -->`) so a later run can supersede the prior bot review instead of stacking. fix mode appends a footer: `_Reviewed after N iteration(s); M findings auto-resolved._`
- **local / local-diff:** print the review in the conversation; never post.
- **plan:** print the review in the conversation; never post. End by offering to apply the Agreed findings to the plan (edit its file, or restate the revised plan).

## Step 7 — State (fix mode)

`.swarm-loop-review/<id>/` — gitignored, cleared per run, never committed. `<id>` = PR number,
else `<branch>-<short-sha>` for local diffs.

- `findings-<N>.md` — each iteration's review.
- `dismissed.txt` — one-line semantic descriptions of dismissed findings, carried across iterations.
- `findings-<N>.md.changelog` — per-finding: id / severity / description / action taken.

End a fix run with a changelog table (Iter / ID / Severity / Finding / Action) and the totals.

## Mini mode

Fast path: set `mini: true` and `maxRescuePasses: 1` in the workflow args. The script then
runs **two reviewers only** — one Claude reviewer covering *all* seven lenses in a single
pass, plus Codex — and **one** kill→rescue exchange (no convergence loop). In fix mode, a
single fix pass (no re-review loop). Same output format and posting rules.

## Edge cases

- Clean tree, no PR, not ahead → "nothing to review," stop.
- `plan` with no path and no plan in the conversation → "no plan to review," stop.
- `plan <path>` where the file doesn't exist → "plan file not found," stop — don't fall back to the conversation.
- `plan` + `fix` → warn that plan review is collaborate-only, run collaborate.
- No `review-double-checks.md` → skip lens 3 with a prominent warning; the rest run.
- Codex binary not found → the workflow's Codex agent notes it and the run proceeds Claude-only.
- Workflow tool unavailable (non-Claude runtime) → Step 3's manual fallback path.
- `gh` unauthenticated / no PR permissions → fall back to `local` output, warn.
- local-diff + `fix` → fixes the working tree but does not push (no PR target) and posts nothing.
- Very large diff → proceed, but state in the summary if coverage was bounded.

---

*Design rationale and the full agent flow live in `design/spec.md` and `design/one-pager.html`.*
