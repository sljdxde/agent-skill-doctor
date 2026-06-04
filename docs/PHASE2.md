# Phase 2: Duplicate and Version Drift Detection

Phase 2 adds the detector core for duplicate groups and version drift findings.

Implemented module:

```text
src/doctor/phase2.js
```

Implemented tests:

```text
test/phase2.test.js
```

## Capabilities

- Stable participant identity key for multi-skill findings
- Order-independent duplicate / drift IDs
- Canonical skill selection
- Exact duplicate detection by content hash
- Same-source duplicate detection
- Same-name duplicate detection
- Version drift detection by same source or same slug with different hash/ref

## Exported functions

```js
buildSkillIdentityKey(skill)
buildParticipantIdentityKey(skills)
chooseCanonical(skills)
detectDuplicateGroups(skills)
detectVersionDrift(skills)
normalizeSourceUrl(url)
sourceKey(skill)
```

## Notes

The module is intentionally pure and does not write to `skills-manager.db` or perform any file operations. It can be wired into the current single-file CLI or migrated into the future Rust/Tauri core.

## Test

```bash
node --test
```
