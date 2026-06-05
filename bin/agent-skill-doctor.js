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
  return path.resolve(expandHome(p)).replaceAll('\\\\', '/');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
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
    '~/.skills-manager/skills',
    '~/.skills-manager',
    '~/.claude/skills',
    '~/.codex/skills',
    '~/.cursor/skills',
    '~/.opencode/skills',
    path.join(process.cwd(), '.claude/skills'),
    path.join(process.cwd(), '.agents/skills'),
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
  if (p.includes('/.skills-manager/')) return 'central_library';
  if (p.includes('/.claude/') || p.includes('/.codex/') || p.includes('/.cursor/') || p.includes('/.opencode/')) return 'agent_global';
  if (p.includes('/.agents/')) return 'project_local';
  return 'unknown';
}

function inferAgent(p) {
  if (p.includes('/.claude/')) return 'claude';
  if (p.includes('/.codex/')) return 'codex';
  if (p.includes('/.cursor/')) return 'cursor';
  if (p.includes('/.opencode/')) return 'opencode';
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
  const skill = {
    id: '', upstreamSkillId: null, name, slug, description,
    source: { type: fm.data.source ? 'git' : 'unknown', url: fm.data.source || fm.data.source_url || null, subdir: fm.data.subdir || null, ref: fm.data.ref || fm.data.version || null, commit: fm.data.commit || null },
    location: { path: candidate.path, root: candidate.root, rootType: rootTypeFor(candidate.path), agent: inferAgent(candidate.path), isSymlink: false, symlinkTarget: null },
    version: fm.data.version || null, sourceRef: fm.data.ref || null, sourceCommit: fm.data.commit || null, sourceTreeSha: fm.data.tree_sha || null,
    frontmatter: fm.data, tags: parseTags(fm.data), presets: [], agentTargets: [], files: hashResult.files,
    hashes: { contentSha256: hashResult.contentSha256, normalizedTextSha256: hashResult.normalizedTextSha256, semanticFingerprint: {} },
    capabilities: [], usage: { installedInAgents: [], installedInProjects: [], presetCount: 0, hasRecentModification: true, manuallyPinned: parseManuallyPinned(fm.data), confidence: 0 },
    createdAt: stat.birthtime?.toISOString?.() || null, modifiedAt: stat.mtime?.toISOString?.() || null, lastSeenAt: now, lastUsedAt: null, status: 'active',
    _scan: { mainFile, text, frontmatterError: fm.error, hasSkillMd: candidate.hasSkillMd, hasReadme: candidate.hasReadme }
  };
  skill.id = sha256(buildSkillIdentityKey(skill));
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

function recordRun(db, run) {
  db.prepare('INSERT INTO doctor_runs (id, started_at, finished_at, status, skill_count, finding_count, duplicate_group_count, high_count, critical_count, config_json, summary_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(run.id, run.startedAt, run.finishedAt, run.status, run.skillCount, run.findingCount, 0, run.highCount, run.criticalCount, JSON.stringify(run.config || {}), JSON.stringify(run.summary || {}));
}

function listSkills(db) { return db.prepare('SELECT * FROM skill_records ORDER BY slug ASC').all(); }
function listFindings(db, includeIgnored) { return db.prepare(`SELECT * FROM findings ${includeIgnored ? '' : 'WHERE ignored = 0'} ORDER BY severity DESC, type ASC, title ASC`).all(); }
function listIgnored(db) { return db.prepare('SELECT * FROM findings WHERE ignored = 1 ORDER BY ignored_at DESC').all(); }
function getFindingSkills(db, findingId) { return db.prepare('SELECT fs.*, sr.slug, sr.name, sr.local_path FROM finding_skills fs JOIN skill_records sr ON sr.id = fs.skill_id WHERE fs.finding_id = ? ORDER BY fs.role ASC, sr.slug ASC').all(findingId); }
function setIgnored(db, id, ignored, reason, at) { return db.prepare('UPDATE findings SET ignored=?, ignored_reason=?, ignored_at=?, updated_at=? WHERE id=?').run(ignored ? 1 : 0, ignored ? (reason || null) : null, ignored ? at : null, at, id).changes || 0; }

function buildReportData(db, includeIgnored) {
  const skills = listSkills(db);
  const rows = listFindings(db, includeIgnored);
  const findings = rows.map(row => ({ id: row.id, type: row.type, severity: row.severity, detectorId: row.detector_id, ruleId: row.rule_id, title: row.title, description: row.description, signature: row.signature, evidence: JSON.parse(row.evidence_json || '[]'), recommendation: row.recommendation, ignored: !!row.ignored, ignoredReason: row.ignored_reason, ignoredAt: row.ignored_at, createdAt: row.created_at, updatedAt: row.updated_at, skills: getFindingSkills(db, row.id) }));
  const bySeverity = {}, byType = {};
  for (const f of findings) { bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1; byType[f.type] = (byType[f.type] || 0) + 1; }
  return { summary: { totalSkills: skills.length, totalFindings: findings.length, bySeverity, byType }, skills, findings };
}

function renderMarkdown(data) {
  const lines = ['# Agent Skill Doctor Report', '', '## Summary', '', `- Total skills: ${data.summary.totalSkills}`, `- Total findings: ${data.summary.totalFindings}`, `- By severity: ${JSON.stringify(data.summary.bySeverity)}`, `- By type: ${JSON.stringify(data.summary.byType)}`, '', '## Findings', ''];
  if (!data.findings.length) lines.push('No findings.', '');
  for (const f of data.findings) {
    lines.push(`### ${f.severity.toUpperCase()} - ${f.title}`, '', `- ID: \`${f.id}\``, `- Type: \`${f.type}\``, `- Detector: \`${f.detectorId}\``);
    if (f.ignored) lines.push(`- Ignored: yes (${f.ignoredReason || 'no reason'})`);
    if (f.skills?.length) lines.push(`- Skills: ${f.skills.map(s => `\`${s.slug}\``).join(', ')}`);
    lines.push('', f.description, '');
    if (f.recommendation) lines.push(`Recommendation: ${f.recommendation}`, '');
  }
  lines.push('## Skills', '');
  for (const s of data.skills) lines.push(`- \`${s.slug}\` - ${s.name} - ${s.local_path}`);
  lines.push('');
  return lines.join('\n');
}

function writeReport(db, { format, output, includeIgnored, reportsDir }) {
  const data = buildReportData(db, includeIgnored);
  const content = format === 'json' ? JSON.stringify(data, null, 2) : renderMarkdown(data);
  const ext = format === 'json' ? 'json' : 'md';
  const outPath = output || path.join(reportsDir, `skill-doctor-report-${Date.now()}.${ext}`);
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
  scan [--full] [--root <path>] [--json]
  diagnose [--json] [--ci] [--fail-on high|critical|medium] [--rules <dir>] [--include-ignored]
  report [--format md|json] [--output <path>] [--include-ignored]
  ignore <finding-id> [--reason <text>]
  unignore <finding-id>
  ignored list
  help
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
  if (args.json) console.log(JSON.stringify({ summary, skills: skills.map(s => ({ id: s.id, slug: s.slug, name: s.name, path: s.location.path, contentHash: s.hashes.contentSha256 })) }, null, 2));
  else console.log(`Scanned ${skills.length} skills. Phase 1 findings: ${findingCount}. DB: ${config.dbPath}`);
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

function runDiagnose(args) {
  runScan({ ...args, json: false });
  const { config, db } = open();
  const skills = db.prepare('SELECT * FROM skill_records ORDER BY slug ASC').all().map(rowToSkill);
  const allFindings = [];

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

  const data = buildReportData(db, !!args['include-ignored']);
  const summary = {
    ...data.summary,
    riskFindings: riskFindings.length,
    conflictFindings: conflictFindings.length,
    zombieCandidates: zombieFindings.length,
  };

  if (args.json) console.log(JSON.stringify({ ...data, summary }, null, 2));
  else {
    console.log(`Skills: ${summary.totalSkills}`);
    console.log(`Findings: ${summary.totalFindings}`);
    console.log(`Risk findings: ${summary.riskFindings}`);
    console.log(`Conflict findings: ${summary.conflictFindings}`);
    console.log(`Zombie candidates: ${summary.zombieCandidates}`);
  }

  if (args.ci) {
    const rows = listFindings(db, !!args['include-ignored']);
    process.exit(exitCodeForFindings(rows, args['fail-on'] || 'high', !!args['include-ignored']));
  }
}

function runReport(args) {
  const { config, db } = open();
  const result = writeReport(db, { format: args.format || 'md', output: args.output ? path.resolve(expandHome(args.output)) : null, includeIgnored: !!args['include-ignored'], reportsDir: config.reportsDir });
  console.log(`Report written: ${result.path}`);
}

function runIgnore(args, ignored) {
  const findingId = args._[1];
  if (!findingId) { console.error(`${ignored ? 'ignore' : 'unignore'} requires <finding-id>`); process.exit(3); }
  const { db } = open();
  const changes = setIgnored(db, findingId, ignored, args.reason || null, nowIso());
  if (!changes) { console.error(`Finding not found: ${findingId}`); process.exit(3); }
  console.log(`${ignored ? 'Ignored' : 'Unignored'} finding: ${findingId}`);
}

function runIgnored(args) {
  if (args._[1] !== 'list') { console.error('Usage: agent-skill-doctor ignored list'); process.exit(3); }
  const { db } = open();
  const rows = listIgnored(db);
  if (args.json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log('No ignored findings.');
  for (const r of rows) console.log(`${r.id}  ${r.severity}  ${r.type}  ${r.title}  reason=${r.ignored_reason || ''}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'help';
  try {
    if (command === 'scan') return runScan(args);
    if (command === 'diagnose') return runDiagnose(args);
    if (command === 'report') return runReport(args);
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
