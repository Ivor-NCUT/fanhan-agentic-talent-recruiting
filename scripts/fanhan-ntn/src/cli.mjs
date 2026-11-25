import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DS, DS_NAME, assertConfigured, queryAll, whoami, ntnVersion, updatePage, extractPageId } from './ntn.mjs';
import {
  normalizeCandidate,
  normalizeJob,
  normalizeCompany,
  EMP_LABEL,
  categoryKey,
  categoryFromKey,
  extractCities,
  employmentFromText,
} from './parse.mjs';
import { buildPool, describePool } from './pool.mjs';
import { llmConfig, judge, judgeSingle } from './llm.mjs';
import { saveKeyToKeychain, deleteKeyFromKeychain, readStdin } from './auth.mjs';

const ROOT = path.join(os.homedir(), '.fanhan-ntn');
const FILES = {
  candidates: path.join(ROOT, 'candidates.json'),
  jobs: path.join(ROOT, 'jobs.json'),
  companies: path.join(ROOT, 'companies.json'),
  meta: path.join(ROOT, 'meta.json'),
};

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const col = (code, s) => (useColor ? `${code}${s}${C.reset}` : s);

const width = (s) =>
  [...String(s)].reduce(
    (a, ch) => a + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1),
    0,
  );
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)));
const cut = (s, n) => {
  let out = '';
  for (const ch of String(s)) {
    if (width(out + ch) > n) return out + '…';
    out += ch;
  }
  return out;
};

function table(headers, rows) {
  if (!rows.length) return;
  const widths = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  const line = (cells) => cells.map((v, i) => pad(v, widths[i])).join('  ');
  console.log(col(C.bold, line(headers)));
  console.log(col(C.dim, widths.map((w) => '─'.repeat(w)).join('  ')));
  for (const r of rows) console.log(line(r));
}

function parseArgv(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out.flags[key] = next;
        i++;
      } else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}

let jsonMode = false;
const say = (...a) => (jsonMode ? console.error : console.log)(...a);

const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};

function needCache(kind) {
  const data = readJson(FILES[kind], null);
  if (!data?.records?.length) throw new Error(`本地还没有 ${DS_NAME[kind]} 缓存，先运行：fanhan-ntn sync`);
  return data;
}

function loadAll() {
  return {
    meta: readJson(FILES.meta, {}),
    candidates: needCache('candidates').records,
    jobs: needCache('jobs').records,
    companies: (readJson(FILES.companies, { records: [] }).records || []),
  };
}

function resolveOne(records, q, label, opts = {}) {
  const needle = String(q || '').trim();
  if (!needle) throw new Error(`请提供${label}（名称、名称片段或页面 ID）`);
  const id = extractPageId(needle);
  if (id) {
    const hit = records.find((r) => r.id === id);
    if (hit) return hit;
    throw new Error(`找不到 ID 为 ${id} 的${label}`);
  }
  const exact = records.filter((r) => r.name === needle);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    if (opts.first) {
      say(col(C.yellow, `注意：「${needle}」有 ${exact.length} 条同名${label}，已按 --first 取第一条 ${exact[0].id}`));
      return exact[0];
    }
    say(col(C.yellow, `「${needle}」有 ${exact.length} 条同名${label}，请用 ID 指定（或加 --first 取第一条）：`));
    for (const r of exact) console.log(`  ${r.id}  ${r.name}  ${r.category || ''} ${r.status || ''}`);
    process.exit(2);
  }
  const partial = records.filter((r) => r.name.includes(needle));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    if (opts.first) {
      say(col(C.yellow, `注意：「${needle}」匹配到 ${partial.length} 条${label}，已按 --first 取第一条 ${partial[0].id}`));
      return partial[0];
    }
    say(col(C.yellow, `「${needle}」匹配到 ${partial.length} 条${label}，请更精确或用 ID（或加 --first 取第一条）：`));
    for (const r of partial.slice(0, 15)) console.log(`  ${r.id}  ${r.name}  ${r.category || ''} ${r.status || ''}`);
    process.exit(2);
  }
  throw new Error(`没有匹配「${needle}」的${label}`);
}


