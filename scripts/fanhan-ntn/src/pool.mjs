import { tokenize, BM25 } from './text.mjs';
import { EMP_LABEL } from './parse.mjs';

const ADJ = {
  data_ai: ['engineering', 'product'],
  engineering: ['data_ai', 'product'],
  product: ['design', 'data_ai', 'engineering'],
  design: ['product', 'growth_marketing'],
  growth_marketing: ['sales_business', 'design', 'product'],
  sales_business: ['growth_marketing'],
  other: [],
};

export function categoryRelation(a, b) {
  if (!a || !b) return 'unknown';
  if (a === b) return 'same';
  if ((ADJ[a] || []).includes(b)) return 'adjacent';
  return 'distant';
}

/**
 * 只做“筛出待判断的记录”，不做任何打分。
 * 排他条件都是硬事实：岗位状态、雇佣类型冲突、职类跨度。
 * 记录数超过上限时才用关键词召回裁剪，并在输出里明确告知。
 */
export function buildPool(direction, subject, records, opts = {}) {
  const {
    includeClosed = false,
    anyCategory = false,
    anyEmployment = false,
    maxRecords = 60,
    keyword = '',
  } = opts;

  const stats = { total: records.length, closed: 0, employment: 0, category: 0, recalled: 0, kept: 0 };
  let pool = [];

  for (const r of records) {
    const job = direction === 'job2cand' ? subject : r;
    const cand = direction === 'job2cand' ? r : subject;

    if (!includeClosed && job.status && job.status !== '招聘中') {
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
    pool.push(r);
  }

  if (pool.length > maxRecords) {
    const queryTokens = tokenize(`${subject.text || ''} ${keyword}`);
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
  return { pool, stats };
}

export function describePool(stats) {
  const parts = [`候选池 ${stats.total}`];
  const cut = [];
  if (stats.closed) cut.push(`已结束 ${stats.closed}`);
  if (stats.employment) cut.push(`雇佣类型不符 ${stats.employment}`);
  if (stats.category) cut.push(`职类跨度过大 ${stats.category}`);
  if (cut.length) parts.push(`排除 ${cut.join(' / ')}`);
  if (stats.recalled) parts.push(`超限后按关键词召回 ${stats.kept}/${stats.recalled}`);
  return parts.join('，');
}

export { EMP_LABEL };
