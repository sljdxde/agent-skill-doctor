'use strict';

function localPath(skill) {
  return String(skill.location?.path || skill.local_path || skill.path || '').replace(/\\/g, '/');
}

function sourceType(skill) {
  return skill.source?.type || skill.source_type || 'unknown';
}

function isManagedInstallation(skill) {
  const type = sourceType(skill);
  if (['builtin', 'plugin', 'marketplace'].includes(type)) return true;
  return /\/plugins\/(?:cache|marketplaces)\//.test(localPath(skill)) || /\/connectors\//.test(localPath(skill));
}

function frontmatterValue(skill, keys) {
  const frontmatter = skill.frontmatter || {};
  for (const key of keys) {
    const value = frontmatter[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isGovernanceCandidate(skill, options = {}) {
  if (options.includeAll) return true;
  if (isManagedInstallation(skill)) return false;

  const rootType = skill.location?.rootType || skill.root_type || '';
  if (rootType === 'central_library' || rootType === 'project_local') return true;

  const frontmatter = skill.frontmatter || {};
  if (isTruthy(frontmatter.registry) || isTruthy(frontmatter.shareable) || isTruthy(frontmatter.publish)) return true;
  const hasOwner = Boolean(frontmatterValue(skill, ['owner', 'owners', 'maintainer', 'maintainers']));
  const hasLifecycle = Boolean(frontmatterValue(skill, ['lifecycle', 'registry_status']));
  return hasOwner && hasLifecycle;
}

function hasUsageEvidence(skill) {
  const usage = skill.usage || {};
  return usage.activityEvidenceAvailable === true
    || usage.presetCountKnown === true
    || usage.activityLogKnown === true
    || (Array.isArray(usage.referenceEvidence) && usage.referenceEvidence.length > 0);
}

module.exports = {
  localPath,
  sourceType,
  isManagedInstallation,
  isGovernanceCandidate,
  hasUsageEvidence,
};
