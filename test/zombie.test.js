'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeZombieScore, zombieLevel, detectZombies, descriptionQuality } = require('../src/doctor/zombie');

function skill(overrides) {
  return {
    id: overrides.id,
    slug: overrides.slug || overrides.id,
    name: overrides.name || overrides.id,
    description: overrides.description || '',
    source: overrides.source || { type: 'unknown' },
    location: overrides.location || { path: `/tmp/${overrides.id}`, root: '/tmp', rootType: 'unknown' },
    hashes: { contentSha256: overrides.hash || overrides.id, normalizedTextSha256: overrides.hash || overrides.id },
    tags: overrides.tags || [],
    usage: overrides.usage || {
      installedInAgents: [],
      installedInProjects: [],
      presetCount: 0,
      hasRecentModification: false,
      lastActivityLogAt: null,
      manuallyPinned: false,
    },
    modifiedAt: overrides.modifiedAt || '2026-01-01T00:00:00.000Z',
  };
}

test('pinned skill returns zombie score 0', () => {
  const s = skill({ id: 'a', usage: { manuallyPinned: true, presetCount: 0, installedInAgents: [], installedInProjects: [], hasRecentModification: false } });
  assert.equal(computeZombieScore(s), 0.0);
});

test('skill with keep tag returns zombie score 0', () => {
  const s = skill({ id: 'a', tags: ['keep'] });
  assert.equal(computeZombieScore(s), 0.0);
});

test('skill with core tag returns zombie score 0', () => {
  const s = skill({ id: 'a', tags: ['core'] });
  assert.equal(computeZombieScore(s), 0.0);
});

test('skill with system tag returns zombie score 0', () => {
  const s = skill({ id: 'a', tags: ['system'] });
  assert.equal(computeZombieScore(s), 0.0);
});

test('completely unused skill gets high zombie score', () => {
  const s = skill({ id: 'a', description: '' });
  const score = computeZombieScore(s);
  assert.ok(score >= 0.8, `Expected score >= 0.8, got ${score}`);
  assert.equal(zombieLevel(score), 'strong_suspicious_zombie');
});

test('skill in preset and agent gets low zombie score', () => {
  const s = skill({
    id: 'a',
    description: 'A useful skill for code review when reviewing PRs',
    usage: {
      presetCount: 1,
      installedInAgents: ['claude'],
      installedInProjects: ['proj1'],
      hasRecentModification: true,
      lastActivityLogAt: '2026-06-01T00:00:00.000Z',
      manuallyPinned: false,
    },
  });
  const score = computeZombieScore(s);
  assert.ok(score < 0.4, `Expected score < 0.4, got ${score}`);
  assert.equal(zombieLevel(score), 'normal');
});

test('zombie level thresholds are correct', () => {
  assert.equal(zombieLevel(0.0), 'normal');
  assert.equal(zombieLevel(0.3), 'normal');
  assert.equal(zombieLevel(0.4), 'low_activity');
  assert.equal(zombieLevel(0.5), 'low_activity');
  assert.equal(zombieLevel(0.6), 'suspicious_zombie');
  assert.equal(zombieLevel(0.7), 'suspicious_zombie');
  assert.equal(zombieLevel(0.8), 'strong_suspicious_zombie');
  assert.equal(zombieLevel(1.0), 'strong_suspicious_zombie');
});

test('detectZombies returns findings for unused skills', () => {
  const unused = skill({ id: 'unused', description: '' });
  const used = skill({
    id: 'used',
    description: 'A useful skill for code review when reviewing PRs and generating results',
    usage: { presetCount: 2, installedInAgents: ['claude'], installedInProjects: ['p1'], hasRecentModification: true, lastActivityLogAt: '2026-06-01', manuallyPinned: false },
  });
  const findings = detectZombies([unused, used]);
  assert.ok(findings.length >= 1);
  assert.equal(findings[0].type, 'zombie');
  assert.equal(findings[0].links[0].role, 'primary');
});

test('descriptionQuality returns 0 for empty description', () => {
  assert.equal(descriptionQuality({ description: '' }), 0);
  assert.equal(descriptionQuality({}), 0);
});

test('descriptionQuality returns higher score for rich description', () => {
  const poor = descriptionQuality({ description: 'tool' });
  const good = descriptionQuality({ description: 'Use this skill when reviewing code to detect bugs. Returns a list of issues found. Run it on pull requests.' });
  assert.ok(good > poor, `Expected good (${good}) > poor (${poor})`);
});

test('detectZombies findings are sorted by score descending', () => {
  const a = skill({ id: 'a', description: '' });
  const b = skill({
    id: 'b',
    description: 'Some description',
    usage: { presetCount: 0, installedInAgents: [], installedInProjects: [], hasRecentModification: false, manuallyPinned: false },
  });
  const findings = detectZombies([a, b]);
  if (findings.length >= 2) {
    assert.ok((findings[0].score || 0) >= (findings[1].score || 0));
  }
});
