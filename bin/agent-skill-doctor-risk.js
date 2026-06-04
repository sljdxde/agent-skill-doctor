#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { loadJsonRules, scanSkillForRisks } = require('../src/doctor/risk-lite');

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
    console.error('Run first: node ./bin/agent-skill-doctor.js scan');
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
  };
}

function listSkillObjects(db) {
  return db.prepare('SELECT * FROM skill_records ORDER BY slug ASC').all().map(rowToSkill);
}

function upsertFinding(db, finding) {
  const existing = db.prepare('SELECT id FROM findings WHERE id = ?').get(finding.id);
  const at = nowIso();
  if (existing) {
    db.prepare('UPDATE findings SET type=?, severity=?, detector_id=?, rule_id=?, title=?, description=?, signature=?, evidence_json=?, recommendation=?, updated_at=? WHERE id=?')
      .run(finding.type, finding.severity, finding.detectorId, finding.ruleId || null, finding.title, finding.description, finding.signature, JSON.stringify(finding.evidence || []), finding.recommendation || null, at, finding.id);
  } else {
    db.prepare('INSERT INTO findings (id, type, severity, detector_id, rule_id, title, description, signature, evidence_json, recommendation, ignored, ignored_reason, ignored_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)')
      .run(finding.id, finding.type, finding.severity, finding.detectorId, finding.ruleId || null, finding.title, finding.description, finding.signature, JSON.stringify(finding.evidence || []), finding.recommendation || null, at, at);
  }
  db.prepare('INSERT OR IGNORE INTO finding_skills (finding_id, skill_id, role, added_at) VALUES (?, ?, ?, ?)')
    .run(finding.id, finding.skillId, 'primary', at);
}

function severityRank(severity) {
  return { info: 0, low: 1, medium: 2, high: 3, critical: 4 }[severity] || 0;
}

function exitCodeForFindings(findings, failOn) {
  const threshold = severityRank(failOn || 'high');
  let hasHigh = false;
  let hasCritical = false;
  for (const finding of findings) {
    if (finding.severity === 'critical' && severityRank(finding.severity) >= threshold) hasCritical = true;
    if (finding.severity === 'high' && severityRank(finding.severity) >= threshold) hasHigh = true;
    if (threshold <= 2 && finding.severity === 'medium') hasHigh = true;
  }
  if (hasCritical) return 2;
  if (hasHigh) return 1;
  return 0;
}

function runScan(args) {
  const db = openDb();
  const rulesDir = path.resolve(args.rules ? expandHome(args.rules) : path.join(process.cwd(), 'rules/default'));
  const rules = loadJsonRules(rulesDir);
  const skills = listSkillObjects(db);
  const findings = [];
  for (const skill of skills) {
    const skillFindings = scanSkillForRisks(skill, rules);
    for (const finding of skillFindings) upsertFinding(db, finding);
    findings.push(...skillFindings);
  }
  const summary = { skills: skills.length, rules: rules.length, riskFindings: findings.length, bySeverity: {} };
  for (const finding of findings) summary.bySeverity[finding.severity] = (summary.bySeverity[finding.severity] || 0) + 1;
  if (args.json) console.log(JSON.stringify({ summary, findings }, null, 2));
  else console.log(`Risk scan complete. Skills: ${skills.length}. Findings: ${findings.length}.`);
  if (args.ci) process.exit(exitCodeForFindings(findings, args['fail-on'] || 'high'));
}

function runList(args) {
  const db = openDb();
  const rows = db.prepare("SELECT * FROM findings WHERE type = 'risk' AND ignored = 0 ORDER BY severity DESC, updated_at DESC").all();
  if (args.json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log('No risk findings.');
  for (const row of rows) console.log(`${row.id}  ${row.severity}  ${row.rule_id}  ${row.title}`);
}

function usage() {
  console.log(`agent-skill-doctor risk scanner\n\nCommands:\n  scan [--rules <dir>] [--json] [--ci] [--fail-on high|critical|medium]\n  list [--json]\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'help';
  if (command === 'scan') return runScan(args);
  if (command === 'list') return runList(args);
  usage();
}

main();
