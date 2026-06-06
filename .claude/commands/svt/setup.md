---
description: "Install and verify the site-visibility-tracker browsing toolchain (@playwright/cli + Claude Code skill + Chromium) and the on-disk run scaffold, then run a live smoke check. Idempotent."
argument-hint: "(no arguments)"
allowed-tools: Bash, Read, Write
---

# /svt:setup — toolchain installer + smoke check

You are bringing up (or re-verifying) the browsing toolchain that the entire
site-visibility-tracker workflow drives. Run every step **idempotently**
(detect-then-act): if a component is already present, report it as such and do
not reinstall. **Never** swallow a failure — if a step fails, stop, name the
failing step, give a concrete remediation hint, and mark the final readiness as
FAIL. Do not claim PASS unless every component is present and the smoke check
returns a real page.

Work through the steps in order, collecting a status line for each. At the end,
print the **Readiness Summary** table.

> **You are the brain — adapt to the OS you're on.** This command is executed by the
> Claude Code agent, not run as a fixed shell script. First note your platform (macOS /
> Linux / Windows — you already know it from your environment) and use the matching idiom
> at each step. The commands below are reference idioms (POSIX / macOS+Linux by default);
> on **Windows** substitute the PowerShell equivalent (e.g. `New-Item -ItemType Directory
> -Force` for `mkdir -p`; `where.exe` for `which`). The toolchain itself — Node,
> `@playwright/cli`, Playwright Chromium — is fully cross-platform; only the shell idioms,
> filesystem paths, and (Linux-only) system-deps differ. *Note: Windows is designed-for but
> not yet validated — report honestly if a step behaves differently there.*

> **Browsing vocabulary lives in the skill, not here.** Step 3 installs the
> `playwright-cli` Claude Code skill (`.claude/skills/playwright-cli/`), which is the
> single source of truth for the CLI command surface (open/goto/type/click/snapshot/
> screenshot, named sessions `-s=`, `--persistent`/`--profile`, `list`/`close-all`/
> `kill-all`, storage-state, etc.) — the agent loads it automatically. **`/svt:*`
> commands must NOT re-document those commands**; they encode only SVT orchestration
> and domain logic. The literal CLI commands shown below exist because this is the
> install+smoke command — install steps are setup-specific, and the smoke is a fixed
> verification script.

## Step 1 — Preflight: Node + npm

```bash
node -v
npm -v
```

- If either is missing/errors: **STOP**. Remediation: "Install Node.js ≥ 18 (which
  bundles npm), then re-run /svt:setup." Mark readiness FAIL and do not continue.
- Otherwise record the versions.

## Step 2 — Install @playwright/cli (global)

First confirm the package identity so a wrong/renamed package surfaces clearly:

```bash
npm view @playwright/cli version
```

- If this errors (package not found / network blocked): **STOP** that step,
  report the exact error, remediation: "Confirm the package name `@playwright/cli`
  and network access to the npm registry." Mark FAIL.

Then install (npm is idempotent — a re-run reports up-to-date, not an error):

```bash
npm i -g @playwright/cli
```

Verify the binary resolves:

```bash
playwright-cli --version
```

- Record: installed vs already-present (compare to whether it resolved before),
  plus the resolved version. If `playwright-cli` does not resolve after install:
  report it (likely a global-bin PATH issue) with remediation to ensure the npm global
  bin directory (`npm prefix -g`) is on PATH. Mark FAIL.

## Step 3 — Install the Claude Code skill

```bash
playwright-cli install --skills
```

- Treat an "already installed" result as success. On error, report the step output
  + remediation. Mark FAIL if it genuinely fails.

## Step 4 — Ensure browsers (hybrid model)

SVT drives **real system Google Chrome** for live collection/login lanes (least
bot-detectable — the binding constraint; natural home for persistent logins), and the
**bundled Playwright chromium** for reproducible smoke / dry-run / CI. Ensure both.

```bash
playwright-cli install                  # initialize workspace (idempotent)
playwright-cli install-browser chromium # bundled chromium — portable/CI + smoke (idempotent)
```

