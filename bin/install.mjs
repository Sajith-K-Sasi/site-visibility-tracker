#!/usr/bin/env node
// site-visibility-tracker — project-folder installer.
//
// A THIN file-copier: it scaffolds the /svt:* commands, the two collector agents, and the
// data contracts from this package's own .claude/ into a target project's .claude/.
// No dependencies (Node built-ins only), no product logic, no second LLM — the product
// stays a pure Claude Code workflow; this script only copies files.

import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const SRC = join(PKG_ROOT, '.claude'); // the package's own bundled files (works for npx-github + npm-publish)

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`site-visibility-tracker — project-folder installer

Scaffolds the /svt:* workflow into a project's .claude/:
  commands/svt/*.md     /svt:setup /svt:login /svt:collect /svt:run /svt:report
  agents/svt-*.md       svt-google + svt-ai-engine collector subagents
  svt/contracts/*.md    input / run-layout / result-shapes / recipe / report contracts

Usage:
  npx github:Sajith-K-Sasi/site-visibility-tracker [target] [--force]
  svt-install [target] [--force]

  target    project directory to install into (default: current directory)
  --force   overwrite existing files (default: skip existing + warn)

After installing, in Claude Code:
  1. /svt:setup               install the toolchain (@playwright/cli + skill + Chromium)
  2. /svt:login <platform>    log into each AI platform (your own sessions; never shared)
  3. /svt:collect | /svt:run  collect; then /svt:report for the XLSX + PDF deliverables
`);
  process.exit(0);
}

if (!existsSync(SRC)) {
  console.error(`error: bundle not found at ${SRC} — is this the site-visibility-tracker package?`);
  process.exit(1);
}

const force = args.includes('--force');
const targetArg = args.find((a) => !a.startsWith('-'));
const TARGET_ROOT = resolve(targetArg ?? process.cwd());
const DEST = join(TARGET_ROOT, '.claude');

// Directory groups: copy every *.md inside.
const GROUPS = [
  { src: join(SRC, 'commands', 'svt'), dest: join(DEST, 'commands', 'svt'), label: 'commands/svt' },
  { src: join(SRC, 'svt', 'contracts'), dest: join(DEST, 'svt', 'contracts'), label: 'svt/contracts' },
];
// Individual files: only the two svt-* agents (never the whole agents/ dir).
const SINGLES = [
  { src: join(SRC, 'agents', 'svt-google.md'), dest: join(DEST, 'agents', 'svt-google.md'), label: 'agents/svt-google.md' },
  { src: join(SRC, 'agents', 'svt-ai-engine.md'), dest: join(DEST, 'agents', 'svt-ai-engine.md'), label: 'agents/svt-ai-engine.md' },
];

let written = 0;
let skipped = 0;

function copyOne(srcFile, destFile, label) {
  mkdirSync(dirname(destFile), { recursive: true });
  const existed = existsSync(destFile);
  if (existed && !force) {
    console.log(`  skip   ${label}  (exists — use --force to overwrite)`);
    skipped++;
    return;
  }
  copyFileSync(srcFile, destFile);
  console.log(`  ${existed ? 'force' : 'write'}  ${label}`);
  written++;
}

console.log(`Installing site-visibility-tracker → ${DEST}\n`);

for (const g of GROUPS) {
  for (const name of readdirSync(g.src).filter((n) => n.endsWith('.md')).sort()) {
    copyOne(join(g.src, name), join(g.dest, name), `${g.label}/${name}`);
  }
}
for (const s of SINGLES) {
  copyOne(s.src, s.dest, s.label);
}

console.log(`\nDone: ${written} written, ${skipped} skipped.`);
console.log(`
Next, in Claude Code:
  1. /svt:setup               — install the toolchain (@playwright/cli + skill + Chromium)
  2. /svt:login <platform>    — log into each AI platform (your own sessions; never shared)
  3. /svt:collect or /svt:run — collect, then /svt:report for the XLSX + PDF deliverables
  (always --dry-run first)
`);
