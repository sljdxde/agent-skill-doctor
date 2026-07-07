'use strict';

const crypto = require('node:crypto');
const { buildParticipantIdentityKey } = require('./phase2');

function sha256(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim().toLowerCase()).filter(Boolean);
  return String(value || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function frontmatterValue(skill, keys) {
  const frontmatter = skill.frontmatter || {};
  for (const key of keys) {
    const value = frontmatter[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function hasTrustedSource(skill) {
  const source = skill.source || {};
  if (['builtin', 'marketplace'].includes(source.type)) return true;
  if (['git', 'plugin'].includes(source.type) && source.url) return true;
  return Boolean(skill.upstreamSkillId || skill.upstream_skill_id);
}

function lifecycleStatus(skill) {
  return frontmatterValue(skill, ['lifecycle', 'status', 'release_status', 'registry_status', 'governance_status']);
}

function hasGovernanceLabel(skill) {
  const tags = normalizeList(skill.tags || []);
  const labels = normalizeList(frontmatterValue(skill, ['label', 'labels']));
  return [...tags, ...labels].some(label => ['stable', 'dev', 'latest'].includes(label));
}

function makeFinding(skill, ruleId, severity, title, description, recommendation) {
  const participantKey = buildParticipantIdentityKey([skill]);
  const evidenceText = `${skill.slug || skill.name}: ${ruleId}`;
  const signature = sha256(`${ruleId}:${skill.id || skill.slug || skill.name}`);
  const id = sha256(`${participantKey}:governance:governance-detector:${ruleId}:${signature}`);
  return {
    id,
    type: 'governance',
    severity,
    detectorId: 'governance-detector',
    ruleId,
    title,
    description,
    signature,
    evidence: [{
      file: skill.location?.path || skill.local_path || '',
      text: evidenceText,
      anchor: evidenceText.toLowerCase(),
    }],
    recommendation,
    skills: [skill],
    links: [{ skillId: skill.id, role: 'primary' }],
  };
}

function detectGovernanceFindings(skills) {
  const findings = [];

  for (const skill of skills) {
    const owner = frontmatterValue(skill, ['owner', 'owners', 'maintainer', 'maintainers']);
    if (!owner) {
      findings.push(makeFinding(
        skill,
        'missing-owner',
        'medium',
        'Missing owner',
        'The skill has no owner or maintainer metadata, so registry review and rollback ownership are unclear.',
        'Add owner or maintainer metadata before sharing this skill through a registry.'
      ));
    }

    const version = skill.version || frontmatterValue(skill, ['version']);
    if (!version) {
      findings.push(makeFinding(
        skill,
        'missing-version',
        'medium',
        'Missing version',
        'The skill has no version metadata, which makes stable release and rollback decisions harder.',
        'Add a version field or lock the skill to an upstream ref before publishing.'
      ));
    }

    if (!lifecycleStatus(skill)) {
      findings.push(makeFinding(
        skill,
        'missing-lifecycle-status',
        'medium',
        'Missing lifecycle status',
        'The skill has no governance lifecycle status such as draft, review, or online.',
        'Add lifecycle metadata such as draft, review, online, deprecated, or archived.'
      ));
    }

    if (!hasGovernanceLabel(skill)) {
      findings.push(makeFinding(
        skill,
        'missing-governance-label',
        'low',
        'Missing governance label',
        'The skill has no stable, dev, or latest label to control adoption scope.',
        'Add a stable, dev, or latest label to make release targeting explicit.'
      ));
    }

    if (!hasTrustedSource(skill)) {
      findings.push(makeFinding(
        skill,
        'missing-source',
        'high',
        'Missing trusted source',
        'The skill has no upstream or registry source, so users cannot tell which copy is authoritative.',
        'Add source metadata or import this skill into a central library or registry before team-wide use.'
      ));
    }
  }

  return findings;
}

module.exports = {
  detectGovernanceFindings,
  hasGovernanceLabel,
  hasTrustedSource,
  lifecycleStatus,
};
