'use strict';

const crypto = require('node:crypto');
const { buildSkillIdentityKey, buildParticipantIdentityKey } = require('./phase2');

function sha256(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeAnchor(text) {
  return normalizeText(text).slice(0, 300);
}

/**
 * Extract all text content from a skill for matching.
 */
function skillTextContent(skill) {
  const parts = [];
  if (skill.description) parts.push(skill.description);
  if (skill._scan?.text) parts.push(skill._scan.text);
  if (skill.frontmatter) {
    for (const v of Object.values(skill.frontmatter)) {
      if (typeof v === 'string') parts.push(v);
    }
  }
  return normalizeText(parts.join(' '));
}

/**
 * Check which alternative index a skill matches, or -1 if none.
 * Uses the best match strategy: checks all alternatives and returns
 * the one with the longest matching keyword to avoid substring false positives.
 */
function matchAlternative(skillText, alternatives) {
  const lower = skillText;
  let bestIdx = -1;
  let bestLen = 0;
  for (let i = 0; i < alternatives.length; i++) {
    const keywords = alternatives[i];
    for (const kw of keywords) {
      const normalized = normalizeText(kw);
      if (lower.includes(normalized) && normalized.length > bestLen) {
        bestIdx = i;
        bestLen = normalized.length;
      }
    }
  }
  return bestIdx;
}

/**
 * Detect conflicts among skills based on conflict rules.
 * Each rule has `alternatives` - when skills match different alternatives, that's a conflict.
 *
 * @param {Array} skills - skill records
 * @param {Array} conflictRules - rules from DEFAULT_CONFLICT_RULES or loaded from files
 * @returns {Array} conflict findings
 */
function detectConflicts(skills, conflictRules) {
  const findings = [];

  for (const rule of conflictRules) {
    const alternatives = rule.alternatives || [];
    if (alternatives.length < 2) continue;

    // Map: alternativeIndex -> [skills]
    const buckets = new Map();
    for (const skill of skills) {
      const text = skillTextContent(skill);
      const idx = matchAlternative(text, alternatives);
      if (idx < 0) continue;
      if (!buckets.has(idx)) buckets.set(idx, []);
      buckets.get(idx).push(skill);
    }

    // Need at least 2 different alternatives matched
    const matchedAlts = [...buckets.entries()].filter(([, s]) => s.length > 0);
    if (matchedAlts.length < 2) continue;

    // Sort by alternative index for deterministic role assignment
    matchedAlts.sort((a, b) => a[0] - b[0]);

    // Collect all participating skills
    const allSkills = [];
    for (const [, bucketSkills] of matchedAlts) allSkills.push(...bucketSkills);
    const sorted = [...allSkills].sort((a, b) =>
      buildSkillIdentityKey(a).localeCompare(buildSkillIdentityKey(b))
    );

    const participantKey = buildParticipantIdentityKey(sorted);
    const conflictType = rule.type || 'opposite_instruction';
    const reason = matchedAlts
      .map(([altIdx, bucketSkills]) => {
        const sortedSlugs = bucketSkills.map(s => s.slug).sort().join(', ');
        return `alternative[${altIdx}] (${alternatives[altIdx].join(', ')}): ${sortedSlugs}`;
      })
      .join(' vs ');

    const signature = sha256(`${conflictType}:${rule.id}:${normalizeAnchor(reason)}`);
    const id = sha256(`${participantKey}:conflict:conflict-detector:${rule.id}:${signature}`);

    // Assign roles: first two buckets get source/target, rest get related
    const links = [];
    for (let bucketIdx = 0; bucketIdx < matchedAlts.length; bucketIdx++) {
      const [, bucketSkills] = matchedAlts[bucketIdx];
      const role = bucketIdx === 0 ? 'source' : bucketIdx === 1 ? 'target' : 'related';
      for (const s of bucketSkills) {
        links.push({ skillId: s.id, role });
      }
    }

    findings.push({
      id,
      type: 'conflict',
      severity: rule.severity || 'medium',
      detectorId: 'conflict-detector',
      ruleId: rule.id,
      title: rule.title || `Conflict: ${conflictType}`,
      description: `Detected conflict among skills: ${reason}`,
      signature,
      evidence: sorted.map(s => ({
        file: s.location?.path || s.local_path || '',
        text: `${s.slug}: ${s.description || '(no description)'}`,
        anchor: normalizeAnchor(`${s.slug} ${s.description || ''}`),
      })),
      recommendation: rule.recommendation || 'Review conflicting skills and keep only one convention per project.',
      skills: sorted,
      links,
    });
  }

  return findings;
}

module.exports = { detectConflicts, matchAlternative, skillTextContent };
