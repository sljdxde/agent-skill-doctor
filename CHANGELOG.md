# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-07-09

### Added
- Added `freshness` diagnostics to detect skills without an update channel, unpinned upstream refs, stale remote-backed copies, and older sibling versions.
- Added `agent-skill-doctor freshness --json` and `diagnose --check-upstream` for focused update checks and optional online upstream verification.
- Added `freshness` summary cards and remediation guidance to Markdown, JSON, and HTML reports.
- Exported `detectFreshnessFindings`, `parseVersion`, `compareVersions`, and `isGitUrl` for Node.js usage.

### Fixed
- Fixed HTML report generation so remediation-path rendering no longer throws when update-detection content is present.

### Documentation
- Updated Chinese and English READMEs with freshness checks, upstream verification commands, and library exports.

## [0.3.0] - 2026-07-07

### Added
- Added `governance` registry readiness diagnostics for owner, version, lifecycle status, release label, and trusted source metadata.
- Added `agent-skill-doctor governance --json` for focused governance findings.
- Added governance findings to diagnose summaries, Markdown reports, JSON reports, and HTML dashboard cards.
- Added targeted `fix --type governance` guide text in English and Chinese.

### Documentation
- Documented governance checks and CLI examples in English and Chinese READMEs.

## [0.1.0] - 2026-06-08

### Added
- Initial npm package release
- CLI with scan, diagnose, report, duplicates, risks, conflicts, zombies, plan, apply commands
- Library API for programmatic usage
- Zero external dependencies
- SQLite-based local database
- Configurable risk rules
- CI/CD support with exit codes
- Examples directory with basic usage example
- Comprehensive README with installation, usage, and API documentation

### Features
- **Scan** local skill directories and build SQLite database
- **Diagnose** skills for quality issues, duplicates, drift, risks, conflicts, and zombies
- **Plan** safe optimization actions with expected state validation
- **Apply** changes with dry-run safety checks
- **Report** in Markdown or JSON format
- **CI support** with exit codes for automated workflows

### Technical Details
- Node.js >= 22.5.0 (uses experimental `node:sqlite` module)
- CommonJS module system
- No external dependencies
- MIT License
