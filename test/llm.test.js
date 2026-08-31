'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createOpenAICompatibleProvider,
  explainFindings,
  localExplain,
  normalizeProvider,
  parseModelContent,
  redactText,
  reviewFindings,
  draftFixes,
} = require('../src/doctor/llm');

function finding(overrides = {}) {
  return {
    id: overrides.id || 'finding-1',
    type: overrides.type || 'risk',
    severity: overrides.severity || 'high',
    title: overrides.title || 'Possible credential access',
    description: overrides.description || 'The skill references /Users/alice/project/.env.',
    recommendation: overrides.recommendation || 'Review the skill before enabling it.',
    skills: overrides.skills || [{ slug: 'secret-skill', root_type: 'project_local' }],
  };
}

test('normalizeProvider supports local and OpenAI-compatible aliases', () => {
  assert.equal(normalizeProvider(), 'local');
  assert.equal(normalizeProvider('orca'), 'orcarouter');
  assert.equal(normalizeProvider('openai'), 'openai-compatible');
  assert.equal(normalizeProvider('unknown'), 'local');
});

test('redactText removes keys, secret assignments, and local paths', () => {
  const result = redactText('sk-abcdefghijk OPENAI_API_KEY=secret /Users/alice/project/.env');
  assert.doesNotMatch(result, /sk-abcdefghijk|OPENAI_API_KEY=secret|\/Users\/alice/);
  assert.match(result, /REDACTED_KEY/);
  assert.match(result, /REDACTED_SECRET/);
  assert.match(result, /REDACTED_PATH/);
});

test('redactText removes common auth tokens and Windows paths', () => {
  const result = redactText('Bearer abcdefghijk ghp_abcdefghijk JWT eyJabc.def.ghi API_TOKEN:secret C:\\Users\\alice\\skill');
  assert.doesNotMatch(result, /Bearer abcdefghijk|ghp_abcdefghijk|eyJabc\.def\.ghi|API_TOKEN:secret|C:\\Users\\alice/);
  assert.match(result, /REDACTED_AUTH/);
  assert.match(result, /REDACTED_TOKEN/);
  assert.match(result, /REDACTED_JWT/);
  assert.match(result, /REDACTED_SECRET/);
  assert.match(result, /REDACTED_PATH/);
});

test('localExplain is deterministic and does not require network access', () => {
  const result = localExplain([finding()], { lang: 'zh' });
  assert.equal(result.provider, 'local');
  assert.equal(result.fallback, false);
  assert.equal(result.items.length, 1);
  assert.match(result.summary, /本地模式/);
  assert.match(result.items[0].explanation, /可能存在凭证访问/);
  assert.match(result.items[0].nextStep, /启用技能前先审查/);
});

test('explainFindings falls back when network access is not explicitly allowed', async () => {
  const result = await explainFindings([finding()], {
    provider: 'orcarouter',
    allowNetwork: false,
    lang: 'en',
  });
  assert.equal(result.provider, 'local');
  assert.equal(result.requestedProvider, 'orcarouter');
  assert.equal(result.fallback, true);
  assert.equal(result.fallbackReason, 'network_disabled');
});

test('OpenAI-compatible provider sends redacted JSON request and parses response', async () => {
  let request;
  const codeFence = String.fromCharCode(96).repeat(3);
  const provider = createOpenAICompatibleProvider({
    provider: 'orcarouter',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'test-key',
    model: 'orcarouter/auto',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [{
              message: {
                content: codeFence + 'json\n{\"summary\":\"ok\",\"items\":[{\"findingId\":\"finding-1\",\"explanation\":\"safe\",\"nextStep\":\"review\"}]} \n' + codeFence,
              },
            }],
          };
        },
      };
    },
  });

  const result = await provider.explain([finding()], { lang: 'en' });
  assert.equal(result.summary, 'ok');
  assert.equal(result.items[0].findingId, 'finding-1');
  assert.equal(request.url, 'https://api.example.test/v1/chat/completions');
  assert.equal(request.options.headers.authorization, 'Bearer test-key');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'orcarouter/auto');
  assert.match(body.messages[1].content, /REDACTED_PATH/);
  assert.doesNotMatch(body.messages[1].content, /\/Users\/alice/);
});

