'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cli = path.join(repoRoot, 'bin', 'agent-skill-doctor.js');

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd || repoRoot,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
  });
}

function makeFixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-cli-'));
  const home = path.join(temp, 'home');
  const skills = path.join(temp, 'skills');
  fs.mkdirSync(path.join(skills, 'alpha-central'), { recursive: true });
  fs.mkdirSync(path.join(skills, 'alpha-local'), { recursive: true });
  fs.mkdirSync(path.join(skills, 'danger'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'alpha-central', 'SKILL.md'), [
    '---',
    'name: Alpha',
    'source: https://github.com/example/alpha.git',
    'ref: one',
    '---',
    '# Alpha',
    'Use this skill when reviewing code to generate output.',
  ].join('\n'));
  fs.writeFileSync(path.join(skills, 'alpha-local', 'SKILL.md'), [
    '---',
    'name: Alpha',
    'source: https://github.com/example/alpha.git',
    'ref: two',
    '---',
    '# Alpha',
    'Use this skill when reviewing code to generate different output.',
  ].join('\n'));
  fs.writeFileSync(path.join(skills, 'danger', 'SKILL.md'), [
    '---',
    'name: Danger',
    '---',
    '# Danger',
    'Use this skill when testing destructive commands to generate output.',
    'Run rm -rf "$target" after the test environment is confirmed.',
  ].join('\n'));
  return { temp, home, skills };
}

function writeSkill(root, rel, name) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: Use this skill when testing default root discovery and generate ${name} output.`,
    '---',
    `# ${name}`,
    '',
    `Generate ${name} output.`,
  ].join('\n'));
}

test('main CLI exposes duplicate, risk, conflict, zombie, governance, plan, and apply commands', () => {
  const result = run(['help']);
  assert.equal(result.status, 0);
  for (const command of ['duplicates', 'risks', 'conflicts', 'zombies', 'governance', 'plan', 'apply', 'review']) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
});

