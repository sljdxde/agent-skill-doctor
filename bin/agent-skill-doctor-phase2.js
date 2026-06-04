#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const phase2 = require('../src/doctor/phase2');

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function home() {
  return expandHome(process.env.AGENT_SKILL_DOCTOR_HOME || '~/.agent-skill-doctor');
}

function nowIso() {
  return new Date().toISOString();
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

function openDb() {
  const dbPath = path.join(home(), 'doctor.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`doctor.db not found: ${dbPath}`);
    console.error('Run Phase 1 first: node ./bin/agent-skill-doctor.js scan');
    process.exit(3);
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
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

function rowToSkill(row) {
  const raw = row.raw_json ? JSON.parse(row.raw_json) : {};
  return {
    ...raw,
    id: row.id,
    upstreamSkillId: row.upstream_skill_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    source: raw.source || {
      type: row.source_type,
      url: row.source_url,
      ref: row.source_ref,
      commit: row.source_commit,
    },
    location: raw.location || {
      path: row.local_path,
      root: path.dirname(row.local_path),
      rootType: row.root_type,
      agent: row.agent,
    },
    hashes: raw.hashes || {
      contentSha256: row.content_hash,
      normalizedTextSha256: row.normalized_hash,
    },
    sourceRef: row.source_ref,
    sourceCommit: row.source_commit,
    modifiedAt: row.modified_at,
  };
}

function listSkillObjects(db) {
  return db.prepare('SELECT * FROM skill_records ORDER BY slug ASC').all().map(rowToSkill);
}

function upsertFinding(db, finding, links) {
  const existing = db.prepare('SELECT id FROM findings WHERE id = ?').get(finding.id);
  if (existing) {
    db.prepare('UPDATE findings SET type=?, severity=?, detector_id=?, rule_id=?, title=?, description=?, signature=?, evidence_json=?, recommendation=?, updated_at=? WHERE id=?')
      .run(finding.type, finding.severity, finding.detectorId, finding.ruleId || null, finding.title, finding.description, finding.signature, JSON.stringify(finding.evidence || []), finding.recommendation || null, finding.updatedAt, finding.id);
  } else {
    db.prepare('INSERT INTO findings (id, type, severity, detector_id, rule_id, title, description, signature, evidence_json, recommendation, ignored, ignored_reason, ignored_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)')
      .run(finding.id, finding.type, finding.severity, finding.detectorId, finding.ruleId || null, finding.title, finding.description, finding.signature, JSON.stringify(finding.evidence || []), finding.recommendation || null, finding.createdAt, finding.updatedAt);
  }
  const stmt = db.prepare('INSERT OR IGNORE INTO finding_skills (finding_id, skill_id, role, added_at) VALUES (?, ?, ?, ?)');
  for (const link of links) stmt.run(finding.id, link.skillId, link.role || 'related', nowIso());
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
  const signature = group.id;
  return {
    finding: {
      id: `dup-${group.id}`,
      type: 'duplicate',
      severity: group.strategy === 'exact_duplicate' ? 'medium' : 'low',
      detectorId: 'duplicate-detector',
      ruleId: group.strategy,
      title: `${group.strategy.replaceAll('_', ' ')} detected`,
      description: `Detected ${group.skills.length} related skills. Canonical suggestion: ${group.canonicalSkillId}.`,
      signature,
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

function runAnalyze(args) {
  const db = openDb();
  const skills = listSkillObjects(db);
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

  const summary = { skills: skills.length, duplicateGroups: groups.length, versionDriftFindings: drifts.length };
  if (args.json) console.log(JSON.stringify({ summary, duplicateGroups: groups, versionDriftFindings: drifts }, null, 2));
  else console.log(`Analyzed ${skills.length} skills. Duplicate groups: ${groups.length}. Version drift findings: ${drifts.length}.`);
}

function runDuplicates(args) {
  const db = openDb();
  const rows = db.prepare('SELECT * FROM duplicate_groups ORDER BY confidence DESC, strategy ASC').all();
  const groups = rows.map(group => ({
    ...group,
    members: db.prepare('SELECT dgm.*, sr.slug, sr.name, sr.local_path FROM duplicate_group_members dgm JOIN skill_records sr ON sr.id = dgm.skill_id WHERE dgm.group_id = ? ORDER BY role ASC, sr.slug ASC').all(group.id),
  }));
  if (args.json) return console.log(JSON.stringify(groups, null, 2));
  if (!groups.length) return console.log('No duplicate groups. Run: node ./bin/agent-skill-doctor-phase2.js analyze');
  for (const group of groups) {
    console.log(`${group.id}  ${group.strategy}  confidence=${group.confidence}`);
    for (const member of group.members) console.log(`  - ${member.role}: ${member.slug}  ${member.local_path}`);
  }
}

function runDrift(args) {
  const db = openDb();
  const rows = db.prepare("SELECT * FROM findings WHERE type = 'version_drift' ORDER BY updated_at DESC").all();
  const findings = rows.map(row => ({
    id: row.id,
    severity: row.severity,
    title: row.title,
    description: row.description,
    evidence: JSON.parse(row.evidence_json || '[]'),
    skills: db.prepare('SELECT fs.*, sr.slug, sr.name, sr.local_path FROM finding_skills fs JOIN skill_records sr ON sr.id = fs.skill_id WHERE fs.finding_id = ? ORDER BY fs.role ASC, sr.slug ASC').all(row.id),
  }));
  if (args.json) return console.log(JSON.stringify(findings, null, 2));
  if (!findings.length) return console.log('No version drift findings. Run: node ./bin/agent-skill-doctor-phase2.js analyze');
  for (const finding of findings) {
    console.log(`${finding.id}  ${finding.title}`);
    for (const skill of finding.skills) console.log(`  - ${skill.role}: ${skill.slug}  ${skill.local_path}`);
  }
}

function usage() {
  console.log(`agent-skill-doctor Phase 2 overlay\n\nCommands:\n  analyze [--json]\n  duplicates [--json]\n  drift [--json]\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'help';
  if (command === 'analyze') return runAnalyze(args);
  if (command === 'duplicates') return runDuplicates(args);
  if (command === 'drift') return runDrift(args);
  usage();
}

main();