test('explainFindings falls back on provider errors', async () => {
  const result = await explainFindings([finding()], {
    provider: 'orcarouter',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'test-key',
    model: 'orcarouter/auto',
    allowNetwork: true,
    fetchImpl: async () => ({ ok: false, status: 503, async json() { return {}; } }),
  });
  assert.equal(result.provider, 'local');
  assert.equal(result.requestedProvider, 'orcarouter');
  assert.equal(result.fallback, true);
  assert.match(result.fallbackReason, /Provider HTTP 503/);
});

test('parseModelContent tolerates plain text and malformed JSON', () => {
  assert.deepEqual(parseModelContent('plain explanation'), { summary: 'plain explanation', items: [] });
  assert.deepEqual(parseModelContent(''), { summary: '', items: [] });
});

test('review task parses verdict and confidence', () => {
  const result = parseModelContent(JSON.stringify({
    summary: 'reviewed',
    items: [{ findingId: 'finding-1', verdict: 'likely_true', confidence: 0.91, explanation: 'guarded', nextStep: 'confirm', guardrails: 'dry-run' }],
  }), 'review');
  assert.equal(result.items[0].verdict, 'likely_true');
  assert.equal(result.items[0].confidence, 0.91);
  assert.equal(result.items[0].guardrails, 'dry-run');
});

test('fix task filters unsafe fields and normalizes edit values', () => {
  const result = parseModelContent(JSON.stringify({
    summary: 'drafted',
    items: [{ findingId: 'finding-1', edits: [
      { field: 'description', value: 'Use this when reviewing code.\n' },
      { field: 'body', value: 'do not allow' },
    ] }],
  }), 'fix');
  assert.deepEqual(result.items[0].edits, [{ field: 'description', value: 'Use this when reviewing code.' }]);
});

test('local AI tasks remain offline and conservative', async () => {
  const reviewed = await reviewFindings([finding()], { provider: 'local', lang: 'zh' });
  assert.equal(reviewed.provider, 'local');
  assert.equal(reviewed.items[0].verdict, 'needs_review');
  const drafted = await draftFixes([finding({ type: 'description_quality' })], { provider: 'local', lang: 'zh' });
  assert.equal(drafted.provider, 'local');
  assert.deepEqual(drafted.items[0].edits, []);
});

test('remote AI tasks use structured task payloads', async () => {
  const requests = [];
  const provider = createOpenAICompatibleProvider({
    provider: 'orcarouter',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'test-key',
    model: 'orcarouter/auto',
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      const task = JSON.parse(JSON.parse(options.body).messages[1].content).task;
      const item = task === 'review'
        ? { findingId: 'finding-1', verdict: 'likely_true', confidence: 0.8, explanation: 'real', nextStep: 'confirm', guardrails: 'dry-run' }
        : { findingId: 'finding-1', edits: [{ field: 'description', value: 'Use this skill when reviewing code.' }, { field: 'script', value: 'blocked' }], explanation: 'metadata only', nextStep: 'review' };
      return { ok: true, status: 200, async json() { return { choices: [{ message: { content: JSON.stringify({ summary: task, items: [item] }) } }] }; } };
    },
  });
  const reviewed = await provider.run('review', [finding()], { lang: 'en' });
  assert.equal(reviewed.items[0].verdict, 'likely_true');
  const fixed = await provider.run('fix', [finding({ type: 'description_quality' })], { lang: 'en' });
  assert.deepEqual(fixed.items[0].edits, [{ field: 'description', value: 'Use this skill when reviewing code.' }]);
  assert.deepEqual(requests.map(request => JSON.parse(request.body.messages[1].content).task), ['review', 'fix']);
});
