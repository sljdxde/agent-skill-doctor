'use strict';

const { t } = require('./i18n');

const DEFAULT_ORCAROUTER_BASE_URL = 'https://api.orcarouter.ai/v1';
const DEFAULT_ORCAROUTER_MODEL = 'orcarouter/auto';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_CONTEXT_TEXT = 2_000;

const TYPE_GUIDANCE = {
  en: {
    risk: 'Review the permission before enabling this skill and require explicit confirmation for risky actions.',
    conflict: 'Choose one instruction as the scoped convention and limit the other skill to projects that need it.',
    duplicate: 'Keep the canonical copy and remove or archive redundant copies after checking references.',
    version_drift: 'Compare the variants, pin the desired source revision, and update older installations.',
    zombie: 'Confirm whether the skill is still used; archive it only after checking presets and project references.',
    governance: 'Add owner, version, lifecycle, release label, and trusted source metadata.',
    freshness: 'Check the upstream source, pin a ref or commit, and update the stale installation.',
    description_quality: 'Document when to use the skill, its inputs and outputs, and any safety constraints.',
    scan_warning: 'Fix the skill structure or frontmatter so the skill can be discovered and interpreted reliably.',
    unknown: 'Review the finding and follow its recommendation before changing the skill.',
  },
  zh: {
    risk: '启用技能前先审查其权限；涉及高风险操作时要求用户明确确认。',
    conflict: '选择一个指令作为项目范围内的约定，并限制另一个技能的适用范围。',
    duplicate: '确认引用关系后保留规范副本，移除或归档冗余副本。',
    version_drift: '比较不同版本，锁定目标来源版本，并更新较旧的安装。',
    zombie: '先确认技能是否仍在使用；检查预设和项目引用后再归档。',
    governance: '补充 owner、version、lifecycle、发布标签和可信来源元数据。',
    freshness: '检查上游来源，锁定 ref 或 commit，并更新过期安装。',
    description_quality: '补充使用时机、输入输出和安全限制说明。',
    scan_warning: '修复技能结构或 frontmatter，确保它能被稳定发现和解析。',
    unknown: '先阅读发现详情和建议，再决定是否修改技能。',
  },
};

const TASK_GUIDANCE = {
  explain: {
    en: 'Explain each finding and give a safe next step.',
    zh: '解释每个诊断发现，并给出安全的下一步。',
  },
  review: {
    en: 'Review whether each risk finding is likely real, a false positive, or still needs human review. Use only the supplied evidence.',
    zh: '判断每个风险发现更可能是真风险、误报，还是仍需人工复核。只能使用提供的证据。',
  },
  fix: {
    en: 'Draft minimal metadata edits for the supplied finding. Return only safe frontmatter field edits; do not rewrite skill instructions or scripts.',
    zh: '为给定发现生成最小元数据编辑。只能返回安全的 frontmatter 字段编辑，不要改写 Skill 指令或脚本。',
  },
};

const FIXABLE_FIELDS = new Set(['name', 'description', 'owner', 'version', 'lifecycle', 'status', 'label', 'source', 'ref', 'commit']);

function responseShape(task, lang) {
  if (task === 'review') {
    return lang === 'zh'
      ? '{"summary":"...","items":[{"findingId":"...","verdict":"likely_true|likely_false_positive|needs_review","confidence":0.0,"explanation":"...","nextStep":"...","guardrails":"..."}]}'
      : '{"summary":"...","items":[{"findingId":"...","verdict":"likely_true|likely_false_positive|needs_review","confidence":0.0,"explanation":"...","nextStep":"...","guardrails":"..."}]}';
  }
  if (task === 'fix') {
    return '{"summary":"...","items":[{"findingId":"...","edits":[{"field":"description","value":"..."}],"explanation":"...","nextStep":"..."}]}';
  }
  return '{"summary":"...","items":[{"findingId":"...","explanation":"...","nextStep":"..."}]}';
}

