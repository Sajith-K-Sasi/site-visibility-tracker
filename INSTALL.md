# Install — site-visibility-tracker

A **pure Claude Code workflow** for tracking organic (Google) + AI-search visibility across
ChatGPT, Gemini, Claude, Grok, and Perplexity. Install it into your own project's `.claude/`
with one command — then drive it from Claude Code with the `/svt:*` slash commands.

## 1. Scaffold the workflow into your project

From the root of the project you want to run it in:

```bash
npx github:Sajith-K-Sasi/site-visibility-tracker
```

This copies into `./.claude/`:

- `commands/svt/` — the `/svt:setup`, `/svt:login`, `/svt:collect`, `/svt:run`, `/svt:report` commands
- `agents/svt-google.md`, `agents/svt-ai-engine.md` — the collector subagents
- `svt/contracts/` — the input · run-layout · result-shapes · recipe · report contracts

It **never overwrites** existing files unless you pass `--force`, and it touches **nothing else** in
`.claude/`.

```bash
# install into a specific directory, or force-overwrite existing files:
npx github:Sajith-K-Sasi/site-visibility-tracker ./path/to/project
npx github:Sajith-K-Sasi/site-visibility-tracker --force
```

*(Once published to npm, `npx site-visibility-tracker` works the same way.)*

## 2. Install the toolchain

In Claude Code:

```
/svt:setup
```

Installs `@playwright/cli` + its Claude Code skill + Chromium. The skill is installed **locally** by
`/svt:setup` (it is intentionally **not** part of this bundle — it's re-installed and version-matched
per machine).

## 3. Log into the platforms — your own sessions

```
/svt:login            # walk every platform in turn
/svt:login chatgpt    # or one at a time
/svt:login --status   # check what's logged in
```

Each person logs into their **own** browser sessions, stored per-project under `profiles/`. Sessions
are **never shared and never committed**. Google organic needs no login.

## 4. Collect, then report

```
/svt:collect <paste a URL line, then keyword lines>   # single, ad-hoc
/svt:run inputs/<your-file>.csv                        # batch (resumable)
/svt:report                                            # XLSX scorecard + PDF client report
```

Always run with `--dry-run` first to eyeball the parse + scope before a full run.
