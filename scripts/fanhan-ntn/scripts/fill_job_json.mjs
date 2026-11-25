import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { updatePage } from '../src/ntn.mjs';
import { extractCities } from '../src/parse.mjs';

const R = path.join(os.homedir(), '.fanhan-ntn');
const jobs = JSON.parse(fs.readFileSync(path.join(R, 'jobs.json'), 'utf8')).records;

const CAT = {
  '研发': 'engineering',
  '产品经理': 'product',
  '增长/市场/运营': 'growth_marketing',
  '商务/销售': 'sales_business',
  '算法': 'data_ai',
  '数据分析': 'data_ai',
  '设计': 'design',
  'HR': 'other',
  '其它': 'other',
};

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Notion rich_text 单项上限 2000 字符，按 1800 切块 */
function richTextChunks(str) {
  const out = [];
  for (let i = 0; i < str.length; i += 1800) {
    out.push({ type: 'text', text: { content: str.slice(i, i + 1800) } });
  }
  return out;
}

const targets = jobs.filter((j) => !j.hasJson && j.description && j.description.trim().length > 20);
console.log(`待生成岗位检索 JSON：${targets.length} 条`);

const dry = process.argv.includes('--dry');
let ok = 0;
const failed = [];

for (const j of targets) {
  const locations = extractCities(`${j.description}\n${j.name}`);
  const payload = {
    title: j.name,
    category: CAT[j.category] || null,
    locations,
    workModes: [],
    sourceHash: sha(`${j.name}\n${j.description}`),
    description: j.description,
    preferences: j.preference || null,
    originalText: `${j.name}\n${locations.join('/')}\n\n${j.description}`,
  };
  const text = JSON.stringify(payload, null, 2);
  if (dry) {
    console.log(`- ${j.name} | ${text.length} 字 | category=${payload.category} | locations=${locations.join('/') || '无'}`);
    continue;
  }
  try {
    await updatePage(j.id, { '职位检索 JSON': { rich_text: richTextChunks(text) } });
    ok++;
    process.stdout.write(`\r写入 ${ok}/${targets.length} …`);
  } catch (e) {
    failed.push({ name: j.name, error: e.message.slice(0, 160) });
  }
}

if (!dry) {
  console.log(`\n完成：成功 ${ok}/${targets.length}`);
  if (failed.length) {
    console.log('失败清单：');
    for (const f of failed) console.log(`  ${f.name}: ${f.error}`);
  }
}