function normalizeProvider(provider) {
  const value = String(provider || 'local').trim().toLowerCase();
  if (value === 'orca' || value === 'orcarouter') return 'orcarouter';
  if (value === 'openai' || value === 'openai-compatible' || value === 'compatible') return 'openai-compatible';
  return 'local';
}

function redactText(value) {
  return String(value || '')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(/\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{8,}\b/gi, '[REDACTED_TOKEN]')
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[REDACTED_AUTH]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/\b[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*(?:\s*=\s*|:\s*)[^,\s"'`]+/gi, '[REDACTED_SECRET]')
    .replace(/\/(?:Users|home|private\/var|tmp)\/[^\s"'\x60]+/g, '[REDACTED_PATH]')
    .replace(/\b[A-Za-z]:[\\/][^\s"'\x60]+/g, '[REDACTED_PATH]')
    .slice(0, MAX_CONTEXT_TEXT);
}

function normalizeFinding(finding) {
  const skills = (finding.skills || []).map(skill => ({
    slug: redactText(skill.slug || skill.name || ''),
    rootType: skill.root_type || skill.rootType || null,
  }));
  return {
    id: String(finding.id || ''),
    type: String(finding.type || 'unknown'),
    severity: String(finding.severity || 'info'),
    title: redactText(finding.title || ''),
    description: redactText(finding.description || ''),
    recommendation: redactText(finding.recommendation || ''),
    evidence: (finding.evidence || []).slice(0, 5).map(item => ({
      file: redactText(item.file || ''),
      text: redactText(item.text || ''),
      anchor: redactText(item.anchor || ''),
      kind: item.kind || undefined,
    })),
    skills,
  };
}

function buildFindingContext(findings, options = {}) {
  const maxFindings = Math.max(1, Math.min(50, Number(options.maxFindings) || 10));
  return findings.slice(0, maxFindings).map(normalizeFinding);
}

function localExplain(findings, options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const items = buildFindingContext(findings, options).map(finding => ({
    findingId: finding.id,
    explanation: localExplanationText(finding, lang),
    nextStep: lang === 'zh'
      ? `${TYPE_GUIDANCE.zh[finding.type] || TYPE_GUIDANCE.zh.unknown}${finding.recommendation ? ` 具体建议：${finding.recommendation}` : ''}`
      : finding.recommendation || TYPE_GUIDANCE.en[finding.type] || TYPE_GUIDANCE.en.unknown,
  }));
  const highest = findings.reduce((current, finding) => {
    const rank = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
    return (rank[finding.severity] || 0) > (rank[current] || 0) ? finding.severity : current;
  }, 'info');
  const summary = lang === 'zh'
    ? '本地模式分析了 ' + items.length + ' 个发现，最高严重程度为 ' + highest + '。'
    : 'Local mode analyzed ' + items.length + ' finding(s); highest severity is ' + highest + '.';
  return { provider: 'local', requestedProvider: 'local', model: null, fallback: false, summary, items };
}

function localExplanationText(finding, lang) {
  const translatedTitle = t(`finding.${finding.title}`, lang);
  const title = translatedTitle === `finding.${finding.title}` ? finding.title : translatedTitle;
  if (lang !== 'zh') return finding.description || 'This finding needs human review.';
  const detail = finding.description ? `诊断摘要：${finding.description}` : '该发现需要人工审查。';
  return title ? `${title}。${detail}` : detail;
}

function endpointFor(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('Missing OpenAI-compatible base URL');
  return /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
}

function cleanModelText(content) {
  const text = Array.isArray(content)
    ? content.map(part => typeof part === 'string' ? part : part?.text || '').join('')
    : String(content || '');
  return text.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/i, '').trim();
}

function parseModelContent(content, task = 'explain') {
  const cleaned = cleanModelText(content);
  if (!cleaned) return { summary: '', items: [] };
  try {
    const parsed = JSON.parse(cleaned);
    const items = Array.isArray(parsed.items) ? parsed.items.map(item => {
      const normalized = {
        findingId: String(item.findingId || ''),
        explanation: String(item.explanation || ''),
        nextStep: String(item.nextStep || ''),
      };
      if (task === 'review') {
        normalized.verdict = ['likely_true', 'likely_false_positive', 'needs_review'].includes(item.verdict)
          ? item.verdict
          : 'needs_review';
        normalized.confidence = Math.max(0, Math.min(1, Number(item.confidence) || 0));
        normalized.guardrails = String(item.guardrails || '');
      }
      if (task === 'fix') {
        normalized.edits = Array.isArray(item.edits)
          ? item.edits
            .filter(edit => FIXABLE_FIELDS.has(String(edit.field || '')) && edit.value != null)
            .slice(0, 12)
            .map(edit => ({ field: String(edit.field), value: String(edit.value).replace(/[\r\n]+/g, ' ').trim() }))
          : [];
      }
      return normalized;
    }) : [];
    return {
      summary: String(parsed.summary || ''),
      items,
    };
  } catch {
    return { summary: cleaned, items: [] };
  }
}

function buildFixContext(findings, options = {}) {
  return buildFindingContext(findings, options).map((finding, index) => {
    const original = findings[index] || {};
    const skill = original.skills?.[0] || {};
    const frontmatter = original.frontmatter || skill.frontmatter || {};
    return {
      ...finding,
      skill: {
        slug: redactText(skill.slug || skill.name || ''),
        name: redactText(skill.name || ''),
        description: redactText(skill.description || ''),
        frontmatter: Object.fromEntries(Object.entries(frontmatter).slice(0, 30).map(([key, value]) => [key, redactText(value)])),
      },
    };
  });
}

function localReviewFindings(findings, options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const items = buildFindingContext(findings, options).map(finding => ({
    findingId: finding.id,
    verdict: finding.type === 'risk' ? 'needs_review' : 'needs_review',
    confidence: 0.25,
    explanation: lang === 'zh'
      ? '本地规则只能说明匹配到了风险模式，无法可靠判断真实意图。'
      : 'Local rules show that a risk pattern matched, but cannot reliably determine intent.',
    nextStep: lang === 'zh' ? '查看证据上下文，并在启用前要求用户确认。' : 'Review the evidence context and require confirmation before enabling the skill.',
    guardrails: lang === 'zh' ? '优先增加确认、范围限制和 dry-run。' : 'Prefer confirmation, scope limits, and a dry-run path.',
  }));
  return {
    provider: 'local', requestedProvider: 'local', model: null, fallback: false,
    summary: lang === 'zh' ? `本地规则复核了 ${items.length} 个风险发现；所有项目仍需人工确认。` : `Local rules reviewed ${items.length} risk finding(s); all items still need human confirmation.`,
    items,
  };
}

function localFixFindings(findings, options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const items = buildFindingContext(findings, options).map(finding => ({
    findingId: finding.id,
    edits: [],
    explanation: lang === 'zh'
      ? '本地模式不会凭空编造 Skill 内容，只生成审阅提示。'
      : 'Local mode does not invent skill content; it only produces a review prompt.',
    nextStep: lang === 'zh' ? '显式允许联网后再让模型生成元数据草稿，或手动补充字段。' : 'Explicitly allow network access for a model-generated metadata draft, or edit the fields manually.',
  }));
  return {
    provider: 'local', requestedProvider: 'local', model: null, fallback: false,
    summary: lang === 'zh' ? `本地模式生成了 ${items.length} 个修复建议，但没有直接修改文件。` : `Local mode generated ${items.length} repair suggestion(s) without editing files.`,
    items,
  };
}

function createOpenAICompatibleProvider(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const endpoint = endpointFor(options.baseUrl);
  const apiKey = String(options.apiKey || '');
  const model = String(options.model || '');
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  if (typeof fetchImpl !== 'function') throw new Error('Fetch API is unavailable');
  if (!apiKey) throw new Error('Missing API key');
  if (!model) throw new Error('Missing model');

  return {
    name: options.provider || 'openai-compatible',
    model,
    async run(task, findings, contextOptions = {}) {
      const lang = contextOptions.lang === 'zh' ? 'zh' : 'en';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            temperature: 0.1,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: lang === 'zh'
                  ? `你是 Agent Skill Doctor 的诊断助手。${TASK_GUIDANCE[task]?.zh || TASK_GUIDANCE.explain.zh} 返回 JSON：${responseShape(task, lang)}。不要编造路径、密钥或未提供的事实。`
                  : `You are an Agent Skill Doctor diagnostic assistant. ${TASK_GUIDANCE[task]?.en || TASK_GUIDANCE.explain.en} Return JSON: ${responseShape(task, lang)}. Do not invent paths, secrets, or facts.`,
              },
              {
                role: 'user',
                content: JSON.stringify({ language: lang, task, findings: task === 'fix' ? buildFixContext(findings, contextOptions) : buildFindingContext(findings, contextOptions) }),
              },
            ],
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Provider HTTP ' + response.status);
        const payload = await response.json();
        return parseModelContent(payload?.choices?.[0]?.message?.content, task);
      } finally {
        clearTimeout(timeout);
      }
    },
    async explain(findings, contextOptions = {}) {
      return this.run('explain', findings, contextOptions);
    },
  };
}

function providerOptions(options = {}) {
  const env = options.env || process.env;
  const provider = normalizeProvider(options.provider || env.AGENT_SKILL_DOCTOR_LLM_PROVIDER || 'local');
  if (provider === 'local') return { provider };
  if (provider === 'orcarouter') {
    return {
      provider,
      baseUrl: options.baseUrl || env.ORCAROUTER_BASE_URL || DEFAULT_ORCAROUTER_BASE_URL,
      apiKey: options.apiKey || env.ORCAROUTER_API_KEY || '',
      model: options.model || env.ORCAROUTER_MODEL || DEFAULT_ORCAROUTER_MODEL,
      timeoutMs: options.timeoutMs || env.AGENT_SKILL_DOCTOR_LLM_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
      fetchImpl: options.fetchImpl,
    };
  }
  return {
    provider,
    baseUrl: options.baseUrl || env.LLM_BASE_URL || '',
    apiKey: options.apiKey || env.OPENAI_API_KEY || '',
    model: options.model || env.LLM_MODEL || '',
    timeoutMs: options.timeoutMs || env.AGENT_SKILL_DOCTOR_LLM_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
  };
}

async function explainFindings(findings, options = {}) {
  return runTask('explain', findings, options);
}

async function reviewFindings(findings, options = {}) {
  return runTask('review', findings, options);
}

async function draftFixes(findings, options = {}) {
  return runTask('fix', findings, options);
}

async function runTask(task, findings, options = {}) {
  const local = task === 'review'
    ? localReviewFindings(findings, options)
    : task === 'fix' ? localFixFindings(findings, options) : localExplain(findings, options);
  const config = providerOptions(options);
  if (config.provider === 'local') return local;
  if (!options.allowNetwork) return { ...local, requestedProvider: config.provider, fallback: true, fallbackReason: 'network_disabled' };

  try {
    const provider = createOpenAICompatibleProvider(config);
    const remote = await provider.run(task, findings, options);
    return { ...remote, provider: config.provider, requestedProvider: config.provider, model: config.model, fallback: false };
  } catch (error) {
    return {
      ...local,
      requestedProvider: config.provider,
      fallback: true,
      fallbackReason: error?.name === 'AbortError' ? 'timeout' : String(error?.message || 'provider_error').slice(0, 120),
    };
  }
}

module.exports = {
  DEFAULT_ORCAROUTER_BASE_URL,
  DEFAULT_ORCAROUTER_MODEL,
  buildFindingContext,
  createOpenAICompatibleProvider,
  explainFindings,
  localExplain,
  localReviewFindings,
  localFixFindings,
  reviewFindings,
  draftFixes,
  runTask,
  normalizeProvider,
  parseModelContent,
  providerOptions,
  redactText,
};
