---
description: "Turn a finished run's per-check records into the client deliverables. Reads runs/<id>/results.ndjson (+ input.snapshot.json for the expected set), materializes results.json, aggregates a per-site scorecard that surfaces every coverage gap (never silently drops a check), and renders runs/<id>/report/scorecard.xlsx via document-skills:xlsx and runs/<id>/report/report.pdf via document-skills:pdf (reportlab). --format=xlsx|pdf|both (default both); --dry-run validates + prints the scope without rendering. gstack-free, no second LLM."
argument-hint: "[run-id]  [--format=xlsx|pdf|both]  [--dry-run]  [--out=<dir>]"
allowed-tools: Bash, Read, Write
---

# /svt:report — the client deliverable from a run (gstack-free)

You are the **report orchestrator**. You read a finished run's per-check records, **aggregate the per-site
scorecard in-context** (you are the brain — no second LLM), and hand the rendering to the adopted
**`document-skills`** skills (agent-driven code): **`:xlsx`** (openpyxl/pandas → the working `scorecard.xlsx`)
and **`:pdf`** (reportlab Platypus → the client-facing `report.pdf`). You own the aggregation, the
**status accounting** (so no check is silently dropped), and the materialized `results.json`; the skills
draw the deliverables. `--format` selects which to produce (default both).

`/svt:report` is the reporting analogue of the collection commands: same run folder, same contracts — it
**reads** what `/svt:run` / `/svt:collect` produced and turns it into a deliverable.

> **Deliverables:** the **XLSX scorecard** (`scorecard.xlsx`, the working artifact) and the **PDF client
> report** (`report.pdf`, the client-facing document). Both render from the **same** in-context scorecard
> model + status accounting — one aggregation, two views. `--format` selects which. A PPTX deck is deferred.

> **Contracts (read, don't duplicate):** `report-contract.md` (**the report's data model + the §5 4-sheet
> workbook layout + the §6 PDF layout + the status accounting** — this command implements it), `run-layout.md`
> (**§2** results.json materialized at report time · `runs/<id>/report/` · **§3** last-line-per-key +
> terminal-vs-non-terminal), `result-shapes.md` (**§3** organic_positional / **§4** ai_presence / **§2** the
> 6-value status enum / **§5** evidence), `input-contract.md` (**§1** the normalized record → the *expected*
> check set + brand/locale labels). **Rendering details live in the `document-skills:xlsx` / `:pdf` skills** —
> drive them; don't re-spec them.

## Behavior

**Args:**
- `/svt:report <run-id>` — report the named run (`runs/<run-id>/`).
- `/svt:report` — no run-id → **auto-select the most recent** `runs/*` that has a `results.ndjson` (echo which one).
- `/svt:report --format=xlsx|pdf|both [run-id]` — choose deliverables: `xlsx` (scorecard only) · `pdf` (client
  report only) · `both` (**default**). Drives which of §5 / §6 runs (and which toolchain §0a preflights).
- `/svt:report --dry-run [run-id]` — validate + aggregate + print the scope/coverage summary; **render nothing**
  (honors `--format`: prints what each selected deliverable *would* contain).
- `/svt:report --out=<dir> [run-id]` — override the report output dir (default `runs/<id>/report/`).

### 0a. Preflight — report toolchain (degrade, don't block)

Unlike the collection commands' §0a (which hard-stops), the report **degrades gracefully** — a missing
render dependency must never lose the data layer. Preflight **only the toolchain `--format` selects**:

- **`python3`** present (required for any render).

**XLSX toolchain** (when `--format` ∈ {xlsx, both}):
- **`openpyxl`** importable — if missing, best-effort `python3 -m pip install --user --quiet openpyxl`
  (fall back to a throwaway venv if the environment is externally-managed). `pandas` is optional (convenience).
- **LibreOffice (`soffice`)** present → **xlsx full mode** (live Excel formulas + `scripts/recalc.py` verifies
  zero formula errors). Absent → **xlsx fallback mode** (computed-value static workbook + a one-line WARN).
  Either way a valid `scorecard.xlsx` is produced. If even `openpyxl` can't be obtained, still do §1–§3 +
  the console summary and emit a CSV alongside, with a clear WARN that the xlsx was skipped.

**PDF toolchain** (when `--format` ∈ {pdf, both}):
- **`reportlab`** importable — if missing, best-effort `python3 -m pip install --user --quiet reportlab`
  (throwaway-venv fallback if externally-managed). **`Pillow`** (`PIL`) importable for evidence thumbnails —
  best-effort install if missing.
