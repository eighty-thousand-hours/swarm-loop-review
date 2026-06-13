---
name: swarm-loop-review
description: Multi-agent swarm review of a PR, local diff, or implementation plan — fan out 7 reviewer lenses + Codex, debate the findings to convergence, then either discuss them (collaborate) or fix-and-post a single GitHub review (fix). Plan review is collaborate-only. Requires a review-double-checks.md at the target repo root for the codebase-standards lens.
allowed-tools:
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

Collect, and pass into every agent's prompt so they don't re-fetch:

- The diff text and changed-file list (per Step 1) — or, in plan mode, the plan text (and its file path, if it has one).
- The repo's `review-double-checks.md` (root). **If absent, note it and skip lens 3** — the rest still run.
- PR mode: the PR title + body (`gh pr view --json title,body`).

## Step 3 — Round 0: review swarm (parallel)

Launch all of the following **concurrently** (one message, Agent tool). Every agent is
**review-only** (makes no edits), may explore the wider codebase for context, ignores issues
confined to test files, surfaces anything it is unsure about, and **cites `file:line` on
every finding**.

**Seven Claude lenses:**

1. **Correctness** — bugs that will break: logic errors, off-by-ones, bad edge cases, races, null/undefined throws, wrong data-shape/contract assumptions, missing error handling at boundaries. Not style; not security.
2. **Code Quality** — redundant/derivable state, parameter sprawl, near-duplicate blocks, leaky abstractions, stringly-typed code, WHAT-narrating comments, needless JSX nesting, nested ternaries / over-clever one-liners.
3. **Codebase Standards** — violations of the repo's `review-double-checks.md` (passed in Step 2). **No built-in rules of its own.** Skip this lens entirely if the file is absent.
4. **Code Reuse** — search the codebase for existing utilities the change should reuse instead of new code; flag duplicated functionality and hand-rolled logic. Spends most of its time exploring, not reading the diff.
5. **Security** — only >80%-confidence exploitable issues. Injection, auth/authz bypass, secrets/crypto, RCE/XSS (React is safe without `dangerouslySetInnerHTML`), sensitive-data exposure. Exclude DoS, rate-limiting, outdated deps, theoretical races; env vars and CLI flags are trusted; client-side needs no auth checks.
6. **Efficiency** — performance and resource use: redundant computation, repeated reads, N+1 patterns, missed concurrency, hot-path bloat, recurring no-op state updates, TOCTOU existence checks, memory/listener leaks, overly broad reads.
7. **Risks (for human judgment)** — changes needing organizational context: perf/complexity shifts, interface/format/contract changes, behavioral changes (defaults, error semantics, security boundaries), new dependencies/coupling, scope changes. Only surface what the PR description does **not** already cover. These are **not** code-fix findings — they route to the human (Step 6).

**Codex — independent bug-spotter.** A non-Claude second opinion focused on bugs. The
Superconductor wrapper can hang non-interactively, so call the real binary, and capture the
review to a file with `-o`:

```bash
CODEX_BIN="$(which -a codex | grep -v '/.superconductor/' | head -n1)"
CODEX_OUT="$(mktemp)"
"$CODEX_BIN" exec review [--uncommitted | --base <branch>] -o "$CODEX_OUT"
```

