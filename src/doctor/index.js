'use strict';

const phase2 = require('./phase2');
const conflict = require('./conflict');
const zombie = require('./zombie');
const riskLite = require('./risk-lite');
const rules = require('./rules');
const i18n = require('./i18n');
const governance = require('./governance');
const freshness = require('./freshness');

module.exports = {
  // Phase 2 - Duplicate and drift detection
  buildSkillIdentityKey: phase2.buildSkillIdentityKey,
  buildParticipantIdentityKey: phase2.buildParticipantIdentityKey,
  chooseCanonical: phase2.chooseCanonical,
  detectDuplicateGroups: phase2.detectDuplicateGroups,
  detectVersionDrift: phase2.detectVersionDrift,
  normalizeSourceUrl: phase2.normalizeSourceUrl,
  sourceTrustScore: phase2.sourceTrustScore,
  sourceKey: phase2.sourceKey,

  // Conflict detection
  detectConflicts: conflict.detectConflicts,
  matchAlternative: conflict.matchAlternative,
  skillTextContent: conflict.skillTextContent,

  // Zombie detection
  computeZombieScore: zombie.computeZombieScore,
  zombieLevel: zombie.zombieLevel,
  zombieLevelDescription: zombie.zombieLevelDescription,
  detectZombies: zombie.detectZombies,
  descriptionQuality: zombie.descriptionQuality,

  // Risk scanning
  getMatchedPatternId: riskLite.getMatchedPatternId,
  loadJsonRules: riskLite.loadJsonRules,
  scanSkillForRisks: riskLite.scanSkillForRisks,

  // Governance readiness
  detectGovernanceFindings: governance.detectGovernanceFindings,
  hasGovernanceLabel: governance.hasGovernanceLabel,
  hasTrustedSource: governance.hasTrustedSource,
  lifecycleStatus: governance.lifecycleStatus,

  // Freshness / update detection
  detectFreshnessFindings: freshness.detectFreshnessFindings,
  compareVersions: freshness.compareVersions,
  parseVersion: freshness.parseVersion,
  isGitUrl: freshness.isGitUrl,

  // Rules and utilities
  DEFAULT_RISK_RULES: rules.DEFAULT_RISK_RULES,
  DEFAULT_CONFLICT_RULES: rules.DEFAULT_CONFLICT_RULES,
  matchedPatternId: rules.matchedPatternId,
  normalizeAnchor: rules.normalizeAnchor,
  normalizeText: rules.normalizeText,
  sha256: rules.sha256,
  validPatternId: rules.validPatternId,

  // i18n
  t: i18n.t,
  dictionaries: i18n.dictionaries
};
