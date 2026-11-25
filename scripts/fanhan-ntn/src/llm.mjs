import { readKeyFromKeychain } from './auth.mjs';

const DEFAULT_BASE = 'https://api.perplexity.ai';
const DEFAULT_MODEL = 'pplx-decider-latest';
const KNOWN_PROVIDERS = new Set(['perplexity', 'deepseek', 'custom']);
const OFFICIAL_ENDPOINTS = new Map([
  ['https://api.perplexity.ai', { provider: 'perplexity', name: 'Perplexity' }],
  ['https://api.deepseek.com', { provider: 'deepseek', name: 'DeepSeek' }],
]);
const OFFICIAL_PATHS = new Set(['', '/v1']);

function endpointError(message) {
  return new Error(`判断模型 endpoint 无效：${message}`);
}

/** 解析并校验 endpoint；认证信息、query、hash、HTTP 都在选 key 之前拒绝。 */
function parseEndpoint(raw) {
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch {
    throw endpointError('必须是完整的 HTTPS URL');
  }
  if (url.protocol !== 'https:') throw endpointError('必须使用 HTTPS');
  if (url.username || url.password) throw endpointError('不能包含 URL 账号或密码');
  if (url.search || url.hash) throw endpointError('不能包含 query 或 hash');
  const path = url.pathname.replace(/\/+$/, '') || '';
  return { url, origin: url.origin, path };
}

function keyFor(provider, env, useKeychain) {
  if (env.FANHAN_LLM_API_KEY) return { key: env.FANHAN_LLM_API_KEY, source: 'FANHAN_LLM_API_KEY' };
  if (provider === 'perplexity' && env.PERPLEXITY_API_KEY) return { key: env.PERPLEXITY_API_KEY, source: 'PERPLEXITY_API_KEY' };
  if (provider === 'deepseek' && env.DEEPSEEK_API_KEY) return { key: env.DEEPSEEK_API_KEY, source: 'DEEPSEEK_API_KEY' };
  if (provider === 'perplexity' && useKeychain) {
    const key = readKeyFromKeychain();
    if (key) return { key, source: 'Keychain' };
  }
  return { key: '', source: 'none' };
}

/**
 * 凭据严格绑定 provider / endpoint / key。
 * provider 特定 key 与 Keychain 只在精确匹配的官方 origin 上使用；
 * 自定义 endpoint 只能显式使用 FANHAN_LLM_API_KEY。
 */
export function llmConfig(env = process.env, { useKeychain = env === process.env } = {}) {
  const explicit = String(env.FANHAN_DECIDER_PROVIDER || '').trim().toLowerCase();
  if (explicit && !KNOWN_PROVIDERS.has(explicit)) {
    throw endpointError(`未知 provider「${explicit}」；只支持 perplexity、deepseek、custom`);
  }

  const parsed = parseEndpoint(env.FANHAN_DECIDER_BASE || DEFAULT_BASE);
  const official = OFFICIAL_ENDPOINTS.get(parsed.origin);
  if (official && !OFFICIAL_PATHS.has(parsed.path)) {
    throw endpointError(`${official.name} 官方 endpoint 只接受根路径或 /v1`);
  }

  let provider;
  let base;
  if (official) {
    if (explicit && explicit !== official.provider) {
      throw endpointError(`provider=${explicit} 与官方 endpoint（${official.provider}）不一致`);
    }
    provider = official.provider;
    base = parsed.origin; // 统一为 origin，post() 再拼 /v1/decisions，避免 /v1/v1/decisions
  } else {
    if (explicit && explicit !== 'custom') {
      throw endpointError(`provider=${explicit} 不能使用非官方 endpoint；自定义端点必须显式 provider=custom`);
    }
    provider = 'custom';
    base = `${parsed.origin}${parsed.path}`;
  }

  const { key, source } = keyFor(provider, env, useKeychain);
  const model = env.FANHAN_DECIDER_MODEL || DEFAULT_MODEL;
  const hint = key
    ? ''
    : provider === 'custom'
      ? `未配置判断模型（provider=custom，endpoint=${base}）。自定义 endpoint 只接受显式 FANHAN_LLM_API_KEY，不会使用 PERPLEXITY_API_KEY / DEEPSEEK_API_KEY / Keychain。`
      : `未配置判断模型（provider=${provider}，endpoint=${base}）。运行 fanhan-ntn auth login 存入 key，或设置与 provider 匹配的 FANHAN_LLM_API_KEY / PERPLEXITY_API_KEY / DEEPSEEK_API_KEY。`;
  return {
    configured: !!key,
    key,
    keySource: source,
    source: source === 'none' ? '无' : source,
    provider,
    base,
    model,
    hint,
  };
}

