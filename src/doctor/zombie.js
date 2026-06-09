'use strict';

const crypto = require('node:crypto');
const { buildSkillIdentityKey, buildParticipantIdentityKey } = require('./phase2');

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
const PLUGIN_SOURCE_RE = /superpowers|using-superpowers/i;

/**
 * Determine source protection level for zombie scoring.
 * Returns: 'official' | 'plugin' | 'thirdParty' | null
 */
function sourceProtectionLevel(skill) {
  const sourceUrl = skill.source?.url || '';
  const plugin = skill._sourcePlugin || '';
  if (OFFICIAL_SOURCE_RE.test(sourceUrl)) return 'official';
  if (plugin && PLUGIN_SOURCE_RE.test(plugin)) return 'plugin';
  if (plugin) return 'thirdParty';
  return null;
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
  const tags = skill.tags || [];

  // Early return for protected skills
  if (usage.manuallyPinned || tags.includes('keep') || tags.includes('core') || tags.includes('system')) {
    return 0.0;
  }

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
function detectZombies(skills) {
  const findings = [];

  for (const skill of skills) {
    const score = computeZombieScore(skill);
    if (score < 0.4) continue;

    const level = zombieLevel(score);
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
    const signature = sha256(`zombie:${level}:${Math.round(score * 100)}:${skill.slug || ''}`);
    const id = sha256(`${participantKey}:zombie:zombie-detector:${level}:${signature}`);

    findings.push({
      id,
      type: 'zombie',
      severity: score >= 0.8 ? 'medium' : 'low',
      detectorId: 'zombie-detector',
      ruleId: level,
      title: `Zombie candidate: ${skill.name || skill.slug}`,
      description: `${zombieLevelDescription(level)} Score: ${score.toFixed(2)}. Factors: ${factorText}.`,
      signature,
      evidence: [{
        file: skill.location?.path || skill.local_path || '',
        text: `${skill.slug}: score=${score.toFixed(2)}, level=${level}, reasons=${reasonText}`,
        anchor: `${skill.slug} zombie ${level}`,
      }],
      recommendation: 'Review whether this skill is still needed. Consider removing from presets or disabling if unused.',
      score,
      level,
      skills: [skill],
      links: [{ skillId: skill.id, role: 'primary' }],
    });
  }

  // Sort by score descending
  findings.sort((a, b) => (b.score || 0) - (a.score || 0));
  return findings;
}

module.exports = { computeZombieScore, zombieLevel, zombieLevelDescription, detectZombies, descriptionQuality };
