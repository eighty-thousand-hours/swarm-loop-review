export const meta = {
  name: 'swarm-loop-review',
  description:
    'Fan out reviewer lenses + Codex over a diff or plan, dedupe, then kill/rescue debate to convergence',
  phases: [
    { title: 'Review', detail: 'parallel reviewer lenses + Codex bug pass' },
    { title: 'Debate', detail: 'dedupe, then kill critic vs rescuer to convergence' },
  ],
}

// args contract (all paths absolute):
// {
//   repoRoot: string            — repo under review; agents may explore it
//   targetPath: string          — diff.patch (diff mode) or the plan file (plan mode)
//   planMode: boolean
//   mini: boolean               — two reviewers (combined lens + Codex), single rescue pass
//   doubleChecksPath: string|null  — review-double-checks.md, or null → skip Standards lens
//   prContextPath: string|null  — pr.md with PR title + body, or null
//   codexInvocation: string|null — shell command for the Codex pass with $CODEX_BIN placeholder,
//                                  or null → Claude-only
//   dismissed: string[]         — semantic descriptions of previously dismissed findings
//   maxRescuePasses: number     — convergence cap (6 full, 1 mini)
// }

// Tolerate a stringified args object — a known Workflow-tool invocation mistake.
const a = typeof args === 'string' ? JSON.parse(args) : args
if (!a || !a.repoRoot || !a.targetPath) {
  throw new Error('swarm-loop-review workflow needs args {repoRoot, targetPath, ...}')
}

const LENSES = [
  {
    key: 'correctness',
    name: 'Correctness',
    diff: 'Bugs that will break: logic errors, off-by-ones, bad edge cases, races, null/undefined throws, wrong data-shape/contract assumptions, missing error handling at boundaries. Not style; not security.',
    plan: 'Feasibility: assumptions the codebase contradicts (data shapes, existing APIs, framework behavior), missing error/edge-case handling in the design.',
  },
  {
    key: 'quality',
    name: 'Code Quality',
    diff: 'Redundant/derivable state, parameter sprawl, near-duplicate blocks, leaky abstractions, stringly-typed code, WHAT-narrating comments, needless JSX nesting, nested ternaries / over-clever one-liners.',
    plan: 'Design quality: duplicated or derivable state, wrong abstraction boundaries, parameter sprawl in proposed interfaces.',
  },
  {
    key: 'standards',
    name: 'Codebase Standards',
    diff: "Violations of the repo's review-double-checks.md (path given below). No built-in rules of your own — flag only what that file declares.",
    plan: 'The plan must not commit to anything review-double-checks.md forbids, and must name the conventions it triggers (migrations, restarts, test strategy, …). No built-in rules of your own.',
  },
  {
    key: 'reuse',
    name: 'Code Reuse',
    diff: 'Search the codebase for existing utilities the change should reuse instead of new code; flag duplicated functionality and hand-rolled logic. Spend most of your time exploring the repo, not reading the diff.',
    plan: 'The highest-value plan lens: existing utilities/components/patterns the plan should use instead of building new; proposed file locations vs where similar files already live.',
  },
  {
    key: 'security',
    name: 'Security',
    diff: 'Only >80%-confidence exploitable issues. Injection, auth/authz bypass, secrets/crypto, RCE/XSS (React is safe without dangerouslySetInnerHTML), sensitive-data exposure. Exclude DoS, rate-limiting, outdated deps, theoretical races; env vars and CLI flags are trusted; client-side needs no auth checks.',
    plan: 'Auth boundaries, data exposure, and trust decisions in the design.',
  },
  {
    key: 'efficiency',
    name: 'Efficiency',
    diff: 'Performance and resource use: redundant computation, repeated reads, N+1 patterns, missed concurrency, hot-path bloat, recurring no-op state updates, TOCTOU existence checks, memory/listener leaks, overly broad reads.',
    plan: "Work designed in that needn't exist: N+1 access patterns, hot-path bloat, missing batching/concurrency.",
  },
  {
    key: 'risks',
    name: 'Risks (for human judgment)',
    diff: 'Changes needing organizational context: perf/complexity shifts, interface/format/contract changes, behavioral changes (defaults, error semantics, security boundaries), new dependencies/coupling, scope changes. Only surface what the PR description does NOT already cover. These are not code-fix findings — they route to the human.',
    plan: 'Changes needing organizational context: perf/complexity shifts, contract changes, behavioral changes, new dependencies/coupling, scope changes. Only surface what the plan does not already cover. These route to the human.',
  },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['lens', 'severity', 'title', 'detail', 'citation'],
        properties: {
          lens: {
            type: 'string',
            enum: LENSES.map((l) => l.key),
            description: 'Which lens this finding belongs to',
          },
          severity: { type: 'string', enum: ['issue', 'suggestion', 'nit'] },
          title: { type: 'string' },
          detail: { type: 'string' },
          citation: {
            type: 'string',
            description:
              'file:line (diff mode); plan line/step plus supporting file:line where the claim rests on the codebase (plan mode)',
          },
          unsure: { type: 'boolean', description: 'true if you are not confident this is real' },
        },
      },
    },
    notes: { type: 'string', description: 'Coverage caveats, skipped checks, tool problems' },
  },
}

