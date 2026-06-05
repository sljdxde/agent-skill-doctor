'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

function sha256(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function normalizePath(input) {
  return path.resolve(String(input || '')).replaceAll('\\\\', '/');
}

function normalizeSourceUrl(url) {
  return String(url || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function buildSkillIdentityKey(skill) {
  if (skill.upstreamSkillId || skill.upstream_skill_id) {
    return `upstream:${skill.upstreamSkillId || skill.upstream_skill_id}`;
  }

  const sourceUrl = skill.source?.url || skill.source_url;
  const sourceSubdir = skill.source?.subdir || skill.source_subdir || '';
  const slug = skill.slug;
  if (sourceUrl && slug) {
    return `source:${normalizeSourceUrl(sourceUrl)}:${sourceSubdir}:${slug}`;
  }

  const root = skill.location?.root || skill.root || skill.root_path;
  if (root && slug) {
    return `path:${normalizePath(root)}:${slug}`;
  }

  const contentHash = skill.hashes?.contentSha256 || skill.content_hash || skill.contentHash || 'unknown-hash';
  const localPath = skill.location?.path || skill.local_path || skill.path || 'unknown-path';
  return `hash:${contentHash}:${normalizePath(localPath)}`;
}

function buildParticipantIdentityKey(skills) {
  return sha256(skills.map(buildSkillIdentityKey).sort().join('\n'));
}

function sourceKey(skill) {
  const sourceUrl = skill.source?.url || skill.source_url;
  if (!sourceUrl) return null;
  const subdir = skill.source?.subdir || skill.source_subdir || '';
  return `${normalizeSourceUrl(sourceUrl)}:${subdir}:${skill.slug || ''}`;
}

function contentHash(skill) {
  return skill.hashes?.contentSha256 || skill.content_hash || skill.contentHash || null;
}

function sourceRef(skill) {
  return skill.sourceCommit || skill.source_commit || skill.source?.commit || skill.sourceRef || skill.source_ref || skill.source?.ref || null;
}

function modifiedTime(skill) {
  return Date.parse(skill.modifiedAt || skill.modified_at || skill.updatedAt || 0) || 0;
}

function sourceTrustScore(skill) {
  const type = skill.source?.type || skill.source_type;
  const url = normalizeSourceUrl(skill.source?.url || skill.source_url);
  if (type === 'marketplace') return 1.0;
  if (/^github\.com\/(anthropics|openai|github|google-gemini)\//.test(url)) return 0.9;
  if (/^github\.com\/[^/]+\//.test(url)) return 0.6;
  const rootType = skill.location?.rootType || skill.root_type;
  if (rootType === 'project_local') return 0.5;
  if (rootType === 'agent_global') return 0.4;
  return 0.2;
}

function locationScore(skill) {
  const rootType = skill.location?.rootType || skill.root_type;
  if (rootType === 'central_library') return 1;
  if (rootType === 'project_local') return 0.7;
  if (rootType === 'agent_global') return 0.5;
  return 0.2;
}

function recencyScore(skill) {
  const time = modifiedTime(skill);
  if (!time) return 0;
  const ageDays = Math.max(0, (Date.now() - time) / 86_400_000);
  return Math.max(0, 1 - ageDays / 365);
}

function usageScore(skill) {
  const usage = skill.usage || {};
  const agentCount = usage.installedInAgents?.length || 0;
  const projectCount = usage.installedInProjects?.length || 0;
  return Math.min(1, (usage.presetCount || 0) * 0.25 + agentCount * 0.25 + projectCount * 0.25);
}

function descriptionScore(skill) {
  const desc = String(skill.description || '').trim();
  if (!desc) return 0;
  return Math.min(1, desc.length / 120);
}

function pinnedScore(skill) {
  const usage = skill.usage || {};
  const tags = skill.tags || [];
  return usage.manuallyPinned || tags.includes('keep') || tags.includes('core') ? 1 : 0;
}

function canonicalScore(skill) {
  if (pinnedScore(skill) === 1) return Number.MAX_SAFE_INTEGER;
  return (
    sourceTrustScore(skill) * 0.25 +
    recencyScore(skill) * 0.20 +
    usageScore(skill) * 0.20 +
    descriptionScore(skill) * 0.15 +
    locationScore(skill) * 0.10 +
    pinnedScore(skill) * 0.10
  );
}

function chooseCanonical(skills) {
  return [...skills].sort((a, b) => {
    const scoreA = canonicalScore(a);
    const scoreB = canonicalScore(b);
    return scoreB - scoreA || String(a.slug || a.name).localeCompare(String(b.slug || b.name));
  })[0];
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].filter(([, members]) => members.length > 1);
}

function duplicateGroupId(strategy, skills) {
  return sha256(`${strategy}:${buildParticipantIdentityKey(skills)}`);
}

function makeDuplicateGroup(strategy, confidence, skills, reason) {
  const sorted = [...skills].sort((a, b) => buildSkillIdentityKey(a).localeCompare(buildSkillIdentityKey(b)));
  const canonical = chooseCanonical(sorted);
  return {
    id: duplicateGroupId(strategy, sorted),
    strategy,
    confidence,
    reason,
    canonicalSkillId: canonical.id,
    members: sorted.map(skill => ({
      skillId: skill.id,
      role: skill.id === canonical.id ? 'canonical' : 'candidate',
      confidence,
    })),
    skills: sorted,
  };
}

function detectDuplicateGroups(skills) {
  const seen = new Set();
  const groups = [];

  const add = (strategy, confidence, grouped, reason) => {
    for (const [, members] of grouped) {
      const group = makeDuplicateGroup(strategy, confidence, members, reason);
      if (seen.has(group.id)) continue;
      seen.add(group.id);
      groups.push(group);
    }
  };

  add('exact_duplicate', 1.0, groupBy(skills, contentHash), 'identical content hash');
  add('same_source_duplicate', 0.95, groupBy(skills, sourceKey), 'same source URL, subdir, and slug');
  add(
    'same_name_duplicate',
    0.7,
    groupBy(skills, skill => {
      const sameSlug = skills.filter(other => other.slug === skill.slug);
      const distinctHashes = new Set(sameSlug.map(contentHash).filter(Boolean));
      return distinctHashes.size > 1 ? skill.slug : null;
    }),
    'same normalized skill name with different content'
  );

  return groups;
}

function versionDriftId(skills, key) {
  return sha256(`version_drift:${buildParticipantIdentityKey(skills)}:${key || ''}`);
}

function detectVersionDrift(skills) {
  const candidates = [
    ...groupBy(skills, sourceKey),
    ...groupBy(skills, skill => skill.slug),
  ];
  const seen = new Set();
  const findings = [];

  for (const [key, members] of candidates) {
    const hashes = new Set(members.map(contentHash).filter(Boolean));
    const refs = new Set(members.map(sourceRef).filter(Boolean));
    if (hashes.size <= 1 && refs.size <= 1) continue;

    const sorted = [...members].sort((a, b) => buildSkillIdentityKey(a).localeCompare(buildSkillIdentityKey(b)));
    const id = versionDriftId(sorted, key);
    if (seen.has(id)) continue;
    seen.add(id);

    findings.push({
      id,
      type: 'version_drift',
      severity: 'medium',
      detectorId: 'drift-detector',
      ruleId: 'content-or-ref-drift',
      title: 'Version drift detected',
      description: `Detected multiple variants for ${key || 'a skill group'} with different content hashes or source refs.`,
      skills: sorted,
      links: sorted.map(skill => ({
        skillId: skill.id,
        role: roleForDrift(skill),
      })),
      evidence: sorted.map(skill => ({
        slug: skill.slug,
        path: skill.location?.path || skill.local_path || skill.path,
        contentHash: contentHash(skill),
        sourceRef: sourceRef(skill),
      })),
      recommendation: 'Review differences and either keep a pinned version or sync from the central library.',
    });
  }

  return findings;
}

function roleForDrift(skill) {
  const rootType = skill.location?.rootType || skill.root_type;
  if (rootType === 'central_library') return 'central';
  if (rootType === 'project_local') return 'project';
  if (skill.location?.agent || skill.agent) return 'agent';
  return 'local';
}

module.exports = {
  buildSkillIdentityKey,
  buildParticipantIdentityKey,
  chooseCanonical,
  detectDuplicateGroups,
  detectVersionDrift,
  normalizeSourceUrl,
  sourceTrustScore,
  sourceKey,
};