const CAT_KEYS = ['data_ai', 'engineering', 'product', 'design', 'growth_marketing', 'operations', 'sales_business', 'other'];
/** 外部 JSON 的 category 可能是英文 key，也可能是中文标签，统一成 {category, categoryKey} */
function normalizeCategory(raw) {
  const v = String(raw || '').trim();
  if (!v) return { category: '', categoryKey: '' };
  if (CAT_KEYS.includes(v)) return { category: categoryFromKey(v), categoryKey: v };
  return { category: v, categoryKey: categoryKey(v) };
}

const prefText = (x) =>
  typeof x === 'string' ? x : typeof x?.value === 'string' ? x.value : Array.isArray(x?.value) ? x.value.join('、') : '';

function externalCandidate(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const json = raw.candidateSearchJson || raw;
  const items = [];
  for (const key of ['skills', 'projects', 'experience', 'education']) {
    for (const it of json[key] || []) {
      items.push({ bucket: key, value: it.value || '', quotes: (it.evidence || []).map((e) => ({ quote: e.quote, source: e.source })) });
    }
  }
  const prefs = json.preferences || {};
  const rolesText = prefText(prefs.roles);
  const citiesText = prefText(prefs.cities);
  const remoteText = prefText(prefs.remote);
  const text = [raw.name || '', ...items.map((i) => i.value), rolesText, citiesText, prefText(prefs.constraints)].join('\n');
  return {
    kind: 'candidate',
    id: `external:${path.basename(file)}`,
    name: raw.name || path.basename(file, '.json'),
    ...normalizeCategory(raw.category || json.category),
    hasJson: true,
    searchJson: json,
    empType: employmentFromText(prefText(prefs.employmentType) || raw.empType || '', '外部 JSON'),
    rolesText,
    citiesText,
    cities: extractCities(citiesText),
    remote: /远程/.test(remoteText) ? !/(不接受远程|不能远程)/.test(remoteText) : null,
    items,
    note: '',
    emailBody: '',
    text,
  };
}

function externalJob(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const json = raw.jobSearchJson || raw;
  const name = json.title || raw.name || path.basename(file, '.json');
  const description = json.description || json.text || '';
  return {
    kind: 'job',
    id: `external:${path.basename(file)}`,
    name,
    ...normalizeCategory(json.category || raw.category),
    status: '招聘中',
    description,
    preference: json.preferences || '',
    searchJson: json,
    hasJson: true,
    empType: employmentFromText(`${name}\n${description}\n${json.preferences || ''}`, '外部 JD'),
    locations: json.locations || extractCities(description),
    workModes: json.workModes || [],
    text: [name, description, json.preferences || '', ...(json.locations || [])].join('\n'),
  };
}

async function cmdStatus() {
  assertConfigured();
  const ver = await ntnVersion();
  const me = await whoami();
  console.log(col(C.bold, 'fanhan-ntn · 状态'));
  console.log(`  Notion CLI      ${ver || col(C.red, '未安装')}`);
  console.log(`  登录身份        ${me.ok ? `${me.workspace}${me.email ? ` (${me.email})` : ''}` : col(C.red, me.error || '未登录')}`);
  const meta = readJson(FILES.meta, null);
  if (!meta) {
    console.log(col(C.yellow, '  本地缓存        无，先运行 fanhan-ntn sync'));
    return;
  }
  console.log(`  上次同步        ${meta.syncedAt}`);
  const cands = readJson(FILES.candidates, { records: [] }).records;
  const jobs = readJson(FILES.jobs, { records: [] }).records;
  const comps = readJson(FILES.companies, { records: [] }).records;
  console.log('');
  table(
    ['数据源', '条数', '缺检索JSON', '缺职类', '其它'],
    [
      ['候选人库', String(cands.length), String(cands.filter((x) => !x.hasJson).length), String(cands.filter((x) => !x.category).length), `雇佣类型待确认 ${cands.filter((x) => (x.empType?.value || 'unknown') === 'unknown').length}`],
      ['职位 JD 库', String(jobs.length), String(jobs.filter((x) => !x.hasJson).length), String(jobs.filter((x) => !x.category).length), `招聘中 ${jobs.filter((x) => x.status === '招聘中').length}`],
      ['公司库', String(comps.length), '-', '-', '-'],
    ],
  );
  const l = llmConfig();
  console.log('');
  console.log(`  判断模型        ${l.configured ? col(C.green, `${l.model} @ ${l.base}`) : col(C.yellow, '未配置')}`);
  if (!l.configured) console.log(col(C.dim, `                  ${l.hint}`));
}

