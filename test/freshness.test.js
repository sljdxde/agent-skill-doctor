'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectFreshnessFindings, parseVersion, compareVersions, isGitUrl } = require('../src/doctor/freshness');

function skill(overrides = {}) {
  return {
    id: overrides.id || 'skill-1',
    slug: overrides.slug || 'doc-format',
    name: overrides.name || 'Doc Format',
    description: overrides.description || 'Use this skill when writing docs.',
    source: overrides.source || { type: 'unknown', url: null },
    location: overrides.location || { path: '/tmp/doc-format', rootType: 'agent_global' },
    version: overrides.version || null,
    sourceRef: overrides.sourceRef || null,
    sourceCommit: overrides.sourceCommit || null,
    modifiedAt: overrides.modifiedAt || null,
    hashes: { contentSha256: overrides.hash || 'hash-1' },
    tags: overrides.tags || [],
    frontmatter: overrides.frontmatter || {},
  };
}

// --- Version parsing tests ---

test('parseVersion parses standard semver', () => {
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('1.2'), [1, 2, 0]);
  assert.deepEqual(parseVersion('1'), [1, 0, 0]);
  assert.deepEqual(parseVersion('1.2.3-beta'), [1, 2, 3]);
});

test('parseVersion returns null for non-version strings', () => {
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(null), null);
  assert.equal(parseVersion('abc'), null);
});

test('compareVersions works correctly', () => {
  assert.ok(compareVersions('1.2.3', '1.2.2') > 0);
  assert.ok(compareVersions('1.3.0', '1.2.9') > 0);
  assert.ok(compareVersions('2.0.0', '1.9.9') > 0);
  assert.ok(compareVersions('1.0.0', '1.0.0') === 0);
  assert.ok(compareVersions('1.0.0', '2.0.0') < 0);
  assert.equal(compareVersions('latest', '1.0.0'), 0); // unparseable → 0
});

// --- isGitUrl tests ---

test('isGitUrl detects GitHub URLs', () => {
  assert.ok(isGitUrl('https://github.com/foo/bar'));
  assert.ok(isGitUrl('https://gitlab.com/foo/bar'));
  assert.ok(isGitUrl('https://gitee.com/foo/bar'));
  assert.ok(isGitUrl('git@github.com:foo/bar.git'));
  assert.ok(isGitUrl('https://github.com/foo/bar.git'));
  assert.ok(!isGitUrl('https://example.com/foo'));
  assert.ok(!isGitUrl(null));
  assert.ok(!isGitUrl(''));
});

// --- Offline signal tests ---

test('no-update-channel: skill without source URL triggers medium finding', () => {
  const findings = detectFreshnessFindings([skill()]);
  const ruleIds = findings.map(f => f.ruleId);
  assert.ok(ruleIds.includes('no-update-channel'));
  const finding = findings.find(f => f.ruleId === 'no-update-channel');
  assert.equal(finding.severity, 'medium');
  assert.equal(finding.type, 'freshness');
  assert.equal(finding.detectorId, 'freshness-detector');
  assert.equal(finding.links[0].role, 'primary');
});

test('no-update-channel: unknown source type triggers finding', () => {
  const findings = detectFreshnessFindings([
    skill({ source: { type: 'unknown', url: null } }),
  ]);
  assert.ok(findings.some(f => f.ruleId === 'no-update-channel'));
});

test('skill with git source URL does NOT trigger no-update-channel', () => {
  const findings = detectFreshnessFindings([
    skill({ source: { type: 'git', url: 'https://github.com/foo/bar' }, sourceRef: 'v1.0.0', sourceCommit: 'abc123' }),
  ]);
  assert.ok(!findings.some(f => f.ruleId === 'no-update-channel'));
});

test('unpinned-source: git URL without ref or commit triggers finding', () => {
  const findings = detectFreshnessFindings([
    skill({ source: { type: 'git', url: 'https://github.com/foo/bar' } }),
  ]);
  assert.ok(findings.some(f => f.ruleId === 'unpinned-source'));
  const finding = findings.find(f => f.ruleId === 'unpinned-source');
  assert.equal(finding.severity, 'low');
});

test('unpinned-source: git URL with ref does NOT trigger finding', () => {
  const findings = detectFreshnessFindings([
    skill({ source: { type: 'git', url: 'https://github.com/foo/bar' }, sourceRef: 'v1.0.0' }),
  ]);
  assert.ok(!findings.some(f => f.ruleId === 'unpinned-source'));
});

test('unpinned-source: git URL with commit does NOT trigger finding', () => {
  const findings = detectFreshnessFindings([
    skill({ source: { type: 'git', url: 'https://github.com/foo/bar' }, sourceCommit: 'abc123def456' }),
  ]);
  assert.ok(!findings.some(f => f.ruleId === 'unpinned-source'));
});

