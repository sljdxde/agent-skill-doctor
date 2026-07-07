'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectGovernanceFindings } = require('../src/doctor/governance');

function skill(overrides = {}) {
  return {
    id: overrides.id || 'skill-1',
    slug: overrides.slug || 'doc-format',
    name: overrides.name || 'Doc Format',
    description: overrides.description || 'Use this skill when writing docs and generate structured output.',
    source: overrides.source || { type: 'unknown', url: null },
    location: overrides.location || { path: '/tmp/doc-format', rootType: 'agent_global' },
    version: overrides.version || null,
    status: overrides.status || 'active',
    tags: overrides.tags || [],
    frontmatter: overrides.frontmatter || {},
    hashes: { contentSha256: overrides.hash || 'hash-1' },
  };
}

test('detectGovernanceFindings reports missing registry readiness metadata', () => {
  const findings = detectGovernanceFindings([skill()]);
  const rules = findings.map(f => f.ruleId).sort();

  assert.deepEqual(rules, [
    'missing-governance-label',
    'missing-lifecycle-status',
    'missing-owner',
    'missing-source',
    'missing-version',
  ]);
  assert.ok(findings.every(f => f.type === 'governance'));
  assert.ok(findings.every(f => f.links[0].role === 'primary'));
});

test('detectGovernanceFindings accepts skills with owner, version, lifecycle label, and source', () => {
  const findings = detectGovernanceFindings([
    skill({
      source: { type: 'git', url: 'https://github.com/example/doc-format' },
      version: '1.2.0',
      tags: ['stable'],
      frontmatter: {
        owner: 'docs-platform',
        lifecycle: 'online',
      },
    }),
  ]);

  assert.equal(findings.length, 0);
});
