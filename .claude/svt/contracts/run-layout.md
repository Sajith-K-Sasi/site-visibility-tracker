# Run-Folder Layout Contract — `runs/<id>/`

> **This is a contract the agent honors — not a scaffolding script.** `/svt:setup` already
> creates the top-level `runs/` and `inputs/` directories (idempotently). Each run then creates
> its own `runs/<id>/` subtree and fills it as checks complete. Everything under `runs/` is
> **gitignored** (client-specific + large).

A run is **self-describing and resumable**: the resolved input, every per-check record, the
evidence, and the quarantine log all live under one `runs/<id>/` folder, so a run can be paused,
crash, or be re-invoked and pick up exactly where it left off without re-doing completed checks.

---

## 1. Run id

```
svt-YYYYMMDD-HHMMSS        e.g.  svt-20260605-101500
```

UTC timestamp at run start. (Matches the existing artifact `runs/svt-20260604-200847/`.) One id
per `/svt:collect` or `/svt:run` invocation; it stamps every record's `run_id` field.

---

## 2. Folder contents

```
runs/<id>/
  input.snapshot.json     # the resolved normalized records (provenance + resume source of truth)
  results.ndjson          # APPEND one JSON record per line, as each check finishes  ← write path
  results.json            # consolidated JSON array — materialized at REPORT time only
  quarantine.json         # checks needing human review (status=quarantined/needs-human), surfaced in report
  evidence/               # one screenshot per check
    <platform>__<site-slug>__<kw-slug>.png
```

| File | When written | By whom | Shape |
|------|--------------|---------|-------|
| `input.snapshot.json` | once, at run start | the orchestrator command | JSON array of normalized records (see [`input-contract.md`](input-contract.md) §1) |
| `results.ndjson` | continuously, append-only | each collector lane, as a check completes | one [result record](result-shapes.md) per line (NDJSON) |
| `results.json` | once, at report time | `/svt:report` | the NDJSON folded into a single JSON array |
| `quarantine.json` | continuously | orchestrator, when a check is `quarantined`/`needs-human` | JSON array of the flagged records (a view, not a separate truth) |
| `evidence/*.png` | per check | each collector lane | PNG; path stored in the record's `result.evidence.screenshot_path` |

> **Why NDJSON for the write path:** appending one line per check is **crash-safe and
> append-only** — a run that dies at check 3,000 of 4,500 leaves 3,000 valid lines and a clean
> tail, with no half-rewritten array to repair. The single-array `results.json` is a *read*
> convenience built once at report time, never the live write target.

---

## 3. Resume protocol (the core of "resumable, never re-do")

On (re-)invocation for a run id, **before enqueuing any check**, read `results.ndjson` and skip
work already done.

**Check identity key:** `(site_url, keyword, platform)`.

**A check is DONE** iff `results.ndjson` contains a record for that key whose `status` is
**terminal**:

| `status` | Terminal? | Meaning on resume |
|----------|-----------|-------------------|
| `ok` | ✅ terminal | collected — skip |
| `not_applicable` | ✅ terminal | legitimately not run (e.g. Google login skipped) — skip |
| `skipped-no-session` | ✅ terminal | no logged-in session — skip (re-runs don't retry unless a session is now present *and* the user asks) |
| `quarantined` | ✅ terminal | flagged for human review — skip auto-retry (handled via report, not re-collection) |
| `error` | ✅ terminal | hard-failed after retries — skip auto-retry (re-run only on explicit request) |
| `needs-human` | ❌ **non-terminal** | a challenge/HIL is pending — **re-attempt** after the human clears it |

So a plain re-run collects only checks with **no record** plus any **`needs-human`** records;
everything terminal is left untouched. (If the same key appears more than once across crashes,
the **last** line for that key wins.)

> **Status semantics live in [`result-shapes.md`](result-shapes.md).** This contract only uses
> them to decide skip-vs-redo. A `skipped-no-session` is an explicit, recorded outcome — it must
> **never** be re-interpreted as "brand not found" (that distinction is the whole point of the
> status enum).

---

## 4. Evidence naming

```
evidence/<platform>__<site-slug>__<kw-slug>.png
        e.g.  google__example-hotel__best-hotel-in-downtown.png
              chatgpt__example-resort__hotels-in-downtown.png
```

- `platform` — one of the six recipe ids.
- `site-slug` — registrable domain, dots stripped (`example-hotel.com` → `example-hotel`).
- `kw-slug` — keyword lowercased, non-alphanumerics → `-`, collapsed/trimmed.
- Collisions (same key) → append `__<n>` (matches the archived `google__taj-hotels__0.png` convention).

The absolute (or run-relative) path lands in `result.evidence.screenshot_path`; `source_url` and
`captured_at` accompany it (see result-shapes).

---

## 5. `inputs/`

`inputs/` (top-level, gitignored) holds the user's reusable CSVs for `/svt:run`. It is **input**,
not run state — the run copies the *resolved* records into `runs/<id>/input.snapshot.json` so the
run no longer depends on the original file. (To version a shared sample input, a user would have to
un-ignore it deliberately; by default nothing in `inputs/` is committed.)

---

## 6. Batch concurrency & resilience (where each piece lives)

This contract defines only the **on-disk shape and the resume rule**. The batch behaviors that build
on it live in `/svt:run` (`.claude/commands/svt/run.md`):

- **Defined in `run.md`:** the concurrency model — **across-platform parallel,
  serial within a platform** (one persistent `profiles/<platform>` session per lane) — and the
  **inter-check jitter** between a lane's successive checks. See `run.md` §4.
- **Defined in `run.md`:** failure **classification + bounded retry/backoff**
  (`run.md` §4a), the per-lane **circuit-breaker** (pause a lane after N consecutive blocks → its
  not-yet-attempted remainder recorded **`needs-human`**, resumable) + the **global wall-clock cap**
  (`run.md` §4b), and **attended-vs-`--unattended`** challenge routing — `--unattended` records an
  unclearable challenge as **`quarantined`** (`run.md` §4c). The **attended** HIL re-queue from
  `/svt:collect` is the default these build on. **No new status value** — every outcome reuses the
  result-shapes §2 enum, and the resume rule (§3 above) is what makes a breaker/cap `needs-human`
  auto-re-attempt on the next `--resume`.