Detect the **chrome channel** (the default `open` launches it) at the per-OS location:
- **macOS:** `/Applications/Google Chrome.app`
- **Linux:** `/opt/google/chrome/chrome` or `which google-chrome`
- **Windows:** `C:\Program Files\Google\Chrome\Application\chrome.exe` (or `where.exe chrome`)

then:
- present → live real-Chrome lanes ready;
- absent → try `playwright-cli install-browser chrome`; if it can't be installed,
  **WARN (not FAIL)**: "chromium-only mode — live real-Chrome lanes unavailable until
  Google Chrome is installed." (CI legitimately runs chromium-only.)

**Linux only:** a clean box needs system libs for any chromium. If `install-browser`
prints a "missing dependencies" warning, run `npx playwright install-deps` (or apt-get:
`libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libdbus-1-3 libcups2 libxkbcommon0
libasound2 libgbm1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libatspi2.0-0`).

- A browser already present counts as success (idempotent). If the chromium download is
  blocked (offline/proxy): report it with remediation ("ensure network access, or set
  PLAYWRIGHT_DOWNLOAD_HOST") and mark FAIL.

## Step 5 — On-disk run scaffold

Ensure the `runs/` and `inputs/` directories exist (create if missing; leave any existing
contents untouched). They are **already covered by `.gitignore`** — do NOT add `.gitkeep`,
do NOT edit `.gitignore`. Use your platform's idiom:

```bash
mkdir -p runs inputs                              # macOS / Linux
# Windows PowerShell:  New-Item -ItemType Directory -Force runs, inputs
```

- Record each as created vs already-present.

## Step 6 — Smoke check (drive the CLI against a live page)

Prove the agent can actually navigate, read structured page state, and capture
evidence. Smoke the **bundled chromium** (`--browser=chromium`) — deterministic across
host + CI, since it does not depend on a system Chrome being installed (verified on macOS
+ clean Debian/arm64). Use a dedicated throwaway session `svt-smoke` and clean it up after.

```bash
mkdir -p runs/_smoke
playwright-cli -s=svt-smoke open --browser=chromium https://example.com
playwright-cli -s=svt-smoke snapshot
playwright-cli -s=svt-smoke screenshot --filename runs/_smoke/example.png
playwright-cli -s=svt-smoke close
```

Note: `screenshot [target]` takes an element *ref*, not a path — the output file goes via
`--filename` (add `--full-page` for the whole page). The **default** `open` (no `--browser`)
launches the chrome channel = system Google Chrome, which is what live lanes use; the smoke
pins chromium only for reproducibility.

Confirm:
- the `snapshot` output is **non-empty** and structurally describes example.com
  (heading "Example Domain" / the page text) — not an error or block page;
- the screenshot file exists and is non-empty.

If the snapshot is empty or the screenshot is missing: mark the smoke FAIL, report
what came back, and do not report overall PASS. Always close the `svt-smoke` session
(use `playwright-cli close-all` if a single `close` does not clear it).

## Readiness Summary (always print this last)

Print a compact table, then a final verdict line:

```
Component            Status                  Detail
-------------------  ----------------------  ----------------------------------
@playwright/cli      installed | present     v<version>
Claude Code skill    installed | present     playwright-cli install --skills
Chromium (bundled)   installed | present     for smoke / CI / dry-run
Chrome channel       present | MISSING(warn)  system Google Chrome — live lanes
runs/                created   | present     ./runs
inputs/              created   | present     ./inputs
Smoke (chromium)     PASS | FAIL             snapshot non-empty + runs/_smoke/example.png

READINESS: PASS  (or)  READINESS: FAIL — <failing step> — <remediation>
```

Rules recap: detect-then-act everywhere · re-runs are safe and report "already present" ·
never silently continue past a failure · the smoke pins chromium for determinism · a
MISSING Chrome channel is a **WARN** (chromium-only/CI mode), not a FAIL · only print
`READINESS: PASS` when @playwright/cli + skill + chromium + scaffold are present and the
chromium smoke returned a real page.
