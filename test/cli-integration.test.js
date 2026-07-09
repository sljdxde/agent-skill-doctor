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
    cwd: repoRoot,
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
    'Never run rm -rf without review.',
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
  for (const command of ['duplicates', 'risks', 'conflicts', 'zombies', 'governance', 'plan', 'apply']) {
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
    'codex-global',
    'cursor-skill',
    'opencode-skill',
  ]);
});

test('diagnose includes duplicate and version drift findings in JSON output', () => {
  const fixture = makeFixture();
  const result = run(['diagnose', '--root', fixture.skills, '--json'], {
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
  const diagnosed = run(['diagnose', '--root', fixture.skills, '--json'], {
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
