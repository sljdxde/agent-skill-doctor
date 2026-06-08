'use strict';

/**
 * Basic usage example for agent-skill-doctor library
 *
 * This example demonstrates how to use the library programmatically
 * to analyze agent skills.
 */

const {
  detectDuplicateGroups,
  detectVersionDrift,
  detectConflicts,
  detectZombies,
  scanSkillForRisks,
  loadJsonRules,
  sha256,
  DEFAULT_CONFLICT_RULES
} = require('agent-skill-doctor');

// Example skill data structure
const exampleSkills = [
  {
    id: 'skill-1',
    name: 'npm-installer',
    description: 'Install npm packages',
    content: 'npm install <package>',
    source: 'https://github.com/example/npm-installer',
    hash: sha256('npm install <package>'),
    tags: ['npm', 'installer'],
    lastUpdated: '2026-01-15'
  },
  {
    id: 'skill-2',
    name: 'npm-installer-v2',
    description: 'Install npm packages (v2)',
    content: 'npm install <package>',
    source: 'https://github.com/example/npm-installer',
    hash: sha256('npm install <package>'),
    tags: ['npm', 'installer'],
    lastUpdated: '2026-02-20'
  },
  {
    id: 'skill-3',
    name: 'pnpm-installer',
    description: 'Install packages with pnpm',
    content: 'pnpm install <package>',
    source: 'https://github.com/example/pnpm-installer',
    hash: sha256('pnpm install <package>'),
    tags: ['pnpm', 'installer'],
    lastUpdated: '2026-03-10'
  },
  {
    id: 'skill-4',
    name: 'unused-skill',
    description: 'An old unused skill',
    content: 'some old command',
    source: 'https://github.com/example/unused',
    hash: sha256('some old command'),
    tags: ['deprecated'],
    lastUpdated: '2024-01-01'
  }
];

console.log('=== Agent Skill Doctor - Basic Usage Example ===\n');

// 1. Detect duplicates
console.log('1. Detecting duplicates...');
const duplicates = detectDuplicateGroups(exampleSkills);
console.log(`   Found ${duplicates.length} duplicate groups`);
duplicates.forEach((group, i) => {
  console.log(`   Group ${i + 1}: ${group.type} - ${group.skills.map(s => s.name).join(', ')}`);
});

// 2. Detect version drift
console.log('\n2. Detecting version drift...');
const drift = detectVersionDrift(exampleSkills);
console.log(`   Found ${drift.length} version drift issues`);
drift.forEach((d, i) => {
  console.log(`   Drift ${i + 1}: ${d.source || d.slug} has ${d.hashes.length} different versions`);
});

// 3. Detect conflicts
console.log('\n3. Detecting conflicts...');
const conflicts = detectConflicts(exampleSkills, DEFAULT_CONFLICT_RULES);
console.log(`   Found ${conflicts.length} conflicts`);
conflicts.forEach((c, i) => {
  console.log(`   Conflict ${i + 1}: ${c.type} between ${c.skills.map(s => s.name).join(' and ')}`);
});

// 4. Detect zombies
console.log('\n4. Detecting zombies...');
const zombies = detectZombies(exampleSkills);
console.log(`   Found ${zombies.length} zombie candidates`);
zombies.forEach((z, i) => {
  console.log(`   Zombie ${i + 1}: ${z.title} (score: ${z.score}, level: ${z.level})`);
});

// 5. Scan for risks
console.log('\n5. Scanning for risks...');
const rulesDir = './rules/default';
const rules = loadJsonRules(rulesDir);
console.log(`   Loaded ${rules.length} risk rules`);

exampleSkills.forEach(skill => {
  const risks = scanSkillForRisks(skill, rules);
  if (risks.length > 0) {
    console.log(`   ${skill.name}: ${risks.length} risks found`);
    risks.forEach(r => console.log(`     - ${r.ruleId}: ${r.message}`));
  }
});

console.log('\n=== Example completed ===');