- reportlab obtainable → **PDF full mode** (reportlab Platypus → `report.pdf`). Not obtainable → **PDF
  fallback mode**: emit a self-contained `runs/<id>/report/report.html` + a one-line WARN that the PDF was
  skipped (the xlsx CSV-fallback analogue). Either way a complete, honest deliverable lands.

Echo the resolved **render mode per selected format** (xlsx full/fallback · pdf full/fallback) up front.

> Wiring these deps (openpyxl/pandas + LibreOffice + reportlab/Pillow) into `/svt:setup` is a deferred
> follow-up; for now `/svt:report` self-checks + self-heals + degrades.

### 1. Resolve the run

- `run-id` arg → bind to `runs/<run-id>/`; it must exist and contain `results.ndjson` (else stop in one line).
- Omitted → scan `runs/*/results.ndjson`, pick the **most recent** (by mtime), and **echo** which run was chosen.
- Read `runs/<id>/input.snapshot.json` for the **expected** set (`records × snapshot.platforms`) + the
  `brand`/`locale`/`site_url` labels. (If the snapshot is absent — an older run — derive the expected set from
  the records present and note that coverage is best-effort.)

### 2. Materialize `results.json` (run-layout §2)

Read `results.ndjson` and apply the run-layout **§3 last-line-per-`(site_url, keyword, platform)`** rule
(a later line supersedes an earlier one). Write the resolved array to **`runs/<id>/results.json`**. The NDJSON
stays the crash-safe source of truth; `results.json` is the read convenience the report (and a human) consume.

### 3. Aggregate the scorecard (report-contract §2/§3) + console summary

Entirely in-context (no second LLM), compute per **site** (registrable domain):
- **§2a AI presence:** `%mentioned`, `%cited`, modal `match_confidence`, top competitors — denominator =
  **ran** (status `ok`) AI checks only.
