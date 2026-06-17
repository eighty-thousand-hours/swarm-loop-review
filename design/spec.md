# swarm-loop-review — specification

**Status:** design spec, pre-build.
**Does not replace `/rpr`** — this is a new, separate skill; `/rpr` stays as-is.
**Self-contained:** defines its own reviewer agents, Codex invocation, debate loop, and output. No dependency on `review-multi` / `review-claude` / `review-codex` or any other skill, and no "mini-of-another-skill" delegation.
**Location:** `~/80k/swarm-loop-review/` — standalone repo. Install by symlinking `SKILL.md` into `~/.claude/skills/swarm-loop-review/` (sibling to `rpr`).

---

## 1. What it is

A multi-agent ("swarm") reviewer that:

1. fans out parallel reviewers (9 Claude lenses + Codex) over a change set,
2. debates its own findings (**kill ⇄ rescue**) to convergence — producing **Agreed / Contested / Dismissed**,
3. either presents them for discussion (**collaborate**) or fixes them and posts a single GitHub review (**fix**).

Built to run once, post-PR-creation; also works on an uncommitted local diff.

**Non-goals (v1):** not a replacement for `/rpr`; does **not** consume pre-existing human review comments on the PR (separate capability, deferred); no Gemini/Copilot/remote-bot integration.

**Prerequisite:** the target repo must ship a `review-double-checks.md` (its codebase-specific review standards) for the Codebase Standards lens to run. The skill itself carries **no** project rules — type-safety, fail-fast/fail-loud, naming, etc. are all codebase-specific and live in `review-double-checks.md`, not here. See §3.0a.

---

## 2. Interface

`/swarm-loop-review [target] [mode] [flags]`

### 2.1 Target — auto-detected if omitted
Resolve in order; stop at the first match:

1. Explicit `<pr-url | #number>` in args → **PR mode** on that PR.
2. Current branch has an open PR (`gh pr view --json number,baseRefName,url`) → **PR mode**.
3. Working tree dirty (`git status --porcelain` non-empty) → **local-diff mode**, `git diff HEAD`.
4. Branch ahead of base, no PR → **local-diff mode**, `git diff <base>...HEAD`.
5. Otherwise (clean tree, no PR, not ahead) → report "nothing to review" and stop.

