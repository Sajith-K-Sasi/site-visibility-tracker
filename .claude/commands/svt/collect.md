---
description: "Collect site × keyword visibility across the Google organic lane + the five AI-chat engines (single, ad-hoc). Parses a pasted block (URL + keyword lines) into normalized records, scaffolds a resumable runs/<id>/, fans checks out as site × keyword × selected platforms, dispatches the svt-google and svt-ai-engine collector subagents per check, and writes evidence-backed organic_positional / ai_presence records. --platforms selects the lanes; --dry-run validates input + probes one keyword per lane without running the full set."
argument-hint: "[pasted block: a URL line then keyword lines]  [--platforms=google,chatgpt,gemini,claude,grok,perplexity]  [--dry-run]"
allowed-tools: Bash, Read, Write, Task
---

# /svt:collect — single-site collection across Google + AI engines (+ --dry-run)

You are the **orchestrator** for an ad-hoc, single-site collection across one or more **platform
lanes** (Google organic + the five AI chats). You parse the input, lay down a resumable run folder,
dispatch the right collector subagent per check, and surface results. Each subagent does the browsing
+ judging + its own write; **you own** the run folder, the resume-diff, the quarantine view, and any
human-in-the-loop (HIL) re-queue.

> **What this command does = Google + the five AI engines, one lane at a time, from pasted-block input.**
> CSV batch, bounded concurrency, inter-check jitter, and the circuit-breaker live in the batch sibling
> `/svt:run`; reporting is `/svt:report`. This is the single-site, interactive path — don't reach into the
> batch concerns here.

