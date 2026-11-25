const STOP_BIGRAMS = new Set([
  '我们', '你们', '他们', '的时', '的工', '以及', '并且', '或者', '可以', '进行', '负责', '相关', '以上', '以下',
  '要求', '职责', '岗位', '工作', '任职', '优先', '熟悉', '具备', '能力', '经验', '一个', '这个', '对于', '通过',
  '以及', '同时', '能够', '具有', '拥有', '参与', '完成', '支持', '包括', '其中', '如果', '因为', '所以', '但是',
]);

const LATIN_STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'you', 'are', 'our', 'will', 'have', 'has', 'not', 'all',
  'can', 'your', 'who', 'job', 'team', 'work', 'more', 'than', 'other', 'into', 'also', 'they', 'their', 'them',
  '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
]);

/** 中文按 bigram 切，英文数字按词切 */
export function tokenize(text) {
  if (!text) return [];
  const s = String(text).toLowerCase();
  const out = [];
  for (const m of s.matchAll(/[a-z][a-z0-9+#._-]{1,}/g)) {
    const w = m[0].replace(/[._-]+$/, '');
    if (w.length >= 2 && !LATIN_STOP.has(w)) out.push(w);
  }
  for (const m of s.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0];
    if (run.length === 1) {
      out.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2);
      if (!STOP_BIGRAMS.has(bg)) out.push(bg);
    }
  }
  return out;
}

export function termCounts(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

export class BM25 {
  constructor(docs, { k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.docs = docs.map((d) => {
      const tf = termCounts(tokenize(d.text));
      let len = 0;
      for (const v of tf.values()) len += v;
      return { tf, len, set: new Set(tf.keys()) };
    });
    this.N = this.docs.length;
    this.avgdl = this.docs.reduce((a, d) => a + d.len, 0) / Math.max(1, this.N);
    const df = new Map();
    for (const d of this.docs) for (const t of d.set) df.set(t, (df.get(t) || 0) + 1);
    this.df = df;
    this.idf = new Map();
    for (const [t, n] of df) this.idf.set(t, Math.log(1 + (this.N - n + 0.5) / (n + 0.5)));
  }

  idfOf(term) {
    return this.idf.get(term) ?? Math.log(1 + (this.N + 0.5) / 0.5);
  }

  score(queryTerms, index) {
    const d = this.docs[index];
    if (!d) return 0;
    let s = 0;
    for (const t of queryTerms) {
      const f = d.tf.get(t);
      if (!f) continue;
      const idf = this.idfOf(t);
      s += (idf * (f * (this.k1 + 1))) / (f + this.k1 * (1 - this.b + (this.b * d.len) / this.avgdl));
    }
    return s;
  }
}

/** 中文职能/技能词典：用于从 JD 中抽取“硬要求” */
const SKILL_LEXICON = [
  '机器学习', '深度学习', '强化学习', '自然语言', '计算机视觉', '语音识别', '语音合成', '信号处理', '推荐系统',
  '大模型', '微调', '提示工程', '向量检索', '知识库', '多模态', '模型部署', '推理优化', '数据标注',
  '数据分析', '数据挖掘', '数据仓库', '指标体系', 'ab测试', '用户研究', '竞品分析', '商业分析', '财务建模',
  '用户增长', '内容运营', '活动运营', '社群运营', '用户运营', '产品运营', '社区运营', '私域', '投放',
  '搜索引擎优化', '搜索优化', '社媒', '公众号', '短视频', '直播', '文案', '选题', '剪辑',
  '产品设计', '交互设计', '视觉设计', '体验设计', '原型', '需求分析', '需求文档', '产品规划', '项目管理',
  '商务拓展', '客户开发', '渠道', '销售', '报价', '合同', '招聘', '绩效', '薪酬', '组织发展', '员工关系',
  '算法工程', '后端', '前端', '全栈', '架构设计', '微服务', '容器', '云原生', '自动化测试', '性能优化',
  '数据安全', '内容安全', '风控', '合规', '供应链', '物流', '财务', '投资', '行研', '尽职调查',
];

export const LATIN_SKILLS = new Set([
  'python', 'java', 'javascript', 'typescript', 'go', 'golang', 'rust', 'c++', 'sql', 'nosql', 'mysql',
  'postgres', 'redis', 'kafka', 'spark', 'flink', 'hadoop', 'pytorch', 'tensorflow', 'transformers',
  'langchain', 'llamaindex', 'rag', 'llm', 'gpt', 'agent', 'mcp', 'sft', 'rlhf', 'embedding', 'rerank',
  'docker', 'kubernetes', 'k8s', 'aws', 'gcp', 'azure', 'linux', 'git', 'ci', 'cd', 'api', 'rest', 'graphql',
  'react', 'vue', 'nextjs', 'node', 'django', 'flask', 'fastapi', 'spring', 'figma', 'sketch', 'photoshop',
  'excel', 'tableau', 'powerbi', 'stata', 'spss', 'r', 'matlab', 'seo', 'sem', 'geo', 'ga', 'crm', 'saas',
  'sql', 'etl', 'bi', 'nlp', 'asr', 'tts', 'cv', 'ocr', 'dsp', 'tflite', 'onnx', 'cuda', 'huggingface',
]);

/** JD 侧“硬要求词”：拉丁技术词 + 中文技能词典命中 */
export function extractRequirements(text) {
  const req = new Set();
  const lower = String(text || '').toLowerCase();
  for (const m of lower.matchAll(/[a-z][a-z0-9+#._-]{1,}/g)) {
    const w = m[0].replace(/[._-]+$/, '');
    if (LATIN_SKILLS.has(w)) req.add(w);
  }
  for (const term of SKILL_LEXICON) {
    if (lower.includes(term)) req.add(term);
  }
  return [...req];
}

export function countHits(terms, docTokens) {
  const set = docTokens instanceof Set ? docTokens : new Set(docTokens);
  const hit = [];
  for (const t of terms) if (set.has(t)) hit.push(t);
  return hit;
}

export function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .trim();
}