const clip = (s, n) => {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n)}…` : str;
};

/** 传给 Decider 的原始材料：尽量保留检索 JSON 原貌，不做事先摘要 */
function rawCandidate(c, jsonLimit = 12000) {
  const json = c.searchJson ? JSON.stringify(c.searchJson).slice(0, jsonLimit) : '';
  return {
    姓名: c.name,
    职类: c.category || null,
    检索JSON: json || null,
    备注: json ? null : clip(c.note, 2500),
    邮件正文: json ? null : clip(c.emailBody, 1500),
    备注补充: json && c.note ? clip(c.note, 600) : null,
    材料来源: c.materialSource || null,
    回退说明: c.fallbackReason || null,
  };
}

function rawJob(j, jsonLimit = 6000) {
  return {
    职位: j.name,
    职类: j.category || null,
    状态: j.status || null,
    地点: j.locations || [],
    职位描述: clip(j.description, 3500),
    描述来源: j.descriptionSource || null,
    招聘偏好: j.preference ? clip(j.preference, 800) : null,
    偏好来源: j.preferenceSource || null,
    检索JSON: j.searchJson ? JSON.stringify(j.searchJson).slice(0, jsonLimit) : null,
    检索JSON说明: j.descriptionDiff?.changed ? '历史检索 JSON 与当前 Notion 职位描述不同，以当前职位描述为准' : null,
  };
}

const FIT_LEVEL_NAMES = ['明显不适合', '偏弱', '可以一试', '比较合适', '非常合适'];
const FIT_LEVELS = [
  '明显不适合：核心技能栈不重合，或方向、职级明显不符',
  '偏弱：有部分相关经验，但缺岗位最关键的那一项能力',
  '可以一试：方向对，关键能力有一项需要面试验证',
  '比较合适：核心要求基本满足，可以直接安排初面',
  '非常合适：材料能直接证明覆盖岗位全部关键要求，且有同类业务的量化成果',
];

function questionsFor() {
  return {
    fit: {
      type: 'score',
      instructions:
        '判断这位候选人能不能直接推进到面试，并据此落在对应的档位。先找出岗位真正看重的两三项核心能力，再看候选人材料是否有事实能证明他具备。\n要求：\n1. 材料里只是出现“相关”“了解”“参与”这类泛泛描述，不构成具备该能力；必须有具体项目、产出或量化结果才算。\n2. 材料没有提到的能力一律视为未知，不得推断具备。\n3. 简历写了职责但看不出个人贡献边界的，不能按“具备”处理。\n4. 大部分候选人应当落在“明显不适合”“偏弱”“可以一试”三档；只有当材料能证明覆盖全部关键要求时才给“非常合适”，不要因为整体看着还行就给高档位。',
      criteria: FIT_LEVELS,
    },
    must_have: {
      type: 'noul',
      instructions:
        '该候选人是否满足岗位写明的硬性要求（学历、年限、必备技术栈、语言、必须的行业经历）？材料完全没有提到某一项硬性要求时，按不满足处理。',
      criteria: { true: '写明的硬性要求都能在材料中找到对应事实', false: '至少一项硬性要求缺失或材料无法证明' },
    },
    employment_conflict: {
      type: 'noul',
      instructions:
        '候选人与该岗位之间是否存在明确的雇佣类型冲突？只有当一方明确写了正式、另一方明确写了实习或兼职时才算冲突。任一方未标注、或候选人的类型只是历史记录且注明了待确认，都不算冲突。',
      criteria: { true: '一方明确正式、另一方明确实习/兼职', false: '类型一致、或至少一方未标注' },
    },
    seniority_ok: {
      type: 'noul',
      instructions:
        '候选人的职级与岗位要求是否大致匹配？（例如实习生 vs 高级/负责人岗属于不匹配；初级岗 vs 十年经验也属于不匹配）',
      criteria: { true: '职级大致对等', false: '明显高配或低配' },
    },
  };
}

function modalLevel(probabilities) {
  if (!probabilities || typeof probabilities !== 'object') return null;
  let best = null;
  let bestValue = -Infinity;
  for (const [key, raw] of Object.entries(probabilities)) {
    const index = Number(key);
    const value = Number(raw);
    if (!Number.isInteger(index) || !Number.isFinite(value)) continue;
    if (value > bestValue) { best = index; bestValue = value; }
  }
  return best;
}

async function post(pathName, body, { env, fetchImpl, retryDelayMs } = {}) {
  const cfg = llmConfig(env, { useKeychain: !env });
  if (!cfg.configured) throw new Error(cfg.hint);
  const doFetch = fetchImpl || globalThis.fetch;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const res = await doFetch(`${cfg.base}${pathName}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`判断接口 ${res.status}：${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (e.status === 400) break;
      if (attempt < 2) {
        const delay = retryDelayMs ?? Number(env?.FANHAN_LLM_RETRY_DELAY_MS ?? 700 * (attempt + 1));
        await new Promise((r) => setTimeout(r, delay));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** 单对判断：一个候选人 × 一个岗位，由 Decider 直接给概率分布 */
async function judgeOne(direction, subject, record, opts = {}) {
  const state =
    direction === 'job2cand'
      ? { 岗位: rawJob(subject), 候选人: rawCandidate(record) }
      : { 候选人: rawCandidate(subject), 岗位: rawJob(record) };

  const body = { model: llmConfig(opts.env, { useKeychain: !opts.env }).model, state, questions: questionsFor() };
  try {
    const data = await post('/v1/decisions', body, opts);
    const a = data.answers || {};
    const fit = a.fit || {};
    const score = typeof fit.score === 'number' ? Math.round(fit.score * 25) : null;
    const expectedIndex = typeof fit.score === 'number' ? Math.round(fit.score) : null;
    const modalIndex = modalLevel(fit.probabilities);
    const p = (k) => (typeof a[k]?.noul === 'number' ? a[k].noul : null);
    return {
      score,
      level: expectedIndex == null ? '' : FIT_LEVEL_NAMES[expectedIndex] || '',
      levelDescription: expectedIndex == null ? '' : FIT_LEVELS[expectedIndex] || '',
      levelBasis: 'expected-score-rounded',
      levelIndex: expectedIndex,
      modalLevel: modalIndex == null ? '' : FIT_LEVEL_NAMES[modalIndex] || '',
      modalLevelDescription: modalIndex == null ? '' : FIT_LEVELS[modalIndex] || '',
      modalLevelIndex: modalIndex,
      confidence: typeof fit.confidence === 'number' ? fit.confidence : null,
      fitProbabilities: fit.probabilities || null,
      mustHave: p('must_have'),
      employmentConflict: p('employment_conflict'),
      seniorityOk: p('seniority_ok'),
      usage: data.usage || null,
    };
  } catch (e) {
    return { score: null, error: e.message || '判断失败' };
  }
}

function validateConcurrency(value) {
  const n = value == null ? 4 : Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`concurrency 必须为正整数，收到 ${value}`);
  return n;
}

export async function judge(direction, subject, records, { concurrency = 4, onProgress, ...opts } = {}) {
  const cfg = llmConfig(opts.env, { useKeychain: !opts.env });
  if (!cfg.configured) throw new Error(cfg.hint);
  const width = validateConcurrency(concurrency);
  const results = new Array(records.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= records.length) return;
      results[i] = { record: records[i], llm: await judgeOne(direction, subject, records[i], opts) };
      done++;
      if (onProgress) onProgress(done, records.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, records.length) }, worker));
  const failed = results.filter((r) => r.llm?.error).length;
  const succeeded = results.length - failed;
  return {
    results,
    summary: {
      total: results.length,
      succeeded,
      failed,
      partial: failed > 0 && succeeded > 0,
      allFailed: results.length > 0 && failed === results.length,
    },
  };
}

export async function judgeSingle(direction, subject, record, opts = {}) {
  const cfg = llmConfig(opts.env, { useKeychain: !opts.env });
  if (!cfg.configured) throw new Error(cfg.hint);
  return judgeOne(direction, subject, record, opts);
}

export { FIT_LEVEL_NAMES };
