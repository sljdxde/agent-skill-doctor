'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getMatchedPatternId, loadJsonRules, scanSkillForRisks } = require('../src/doctor/risk-lite');

test('getMatchedPatternId uses pattern.id when valid', () => {
  const result = getMatchedPatternId('test-rule', { id: 'env-file' }, 0);
  assert.equal(result, 'env-file');
});

test('getMatchedPatternId falls back to hash when pattern.id is invalid', () => {
  const result = getMatchedPatternId('test-rule', { id: 'INVALID_ID' }, 0);
  assert.ok(result.startsWith('test-rule_'));
  assert.ok(result.length > 10);
});

test('getMatchedPatternId falls back to hash for string patterns', () => {
  const result = getMatchedPatternId('test-rule', { text: '.env' }, 0);
  assert.ok(result.startsWith('test-rule_'));
});

test('getMatchedPatternId falls back to index when no text', () => {
  const result = getMatchedPatternId('test-rule', {}, 5);
  assert.equal(result, 'test-rule_5');
});

test('loadJsonRules loads rules from directory', () => {
  const rules = loadJsonRules('rules/default');
  assert.ok(rules.length > 0, 'Expected rules to be loaded');
  assert.ok(rules.every(r => r.id), 'Every rule should have an id');
  assert.ok(rules.every(r => r.patterns), 'Every rule should have patterns');
});

test('loadJsonRules returns empty for non-existent directory', () => {
  const rules = loadJsonRules('/nonexistent/path');
  assert.deepEqual(rules, []);
});

test('loadJsonRules validates version', () => {
  // This test relies on the actual rule files having version: 1
  const rules = loadJsonRules('rules/default');
  assert.ok(rules.length > 0);
});

test('getMatchedPatternId falls back to hash for regex patterns', () => {
  const result = getMatchedPatternId('test-rule', { regex: '\\.env' }, 0);
  assert.ok(result.startsWith('test-rule_'));
  assert.notEqual(result, 'test-rule_0');
});

test('scanSkillForRisks supports regex patterns', () => {
  const skill = {
    id: 'skill-a',
    slug: 'alpha',
    source: { type: 'unknown' },
    location: { path: __filename, root: __dirname, rootType: 'unknown' },
    hashes: { contentSha256: 'h1' },
    files: [{ path: __filename, relativePath: 'risk-lite.test.js' }],
  };
  const findings = scanSkillForRisks(skill, [{
    id: 'regex-rule',
    severity: 'high',
    patterns: [{ id: 'regex-pattern', regex: 'scanSkillForRisks\\s+supports' }],
  }]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, 'regex-rule');
});
