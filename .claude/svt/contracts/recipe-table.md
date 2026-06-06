# Per-Platform Recipe Table — collection data

> **This is recipe DATA, not collector code.** It parameterizes the future collector subagents —
> `svt-google` and `svt-ai-engine` — so one subagent body handles all five AI
> chats by reading its row here. The actual CLI verbs (`open`/`type`/`snapshot`/`screenshot`,
> named sessions, `--profile`, `attach`) live in the installed **`playwright-cli` skill**
> (`.claude/skills/playwright-cli/`) — this table references them, it does not re-document them.

Two engine types, six platforms. `google` is **organic/positional**; the five chats are
**ai_presence** (see [`result-shapes.md`](result-shapes.md)). Login signals + the grok fallback
below are taken from the **live login walk**, not guessed.

---

## Table

| platform | engine_type | entry_url | query_method | logged_in_signal | done_signal | session |
|----------|-------------|-----------|--------------|------------------|-------------|---------|
| **google** | organic | `https://www.google.<cctld\|com>/search?q=<q>&gl=<locale>&hl=en&pws=0&start=<n>` | build the search URL (no typing) | account avatar present — **login OPTIONAL** | SERP results list rendered | real-Chrome `profiles/google` *(optional)* |
| **chatgpt** | ai_chat | `https://chatgpt.com` | type `query` verbatim into composer, submit | account/profile menu (name / "Upgrade") **and NO** "Log in"/"Sign up for free" — *composer alone ≠ logged in* | answer **stream complete** | real-Chrome `profiles/chatgpt` |
| **gemini** | ai_chat | `https://gemini.google.com` | type `query` verbatim, submit | prompt input present (logged-in Google chrome) | answer stream complete | real-Chrome `profiles/gemini` |
| **claude** | ai_chat | `https://claude.ai` | type `query` verbatim, submit | chat input present | answer stream complete | real-Chrome `profiles/claude` |
| **grok** | ai_chat | `https://grok.com` | type `query` verbatim, submit | prompt input present | answer stream complete | real-Chrome `profiles/grok` ⚠ **does not persist — see fallback** |
| **perplexity** | ai_chat | `https://www.perplexity.ai` | type `query` verbatim, submit | "Ask anything" input present | answer + sources rendered | real-Chrome `profiles/perplexity` |

`<q>` = URL-encoded `query`; `<locale>` from the normalized record (default `in`); `<n>` = `start`
offset. The **binding region pin is `gl=<locale>`** (with `pws=0` disabling personalization);
the host ccTLD is secondary (`www.google.com` + `gl` regions correctly).

---

## Per-platform extraction notes

### google — organic_positional
- **Top-50 only.** Paginate `&start=0,10,20,30,40`; stop at 50. Beyond 50 → `found:false,
  position:null` (still `status:ok`).
- Read the SERP `snapshot`; find the brand's **registrable domain** among organic results →
  `position` (1-based) + the exact `ranking_url`. Deep-path/locale variants of the brand site count.
- Detect the **AI Overview** block independently → `in_ai_overview`, `cited`, and `ai_overview_domains`
  (the domains it cites — competitive intel).
- Login is optional (organic SERP is public); a `profiles/google` session only helps region/consistency.

### chatgpt · gemini · claude · grok · perplexity — ai_presence
- Type the **`query` verbatim** (raw keyword; no question rewrite) into the composer and submit.
- **Wait for the stream to finish** (`done_signal`) before reading — never scrape a half-streamed
  answer. Then read the answer + any source chips.
- Judge in-context → `mentioned`, `cited`, `position_in_answer`, `competitors_mentioned`,
  `sources_cited`, `match_confidence`; store `raw_answer`. Low confidence → `quarantined`.
- perplexity surfaces explicit source citations → populate `sources_cited` from them.

---

## Cross-cutting handling (from live findings)

### grok — persists via `state-load`/`state-save`
grok's **persistent profile loses** its auth on reopen (federated X/Twitter auth — the cross-domain
`.x.ai`/`.twitter.com`/`x.com` cookies aren't captured by the profile, and/or session-only tokens).
**Resolved operationally:** a captured `auth.json` storage state **does** carry the federated
cookies, so grok now persists. The grok lane resolves its session **in priority order**:

1. **`state-load profiles/grok-auth.json`** (primary/default) — opens grok already logged-in from the
   saved storage state (incl. the federated `.x.ai`/`.twitter.com`/`x.com` cookies).
2. **`attach --cdp=chrome`** (secondary) — attach to the user's already-running real Chrome (logged into X/grok).
3. **fresh login (`mode=attended` only)** — patient-wait for the human to log in, then **`state-save
   profiles/grok-auth.json`**. The save **must include the federated `.x.ai`/`.twitter.com`/`x.com`
   cookies** (not just `grok.com`) so the next run's `state-load` works → grok persists.

If none yields a logged-in grok (esp. `mode=unattended` with nothing loadable), the lane is recorded
**`skipped-no-session`**, never a false "not found". (`/svt:login --status` reports grok
**`expired — re-login needed`** in that case.) **Residual:** the saved state's longevity across days is
unmeasured — re-save when it expires.

### Cloudflare "Just a moment…" — wait before judging (all platforms, esp. on reopen) — `mode`-aware
Opening (and especially **reopening**) a persistent profile can hit a Cloudflare-style interstitial
("Just a moment…", "verify you are human", title `Just a moment...`); the Google lane can also hit the
`/sorry/` "unusual traffic" wall. It usually clears in **headed real Chrome**. **How long a lane waits
depends on the `mode`** the orchestrator hands it (run-context, not a record field):
- **attended** — keep the headed window open and **wait for the human** to clear it: poll on a steady
  cadence up to a **generous cap (~5 min)**, re-prompting periodically, then continue the moment the
  real app/SERP loads (only an abandoned challenge → `needs-human`). Strictly better than timeout-give-up
  when a human is present (validated live).
- **unattended** — poll **~15s**; if it never clears → `needs-human` (the orchestrator's
  cooldown/breaker/`quarantined` carry it). A lane **never** waits for an absent human.

Prefer `--headed` so challenges pass. (Lane-side handling lives in `svt-google`/`svt-ai-engine` **step 3**;
the attended-vs-`--unattended` routing is `run.md` §4c; `/svt:collect` is always attended.)

### skip-no-session (every platform)
A platform whose session is not logged-in is **skipped and recorded `skipped-no-session`** — the
unknown is `unknown`, never a fabricated "brand not found". (Status semantics: [`result-shapes.md`](result-shapes.md) §2.)

---

## Consumers

- **`svt-google`** reads the `google` row → organic_positional records.
- **`svt-ai-engine`** is parameterized by the five `ai_chat` rows → ai_presence records.
- Both drive the **`playwright-cli` skill** against the real-Chrome `profiles/<platform>` sessions
  established by [`/svt:login`](../../commands/svt/login.md); the orchestrator holds HIL.
