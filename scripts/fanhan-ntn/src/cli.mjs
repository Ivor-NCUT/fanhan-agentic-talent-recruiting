#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DS, DS_NAME, assertConfigured, queryAll, whoami, ntnVersion, updatePage, extractPageId, readRelation, verifyRelation, fetchPage, acquireLock, ensurePrivateDir } from './ntn.mjs';
import { normalizeCandidate, normalizeJob, normalizeCompany, categoryKey, categoryFromKey, choice, meaningfulSearchJson, extractCities, employmentFromText, employmentFromStructured, EMP_LABEL } from './parse.mjs';
import { buildPool, describePool, seekingAllows } from './pool.mjs';
import { llmConfig, judge, judgeSingle, FIT_LEVEL_NAMES } from './llm.mjs';
import { readStdin, saveKeyToKeychain, deleteKeyFromKeychain } from './auth.mjs';

const ROOT = path.join(os.homedir(), '.fanhan-ntn');
const CACHE = {
  candidates: path.join(ROOT, 'candidates.json'),
  jobs: path.join(ROOT, 'jobs.json'),
  companies: path.join(ROOT, 'companies.json'),
};
const META = path.join(ROOT, 'meta.json');
const STALE_MS = () => Number(process.env.FANHAN_CACHE_STALE_MS || 24 * 60 * 60_000);

let jsonMode = false;
const say = (...a) => { if (!jsonMode) console.log(...a); };

const C = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
if (process.env.NO_COLOR || !process.stdout.isTTY) for (const k of Object.keys(C)) C[k] = (s) => s;

const cut = (s, n) => {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n)}…` : str;
};

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(visualWidth(h), ...rows.map((r) => visualWidth(r[i] ?? ''))));
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i] + (i < cells.length - 1 ? 2 : 0))).join('');
  say(C.dim(line(headers)));
  for (const r of rows) say(line(r));
}

const visualWidth = (s) => {
  let w = 0;
  for (const ch of String(s ?? '')) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u3000-\u303F]/.test(ch) ? 2 : 1;
  return w;
};

function parseArgv(argv) {
  const f = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { f[key] = next; i++; }
      else f[key] = true;
    } else f._.push(a);
  }
  return f;
}

const readJson = (p, dflt = null) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; }
};

function needCache() {
  const c = readJson(CACHE.candidates, { records: [] });
  const j = readJson(CACHE.jobs, { records: [] });
  return { candidates: c.records, jobs: j.records, meta: readJson(META, {}) };
}

function loadAll() {
  return {
    candidates: readJson(CACHE.candidates, { records: [] }).records,
    jobs: readJson(CACHE.jobs, { records: [] }).records,
    companies: readJson(CACHE.companies, { records: [] }).records,
    meta: readJson(META, {}),
  };
}

function ageInfo(syncedAt) {
  const t = Date.parse(syncedAt || '');
  if (!Number.isFinite(t)) return { ms: null, text: '时间未知', stale: true };
  const ms = Date.now() - t;
  const hours = ms / 3600_000;
  const text = hours < 1 ? `${Math.max(1, Math.round(ms / 60_000))} 分钟前` : hours < 48 ? `${Math.round(hours)} 小时前` : `${Math.round(hours / 24)} 天前`;
  return { ms, text, stale: ms > STALE_MS() };
}

function cacheStamp(syncedAt) {
  const a = ageInfo(syncedAt);
  if (a.ms == null) return '缓存同步时间未知（无法验证时效）';
  return `缓存同步于 ${syncedAt}（${a.text}${a.stale ? '，已过期' : '，新鲜'}）`;
}

function localRootConfig() {
  return readJson(path.join(ROOT, 'config.json'), {}) || {};
}

function safetyContract() {
  const cfg = localRootConfig();
  const s = cfg.safety || {};
  const contract = {
    duplicate: s.duplicate || '是否重复',
    seeking: s.seeking || '求职状态',
    recommendedCompanies: s.recommendedCompanies || '推荐过的公司',
    doNotRecommend: s.doNotRecommend || null,
    withdrawn: s.withdrawn || null,
  };
  const missing = [];
  if (!contract.doNotRecommend) missing.push('全局不推荐字段');
  if (!contract.withdrawn) missing.push('撤回保护字段');
  return { ...contract, missing, globalConfigured: missing.length === 0 };
}

function safetyFlag(prop) {
  if (!prop) return null;
  if (prop.type === 'checkbox') return prop.checkbox === true;
  if (prop.type === 'number') return Number(prop.number || 0) > 0;
  const v = choice(prop) || (prop.rich_text || []).map((t) => t.plain_text || '').join('');
  if (!v) return false;
  return /^(是|已撤回|撤回|不推荐|禁止|true|yes|1)$/i.test(String(v).trim()) || /撤回|不推荐|禁止/.test(String(v));
}

function assertCandidateSafety(page) {
  const p = page.properties || {};
  const dup = p['是否重复'];
  const seek = p['求职状态'];
  if (!dup) throw new Error('候选人页面缺少安全字段「是否重复」，无法验证重复保护；拒绝 link。请先验证 Notion schema。');
  if (!seek) throw new Error('候选人页面缺少安全字段「求职状态」，无法验证是否在求职；拒绝 link。请先验证 Notion schema。');
  if (dup.checkbox === true) throw new Error('候选人被标记为「是否重复」，拒绝写入关系。');
  const seekVal = choice(seek);
  if (seekVal && !seekingAllows(seekVal)) throw new Error(`候选人求职状态为「${seekVal}」，不求职/已撤回，拒绝写入关系。`);

  const cfg = safetyContract();
  for (const [label, field] of [['全局不推荐', cfg.doNotRecommend], ['撤回', cfg.withdrawn]]) {
    if (!field) continue;
    const prop = p[field];
    if (!prop) throw new Error(`safety 配置了${label}字段「${field}」，但候选人页面缺失；拒绝写入。`);
    if (safetyFlag(prop)) throw new Error(`候选人命中${label}保护（${field}），拒绝写入。`);
  }
  return cfg;
}

function positiveInt(value, fallback, name) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} 必须为正整数，收到 ${value}`);
  return n;
}

