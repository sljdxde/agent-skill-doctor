'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { buildParticipantIdentityKey, normalizeSourceUrl } = require('./phase2');

function sha256(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

/**
 * Stale age threshold in days. Skills older than this with a remote source
 * are considered potentially outdated.
 */
const STALE_AGE_DAYS = 180;
const STALE_AGE_MS = STALE_AGE_DAYS * 86_400_000;

/**
 * Timeout for a single git ls-remote call (milliseconds).
 */
const LS_REMOTE_TIMEOUT_MS = 15_000;

/**
 * Parse a semver-like version string into a comparable array.
 * Returns null if the string is not a recognizable version.
 * Supports: 1, 1.2, 1.2.3, 1.2.3-beta, v1.2.3
 */
function parseVersion(v) {
  if (!v) return null;
  const match = String(v).trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].+)?$/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2] || '0', 10), parseInt(match[3] || '0', 10)];
}

/**
 * Compare two version strings. Returns positive if a > b, negative if a < b, 0 if equal.
 * Returns 0 if either cannot be parsed.
 */
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return 0;
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] - vb[i];
  }
  return 0;
}

/**
 * Get the source URL from a skill object.
 */
function sourceUrl(skill) {
  return skill.source?.url || skill.source_url || null;
}

/**
 * Get the source type from a skill object.
 */
function sourceType(skill) {
  return skill.source?.type || skill.source_type || 'unknown';
}

/**
 * Get the pinned ref from a skill object.
 */
function sourceRef(skill) {
  return skill.sourceRef || skill.source_ref || skill.source?.ref || null;
}

/**
 * Get the pinned commit from a skill object.
 */
function sourceCommit(skill) {
  return skill.sourceCommit || skill.source_commit || skill.source?.commit || null;
}

/**
 * Get the content hash from a skill object.
 */
function contentHash(skill) {
  return skill.hashes?.contentSha256 || skill.content_hash || skill.contentHash || null;
}

/**
 * Get the modification time as a timestamp (milliseconds).
 */
function modifiedTime(skill) {
  return Date.parse(skill.modifiedAt || skill.modified_at || skill.updatedAt || 0) || 0;
}

/**
 * Check if a URL looks like a git repository URL.
 */
function isGitUrl(url) {
  if (!url) return false;
  return /^https?:\/\/(github|gitlab|bitbucket|gitee)\.com\//i.test(url) ||
         /^git@/i.test(url) ||
         /\.git$/i.test(url);
}

/**
 * Run `git ls-remote` to get the remote HEAD commit for a URL.
 * Returns the commit hash or null on error/timeout.
 * Results are cached per URL to avoid duplicate network calls.
 */
