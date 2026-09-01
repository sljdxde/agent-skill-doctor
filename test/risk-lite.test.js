'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('scanSkillForRisks ignores safety constraints and reference files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-risk-'));
  const main = path.join(root, 'SKILL.md');
  const reference = path.join(root, 'references', 'reference.md');
  fs.mkdirSync(path.dirname(reference), { recursive: true });
  fs.writeFileSync(main, 'Never run rm -rf on a user directory.\n不要执行 rm -rf。\n不做 rm -rf 清理。\nThe pattern `rm -rf` matches a destructive command.\n- 删除/移动：`rm`, `rm -rf`, `unlink`\n| 系统破坏 | `rm -rf /` | 恶意 |\n');
  fs.writeFileSync(reference, 'rm -rf is documented here.\n');
  const skill = {
    id: 'safe-skill', slug: 'safe-skill', source: { type: 'unknown' },
    location: { path: root, root, rootType: 'unknown' }, hashes: { contentSha256: 'safe' },
    files: [{ path: main, relativePath: 'SKILL.md' }, { path: reference, relativePath: 'references/reference.md' }],
  };
  const findings = scanSkillForRisks(skill, [{ id: 'destructive-action-risk', severity: 'critical', patterns: [{ id: 'rm', text: 'rm -rf' }] }]);
  assert.equal(findings.length, 0);
});

test('scanSkillForRisks flags an executable destructive command', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-risk-'));
  const main = path.join(root, 'SKILL.md');
  fs.writeFileSync(main, 'Run `rm -rf "$target"` after the export completes.\n');
  const skill = {
    id: 'unsafe-skill', slug: 'unsafe-skill', source: { type: 'unknown' },
    location: { path: root, root, rootType: 'unknown' }, hashes: { contentSha256: 'unsafe' },
    files: [{ path: main, relativePath: 'SKILL.md' }],
  };
  const findings = scanSkillForRisks(skill, [{ id: 'destructive', severity: 'critical', patterns: [{ id: 'rm', text: 'rm -rf' }] }]);
  assert.equal(findings.length, 1);
});

test('default destructive rule matches both -rf and -fr flag order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-risk-'));
  const main = path.join(root, 'SKILL.md');
  fs.writeFileSync(main, 'Run rm -fr "$target" after the export completes.\n');
  const skill = {
    id: 'unsafe-reversed-flags', slug: 'unsafe-reversed-flags', source: { type: 'unknown' },
    location: { path: root, root, rootType: 'unknown' }, hashes: { contentSha256: 'unsafe-reversed-flags' },
    files: [{ path: main, relativePath: 'SKILL.md' }],
  };
  const rules = loadJsonRules(path.join(__dirname, '..', 'rules', 'default'));
  const findings = scanSkillForRisks(skill, rules);
  assert.ok(findings.some(finding => finding.ruleId === 'destructive-action-risk'));
});

test('default destructive rule distinguishes bounded cleanup from unbounded deletion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-risk-'));
  const cleanup = path.join(root, 'cleanup.sh');
  const destructive = path.join(root, 'destroy.sh');
  fs.writeFileSync(cleanup, 'rm -rf dist\nrm -rf "$TMPDIR"\n');
  fs.writeFileSync(destructive, 'rm -rf "$HOME"\n');
  const rules = loadJsonRules(path.join(__dirname, '..', 'rules', 'default'));
  const base = { source: { type: 'unknown' }, location: { root, rootType: 'unknown' }, hashes: { contentSha256: 'risk' } };
  const cleanupFindings = scanSkillForRisks({ ...base, id: 'cleanup', slug: 'cleanup', location: { ...base.location, path: root }, files: [{ path: cleanup, relativePath: 'cleanup.sh' }] }, rules);
  const destructiveFindings = scanSkillForRisks({ ...base, id: 'destructive', slug: 'destructive', location: { ...base.location, path: root }, files: [{ path: destructive, relativePath: 'destroy.sh' }] }, rules);
  assert.equal(cleanupFindings.find(finding => finding.ruleId === 'destructive-action-risk').severity, 'medium');
  assert.equal(destructiveFindings.find(finding => finding.ruleId === 'destructive-action-risk').severity, 'critical');
});
