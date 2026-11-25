const CAT_TO_KEY = {
  '算法': 'data_ai',
  '研发': 'engineering',
  '产品经理': 'product',
  '设计': 'design',
  '数据分析': 'data_ai',
  '增长/市场/运营': 'growth_marketing',
  '商务/销售': 'sales_business',
  'HR': 'other',
  '其它': 'other',
};

const KEY_TO_CAT = {
  data_ai: '算法',
  engineering: '研发',
  product: '产品经理',
  design: '设计',
  growth_marketing: '增长/市场/运营',
  operations: '增长/市场/运营',
  sales_business: '商务/销售',
  other: '其它',
};

export function categoryKey(cn) {
  return CAT_TO_KEY[cn] || 'other';
}
export function categoryFromKey(key) {
  return KEY_TO_CAT[key] || '其它';
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
const civil = (prop) => prop?.select?.name || null;

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
  return '';
}

export function extractCities(text) {
  if (!text) return [];
  return uniq(CITIES.filter((c) => text.includes(c)));
}

/**
 * 从自由文本判断雇佣类型。
 * 同时出现“正职/全职”和“实习”时判为冲突（unknown），不静默取一。
 */
export function employmentFromText(text, basisPrefix) {
  const s = String(text || '');
  const ft = /(正职|全职|正式员工)/.test(s);
  const it = /实习/.test(s);
  if (ft && !it) return { value: 'full_time', basis: `${basisPrefix}：正职/全职` };
  if (it && !ft) return { value: 'internship', basis: `${basisPrefix}：实习` };
  if (ft && it) return { value: 'unknown', basis: `${basisPrefix}：正职与实习并存，意向冲突待确认` };
  return { value: 'unknown', basis: `${basisPrefix}：未标注` };
}

export function normalizeCandidate(page) {
  const p = page.properties || {};
  const name = title(p['候选人昵称']) || title(p['简历上的姓名']) || '(未命名)';
  const searchJson = parseJson(rt(p['候选人检索 JSON']));
  const note = rt(p['备注']);
  const emailBody = rt(p['邮件正文']);
  const prefs = searchJson?.preferences || {};

  const rolesText = prefText(prefs.roles);
  const citiesText = prefText(prefs.cities);
  const remoteText = prefText(prefs.remote);
  const salaryText = prefText(prefs.salary);
  const availabilityText = prefText(prefs.availability);
  const constraintsText = prefText(prefs.constraints);

  let emp = prefs.employmentType
    ? employmentFromText(prefText(prefs.employmentType), '检索JSON.雇佣类型')
    : { value: 'unknown', basis: '检索JSON无雇佣类型记录' };
  if (emp.value === 'unknown' && !prefs.employmentType) {
    const probe = `${note}\n${emailBody}`;
    if (probe.trim()) emp = employmentFromText(probe, '备注/邮件正文（无结构化记录）');
  }

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
    salaryText,
    availabilityText,
    constraintsText,
  ];

  return {
    kind: 'candidate',
    id: page.id,
    name,
    resumeName: title(p['简历上的姓名']),
    email: p['邮箱']?.email || '',
    phone: p['手机号']?.phone_number || '',
    wechat: rt(p['微信号']),
    category: civil(p['候选人职位类目']),
    categoryKey: categoryKey(civil(p['候选人职位类目'])),
    source: civil(p['来源渠道']),
    seekingStatus: civil(p['求职状态']),
    referrer: rt(p['推荐人']),
    groupName: rt(p['候选人服务群名称']),
    duplicate: p['是否重复']?.checkbox || false,
    note,
    emailBody,
    links: rt(p['作品链接']),
    hasJson: !!searchJson,
    searchJson,
    empType: emp,
    rolesText,
    citiesText,
    cities,
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
  const description = rt(p['职位描述']);
  const preference = rt(p['职位招聘偏好']);
  const searchJson = parseJson(rt(p['职位检索 JSON']));
  const body = searchJson?.description || description;
  const original = searchJson?.originalText || '';
  const prefsText = prefText(searchJson?.preferences) || preference;

  let emp;
  if (/实习/.test(name)) {
    emp = /(正职|全职)/.test(name)
      ? { value: 'unknown', basis: '职位名称同时含实习与正职' }
      : { value: 'internship', basis: '职位名称含“实习”' };
  } else if (/(正职|全职)/.test(name)) {
    emp = { value: 'full_time', basis: '职位名称含“正职/全职”' };
  } else {
    emp = employmentFromText(`${body}\n${original}`, '职位正文');
    if (emp.value === 'unknown') {
      const years = `${body}\n${original}\n${prefsText}`.match(/([3-9]|[1-9]\d)\s*年(以上|及以上)?[^\n。；]{0,10}(经验|经历|研发|工作)/);
      if (years) emp = { value: 'full_time', basis: `正文要求 ${years[1]} 年以上经验，推定正式岗` };
    }
  }

  const cnCategory = civil(p['职位类目']);
  const textParts = [
    name,
    body,
    prefsText,
    ...(searchJson?.locations || []),
    ...(searchJson?.workModes || []),
  ];

  return {
    kind: 'job',
    id: page.id,
    name,
    category: cnCategory,
    categoryKey: categoryKey(cnCategory),
    status: civil(p['岗位状态']),
    description: body,
    preference: prefsText,
    searchJson,
    hasJson: !!searchJson,
    empType: emp,
    locations: searchJson?.locations || extractCities(`${body}\n${name}`),
    workModes: searchJson?.workModes || [],
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
  unknown: '待确认',
};
