# Report Contract — the client deliverable from a run

> **This is a contract the agent fills in-context — not report code.** `/svt:report` reads a finished
> run's records and *you* (the Claude Code agent) aggregate + render in-context. The render uses the
> adopted **`document-skills:xlsx`** / **`document-skills:pdf`** skills — agent-driven code
> (openpyxl/pandas etc.), **no second LLM, no gstack**. This file defines **what the report contains**, not
> how a skill draws it. (Architecture parallel: `document-skills` is to reporting what `playwright-cli` is
> to collection — the command orchestrates, the skill renders.)

A run produces per-check records (result-shapes §3/§4); the report turns them into a **per-site scorecard**
a marketer can hand a client — and it preserves the project's first law: **never silently drop a check**.

---

## 1. Inputs

- **`runs/<id>/results.ndjson`** — the per-check records (result-shapes). **Last line per
  `(site_url, keyword, platform)` wins** (run-layout §3): the report reads the same resolved view the
  resume protocol does (a later `ok` supersedes an earlier `error`/`needs-human`).
- **`runs/<id>/input.snapshot.json`** — the resolved normalized records (input-contract §1): the
  **expected** check set (`site × keyword × platform`, where `platform ∈ snapshot.platforms`) plus the
  `brand` / `locale` / `site_url` labels. The snapshot is what makes a **missing** record visible
  (`expected − collected` = not-yet-collected), so a never-run check cannot hide.
- (materialized) **`runs/<id>/results.json`** — the NDJSON folded into a single JSON array, written at
  report time (run-layout §2).

---

## 2. Per-site scorecard model

The unit is the **site** (registrable domain, from `site_url`). For each site, across its keywords:

### 2a. AI-engine presence — the 5 `ai_presence` platforms (chatgpt · gemini · claude · grok · perplexity)
| Metric | Source field (result-shapes §4) | Definition |
|--------|--------------------------------|-----------|
| `% mentioned` | `result.mentioned` | mentioned-true ÷ **ran** AI checks (status `ok`) |
| `% cited` | `result.cited` | cited-true ÷ ran AI checks |
| modal `match_confidence` | `result.match_confidence` | the dominant confidence among ran checks |
| top competitors | `result.competitors_mentioned` | most-frequently-named other brands (competitive intel) |

- **Denominator = ran checks only** (`status=ok`). `skipped-no-session` / `needs-human` / `error` /
  `quarantined` are **coverage gaps**, excluded from the denominator and reported separately (§3) — a gap is
  **never** counted as a "not mentioned".

### 2b. Google organic (`organic_positional`)
| Metric | Source field (result-shapes §3) | Definition |
|--------|--------------------------------|-----------|
| `found-rate` | `result.found` | found-true ÷ ran Google checks |
| `avg position` | `result.position` | mean position over **found** checks (1–50; blank if none found) |
| `AI-Overview presence` | `result.in_ai_overview` | share of ran checks with the brand in Google's AI Overview |
| `AI-Overview cited` | `result.cited` | share cited inside the AI Overview |

### 2c. Per-keyword detail
One row per `(keyword, platform)`: the **status** + the **headline signal** — Google → `pos N · ranking_url`
/ `not found` / *coverage gap*; AI → `mentioned · cited · <confidence>` / *coverage gap* — plus the
evidence path. Rows for **expected-but-missing** checks appear as `not-collected`.

---

## 3. Status accounting (the honesty guarantee)

For each site, count **every** check by status (result-shapes §2), plus the **expected-but-missing**:

| Bucket | In the report |
|--------|---------------|
| `ok` | a real result — **including a legitimate `found:false` / `mentioned:false`** (a reportable negative) |
| `quarantined` | ran but untrustworthy (low confidence / unattended challenge) — surfaced for human review |
| `needs-human` | a challenge blocked it — **coverage gap, not a negative**; resumable |
| `skipped-no-session` | no session — **couldn't look**; coverage gap, not "absent" |
| `error` | hard failure after retries — coverage gap |
| `not_applicable` | intentionally not run for this platform |
| **`not-collected`** | present in `input.snapshot.json` but **no record** in results — never run; surfaced so the gap is explicit |

> **The inequality the report MUST preserve:** `ok+found:false/mentioned:false` (looked, absent) ≠
> `skipped-no-session` (couldn't look) ≠ `needs-human` / `quarantined` / `error` / `not-collected` (didn't
> complete). A coverage gap is **never** rendered as a competitive negative.
> **Coverage** is shown per site as `ran ÷ expected` so the reader knows how complete the picture is.

---

## 4. Artifacts + materialization

- **Report output dir: `runs/<id>/report/`** (created at report time; gitignored with the rest of `runs/`).
- **`results.json`** materialized from `results.ndjson` at report time (run-layout §2) → `runs/<id>/results.json`.
- Deliverables: **`runs/<id>/report/scorecard.xlsx`** · **`runs/<id>/report/report.pdf`**.
- Evidence (`result.evidence.screenshot_path`, result-shapes §5) is carried through and **linked** from the
  detail / Quarantine rows — the audit trail survives into the deliverable.

