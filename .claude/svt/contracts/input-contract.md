# Input Contract — `/svt:collect` · `/svt:run`

> **This is a contract the agent fills in-context — not parser code.** When a command
> receives input, *you* (the Claude Code agent) read it, apply the rules below, and produce
> the **normalized records**. There is no Node parser, no schema library. If a rule here is
> ambiguous for a given input, prefer the explicit example over guessing.

The product accepts site × keyword work two ways — a reusable **CSV file** (`/svt:run`) and a
**pasted block** (`/svt:collect`) — and both collapse to **one internal record shape**, so
everything downstream (the run-folder snapshot, the collector subagents, the report) sees a
single model regardless of how the work was entered.

---

## 1. The normalized record (the one internal model)

Every input row/line resolves to exactly this object:

```json
{
  "site_url":        "https://example-hotel.com/",
  "keyword":         "best hotel in downtown",
  "brand":           "Example Hotel",
  "locale":          "in",
  "prompt_override": null,
  "query":           "best hotel in downtown"
}
```

| Field | Source | Rule |
|-------|--------|------|
| `site_url` | required | The site whose visibility is measured. Kept **verbatim**, including deep paths (e.g. `/example-resort-downtown/`). Matching is done on the **registrable domain** (see §4), but `site_url` records exactly what was entered. |
| `keyword` | required | The raw search phrase. Stored **verbatim** — never rewritten, never turned into a question. |
| `brand` | optional | Used to match an AI answer that *names* the hotel without linking it. **Default:** derive from the registrable domain (e.g. `example-hotel.com` → "Example Hotel"). |
| `locale` | optional | Pins the Google search region (§ recipe-table). **Default: `in`** (India) when absent. Per-row override allowed (`ae`, `us`, …). |
| `prompt_override` | optional | A manual query override. **Default: `null`.** When set, it — not `keyword` — becomes the `query`. |
| `query` | derived | `query = prompt_override || keyword`. The **raw keyword is used verbatim** on every platform; there is **no keyword→question transform**. This is what gets typed into an AI composer / built into the Google search URL. |

> **Why `query` is derived, not entered:** the project rule is *measure what the user actually
> searches*. Rewriting "best hotel in downtown" into "What is the best hotel in downtown?"
> would measure a different query than the client cares about. `prompt_override` exists only
> for the rare case where a human deliberately wants a different prompt.

---

## 2. File (CSV) mode — `/svt:run inputs/<file>.csv`

A **reusable** CSV. Required header columns `site_url,keyword`; optional `brand,locale,prompt_override`.
Rows are **grouped by `site_url`** (all keywords for a site collected together). Column order is
free; match by header name.

**Sample (`inputs/example-hotel.csv`) — shown inline; do NOT commit a CSV (`inputs/` is gitignored):**

```csv
site_url,keyword,brand,locale,prompt_override
https://example-hotel.com/,Hotels in downtown,Example Hotel,ae,
https://example-hotel.com/,best hotel in downtown,Example Hotel,ae,
https://example-hotel.com/,4 star hotel in downtown,Example Hotel,ae,
https://example-resort.com,hotels in downtown,Example Resort,ae,
https://example-resort.com,best desert hotel in the metro area,Example Resort,,
```

Resolution notes for the sample:
- Row 1–3 → brand "Example Hotel", locale `ae` (overriding the `in` default — these are the region hotels measured to the region searchers), `prompt_override` empty → `query = keyword`.
- Row 5 → blank `locale` → falls back to the **`in`** default; blank `brand` → would derive "Example Resort" from the domain, but here it's given explicitly.
- Minimal valid file is just `site_url,keyword` with the other three columns omitted entirely.

---

## 3. Pasted-block (direct) mode — `/svt:collect`

A single site + its keywords, pasted the way a human drops data into chat: a **URL line**
followed by **plain or numbered keyword lines**. No CSV authoring. Resolves to the **same**
normalized records (one per keyword), all sharing the one `site_url`.

**Sample block:**

```
https://example-hotel.com/
1. Hotels in downtown
2. downtown hotel
3. best hotel in downtown
hotel in downtown
4 star hotel in downtown
```

Resolution:
- First line that is a URL → `site_url`.
- Each subsequent non-empty line → one `keyword` (strip a leading `N.`, `N)`, `-`, or `*` enumerator; keep the rest verbatim).
- `brand` derived from the domain ("Example Hotel"); `locale` defaults to `in`; `prompt_override` null; `query = keyword`.
- Optional inline overrides are **not** parsed from a pasted block — for per-row `brand`/`locale`/`prompt_override`, use CSV mode.

---

## 4. Edge handling (never crash, never silently drop)

| Situation | Rule |
|-----------|------|
| **Malformed / empty row** (missing `site_url` or `keyword`, blank line, comment) | **Skip + log** it (note the row in the run log / `input.snapshot.json` as skipped-malformed). Never abort the batch. |
| **Deep-path URL** (`…/example-resort-downtown/`) | Keep `site_url` verbatim. **Brand/visibility matching uses the registrable domain** (`example-resort.com`); the exact ranking page is captured later in `result.ranking_url`. |
| **Duplicate (site_url, keyword)** | Collapse to one record (idempotent) — the same check is never enqueued twice. |
| **Unknown extra CSV column** | Ignore it (forward-compatible); only the five known fields are read. |
| **`locale` not a 2-letter code** | Use it verbatim if the recipe-table can map it; otherwise log and fall back to `in`. |

---

## 5. Where the resolved records go

The fully-resolved record list is written once, at run start, to **`runs/<id>/input.snapshot.json`**
— see [`run-layout.md`](run-layout.md). That snapshot is the run's provenance *and* the source
of truth the resume protocol diffs against. The per-check output each record produces is defined
in [`result-shapes.md`](result-shapes.md).

> **Scope (this contract):** intake → normalized records only. Fan-out across `site × keyword ×
> platform`, concurrency, jitter, and circuit-breaking are **`/svt:run`** concerns,
> not defined here.