const _lsRemoteCache = new Map();
function gitLsRemoteHead(url) {
  if (_lsRemoteCache.has(url)) return _lsRemoteCache.get(url);
  let result = null;
  try {
    const output = execFileSync('git', ['ls-remote', url, 'HEAD'], {
      encoding: 'utf8',
      timeout: LS_REMOTE_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const line = output.trim().split('\n')[0];
    const match = line.match(/^([0-9a-f]{40})\s+HEAD/);
    if (match) result = match[1];
  } catch {
    // git not installed, network error, private repo, timeout, etc.
    result = null;
  }
  _lsRemoteCache.set(url, result);
  return result;
}

/**
 * Run `git ls-remote` to get the commit for a specific ref.
 * Returns the commit hash or null on error/timeout.
 */
function gitLsRemoteRef(url, ref) {
  const cacheKey = `${url}\t${ref}`;
  if (_lsRemoteCache.has(cacheKey)) return _lsRemoteCache.get(cacheKey);
  let result = null;
  try {
    const output = execFileSync('git', ['ls-remote', url, ref], {
      encoding: 'utf8',
      timeout: LS_REMOTE_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const lines = output.trim().split('\n');
    for (const line of lines) {
      const match = line.match(/^([0-9a-f]{40})\s+\S+/);
      if (match) { result = match[1]; break; }
    }
  } catch {
    result = null;
  }
  _lsRemoteCache.set(cacheKey, result);
  return result;
}

/**
 * Clear the ls-remote cache. Useful for testing.
 */
function clearLsRemoteCache() {
  _lsRemoteCache.clear();
}

function makeFinding(skill, ruleId, severity, title, description, recommendation, extra) {
  const participantKey = buildParticipantIdentityKey([skill]);
  const evidenceText = `${skill.slug || skill.name}: ${ruleId}`;
  const signature = sha256(`${ruleId}:${skill.id || skill.slug || skill.name}`);
  const id = sha256(`${participantKey}:freshness:freshness-detector:${ruleId}:${signature}`);
  return {
    id,
    type: 'freshness',
    severity,
    detectorId: 'freshness-detector',
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
    ...extra,
  };
}

/**
 * Detect freshness (update availability) findings for a list of skills.
 *
 * Offline signals (always evaluated):
 *   - no-update-channel: skill has no source URL, cannot check for updates
 *   - unpinned-source:   skill has a git source URL but no pinned ref or commit
 *   - stale-by-age:      skill with remote source modified too long ago
 *   - version-lower-than-sibling: same source group, another copy has a higher version
 *
 * Online signals (only when options.checkUpstream is true):
 *   - pinned-ref-behind: git ls-remote shows upstream HEAD differs from local commit
 *
 * @param {Array} skills - list of skill objects
 * @param {Object} options - { checkUpstream: boolean }
 * @returns {Array} freshness findings
 */
function detectFreshnessFindings(skills, options = {}) {
  const findings = [];
  const checkUpstream = !!options.checkUpstream;

  // Build source groups for sibling version comparison.
  // Unlike phase2.sourceKey (which includes slug), we group by URL + subdir only,
  // so the same skill with different slugs in different locations still gets compared.
  function versionGroupKey(skill) {
    const url = skill.source?.url || skill.source_url;
    if (!url) return null;
    const subdir = skill.source?.subdir || skill.source_subdir || '';
    return `${normalizeSourceUrl(url)}:${subdir}`;
  }

  const sourceGroups = new Map();
  for (const skill of skills) {
    const key = versionGroupKey(skill);
    if (!key) continue;
    if (!sourceGroups.has(key)) sourceGroups.set(key, []);
    sourceGroups.get(key).push(skill);
  }

  for (const skill of skills) {
    const url = sourceUrl(skill);
    const type = sourceType(skill);
    const ref = sourceRef(skill);
    const commit = sourceCommit(skill);
    const version = skill.version || null;

    // Skip built-in / official skills — they are managed by the agent itself
    if (type === 'builtin') continue;

    // --- Signal 1: no-update-channel ---
    if (!url || type === 'unknown') {
      findings.push(makeFinding(
        skill,
        'no-update-channel',
        'medium',
        'No update channel available',
        `The skill "${skill.slug || skill.name}" has no source URL or registry reference, so it is impossible to check whether an update is available upstream.`,
        'Add a source URL (e.g. a git repository) or registry reference to the skill frontmatter so updates can be tracked.'
      ));
      continue; // No point checking other signals without a source
    }

    // --- Signal 2: unpinned-source ---
    if (!ref && !commit) {
      findings.push(makeFinding(
        skill,
        'unpinned-source',
        'low',
        'Source is not pinned to a ref or commit',
        `The skill "${skill.slug || skill.name}" has a source URL (${url}) but no pinned ref (tag/branch) or commit. It may silently drift from upstream on each install.`,
        'Pin the skill to a specific git tag, branch, or commit hash in the frontmatter to make updates reproducible.'
      ));
    }

    // --- Signal 3: stale-by-age ---
    const mtime = modifiedTime(skill);
    if (mtime > 0 && (Date.now() - mtime) > STALE_AGE_MS) {
      const ageDays = Math.floor((Date.now() - mtime) / 86_400_000);
      findings.push(makeFinding(
        skill,
        'stale-by-age',
        'low',
        'Skill may be outdated (stale by age)',
        `The skill "${skill.slug || skill.name}" was last modified ${ageDays} days ago and has a remote source. It may be behind the upstream version.`,
        `Check the upstream repository (${url}) for newer releases and update the skill if a newer version is available.`
      ));
    }

    // --- Signal 4: version-lower-than-sibling ---
    const key = versionGroupKey(skill);
    if (key && version) {
      const siblings = sourceGroups.get(key) || [];
      const newerSiblings = siblings.filter(s => s !== skill && s.version && compareVersions(s.version, version) > 0);
      if (newerSiblings.length > 0) {
        const maxVersion = newerSiblings.reduce((max, s) => compareVersions(s.version, max) > 0 ? s.version : max, version);
        findings.push(makeFinding(
          skill,
          'version-lower-than-sibling',
          'low',
          'Local copy has a lower version than a sibling',
          `The skill "${skill.slug || skill.name}" is at version ${version}, but another copy from the same source is at version ${maxVersion}. This copy may be outdated.`,
          `Update this skill to version ${maxVersion} to match the newer sibling, or remove the older copy if it is redundant.`
        ));
      }
    }

    // --- Online signal: pinned-ref-behind ---
    if (checkUpstream && isGitUrl(url)) {
      const remoteHead = gitLsRemoteHead(url);
      if (remoteHead && commit) {
        // We have a local commit and a remote HEAD — compare
        if (remoteHead !== commit.toLowerCase()) {
          // If the skill has a ref, check if that ref's commit matches
          let refCommit = null;
          if (ref) refCommit = gitLsRemoteRef(url, ref);
          if (!refCommit || refCommit !== commit.toLowerCase()) {
            findings.push(makeFinding(
              skill,
              'pinned-ref-behind',
              'medium',
              'Skill is behind upstream (commit mismatch)',
              `The skill "${skill.slug || skill.name}" is pinned to commit ${commit.slice(0, 8)}, but the upstream HEAD is ${remoteHead.slice(0, 8)}. An update is available.`,
              `Update the skill from the upstream repository (${url}) to the latest commit ${remoteHead.slice(0, 8)}.`,
              { remoteHead, localCommit: commit }
            ));
          }
        }
      } else if (remoteHead && ref && !commit) {
        // We have a ref but no commit — check if the ref still points to the same commit
        const refCommit = gitLsRemoteRef(url, ref);
        // We can't definitively say it's behind without a local commit to compare,
        // but we can note the current upstream commit for awareness
        // Only report if the skill also looks stale by age (combined signal)
        if (refCommit && mtime > 0 && (Date.now() - mtime) > STALE_AGE_MS) {
          findings.push(makeFinding(
            skill,
            'pinned-ref-behind',
            'medium',
            'Skill may be behind upstream (no commit pin, stale)',
            `The skill "${skill.slug || skill.name}" is pinned to ref "${ref}" but has no commit hash. The upstream ref currently points to ${refCommit.slice(0, 8)}. The skill is also stale by age, so an update is likely available.`,
            `Update the skill from the upstream repository (${url}) and record the commit hash ${refCommit.slice(0, 8)} in the frontmatter.`,
            { remoteRef: refCommit }
          ));
        }
      }
    }
  }

  // Sort: medium severity first, then low
  const severityOrder = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4));
  return findings;
}

module.exports = {
  detectFreshnessFindings,
  parseVersion,
  compareVersions,
  isGitUrl,
  gitLsRemoteHead,
  gitLsRemoteRef,
  clearLsRemoteCache,
  STALE_AGE_DAYS,
};
