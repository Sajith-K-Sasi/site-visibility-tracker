---
description: "Establish or check per-platform logged-in browser sessions for site-visibility-tracker. Opens a headed, real-Chrome, persistent profile per platform, lets you authenticate once, verifies logged-in, and records session status with explicit skip-no-session semantics."
argument-hint: "[platform | --status]   (platform: chatgpt|gemini|claude|grok|perplexity|google)"
allowed-tools: Bash, Read
---

# /svt:login — per-platform logged-in sessions

You are establishing (or checking) the **logged-in browser sessions** that the AI-engine
lanes read results from. Each platform gets its own **headed, real Google Chrome,
persistent** profile under `profiles/<platform>/`, so the login survives across separate
CLI invocations (and later `/svt:collect` / `/svt:run`).

> **You are the brain — judge logged-in vs login-wall in-context.** Do NOT rely on brittle
> CSS selectors. Open the page, read the `snapshot`, and decide. **Strongest signal:** the
> *absence* of "Log in" / "Sign up" affordances **AND** the *presence* of an account /
> profile menu (the user's name, avatar, or "Upgrade"). ⚠️ A chat composer / search box
> alone is **NOT** proof of login — several platforms (e.g. ChatGPT) show a composer while
> logged out. That judgment is yours.

> **Wait out bot-challenges before judging.** Opening — and especially *reopening* a
> persistent profile (a fresh session handle) — can hit a Cloudflare-style interstitial
> ("Just a moment…", "verify you are human", title "Just a moment..."). This is expected and
> usually clears within a few seconds in **headed real Chrome**. Poll the title/snapshot
> (up to ~15s) until the real app loads before you judge logged-in vs login-wall — never
> judge off the challenge page. Prefer `--headed` so challenges pass.

> **Browsing vocabulary lives in the skill.** The installed `playwright-cli` skill
> (`.claude/skills/playwright-cli/`, esp. `references/session-management.md`) is the source
> of truth for the exact flags (named sessions `-s=`, persistent `--profile=<dir>`,
> `--browser=chrome`, `--headed`, `state-save`/`state-load`, `close`/`close-all`). Use them;
> do not re-document them here.

> **NEVER touch credentials.** You never type, read, or store usernames / passwords / 2FA
> codes, and you never write any credential to a file or the repo. The human authenticates
> in the visible browser window; you only observe whether the result is logged-in.

## Platform map (minimal — login URL + how to judge logged-in)

The **full** per-platform recipe (search/answer extraction) is defined in the recipe table. Here,
only the login URL + the logged-in signal to judge by snapshot:

| Platform   | Login URL                     | Logged-in signal (judge from snapshot) | Notes |
|------------|-------------------------------|----------------------------------------|-------|
| chatgpt    | https://chatgpt.com           | account/profile menu present (user name / "Upgrade") AND no "Log in"/"Sign up for free" — composer alone ≠ logged in | required |
| gemini     | https://gemini.google.com     | prompt input present | required |
| claude     | https://claude.ai             | chat input present | required |
| grok       | https://grok.com              | prompt input present | required |
| perplexity | https://www.perplexity.ai     | "Ask anything" input present | required |
| google     | https://www.google.com        | account avatar present | **login OPTIONAL** — organic SERP is public; a session only helps consistency/region |

## Behavior

**Args:**
- `/svt:login <platform>` — log in / verify one platform.
- `/svt:login` — walk all supported platforms in turn.
- `/svt:login --status` — report each platform's status only (probe existing profiles; do not prompt for new logins).

### Login / verify flow (per platform)

1. **Ensure `profiles/` exists** (create if missing; gitignored — do NOT `.gitkeep`, do NOT edit `.gitignore`).
2. **Open a headed real-Chrome persistent session** for the platform: a named session
   `svt-<platform>` using the chrome channel, headed, with a persistent profile at
   `profiles/<platform>`, navigating to the platform's login URL. (Consult the skill's
   session-management reference for the exact flag spelling.)
3. **Wait for any bot-challenge to clear** (title "Just a moment..." / "verify you are
   human"); poll up to ~15s until the real app loads. Then **read the snapshot and judge**
   logged-in vs login-wall (account/profile present + no "Log in"/"Sign up"):
   - **Already logged in** → report "already logged in"; do NOT force re-auth; close the session.
   - **Login wall** → this is a blocking **human step**: ask the user to sign in (credentials /
     2FA / passkey) in the visible window and tell you when done. Wait. Do not automate it.
4. **Re-verify after the human signals done:** re-read the snapshot.
   - logged-in → report success.
   - still a login wall → report "still not logged in" (do not loop silently; surface it).
5. **Close** the session (`close` / `close-all`) — the profile on disk retains the login.

### `--status` / skip-no-session semantics (CORE constraint)

Report each platform as exactly one explicit status — **never** a silent success or a false
"not found":

| Status | Meaning |
|--------|---------|
| `logged-in` | profile exists and a probe shows the app UI |
| `expired — re-login needed` | profile exists but probe shows a login wall |
| `skipped — no session` | no `profiles/<platform>/` profile yet |

A platform that is not `logged-in` is **skipped and recorded as skipped** by downstream
collection — it must never become a false "brand not found". (The formal persisted run-time
result/skip contract is defined in the result-shapes contract; here you report the live status.)

## Output

Print a status table, e.g.:

```
Platform     Status                      Profile
-----------  --------------------------  ----------------------
chatgpt      logged-in                   profiles/chatgpt
gemini       skipped — no session        (none)
claude       expired — re-login needed   profiles/claude
...
```

Rules recap: real Chrome + persistent `profiles/<platform>` · judge logged-in in-context ·
human authenticates (never automated) · **no credential ever stored** · skip-no-session is
explicit, never a false negative · always close sessions when done.
