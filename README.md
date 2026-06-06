# site-visibility-tracker

> A pure **Claude Code workflow** that tracks organic (Google) and AI-search (ChatGPT, Gemini, Claude, Grok, Perplexity) visibility for any list of sites × keywords — turning hours of manual checking into one evidence-backed run and a client-ready report.

**What it is:** slash commands plus the Claude Code agent itself as the brain. No bundled software, no second LLM, no backend. The agent drives a logged-in browser through Microsoft's `@playwright/cli` (and its Claude Code skill), reads each result, judges visibility in-context, captures screenshot evidence, and emits an XLSX scorecard + a PDF report.

**Status:** v0.1 MVP — collection, resilience, and reporting are shipped and installable; final live validation + scale-up is in progress.

---

## Why

A digital-marketing team manually tracks organic + AI visibility for ~10 priority keywords across dozens of client sites — roughly **75 hours per cycle**. This workflow automates the collection, keeps every check honest and evidence-backed, and produces the deliverables. Point it at a list of sites + keywords; it drives real logged-in browser sessions across all six platforms, captures structured results + screenshots, asks a human only when a CAPTCHA truly needs one, and writes the spreadsheet + PDF.

Nothing about any client is hardcoded. **The input file is the only client-specific artifact.**

---

## Install

One command scaffolds the workflow into your project's `.claude/` (see **[INSTALL.md](INSTALL.md)** for the full quickstart):

```bash
npx github:Sajith-K-Sasi/site-visibility-tracker
```

This copies the `/svt:*` commands, the two collector agents, and the data contracts into `./.claude/`. It never overwrites existing files unless you pass `--force`, and it touches nothing else.

Then, inside Claude Code:

```
/svt:setup            # install the toolchain (@playwright/cli + its skill + Chromium)
/svt:login            # log into each platform in your own browser sessions (never shared)
```

`/svt:setup` also needs Python 3 for reporting (openpyxl + reportlab; LibreOffice optional, for the richer XLSX mode).

---

## Commands

| Command | What it does |
|---|---|
| `/svt:setup` | One-time: install `@playwright/cli` + its skill + Chromium; scaffold `runs/` and `inputs/`. Idempotent. |
| `/svt:login [platform] \| --status` | Open a headed real-Chrome session and log into each AI platform once; the login persists in a per-platform profile. `--status` reports what's logged in. Google organic needs no login. |
| `/svt:collect <pasted block>` | Single, ad-hoc: a URL line then keyword lines → collect that site across the selected platforms. |
| `/svt:run inputs/<file>.csv` | Batch: walk a reusable CSV of sites × keywords; concurrent, resumable. |
| `/svt:report [run-id]` | Turn a finished run into the deliverables: `scorecard.xlsx` + `report.pdf`. `--format=xlsx\|pdf\|both`. |
| `--dry-run` (flag) | On `collect`/`run`: validate input + sessions, probe one keyword per live lane, print the scope estimate. No full collection. Always run it first. |

---

## How it works

- **Commands orchestrate; subagents collect.** Each `/svt:*` command is an orchestrator. The browsing + judging happens in **collector subagents** that run in isolated context:
  - `svt-google` — region-pinned Google search, top-50 positional scan by registrable domain, best-effort AI-Overview detection.
  - `svt-ai-engine` — one recipe-parameterized body for all five AI chats: open the logged-in session, type the keyword verbatim, wait for the answer to finish streaming, judge presence/citation.
- **The agent is the only brain.** It reads the page snapshot and judges visibility by meaning — no second LLM, no brittle CSS selectors.
- **Browsing is the `@playwright/cli` skill.** Stateful named sessions, one persistent real-Chrome profile per platform, so logins survive between runs. The skill is installed locally by `/svt:setup` (not bundled).
- **Human-in-the-loop stays at the edge.** When a challenge appears (Google `/sorry/`, a Cloudflare interstitial, a login wall) and a human is present, the lane keeps the headed window open and **patiently waits** for you to clear it, then continues — no give-up-and-retry round-trip. Unattended runs never wait for a human; they cool down, back off, and flag instead.

### Input (two modes, one model)

- **CSV (`/svt:run`):** required `site_url,keyword`; optional `brand,locale,prompt_override`. Grouped by site; swap the file to run a different client.
- **Pasted block (`/svt:collect`):** a single URL + keyword lines, parsed into the same records.
- `brand` drives AI-answer matching when an engine names the site without linking it (falls back to a domain-derived name).
- `locale` pins the Google region — defaults to `in`; per-row override supported.
- The **raw keyword is queried verbatim** on every platform (no keyword→question rewrite) unless `prompt_override` is set.

### Two result shapes

