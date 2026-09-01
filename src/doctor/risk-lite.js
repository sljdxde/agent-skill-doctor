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

function isRiskRelevantFile(relativeFile) {
  const normalized = String(relativeFile || '').replace(/\\/g, '/').toLowerCase();
  if (/^(?:references|docs|examples|test|tests)\//.test(normalized)) return false;
  const base = path.basename(normalized);
  if (base === 'skill.md' || base === 'readme.md') return true;
  return /^(?:scripts|commands)\//.test(normalized) || /\.(?:js|ts|py|rs|sh|bash|zsh)$/i.test(normalized);
}

function nearbyLines(text, index) {
  const lines = String(text || '').split(/\r?\n/);
  const lineIndex = lineNumberAt(text, index) - 1;
  return [lines[lineIndex - 1], lines[lineIndex], lines[lineIndex + 1]].filter(Boolean).join(' ').toLowerCase();
}

function lineAt(text, index) {
  const lines = String(text || '').split(/\r?\n/);
  return lines[lineNumberAt(text, index) - 1] || '';
}

function isSafetyConstraint(text, index) {
  const context = nearbyLines(text, index);
  return /\b(?:never|do not|don't|avoid|must not|prohibit|forbidden)\b/.test(context) || /(?:不要|禁止|不得|切勿|严禁|避免|不可|不应|不(?:执行|运行|允许|可以|得|应|做))/.test(context);
}

function isDocumentationReference(text, index) {
  const context = nearbyLines(text, index);
  const line = lineAt(text, index);
  const inlineCodeCount = (line.match(/`/g) || []).length;
  return /^\s*\|/.test(line) || (/^\s*[-*]\s+/.test(line) && inlineCodeCount >= 4 && !/\b(?:run|execute)\b|(?:执行|运行)/i.test(line)) || /\b(?:regex|regular expression|pattern|matches?|example|sample|documentation|signature)\b/.test(context) || /(?:正则|匹配|示例|样例|检测规则|风险模式)/.test(context);
}

function destructiveSeverity(text) {
  const command = String(text || '').toLowerCase().replace(/[\"'`]/g, ' ').replace(/\s+/g, ' ').trim();
  const target = command.replace(/^.*?\brm\s+(?:(?:-[a-z]+\s*)+|(?:--(?:force|recursive)\s*)+)/, '').trim();
  if (!target) return 'critical';
  if (/(?:^|\s)(?:\/|\/\*|~(?:\/|$)|\$\{?home\}?|\$\{?userprofile\}?)(?:\s|$)/.test(target)) return 'critical';
  if (/\$\{?[a-z0-9_]*(?:tmp|temp|build|dist|out|cache|venv|test)[a-z0-9_]*\}?/.test(target) || /(?:^|\s)\/tmp\//.test(target)) return 'medium';
  if (/(?:^|\s)(?:dist|build|coverage|node_modules|test-env|\.godot\/imported|\.tmp)(?:\s|$)/.test(target)) return 'low';
  return 'high';
}

function severityForEvidence(rule, evidence) {
  if (rule.id !== 'destructive-action-risk') return rule.severity || 'medium';
  const rank = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
  return evidence.reduce((highest, item) => {
    const severity = destructiveSeverity(item.text);
    return rank[severity] > rank[highest] ? severity : highest;
  }, 'info');
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

function findPatternMatches(original, lower, pattern) {
  if (pattern && typeof pattern === 'object' && pattern.regex) {
    const flags = `${pattern.flags || 'i'}${String(pattern.flags || '').includes('g') ? '' : 'g'}`;
    const re = new RegExp(pattern.regex, flags);
    const matches = [];
    for (const match of original.matchAll(re)) {
      matches.push({ index: match.index, text: match[0] });
    }
    return matches;
  }
  const needle = String((pattern && (pattern.text || pattern.value)) || pattern || '').toLowerCase();
  if (!needle) return [];
  const matches = [];
  let index = 0;
  while ((index = lower.indexOf(needle, index)) >= 0) {
    matches.push({ index, text: original.slice(index, index + needle.length) });
    index += Math.max(needle.length, 1);
  }
  return matches;
}

function scanSkillForRisks(skill, rules) {
  // Collect all matches grouped by rule+pattern to deduplicate
  const matchMap = new Map(); // key: `${ruleId}:${patternId}` -> { rule, patternId, evidence[] }
  for (const file of skill.files || []) {
    const filePath = file.path;
    if (!filePath || !fs.existsSync(filePath) || !isTextLike(filePath)) continue;
    const original = fs.readFileSync(filePath, 'utf8');
    const lower = original.toLowerCase();
    const relativeFile = file.relativePath || path.basename(filePath);
    if (!isRiskRelevantFile(relativeFile)) continue;

    for (const rule of rules) {
      const patterns = rule.patterns || [];
      for (let i = 0; i < patterns.length; i++) {
        const pattern = patterns[i];
        const matches = findPatternMatches(original, lower, pattern);
        if (!matches.length) continue;
        const patternId = getMatchedPatternId(rule.id, pattern, i);
        const mapKey = `${rule.id}:${patternId}`;
        if (!matchMap.has(mapKey)) matchMap.set(mapKey, { rule, patternId, evidence: [] });
        for (const match of matches) {
          if (!pattern.matchSafetyConstraints && isSafetyConstraint(original, match.index)) continue;
          if (!pattern.matchDocumentationReferences && ['destructive-action-risk', 'credential-risk', 'network-download-risk'].includes(rule.id) && isDocumentationReference(original, match.index)) continue;
          const line = lineNumberAt(original, match.index);
          matchMap.get(mapKey).evidence.push({
            file: relativeFile, lineStart: line, lineEnd: line,
            text: match.text, anchor: normalizeAnchor(match.text),
          });
        }
      }
    }
  }

  // Generate one finding per rule+pattern per skill
  const findings = [];
  const participantKey = buildParticipantIdentityKey([skill]);
  for (const [, { rule, patternId, evidence }] of matchMap) {
    if (!evidence.length) continue;
    const signature = sha256(`${rule.id}:${patternId}:${evidence.map(e => `${e.file}:${e.lineStart}`).join(',')}`);
    const id = sha256(`${participantKey}:risk:risk-detector:${rule.id}:${signature}`);
    findings.push({
      id,
      type: 'risk',
      severity: severityForEvidence(rule, evidence),
      detectorId: 'risk-detector',
      ruleId: rule.id,
      title: rule.title || 'Risk pattern detected',
      description: `${rule.description || 'Risk pattern detected.'} [matched: ${patternId}]`,
      signature,
      evidence: evidence.map(e => ({ ...e, occurrenceId: sha256(`${id}:${e.file}:${e.lineStart}`) })),
      recommendation: rule.recommendation || 'Review the skill before enabling it automatically.',
      skillId: skill.id,
    });
  }
  return findings;
}

module.exports = { getMatchedPatternId, loadJsonRules, scanSkillForRisks, isRiskRelevantFile, isSafetyConstraint, isDocumentationReference, destructiveSeverity, severityForEvidence };