---

## 5. XLSX workbook layout (`scorecard.xlsx`)

| Sheet | Contents |
|-------|----------|
| **Summary** | one row per site: brand · **coverage (ran/expected)** · AI `%mentioned` · AI `%cited` · Google `found-rate` · Google `avg-pos` · AI-Overview presence · the §3 status counts |
| **`<site>` detail** | per-keyword × platform rows (§2c) — status + headline signal + evidence path. One sheet per site (slug-named); if many sites, a leading `site` column instead |
| **Quarantine** | every `quarantined` / `needs-human` / `skipped-no-session` / `error` / `not-collected` record with its `note` + evidence path — the **"nothing dropped" ledger** |
| **Raw** | the flat per-check table (one row per resolved record: the envelope fields + the headline result) |

**Rendering conventions (per `document-skills:xlsx`, not restated here):** professional font; `0.0%` for
rates; position as an integer; zeros shown as `-`. **Prefer live Excel formulas** for the % / averages (so
the client can adjust source rows) with `scripts/recalc.py` verifying **zero formula errors**. When the
recalc toolchain (LibreOffice) is **absent**, the report emits **computed values** (a valid static
workbook) + a one-line WARN — graceful degradation, **never a failed report**.

---

## 6. PDF report layout (`report.pdf`)

The PDF is the **client-facing deliverable** a marketer hands a client (the XLSX is the working artifact).
It is a **second view over the unchanged §1–§4 model** — the **same** per-site scorecard (§2), the **same**
status accounting (§3), the **same** materialized inputs (§1) and artifacts (§4). It adds **no new metric and
no new status**; it presents the existing model as a narrative document. Rendered via the adopted
**`document-skills:pdf`** skill (reportlab Platypus) — agent-driven code, **no second LLM, no gstack**.

### 6a. Sections (in order)

| Section | Contents (all sourced from §1–§4) |
|---------|-----------------------------------|
| **Cover** | report title · brand / site name(s) · run id · report date · a one-line **coverage headline** (`ran ÷ expected` across the run). |
| **Executive summary** (portfolio rollup across all sites) | overall **coverage %** · AI **presence rate** (`%mentioned` over **ran** AI checks) · AI **citation rate** · Google **found-rate** + **avg position** · **AI-Overview presence** · **top competitors** (from `result.competitors_mentioned`) · an explicit **coverage-gap callout** (count of `needs-human` / `skipped-no-session` / `error` / `not-collected`). Plain-language, client-readable. |
| **Per-site visibility page** (one per site; page break between) | the §2a AI-presence + §2b Google metrics as a compact scorecard table · the §2c per-keyword × platform **detail table** (status + headline signal) · **embedded evidence** (§6b). |
| **Coverage / quarantine appendix** | the §3 "nothing-dropped" ledger carried into the PDF: every `quarantined` / `needs-human` / `skipped-no-session` / `error` / `not-collected` record with its `note` + evidence path. No gaps → a single "full coverage — nothing dropped" line. |

### 6b. Embedded evidence (the audit trail survives into the deliverable)

- Evidence screenshots (`result.evidence.screenshot_path`, result-shapes §5) for **`ok`** checks are embedded
  on the owning site's page as **downscaled thumbnails**.
- **Per-site cap:** embed at most **N** thumbnails per site (a sane default, e.g. 6); list the remainder by
  path. **Rationale:** at the 75-site × ~10-kw × 6-engine scale (~4,500 checks) embedding every screenshot
  would balloon the PDF — the cap keeps it client-deliverable. State the cap in the report when it elides.

### 6c. Honesty (the §3 inequality, restated for the PDF)

A **coverage gap** (`needs-human` / `skipped-no-session` / `error` / `not-collected`) is **NEVER** rendered as
a competitive negative anywhere in the PDF. Only **`ok + found:false / mentioned:false`** is a real "absent".
Google with zero **ran** checks shows **`-`**, never a fabricated `0% found`. Coverage (`ran ÷ expected`) is
shown on the cover + exec summary so the reader knows how complete the picture is.

### 6d. Rendering conventions + degradation (don't re-spec the skill)

Per `document-skills:pdf` (reportlab Platypus): professional fonts; `0.0%` rates; integer positions; zeros as
`-`; `Table`/`TableStyle` scorecards; `Image()` flowable for thumbnails; `PageBreak` per site. **Primary =
reportlab**; **fallback = a self-contained `runs/<id>/report/report.html` + a one-line WARN** (PDF skipped)
when reportlab is unavailable — the §5 xlsx-fallback analogue: **graceful degradation, never a failed
report.** (The PDF artifact path is the `runs/<id>/report/report.pdf` already listed in §4.)

---

## 7. AI Visibility Tracker matrix (standalone XLSX)

