'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildParticipantIdentityKey,
  detectDuplicateGroups,
  detectVersionDrift,
} = require('../src/doctor/phase2');

function skill(overrides) {
  return {
    id: overrides.id,
    slug: overrides.slug,
    name: overrides.slug,
    source: overrides.source || { type: 'unknown' },
    location: overrides.location || { path: `/tmp/${overrides.id}`, root: '/tmp', rootType: 'unknown' },
    hashes: { contentSha256: overrides.hash || overrides.id, normalizedTextSha256: overrides.hash || overrides.id },
    sourceRef: overrides.sourceRef || null,
    modifiedAt: overrides.modifiedAt || '2026-01-01T00:00:00.000Z',
  };
}

test('participant identity is order independent', () => {
  const a = skill({ id: 'a', slug: 'alpha', hash: 'h1' });
  const b = skill({ id: 'b', slug: 'beta', hash: 'h2' });
  assert.equal(buildParticipantIdentityKey([a, b]), buildParticipantIdentityKey([b, a]));
});

test('detects exact duplicates by content hash', () => {
  const a = skill({ id: 'a', slug: 'alpha', hash: 'same' });
  const b = skill({ id: 'b', slug: 'beta', hash: 'same' });
  const groups = detectDuplicateGroups([a, b]);
  assert.equal(groups.some(g => g.strategy === 'exact_duplicate'), true);
});

test('detects same source duplicates', () => {
  const source = { type: 'git', url: 'https://github.com/example/skill.git', subdir: 'x' };
  const a = skill({ id: 'a', slug: 'alpha', hash: 'h1', source });
  const b = skill({ id: 'b', slug: 'alpha', hash: 'h2', source });
  const groups = detectDuplicateGroups([a, b]);
  assert.equal(groups.some(g => g.strategy === 'same_source_duplicate'), true);
});

test('detects version drift by same slug and different hashes', () => {
  const a = skill({ id: 'a', slug: 'alpha', hash: 'h1' });
  const b = skill({ id: 'b', slug: 'alpha', hash: 'h2' });
  const findings = detectVersionDrift([a, b]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, 'version_drift');
});