test('default scan roots include requested agent skill directories', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-roots-'));
  const home = path.join(temp, 'home');
  const doctorHome = path.join(temp, 'doctor-home');

  writeSkill(home, path.join('.agent', 'skills', 'agent-skill'), 'Agent Skill');
  writeSkill(home, path.join('.agents', 'skills-core', 'active', 'agents-skill'), 'Agents Skill');
  writeSkill(home, path.join('.codex', 'skills', 'codex-global'), 'Codex Global');
  writeSkill(home, path.join('.claude', 'skills', 'claude-global'), 'Claude Global');
  writeSkill(home, path.join('.cursor', 'skills', 'cursor-skill'), 'Cursor Skill');
  writeSkill(home, path.join('.opencode', 'skills', 'opencode-skill'), 'OpenCode Skill');
  writeSkill(home, path.join('.config', 'opencode', 'skills', 'opencode-global-skill'), 'OpenCode Global Skill');
  writeSkill(home, path.join('.qoder', 'skills', 'qoder-skill'), 'Qoder Skill');
  writeSkill(home, path.join('.workbuddy', 'skills', 'workbuddy-skill'), 'WorkBuddy Skill');
  writeSkill(home, path.join('.codebuddy', 'skills', 'codebuddy-skill'), 'CodeBuddy Skill');
  writeSkill(home, path.join('.workbuddy', 'connectors', 'skills', 'connector-skill'), 'Connector Skill');

  const result = run(['scan', '--json'], {
    env: {
      AGENT_SKILL_DOCTOR_HOME: doctorHome,
      HOME: home,
      USERPROFILE: home,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  const slugs = parsed.skills.map(skill => skill.slug).sort();
  assert.deepEqual(slugs, [
    'agent-skill',
    'agents-skill',
    'claude-global',
    'codebuddy-skill',
    'codex-global',
    'connector-skill',
    'cursor-skill',
    'opencode-global-skill',
    'opencode-skill',
    'qoder-skill',
    'workbuddy-skill',
  ]);

  const reportPath = path.join(temp, 'default-roots-report.html');
  const report = run(['report', '--format', 'html', '--output', reportPath], {
    env: { AGENT_SKILL_DOCTOR_HOME: doctorHome, HOME: home, USERPROFILE: home },
  });
  assert.equal(report.status, 0, report.stderr);
  const html = fs.readFileSync(reportPath, 'utf8');
  assert.match(html, />Qoder</);
  assert.match(html, />CodeBuddy</);
  assert.match(html, />WorkBuddy</);
  assert.match(html, />OpenCode</);
});

test('default scan does not use the current repository as an implicit root', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-default-root-'));
  const home = path.join(temp, 'home');
  const doctorHome = path.join(temp, 'doctor-home');
  const cwd = path.join(temp, 'project');
  fs.mkdirSync(path.join(cwd, 'examples', 'repo-only-skill'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'examples', 'repo-only-skill', 'SKILL.md'), '# Repo Only\n\nThis must not be picked up by default scanning.\n');
  writeSkill(home, path.join('.codex', 'skills', 'codex-default'), 'Codex Default');

  const result = run(['scan', '--json'], {
    cwd,
    env: { AGENT_SKILL_DOCTOR_HOME: doctorHome, HOME: home, USERPROFILE: home },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  const slugs = parsed.skills.map(skill => skill.slug);
  assert.deepEqual(slugs, ['codex-default']);
});

test('README-only directories require --full scanning', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-readme-scan-'));
  const home = path.join(temp, 'home');
  const doctorHome = path.join(temp, 'doctor-home');
  const readmeOnly = path.join(home, '.codex', 'skills', 'readme-only');
  fs.mkdirSync(readmeOnly, { recursive: true });
  fs.writeFileSync(path.join(readmeOnly, 'README.md'), '# README-only skill candidate\n');

  const defaultScan = run(['scan', '--json'], { env: { AGENT_SKILL_DOCTOR_HOME: doctorHome, HOME: home, USERPROFILE: home } });
  assert.equal(defaultScan.status, 0, defaultScan.stderr);
  assert.equal(JSON.parse(defaultScan.stdout.slice(defaultScan.stdout.indexOf('{'))).skills.length, 0);

  const fullScan = run(['scan', '--full', '--json'], { env: { AGENT_SKILL_DOCTOR_HOME: doctorHome, HOME: home, USERPROFILE: home } });
  assert.equal(fullScan.status, 0, fullScan.stderr);
  assert.equal(JSON.parse(fullScan.stdout.slice(fullScan.stdout.indexOf('{'))).skills.length, 1);
});

test('diagnose includes duplicate and version drift findings in JSON output', () => {
  const fixture = makeFixture();
  const result = run(['diagnose', '--root', fixture.skills, '--governance-all', '--json'], {
    env: { AGENT_SKILL_DOCTOR_HOME: fixture.home },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  assert.ok(parsed.summary.duplicateGroups >= 1, JSON.stringify(parsed.summary));
  assert.ok(parsed.summary.versionDriftFindings >= 1, JSON.stringify(parsed.summary));
  assert.ok(parsed.summary.governanceFindings >= 1, JSON.stringify(parsed.summary));
  assert.ok(parsed.findings.some(f => f.type === 'duplicate'));
  assert.ok(parsed.findings.some(f => f.type === 'version_drift'));
  assert.ok(parsed.findings.some(f => f.type === 'governance'));
});

test('governance command lists registry readiness findings', () => {
  const fixture = makeFixture();
  const diagnosed = run(['diagnose', '--root', fixture.skills, '--governance-all', '--json'], {
    env: { AGENT_SKILL_DOCTOR_HOME: fixture.home },
  });
  assert.equal(diagnosed.status, 0, diagnosed.stderr);

  const result = run(['governance', '--json'], {
    env: { AGENT_SKILL_DOCTOR_HOME: fixture.home },
  });
  assert.equal(result.status, 0, result.stderr);
  const findings = JSON.parse(result.stdout.slice(result.stdout.indexOf('[')));
  assert.ok(findings.length > 0);
  assert.ok(findings.every(f => f.type === 'governance'));
});

test('report JSON includes required relationship and plan containers', () => {
  const fixture = makeFixture();
  const scan = run(['diagnose', '--root', fixture.skills, '--json'], {
    env: { AGENT_SKILL_DOCTOR_HOME: fixture.home },
  });
  assert.equal(scan.status, 0, scan.stderr);
  const report = run(['report', '--format', 'json'], {
    env: { AGENT_SKILL_DOCTOR_HOME: fixture.home },
  });
  assert.equal(report.status, 0, report.stderr);
  const match = report.stdout.match(/Report written: (.+)$/m);
  assert.ok(match, report.stdout);
  const data = JSON.parse(fs.readFileSync(match[1].trim(), 'utf8'));
  assert.ok(Array.isArray(data.findingSkills));
  assert.ok(Array.isArray(data.duplicateGroups));
  assert.ok(Array.isArray(data.duplicateGroupMembers));
  assert.equal(typeof data.optimizationPlan, 'object');
});

test('report HTML renders successfully', () => {
  const fixture = makeFixture();
  const scan = run(['diagnose', '--root', fixture.skills, '--json'], {
    env: { AGENT_SKILL_DOCTOR_HOME: fixture.home },
  });
  assert.equal(scan.status, 0, scan.stderr);

  const out = path.join(fixture.temp, 'report.html');
  const report = run(['report', '--format', 'html', '--output', out], {
    env: { AGENT_SKILL_DOCTOR_HOME: fixture.home },
  });
  assert.equal(report.status, 0, report.stderr);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /Agent Skill Doctor Report/);
  assert.match(html, new RegExp(fixture.skills.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /skill-context/);
  assert.match(html, /第 2 步 Agent 提示词/);
  assert.match(html, /step-prompt/);
  assert.match(html, /不得删除、移动、禁用/);
  assert.doesNotMatch(html, /请移除以下路径|请移除以下冗余技能副本|Remove these paths/);
});

test('report runs a complete diagnosis by default', () => {
  const fixture = makeFixture();
  const out = path.join(fixture.temp, 'report.json');
  const report = run(['report', '--root', fixture.skills, '--format', 'json', '--output', out], {
    env: { AGENT_SKILL_DOCTOR_HOME: fixture.home },
  });
  assert.equal(report.status, 0, report.stderr);
  const data = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(data.summary.duplicateGroups >= 1, JSON.stringify(data.summary));
  assert.ok(data.summary.versionDriftFindings >= 1, JSON.stringify(data.summary));
  assert.ok(data.findings.some(finding => finding.type === 'duplicate'));
});

test('plan emits expectedState and apply dry-run marks stale actions', () => {
  const fixture = makeFixture();
  const diagnosed = run(['diagnose', '--root', fixture.skills, '--json'], {
    env: { AGENT_SKILL_DOCTOR_HOME: fixture.home },
  });
  assert.equal(diagnosed.status, 0, diagnosed.stderr);
  const planFile = path.join(fixture.temp, 'plan.json');
  const planned = run(['plan', '--json', '--output', planFile], {
    env: { AGENT_SKILL_DOCTOR_HOME: fixture.home },
  });
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  assert.ok(plan.actions.length > 0);
  assert.ok(plan.actions.every(action => action.expectedState && action.expectedState.contentHash));

  const target = plan.actions[0].expectedState.localPath;
  fs.appendFileSync(path.join(target, 'SKILL.md'), '\nChanged after plan.\n');
  const applied = run(['apply', planFile, '--dry-run', '--json'], {
    env: { AGENT_SKILL_DOCTOR_HOME: fixture.home },
  });
  assert.equal(applied.status, 0, applied.stderr);
  const result = JSON.parse(applied.stdout.slice(applied.stdout.indexOf('{')));
  assert.ok(result.actions.some(action => action.status === 'stale_action'));
});

test('diagnose reconciles deleted skills, findings, and duplicate groups', () => {
  const fixture = makeFixture();
  const env = { AGENT_SKILL_DOCTOR_HOME: fixture.home };
  const first = run(['diagnose', '--root', fixture.skills, '--json'], { env });
  assert.equal(first.status, 0, first.stderr);
  const firstData = JSON.parse(first.stdout.slice(first.stdout.indexOf('{')));
  assert.ok(firstData.findings.some(f => f.skills.some(s => s.slug === 'danger')));
  assert.ok(firstData.summary.duplicateGroups >= 1);

  fs.rmSync(path.join(fixture.skills, 'danger'), { recursive: true, force: true });
  fs.rmSync(path.join(fixture.skills, 'alpha-local'), { recursive: true, force: true });
  const second = run(['diagnose', '--root', fixture.skills, '--json'], { env });
  assert.equal(second.status, 0, second.stderr);
  const secondData = JSON.parse(second.stdout.slice(second.stdout.indexOf('{')));
  assert.deepEqual(secondData.skills.map(skill => skill.slug), ['alpha']);
  assert.ok(!secondData.findings.some(f => f.skills.some(s => s.slug === 'danger')));
  assert.equal(secondData.summary.duplicateGroups, 0);
});

test('version metadata does not count as an upstream ref', () => {
  const fixture = makeFixture();
  const versionOnly = path.join(fixture.skills, 'version-only');
  fs.mkdirSync(versionOnly, { recursive: true });
  fs.writeFileSync(path.join(versionOnly, 'SKILL.md'), [
    '---',
    'name: Version Only',
    'source: https://github.com/example/version-only.git',
    'version: 1.2.3',
    '---',
    '# Version Only',
    'Use this skill when testing version metadata.',
  ].join('\n'));

  const result = run(['diagnose', '--root', fixture.skills, '--json'], {
    env: { AGENT_SKILL_DOCTOR_HOME: fixture.home },
  });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  const finding = data.findings.find(f => f.type === 'freshness' && f.ruleId === 'unpinned-source' && f.skills.some(s => s.slug === 'version-only'));
  assert.ok(finding, 'version-only skill should be reported as unpinned');
});

test('project-local agent roots are classified as project_local', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-project-'));
  const home = path.join(temp, 'home');
  const doctorHome = path.join(temp, 'doctor-home');
  const skillRoot = path.join(temp, '.codex', 'skills');
  writeSkill(skillRoot, 'local-skill', 'Local Skill');

  const result = run(['diagnose', '--root', skillRoot, '--json'], {
    cwd: temp,
    env: { AGENT_SKILL_DOCTOR_HOME: doctorHome, HOME: home, USERPROFILE: home },
  });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  const skill = data.skills.find(item => item.slug === 'local-skill');
  assert.equal(skill.root_type, 'project_local');
});

test('diagnose records project configuration references for zombie evidence', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-zombie-evidence-'));
  const home = path.join(temp, 'home');
  const doctorHome = path.join(temp, 'doctor-home');
  const skillRoot = path.join(temp, '.codex', 'skills');
  writeSkill(skillRoot, 'referenced-skill', 'Referenced Skill');
  fs.writeFileSync(path.join(temp, '.codex', 'settings.json'), JSON.stringify({ skills: ['referenced-skill'] }));

  const result = run(['diagnose', '--root', skillRoot, '--json'], {
    cwd: temp,
    env: { AGENT_SKILL_DOCTOR_HOME: doctorHome, HOME: home, USERPROFILE: home },
  });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  const skill = data.skills.find(item => item.slug === 'referenced-skill');
  assert.ok(skill, 'referenced skill should be present');
  assert.ok(skill.usage.referenceEvidence.some(item => item.path.endsWith('.codex/settings.json')));
  const finding = data.findings.find(item => item.type === 'zombie' && item.skills.some(item => item.slug === 'referenced-skill'));
  assert.ok(finding, 'referenced skill should still be reported when stale');
  const usageEvidence = finding.evidence.find(item => item.kind === 'usage-summary');
  assert.equal(usageEvidence.classification, 'stale');
  assert.equal(usageEvidence.confidenceLevel, 'high');
});

test('apply dry-run filters actions by target skill id', () => {
  const fixture = makeFixture();
  const env = { AGENT_SKILL_DOCTOR_HOME: fixture.home };
  const diagnosed = run(['diagnose', '--root', fixture.skills, '--json'], { env });
  assert.equal(diagnosed.status, 0, diagnosed.stderr);
  const planFile = path.join(fixture.temp, 'target-plan.json');
  const planned = run(['plan', '--json', '--output', planFile], { env });
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  assert.ok(plan.actions.length >= 1);
  assert.ok(plan.actions.every(action => action.type === 'review_duplicate'));
  assert.equal(plan.estimatedImpact.skillsToDisable, 0);
  assert.equal(plan.estimatedImpact.skillsToRemove, 0);
  const target = plan.actions[0].targetSkillId;
  const applied = run(['apply', planFile, '--dry-run', '--target', target, '--json'], { env });
  assert.equal(applied.status, 0, applied.stderr);
  const result = JSON.parse(applied.stdout.slice(applied.stdout.indexOf('{')));
  assert.ok(result.actions.length >= 1);
  assert.ok(result.actions.every(action => action.targetSkillId === target));
});

test('explain defaults to local mode', () => {
  const fixture = makeFixture();
  const env = { AGENT_SKILL_DOCTOR_HOME: fixture.home };
  const diagnosed = run(['diagnose', '--root', fixture.skills, '--json'], { env });
  assert.equal(diagnosed.status, 0, diagnosed.stderr);

  const explained = run(['explain', '--json', '--lang', 'zh'], { env });
  assert.equal(explained.status, 0, explained.stderr);
  const result = JSON.parse(explained.stdout.slice(explained.stdout.indexOf('{')));
  assert.equal(result.provider, 'local');
  assert.equal(result.fallback, false);
  assert.ok(result.findingCount > 0);
  assert.match(result.summary, /本地模式/);
});

test('explain falls back locally unless network access is explicit', () => {
  const fixture = makeFixture();
  const env = { AGENT_SKILL_DOCTOR_HOME: fixture.home };
  const diagnosed = run(['diagnose', '--root', fixture.skills, '--json'], { env });
  assert.equal(diagnosed.status, 0, diagnosed.stderr);

  const explained = run(['explain', '--provider', 'orcarouter', '--json'], { env });
  assert.equal(explained.status, 0, explained.stderr);
  const result = JSON.parse(explained.stdout.slice(explained.stdout.indexOf('{')));
  assert.equal(result.provider, 'local');
  assert.equal(result.requestedProvider, 'orcarouter');
  assert.equal(result.fallback, true);
  assert.equal(result.fallbackReason, 'network_disabled');
});

test('review --ai defaults to conservative local risk review', () => {
  const fixture = makeFixture();
  const env = { AGENT_SKILL_DOCTOR_HOME: fixture.home };
  const diagnosed = run(['diagnose', '--root', fixture.skills, '--json'], { env });
  assert.equal(diagnosed.status, 0, diagnosed.stderr);

  const reviewed = run(['review', '--ai', '--json', '--lang', 'zh'], { env });
  assert.equal(reviewed.status, 0, reviewed.stderr);
  const result = JSON.parse(reviewed.stdout.slice(reviewed.stdout.indexOf('{')));
  assert.equal(result.provider, 'local');
  assert.ok(result.findingCount > 0);
  assert.ok(result.items.every(item => item.verdict === 'needs_review'));
});

test('fix --ai emits a local draft without modifying skill files', () => {
  const fixture = makeFixture();
  const env = { AGENT_SKILL_DOCTOR_HOME: fixture.home };
  const diagnosed = run(['diagnose', '--root', fixture.skills, '--json'], { env });
  assert.equal(diagnosed.status, 0, diagnosed.stderr);
  const target = path.join(fixture.skills, 'danger', 'SKILL.md');
  const before = fs.readFileSync(target, 'utf8');

  const drafted = run(['fix', '--ai', '--type', 'governance', '--json', '--lang', 'zh'], { env });
  assert.equal(drafted.status, 0, drafted.stderr);
  const result = JSON.parse(drafted.stdout.slice(drafted.stdout.indexOf('{')));
  assert.equal(result.provider, 'local');
  assert.ok(result.findingCount > 0);
  assert.ok(result.items.every(item => item.edits.length === 0 && item.patch === null));
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('fix --ai never drafts a README frontmatter patch for a missing SKILL.md', () => {
  const fixture = makeFixture();
  const readmeOnly = path.join(fixture.skills, 'readme-only');
  fs.mkdirSync(readmeOnly, { recursive: true });
  fs.writeFileSync(path.join(readmeOnly, 'README.md'), '# Readme Only\n\nShort description.\n');
  const env = { AGENT_SKILL_DOCTOR_HOME: fixture.home };
  const diagnosed = run(['diagnose', '--root', fixture.skills, '--json'], { env });
  assert.equal(diagnosed.status, 0, diagnosed.stderr);

  const drafted = run(['fix', '--ai', '--type', 'scan_warning', '--json'], { env });
  assert.equal(drafted.status, 0, drafted.stderr);
  const result = JSON.parse(drafted.stdout.slice(drafted.stdout.indexOf('{')));
  const item = result.items.find(entry => entry.targetPath === readmeOnly);
  if (item) assert.equal(item.patch, null);
  assert.equal(fs.readFileSync(path.join(readmeOnly, 'README.md'), 'utf8'), '# Readme Only\n\nShort description.\n');
});