A flat, **client-facing matrix** — the at-a-glance grid a marketer hands a client: site × keyword ×
engine, one Yes/No per AI engine plus the Google rank. It is a **SECOND VIEW over the unchanged §1–§3
model** (the same materialized `results.json`, the same last-line-per-`(site_url, keyword, platform)`
resolution, the same status accounting) — it adds **no new metric and no new status**. It is the **default
deliverable** of `/svt:report`; the §5 `scorecard.xlsx` + §6 `report.pdf` are **opt-in** via `--format`
(suppress the matrix with `--no-matrix`).

- **Artifact:** `runs/<id>/report/ai-visibility-matrix.xlsx` (one sheet, titled **"AI Visibility
  Tracker"**). Degrades to `runs/<id>/report/ai-visibility-matrix.csv` + a one-line WARN if openpyxl is
  unobtainable — the §5 CSV-fallback analogue: **graceful degradation, never a failed report**.

### 7a. Columns (exact order) + field mapping

| # | Column | Source (existing field) |
|---|--------|-------------------------|
| 1 | **Date** | the run date — parsed from `run_id` (`svt-YYYYMMDD-…`), formatted `YYYY-MM-DD` |
| 2 | **Site** | the site label — `input.snapshot.json` `brand` (fallback `site_url`) |
| 3 | **KWs** | `keyword` (verbatim) |
| 4 | **Google SERP Position** | `organic_positional.result.position` (integer 1–50; see 7c for absent/gap) |
| 5 | **Chatgpt** | `ai_presence.result.mentioned` for platform `chatgpt` |
| 6 | **Gemini** | `ai_presence.result.mentioned` for platform `gemini` |
| 7 | **Perplexity** | `ai_presence.result.mentioned` for platform `perplexity` |
| 8 | **Claudeai** | `ai_presence.result.mentioned` for platform **`claude`** |
| 9 | **Grok** | `ai_presence.result.mentioned` for platform `grok` |

> The column label **"Claudeai" = the `claude` platform**; **"Grok" = the `grok` platform** (the display
> names differ from the recipe ids). The engine column order is fixed exactly as above.

### 7b. Layout

- **One row per keyword**, grouped per **site** (registrable domain / label).
- **Date + Site** are shown **once per site block** — rendered on the block's first keyword row and
  vertically merged across the block's rows (so a multi-keyword site reads as one labelled group).
- A header row carries the nine column titles (bold + filled); the header row is frozen.

### 7c. Honesty cell-mapping (the §3 inequality applied to a Yes/No grid)

The §3 guarantee holds **in every cell** — a coverage gap is **never** a competitive negative:

| Cell | Renders |
|------|---------|
| engine — `ok` + `mentioned:true` | **`Yes`** |
| engine — `ok` + `mentioned:false` | **`No`** (a real, reportable "absent") |
| engine — `skipped-no-session` / `needs-human` / `error` / `quarantined` / `not-collected` | **`—`** (coverage gap — *couldn't look*, **never** `No`) |
| Google — `ok` + `found:true` | the **integer position** (1–50) |
| Google — `ok` + `found:false` | **`—`** (scanned, not in top 50) |
| Google — coverage gap (any non-`ok` / `not-collected`) | **`—`** |

> The same inequality as §3 / §6c: **`ok + mentioned:false / found:false`** (looked, absent) ≠ a
> **coverage gap** (couldn't look). Only the former is a `No` / a missing rank; the latter is always
> `—`. No cell is ever a fabricated `No` or `0`. (result-shapes §3 = organic / §4 = ai_presence.)

### 7d. Visual style (the client template)

The matrix is the client-facing grid, styled to match the shared template:

| Element | Style |
|---------|-------|
| **Title row** | `AI Visibility Tracker` **merged across all nine columns**, lavender fill, bold, centered |
| **Header row** | the nine titles on a rose/pink fill, bold, centered; thin cell borders throughout; **frozen** so it stays visible on scroll |
| **Date + Site** | merged once per site block, vertically centered |
| **KWs** | left-aligned, **wrapped text** (long keywords wrap, as in the template) |
| **Engine cells** (`Yes`/`No`/`—`) | **plain text** with a **direct cell fill** per value (no dropdown — the value is always visible) — **`Yes` → green** fill + white bold · **`No` → red** fill + white bold · **`—` → neutral grey** + grey text |
| **Google SERP Position** | the integer rank or `—`, centered, uncolored |

The value is written as **plain text** with the fill baked into the cell, so the green/red `Yes`/`No` cells
render identically in **Excel**, **Google Sheets**, and Numbers — no dropdown, nothing hidden. When the matrix
degrades to CSV (openpyxl absent), the cells carry the same `Yes`/`No`/`—` **text** without the fills — still
complete and honest.

---
*report-contract.md — the deliverable's data + layout. Intake → input-contract; per-check record →
result-shapes; run folder + resume → run-layout; per-platform collection → recipe-table.*
