# agent-skill-doctor

Agent Skill Doctor is a diagnostic and governance tool for AI agent skills.

This repository currently contains a safe CLI foundation for scanning and diagnosing agent skills:

- scan local skill directories
- build `doctor.db` with SQLite
- compute stable skill/content hashes
- create stable finding IDs that do not depend on line numbers
- store `findings` + `finding_skills`
- detect scan warnings and description quality issues
- support ignore / unignore
- export Markdown / JSON reports
- detect exact / same-source / same-name duplicate groups
- detect basic version drift by content hash or source ref
- scan rule-based risks
- detect basic conflicts
- detect low-activity / suspected zombie candidates
- generate safe optimization plans with expected state
- dry-run apply with stale action checks
- support CI exit codes

## Requirements

Node.js >= 22.5.0. This prototype uses Node's built-in `node:sqlite` module, which is experimental in Node 22.

## Quick start

Phase 1 scan and report:

```bash
node ./bin/agent-skill-doctor.js scan --json
node ./bin/agent-skill-doctor.js diagnose --json
node ./bin/agent-skill-doctor.js report --format md --output ./skill-doctor-report.md
node ./bin/agent-skill-doctor.js ignored list
```

Scan a specific root:

```bash
node ./bin/agent-skill-doctor.js scan --root ~/.skills-manager/skills --json
```

Ignore a finding:

```bash
node ./bin/agent-skill-doctor.js ignore <finding-id> --reason "false positive"
node ./bin/agent-skill-doctor.js unignore <finding-id>
```

## Phase 2 duplicate and drift analysis

`diagnose` runs duplicate and drift analysis automatically. The older Phase 2 overlay is still available for focused debugging:

```bash
node ./bin/agent-skill-doctor.js scan --root ~/.skills-manager/skills
node ./bin/agent-skill-doctor-phase2.js analyze --json
node ./bin/agent-skill-doctor-phase2.js duplicates
node ./bin/agent-skill-doctor-phase2.js drift
```

Phase 2 writes only to Agent Skill Doctor's own database tables:

```text
duplicate_groups
duplicate_group_members
findings
finding_skills
```

It does not write to `skills-manager.db` and does not modify skill files.

## Risk, conflict, zombie, and plans

```bash
node ./bin/agent-skill-doctor.js diagnose --ci --fail-on high
node ./bin/agent-skill-doctor.js duplicates
node ./bin/agent-skill-doctor.js risks
node ./bin/agent-skill-doctor.js conflicts
node ./bin/agent-skill-doctor.js zombies
node ./bin/agent-skill-doctor.js plan --safe --json --output ./plan.json
node ./bin/agent-skill-doctor.js apply ./plan.json --dry-run
```

`apply` is intentionally limited to `--dry-run` in this MVP. It recomputes target content hashes and marks changed actions as `stale_action`.

## Data directory

Default:

```text
~/.agent-skill-doctor/
  doctor.db
  reports/
```

Override:

```bash
AGENT_SKILL_DOCTOR_HOME=/tmp/asd node ./bin/agent-skill-doctor.js scan
```

## Safety

This implementation never writes to `skills-manager.db` and never deletes or overwrites skill files. Any future write operation must go through a dry-run plan and expected-state validation first.
