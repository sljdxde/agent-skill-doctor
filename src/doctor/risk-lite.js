'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildParticipantIdentityKey } = require('./phase2');

function sha256(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeAnchor(text) {
  return normalizeText(text).slice(0, 300);
}

function getMatchedPatternId(ruleId, pattern, index) {
  if (pattern && pattern.id && /^[a-z0-9-]{1,64}$/.test(pattern.id)) return pattern.id;
  const text = typeof pattern === 'string' ? pattern : String((pattern && (pattern.regex || pattern.text || pattern.value)) || '');
  if (text) return `${ruleId}_${sha256(text).slice(0, 8)}`;
  return `${ruleId}_${index}`;
}

function loadJsonRules(rulesDir) {
  const rules = [];
  if (!rulesDir || !fs.existsSync(rulesDir)) return rules;
  for (const file of fs.readdirSync(rulesDir).sort()) {
    if (!file.endsWith('.json')) continue;
    const parsed = JSON.parse(fs.readFileSync(path.join(rulesDir, file), 'utf8'));
    if (parsed.version !== 1) throw new Error(`Unsupported rule file version in ${file}`);
    for (const rule of parsed.rules || []) {
      const ids = new Set();
      for (const pattern of rule.patterns || []) {
        if (!pattern || typeof pattern !== 'object' || !pattern.id || !/^[a-z0-9-]{1,64}$/.test(pattern.id)) continue;
        if (ids.has(pattern.id)) throw new Error(`Duplicate pattern.id "${pattern.id}" in rule "${rule.id}"`);
        ids.add(pattern.id);
      }
      rules.push({ ...rule, file });
    }
  }
  return rules;
}

function isTextLike(filePath) {
  return /\.(md|txt|json|ya?ml|toml|js|ts|py|rs|sh|bash|zsh)$/i.test(filePath);
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function findPattern(original, lower, pattern) {
  if (pattern && typeof pattern === 'object' && pattern.regex) {
    const re = new RegExp(pattern.regex, pattern.flags || 'i');
    const match = re.exec(original);
    if (!match) return null;
    return { index: match.index, text: match[0] };
  }

  const needle = String((pattern && (pattern.text || pattern.value)) || pattern || '').toLowerCase();
  if (!needle) return null;
  const index = lower.indexOf(needle);
  if (index < 0) return null;
  return { index, text: original.slice(index, index + needle.length) };
}

function scanSkillForRisks(skill, rules) {
  const findings = [];
  for (const file of skill.files || []) {
    const filePath = file.path;
    if (!filePath || !fs.existsSync(filePath) || !isTextLike(filePath)) continue;
    const original = fs.readFileSync(filePath, 'utf8');
    const lower = original.toLowerCase();
    const relativeFile = file.relativePath || path.basename(filePath);

    for (const rule of rules) {
      const patterns = rule.patterns || [];
      for (let i = 0; i < patterns.length; i++) {
        const pattern = patterns[i];
        const match = findPattern(original, lower, pattern);
        if (!match) continue;
        const matched = match.text;
        const patternId = getMatchedPatternId(rule.id, pattern, i);
        const participantKey = buildParticipantIdentityKey([skill]);
        const signature = sha256(`${relativeFile}:${patternId}:${normalizeAnchor(matched)}`);
        const id = sha256(`${participantKey}:risk:risk-detector:${rule.id}:${signature}`);
        const line = lineNumberAt(original, match.index);
        findings.push({
          id,
          type: 'risk',
          severity: rule.severity || 'medium',
          detectorId: 'risk-detector',
          ruleId: rule.id,
          title: rule.title || 'Risk pattern detected',
          description: rule.description || `Detected risk pattern ${patternId}.`,
          signature,
          evidence: [{ file: relativeFile, lineStart: line, lineEnd: line, text: matched, anchor: normalizeAnchor(matched), occurrenceId: sha256(`${id}:${line}`) }],
          recommendation: rule.recommendation || 'Review the skill before enabling it automatically.',
          skillId: skill.id,
        });
      }
    }
  }
  return findings;
}

module.exports = { getMatchedPatternId, loadJsonRules, scanSkillForRisks };
