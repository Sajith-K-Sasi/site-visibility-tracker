---
description: "Batch-collect site × keyword visibility across the Google organic lane + the five AI-chat engines from a reusable CSV. Reads inputs/<file>.csv into normalized records (grouped by site), scaffolds a resumable runs/<id>/, fans checks out as site × keyword × selected platforms, and dispatches the svt-google and svt-ai-engine collector subagents with across-platform concurrency (one persistent session per platform) + serial-within-a-platform jitter. --platforms selects the lanes; --max-lanes caps parallel lanes; --dry-run validates input + probes one keyword per lane without running the full set."
argument-hint: "[inputs/<file>.csv]  [--platforms=google,chatgpt,gemini,claude,grok,perplexity]  [--max-lanes=N]  [--unattended]  [--max-retries=N]  [--breaker-threshold=N]  [--max-wall-clock=<dur>]  [--cooldown=<dur>]  [--resume=<run_id>]  [--dry-run]"
allowed-tools: Bash, Read, Write, Task
---

# /svt:run — batch CSV collection across Google + AI engines (resumable, concurrent)

You are the **batch orchestrator**. You read a reusable **CSV** of `site × keyword` work, lay down a
resumable run folder, fan the work out as `site × keyword × platform`, and dispatch the right
collector subagent per check — running **multiple platform lanes in parallel** while keeping each
single platform **sequential** (one persistent profile per platform is the binding constraint). Each
subagent does the browsing + judging + its own write; **you own** the run folder, the resume-diff,
the quarantine view, and any human-in-the-loop (HIL) re-queue.

`/svt:run` is the batch sibling of `/svt:collect`: same contracts, same collector subagents, same
dispatch + resume + HIL semantics — scaled from one pasted site to a many-site CSV, with concurrency.

> **What this command does:** batch CSV intake + across-platform concurrency + inter-check jitter +
> batch `--dry-run` + summary, **plus resilience:** failure classification + bounded retry/backoff (§4a),
> per-lane **circuit-breaker** + global **wall-clock cap** (§4b), and **attended-vs-`--unattended`**
> challenge routing (§4c). The **attended** HIL clearance carried over from `/svt:collect` is the default;
> **`--unattended` never blocks** for a human (an unclearable challenge → `quarantined`, not a pause).
> All resilience reuses the existing 6-value status enum — **no new status value**.

