# agent-skill-doctor

[![npm version](https://badge.fury.io/js/agent-skill-doctor.svg)](https://www.npmjs.com/package/agent-skill-doctor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.5.0-brightgreen.svg)](https://nodejs.org/)

Agent Skill Doctor is a diagnostic and governance tool for AI agent skills.

## Features

- **Scan** local skill directories and build SQLite database
- **Diagnose** skills for quality issues, duplicates, drift, risks, conflicts, and zombies
- **Plan** safe optimization actions with expected state validation
- **Apply** changes with dry-run safety checks
- **Report** in Markdown or JSON format
- **CI support** with exit codes for automated workflows

## Requirements

- Node.js >= 22.5.0 (uses experimental `node:sqlite` module)
- No external dependencies (zero-dependency package)

## Project Structure

```
agent-skill-doctor/
├── bin/                    # CLI entry points
│   ├── agent-skill-doctor.js          # Main CLI
│   ├── agent-skill-doctor-phase2.js   # Phase 2 analysis
│   ├── agent-skill-doctor-phase3.js   # Phase 3 conflicts
│   └── agent-skill-doctor-risk.js     # Risk scanning
├── src/doctor/             # Core library modules
│   ├── index.js            # Main exports
│   ├── phase2.js           # Duplicate/drift detection
│   ├── conflict.js         # Conflict detection
│   ├── zombie.js           # Zombie detection
│   ├── risk-lite.js        # Risk scanning
│   └── rules.js            # Rules and utilities
├── rules/default/          # Default risk rules
│   ├── credential-risk.json
│   ├── destructive-risk.json
│   └── shell-network-risk.json
├── test/                   # Test files
├── docs/                   # Documentation
└── package.json            # Package configuration
```

## Common Use Cases

### Quick Health Check

```bash
# Scan and get a quick diagnosis
agent-skill-doctor scan
agent-skill-doctor diagnose --json
```

### CI/CD Integration

```bash
# Fail pipeline on high-risk findings
agent-skill-doctor diagnose --ci --fail-on high

# Generate report for artifacts
agent-skill-doctor report --format json --output ./skill-report.json
```

### Find and Clean Up Duplicates

```bash
# List all duplicates
agent-skill-doctor duplicates

# Generate optimization plan
agent-skill-doctor plan --safe --json --output ./cleanup-plan.json

# Preview changes (dry-run)
agent-skill-doctor apply ./cleanup-plan.json --dry-run
```

## Installation

### Via npm (recommended)

```bash
npm install -g agent-skill-doctor
```

### From source

```bash
git clone https://github.com/anthropics/agent-skill-doctor.git
cd agent-skill-doctor
npm link
```

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

### Global installation

After installing via npm:

```bash
# Scan and diagnose
agent-skill-doctor scan --json
agent-skill-doctor diagnose --json
agent-skill-doctor report --format md --output ./skill-doctor-report.md
agent-skill-doctor ignored list

# Scan a specific root
agent-skill-doctor scan --root ~/.skills-manager/skills --json

# Ignore a finding
agent-skill-doctor ignore <finding-id> --reason "false positive"
agent-skill-doctor unignore <finding-id>
```

### Local development

If running from source:

```bash
node ./bin/agent-skill-doctor.js scan --json
node ./bin/agent-skill-doctor.js diagnose --json
node ./bin/agent-skill-doctor.js report --format md --output ./skill-doctor-report.md
node ./bin/agent-skill-doctor.js ignored list
```

## Phase 2 duplicate and drift analysis

`diagnose` runs duplicate and drift analysis automatically. The older Phase 2 overlay is still available for focused debugging:

```bash
# Global installation
agent-skill-doctor scan --root ~/.skills-manager/skills
agent-skill-doctor phase2 analyze --json
agent-skill-doctor phase2 duplicates
agent-skill-doctor phase2 drift

# Local development
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
# Global installation
agent-skill-doctor diagnose --ci --fail-on high
agent-skill-doctor duplicates
agent-skill-doctor risks
agent-skill-doctor conflicts
agent-skill-doctor zombies
agent-skill-doctor plan --safe --json --output ./plan.json
agent-skill-doctor apply ./plan.json --dry-run

# Local development
node ./bin/agent-skill-doctor.js diagnose --ci --fail-on high
node ./bin/agent-skill-doctor.js duplicates
node ./bin/agent-skill-doctor.js risks
node ./bin/agent-skill-doctor.js conflicts
node ./bin/agent-skill-doctor.js zombies
node ./bin/agent-skill-doctor.js plan --safe --json --output ./plan.json
node ./bin/agent-skill-doctor.js apply ./plan.json --dry-run
```

`apply` is intentionally limited to `--dry-run` in this MVP. It recomputes target content hashes and marks changed actions as `stale_action`.

## Configuration

### Data Directory

Default location:

```text
~/.agent-skill-doctor/
  doctor.db
  reports/
```

Override with environment variable:

```bash
# Global installation
AGENT_SKILL_DOCTOR_HOME=/tmp/asd agent-skill-doctor scan

# Local development
AGENT_SKILL_DOCTOR_HOME=/tmp/asd node ./bin/agent-skill-doctor.js scan
```

### Custom Risk Rules

You can provide custom risk rules directory:

```bash
agent-skill-doctor diagnose --rules ./my-custom-rules
```

Rules should be JSON files following the format in `rules/default/`.

## Library Usage

You can also use agent-skill-doctor as a Node.js library:

```javascript
const { 
  detectDuplicateGroups, 
  detectVersionDrift, 
  detectConflicts, 
  detectZombies, 
  scanSkillForRisks 
} = require('agent-skill-doctor');

// Or import specific modules
const phase2 = require('agent-skill-doctor/phase2');
const conflict = require('agent-skill-doctor/conflict');
const zombie = require('agent-skill-doctor/zombie');
const risk = require('agent-skill-doctor/risk');
const rules = require('agent-skill-doctor/rules');
```

### API Reference

#### Phase 2 - Duplicate and Drift Detection

```javascript
const { detectDuplicateGroups, detectVersionDrift } = require('agent-skill-doctor');

// Detect duplicates
const duplicates = detectDuplicateGroups(skills);
// Returns: Array of duplicate groups with type (exact, same-source, same-name)

// Detect version drift
const drift = detectVersionDrift(skills);
// Returns: Array of version drift findings
```

#### Conflict Detection

```javascript
const { detectConflicts, DEFAULT_CONFLICT_RULES } = require('agent-skill-doctor');

// Detect conflicts between skills
const conflicts = detectConflicts(skills, DEFAULT_CONFLICT_RULES);
// Returns: Array of conflicts (e.g., competing package managers)
```

#### Zombie Detection

```javascript
const { detectZombies, computeZombieScore } = require('agent-skill-doctor');

// Detect zombie candidates
const zombies = detectZombies(skills);
// Returns: Array of zombie findings sorted by score

// Compute individual zombie score
const score = computeZombieScore(skill);
// Returns: Number 0-100 (higher = more likely zombie)
```

#### Risk Scanning

```javascript
const { scanSkillForRisks, loadJsonRules } = require('agent-skill-doctor');

// Load default rules
const rules = loadJsonRules('./rules/default');

// Scan skill for risks
const risks = scanSkillForRisks(skill, rules);
// Returns: Array of risk findings with severity levels
```

## Safety

This implementation never writes to `skills-manager.db` and never deletes or overwrites skill files. Any future write operation must go through a dry-run plan and expected-state validation first.

## Publishing to npm

To publish this package to npm:

```bash
# Login to npm
npm login

# Publish the package
npm publish
```

To publish as a scoped package (e.g., @your-username/agent-skill-doctor):

```bash
npm publish --access public
```

Or use the provided script:

```bash
./scripts/publish.sh 0.1.0
```

## Examples

### Basic Library Usage

```javascript
const {
  detectDuplicateGroups,
  detectVersionDrift,
  detectConflicts,
  detectZombies,
  scanSkillForRisks,
  loadJsonRules,
  DEFAULT_CONFLICT_RULES
} = require('agent-skill-doctor');

// Analyze your skills
const duplicates = detectDuplicateGroups(skills);
const drift = detectVersionDrift(skills);
const conflicts = detectConflicts(skills, DEFAULT_CONFLICT_RULES);
const zombies = detectZombies(skills);

// Load risk rules and scan
const rules = loadJsonRules('./rules/default');
const risks = scanSkillForRisks(skills[0], rules);
```

See `examples/basic-usage.js` for a complete working example.

## Troubleshooting

### Node.js Version Error

If you see "ExperimentalWarning: SQLite is an experimental feature":

```bash
# Check your Node.js version
node --version

# Should be >= 22.5.0
# Update Node.js if needed: https://nodejs.org/
```

### Permission Errors on Global Install

```bash
# Use npx instead of global install
npx agent-skill-doctor scan

# Or fix npm permissions
# See: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally
```

### Database Locked Errors

If you get database locked errors:

```bash
# Remove the database and rescan
rm ~/.agent-skill-doctor/doctor.db
agent-skill-doctor scan
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a detailed history of changes.

### v0.1.0 (Current)
- Initial npm package release
- CLI with scan, diagnose, report, duplicates, risks, conflicts, zombies, plan, apply commands
- Library API for programmatic usage
- Zero external dependencies
- SQLite-based local database
- Configurable risk rules
- CI/CD support with exit codes

## Links

- [GitHub Repository](https://github.com/anthropics/agent-skill-doctor)
- [npm Package](https://www.npmjs.com/package/agent-skill-doctor)
- [Issue Tracker](https://github.com/anthropics/agent-skill-doctor/issues)
- [Design Documentation](docs/DESIGN-PHASE1.md)
- [Changelog](CHANGELOG.md)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `npm test`
5. Submit a pull request

## License

MIT License - see LICENSE file for details.
