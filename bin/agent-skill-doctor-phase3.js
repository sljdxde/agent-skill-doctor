#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { detectConflicts } = require('../src/doctor/conflict');
const { detectZombies } = require('../src/doctor/zombie');
const { DEFAULT_CONFLICT_RULES } = require('../src/doctor/rules');

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

function upsertFinding(db, finding, links) {
  const existing = db.prepare('SELECT id FROM findings WHERE id = ?').get(finding.id);
  const at = nowIso();
  if (existing) {
    db.prepare('UPDATE findings SET type=?, severity=?, detector_id=?, rule_id=?, title=?, description=?, signature=?, evidence_json=?, recommendation=?, updated_at=? WHERE id=?')
      .run(finding.type, finding.severity, finding.detectorId, finding.ruleId || null, finding.title, finding.description, finding.signature, JSON.stringify(finding.evidence || []), finding.recommendation || null, at, finding.id);
  } else {
    db.prepare('INSERT INTO findings (id, type, severity, detector_id, rule_id, title, description, signature, evidence_json, recommendation, ignored, ignored_reason, ignored_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)')
      .run(finding.id, finding.type, finding.severity, finding.detectorId, finding.ruleId || null, finding.title, finding.description, finding.signature, JSON.stringify(finding.evidence || []), finding.recommendation || null, at, at);
  }
  const stmt = db.prepare('INSERT OR IGNORE INTO finding_skills (finding_id, skill_id, role, added_at) VALUES (?, ?, ?, ?)');
  for (const link of links) stmt.run(finding.id, link.skillId, link.role || 'related', at);
}

function severityRank(severity) {
  return { info: 0, low: 1, medium: 2, high: 3, critical: 4 }[severity] || 0;
}

function exitCodeForFindings(findings, failOn) {
  const threshold = severityRank(failOn || 'high');
  let maxSeverity = 0;
  for (const f of findings) {
    if (f.ignored) continue;
    const rank = severityRank(f.severity);
    if (rank >= threshold) maxSeverity = Math.max(maxSeverity, rank);
  }
  if (maxSeverity >= 4) return 2; // critical
  if (maxSeverity >= threshold) return 1; // at or above threshold
  return 0;
}

// --- Conflict ---

function runConflicts(args) {
  const db = openDb();
  const skills = listSkillObjects(db);
  const findings = detectConflicts(skills, DEFAULT_CONFLICT_RULES);

  for (const finding of findings) {
    upsertFinding(db, finding, finding.links);
  }

  const summary = { skills: skills.length, conflictFindings: findings.length, bySeverity: {} };
  for (const f of findings) summary.bySeverity[f.severity] = (summary.bySeverity[f.severity] || 0) + 1;

  if (args.json) console.log(JSON.stringify({ summary, findings }, null, 2));
  else {
    console.log(`Conflict scan complete. Skills: ${skills.length}. Findings: ${findings.length}.`);
    for (const f of findings) console.log(`  ${f.severity}  ${f.title}`);
  }

  if (args.ci) process.exit(exitCodeForFindings(findings, args['fail-on'] || 'high'));
}

function runConflictList(args) {
  const db = openDb();
  const rows = db.prepare("SELECT * FROM findings WHERE type = 'conflict' AND ignored = 0 ORDER BY severity DESC, updated_at DESC").all();
  const findings = rows.map(row => ({
    ...row,
    evidence: JSON.parse(row.evidence_json || '[]'),
    skills: db.prepare('SELECT fs.*, sr.slug, sr.name, sr.local_path FROM finding_skills fs JOIN skill_records sr ON sr.id = fs.skill_id WHERE fs.finding_id = ? ORDER BY fs.role ASC, sr.slug ASC').all(row.id),
  }));
  if (args.json) return console.log(JSON.stringify(findings, null, 2));
  if (!findings.length) return console.log('No conflict findings.');
  for (const f of findings) {
    console.log(`${f.id}  ${f.severity}  ${f.title}`);
    for (const s of f.skills) console.log(`  - ${s.role}: ${s.slug}  ${s.local_path}`);
  }
}

// --- Zombie ---

function runZombies(args) {
  const db = openDb();
  const skills = listSkillObjects(db);
  const findings = detectZombies(skills);

  for (const finding of findings) {
    upsertFinding(db, finding, finding.links);
  }

  const summary = { skills: skills.length, zombieCandidates: findings.length, byLevel: {} };
  for (const f of findings) summary.byLevel[f.level || f.ruleId] = (summary.byLevel[f.level || f.ruleId] || 0) + 1;

  if (args.json) console.log(JSON.stringify({ summary, findings }, null, 2));
  else {
    console.log(`Zombie scan complete. Skills: ${skills.length}. Candidates: ${findings.length}.`);
    for (const f of findings) console.log(`  ${f.severity}  score=${(f.score || 0).toFixed(2)}  ${f.title}`);
  }

  if (args.ci) process.exit(exitCodeForFindings(findings, args['fail-on'] || 'high'));
}

function runZombieList(args) {
  const db = openDb();
  const rows = db.prepare("SELECT * FROM findings WHERE type = 'zombie' AND ignored = 0 ORDER BY updated_at DESC").all();
  const findings = rows.map(row => ({
    ...row,
    evidence: JSON.parse(row.evidence_json || '[]'),
    skills: db.prepare('SELECT fs.*, sr.slug, sr.name, sr.local_path FROM finding_skills fs JOIN skill_records sr ON sr.id = fs.skill_id WHERE fs.finding_id = ? ORDER BY fs.role ASC, sr.slug ASC').all(row.id),
  }));
  if (args.json) return console.log(JSON.stringify(findings, null, 2));
  if (!findings.length) return console.log('No zombie candidates.');
  for (const f of findings) {
    console.log(`${f.id}  ${f.severity}  ${f.title}`);
    for (const s of f.skills) console.log(`  - ${s.slug}  ${s.local_path}`);
  }
}

// --- Main ---

function usage() {
  console.log(`agent-skill-doctor Phase 3 CLI (conflict + zombie)

Commands:
  conflicts [--json] [--ci] [--fail-on high|critical|medium]
  conflict-list [--json]
  zombies [--json] [--ci] [--fail-on high|critical|medium]
  zombie-list [--json]
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'help';
  if (command === 'conflicts') return runConflicts(args);
  if (command === 'conflict-list') return runConflictList(args);
  if (command === 'zombies') return runZombies(args);
  if (command === 'zombie-list') return runZombieList(args);
  usage();
}

main();
