# agent-skill-doctor

Agent Skill Doctor is a diagnostic and governance tool for AI agent skills.

This repository currently contains a safe Phase 1 foundation plus a Phase 2 overlay:

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

It intentionally does **not** implement risk rule scanning, conflict detection, zombie detection, delete, overwrite, force sync, or direct writes to `skills-manager.db` yet.

## Requirements

Node.js >= 22.5.0. This prototype uses Node's built-in `node:sqlite` module, which is experimental in Node 22.

## Quick start

Phase 1 scan and report:

```bash
node ./bin/agent-skill-doctor.js scan --json
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

Run Phase 1 scan first, then run the Phase 2 overlay against `doctor.db`:

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

This implementation never writes to `skills-manager.db` and never deletes or overwrites skill files.
