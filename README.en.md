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

1. Run: npx agent-skill-doctor diagnose --lang en
2. Generate an HTML report: npx agent-skill-doctor report --format html --lang en
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
```

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
agent-skill-doctor zombies --json

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
  scanSkillForRisks,
  loadJsonRules,
  DEFAULT_CONFLICT_RULES
} = require('agent-skill-doctor');
```

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