test('stale-by-age: skill modified >180 days ago with remote source triggers finding', () => {
  const oldDate = new Date(Date.now() - 200 * 86_400_000).toISOString();
  const findings = detectFreshnessFindings([
    skill({
      source: { type: 'git', url: 'https://github.com/foo/bar' },
      sourceRef: 'v1.0.0',
      modifiedAt: oldDate,
    }),
  ]);
  assert.ok(findings.some(f => f.ruleId === 'stale-by-age'));
});

test('stale-by-age: recently modified skill does NOT trigger finding', () => {
  const recentDate = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const findings = detectFreshnessFindings([
    skill({
      source: { type: 'git', url: 'https://github.com/foo/bar' },
      sourceRef: 'v1.0.0',
      modifiedAt: recentDate,
    }),
  ]);
  assert.ok(!findings.some(f => f.ruleId === 'stale-by-age'));
});

test('stale-by-age: old skill without remote source does NOT trigger finding', () => {
  const oldDate = new Date(Date.now() - 200 * 86_400_000).toISOString();
  // no-update-channel will trigger instead, and continue skips stale-by-age
  const findings = detectFreshnessFindings([
    skill({ source: { type: 'unknown', url: null }, modifiedAt: oldDate }),
  ]);
  assert.ok(!findings.some(f => f.ruleId === 'stale-by-age'));
});

test('version-lower-than-sibling: lower version triggers finding', () => {
  const skills = [
    skill({
      id: 'a', slug: 'doc-format-a',
      source: { type: 'git', url: 'https://github.com/foo/bar' },
      sourceRef: 'v1.0.0', version: '1.0.0',
    }),
    skill({
      id: 'b', slug: 'doc-format-b',
      source: { type: 'git', url: 'https://github.com/foo/bar' },
      sourceRef: 'v2.0.0', version: '2.0.0',
    }),
  ];
  const findings = detectFreshnessFindings(skills);
  const siblingFindings = findings.filter(f => f.ruleId === 'version-lower-than-sibling');
  assert.ok(siblingFindings.length >= 1);
  assert.ok(siblingFindings.some(f => f.description.includes('1.0.0')));
});

test('version-lower-than-sibling: same version does NOT trigger finding', () => {
  const skills = [
    skill({
      id: 'a', slug: 'doc-format-a',
      source: { type: 'git', url: 'https://github.com/foo/bar' },
      sourceRef: 'v1.0.0', version: '1.0.0',
    }),
    skill({
      id: 'b', slug: 'doc-format-b',
      source: { type: 'git', url: 'https://github.com/foo/bar' },
      sourceRef: 'v1.0.0', version: '1.0.0',
    }),
  ];
  const findings = detectFreshnessFindings(skills);
  assert.ok(!findings.some(f => f.ruleId === 'version-lower-than-sibling'));
});

test('builtin skills are skipped entirely', () => {
  const findings = detectFreshnessFindings([
    skill({ source: { type: 'builtin', url: null } }),
  ]);
  assert.equal(findings.length, 0);
});

test('findings are sorted by severity (medium before low)', () => {
  const findings = detectFreshnessFindings([
    skill({ id: 'no-source', slug: 'no-source' }),  // no-update-channel (medium)
    skill({
      id: 'unpinned', slug: 'unpinned',
      source: { type: 'git', url: 'https://github.com/foo/bar' },
    }), // unpinned-source (low)
  ]);
  const severities = findings.map(f => f.severity);
  const firstLowIdx = severities.indexOf('low');
  const firstMediumIdx = severities.indexOf('medium');
  if (firstLowIdx >= 0 && firstMediumIdx >= 0) {
    assert.ok(firstMediumIdx < firstLowIdx, 'medium findings should come before low');
  }
});

test('multiple findings can be generated for a single skill', () => {
  const oldDate = new Date(Date.now() - 200 * 86_400_000).toISOString();
  const findings = detectFreshnessFindings([
    skill({
      source: { type: 'git', url: 'https://github.com/foo/bar' },
      modifiedAt: oldDate,
      // no ref, no commit → unpinned-source
      // old date + remote → stale-by-age
    }),
  ]);
  const ruleIds = findings.map(f => f.ruleId);
  assert.ok(ruleIds.includes('unpinned-source'));
  assert.ok(ruleIds.includes('stale-by-age'));
});

test('checkUpstream does not crash when git is unavailable or URL is invalid', () => {
  // Using a fake URL that will fail — should not throw
  const findings = detectFreshnessFindings([
    skill({
      source: { type: 'git', url: 'https://github.com/nonexistent/fake-repo-12345' },
      sourceRef: 'v1.0.0',
      sourceCommit: 'a'.repeat(40),
    }),
  ], { checkUpstream: true });
  // Should still produce offline findings, just no pinned-ref-behind
  assert.ok(findings.every(f => f.ruleId !== 'pinned-ref-behind'));
});
