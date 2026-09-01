<div align="center">

# Agent Skill Doctor

AI Agent Skills diagnostics and governance for Claude Code, Codex, Cursor, OpenCode, and other local agent skill folders.

[![License](https://img.shields.io/badge/License-MIT-3B82F6?style=for-the-badge)](./LICENSE)
[![npm](https://img.shields.io/npm/v/agent-skill-doctor?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/agent-skill-doctor)
[![Node](https://img.shields.io/badge/Node-%3E%3D22.5.0-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Zero Deps](https://img.shields.io/badge/Zero-Dependencies-10B981?style=for-the-badge)](#install)

[中文](./README.md) · English

</div>

---

Agent Skill Doctor diagnoses local AI Agent Skills: duplicate installs, version drift, conflicting instructions, risky commands, zombie skills, weak descriptions, and scan structure warnings. It does not delete or overwrite skill files by default; it diagnoses, reports, and generates repair prompts for your agent.

## What It Detects

- `risk`: risky text such as `rm -rf`, `.env`, `curl/wget`, `powershell`, or `child_process`.
- `conflict`: contradictory instructions, such as `npm install` vs `pnpm install`.
- `duplicate`: exact, same-source, or same-name duplicate skills.
- `version_drift`: the same skill installed with different refs or content.
- `governance`: registry / team-sharing readiness, such as missing owner, version, lifecycle status, stable/dev label, or trusted source.
- `freshness`: whether a skill may need an update, such as missing source URLs, unpinned refs/commits, old remote-backed copies, or a lower version than a sibling copy. Use `--check-upstream` to verify against the upstream `HEAD` with `git ls-remote`.
- `zombie`: low-activity or possibly abandoned skills.
- `description_quality`: missing trigger, input/output, risk notes, or too-short descriptions.
- `scan_warning`: missing `SKILL.md` or malformed frontmatter.

## Scoring Rules

- Risk severity comes from JSON rules: destructive file operations are usually `critical`, credential access and remote downloads are usually `high`, shell execution is usually `medium`.
- Duplicate confidence: exact content `1.0`, same source and slug `0.95`, same name with different content `0.7`.
- Zombie score is `0.0 - 1.0`; higher means more suspicious:
  - no preset: `+0.25`
  - not installed in any agent: `+0.20`
  - not installed in any project: `+0.20`
  - no recent modification: `+0.15`
  - no activity log: `+0.15`
  - weak description: `+0.05`
- Zombie protection: `pinned/keep/core/system` tags and official sources return `0`; plugin sources multiply by `0.5`; third-party plugin sources multiply by `0.75`.
- Zombie levels: `>=0.8` strong suspected zombie, `>=0.6` suspected zombie, `>=0.4` low activity.
- Findings are classified as `stale` (reference or activity evidence exists but the skill is inactive), `unused_candidate` (installed but no reference was found), or `untracked` (evidence is incomplete). Recommendations are intentionally review/archive/disable first, never automatic deletion.
- The scanner checks each skill directory and nearby agent/project configuration files for slug or name references, then records matched files and evidence confidence. Use `--zombie-threshold` and `--min-confidence` to narrow results.
- Description quality starts at 60 points; short descriptions, missing triggers, missing input/output notes, and undocumented risks reduce the score and create findings.

## Install

```bash
npm install -g agent-skill-doctor
```

Or run without global install:

```bash
npx agent-skill-doctor help
```

Requires Node.js `>= 22.5.0`.

## Quick Start: Use It With An Agent

Paste this into Claude Code, Codex, Cursor Agent, or another local agent:

```text
Use agent-skill-doctor to diagnose my local Agent Skills:

1. Generate a full HTML report: npx agent-skill-doctor report --format html --lang en
2. `report` runs the complete diagnosis first; use `--scan-only` to export the existing result after a recent `diagnose` run.
3. Review conflicts, duplicates, version drift, zombie skills, and risks.
4. Do not delete files yet. First produce a repair plan and explain which skills would change.
5. Give recommendations for risk, duplicate, version_drift, governance, zombie, and description_quality findings.
```

The agent can use `fix` to generate targeted repair prompts:

```bash
npx agent-skill-doctor fix --lang en
npx agent-skill-doctor fix --type risk --severity high --lang en
npx agent-skill-doctor fix --type zombie --lang en
```

Default scan roots:

```text
~/.agent/skills
~/.agents/skills
~/.agents/skills-core
~/.codex/skills
~/.claude/skills
~/.cursor/skills
~/.opencode/skills
~/.config/opencode/skills
~/.qoder/skills
~/.qoder-cn/skills
~/.qoderwork/skills
~/.qoderworkcn/skills
~/.codebuddy/skills
~/.workbuddy/skills
~/.workbuddy/connectors/skills
~/.deepseek/skills
~/.deepseek-harness/skills
```

Agents such as DeepSeek Harness that reuse `~/.agents/skills` are discovered through that shared root. The default scan never treats the current working directory as a scan root; use `--root` explicitly when you want to scan a project or another specific directory. By default, only directories containing `SKILL.md` are recognized as skills; use `--full` to include README-only candidates.

By default, `governance` checks only project-local, central-library, or explicitly shareable/publishable skills, so third-party installations are not presented as items you need to govern. Use `--governance-all` for a full inventory. `zombie` requires explicit usage telemetry; missing telemetry alone is never treated as missing usage.

Scan a specific directory:

```bash
npx agent-skill-doctor diagnose --root ./my-skills --lang en
```

## Reproducible Demo

This repo includes a sanitized demo at `examples/readme-demo-skills`. It contains 5 small skills that trigger risk, conflict, duplicate, version drift, zombie, and description quality findings.

```bash
npm install
npm run start -- diagnose --root ./examples/readme-demo-skills --rebuild-index --lang en
```

Example output:

```text
Skills: 5
Findings: 15
Risk findings: 3
Conflict findings: 1
Zombie candidates: 5
```

The demo is intentionally small:

- `dangerous-deploy` triggers `rm -rf`, `.env`, and `curl` risk findings.
- `npm-installer` and `pnpm-installer` trigger package-manager conflict, same-source duplicate, and version drift findings.
- `markdown-reporter-a` and `markdown-reporter-b` trigger an exact duplicate finding.
- `Dangerous Deploy` has a short description, triggering description quality findings.

Generate targeted risk repair prompts:

```bash
npm run start -- fix --type risk --lang en
```

The real CLI output includes your local path. The example below is sanitized for documentation:

```text
Skill: dangerous-deploy (./examples/readme-demo-skills/dangerous-deploy)
- [critical] Possible destructive filesystem operation
- [high] Possible credential access
- [high] Possible remote download or installer execution
```

## HTML Reports And Language Switching

Generate a Chinese HTML report:

```bash
npm run start -- report --format html --lang zh --output ./reports/skill-doctor.zh.html
```

Generate an English HTML report:

```bash
npm run start -- report --format html --lang en --output ./reports/skill-doctor.en.html
```

HTML reports include:

- Scan overview and severity distribution
- Skill list and source details
- Findings grouped by type
- Remediation path
- Copyable agent prompts
- In-report language toggle

## Common Commands

```bash
# Scan and write the local diagnostic database
agent-skill-doctor scan --lang en

# Full diagnosis
agent-skill-doctor diagnose --lang en
agent-skill-doctor diagnose --json

# Inspect one finding type
agent-skill-doctor risks --json
agent-skill-doctor conflicts --json
agent-skill-doctor duplicates --json
agent-skill-doctor governance --json
agent-skill-doctor freshness --json
agent-skill-doctor zombies --json

# Only show high-confidence zombie candidates
agent-skill-doctor diagnose --json --min-confidence 0.8

# Raise the zombie score threshold to reduce low-activity noise
agent-skill-doctor diagnose --json --zombie-threshold 0.6

# Update detection with upstream verification
agent-skill-doctor diagnose --check-upstream --lang en

# Generate reports
agent-skill-doctor report --format md --lang en
agent-skill-doctor report --format json --output ./skill-report.json
agent-skill-doctor report --format html --lang en

# Generate repair prompts
agent-skill-doctor fix --lang en
agent-skill-doctor fix --type duplicate --lang en
agent-skill-doctor fix --type version_drift --lang en
agent-skill-doctor fix --type governance --lang en

# Fail CI by severity
agent-skill-doctor diagnose --ci --fail-on high

# Generate an optimization plan and dry-run it
agent-skill-doctor plan --safe --json --output ./plan.json
agent-skill-doctor apply ./plan.json --dry-run
```

## Data Directory

Default location:

```text
~/.agent-skill-doctor/
  doctor.db
  reports/
```

Override it with an environment variable:

```bash
AGENT_SKILL_DOCTOR_HOME=./.doctor-data agent-skill-doctor diagnose --lang en
```

PowerShell:

```powershell
$env:AGENT_SKILL_DOCTOR_HOME = ".\.doctor-data"
agent-skill-doctor diagnose --lang en
```

## Custom Risk Rules

```bash
agent-skill-doctor diagnose --rules ./rules/default --lang en
```

Rules are JSON files. See `rules/default/`.

## Node.js Library Usage

```js
const {
  detectDuplicateGroups,
  detectVersionDrift,
  detectConflicts,
  detectZombies,
  detectFreshnessFindings,
  scanSkillForRisks,
  loadJsonRules,
  DEFAULT_CONFLICT_RULES
} = require('agent-skill-doctor');
```

## Optional AI Explanations

The diagnostic core stays local by default. Generate explanations and next steps without network access:

```bash
agent-skill-doctor explain --lang en
agent-skill-doctor explain --finding-id <finding-id> --json
```

To use OrcaRouter, network access must be explicitly enabled:

```bash
export ORCAROUTER_API_KEY="your-key"
agent-skill-doctor explain \
  --provider orcarouter \
  --allow-network \
  --model orcarouter/auto \
  --lang en
```

Remote requests contain only redacted finding summaries, never complete skill files. Missing credentials, disabled network access, timeouts, or provider errors automatically fall back to local explanations.

Run an AI-assisted semantic review for risk findings:

```bash
agent-skill-doctor review --ai --type risk --lang en
```

Generate repair drafts for description, governance, and structure findings:

```bash
agent-skill-doctor fix --ai --type description_quality --lang en
agent-skill-doctor fix --ai --allow-network --provider orcarouter --output ./ai-fix-draft.json
```

`fix --ai` accepts only safe frontmatter field edits and prints a diff; it never edits skill files automatically. Without explicit network permission, local mode provides a conservative review prompt instead of inventing content.

## Safety Boundaries

- Does not write to `skills-manager.db`.
- Does not delete, move, or overwrite skill files by default.
- `apply` currently supports `--dry-run` only.
- Risk findings are not always bugs; they usually mean a skill needs elevated capability and should be explicitly reviewed.

## Troubleshooting

```bash
# Node version
node --version

# No global install permission
npx agent-skill-doctor diagnose --lang en

# Rebuild the diagnostic database
rm ~/.agent-skill-doctor/doctor.db
agent-skill-doctor diagnose --lang en
```

PowerShell:

```powershell
Remove-Item "$env:USERPROFILE\.agent-skill-doctor\doctor.db" -Force
agent-skill-doctor diagnose --lang en
```

## Links

- [GitHub](https://github.com/sljdxde/agent-skill-doctor)
- [npm](https://www.npmjs.com/package/agent-skill-doctor)
- [Changelog](./CHANGELOG.md)
- [License](./LICENSE)
