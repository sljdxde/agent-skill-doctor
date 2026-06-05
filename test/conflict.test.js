'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectConflicts, matchAlternative, skillTextContent } = require('../src/doctor/conflict');

function skill(overrides) {
  return {
    id: overrides.id,
    slug: overrides.slug || overrides.id,
    name: overrides.name || overrides.id,
    description: overrides.description || '',
    source: overrides.source || { type: 'unknown' },
    location: overrides.location || { path: `/tmp/${overrides.id}`, root: '/tmp', rootType: 'unknown' },
    hashes: { contentSha256: overrides.hash || overrides.id, normalizedTextSha256: overrides.hash || overrides.id },
    frontmatter: overrides.frontmatter || {},
    _scan: overrides._scan || {},
    modifiedAt: overrides.modifiedAt || '2026-01-01T00:00:00.000Z',
  };
}

const PM_RULE = {
  id: 'package-manager-conflict',
  type: 'opposite_instruction',
  severity: 'medium',
  title: 'Conflicting package manager instructions',
  alternatives: [['use npm', 'npm install'], ['use pnpm', 'pnpm install'], ['use yarn', 'yarn install']],
  recommendation: 'Keep only one package-manager convention skill per project or preset.',
};

const OUTPUT_RULE = {
  id: 'output-format-conflict',
  type: 'output_format_conflict',
  severity: 'medium',
  title: 'Conflicting output format instructions',
  alternatives: [['respond in json', 'output json only'], ['respond in markdown', 'output markdown only']],
  recommendation: 'Scope output-format skills to specific projects or presets.',
};

test('matchAlternative returns correct index', () => {
  assert.equal(matchAlternative('always use pnpm for installing', PM_RULE.alternatives), 1);
  assert.equal(matchAlternative('run npm install to add deps', PM_RULE.alternatives), 0);
  assert.equal(matchAlternative('use yarn install please', PM_RULE.alternatives), 2);
  assert.equal(matchAlternative('just a random skill', PM_RULE.alternatives), -1);
});

test('detectConflicts finds conflict between npm and pnpm skills', () => {
  const a = skill({ id: 'a', slug: 'npm-skill', description: 'always use npm install' });
  const b = skill({ id: 'b', slug: 'pnpm-skill', description: 'use pnpm install for everything' });
  const findings = detectConflicts([a, b], [PM_RULE]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, 'conflict');
  assert.equal(findings[0].ruleId, 'package-manager-conflict');
  assert.equal(findings[0].links.length, 2);
  assert.equal(findings[0].links[0].role, 'source');
  assert.equal(findings[0].links[1].role, 'target');
});

test('detectConflicts no conflict when only one alternative matched', () => {
  const a = skill({ id: 'a', slug: 'npm-skill', description: 'always use npm install' });
  const b = skill({ id: 'b', slug: 'npm-skill2', description: 'npm install is the way' });
  const findings = detectConflicts([a, b], [PM_RULE]);
  assert.equal(findings.length, 0);
});

test('detectConflicts uses sorted participant identity keys', () => {
  const a = skill({ id: 'a', slug: 'npm-skill', description: 'use npm install' });
  const b = skill({ id: 'b', slug: 'pnpm-skill', description: 'use pnpm install' });
  const findings1 = detectConflicts([a, b], [PM_RULE]);
  const findings2 = detectConflicts([b, a], [PM_RULE]);
  assert.equal(findings1[0].id, findings2[0].id);
});

test('detectConflicts finds output format conflict', () => {
  const a = skill({ id: 'a', slug: 'json-skill', description: 'always respond in json format' });
  const b = skill({ id: 'b', slug: 'md-skill', description: 'respond in markdown only' });
  const findings = detectConflicts([a, b], [OUTPUT_RULE]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, 'output-format-conflict');
});

test('detectConflicts handles three-way conflict', () => {
  const a = skill({ id: 'a', slug: 'npm-skill', description: 'use npm install' });
  const b = skill({ id: 'b', slug: 'pnpm-skill', description: 'use pnpm install' });
  const c = skill({ id: 'c', slug: 'yarn-skill', description: 'use yarn install' });
  const findings = detectConflicts([a, b, c], [PM_RULE]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].links.length, 3);
  assert.equal(findings[0].links[0].role, 'source');
  assert.equal(findings[0].links[1].role, 'target');
  assert.equal(findings[0].links[2].role, 'related');
});