> **Contracts (read, don't duplicate):** `input-contract.md` (§3 pasted-block → normalized records),
> `recipe-table.md` (the six platform rows the lanes are parameterized by), `run-layout.md` (runs/<id>/
> layout, NDJSON append path, §3 resume protocol keyed on `(site_url, keyword, platform)`, §4 evidence
> naming), `result-shapes.md` (the records the lanes write — organic_positional / ai_presence).
> **Browsing flags live in the `playwright-cli` skill** — the subagents use them; you don't drive the
> browser directly.

## Behavior

**Args:**
- `/svt:collect <pasted block>` — collect the block's site × keywords across the **selected platforms**.
- `/svt:collect --platforms=<list> <pasted block>` — restrict to the named lanes (any of
  `google,chatgpt,gemini,claude,grok,perplexity`).
- `/svt:collect --dry-run <pasted block>` — validate + probe one keyword per selected lane; run no full set.
- Re-invoking against an existing `runs/<id>/` **resumes** it (skips terminal checks).

### 0a. Preflight — toolchain + scaffold (fail fast, before parsing input)

Verify the toolchain is present **before** parsing input, so a missing dependency fails in **one clear
line** instead of mid-collection:

- **`playwright-cli` on PATH** *and* the **`playwright-cli` skill** present (`.claude/skills/playwright-cli/`).
- **`runs/` and `inputs/` directories exist** (created by `/svt:setup`).

If any is missing → **stop with a single remediation message: "Run `/svt:setup` first."** Do not partially
proceed.

> **Toolchain/scaffold gate only — login is NOT gated here.** Per-platform logged-in state stays the
> *soft*, honest `skipped-no-session` prognosis in §0 (an AI lane with no session is recorded, never a
> hard stop; google login is optional). The preflight only guards the things that make *every* lane fail.

### 0. Platform selection (which lanes run)

- **`--platforms=<comma-list>`** explicitly selects lanes (subset of the six recipe ids). Unknown names
  are reported and ignored; if the flag resolves to an empty set, stop and ask.
- **Omitted →** default to **every platform that currently has a usable session**:
  - `google` is **always** included (login is OPTIONAL — the organic SERP is public).
  - an AI chat is included if its `profiles/<platform>` session looks logged-in (profile dir present;
    the lane re-confirms via the recipe `logged_in_signal` at dispatch — same judgment `/svt:login
    --status` uses). A selected AI platform with **no** logged-in session is **still enqueued** and the
    lane records it `skipped-no-session` — **never silently dropped** (the unknown stays `unknown`).
- Echo the resolved lane set + each lane's live/skip prognosis before dispatching.

### 1. Intake → normalized records (input-contract §3, pasted-block mode)

- The **first line that is a URL** → `site_url` (verbatim, deep paths kept).
- Each subsequent **non-empty line** → one `keyword` — strip a leading `N.` / `N)` / `-` / `*`
  enumerator; keep the rest **verbatim**.
- Resolve each to a normalized record: `brand` derived from the registrable domain unless given;
  `locale` defaults to **`in`**; `prompt_override` null; `query = prompt_override || keyword`.
- **Collapse** duplicate `(site_url, keyword)`. **Skip + log** malformed/blank lines (note them in the
  run log / `input.snapshot.json`) — never abort.
- (Pasted-block mode does **not** parse per-row `brand`/`locale`/`prompt_override`; those need CSV mode
  (`/svt:run`). To measure these the region hotels at `ae`, pass locale at invocation / note it for the run. `brand`
  is load-bearing for the AI lanes — AI presence is a name match — so set it explicitly when the
  domain-derived guess is poor.)

### 2. Run scaffold (run-layout §2)

- Mint `run_id = svt-YYYYMMDD-HHMMSS` (UTC, `date -u +svt-%Y%m%d-%H%M%S`).
- Create `runs/<id>/` with `evidence/` and an empty `results.ndjson` (top-level `runs/` already exists
  from `/svt:setup`).
- Write `runs/<id>/input.snapshot.json` — the JSON array of resolved normalized records **plus the
  resolved platform set** for this run. This is the run's provenance **and** the resume source of truth.

### 3. Resume-diff (run-layout §3) — before dispatching anything

- The check identity key is **`(site_url, keyword, platform)`** — one keyword now yields **one check per
  selected platform**.
- If `results.ndjson` already has lines (re-invoked run), read it. For each key, the **last** line wins.
  A check is **DONE** if its last status is terminal (`ok` / `not_applicable` / `skipped-no-session` /
  `quarantined` / `error`).
- Dispatch only checks with **no record** plus any **`needs-human`** (non-terminal). Everything terminal
  is left untouched — never re-collected. (A `skipped-no-session` is terminal: a later re-run retries it
  only if a session is now present **and** the user asks.)

### 4. Dispatch the lanes (single lane at a time, sequential)

- The pending set = `site × keyword × {selected platforms}` minus the terminal checks.
- For each pending check, **route by platform** and invoke the collector subagent (Task tool), passing
  the normalized record **and** the `platform` **and** run context (`run_id`, `run_dir = runs/<id>`,
  `evidence_dir = runs/<id>/evidence`, **`mode=attended`**). `/svt:collect` is the interactive,
  always-human-present path → it **always** passes `mode=attended` (it has no `--unattended`); the lane's
  step-3 challenge wait + grok fresh-login therefore patiently wait for the human **in-line**.
  `mode` is run-context, not a record field (no schema change):
  - `platform=google` → **`svt-google`** (organic_positional).
  - `platform ∈ {chatgpt,gemini,claude,grok,perplexity}` → **`svt-ai-engine`** (ai_presence).
- The subagent browses, judges, captures evidence, **appends its own `results.ndjson` line**, and
  returns a compact summary (`svt-google`: `{status,found,position,ranking_url,screenshot_path}`;
  `svt-ai-engine`: `{status,mentioned,cited,match_confidence,screenshot_path}`). This command runs **one
  lane at a time, sequentially** — no concurrency/jitter (that's the batch sibling `/svt:run`).

### 5. Post: quarantine view + HIL backstop (you own these)

- After the lanes return, materialize `runs/<id>/quarantine.json` as a **view** over `results.ndjson`
  — the records whose status is `quarantined` or `needs-human` (a view, not a second source of truth).
- Since collect is always attended, the **lane patiently waits for the human in-line** (via
  step 3 / grok step 2) and typically clears the challenge **inside the check** — so a `needs-human` here
  means the lane gave up after its outer cap (the human walked away). For each such **`needs-human`** (a
  Google `/sorry/` reCAPTCHA, an AI Cloudflare interstitial, a login wall): **own the HIL re-queue as the
  backstop** — surface the blocked check, let the human clear it in the headed window, then
  **re-dispatch** that check. The run folder, resume-diff, quarantine view, and this re-queue stay at the
  orchestrator; the attended challenge *wait* is the one piece that lives in the lane (a deliberate, narrow
  exception to "never inside a lane" for that wait).

### 6. Summary

Print a per-check table (one row per `keyword × platform`) + counts:

```
Keyword                      Platform    Status  Signal                         Evidence
---------------------------  ----------  ------  -----------------------------  ----------------------------------------
best hotel in downtown      google      ok      pos 3 · example-hotel.com         evidence/google__example-hotel__best-hotel-in-downtown.png
best hotel in downtown      perplexity  ok      mentioned · cited:no · high    evidence/perplexity__example-hotel__best-hotel-in-downtown.png
best hotel in downtown      grok        skip    skipped-no-session             —

ok: 8   quarantined: 0   needs-human: 1   skipped-no-session: 2   error: 0     → runs/svt-20260605-101500/
```

(Google rows show `pos N · domain`; AI rows show `mentioned · cited:yes/no · <confidence>`.)

## `--platforms` examples

- `--platforms=google` — Google organic only.
- `--platforms=perplexity` — one AI lane.
- `--platforms=google,chatgpt,perplexity` — three lanes per keyword.
- *(omitted)* — Google + every AI engine with a logged-in session; the rest recorded `skipped-no-session`.

## `--dry-run` (input-agnostic, non-destructive smoke — ALWAYS run before a full run)

Do steps **0–2** (platform selection + intake + scaffold), then:

1. **Echo** the resolved normalized records (so input parsing is eyeballable) + the resolved lane set.
2. **Report each selected lane** as LIVE vs `skipped-no-session`: `google` is effectively always LIVE
   (note if `profiles/google` is absent so the user knows it's anonymous); each AI lane is LIVE if its
   `profiles/<platform>` session looks logged-in, else flagged `skipped-no-session` (and grok flagged
   per its known non-persistence — fallback `attach --cdp`/`state-load` or skip).
3. **Print what each lane WOULD issue for keyword #1:** for `google`, the exact verbatim search URL
   (`https://www.google.com/search?q=…&gl=<locale>&hl=en&pws=0&start=0`); for each AI lane, the exact
   **verbatim `query`** it would type into the composer (no rewrite).
4. **Probe keyword #1 only** — dispatch the right subagent for the **first** record on **each LIVE
   selected lane** (one real check per lane, capturing evidence + the parsed record) so extraction can
   be sanity-checked. Skipped lanes are not probed.
5. **Print a scope estimate** — total checks (= sites × keywords × selected lanes), active lanes, rough ETA.

It does **NOT** run the full keyword set. Example: 1 URL + 9 keywords × {google,perplexity} → ~2 probe
checks (one per LIVE lane), not 18.

## Rules recap

- Google + AI engines · single lane at a time · pasted-block only (CSV/batch = `/svt:run`) · no report (use `/svt:report`).
- **Route by platform:** `google`→`svt-google`, the five chats→`svt-ai-engine`. The check key is
  `(site_url, keyword, platform)` (run-layout §3).
- The **subagent writes** its record + evidence; **you** own the run folder, resume-diff, quarantine
  view, and HIL re-queue.
- **Never silently drop a check, never a false "not found":** `ok + found:false`/`mentioned:false`
  (we looked, the brand isn't there) ≠ `skipped-no-session` (no session — we couldn't look) ≠
  `needs-human` (a challenge blocked us) — keep them distinct (result-shapes §2).
- Always `--dry-run` before a full run.
- Nothing under `runs/` is committed (gitignored).
