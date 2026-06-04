'use strict';

const crypto = require('node:crypto');

function sha256(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeAnchor(text) {
  return normalizeText(text).slice(0, 300);
}

function validPatternId(id) {
  return /^[a-z0-9-]{1,64}$/.test(String(id || ''));
}

function matchedPatternId(ruleId, pattern, index) {
  if (pattern && typeof pattern === 'object' && validPatternId(pattern.id)) return pattern.id;
  const text = typeof pattern === 'string' ? pattern : (pattern && (pattern.regex || pattern.text));
  if (text) return `${ruleId}_${sha256(text).slice(0, 8)}`;
  return `${ruleId}_${index}`;
}

const DEFAULT_RISK_RULES = [];

const DEFAULT_CONFLICT_RULES = [
  {
    id: 'package-manager-conflict',
    type: 'opposite_instruction',
    severity: 'medium',
    title: 'Conflicting package manager instructions',
    alternatives: [['use npm', 'npm install'], ['use pnpm', 'pnpm install'], ['use yarn', 'yarn install']],
    recommendation: 'Keep only one package-manager convention skill per project or preset.'
  },
  {
    id: 'output-format-conflict',
    type: 'output_format_conflict',
    severity: 'medium',
    title: 'Conflicting output format instructions',
    alternatives: [['respond in json', 'output json only'], ['respond in markdown', 'output markdown only']],
    recommendation: 'Scope output-format skills to specific projects or presets.'
  }
];

module.exports = {
  DEFAULT_RISK_RULES,
  DEFAULT_CONFLICT_RULES,
  matchedPatternId,
  normalizeAnchor,
  normalizeText,
  sha256,
  validPatternId
};
