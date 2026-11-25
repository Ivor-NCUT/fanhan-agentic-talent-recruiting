import { spawn } from 'node:child_process';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 工作区相关的 data source ID 只存在本地配置或环境变量里，不进仓库 */
function localConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.fanhan-ntn', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

const CFG = localConfig();
const pick = (key, envName) => process.env[envName] || CFG[key] || null;

export const DS = {
  candidates: pick('candidates', 'FANHAN_DS_CANDIDATES'),
  jobs: pick('jobs', 'FANHAN_DS_JOBS'),
  companies: pick('companies', 'FANHAN_DS_COMPANIES'),
};

export function assertConfigured() {
  const missing = Object.entries(DS).filter(([, v]) => !v).map(([k]) => k);
  if (!missing.length) return;
  throw new Error(
    `缺少 data source 配置：${missing.join(', ')}。请在 ~/.fanhan-ntn/config.json 写入 {"candidates":"...","jobs":"...","companies":"..."}，或设置 FANHAN_DS_CANDIDATES / FANHAN_DS_JOBS / FANHAN_DS_COMPANIES。用 ntn datasources resolve <database_id> 可查。`,
  );
}

export const DS_NAME = {
  candidates: '候选人库',
  jobs: '职位 JD 库',
  companies: '公司库',
};

function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('ntn', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      if (e.code === 'ENOENT') {
        reject(
          new Error(
            '找不到 ntn 命令。请先安装 Notion 官方 CLI 并执行 ntn login：https://www.npmjs.com/package/@notionhq/cli',
          ),
        );
      } else reject(e);
    });
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0) {
        reject(new Error(`ntn ${args.slice(0, 3).join(' ')} 失败（exit ${code}）：${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function ntnJson(args, input) {
  const { stdout } = await run(args, input);
  const text = stdout.trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`ntn 返回的不是合法 JSON：${text.slice(0, 300)}`);
  }
}

export async function whoami() {
  try {
    const { stdout } = await run(['whoami']);
    const line = stdout.trim();
    const cols = line.split('\t');
    const workspace = cols.length >= 6 ? cols[5] : line.split(/\s{2,}/).pop() || '';
    const email = (line.match(/[\w.+-]+@[\w.-]+/) || [''])[0];
    return { raw: line, workspace: workspace || email, email, ok: true };
  } catch (e) {
    return { raw: '', workspace: '', email: '', ok: false, error: e.message };
  }
}

export async function ntnVersion() {
  try {
    const { stdout } = await run(['--version']);
    return stdout.trim();
  } catch {
    return null;
  }
}

/** 全量拉取一个 data source，自动翻页 */
export async function queryAll(dataSourceId, { pageSize = 100, onPage } = {}) {
  const rows = [];
  let cursor = null;
  let guard = 0;
  for (;;) {
    const args = ['datasources', 'query', dataSourceId, '--limit', String(pageSize), '--json'];
    if (cursor) args.push('--start-cursor', cursor);
    const payload = await ntnJson(args);
    const results = payload.results || [];
    rows.push(...results);
    if (onPage) onPage(rows.length, payload.has_more);
    if (!payload.has_more || !payload.next_cursor) break;
    cursor = payload.next_cursor;
    if (++guard > 200) throw new Error('翻页次数异常，已中止');
  }
  return rows;
}

/** 写回：更新页面属性（关系等） */
export async function updatePage(pageId, properties) {
  return ntnJson(['api', `/v1/pages/${pageId}`, '-X', 'PATCH', '-d', '@-'], JSON.stringify({ properties }));
}

export function extractPageId(input) {
  if (!input) return null;
  const m = String(input).match(/([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (!m) return null;
  const raw = m[1].replace(/-/g, '');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}
