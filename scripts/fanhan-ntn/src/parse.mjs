const CATEGORY_ALIASES = {
  '算法': 'data_ai',
  '算法工程师': 'data_ai',
  '数据分析': 'data_ai',
  '数据': 'data_ai',
  '研发': 'engineering',
  '工程': 'engineering',
  '开发': 'engineering',
  '产品经理': 'product',
  '产品': 'product',
  '设计': 'design',
  '增长/市场/运营': 'growth_marketing',
  '增长/运营/市场': 'growth_marketing',
  '增长/市场': 'growth_marketing',
  '增长市场运营': 'growth_marketing',
  '增长运营': 'growth_marketing',
  '市场运营': 'growth_marketing',
  '市场': 'growth_marketing',
  '增长': 'growth_marketing',
  '运营': 'operations',
  '商务/销售': 'sales_business',
  '商务': 'sales_business',
  '销售': 'sales_business',
  'HR': 'other',
  '人力': 'other',
  '人事': 'other',
  '其它': 'other',
  '其他': 'other',
  '其他类': 'other',
  'other': 'other',
  'data_ai': 'data_ai',
  'engineering': 'engineering',
  'product': 'product',
  'design': 'design',
  'growth_marketing': 'growth_marketing',
  'operations': 'operations',
  'sales_business': 'sales_business',
};

const KEY_TO_CAT = {
  data_ai: '算法',
  engineering: '研发',
  product: '产品经理',
  design: '设计',
  growth_marketing: '增长/市场/运营',
  operations: '运营',
  sales_business: '商务/销售',
  other: '其它',
};