async function cmdSync() {
  assertConfigured();
  fs.mkdirSync(ROOT, { recursive: true });
  const t0 = Date.now();
  const plan = [
    ['candidates', DS.candidates, normalizeCandidate],
    ['jobs', DS.jobs, normalizeJob],
    ['companies', DS.companies, normalizeCompany],
  ];
  const meta = { syncedAt: new Date().toISOString(), counts: {} };
  for (const [kind, ds, normalize] of plan) {
    const pages = await queryAll(ds, {
      onPage: (n) => process.stderr.write(col(C.dim, `\r同步 ${DS_NAME[kind]} … ${n} 条`)),
    });
    const records = pages.map(normalize);
    fs.writeFileSync(FILES[kind], JSON.stringify({ syncedAt: meta.syncedAt, records }));
    meta.counts[kind] = records.length;
    process.stderr.write(col(C.dim, `\r同步 ${DS_NAME[kind]} … ${records.length} 条 ✓\n`));
  }
  fs.writeFileSync(FILES.meta, JSON.stringify(meta, null, 2));
  console.log(col(C.green, `同步完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s → ${ROOT}`));
}

function cmdList(args) {
  const [kind] = args._;
  if (!['candidates', 'jobs', 'companies'].includes(kind)) throw new Error('用法：fanhan-ntn list <candidates|jobs|companies>');
  const data = readJson(FILES[kind], null);
  if (!data?.records) throw new Error(`没有 ${DS_NAME[kind]} 缓存，先运行 fanhan-ntn sync`);
  let rows = data.records;
  const f = args.flags;
  if (f.category) rows = rows.filter((r) => (r.category || '') === f.category);
  if (f.status) rows = rows.filter((r) => (r.status || '') === f.status);
  if (f['has-json'] === 'no') rows = rows.filter((r) => !r.hasJson);
  if (f['has-json'] === 'yes') rows = rows.filter((r) => r.hasJson);
  if (f.employment) rows = rows.filter((r) => (r.empType?.value || 'unknown') === f.employment);
  if (f.q) rows = rows.filter((r) => r.name.includes(f.q));
  if (f.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const limit = Number(f.limit || 40);
  const slice = rows.slice(0, limit);
  if (kind === 'companies') {
    table(['公司', '官网', '职位数'], slice.map((r) => [cut(r.name, 26), cut(r.site || '-', 30), String(r.jobIds?.length || 0)]));
  } else {
    table(
      ['名称', '职类', '雇佣', 'JSON', '状态'],
      slice.map((r) => [cut(r.name, 30), r.category || '-', EMP_LABEL[r.empType?.value || 'unknown'], r.hasJson ? '有' : col(C.red, '缺'), r.status || '-']),
    );
  }
  console.log(col(C.dim, `共 ${rows.length} 条，显示 ${slice.length} 条`));
}

function cmdGet(args) {
  const [rawKind, ...rest] = args._;
  const kind = { candidate: 'candidates', job: 'jobs', company: 'companies' }[rawKind] || rawKind;
  if (!['candidates', 'jobs', 'companies'].includes(kind)) throw new Error('用法：fanhan-ntn get <candidate|job|company> <名称|ID>');
  const q = rest.join(' ');
  const file = kind === 'candidates' ? FILES.candidates : kind === 'jobs' ? FILES.jobs : FILES.companies;
  const data = readJson(file, null);
  if (!data?.records) throw new Error('缓存不存在，先运行 fanhan-ntn sync');
  const r = resolveOne(data.records, q, kind === 'jobs' ? '职位' : '候选人', { first: args.flags.first });
  if (args.flags.json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(col(C.bold, r.name));
  console.log(col(C.dim, `  id ${r.id}`));
  if (r.kind === 'candidate') {
    console.log(`  职类 ${r.category || '-'}   雇佣 ${EMP_LABEL[r.empType?.value]}（${r.empType?.basis}）`);
    console.log(`  邮箱 ${r.email || '-'}   手机 ${r.phone || '-'}   微信 ${r.wechat || '-'}`);
    console.log(`  期望 ${cut(r.rolesText || '-', 90)}   城市 ${(r.cities || []).join('/') || '-'}`);
    const j = r.searchJson;
    if (j) {
      for (const key of ['skills', 'experience', 'projects', 'education']) {
        const arr = j[key] || [];
        if (!arr.length) continue;
        console.log(col(C.bold, `\n  [${key}] ${arr.length} 条`));
        for (const it of arr.slice(0, 5)) console.log(`   · ${cut(it.value, 110)}`);
      }
      if (j.unknowns?.length) {
        console.log(col(C.bold, `\n  [unknowns] ${j.unknowns.length} 条`));
        for (const u of j.unknowns.slice(0, 4)) console.log(col(C.dim, `   · ${cut(u, 100)}`));
      }
    } else {
      console.log(col(C.yellow, '\n  无检索 JSON，以下为备注/邮件正文：'));
      console.log(col(C.dim, cut(r.note || r.emailBody || '（空）', 600)));
    }
    console.log(col(C.dim, `\n  已匹配职位 ${r.relations.matchedJobs.length} 个 / 已投递 ${r.relations.appliedJobs.length} 个`));
  } else {
    console.log(`  职类 ${r.category || '-'}   状态 ${r.status || '-'}   雇佣 ${EMP_LABEL[r.empType?.value]}（${r.empType?.basis}）`);
    console.log(`  地点 ${(r.locations || []).join('/') || '-'}   工作模式 ${(r.workModes || []).join('/') || '-'}`);
    console.log(col(C.bold, '\n  [职位描述]'));
    console.log(col(C.dim, cut(r.description || '（空）', 1200)));
    if (r.preference) {
      console.log(col(C.bold, '\n  [招聘偏好]'));
      console.log(col(C.dim, cut(r.preference, 400)));
    }
  }
}

async function cmdMatch(args) {
  const f = args.flags;
  jsonMode = !!f.json;
  const { candidates, jobs } = loadAll();
  const top = Number(f.top || 10);
  const noLlm = !!f['no-llm'];

  let direction, subject, records;
  if (f['candidate-json'] || f.candidate) {
    subject = f['candidate-json'] ? externalCandidate(f['candidate-json']) : resolveOne(candidates, f.candidate, '候选人', { first: f.first });
    direction = 'cand2job';
    records = jobs;
  } else if (f['job-json'] || f.job) {
    subject = f['job-json'] ? externalJob(f['job-json']) : resolveOne(jobs, f.job, '职位', { first: f.first });
    direction = 'job2cand';
    records = candidates;
  } else {
    throw new Error('用法：fanhan-ntn match --candidate <名称|ID> / --candidate-json <文件> / --job <名称|ID> / --job-json <文件>');
  }

  const poolOpts = {
    includeClosed: !!f['include-closed'],
    anyCategory: !!f['any-category'],
    anyEmployment: !!f['any-employment'],
    maxRecords: Number(f['max-records'] || 60),
    keyword: f.keyword || '',
  };
  const { pool, stats } = buildPool(direction, subject, records, poolOpts);

  const head =
    direction === 'job2cand'
      ? col(C.bold, `岗位：${subject.name}`) + col(C.dim, `  ${subject.category || '-'} · ${subject.status || '-'} · ${EMP_LABEL[subject.empType.value]}（${subject.empType.basis}） · ${(subject.locations || []).join('/') || '地点未标注'}`)
      : col(C.bold, `候选人：${subject.name}`) + col(C.dim, `  ${subject.category || '-'} · ${EMP_LABEL[subject.empType.value]}（${subject.empType.basis}） · 期望 ${cut(subject.rolesText || '未记录', 40)}`);
  say(head);
  say(col(C.dim, describePool(stats)));

  if (noLlm) {
    say(col(C.yellow, '\n--no-llm：仅列出硬性条件筛出的记录，不做判断。\n'));
    const rows = pool.slice(0, top).map((r, i) => [
      String(i + 1),
      cut(r.name, 24),
      r.category || '-',
      EMP_LABEL[r.empType?.value || 'unknown'],
      (r.locations || r.cities || []).join('/') || '-',
    ]);
    table(['#', '名称', '职类', '雇佣', '地点'], rows);
    console.log(col(C.dim, `\n共 ${pool.length} 条待判断`));
    return;
  }

  if (!pool.length) {
    console.log(col(C.yellow, '\n没有通过硬性条件的记录。可加 --any-category / --include-closed / --any-employment 放宽。'));
    return;
  }

  const cfg = llmConfig();
  if (!cfg.configured) throw new Error(cfg.hint);

  say(col(C.dim, `\n交给模型判断 ${pool.length} 对（${cfg.model}）…`));
  const judged = await judge(direction, subject, pool, {
    concurrency: Number(f.concurrency || 4),
    onProgress: (done, total) => process.stderr.write(col(C.dim, `\r模型判断中 … ${done}/${total}`)),
  });
  process.stderr.write(col(C.dim, `\r${' '.repeat(60)}\r`));

  const clean = judged
    .map((j) => ({ ...j, llm: j.llm || {} }))
    .sort((a, b) => {
      const sa = a.llm.score ?? -1;
      const sb = b.llm.score ?? -1;
      return sb - sa;
    });

  if (f.min) {
    const min = Number(f.min);
    const kept = clean.filter((j) => (j.llm.score ?? -1) >= min);
    clean.length = 0;
    clean.push(...kept);
  }

  let deduped = clean;
  if (!f.all && direction === 'cand2job') {
    const seen = new Map();
    for (const item of clean) {
      const key = item.record.name.trim();
      const prev = seen.get(key);
      if (!prev) seen.set(key, item);
      else if ((item.llm.score ?? -1) > (prev.llm.score ?? -1)) seen.set(key, item);
    }
    deduped = clean.filter((item) => seen.get(item.record.name.trim()) === item);
  }
  const shown = deduped.slice(0, top);
  if (f.json) {
    console.log(
      JSON.stringify(
        {
          subject: { id: subject.id, name: subject.name, kind: subject.kind },
          direction,
          pool: stats,
          results: shown.map((j) => ({
            name: j.record.name,
            id: j.record.id,
            score: j.llm.score ?? null,
            level: j.llm.level || '',
            confidence: j.llm.confidence ?? null,
            probabilities: j.llm.fitProbabilities || null,
            mustHave: j.llm.mustHave ?? null,
            employmentConflict: j.llm.employmentConflict ?? null,
            seniorityOk: j.llm.seniorityOk ?? null,
            error: j.llm.error || null,
            category: j.record.category || null,
            employment: j.record.empType?.value || 'unknown',
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!shown.length) {
    console.log(col(C.yellow, '\n没有达到分数阈值的记录。'));
    return;
  }

  const headers = ['#', direction === 'job2cand' ? '候选人' : '岗位', '评分', '模型档位', '硬性要求', '类型冲突', '职类', '地点'];
  const rows = shown.map((j, i) => [
    String(i + 1),
    cut(j.record.name, 22),
    j.llm.score == null ? '—' : String(j.llm.score),
    j.llm.level || '-',
    pct(j.llm.mustHave),
    pct(j.llm.employmentConflict),
    j.record.category || '-',
    cut((j.record.locations || j.record.cities || []).join('/') || '-', 12),
  ]);
  console.log('');
  table(headers, rows);

  console.log('');
  shown.forEach((j, i) => {
    const parts = [`${j.llm.score ?? '—'} 分`];
    if (j.llm.level) parts.push(j.llm.level);
    if (j.llm.confidence != null) parts.push(`置信 ${(j.llm.confidence * 100).toFixed(0)}%`);
    console.log(col(C.bold, `${i + 1}. ${j.record.name}`) + col(C.dim, `  ${parts.join(' · ')}`));
    if (f.explain && j.llm.fitProbabilities) {
      const dist = Object.entries(j.llm.fitProbabilities)
        .map(([k, v]) => `${FIT_LEVEL_NAMES[Number(k)] || k} ${(Number(v) * 100).toFixed(0)}%`)
        .join(' / ');
      console.log(col(C.dim, `   分布：${dist}`));
    }
    if (j.llm.error) console.log(col(C.red, `   错误：${j.llm.error}`));
  });
  const dupNote = deduped.length < clean.length ? `，同名职位已合并 ${clean.length - deduped.length} 条（--all 展开）` : '';
  console.log(col(C.dim, `\n共判断 ${judged.length} 对，展示 ${shown.length} 对${dupNote}。分数为模型对整体匹配的概率加权判断，硬性要求/类型冲突为独立概率，CLI 不参与加权。`));
}

const FIT_LEVEL_NAMES = ['明显不适合', '偏弱', '可以一试', '比较合适', '非常合适'];

function pct(v) {
  return typeof v === 'number' ? `${(v * 100).toFixed(0)}%` : '—';
}

async function cmdExplain(args) {
  const [a, b] = args._;
  const f = args.flags;
  const { candidates, jobs } = loadAll();
  let cand, job;
  if (f.candidate && f.job) {
    cand = resolveOne(candidates, f.candidate, '候选人', { first: f.first });
    job = resolveOne(jobs, f.job, '职位', { first: f.first });
  } else {
    if (!a || !b) throw new Error('用法：fanhan-ntn explain <候选人> <职位>');
    cand = resolveOne(candidates, a, '候选人', { first: f.first });
    job = resolveOne(jobs, b, '职位', { first: f.first });
  }
  const cfg = llmConfig();
  if (!cfg.configured) throw new Error(cfg.hint);
  const res = await judgeSingle('job2cand', job, cand);
  console.log(col(C.bold, `${cand.name} × ${job.name}`));
  console.log(col(C.dim, `岗位：${job.category || '-'} · ${EMP_LABEL[job.empType.value]}（${job.empType.basis}） · ${(job.locations || []).join('/') || '地点未标注'}`));
  console.log(col(C.dim, `候选人：${cand.category || '-'} · ${EMP_LABEL[cand.empType.value]}（${cand.empType.basis}）`));
  console.log('');
  if (res.error) {
    console.log(col(C.red, `  错误：${res.error}`));
  } else {
    console.log(`  匹配分 ${col(C.bold, String(res.score ?? '—'))}   档位 ${res.level || '-'}${res.confidence != null ? `   置信 ${(res.confidence * 100).toFixed(0)}%` : ''}`);
    console.log(`  硬性要求满足概率 ${pct(res.mustHave)}   雇佣类型冲突 ${pct(res.employmentConflict)}   职级匹配 ${pct(res.seniorityOk)}`);
    if (res.fitProbabilities) {
      const dist = Object.entries(res.fitProbabilities)
        .map(([k, v]) => `${FIT_LEVEL_NAMES[Number(k)] || k} ${(Number(v) * 100).toFixed(0)}%`)
        .join(' / ');
      console.log(col(C.dim, `  分布：${dist}`));
    }
    if (res.usage) console.log(col(C.dim, `  用量：${JSON.stringify(res.usage)}`));
  }
  if (f.raw) {
    console.log(col(C.bold, '\n[候选人原始检索 JSON]'));
    console.log(col(C.dim, cut(JSON.stringify(cand.searchJson || { note: cand.note, emailBody: cand.emailBody }, null, 1), 3000)));
  }
}

function cmdAudit(args) {
  const { candidates, jobs } = loadAll();
  const f = args.flags;
  const cNoJson = candidates.filter((x) => !x.hasJson);
  const cNoCat = candidates.filter((x) => !x.category);
  const cNoEmp = candidates.filter((x) => (x.empType?.value || 'unknown') === 'unknown');
  const cEmpty = candidates.filter((x) => !x.hasJson && !x.note && !x.emailBody);
  const jNoJson = jobs.filter((x) => !x.hasJson);
  const jNoDesc = jobs.filter((x) => !x.description);
  const jNoCat = jobs.filter((x) => !x.category);
  const jNoEmp = jobs.filter((x) => (x.empType?.value || 'unknown') === 'unknown');
  if (f.json) {
    console.log(JSON.stringify({ cNoJson, cNoCat, cNoEmp, cEmpty, jNoJson, jNoDesc, jNoCat, jNoEmp }, null, 2));
    return;
  }
  console.log(col(C.bold, '数据体检'));
  table(
    ['维度', '数量', '说明'],
    [
      ['候选人缺检索 JSON', String(cNoJson.length), `其中 ${cEmpty.length} 条连备注/邮件正文都没有（空壳）`],
      ['候选人缺职类', String(cNoCat.length), '不参与职类筛选'],
      ['候选人雇佣类型待确认', String(cNoEmp.length), '无法执行正式/实习硬性排除，会交给模型判断'],
      ['岗位缺检索 JSON', String(jNoJson.length), `其中 ${jNoDesc.length} 条连描述都缺`],
      ['岗位缺职类', String(jNoCat.length), '-'],
      ['岗位雇佣类型待确认', String(jNoEmp.length), '建议在 Notion 补标注'],
    ],
  );
  const show = (t, arr, fmt) => {
    if (!arr.length) return;
    console.log(col(C.bold, `\n${t}（前 15）`));
    for (const r of arr.slice(0, 15)) console.log(col(C.dim, `  ${r.id.slice(0, 8)}  ${fmt(r)}`));
    if (arr.length > 15) console.log(col(C.dim, `  … 另有 ${arr.length - 15} 条`));
  };
  show('候选人缺检索 JSON', cNoJson, (r) => `${cut(r.name, 20)}  备注${r.note ? 'Y' : 'N'} 邮件${r.emailBody ? 'Y' : 'N'}`);
  show('岗位缺检索 JSON', jNoJson, (r) => `${cut(r.name, 24)}  描述${r.description ? `${r.description.length}字` : '无'}`);
}

async function cmdAuth(args) {
  const sub = args._[0] || 'status';
  if (sub === 'login') {
    const key = await readStdin();
    if (!key) throw new Error('没有从 stdin 读到 key。用法：pbpaste | fanhan-ntn auth login');
    await saveKeyToKeychain(key);
    const masked = `${key.slice(0, 4)}${'*'.repeat(Math.max(0, key.length - 8))}${key.slice(-4)}`;
    console.log(col(C.green, `已保存到 Keychain（服务 fanhan-ntn-llm）：${masked}`));
    return;
  }
  if (sub === 'logout') {
    const ok = await deleteKeyFromKeychain();
    console.log(ok ? col(C.green, '已从 Keychain 删除模型 key') : col(C.yellow, 'Keychain 中没有该记录'));
    return;
  }
  const cfg = llmConfig();
  console.log(col(C.bold, '模型凭据'));
  console.log(`  状态  ${cfg.configured ? col(C.green, '已配置') : col(C.yellow, '未配置')}`);
  console.log(`  来源  ${cfg.source}`);
  console.log(`  端点  ${cfg.base}`);
  console.log(`  模型  ${cfg.model}`);
  if (!cfg.configured) console.log(col(C.dim, `\n${cfg.hint}`));
}

async function cmdLink(args) {
  const f = args.flags;
  if (!f.candidate) throw new Error('用法：fanhan-ntn link --candidate <候选人> --jobs <职位1,职位2> [--yes]');
  const { candidates, jobs } = loadAll();
  const cand = resolveOne(candidates, f.candidate, '候选人', { first: f.first });
  const names = String(f.jobs || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  if (!names.length) throw new Error('请用 --jobs 指定至少一个职位（逗号分隔）');
  const jobRecords = names.map((n) => resolveOne(jobs, n, '职位', { first: f.first }));
  console.log(col(C.bold, `关联：${cand.name} ↔ ${jobRecords.map((j) => j.name).join('、')}`));
  for (const j of jobRecords) console.log(col(C.dim, `  ${cand.id.slice(0, 8)} → ${j.id.slice(0, 8)} ${j.name}`));
  if (!f.yes) {
    console.log(col(C.yellow, '\n这是预演。确认无误后加 --yes 才会写入 Notion。'));
    return;
  }
  const merged = [...new Set([...(cand.relations.matchedJobs || []), ...jobRecords.map((j) => j.id)])].map((id) => ({ id }));
  await updatePage(cand.id, { 匹配的职位: { relation: merged } });
  console.log(col(C.green, `  ✓ 候选人侧「匹配的职位」已更新（${merged.length} 个）`));
  for (const j of jobRecords) {
    const cur = [...new Set([...(j.relations.matchedCandidates || []), cand.id])].map((id) => ({ id }));
    await updatePage(j.id, { 匹配的人选: { relation: cur } });
    console.log(col(C.green, `  ✓ 岗位「${j.name}」「匹配的人选」已更新（${cur.length} 人）`));
  }
  console.log(col(C.dim, '\n提示：本地缓存未更新，重新 sync 后关系字段才会反映。'));
}

function usage() {
  console.log(`${col(C.bold, 'fanhan-ntn')} · 泛函招聘 Notion 版 CLI v0.2.0

${col(C.bold, '数据')}
  status                                    连接、缓存、模型配置总览
  sync                                      从 Notion 三张表拉取到本地缓存
  audit [--json]                            缺 JSON / 缺职类 / 空壳记录清单
  list <candidates|jobs|companies>          列表（--category --status --employment --has-json --q --limit）
  get <candidate|job> <名称|ID>              单条详情（--json）

${col(C.bold, '匹配（筛选交给 CLI，判断交给模型）')}
  match --candidate <名称|ID>               候选人 → 岗位
  match --candidate-json <文件>             用外部候选人 JSON 匹配库内岗位
  match --job <名称|ID>                     岗位 → 候选人
  match --job-json <文件>                   用外部 JD JSON 匹配库内候选人
  explain <候选人> <职位>                    单对判断（--raw 附原始 JSON）

${col(C.bold, 'match 参数')}
  --top 10              展示条数
  --min 70              只保留模型评分不低于该值
  --max-records 60      最多送多少条给模型（默认 60，控制成本）
  --no-llm              只列硬性条件筛出的记录，不做判断
  --any-category        不按职类排除
  --any-employment      不按雇佣类型排除
  --include-closed      包含已结束岗位
  --keyword <词>        额外召回词
  --batch 8 --concurrency 3   模型批大小与并发
  --explain / --json    附分档概率 / 机器可读输出
  --all                 同名职位不合并（默认合并，保留最高分）

${col(C.bold, '写回')}
  link --candidate <候选人> --jobs <职位1,职位2> [--yes]
                                            写入「匹配的职位」/「匹配的人选」（默认仅预演）

${col(C.bold, '模型凭据')}
  auth login                               从 stdin 读 key 存入 Keychain（不落命令行参数）
                                           用法：pbpaste | fanhan-ntn auth login
  auth status                              查看当前凭据来源与端点
  auth logout                              删除 Keychain 中的 key

${col(C.bold, '判断模型（Perplexity Decider）')}
  FANHAN_DECIDER_MODEL  默认 pplx-decider-latest
  FANHAN_DECIDER_BASE   默认 https://api.perplexity.ai
  PERPLEXITY_API_KEY    可选，优先于 Keychain
`);
}

export async function main(argv) {
  const args = parseArgv(argv);
  const cmd = args._.shift();
  try {
    switch (cmd) {
      case 'status':
        await cmdStatus();
        break;
      case 'sync':
        await cmdSync();
        break;
      case 'list':
        cmdList(args);
        break;
      case 'get':
        cmdGet(args);
        break;
      case 'match':
        await cmdMatch(args);
        break;
      case 'explain':
        await cmdExplain(args);
        break;
      case 'audit':
        cmdAudit(args);
        break;
      case 'link':
        await cmdLink(args);
        break;
      case 'auth':
        await cmdAuth(args);
        break;
      case undefined:
      case 'help':
      case '--help':
        usage();
        break;
      default:
        console.log(col(C.red, `未知命令：${cmd}\n`));
        usage();
        process.exit(1);
    }
  } catch (e) {
    console.error(col(C.red, `错误：${e.message}`));
    process.exit(1);
  }
}