Consequences:
- On `main` with uncommitted edits → step 3 → **local diff** (the intended default).
- PR exists *and* you have extra uncommitted edits → PR mode wins (reviews what's actually in the PR). Use `--diff` to force local.

Output destination follows **mode + flags, not the target**: PR mode posts to GitHub by default; local-diff mode is conversation-only.

### 2.2 Mode
- **`collaborate`** (default) — run swarm + debate, **present** the result in the conversation. Never edits code; never posts without confirmation. Ends by offering to fix and/or post.
- **`fix`** — autonomous. Apply net-positive fixes, re-review to convergence, push commits, post the final review. Choosing `fix` is the authorization for those outward actions.

### 2.3 Flags
- **`mini`** — fast pass (see §5).
- **`local`** — never post; output to the conversation. Implied in local-diff mode.
- **`base <branch>`** — override the diff base (default: PR base, else `main`).
- **`--diff`** — force local-diff input even if a PR exists.

Combinable: `/swarm-loop-review fix mini`, `/swarm-loop-review 1234 base develop local`.

---

## 3. Pipeline

### 3.0 Gather context (once)
Compute the diff text, the changed-file list, and read the repo's `review-double-checks.md` (required for lens 4 — see §3.0a). PR mode: also fetch title + body (`gh pr view --json title,body`). Pass all of this into every agent's prompt so agents don't re-fetch.

### 3.0a `review-double-checks.md` — the codebase standards file (required for lens 4)

The skill keeps **no** codebase-specific rules of its own. Any repo that wants the Codebase Standards lens must provide a `review-double-checks.md` at its root: the house rules an automated reviewer should enforce. For minerva that file would carry type-safety (no `passthrough()`, casts need a comment, no weak typings), fail-fast/fail-loud (no `foo?.bar ?? ""` masking, no swallowed errors), no halfway refactors, British-English frontend copy, the `forEach` ban, the component-README registry, Prisma-migration-presence, semantic CSS tokens, etc.

- Every rule here is a codebase convention the kill critic **defaults to fixing** when violated (§3.2) — no per-rule tagging; keep the file to rules you genuinely want enforced.
- If `review-double-checks.md` is absent, the Standards lens is **skipped with a prominent warning** ("no review-double-checks.md — codebase-standards review skipped; add one to enable it"). The generic lenses still run.

### 3.1 Round 0 — review swarm (parallel)
Launch all of the following concurrently. Every agent is **review-only** (no edits), may explore the wider codebase for context, ignores issues confined to test files (**except** the Test Coverage & Parity lens, whose subject *is* the tests), surfaces anything it's unsure about, and cites `file:line` on every finding.

**Nine Claude lenses:**

1. **Correctness** — bugs that will break: logic errors, off-by-ones, bad edge cases, races, null/undefined throws, wrong data-shape/contract assumptions, missing error handling at boundaries. Not style; not security.
2. **Code Quality** — redundant/derivable state, parameter sprawl, near-duplicate blocks, leaky abstractions, stringly-typed code, WHAT-narrating comments, needless JSX nesting, nested ternaries / over-clever one-liners.
3. **Linus Torvalds** — taste, in the Torvalds sense; the structural smells the tactical Code Quality lens misses. Special cases a better data structure or reframing would erase (the "good taste" refactor, not a one-liner cleanup); complexity that's really the wrong data model (bad code is usually a symptom of bad data structures); over-engineering — speculative generality and abstraction layers that don't earn their keep, solve the problem you have; and "don't break userspace" — changes that silently break existing callers, on-disk/serialized formats, public APIs, or CLI/flag behavior. Leaves deliberate, documented contract changes to the Risks lens; flags the accidental break and the structural smell.
4. **Codebase Standards** — deviations from the repo's `review-double-checks.md` (§3.0a). This lens is **entirely codebase-driven**: it has no built-in rules. It flags violations of whatever `review-double-checks.md` declares (for minerva that's type-safety, fail-fast/fail-loud, halfway refactors, British English, etc.). Skipped if `review-double-checks.md` is missing.
5. **Code Reuse** — search the codebase for existing utilities the change should use instead of new code; flag duplicated functionality and hand-rolled logic. Spends most of its time exploring, not reading the diff.
6. **Security** — only >80%-confidence exploitable issues. Injection, auth/authz bypass, secrets/crypto, RCE/XSS (React safe without `dangerouslySetInnerHTML`), sensitive-data exposure. Exclude DoS, rate-limiting, outdated deps, theoretical races; env vars and CLI flags are trusted; client-side needs no auth checks.
7. **Efficiency** — performance and resource use: redundant computation, repeated reads, N+1 patterns, missed concurrency, hot-path bloat, recurring no-op state updates, TOCTOU existence checks, memory/listener leaks, overly broad reads.
8. **Test Coverage & Parity** — whether the change is actually verified and whether its tests mirror production. Untested code paths / error & failure branches (happy-path-only); tests flaky by construction (real sleeps, wall-clock/timezone dependence, ordering or shared-fixture coupling, port/network races); over-mocking that breaks production parity — a mock of the dependency a test exists to exercise tests the mock, not the system (canonical case: stubbing the LLM when production calls a real model — prefer real-model/integration tests; a mock needs a real reason: irreducible nondeterminism, prohibitive cost/latency, an unsafe side effect); and missing coverage of dependency-down/degraded paths (service down, timeout, rate-limit, malformed/empty response). **This is the one lens whose subject is the test files** — the swarm-wide "ignore test-only issues" rule is inverted for it.
9. **Risks (for human judgment)** — changes needing organizational context: perf/complexity/resource shifts, interface/format/contract changes, behavioral changes (defaults, error semantics, security boundaries), new dependencies/coupling, scope changes. For each, check whether the PR description already covers it; only surface what the description leaves unaddressed. These are **not** code-fix findings — they route to the human (§3.4).