- **Google (organic, positional):** `found` · `position` (registrable-domain rank 1–50, null beyond) · `ranking_url` · `in_ai_overview` + `cited` · evidence.
- **AI engines (presence, not positional):** `mentioned` · `cited` · `position_in_answer` · `competitors_mentioned` · `sources_cited` · `match_confidence` · `raw_answer` · evidence.

### Honesty guarantees

Every check resolves to one of six explicit statuses — and the distinctions are never blurred:

`ok` (we looked) · `not_applicable` · `skipped-no-session` (no login — we couldn't look) · `quarantined` (ran, but needs review) · `needs-human` (a challenge blocked us) · `error`.

A coverage gap is **never** rendered as a competitive negative. "We looked and the brand isn't there" (`ok` + `found:false`/`mentioned:false`) is kept distinct from "we couldn't look" (`skipped-no-session`) and "a wall blocked us" (`needs-human`). A check is **never silently dropped**, and a screenshot is captured for every `ok`/`quarantined` result.

### Resilience (batch runs)

`/svt:run` runs the platform lanes **in parallel, serial within each platform** (one persistent profile per platform is the binding constraint), with per-lane jitter. It adds bounded retry/backoff, a per-lane circuit-breaker, an optional global wall-clock cap, and an `--unattended` mode that never blocks for a human. Bot-detection is the constraint, not hardware — so the knobs are about staying human-looking, not throughput.

---

## Reporting

`/svt:report` aggregates a run in-context and renders two views of one model, gstack-free, via Anthropic's first-party **document-skills**:

- **`scorecard.xlsx`** — per-site visibility scorecard (% mentioned/cited across the AI engines, average Google position, AI-Overview presence) via `document-skills:xlsx` (openpyxl).
- **`report.pdf`** — client-ready report (cover, exec summary, per-site visibility pages with embedded evidence, a coverage/quarantine appendix) via `document-skills:pdf` (reportlab).

`--format` selects which to render. The honesty rules carry into both: a coverage gap is surfaced as a gap, never a fake `0%`; Google with zero ran checks shows `—`, not a fabricated negative.

---

## Run artifacts

Everything a run produces lives under `runs/<run-id>/` (gitignored):

| Artifact | Purpose |
|---|---|
| `results.ndjson` | Append-only log of every check (both shapes) — crash-safe, resumable |
| `evidence/*.png` | One screenshot per `ok`/`quarantined` check — the audit trail |
| `quarantine.json` | View over the records needing review (`quarantined` / `needs-human`) |
| `report/scorecard.xlsx`, `report/report.pdf` | The client deliverables (`/svt:report`) |

Resume a batch with `/svt:run --resume=<run_id>` — it skips completed checks and re-attempts the ones a challenge blocked.

---

## Distribution

The whole workflow installs into a teammate's project with the `npx` line above — it copies the `.claude/` command/agent/contract files (a thin file-copier; the product stays pure Claude Code). Each person runs `/svt:setup` for their own toolchain and `/svt:login` for their own browser sessions. **Sessions are never shared or committed.** See **[INSTALL.md](INSTALL.md)**.

---

## Constraints

- Browsing is via `@playwright/cli` + its Claude Code skill **only** — no MCP server, no bundled collector software.
- The Claude Code agent is the **only LLM** — parsing and judging happen in-context.
- Read-only against the six platforms, through the user's own logged-in sessions.
- Bot-detection / rate-limiting is the binding constraint (throttle, jitter, circuit-breaker), not hardware.
- Google scan depth: top 50.

## Out of scope

Database / hosted dashboard / built-in scheduler · trend-diffing (this is a one-off snapshot) · SEO advice / content generation / keyword research · a bundled Node software package · a second LLM. Reporting uses Anthropic first-party `document-skills` (agent-driven openpyxl/reportlab — not a second LLM, not gstack).

---

## Validation set

Before scaling, validate on a small set — e.g. **2 sites × ~10–20 keywords each** — so you can eyeball
coverage, evidence, and the quarantine behavior end to end. Provide your own sites/keywords via a CSV
(`/svt:run`) or a pasted block (`/svt:collect`); nothing about any specific site is baked in.

**Platforms:** Google Search · ChatGPT · Gemini · Claude · Grok · Perplexity.

---

## Repository layout

```
.claude/commands/svt/   the /svt:* slash commands (the product surface)
.claude/agents/         svt-google + svt-ai-engine collector subagents
.claude/svt/contracts/  input · run-layout · result-shapes · recipe-table · report-contract
bin/install.mjs         the npx project-folder installer
INSTALL.md              teammate install quickstart
inputs/                 your CSVs
runs/                   per-run artifacts (gitignored)
profiles/               per-platform browser sessions (gitignored, never shared)
```
