import { tokenize, BM25 } from './text.mjs';
import { EMP_LABEL } from './parse.mjs';

const ADJ = {
  data_ai: ['engineering', 'product'],
  engineering: ['data_ai', 'product'],
  product: ['design', 'data_ai', 'engineering', 'operations'],
  design: ['product', 'growth_marketing'],
  growth_marketing: ['sales_business', 'design', 'product', 'operations'],
  operations: ['growth_marketing', 'product', 'sales_business'],
  sales_business: ['growth_marketing', 'operations'],
  other: [],
};

export function categoryRelation(a, b) {
  if (!a || !b) return 'unknown';
  if (a === b) return 'same';
  if ((ADJ[a] || []).includes(b) || (ADJ[b] || []).includes(a)) return 'adjacent';
  return 'distant';
}

const NOT_SEEKING = new Set([
  'not_looking', 'not looking', 'notlooking', 'not-seeking', 'not seeking',
  'withdrawn', 'withdraw', 'closed',
  '不找工作', '不看机会', '暂不考虑', '暂停求职', '停止求职', '已撤回', '撤回', '已入职', '已停止',
]);

/** 未知求职状态保留待确认；只有明确不求职/已撤回才排除。 */
export function seekingAllows(status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s) return true;
  if (NOT_SEEKING.has(s)) return false;
  return !/(不求职|不找工作|不看机会|暂不考虑|暂停求职|停止求职|已撤回|已入职|已停止)/.test(s);
}

function companyIdsOf(record) {
  return new Set([...(record?.companyIds || []), ...(record?.relations?.companies || [])].filter(Boolean));
}

function alreadyRecommended(subject, record, direction) {
  const candidate = direction === 'job2cand' ? record : subject;
  const job = direction === 'job2cand' ? subject : record;
  const recommended = new Set(candidate?.relations?.companies || []);
  if (!recommended.size) return false;
  for (const id of job?.companyIds || []) if (recommended.has(id)) return true;
  return false;
}

/**
 * 只做“筛出待判断的记录”，不做任何打分。
 * 排他条件都是硬事实：岗位状态、雇佣类型冲突、职类跨度、重复/不求职/已推荐公司。
 * 记录数超过上限时才用关键词召回裁剪，并在输出里明确告知。
 */
export function buildPool(direction, subject, records, opts = {}) {
  const {
    includeClosed = false,
    includeUnknownStatus = false,
    includeDuplicates = false,
    includeNotSeeking = false,
    includeRecommended = false,
    anyCategory = false,
    anyEmployment = false,
    maxRecords = 60,
    keyword = '',
  } = opts;

  const stats = {
    total: records.length,
    closed: 0,
    unknownStatus: 0,
    employment: 0,
    category: 0,
    duplicate: 0,
    notSeeking: 0,
    recommended: 0,
    recalled: 0,
    kept: 0,
    details: [],
  };
  let pool = [];

  for (const r of records) {
    const job = direction === 'job2cand' ? subject : r;
    const cand = direction === 'job2cand' ? r : subject;

    if (!job.status) {
      if (!includeUnknownStatus) {
        stats.unknownStatus++;
        continue;
      }
    } else if (!includeClosed && job.status !== '招聘中') {
      stats.closed++;
      continue;
    }

    const j = job.empType?.value || 'unknown';
    const c = cand.empType?.value || 'unknown';
    if (!anyEmployment && j !== 'unknown' && c !== 'unknown' && j !== c) {
      stats.employment++;
      continue;
    }
    const rel = categoryRelation(job.categoryKey, cand.categoryKey);
    if (!anyCategory && rel === 'distant') {
      stats.category++;
      continue;
    }
    if (!includeDuplicates && cand.duplicate === true) {
      stats.duplicate++;
      continue;
    }
    if (!includeNotSeeking && !seekingAllows(cand.seekingStatus)) {
      stats.notSeeking++;
      continue;
    }
    if (!includeRecommended && alreadyRecommended(subject, r, direction)) {
      stats.recommended++;
      continue;
    }
    pool.push(r);
  }

  if (pool.length > maxRecords) {
    const queryTokens = [...new Set(tokenize(`${subject.text || ''} ${keyword}`))];
    const bm25 = new BM25(pool.map((r) => ({ text: r.text || '' })));
    const scored = pool
      .map((r, i) => ({ r, s: bm25.score(queryTokens, i) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, maxRecords)
      .map((x) => x.r);
    stats.recalled = pool.length;
    pool = scored;
  }
  stats.kept = pool.length;
  const detail = [];
  if (stats.closed) detail.push(`已结束 ${stats.closed}`);
  if (stats.unknownStatus) detail.push(`岗位状态未知 ${stats.unknownStatus}`);
  if (stats.employment) detail.push(`雇佣类型不符 ${stats.employment}`);
  if (stats.category) detail.push(`职类跨度过大 ${stats.category}`);
  if (stats.duplicate) detail.push(`重复 ${stats.duplicate}`);
  if (stats.notSeeking) detail.push(`不求职/已撤回 ${stats.notSeeking}`);
  if (stats.recommended) detail.push(`已推荐过该公司 ${stats.recommended}`);
  stats.details = detail;
  return { pool, stats };
}

export function describePool(stats) {
  const parts = [`候选池 ${stats.total}`];
  if (stats.details?.length) parts.push(`排除 ${stats.details.join(' / ')}`);
  if (stats.recalled) parts.push(`超限后按关键词召回 ${stats.kept}/${stats.recalled}`);
  return parts.join('，');
}

export { EMP_LABEL };