**Fan-out: nine lenses, six agents.** The nine above are the **output taxonomy**, not the agent count. The default fan-out groups them into six reviewer agents (script `GROUPS` table): *Correctness + Efficiency* in one, *Code Quality + Linus + Standards* in one, and *Code Reuse*, *Security*, *Test Coverage & Parity*, and *Risks* solo. The rule: a lens runs solo only when it needs a distinct **working mode** (Reuse explores the repo; Tests reads test files), a stricter **precision bar** (Security), or different **output routing** (Risks); the rest are "read the diff and judge" and combine cheaply. Each agent still tags findings per individual lens, so dedupe, disposition, and output sections are unaffected. Mini mode (§5) collapses to a single combined reviewer. *(Validated against GSD's `gsd-code-reviewer`, which uses just three buckets — Bugs / Security / Quality — and cuts performance entirely; we fold Efficiency in rather than drop it.)*

**Codex — independent bug-spotter.** A non-Claude second opinion focused on bugs. The Superconductor wrapper can hang non-interactively, so resolve the real binary and capture the review to a file with `-o`:

```bash
CODEX_BIN="$(which -a codex | grep -v '/.superconductor/' | head -n1)"
CODEX_OUT="$(mktemp)"
"$CODEX_BIN" exec review [--uncommitted | --base <branch>] -o "$CODEX_OUT"
```

**Read the review from `"$CODEX_OUT"`, never from stdout.** `codex` streams its entire agent session — config banner, then every tool call (file reads, greps, scratch scripts) and its output — to stdout, and prints the review only as the final message; reading stdout makes the review look like tool noise and it gets silently discarded. `-o` writes just that final message. A non-empty file is the review (found-issues and clean cases both exit 0); an empty/absent file is the only true "no review" signal. (Re-resolve `$CODEX_BIN` and re-create `$CODEX_OUT` each call — bash state doesn't persist.) One pass only; no `resume`/follow-up — the standards checklist is already covered by lens 4.

### 3.2 Dedupe + kill ⇄ rescue debate
Collect all findings and dedupe across sources (the same issue from N agents = one finding; note the corroboration — agreement raises confidence).

Now run the debate. **You (the orchestrator) are the kill critic.** Repeat:

1. **Triage (you):** mark every finding **keep** or **dismiss** with a one-line reason — first pass over the full deduped list, later passes revised in light of the rescuer's objections (you needn't concede, but reconsider each).
2. **Rescue pass:** spawn a **fresh** subagent (new each pass; its only inputs are the findings + your current keep/dismiss decisions). It argues to **restore** anything you dismissed that matters — especially the default-fix categories (conventions, comments) and cheap, net-positive nits — and ends with a line `OBJECTIONS: <finding ids>` or `OBJECTIONS: none`.
3. **Terminate** when the rescuer returns `OBJECTIONS: none` (you are in agreement) **or** you have run **6 rescue passes**, whichever comes first; otherwise loop back to step 1.

**Do not stop after one pass.** Keep going back and forth until the rescuer has no objections or all 6 passes are spent. Anything the rescuer still disputes after 6 passes is **Contested** — not silently dismissed.

**Disposition policy (kill critic):**

- No blanket default across all findings. Use judgment, and weigh **cost vs benefit — never benefit alone** (a tiny-benefit change is still worth it when its cost is ~zero; a large-benefit change isn't when it's expensive, risky, or out of scope).
- **Default to fixing** the two areas the swarm habitually *under*-acts on: (a) any violation of the repo's `review-double-checks.md` (the codebase conventions); (b) over-explaining / change-narrating comments (a generic AI-author weakness, so it stays in the skill). A *default fix*, not always-fix — judgment/cost-benefit can still dismiss with good reason.
- Nits elsewhere: keep only when the fix is clearly net-positive (cheap *and* genuinely clearer).
- **Scope is resolved here, not escalated reflexively.** Use cost-benefit to decide whether an out-of-scope-ish item is worth doing. Only items that stay genuinely disputed after the debate become Contested — the human bucket must stay small.
- **Severity is not a politeness dial.** Never downgrade `issue → suggestion → nit`, or dismiss a real finding, to seem less harsh or avoid conflict; calibrate to real impact only. Under-calling a genuine issue is as much a defect as a false positive. (Reviewers and the dedupe step are held to the same rule — a merged finding never drops below the highest severity any reviewer assigned.)

**Result — three buckets:**

- **Agreed** — keep (and, in fix mode, fix).
- **Contested** — kill and rescue still disagree after the loop. Surfaced to the human.
- **Dismissed** — dropped, and remembered (§4) so re-reviews don't resurface them.

### 3.3 Fix loop (fix mode only)
1. Apply Agreed findings as code changes; commit per repo convention (`Co-Authored-By: Claude <model>`).
   - **Re-verify before editing:** re-read the cited lines (±~10) and confirm the code still matches the finding — citations drift as earlier fixes shift line numbers. If it no longer matches, skip rather than blind-apply; the next iteration re-derives it.
   - **Mechanical vs. semantic:** mechanical fixes (rename, comment removal, dedupe, convention fix verifiable by re-read or syntax/type check) are `fixed`; changes to logic/control-flow/algorithm are `fixed — needs human verification` (a syntax check proves it parses, not that it's correct) and surface in the output.
2. Re-run Round 0 on the changed code (a fresh swarm), passing the dismissed-set forward so dropped findings are suppressed (semantic match, not string match).
3. **Oscillation guard:** if every remaining actionable finding is already in the dismissed-set, stop.
4. Loop until no actionable Agreed findings remain, or `max-iterations` (default 5).

Risks (lens 9) and Contested items are never auto-fixed; they pass through to output.

### 3.4 Output — findings format
- One section per dimension (Correctness, Code Quality, Linus Torvalds, Standards, Code Reuse, Security, Efficiency, Test Coverage & Parity, Risks), in that order; never merged.
- Each finding has: a section-letter ID numbered within the section (`C1`, `C2`, `Q1`, `L1`, `S1`, `T1`, `R1`…); exactly one severity — **issue / suggestion / nit**; and a `file:line` citation (**mandatory, every finding**). Sort within a section issues → suggestions → nits. Bulleted, not numbered (auto-renumbering breaks the IDs).
- Actionable only — no praise, no "verified X" filler. A clean section is the prose line **"No issues found."** + one factual sentence on what was checked (signals it was actually reviewed; visually distinct from bullets).
- **Contested block:** each item flagged `⚖️ reviewer flagged → author dismissed — your call`, showing both the finding and the dismissal reasoning.
- **Risks** are phrased as "document this in the PR description so a human can judge," not as code fixes.

### 3.5 Output — destination
- **collaborate:** present the review in the conversation; do not post or fix. End by offering — "post this as a GitHub review? / fix any of these?" Posting is outward-facing, so always confirm in collaborate.
- **fix:** after the fix loop, push commits and post the final review automatically (PR mode, unless `local`).
- **GitHub post** (when posting): one review via `gh pr review --comment` (never `--request-changes` / `--approve`), led by an attribution header noting it's automated and posted under the account owner's token but not authored by them. Include a hidden marker (`<!-- swarm-loop-review -->`) so a later run can supersede the prior bot review instead of stacking. fix mode appends a footer: `_Reviewed after N iteration(s); M findings auto-resolved._`
- **local / local-diff:** print the review in the conversation; never post.

---

## 4. State & files (fix mode)
`.swarm-loop-review/<id>/` — gitignored, cleared per run, never committed. `<id>` = PR number, else `<branch>-<short-sha>` for local diffs.
- `findings-<N>.md` — each iteration's review.
- `dismissed.txt` — one-line semantic descriptions of dismissed findings, carried across iterations.
- `findings-<N>.md.changelog` — per-finding: id / severity / description / action taken.

End a fix run by presenting a changelog table (Iter / ID / Severity / Finding / Action) and the totals.

---

## 5. Mini mode
Fast path: **two reviewers only** — a single Claude reviewer told to cover *all* lenses in one pass (correctness, quality, taste, standards, reuse, security, efficiency, tests, risks), plus Codex. **One** kill→rescue exchange (no convergence loop); in fix mode, a single fix pass (no re-review loop). Same output format and posting rules.

---

## 6. Edge cases
- Clean tree, no PR, not ahead → "nothing to review," stop.
- Codex binary not found → note it, proceed Claude-only.
- `gh` unauthenticated / no PR permissions → fall back to `local` output, warn.
- local-diff + `fix` → fixes the working tree but does not push (no PR target) and posts nothing.
- Very large diff → proceed, but state in the summary if coverage was bounded.

---

## 7. Proposed frontmatter (for the eventual SKILL.md)
```yaml
name: swarm-loop-review
description: Multi-agent swarm review of a PR or local diff — fan out reviewers, debate findings to convergence, then discuss (collaborate) or fix-and-post (fix).
allowed-tools: [Task, Agent, Read, Edit, Bash, Grep, Glob]
```

---

## 8. Deferred decisions
- Consuming existing human review threads (respond-to-reviews style) — out of v1.
- Supersede mechanism for re-runs (hidden marker vs dismiss-old-review) — pick at build.
- Whether Risks is its own posted section or merged into Contested.
- Kill critic's context on a *cold* external PR (no build history) vs a diff the current session authored — the kill step is strongest in the latter.
- `review-double-checks.md` format — freeform prose vs lightly structured sections — pick at build.