const DEDUPED_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'lens', 'severity', 'title', 'detail', 'citation', 'sources'],
        properties: {
          id: { type: 'string', description: 'F1, F2, …' },
          lens: { type: 'string', enum: LENSES.map((l) => l.key) },
          severity: { type: 'string', enum: ['issue', 'suggestion', 'nit'] },
          title: { type: 'string' },
          detail: { type: 'string' },
          citation: { type: 'string' },
          sources: {
            type: 'array',
            items: { type: 'string' },
            description: 'Reviewers that reported it — N>1 means corroborated',
          },
        },
      },
    },
  },
}

const CRITIC_SCHEMA = {
  type: 'object',
  required: ['decisions'],
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'verdict', 'reason'],
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['keep', 'dismiss'] },
          reason: { type: 'string', description: 'One line' },
        },
      },
    },
  },
}

const RESCUE_SCHEMA = {
  type: 'object',
  required: ['objections'],
  properties: {
    objections: {
      type: 'array',
      description: 'Empty array = OBJECTIONS: none (you accept every dismissal)',
      items: {
        type: 'object',
        required: ['id', 'argument'],
        properties: {
          id: { type: 'string', description: 'id of a dismissed finding to restore' },
          argument: { type: 'string', description: 'Your strongest case for restoring it' },
        },
      },
    },
  },
}

const objectMode = a.planMode ? 'plan' : 'diff'
const objectNoun = a.planMode ? 'implementation plan' : 'diff'

const contextBlock = [
  `Object under review (${objectNoun}): ${a.targetPath}`,
  `Repo root (you may explore it for context): ${a.repoRoot}`,
  a.prContextPath ? `PR title + body: ${a.prContextPath}` : null,
  a.doubleChecksPath
    ? `Codebase review standards: ${a.doubleChecksPath}`
    : 'No review-double-checks.md in this repo.',
]
  .filter(Boolean)
  .join('\n')

const dismissedBlock =
  a.dismissed && a.dismissed.length > 0
    ? `Previously dismissed findings — do NOT resurface anything semantically matching these (semantic match, not string match):\n${a.dismissed.map((d) => `- ${d}`).join('\n')}`
    : ''

