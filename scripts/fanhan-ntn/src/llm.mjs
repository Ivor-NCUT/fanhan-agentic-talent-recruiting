import { readKeyFromKeychain } from './auth.mjs';

const BASE = (process.env.FANHAN_DECIDER_BASE || 'https://api.perplexity.ai').replace(/\/$/, '');
const MODEL = process.env.FANHAN_DECIDER_MODEL || 'pplx-decider-latest';
const ENV_KEY =
  process.env.FANHAN_LLM_API_KEY || process.env.PERPLEXITY_API_KEY || process.env.DEEPSEEK_API_KEY || '';
const KEYCHAIN_KEY = ENV_KEY ? '' : readKeyFromKeychain() || '';
const KEY = ENV_KEY || KEYCHAIN_KEY;

export function llmConfig() {
  return {
    configured: !!KEY,
    source: ENV_KEY ? '环境变量' : KEYCHAIN_KEY ? 'Keychain' : '无',
    base: BASE,
    model: MODEL,
    hint: KEY
      ? ''
      : '未配置判断模型。运行 fanhan-ntn auth login 存入 key（从 stdin 读，不进命令行），或设置 PERPLEXITY_API_KEY。',
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
  };
}

function rawJob(j, jsonLimit = 6000) {
  return {
    职位: j.name,
    职类: j.category || null,
    状态: j.status || null,
    地点: j.locations || [],
    职位描述: clip(j.description, 3500),
    招聘偏好: j.preference ? clip(j.preference, 800) : null,
    检索JSON: j.searchJson ? JSON.stringify(j.searchJson).slice(0, jsonLimit) : null,
  };
}

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
        '候选人与该岗位之间是否存在明确的雇佣类型冲突？只有当一方明确写了正式、另一方明确写了实习时才算冲突。任一方未标注、或候选人的类型只是历史记录且注明了待确认，都不算冲突。',
      criteria: { true: '一方明确正式、另一方明确实习', false: '类型一致、或至少一方未标注' },
    },
    seniority_ok: {
      type: 'noul',
      instructions:
        '候选人的职级与岗位要求是否大致匹配？（例如实习生 vs 高级/负责人岗属于不匹配；初级岗 vs 十年经验也属于不匹配）',
      criteria: { true: '职级大致对等', false: '明显高配或低配' },
    },
  };
}

async function post(pathName, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(`${BASE}${pathName}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
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
  } finally {
    clearTimeout(timer);
  }
}

/** 单对判断：一个候选人 × 一个岗位，由 Decider 直接给概率分布 */
async function judgeOne(direction, subject, record) {
  const state =
    direction === 'job2cand'
      ? { 岗位: rawJob(subject), 候选人: rawCandidate(record) }
      : { 候选人: rawCandidate(subject), 岗位: rawJob(record) };

  const body = { model: MODEL, state, questions: questionsFor() };
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await post('/v1/decisions', body);
      const a = data.answers || {};
      const fit = a.fit || {};
      const score = typeof fit.score === 'number' ? Math.round(fit.score * 25) : null;
      const p = (k) => (typeof a[k]?.noul === 'number' ? a[k].noul : null);
      return {
        score,
        level: score == null ? '' : FIT_LEVELS[Math.round(fit.score)] || '',
        confidence: typeof fit.confidence === 'number' ? fit.confidence : null,
        fitProbabilities: fit.probabilities || null,
        mustHave: p('must_have'),
        employmentConflict: p('employment_conflict'),
        seniorityOk: p('seniority_ok'),
        usage: data.usage || null,
      };
    } catch (e) {
      lastErr = e;
      if (e.status === 400) break;
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
  return { score: null, error: lastErr?.message || '判断失败' };
}

export async function judge(direction, subject, records, { concurrency = 4, onProgress } = {}) {
  if (!KEY) throw new Error(llmConfig().hint);
  const results = new Array(records.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= records.length) return;
      results[i] = { record: records[i], llm: await judgeOne(direction, subject, records[i]) };
      done++;
      if (onProgress) onProgress(done, records.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, worker));
  return results;
}

export async function judgeSingle(direction, subject, record) {
  if (!KEY) throw new Error(llmConfig().hint);
  return judgeOne(direction, subject, record);
}
