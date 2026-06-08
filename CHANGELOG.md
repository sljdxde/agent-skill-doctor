# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
