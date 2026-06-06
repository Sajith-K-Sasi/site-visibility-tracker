# Result Shapes Contract — the persisted record

> **This is the schema the agent fills in-context for every check.** One check → one record →
> one line in [`runs/<id>/results.ndjson`](run-layout.md). There are **two result shapes**
> because organic search has a *position* and an AI answer does not — "ranking" doesn't exist
> inside a chat reply, only *presence*. Both shapes share one envelope.

---

## 1. Shared envelope

Every record — regardless of shape — has these top-level fields:

```jsonc
{
  "run_id":       "svt-20260605-101500",       // the run (run-layout §1)
  "platform":     "google",                     // recipe id: google|chatgpt|gemini|claude|grok|perplexity
  "site_url":     "https://example-hotel.com/",    // verbatim, from the normalized record
  "keyword":      "best hotel in downtown",    // verbatim
  "result_shape": "organic_positional",         // "organic_positional" | "ai_presence"
  "collected_at": "2026-06-05T10:15:42Z",       // ISO-8601 UTC, when the check completed
  "status":       "ok",                          // see §2
  "result":       { /* shape-specific, see §3 / §4 — null when status has no result */ },
  "note":         null                           // OPTIONAL — short human-readable reason for a NON-ok status (HIL/audit). Omit or null when status="ok". See §2.
}
```

The `(site_url, keyword, platform)` triple is the **check identity key** the resume protocol
diffs against (run-layout §3).

The optional **`note`** is metadata, never a result: it explains *why* a non-`ok` check landed where
it did (the challenge that blocked it, why it was quarantined, the error) so the HIL queue and report
can show the reason without re-opening the page. See §2.

---

## 2. `status` enum (the only allowed values)

A check resolves to **exactly one** status. This enum is what guarantees the project rule *never
silently drop a check, never emit a false "not found"*.

| `status` | Meaning | `result`? |
|----------|---------|-----------|
| `ok` | The check ran and produced a real result — **including a legitimate "not found"** (`found:false` / `mentioned:false`). | present |
| `not_applicable` | The check was intentionally not run for this platform (e.g. Google login skipped — organic still ran; or a platform excluded for this row). | present or null |
| `skipped-no-session` | No logged-in session for this platform → the lane was skipped. **NOT a "not found"** — the brand's visibility here is *unknown*, not *absent*. | null |
| `needs-human` | A challenge (CAPTCHA / login wall / region interstitial) blocks automation; queued for HIL. **Non-terminal** — re-attempted after the human clears it. | null |
| `quarantined` | Ran but the result is untrustworthy (low `match_confidence`, ambiguous brand, or an unattended challenge) → flagged for human review, surfaced in the report. | present (best-effort) |
| `error` | Hard failure after retries + self-heal (page broken, timeout exhausted). | null or partial |

> **`ok` + `found:false` ≠ `skipped-no-session`.** The first means "we looked, the brand isn't
> there" (a real, reportable negative). The second means "we couldn't look." Conflating them
> would silently turn a missing session into a fake competitive loss — the exact failure this
> enum prevents.

Terminal vs non-terminal (for resume) is defined in [`run-layout.md`](run-layout.md) §3:
everything is terminal **except `needs-human`**.

**`note` on non-`ok` records:** every record whose status is **not** `ok` (`needs-human`, `error`,
`quarantined`, and optionally `not_applicable` / `skipped-no-session`) SHOULD carry the envelope
**`note`** (§1) — a short human-readable reason: the blocking challenge, the hard failure, or the
ambiguity that triggered quarantine. `ok` records omit it. `note` is for humans (HIL queue + report);
it **never** substitutes for a real `result`, and the resume protocol ignores it.

---

## 3. `result_shape: organic_positional` — Google

Positional. Field names reused **verbatim** from the archived `runs/svt-20260604-200847/results.json`
so no downstream tool has to relearn the schema.

```jsonc
"result": {
  "found":              true,          // brand's registrable domain appears in the top-50 organic results
  "position":           1,             // 1–50 rank of the brand's domain; null if not in top 50
  "ranking_url":        "https://www.tajhotels.com/en-in",  // the exact page that ranked
  "in_ai_overview":     false,         // brand appears in Google's AI Overview block
  "cited":              false,         // brand is cited/linked inside the AI Overview
  "ai_overview_domains":[],            // domains the AI Overview cited (competitive intel)
  "evidence":           { /* §5 */ }
}
```

Rules:
- **Scan depth = top 50.** Paginate via the recipe's `&start=` (0,10,20,30,40); stop at 50.
  Beyond 50 → `found:false`, `position:null` (still `status:ok`).