**Read the review from `"$CODEX_OUT"`, never from stdout.** `codex` streams its **entire agent
session** — a config banner, then every tool call it makes (file reads, greps, scratch
scripts) and each command's output — to stdout, and prints the actual review only as the final
message. Reading/skimming/`tail`-ing stdout makes the review look like tool noise and it gets
silently discarded; `-o` writes just that final message to the file. A non-empty `$CODEX_OUT`
is the review (in both the found-issues and the clean cases — exit code is 0 either way); an
empty/absent file is the only true "Codex produced no review" signal. (Re-resolve `$CODEX_BIN`
and re-create `$CODEX_OUT` each call — bash state doesn't persist.) One pass only; no
`resume`/follow-up. If no Codex binary is found, note it and proceed Claude-only.

*(Codex runtime: use Codex's native review for the bug pass and a review-only subagent to
cover the seven lenses.)*

**Plan mode — same swarm, different object.** The lenses review the *proposed approach*
against the existing codebase rather than a diff:

1. **Correctness** → feasibility: assumptions the codebase contradicts (data shapes, existing APIs, framework behavior), missing error/edge-case handling in the design.
2. **Code Quality** → design quality: duplicated or derivable state, wrong abstraction boundaries, parameter sprawl in proposed interfaces.
3. **Codebase Standards** → the plan must not commit to anything `review-double-checks.md` forbids, and must name the conventions it triggers (migrations, restarts, test strategy, …).
4. **Code Reuse** → the highest-value plan lens: existing utilities/components/patterns the plan should use instead of building new; proposed file locations vs where similar files already live.
5. **Security** → auth boundaries, data exposure, and trust decisions in the design.
6. **Efficiency** → work designed in that needn't exist: N+1 access patterns, hot-path bloat, missing batching/concurrency.
7. **Risks** → unchanged.

Citations in plan mode: quote the plan line/step being flagged, plus `file:line` of existing
code wherever the claim rests on the codebase. **Codex:** `codex review` only reads diffs —
instead run one pass of `"$CODEX_BIN" exec -o "$CODEX_OUT" -` with the critique prompt + plan
text piped via stdin (heredoc or temp file; never interpolated into the argv, which breaks on
quotes/backticks and ARG_MAX), asking for wrong assumptions, missing pieces, and
bugs-in-waiting; same one-pass/no-resume rule. **Read the critique from `"$CODEX_OUT"`, not
stdout** — `exec` streams the same full session transcript as `review` does.

## Step 4 — Dedupe + kill ⇄ rescue debate

Collect all findings and dedupe across sources (the same issue from N agents = one finding;
note the corroboration — agreement raises confidence).

Now run the debate. **You (the orchestrator) are the kill critic.** Repeat:

1. **Triage (you):** mark every finding **keep** or **dismiss** with a one-line reason. First pass: the full deduped list. Later passes: revise in light of the rescuer's objections — you needn't concede, but reconsider each.
2. **Rescue pass:** spawn a **fresh** subagent (new each pass — its only inputs are the findings + your current keep/dismiss decisions; not a re-run of the seven lenses). It argues to **restore** anything you dismissed that matters — especially the default-fix categories (conventions, comments) and cheap, net-positive nits. It must end its reply with a line `OBJECTIONS: <finding ids it still disputes>` or `OBJECTIONS: none`.
3. **Terminate** when the rescuer returns `OBJECTIONS: none` — you are in agreement — **or** when you have run **6 rescue passes**, whichever comes first. Otherwise loop back to step 1.

**Do not stop after a single pass.** Keep going back and forth until the rescuer has no objections or all 6 passes are spent. Anything the rescuer still disputes after 6 passes is **Contested**, not silently dismissed.

**Disposition policy:**

- No blanket default-dismiss or default-fix. Use judgment, and weigh **cost vs benefit — never benefit alone** (a tiny-benefit change is still worth it when its cost is ~zero; a large-benefit change isn't when it's expensive, risky, or out of scope).
- **Default to fixing** the two areas the swarm habitually *under*-acts on: (a) any violation of `review-double-checks.md` (the codebase conventions); (b) over-explaining / change-narrating comments. This is a *default fix*, not always-fix — judgment can still dismiss with good reason.
- Nits elsewhere: keep only when the fix is clearly net-positive (cheap *and* genuinely clearer).
- **Resolve scope here, don't escalate reflexively.** Use cost-benefit to decide whether an out-of-scope-ish item is worth doing. Only items still genuinely disputed after the debate become Contested — keep that bucket small.

**Result — three buckets:** **Agreed** (keep / fix), **Contested** (still disputed → human),
**Dismissed** (dropped, and remembered so re-reviews don't resurface them).

## Step 5 — Fix loop (fix mode only)

1. Apply Agreed findings as code changes; commit per repo convention (`Co-Authored-By: Claude <model>`).
2. Re-run Round 0 on the changed code (a fresh swarm), passing the dismissed-set forward so dropped findings are suppressed (semantic match, not string match).
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

Fast path: **two reviewers only** — one Claude reviewer told to cover *all* seven lenses in a
single pass, plus Codex. **One** kill→rescue exchange (no convergence loop); in fix mode, a
single fix pass (no re-review loop). Same output format and posting rules.

## Edge cases

- Clean tree, no PR, not ahead → "nothing to review," stop.
- `plan` with no path and no plan in the conversation → "no plan to review," stop.
- `plan <path>` where the file doesn't exist → "plan file not found," stop — don't fall back to the conversation.
- `plan` + `fix` → warn that plan review is collaborate-only, run collaborate.
- No `review-double-checks.md` → skip lens 3 with a prominent warning; the rest run.
- Codex binary not found → note it, proceed Claude-only. An **empty `-o` file** (binary ran, found nothing) is a real clean result, not a read failure — don't fall back to scraping stdout to "recover" findings.
- `gh` unauthenticated / no PR permissions → fall back to `local` output, warn.
- local-diff + `fix` → fixes the working tree but does not push (no PR target) and posts nothing.
- Very large diff → proceed, but state in the summary if coverage was bounded.

---

*Design rationale and the full agent flow live in `design/spec.md` and `design/one-pager.html`.*