/** 保留未知职类为空 key，避免把“未知”误判成“其它”后硬性排除。 */
export function categoryKey(cn) {
  const raw = String(cn || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (CATEGORY_ALIASES[raw]) return CATEGORY_ALIASES[raw];
  if (CATEGORY_ALIASES[lower]) return CATEGORY_ALIASES[lower];
  if (raw.includes('增长') || raw.includes('市场')) return 'growth_marketing';
  if (raw.includes('运营')) return 'operations';
  if (raw.includes('算法') || raw.includes('数据')) return 'data_ai';
  if (raw.includes('研发') || raw.includes('开发') || raw.includes('工程')) return 'engineering';
  if (raw.includes('产品')) return 'product';
  if (raw.includes('设计')) return 'design';
  if (raw.includes('销售') || raw.includes('商务')) return 'sales_business';
  if (raw.includes('其它') || raw.includes('其他')) return 'other';
  return '';
}
export function categoryFromKey(key) {
  const k = String(key || '').trim();
  if (KEY_TO_CAT[k]) return KEY_TO_CAT[k];
  return k;
}

const CITIES = [
  '北京', '上海', '深圳', '广州', '杭州', '成都', '南京', '武汉', '苏州', '西安', '合肥', '长沙', '厦门',
  '青岛', '天津', '重庆', '无锡', '宁波', '郑州', '济南', '福州', '东莞', '佛山', '珠海', '大连', '沈阳',
  '香港', '澳门', '台北', '新加坡', '东京', '首尔', '洛杉矶', '纽约', '旧金山', '西雅图', '波士顿',
  '伦敦', '柏林', '迪拜', '悉尼', '多伦多', '温哥华', '巴黎', '阿姆斯特丹',
];

const rt = (prop) =>
  (prop?.rich_text || [])
    .map((t) => t.plain_text || t.text?.content || '')
    .join('');

const title = (prop) =>
  (prop?.title || [])
    .map((t) => t.plain_text || t.text?.content || '')
    .join('');

const rel = (prop) => (prop?.relation || []).map((r) => r.id);

/** Notion 的 select 与 status 在线上可能互换；两者都按值读取。 */
export function choice(prop) {
  if (!prop) return null;
  if (prop.select?.name) return prop.select.name;
  if (prop.status?.name) return prop.status.name;
  if (typeof prop.select === 'string') return prop.select;
  if (typeof prop.status === 'string') return prop.status;
  return null;
}

const parseJson = (s) => {
  if (!s || !s.trim()) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

/** preferences 里的字段统一是 {value: string, evidence: [...]} 或 null */
function prefText(pref) {
  if (!pref) return '';
  if (typeof pref === 'string') return pref;
  if (typeof pref.value === 'string') return pref.value;
  if (Array.isArray(pref.value)) return pref.value.join('、');
  if (Array.isArray(pref)) return pref.map(prefText).filter(Boolean).join('、');
  return '';
}

export function meaningfulSearchJson(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = ['skills', 'projects', 'experience', 'education', 'preferences', 'description', 'title', 'locations', 'workModes', 'originalText', 'unknowns'];
  return keys.some((key) => {
    const v = obj[key];
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return String(v).trim().length > 0;
  });
}

export function extractCities(text) {
  if (!text) return [];
  return uniq(CITIES.filter((c) => String(text).includes(c)));
}

const EMP_VALUES = {
  full_time: ['全职', '正职', '正式员工', '正式', 'full_time', 'full-time', 'fulltime', 'full time'],
  internship: ['实习', '实习生', 'internship', 'intern'],
  part_time: ['兼职', 'part_time', 'part-time', 'parttime', 'part time'],
};

function employmentToken(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  const hits = new Set();
  for (const [value, words] of Object.entries(EMP_VALUES)) {
    if (words.some((w) => s === w || s.includes(w))) hits.add(value);
  }
  if (hits.size === 0) return null;
  if (hits.size === 1) return [...hits][0];
  return 'conflict';
}

const empResult = (value, basisPrefix, detail = '') => {
  const suffix = detail ? `：${detail}` : '';
  if (value === 'conflict') return { value: 'unknown', basis: `${basisPrefix}：雇佣类型表述冲突，待确认${suffix}` };
  if (value === 'full_time' || value === 'internship' || value === 'part_time') {
    return { value, basis: `${basisPrefix}：${detail || EMP_LABEL[value]}` };
  }
  return { value: 'unknown', basis: `${basisPrefix}：未标注${suffix}` };
};

/** 结构化字段优先；任何冲突都保留 unknown，不静默取一。 */
export function employmentFromStructured(value, basisPrefix = '结构化字段') {
  const text = prefText(value);
  if (/(不接受|不考虑|不招|排除|不|非|无)\s*(全职|正职|正式|实习|兼职|full|intern|part)/i.test(text)) {
    return { value: 'unknown', basis: `${basisPrefix}：否定/限制表述，待确认（${text}）` };
  }
  const token = employmentToken(text);
  return token ? empResult(token, basisPrefix, text) : { value: 'unknown', basis: `${basisPrefix}：未标注` };
}

function isNegated(text, index) {
  const before = text.slice(Math.max(0, index - 8), index);
  return /(不|非|无|别|勿|不考虑|不接受|排除|不含|不招|仅排除)\s*$/.test(before);
}

function isHistorical(text, index) {
  const around = text.slice(Math.max(0, index - 18), Math.min(text.length, index + 18));
  return /(19|20)\d{2}|经历|历史|曾经|过往|以往|之前|过去|上一份|前任|记录|毕业/.test(around);
}

const EMP_WORD = '(全职|正职|正式员工|正式|实习|兼职|full[-_ ]?time|internship|intern|part[-_ ]?time)';
const INTENT_LABEL = /(?:求职意向|求职类型|工作性质|雇佣类型|招聘类型|职位类型|用人性质|employment\s*type|job\s*type)\s*[:：=]\s*([^\n。；;，,]{1,60})/gi;
const INTENT_PHRASE = new RegExp(`(?:本岗位为|该岗位为|岗位性质为|职位性质为|本职位为|接受|仅招|只招|可)\\s*${EMP_WORD}`, 'gi');
const INTENT_SUFFIX = new RegExp(`${EMP_WORD}\\s*(?:岗位|岗|职位)`, 'gi');

/**
 * 只识别明确的雇佣意向语句或结构化字段。
 * 不把年份、历史实习、普通提及、否定句或职位名称当作当前意向。
 */
export function employmentFromText(text, basisPrefix) {
  const s = String(text || '');
  if (!s.trim()) return { value: 'unknown', basis: `${basisPrefix}：未标注` };
  const found = [];
  for (const m of s.matchAll(INTENT_LABEL)) {
    if (/(不接受|不考虑|不招|排除|不|非|无)\s*(全职|正职|正式|实习|兼职|full|intern|part)/i.test(m[1])) continue;
    if (isHistorical(s, m.index)) continue;
    const token = employmentToken(m[1]);
    if (token) found.push({ token, detail: m[0], index: m.index });
  }
  for (const re of [INTENT_PHRASE, INTENT_SUFFIX]) {
    for (const m of s.matchAll(re)) {
      if (isNegated(s, m.index) || isHistorical(s, m.index)) continue;
      const word = m[1];

      // “可实习”只是可能性，不能盖过正文里的明确全职；单独出现时也不强制实习。
      if (/^可/.test(m[0]) && /实习/.test(word)) continue;
      const token = employmentToken(word);
      if (token) found.push({ token, detail: m[0], index: m.index });
    }
  }
  if (!found.length) return { value: 'unknown', basis: `${basisPrefix}：无明确雇佣意向` };
  const values = uniq(found.map((f) => f.token));
  if (values.length > 1) return empResult('conflict', basisPrefix, values.join('/'));
  return empResult(values[0], basisPrefix, found[0].detail.trim());
}

function candidateEmployment(pageProps, prefs, note, emailBody, searchJson) {
  const structured = choice(pageProps['雇佣类型']) || choice(pageProps['求职类型']) || choice(pageProps['工作性质']);
  if (structured) return employmentFromStructured(structured, 'Notion 雇佣类型');
  if (prefs.employmentType) return employmentFromStructured(prefs.employmentType, '检索JSON.雇佣类型');
  const text = employmentFromText(`${note}\n${emailBody}`, '备注/邮件正文');
  if (text.value !== 'unknown') return text;
  if (!searchJson) return { value: 'unknown', basis: '无结构化雇佣类型记录' };
  return { value: 'unknown', basis: '检索JSON无结构化雇佣类型记录' };
}

export function normalizeCandidate(page) {
  const p = page.properties || {};
  const name = title(p['候选人昵称']) || title(p['简历上的姓名']) || '(未命名)';
  const rawSearchJson = parseJson(rt(p['候选人检索 JSON']));
  const hasJson = meaningfulSearchJson(rawSearchJson);
  const searchJson = hasJson ? rawSearchJson : null;
  const note = rt(p['备注']);
  const emailBody = rt(p['邮件正文']);
  const prefs = searchJson?.preferences || {};

  const rolesText = prefText(prefs.roles);
  const citiesText = prefText(prefs.cities);
  const remoteText = prefText(prefs.remote);
  const salaryText = prefText(prefs.salary);
  const availabilityText = prefText(prefs.availability);
  const constraintsText = prefText(prefs.constraints);
  const currentLocationText =
    prefText(prefs.currentLocation) ||
    prefText(prefs.currentCity) ||
    prefText(prefs.currentCities) ||
    prefText(prefs.location) ||
    prefText(searchJson?.currentLocation);

  const emp = candidateEmployment(p, prefs, note, emailBody, searchJson);

  const items = [];
  for (const key of ['skills', 'projects', 'experience', 'education']) {
    for (const it of searchJson?.[key] || []) {
      items.push({
        bucket: key,
        value: it.value || '',
        quotes: (it.evidence || []).map((e) => ({ quote: e.quote || '', source: e.source || '' })),
      });
    }
  }

  const cities = extractCities(citiesText);
  const currentCities = extractCities(currentLocationText);
  const remote = /远程/.test(remoteText)
    ? !/(不接受远程|不能远程|不考虑远程)/.test(remoteText)
    : null;

  const textParts = [
    name,
    note,
    emailBody,
    ...items.map((i) => i.value),
    ...items.flatMap((i) => i.quotes.map((q) => q.quote)),
    rolesText,
    citiesText,
    currentLocationText,
    salaryText,
    availabilityText,
    constraintsText,
  ];

  const fallbackReason = !rawSearchJson
    ? (rt(p['候选人检索 JSON']) ? '检索JSON无法解析，已回退备注/邮件正文' : '')
    : (!hasJson ? '检索JSON为空对象，已回退备注/邮件正文' : '');
  const materialSource = hasJson
    ? '检索JSON'
    : note || emailBody
      ? (fallbackReason ? `${fallbackReason}` : '备注/邮件正文（无检索JSON）')
      : '无可用材料';

  return {
    kind: 'candidate',
    id: page.id,
    name,
    resumeName: title(p['简历上的姓名']),
    email: p['邮箱']?.email || '',
    phone: p['手机号']?.phone_number || '',
    wechat: rt(p['微信号']),
    category: choice(p['候选人职位类目']),
    categoryKey: categoryKey(choice(p['候选人职位类目'])),
    source: choice(p['来源渠道']),
    seekingStatus: choice(p['求职状态']),
    referrer: rt(p['推荐人']),
    groupName: rt(p['候选人服务群名称']),
    duplicate: p['是否重复']?.checkbox || false,
    note,
    emailBody,
    links: rt(p['作品链接']),
    hasJson,
    searchJson,
    searchJsonRaw: rawSearchJson,
    materialSource,
    fallbackReason,
    empType: emp,
    rolesText,
    citiesText,
    cities,
    currentLocationText,
    currentCities,
    remote,
    salaryText,
    availabilityText,
    constraintsText,
    items,
    text: uniq(textParts).join('\n'),
    relations: {
      matchedJobs: rel(p['匹配的职位']),
      appliedJobs: rel(p['投递的职位']),
      companies: rel(p['推荐过的公司']),
    },
    updatedAt: page.last_edited_time || page.created_time || '',
  };
}

export function normalizeJob(page) {
  const p = page.properties || {};
  const name = title(p['职位名称']) || '(未命名职位)';
  const currentDescription = rt(p['职位描述']);
  const currentPreference = rt(p['职位招聘偏好']);
  const rawSearchJson = parseJson(rt(p['职位检索 JSON']));
  const hasJson = meaningfulSearchJson(rawSearchJson);
  const searchJson = hasJson ? rawSearchJson : null;
  const retrievedDescription = searchJson?.description || searchJson?.text || '';
  const retrievedPreference = prefText(searchJson?.preferences);
  const description = currentDescription || retrievedDescription;
  const descriptionSource = currentDescription ? 'notion' : retrievedDescription ? 'retrieval-json' : 'none';
  const preference = currentPreference || retrievedPreference;
  const preferenceSource = currentPreference ? 'notion' : retrievedPreference ? 'retrieval-json' : 'none';
  const changed = String(currentDescription || '').trim() !== String(retrievedDescription || '').trim();

  const structuredEmployment =
    choice(p['雇佣类型']) || choice(p['工作性质']) || choice(p['职位类型']) || searchJson?.employmentType;
  let emp;
  if (structuredEmployment) {
    emp = employmentFromStructured(structuredEmployment, '岗位结构化雇佣类型');
  } else {
    emp = employmentFromText(`${currentDescription}\n${currentPreference}`, '职位正文明确表述');
  }

  const cnCategory = choice(p['职位类目']);
  const currentLocationText =
    choice(p['工作地点']) ||
    rt(p['工作地点']) ||
    choice(p['地点']) ||
    rt(p['地点']) ||
    '';
  const searchLocations = Array.isArray(searchJson?.locations) ? searchJson.locations : [];
  const locations = extractCities(currentLocationText) .length
    ? extractCities(currentLocationText)
    : extractCities(`${currentDescription}\n${name}`).length
      ? extractCities(`${currentDescription}\n${name}`)
      : searchLocations;
  const locationsSource = extractCities(currentLocationText).length
    ? 'notion'
    : extractCities(`${currentDescription}\n${name}`).length
      ? 'description'
      : searchLocations.length
        ? 'retrieval-json'
        : 'none';
  const workModes = Array.isArray(searchJson?.workModes) ? searchJson.workModes : [];
  const textParts = [
    name,
    description,
    preference,
    ...locations,
    ...workModes,
  ];

  return {
    kind: 'job',
    id: page.id,
    name,
    category: cnCategory,
    categoryKey: categoryKey(cnCategory),
    status: choice(p['岗位状态']),
    description,
    descriptionSource,
    retrievedDescription,
    descriptionDiff: {
      changed,
      currentLength: currentDescription.length,
      retrievedLength: String(retrievedDescription || '').length,
    },
    preference,
    preferenceSource,
    retrievedPreference,
    searchJson,
    searchJsonRaw: rawSearchJson,
    hasJson,
    empType: emp,
    locations,
    locationsSource,
    searchLocations,
    workModes,
    companyIds: rel(p['关联公司']),
    sourcePartner: rt(p['来源合作方（来源猎头）']),
    text: uniq(textParts).join('\n'),
    relations: {
      matchedCandidates: rel(p['匹配的人选']),
      appliedCandidates: rel(p['投递的人选']),
    },
    updatedAt: page.last_edited_time || page.created_time || '',
  };
}

export function normalizeCompany(page) {
  const p = page.properties || {};
  return {
    kind: 'company',
    id: page.id,
    name: title(p['公司名称']) || '(未命名公司)',
    site: p['官网']?.url || '',
    preference: rt(p['公司招聘偏好']),
    note: rt(p['备注']),
    jobIds: rel(p['职位 JD']),
    updatedAt: page.last_edited_time || '',
  };
}

export const EMP_LABEL = {
  full_time: '正式',
  internship: '实习',
  part_time: '兼职',
  unknown: '待确认',
};
