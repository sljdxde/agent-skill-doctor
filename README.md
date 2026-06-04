# agent-skill-doctor

Agent Skill Doctor is a diagnostic and governance tool for AI agent skills.

This Phase 1 implementation focuses on the safe foundation:

- scan local skill directories
- build `doctor.db` with SQLite
- compute stable skill/content hashes
- create stable finding IDs that do not depend on line numbers
- store `findings` + `finding_skills`
- detect scan warnings and description quality issues
- support ignore / unignore
- export Markdown / JSON reports

It intentionally does **not** implement risk rule scanning, duplicate detection, version drift, conflict detection, zombie detection, or write-back actions yet.

## Requirements

Node.js >= 22.5.0. This prototype uses Node's built-in `node:sqlite` module, which is experimental in Node 22.

## Quick start

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