function reviewerPreamble(lensLine) {
  return [
    `You are one reviewer in a multi-agent review swarm examining a ${objectNoun}.`,
    '',
    lensLine,
    '',
    'Read the files below before anything else, then review strictly through your lens(es):',
    contextBlock,
    '',
    'Rules:',
    '- Review-only: make no edits anywhere.',
    '- You may explore the wider repo for context (Read/Grep/Glob/Bash).',
    '- Ignore issues confined to test files.',
    '- Surface anything you are unsure about with "unsure": true rather than staying silent.',
    a.planMode
      ? '- Every finding cites the plan line/step being flagged, plus file:line of existing code wherever the claim rests on the codebase.'
      : '- Every finding cites file:line. Mandatory.',
    '- Actionable findings only — no praise, no "verified X" filler.',
    dismissedBlock,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

function lensPrompt(lens) {
  return reviewerPreamble(
    `Your lens — ${lens.name}: ${lens[objectMode]}\nTag every finding with lens "${lens.key}".`,
  )
}

function combinedPrompt(lenses) {
  const lensList = lenses.map((l) => `- ${l.name} ("${l.key}"): ${l[objectMode]}`).join('\n')
  return reviewerPreamble(
    `You cover ALL of the following lenses in a single pass; tag each finding with its lens key:\n${lensList}`,
  )
}

function codexPrompt() {
  return [
    'You run the Codex bug pass of a review swarm — a non-Claude second opinion focused on bugs.',
    '',
    'Resolve the real Codex binary first (the Superconductor wrapper can hang non-interactively), plus a temp file for its output:',
    '',
    "  CODEX_BIN=\"$(which -a codex | grep -v '/.superconductor/' | head -n1)\"",
    '  CODEX_OUT="$(mktemp)"',
    '',
    'If $CODEX_BIN is empty, do not improvise a substitute: return zero findings with notes "codex binary not found".',
    'Otherwise run exactly this command from the repo root, substituting $CODEX_BIN and $CODEX_OUT (one pass only; never resume or follow up):',
    '',
    `  cd ${a.repoRoot} && ${a.codexInvocation}`,
    '',
    'Give it time — minutes, not seconds. Then read the review from "$CODEX_OUT", NOT stdout: codex streams its whole agent session (config banner + every tool call and its output) to stdout and writes only the final review message to the -o file, so stdout reads as tool noise. A non-empty $CODEX_OUT is the review (exit code is 0 whether it found issues or not); an empty/absent file is the only true "no review" signal — return zero findings with notes "codex produced no review", never scrape stdout to recover them. Translate the review into findings:',
    '- Map each reported problem to the closest lens key (default "correctness").',
    '- Severity: breaking bug → issue; improvement → suggestion; trivia → nit.',
    a.planMode
      ? '- Citations: the plan line/step concerned, plus file:line where applicable.'
      : '- Citations: file:line from the report (resolve them against the repo if the report is vague).',
    '- Drop findings confined to test files.',
    dismissedBlock,
    '',
    'Context for interpreting the output:',
    contextBlock,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

const DISPOSITION_POLICY = [
  'Disposition policy:',
  '- No blanket default-dismiss or default-fix. Use judgment, and weigh cost vs benefit — never benefit alone (a tiny-benefit change is still worth it when its cost is ~zero; a large-benefit change is not when it is expensive, risky, or out of scope).',
  '- Default to fixing the two areas review swarms habitually under-act on: (a) any violation of the repo review-double-checks.md conventions; (b) over-explaining / change-narrating comments. A default, not always-fix — judgment can still dismiss with good reason.',
  '- Nits elsewhere: keep only when the fix is clearly net-positive (cheap AND genuinely clearer).',
  '- Resolve scope here, do not escalate reflexively. Only genuinely disputed items should survive to the human.',
  '- "risks"-lens findings are for the human, not code fixes: keep them unless the PR description / plan already covers them.',
].join('\n')

function criticPrompt(findings, priorDecisions, rescue) {
  const revision = priorDecisions
    ? [
        '',
        `Your previous decisions:\n${JSON.stringify(priorDecisions)}`,
        '',
        `A fresh rescuer objected to these dismissals:\n${JSON.stringify(rescue.objections)}`,
        '',
        'Reconsider each objected dismissal on its merits — you need not concede, but you must genuinely reweigh it, not restate yourself.',
      ].join('\n')
    : ''
  return [
    `You are the kill critic in a review debate over a ${objectNoun}. Triage EVERY finding below: verdict "keep" or "dismiss", with a one-line reason each. Return a decision for every finding id — no omissions.`,
    '',
    DISPOSITION_POLICY,
    '',
    'Context files (read as needed to judge a finding):',
    contextBlock,
    '',
    `Findings:\n${JSON.stringify(findings)}`,
    revision,
  ].join('\n')
}

function rescuePrompt(findings, decisions) {
  return [
    `You are a fresh-eyed rescuer in a review debate over a ${objectNoun}. Your only inputs are the findings and the kill critic's current keep/dismiss decisions — you are not re-reviewing the ${objectNoun}.`,
    '',
    'Argue to RESTORE dismissed findings that matter — especially codebase-convention violations, comment-hygiene findings, and cheap net-positive nits. The critic systematically under-values these.',
    '',
    DISPOSITION_POLICY,
    '',
    'Object only where you genuinely disagree with a dismissal; return an empty objections array when you accept them all. Findings the critic kept need no defense.',
    '',
    'Context files (read as needed):',
    contextBlock,
    '',
    `Findings:\n${JSON.stringify(findings)}`,
    '',
    `Current decisions:\n${JSON.stringify(decisions)}`,
  ].join('\n')
}

// ---- Phase: Review ----------------------------------------------------------

phase('Review')

const activeLenses = LENSES.filter((l) => l.key !== 'standards' || a.doubleChecksPath)
if (activeLenses.length < LENSES.length) {
  log('⚠️ no review-double-checks.md — Codebase Standards lens skipped')
}

// Wrap each reviewer so a single agent failure logs and drops to null rather
// than rejecting the whole parallel() barrier — the partial-failure handling
// below then accounts for the missing reviewer.
const finder = (prompt, label, source) => () =>
  agent(prompt, { label, phase: 'Review', schema: FINDINGS_SCHEMA })
    .then((r) => r && { source, ...r })
    .catch((err) => {
      log(`${source} reviewer errored: ${(err && err.message) || err}`)
      return null
    })

const finderThunks = []
if (a.mini) {
  finderThunks.push(finder(combinedPrompt(activeLenses), 'lens:combined', 'combined'))
} else {
  for (const lens of activeLenses) {
    finderThunks.push(finder(lensPrompt(lens), `lens:${lens.key}`, lens.key))
  }
}
if (a.codexInvocation) {
  finderThunks.push(finder(codexPrompt(), 'codex', 'codex'))
} else {
  log('Codex pass disabled (no invocation supplied) — Claude-only review')
}

// Barrier (not pipeline): the dedupe step genuinely needs every reviewer's
// findings at once to merge cross-source duplicates.
const reviews = (await parallel(finderThunks)).filter(Boolean)

const notes = []
if (reviews.length < finderThunks.length) {
  notes.push(`${finderThunks.length - reviews.length} reviewer(s) failed or were skipped`)
}
for (const review of reviews) {
  if (review.notes) notes.push(`${review.source}: ${review.notes}`)
}

const rawFindings = reviews.flatMap((review) =>
  (review.findings || []).map((f) => ({ ...f, source: review.source })),
)
log(`${rawFindings.length} raw finding(s) from ${reviews.length} reviewer(s)`)

if (rawFindings.length === 0) {
  return { agreed: [], contested: [], dismissed: [], notes, rescuePasses: 0 }
}

// ---- Phase: Debate ----------------------------------------------------------

phase('Debate')

const deduped = await agent(
  [
    'Dedupe these review findings from multiple reviewers. The same underlying issue reported by N reviewers becomes ONE finding listing all its sources (corroboration raises confidence — note it in the merged detail). Distinct issues at the same location stay separate.',
    'Keep the strongest phrasing and the most precise citation; preserve the lens of the primary report; assign ids F1, F2, … in input order.',
    '',
    `Findings:\n${JSON.stringify(rawFindings)}`,
  ].join('\n'),
  { label: 'dedupe', phase: 'Debate', schema: DEDUPED_SCHEMA },
)
if (!deduped) throw new Error('dedupe agent failed')
const findings = deduped.findings || []
log(`${findings.length} finding(s) after dedupe`)

let criticOut = await agent(criticPrompt(findings, null, null), {
  label: 'critic:1',
  phase: 'Debate',
  schema: CRITIC_SCHEMA,
})
if (!criticOut) throw new Error('kill critic failed on the first pass')
let decisions = criticOut.decisions || []

let contestedIds = []
let rescuePasses = 0
for (let pass = 1; pass <= a.maxRescuePasses; pass++) {
  rescuePasses = pass
  const rescue = await agent(rescuePrompt(findings, decisions), {
    label: `rescue:${pass}`,
    phase: 'Debate',
    schema: RESCUE_SCHEMA,
  })
  if (!rescue) {
    notes.push(`rescue pass ${pass} failed — treating as no objections`)
    break
  }
  // Rescuers can only restore dismissals; objections to kept findings are noise.
  const dismissedIds = new Set(
    decisions.filter((d) => d && d.verdict === 'dismiss').map((d) => d.id),
  )
  const objections = (rescue.objections || []).filter((o) => o && dismissedIds.has(o.id))
  log(`rescue pass ${pass}: ${objections.length} objection(s)`)
  if (objections.length === 0) break
  if (pass === a.maxRescuePasses) {
    contestedIds = objections.map((o) => o.id)
    break
  }
  criticOut = await agent(criticPrompt(findings, decisions, { objections }), {
    label: `critic:${pass + 1}`,
    phase: 'Debate',
    schema: CRITIC_SCHEMA,
  })
  if (!criticOut) {
    notes.push(`critic pass ${pass + 1} failed — standing dismissals become contested`)
    contestedIds = objections.map((o) => o.id)
    break
  }
  decisions = criticOut.decisions || []
}

const decisionById = new Map(
  decisions.filter((d) => d && d.id).map((d) => [d.id, d]),
)
const contestedSet = new Set(contestedIds)
const agreed = []
const contested = []
const dismissed = []
for (const finding of findings) {
  const decision = decisionById.get(finding.id)
  if (!decision) {
    // Critic omitted it despite instructions — surfacing beats silently dropping.
    notes.push(`no verdict for ${finding.id} — kept by default`)
    agreed.push(finding)
  } else if (contestedSet.has(finding.id)) {
    contested.push({ ...finding, dismissalReason: decision.reason })
  } else if (decision.verdict === 'keep') {
    agreed.push({ ...finding, keepReason: decision.reason })
  } else {
    dismissed.push({ ...finding, dismissalReason: decision.reason })
  }
}

log(
  `converged after ${rescuePasses} rescue pass(es): ${agreed.length} agreed / ${contested.length} contested / ${dismissed.length} dismissed`,
)

return { agreed, contested, dismissed, notes, rescuePasses }
