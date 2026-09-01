'use strict';

const crypto = require('node:crypto');
const { buildSkillIdentityKey, buildParticipantIdentityKey } = require('./phase2');
const { hasUsageEvidence, isManagedInstallation } = require('./skill-scope');

function sha256(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Simple description quality score (0-100).
 * Checks for presence, length, and useful content indicators.
 */
function descriptionQuality(skill) {
  const desc = String(skill.description || '').trim();
  if (!desc) return 0;
  let score = 40; // has description
  if (desc.length >= 20) score += 20;
  if (desc.length >= 60) score += 10;
  // Check for trigger/usage indicators
  const lower = desc.toLowerCase();
  if (/\b(when|use |trigger|if |run |invoke)\b/.test(lower)) score += 10;
  // Check for I/O indicators
  if (/\b(input|output|return|result|respond|answer)\b/.test(lower)) score += 10;
  // Check for action verbs
  if (/\b(scan|detect|check|analyze|generate|create|build|find)\b/.test(lower)) score += 10;
  return clamp(score, 0, 100);
}

const OFFICIAL_SOURCE_RE = /github\.com\/(anthropics|openai|github|google-gemini)\//i;
const OFFICIAL_PLUGIN_RE = /^(anthropics|openai|github|google-gemini)(\/|$)/i;
const PLUGIN_SOURCE_RE = /superpowers|using-superpowers/i;

/**
 * Determine source protection level for zombie scoring.
 * Returns: 'official' | 'plugin' | 'thirdParty' | null
 */
function sourceProtectionLevel(skill) {
  const sourceUrl = skill.source?.url || '';
  const plugin = skill._sourcePlugin || '';
  if (OFFICIAL_SOURCE_RE.test(sourceUrl)) return 'official';
  if (plugin && OFFICIAL_PLUGIN_RE.test(plugin)) return 'official';
  if (plugin && PLUGIN_SOURCE_RE.test(plugin)) return 'plugin';
  if (plugin) return 'thirdParty';
  return null;
}

function isProtectedSkill(skill) {
  const usage = skill.usage || {};
  const tags = usage.tags || skill.tags || [];
  return Boolean(
    usage.manuallyPinned
      || tags.includes('keep')
      || tags.includes('core')
      || tags.includes('system')
      || sourceProtectionLevel(skill) === 'official'
  );
}

function usageEvidenceQuality(skill) {
  const usage = skill.usage || {};
  const sources = [];
  if (Array.isArray(usage.referenceEvidence) && usage.referenceEvidence.length) sources.push('config_reference');
  if ((usage.presetCount || 0) > 0) sources.push('preset');
  if (Array.isArray(usage.installedInAgents) && usage.installedInAgents.length) sources.push('agent_installation');
  if (Array.isArray(usage.installedInProjects) && usage.installedInProjects.length) sources.push('project_installation');
  if (usage.lastActivityLogAt || (usage.activityCount || 0) > 0 || (usage.invocationCount || 0) > 0) sources.push('activity');

  const configuredConfidence = Number(usage.confidence);
  const score = Number.isFinite(configuredConfidence)
    ? clamp(configuredConfidence, 0, 1)
    : (sources.length ? 0.6 : 0.3);
  const level = score >= 0.8 ? 'high' : score >= 0.5 ? 'medium' : 'low';
  return { score, level, sources };
}

function zombieClassification(skill, score) {
  if (isProtectedSkill(skill)) return 'protected';
  if (score < 0.4) return 'normal';
  const usage = skill.usage || {};
  const hasActivityEvidence = Boolean(
    (usage.presetCount || 0) > 0
      || (Array.isArray(usage.referenceEvidence) && usage.referenceEvidence.length)
      || usage.lastActivityLogAt
      || (usage.activityCount || 0) > 0
      || (usage.invocationCount || 0) > 0
  );
  if (hasActivityEvidence) return 'stale';
  const hasInstallationEvidence = Boolean(
    (Array.isArray(usage.installedInAgents) && usage.installedInAgents.length)
      || (Array.isArray(usage.installedInProjects) && usage.installedInProjects.length)
  );
  if (hasInstallationEvidence) return 'unused_candidate';
  return usageEvidenceQuality(skill).score < 0.5 ? 'untracked' : 'unused_candidate';
}

function zombieRecommendation(classification) {
  if (classification === 'stale') return 'Check the recorded references and recent activity before archiving; the skill may still be intentionally installed.';
  if (classification === 'untracked') return 'Usage evidence is incomplete. Inspect agent and project configuration before changing or archiving this skill.';
  return 'Review whether this skill is still needed. Archive or disable it only after checking presets and project references.';
}

/**
 * Compute zombie score for a skill (0.0 - 1.0).
 *
 * Early return 0 for pinned / keep / core / system / official-source skills.
 * Plugin-source skills get 50% score reduction. Third-party get 25% reduction.
 *
 * Score components:
 *   presetCount === 0                  : +0.25
 *   installedInAgents.length === 0     : +0.20
 *   installedInProjects.length === 0   : +0.20
 *   !hasRecentModification             : +0.15
 *   !lastActivityLogAt                 : +0.15
 *   descriptionQuality < 40            : +0.05
 */
function computeZombieScore(skill) {
  const usage = skill.usage || {};

  // Early return for protected skills
  if (isProtectedSkill(skill)) {
    return 0.0;
  }

  // An installed location is not activity telemetry. Without observed usage data, absence of activity cannot prove a skill is stale.
  if (isManagedInstallation(skill) || (usage.installedInProjects || []).length > 0 || !hasUsageEvidence(skill)) return 0.0;

  // Official sources are fully protected
  const protection = sourceProtectionLevel(skill);
  if (protection === 'official') return 0.0;

  let score = 0;
  if ((usage.presetCount || 0) === 0) score += 0.25;
  if (!usage.installedInAgents || usage.installedInAgents.length === 0) score += 0.20;
  if (!usage.installedInProjects || usage.installedInProjects.length === 0) score += 0.20;
  if (!usage.hasRecentModification) score += 0.15;
  if (!usage.lastActivityLogAt) score += 0.15;
  if (descriptionQuality(skill) < 40) score += 0.05;

  // Reduce score for plugin/third-party sources
  if (protection === 'plugin') score *= 0.5;
  else if (protection === 'thirdParty') score *= 0.75;

  return clamp(score, 0, 1);
}

/**
 * Get zombie severity label.
 */
function zombieLevel(score) {
  if (score >= 0.8) return 'strong_suspicious_zombie';
  if (score >= 0.6) return 'suspicious_zombie';
  if (score >= 0.4) return 'low_activity';
  return 'normal';
}

/**
 * Get human-readable zombie level description.
 */
function zombieLevelDescription(level) {
  switch (level) {
    case 'strong_suspicious_zombie': return 'Strong suspected zombie skill - very low activity signals.';
    case 'suspicious_zombie': return 'Suspected zombie skill - low activity signals.';
    case 'low_activity': return 'Low activity skill - may be unused.';
    default: return 'Normal activity level.';
  }
}

/**
 * Detect zombie skills from a list of skill records.
 * Returns findings for skills with zombie score >= 0.4.
 *
 * @param {Array} skills
 * @returns {Array} zombie findings
 */
function detectZombies(skills, options = {}) {
  const findings = [];
  const thresholdValue = Number(options.threshold);
  const threshold = Number.isFinite(thresholdValue) ? clamp(thresholdValue, 0, 1) : 0.4;
  const minConfidenceValue = Number(options.minConfidence);
  const minConfidence = Number.isFinite(minConfidenceValue) ? clamp(minConfidenceValue, 0, 1) : 0;

  for (const skill of skills) {
    const score = computeZombieScore(skill);
    const evidenceQuality = usageEvidenceQuality(skill);
    if (score < threshold || evidenceQuality.score < minConfidence) continue;

    const level = zombieLevel(score);
    const classification = zombieClassification(skill, score);
    const participantKey = buildParticipantIdentityKey([skill]);
    const reasons = [];

    const usage = skill.usage || {};
    const factors = [];
    if ((usage.presetCount || 0) === 0) { reasons.push('not in any preset'); factors.push('presetCount==0 (+0.25)'); }
    if (!usage.installedInAgents || usage.installedInAgents.length === 0) { reasons.push('not installed in any agent'); factors.push('noAgents (+0.20)'); }
    if (!usage.installedInProjects || usage.installedInProjects.length === 0) { reasons.push('not installed in any project'); factors.push('noProjects (+0.20)'); }
    if (!usage.hasRecentModification) { reasons.push('no recent modifications'); factors.push('noModification (+0.15)'); }
    if (!usage.lastActivityLogAt) { reasons.push('no activity log entries'); factors.push('noActivityLog (+0.15)'); }
    if (descriptionQuality(skill) < 40) { reasons.push('poor description quality'); factors.push('lowDescriptionQuality (+0.05)'); }

    // Source protection discount
    const protection = sourceProtectionLevel(skill);
    if (protection === 'plugin') factors.push('sourcePlugin (*0.50)');
    else if (protection === 'thirdParty') factors.push('sourceThirdParty (*0.75)');

    const reasonText = reasons.join('; ');
    const factorText = factors.join('; ');
    const referenceEvidence = Array.isArray(usage.referenceEvidence) ? usage.referenceEvidence : [];
    const referenceText = referenceEvidence.length
      ? `references=${referenceEvidence.map(item => item.path || item.file || item).join(', ')}`
      : 'references=none detected';
    const signature = sha256(`zombie:${level}:${Math.round(score * 100)}:${skill.slug || ''}`);
    const id = sha256(`${participantKey}:zombie:zombie-detector:${level}:${signature}`);

    findings.push({
      id,
      type: 'zombie',
      severity: score >= 0.8 ? 'medium' : 'low',
      detectorId: 'zombie-detector',
      ruleId: level,
      title: `Zombie candidate: ${skill.name || skill.slug}`,
      description: `${zombieLevelDescription(level)} Score: ${score.toFixed(2)}. Classification: ${classification}. Evidence confidence: ${evidenceQuality.level} (${evidenceQuality.score.toFixed(2)}). Factors: ${factorText}.`,
      signature,
      evidence: [{
        file: skill.location?.path || skill.local_path || '',
        text: `${skill.slug}: score=${score.toFixed(2)}, level=${level}, reasons=${reasonText}`,
        anchor: `${skill.slug} zombie ${level}`,
      }, {
        file: 'usage-signals',
        kind: 'usage-summary',
        classification,
        confidence: evidenceQuality.score,
        confidenceLevel: evidenceQuality.level,
        sources: evidenceQuality.sources,
        references: referenceEvidence,
        text: `${classification}; confidence=${evidenceQuality.score.toFixed(2)}; ${referenceText}`,
        anchor: `${skill.slug} usage evidence`,
      }],
      recommendation: zombieRecommendation(classification),
      score,
      level,
      classification,
      confidence: evidenceQuality.score,
      skills: [skill],
      links: [{ skillId: skill.id, role: 'primary' }],
    });
  }

  // Sort by score descending
  findings.sort((a, b) => (b.score || 0) - (a.score || 0));
  return findings;
}

module.exports = {
  computeZombieScore,
  zombieLevel,
  zombieLevelDescription,
  detectZombies,
  descriptionQuality,
  usageEvidenceQuality,
  zombieClassification,
};