- **§2b Google organic:** `found-rate`, `avg position` (over found), AI-Overview presence + cited.
- **§2c per-keyword detail:** one row per `(keyword, platform)` → status + headline signal + evidence path.
- **§3 status accounting:** count every status (`ok·quarantined·needs-human·skipped-no-session·error·
  not_applicable`) **plus `not-collected`** (in the snapshot's expected set but with **no record**). Compute
  **coverage = ran ÷ expected** per site.
- **Quarantine view:** collect every `quarantined` / `needs-human` / `skipped-no-session` / `error` /
  `not-collected` record (+ its `note` + evidence path) — the "nothing dropped" ledger.

Then **print a console summary** so the aggregation is eyeballable before rendering: per site, coverage +
the status counts + the headline AI/Google metrics, and a one-line callout of the quarantine/coverage gaps.

> **Honesty rule (report-contract §3):** a coverage gap (`needs-human`/`skipped-no-session`/`error`/
> `not-collected`) is **never** rendered as a competitive negative. Only `ok + found:false/mentioned:false`
> is a real "absent". Keep the buckets distinct end-to-end.

### 4. `--dry-run`

Do §0a–§3 + the console summary, then **STOP**: for each **selected** `--format`, report what it *would*
contain and its **render mode** — `scorecard.xlsx` (the sheets + per-site rows; full/fallback) and/or
`report.pdf` (the §6 sections + per-site pages + the evidence-thumbnail count; full/fallback). Render nothing;
write `results.json` (harmless, it's a read convenience) but no workbook or PDF.

### 5. Render — `scorecard.xlsx` via `document-skills:xlsx`  *(when `--format` ∈ {xlsx, both})*

Render `runs/<id>/report/scorecard.xlsx` per **report-contract §5** with the **`document-skills:xlsx`**
workflow (openpyxl). Build the four sheets:

- **Summary** — one row per site: `brand` · **`coverage (ran/expected)`** · AI `%mentioned` · AI `%cited` ·
  Google `found-rate` · Google `avg-pos` · AI-Overview presence · the §3 status counts. Bold + filled header;
  `0.0%` for rates, integer position, zeros as `-`.
- **`<site>` detail** (slug-named per site) — per-keyword × platform rows: status + headline signal + the
  evidence path (hyperlinked). Tint the status cell (ok vs coverage-gap) for scan-ability.
- **Quarantine** — every `quarantined` / `needs-human` / `skipped-no-session` / `error` / `not-collected`
  record + its `note` + evidence path. (No gaps → a single "full coverage — nothing dropped" row.)
- **Raw** — the flat per-check table (envelope fields + headline result), one row per resolved record.

**Render mode (from §0a):**
- **full** (LibreOffice present): write the % / averages as **live Excel formulas** (e.g.
  `=COUNTIF(detail!…)/…`), professional font; then run the skill's **`scripts/recalc.py <file>`**, parse its
  JSON, and **fix any formula error** (`#REF!`/`#DIV/0!`/…) — loop until `total_errors:0`.
- **fallback** (LibreOffice absent): write the **computed values** you already aggregated in §3 — a valid
  static workbook — and print `WARN: LibreOffice absent → static scorecard.xlsx (computed values, no live formulas)`.

Create `runs/<id>/report/`, save the workbook, and print the final path + render mode + an "open it" pointer.
Re-running overwrites the workbook (the run's records are the source of truth). **Never** let a render-mode
downgrade fail the report — a static, complete, honest scorecard is the floor.

### 6. Render — `report.pdf` via `document-skills:pdf`  *(when `--format` ∈ {pdf, both})*

Render `runs/<id>/report/report.pdf` per **report-contract §6** with the **`document-skills:pdf`** workflow
(**reportlab Platypus** — `SimpleDocTemplate` + `Paragraph` + `Table`/`TableStyle` + `Image()` flowable +
`PageBreak`). This is the **client-facing** document and renders from the **same §3 in-context scorecard
model** — no re-aggregation. Build the sections (report-contract §6a) in order:

- **Cover** — report title · brand / site name(s) · run id · report date · the one-line **coverage headline**
  (`ran ÷ expected` across the run).
- **Executive summary** (portfolio rollup) — overall coverage % · AI `%mentioned` / `%cited` (over ran AI
  checks) · Google found-rate + avg position · AI-Overview presence · top competitors · the coverage-gap
  callout. Plain-language, client-readable.
- **Per-site visibility page** (one per site, `PageBreak` between) — the §2a AI + §2b Google metrics as a
  compact scorecard `Table`; the §2c per-keyword × platform detail table (status + headline signal); and
  **embedded evidence** for `ok` checks (`result.evidence.screenshot_path`, result-shapes §5) as downscaled
  `Image()` thumbnails, **capped per site** (report-contract §6b — e.g. 6; list the remainder by path, and
  note in the report when it elides). Don't balloon the PDF at scale.
- **Coverage / quarantine appendix** — every `quarantined` / `needs-human` / `skipped-no-session` / `error` /
  `not-collected` record + its `note` + evidence path (the "nothing-dropped" ledger). No gaps → a single
  "full coverage — nothing dropped" line.

**Honesty (report-contract §6c):** a coverage gap is **never** a competitive negative anywhere in the PDF;
only `ok + found:false / mentioned:false` is a real "absent"; Google with zero ran checks shows `-`, never
`0% found`.

**Render mode (from §0a):**
- **PDF full** (reportlab present): build + save the Platypus document. Professional fonts; `0.0%` rates;
  integer positions; zeros as `-`. (Per the skill: never use Unicode sub/superscripts in reportlab.)
- **PDF fallback** (reportlab unobtainable): write a **self-contained `runs/<id>/report/report.html`** carrying
  the same sections (evidence `<img>` by relative path) + print
  `WARN: reportlab absent → report.html emitted (PDF skipped)`.

Create `runs/<id>/report/`, save, and print the final path + render mode + an "open it" pointer. Re-running
overwrites it (the run's records are the source of truth). **Never** let a downgrade fail the report — a
complete, honest client document is the floor.

## Rules recap

- **Reads** a finished run (`runs/<id>/results.ndjson` + `input.snapshot.json`); **writes** `results.json` +
  (per `--format`) `runs/<id>/report/scorecard.xlsx` and/or `runs/<id>/report/report.pdf`. Collection-side
  files are untouched — the report is read-only over results.
- **One aggregation, two views:** you aggregate the scorecard **once** in-context (no second LLM); the
  **`document-skills:xlsx` / `:pdf` skills render** (agent-driven code: openpyxl / reportlab). gstack-free.
- **Never silently drop a check:** every status + `not-collected` is surfaced; a coverage gap is never a
  competitive negative (report-contract §3/§6c). `results.json` is the run-layout §2 last-line-per-key resolution.
- **Always `--dry-run` first** to eyeball coverage before rendering. Nothing under `runs/` is committed (gitignored).
- **Degrade, don't block:** a missing render dep degrades (xlsx → static/CSV+WARN · pdf → report.html+WARN),
  never failing the report — a complete, honest deliverable is the floor.
