# Phase 1 Implementation Notes

This scaffold implements the Phase 1 foundation from the final design:

- `doctor.db` with `skill_records`, `findings`, `finding_skills`, `doctor_runs`
- `scan` and `scan --full` command shape
- stable skill identity key
- stable participant identity key
- stable finding ID separated from occurrence ID
- `Evidence.anchor` not based on line numbers
- `ignore`, `unignore`, `ignored list`
- Markdown and JSON reports

Important boundaries:

- No direct writes to `skills-manager.db`
- No delete / overwrite / force sync
- No rule-based risk scanning in Phase 1
- No duplicate / version drift detection yet
- No `--allow-stale`

This is a standalone Node 22 prototype so it can be reviewed and integrated before porting into the Tauri/Rust core.
