import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { updatePage, fetchPage, acquireLock, ensurePrivateDir } from '../src/ntn.mjs';
import { extractCities, choice, categoryKey } from '../src/parse.mjs';

const R = path.join(os.homedir(), '.fanhan-ntn');
const jobsFile = path.join(R, 'jobs.json');
let jobs;
try {
  jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8')).records;
} catch (e) {
  console.error(`读取职位缓存失败：${e.message}。先运行 fanhan-ntn sync。`);
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const write = args.has('--yes') && !args.has('--dry');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function richTextChunks(str) {
  const out = [];
  for (let i = 0; i < str.length; i += 1800) out.push({ type: 'text', text: { content: str.slice(i, i + 1800) } });
  return out;
}

const rt = (prop) => (prop?.rich_text || []).map((t) => t.plain_text || t.text?.content || '').join('');

const targets = jobs.filter((j) => !j.hasJson && j.description && j.description.trim().length > 20);
console.log(`待生成岗位检索 JSON：${targets.length} 条`);
if (!write) console.log('当前为预演（默认 dry-run）。确认后加 --yes 才会读取最新页面并写入。');

let ok = 0;
const failed = [];
let release = () => {};
if (write) {
  ensurePrivateDir(R);
  release = acquireLock(R, 'fill-job-json');
}
try {
for (const j of targets) {
  let fresh;
  try {
    fresh = await fetchPage(j.id);
    const props = fresh.properties || {};
    const existing = rt(props['职位检索 JSON']).trim();
    if (existing) {
      failed.push({ name: j.name, error: '冲突：Notion 当前「职位检索 JSON」已存在且非空，拒绝覆盖陈旧生成结果。' });
      continue;
    }
    const freshDesc = rt(props['职位描述']).trim();
    if (freshDesc && freshDesc !== String(j.description || '').trim()) {
      failed.push({ name: j.name, error: '冲突：Notion 当前「职位描述」与缓存不一致，先 fanhan-ntn sync 再生成。' });
      continue;
    }
  } catch (e) {
    failed.push({ name: j.name, error: `读取最新页面失败：${e.message}` });
    continue;
  }

  const props = fresh.properties || {};
  const name = (props['职位名称']?.title || []).map((t) => t.plain_text || t.text?.content || '').join('') || j.name;
  const description = rt(props['职位描述']).trim() || j.description;
  const locations = extractCities(`${description}\n${name}`);
  const catKey = categoryKey(choice(props['职位类目'])) || j.categoryKey || null;
  const preference = rt(props['职位招聘偏好']) || j.preference || null;
  const payload = {
    title: name,
    category: catKey,
    locations,
    workModes: [],
    sourceHash: sha(`${name}\n${description}`),
    description,
    preferences: preference,
    originalText: `${name}\n${locations.join('/')}\n\n${description}`,
  };
  const text = JSON.stringify(payload, null, 2);

  if (!write) {
    console.log(`- ${name} | ${text.length} 字 | category=${catKey || '未知'} | locations=${locations.join('/') || '无'}`);
    continue;
  }

  try {
    await updatePage(j.id, { '职位检索 JSON': { rich_text: richTextChunks(text) } });
    const after = await fetchPage(j.id);
    const got = rt(after.properties?.['职位检索 JSON']).trim();
    if (!got) throw new Error('写入后复核失败：最新页面「职位检索 JSON」仍为空');
    ok++;
    process.stdout.write(`\r写入并复核 ${ok}/${targets.length} …`);
  } catch (e) {
    failed.push({ name, error: e.message.slice(0, 220) });
  }
}
} finally {
  release();
}

if (write) console.log(`\n完成：成功 ${ok}/${targets.length}`);
if (failed.length) {
  console.log('失败/冲突清单：');
  for (const f of failed) console.log(`  ${f.name}: ${f.error}`);
  process.exitCode = 1;
}