function resolveOne(arg, records, type) {
  if (!arg) return null;
  const q = String(arg).startsWith('name:') ? String(arg).slice(5).trim() : null;
  const id = q ? null : (extractPageId(arg) || String(arg));
  const rec = id ? records.find((r) => r.id === id) : null;
  if (rec) return rec;
  const needle = q || String(arg).trim();
  const hits = records.filter((r) => (r.name || '').includes(needle));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`缓存里找不到${type}「${needle}」，先 fanhan-ntn sync`);
  say(`「${needle}」匹配到多个${type}：`);
  for (const h of hits.slice(0, 20)) say(`  ${h.id}  ${h.name}`);
  process.exit(2);
}

function pickDirection(f) {
  const direction = (f.candidates || f.candidate) ? 'cand2job' : (f.jobs || f.job) ? 'job2cand' : null;
  if (!direction) throw new Error('需要 --candidate 或 --job 指定匹配方向');
  return direction;
}

function publishSnapshot(entries) {
  ensurePrivateDir(ROOT);
  const staged = [];
  const backups = [];
  const published = [];
  try {
    for (const { file, content } of entries) {
      const tmp = path.join(ROOT, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, content);
        try { fs.fsyncSync(fd); } catch {}
      } finally { fs.closeSync(fd); }
      try { fs.chmodSync(tmp, 0o600); } catch {}
      staged.push({ file, tmp });
    }
    for (const { file } of staged) {
      if (!fs.existsSync(file)) continue;
      const backup = path.join(ROOT, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.bak`);
      fs.renameSync(file, backup);
      try { fs.chmodSync(backup, 0o600); } catch {}
      backups.push({ file, backup });
    }
    for (const { file, tmp } of staged) {
      fs.renameSync(tmp, file);
      try { fs.chmodSync(file, 0o600); } catch {}
      published.push(file);
    }
    for (const { backup } of backups) { try { fs.unlinkSync(backup); } catch {} }
  } catch (e) {
    for (const file of published) { try { fs.unlinkSync(file); } catch {} }
    for (const { file, backup } of backups.reverse()) {
      try { if (!fs.existsSync(file)) fs.renameSync(backup, file); } catch {}
    }
    for (const { tmp } of staged) { try { fs.unlinkSync(tmp); } catch {} }
    throw e;
  }
}

async function cmdSync() {
  assertConfigured();
  ensurePrivateDir(ROOT);
  const release = acquireLock(ROOT, 'sync');
  try {
    const plan = [
      ['candidates', DS.candidates, '候选人'],
      ['jobs', DS.jobs, '职位'],
      ['companies', DS.companies, '公司'],
    ];
    const snap = {};
    const counts = {};
    for (const [key, ds, label] of plan) {
      say(`拉取 ${label}（${DS_NAME[key]}）…`);
      const pages = await queryAll(ds, { onPage: (n, more) => say(`  ${label} ${n} 条${more ? '，继续翻页' : '，已到末页'}`) });
      counts[key] = pages.length;
      const norm = key === 'candidates' ? normalizeCandidate : key === 'jobs' ? normalizeJob : normalizeCompany;
      snap[key] = pages.map(norm);
    }
    const syncedAt = new Date().toISOString();
    const meta = { syncedAt, counts, dataSources: { ...DS } };
    const entries = [
      { file: CACHE.candidates, content: JSON.stringify({ syncedAt, records: snap.candidates }) },
      { file: CACHE.jobs, content: JSON.stringify({ syncedAt, records: snap.jobs }) },
      { file: CACHE.companies, content: JSON.stringify({ syncedAt, records: snap.companies }) },
      { file: META, content: JSON.stringify(meta, null, 2) },
    ];
    publishSnapshot(entries);
    say(C.green(`同步完成：候选人 ${counts.candidates} / 职位 ${counts.jobs} / 公司 ${counts.companies}`));
    say(cacheStamp(syncedAt));
  } finally {
    release();
  }
}

async function cmdStatus(f) {
  assertConfigured();
  const version = await ntnVersion();
  const who = await whoami();
  const meta = readJson(META, {});
  const c = readJson(CACHE.candidates, { records: [] });
  const j = readJson(CACHE.jobs, { records: [] });
  const co = readJson(CACHE.companies, { records: [] });
  const safety = safetyContract();
  if (f.json) {
    console.log(JSON.stringify({ ntn: version || null, who, dataSources: DS, counts: { candidates: c.records.length, jobs: j.records.length, companies: co.records.length }, lastSync: meta.syncedAt || null, cache: ageInfo(meta.syncedAt), safety }, null, 2));
    return;
  }
  console.log(C.bold('fanhan-ntn 状态'));
  console.log(`  ntn 版本        ${version || C.yellow('未安装/不可用')}`);
  console.log(`  Notion 账号     ${who.ok ? who.workspace : C.red('未登录（运行 ntn login）')}`);
  if (!who.ok && who.error) console.log(`  ${C.dim(who.error)}`);
  console.log(`  候选人库         ${DS.candidates || C.red('未配置')}  ${C.dim(`缓存 ${c.records.length} 条`)}`);
  console.log(`  职位库           ${DS.jobs || C.red('未配置')}  ${C.dim(`缓存 ${j.records.length} 条`)}`);
  console.log(`  公司库           ${DS.companies || C.red('未配置')}  ${C.dim(`缓存 ${co.records.length} 条`)}`);
  console.log(`  上次同步         ${meta.syncedAt || C.yellow('从未同步')}`);
  if (meta.syncedAt) {
    const a = ageInfo(meta.syncedAt);
    console.log(`${a.stale ? C.yellow('  缓存已过期     ' + a.text) : C.green('  缓存新鲜       ' + a.text)}`);
  }
  const version2 = readJson(META, {}).counts;
  if (version2) console.log(`  缓存计数         ${JSON.stringify(version2)}`);
  console.log(`  写入安全检查     重复=${safety.duplicate} / 求职状态=${safety.seeking}（link --yes 时新鲜验证）`);
  console.log(`  全局安全字段     ${safety.globalConfigured ? C.green('已配置') : C.yellow('未配置：不提供全局不推荐/撤回保护（link 不是发布）')}`);
}

async function cmdList(f) {
  const { candidates, jobs, meta } = needCache();
  const which = f._[0] || (f.candidates ? 'candidates' : f.jobs ? 'jobs' : null);
  let records;
  let label;
  if (which === 'candidates' || f.candidates) { records = candidates; label = '候选人'; }
  else if (which === 'jobs' || f.jobs) { records = jobs; label = '职位'; }
  else throw new Error('需要 candidates 或 jobs（例如 fanhan-ntn list candidates）');
  if (f.category) {
    const key = categoryKey(f.category);
    records = records.filter((r) => r.categoryKey === key || (!key && r.category === f.category));
  }
  if (f.status) records = records.filter((r) => r.status === f.status);
  const limit = f.limit ? positiveInt(f.limit, 20, 'limit') : 0;
  const shown = limit ? records.slice(0, limit) : records;
  if (f.json) {
    console.log(JSON.stringify({ syncedAt: meta.syncedAt || null, records: shown }, null, 2));
    return;
  }
  const headers = label === '候选人'
    ? ['ID', '昵称', '职类', '雇佣', '求职状态', '重复']
    : ['ID', '职位', '职类', '状态', '地点', '雇佣'];
  const rows = shown.map((r) => label === '候选人'
    ? [r.id, cut(r.name, 20), r.category || '-', EMP_LABEL[r.empType?.value] || '待确认', r.seekingStatus || '-', r.duplicate ? C.yellow('是') : '否']
    : [r.id, cut(r.name, 28), r.category || '-', r.status || C.yellow('状态缺失'), (r.locations || []).join('/') || '-', EMP_LABEL[r.empType?.value] || '待确认']);
  table(headers, rows);
  console.log(C.dim(`\n共 ${shown.length} 条${limit && records.length > limit ? `（已按 --limit ${limit} 截断，总 ${records.length} 条）` : ''}`));
  console.log(C.dim(cacheStamp(meta.syncedAt)));
}

async function cmdGet(f) {
  const { candidates, jobs, meta } = needCache();
  if (!f.candidate && !f.job && f._.length >= 2) {
    if (f._[0] === 'candidate' || f._[0] === '候选人') f.candidate = f._[1];
    if (f._[0] === 'job' || f._[0] === '职位') f.job = f._[1];
  }
  if (!f.candidate && !f.job) throw new Error('需要 --candidate <id|name:xxx> 或 --job <id|name:xxx>');
  const target = f.candidate
    ? { type: '候选人', rec: resolveOne(f.candidate, candidates, '候选人') }
    : { type: '职位', rec: resolveOne(f.job, jobs, '职位') };
  const r = target.rec;
  if (f.json) {
    console.log(JSON.stringify({ syncedAt: meta.syncedAt || null, cache: ageInfo(meta.syncedAt), record: r }, null, 2));
    return;
  }
  console.log(C.bold(`${target.type}  ${r.name}`));
  console.log(`  ID              ${r.id}`);
  console.log(C.dim(`  ${cacheStamp(meta.syncedAt)}`));
  if (r.kind === 'candidate') {
    console.log(`  职类            ${r.category || C.yellow('未知（保留，不强行归类）')}`);
    console.log(`  雇佣类型        ${EMP_LABEL[r.empType?.value] || '待确认'} ${C.dim(r.empType?.basis || '')}`);
    console.log(`  期望城市        ${(r.cities || []).join('、') || '-'}`);
    console.log(`  当前地点        ${r.currentLocationText || (r.currentCities || []).join('、') || '-'}`);
    const remote = r.remote == null ? '未知' : r.remote ? '接受' : '不接受';
    console.log(`  远程            ${remote}`);
    console.log(`  薪资期望        ${r.salaryText || '-'}`);
    console.log(`  到岗            ${r.availabilityText || '-'}`);
    console.log(`  求职状态        ${r.seekingStatus || C.yellow('未知')}`);
    console.log(`  重复            ${r.duplicate ? C.yellow('是') : '否'}`);
    console.log(`  来源渠道        ${r.source || '-'}`);
    console.log(`  材料来源        ${r.materialSource || (r.hasJson ? '检索JSON' : '备注/邮件正文')}${r.fallbackReason ? '（' + r.fallbackReason + '）' : ''}`);
    if (r.items?.length) {
      console.log('\n  ' + C.bold('检索材料'));
      for (const it of r.items) console.log(`  · [${it.bucket}] ${it.value}`);
    }
    const note = r.note || r.emailBody;
    if (note) console.log(`\n  ${C.bold('备注/邮件正文')}\n  ${note}`);
    if (r.links) console.log(`\n  作品链接        ${r.links}`);
  } else {
    console.log(`  职类            ${r.category || C.yellow('未知（保留，不强行归类）')}`);
    console.log(`  状态            ${r.status || C.yellow('状态缺失（不默认招聘中）')}`);
    console.log(`  地点            ${(r.locations || []).join('、') || '-'} ${C.dim('来源:' + (r.locationsSource || 'none'))}`);
    console.log(`  雇佣类型        ${EMP_LABEL[r.empType?.value] || '待确认'} ${C.dim(r.empType?.basis || '')}`);
    console.log(`  描述来源        ${r.descriptionSource || 'none'}`);
    if (r.descriptionDiff?.changed) {
      console.log(C.yellow(`  注意            历史检索 JSON 与当前 Notion 职位描述不同（当前 ${r.descriptionDiff.currentLength} 字 / 检索 ${r.descriptionDiff.retrievedLength} 字）`));
    }
    console.log(`\n  ${C.bold('职位描述')}\n${r.description || C.yellow('（空）')}`);
    if (r.descriptionDiff?.changed && r.retrievedDescription) {
      console.log(`\n  ${C.bold('历史检索 JSON 描述（仅供对照，不覆盖当前）')}\n${cut(r.retrievedDescription, 1200)}`);
    }
    console.log(`\n  ${C.bold('招聘偏好')} ${r.preferenceSource ? C.dim('来源:' + r.preferenceSource) : ''}\n${r.preference || '-'}`);
    if (r.retrievedPreference && r.retrievedPreference !== r.preference) console.log(C.yellow(`  检索 JSON 偏好与当前不同（未覆盖）：${cut(r.retrievedPreference, 300)}`));
  }
}

const prefText = (v) => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(prefText).filter(Boolean).join('、');
  if (typeof v.value === 'string') return v.value;
  if (Array.isArray(v.value)) return v.value.map(prefText).filter(Boolean).join('、');
  return '';
};

function externalCandidate(file) {
  const raw = readJson(file);
  if (!raw || typeof raw !== 'object') throw new Error(`无法读取候选人 JSON：${file}`);
  const candidateSearchJson = raw.candidateSearchJson ?? raw.searchJson ?? raw;
  const rawJson = candidateSearchJson && typeof candidateSearchJson === 'object' ? candidateSearchJson : null;
  const hasJson = meaningfulSearchJson(rawJson);
  const searchJson = hasJson ? rawJson : null;
  const prefs = searchJson?.preferences || {};
  const note = String(raw.note ?? raw.notes ?? raw['备注'] ?? '');
  const emailBody = String(raw.emailBody ?? raw.email ?? raw['邮件正文'] ?? '');
  const currentLocationText = prefText(prefs.currentLocation) || prefText(prefs.currentCity) || prefText(prefs.currentCities) || prefText(prefs.location) || prefText(searchJson?.currentLocation);
  const structured = raw.empType || prefs.employmentType;
  const emp = structured
    ? employmentFromStructured(structured, '外部JSON雇佣类型')
    : employmentFromText(`${note}\n${emailBody}`, '外部备注/邮件正文');
  const fallbackReason = rawJson && !hasJson ? '外部检索JSON为空对象，已回退备注/邮件正文' : !rawJson ? '外部文件没有检索JSON，已回退备注/邮件正文' : '';
  const items = [];
  for (const bucket of ['skills', 'projects', 'experience', 'education']) {
    for (const it of searchJson?.[bucket] || []) {
      items.push({ bucket, value: it.value || '', quotes: (it.evidence || []).map((e) => ({ quote: e.quote || '', source: e.source || '' })) });
    }
  }
  const citiesText = prefText(prefs.cities);
  const rolesText = prefText(prefs.roles);
  const text = [raw.name || raw.nickname || '', note, emailBody, citiesText, rolesText, currentLocationText, ...items.map((i) => i.value), ...items.flatMap((i) => i.quotes.map((q) => q.quote))].filter(Boolean).join('\n');
  return {
    kind: 'candidate',
    id: `external:${path.basename(file)}`,
    name: raw.name || raw.nickname || '(外部候选人)',
    category: raw.category || '',
    categoryKey: categoryKey(raw.category || ''),
    source: raw.source || 'external-json',
    seekingStatus: raw.seekingStatus || raw.status || '',
    duplicate: raw.duplicate === true,
    note,
    emailBody,
    hasJson,
    searchJson,
    searchJsonRaw: rawJson,
    materialSource: hasJson ? '外部检索JSON' : (note || emailBody ? (fallbackReason || '外部备注/邮件正文（无检索JSON）') : '无可用材料'),
    fallbackReason,
    empType: emp,
    rolesText,
    citiesText,
    cities: extractCities(citiesText),
    currentLocationText,
    currentCities: extractCities(currentLocationText),
    remote: null,
    salaryText: prefText(prefs.salary),
    availabilityText: prefText(prefs.availability),
    constraintsText: prefText(prefs.constraints),
    items,
    text,
    relations: { matchedJobs: [], appliedJobs: [], companies: [] },
    updatedAt: '',
  };
}

function externalJob(file) {
  const raw = readJson(file);
  if (!raw || typeof raw !== 'object') throw new Error(`无法读取职位 JSON：${file}`);
  const jobSearchJson = raw.jobSearchJson ?? raw.searchJson ?? raw;
  const rawJson = jobSearchJson && typeof jobSearchJson === 'object' ? jobSearchJson : null;
  const hasJson = meaningfulSearchJson(rawJson);
  const searchJson = hasJson ? rawJson : null;
  const description = searchJson?.description || raw.description || '';
  const preference = prefText(searchJson?.preferences) || raw.preference || '';
  const structured = searchJson?.employmentType || raw.employmentType;
  const emp = structured
    ? employmentFromStructured(structured, '外部职位结构化雇佣类型')
    : employmentFromText(description, '外部职位正文明确表述');
  const name = raw.name || searchJson?.title || '(外部职位)';
  const locations = Array.isArray(raw.locations) ? raw.locations : Array.isArray(searchJson?.locations) ? searchJson.locations : extractCities(`${description}\n${name}`);
  const status = raw.status || searchJson?.status || '';
  return {
    kind: 'job',
    id: `external:${path.basename(file)}`,
    name,
    category: raw.category || '',
    categoryKey: categoryKey(raw.category || ''),
    status,
    description,
    descriptionSource: description ? 'external-json' : 'none',
    retrievedDescription: description,
    descriptionDiff: { changed: false, currentLength: String(description).length, retrievedLength: String(description).length },
    preference,
    preferenceSource: preference ? 'external-json' : 'none',
    retrievedPreference: preference,
    searchJson,
    searchJsonRaw: rawJson,
    hasJson,
    empType: emp,
    locations,
    locationsSource: locations.length ? 'external-json' : 'none',
    searchLocations: Array.isArray(searchJson?.locations) ? searchJson.locations : [],
    workModes: Array.isArray(searchJson?.workModes) ? searchJson.workModes : [],
    companyIds: Array.isArray(raw.companyIds) ? raw.companyIds : [],
    sourcePartner: raw.sourcePartner || '',
    text: [name, description, preference, ...locations].filter(Boolean).join('\n'),
    relations: { matchedCandidates: [], appliedCandidates: [] },
    updatedAt: '',
  };
}

function resultRow(entry, index) {
  const r = entry.record;
  const l = entry.llm || {};
  return {
    rank: index + 1,
    id: r.id,
    name: r.name,
    category: r.category || '',
    categoryKey: r.categoryKey || '',
    employment: EMP_LABEL[r.empType?.value] || '待确认',
    locations: r.locations || [],
    cities: r.cities || [],
    currentLocation: r.currentLocationText || '',
    status: r.status || '',
    score: l.score ?? null,
    level: l.level || '',
    levelBasis: l.levelBasis || 'expected-score-rounded',
    modalLevel: l.modalLevel || '',
    confidence: l.confidence ?? null,
    error: l.error || null,
  };
}

async function cmdMatch(f) {
  jsonMode = !!f.json;
  if (f['candidate-json']) f.candidate = f['candidate-json'];
  if (f['job-json']) f.job = f['job-json'];
  const direction = pickDirection(f);
  if (f.batch !== undefined) throw new Error('不再支持 --batch（旧文档中的批大小未实现）。请使用 --concurrency <正整数> 控制并发。');
  const top = positiveInt(f.top, 10, 'top');
  const concurrency = positiveInt(f.concurrency, 4, 'concurrency');
  const maxRecords = positiveInt(f['max-records'], 60, 'max-records');
  if (f.min != null && !Number.isFinite(Number(f.min))) throw new Error(`min 必须为数字，收到 ${f.min}`);

  const all = loadAll();
  const subjectArg = direction === 'cand2job' ? (f.candidates || f.candidate) : (f.jobs || f.job);
  const subject = direction === 'cand2job'
    ? (fs.existsSync(subjectArg) ? externalCandidate(subjectArg) : resolveOne(subjectArg, all.candidates, '候选人'))
    : (fs.existsSync(subjectArg) ? externalJob(subjectArg) : resolveOne(subjectArg, all.jobs, '职位'));
  if (!subject) throw new Error('找不到主体记录');
  const records = direction === 'cand2job' ? all.jobs : all.candidates;
  if (!records.length) throw new Error(`没有可匹配的${direction === 'cand2job' ? '职位' : '候选人'}缓存，先 fanhan-ntn sync`);

  const { pool, stats } = buildPool(direction, subject, records, {
    includeClosed: !!f['include-closed'],
    includeUnknownStatus: !!f['include-unknown-status'],
    includeDuplicates: !!f['include-duplicates'],
    includeNotSeeking: !!f['include-not-seeking'],
    includeRecommended: !!f['include-recommended'],
    anyCategory: !!f['any-category'],
    anyEmployment: !!f['any-employment'],
    maxRecords,
    keyword: typeof f.keyword === 'string' ? f.keyword : '',
  });

  if (!jsonMode) {
    const subjType = direction === 'cand2job' ? '候选人' : '职位';
    console.log(C.bold(`主体 ${subjType}: ${subject.name}`));
    console.log(`主体 ID: ${subject.id}`);
    console.log(describePool(stats));
  }
  if (!pool.length) {
    if (jsonMode) console.log(JSON.stringify({ subject: { id: subject.id, name: subject.name }, direction, pool: stats, summary: { total: 0, failed: 0 }, partial: false, results: [], failures: [] }, null, 2));
    else console.log(C.yellow('没有通过硬性条件的候选池。可检查状态/职类/雇佣类型，或显式使用 include 开关。'));
    return;
  }

  if (f['no-llm']) {
    const shown = pool.slice(0, top);
    const results = shown.map((r, i) => resultRow({ record: r, llm: null }, i));
    if (jsonMode) {
      console.log(JSON.stringify({ subject: { id: subject.id, name: subject.name }, direction, pool: stats, model: 'not-run', summary: { total: shown.length, failed: 0 }, partial: false, results, failures: [] }, null, 2));
      return;
    }
    const headers = direction === 'cand2job'
      ? ['#', 'ID', '职位', '职类', '地点', '状态', '雇佣']
      : ['#', 'ID', '候选人', '职类', '雇佣', '求职', '重复'];
    const rows = shown.map((r, i) => direction === 'cand2job'
      ? [i + 1, r.id, cut(r.name, 24), r.category || '-', (r.locations || []).join('/') || '-', r.status || '-', EMP_LABEL[r.empType?.value] || '待确认']
      : [i + 1, r.id, cut(r.name, 20), r.category || '-', EMP_LABEL[r.empType?.value] || '待确认', r.seekingStatus || '-', r.duplicate ? '是' : '否']);
    table(headers, rows);
    console.log(C.dim(`\n未调用模型（--no-llm）。候选池 ${stats.kept} 条，展示前 ${shown.length} 条。`));
    return;
  }

  const cfg = llmConfig();
  if (!cfg.configured) throw new Error(cfg.hint);
  if (!jsonMode) console.log(C.dim(`判断模型 provider=${cfg.provider} endpoint=${cfg.base} key=${cfg.source}，并发 ${concurrency}`));
  const judged = await judge(direction, subject, pool, {
    concurrency,
    onProgress: (done, total) => { if (!jsonMode && process.stderr.isTTY) process.stderr.write(`\r  模型判断 ${done}/${total}`); },
  });
  if (!jsonMode && process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(40) + '\r');
  const summary = judged.summary;
  const failures = judged.results
    .filter((x) => x.llm?.error)
    .map((x) => ({ id: x.record.id, name: x.record.name, error: x.llm.error }));
  const ok = judged.results.filter((x) => !x.llm?.error && typeof x.llm?.score === 'number').sort((a, b) => b.llm.score - a.llm.score || String(a.record.name).localeCompare(String(b.record.name), 'zh'));
  const filtered = f.min != null ? ok.filter((x) => x.llm.score >= Number(f.min)) : ok;
  const shown = filtered.slice(0, top);

  if (jsonMode) {
    console.log(JSON.stringify({
      subject: { id: subject.id, name: subject.name },
      direction,
      pool: stats,
      summary,
      partial: summary.failed > 0,
      results: shown.map(resultRow),
      failures,
    }, null, 2));
    if (summary.failed) process.exitCode = 1;
    return;
  }

  if (!shown.length) {
    console.log(C.yellow(`没有达到 min=${f.min ?? '-'} 的结果。`));
  } else {
    const headers = direction === 'cand2job'
      ? ['#', 'ID', '职位', '职类', '地点', '分', '档', '雇佣']
      : ['#', 'ID', '候选人', '职类', '契合度', '分', '档', '雇佣'];
    const rows = shown.map((x, i) => direction === 'cand2job'
      ? [i + 1, x.record.id, cut(x.record.name, 24), x.record.category || '-', (x.record.locations || []).join('/') || '-', x.llm.score ?? '-', x.llm.level || '-', EMP_LABEL[x.record.empType?.value] || '待确认']
      : [i + 1, x.record.id, cut(x.record.name, 20), x.record.category || '-', fmtLevel(x.llm), x.llm.score ?? '-', x.llm.level || '-', EMP_LABEL[x.record.empType?.value] || '待确认']);
    table(headers, rows);
  }

  if (f.min != null) console.log(C.dim(`按 min=${f.min} 过滤；模型失败记录不参与排序但始终在下方列出。`));
  if (f.explain) {
    for (const x of shown) {
      console.log(`\n${C.bold(x.record.name)} — ${x.llm.score} 分 / ${x.llm.level}`);
      console.log(C.dim(`  期望分档=${x.llm.level}（levelBasis=${x.llm.levelBasis}），众数档=${x.llm.modalLevel || '-'}`));
      const probs = x.llm.fitProbabilities || {};
      const parts = Object.entries(probs).map(([k, v]) => `${FIT_LEVEL_NAMES[Number(k)] || k}:${(Number(v) * 100).toFixed(2)}%`);
      console.log(`  概率分布        ${parts.join('  ')}`);
      if (x.llm.mustHave != null) console.log(`  硬性要求        ${x.llm.mustHave ? '满足' : '不满足'}`);
      if (x.llm.employmentConflict != null) console.log(`  雇佣冲突        ${x.llm.employmentConflict ? '有' : '无'}`);
    }
  }

  console.log(C.dim(`\n候选池 ${stats.kept} 条，通过模型 ${ok.length} 条，展示前 ${shown.length} 条。${stats.recalled ? `关键词召回 ${stats.kept}/${stats.recalled}。` : ''}`));
  if (summary.failed) {
    console.log(C.red(`模型判断失败 ${summary.failed}/${summary.total} 条（本次结果为部分失败，退出码非 0）。`));
    for (const x of failures.slice(0, 20)) console.log(`  ${x.id}  ${cut(x.name, 20)}  ${x.error}`);
    if (failures.length > 20) console.log(C.dim(`  其余 ${failures.length - 20} 条失败已省略`));
    process.exitCode = 1;
  }
}

function fmtLevel(llm) {
  if (!llm || llm.score == null) return '-';
  return `${llm.level || ''}${llm.modalLevel && llm.modalLevel !== llm.level ? C.dim(` (众数:${llm.modalLevel})`) : ''}`;
}

const pct = (v) => (typeof v === 'number' ? `${(v * 100).toFixed(0)}%` : '—');

async function cmdExplain(args) {
  const f = args;
  const [a, b] = f._;
  const { candidates, jobs } = loadAll();
  let cand;
  let job;
  if (f.candidate && f.job) {
    cand = resolveOne(f.candidate, candidates, '候选人');
    job = resolveOne(f.job, jobs, '职位');
  } else {
    if (!a || !b) throw new Error('用法：fanhan-ntn explain <候选人> <职位>');
    cand = resolveOne(a, candidates, '候选人');
    job = resolveOne(b, jobs, '职位');
  }
  const cfg = llmConfig();
  if (!cfg.configured) throw new Error(cfg.hint);
  const res = await judgeSingle('job2cand', job, cand);
  console.log(C.bold(`${cand.name} × ${job.name}`));
  console.log(C.dim(`岗位：${job.category || '-'} · ${EMP_LABEL[job.empType.value]}（${job.empType.basis}） · ${(job.locations || []).join('/') || '地点未标注'}`));
  console.log(C.dim(`候选人：${cand.category || '-'} · ${EMP_LABEL[cand.empType.value]}（${cand.empType.basis}）`));
  console.log('');
  if (res.error) {
    console.log(C.red(`  错误：${res.error}`));
    process.exitCode = 1;
  } else {
    console.log(`  匹配分 ${C.bold(String(res.score ?? '—'))}   档位 ${res.level || '-'}${res.confidence != null ? `   置信 ${(res.confidence * 100).toFixed(0)}%` : ''}`);
    console.log(C.dim(`  档位口径 ${res.levelBasis}；众数档 ${res.modalLevel || '-'}（概率最高，不用于替换期望分档）`));
    console.log(`  硬性要求满足概率 ${pct(res.mustHave)}   雇佣类型冲突 ${pct(res.employmentConflict)}   职级匹配 ${pct(res.seniorityOk)}`);
    if (res.fitProbabilities) {
      const dist = Object.entries(res.fitProbabilities).map(([k, v]) => `${FIT_LEVEL_NAMES[Number(k)] || k} ${(Number(v) * 100).toFixed(0)}%`).join(' / ');
      console.log(C.dim(`  分布：${dist}`));
    }
    if (res.usage) console.log(C.dim(`  用量：${JSON.stringify(res.usage)}`));
  }
  if (f.raw) {
    console.log(C.bold('\n[候选人原始检索 JSON]'));
    console.log(C.dim(cut(JSON.stringify(cand.searchJson || { note: cand.note, emailBody: cand.emailBody }, null, 1), 3000)));
    console.log(C.bold('\n[岗位描述来源]'));
    console.log(C.dim(`来源=${job.descriptionSource}；当前 Notion 描述不会被历史检索 JSON 覆盖。`));
  }
}

function cmdAudit(f) {
  const { candidates, jobs } = loadAll();
  const safety = safetyContract();
  const cNoJson = candidates.filter((x) => !x.hasJson);
  const cNoCat = candidates.filter((x) => !x.category);
  const cNoEmp = candidates.filter((x) => (x.empType?.value || 'unknown') === 'unknown');
  const cEmpty = candidates.filter((x) => !x.hasJson && !x.note && !x.emailBody);
  const cDup = candidates.filter((x) => x.duplicate === true);
  const cNotSeeking = candidates.filter((x) => x.seekingStatus && !seekingAllows(x.seekingStatus));
  const jNoJson = jobs.filter((x) => !x.hasJson);
  const jNoDesc = jobs.filter((x) => !x.description);
  const jNoCat = jobs.filter((x) => !x.category);
  const jNoEmp = jobs.filter((x) => (x.empType?.value || 'unknown') === 'unknown');
  const jNoStatus = jobs.filter((x) => !x.status);
  if (f.json) {
    console.log(JSON.stringify({ safety, cNoJson, cNoCat, cNoEmp, cEmpty, cDup, cNotSeeking, jNoJson, jNoDesc, jNoCat, jNoEmp, jNoStatus }, null, 2));
    return;
  }
  console.log(C.bold('数据体检'));
  table(['维度', '数量', '说明'], [
    ['候选人缺检索 JSON', String(cNoJson.length), `其中 ${cEmpty.length} 条连备注/邮件正文都没有（空壳）`],
    ['候选人缺职类', String(cNoCat.length), '保留未知，不强行归入其它'],
    ['候选人雇佣类型待确认', String(cNoEmp.length), '不猜历史实习/职位名称，交由信息或模型显式处理'],
    ['候选人标记重复', String(cDup.length), '默认不进入匹配池（--include-duplicates 可显式放开）'],
    ['候选人明确不求职/撤回', String(cNotSeeking.length), '默认不进入匹配池（--include-not-seeking 可显式放开）'],
    ['岗位缺检索 JSON', String(jNoJson.length), `其中 ${jNoDesc.length} 条连描述都缺`],
    ['岗位缺职类', String(jNoCat.length), '-'],
    ['岗位雇佣类型待确认', String(jNoEmp.length), '建议在 Notion 补标注'],
    ['岗位状态缺失', String(jNoStatus.length), '不默认招聘中；默认不进入匹配池'],
  ]);
  console.log(C.dim(`\n全局安全字段：${safety.globalConfigured ? '已配置' : '未配置（不提供全局不推荐/撤回保护；link 不是发布）'}`));
  const show = (t, arr, fmt) => {
    if (!arr.length) return;
    console.log(C.bold(`\n${t}（前 15）`));
    for (const r of arr.slice(0, 15)) console.log(C.dim(`  ${r.id.slice(0, 8)}  ${fmt(r)}`));
    if (arr.length > 15) console.log(C.dim(`  … 另有 ${arr.length - 15} 条`));
  };
  show('候选人缺检索 JSON', cNoJson, (r) => `${cut(r.name, 20)}  备注${r.note ? 'Y' : 'N'} 邮件${r.emailBody ? 'Y' : 'N'}${r.fallbackReason ? `  回退:${r.fallbackReason}` : ''}`);
  show('岗位缺检索 JSON', jNoJson, (r) => `${cut(r.name, 24)}  描述${r.description ? `${r.description.length}字` : '无'}`);
  show('岗位状态缺失', jNoStatus, (r) => cut(r.name, 28));
}

async function cmdAuth(args) {
  const sub = args._[0] || 'status';
  if (sub === 'login') {
    const key = await readStdin();
    if (!key) throw new Error('没有从 stdin 读到 key。用法：pbpaste | fanhan-ntn auth login');
    await saveKeyToKeychain(key);
    const masked = `${key.slice(0, 4)}${'*'.repeat(Math.max(0, key.length - 8))}${key.slice(-4)}`;
    console.log(C.green(`已保存到 Keychain（服务 fanhan-ntn-llm）：${masked}`));
    return;
  }
  if (sub === 'logout') {
    const ok = await deleteKeyFromKeychain();
    console.log(ok ? C.green('已从 Keychain 删除模型 key') : C.yellow('Keychain 中没有该记录'));
    return;
  }
  const cfg = llmConfig();
  console.log(C.bold('模型凭据（provider / endpoint / key 严格绑定）'));
  console.log(`  状态    ${cfg.configured ? C.green('已配置') : C.yellow('未配置')}`);
  console.log(`  来源    ${cfg.source}${cfg.keySource && cfg.keySource !== 'none' ? C.dim(` (${cfg.keySource})`) : ''}`);
  console.log(`  provider ${cfg.provider}`);
  console.log(`  端点    ${cfg.base}`);
  console.log(`  模型    ${cfg.model}`);
  if (!cfg.configured) console.log(C.dim(`\n${cfg.hint}`));
}

function freshConflict(label, cached, fresh) {
  const cachedSet = new Set(cached || []);
  const freshSet = new Set(fresh || []);
  const added = (fresh || []).filter((id) => !cachedSet.has(id));
  const removed = (cached || []).filter((id) => !freshSet.has(id));
  if (!added.length && !removed.length) return;
  console.log(C.yellow(`  ! ${label}：缓存与 Notion 最新关系不一致（新增 ${added.length} / 移除 ${removed.length}）；以最新读取为准合并，不盲目覆盖。`));
}

async function cmdLink(args) {
  const f = args;
  if (!f.candidate) throw new Error('用法：fanhan-ntn link --candidate <候选人> --jobs <职位1,职位2> [--yes] [--mark-recommended]');
  const { candidates, jobs } = loadAll();
  const cand = resolveOne(f.candidate, candidates, '候选人');
  const names = String(f.jobs || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  if (!names.length) throw new Error('请用 --jobs 指定至少一个职位（逗号分隔）');
  const jobRecords = names.map((n) => resolveOne(n, jobs, '职位'));
  console.log(C.bold(`关联：${cand.name} ↔ ${jobRecords.map((j) => j.name).join('、')}`));
  for (const j of jobRecords) console.log(C.dim(`  ${cand.id} → ${j.id} ${j.name}`));
  const safety = safetyContract();
  if (!safety.globalConfigured) console.log(C.yellow('  提示：未配置全局不推荐/撤回字段；link 只写关系，不提供发布级全局保护。'));

  if (!f.yes) {
    console.log(C.yellow('\n这是预演：不写 Notion、不联网读取、不更新缓存。确认后加 --yes 才会写入。'));
    return;
  }

  ensurePrivateDir(ROOT);
  const release = acquireLock(ROOT, 'link');
  try {
    const candRel = await readRelation(cand.id, '匹配的职位');
    assertCandidateSafety(candRel.page);
    const freshJobs = [];
    for (const j of jobRecords) {
      const rel = await readRelation(j.id, '匹配的人选');
      const status = choice(rel.page.properties?.['岗位状态']);
      if (status !== '招聘中') {
        throw new Error(`岗位「${j.name}」当前状态为「${status || '缺失'}」，不是招聘中；拒绝写入（状态缺失也不默认招聘中）。`);
      }
      freshJobs.push({ record: j, rel });
    }

    freshConflict('候选人「匹配的职位」', cand.relations.matchedJobs || [], candRel.ids);
    for (const x of freshJobs) freshConflict(`岗位「${x.record.name}」「匹配的人选」`, x.record.relations.matchedCandidates || [], x.rel.ids);

    const candIds = [...new Set([...candRel.ids, ...jobRecords.map((j) => j.id)])];
    await updatePage(cand.id, { 匹配的职位: { relation: candIds.map((id) => ({ id })) } });
    const candCheck = await verifyRelation(cand.id, '匹配的职位', candIds);
    if (!candCheck.ok) throw new Error(`候选人关系写入后校验失败，缺少 ${candCheck.missing.length} 个关联；请重新 sync 并人工核对。`);
    console.log(C.green(`  ✓ 候选人「匹配的职位」已写入并复核（${candIds.length} 个）`));

    for (const x of freshJobs) {
      const ids = [...new Set([...x.rel.ids, cand.id])];
      await updatePage(x.record.id, { 匹配的人选: { relation: ids.map((id) => ({ id })) } });
      const check = await verifyRelation(x.record.id, '匹配的人选', ids);
      if (!check.ok) throw new Error(`岗位「${x.record.name}」关系写入后校验失败，缺少 ${check.missing.length} 人；请重新 sync 并人工核对。`);
      console.log(C.green(`  ✓ 岗位「${x.record.name}」「匹配的人选」已写入并复核（${ids.length} 人）`));
    }

    if (f['mark-recommended']) {
      const companyIds = [...new Set(freshJobs.flatMap((x) => (x.rel.page.properties?.['关联公司']?.relation || []).map((r) => r.id)).filter(Boolean))];
      if (!companyIds.length) throw new Error('岗位没有关联公司，无法 --mark-recommended；未写入推荐公司。');
      const recRel = await readRelation(cand.id, safety.recommendedCompanies);
      const ids = [...new Set([...recRel.ids, ...companyIds])];
      await updatePage(cand.id, { [safety.recommendedCompanies]: { relation: ids.map((id) => ({ id })) } });
      const check = await verifyRelation(cand.id, safety.recommendedCompanies, ids);
      if (!check.ok) throw new Error(`「${safety.recommendedCompanies}」写入后校验失败，缺少 ${check.missing.length} 个；请人工核对。`);
      console.log(C.green(`  ✓ 候选人「${safety.recommendedCompanies}」已写入并复核（${ids.length} 个）`));
    }

    console.log(C.dim('\n关系已新鲜读取、合并去重、写入并逐项复核；本地锁只防同一台机器并发，不是服务端 CAS，也不保证跨机器并发。缓存未更新，重新 sync 后可见。'));
  } finally {
    release();
  }
}

function usage() {
  console.log(`${C.bold('fanhan-ntn')} · 泛函招聘 Notion 版 CLI v0.3.0

${C.bold('数据')}
  status                                    连接、缓存时效、模型与安全字段总览
  sync                                      从 Notion 三张表全量拉取；完整成功才原子替换缓存
  audit [--json]                            缺 JSON / 缺职类 / 空壳 / 安全字段清单
  list --candidates|--jobs                  列表（--category --status --limit --json）
  get --candidate|--job <名称|ID>            单条详情（--json；职位默认展示完整当前描述）

${C.bold('匹配（筛选交给 CLI，判断交给模型）')}
  match --candidate <名称|ID>               候选人 → 岗位
  match --candidate <外部JSON文件>           用外部候选人 JSON 匹配库内岗位
  match --job <名称|ID>                     岗位 → 候选人
  match --job <外部JD JSON文件>              用外部 JD JSON 匹配库内候选人
  explain <候选人> <职位>                    单对判断（--raw 附原始来源）

${C.bold('match 参数')}
  --top 10                      展示条数
  --min 70                      只保留模型评分不低于该值（失败记录仍会列出）
  --max-records 60              最多送多少条给模型（默认 60）
  --concurrency 4               模型并发，必须为正整数
  --no-llm                      只列硬性条件筛出的记录，不做判断
  --any-category                不按职类排除
  --any-employment              不按雇佣类型排除
  --include-closed              包含已结束岗位
  --include-unknown-status      显式包含状态缺失岗位（默认排除）
  --include-duplicates          显式包含标记重复的候选人
  --include-not-seeking         显式包含明确不求职/撤回的候选人
  --include-recommended         显式包含已推荐过该公司的候选人
  --keyword <词>                额外召回词
  --explain / --json            附分档概率 / 机器可读输出（stdout 只有 JSON）

${C.bold('写回')}
  link --candidate <候选人> --jobs <职位1,职位2> [--yes] [--mark-recommended]
                                            新鲜读取、合并去重、本地锁、写后复核；
                                            默认仅预演。--mark-recommended 需显式指定。

${C.bold('模型凭据（provider / endpoint / key 严格绑定）')}
  auth login                               从 stdin 读 key 存入 Keychain（不落命令行参数）
                                           用法：pbpaste | fanhan-ntn auth login
  auth status                              查看 provider、来源、端点
  auth logout                              删除 Keychain 中的 key

${C.bold('模型环境变量')}
  FANHAN_DECIDER_PROVIDER  perplexity | deepseek | custom；不填则按 endpoint 推断
  FANHAN_DECIDER_MODEL     默认 pplx-decider-latest
  FANHAN_DECIDER_BASE      默认 https://api.perplexity.ai
  FANHAN_LLM_API_KEY       显式通用 key（优先）
  PERPLEXITY_API_KEY       仅 provider=perplexity 时使用
  DEEPSEEK_API_KEY         仅 provider=deepseek 时使用
  注意：不会再把 DEEPSEEK_API_KEY 静默发往 Perplexity 端点。

${C.bold('缓存与安全边界')}
  FANHAN_CACHE_STALE_MS    缓存过期阈值，默认 24 小时；list/get/status 会显示时效
  安全字段：默认「是否重复」「求职状态」；全局不推荐/撤回字段需在
  ~/.fanhan-ntn/config.json 的 safety 中显式配置，否则在 status/audit 中显示未配置。
`);
}

export async function main(argv) {
  const args = parseArgv(argv);
  const cmd = args._.shift();
  try {
    switch (cmd) {
      case 'status': await cmdStatus(args); break;
      case 'sync': await cmdSync(); break;
      case 'list': await cmdList(args); break;
      case 'get': await cmdGet(args); break;
      case 'match': await cmdMatch(args); break;
      case 'explain': await cmdExplain(args); break;
      case 'audit': cmdAudit(args); break;
      case 'link': await cmdLink(args); break;
      case 'auth': await cmdAuth(args); break;
      case undefined:
      case 'help':
      case '--help':
        usage();
        break;
      default:
        console.error(C.red(`未知命令：${cmd}\n`));
        usage();
        process.exit(1);
    }
  } catch (e) {
    console.error(C.red(`错误：${e.message}`));
    process.exit(1);
  }
}