> **Contracts (read, don't duplicate):** `input-contract.md` (**§2 CSV mode** → normalized records),
> `recipe-table.md` (the six platform rows the lanes are parameterized by), `run-layout.md` (runs/<id>/
> layout, NDJSON append path, **§3 resume protocol** keyed on `(site_url, keyword, platform)`, §4
> evidence naming, **§6** where this command's concurrency/jitter are recorded), `result-shapes.md`
> (the records the lanes write — organic_positional / ai_presence). **Browsing flags live in the
> `playwright-cli` skill** — the subagents use them; you don't drive the browser directly.

## Behavior

**Args:**
- `/svt:run inputs/<file>.csv` — batch-collect the CSV's sites × keywords across the **selected platforms**.
- `/svt:run --platforms=<list> inputs/<file>.csv` — restrict to the named lanes (any of
  `google,chatgpt,gemini,claude,grok,perplexity`).
- `/svt:run --max-lanes=<N> inputs/<file>.csv` — cap the number of platform lanes dispatched in parallel
  per round (default = the number of active platforms, ≤6).
- `/svt:run --dry-run inputs/<file>.csv` — validate + probe one keyword per selected lane; run no full set.
- `/svt:run --unattended inputs/<file>.csv` — **never block for a human**: challenges are handled with
  per-platform cooldown + bounded retry, and a still-unclearable challenge is recorded `quarantined` rather
  than paused for HIL. Default is **attended** (headed HIL clearance). See **Resilience** + §4c.
- `/svt:run --max-retries=<N> inputs/<file>.csv` — cap the orchestrator's re-dispatches of a *transient*
  `error` (default **2**; exponential backoff + jitter). See §4a.
- `/svt:run --breaker-threshold=<N> inputs/<file>.csv` — consecutive-block count that trips a lane's
  circuit-breaker and pauses it for the rest of the run (default **3**). See §4b.
- `/svt:run --max-wall-clock=<dur> inputs/<file>.csv` — global time cap (e.g. `90m`, `4h`); once exceeded,
  stop dispatching new checks, let in-flight finish, record the rest `needs-human` (default **none**). See §4b.
- `/svt:run --cooldown=<dur> inputs/<file>.csv` — per-platform pause after a block before re-dispatch
  (default **60s**, grows per consecutive block); the `--unattended` pacing knob. See §4c.
- `/svt:run --resume=<run_id> [inputs/<file>.csv]` — **resume an existing run**: bind to `runs/<run_id>/`
  and continue from its `results.ndjson` (skips terminal checks, re-attempts `needs-human`). The CSV arg is
  optional on resume (the run's `input.snapshot.json` is the source of truth); if you do pass one, it must
  resolve to the same records or the command warns + stops rather than silently diverging.
- **How a re-run is identified:** resume is bound to the **run folder**, not the CSV. Without `--resume`,
  every invocation **mints a fresh `run_id`** (a new run) — so re-typing the same CSV starts over. Use
  `--resume=<run_id>` to continue a prior run. (Best-effort: if no `--resume` is given but an *incomplete*
  run with a matching `input.snapshot.json` exists, the command surfaces it and offers `--resume` instead of
  silently starting a duplicate.)

### 0a. Preflight — toolchain + scaffold (fail fast, before parsing input)

A batch can fan out thousands of checks; verify the toolchain is present **before** parsing input, so a
missing dependency fails in **one clear line** instead of mid-run after partial work:

- **`playwright-cli` on PATH** *and* the **`playwright-cli` skill** present (`.claude/skills/playwright-cli/`).
- **`runs/` and `inputs/` directories exist** (created by `/svt:setup`).

If any is missing → **stop with a single remediation message: "Run `/svt:setup` first."** Do not partially
proceed.

> **Toolchain/scaffold gate only — login is NOT gated here.** Per-platform logged-in state stays the
> *soft*, honest `skipped-no-session` prognosis in §0 (an AI lane with no session is recorded, never a
> hard stop; google login is optional). The preflight only guards the things that make *every* lane fail.

### 0. Platform selection (which lanes run)

Identical rule to `/svt:collect` §0:

- **`--platforms=<comma-list>`** explicitly selects lanes (subset of the six recipe ids). Unknown names
  are reported and ignored; if the flag resolves to an empty set, stop and ask.
- **Omitted →** default to **every platform that currently has a usable session**:
  - `google` is **always** included (login is OPTIONAL — the organic SERP is public).
  - an AI chat is included if its `profiles/<platform>` session looks logged-in (profile dir present;
    the lane re-confirms via the recipe `logged_in_signal` at dispatch). A selected AI platform with
    **no** logged-in session is **still enqueued** and the lane records it `skipped-no-session` —
    **never silently dropped** (the unknown stays `unknown`).
- Echo the resolved lane set + each lane's live/skip prognosis before dispatching.

### 1. CSV intake → normalized records (input-contract §2, CSV mode)

Read `inputs/<file>.csv` and apply **input-contract §2** in-context (there is no parser code — you are
the parser; honor the contract, do not re-define its field rules here):

- Required header columns **`site_url,keyword`**; optional **`brand,locale,prompt_override`**. Match
  columns **by header name** — column order is free; ignore unknown extra columns (forward-compatible).
- **Group rows by `site_url`** (all keywords for a site collected together).
- Resolve each row to the **one normalized record** (input-contract §1): `brand` derived from the
  registrable domain unless given; `locale` defaults to **`in`** unless given (per-row override allowed,
  e.g. `ae`); `prompt_override` null unless given; `query = prompt_override || keyword`, and the **raw
  keyword is used verbatim** (no keyword→question transform).
- **Edge handling (input-contract §4) — never crash, never silently drop:** skip **and log** any
  malformed/blank row (missing `site_url` or `keyword`, comment line) as *skipped-malformed* in the run
  log / `input.snapshot.json`; **collapse** duplicate `(site_url, keyword)` to one record; a `locale`
  the recipe-table can't map → log + fall back to `in`. Never abort the batch over one bad row.

### 2. Run scaffold or resume (run-layout §2) — this is where "fresh vs re-run" is decided

**Determine the `run_id` first:**

- **`--resume=<run_id>` given → RESUME.** The run must already exist as `runs/<run_id>/` with an
  `input.snapshot.json` (else stop: "no such run to resume"). **Reuse it as-is** — do **not** re-scaffold,
  do **not** overwrite the snapshot or `results.ndjson`. The snapshot is the source of truth; if a CSV arg
  was also passed, re-resolve it and **stop with a warning on any mismatch** rather than silently diverging.
- **No `--resume` → default is a FRESH run.** Best-effort first: scan `runs/*/input.snapshot.json` for an
  **incomplete** run (one with pending/`needs-human` keys) whose resolved records + platform set **match**
  this input; if found, **surface it and offer `--resume=<that-id>`** instead of silently creating a
  duplicate. Otherwise mint `run_id = svt-YYYYMMDD-HHMMSS` (UTC, `date -u +svt-%Y%m%d-%H%M%S`).

**Scaffold (FRESH only):**
- Create `runs/<id>/` with `evidence/` and an empty `results.ndjson` (top-level `runs/` already exists
  from `/svt:setup`).
- Write `runs/<id>/input.snapshot.json` — the JSON array of resolved normalized records **plus the
  resolved platform set** (and any *skipped-malformed* rows, noted). This is the run's provenance **and**
  the resume source of truth; the run no longer depends on the original CSV.

**On RESUME**, the folder + `input.snapshot.json` already exist — skip scaffolding entirely and go straight
to the resume-diff (§3), which reads the existing `results.ndjson` to compute what's still pending.

### 3. Resume-diff (run-layout §3) — before dispatching anything

- The check identity key is **`(site_url, keyword, platform)`** — one keyword yields **one check per
  selected platform**.
- If `results.ndjson` already has lines (re-invoked run), read it. For each key, the **last** line wins.
  A check is **DONE** if its last status is terminal (`ok` / `not_applicable` / `skipped-no-session` /
  `quarantined` / `error`).
- Dispatch only checks with **no record** plus any **`needs-human`** (non-terminal). Everything terminal
  is left untouched — never re-collected. (A `skipped-no-session` is terminal: a later re-run retries it
  only if a session is now present **and** the user asks.)

### 4. Dispatch the lanes — across-platform parallel, serial within a platform, with jitter

The pending set = `site × keyword × {selected platforms}` minus the terminal checks. The concurrency
model is **across platforms in parallel, sequential within a platform** — because each platform has
exactly **one persistent `profiles/<platform>`**, and bot-detection (Google `/sorry/`, AI Cloudflare)
is the binding constraint. Two checks must never hit one platform's profile at once.

**Per-platform queues.** Group the pending checks into **one FIFO queue per active platform** (its
keyword order across all sites — sites are interleaved, the queue is just that platform's pending work).

**Round-by-round execution (this is how parallelism + serialization both fall out):**

1. **Active lanes** = the platforms with a non-empty queue, capped at `N = --max-lanes` (default = the
   count of active platforms, ≤6). If more platforms are active than `N`, rotate which platforms get a
   slot each round (round-robin) so **every** platform keeps progressing — never starve a lane.
2. Each **round**, take the **head** of each active lane's queue and **dispatch those checks in
   parallel** — issue all the `Task` calls **in a single message** so the platform lanes advance
   concurrently. (One google check + one perplexity check + … run at the same time; never two google
   checks at once.)
3. **Wait** for the round's checks to return, then start the next round with the new heads.
4. **One named session per profile:** each platform lane drives its own `playwright-cli` named session
   against `profiles/<platform>` (e.g. `-s=svt-google`, `-s=svt-perplexity`, `--profile=profiles/<p>`),
   so no two concurrently-running checks share a profile dir.

**Inter-check jitter (per lane, non-blocking across lanes).** Between a platform's **successive** checks
(i.e. before that lane dispatches its next head), sleep a **randomized** delay so a lane never machine-
guns its target. Jitter is per-lane — one lane's sleep does not hold up other lanes' rounds. Sensible
**agent-tunable defaults**:

| Lane | Default jitter band | Why |
|------|--------------------|-----|
| `google` | ~8–20 s | The `/sorry/` rate-limit is the tightest constraint; widest band |
| AI chats (`chatgpt,gemini,claude,grok,perplexity`) | ~3–8 s | Logged-in chat sessions tolerate a faster cadence than anonymous SERP fetches |

(These are starting values — tune per observed challenge rate. The *adaptive* throttle / circuit-breaker
that reacts to repeated blocks is **§4b**, below.)

**Route by platform** (the collector subagents are reused with the **same dispatch contract** as
`/svt:collect` §4, now carrying the `mode` signal). For each dispatched check, invoke the subagent (Task
tool) with the normalized record **and** the `platform` **and** run context (`run_id`, `run_dir =
runs/<id>`, `evidence_dir = runs/<id>/evidence`, **`mode`**). **`mode = unattended` iff `--unattended`
is set, else `attended`** — this is the seam the lanes' step-3 challenge wait + the grok fresh-login
branch read. `mode` is **run-context, not a record field** → no schema change, no new status:
- `platform=google` → **`svt-google`** (organic_positional); returns `{status,found,position,ranking_url,screenshot_path}`.
- `platform ∈ {chatgpt,gemini,claude,grok,perplexity}` → **`svt-ai-engine`** (ai_presence); returns
  `{status,mentioned,cited,match_confidence,screenshot_path}`.

The subagent browses, judges, captures evidence, **appends its own `results.ndjson` line**, and returns
its compact summary. You record nothing on its behalf — you only track which checks have returned to
drive the next round.

**Challenge handling — lane-side patient wait (attended), orchestrator re-queue as backstop.**
In **attended** mode the **lane itself** now keeps the headed window open and **patiently waits for the
human** to clear the `/sorry/` reCAPTCHA / Cloudflare interstitial / login wall, then continues the check
in-line (svt-google/svt-ai-engine step 3) — eliminating the poll-15s→`needs-human`→re-dispatch round-trip.
The orchestrator's post-round HIL re-queue is now the **backstop**: a check the lane *still* returns
**`needs-human`** (the human walked away past the lane's outer cap, or appeared only after it gave up) is
surfaced after the round, cleared in the headed window, and **re-queued** to its lane. The run folder,
resume-diff, quarantine view, and this re-queue stay at the orchestrator; the **attended challenge wait**
is the one piece that lives in the lane (a deliberate, narrow exception to "never inside
a lane" for that wait). In **`--unattended`** the lane never waits — see §4c.

### 4a. Failure handling — classify + bounded retry

A returned status is **classified, not blindly retried** — the honesty enum already tells us whether a
check is done, transient, or blocked:

| Returned status | Class | Orchestrator action |
|-----------------|-------|---------------------|
| `ok` | done | terminal — record stands; **resets** the lane's consecutive-block counter (§4b) |
| `not_applicable` | done | terminal — no retry |
| `skipped-no-session` | done | terminal — no retry (no session to retry against) |
| `quarantined` | done | terminal — flagged for the report, no retry |
| `error` | **transient** | **re-dispatch the same check** with **exponential backoff + jitter**, up to `--max-retries` (default **2**); if still `error` after the budget → leave it terminal `error` + `note` |
| `needs-human` | **blocked** | NOT the transient path → routed to §4b/§4c (challenge/breaker); never silently retried as if transient |

**Division of labor (lane vs orchestrator).** The **lane** still performs its own *single internal retry*
for a hard failure before it ever returns `error` (unchanged — `svt-google`/`svt-ai-engine` already do
"error = hard failure after one retry"). The **orchestrator** owns the *cross-check* bounded re-dispatch:
on `error` it waits a backoff (suggested **~5s → 15s → 45s ± jitter**) and re-issues the **same** check as
a fresh `Task`. The lane appends a new `results.ndjson` line each attempt; **last-line-per-key wins**
(run-layout §3), so a later `ok` supersedes the earlier `error` automatically — no edit-in-place, no
dropped check. After `--max-retries` exhausted attempts the record stays terminal `error` + `note` ("hard
failure after N retries").

> **No new status value.** Retry/backoff reuses the existing 6-value enum (result-shapes §2) end to end —
> `error` stays `error`; a recovered check becomes `ok`. The orchestrator only decides *when to re-dispatch*.

### 4b. Circuit-breaker + wall-clock cap

Retry handles a *one-off* failure; the **breaker** handles a lane that is *systematically* blocked (the
Google `/sorry/` wall that re-walls every check on a bad IP) so the batch never burns its whole budget
machine-gunning a wall.

**Per-lane circuit-breaker.** Maintain a **consecutive-block counter per platform**:

- **increment** on a `needs-human`, or on an `error` whose `--max-retries` budget is exhausted;
- **reset to 0** on any `ok` (the lane recovered);
- at **`--breaker-threshold`** (default **3**) consecutive blocks → **trip the breaker**: remove that
  platform from the round rotation (§4) for the rest of the run, and record each of its **remaining
  not-yet-attempted** checks as **`needs-human`** + `note "lane circuit-broken (N consecutive blocks)"`.

Why `needs-human` (not `quarantined`) for the remainder: those checks were **never attempted** — the lane
was paused before reaching them. `needs-human` is **non-terminal** (run-layout §3), so they are surfaced in
`quarantine.json` now **and auto-re-attempted on a later `--resume`** (e.g. once the IP/session is
healthier). The breaker is **per-lane**: tripping `google` never pauses `perplexity` — every other lane
keeps draining its queue.

**Global wall-clock cap.** `--max-wall-clock=<dur>` (default **none** = run to completion). When the
elapsed run time exceeds the cap, the orchestrator **stops dispatching new checks**, lets the **in-flight**
round finish (**never a hard kill mid-check** — that would orphan a half-collected page), records every
still-**pending** check as `needs-human` + `note "wall-clock cap reached"`, then prints the summary (§6).
Like the breaker remainder, these are non-terminal → a later `--resume` picks them up.

**Relation to §4c:** in **attended** mode the human may clear a challenge before the threshold trips
(resetting the counter), so the breaker is the backstop when challenges keep recurring; in **`--unattended`**
mode the breaker + cooldown are the *only* pacing, and an unclearable challenge resolves per §4c.

### 4c. Challenge routing — attended (default) vs `--unattended`

A `needs-human` (CAPTCHA / `/sorry/` wall / Cloudflare interstitial / login wall) is routed by **mode**:

**Attended (default).** The lane patiently waits for the human **in-line** (§4 above), so most
challenges clear **inside the check**. The orchestrator's headed-clearance re-queue is the **backstop**:
after a round, surface any check the lane still returned `needs-human`, open the headed window, let the
human clear the wall, then **re-dispatch** it (it returns to its lane's queue). A challenge the human
leaves unresolved stays **`needs-human`** (non-terminal) — surfaced in `quarantine.json` and resumable
next session.

**`--unattended` (never blocks).** No human is present, so the orchestrator **must not pause for HIL**. On
`needs-human` it instead:

1. applies a per-platform **cooldown** (`--cooldown`, default **60s**, **growing per consecutive block** —
   e.g. 60s → 120s → 240s — to back off a rate-limit), then
2. **re-dispatches** the check within the breaker budget (§4b);
3. if the challenge is **still unresolved** once that budget is spent → record the check **`quarantined`**
   + `note "unattended — challenge unresolved"`. This is the **tried-and-gave-up** outcome: **terminal**,
   flagged in the report, **never dropped**.

**The distinction that matters (never-reached vs tried-and-gave-up):**

| Outcome | Status | Terminal? | Meaning |
|---------|--------|-----------|---------|
| Lane paused by the breaker *before* this check was attempted | `needs-human` | no — resumable | **never-reached** — a `--resume` will try it |
| `--unattended` tried it; cooldown + retries exhausted, still blocked | `quarantined` | yes | **tried-and-gave-up** — flagged for human review |

Both are honest, and the enum stays intact across both modes:
`skipped-no-session` (no session — couldn't look) ≠ `ok + found:false/mentioned:false` (looked, not there)
≠ `needs-human` (blocked, not yet exhausted) ≠ `quarantined` (blocked, exhausted). **No new status value is
introduced** — every outcome is one of the existing six (result-shapes §2).

> **Known limitations (not handled here):** lane-side *mid-check pagination resume* (a circuit-broken
> Google check re-runs from `start=0` on resume — smarter intra-check resume would need lane state) and
> automated network/IP/VPN rotation (an ops concern). Reporting is a separate command — `/svt:report`.

### 5. `--dry-run` (validate + probe; ALWAYS run before a full batch)

Do steps **0a–2** (preflight + platform selection + CSV intake + scaffold), then — same shape as
`/svt:collect` §5, scaled to the whole CSV:

1. **Echo** the resolved normalized records **grouped by site** (so the CSV parse is eyeballable):
   per site, its `brand` + `locale` + each `keyword`/`query`; and list any **skipped-malformed** rows.
2. **Report each selected lane** LIVE vs `skipped-no-session`: `google` is effectively always LIVE (note
   if `profiles/google` is absent → it runs anonymously); each AI lane is LIVE if its `profiles/<platform>`
   session looks logged-in, else flagged `skipped-no-session` (grok flagged per its known non-persistence
   → its fallback chain `attach --cdp` / `state-load auth.json` / else skip).
3. **Print what each lane WOULD issue for keyword #1** (of the first site): for `google`, the exact
   verbatim search URL `https://www.google.com/search?q=<query>&gl=<locale>&hl=en&pws=0&start=0`; for each
   AI lane, the exact **verbatim `query`** it would type into the composer (no rewrite).
4. **Probe keyword #1 only** — dispatch the right subagent for the **first** record on **each LIVE
   selected lane** (one real check per lane, capturing evidence + the parsed record) so extraction can be
   sanity-checked. Skipped lanes are not probed.
5. **Print a scope estimate** — total checks = **sites × keywords × selected lanes**, the active-lane
   count, and a rough ETA (factor in the per-lane jitter band + across-platform parallelism: wall-clock ≈
   (checks per busiest lane) × (avg check time + lane jitter), since lanes run concurrently).
6. **Echo the active resilience config** (so a long unattended run is eyeballable before you start it):
   the **mode** (attended / `--unattended`), `--max-retries`, `--breaker-threshold`, `--max-wall-clock`
   (or "none"), and `--cooldown` — showing each effective value (and "(default)" where the flag was
   omitted). See **Resilience** below.

It does **NOT** run the full set. Example: a 2-site CSV (3 + 2 keywords) × {google,perplexity} → 10 total
checks, but the dry-run probes ~2 (one per LIVE lane), not 10.

### 6. Run + summary

Run the full set per §4 (unless `--dry-run`). After the lanes drain, materialize
`runs/<id>/quarantine.json` as a **view** over `results.ndjson` (records whose status is `quarantined`
or `needs-human`), then print a per-check table (one row per **site × keyword × platform**) + counts:

```
Site / Brand           Keyword                      Platform    Status  Signal                         Evidence
---------------------  ---------------------------  ----------  ------  -----------------------------  ----------------------------------------
example-hotel / Example Hotel     best hotel in downtown      google      ok      pos 3 · example-hotel.com         evidence/google__example-hotel__best-hotel-in-downtown.png
example-hotel / Example Hotel     best hotel in downtown      perplexity  ok      mentioned · cited:no · high    evidence/perplexity__example-hotel__best-hotel-in-downtown.png
example-resort / …   hotels in downtown           google      ok      pos 7 · example-resort.com   evidence/google__example-resort__hotels-in-downtown.png

ok: 8   quarantined: 0   needs-human: 1   skipped-no-session: 2   error: 0     → runs/svt-20260605-101500/
```

(Google rows show `pos N · domain`; AI rows show `mentioned · cited:yes/no · <confidence>`.) Re-running
the same run resumes it (§3) — the summary then reflects the full run, not just this invocation's checks.

## Resilience

`/svt:run` survives an unattended batch without dropping a check. All knobs have sensible defaults — a bare
`/svt:run inputs/x.csv` is **attended**, retry **2**, breaker **3**, no wall-clock cap, cooldown **60s**:

| Flag | Default | Effect | Section |
|------|---------|--------|---------|
| `--unattended` | off (attended) | never block for HIL; unclearable challenge → `quarantined` | §4c |
| `--max-retries=N` | 2 | orchestrator re-dispatches of a *transient* `error` (exp. backoff + jitter) | §4a |
| `--breaker-threshold=N` | 3 | consecutive blocks that pause a lane for the rest of the run | §4b |
| `--max-wall-clock=<dur>` | none | global time cap; on exceed, pending → `needs-human` | §4b |
| `--cooldown=<dur>` | 60s | per-platform pause after a block (grows per consecutive block) | §4c |

**Outcome map (never drop a check):** transient → bounded retry → `ok` or terminal `error`; recurring
challenge → breaker pauses the lane, its **not-yet-attempted** remainder `needs-human` (resumable) — or, in
`--unattended`, an **attempted** check → `quarantined` (tried-and-gave-up); time-boxed by the optional
wall-clock cap. The 6-value status enum (result-shapes §2) is reused unchanged — **no new status value**.

## Rules recap

- Batch CSV (`inputs/<file>.csv`, input-contract §2) · **across-platform concurrency, serial within a
  platform + jitter** (§4) · **resilience: retry/backoff + per-lane circuit-breaker + wall-clock cap +
  attended/`--unattended`** (§4a–§4c, **Resilience** recap) · no report (use `/svt:report`).
- **Route by platform:** `google`→`svt-google`, the five chats→`svt-ai-engine` — both reused **unchanged**.
  The check key is `(site_url, keyword, platform)` (run-layout §3).
- The **subagent writes** its record + evidence; **you** own the run folder, resume-diff, quarantine view,
  and the (attended) HIL re-queue.
- **Never silently drop a check, never a false "not found":** `ok + found:false`/`mentioned:false` (we
  looked, the brand isn't there) ≠ `skipped-no-session` (no session — we couldn't look) ≠ `needs-human`
  (a challenge blocked us) — keep them distinct (result-shapes §2).
- **Always `--dry-run` before a full batch.** Nothing under `runs/` is committed (gitignored).