- Match on the **registrable domain** (deep-path/query-string variants of the brand's site count);
  `ranking_url` records the specific URL that ranked.
- AI-Overview detection is independent of organic position — a brand can be in the AI Overview but
  not the organic top-50, or vice-versa.

### Worked sample (organic) — valid `results.ndjson` line

```json
{"run_id":"svt-20260604-200847","platform":"google","site_url":"https://www.tajhotels.com","keyword":"taj hotels","result_shape":"organic_positional","collected_at":"2026-06-04T14:38:47Z","status":"ok","result":{"found":true,"position":1,"ranking_url":"https://www.tajhotels.com/en-in","in_ai_overview":false,"cited":false,"ai_overview_domains":[],"evidence":{"screenshot_path":"runs/svt-20260604-200847/evidence/google__tajhotels__taj-hotels.png","captured_at":"2026-06-04T14:38:47Z","source_url":"https://www.google.co.in/search?q=taj%20hotels&gl=in&hl=en&pws=0&start=0"}}}
```

---

## 4. `result_shape: ai_presence` — ChatGPT · Gemini · Claude · Grok · Perplexity

Presence, not position. The brand either is or isn't part of the answer; *where* in the answer and
*how confidently* matter more than a numeric rank.

```jsonc
"result": {
  "mentioned":            true,         // the brand is named/recommended in the answer
  "cited":                true,         // the brand's own site is linked/cited as a source
  "position_in_answer":   "2nd of 5 listed",  // human-readable place in the answer (null if prose, not a list)
  "competitors_mentioned":["Hilton downtown","Citymax Hotel downtown"],  // other hotels named
  "sources_cited":        ["tripadvisor.com","booking.com","example-hotel.com"], // domains the engine pulled from
  "match_confidence":     "high",       // high|medium|low — drives the quarantine path when low
  "raw_answer":           "For downtown, Example Hotel is a strong 4-star option ...", // stored for audit
  "evidence":             { /* §5 */ }
}
```

Rules:
- **Wait for the stream to complete** before reading (recipe `done_signal`) — never scrape a
  half-streamed answer.
- `mentioned` keys on the **brand** (name match), not just the domain — an engine often names a
  hotel without linking it; that still counts as visibility. `cited` is the stricter signal (the
  brand's own URL appears as a source).
- **`match_confidence: low`** (ambiguous/generic brand name, uncertain match) → the orchestrator
  sets `status: quarantined` rather than counting it; never silently scored.
- `raw_answer` is retained verbatim for the audit trail (and so a human can re-judge a quarantined
  check from the record alone).

### Worked sample (AI presence) — valid `results.ndjson` line

```json
{"run_id":"svt-20260605-101500","platform":"chatgpt","site_url":"https://example-hotel.com/","keyword":"best hotel in downtown","result_shape":"ai_presence","collected_at":"2026-06-05T10:16:09Z","status":"ok","result":{"mentioned":true,"cited":false,"position_in_answer":"2nd of 5 listed","competitors_mentioned":["Hilton downtown","Citymax Hotel downtown"],"sources_cited":["tripadvisor.com","booking.com"],"match_confidence":"high","raw_answer":"For downtown, a few well-regarded options are Hilton downtown, Example Hotel, Citymax ...","evidence":{"screenshot_path":"runs/svt-20260605-101500/evidence/chatgpt__example-hotel__best-hotel-in-downtown.png","captured_at":"2026-06-05T10:16:09Z","source_url":"https://chatgpt.com/"}}}
```

---

## 5. `evidence` sub-object (both shapes)

Reused field names from the archived artifact. **Required for every `ok`/`quarantined` record**
(audit trail — one screenshot per check).

```jsonc
"evidence": {
  "screenshot_path": "runs/<id>/evidence/<platform>__<site>__<kw>.png",  // run-layout §4
  "captured_at":     "2026-06-05T10:16:09Z",                              // ISO-8601 UTC
  "source_url":      "https://www.google.co.in/search?q=...&start=0"      // the URL the evidence was taken from
}
```

For `skipped-no-session` / `needs-human` (no `result`), there is no evidence object.

---

## 6. Consistency notes

- **No new dependencies** to fill these — the agent reads the page and writes the JSON in-context
  (no second LLM, no schema library, no DB). The record *is* the data layer.
- The **organic** shape's field names are byte-for-byte the archived ones; only the **wrapper**
  gains the explicit `status` enum (the archived sample used `status:"ok"` already — this contract
  formalizes the full set).
- Per-platform *how-to-collect* (URLs, done-signals, extraction) is **not** here — see
  [`recipe-table.md`](recipe-table.md). This file defines only the **output record**.
