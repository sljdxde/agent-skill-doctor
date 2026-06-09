#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { loadJsonRules, scanSkillForRisks } = require('../src/doctor/risk-lite');
const { detectConflicts } = require('../src/doctor/conflict');
const { detectZombies } = require('../src/doctor/zombie');
const { DEFAULT_CONFLICT_RULES } = require('../src/doctor/rules');
const phase2 = require('../src/doctor/phase2');
const { t, dictionaries } = require('../src/doctor/i18n');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.cache', '.DS_Store']);

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function normalizePath(p) {
  return path.resolve(expandHome(p)).replace(/\\/g, '/');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function nl2br(str) {
  return escapeHtml(str).replace(/\n/g, '<br>');
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function slugify(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown-skill';
}

function normalizeText(text) {
  return String(text || '')
    .replace(/^---[\s\S]*?---\s*/m, '')
    .replace(/```[\s\S]*?```/g, block => block.replace(/#.*$/gm, ''))
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAnchor(text) {
  return normalizeText(text).slice(0, 300);
}

function safeReadText(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function isTextLike(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ['.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.js', '.ts', '.py', '.rs', '.sh'].includes(ext);
}

function doctorHome() {
  return expandHome(process.env.AGENT_SKILL_DOCTOR_HOME || '~/.agent-skill-doctor');
}

function loadConfig() {
  const home = doctorHome();
  ensureDir(home);
  ensureDir(path.join(home, 'reports'));
  const candidates = [
    // Central library
    '~/.skills-manager/skills',
    '~/.skills-manager',
    // Agent global directories
    '~/.claude/skills',
    '~/.codex/skills',
    '~/.cursor/skills',
    '~/.opencode/skills',
    '~/.agent/skills',
    '~/.agents/skills',
    '~/.agents/skills-core',
    '~/.windsurf/skills',
    '~/.aider/skills',
    '~/.continue/skills',
    '~/.cody/skills',
    '~/.copilot/skills',
    // Project-local directories
    path.join(process.cwd(), '.claude/skills'),
    path.join(process.cwd(), '.agents/skills'),
    path.join(process.cwd(), '.agent/skills'),
    path.join(process.cwd(), '.windsurf/skills'),
    path.join(process.cwd(), '.cursor/skills'),
    path.join(process.cwd(), '.codex/skills'),
    path.join(process.cwd(), '.opencode/skills'),
  ].map(expandHome).filter(p => {
    try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch { return false; }
  });
  return {
    home,
    dbPath: path.join(home, 'doctor.db'),
    reportsDir: path.join(home, 'reports'),
    scan: { maxDepth: 6 },
    roots: candidates,
  };
}

function openDb(dbPath) {
  ensureDir(path.dirname(dbPath));
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
CREATE TABLE IF NOT EXISTS skill_records (
  id TEXT PRIMARY KEY,
  upstream_skill_id TEXT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  source_type TEXT,
  source_url TEXT,
  source_ref TEXT,
  source_commit TEXT,
  source_tree_sha TEXT,
  local_path TEXT NOT NULL,
  root_type TEXT NOT NULL,
  agent TEXT,
  content_hash TEXT,
  normalized_hash TEXT,
  semantic_fingerprint_json TEXT,
  status TEXT,
  created_at TEXT,
  modified_at TEXT,
  last_seen_at TEXT,
  last_used_at TEXT,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_records_upstream_skill_id ON skill_records(upstream_skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_records_slug ON skill_records(slug);
CREATE INDEX IF NOT EXISTS idx_skill_records_content_hash ON skill_records(content_hash);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  detector_id TEXT NOT NULL,
  rule_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  signature TEXT NOT NULL,
  evidence_json TEXT,
  recommendation TEXT,
  ignored INTEGER NOT NULL DEFAULT 0,
  ignored_reason TEXT,
  ignored_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_type ON findings(type);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity);
CREATE INDEX IF NOT EXISTS idx_findings_ignored ON findings(ignored);

CREATE TABLE IF NOT EXISTS finding_skills (
  finding_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'related',
  added_at TEXT NOT NULL,
  PRIMARY KEY (finding_id, skill_id, role),
  FOREIGN KEY (finding_id) REFERENCES findings(id) ON DELETE CASCADE,
  FOREIGN KEY (skill_id) REFERENCES skill_records(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_finding_skills_skill_id ON finding_skills(skill_id);
CREATE INDEX IF NOT EXISTS idx_finding_skills_finding_id ON finding_skills(finding_id);
CREATE INDEX IF NOT EXISTS idx_finding_skills_added_at ON finding_skills(added_at);

CREATE TABLE IF NOT EXISTS doctor_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  skill_count INTEGER NOT NULL DEFAULT 0,
  finding_count INTEGER NOT NULL DEFAULT 0,
  duplicate_group_count INTEGER NOT NULL DEFAULT 0,
  high_count INTEGER NOT NULL DEFAULT 0,
  critical_count INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL,
  summary_json TEXT
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  format TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  summary_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS duplicate_groups (
  id TEXT PRIMARY KEY,
  strategy TEXT NOT NULL,
  confidence REAL NOT NULL,
  canonical_skill_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (canonical_skill_id) REFERENCES skill_records(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_duplicate_groups_strategy ON duplicate_groups(strategy);
CREATE INDEX IF NOT EXISTS idx_duplicate_groups_canonical_skill_id ON duplicate_groups(canonical_skill_id);

CREATE TABLE IF NOT EXISTS duplicate_group_members (
  group_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'candidate',
  confidence REAL NOT NULL DEFAULT 1.0,
  added_at TEXT NOT NULL,
  PRIMARY KEY (group_id, skill_id),
  FOREIGN KEY (group_id) REFERENCES duplicate_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (skill_id) REFERENCES skill_records(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_duplicate_group_members_skill_id ON duplicate_group_members(skill_id);
CREATE INDEX IF NOT EXISTS idx_duplicate_group_members_added_at ON duplicate_group_members(added_at);
`);
  return db;
}

function parseFrontmatter(text) {
  if (!text || !text.startsWith('---')) return { data: {}, body: text || '', error: null };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text, error: 'frontmatter_missing_closing_delimiter' };
  const raw = text.slice(3, end).trim();
  const body = text.slice(end + 4).trimStart();
  const data = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    value = value.replace(/^["']|["']$/g, '');
    data[key] = value;
  }
  return { data, body, error: null };
}

function findSkillCandidates(dir, root, depth, maxDepth) {
  const out = [];
  if (depth > maxDepth) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  const names = new Set(entries.map(e => e.name));
  const hasSkillMd = names.has('SKILL.md') || names.has('skill.md');
  const hasReadme = names.has('README.md') || names.has('readme.md');
  if (hasSkillMd || (hasReadme && depth > 0)) {
    out.push({ path: normalizePath(dir), root: normalizePath(root), hasSkillMd, hasReadme });
    if (hasSkillMd) return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    out.push(...findSkillCandidates(path.join(dir, entry.name), root, depth + 1, maxDepth));
  }
  return out;
}

function readSkillText(candidatePath) {
  for (const file of ['SKILL.md', 'skill.md', 'README.md', 'readme.md']) {
    const p = path.join(candidatePath, file);
    if (fs.existsSync(p)) return { file, text: safeReadText(p) };
  }
  return { file: null, text: '' };
}

function listFiles(dir, root = dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p, root));
    else if (entry.isFile()) {
      let size = 0;
      try { size = fs.statSync(p).size; } catch {}
      out.push({ path: normalizePath(p), relativePath: path.relative(root, p).replaceAll('\\\\', '/'), sizeBytes: size });
    }
  }
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function computeHashes(dir) {
  const files = listFiles(dir);
  const pieces = [];
  const normalizedTexts = [];
  for (const file of files) {
    let buf;
    try { buf = fs.readFileSync(file.path); } catch { continue; }
    const fileHash = sha256(buf);
    pieces.push(`${file.relativePath}\0${fileHash}`);
    file.hashSha256 = fileHash;
    file.kind = kindForFile(file.relativePath);
    if (isTextLike(file.path)) normalizedTexts.push(normalizeText(buf.toString('utf8')));
  }
  return { files, contentSha256: sha256(pieces.join('\n')), normalizedTextSha256: sha256(normalizedTexts.join('\n')) };
}

function kindForFile(rel) {
  const base = path.basename(rel).toLowerCase();
  if (base === 'skill.md') return 'skill_md';
  if (base === 'readme.md') return 'readme';
  if (/\.(js|ts|py|rs|sh)$/.test(base)) return 'script';
  if (/\.(json|ya?ml|toml)$/.test(base)) return 'config';
  return 'unknown';
}

function rootTypeFor(p) {
  const n = p.replace(/\\/g, '/');
  if (n.includes('/.skills-manager/')) return 'central_library';
  if (n.includes('/.claude/') || n.includes('/.codex/') || n.includes('/.cursor/') || n.includes('/.opencode/') ||
      n.includes('/.agent/') || n.includes('/.windsurf/') || n.includes('/.aider/') ||
      n.includes('/.continue/') || n.includes('/.cody/') || n.includes('/.copilot/')) return 'agent_global';
  if (n.includes('/.agents/')) {
    // ~/.agents/ is global, <cwd>/.agents/ is project-local
    const home = (os.homedir() || '').replace(/\\/g, '/');
    if (n.startsWith(home + '/')) return 'agent_global';
    return 'project_local';
  }
  return 'unknown';
}

function inferAgent(p) {
  const n = p.replace(/\\/g, '/');
  if (n.includes('/.claude/')) return 'claude';
  if (n.includes('/.codex/')) return 'codex';
  if (n.includes('/.cursor/')) return 'cursor';
  if (n.includes('/.opencode/')) return 'opencode';
  if (n.includes('/.windsurf/')) return 'windsurf';
  if (n.includes('/.aider/')) return 'aider';
  if (n.includes('/.continue/')) return 'continue';
  if (n.includes('/.cody/')) return 'cody';
  if (n.includes('/.copilot/')) return 'copilot';
  if (n.includes('/.agents/')) return 'agents';
  if (n.includes('/.agent/')) return 'agent';
  return null;
}

function parseTags(frontmatter) {
  const raw = frontmatter.tags || frontmatter.tag || '';
  if (Array.isArray(raw)) return raw.map(String).map(s => s.trim().toLowerCase()).filter(Boolean);
  return String(raw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function parseManuallyPinned(frontmatter) {
  const v = frontmatter.pinned || frontmatter.pin || frontmatter.keep;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true' || v === '';
  return false;
}

function usageSignalsFor(candidatePath, rootType, agent, modifiedAt, frontmatter) {
  const isAgentGlobal = rootType === 'agent_global';
  const isProjectLocal = rootType === 'project_local';
  const modifiedMs = Date.parse(modifiedAt || 0);
  const recentWindowMs = 90 * 24 * 60 * 60 * 1000;
  return {
    installedInAgents: isAgentGlobal && agent ? [agent] : [],
    installedInProjects: isProjectLocal ? [path.dirname(candidatePath)] : [],
    presetCount: Number(frontmatter.preset_count || frontmatter.presetCount || 0),
    hasRecentModification: modifiedMs > 0 ? Date.now() - modifiedMs <= recentWindowMs : false,
    lastActivityLogAt: frontmatter.last_activity_at || frontmatter.lastActivityLogAt || null,
    manuallyPinned: parseManuallyPinned(frontmatter),
    confidence: isAgentGlobal || isProjectLocal ? 0.6 : 0.3,
  };
}

function inferNameDescription(dir, text, frontmatter) {
  const lines = text.split(/\r?\n/);
  const heading = lines.find(l => /^#\s+/.test(l));
  const name = frontmatter.name || (heading ? heading.replace(/^#\s+/, '').trim() : path.basename(dir));
  let description = frontmatter.description || frontmatter.summary || '';
  if (!description) {
    const bodyLine = lines.map(l => l.trim()).find(l => l && !l.startsWith('#') && !l.startsWith('---') && !l.includes(':'));
    description = bodyLine || '';
  }
  return { name, description };
}

function buildSkillIdentityKey(skill) {
  if (skill.upstreamSkillId) return `upstream:${skill.upstreamSkillId}`;
  if (skill.source.url && skill.slug) return `source:${String(skill.source.url).replace(/\.git$/, '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase()}:${skill.source.subdir || ''}:${skill.slug}`;
  if (skill.location.root && skill.slug) return `path:${normalizePath(skill.location.root)}:${skill.slug}`;
  return `hash:${skill.hashes.contentSha256}:${normalizePath(skill.location.path)}`;
}

function buildParticipantIdentityKey(skills) {
  return sha256(skills.map(buildSkillIdentityKey).sort().join('\n'));
}

function parseSkillCandidate(candidate) {
  const now = nowIso();
  const { file: mainFile, text } = readSkillText(candidate.path);
  const fm = parseFrontmatter(text);
  const { name, description } = inferNameDescription(candidate.path, text, fm.data);
  const slug = slugify(fm.data.id || fm.data.slug || name || path.basename(candidate.path));
  const hashResult = computeHashes(candidate.path);
  const stat = fs.statSync(candidate.path);
  const modifiedAt = stat.mtime?.toISOString?.() || null;
  const rootType = rootTypeFor(candidate.path);
  const agent = inferAgent(candidate.path);
  const skill = {
    id: '', upstreamSkillId: null, name, slug, description,
    source: { type: fm.data.source ? 'git' : 'unknown', url: fm.data.source || fm.data.source_url || null, subdir: fm.data.subdir || null, ref: fm.data.ref || fm.data.version || null, commit: fm.data.commit || null },
    location: { path: candidate.path, root: candidate.root, rootType, agent, isSymlink: false, symlinkTarget: null },
    version: fm.data.version || null, sourceRef: fm.data.ref || null, sourceCommit: fm.data.commit || null, sourceTreeSha: fm.data.tree_sha || null,
    frontmatter: fm.data, tags: parseTags(fm.data), presets: [], agentTargets: [], files: hashResult.files,
    hashes: { contentSha256: hashResult.contentSha256, normalizedTextSha256: hashResult.normalizedTextSha256, semanticFingerprint: {} },
    capabilities: [], usage: usageSignalsFor(candidate.path, rootType, agent, modifiedAt, fm.data),
    createdAt: stat.birthtime?.toISOString?.() || null, modifiedAt, lastSeenAt: now, lastUsedAt: null, status: 'active',
    _scan: { mainFile, text, frontmatterError: fm.error, hasSkillMd: candidate.hasSkillMd, hasReadme: candidate.hasReadme }
  };
  skill.id = sha256(`${buildSkillIdentityKey(skill)}:${normalizePath(skill.location.path)}`);
  return skill;
}

function scanRoots(roots, options = {}) {
  const candidates = new Map();
  for (const raw of roots) {
    const root = normalizePath(raw);
    if (!fs.existsSync(root)) continue;
    for (const c of findSkillCandidates(root, root, 0, options.maxDepth || 6)) candidates.set(c.path, c);
  }
  return [...candidates.values()].map(parseSkillCandidate);
}

function makeFinding(skill, { type, severity, detectorId, ruleId, title, description, issueType, evidenceText, recommendation }) {
  const participantKey = buildParticipantIdentityKey([skill]);
  const evidence = [{ file: skill._scan.mainFile || skill.location.path, text: evidenceText || title, anchor: normalizeAnchor(evidenceText || title) }];
  const signature = sha256(`${issueType}:${evidence[0].file}:${evidence[0].anchor}`);
  const id = sha256(`${participantKey}:${type}:${detectorId}:${ruleId || ''}:${signature}`);
  const at = nowIso();
  return { finding: { id, type, severity, detectorId, ruleId, title, description, signature, evidence, recommendation, ignored: false, createdAt: at, updatedAt: at }, link: { findingId: id, skillId: skill.id, role: 'primary', addedAt: at } };
}

function descriptionQualityScore(skill) {
  const desc = String(skill.description || '').trim();
  if (!desc) return { score: 0, issues: ['missing-description'] };
  const issues = [];
  let score = 60; // has description
  if (desc.length < 20) { score -= 20; issues.push('short-description'); }
  const lower = desc.toLowerCase();
  // Check for trigger/usage condition
  if (!/\b(when|use |trigger|if |run |invoke|install|enable)\b/.test(lower)) { score -= 15; issues.push('no-trigger-condition'); }
  // Check for I/O description
  if (!/\b(input|output|return|result|respond|answer|generate|create|produce)\b/.test(lower)) { score -= 10; issues.push('no-io-description'); }
  // Check for high-risk content in skill without risk description
  const hasRisk = /\b(rm |delete|remove|exec|shell|subprocess|curl|wget|sudo|env|token|key|secret|password|credential)\b/.test(lower);
  const hasRiskDesc = /\b(risk|danger|careful|caution|warning|safe|security|destructive|irreversible)\b/.test(lower);
  if (hasRisk && !hasRiskDesc) { score -= 20; issues.push('risk-not-described'); }
  return { score: Math.max(0, score), issues };
}

function detectPhase1Findings(skill) {
  const out = [];
  if (!skill._scan.hasSkillMd) out.push(makeFinding(skill, { type: 'scan_warning', severity: 'low', detectorId: 'scan-warning-detector', title: 'SKILL.md is missing', description: 'This skill candidate was detected from README.md or directory context, but no SKILL.md file was found.', issueType: 'missing-skill-md', evidenceText: skill.location.path, recommendation: 'Add SKILL.md to make the skill explicit and portable.' }));
  if (skill._scan.frontmatterError) out.push(makeFinding(skill, { type: 'scan_warning', severity: 'medium', detectorId: 'scan-warning-detector', title: 'Frontmatter parse warning', description: `The main skill file has malformed frontmatter: ${skill._scan.frontmatterError}.`, issueType: 'frontmatter-warning', evidenceText: skill._scan.frontmatterError, recommendation: 'Fix YAML frontmatter delimiters and key/value format.' }));

  const dq = descriptionQualityScore(skill);
  if (dq.issues.includes('missing-description')) {
    out.push(makeFinding(skill, { type: 'description_quality', severity: 'medium', detectorId: 'description-quality-detector', title: 'Description is missing', description: 'The skill has no usable description, which makes selection and governance harder.', issueType: 'missing-description', evidenceText: skill.name, recommendation: 'Add a clear description explaining when to use this skill.' }));
  } else {
    if (dq.issues.includes('short-description')) out.push(makeFinding(skill, { type: 'description_quality', severity: 'low', detectorId: 'description-quality-detector', title: 'Description is too short', description: 'The skill description is very short and may not explain trigger conditions or behavior.', issueType: 'short-description', evidenceText: skill.description, recommendation: 'Expand the description with use cases, inputs, outputs, and limitations.' }));
    if (dq.issues.includes('no-trigger-condition')) out.push(makeFinding(skill, { type: 'description_quality', severity: 'info', detectorId: 'description-quality-detector', title: 'No trigger condition in description', description: 'The description does not explain when or how to invoke this skill.', issueType: 'no-trigger-condition', evidenceText: skill.description, recommendation: 'Add trigger conditions (e.g., "when reviewing code", "use this for X").' }));
    if (dq.issues.includes('no-io-description')) out.push(makeFinding(skill, { type: 'description_quality', severity: 'info', detectorId: 'description-quality-detector', title: 'No input/output description', description: 'The description does not explain what the skill produces or returns.', issueType: 'no-io-description', evidenceText: skill.description, recommendation: 'Describe expected inputs, outputs, or side effects.' }));
    if (dq.issues.includes('risk-not-described')) out.push(makeFinding(skill, { type: 'description_quality', severity: 'medium', detectorId: 'description-quality-detector', title: 'High-risk actions without risk description', description: 'The skill appears to contain risky operations (shell, file deletion, credentials) but the description does not mention risks.', issueType: 'risk-not-described', evidenceText: skill.description, recommendation: 'Add risk warnings and safety considerations to the description.' }));
  }
  return { findings: out.map(x => x.finding), links: out.map(x => x.link) };
}

function upsertSkill(db, skill) {
  db.prepare(`INSERT INTO skill_records (id, upstream_skill_id, name, slug, description, source_type, source_url, source_ref, source_commit, source_tree_sha, local_path, root_type, agent, content_hash, normalized_hash, semantic_fingerprint_json, status, created_at, modified_at, last_seen_at, last_used_at, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, slug=excluded.slug, description=excluded.description, source_type=excluded.source_type, source_url=excluded.source_url, source_ref=excluded.source_ref, source_commit=excluded.source_commit, source_tree_sha=excluded.source_tree_sha, local_path=excluded.local_path, root_type=excluded.root_type, agent=excluded.agent, content_hash=excluded.content_hash, normalized_hash=excluded.normalized_hash, semantic_fingerprint_json=excluded.semantic_fingerprint_json, status=excluded.status, modified_at=excluded.modified_at, last_seen_at=excluded.last_seen_at, last_used_at=excluded.last_used_at, raw_json=excluded.raw_json`).run(skill.id, skill.upstreamSkillId || null, skill.name, skill.slug, skill.description || null, skill.source.type, skill.source.url || null, skill.sourceRef || skill.source.ref || null, skill.sourceCommit || skill.source.commit || null, skill.sourceTreeSha || null, skill.location.path, skill.location.rootType, skill.location.agent || null, skill.hashes.contentSha256, skill.hashes.normalizedTextSha256, JSON.stringify(skill.hashes.semanticFingerprint || {}), skill.status || 'unknown', skill.createdAt || null, skill.modifiedAt || null, skill.lastSeenAt, skill.lastUsedAt || null, JSON.stringify(skill));
}

function upsertFinding(db, finding, links) {
  const at = nowIso();
  const createdAt = finding.createdAt || at;
  const updatedAt = finding.updatedAt || at;
  const existing = db.prepare('SELECT id FROM findings WHERE id = ?').get(finding.id);
  if (existing) db.prepare('UPDATE findings SET type=?, severity=?, detector_id=?, rule_id=?, title=?, description=?, signature=?, evidence_json=?, recommendation=?, updated_at=? WHERE id=?').run(finding.type, finding.severity, finding.detectorId, finding.ruleId || null, finding.title, finding.description, finding.signature, JSON.stringify(finding.evidence || []), finding.recommendation || null, updatedAt, finding.id);
  else db.prepare('INSERT INTO findings (id, type, severity, detector_id, rule_id, title, description, signature, evidence_json, recommendation, ignored, ignored_reason, ignored_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)').run(finding.id, finding.type, finding.severity, finding.detectorId, finding.ruleId || null, finding.title, finding.description, finding.signature, JSON.stringify(finding.evidence || []), finding.recommendation || null, createdAt, updatedAt);
  const stmt = db.prepare('INSERT OR IGNORE INTO finding_skills (finding_id, skill_id, role, added_at) VALUES (?, ?, ?, ?)');
  for (const link of links) stmt.run(link.findingId || finding.id, link.skillId, link.role || 'primary', link.addedAt || at);
}

function upsertDuplicateGroup(db, group) {
  const at = nowIso();
  db.prepare('INSERT INTO duplicate_groups (id, strategy, confidence, canonical_skill_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET strategy=excluded.strategy, confidence=excluded.confidence, canonical_skill_id=excluded.canonical_skill_id, updated_at=excluded.updated_at')
    .run(group.id, group.strategy, group.confidence, group.canonicalSkillId || null, at, at);
  const stmt = db.prepare('INSERT OR REPLACE INTO duplicate_group_members (group_id, skill_id, role, confidence, added_at) VALUES (?, ?, ?, ?, ?)');
  for (const member of group.members) stmt.run(group.id, member.skillId, member.role, member.confidence, at);
}

function duplicateFindingFromGroup(group) {
  const at = nowIso();
  return {
    finding: {
      id: sha256(`${phase2.buildParticipantIdentityKey(group.skills)}:duplicate:duplicate-detector:${group.strategy}:${group.id}`),
      type: 'duplicate',
      severity: group.strategy === 'exact_duplicate' ? 'medium' : 'low',
      detectorId: 'duplicate-detector',
      ruleId: group.strategy,
      title: `${group.strategy.replaceAll('_', ' ')} detected`,
      description: `Detected ${group.skills.length} related skills. Canonical suggestion: ${group.canonicalSkillId}.`,
      signature: group.id,
      evidence: [{ file: 'multiple-skills', text: group.skills.map(s => `${s.slug}: ${s.location?.path || s.local_path}`).join('\n'), anchor: group.strategy }],
      recommendation: 'Review the group and keep one canonical skill before disabling duplicates.',
      createdAt: at,
      updatedAt: at,
    },
    links: group.members.map(m => ({ skillId: m.skillId, role: m.role })),
  };
}

function driftFindingToDbFinding(drift) {
  const at = nowIso();
  return {
    finding: {
      id: drift.id,
      type: 'version_drift',
      severity: drift.severity,
      detectorId: drift.detectorId,
      ruleId: drift.ruleId,
      title: drift.title,
      description: drift.description,
      signature: drift.id,
      evidence: [{ file: 'multiple-skills', text: JSON.stringify(drift.evidence, null, 2), anchor: drift.id }],
      recommendation: drift.recommendation,
      createdAt: at,
      updatedAt: at,
    },
    links: drift.links,
  };
}

function runPhase2Analysis(db, skills) {
  const groups = phase2.detectDuplicateGroups(skills);
  const drifts = phase2.detectVersionDrift(skills);
  for (const group of groups) {
    upsertDuplicateGroup(db, group);
    const made = duplicateFindingFromGroup(group);
    upsertFinding(db, made.finding, made.links);
  }
  for (const drift of drifts) {
    const made = driftFindingToDbFinding(drift);
    upsertFinding(db, made.finding, made.links);
  }
  return { groups, drifts };
}

function recordRun(db, run) {
  db.prepare('INSERT INTO doctor_runs (id, started_at, finished_at, status, skill_count, finding_count, duplicate_group_count, high_count, critical_count, config_json, summary_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(run.id, run.startedAt, run.finishedAt, run.status, run.skillCount, run.findingCount, 0, run.highCount, run.criticalCount, JSON.stringify(run.config || {}), JSON.stringify(run.summary || {}));
}

function listSkills(db) { return db.prepare('SELECT * FROM skill_records ORDER BY slug ASC').all(); }
function listFindings(db, includeIgnored) { return db.prepare(`SELECT * FROM findings ${includeIgnored ? '' : 'WHERE ignored = 0'} ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 WHEN 'info' THEN 4 ELSE 5 END, type ASC, title ASC`).all(); }
function listIgnored(db) { return db.prepare('SELECT * FROM findings WHERE ignored = 1 ORDER BY ignored_at DESC').all(); }
function getFindingSkills(db, findingId) { return db.prepare('SELECT fs.*, sr.slug, sr.name, sr.local_path FROM finding_skills fs JOIN skill_records sr ON sr.id = fs.skill_id WHERE fs.finding_id = ? ORDER BY fs.role ASC, sr.slug ASC').all(findingId); }
function setIgnored(db, id, ignored, reason, at) { return db.prepare('UPDATE findings SET ignored=?, ignored_reason=?, ignored_at=?, updated_at=? WHERE id=?').run(ignored ? 1 : 0, ignored ? (reason || null) : null, ignored ? at : null, at, id).changes || 0; }
function listFindingSkills(db) { return db.prepare('SELECT * FROM finding_skills ORDER BY finding_id ASC, role ASC, skill_id ASC').all(); }
function listDuplicateGroups(db) { return db.prepare('SELECT * FROM duplicate_groups ORDER BY confidence DESC, strategy ASC').all(); }
function listDuplicateGroupMembers(db) { return db.prepare('SELECT * FROM duplicate_group_members ORDER BY group_id ASC, role ASC, skill_id ASC').all(); }

function buildReportData(db, includeIgnored) {
  const skills = listSkills(db);
  const rows = listFindings(db, includeIgnored);
  const findings = rows.map(row => ({ id: row.id, type: row.type, severity: row.severity, detectorId: row.detector_id, ruleId: row.rule_id, title: row.title, description: row.description, signature: row.signature, evidence: JSON.parse(row.evidence_json || '[]'), recommendation: row.recommendation, ignored: !!row.ignored, ignoredReason: row.ignored_reason, ignoredAt: row.ignored_at, createdAt: row.created_at, updatedAt: row.updated_at, skills: getFindingSkills(db, row.id) }));
  const bySeverity = {}, byType = {};
  for (const f of findings) { bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1; byType[f.type] = (byType[f.type] || 0) + 1; }
  const duplicateGroups = listDuplicateGroups(db);
  const duplicateGroupMembers = listDuplicateGroupMembers(db);
  const findingSkills = listFindingSkills(db);
  const scanDirs = [...new Set(skills.map(s => {
    const raw = typeof s.raw_json === 'string' ? JSON.parse(s.raw_json) : (s.raw_json || {});
    return raw.location?.root || '';
  }).filter(Boolean))].length;

  const summary = {
    scanDirs,
    totalSkills: skills.length,
    totalFindings: findings.length,
    duplicateGroups: duplicateGroups.length,
    versionDriftFindings: findings.filter(f => f.type === 'version_drift').length,
    riskFindings: findings.filter(f => f.type === 'risk').length,
    conflictFindings: findings.filter(f => f.type === 'conflict').length,
    zombieCandidates: findings.filter(f => f.type === 'zombie').length,
    descriptionQualityFindings: findings.filter(f => f.type === 'description_quality').length,
    duplicateFindings: findings.filter(f => f.type === 'duplicate').length,
    ignoredFindings: rows.filter(row => row.ignored).length,
    bySeverity,
    byType,
  };
  return { summary, skills, findings, findingSkills, duplicateGroups, duplicateGroupMembers, optimizationPlan: {} };
}

function renderMarkdown(data, lang) {
  const L = (key, ...args) => t(key, lang || 'en', ...args);
  const lines = [
    `# ${L('report.title')}`,
    '',
    `## ${L('report.summary')}`,
    '',
    `- ${L('report.totalSkills')}: ${data.summary.totalSkills}`,
    `- ${L('report.totalFindings')}: ${data.summary.totalFindings}`,
    `- ${L('report.duplicateGroups')}: ${data.summary.duplicateGroups}`,
    `- ${L('report.versionDriftFindings')}: ${data.summary.versionDriftFindings}`,
    `- ${L('report.conflictFindings')}: ${data.summary.conflictFindings}`,
    `- ${L('report.riskFindings')}: ${data.summary.riskFindings}`,
    `- ${L('report.zombieCandidates')}: ${data.summary.zombieCandidates}`,
    `- ${L('report.ignoredFindings')}: ${data.summary.ignoredFindings}`,
    `- ${L('report.bySeverity')}: ${JSON.stringify(data.summary.bySeverity)}`,
    `- ${L('report.byType')}: ${JSON.stringify(data.summary.byType)}`,
    '',
    `## ${L('report.criticalRisks')}`,
    '',
  ];
  const criticalRisks = data.findings.filter(f => f.type === 'risk' && f.severity === 'critical');
  if (!criticalRisks.length) lines.push(L('report.noCriticalRisks'), '');
  for (const f of criticalRisks) lines.push(`- \`${f.id}\` ${f.title}`, '');
  lines.push(`## ${L('report.duplicateGroupsSection')}`, '');
  if (!data.duplicateGroups.length) lines.push(L('report.noDuplicateGroups'), '');
  for (const group of data.duplicateGroups) lines.push(`- \`${group.id}\` ${group.strategy} confidence=${group.confidence}`);
  lines.push('', `## ${L('report.findings')}`, '');
  if (!data.findings.length) lines.push(L('report.noFindings'), '');
  for (const f of data.findings) {
    lines.push(`### ${t(`severity.${f.severity}`, lang)} - ${f.title}`, '', `- ${L('report.id')}: \`${f.id}\``, `- ${L('report.type')}: \`${f.type}\``, `- ${L('report.detector')}: \`${f.detectorId}\``);
    if (f.ignored) lines.push(`- ${L('html.ignored')}: yes (${f.ignoredReason || 'no reason'})`);
    if (f.skills?.length) lines.push(`- Skills: ${f.skills.map(s => `\`${s.slug}\``).join(', ')}`);
    lines.push('', f.description, '');
    if (f.recommendation) lines.push(`${L('report.recommendation')}: ${f.recommendation}`, '');
  }
  lines.push(`## ${L('report.skills')}`, '');
  for (const s of data.skills) lines.push(`- \`${s.slug}\` - ${s.name} - ${s.local_path}`);
  lines.push('');
  return lines.join('\n');
}

function renderHtml(data, lang, reportPath) {
  const severityColors = { critical: '#dc2626', high: '#ea580c', medium: '#ca8a04', low: '#2563eb', info: '#6b7280' };
  const totalForBar = data.summary.totalFindings || 1;

  // Dual-language helper: renders both en and zh spans
  const D = (key, ...args) => {
    const enText = escapeHtml(t(key, 'en', ...args));
    const zhText = escapeHtml(t(key, 'zh', ...args));
    if (enText === zhText) return enText;
    return `<span data-lang="en">${enText}</span><span data-lang="zh">${zhText}</span>`;
  };

  // Dual-language helper with newline-to-<br> conversion for <p> tags
  const Dn = (key, ...args) => {
    const enText = nl2br(t(key, 'en', ...args));
    const zhText = nl2br(t(key, 'zh', ...args));
    if (enText === zhText) return enText;
    return `<span data-lang="en">${enText}</span><span data-lang="zh">${zhText}</span>`;
  };

  // Translate finding title
  const translateTitle = (title) => {
    const key = `finding.${title}`;
    const enText = t(key, 'en');
    const zhText = t(key, 'zh');
    const en = enText === key ? title : enText;
    const zh = zhText === key ? title : zhText;
    if (en === zh) return escapeHtml(en);
    return `<span data-lang="en">${escapeHtml(en)}</span><span data-lang="zh">${escapeHtml(zh)}</span>`;
  };

  // Tooltip helper: renders a ? icon with hover tooltip
  const tooltip = (titleKey, textKey) => {
    return `<span class="tip-wrap"><span class="tip-icon">?</span><span class="tip-box"><strong>${D(titleKey)}</strong><br>${Dn(textKey)}</span></span>`;
  };

  // Skill classification
  const OFFICIAL_ORGS = /github\.com\/(anthropics|openai|github|google-gemini)\//i;
  const GITHUB_URL = /github\.com\//i;

  function classifySkill(skill) {
    const raw = typeof skill.raw_json === 'string' ? JSON.parse(skill.raw_json) : (skill.raw_json || {});
    const sourceUrl = raw.source?.url || skill.source_url || '';
    const rootType = raw.location?.rootType || skill.root_type || '';
    const agent = raw.location?.agent || skill.agent || '';

    if (OFFICIAL_ORGS.test(sourceUrl)) return 'official';
    if (rootType === 'agent_global') return 'plugin';
    if (rootType === 'project_local') return 'standalone';
    if (GITHUB_URL.test(sourceUrl)) return 'thirdParty';
    return 'unknown';
  }

  // Build scan overview data
  const skills = (data.skills || []).map(s => {
    const raw = typeof s.raw_json === 'string' ? JSON.parse(s.raw_json) : (s.raw_json || {});
    return {
      name: s.name || raw.name || s.slug || '-',
      slug: s.slug || raw.slug || '-',
      path: s.local_path || raw.location?.path || '',
      root: raw.location?.root || '',
      rootType: raw.location?.rootType || s.root_type || '',
      agent: raw.location?.agent || s.agent || '',
      sourceUrl: raw.source?.url || s.source_url || '',
      description: s.description || raw.description || '',
      classification: classifySkill(s),
    };
  });

  // Group skills by classification
  const classOrder = ['official', 'plugin', 'standalone', 'thirdParty', 'unknown'];
  const skillsByClass = {};
  for (const cls of classOrder) skillsByClass[cls] = [];
  for (const skill of skills) skillsByClass[skill.classification].push(skill);

  // Group skills by root directory
  const skillsByRoot = {};
  for (const skill of skills) {
    const root = skill.root || '(unknown root)';
    if (!skillsByRoot[root]) skillsByRoot[root] = { rootType: skill.rootType, agent: skill.agent, skills: [] };
    skillsByRoot[root].skills.push(skill);
  }

  // Build scan overview HTML
  const classColors = { official: '#10b981', plugin: '#8b5cf6', standalone: '#3b82f6', thirdParty: '#f59e0b', unknown: '#6b7280' };
  const rootTypeLabel = (rt) => {
    if (rt === 'central_library') return D('html.rootType.central');
    if (rt === 'agent_global') return D('html.rootType.global');
    if (rt === 'project_local') return D('html.rootType.project');
    return rt || '-';
  };
  const classCounts = classOrder.map(cls => {
    const count = skillsByClass[cls].length;
    return count > 0 ? `<span class="legend-item"><span class="dot" style="background:${classColors[cls]}"></span>${D(`html.${cls}`)} (${count})</span>` : '';
  }).filter(Boolean).join(' ');

  const sortedRoots = Object.keys(skillsByRoot).sort();
  const rootCards = sortedRoots.map(root => {
    const group = skillsByRoot[root];
    const agentTag = group.agent ? `<span class="tag">${escapeHtml(t(`agent.${group.agent}`, lang, group.agent))}</span>` : '';
    const typeTag = `<span class="tag">${rootTypeLabel(group.rootType)}</span>`;
    const tableRows = group.skills.map(s => {
      const clsLabel = D(`html.${s.classification}`);
      const srcCell = s.sourceUrl ? escapeHtml(s.sourceUrl) : clsLabel;
      return `<tr><td><span class="badge" style="background:${classColors[s.classification]};font-size:0.65rem;padding:0.1rem 0.4rem">${clsLabel}</span></td><td class="skill-name">${escapeHtml(s.name)}</td><td>${srcCell}</td><td>${escapeHtml(s.description || '-').substring(0, 80)}</td></tr>`;
    }).join('');
    const table = `<table class="skill-table"><thead><tr><th>${D('report.type')}</th><th>${D('report.name')}</th><th>${D('html.source')}</th><th>${D('report.description')}</th></tr></thead><tbody>${tableRows}</tbody></table>`;
    return `<details class="root-card"><summary><span class="root-path">${escapeHtml(root)}</span>${agentTag}${typeTag}<span class="tag">${group.skills.length}</span></summary><div class="root-body">${table}</div></details>`;
  }).join('\n');

  const scanOverviewHtml = `
    <div class="scan-class-legend">${classCounts}</div>
    ${rootCards || `<p>${D('html.noSkills')}</p>`}
  `;

  // Summary cards with collapsible details and tooltips
  const scanRootCount = skillsByRoot ? Object.keys(skillsByRoot).length : 0;
  const cardDefs = [
    { key: 'report.scanDirs', descKey: 'dashboard.scanDirs.desc', value: scanRootCount, color: '#0ea5e9', tooltipTitle: null, tooltipText: null, filterFn: null },
    { key: 'report.scanSkills', descKey: 'dashboard.scanSkills.desc', value: data.summary.totalSkills, color: '#3b82f6', tooltipTitle: null, tooltipText: null, filterFn: null },
    { key: 'report.totalFindings', descKey: 'dashboard.totalFindings.desc', value: data.summary.totalFindings, color: '#8b5cf6', tooltipTitle: null, tooltipText: null, filterFn: null },
    { key: 'report.riskFindings', descKey: 'dashboard.riskFindings.desc', value: data.summary.riskFindings, color: '#ef4444', tooltipTitle: 'tooltip.risk.title', tooltipText: 'tooltip.risk.text', filterFn: f => f.type === 'risk' },
    { key: 'report.zombieCandidates', descKey: 'dashboard.zombieCandidates.desc', value: data.summary.zombieCandidates, color: '#f59e0b', tooltipTitle: 'tooltip.zombie.title', tooltipText: 'tooltip.zombie.text', filterFn: f => f.type === 'zombie' },
    { key: 'report.descriptionQualityFindings', descKey: 'dashboard.descriptionQualityFindings.desc', value: data.summary.descriptionQualityFindings, color: '#a855f7', tooltipTitle: 'tooltip.descriptionQuality.title', tooltipText: 'tooltip.descriptionQuality.text', filterFn: f => f.type === 'description_quality' },
    { key: 'report.duplicateFindings', descKey: 'dashboard.duplicateFindings.desc', value: data.summary.duplicateFindings, color: '#6366f1', tooltipTitle: 'tooltip.duplicate.title', tooltipText: 'tooltip.duplicate.text', filterFn: f => f.type === 'duplicate' },
    { key: 'report.versionDriftFindings', descKey: 'dashboard.versionDriftFindings.desc', value: data.summary.versionDriftFindings, color: '#14b8a6', tooltipTitle: 'tooltip.versionDrift.title', tooltipText: 'tooltip.versionDrift.text', filterFn: f => f.type === 'version_drift' },
    { key: 'report.conflictFindings', descKey: 'dashboard.conflictFindings.desc', value: data.summary.conflictFindings, color: '#10b981', tooltipTitle: 'tooltip.conflict.title', tooltipText: 'tooltip.conflict.text', filterFn: f => f.type === 'conflict' },
  ];

  const summaryCards = cardDefs.map(c => {
    const tip = c.tooltipTitle ? tooltip(c.tooltipTitle, c.tooltipText) : '';
    // Build collapsible detail list for this card type
    let detailSection = '';
    if (c.filterFn) {
      const items = data.findings.filter(c.filterFn);
      if (items.length > 0) {
        const rows = items.map(f => {
          const skills = (f.skills || []).map(s => escapeHtml(s.slug)).join(', ');
          return `<div class="card-item"><span class="badge badge-${f.severity}" style="font-size:0.6rem;padding:0.1rem 0.35rem">${D(`severity.${f.severity}`)}</span> ${translateTitle(f.title)} <span class="card-item-skills">${skills ? `[${skills}]` : ''}</span></div>`;
        }).join('');
        detailSection = `<details class="card-details"><summary>${D('html.expandDetails')}</summary><div class="card-detail-list">${rows}</div></details>`;
      }
    } else if (c.key === 'report.zombieCandidates') {
      detailSection = `<div class="card-detail"><strong>${D('tooltip.zombie.formula')}</strong><br><code>${Dn('tooltip.zombie.formulaText')}</code></div>`;
    } else if (c.key === 'report.scanDirs' && skillsByRoot) {
      const dirList = Object.keys(skillsByRoot).sort().map(r => `<div class="card-item"><code>${escapeHtml(r)}</code> <span class="card-item-skills">(${skillsByRoot[r].skills.length})</span></div>`).join('');
      detailSection = `<details class="card-details"><summary>${D('html.expandDetails')}</summary><div class="card-detail-list">${dirList}</div></details>`;
    }
    const cardContent = `<div class="stat-value">${c.value}</div><div class="stat-label">${D(c.key)} ${tip}</div><div class="stat-desc">${Dn(c.descKey)}</div>${detailSection}`;
    return `<div class="stat-card" style="border-left:4px solid ${c.color}">${cardContent}</div>`;
  }).join('\n');

  // Severity bar
  const severityBar = ['critical', 'high', 'medium', 'low', 'info'].map(sev => {
    const count = data.summary.bySeverity[sev] || 0;
    const pct = (count / totalForBar * 100).toFixed(1);
    return count > 0 ? `<div class="bar-seg bar-${sev}" style="width:${pct}%" title="${escapeHtml(t(`severity.${sev}`, 'en'))}/${escapeHtml(t(`severity.${sev}`, 'zh'))}: ${count}"></div>` : '';
  }).join('');

  // Severity legend
  const severityLegend = ['critical', 'high', 'medium', 'low', 'info'].map(sev => {
    const count = data.summary.bySeverity[sev] || 0;
    return `<span class="legend-item"><span class="dot" style="background:${severityColors[sev]}"></span>${D(`severity.${sev}`)} (${count})</span>`;
  }).join(' ');

  // Remediation path — prioritized roadmap with specific recommendations
  const reportPathForPrompt = reportPath ? reportPath.replace(/\\/g, '/') : '';
  const pathHintEn = reportPathForPrompt ? ` The diagnostic report is at: ${reportPathForPrompt}` : '';
  const pathHintZh = reportPathForPrompt ? ` 诊断报告路径：${reportPathForPrompt}` : '';

  // Helper: build skill info map
  const skillInfoMap = {};
  for (const s of data.skills) skillInfoMap[s.id] = { name: s.name || s.slug, slug: s.slug, path: s.local_path || '' };

  // Step 1: Conflicts
  const conflictFindings = data.findings.filter(f => f.type === 'conflict');
  // Step 2: Version drift + duplicates — build specific keep/remove recommendations
  const driftFindings = data.findings.filter(f => f.type === 'version_drift');
  const dupGroups = data.duplicateGroups || [];
  const dupMembers = data.duplicateGroupMembers || [];

  // For each duplicate group, recommend which to keep
  const dupRecommendations = dupGroups.map(g => {
    const members = dupMembers.filter(m => m.group_id === g.id).map(m => ({
      ...m, ...(skillInfoMap[m.skill_id] || { name: m.skill_id, slug: '', path: '' })
    }));
    // Heuristic: prefer agent_global > central_library > project_local; prefer canonical role
    const rootPriority = { agent_global: 0, central_library: 1, project_local: 2, unknown: 3 };
    const sorted = members.sort((a, b) => {
      const skillA = data.skills.find(s => s.id === a.skill_id);
      const skillB = data.skills.find(s => s.id === b.skill_id);
      const rtA = rootPriority[skillA?.root_type] ?? 3;
      const rtB = rootPriority[skillB?.root_type] ?? 3;
      if (a.role === 'canonical' && b.role !== 'canonical') return -1;
      if (b.role === 'canonical' && a.role !== 'canonical') return 1;
      return rtA - rtB;
    });
    const keep = sorted[0];
    const remove = sorted.slice(1);
    return { group: g, keep, remove, members: sorted };
  });

  // Step 3: Zombies — group by severity
  const zombieFindings = data.findings.filter(f => f.type === 'zombie');
  const zombieBySkill = {};
  for (const f of zombieFindings) {
    for (const s of (f.skills || [])) {
      if (!zombieBySkill[s.slug]) zombieBySkill[s.slug] = { finding: f, skill: s };
    }
  }
  const zombieHigh = Object.values(zombieBySkill).filter(z => ['critical', 'high'].includes(z.finding.severity));
  const zombieMedium = Object.values(zombieBySkill).filter(z => z.finding.severity === 'medium');
  const zombieLow = Object.values(zombieBySkill).filter(z => z.finding.severity === 'low');

  // Step 4: Description quality
  const dqFindings = data.findings.filter(f => f.type === 'description_quality');
  // Step 5: Risk (informational only)
  const riskFindings = data.findings.filter(f => f.type === 'risk');

  // Build remediation path HTML
  const stepStyle = 'padding:0.4rem 0.75rem;border-radius:6px;font-size:0.85rem;margin-bottom:0.5rem';

  let pathHtml = '';

  // Step 1: Conflicts
  const conflictCount = conflictFindings.length;
  pathHtml += `<div style="${stepStyle};background:${conflictCount > 0 ? 'var(--c-critical)' : '#10b981'}22;border-left:4px solid ${conflictCount > 0 ? 'var(--c-critical)' : '#10b981'}">
    <strong>${lang === 'zh' ? '第 1 步：冲突检测' : 'Step 1: Conflict Detection'}</strong> <span class="tag">${conflictCount}</span><br>
    <span style="color:var(--muted);font-size:0.8rem">${conflictCount === 0 ? (lang === 'zh' ? '无冲突，技能间指令一致。' : 'No conflicts found. Skills have consistent instructions.') : (lang === 'zh' ? '存在冲突指令，需要选择保留哪一方。' : 'Conflicting instructions found. Choose which to keep.')}</span>
  </div>`;

  // Step 2: Duplicates + Version Drift
  const dupDriftCount = dupRecommendations.length + driftFindings.length;
  let dupDriftDetail = '';
  if (dupDriftCount > 0) {
    for (const rec of dupRecommendations) {
      const strat = { exact_duplicate: lang === 'zh' ? '完全重复' : 'Exact duplicate', same_source_duplicate: lang === 'zh' ? '同源重复' : 'Same source', same_name_duplicate: lang === 'zh' ? '同名重复' : 'Same name' }[rec.group.strategy] || rec.group.strategy;
      dupDriftDetail += `<div style="margin:0.5rem 0;padding:0.5rem;background:var(--bg);border-radius:6px;font-size:0.8rem">
        <strong>${strat}</strong> (${lang === 'zh' ? '置信度' : 'Confidence'}: ${rec.group.confidence})<br>`;
      for (const m of rec.members) {
        const isKeep = m === rec.keep;
        dupDriftDetail += `<div style="margin:0.2rem 0">${isKeep ? '<span style="color:#10b981;font-weight:700">&#10003; ' + (lang === 'zh' ? '保留' : 'KEEP') + '</span>' : '<span style="color:#ef4444;font-weight:700">&#10007; ' + (lang === 'zh' ? '移除' : 'REMOVE') + '</span>'} <code>${escapeHtml(m.slug || m.name)}</code> <small style="color:var(--muted)">${escapeHtml(m.path)}</small></div>`;
      }
      dupDriftDetail += `</div>`;
    }
    for (const f of driftFindings) {
      const driftSkills = (f.skills || []).map(s => ({ ...s, ...(skillInfoMap[s.id] || {}) }));
      // Prefer agent_global version
      const sorted = driftSkills.sort((a, b) => {
        const rtA = a.root_type === 'agent_global' ? 0 : 1;
        const rtB = b.root_type === 'agent_global' ? 0 : 1;
        return rtA - rtB;
      });
      dupDriftDetail += `<div style="margin:0.5rem 0;padding:0.5rem;background:var(--bg);border-radius:6px;font-size:0.8rem">
        <strong>${lang === 'zh' ? '版本漂移' : 'Version Drift'}</strong>: <code>${escapeHtml(sorted[0]?.slug || '')}</code><br>`;
      for (const s of sorted) {
        const isKeep = s === sorted[0];
        dupDriftDetail += `<div style="margin:0.2rem 0">${isKeep ? '<span style="color:#10b981;font-weight:700">&#10003; ' + (lang === 'zh' ? '保留' : 'KEEP') + '</span>' : '<span style="color:#ef4444;font-weight:700">&#10007; ' + (lang === 'zh' ? '移除' : 'REMOVE') + '</span>'} <code>${escapeHtml(s.slug || s.name)}</code> <small style="color:var(--muted)">${escapeHtml(s.path || s.local_path || '')}</small></div>`;
      }
      dupDriftDetail += `</div>`;
    }
  }
  pathHtml += `<div style="${stepStyle};background:${dupDriftCount > 0 ? '#f59e0b' : '#10b981'}22;border-left:4px solid ${dupDriftCount > 0 ? '#f59e0b' : '#10b981'}">
    <strong>${lang === 'zh' ? '第 2 步：重复技能 & 版本漂移' : 'Step 2: Duplicates & Version Drift'}</strong> <span class="tag">${dupDriftCount}</span><br>
    <span style="color:var(--muted);font-size:0.8rem">${dupDriftCount === 0 ? (lang === 'zh' ? '无重复或漂移。' : 'No duplicates or drift found.') : (lang === 'zh' ? '保留推荐版本，移除冗余副本。' : 'Keep recommended versions, remove redundant copies.')}</span>
    ${dupDriftDetail ? `<details style="margin-top:0.5rem"><summary style="cursor:pointer;font-size:0.8rem;color:var(--muted)">${lang === 'zh' ? '查看详情' : 'View details'}</summary>${dupDriftDetail}</details>` : ''}
  </div>`;

  // Step 3: Zombies
  const zombieTotal = zombieFindings.length;
  let zombieDetail = '';
  if (zombieTotal > 0) {
    const showZombies = [...zombieHigh, ...zombieMedium, ...zombieLow].slice(0, 15);
    zombieDetail = showZombies.map(z => {
      const desc = z.finding.description || '';
      const scoreMatch = desc.match(/[\d.]+/);
      const score = scoreMatch ? scoreMatch[0] : '?';
      return `<div style="margin:0.2rem 0;font-size:0.8rem"><span class="badge badge-${z.finding.severity}" style="font-size:0.6rem;padding:0.1rem 0.35rem">${D(`severity.${z.finding.severity}`)}</span> <code>${escapeHtml(z.skill?.slug || '')}</code> (score: ${score})</div>`;
    }).join('');
    if (zombieTotal > 15) zombieDetail += `<div style="font-size:0.75rem;color:var(--muted)">... ${lang === 'zh' ? '还有' : 'and'} ${zombieTotal - 15} ${lang === 'zh' ? '个' : 'more'}</div>`;
  }
  pathHtml += `<div style="${stepStyle};background:${zombieTotal > 0 ? '#f59e0b' : '#10b981'}22;border-left:4px solid ${zombieTotal > 0 ? '#f59e0b' : '#10b981'}">
    <strong>${lang === 'zh' ? '第 3 步：僵尸技能' : 'Step 3: Zombie Skills'}</strong> <span class="tag">${zombieTotal}</span><br>
    <span style="color:var(--muted);font-size:0.8rem">${zombieTotal === 0 ? (lang === 'zh' ? '无僵尸技能。' : 'No zombie skills found.') : (lang === 'zh' ? '优先清理高分僵尸，低分的可暂保留。' : 'Prioritize high-score zombies. Low-score ones can be kept for now.')}</span>
    ${zombieDetail ? `<details style="margin-top:0.5rem"><summary style="cursor:pointer;font-size:0.8rem;color:var(--muted)">${lang === 'zh' ? '查看详情' : 'View details'}</summary>${zombieDetail}</details>` : ''}
  </div>`;

  // Step 4: Description quality
  const dqCount = dqFindings.length;
  pathHtml += `<div style="${stepStyle};background:${dqCount > 0 ? '#a855f7' : '#10b981'}22;border-left:4px solid ${dqCount > 0 ? '#a855f7' : '#10b981'}">
    <strong>${lang === 'zh' ? '第 4 步：描述质量' : 'Step 4: Description Quality'}</strong> <span class="tag">${dqCount}</span><br>
    <span style="color:var(--muted);font-size:0.8rem">${dqCount === 0 ? (lang === 'zh' ? '所有技能描述质量合格。' : 'All skill descriptions pass quality check.') : (lang === 'zh' ? '可交给 Agent 自动补充描述，优先级较低。' : 'Can be auto-improved by Agent. Lower priority.')}</span>
  </div>`;

  // Step 5: Risk (informational)
  const riskCount = riskFindings.length;
  pathHtml += `<div style="${stepStyle};background:#6b728022;border-left:4px solid #6b7280">
    <strong>${lang === 'zh' ? '第 5 步：风险发现（仅供参考）' : 'Step 5: Risk Findings (Informational)'}</strong> <span class="tag">${riskCount}</span><br>
    <span style="color:var(--muted);font-size:0.8rem">${riskCount === 0 ? (lang === 'zh' ? '无风险发现。' : 'No risk findings.') : (lang === 'zh' ? '风险是技能本身需要的权限，无需修复，仅作标注。' : 'Risks are inherent permissions required by skills. No fix needed, just awareness.')}</span>
  </div>`;

  // Agent prompt for duplicates/drift cleanup
  let dupDriftAgentPrompt = '';
  if (dupDriftCount > 0) {
    const removeList = [];
    for (const rec of dupRecommendations) {
      for (const m of rec.remove) removeList.push(m.path || m.slug || m.name);
    }
    for (const f of driftFindings) {
      const driftSkills = (f.skills || []).sort((a, b) => (a.root_type === 'agent_global' ? 0 : 1) - (b.root_type === 'agent_global' ? 0 : 1));
      for (const s of driftSkills.slice(1)) removeList.push(s.path || s.local_path || s.slug);
    }
    if (removeList.length > 0) {
      const promptEn = `Please remove the following redundant skill copies:${pathHintEn}\n\nRemove these paths:\n${removeList.map(p => `- ${p}`).join('\n')}\n\nKeep the recommended versions listed in the diagnostic report.`;
      const promptZh = `请移除以下冗余技能副本：${pathHintZh}\n\n移除以下路径：\n${removeList.map(p => `- ${p}`).join('\n')}\n\n保留诊断报告中推荐的版本。`;
      dupDriftAgentPrompt = `<div class="prompt-block"><pre class="prompt"><span data-lang="en">${escapeHtml(promptEn)}</span><span data-lang="zh">${escapeHtml(promptZh)}</span></pre><button class="copy-btn" onclick="copyPrompt(this)">${D('fix.copyAgentPrompt')}</button></div>`;
    }
  }

  const remediationPathHtml = `<div style="margin-bottom:1.5rem">${pathHtml}</div>${dupDriftAgentPrompt}`;

  // Per-finding detail (grouped by type)
  const findingsByType = {};
  for (const f of data.findings) {
    if (!findingsByType[f.type]) findingsByType[f.type] = {};
    const skillSlugs = (f.skills || []).map(s => s.slug);
    if (skillSlugs.length === 0) skillSlugs.push('<unknown>');
    for (const slug of skillSlugs) {
      if (!findingsByType[f.type][slug]) findingsByType[f.type][slug] = [];
      findingsByType[f.type][slug].push(f);
    }
  }

  const perFindingHtml = data.findings.length === 0
    ? `<p>${D('fix.noRisks')}</p>`
    : Object.entries(findingsByType).map(([type, skillMap]) => {
        const allFindings = Object.values(skillMap).flat();
        const count = allFindings.length;
        const skillRows = Object.entries(skillMap).map(([slug, findings]) => {
          const findingItems = findings.map(f => {
            const evidenceList = (f.evidence || []).map(e => `<small style="color:var(--muted)">${escapeHtml(e.file || '')}${e.lineStart ? ':' + e.lineStart : ''}</small>`).join(', ');
            return `<li><span class="badge badge-${f.severity}" style="font-size:0.6rem;padding:0.1rem 0.35rem">${D(`severity.${f.severity}`)}</span> ${translateTitle(f.title)} — ${escapeHtml(f.description || '')} ${evidenceList}</li>`;
          }).join('');
          return `<div class="card-item"><strong>${escapeHtml(slug)}</strong><ul style="margin:0.25rem 0 0.5rem 1.5rem">${findingItems}</ul></div>`;
        }).join('');
        const agentLines = Object.entries(skillMap).map(([slug, findings]) => {
          const detailLines = findings.map(f =>
            `  - [${f.severity}] ${f.title}: ${f.description || ''}${f.recommendation ? ' | ' + f.recommendation : ''}`
          ).join('\n');
          return `技能: ${slug}\n${detailLines}`;
        }).join('\n\n');
        const agentLinesEn = Object.entries(skillMap).map(([slug, findings]) => {
          const detailLines = findings.map(f =>
            `  - [${f.severity}] ${f.title}: ${f.description || ''}${f.recommendation ? ' | ' + f.recommendation : ''}`
          ).join('\n');
          return `Skill: ${slug}\n${detailLines}`;
        }).join('\n\n');
        return `
    <details class="finding-card">
      <summary>
        <span class="tag">${D(`type.${type}`)}</span>
        <span class="finding-title">${D(`guide.${type}.title`)}</span>
        <span class="tag">${count}</span>
      </summary>
      <div class="finding-body">
        ${skillRows}
        <div class="fix-versions">
          <div class="fix-ver">
            <h4>${D('fix.humanVersion')}</h4>
            <pre class="steps">${D(`guide.${type}.steps`)}</pre>
          </div>
          <div class="fix-ver">
            <h4>${D('fix.agentVersion')}</h4>
            <div class="prompt-block">
              <pre class="prompt"><span data-lang="en">${escapeHtml(`Please fix all ${type} issues:${pathHintEn}\n\n${agentLinesEn}`)}</span><span data-lang="zh">${escapeHtml(`请修复以下 ${type} 类型的所有问题：${pathHintZh}\n\n${agentLines}`)}</span></pre>
              <button class="copy-btn" onclick="copyPrompt(this)">${D('fix.copyAgentPrompt')}</button>
            </div>
          </div>
        </div>
      </div>
    </details>`;
      }).join('\n');

  // Findings (risk list)
  const findingsHtml = data.findings.map(f => {
    const skillsList = (f.skills || []).map(s => `<code>${escapeHtml(s.slug)}</code>`).join(', ');
    const evidenceList = (f.evidence || []).map(e => `<li>${escapeHtml(e.file || '')}${e.lineStart ? `:${e.lineStart}` : ''} — <code>${escapeHtml(e.text || e.anchor || '')}</code></li>`).join('');
    return `
    <details class="finding-card">
      <summary>
        <span class="badge badge-${f.severity}">${D(`severity.${f.severity}`)}</span>
        <span class="finding-title">${translateTitle(f.title)}</span>
        <span class="tag">${D(`type.${f.type}`)}</span>
        ${f.ignored ? `<span class="tag tag-ignored">${D('html.ignored')}</span>` : ''}
      </summary>
      <div class="finding-body">
        <p>${escapeHtml(f.description)}</p>
        ${evidenceList ? `<details><summary>${D('report.evidence')}</summary><ul>${evidenceList}</ul></details>` : ''}
        ${f.recommendation ? `<p><strong>${D('report.recommendation')}:</strong> ${escapeHtml(f.recommendation)}</p>` : ''}
        ${skillsList ? `<p><strong>${D('html.skillsInvolved')}:</strong> ${skillsList}</p>` : ''}
        <p class="finding-id"><small>ID: <code>${escapeHtml(f.id)}</code></small></p>
      </div>
    </details>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="${lang || 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t('report.title', lang || 'en')}</title>
<style>
:root{--c-critical:#dc2626;--c-high:#ea580c;--c-medium:#ca8a04;--c-low:#2563eb;--c-info:#6b7280;--bg:#f8fafc;--card:#fff;--text:#1e293b;--border:#e2e8f0;--muted:#64748b}
@media(prefers-color-scheme:dark){:root{--bg:#0f172a;--card:#1e293b;--text:#e2e8f0;--border:#334155;--muted:#94a3b8}}
*{box-sizing:border-box;margin:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;padding:1.5rem}
header{display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem;flex-wrap:wrap;gap:0.5rem}h1{font-size:1.5rem}h2{font-size:1.2rem;margin:1.5rem 0 0.75rem;padding-bottom:0.5rem;border-bottom:2px solid var(--border)}
.lang-btn{padding:0.4rem 1rem;border:1px solid var(--border);border-radius:6px;background:var(--card);cursor:pointer;font-size:0.85rem;color:var(--text)}
.dashboard{display:grid;grid-template-columns:repeat(5,1fr);gap:0.75rem;margin-bottom:1.5rem}@media(max-width:900px){.dashboard{grid-template-columns:repeat(3,1fr)}}@media(max-width:500px){.dashboard{grid-template-columns:repeat(2,1fr)}}
.stat-card{background:var(--card);border-radius:8px;padding:1rem;box-shadow:0 1px 3px rgba(0,0,0,0.08)}.stat-value{font-size:1.75rem;font-weight:700}.stat-label{font-size:0.8rem;color:var(--muted);margin-top:0.25rem;display:flex;align-items:center;gap:0.3rem}.stat-desc{font-size:0.7rem;color:var(--muted);margin-top:0.35rem;line-height:1.4}
.card-detail{margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid var(--border);font-size:0.75rem;color:var(--muted)}.card-detail code{font-size:0.7rem;white-space:pre-wrap}
.card-details{margin-top:0.5rem}.card-details summary{font-size:0.7rem;color:var(--muted);cursor:pointer;padding:0.2rem 0;display:flex}.card-details summary:hover{color:var(--text)}
.card-detail-list{max-height:200px;overflow-y:auto;padding:0.25rem 0}.card-item{font-size:0.75rem;padding:0.2rem 0;display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap}.card-item-skills{color:var(--muted);font-size:0.7rem}
.severity-bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--border);margin:0.75rem 0}.bar-seg{height:100%}.bar-critical{background:var(--c-critical)}.bar-high{background:var(--c-high)}.bar-medium{background:var(--c-medium)}.bar-low{background:var(--c-low)}.bar-info{background:var(--c-info)}
.legend{display:flex;flex-wrap:wrap;gap:0.75rem;font-size:0.8rem;color:var(--muted);margin-bottom:1rem}.legend-item{display:flex;align-items:center;gap:0.3rem}.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.finding-card{background:var(--card);border:1px solid var(--border);border-radius:8px;margin-bottom:0.5rem;overflow:hidden}summary{padding:0.75rem 1rem;cursor:pointer;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap}summary:hover{background:rgba(0,0,0,0.02)}
.badge{font-size:0.7rem;padding:0.15rem 0.5rem;border-radius:4px;color:#fff;font-weight:600;text-transform:uppercase}.badge-critical{background:var(--c-critical)}.badge-high{background:var(--c-high)}.badge-medium{background:var(--c-medium)}.badge-low{background:var(--c-low)}.badge-info{background:var(--c-info)}
.finding-title{font-weight:600;flex:1}.tag{font-size:0.7rem;padding:0.1rem 0.4rem;border-radius:3px;background:var(--border);color:var(--muted)}.tag-ignored{background:#fef3c7;color:#92400e}
.finding-body{padding:0.75rem 1rem;border-top:1px solid var(--border);font-size:0.9rem}.finding-body p{margin:0.5rem 0}.finding-body ul{margin:0.5rem 0 0.5rem 1.5rem}.finding-id{color:var(--muted);margin-top:0.5rem}
.fix-versions{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:0.75rem}.fix-ver h4{font-size:0.8rem;color:var(--muted);margin-bottom:0.5rem;text-transform:uppercase}
.dupe-table{width:100%;border-collapse:collapse;font-size:0.85rem;margin-top:0.5rem}th,td{padding:0.5rem 0.75rem;border:1px solid var(--border);text-align:left}th{background:var(--card);font-weight:600}
.guide-card{background:var(--card);border:1px solid var(--border);border-radius:8px;margin-bottom:0.5rem}summary{font-weight:600}.guide-body{padding:0.75rem 1rem;border-top:1px solid var(--border);font-size:0.9rem}
.steps{background:var(--bg);padding:0.75rem;border-radius:6px;white-space:pre-wrap;font-size:0.85rem;margin:0.5rem 0}
.prompt-block{position:relative;margin-top:0.5rem}.prompt{background:#1e293b;color:#e2e8f0;padding:0.75rem;border-radius:6px;font-size:0.8rem;white-space:pre-wrap;overflow-x:auto}
.copy-btn{position:absolute;top:0.5rem;right:0.5rem;padding:0.25rem 0.6rem;font-size:0.75rem;border:none;border-radius:4px;background:rgba(255,255,255,0.15);color:#e2e8f0;cursor:pointer}.copy-btn:hover{background:rgba(255,255,255,0.25)}
.info-card{background:var(--card);border:1px solid var(--border);border-radius:8px;margin-bottom:1rem}summary{font-weight:600}.info-body{padding:0.75rem 1rem;border-top:1px solid var(--border);font-size:0.9rem}.info-body p{margin:0.5rem 0;padding-left:1rem;border-left:3px solid var(--border)}
.guide-section{margin:0.75rem 0}.guide-section h4{font-size:0.85rem;color:var(--muted);margin-bottom:0.5rem;text-transform:uppercase;letter-spacing:0.5px}
.cause{background:var(--bg);padding:0.75rem;border-radius:6px;white-space:pre-wrap;font-size:0.85rem;margin:0.5rem 0;border-left:3px solid var(--c-medium)}
.example{background:var(--bg);padding:0.75rem;border-radius:6px;white-space:pre-wrap;font-size:0.85rem;margin:0.5rem 0;border-left:3px solid var(--c-low)}
.tip-wrap{position:relative;display:inline-flex;align-items:center}.tip-icon{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:var(--border);color:var(--muted);font-size:0.65rem;font-weight:700;cursor:help;margin-left:0.25rem}
.tip-box{display:none;position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:0.75rem;font-size:0.8rem;width:320px;z-index:10;box-shadow:0 4px 12px rgba(0,0,0,0.12);line-height:1.5;white-space:normal}
.tip-wrap:hover .tip-box{display:block}
.scan-class-legend{display:flex;flex-wrap:wrap;gap:0.75rem;font-size:0.8rem;color:var(--muted);margin-bottom:0.75rem}
.root-card{background:var(--card);border:1px solid var(--border);border-radius:8px;margin-bottom:0.5rem;overflow:hidden}.root-card summary{padding:0.6rem 1rem;cursor:pointer;font-size:0.85rem;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap}.root-card summary:hover{background:var(--bg)}.root-card .root-path{font-family:monospace;font-size:0.8rem;font-weight:600;word-break:break-all}.root-card .tag{font-size:0.65rem}.root-body{padding:0 1rem 0.75rem;border-top:1px solid var(--border)}.root-empty{padding:0.6rem 1rem;font-size:0.8rem;color:var(--muted);font-style:italic}
.skill-table{width:100%;border-collapse:collapse;font-size:0.8rem;margin-top:0.5rem}th,td{padding:0.4rem 0.6rem;border:1px solid var(--border);text-align:left}th{background:var(--bg);font-weight:600;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.3px}.skill-table code{font-size:0.75rem;word-break:break-all}.skill-table .skill-name{font-weight:600}
footer{text-align:center;color:var(--muted);font-size:0.8rem;margin-top:2rem;padding-top:1rem;border-top:1px solid var(--border)}
</style>
</head>
<body>
<header>
  <h1>${D('report.title')}</h1>
  <button class="lang-btn" onclick="toggleLang()"><span data-lang="en">中文</span><span data-lang="zh">EN</span></button>
</header>

<h2>${D('html.dashboard')}</h2>
<div class="dashboard">${summaryCards}</div>
<div class="severity-bar">${severityBar}</div>
<div class="legend">${severityLegend}</div>

<h2>${D('html.scanOverview')}</h2>
${scanOverviewHtml}

<details class="info-card">
  <summary>${D('severity.explanation.title')}</summary>
  <div class="info-body">
    <p>${D('severity.explanation.critical')}</p>
    <p>${D('severity.explanation.high')}</p>
    <p>${D('severity.explanation.medium')}</p>
    <p>${D('severity.explanation.low')}</p>
    <p>${D('severity.explanation.info')}</p>
  </div>
</details>

<h2>${D('html.remediationGuide')}</h2>
${remediationPathHtml}

<h3 style="font-size:1rem;margin:1.5rem 0 0.5rem;color:var(--muted)">${D('fix.perFinding')}</h3>
${perFindingHtml}

<footer>${D('html.generatedAt')}: ${new Date().toISOString()}</footer>

<script>
function setLang(lang){
  document.documentElement.lang=lang;
  document.querySelectorAll('[data-lang]').forEach(function(e){
    if(e.dataset.lang===lang){
      e.style.removeProperty('display');
    }else{
      e.style.display='none';
    }
  });
  localStorage.setItem('asd-lang',lang);
}
function toggleLang(){
  var cur=document.documentElement.lang;
  setLang(cur==='en'?'zh':'en');
}
function copyPrompt(btn){
  var lang=document.documentElement.lang;
  var pre=btn.previousElementSibling;
  var text=pre.querySelector('[data-lang="'+lang+'"]')||pre;
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text.textContent).then(function(){
      var orig=btn.innerHTML;
      btn.innerHTML=lang==='en'?'Copied!':'已复制!';
      setTimeout(function(){btn.innerHTML=orig},2000);
    });
  } else {
    var ta=document.createElement('textarea');ta.value=text.textContent;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);
    var orig=btn.innerHTML;
    btn.innerHTML=lang==='en'?'Copied!':'已复制!';
    setTimeout(function(){btn.innerHTML=orig},2000);
  }
}
(function(){
  var initial='${(lang === 'zh' ? 'zh' : 'en')}';
  var saved=localStorage.getItem('asd-lang');
  var active=saved||initial;
  setLang(active);
})();
</script>
</body>
</html>`;
}

function writeReport(db, { format, output, includeIgnored, reportsDir, lang }) {
  const data = buildReportData(db, includeIgnored);
  const ext = format === 'json' ? 'json' : format === 'html' ? 'html' : 'md';
  const outPath = output || path.join(reportsDir, `skill-doctor-report-${Date.now()}.${ext}`);
  let content;
  if (format === 'json') {
    content = JSON.stringify(data, null, 2);
  } else if (format === 'html') {
    content = renderHtml(data, lang, outPath);
  } else {
    content = renderMarkdown(data, lang);
  }
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, content, 'utf8');
  const reportId = sha256(`${outPath}:${nowIso()}`);
  db.prepare('INSERT OR IGNORE INTO reports (id, format, path, created_at, summary_json) VALUES (?, ?, ?, ?, ?)')
    .run(reportId, format, outPath, nowIso(), JSON.stringify(data.summary));
  return { path: outPath, data };
}

function usage() {
  console.log(`agent-skill-doctor CLI

Commands:
  scan [--full] [--rebuild-index] [--root <path>] [--json] [--lang en|zh]
  diagnose [--json] [--ci] [--fail-on high|critical|medium] [--rules <dir>] [--include-ignored] [--lang en|zh]
  report [--format md|json|html] [--output <path>] [--include-ignored] [--lang en|zh]
  guide [--lang en|zh]
  fix [--type <type>] [--severity <level>] [--lang en|zh]
  duplicates [--json]
  risks [--json] [--ci] [--fail-on high|critical|medium]
  conflicts [--json] [--ci] [--fail-on high|critical|medium]
  zombies [--json] [--ci] [--fail-on high|critical|medium]
  plan [--safe|--normal|--aggressive] [--json] [--output <path>]
  apply <plan.json> --dry-run [--json]
  ignore <finding-id> [--reason <text>]
  unignore <finding-id>
  ignored list
  help

Fix types: risk, zombie, duplicate, conflict, version_drift, description_quality, scan_warning
Fix severity: critical, high, medium, low, info
`);
}

function open() { const config = loadConfig(); return { config, db: openDb(config.dbPath) }; }

function severityRank(severity) {
  return { info: 0, low: 1, medium: 2, high: 3, critical: 4 }[severity] || 0;
}

function exitCodeForFindings(findings, failOn, includeIgnored) {
  const threshold = severityRank(failOn || 'high');
  let maxSeverity = 0;
  for (const f of findings) {
    if (f.ignored && !includeIgnored) continue;
    const rank = severityRank(f.severity);
    if (rank >= threshold) maxSeverity = Math.max(maxSeverity, rank);
  }
  if (maxSeverity >= 4) return 2; // critical
  if (maxSeverity >= threshold) return 1; // at or above threshold
  return 0;
}

function runScan(args) {
  const { config, db } = open();
  const startedAt = nowIso();
  const roots = args.root ? [expandHome(args.root)] : config.roots;
  if (args['rebuild-index']) {
    db.exec('DELETE FROM duplicate_group_members; DELETE FROM duplicate_groups; DELETE FROM finding_skills; DELETE FROM findings; DELETE FROM skill_records;');
  }
  const skills = scanRoots(roots, { maxDepth: config.scan.maxDepth, full: !!args.full });
  let findingCount = 0, highCount = 0, criticalCount = 0;
  for (const skill of skills) {
    upsertSkill(db, skill);
    const { findings, links } = detectPhase1Findings(skill);
    for (const finding of findings) {
      upsertFinding(db, finding, links.filter(l => l.findingId === finding.id));
      findingCount++;
      if (finding.severity === 'high') highCount++;
      if (finding.severity === 'critical') criticalCount++;
    }
  }
  const summary = { roots, skills: skills.length, phase1Findings: findingCount, dbPath: config.dbPath };
  recordRun(db, { id: sha256(`${startedAt}:${Math.random()}`), startedAt, finishedAt: nowIso(), status: 'ok', skillCount: skills.length, findingCount, highCount, criticalCount, config: { roots }, summary });
  if (args.silent) return; // Called from runDiagnose, don't print
  if (args.json) console.log(JSON.stringify({ summary, skills: skills.map(s => ({ id: s.id, slug: s.slug, name: s.name, path: s.location.path, contentHash: s.hashes.contentSha256 })) }, null, 2));
  else console.log(t('cli.scanned', args.lang || 'en', skills.length, findingCount, config.dbPath));
}

function rowToSkill(row) {
  const raw = row.raw_json ? JSON.parse(row.raw_json) : {};
  return {
    ...raw,
    id: row.id,
    upstreamSkillId: row.upstream_skill_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    source: raw.source || { type: row.source_type, url: row.source_url, ref: row.source_ref, commit: row.source_commit },
    location: raw.location || { path: row.local_path, root: path.dirname(row.local_path), rootType: row.root_type, agent: row.agent },
    hashes: raw.hashes || { contentSha256: row.content_hash, normalizedTextSha256: row.normalized_hash },
    files: raw.files || [],
    tags: raw.tags || [],
    usage: raw.usage || { installedInAgents: [], installedInProjects: [], presetCount: 0, hasRecentModification: false, manuallyPinned: false },
    frontmatter: raw.frontmatter || {},
    _scan: raw._scan || {},
  };
}

function listSkillObjects(db) {
  return db.prepare('SELECT * FROM skill_records ORDER BY slug ASC').all().map(rowToSkill);
}

function runDiagnose(args) {
  runScan({ ...args, json: false, silent: true });
  const { config, db } = open();
  const skills = listSkillObjects(db);

  // Risk scan
  const rulesDir = args.rules ? path.resolve(expandHome(args.rules)) : path.join(process.cwd(), 'rules/default');
  let riskFindings = [];
  if (fs.existsSync(rulesDir)) {
    const rules = loadJsonRules(rulesDir);
    for (const skill of skills) {
      const found = scanSkillForRisks(skill, rules);
      for (const f of found) upsertFinding(db, f, [{ findingId: f.id, skillId: skill.id, role: 'primary' }]);
      riskFindings.push(...found);
    }
  }

  // Conflict detection
  const conflictFindings = detectConflicts(skills, DEFAULT_CONFLICT_RULES);
  for (const f of conflictFindings) upsertFinding(db, f, f.links || []);

  // Zombie detection
  const zombieFindings = detectZombies(skills);
  for (const f of zombieFindings) upsertFinding(db, f, f.links || []);

  // Duplicate and version drift detection
  const phase2Result = runPhase2Analysis(db, skills);

  const data = buildReportData(db, !!args['include-ignored']);
  const summary = {
    ...data.summary,
    riskFindings: riskFindings.length,
    conflictFindings: conflictFindings.length,
    zombieCandidates: zombieFindings.length,
    duplicateGroups: phase2Result.groups.length,
    versionDriftFindings: phase2Result.drifts.length,
  };

  if (args.json) console.log(JSON.stringify({ ...data, summary }, null, 2));
  else {
    const lang = args.lang || 'en';
    console.log(t('cli.skills', lang, summary.totalSkills));
    console.log(t('cli.findings', lang, summary.totalFindings));
    console.log(t('cli.riskFindings', lang, summary.riskFindings));
    console.log(t('cli.conflictFindings', lang, summary.conflictFindings));
    console.log(t('cli.zombieCandidates', lang, summary.zombieCandidates));
  }

  if (args.ci) {
    const rows = listFindings(db, !!args['include-ignored']);
    process.exit(exitCodeForFindings(rows, args['fail-on'] || 'high', !!args['include-ignored']));
  }
}

function runReport(args) {
  const { config, db } = open();
  const result = writeReport(db, { format: args.format || 'md', output: args.output ? path.resolve(expandHome(args.output)) : null, includeIgnored: !!args['include-ignored'], reportsDir: config.reportsDir, lang: args.lang || 'en' });
  console.log(t('cli.reportWritten', args.lang || 'en', result.path));
  if (args.ci) {
    const rows = listFindings(db, !!args['include-ignored']);
    process.exit(exitCodeForFindings(rows, args['fail-on'] || 'high', !!args['include-ignored']));
  }
}

function outputJsonOrText(args, jsonValue, textLines) {
  if (args.json) console.log(JSON.stringify(jsonValue, null, 2));
  else console.log(textLines.join('\n'));
}

function runDuplicates(args) {
  const { db } = open();
  const groups = listDuplicateGroups(db).map(group => ({
    ...group,
    members: db.prepare('SELECT dgm.*, sr.slug, sr.name, sr.local_path FROM duplicate_group_members dgm JOIN skill_records sr ON sr.id = dgm.skill_id WHERE dgm.group_id = ? ORDER BY role ASC, sr.slug ASC').all(group.id),
  }));
  if (!groups.length) return outputJsonOrText(args, [], [t('cli.noDuplicateGroups', args.lang || 'en')]);
  outputJsonOrText(args, groups, groups.flatMap(group => [
    `${group.id}  ${group.strategy}  confidence=${group.confidence}`,
    ...group.members.map(member => `  - ${member.role}: ${member.slug}  ${member.local_path}`),
  ]));
}

function runFindingsByType(args, type) {
  const { db } = open();
  const rows = db.prepare('SELECT * FROM findings WHERE type = ? AND ignored = 0 ORDER BY CASE severity WHEN \'critical\' THEN 0 WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 WHEN \'low\' THEN 3 WHEN \'info\' THEN 4 ELSE 5 END, updated_at DESC').all(type);
  const findings = rows.map(row => ({
    id: row.id,
    type: row.type,
    severity: row.severity,
    ruleId: row.rule_id,
    title: row.title,
    description: row.description,
    evidence: JSON.parse(row.evidence_json || '[]'),
    skills: getFindingSkills(db, row.id),
  }));
  outputJsonOrText(
    args,
    findings,
    findings.length ? findings.map(f => `${f.id}  ${f.severity}  ${f.ruleId || ''}  ${f.title}`) : [t('cli.noFindings', args.lang || 'en', type)]
  );
  if (args.ci) process.exit(exitCodeForFindings(rows, args['fail-on'] || 'high', false));
}

function expectedStateForSkill(row) {
  return {
    upstreamSkillId: row.upstream_skill_id || null,
    localPath: row.local_path,
    contentHash: row.content_hash,
    normalizedHash: row.normalized_hash,
    sourceCommit: row.source_commit || null,
    modifiedAt: row.modified_at || null,
  };
}

function buildOptimizationPlan(db, mode) {
  const at = nowIso();
  const actions = [];
  const duplicateMembers = db.prepare(`
SELECT dgm.*, dg.strategy, dg.canonical_skill_id, sr.upstream_skill_id, sr.slug, sr.name, sr.local_path, sr.content_hash, sr.normalized_hash, sr.source_commit, sr.modified_at
FROM duplicate_group_members dgm
JOIN duplicate_groups dg ON dg.id = dgm.group_id
JOIN skill_records sr ON sr.id = dgm.skill_id
WHERE dgm.role = 'candidate'
ORDER BY dg.confidence DESC, sr.slug ASC
`).all();

  for (const member of duplicateMembers) {
    const actionType = mode === 'aggressive' ? 'remove_from_preset' : mode === 'normal' ? 'disable' : 'tag';
    actions.push({
      id: sha256(`${member.group_id}:${member.skill_id}:${actionType}`),
      type: actionType,
      targetSkillId: member.skill_id,
      reason: `Duplicate candidate in ${member.strategy}; canonical skill is ${member.canonical_skill_id}.`,
      risk: actionType === 'tag' ? 'safe' : 'needs_review',
      expectedState: expectedStateForSkill(member),
      dryRunCommand: `agent-skill-doctor apply plan.json --dry-run --target ${member.skill_id}`,
      executeCommand: null,
    });
  }

  return {
    id: sha256(`plan:${at}:${actions.map(a => a.id).join('\n')}`),
    createdAt: at,
    mode,
    summary: `Generated ${actions.length} safe governance action(s).`,
    actions,
    estimatedImpact: {
      skillsToDisable: actions.filter(a => a.type === 'disable').length,
      skillsToRemove: 0,
      duplicatesToMerge: actions.length,
      riskySkills: db.prepare("SELECT COUNT(*) AS count FROM findings WHERE type = 'risk' AND ignored = 0").get().count,
    },
  };
}

function runPlan(args) {
  const { config, db } = open();
  const mode = args.aggressive ? 'aggressive' : args.normal ? 'normal' : 'safe';
  const plan = buildOptimizationPlan(db, mode);
  const outPath = args.output ? path.resolve(expandHome(args.output)) : null;
  if (outPath) {
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, JSON.stringify(plan, null, 2), 'utf8');
  }
  if (args.json) console.log(JSON.stringify(plan, null, 2));
  else {
    if (outPath) console.log(`Plan written: ${outPath}`);
    console.log(plan.summary);
  }
}

function currentStateForPath(localPath) {
  if (!localPath || !fs.existsSync(localPath) || !fs.statSync(localPath).isDirectory()) {
    return { exists: false, contentHash: null, normalizedHash: null, modifiedAt: null };
  }
  const hashes = computeHashes(localPath);
  const stat = fs.statSync(localPath);
  return {
    exists: true,
    contentHash: hashes.contentSha256,
    normalizedHash: hashes.normalizedTextSha256,
    modifiedAt: stat.mtime?.toISOString?.() || null,
  };
}

function actionIsStale(action) {
  const expected = action.expectedState || {};
  const current = currentStateForPath(expected.localPath);
  if (!current.exists) return true;
  return Boolean(
    expected.contentHash && current.contentHash !== expected.contentHash
  );
}

function runApply(args) {
  const lang = args.lang || 'en';
  const planPath = args._[1] ? path.resolve(expandHome(args._[1])) : null;
  if (!planPath) { console.error(t('cli.applyRequiresPlan', lang)); process.exit(3); }
  if (!args['dry-run']) { console.error(t('cli.dryRunOnly', lang)); process.exit(3); }
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const actions = (plan.actions || []).map(action => ({
    id: action.id,
    type: action.type,
    targetSkillId: action.targetSkillId,
    status: actionIsStale(action) ? 'stale_action' : 'dry_run',
    reason: action.reason,
  }));
  const result = { planId: plan.id, dryRun: true, actions };
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const action of actions) console.log(`${action.status}  ${action.type}  ${action.targetSkillId}`);
  }
}

function runIgnore(args, ignored) {
  const lang = args.lang || 'en';
  const findingId = args._[1];
  if (!findingId) { console.error(t('cli.ignoreRequiresId', lang, ignored ? 'ignore' : 'unignore')); process.exit(3); }
  const { db } = open();
  const changes = setIgnored(db, findingId, ignored, args.reason || null, nowIso());
  if (!changes) { console.error(t('cli.findingNotFound', lang, findingId)); process.exit(3); }
  console.log(t(ignored ? 'cli.ignoredFinding' : 'cli.unignoredFinding', lang, ignored ? 'Ignored' : 'Unignored', findingId));
}

function runIgnored(args) {
  const lang = args.lang || 'en';
  if (args._[1] !== 'list') { console.error(t('cli.ignoredListUsage', lang)); process.exit(3); }
  const { db } = open();
  const rows = listIgnored(db);
  if (args.json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log(t('cli.noIgnored', args.lang || 'en'));
  for (const r of rows) console.log(`${r.id}  ${r.severity}  ${r.type}  ${r.title}  reason=${r.ignored_reason || ''}`);
}

function runGuide(args) {
  const lang = args.lang || 'en';
  const types = ['risk', 'zombie', 'duplicate', 'conflict', 'version_drift', 'description_quality', 'scan_warning'];
  const lines = [];
  for (const type of types) {
    lines.push(`=== ${t(`guide.${type}.title`, lang)} ===`);
    lines.push('');
    lines.push(t(`guide.${type}.definition`, lang));
    lines.push('');
    lines.push(t(`guide.${type}.cause`, lang));
    lines.push('');
    lines.push(t(`guide.${type}.severity`, lang));
    lines.push('');
    lines.push(t(`guide.${type}.steps`, lang));
    lines.push('');
    lines.push(`${lang === 'zh' ? '示例提示词' : 'Example prompt'}:`);
    lines.push(`  ${t(`guide.${type}.prompt`, lang, '<skill-path>')}`);
    lines.push('');
    lines.push(`${lang === 'zh' ? 'Agent 交互示例' : 'Agent Interaction Example'}:`);
    lines.push(t(`guide.${type}.agentExample`, lang));
    lines.push('');
  }
  console.log(lines.join('\n'));
}

function runFix(args) {
  const { db } = open();
  const lang = args.lang || 'en';
  const typeFilter = args.type || null;
  const severityFilter = args.severity || null;

  // Validate severity
  const validSeverities = ['critical', 'high', 'medium', 'low', 'info'];
  if (severityFilter && !validSeverities.includes(severityFilter)) {
    console.error(`${lang === 'zh' ? '无效的严重程度' : 'Invalid severity'}: ${severityFilter}. ${lang === 'zh' ? '可选值' : 'Valid values'}: ${validSeverities.join(', ')}`);
    process.exit(3);
  }

  // Validate type
  const validTypes = ['risk', 'zombie', 'duplicate', 'conflict', 'version_drift', 'description_quality', 'scan_warning'];
  if (typeFilter && !validTypes.includes(typeFilter)) {
    console.error(`${lang === 'zh' ? '无效的问题类型' : 'Invalid type'}: ${typeFilter}. ${lang === 'zh' ? '可选值' : 'Valid values'}: ${validTypes.join(', ')}`);
    process.exit(3);
  }

  // Get findings from database
  let rows = listFindings(db, !!args['include-ignored']);

  // Apply filters
  if (typeFilter) {
    rows = rows.filter(r => r.type === typeFilter);
  }
  if (severityFilter) {
    const minRank = severityRank(severityFilter);
    rows = rows.filter(r => severityRank(r.severity) >= minRank);
  }

  if (rows.length === 0) {
    console.log(t('fix.noFindings', lang));
    return;
  }

  // Group findings by type
  const byType = {};
  for (const row of rows) {
    if (!byType[row.type]) byType[row.type] = [];
    byType[row.type].push(row);
  }

  const lines = [];
  lines.push(`=== ${t('fix.title', lang)} ===`);
  lines.push('');

  // Generate prompts for each type
  for (const [type, findings] of Object.entries(byType)) {
    const skillMap = {};
    for (const f of findings) {
      const fs = getFindingSkills(db, f.id);
      for (const s of fs) {
        if (!skillMap[s.slug]) skillMap[s.slug] = { path: s.local_path, findings: [] };
        skillMap[s.slug].findings.push(f);
      }
    }

    lines.push(`--- ${t(`guide.${type}.title`, lang)} (${findings.length}) ---`);
    lines.push('');
    lines.push(t(`guide.${type}.definition`, lang));
    lines.push('');

    // List each skill with its specific findings
    for (const [slug, info] of Object.entries(skillMap)) {
      lines.push(`${lang === 'zh' ? '技能' : 'Skill'}: ${slug}`);
      lines.push(`${lang === 'zh' ? '路径' : 'Path'}: ${info.path}`);
      lines.push(`${lang === 'zh' ? '问题' : 'Issues'}:`);
      for (const f of info.findings) {
        lines.push(`  - [${f.severity.toUpperCase()}] ${f.title}`);
        if (f.description) lines.push(`    ${f.description.substring(0, 100)}...`);
        lines.push(`    ID: ${f.id}`);
      }
      lines.push('');
    }

    lines.push(`${lang === 'zh' ? '修复步骤' : 'Fix Steps'}:`);
    lines.push(t(`guide.${type}.steps`, lang));
    lines.push('');

    // Generate targeted prompt
    const allSkills = Object.keys(skillMap);
    lines.push(`${lang === 'zh' ? '复制以下提示词给 Agent' : 'Copy this prompt to Agent'}:`);
    lines.push('---');
    lines.push(`${lang === 'zh' ? '请修复以下技能的问题' : 'Please fix the following skills'}:`);
    for (const [slug, info] of Object.entries(skillMap)) {
      lines.push(`\n技能: ${slug} (${info.path})`);
      for (const f of info.findings) {
        lines.push(`- [${f.severity}] ${f.title}: ${f.recommendation || t(`guide.${type}.steps`, lang).split('\n')[0]}`);
      }
    }
    lines.push('---');
    lines.push('');
  }

  console.log(lines.join('\n'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'help';
  try {
    if (command === 'scan') return runScan(args);
    if (command === 'diagnose') return runDiagnose(args);
    if (command === 'report') return runReport(args);
    if (command === 'guide') return runGuide(args);
    if (command === 'fix') return runFix(args);
    if (command === 'duplicates') return runDuplicates(args);
    if (command === 'risks') return runFindingsByType(args, 'risk');
    if (command === 'conflicts') return runFindingsByType(args, 'conflict');
    if (command === 'zombies') return runFindingsByType(args, 'zombie');
    if (command === 'plan') return runPlan(args);
    if (command === 'apply') return runApply(args);
    if (command === 'ignore') return runIgnore(args, true);
    if (command === 'unignore') return runIgnore(args, false);
    if (command === 'ignored') return runIgnored(args);
    return usage();
  } catch (err) {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(3);
  }
}

main();
